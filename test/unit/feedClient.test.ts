// feedClient.test.ts (Node only) — the reference client's fail-closed watchdog and its resume,
// on fake timers. The frames it is fed are built by the protocol's own builders.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FeedClient, type FeedEvents, type RevokedReason } from '../../src/client/feedClient';
import { FORBIDDEN_FRAME, HEARTBEAT_FRAME, PING_FRAME, REVOKED_FRAME, accessFrame, deltaFrame, helloFrame, snapshotFrame } from '../../src/core/protocol';

class FakeSocket {
  static all: FakeSocket[] = [];
  sent: string[] = [];
  closed = false;
  private listeners: Record<string, ((event: any) => void)[]> = {};
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  addEventListener(type: string, fn: (event: any) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, event: any = {}) {
    for (const fn of this.listeners[type] ?? []) fn(event);
  }
  frame(data: string) {
    this.emit('message', { data });
  }
}

const clock = { now: () => Date.now() };
let revoked: RevokedReason[];
let log: string[];
const events: FeedEvents = {
  revoked: (reason) => revoked.push(reason),
  snapshot: (docs, seq) => log.push(`snapshot ${seq} ${docs.map((d) => d.path).join(',')}`),
  delta: (d, own) => log.push(`delta ${d.seq}${own ? ' own' : ''}`),
  access: (role, seq) => log.push(`access ${role} ${seq}`),
};
const make = (extra: { sinceSeq?: number } = {}) => new FeedClient({ url: 'ws://x/feed', WebSocket: FakeSocket, clock, token: () => 'tok', events, ...extra });
/** The client's current socket, opened. */
async function opened(): Promise<FakeSocket> {
  await vi.advanceTimersByTimeAsync(0);
  const socket = FakeSocket.all.at(-1)!;
  socket.emit('open');
  return socket;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
  revoked = [];
  log = [];
});
afterEach(() => vi.useRealTimers());

it('59 s of silence keeps the client live; 60 s emits revoked(channel-lost)', async () => {
  const client = make();
  client.start();
  const socket = await opened();
  expect(socket.sent).toEqual([helloFrame('tok')]);

  await vi.advanceTimersByTimeAsync(59_000);
  expect(revoked).toEqual([]);
  // It has been pinging all along; silence is the service's, not the client's.
  expect(socket.sent.filter((f) => f === PING_FRAME)).toHaveLength(2);

  await vi.advanceTimersByTimeAsync(1_000);
  expect(revoked).toEqual(['channel-lost']);
  expect(socket.closed).toBe(true);
  // Terminal: no reconnect, no second report.
  await vi.advanceTimersByTimeAsync(600_000);
  expect(revoked).toEqual(['channel-lost']);
  expect(FakeSocket.all).toHaveLength(1);
});

it('a heartbeat resets the timer', async () => {
  const client = make();
  client.start();
  const socket = await opened();
  socket.frame(accessFrame('reader', 0));
  await vi.advanceTimersByTimeAsync(30_000);
  socket.frame(HEARTBEAT_FRAME);
  await vi.advanceTimersByTimeAsync(59_999);
  expect(revoked).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(revoked).toEqual(['channel-lost']);
});

it('heartbeats on a socket that was never admitted do not keep the mount alive', async () => {
  const client = make();
  client.start();
  const socket = await opened();
  for (let t = 0; t < 59_000; t += 1_000) {
    socket.frame(HEARTBEAT_FRAME);
    await vi.advanceTimersByTimeAsync(1_000);
  }
  expect(revoked).toEqual([]);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(revoked).toEqual(['channel-lost']);
});

it('being admitted and dropped, over and over, still fails closed at 60 s', async () => {
  const client = make();
  client.start();
  for (let i = 0; i < 400 && !revoked.length; i++) {
    const socket = await opened();
    socket.frame(accessFrame('reader', 7));
    socket.emit('close', { code: 4400 });
    await vi.advanceTimersByTimeAsync(1_000);
  }
  expect(revoked).toEqual(['channel-lost']);
  // It backed off rather than hammering: a handful of attempts, not hundreds.
  expect(FakeSocket.all.length).toBeLessThan(40);
});

it('a socket that keeps failing to connect still fails closed at 60 s', async () => {
  const client = make();
  client.start();
  for (let i = 0; i < 100 && !revoked.length; i++) {
    await vi.advanceTimersByTimeAsync(0);
    FakeSocket.all.at(-1)!.emit('close', { code: 1006 });
    await vi.advanceTimersByTimeAsync(1_000);
  }
  expect(revoked).toEqual(['channel-lost']);
  expect(FakeSocket.all.length).toBeGreaterThan(5);
});

it('resumes from its last seq after a disconnect, and tells its own writes by opId', async () => {
  const client = make();
  client.start();
  const first = await opened();
  first.frame(accessFrame('writer', 0));
  first.frame(snapshotFrame(0, [{ path: '/a', rev: 1, data: '1' }], true));
  first.frame(snapshotFrame(0, [{ path: '/b', rev: 1, data: '2' }], false));
  client.track('mine');
  first.frame(deltaFrame(1, [{ path: '/a', op: 'put', rev: 1 }], 'mine'));
  first.frame(deltaFrame(2, [{ path: '/a', op: 'put', rev: 2 }], 'theirs'));
  expect(log).toEqual(['access writer 0', 'snapshot 0 /a,/b', 'delta 1 own', 'delta 2']);

  // The role changed: access, then the service closes the socket. The client comes back.
  first.frame(accessFrame('reader', 2));
  first.emit('close', { code: 4409 });
  await vi.advanceTimersByTimeAsync(250);
  const second = await opened();
  expect(second).not.toBe(first);
  expect(second.sent).toEqual([helloFrame('tok', 2)]);
  second.frame(accessFrame('reader', 3));
  // A replayed delta at or below its seq is not delivered twice.
  second.frame(deltaFrame(2, [{ path: '/a', op: 'put', rev: 2 }]));
  second.frame(deltaFrame(3, [{ path: '/c', op: 'put', rev: 3 }]));
  expect(log.slice(4)).toEqual(['access reader 2', 'access reader 3', 'delta 3']);
  expect(client.role).toBe('reader');
  expect(revoked).toEqual([]);
  client.stop();
});

it('revoked and forbidden frames are terminal', async () => {
  for (const [frame, reason] of [[REVOKED_FRAME, 'revoked'], [FORBIDDEN_FRAME, 'forbidden']] as const) {
    revoked = [];
    const client = make();
    client.start();
    const socket = await opened();
    socket.frame(frame);
    socket.emit('close', { code: 4410 });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(revoked).toEqual([reason]);
    expect(FakeSocket.all.at(-1)).toBe(socket);
  }
});
