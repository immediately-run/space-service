// ports.ts — the platform services the core needs, one small interface each
// (STORE_PORTABILITY_SPEC §5.5.1). Everything under src/core/ names only these; src/cloudflare/
// and src/local/ each implement them. Nothing here imports a platform.
import type { Role } from './protocol';

/** A value SQLite stores and returns. */
export type SqlValue = ArrayBuffer | string | number | null;
export type Row = Record<string, SqlValue>;

/** One statement's result: every row, or exactly one (`one` throws on any other count). */
export interface Cursor<T> {
  toArray(): T[];
  one(): T;
}

/**
 * The space's database. Synchronous on both hosts — the Durable Object's SQLite and
 * `node:sqlite` alike — so a core operation that does not await is one atomic turn.
 */
export interface Store {
  /** One statement with bound parameters. */
  exec<T = Row>(query: string, ...params: unknown[]): Cursor<T>;
  /** Several statements with no parameters: a migration file. */
  script(sql: string): void;
  /** Run `fn` as one transaction (nestable): its writes commit together or not at all. */
  transaction<T>(fn: () => T): T;
}

/** The core's only source of time: epoch milliseconds. */
export interface Clock {
  now(): number;
}

/**
 * What the service knows about one feed socket. On Cloudflare it is serialised onto the socket,
 * so it survives hibernation. `uid` is null until the socket's `hello` is accepted; until then
 * `exp` is the deadline for that hello, afterwards the token's expiry.
 */
export interface Attachment {
  uid: string | null;
  role: Role | null;
  /** Epoch milliseconds at which the socket is closed. */
  exp: number;
  /** The core has closed this socket; a host may still list it until the close completes. */
  closed?: true;
}

/** One feed socket. */
export interface Socket {
  get(): Attachment | null;
  set(attachment: Attachment): void;
  /** May throw on a socket that is already gone; the core treats that as closed. */
  send(frame: string): void;
  close(code: number, reason: string): void;
}

/** Every socket open on this space. */
export interface Sockets {
  list(): Socket[];
}

/** The space's one wake-up: the instant the core next wants `alarm()`, or null for none. */
export interface Scheduler {
  set(at: number | null): void;
}

/** The instance's settings: Worker vars and secrets on Cloudflare, start-up options locally. */
export interface Config {
  /** The SPKI PEM of the ES256 key whose tokens the service accepts. Absent, nothing is. */
  TOKEN_PUBLIC_KEY_PEM?: string;
  /** The `aud` a token must carry. Absent, no token is accepted. */
  TOKEN_AUDIENCE?: string;
}

/** What a host hands the core. */
export interface Ports {
  store: Store;
  clock: Clock;
  sockets: Sockets;
  scheduler: Scheduler;
  config: Config;
}
