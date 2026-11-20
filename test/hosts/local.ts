// local.ts — the conformance suite's Node host: the same core on `node:sqlite` behind the
// per-space queues, served on a real port in this process, with the run's bindings.
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { inject } from 'vitest';
import { feedPath } from '../../src/core/http';
import type { SpaceCore } from '../../src/core/space';
import { LocalHost } from '../../src/local/host';
import { serve } from '../../src/local/server';
import type { RawSocket } from '../lib/harness';

const config = inject('localConfig');

export const HOST = 'local';
export const AUDIENCE: string = config.TOKEN_AUDIENCE;
export const SIGNING_JWK: string = config.TEST_SIGNING_JWK;
/** Local only: the run's signing key as PKCS#8 PEM, the form the drill reads. */
export const SIGNING_PEM: string = config.TEST_SIGNING_PEM;

let host: LocalHost;
let server: Server;
let port = 0;

async function fresh(): Promise<void> {
  host = new LocalHost({ dataDir: ':memory:', config, alarm: 'manual' });
  server = serve(host);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  port = (server.address() as AddressInfo).port;
}
await fresh();

/** Local only: where the host under test listens. */
export const origin = () => `http://127.0.0.1:${port}`;
/** Local only: the host under test. */
export const current = () => host;

/** A verb request to the host. */
export function call(req: Request): Promise<Response> {
  return host.handle(req);
}

/** A feed socket, over the real listener. */
export function open(spaceId: string): Promise<RawSocket> {
  return new Promise((done, fail) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${feedPath(spaceId)}`);
    ws.addEventListener('open', () => done(ws as unknown as RawSocket));
    ws.addEventListener('error', () => fail(new Error('the feed did not open')));
  });
}

/** Run `fn` with a space's core, in its turn in the space's queue. */
export function withCore<T>(spaceId: string, fn: (core: SpaceCore) => T): Promise<T> {
  return host.queues.run(spaceId, () => {
    const core = host.core(spaceId);
    if (!core) throw new Error(`no such space: ${spaceId}`);
    return fn(core);
  });
}

export async function reset(): Promise<void> {
  host.stop();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  await fresh();
}
