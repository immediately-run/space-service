// drill-summary.mjs — put one drill run together:
//
//   node scripts/drill-summary.mjs <local.json> <staging.json> <cost.json> <out.json>
//
// It writes `{ local, staging, cost }` to <out.json> and prints a Markdown summary table of the
// two reports. The figures are copied as reported; nothing is judged here.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ms = (v) => (v === null || v === undefined ? '—' : `${v} ms`);
const q = (x) => (x?.count ? `${ms(x.p50)} / ${ms(x.p95)} / ${ms(x.max)}` : '—');

/** The rows of the summary: a label and how to read it from one target's report. */
const ROWS = [
  ['target', (r) => r.target],
  ['members / writes', (r) => `${r.members} / ${r.writes}`],
  ['delta latency p50 / p95 / max', (r) => q(r.deltaLatencyMs)],
  ['put answer p50 / p95 / max', (r) => q(r.ackLatencyMs)],
  ['deltas delivered', (r) => `${r.deltasDelivered.received} of ${r.deltasDelivered.expected}`],
  ['access after setRole', (r) => ms(r.accessAfterSetRole.latencyMs)],
  ['access before any later delta', (r) => `${r.accessAfterSetRole.beforeAnyLaterDelta} (${r.accessAfterSetRole.laterDeltas} later deltas)`],
  ['write after downgrade', (r) => r.accessAfterSetRole.writeAfterDowngrade],
  ['revoked after delete p50 / p95 / max', (r) => q(r.revokedAfterDelete.latencyMs)],
  ['revoked sockets', (r) => `${r.revokedAfterDelete.sockets} of ${r.revokedAfterDelete.of}`],
  ['revoked after last delta', (r) => String(r.revokedAfterDelete.afterLastDelta)],
  ['channel loss', (r) => `${r.channelLoss.outcome}, ${ms(r.channelLoss.watchdogMs)} after the last frame`],
];

export function summary({ local, staging, cost }) {
  const lines = ['| | local (Node host) | staging (Durable Object) |', '|---|---|---|'];
  for (const [label, read] of ROWS) lines.push(`| ${label} | ${read(local)} | ${read(staging)} |`);
  lines.push('', `**Cost:** ${typeof cost === 'string' ? cost : `\`${JSON.stringify(cost)}\``}`);
  return lines.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [localFile, stagingFile, costFile, outFile] = process.argv.slice(2);
  const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
  const report = { local: read(localFile), staging: read(stagingFile), cost: read(costFile).cost };
  writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(summary(report));
}
