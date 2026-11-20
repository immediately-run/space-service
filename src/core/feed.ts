// feed.ts — the change feed and the revocation channel (STORE_PORTABILITY_SPEC §5.5.4;
// R-STORE-2, R-STORE-3). Sockets are the host's; what the core knows of each is its attachment.
// Everything here is synchronous, so a commit and its delta, or a membership change and its
// `access`/`revoked` push and close, are one turn.
import type { Claims } from './auth';
import { deltasSince, head, snapshotPages, type StoredDoc } from './files';
import type { Attachment, Ports, Socket } from './ports';
import { CLOSE, FORBIDDEN_FRAME, HELLO_TIMEOUT_MS, REVOKED_FRAME, accessFrame, deltaFrame, snapshotFrame, type DeltaChange, type Role } from './protocol';

/** Send, treating a socket that is already gone as closed. */
function send(socket: Socket, frame: string): boolean {
  try {
    socket.send(frame);
    return true;
  } catch {
    return false;
  }
}

/** Close a socket and mark it, so nothing later in this or any turn sends to it. */
function close(socket: Socket, how: { code: number; reason: string }): void {
  const a = socket.get();
  try {
    socket.set({ uid: a?.uid ?? null, role: a?.role ?? null, exp: a?.exp ?? 0, closed: true });
    socket.close(how.code, how.reason);
  } catch {
    // Already gone.
  }
}

/** The sockets the core still serves, each with its attachment. */
function open(ports: Ports): { socket: Socket; a: Attachment }[] {
  const out: { socket: Socket; a: Attachment }[] = [];
  for (const socket of ports.sockets.list()) {
    const a = socket.get();
    if (a && !a.closed) out.push({ socket, a });
  }
  return out;
}

/** Ask for the next wake-up: the earliest instant a socket must be closed. */
export function reschedule(ports: Ports): void {
  let at: number | null = null;
  for (const { a } of open(ports)) if (at === null || a.exp < at) at = a.exp;
  ports.scheduler.set(at);
}

/** A socket the host just accepted: unauthenticated, with a deadline for its hello. */
export function opened(ports: Ports, socket: Socket): void {
  socket.set({ uid: null, role: null, exp: ports.clock.now() + HELLO_TIMEOUT_MS });
  reschedule(ports);
}

/** The one answer to a refused hello. */
export function refuse(ports: Ports, socket: Socket): void {
  send(socket, FORBIDDEN_FRAME);
  close(socket, CLOSE.forbidden);
  reschedule(ports);
}

export function protocolError(ports: Ports, socket: Socket): void {
  close(socket, CLOSE.protocol);
  reschedule(ports);
}

/**
 * Admit a socket whose hello verified and whose uid holds `role`: its `access`, then every
 * delta after `sinceSeq` exactly once and in order — or, with no `sinceSeq` or one the log no
 * longer reaches, a snapshot.
 */
export function admit(ports: Ports, socket: Socket, claims: Claims, role: Role, sinceSeq: number | undefined): void {
  const { store } = ports;
  socket.set({ uid: claims.uid, role, exp: claims.exp });
  const seq = head(store);
  let alive = send(socket, accessFrame(role, seq));
  const deltas = sinceSeq === undefined ? null : deltasSince(store, sinceSeq);
  if (deltas) {
    for (const d of deltas) alive = alive && send(socket, deltaFrame(d.seq, d.changes, d.opId));
  } else {
    // One page behind, so each frame knows whether another follows.
    let held: StoredDoc[] | null = null;
    for (const page of snapshotPages(store)) {
      if (!alive) break;
      if (held) alive = send(socket, snapshotFrame(seq, held, true));
      held = page;
    }
    if (alive && held) alive = send(socket, snapshotFrame(seq, held, false));
  }
  if (!alive) close(socket, CLOSE.protocol);
  reschedule(ports);
}

/** A committed changeset, to every admitted socket. */
export function broadcast(ports: Ports, seq: number, changes: DeltaChange[], opId: string | undefined): void {
  const frame = deltaFrame(seq, changes, opId);
  const now = ports.clock.now();
  let dropped = false;
  for (const { socket, a } of open(ports)) {
    if (a.uid === null) continue;
    if (a.exp <= now) {
      close(socket, CLOSE.expired);
      dropped = true;
    } else if (!send(socket, frame)) {
      close(socket, CLOSE.protocol);
      dropped = true;
    }
  }
  if (dropped) reschedule(ports);
}

/**
 * A uid's authority changed: tell each of its sockets, then close them. A changed role is
 * `access` (the client reconnects and resumes under it); a lost membership is `revoked`.
 */
export function authorityChanged(ports: Ports, uid: string, role: Role | null): void {
  const seq = head(ports.store);
  for (const { socket, a } of open(ports)) {
    if (a.uid !== uid) continue;
    send(socket, role === null ? REVOKED_FRAME : accessFrame(role, seq));
    close(socket, role === null ? CLOSE.revoked : CLOSE.access);
  }
  reschedule(ports);
}

/** The space was tombstoned: `revoked` to every socket, then close them all. */
export function revokeAll(ports: Ports): void {
  for (const { socket, a } of open(ports)) {
    if (a.uid !== null) send(socket, REVOKED_FRAME);
    close(socket, a.uid !== null ? CLOSE.revoked : CLOSE.forbidden);
  }
  reschedule(ports);
}

/** The wake-up: close every socket whose token has expired, or whose hello never came. */
export function expire(ports: Ports): void {
  const now = ports.clock.now();
  for (const { socket, a } of open(ports)) {
    if (a.exp <= now) close(socket, a.uid === null ? CLOSE.forbidden : CLOSE.expired);
  }
  reschedule(ports);
}
