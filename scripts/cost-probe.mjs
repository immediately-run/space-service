// cost-probe.mjs — what the drill cost on Cloudflare: the staging Worker's and its Durable
// Objects' requests and duration over the drill's window, from the GraphQL Analytics API.
//
//   CLOUDFLARE_API_TOKEN=… node scripts/cost-probe.mjs --script <name> --since <ISO> --until <ISO>
//
// It prints `{ "cost": … }` and always exits 0. When the API refuses or has nothing — a token
// without Account Analytics: Read, a dataset still empty, a field this account's schema lacks —
// the answer is the string `unavailable — <reason>`. It never estimates and never fills a gap:
// the drill's latency and revocation results are the gate, and this is a reading beside them.
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const API = 'https://api.cloudflare.com/client/v4';

const QUERY = `query DrillCost($account: String!, $script: String!, $since: Time!, $until: Time!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      worker: workersInvocationsAdaptive(limit: 1000, filter: { scriptName: $script, datetime_geq: $since, datetime_leq: $until }) {
        sum { requests subrequests errors }
        quantiles { cpuTimeP50 cpuTimeP99 }
      }
      objectRequests: durableObjectsInvocationsAdaptiveGroups(limit: 1000, filter: { scriptName: $script, datetime_geq: $since, datetime_leq: $until }) {
        sum { requests responseBodySize }
      }
      objectDuration: durableObjectsPeriodicGroups(limit: 1000, filter: { scriptName: $script, datetime_geq: $since, datetime_leq: $until }) {
        sum { activeTime cpuTime inboundWebsocketMsgCount outboundWebsocketMsgCount }
        max { activeWebsocketConnections }
      }
    }
  }
}`;

const unavailable = (reason) => ({ cost: `unavailable — ${reason}` });
const message = (e) => (e instanceof Error ? e.message : String(e));

/** Add up one numeric field group across a dataset's rows. */
function total(rows, group) {
  const out = {};
  for (const row of rows ?? []) {
    for (const [k, v] of Object.entries(row?.[group] ?? {})) if (typeof v === 'number') out[k] = (out[k] ?? 0) + v;
  }
  return out;
}
function highest(rows, group) {
  const out = {};
  for (const row of rows ?? []) {
    for (const [k, v] of Object.entries(row?.[group] ?? {})) if (typeof v === 'number') out[k] = Math.max(out[k] ?? 0, v);
  }
  return out;
}

/**
 * Read the window's figures. `fetch` is injected. Resolves to `{ cost: {...} }` with the
 * figures exactly as the API reported them, or `{ cost: 'unavailable — <reason>' }`.
 *
 * @param {{ fetch: (url: string, init?: any) => Promise<any>, token: string | undefined, accountId?: string, script: string, since: string, until: string }} args
 * @returns {Promise<{ cost: string | Record<string, unknown> }>}
 */
export async function probe({ fetch, token, accountId, script, since, until }) {
  if (!token) return unavailable('no API token');
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  try {
    let account = accountId;
    if (!account) {
      const res = await fetch(`${API}/accounts?per_page=5`, { headers });
      const body = await res.json();
      if (!res.ok || !body?.success) return unavailable(`the account lookup failed: ${body?.errors?.[0]?.message ?? `HTTP ${res.status}`}`);
      if (body.result?.length !== 1) return unavailable(`the token sees ${body.result?.length ?? 0} accounts; set CLOUDFLARE_ACCOUNT_ID`);
      account = body.result[0].id;
    }
    const res = await fetch(`${API}/graphql`, { method: 'POST', headers, body: JSON.stringify({ query: QUERY, variables: { account, script, since, until } }) });
    const body = await res.json();
    if (body?.errors?.length) return unavailable(body.errors[0].message ?? 'the API returned an error');
    if (!res.ok) return unavailable(`HTTP ${res.status}`);
    const data = body?.data?.viewer?.accounts?.[0];
    if (!data) return unavailable('the API returned no account data');
    const rows = (data.worker?.length ?? 0) + (data.objectRequests?.length ?? 0) + (data.objectDuration?.length ?? 0);
    if (!rows) return unavailable('the datasets hold nothing for this window yet');
    return {
      cost: {
        script,
        since,
        until,
        worker: { ...total(data.worker, 'sum'), ...highest(data.worker, 'quantiles') },
        durableObjects: { ...total(data.objectRequests, 'sum'), ...total(data.objectDuration, 'sum'), ...highest(data.objectDuration, 'max') },
      },
    };
  } catch (e) {
    return unavailable(message(e));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { script: { type: 'string' }, since: { type: 'string' }, until: { type: 'string' } } });
  const out =
    values.script && values.since && values.until
      ? await probe({ fetch, token: process.env.CLOUDFLARE_API_TOKEN, accountId: process.env.CLOUDFLARE_ACCOUNT_ID, script: values.script, since: values.since, until: values.until })
      : unavailable('usage: cost-probe.mjs --script <name> --since <ISO> --until <ISO>');
  console.log(JSON.stringify(out, null, 2));
}
