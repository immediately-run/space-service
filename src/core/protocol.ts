// protocol.ts — the wire contract between the host and the space service
// (STORE_PORTABILITY_SPEC §5.5.3, §5.5.4): the one home for every verb, frame type, error code,
// close code and limit. No other file spells a frame's `type` string; they build and parse
// frames through this module.

// ── Limits ──────────────────────────────────────────────────────────────────────────────────

/** The largest file record, as the UTF-8 bytes of its JSON (R-STORE-1: contract, not a store fact). */
export const MAX_FILE_SIZE = 1_000_000;
/** The most changes one atomic commit may carry (R-STORE-4's declared bound). */
export const COMMIT_BOUND = 500;
/** How many commits of the change log are kept for resume; older `sinceSeq` gets a snapshot. */
export const FEED_RETENTION = 256;
export const MAX_PATH_BYTES = 1024;
export const MAX_OP_ID_LENGTH = 128;
export const MAX_UID_LENGTH = 256;
/** The largest request body either host reads. */
export const MAX_BODY_BYTES = 32 * 1024 * 1024;
/** A snapshot is sent as frames of about this many bytes of file data (always at least one file). */
export const SNAPSHOT_FRAME_BYTES = 900_000;
/** A socket that has not said an accepted `hello` by then is closed. */
export const HELLO_TIMEOUT_MS = 10_000;
/** How often the reference client pings; the service answers each with a heartbeat. */
export const PING_INTERVAL_MS = 20_000;
/** A feed silent for this long is treated as revoked by its holder (R-STORE-3, fail closed). */
export const CHANNEL_LOST_MS = 60_000;

// ── Roles ───────────────────────────────────────────────────────────────────────────────────

export const ROLE = { owner: 'owner', writer: 'writer', reader: 'reader' } as const;
export type Role = (typeof ROLE)[keyof typeof ROLE];
export const isRole = (x: unknown): x is Role => x === ROLE.owner || x === ROLE.writer || x === ROLE.reader;
/** Whether a role may write files. */
export const canWrite = (role: Role): boolean => role !== ROLE.reader;

// ── Errors ──────────────────────────────────────────────────────────────────────────────────

export const ERROR = {
  /** Anything ungranted, uniformly: bad token, no membership, deleted or absent space (P7). */
  forbidden: 'forbidden',
  /** A `basedOn` did not match the path's current `rev`; nothing was written. */
  conflict: 'conflict',
  /** A commit carried more than COMMIT_BOUND changes; nothing was written. */
  boundExceeded: 'boundExceeded',
  /** A granted caller sent a malformed request. */
  invalid: 'invalid',
  /** A granted caller read a path that holds no file. */
  notFound: 'notFound',
  /** The host failed; nothing about the request or the space. */
  internal: 'internal',
} as const;
export type ErrorCode = (typeof ERROR)[keyof typeof ERROR];

const HTTP_STATUS: Record<ErrorCode, number> = { forbidden: 403, conflict: 409, boundExceeded: 413, invalid: 400, notFound: 404, internal: 500 };

/** A verb's answer: an HTTP status and a JSON body. */
export interface Reply {
  status: number;
  body: Record<string, unknown>;
}
export const ok = (body: Record<string, unknown> = {}): Reply => ({ status: 200, body });
export const fail = (error: ErrorCode, extra: Record<string, unknown> = {}): Reply => ({ status: HTTP_STATUS[error], body: { error, ...extra } });
export const FORBIDDEN: Reply = fail(ERROR.forbidden);

// ── Verbs: POST /v1/spaces/{spaceId}/{verb}, a JSON body, a Bearer token ────────────────────

export const VERB = {
  create: 'create',
  put: 'put',
  delete: 'delete',
  commit: 'commit',
  read: 'read',
  members: 'members',
  setRole: 'setRole',
  unshare: 'unshare',
  softDelete: 'softDelete',
} as const;
export type Verb = (typeof VERB)[keyof typeof VERB];
export const isVerb = (x: string): x is Verb => Object.hasOwn(VERB, x);
/** GET /v1/spaces/{spaceId}/feed with `Upgrade: websocket`. */
export const FEED_SEGMENT = 'feed';
export const SPACE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export const OP = { put: 'put', delete: 'delete' } as const;
export type Op = (typeof OP)[keyof typeof OP];

/** One file change. A put's `data` is the record's JSON text, opaque to the service. */
export type Change =
  | { op: typeof OP.put; path: string; data: string; basedOn?: number }
  | { op: typeof OP.delete; path: string; basedOn?: number };

const utf8 = new TextEncoder();
export const byteLength = (s: string): number => utf8.encode(s).length;

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isSeq = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
const utf8Strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
/** No lone surrogate: two such strings can differ here and be one string once stored. */
const wellFormed = (s: string): boolean => {
  try {
    return utf8Strict.decode(utf8.encode(s)) === s;
  } catch {
    return false;
  }
};
const isPath = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && !x.includes('\0') && byteLength(x) <= MAX_PATH_BYTES && wellFormed(x);
const isUid = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= MAX_UID_LENGTH && wellFormed(x);

/** `opId` is optional: undefined when absent, null when malformed. */
function opIdOf(body: Record<string, unknown>): string | undefined | null {
  if (body.opId === undefined) return undefined;
  return typeof body.opId === 'string' && body.opId.length > 0 && body.opId.length <= MAX_OP_ID_LENGTH && wellFormed(body.opId) ? body.opId : null;
}

function parseChange(x: unknown, op: Op): Change | null {
  if (!isObject(x) || !isPath(x.path)) return null;
  if (x.basedOn !== undefined && !isSeq(x.basedOn)) return null;
  const basedOn = x.basedOn as number | undefined;
  if (op === OP.delete) return { op, path: x.path, ...(basedOn === undefined ? {} : { basedOn }) };
  if (x.data === undefined) return null;
  const data = JSON.stringify(x.data);
  if (data === undefined || byteLength(data) > MAX_FILE_SIZE) return null;
  return { op, path: x.path, data, ...(basedOn === undefined ? {} : { basedOn }) };
}

export interface Changeset {
  changes: Change[];
  opId: string | undefined;
}

/** `put` and `delete` bodies: `{ path, data?, basedOn?, opId? }`. */
export function parseSingle(body: unknown, op: Op): Changeset | null {
  if (!isObject(body)) return null;
  const opId = opIdOf(body);
  const change = parseChange(body, op);
  return change && opId !== null ? { changes: [change], opId } : null;
}

/** A `commit` body: `{ changes: [{ op, path, data?, basedOn? }], opId? }`, each path once. */
export function parseCommit(body: unknown): Changeset | typeof ERROR.boundExceeded | null {
  if (!isObject(body) || !Array.isArray(body.changes) || body.changes.length === 0) return null;
  if (body.changes.length > COMMIT_BOUND) return ERROR.boundExceeded;
  const opId = opIdOf(body);
  if (opId === null) return null;
  const seen = new Set<string>();
  const changes: Change[] = [];
  for (const raw of body.changes) {
    if (!isObject(raw) || (raw.op !== OP.put && raw.op !== OP.delete)) return null;
    const change = parseChange(raw, raw.op);
    if (!change || seen.has(change.path)) return null;
    seen.add(change.path);
    changes.push(change);
  }
  return { changes, opId };
}

export function parseRead(body: unknown): { path: string } | null {
  return isObject(body) && isPath(body.path) ? { path: body.path } : null;
}

export function parseSetRole(body: unknown): { uid: string; role: Role } | null {
  return isObject(body) && isUid(body.uid) && isRole(body.role) ? { uid: body.uid, role: body.role } : null;
}

export function parseUnshare(body: unknown): { uid: string } | null {
  return isObject(body) && isUid(body.uid) ? { uid: body.uid } : null;
}

// ── The feed: one WebSocket per mounted space ───────────────────────────────────────────────

export const FRAME = {
  // client → service
  hello: 'hello',
  ping: 'ping',
  // service → client
  snapshot: 'snapshot',
  delta: 'delta',
  access: 'access',
  revoked: 'revoked',
  heartbeat: 'heartbeat',
  forbidden: 'forbidden',
} as const;

/** A file as a snapshot carries it; `data` is the record as the writer sent it. */
export interface Doc {
  path: string;
  data: unknown;
  rev: number;
}
export interface DeltaChange {
  path: string;
  op: Op;
  rev: number;
}

export type ClientFrame = { type: typeof FRAME.hello; token: string; sinceSeq?: number } | { type: typeof FRAME.ping };

export type ServerFrame =
  /** The files as of `seq`. `more` marks every frame of a snapshot but its last. */
  | { type: typeof FRAME.snapshot; seq: number; docs: Doc[]; more?: true }
  /** One committed changeset: everything it changed, under its one `seq`. */
  | { type: typeof FRAME.delta; seq: number; changes: DeltaChange[]; opId?: string }
  /** The role this socket holds, as of `seq`. First answer to a `hello`; sent again, before the
   *  socket closes, when the role changes. */
  | { type: typeof FRAME.access; role: Role; seq: number }
  | { type: typeof FRAME.revoked }
  | { type: typeof FRAME.heartbeat }
  | { type: typeof FRAME.forbidden };

export const PING_FRAME = JSON.stringify({ type: FRAME.ping });
export const HEARTBEAT_FRAME = JSON.stringify({ type: FRAME.heartbeat });
/** The one answer to every refused `hello` (P7): identical bytes whatever the reason. */
export const FORBIDDEN_FRAME = JSON.stringify({ type: FRAME.forbidden });
export const REVOKED_FRAME = JSON.stringify({ type: FRAME.revoked });

export const helloFrame = (token: string, sinceSeq?: number): string => JSON.stringify({ type: FRAME.hello, token, ...(sinceSeq === undefined ? {} : { sinceSeq }) });
export const accessFrame = (role: Role, seq: number): string => JSON.stringify({ type: FRAME.access, role, seq });
export const deltaFrame = (seq: number, changes: DeltaChange[], opId?: string | null): string =>
  JSON.stringify({ type: FRAME.delta, seq, changes, ...(opId ? { opId } : {}) });
/** `docs` are `{ path, rev, data }` with `data` already JSON text, spliced in without a re-parse. */
export const snapshotFrame = (seq: number, docs: { path: string; rev: number; data: string }[], more: boolean): string =>
  `{"type":${JSON.stringify(FRAME.snapshot)},"seq":${seq},"docs":[${docs.map((d) => `{"path":${JSON.stringify(d.path)},"rev":${d.rev},"data":${d.data}}`).join(',')}]${more ? ',"more":true' : ''}}`;

function parseJson(text: unknown): Record<string, unknown> | null {
  if (typeof text !== 'string') return null;
  try {
    const x: unknown = JSON.parse(text);
    return isObject(x) ? x : null;
  } catch {
    return null;
  }
}

export function parseClientFrame(text: unknown): ClientFrame | null {
  const x = parseJson(text);
  if (!x) return null;
  if (x.type === FRAME.ping) return { type: FRAME.ping };
  if (x.type !== FRAME.hello || typeof x.token !== 'string') return null;
  if (x.sinceSeq !== undefined && !isSeq(x.sinceSeq)) return null;
  return { type: FRAME.hello, token: x.token, ...(x.sinceSeq === undefined ? {} : { sinceSeq: x.sinceSeq as number }) };
}

/** A frame from the service, as its client reads it. The service is trusted for shape. */
export function parseServerFrame(text: unknown): ServerFrame | null {
  const x = parseJson(text);
  if (!x || typeof x.type !== 'string' || !Object.hasOwn(FRAME, x.type) || x.type === FRAME.hello || x.type === FRAME.ping) return null;
  return x as unknown as ServerFrame;
}

/** WebSocket close codes, each with its reason text. */
export const CLOSE = {
  /** The client broke the protocol after its hello was accepted. */
  protocol: { code: 4400, reason: 'protocol' },
  /** The socket's token reached its `exp`: refresh the token and resume. */
  expired: { code: 4401, reason: 'token-expired' },
  /** After the forbidden frame. */
  forbidden: { code: 4403, reason: 'forbidden' },
  /** After an `access` frame for a changed role: reconnect and resume. */
  access: { code: 4409, reason: 'access-changed' },
  /** After the revoked frame. */
  revoked: { code: 4410, reason: 'revoked' },
} as const;
