// report.test.ts (Node only) — the drill's report over samples from the real producer: the
// scenario itself, run against the local host over real sockets, with 200 writes. Only the
// channel-loss feed runs on a faster clock, so its 60 s take a tenth of a second.
import { expect, it } from 'vitest';
import { AUDIENCE, SIGNING_PEM, origin } from '#host';
import { FeedClient } from '../../src/client/feedClient';
import { SpaceClient } from '../../src/client/spaceClient';
import { CHANNEL_LOST_MS, FRAME } from '../../src/core/protocol';
import { minter } from '../../src/drill/mint';
import { summarize, quantiles } from '../../src/drill/report';
import { runScenario } from '../../src/drill/scenario';
import { stallable } from '../../src/drill/stall';
import { newSpaceId } from '../lib/harness';

const WRITES = 200;
const MEMBERS = 3;

async function drill() {
  const clock = { now: () => performance.timeOrigin + performance.now() };
  const SPEED = 600;
  const zero = clock.now();
  const lossClock = { now: () => zero + (clock.now() - zero) * SPEED };
  const lossTimers = { set: (fn: () => void, ms: number) => setTimeout(fn, ms / SPEED), clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  const spaceId = newSpaceId();
  const feedUrl = new SpaceClient({ origin: origin(), spaceId, token: () => '' }).feedUrl;
  return runScenario({
    spaceId,
    api: (token) => new SpaceClient({ origin: origin(), spaceId, token }),
    feed: ({ token, events, loss }) => {
      const sockets = stallable();
      const client = new FeedClient({ url: feedUrl, WebSocket: sockets.WebSocket, token, events, ...(loss ? { clock: lossClock, timers: lossTimers } : { clock }) });
      return {
        start: () => client.start(),
        stop: () => {
          client.stop();
          sockets.terminate();
        },
        track: (opId) => client.track(opId),
        stall: () => sockets.stall(),
        lastFrameAt: () => client.lastFrameAt,
      };
    },
    mint: await minter(SIGNING_PEM, clock, AUDIENCE),
    clock,
    lossClock,
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    members: MEMBERS,
    writes: WRITES,
    intervalMs: 0,
  });
}

/** Every leaf of a report is a value: nothing undefined, nothing NaN. */
function leaves(x: unknown, path = 'report'): string[] {
  if (x === undefined || (typeof x === 'number' && Number.isNaN(x))) return [path];
  if (x === null || typeof x !== 'object') return [];
  return Object.entries(x).flatMap(([k, v]) => leaves(v, `${path}.${k}`));
}

it('summarize reports every field over a real run of the scenario', async () => {
  const samples = await drill();
  const report = summarize(samples);

  expect(Object.keys(report).sort()).toEqual(['accessAfterSetRole', 'ackLatencyMs', 'channelLoss', 'deltaLatencyMs', 'deltasDelivered', 'framesPerSubscriber', 'members', 'revokedAfterDelete', 'spaceId', 'writes']);
  expect(leaves(report)).toEqual([]);
  expect(report).toMatchObject({ members: MEMBERS, writes: WRITES });

  // Every write reached every member's feed, and each is timed.
  expect(report.deltasDelivered).toEqual({ received: WRITES * MEMBERS, expected: WRITES * MEMBERS });
  expect(report.deltaLatencyMs.count).toBe(WRITES * MEMBERS);
  for (const q of [report.deltaLatencyMs, report.ackLatencyMs]) {
    expect(q.p50).toBeGreaterThanOrEqual(0);
    expect(q.p95).toBeGreaterThanOrEqual(q.p50!);
    expect(q.max).toBeGreaterThanOrEqual(q.p95!);
  }
  expect(report.ackLatencyMs.count).toBe(WRITES);

  // The downgrade: access first, then the later deltas, and the write refused.
  expect(report.accessAfterSetRole.latencyMs).toBeGreaterThanOrEqual(0);
  expect(report.accessAfterSetRole).toMatchObject({ beforeAnyLaterDelta: true, laterDeltas: 5, writeAfterDowngrade: 'forbidden' });

  // The delete: revoked on every feed, ordered after its last delta.
  expect(report.revokedAfterDelete).toMatchObject({ sockets: MEMBERS, of: MEMBERS, afterLastDelta: true });
  expect(report.revokedAfterDelete.latencyMs.count).toBe(MEMBERS);
  expect(report.revokedAfterDelete.latencyMs.p50).toBeGreaterThanOrEqual(0);
  for (const uid of samples.members) {
    const log = samples.events[uid];
    const lastDelta = log.findLast((e) => e.kind === 'delta')!;
    const revoked = log.find((e) => e.kind === 'revoked')!;
    expect(revoked.at).toBeGreaterThanOrEqual(lastDelta.at);
    expect(revoked).toMatchObject({ reason: 'revoked' });
    expect(revoked.at).toBeGreaterThanOrEqual(samples.softDelete.requestedAt);
  }

  // The cut-off feed heard nothing of the delete; its own watchdog ended it, no earlier than 60 s.
  expect(report.channelLoss.outcome).toBe('channel-lost');
  expect(report.channelLoss.watchdogMs).toBeGreaterThanOrEqual(CHANNEL_LOST_MS);
  expect(report.channelLoss.sinceStallMs).toBeGreaterThan(0);

  // Frame counts per subscriber; the owner's own writes came back marked as its own.
  const [owner, writer, reader] = samples.members;
  expect(report.framesPerSubscriber[owner]).toMatchObject({ [FRAME.access]: 1, [FRAME.snapshot]: 1, [FRAME.delta]: WRITES + 5, [FRAME.revoked]: 1 });
  expect(report.framesPerSubscriber[reader]).toMatchObject({ [FRAME.delta]: WRITES + 5, [FRAME.revoked]: 1 });
  // The downgraded member was told its role twice more: at the change, and on its way back in.
  expect(report.framesPerSubscriber[writer]).toMatchObject({ [FRAME.access]: 3, [FRAME.delta]: WRITES + 5 });
  expect(samples.events[owner].filter((e) => e.kind === 'delta').every((e) => e.own)).toBe(true);
  expect(samples.events[reader].some((e) => e.kind === 'delta' && e.own)).toBe(false);
}, 60_000);

it('quantiles are nearest-rank, and empty when there is nothing', () => {
  expect(quantiles([])).toEqual({ count: 0, p50: null, p95: null, max: null });
  expect(quantiles([5])).toEqual({ count: 1, p50: 5, p95: 5, max: 5 });
  expect(quantiles(Array.from({ length: 100 }, (_, i) => 100 - i))).toEqual({ count: 100, p50: 50, p95: 95, max: 100 });
});
