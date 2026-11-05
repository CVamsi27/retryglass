import { afterEach, expect, test, vi } from 'vitest';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Scenario } from '../src/contracts.js';

const observations = vi.hoisted(() => ({ workers: [] as string[], points: [] as string[], resolutions: 0 }));
vi.mock('../src/docker/lifecycle.js', () => ({
  TOOL_IMAGE: 'retryglass-tool:0.1.0-alpha.1', prepareImages: async () => {},
  imageIdentity: async (image: string) => image === 'synthetic-worker:v1'
    ? `sha256:${(++observations.resolutions === 1 ? 'b' : 'c').repeat(64)}` : `sha256:${'a'.repeat(64)}`,
  createCell: async (scenario: Scenario) => { observations.workers.push(scenario.worker.image); return { runId: 'synthetic-pinned' }; },
  destroyCell: async () => {}, startWorker: async () => 'worker', stopWorker: async () => ({ code: 0 }),
  isWorkerRunning: async () => false, execCollector: async () => ({ exists: true, state: 'completed' }),
  readWorkerLogs: async () => JSON.stringify({ index: 0, seam: 'db.query', label: 'pg query' }),
}));
vi.mock('../src/sweep/point.js', () => ({ runCrashPoint: async ({ scenario }: { scenario: Scenario }) => {
  observations.points.push(scenario.worker.image);
  return { crashVerified: true, exitCode: 137, exitSignal: 'SIGKILL', recovery: 'stalled', recoveryWaitMs: 1,
    evidence: { before: [], partial: [], after: [], httpAttempts: [], appliedOperations: [], outputJobs: [], jobAttempts: [] },
    rules: [{ id: 'synthetic-observation', passed: true, observed: 1 }], violations: [], missing: [],
    execution: 'completed', coverage: 'complete_for_declared_surfaces', assertions: 'passed', cleanup: 'completed', durationMs: 1 };
} }));
import { runSweep } from '../src/sweep/run.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test('a sweep resolves a mutable worker tag once and uses that identity for discovery and every point', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retryglass-image-pin-')); roots.push(root);
  const scenario = JSON.parse(await readFile('examples/invoice/scenario-sweep.json', 'utf8'));
  scenario.worker.image = 'synthetic-worker:v1';
  await writeFile(join(root, 'scenario.json'), JSON.stringify(scenario));
  for (const file of ['schema.sql', 'seed.sql']) await copyFile(`examples/invoice/${file}`, join(root, file));
  const report = await runSweep(join(root, 'scenario.json'), { outputRoot: join(root, 'output') });
  const pinned = `sha256:${'b'.repeat(64)}`;
  expect(observations.workers).toEqual([pinned, pinned, pinned]);
  expect(observations.points).toEqual([pinned]);
  expect(observations.resolutions).toBe(1);
  expect(report.provenance.imageIds).toMatchObject({ worker: pinned });
});
