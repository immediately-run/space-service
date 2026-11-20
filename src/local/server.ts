// server.ts — the Node host's listener: `node:http` serving the same routes as the Worker, and
// `ws` for the feed. A request's body is read whole before it queues, so a space's queue never
// waits on a client's upload.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { WebSocketServer } from 'ws';
import { notRouted, respond, route } from '../core/http';
import { ERROR, MAX_BODY_BYTES, fail } from '../core/protocol';
import type { LocalHost } from './host';

/** The largest frame a client may send: a hello carries one token. */
const MAX_CLIENT_FRAME = 64 * 1024;

async function toRequest(req: IncomingMessage): Promise<Request | null> {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v == null) continue;
    for (const one of Array.isArray(v) ? v : [v]) headers.append(k, one);
  }
  // The request target is a path, always appended to a fixed origin: `//x/…` stays a path.
  const target = req.url ?? '/';
  if (!target.startsWith('/')) return null;
  const method = req.method ?? 'GET';
  let body: Buffer | undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_BODY_BYTES) return null;
      chunks.push(c as Buffer);
    }
    body = Buffer.concat(chunks);
  }
  return new Request(`http://space-service${target}`, { method, headers, body });
}

async function send(res: ServerResponse, out: Response) {
  const headers: Record<string, string> = {};
  out.headers.forEach((v, k) => (headers[k] = v));
  res.writeHead(out.status, headers);
  res.end(Buffer.from(await out.arrayBuffer()));
}

/** Serve `host`: verbs over HTTP, the feed over WebSocket. */
export function serve(host: LocalHost): Server {
  const server = createServer((req, res) => {
    toRequest(req)
      .then((r) => (r ? host.handle(r) : respond(fail(ERROR.invalid))))
      // A failure of the host itself — a database that will not open — is said, not hung up on.
      .catch(() => respond(fail(ERROR.internal)))
      .then((out) => send(res, out))
      .catch(() => res.destroy());
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_FRAME });
  server.on('upgrade', (req, socket, head) => {
    // A peer that resets mid-handshake must not take the process down.
    socket.on('error', () => socket.destroy());
    const target = req.url ?? '/';
    const r = target.startsWith('/') ? route(req.method ?? 'GET', `http://space-service${target}`) : null;
    if (!r || !('feed' in r)) {
      const out = notRouted();
      socket.end(`HTTP/1.1 ${out.status} Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => host.connect(r.spaceId, ws));
  });
  return server;
}
