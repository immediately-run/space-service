// host.ts — the space service as one Node process (STORE_PORTABILITY_SPEC §5.5.1, §10.1): the
// same core as the Durable Object, over `node:sqlite`, one database file per space, each space
// behind its own request queue, with `ws` sockets and a timer as the wake-up.
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { WebSocket } from 'ws';
import { verifyToken } from '../core/auth';
import { bearer, forbidden, notRouted, readBody, respond, route } from '../core/http';
import type { Attachment, Clock, Config, Scheduler, Socket } from '../core/ports';
import { CLOSE, FORBIDDEN_FRAME, HEARTBEAT_FRAME, HELLO_TIMEOUT_MS, PING_FRAME, VERB } from '../core/protocol';
import { SpaceCore } from '../core/space';
import { systemClock } from './clock';
import { SpaceQueues } from './queue';
import { openStore } from './store';

export interface LocalOptions {
  /** The directory holding one `<spaceId>.sqlite` per space, or `:memory:` for none (tests). */
  dataDir: string;
  config: Config;
  clock?: Clock;
  /** `timer` wakes each space by the clock; `manual` only records the wake-up (a test ticks it). */
  alarm?: 'timer' | 'manual';
}

const MAX_TIMEOUT = 2 ** 31 - 1;

/** A `ws` socket as the core's Socket; its attachment lives in this process. */
class LocalSocket implements Socket {
  private attachment: Attachment | null = null;
  constructor(private readonly ws: WebSocket) {}
  get() {
    return this.attachment;
  }
  set(a: Attachment) {
    this.attachment = a;
  }
  send(frame: string) {
    if (this.ws.readyState !== this.ws.OPEN) throw new Error('the socket is not open');
    this.ws.send(frame);
  }
  close(code: number, reason: string) {
    this.ws.close(code, reason);
  }
}

/** A space's wake-up as a timer: one pending fire at the instant the core last asked for. */
class TimerScheduler implements Scheduler {
  at: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly now: () => number, private readonly fire: (() => void) | null) {}
  set(at: number | null) {
    this.at = at;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (at === null || !this.fire) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.fire!();
    }, Math.min(MAX_TIMEOUT, Math.max(0, at - this.now())));
    this.timer.unref();
  }
  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

interface OpenSpace {
  core: SpaceCore;
  db: DatabaseSync;
  sockets: Set<LocalSocket>;
  scheduler: TimerScheduler;
}

export class LocalHost {
  readonly queues = new SpaceQueues();
  private readonly spaces = new Map<string, OpenSpace>();
  private readonly clock: Clock;

  constructor(private readonly opts: LocalOptions) {
    this.clock = opts.clock ?? systemClock;
    if (opts.dataDir !== ':memory:') mkdirSync(opts.dataDir, { recursive: true });
  }

  /**
   * The open space, opening its database if it has one. A space that was never created has no
   * database, and only `create` makes one — so a caller probing ids leaves nothing behind.
   */
  private space(spaceId: string, create: boolean): OpenSpace | null {
    const open = this.spaces.get(spaceId);
    if (open) return open;
    const memory = this.opts.dataDir === ':memory:';
    const path = memory ? ':memory:' : join(this.opts.dataDir, `${spaceId}.sqlite`);
    if (!create && (memory || !existsSync(path))) return null;
    const { db, store } = openStore(path);
    const sockets = new Set<LocalSocket>();
    const fire = this.opts.alarm === 'manual' ? null : () => void this.queues.run(spaceId, () => made.core.alarm()).catch((e) => console.error('space-service: wake-up failed', e));
    const scheduler = new TimerScheduler(() => made.core.clock.now(), fire);
    const made: OpenSpace = {
      db,
      sockets,
      scheduler,
      core: new SpaceCore({ store, clock: this.clock, sockets: { list: () => [...sockets] }, scheduler, config: this.opts.config }),
    };
    this.spaces.set(spaceId, made);
    return made;
  }

  /** The core of a space that exists, for tests that drive it directly. */
  core(spaceId: string): SpaceCore | null {
    return this.space(spaceId, false)?.core ?? null;
  }

  /** A verb request, answered as the Worker answers it. */
  async handle(req: Request): Promise<Response> {
    const r = route(req.method, req.url);
    if (!r || 'feed' in r) return notRouted();
    return this.queues.run(r.spaceId, async () => {
      const claims = await verifyToken(bearer(req), this.opts.config, this.clock.now());
      if (!claims) return forbidden();
      const body = await readBody(req);
      const space = this.space(r.spaceId, r.verb === VERB.create);
      if (!space) return forbidden();
      return respond(space.core.request(r.verb, claims, body));
    });
  }

  /** A feed socket for `spaceId`, just upgraded. */
  connect(spaceId: string, ws: WebSocket): void {
    const socket = new LocalSocket(ws);
    const refuse = () => {
      try {
        if (ws.readyState === ws.OPEN) ws.send(FORBIDDEN_FRAME);
        ws.close(CLOSE.forbidden.code, CLOSE.forbidden.reason);
      } catch {
        // Gone.
      }
    };
    /** The socket's space, with the socket registered on it — or null while no such space exists. */
    let gone = false;
    const joined = (): OpenSpace | null => {
      const space = this.space(spaceId, false);
      if (space && !gone && !space.sockets.has(socket)) {
        space.sockets.add(socket);
        space.core.opened(socket);
      }
      return space;
    };
    // A socket on a space that does not exist looks, from outside, like any socket awaiting its
    // hello: it is refused when the hello comes, or at the same deadline.
    const deadline = setTimeout(() => void this.queues.run(spaceId, () => void (joined() ?? refuse())), HELLO_TIMEOUT_MS);
    deadline.unref();
    void this.queues.run(spaceId, () => void joined());

    ws.on('message', (data, isBinary) => {
      const text = isBinary ? null : data.toString();
      // Heartbeats are answered here, outside the queue: a ping never waits behind a request.
      if (text === PING_FRAME) {
        if (ws.readyState === ws.OPEN) ws.send(HEARTBEAT_FRAME);
        return;
      }
      void this.queues
        .run(spaceId, async () => {
          const space = joined();
          if (gone) return;
          if (!space) return refuse();
          await space.core.message(socket, text);
        })
        .catch((e) => console.error('space-service: socket message failed', e));
    });
    ws.on('close', () => {
      gone = true;
      clearTimeout(deadline);
      void this.queues.run(spaceId, () => {
        const space = this.spaces.get(spaceId);
        if (space?.sockets.delete(socket)) space.core.closed();
      });
    });
    ws.on('error', () => ws.terminate());
  }

  /** One wake-up now, in its turn. */
  tick(spaceId: string): Promise<void> {
    return this.queues.run(spaceId, () => this.space(spaceId, false)?.core.alarm());
  }

  /** Close every socket and database. */
  stop(): void {
    for (const space of this.spaces.values()) {
      space.scheduler.stop();
      for (const s of space.sockets) s.close(1001, 'going away');
      space.db.close();
    }
    this.spaces.clear();
  }
}
