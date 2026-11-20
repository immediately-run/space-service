// cloudflare.ts — the conformance suite's Cloudflare host: the Worker and its Durable Objects in
// workerd, through @cloudflare/vitest-plugin.
import { env, reset as resetStorage, runInDurableObject } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import type { Space } from '../../src/cloudflare/space';
import { feedPath } from '../../src/core/http';
import type { SpaceCore } from '../../src/core/space';
import type { RawSocket } from '../lib/harness';

export const HOST = 'cloudflare';
export const AUDIENCE: string = env.TOKEN_AUDIENCE!;
export const SIGNING_JWK: string = env.TEST_SIGNING_JWK;

const worker = () => (exports as unknown as { default: { fetch: (r: Request) => Promise<Response> } }).default;

/** A verb request to the Worker. */
export function call(req: Request): Promise<Response> {
  return worker().fetch(req);
}

/** A feed socket, upgraded through the Worker. */
export async function open(spaceId: string): Promise<RawSocket> {
  const res = await worker().fetch(new Request(`https://space.test${feedPath(spaceId)}`, { headers: { Upgrade: 'websocket' } }));
  const ws = res.webSocket;
  if (!ws) throw new Error(`the feed did not upgrade: ${res.status}`);
  ws.accept();
  return ws as unknown as RawSocket;
}

/** Run `fn` with a space's core, inside its object. */
export function withCore<T>(spaceId: string, fn: (core: SpaceCore) => T): Promise<T> {
  return runInDurableObject(env.SPACE.get(env.SPACE.idFromName(spaceId)), (o: Space) => fn(o.core));
}

export function reset(): Promise<void> {
  return resetStorage();
}
