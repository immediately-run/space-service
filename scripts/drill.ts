// drill.ts — the R-STORE-2/3 drill against a running space service (STORE_PORTABILITY_SPEC §5.5.7):
//
//   npm run drill -- --target <url> --key-file <pem> --members <n> [--writes 200] [--interval-ms 50] [--audience <aud>]
//
// It prints one DrillReport as JSON on stdout and nothing else there. Wiring only: the scenario
// is src/drill/scenario.ts, the numbers are src/drill/report.ts. The key file is read, used to
// sign the drill's tokens, and never printed.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { FeedClient } from '../src/client/feedClient';
import { SpaceClient } from '../src/client/spaceClient';
import { DRILL_AUDIENCE, minter } from '../src/drill/mint';
import { summarize } from '../src/drill/report';
import { runScenario } from '../src/drill/scenario';
import { stallable } from '../src/drill/stall';

const { values } = parseArgs({
  options: {
    target: { type: 'string' },
    'key-file': { type: 'string' },
    members: { type: 'string', default: '3' },
    writes: { type: 'string', default: '200' },
    'interval-ms': { type: 'string', default: '50' },
    audience: { type: 'string', default: DRILL_AUDIENCE },
  },
});
if (!values.target || !values['key-file']) {
  console.error('usage: npm run drill -- --target <url> --key-file <pem> --members <n>');
  process.exit(2);
}

const origin = values.target.replace(/\/+$/, '');
const clock = { now: () => performance.timeOrigin + performance.now() };
const mint = await minter(readFileSync(values['key-file'], 'utf8'), clock, values.audience);
const spaceId = `drill-${randomUUID()}`;
const feedUrl = new SpaceClient({ origin, spaceId, token: () => '' }).feedUrl;

const samples = await runScenario({
  spaceId,
  api: (token) => new SpaceClient({ origin, spaceId, token }),
  feed: ({ token, events }) => {
    const sockets = stallable();
    const client = new FeedClient({ url: feedUrl, WebSocket: sockets.WebSocket, clock, token, events });
    return {
      start: () => client.start(),
      stop: () => {
        client.stop();
        sockets.terminate();
      },
      track: (opId) => client.track(opId),
      stall: () => sockets.stall(),
      lastFrameAt: () => client.lastFrameAt,
    };
  },
  mint,
  clock,
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  members: Number(values.members),
  writes: Number(values.writes),
  intervalMs: Number(values['interval-ms']),
});

console.log(JSON.stringify({ target: origin, ...summarize(samples) }, null, 2));
process.exit(0);
