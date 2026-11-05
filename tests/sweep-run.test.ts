import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { runSweep } from '../src/sweep/run.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function outputRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'retryglass-sweep-guard-'));
  roots.push(root);
  return root;
}

test('a sweep refuses a failed-retry scenario before creating any cell or report', async () => {
  const root = await outputRoot();
  await expect(runSweep(resolve('examples/invoice/scenario.json'), { outputRoot: root }))
    .rejects.toThrow(/requires experiment 'crash-sweep'/);
  // No run directory, no partial report: a refused mode is a setup failure, not evidence.
  await expect(readdir(join(root, 'runs'))).rejects.toThrow();
});

test('a sweep rejects a scenario that is not valid JSON data before running anything', async () => {
  const root = await outputRoot();
  await expect(runSweep(resolve('examples/invoice/process.ts'), { outputRoot: root }))
    .rejects.toThrow(/JSON/);
});

test('a sweep requires three discovery runs before creating a cell', async () => {
  const root = await outputRoot();
  await expect(runSweep(resolve('examples/invoice/scenario-sweep.json'), { outputRoot: root, discoveryRuns: 2 }))
    .rejects.toThrow(/three discovery runs/);
  await expect(readdir(join(root, 'runs'))).rejects.toThrow();
});

test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 65])('rejects invalid API sweep bound %s before creating resources', async maxCrashPoints => {
  const root = await outputRoot();
  await expect(runSweep(resolve('examples/invoice/scenario-sweep.json'), { outputRoot: root, maxCrashPoints }))
    .rejects.toThrow(/maxCrashPoints.*integer.*1.*64/);
  await expect(readdir(join(root, 'runs'))).rejects.toThrow();
});
