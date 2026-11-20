// protocol.test.ts — the wire contract's parsers and frame builders, on both hosts.
import { expect, it } from 'vitest';
import {
  COMMIT_BOUND,
  FRAME,
  MAX_FILE_SIZE,
  MAX_PATH_BYTES,
  accessFrame,
  deltaFrame,
  helloFrame,
  parseClientFrame,
  parseCommit,
  parseServerFrame,
  parseSetRole,
  parseSingle,
  snapshotFrame,
} from '../../src/core/protocol';
import { route } from '../../src/core/http';

it('parses a put, keeping the record as JSON text', () => {
  expect(parseSingle({ path: '/a', data: { k: [1, 'é'] }, basedOn: 3, opId: 'x' }, 'put')).toEqual({ changes: [{ op: 'put', path: '/a', data: '{"k":[1,"é"]}', basedOn: 3 }], opId: 'x' });
  expect(parseSingle({ path: '/a', data: null }, 'put')).toEqual({ changes: [{ op: 'put', path: '/a', data: 'null' }], opId: undefined });
  expect(parseSingle({ path: '/a' }, 'delete')).toEqual({ changes: [{ op: 'delete', path: '/a' }], opId: undefined });
});

it('refuses malformed writes', () => {
  for (const body of [null, [], 'x', {}, { path: 1, data: 1 }, { path: '/a\0', data: 1 }, { path: '/a', data: 1, basedOn: 1.5 }, { path: '/a', data: 1, opId: '' }, { path: '/a', data: 1, opId: 7 }]) {
    expect(parseSingle(body, 'put'), JSON.stringify(body)).toBeNull();
  }
  // Limits count UTF-8 bytes, not characters.
  expect(parseSingle({ path: 'é'.repeat(MAX_PATH_BYTES / 2), data: 1 }, 'put')).not.toBeNull();
  expect(parseSingle({ path: 'é'.repeat(MAX_PATH_BYTES / 2 + 1), data: 1 }, 'put')).toBeNull();
  expect(parseSingle({ path: '/a', data: 'é'.repeat((MAX_FILE_SIZE - 2) / 2) }, 'put')).not.toBeNull();
  expect(parseSingle({ path: '/a', data: 'é'.repeat((MAX_FILE_SIZE - 2) / 2 + 1) }, 'put')).toBeNull();
  // A lone surrogate would be stored as U+FFFD, where two different paths become one.
  expect(parseSingle({ path: '/\ud800', data: 1 }, 'put')).toBeNull();
  expect(parseCommit({ changes: [{ op: 'put', path: '/\ud800', data: 1 }, { op: 'put', path: '/\ud801', data: 1 }] })).toBeNull();
  expect(parseSingle({ path: '/😀', data: '\ud800' }, 'put')).not.toBeNull();
});

it('parses a commit, each path once, within the bound', () => {
  const change = (i: number) => ({ op: 'put', path: `/${i}`, data: i });
  expect(parseCommit({ changes: [change(1), { op: 'delete', path: '/2', basedOn: 0 }] })).toEqual({
    changes: [{ op: 'put', path: '/1', data: '1' }, { op: 'delete', path: '/2', basedOn: 0 }],
    opId: undefined,
  });
  expect(parseCommit({ changes: Array.from({ length: COMMIT_BOUND + 1 }, (_, i) => change(i)) })).toBe('boundExceeded');
  expect(parseCommit({ changes: [change(1), change(1)] })).toBeNull();
  expect(parseCommit({ changes: [] })).toBeNull();
  expect(parseCommit({ changes: [{ path: '/1', data: 1 }] })).toBeNull();
});

it('parses roles strictly', () => {
  expect(parseSetRole({ uid: 'google:1', role: 'writer' })).toEqual({ uid: 'google:1', role: 'writer' });
  expect(parseSetRole({ uid: 'google:1', role: 'admin' })).toBeNull();
  expect(parseSetRole({ uid: '', role: 'reader' })).toBeNull();
});

it('round-trips every frame through its builder and parser', () => {
  expect(parseClientFrame(helloFrame('t', 5))).toEqual({ type: FRAME.hello, token: 't', sinceSeq: 5 });
  expect(parseClientFrame(helloFrame('t'))).toEqual({ type: FRAME.hello, token: 't' });
  expect(parseClientFrame(JSON.stringify({ type: FRAME.hello, token: 't', sinceSeq: -1 }))).toBeNull();
  expect(parseClientFrame(JSON.stringify({ type: FRAME.delta }))).toBeNull();
  expect(parseClientFrame('{')).toBeNull();
  expect(parseClientFrame(new ArrayBuffer(4))).toBeNull();

  expect(parseServerFrame(accessFrame('reader', 9))).toEqual({ type: FRAME.access, role: 'reader', seq: 9 });
  expect(parseServerFrame(deltaFrame(2, [{ path: '/a', op: 'put', rev: 2 }], 'op'))).toEqual({ type: FRAME.delta, seq: 2, opId: 'op', changes: [{ path: '/a', op: 'put', rev: 2 }] });
  expect(parseServerFrame(deltaFrame(2, [], null))).toEqual({ type: FRAME.delta, seq: 2, changes: [] });
  // A snapshot splices each record's stored JSON text in as it is.
  expect(parseServerFrame(snapshotFrame(3, [{ path: '/"q"', rev: 1, data: '{"a":"\\u00e9"}' }], true))).toEqual({ type: FRAME.snapshot, seq: 3, more: true, docs: [{ path: '/"q"', rev: 1, data: { a: 'é' } }] });
  expect(parseServerFrame(JSON.stringify({ type: FRAME.hello, token: 't' }))).toBeNull();
});

it('routes only the verbs and the feed', () => {
  expect(route('POST', 'https://x/v1/spaces/abc_-1/put')).toEqual({ spaceId: 'abc_-1', verb: 'put' });
  expect(route('GET', 'https://x/v1/spaces/abc/feed')).toEqual({ spaceId: 'abc', feed: true });
  for (const [method, path] of [['GET', '/v1/spaces/abc/put'], ['POST', '/v1/spaces/abc/feed'], ['POST', '/v1/spaces/abc/constructor'], ['POST', '/v1/spaces/a.b/put'], ['POST', '/v1/spaces/abc/put/x'], ['POST', '/']]) {
    expect(route(method, `https://x${path}`), path).toBeNull();
  }
});
