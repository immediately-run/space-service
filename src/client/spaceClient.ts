// spaceClient.ts — the verbs of the wire contract (STORE_PORTABILITY_SPEC §5.5.3) over HTTP, for
// one space and one token holder. Runtime-neutral: it uses `fetch`.
import { feedPath, verbPath } from '../core/http';
import { ERROR, OP, VERB, type ErrorCode, type Role, type Verb } from '../core/protocol';

export type Result<T> = ({ ok: true } & T) | { ok: false; error: ErrorCode; paths?: string[] };

export interface WriteOptions {
  /** The rev this write is based on (0: the path must hold no file). Absent: last writer wins. */
  basedOn?: number;
  /** Echoed on the write's delta, so its writer can tell it from a remote change. */
  opId?: string;
}

export type CommitChange = { op: typeof OP.put; path: string; data: unknown; basedOn?: number } | { op: typeof OP.delete; path: string; basedOn?: number };

export interface SpaceClientOptions {
  /** `http(s)://host[:port]` of the service. */
  origin: string;
  spaceId: string;
  token: () => Promise<string> | string;
  fetch?: (input: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; json(): Promise<unknown> }>;
}

export class SpaceClient {
  constructor(private readonly opts: SpaceClientOptions) {}

  /** The feed's URL for this space. */
  get feedUrl(): string {
    return this.opts.origin.replace(/^http/, 'ws') + feedPath(this.opts.spaceId);
  }

  private async call<T>(verb: Verb, body: unknown = {}): Promise<Result<T>> {
    const send = this.opts.fetch ?? ((input, init) => fetch(input, init));
    const res = await send(this.opts.origin + verbPath(this.opts.spaceId, verb), {
      method: 'POST',
      headers: { authorization: `Bearer ${await this.opts.token()}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const out = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.status === 200 && out) return { ok: true, ...(out as T) };
    return { ok: false, error: (out?.error as ErrorCode | undefined) ?? ERROR.invalid, ...(Array.isArray(out?.paths) ? { paths: out.paths as string[] } : {}) };
  }

  create = () => this.call<{ seq: number }>(VERB.create);
  put = (path: string, data: unknown, o: WriteOptions = {}) => this.call<{ seq: number; rev: number }>(VERB.put, { path, data, ...o });
  delete = (path: string, o: WriteOptions = {}) => this.call<{ seq: number }>(VERB.delete, { path, ...o });
  /** Every change or none, as one delta: a rename is `[delete old, put new]`. */
  commit = (changes: CommitChange[], o: { opId?: string } = {}) => this.call<{ seq: number }>(VERB.commit, { changes, ...o });
  read = (path: string) => this.call<{ data: unknown; rev: number }>(VERB.read, { path });
  members = () => this.call<{ members: { uid: string; role: Role }[]; everShared: boolean }>(VERB.members);
  setRole = (uid: string, role: Role) => this.call<{ seq: number }>(VERB.setRole, { uid, role });
  unshare = (uid: string) => this.call<{ seq: number }>(VERB.unshare, { uid });
  softDelete = () => this.call<{ seq: number }>(VERB.softDelete);
}
