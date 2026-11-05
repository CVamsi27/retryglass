import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { validateReport, validateSweepReport, type SweepCrashPoint } from '../src/contracts.js';
import { exportCrashPoint, exportFixture } from '../src/export.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const digest = (content: string) => createHash('sha256').update(content).digest('hex');

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'retryglass-export-'));
  roots.push(root);
  return root;
}

async function syntheticRun(overrides: {
  execution?: 'completed' | 'setup_failed' | 'timed_out' | 'interrupted';
  coverage?: 'complete_for_declared_surfaces' | 'partial' | 'unsupported';
  assertions?: 'passed' | 'failed' | 'not_evaluated';
  tamperSeed?: boolean;
} = {}) {
  const outputRoot = await fixtureRoot();
  const runId = 'run-export-fixture';
  const runDir = join(outputRoot, 'runs', runId);
  const inputs = join(runDir, 'inputs');
  await mkdir(inputs, { recursive: true });

  const scenarioText = await readFile('examples/invoice/scenario.json', 'utf8');
  const schema = await readFile('examples/invoice/schema.sql', 'utf8');
  const seed = await readFile('examples/invoice/seed.sql', 'utf8');
  await writeFile(join(inputs, 'scenario.json'), scenarioText);
  await writeFile(join(inputs, 'schema.sql'), schema);
  await writeFile(join(inputs, 'seed.sql'), overrides.tamperSeed ? '-- replaced\n' : seed);

  const report = validateReport({
    schemaVersion: 1,
    runId,
    scenarioId: 'invoice-ack-loss-stable',
    evidenceKind: 'observed',
    execution: overrides.execution ?? 'completed',
    coverage: overrides.coverage ?? 'complete_for_declared_surfaces',
    assertions: overrides.assertions ?? 'passed',
    cleanup: 'completed',
    evidence: {
      before: [], partial: [], after: [],
      httpAttempts: [], appliedOperations: [], outputJobs: [], jobAttempts: [],
    },
    rules: [],
    missing: [],
    provenance: { fixtureDigests: { schema: digest(schema), seed: digest(seed) }, imageIds: { tool: 'sha256:tool' } },
  });
  await writeFile(join(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(runDir, 'worker-attempt-1.log'), 'synthetic worker log\n');
  return { outputRoot, runId, runDir };
}

test('exports only the reviewed scenario, fixtures, template and manifest', async () => {
  const run = await syntheticRun();
  const target = join(await fixtureRoot(), 'regression');

  await exportFixture(run.runId, target, { outputRoot: run.outputRoot });

  const manifest = JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  expect(manifest).toMatchObject({
    sourceRunId: run.runId,
    scenarioId: 'invoice-ack-loss-stable',
    evidenceKind: 'observed',
    run: { execution: 'completed', coverage: 'complete_for_declared_surfaces', assertions: 'passed', cleanup: 'completed' },
    files: ['scenario.json', 'schema.sql', 'seed.sql', 'retry.test.ts', 'manifest.json'],
  });
  expect(manifest.imageIds).toEqual({ tool: 'sha256:tool' });
  expect(await readFile(join(target, 'scenario.json'), 'utf8')).toBe(await readFile('examples/invoice/scenario.json', 'utf8'));
  expect(await readFile(join(target, 'retry.test.ts'), 'utf8')).toContain("from 'retryglass'");
  expect(manifest.note).toMatch(/Synthetic fixture only/);
});

test('refuses to overwrite an existing target', async () => {
  const run = await syntheticRun();
  const target = join(await fixtureRoot(), 'regression');
  await mkdir(target);
  await expect(exportFixture(run.runId, target, { outputRoot: run.outputRoot }))
    .rejects.toThrow('Export target already exists');
});

test('refuses incomplete evidence and unsafe run identities', async () => {
  const partial = await syntheticRun({ coverage: 'partial', assertions: 'not_evaluated' });
  await expect(exportFixture(partial.runId, join(await fixtureRoot(), 'a'), { outputRoot: partial.outputRoot }))
    .rejects.toThrow('incomplete evidence');

  const timedOut = await syntheticRun({ execution: 'timed_out' });
  await expect(exportFixture(timedOut.runId, join(await fixtureRoot(), 'b'), { outputRoot: timedOut.outputRoot }))
    .rejects.toThrow('did not complete');

  const run = await syntheticRun();
  await expect(exportFixture('../escape', join(await fixtureRoot(), 'c'), { outputRoot: run.outputRoot }))
    .rejects.toThrow('Unsafe run ID');
  await expect(exportFixture('run-missing', join(await fixtureRoot(), 'd'), { outputRoot: run.outputRoot }))
    .rejects.toThrow();
});

test('refuses preserved fixtures that no longer match the report digest', async () => {
  const run = await syntheticRun({ tamperSeed: true });
  await expect(exportFixture(run.runId, join(await fixtureRoot(), 'tampered'), { outputRoot: run.outputRoot }))
    .rejects.toThrow('does not match the report digest');
});

test('keeps a failed-assertion run exportable without claiming it passed', async () => {
  const run = await syntheticRun({ assertions: 'failed' });
  const target = join(await fixtureRoot(), 'known-bug');
  await exportFixture(run.runId, target, { outputRoot: run.outputRoot });
  const manifest = JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8')) as { run: { assertions: string } };
  expect(manifest.run.assertions).toBe('failed');
});

async function syntheticSweepRun(options: { crashVerified?: boolean; failing?: boolean } = {}) {
  const outputRoot = await fixtureRoot();
  const runId = 'sweep-export-fixture';
  const runDir = join(outputRoot, 'runs', runId);
  const inputs = join(runDir, 'inputs');
  await mkdir(inputs, { recursive: true });

  const scenarioText = await readFile('examples/invoice/scenario-sweep.json', 'utf8');
  const schema = await readFile('examples/invoice/schema.sql', 'utf8');
  const seed = await readFile('examples/invoice/seed.sql', 'utf8');
  await writeFile(join(inputs, 'scenario.json'), scenarioText);
  await writeFile(join(inputs, 'schema.sql'), schema);
  await writeFile(join(inputs, 'seed.sql'), seed);

  const crashVerified = options.crashVerified ?? true;
  const failing = options.failing ?? true;
  const point: SweepCrashPoint = {
    id: 'cp-03', index: 2, seam: 'http.request', label: 'http fetch',
    crashVerified, exitCode: crashVerified ? 137 : 0, exitSignal: crashVerified ? 'SIGKILL' : null,
    recovery: crashVerified ? 'stalled' : 'not_recovered', recoveryWaitMs: crashVerified ? 1_850 : 0,
    evidence: { before: [], partial: [], after: [], httpAttempts: [], appliedOperations: [], outputJobs: [], jobAttempts: [] },
    rules: [
      { id: 'one-provider-action', passed: !failing, observed: failing ? 2 : 1 },
      { id: 'retry-completes', passed: true, observed: 'completed' },
    ],
    violations: failing ? ['one-provider-action'] : [],
    missing: crashVerified ? [] : ['crash point cp-03: worker exit code was 0, expected 137'],
    execution: 'completed',
    coverage: 'complete_for_declared_surfaces',
    assertions: crashVerified ? (failing ? 'failed' : 'passed') : 'not_evaluated',
    cleanup: 'completed', durationMs: 42_000,
  };
  const report = validateSweepReport({
    schemaVersion: 2, mode: 'crash-sweep', runId,
    scenarioId: 'invoice-ack-loss-sweep', evidenceKind: 'observed',
    execution: 'completed', coverage: 'complete_for_declared_surfaces',
    assertions: point.assertions, cleanup: 'completed',
    sweep: {
      maxCrashPoints: 64, discovered: 1, executed: 1,
      verified: crashVerified ? 1 : 0, incomplete: crashVerified ? 0 : 1,
      crashPoints: [point], firstViolationId: failing && crashVerified ? 'one-provider-action' : null,
    },
    missing: point.missing,
    provenance: { fixtureDigests: { schema: digest(schema), seed: digest(seed) }, imageIds: { tool: 'sha256:tool' } },
  });
  await writeFile(join(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  return { outputRoot, runId, runDir };
}

test('exports one observed crash point with the failing rule it documents', async () => {
  const run = await syntheticSweepRun();
  const target = join(await fixtureRoot(), 'crash-point');

  await exportCrashPoint(run.runId, 'cp-03', target, { outputRoot: run.outputRoot });

  const manifest = JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  expect(manifest).toMatchObject({
    schemaVersion: 2,
    kind: 'crash-point',
    sourceRunId: run.runId,
    scenarioId: 'invoice-ack-loss-sweep',
    crashPoint: { id: 'cp-03', index: 2, seam: 'http.request', crashAfter: 3 },
    point: { crashVerified: true, recovery: 'stalled', assertions: 'failed' },
    failingRules: [{ id: 'one-provider-action', observed: 2 }],
    files: ['scenario.json', 'schema.sql', 'seed.sql', 'retry.test.ts', 'manifest.json'],
  });
  expect(manifest.command).toBe('retryglass sweep --scenario scenario.json --crash-point cp-03');
  expect(await readFile(join(target, 'scenario.json'), 'utf8')).toBe(
    await readFile('examples/invoice/scenario-sweep.json', 'utf8'),
  );
  const template = await readFile(join(target, 'retry.test.ts'), 'utf8');
  expect(template).toContain("from 'retryglass'");
  expect(template).toContain('crashPoints');
});

test('refuses an unverified crash point and an unknown or unsafe identity', async () => {
  const unverified = await syntheticSweepRun({ crashVerified: false });
  await expect(exportCrashPoint(unverified.runId, 'cp-03', join(await fixtureRoot(), 'a'), { outputRoot: unverified.outputRoot }))
    .rejects.toThrow('unverified crash point');

  const run = await syntheticSweepRun();
  await expect(exportCrashPoint(run.runId, 'cp-09', join(await fixtureRoot(), 'b'), { outputRoot: run.outputRoot }))
    .rejects.toThrow('not recorded in this sweep');
  await expect(exportCrashPoint(run.runId, '../../etc', join(await fixtureRoot(), 'c'), { outputRoot: run.outputRoot }))
    .rejects.toThrow('Unsafe crash point identity');
  await expect(exportCrashPoint('../escape', 'cp-03', join(await fixtureRoot(), 'd'), { outputRoot: run.outputRoot }))
    .rejects.toThrow('Unsafe run ID');
});

test('refuses a schemaVersion 1 report through the crash-point exporter', async () => {
  const run = await syntheticRun();
  await expect(exportCrashPoint(run.runId, 'cp-03', join(await fixtureRoot(), 'v1'), { outputRoot: run.outputRoot }))
    .rejects.toThrow(/schemaVersion 2 sweep report/);
});

test('refuses to overwrite an existing crash-point target', async () => {
  const run = await syntheticSweepRun();
  const target = join(await fixtureRoot(), 'taken');
  await mkdir(target);
  await expect(exportCrashPoint(run.runId, 'cp-03', target, { outputRoot: run.outputRoot }))
    .rejects.toThrow('Export target already exists');
});

test('refuses single-run and crash-point exports when cleanup failed', async () => {
  const single = await syntheticRun();
  const sweep = await syntheticSweepRun();
  for (const run of [single, sweep]) {
    const path = join(run.runDir, 'report.json');
    const report = JSON.parse(await readFile(path, 'utf8'));
    report.cleanup = 'failed';
    await writeFile(path, JSON.stringify(report));
  }
  await expect(exportFixture(single.runId, join(await fixtureRoot(), 'a'), { outputRoot: single.outputRoot }))
    .rejects.toThrow(/cleanup/i);
  await expect(exportCrashPoint(sweep.runId, 'cp-03', join(await fixtureRoot(), 'b'), { outputRoot: sweep.outputRoot }))
    .rejects.toThrow(/cleanup/i);
});
