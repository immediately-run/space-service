// hosts.test.ts (Node only) — the two-host condition, as a test (§5.5.6; §9: "a host-specific
// skip fails the job"): every integration scenario runs in both projects, and NODE_ONLY names
// unit tests only.
import { readdirSync } from 'node:fs';
import { matchesGlob, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { NODE_ONLY, PROJECTS } from '../../vitest.config';

const root = resolve(import.meta.dirname, '../..');
const runs = (project: { include: string[]; exclude: string[] }, file: string) =>
  project.include.some((g) => matchesGlob(file, g)) && !project.exclude.some((g) => matchesGlob(file, g));

it('no integration scenario runs on one host only', () => {
  const scenarios = (readdirSync(resolve(root, 'test/integration'), { recursive: true }) as string[]).map((f) => `test/integration/${f}`);
  expect(scenarios.filter((f) => f.endsWith('.test.ts')).length).toBeGreaterThanOrEqual(8);
  for (const file of scenarios) {
    // Everything under test/integration/ is a scenario: a helper there would run on neither.
    expect(file, 'test/integration/ holds scenarios only').toMatch(/\/S-SS-\d+\.[a-z-]+\.test\.ts$/);
    expect(runs(PROJECTS.cloudflare, file), `${file} on cloudflare`).toBe(true);
    expect(runs(PROJECTS.local, file), `${file} on local`).toBe(true);
  }
});

it('NODE_ONLY names existing unit tests only', () => {
  const unit = readdirSync(resolve(root, 'test/unit')).map((f) => `test/unit/${f}`);
  for (const file of NODE_ONLY) {
    expect(file).toMatch(/^test\/unit\/[^/]+\.test\.ts$/);
    expect(unit, `${file} exists`).toContain(file);
    expect(runs(PROJECTS.local, file), `${file} on local`).toBe(true);
  }
  expect(PROJECTS.cloudflare.exclude).toEqual(NODE_ONLY);
  expect(PROJECTS.local.exclude).toEqual([]);
});
