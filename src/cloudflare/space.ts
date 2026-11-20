// space.ts — the `Space` Durable Object (STORE_PORTABILITY_SPEC §5.5.1, §5.5.4): wiring only. One
// object per space. It hands the core its ports — the object's SQLite as the Store, its
// hibernatable WebSockets as the Sockets, its alarm as the Scheduler — and passes every request,
// socket event and alarm through. The object's input gate is what makes each synchronous core
// call one turn.
//
// Only the SQL storage API is used, never the key-value one.
import { DurableObject } from 'cloudflare:workers';
import { forbidden, notRouted, readBody, respond, route } from '../core/http';
import type { Attachment, Cursor, Row, Socket, SqlValue, Store } from '../core/ports';
import { HEARTBEAT_FRAME, PING_FRAME } from '../core/protocol';
import { SpaceCore } from '../core/space';
import { systemClock } from './clock';

/** The verified caller, from the Worker to the object. Only the Worker can reach the object. */
export const UID_HEADER = 'x-space-uid';
export const EXP_HEADER = 'x-space-exp';

/** `ctx.storage` as the core's Store: the same synchronous SQLite, unchanged. */
export function durableStore(storage: DurableObjectStorage): Store {
  return {
    exec: <T = Row>(query: string, ...params: unknown[]) => storage.sql.exec(query, ...(params as SqlValue[])) as unknown as Cursor<T>,
    script: (sql: string) => void storage.sql.exec(sql),
    transaction: <T>(fn: () => T) => storage.transactionSync(fn),
  };
}

/** A hibernatable WebSocket as the core's Socket: its attachment is serialised onto it. */
const wrap = (ws: WebSocket): Socket => ({
  get: () => ws.deserializeAttachment() as Attachment | null,
  set: (a) => ws.serializeAttachment(a),
  send: (frame) => ws.send(frame),
  close: (code, reason) => ws.close(code, reason),
});

export class Space extends DurableObject<Env> {
  readonly core: SpaceCore;
  /** The alarm as last set, so an unchanged wake-up costs no storage write. */
  private alarmAt: number | null | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Heartbeats are answered by the runtime, so a ping never wakes a hibernating object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING_FRAME, HEARTBEAT_FRAME));
    this.core = new SpaceCore({
      store: durableStore(ctx.storage),
      clock: systemClock,
      sockets: { list: () => ctx.getWebSockets().map(wrap) },
      scheduler: {
        set: (at) => {
          if (at === this.alarmAt) return;
          this.alarmAt = at;
          ctx.waitUntil(at === null ? ctx.storage.deleteAlarm() : ctx.storage.setAlarm(at));
        },
      },
      config: env,
    });
  }

  async fetch(req: Request): Promise<Response> {
    const r = route(req.method, req.url);
    if (!r) return notRouted();
    if ('feed' in r) {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      this.core.opened(wrap(pair[1]));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    const uid = req.headers.get(UID_HEADER);
    const exp = Number(req.headers.get(EXP_HEADER));
    if (!uid || !Number.isFinite(exp)) return forbidden();
    const body = await readBody(req);
    return respond(this.core.request(r.verb, { uid: decodeURIComponent(uid), exp }, body));
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    return this.core.message(wrap(ws), message);
  }

  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // A close with no status cannot be echoed; the socket is gone either way.
    }
    this.core.closed();
  }

  webSocketError(): void {
    this.core.closed();
  }

  alarm(): void {
    this.alarmAt = undefined;
    this.core.alarm();
  }
}
