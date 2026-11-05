import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { RunReport } from '../src/contracts.js';
import { prepareImages, waitForContainerCleanup, waitForNetworkCleanup } from '../src/docker/lifecycle.js';
import { exportFixture } from '../src/export.js';
import { exitCode } from '../src/policy.js';
import { runScenario } from '../src/run.js';

/**
 * Real constrained cells. These runs need a Docker daemon and are excluded from `pnpm test`; run
 * them with `pnpm test:integration`. The tool image is built from `dist`, so this suite rebuilds it.
 */
const roots: string[] = [];
const exampleDir = resolve('examples/invoice');

function build(): void {
  execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'], {
    stdio: 'inherit',
  });
}

async function outputRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'retryglass-rehearsal-'));
  roots.push(root);
  return root;
}

function run(scenario: string): Promise<RunReport> {
  return outputRoot().then(root =>
    runScenario(join(exampleDir, scenario), { outputRoot: root, signal: AbortSignal.timeout(180_000) }));
}

async function assertClean(runId: string): Promise<void> {
  await waitForContainerCleanup(runId);
  await waitForNetworkCleanup(runId);
}

beforeAll(() => {
  build();
  return prepareImages();
}, 600_000);

afterAll(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

test('the golden invoice rehearses one applied effect across a same-job retry', async () => {
  const report = await run('scenario.json');
  expect(report.execution).toBe('completed');
  expect(report.coverage).toBe('complete_for_declared_surfaces');
  expect(report.assertions).toBe('passed');
  expect(report.cleanup).toBe('completed');
  expect(exitCode(report)).toBe(0);

  const [first, second] = report.evidence.jobAttempts;
  expect(first).toMatchObject({ attempt: 1, jobId: 'job-17', operationKey: 'op-17', state: 'failed' });
  expect(second).toMatchObject({ attempt: 2, jobId: 'job-17', operationKey: 'op-17', state: 'completed' });
  expect(second!.attemptsMade).toBeGreaterThan(first!.attemptsMade);

  expect(report.evidence.httpAttempts).toHaveLength(2);
  expect(report.evidence.appliedOperations).toHaveLength(1);
  expect(report.evidence.appliedOperations[0]?.idempotencyKey).toBe('op-17');
  expect(report.evidence.outputJobs).toEqual([
    { queue: 'reminders', jobId: 'reminder-op-17', name: 'reminder', operationKey: 'op-17' },
  ]);

  const partialInvoices = report.evidence.partial.find(item => item.table === 'public.invoices');
  expect(partialInvoices?.rows).toEqual([{ operation_key: 'op-17', status: 'created' }]);
  const finalInvoices = report.evidence.after.find(item => item.table === 'public.invoices');
  expect(finalInvoices?.rows).toEqual([{ operation_key: 'op-17', status: 'complete' }]);

  expect(report.provenance?.stops).toEqual([
    expect.objectContaining({ remainingDatabaseBackends: 0, simulatorDrained: true }),
    expect.objectContaining({ remainingDatabaseBackends: 0, simulatorDrained: true }),
  ]);
  await assertClean(report.runId);
}, 240_000);

test('a fresh provider key per attempt is a visible duplicate effect, not a pass', async () => {
  const report = await run('scenario-buggy.json');
  expect(report.execution).toBe('completed');
  expect(report.coverage).toBe('complete_for_declared_surfaces');
  expect(report.assertions).toBe('failed');
  expect(exitCode(report)).toBe(1);
  expect(report.evidence.appliedOperations).toHaveLength(2);
  expect(report.rules.find(rule => rule.id === 'one-provider-action')).toMatchObject({ passed: false, observed: 2 });
  await assertClean(report.runId);
}, 240_000);

test('exports a self-contained fixture that rehearses the same effects in a fresh cell', async () => {
  const root = await outputRoot();
  const report = await runScenario(join(exampleDir, 'scenario.json'), {
    outputRoot: root, signal: AbortSignal.timeout(180_000),
  });
  const target = join(await outputRoot(), 'exported');
  await expect(exportFixture(report.runId, target, { outputRoot: root })).resolves.toBe(target);
  await expect(exportFixture(report.runId, target, { outputRoot: root })).rejects.toThrow('already exists');

  expect((await readdir(target)).sort()).toEqual(['manifest.json', 'retry.test.ts', 'scenario.json', 'schema.sql', 'seed.sql']);

  const rerun = await runScenario(join(target, 'scenario.json'), {
    outputRoot: await outputRoot(), signal: AbortSignal.timeout(180_000),
  });
  expect(rerun.execution).toBe('completed');
  expect(rerun.assertions).toBe('passed');
  expect(rerun.evidence.appliedOperations).toHaveLength(1);
  expect(rerun.evidence.outputJobs).toHaveLength(1);
  await assertClean(rerun.runId);
  await assertClean(report.runId);
}, 600_000);

test('a retry that crashes before useful work fails the golden terminal-state assertion', async () => {
  const report = await run('scenario-retry-crash.json');
  expect(report.execution).toBe('completed');
  expect(report.assertions).toBe('failed');
  expect(exitCode(report)).toBe(1);
  expect(report.evidence.jobAttempts.map(attempt => attempt.state)).toEqual(['failed', 'failed']);
  expect(report.rules.find(rule => rule.id === 'retry-completes')).toMatchObject({ passed: false, observed: 'failed' });
  expect(report.evidence.appliedOperations).toHaveLength(0);
  await assertClean(report.runId);
}, 240_000);

test('a provider ignoring a stable key still records two applied operations',async()=>{
  const report=await run('scenario-ignored-key.json');
  expect(report.execution).toBe('completed');
  expect(report.coverage).toBe('complete_for_declared_surfaces');
  expect(report.assertions).toBe('failed');
  expect(report.cleanup).toBe('completed');
  expect(exitCode(report)).toBe(1);
  expect(report.evidence.appliedOperations).toHaveLength(2);
  expect(new Set(report.evidence.httpAttempts.map(item=>item.idempotencyKey))).toEqual(new Set(['op-17']));
  await assertClean(report.runId);
},240_000);
