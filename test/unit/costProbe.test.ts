// costProbe.test.ts (Node only) — the cost probe reports what the API said, or that it is
// unavailable and why. It never produces a figure of its own.
import { expect, it } from 'vitest';
import { probe } from '../../scripts/cost-probe.mjs';

const window = { script: 'some-worker', since: '2026-01-01T00:00:00Z', until: '2026-01-01T00:10:00Z' };
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
/** A stub fetch: the account lookup succeeds, the GraphQL call answers with `graphql`. */
const stub = (graphql: unknown, status = 200) => async (url: string) =>
  url.endsWith('/graphql') ? json(graphql, status) : json({ success: true, result: [{ id: 'acct' }] });

it('a GraphQL error yields cost: unavailable — <message>', async () => {
  const out = await probe({ fetch: stub({ data: null, errors: [{ message: 'not authorized for that account' }] }), token: 't', ...window });
  expect(out).toEqual({ cost: 'unavailable — not authorized for that account' });
});

it('every other way of having no figures is unavailable too, with its reason', async () => {
  expect(await probe({ fetch: stub({}), token: '', ...window })).toEqual({ cost: 'unavailable — no API token' });
  expect(await probe({ fetch: stub({ data: { viewer: { accounts: [{ worker: [], objectRequests: [], objectDuration: [] }] } } }), token: 't', ...window })).toEqual({
    cost: 'unavailable — the datasets hold nothing for this window yet',
  });
  expect(await probe({ fetch: stub('gateway timeout', 504), token: 't', ...window })).toEqual({ cost: 'unavailable — HTTP 504' });
  const offline = async () => {
    throw new Error('network down');
  };
  expect(await probe({ fetch: offline, token: 't', ...window })).toEqual({ cost: 'unavailable — network down' });
  const noAccount = async () => json({ success: false, errors: [{ message: 'bad token' }] }, 403);
  expect(await probe({ fetch: noAccount, token: 't', ...window })).toEqual({ cost: 'unavailable — the account lookup failed: bad token' });
});

it('figures are copied as the API reported them', async () => {
  const data = {
    viewer: {
      accounts: [
        {
          worker: [{ sum: { requests: 400, subrequests: 400, errors: 0 }, quantiles: { cpuTimeP50: 900, cpuTimeP99: 4000 } }, { sum: { requests: 21, subrequests: 21, errors: 1 }, quantiles: { cpuTimeP50: 700, cpuTimeP99: 5000 } }],
          objectRequests: [{ sum: { requests: 421, responseBodySize: 9000 } }],
          objectDuration: [{ sum: { activeTime: 12000000, cpuTime: 350000, inboundWebsocketMsgCount: 12, outboundWebsocketMsgCount: 640 }, max: { activeWebsocketConnections: 4 } }],
        },
      ],
    },
  };
  let asked: any;
  const fetch = async (url: string, init?: { body?: string }) => {
    if (url.endsWith('/graphql')) asked = JSON.parse(init!.body!);
    return stub({ data })(url);
  };
  expect(await probe({ fetch, token: 't', accountId: 'given', ...window })).toEqual({
    cost: {
      ...window,
      worker: { requests: 421, subrequests: 421, errors: 1, cpuTimeP50: 900, cpuTimeP99: 5000 },
      durableObjects: { requests: 421, responseBodySize: 9000, activeTime: 12000000, cpuTime: 350000, inboundWebsocketMsgCount: 12, outboundWebsocketMsgCount: 640, activeWebsocketConnections: 4 },
    },
  });
  expect(asked.variables).toEqual({ account: 'given', ...window });
});
