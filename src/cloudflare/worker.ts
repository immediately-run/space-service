// worker.ts — the Worker (STORE_PORTABILITY_SPEC §5.5.1): it verifies the token and routes to the
// space's Durable Object, named by the opaque space id. A request with no valid token never
// reaches an object.
//
// The feed is the one exception to "verifies first": a browser cannot put a header on a
// WebSocket, so the token arrives in the socket's first frame (§5.5.3 `hello`) and the object
// verifies it there, with the same verifier.
import { verifyToken } from '../core/auth';
import { bearer, forbidden, notRouted, route } from '../core/http';
import { systemClock } from './clock';
import { EXP_HEADER, UID_HEADER } from './space';

export { Space } from './space';

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const r = route(req.method, req.url);
    if (!r) return notRouted();
    const space = env.SPACE.get(env.SPACE.idFromName(r.spaceId));
    if ('feed' in r) {
      if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return notRouted();
      return space.fetch(req);
    }
    const claims = await verifyToken(bearer(req), env, systemClock.now());
    if (!claims) return forbidden();
    // The object trusts these two headers, so whatever the client sent under them is replaced.
    const headers = new Headers(req.headers);
    headers.delete('authorization');
    headers.set(UID_HEADER, encodeURIComponent(claims.uid));
    headers.set(EXP_HEADER, String(claims.exp));
    return space.fetch(new Request(req, { headers }));
  },
} satisfies ExportedHandler<Env>;
