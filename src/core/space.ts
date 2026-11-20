// space.ts — one space's core (STORE_PORTABILITY_SPEC §5.5.1): the same class, unmodified, inside
// a Durable Object and inside the Node host. A host gives it its ports and passes it three
// things: verified requests, feed-socket events, and the wake-up it asked for.
//
// `request`, `alarm`, `opened` and `closed` are synchronous: one call is one turn, with no point
// at which another request can run. `message` awaits exactly once — the token's signature check
// — and decides nothing before it; everything after it is one turn too.
import { live, verifyToken, type Claims } from './auth';
import { migrate } from './db';
import * as feed from './feed';
import * as files from './files';
import * as members from './members';
import type { Clock, Ports, Socket } from './ports';
import {
  ERROR,
  FORBIDDEN,
  FRAME,
  HEARTBEAT_FRAME,
  OP,
  ROLE,
  VERB,
  canWrite,
  fail,
  ok,
  parseClientFrame,
  parseCommit,
  parseRead,
  parseSetRole,
  parseSingle,
  parseUnshare,
  type Changeset,
  type Reply,
  type Verb,
} from './protocol';

export class SpaceCore {
  /** The core's clock. A test replaces it; nothing else in the core reads time. */
  clock: Clock;
  private readonly ports: Ports;

  constructor(ports: Omit<Ports, 'clock'> & { clock: Clock }) {
    this.clock = ports.clock;
    const core = this;
    this.ports = { ...ports, clock: { now: () => core.clock.now() } };
    migrate(ports.store);
  }

  get store() {
    return this.ports.store;
  }

  // ── Verbs ───────────────────────────────────────────────────────────────────────────────

  /**
   * One verb for a caller whose token a host has verified. The claims are checked again here,
   * on the core's clock, and the caller's role is read from the space's own tables in this turn.
   * Authority is decided before the body is looked at, so an ungranted caller learns nothing
   * from how a request is refused.
   */
  request(verb: Verb, claims: Claims, body: unknown): Reply {
    const { store } = this.ports;
    if (!live(claims, this.clock.now())) return FORBIDDEN;
    if (verb === VERB.create) return members.create(store, claims.uid) ? ok({ seq: 0 }) : FORBIDDEN;

    const role = members.roleOf(store, claims.uid);
    if (!role) return FORBIDDEN;

    switch (verb) {
      case VERB.read: {
        const q = parseRead(body);
        if (!q) return fail(ERROR.invalid);
        const file = files.read(store, q.path);
        return file ? ok({ data: JSON.parse(file.data), rev: file.rev }) : fail(ERROR.notFound);
      }
      case VERB.members:
        return ok({ members: members.list(store), everShared: members.spaceRow(store)!.ever_shared === 1 });
      case VERB.put:
      case VERB.delete:
      case VERB.commit: {
        if (!canWrite(role)) return FORBIDDEN;
        const set = verb === VERB.commit ? parseCommit(body) : parseSingle(body, verb === VERB.put ? OP.put : OP.delete);
        if (set === ERROR.boundExceeded) return fail(ERROR.boundExceeded);
        if (!set) return fail(ERROR.invalid);
        return this.write(set, verb === VERB.put);
      }
      case VERB.setRole:
      case VERB.unshare: {
        if (role !== ROLE.owner) return FORBIDDEN;
        const grant = verb === VERB.setRole ? parseSetRole(body) : null;
        const removal = verb === VERB.unshare ? parseUnshare(body) : null;
        if (!grant && !removal) return fail(ERROR.invalid);
        const effect = grant ? members.setRole(store, grant.uid, grant.role) : members.unshare(store, removal!.uid);
        if (effect === 'anchor') return fail(ERROR.invalid);
        // The push and the close are this same turn (R-STORE-3).
        if (effect) feed.authorityChanged(this.ports, effect.uid, effect.role);
        return ok({ seq: files.head(store) });
      }
      case VERB.softDelete: {
        if (role !== ROLE.owner) return FORBIDDEN;
        const seq = files.head(store);
        members.softDelete(store);
        feed.revokeAll(this.ports);
        return ok({ seq });
      }
    }
  }

  private write(set: Changeset, single: boolean): Reply {
    const result = files.commit(this.ports.store, set.changes, set.opId, this.clock.now());
    if ('conflict' in result) return fail(ERROR.conflict, { paths: result.conflict });
    if (result.changes.length) feed.broadcast(this.ports, result.seq, result.changes, set.opId);
    return ok(single ? { seq: result.seq, rev: result.seq } : { seq: result.seq });
  }

  // ── The feed ────────────────────────────────────────────────────────────────────────────

  /** A feed socket the host just accepted. */
  opened(socket: Socket): void {
    feed.opened(this.ports, socket);
  }

  /** A text frame from a feed socket. */
  async message(socket: Socket, text: unknown): Promise<void> {
    const frame = parseClientFrame(text);
    const admitted = () => socket.get()?.uid != null;
    if (frame?.type === FRAME.ping) {
      // A host answers pings itself, without waking the core; this is the same answer.
      try {
        socket.send(HEARTBEAT_FRAME);
      } catch {
        // Gone.
      }
      return;
    }
    if (!frame) return admitted() ? feed.protocolError(this.ports, socket) : feed.refuse(this.ports, socket);
    if (admitted()) return feed.protocolError(this.ports, socket);

    const claims = await verifyToken(frame.token, this.ports.config, this.clock.now());

    // One turn from here. The socket may have been admitted, or closed, while the check ran.
    const a = socket.get();
    if (!a || a.closed) return;
    if (a.uid !== null) return feed.protocolError(this.ports, socket);
    const role = claims && live(claims, this.clock.now()) ? members.roleOf(this.ports.store, claims.uid) : null;
    if (!claims || !role) return feed.refuse(this.ports, socket);
    feed.admit(this.ports, socket, claims, role, frame.sinceSeq);
  }

  /** A feed socket closed, from either end. */
  closed(): void {
    feed.reschedule(this.ports);
  }

  /** The wake-up the core asked its Scheduler for. */
  alarm(): void {
    feed.expire(this.ports);
  }
}
