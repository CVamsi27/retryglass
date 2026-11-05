import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Cell, Scenario } from '../src/contracts.js';

const state = vi.hoisted(() => ({ reads: 0, applied: 2, workerImages: [] as string[] }));
vi.mock('../src/docker/lifecycle.js', () => ({
  TOOL_IMAGE: 'retryglass-tool:0.1.0-alpha.1',
  prepareImages: async () => {},
  imageIdentity: async () => `sha256:${'a'.repeat(64)}`,
  createCell: async (_scenario: Scenario, _fixtures: string, runDir: string, runId: string) => ({ runId, runDir, applicationRole: 'synthetic_app', networkId: 'synthetic-network' }),
  startWorker: async (_cell: Cell, scenario: Scenario) => { state.workerImages.push(scenario.worker.image); return 'synthetic-worker'; },
  isWorkerRunning: async () => false,
  readWorkerLogs: async () => '',
  stopWorker: async () => ({ code: 0, signal: 'SIGTERM', oomKilled: false, forced: false }),
  destroyCell: async () => { throw new Error('Synthetic cleanup failure'); },
  execCollector: async (_cell: Cell, command: string, argument: { tables?: Scenario['tables'] }) => {
    if (command === 'snapshot') return argument.tables!.map(table => ({ ...table, truncated: false, rows: table.table === 'public.invoices' ? [{ operation_key: 'op-17', status: 'complete' }] : [{ operation_key: 'op-17', total_cents: 1700 }] }));
    if (command === 'job-state') return { exists: true, jobId: 'job-17', operationKey: 'op-17', state: ++state.reads === 1 ? 'failed' : 'completed', attemptsMade: state.reads, attemptsStarted: state.reads };
    if (command === 'job-retry') return { jobId: 'job-17', state: 'waiting' };
    if (command === 'quiesce') return { remaining: 0, terminatedActive: false };
    return {};
  },
  simulatorControl: async () => ({ sealed: true, issues: [],
    httpAttempts: [1, 2].map(i => ({ attemptId: `a${i}`, operationKey: 'op-17', idempotencyKey: 'op-17', payloadDigest: 'synthetic', response: 'success' })),
    appliedOperations: Array.from({ length: state.applied }, (_, i) => ({ operationId: `o${i}`, operationKey: 'op-17', idempotencyKey: 'op-17', payloadDigest: 'synthetic' })),
  }),
  collectOutputs: async () => [{ queue: 'reminders', jobId: 'reminder-op-17', name: 'reminder', operationKey: 'op-17' }],
}));
vi.mock('../src/sweep/crash.js', () => ({
  prefixFor: (cell: Cell) => `retryglass-${cell.runId}`,
  verifyCrash: async () => ({ crashVerified: true, exitCode: 137, logs: '', reasons: [] }),
  recoverStalledJob: async () => ({ recovery: 'stalled', recoveryWaitMs: 2000, attemptsMade: 1, attemptsStarted: 1 }),
}));

import { runScenario } from '../src/run.js';
import { runCrashPoint } from '../src/sweep/point.js';
import { loadScenario } from '../src/scenario.js';
import { exitCode } from '../src/policy.js';
const roots: string[] = [];
beforeEach(() => { state.reads = 0; state.applied = 2; state.workerImages = []; });
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root() { const directory = await mkdtemp(join(tmpdir(), 'retryglass-cleanup-evidence-')); roots.push(directory); return directory; }

test('single-run cleanup failure retains a fully observed duplicate finding', async () => {
  const report = await runScenario(resolve('examples/invoice/scenario.json'), { outputRoot: await root() });
  expect(report.cleanup).toBe('failed');
  expect(report.coverage).toBe('partial');
  expect(report.assertions).toBe('failed');
  expect(report.rules).toContainEqual({ id: 'one-provider-action', observed: 2, passed: false });
  expect(exitCode(report)).toBe(2);
});

test('single-run cleanup failure never presents otherwise healthy effects as passed', async () => {
  state.applied = 1;
  const report = await runScenario(resolve('examples/invoice/scenario.json'), { outputRoot: await root() });
  expect(report.cleanup).toBe('failed');
  expect(report.assertions).toBe('not_evaluated');
  expect(exitCode(report)).toBe(2);
});

test('both attempts use the worker identity captured before execution', async () => {
  const report = await runScenario(resolve('examples/invoice/scenario.json'), { outputRoot: await root() });
  const pinned = `sha256:${'a'.repeat(64)}`;
  expect(state.workerImages).toEqual([pinned, pinned]);
  expect(report.provenance?.imageIds).toMatchObject({ worker: pinned });
});

test.each([1, 2])('a crash-point cleanup failure retains observed rule results for %s applied effects', async applied => {
  state.applied = applied; state.reads = 1;
  const { scenario, fixtureRoot } = await loadScenario(resolve('examples/invoice/scenario-sweep.json'));
  const point = await runCrashPoint({ scenario, fixtureRoot, runDir: await root(), runId: 'synthetic-cleanup', point: { id: 'cp-03', index: 2, seam: 'http.request', label: 'http fetch' } });
  expect(point.cleanup).toBe('failed');
  expect(point.coverage).toBe('partial');
  expect(point.assertions).toBe(applied === 2 ? 'failed' : 'not_evaluated');
  expect(point.rules).toContainEqual({ id: 'one-provider-action', observed: applied, passed: applied === 1 });
  expect(exitCode(point)).toBe(2);
});
