// feedClient.ts — the reference client of the feed (STORE_PORTABILITY_SPEC §5.5.4), for whoever
// holds a mount: the drill today, the host's adapter later. Runtime-neutral: it is handed a
// WebSocket constructor, a Clock and (optionally) timers.
//
// It resumes from its last `seq` after any disconnect, tells its own writes' echoes apart by
// `opId`, and holds the fail-closed rule (R-STORE-3): a feed from which no frame has arrived for
// CHANNEL_LOST_MS is reported as revoked, whatever the reason for the silence.
import type { Clock } from '../core/ports';
import { CHANNEL_LOST_MS, FRAME, PING_FRAME, PING_INTERVAL_MS, helloFrame, parseServerFrame, type DeltaChange, type Doc, type Role } from '../core/protocol';

/** The part of the WebSocket API the client uses; browsers', Node's and `ws`'s all fit. */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: any) => void): void;
}
export type WebSocketConstructor = new (url: string) => WebSocketLike;

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}
const systemTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

export interface Delta {
  seq: number;
  changes: DeltaChange[];
  opId?: string;
}

/** Why a mount lost its authority: the service said so, refused the hello, or went silent. */
export type RevokedReason = 'revoked' | 'forbidden' | 'channel-lost';

export interface FeedEvents {
  /** The whole space as of `seq`: at first connect, and whenever a resume was not possible. */
  snapshot?(docs: Doc[], seq: number): void;
  /** One committed changeset. `own` when its `opId` is one this client was told to expect. */
  delta?(delta: Delta, own: boolean): void;
  /** The role the feed holds: after every hello, and when it changes. */
  access?(role: Role, seq: number): void;
  /** Terminal: the client has stopped. Tear the mount down. */
  revoked?(reason: RevokedReason): void;
  /** Every frame as it arrives, for measurement. */
  frame?(type: string): void;
}

export interface FeedClientOptions {
  /** `ws://` or `wss://` URL of the space's feed. */
  url: string;
  WebSocket: WebSocketConstructor;
  clock: Clock;
  timers?: Timers;
  /** A currently valid token; called at every (re)connect, so it may refresh. */
  token: () => Promise<string> | string;
  /** Resume from here instead of asking for a snapshot. */
  sinceSeq?: number;
  events: FeedEvents;
  /** First reconnect delay; it doubles up to `maxBackoffMs`. */
  backoffMs?: number;
  maxBackoffMs?: number;
}

export class FeedClient {
  /** The last seq this client has fully received; undefined before the first snapshot. */
  seq: number | undefined;
  role: Role | null = null;
  /** When the last frame arrived (or when the client started), by its Clock. */
  lastFrameAt = 0;
  /** Set once the client has reported `revoked`. */
  revoked: RevokedReason | null = null;

  private readonly timers: Timers;
  private socket: WebSocketLike | null = null;
  private generation = 0;
  private running = false;
  private backoff: number;
  private watchdog: unknown;
  private pinger: unknown;
  private retry: unknown;
  private readonly pending = new Set<string>();
  private partial: Doc[] = [];
  /** The current socket's hello was accepted. */
  private admitted = false;

  constructor(private readonly opts: FeedClientOptions) {
    this.timers = opts.timers ?? systemTimers;
    this.seq = opts.sinceSeq;
    this.backoff = opts.backoffMs ?? 250;
  }

  /** Connect, and stay connected until `stop()` or `revoked`. */
  start(): void {
    if (this.running || this.revoked) return;
    this.running = true;
    this.lastFrameAt = this.opts.clock.now();
    this.armWatchdog();
    this.pinger = this.timers.set(() => this.ping(), PING_INTERVAL_MS);
    void this.connect();
  }

  /** Disconnect for good, without reporting anything. */
  stop(): void {
    this.running = false;
    this.generation++;
    for (const t of [this.watchdog, this.pinger, this.retry]) if (t !== undefined) this.timers.clear(t);
    this.watchdog = this.pinger = this.retry = undefined;
    this.drop();
  }

  /** Expect a delta carrying `opId`: a write this holder is about to make. */
  track(opId: string): void {
    this.pending.add(opId);
  }

  /** Stop expecting `opId`: its write failed, so no delta will carry it. */
  untrack(opId: string): void {
    this.pending.delete(opId);
  }

  private drop(): void {
    const s = this.socket;
    this.socket = null;
    try {
      s?.close();
    } catch {
      // Already closed.
    }
  }

  private fail(reason: RevokedReason): void {
    if (this.revoked) return;
    this.revoked = reason;
    this.stop();
    this.opts.events.revoked?.(reason);
  }

  private armWatchdog(): void {
    if (this.watchdog !== undefined) this.timers.clear(this.watchdog);
    const due = this.lastFrameAt + CHANNEL_LOST_MS - this.opts.clock.now();
    this.watchdog = this.timers.set(() => {
      this.watchdog = undefined;
      if (!this.running) return;
      if (this.opts.clock.now() - this.lastFrameAt >= CHANNEL_LOST_MS) this.fail('channel-lost');
      else this.armWatchdog();
    }, Math.max(0, due));
  }

  private ping(): void {
    if (!this.running) return;
    try {
      this.socket?.send(PING_FRAME);
    } catch {
      // Not open; the close handler reconnects, the watchdog decides.
    }
    this.pinger = this.timers.set(() => this.ping(), PING_INTERVAL_MS);
  }

  private async connect(): Promise<void> {
    const generation = ++this.generation;
    const current = () => this.running && generation === this.generation;
    let token: string;
    try {
      token = await this.opts.token();
    } catch {
      if (current()) this.reconnect();
      return;
    }
    if (!current()) return;
    let socket: WebSocketLike;
    try {
      socket = new this.opts.WebSocket(this.opts.url);
    } catch {
      this.reconnect();
      return;
    }
    this.socket = socket;
    this.partial = [];
    this.admitted = false;
    socket.addEventListener('open', () => {
      if (!current()) return;
      try {
        socket.send(helloFrame(token, this.seq));
      } catch {
        // The close handler reconnects.
      }
    });
    socket.addEventListener('message', (event) => {
      if (current()) this.receive(event.data);
    });
    const lost = () => {
      if (!current()) return;
      this.socket = null;
      this.reconnect();
    };
    socket.addEventListener('close', lost);
    socket.addEventListener('error', lost);
  }

  private reconnect(): void {
    this.generation++;
    this.drop();
    if (this.retry !== undefined) this.timers.clear(this.retry);
    this.retry = this.timers.set(() => {
      this.retry = undefined;
      if (this.running) void this.connect();
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, this.opts.maxBackoffMs ?? 5000);
  }

  private receive(data: unknown): void {
    const frame = parseServerFrame(data);
    if (!frame) return;
    const { events } = this.opts;
    events.frame?.(frame.type);
    if (frame.type === FRAME.access) {
      // Admitted — which is not yet proof the feed works. A socket that is admitted and then
      // dropped, over and over, must still run out the watchdog, so `access` neither feeds it
      // nor resets the backoff.
      this.admitted = true;
      this.role = frame.role;
      events.access?.(frame.role, frame.seq);
      return;
    }
    // The feed is alive when an admitted socket delivers: a heartbeat on a socket whose hello
    // was never accepted says nothing about this holder's access.
    if (this.admitted || frame.type === FRAME.revoked || frame.type === FRAME.forbidden) {
      this.lastFrameAt = this.opts.clock.now();
      this.armWatchdog();
      this.backoff = this.opts.backoffMs ?? 250;
    }
    switch (frame.type) {
      case FRAME.snapshot:
        this.partial.push(...frame.docs);
        if (frame.more) return;
        this.seq = frame.seq;
        events.snapshot?.(this.partial, frame.seq);
        this.partial = [];
        return;
      case FRAME.delta: {
        // A resumed feed replays from the client's seq; anything at or below it is a repeat.
        if (this.seq !== undefined && frame.seq <= this.seq) return;
        this.seq = frame.seq;
        const own = frame.opId !== undefined && this.pending.delete(frame.opId);
        events.delta?.({ seq: frame.seq, changes: frame.changes, ...(frame.opId === undefined ? {} : { opId: frame.opId }) }, own);
        return;
      }
      case FRAME.revoked:
        return this.fail('revoked');
      case FRAME.forbidden:
        return this.fail('forbidden');
      case FRAME.heartbeat:
        return;
    }
  }
}
