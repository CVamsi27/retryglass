import { expect, test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { exitCode, runSweep } from 'retryglass';

test('the retry preserves the declared synthetic business effects', async () => {
  const report = await runSweep(fileURLToPath(new URL('./scenario.json', import.meta.url)), {
    outputRoot: '.retryglass/regression',
  });
  expect(report.execution).toBe('completed');
  expect(report.coverage).toBe('complete_for_declared_surfaces');
  expect(report.assertions).toBe('passed');
  expect(report.cleanup).toBe('completed');
  expect(exitCode(report)).toBe(0);
}, 600_000);
