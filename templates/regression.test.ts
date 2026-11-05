import { expect, test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { runScenario } from 'retryglass';

/**
 * Exported from a completed Retryglass rehearsal. The scenario and its declared fixtures sit next to
 * this file, so the case stays self-contained. This test only describes its declared surfaces; it
 * does not establish that a production retry is safe.
 */
test('invoice retry preserves the declared business effects', async () => {
  const report = await runScenario(fileURLToPath(new URL('./scenario.json', import.meta.url)), {
    outputRoot: '.retryglass/regression',
  });
  expect(report.execution).toBe('completed');
  expect(report.coverage).toBe('complete_for_declared_surfaces');
  expect(report.assertions).toBe('passed');
  expect(report.cleanup).toBe('completed');
}, 180_000);
