# space-service

Shared spaces on per-space SQLite: **one core, two hosts**.

- **Hosted:** a Cloudflare Worker that verifies the token and routes, and one SQLite-backed
  Durable Object per space.
- **Self-hosted:** one Node process with `node:sqlite`, one database file per space, and a
  per-space request queue that reproduces the Durable Object's input gate.

Both run the same runtime-neutral core, unmodified, and **the same conformance suite runs against
both on every change**. That is the condition the design rests on: it is what keeps the hosted
runtime from becoming a lock-in.

The design is `STORE_PORTABILITY_SPEC` §5.5 in `immediately-run/docs`. This repository is the
first slice of it (roadmap items R3-1282 and R3-1283): files with the `rev` compare-and-set and the atomic
commit, roles with the `everShared` latch, the soft-delete tombstone, the `seq` change feed with
resume, the revocation push, and token verification. Invitations, quotas, blobs, the per-user
index objects and the browser host's adapter are later items. It also holds the drill that
measures the design on both hosts.

## Layout

```
src/core/         runtime-neutral: the whole service
  ports.ts          Store, Clock, Sockets, Scheduler, Config — all a host provides
  protocol.ts       the wire contract: verbs, frames, errors, close codes, limits
  auth.ts           the token verifier (ES256, audience-bound, exp required)
  files.ts          file records, the rev CAS, the atomic commit, the change log
  members.ts        roles, the latch, the tombstone
  feed.ts           hello / resume / snapshot, delta fan-out, the revocation push, expiry
  space.ts          SpaceCore: one space; what both hosts instantiate
  http.ts           routes, bearer token, body, response (Fetch API only)
src/cloudflare/   the Worker and the `Space` Durable Object — wiring
src/local/        the Node host: node:sqlite store, per-space queues, http + ws server — wiring
src/client/       the reference client: FeedClient (the feed) and SpaceClient (the verbs)
src/drill/        the R-STORE-2/3 drill: scenario (pure), report (pure), token minter, stall helper
src/migrations/   the schema, append-only
scripts/          drill CLI, staging-url, cost probe, drill summary, the TypeScript runner
test/integration/ the conformance suite — every file runs on both hosts
test/hosts/       the two hosts the suite runs against
test/unit/        unit tests; the ones that need Node are listed in vitest.config.ts
```

## Running it

```
npm install
npm test            # the suite on both hosts, plus the unit tests
npm run typecheck
```

`npm test` needs nothing but Node 22.13 or later: the Workers runtime runs locally.

To start the Node host:

```
npm start -- --data-dir ./data --public-key-file ./platform.pub.pem --audience my-space-service
```

It listens on `127.0.0.1:8787` (`--host`, `--port`) and trusts exactly one key: the SPKI PEM in
`--public-key-file`. Each space is one file, `<data-dir>/<spaceId>.sqlite`, held exclusively by
the process.

## The wire contract

The browser host is the only client. Every request carries a **platform-minted, audience-bound
ES256 token** (`sub` is the uid, `aud` is the service's configured audience, `exp` is required).
It is never the identity provider's ID token.

### Verbs — `POST /v1/spaces/{spaceId}/{verb}`, JSON body, `Authorization: Bearer <token>`

| Verb | Body | Answer | Who |
|---|---|---|---|
| `create` | — | `{ seq: 0 }` | any token holder; becomes the anchor owner |
| `put` | `{ path, data, basedOn?, opId? }` | `{ seq, rev }` | owner, writer |
| `delete` | `{ path, basedOn?, opId? }` | `{ seq }` | owner, writer |
| `commit` | `{ changes: [{ op: 'put' \| 'delete', path, data?, basedOn? }], opId? }` | `{ seq }` | owner, writer |
| `read` | `{ path }` | `{ data, rev }` | any member |
| `members` | — | `{ members: [{ uid, role }], everShared }` | any member |
| `setRole` | `{ uid, role }` | `{ seq }` | owner |
| `unshare` | `{ uid }` | `{ seq }` | owner |
| `softDelete` | — | `{ seq }` | owner |

- `data` is the file record, any JSON value, opaque to the service; at most `MAX_FILE_SIZE`
  (1,000,000) bytes as JSON.
- `basedOn` makes a write conditional on the path's current `rev` (`0`: the path holds no file).
  Without it the write is unconditional, last writer wins.
- A `commit` applies every change or none, bounded at `COMMIT_BOUND` (500) changes, each path at
  most once. A rename is `commit [delete old, put new]`.
- Every committed changeset takes exactly one `seq`. A file's `rev` is the `seq` of the commit
  that wrote it, so a `rev` is never reused on a path, even across a delete. Treat it as opaque.
- `setRole` grants a role or changes one. Granting `writer` or `owner` to anyone but the anchor
  owner sets the `everShared` latch in the same transaction; nothing unsets it.

Errors are `{ error }` with a status:

| `error` | Status | Meaning |
|---|---|---|
| `forbidden` | 403 | anything ungranted — bad token, no membership, deleted space, absent space — always the identical body |
| `conflict` | 409 | a `basedOn` was stale; `paths` names them; nothing was written |
| `boundExceeded` | 413 | a commit over `COMMIT_BOUND`; nothing was written |
| `invalid` | 400 | a granted caller sent a malformed request |
| `notFound` | 404 | a granted caller read a path that holds no file |

Authority is decided before the body is looked at, so a caller without the grant gets `forbidden`
whether or not the request was well-formed.

### The feed — `GET /v1/spaces/{spaceId}/feed`, a WebSocket per mounted space

```
→ hello { token, sinceSeq? }
← access { role, seq }                          first answer to a hello
← snapshot { seq, docs: [{ path, data, rev }], more? }    with no sinceSeq, or one the log no longer reaches
← delta { seq, changes: [{ path, op, rev }], opId? }      one per committed changeset, in order
← access { role, seq }   then close 4409        the socket's uid changed role: reconnect and resume
← revoked                then close 4410        the uid lost access, or the space was deleted
← forbidden              then close 4403        the hello was refused, for any reason
→ ping   ← heartbeat
          close 4401                            the socket's token reached its exp: refresh and resume
```

- **Resume.** `hello { sinceSeq }` replays every later delta exactly once, in order. The log keeps
  the last `FEED_RETENTION` (256) commits; an older `sinceSeq` gets a fresh snapshot instead.
- **Echo.** A delta carries the `opId` of the write that caused it, so a holder tells its own
  write from a remote one.
- **Deltas carry no data.** A delta names what changed; the holder reads what it needs with `read`.
- **Revocation.** A role change, an unshare or a soft delete commits, pushes `access` or
  `revoked` to the affected sockets and closes them, all in one turn. No delta reaches a socket
  after its authority changed.
- **Fail closed.** The holder treats a feed with no frame for 60 s as revoked; the reference
  client does this (`revoked('channel-lost')`). The service answers each `ping` with a
  `heartbeat`, on Cloudflare without waking the object.
- **A socket has ten seconds** to send an accepted hello.

## How it holds together

- **The core is synchronous.** `Store` is synchronous on both hosts, so every verb is one
  transaction and one turn: the commit, its delta to every socket, and — for a membership change
  — the push and the close. The only `await` in the core is the token's signature check, and
  nothing is decided before it.
- **The space's database is the only authority.** Every check that grants anything reads the
  space's own tables in the turn that acts on it.
- **The schema is the second gate.** Triggers make the states the core must never produce
  unwritable: the latch never goes back, a write-capable member cannot exist in an unlatched
  space, the anchor owner stays an owner, `rev` and `seq` never decrease.
- **Hibernation.** On Cloudflare, sockets are accepted through the hibernation API; the uid, role
  and token expiry are serialised onto each socket, and one alarm is kept at the earliest expiry.

## The scenarios

Every scenario runs in the `cloudflare` project and in the `local` project. Inputs come from the
real producer: log rows, deltas and snapshots are made by calling the service's verbs, and tokens
are signed by a real signer with a key made for the run.

| Id | File | What it proves |
|---|---|---|
| S-SS-1 | `S-SS-1.resume.test.ts` | Over a log of 300 real commits, every `sinceSeq` replays exactly the later deltas in order; a `sinceSeq` below retention gets a snapshot. |
| S-SS-2 | `S-SS-2.downgrade.test.ts` | A downgraded writer's open socket gets `access` with the committed `seq`, is closed, and receives no later delta. An unshared member gets `revoked`. Only an owner changes membership, never the anchor owner's. |
| S-SS-3 | `S-SS-3.delete.test.ts` | `softDelete` sends `revoked` to every socket; afterwards every hello and verb is `forbidden` for everyone, byte-identical to a space that never existed. |
| S-SS-4 | `S-SS-4.cas.test.ts` | A stale `basedOn` is `conflict`. A commit with one stale entry applies nothing and logs nothing. A commit of `COMMIT_BOUND + 1` is `boundExceeded`. Malformed writes are refused whole. |
| S-SS-5 | `S-SS-5.rename.test.ts` | `commit [delete old, put new]` is one delta; observers arriving during it see the old path or the new one, never both or neither. |
| S-SS-6 | `S-SS-6.latch.test.ts` | `setRole` to a non-owner writer sets the latch in the same transaction. Raw statements that would unset it, or skip it, fail on the schema's triggers. |
| S-SS-7 | `S-SS-7.token.test.ts` | An expired token, a wrong audience, a foreign key, a missing `exp` and a non-member all get the identical `forbidden`. A socket closes at its token's `exp` on the fake clock. |
| S-SS-8 | `S-SS-8.echo.test.ts` | A delta carries its writer's `opId`, live and replayed. |

Unit tests: `protocol.test.ts` (both hosts), `feedClient.test.ts` (the 60 s watchdog, resume,
echo), `queue.test.ts` (per-space queues), `hosts.test.ts` (no scenario runs on one host only),
and the drill's: `report.test.ts` (the scenario run against the local host with 200 writes, then
summarized), `mint.test.ts`, `stagingUrl.test.ts`, `costProbe.test.ts`; and `localHost.test.ts` (an absent space is indistinguishable on the feed,
case-safe file names, databases open only while in use).

## The drill

The drill is the measurement `STORE_PORTABILITY_SPEC` §5.5.7 asks for (roadmap item R3-1283): one
mounted space, one feed per member, 200 writes at a steady rate, a role downgrade, a delete, and
a 60-second channel loss — over a real network, against a real host.

```
npm run drill -- --target <url> --key-file <private-key.pem> --members <n> [--writes 200] [--interval-ms 50] [--audience <aud>]
```

It prints one `DrillReport` as JSON on stdout:

| Field | What it is |
|---|---|
| `deltaLatencyMs` | from the owner sending a `put` to each member's feed receiving its delta: p50, p95, max |
| `ackLatencyMs` | from sending a `put` to its HTTP answer |
| `deltasDelivered` | deltas received, of `writes × members` |
| `accessAfterSetRole` | latency from the downgrade request to the member's `access`; whether it came before every later delta; what the member's next write got |
| `revokedAfterDelete` | latency from the delete request to each feed's `revoked`; how many feeds got it; whether it came after each feed's last delta |
| `channelLoss` | what ended a feed that was cut off without notice, and how long after its last frame |
| `framesPerSubscriber` | frames received per member, by type |

The drill measures and records. There is no threshold in it, and none in the test suite: the
numbers are for a person to read.

The channel-loss leg stops reading from one feed's TCP socket, so nothing arrives and nothing
says so; that feed's own watchdog is what ends it. The leg takes the full 60 seconds, so a drill
run takes a little over a minute.

**The key.** `--key-file` is the PKCS#8 PEM of an ES256 private key whose public half the target
trusts. The drill signs its tokens with it (`sub` `drill:<n>`, ten minutes) and never prints,
logs or reports it.

To drill a Node host on your machine:

```
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out drill.pem
openssl pkey -in drill.pem -pubout -out drill.pub.pem
npm start -- --data-dir ./data --public-key-file drill.pub.pem --audience space-service-staging --port 8787 &
npm run drill -- --target http://127.0.0.1:8787 --key-file drill.pem --members 3
```

### Staging and the workflows

- `wrangler.toml` `[env.staging]` is the only deployment and the one home of its route, name and
  audience; `scripts/staging-url.mjs` reads them from there. There is no production environment.
- `.github/workflows/deploy-staging.yml` — on push to `main`, after the suite: `wrangler deploy
  --env staging`, then sets the Worker secret `TOKEN_PUBLIC_KEY_PEM` from `DRILL_PUBLIC_KEY_PEM`.
  Staging trusts that key and no other.
- `.github/workflows/drill.yml` — on demand: starts the Node host on the runner, drills it,
  drills the staging Worker, reads the staging run's cost, uploads `drill-report.json`
  (`{ local, staging, cost }`) and writes a summary table.
- Both run in the `staging` environment and fail at their first step, naming the secret, when
  one they need is unset: `CLOUDFLARE_API_TOKEN`, `DRILL_PUBLIC_KEY_PEM`, and for the drill
  `DRILL_PRIVATE_KEY_PEM`.
- `scripts/cost-probe.mjs` asks Cloudflare's GraphQL Analytics API for the staging Worker's and
  its objects' requests and duration over the run. When the API refuses or has nothing, the
  report says `cost: unavailable — <reason>` and the run stays green. It never estimates.

## Decisions made while building

These go beyond, or differ from, the letter of R3-1282. Each is small; each is here so it is not
rediscovered.

- **`access` is also the hello's first answer.** The spec's frame list has no acknowledgement of
  an accepted hello, and a resume with nothing to replay would otherwise say nothing. `access
  { role, seq }` announces the role the socket holds; sent again before a close, it announces
  the change.
- **The `Sockets` port is per socket**, not per uid (`list()` of sockets with `get`/`set`/`send`/
  `close`): a hello is answered on one socket, before that socket has a uid.
- **The Worker verifies the token for verbs; the object verifies it for the feed.** A browser
  cannot put a header on a WebSocket, so the token arrives in the `hello` frame, as the spec's
  protocol has it. The same verifier runs in both places. One consequence: a feed upgrade
  instantiates the space's object before any token is seen.
- **Snapshots are chunked** (`more`), so one frame never has to hold a whole space.
- **`rev` is the commit's `seq`.** It is monotonic per path, as required, and also unique across
  a delete and re-create, which a per-file counter is not.
- **Authority changes do not take a `seq`.** `seq` counts file changesets; `access` carries the
  `seq` the socket had been sent up to.
- **Retention is a count** (`FEED_RETENTION`). The spec's age bound waits for the measured numbers.
- **On the Node host, a space has no database until it is created**, so probing ids creates no
  files.
- **A space's database is open only while in use** on the Node host: it closes when no socket is
  on it and reopens on the next request, so the process does not accumulate open files.
- **File names are case-safe.** Space ids differ by case; on the Node host each capital is
  written as `_` plus its lower-case letter, so two ids never share a file on any file system.
- **The client's watchdog counts only an admitted socket's frames.** A heartbeat on a socket
  whose hello was never accepted, or an `access` that is followed by a drop, does not keep a
  mount alive.
- **`opId` is a hint, not a proof.** Any writer can send any `opId`; a holder that needs to know
  a delta is its own should also compare the `seq` its write was answered with.
- **Known limit: a stuck space still answers pings.** Heartbeats are answered outside the core
  on both hosts (that is what lets an object hibernate), so a holder's watchdog proves the
  connection, not that the space is processing requests.
- **The staging route needs a DNS record.** `[env.staging]` uses a zone route, as Baton does, so
  the hostname must resolve through Cloudflare before the first drill.
- **The cost probe's query is unverified against the live API.** Its dataset and field names
  follow Cloudflare's documentation; no token was available to run it. If a name is wrong the
  report says `unavailable` with the API's own message, which names the field.
