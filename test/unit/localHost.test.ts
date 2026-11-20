// localHost.test.ts (Node only) — the Node host's own promises, beyond the conformance suite:
// a space that does not exist answers a feed socket exactly as one that does, file names are
// safe on case-insensitive file systems, and a space's database is open only while in use.
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, inject, it } from 'vitest';
import { feedPath } from '../../src/core/http';
import { CLOSE, FORBIDDEN_FRAME, HEARTBEAT_FRAME, HELLO_TIMEOUT_MS, helloFrame } from '../../src/core/protocol';
import { LocalHost, spaceFile } from '../../src/local/host';
import { serve } from '../../src/local/server';
import { mint } from '../lib/harness';

const config = inject('localConfig');
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

async function start(dataDir: string) {
  const host = new LocalHost({ dataDir, config });
  const server = serve(host);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as AddressInfo).port;
  cleanup.push(() => {
    host.stop();
    server.closeAllConnections();
    server.close();
  });
  const verb = async (spaceId: string, name: string, token: string, body: unknown = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/spaces/${spaceId}/${name}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  /** Open a feed socket, send `frames`, and report everything until `ms` have passed. */
  const probe = (spaceId: string, frames: string[], ms: number) =>
    new Promise<{ got: string[]; close: [number, string] | null }>((done) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${feedPath(spaceId)}`);
      const got: string[] = [];
      let close: [number, string] | null = null;
      ws.addEventListener('open', () => frames.forEach((f) => ws.send(f)));
      ws.addEventListener('message', (e) => got.push(e.data as string));
      ws.addEventListener('close', (e) => (close = [e.code, e.reason]));
      setTimeout(() => {
        ws.close();
        done({ got, close });
      }, ms);
    });
  return { host, port, verb, probe };
}

it('a feed socket cannot tell a space that does not exist from one it may not enter', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'space-service-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const { verb, probe } = await start(dir);
  const owner = await mint('user:owner');
  const stranger = await mint('user:stranger');
  expect((await verb('real', 'create', owner)).status).toBe(200);

  const cases: Record<string, string[]> = {
    'a ping that is not the canonical bytes': ['{"type":"ping","x":1}'],
    'the canonical ping': ['{"type":"ping"}'],
    'a hello from a non-member': [helloFrame(stranger)],
    'a hello with a bad token': [helloFrame('nope')],
    garbage: ['{{{'],
    'a ping, then a hello': ['{"type":"ping"}', helloFrame(stranger)],
  };
  for (const [name, frames] of Object.entries(cases)) {
    expect(await probe('absent', frames, 300), name).toEqual(await probe('real', frames, 300));
  }
  // The answers themselves: a heartbeat for a ping, the one refusal for everything else.
  expect(await probe('absent', ['{"type":"ping","x":1}'], 300)).toEqual({ got: [HEARTBEAT_FRAME], close: null });
  expect(await probe('absent', [helloFrame(stranger)], 300)).toEqual({ got: [FORBIDDEN_FRAME], close: [CLOSE.forbidden.code, CLOSE.forbidden.reason] });
  // Probing made no file.
  expect(readdirSync(dir).filter((f) => f.includes('absent'))).toEqual([]);
});

it('silence is closed at the same deadline, with no frame, whether or not the space exists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'space-service-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const { verb, probe } = await start(dir);
  expect((await verb('real', 'create', await mint('user:owner'))).status).toBe(200);
  const [absent, real] = await Promise.all([probe('absent', [], HELLO_TIMEOUT_MS + 1500), probe('real', [], HELLO_TIMEOUT_MS + 1500)]);
  expect(absent).toEqual({ got: [], close: [CLOSE.forbidden.code, CLOSE.forbidden.reason] });
  expect(real).toEqual(absent);
}, 20_000);

it('ids that differ only by case are different spaces in different files', async () => {
  expect(spaceFile('abc')).toBe('abc.sqlite');
  expect(spaceFile('ABC')).toBe('_a_b_c.sqlite');
  expect(spaceFile('a_b')).toBe('a__b.sqlite');
  expect(spaceFile('_a')).not.toBe(spaceFile('A'));
  const names = ['abc', 'ABC', 'aBc', 'a_bc', '_abc', 'A_bc', '__', '_', 'ab_C'].map((id) => spaceFile(id).toLowerCase());
  expect(new Set(names).size).toBe(names.length);

  const dir = mkdtempSync(join(tmpdir(), 'space-service-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const { verb } = await start(dir);
  const one = await mint('user:one');
  const two = await mint('user:two');
  expect((await verb('Space', 'create', one)).status).toBe(200);
  expect((await verb('space', 'create', two)).status).toBe(200);
  await verb('Space', 'put', one, { path: '/a', data: 'one' });
  expect((await verb('space', 'read', two, { path: '/a' })).status).toBe(404);
  expect((await verb('Space', 'read', two, { path: '/a' })).status).toBe(403);
});

it("a space's database is open only while in use, and survives a restart of the host", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'space-service-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const owner = await mint('user:owner');
  const first = await start(dir);
  expect((await first.verb('kept', 'create', owner)).status).toBe(200);
  expect((await first.verb('kept', 'put', owner, { path: '/a', data: { n: 1 } })).body).toEqual({ seq: 1, rev: 1 });

  // No socket is on the space, so the first host holds no lock on its file: a second host on
  // the same directory can serve it, and sees what was written.
  const second = await start(dir);
  expect((await second.verb('kept', 'read', owner, { path: '/a' })).body).toEqual({ data: { n: 1 }, rev: 1 });
  expect((await second.verb('kept', 'put', owner, { path: '/a', data: { n: 2 }, basedOn: 1 })).body).toEqual({ seq: 2, rev: 2 });
  expect((await first.verb('kept', 'read', owner, { path: '/a' })).body).toEqual({ data: { n: 2 }, rev: 2 });
});
