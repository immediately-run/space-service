// report.ts — the drill's report (STORE_PORTABILITY_SPEC §5.5.7): the samples reduced to the
// numbers the decision reads. Pure. It reports; it does not pass or fail anything.
import { ROLE } from '../core/protocol';
import type { FeedEvent, Samples } from './scenario';

export interface Quantiles {
  count: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

export interface DrillReport {
  spaceId: string;
  members: number;
  writes: number;
  /** From the writer sending a put to each subscriber's feed receiving its delta. */
  deltaLatencyMs: Quantiles;
  /** From sending a put to its HTTP answer. */
  ackLatencyMs: Quantiles;
  /** How many of the `writes × members` deltas arrived. */
  deltasDelivered: { received: number; expected: number };
  accessAfterSetRole: {
    /** From asking for the downgrade to the downgraded member's feed receiving `access`. */
    latencyMs: number | null;
    /** No delta committed after the downgrade reached that member before its `access` did. */
    beforeAnyLaterDelta: boolean;
    /** Deltas committed after the downgrade that the member did receive, afterwards, as a reader. */
    laterDeltas: number;
    /** What a write by the downgraded member got: an error code, or `ok`. */
    writeAfterDowngrade: string;
  };
  revokedAfterDelete: {
    /** From asking for the delete to each feed receiving `revoked`. */
    latencyMs: Quantiles;
    /** Feeds that were told `revoked`, of those open. */
    sockets: number;
    of: number;
    /** On every feed, `revoked` arrived after its last delta, and nothing arrived after it. */
    afterLastDelta: boolean;
  };
  channelLoss: {
    /** What ended the cut-off feed: `channel-lost`, another reason, or `not-fired`. */
    outcome: string;
    /** From the feed's last frame to its watchdog firing. */
    watchdogMs: number | null;
    /** From the cut-off to the watchdog firing. */
    sinceStallMs: number | null;
  };
  /** Per subscriber, the frames it received, by type. */
  framesPerSubscriber: Record<string, Record<string, number>>;
}

const round = (n: number) => Math.round(n * 10) / 10;

export function quantiles(values: number[]): Quantiles {
  if (!values.length) return { count: 0, p50: null, p95: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => round(sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]);
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), max: round(sorted[sorted.length - 1]) };
}

export function summarize(s: Samples): DrillReport {
  const sentAt = new Map(s.writes.map((w) => [w.opId, w.sentAt]));
  const delta: number[] = [];
  for (const uid of s.members) {
    for (const e of s.events[uid]) {
      if (e.kind !== 'delta' || e.opId === undefined) continue;
      const sent = sentAt.get(e.opId);
      if (sent !== undefined) delta.push(e.at - sent);
    }
  }

  // The downgraded member: its `access` as a reader, against the deltas committed after it.
  const downgraded = s.events[s.downgrade.uid];
  const accessIndex = downgraded.findIndex((e) => e.kind === 'access' && e.at >= s.downgrade.requestedAt && e.role === ROLE.reader);
  const access = accessIndex < 0 ? null : downgraded[accessIndex];
  const later = downgraded.map((e, i) => ({ e, i })).filter(({ e }) => e.kind === 'delta' && e.seq > s.downgrade.seq);

  const revoked: number[] = [];
  let afterLastDelta = true;
  for (const uid of s.members) {
    const log = s.events[uid];
    const index = log.findIndex((e) => e.kind === 'revoked');
    if (index < 0) continue;
    revoked.push(log[index].at - s.softDelete.requestedAt);
    const lastDelta = log.findLast((e: FeedEvent) => e.kind === 'delta');
    if (index !== log.length - 1 || (lastDelta && lastDelta.at > log[index].at)) afterLastDelta = false;
  }

  const { loss } = s;
  return {
    spaceId: s.spaceId,
    members: s.members.length,
    writes: s.writes.length,
    deltaLatencyMs: quantiles(delta),
    ackLatencyMs: quantiles(s.writes.map((w) => w.ackedAt - w.sentAt)),
    deltasDelivered: { received: delta.length, expected: s.writes.length * s.members.length },
    accessAfterSetRole: {
      latencyMs: access ? round(access.at - s.downgrade.requestedAt) : null,
      beforeAnyLaterDelta: access !== null && later.every(({ i }) => i > accessIndex),
      laterDeltas: later.length,
      writeAfterDowngrade: s.downgrade.writeAfter,
    },
    revokedAfterDelete: { latencyMs: quantiles(revoked), sockets: revoked.length, of: s.members.length, afterLastDelta: afterLastDelta && revoked.length === s.members.length },
    channelLoss: {
      outcome: loss.reason ?? 'not-fired',
      watchdogMs: loss.firedAt === null ? null : round(loss.firedAt - loss.lastFrameAt),
      sinceStallMs: loss.firedAt === null ? null : round(loss.firedAt - loss.stalledAt),
    },
    framesPerSubscriber: s.frames,
  };
}
