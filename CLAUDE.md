# CLAUDE.md — space-service

The space service is specified by `STORE_PORTABILITY_SPEC` §5.5 in `immediately-run/docs`
(`content/specs/STORE_PORTABILITY_SPEC.mdx`) and built through that repository's roadmap items
(project `space-service`). Read the item and the sections it cites before changing anything. See
`README.md` for the layout, the wire contract and the scenario table.

## Rules

- **One core, two hosts.** Everything under `src/core/` is runtime-neutral: it names only the
  ports in `src/core/ports.ts` and never asks which host it is on (no `typeof WebSocketPair`, no
  `globalThis.…`, no `node:` or `cloudflare:` import). `src/cloudflare/` and `src/local/` are
  wiring.
- **One suite, both hosts.** Every file in `test/integration/` runs in the `cloudflare` project
  and in the `local` project. `NODE_ONLY` in `vitest.config.ts` may name `test/unit/` files
  only; `test/unit/hosts.test.ts` fails the run otherwise. Never skip a scenario on one host.
- **One clock.** The core reads time only through its `clock`; tests replace it. `Date.now()`
  appears in `src/` only in `src/cloudflare/clock.ts` and `src/local/clock.ts`.
- **One home for the protocol.** Every verb, frame type, error code, close code and limit is in
  `src/core/protocol.ts`. No other file spells a frame's `type` string.
- **The space's database is the only authority.** Every decision that grants anything reads the
  space's own tables in the turn that acts on it. Nothing cached, nothing from another store.
- **Uniform refusal.** Anything ungranted is the same `forbidden`: bad token, no membership,
  deleted space, absent space. Decide authority before looking at the request body.
- **Trust only verified tokens, and only the configured key.** No key in `wrangler.toml`; test
  keys are made per run in `vitest.config.ts`. A token without `exp` is refused.
- **Migrations are append-only.** A schema change is a new file in `src/migrations/` and a new
  entry in its `index.ts`.
- **Test inputs come from the real producer.** Log rows, deltas and snapshots are produced by
  calling the service's verbs; tokens are signed by a real signer.
