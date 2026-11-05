import { expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runSweep, loadScenario, assertCrashPointPassed, type CrashPoint } from 'retryglass';

/**
 * Exported from one observed Retryglass crash point. The scenario and its declared fixtures sit next
 * to this file, so the case stays self-contained. The test asserts the declared invariants at that
 * crash point: it fails while the worker still duplicates or loses an effect there, and passes once
 * the worker is corrected. It describes only its declared surfaces and says nothing about
 * production retry safety.
 */
test('the retry preserves the declared effects at this crash point', async () => {
  const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));
  const manifest = JSON.parse(await readFile(at('./manifest.json'), 'utf8')) as {
    crashPoint: CrashPoint;
    failingRules: Array<{ id: string; observed: unknown }>;
  };

  const report = await runSweep(at('./scenario.json'), {
    outputRoot: '.retryglass/regression',
    crashPoints: [manifest.crashPoint.id],
  });

  const { scenario } = await loadScenario(at('./scenario.json'));
  assertCrashPointPassed(report, manifest.crashPoint, scenario.rules.map(rule => rule.id));
  expect(report.sweep.executed).toBe(1);
}, 600_000);
