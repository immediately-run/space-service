// harness.ts — what the scenarios share, on either host: real tokens from a real signer, verb
// calls, and feed sockets whose frames a test reads one at a time.
import { SignJWT, importJWK } from 'jose';
import { AUDIENCE, SIGNING_JWK, call, open, withCore } from '#host';
import { verbPath } from '../../src/core/http';
import { FRAME, PING_FRAME, helloFrame, parseServerFrame, type ServerFrame, type Verb } from '../../src/core/protocol';

/** The WebSocket API both hosts' test sockets share. */
export interface RawSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close', listener: (event: { code: number; reason: string }) => void): void;
}

export const newSpaceId = () => `s-${crypto.randomUUID()}`;
const nowSeconds = () => Math.floor(Date.now() / 1000);

type SigningKey = Parameters<SignJWT['sign']>[0];
let runKey: Promise<SigningKey> | undefined;

export interface MintOptions {
  /** Seconds from now; negative for a token already expired. Default 600. */
  expiresIn?: number;
  audience?: string;
  /** Sign with this key instead of the run's. */
  key?: SigningKey;
  /** Leave `exp` out altogether. */
  noExp?: boolean;
}

/** A token as the platform would mint it, signed with the run's key. */
export async function mint(uid: string, o: MintOptions = {}): Promise<string> {
  runKey ??= importJWK(JSON.parse(SIGNING_JWK), 'ES256') as Promise<SigningKey>;
  let jwt = new SignJWT({}).setProtectedHeader({ alg: 'ES256' }).setSubject(uid).setAudience(o.audience ?? AUDIENCE).setIssuedAt(nowSeconds() - 3600);
  if (!o.noExp) jwt = jwt.setExpirationTime(nowSeconds() + (o.expiresIn ?? 600));
  return jwt.sign(o.key ?? (await runKey));
}

export interface ApiResult {
  status: number;
  body: any;
  text: string;
}

/** One verb, as its caller. */
export async function api(spaceId: string, token: string | null, verb: Verb, body: unknown = {}): Promise<ApiResult> {
  const res = await call(
    new Request(`https://space.test${verbPath(spaceId, verb)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
      body: JSON.stringify(body),
    }),
  );
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) };
}

const feeds = new Set<Feed>();

/** A feed socket as a test reads it. */
export class Feed {
  /** Every frame received, as text, in order. */
  readonly raw: string[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  isClosed = false;
  private readonly queue: ServerFrame[] = [];
  private waiter: (() => void) | null = null;

  constructor(private readonly ws: RawSocket) {
    feeds.add(this);
    ws.addEventListener('message', (event) => {
      const frame = parseServerFrame(event.data);
      if (!frame) throw new Error(`not a frame: ${String(event.data)}`);
      this.raw.push(event.data as string);
      this.queue.push(frame);
      this.waiter?.();
    });
    this.closed = new Promise((done) =>
      ws.addEventListener('close', (event) => {
        this.isClosed = true;
        this.waiter?.();
        done({ code: event.code, reason: event.reason });
      }),
    );
  }

  send(text: string): void {
    this.ws.send(text);
  }

  /** Set by `hello()`: the answer to a hello is awaited before anything is called settled. */
  awaitingHello = false;

  /** Wait, without reading, until a frame has arrived or the socket has closed. */
  private async arrived(): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!this.raw.length && !this.isClosed) {
      if (Date.now() > deadline) throw new Error('no answer to the hello within 5 s');
      await new Promise<void>((done) => {
        const timer = setTimeout(done, 50);
        this.waiter = () => {
          clearTimeout(timer);
          done();
        };
      });
      this.waiter = null;
    }
  }

  /** The next frame; fails if the socket closes or five seconds pass first. */
  async next(): Promise<ServerFrame> {
    const deadline = Date.now() + 5000;
    while (!this.queue.length) {
      if (this.isClosed) throw new Error('the feed closed with no further frame');
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('no frame within 5 s');
      await new Promise<void>((done) => {
        const timer = setTimeout(done, left);
        this.waiter = () => {
          clearTimeout(timer);
          done();
        };
      });
      this.waiter = null;
    }
    return this.queue.shift()!;
  }

  /** Frames already received and not yet read. */
  drain(): ServerFrame[] {
    return this.queue.splice(0);
  }

  /**
   * Everything the service has sent so far: ping, then read up to the heartbeat that answers
   * it. Frames sent before the ping was handled arrive before the heartbeat. Fails if the socket
   * closes first.
   */
  async settle(): Promise<ServerFrame[]> {
    // A hello is verified asynchronously while a ping is answered at once, so the ping is sent
    // only after the hello's first frame is here; the rest of its answer was sent in that turn.
    if (this.awaitingHello) await this.arrived();
    this.awaitingHello = false;
    this.send(PING_FRAME);
    const out: ServerFrame[] = [];
    for (;;) {
      const frame = await this.next();
      if (frame.type === FRAME.heartbeat) return out;
      out.push(frame);
    }
  }

  close(): void {
    feeds.delete(this);
    if (this.isClosed) return;
    try {
      this.ws.close(1000, 'done');
    } catch {
      // Already closing.
    }
  }
}

/** An open feed socket that has said nothing yet. */
export async function connect(spaceId: string): Promise<Feed> {
  return new Feed(await open(spaceId));
}

/** A feed socket that has sent its hello. */
export async function hello(spaceId: string, token: string, sinceSeq?: number): Promise<Feed> {
  const feed = await connect(spaceId);
  feed.send(helloFrame(token, sinceSeq));
  feed.awaitingHello = true;
  return feed;
}

/** Close every feed a test left open, and wait until each is closed. */
export async function closeFeeds(): Promise<void> {
  const open = [...feeds];
  for (const feed of open) feed.close();
  await Promise.all(open.map((f) => Promise.race([f.closed, new Promise((done) => setTimeout(done, 1000))])));
}

/** Put a space's core on a fixed clock (epoch milliseconds). */
export function setClock(spaceId: string, at: number): Promise<void> {
  return withCore(spaceId, (core) => {
    core.clock = { now: () => at };
  });
}

/** Run the wake-up the core asked for, now. */
export function tick(spaceId: string): Promise<void> {
  return withCore(spaceId, (core) => core.alarm());
}

/** A new space with its owner, and tokens for whoever else the scenario names. */
export async function newSpace<const U extends string>(...others: U[]): Promise<{ spaceId: string; owner: string } & Record<U, string>> {
  const spaceId = newSpaceId();
  const owner = await mint('user:owner');
  const created = await api(spaceId, owner, 'create');
  if (created.status !== 200) throw new Error(`create failed: ${created.text}`);
  const tokens: Record<string, string> = {};
  for (const name of others) tokens[name] = await mint(`user:${name}`);
  return { spaceId, owner, ...tokens } as { spaceId: string; owner: string } & Record<U, string>;
}
