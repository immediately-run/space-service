// scenario.ts — the R-STORE-2/3 drill (STORE_PORTABILITY_SPEC §5.5.7, §8 Q3), as a pure scenario:
// one mounted space, one feed per member, a steady run of writes, a role downgrade, a delete,
// and a channel loss. It is handed everything that touches the outside — the verbs, the feeds,
// the minter, the clock — and returns raw samples; src/drill/report.ts turns those into numbers.
//
// It measures and records. It judges nothing: there is no threshold in here.
import type { FeedEvents, RevokedReason } from '../client/feedClient';
import type { SpaceClient } from '../client/spaceClient';
import type { Clock } from '../core/ports';
import { CHANNEL_LOST_MS, ROLE, type Role } from '../core/protocol';

/** A feed as the scenario drives it. */
export interface DrillFeed {
  start(): void;
  stop(): void;
  track(opId: string): void;
  /** Cut the feed off without telling it: its socket is no longer read. */
  stall(): void;
  /** When its last frame arrived, on the clock the feed was given. */
  lastFrameAt(): number;
}

export type Token = () => Promise<string>;

export interface ScenarioDeps {
  spaceId: string;
  /** The verbs, as the holder of `token`. */
  api(token: Token): Pick<SpaceClient, 'create' | 'put' | 'setRole' | 'softDelete'>;
  /** A feed, as the holder of `token`. `loss` marks the channel-loss leg's feed. */
  feed(args: { token: Token; events: FeedEvents; loss: boolean }): DrillFeed;
  mint(uid: string): Promise<string>;
  clock: Clock;
  /** The clock the channel-loss feed runs on, when it is not `clock`. */
  lossClock?: Clock;
  sleep(ms: number): Promise<void>;
  /** Members of the space, the owner included: one owner, one writer, the rest readers. */
  members: number;
  /** How many files the owner writes, one every `intervalMs`. */
  writes: number;
  intervalMs: number;
  /** Writes made after the downgrade, so "no later delta before access" has deltas to order. */
  tailWrites?: number;
  /** How long any one step may take before the drill gives up. */
  timeoutMs?: number;
}

export type FeedEvent =
  | { kind: 'snapshot'; at: number; seq: number }
  | { kind: 'delta'; at: number; seq: number; opId?: string; own: boolean }
  | { kind: 'access'; at: number; seq: number; role: Role }
  | { kind: 'revoked'; at: number; reason: RevokedReason };

export interface WriteSample {
  opId: string;
  seq: number;
  sentAt: number;
  ackedAt: number;
}

export interface Samples {
  spaceId: string;
  /** The members' uids: owner, writer, then readers. */
  members: string[];
  writes: WriteSample[];
  tail: WriteSample[];
  /** Per member, everything its feed reported, in arrival order. */
  events: Record<string, FeedEvent[]>;
  /** Per member, how many frames of each type arrived. */
  frames: Record<string, Record<string, number>>;
  downgrade: { uid: string; requestedAt: number; ackedAt: number; seq: number; writeAfter: string };
  softDelete: { requestedAt: number; ackedAt: number };
  /** The channel-loss leg, on `lossClock`. `firedAt` stays null if the watchdog never fired. */
  loss: { uid: string; stalledAt: number; lastFrameAt: number; firedAt: number | null; reason: RevokedReason | null };
}

export async function runScenario(d: ScenarioDeps): Promise<Samples> {
  if (d.members < 3) throw new Error('the drill needs at least three members: an owner, a writer and a reader');
  const { clock } = d;
  const lossClock = d.lossClock ?? clock;
  const timeoutMs = d.timeoutMs ?? 30_000;
  const uids = Array.from({ length: d.members }, (_, i) => `drill:${i}`);
  const [owner, writer] = uids;
  const lossUid = uids[uids.length - 1];
  const tokenOf = (uid: string): Token => () => d.mint(uid);
  const as = (uid: string) => d.api(tokenOf(uid));

  async function until(done: () => boolean, what: string, on: Clock = clock, limit: number = timeoutMs): Promise<void> {
    const deadline = on.now() + limit;
    while (!done()) {
      if (on.now() > deadline) throw new Error(`the drill gave up waiting for ${what}`);
      await d.sleep(5);
    }
  }
  async function must<T extends { ok: boolean }>(result: Promise<T>, what: string): Promise<Extract<T, { ok: true }>> {
    const r = await result;
    if (!r.ok) throw new Error(`${what} was refused: ${(r as unknown as { error: string }).error}`);
    return r as Extract<T, { ok: true }>;
  }

  const events: Samples['events'] = {};
  const frames: Samples['frames'] = {};
  const feeds = new Map<string, DrillFeed>();
  const extra: DrillFeed[] = [];
  const saw = (uid: string, match: (e: FeedEvent) => boolean) => events[uid].some(match);
  const everyone = (match: (e: FeedEvent) => boolean) => uids.every((uid) => saw(uid, match));

  try {
    // One space; one owner, one writer, the rest readers.
    await must(as(owner).create(), 'create');
    await must(as(owner).setRole(writer, ROLE.writer), 'setRole writer');
    for (const uid of uids.slice(2)) await must(as(owner).setRole(uid, ROLE.reader), 'setRole reader');

    // One feed per member, each recording what arrives and when.
    for (const uid of uids) {
      const log: FeedEvent[] = (events[uid] = []);
      const counts: Record<string, number> = (frames[uid] = {});
      const feed = d.feed({
        token: tokenOf(uid),
        loss: false,
        events: {
          snapshot: (_docs, seq) => log.push({ kind: 'snapshot', at: clock.now(), seq }),
          delta: (delta, own) => log.push({ kind: 'delta', at: clock.now(), seq: delta.seq, ...(delta.opId === undefined ? {} : { opId: delta.opId }), own }),
          access: (role, seq) => log.push({ kind: 'access', at: clock.now(), seq, role }),
          revoked: (reason) => log.push({ kind: 'revoked', at: clock.now(), reason }),
          frame: (type) => (counts[type] = (counts[type] ?? 0) + 1),
        },
      });
      feeds.set(uid, feed);
      feed.start();
    }
    await until(() => everyone((e) => e.kind === 'snapshot'), "every member's snapshot");

    // The channel-loss leg, alongside everything else: one more feed, cut off once it is live.
    const loss: Samples['loss'] = { uid: lossUid, stalledAt: 0, lastFrameAt: 0, firedAt: null, reason: null };
    let lossLive = false;
    const lossFeed = d.feed({
      token: tokenOf(lossUid),
      loss: true,
      events: {
        snapshot: () => (lossLive = true),
        revoked: (reason) => {
          loss.firedAt = lossClock.now();
          loss.reason = reason;
        },
      },
    });
    extra.push(lossFeed);
    lossFeed.start();
    await until(() => lossLive, "the channel-loss feed's snapshot");
    lossFeed.stall();
    loss.stalledAt = lossClock.now();

    // The owner writes at a steady rate; every feed records each delta's arrival.
    async function write(i: number, prefix: string): Promise<WriteSample> {
      const opId = `${prefix}-${i}`;
      feeds.get(owner)!.track(opId);
      const sentAt = clock.now();
      const r = await must(as(owner).put(`/drill/${prefix}/${i}.json`, { i, note: 'the drill wrote this' }, { opId }), 'put');
      return { opId, seq: r.seq, sentAt, ackedAt: clock.now() };
    }
    const writes: WriteSample[] = [];
    const started = clock.now();
    for (let i = 0; i < d.writes; i++) {
      const wait = started + i * d.intervalMs - clock.now();
      if (wait > 0) await d.sleep(wait);
      writes.push(await write(i, 'w'));
    }
    const lastWrite = writes[writes.length - 1].seq;
    await until(() => everyone((e) => e.kind === 'delta' && e.seq === lastWrite), 'the last write on every feed');

    // The downgrade: the writer becomes a reader while its feed is open.
    const downgrade: Samples['downgrade'] = { uid: writer, requestedAt: clock.now(), ackedAt: 0, seq: 0, writeAfter: '' };
    downgrade.seq = (await must(as(owner).setRole(writer, ROLE.reader), 'setRole reader (downgrade)')).seq;
    downgrade.ackedAt = clock.now();
    await until(() => saw(writer, (e) => e.kind === 'access' && e.role === ROLE.reader), "the downgraded member's access");
    const refused = await as(writer).put('/drill/after-downgrade.json', {});
    downgrade.writeAfter = refused.ok ? 'ok' : refused.error;
    const tail: WriteSample[] = [];
    for (let i = 0; i < (d.tailWrites ?? 5); i++) tail.push(await write(i, 't'));
    const lastTail = tail[tail.length - 1]?.seq ?? lastWrite;
    await until(() => everyone((e) => e.kind === 'delta' && e.seq === lastTail), 'the writes after the downgrade on every feed');

    // The delete.
    const softDelete = { requestedAt: clock.now(), ackedAt: 0 };
    await must(as(owner).softDelete(), 'softDelete');
    softDelete.ackedAt = clock.now();
    await until(() => everyone((e) => e.kind === 'revoked'), "every member's revoked");

    // The cut-off feed hears none of it; its own watchdog is what ends it.
    await until(() => loss.firedAt !== null, 'the channel-loss watchdog', lossClock, CHANNEL_LOST_MS + timeoutMs);
    loss.lastFrameAt = lossFeed.lastFrameAt();

    return { spaceId: d.spaceId, members: uids, writes, tail, events, frames, downgrade, softDelete, loss };
  } finally {
    for (const feed of [...feeds.values(), ...extra]) feed.stop();
  }
}
