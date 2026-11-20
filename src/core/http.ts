// http.ts — the service's HTTP surface, shared by both hosts: the routes, the bearer token, the
// body and the response. It uses only the Fetch API's Request and Response, which the Workers
// runtime and Node both provide.
import { ERROR, FEED_SEGMENT, FORBIDDEN, MAX_BODY_BYTES, SPACE_ID, fail, isVerb, type Reply, type Verb } from './protocol';

export type Route = { spaceId: string; verb: Verb } | { spaceId: string; feed: true };

/** `POST /v1/spaces/{spaceId}/{verb}` or `GET /v1/spaces/{spaceId}/feed`; anything else is null. */
export function route(method: string, url: string): Route | null {
  const m = /^\/v1\/spaces\/([^/]+)\/([^/]+)$/.exec(new URL(url).pathname);
  if (!m || !SPACE_ID.test(m[1])) return null;
  if (m[2] === FEED_SEGMENT) return method === 'GET' ? { spaceId: m[1], feed: true } : null;
  return method === 'POST' && isVerb(m[2]) ? { spaceId: m[1], verb: m[2] } : null;
}

export const feedPath = (spaceId: string): string => `/v1/spaces/${spaceId}/${FEED_SEGMENT}`;
export const verbPath = (spaceId: string, verb: Verb): string => `/v1/spaces/${spaceId}/${verb}`;

/** The request's bearer token, or null. */
export function bearer(req: Request): string | null {
  const m = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '');
  return m ? m[1] : null;
}

/** The request's JSON body; `undefined` when it is absent, too large or not JSON. */
export async function readBody(req: Request): Promise<unknown> {
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return undefined;
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return undefined;
  if (text === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function respond(reply: Reply): Response {
  return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

export const forbidden = (): Response => respond(FORBIDDEN);
/** A path the service does not have: nothing about any space. */
export const notRouted = (): Response => respond(fail(ERROR.notFound));
