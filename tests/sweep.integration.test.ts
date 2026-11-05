import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { prepareImages, waitForContainerCleanup, waitForNetworkCleanup } from '../src/docker/lifecycle.js';
import type { SweepReport } from '../src/contracts.js';
import { exportCrashPoint } from '../src/export.js';
import { exitCode } from '../src/policy.js';
import { runSweep } from '../src/sweep/run.js';

/**
 * Real constrained cells: enumeration, crash verification, stall recovery, retry and aggregation.
 * Needs a Docker daemon; excluded from `pnpm test` and run with `pnpm test:integration`.
 */
const roots: string[] = [];
const exampleDir = resolve('examples/invoice');

function build(): void {
  execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'], {
    stdio: 'inherit',
  });
}


async function outputRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'retryglass-sweep-'));
  roots.push(root);
  return root;
}

async function assertClean(report:SweepReport):Promise<void>{
  const discoveryRuns=Number(report.provenance.discoveryRuns??3);
  const runs=[...Array.from({length:discoveryRuns},(_,index)=>`${report.runId}-d${index+1}`),...report.sweep.crashPoints.map(point=>`${report.runId}-${point.id}`)];
  for(const runId of runs){await waitForContainerCleanup(runId);await waitForNetworkCleanup(runId);}
}

beforeAll(() => {
  build();
  return prepareImages();
}, 600_000);

afterAll(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});

test('the corrected invoice worker passes every enumerated crash point', async () => {
  const report = await runSweep(join(exampleDir, 'scenario-sweep.json'), {
    outputRoot: await outputRoot(),
    discoveryRuns: 3,
    signal: AbortSignal.timeout(3_000_000),
  });

  expect(report.execution).toBe('completed');
  expect(report.coverage).toBe('complete_for_declared_surfaces');
  expect(report.assertions).toBe('passed');
  expect(report.cleanup).toBe('completed');
  expect(exitCode(report)).toBe(0);
  expect(report.sweep.firstViolationId).toBeNull();

  // The invoice processor settles at least these five seams: two reads, one insert, the provider
  // call, the follow-up queue add and the final update.
  expect(report.sweep.discovered).toBeGreaterThanOrEqual(5);
  expect(report.sweep.executed).toBe(report.sweep.discovered);
  expect(report.sweep.verified).toBe(report.sweep.discovered);

  await assertClean(report);
}, 3_000_000);

test('the buggy worker duplicates only where the provider already applied', async () => {
  const report = await runSweep(join(exampleDir, 'scenario-sweep-buggy.json'), {
    outputRoot: await outputRoot(),
    discoveryRuns: 3,
    signal: AbortSignal.timeout(3_000_000),
  });

  expect(report.execution).toBe('completed');
  expect(report.coverage).toBe('complete_for_declared_surfaces');
  expect(report.assertions).toBe('failed');
  expect(exitCode(report)).toBe(1);
  expect(report.sweep.firstViolationId).toBe('one-provider-action');

  const providerPoint = report.sweep.crashPoints.find(point => point.seam === 'http.request');
  expect(providerPoint?.violations).toContain('one-provider-action');
  expect(providerPoint?.rules.find(rule => rule.id === 'one-provider-action')).toMatchObject({ passed: false, observed: 2 });

  // A crash before the provider call is still a single applied effect on retry.
  const beforeProvider = report.sweep.crashPoints.filter(point => point.index < (providerPoint?.index ?? 0));
  expect(beforeProvider.length).toBeGreaterThan(0);
  for (const point of beforeProvider) {
    expect(point.violations, `${point.id} before the provider`).toEqual([]);
    expect(point.evidence.appliedOperations).toHaveLength(1);
  }

  await assertClean(report);
}, 3_000_000);

test('an exported crash point reproduces its violation in a fresh cell', async () => {
  const root = await outputRoot();
  const sweep = await runSweep(join(exampleDir, 'scenario-sweep-buggy.json'), {
    outputRoot: root,
    discoveryRuns: 3,
    signal: AbortSignal.timeout(3_000_000),
  });
  const target = join(await outputRoot(), 'regression');
  const crashPoint = sweep.sweep.crashPoints.find(point => point.violations.length > 0);
  expect(crashPoint).toBeDefined();

  await exportCrashPoint(sweep.runId, crashPoint!.id, target, { outputRoot: root });
  await expect(exportCrashPoint(sweep.runId, crashPoint!.id, target, { outputRoot: root }))
    .rejects.toThrow('already exists');

  const rerun = await runSweep(join(target, 'scenario.json'), {
    outputRoot: await outputRoot(),
    discoveryRuns: 3,
    crashPoints: [crashPoint!.id],
    signal: AbortSignal.timeout(3_000_000),
  });
  expect(rerun.sweep.executed).toBe(1);
  expect(rerun.sweep.crashPoints[0]?.crashVerified).toBe(true);
  expect(rerun.sweep.crashPoints[0]?.violations).toEqual(crashPoint!.violations);
  expect(rerun.assertions).toBe('failed');
  expect(exitCode(rerun)).toBe(1);

  await assertClean(sweep);
  await assertClean(rerun);
}, 3_000_000);
