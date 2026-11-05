import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  validateReport, validateScenario, validateSweepReport, type RunReport, type Scenario,
} from './contracts.js';
import { PACKAGE_ROOT } from './package-root.js';

export interface ExportOptions {
  outputRoot: string;
}

const RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const CRASH_POINT_ID = /^cp-[0-9]{2,3}$/;
// Shipped with the package, so an installed CLI must not resolve them against the working directory.
const TEMPLATE = join(PACKAGE_ROOT, 'templates', 'regression.test.ts');
const SWEEP_TEMPLATE = join(PACKAGE_ROOT, 'templates', 'sweep-regression.test.ts');

function digest(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Join a scenario-declared relative path under a root, refusing anything that escapes it. */
function contained(root: string, path: string): string {
  const target = resolve(root, path);
  const within = relative(root, target);
  if (!within || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) {
    throw new Error(`Exported path escapes the target directory: ${path}`);
  }
  return target;
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch { return false; }
}

function requireExportable(report: RunReport): void {
  if (report.cleanup !== 'completed') throw new Error('Cannot export a run with failed cleanup');
  if (report.evidenceKind !== 'observed') throw new Error('Only an observed rehearsal can be exported');
  if (report.execution !== 'completed') throw new Error(`Cannot export a run that did not complete (execution: ${report.execution})`);
  if (report.coverage !== 'complete_for_declared_surfaces') {
    throw new Error(`Cannot export incomplete evidence (coverage: ${report.coverage})`);
  }
}

/**
 * Export a completed rehearsal as a self-contained regression fixture: the exact validated scenario,
 * only its declared fixtures, an immutable manifest and a normal Vitest test. Reports and worker logs
 * are deliberately not copied, and an existing target is never overwritten.
 */
export async function exportFixture(
  runId: string,
  target: string,
  options: ExportOptions,
): Promise<string> {
  if (!RUN_ID.test(runId)) throw new Error('Unsafe run ID');
  const runDir = join(resolve(options.outputRoot, 'runs'), runId);
  const report = validateReport(JSON.parse(await readFile(join(runDir, 'report.json'), 'utf8')) as unknown);
  if (report.runId !== runId) throw new Error('Report identity does not match the requested run');
  requireExportable(report);

  const inputsDir = join(runDir, 'inputs');
  const scenarioText = await readFile(join(inputsDir, 'scenario.json'), 'utf8');
  const scenario = validateScenario(JSON.parse(scenarioText) as unknown);
  if (report.scenarioId && report.scenarioId !== scenario.scenarioId) {
    throw new Error('Report scenario does not match the preserved inputs');
  }

  const fixtures = new Map<string, string>();
  for (const [kind, path] of [['schema', scenario.fixture.schema], ['seed', scenario.fixture.seed]] as const) {
    const content = await readFile(contained(inputsDir, path), 'utf8');
    const expected = (report.provenance?.fixtureDigests as Record<string, unknown> | undefined)?.[kind];
    if (typeof expected !== 'string' || digest(content) !== expected) {
      throw new Error(`Preserved ${kind} fixture does not match the report digest`);
    }
    fixtures.set(path, content);
  }

  const template = await readFile(TEMPLATE, 'utf8');
  const resolvedTarget = resolve(target);
  if (await exists(resolvedTarget)) throw new Error('Export target already exists');

  const staging = `${resolvedTarget}.tmp-${randomBytes(4).toString('hex')}`;
  const files = ['scenario.json', ...fixtures.keys(), 'retry.test.ts', 'manifest.json'];
  try {
    await mkdir(staging);
    await writeFile(join(staging, 'scenario.json'), scenarioText, 'utf8');
    for (const [path, content] of fixtures) {
      const destination = join(staging, path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, content, 'utf8');
    }
    await writeFile(join(staging, 'retry.test.ts'), template, 'utf8');
    await writeFile(join(staging, 'manifest.json'), `${JSON.stringify({
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      sourceRunId: report.runId,
      scenarioId: scenario.scenarioId,
      evidenceKind: report.evidenceKind,
      run: {
        execution: report.execution,
        coverage: report.coverage,
        assertions: report.assertions,
        cleanup: report.cleanup,
      },
      worker: scenario.worker,
      imageIds: report.provenance?.imageIds ?? null,
      reportDigest: digest(JSON.stringify(report)),
      scenarioDigest: digest(scenarioText),
      fixtureDigests: { schema: digest(fixtures.get(scenario.fixture.schema)!), seed: digest(fixtures.get(scenario.fixture.seed)!) },
      files,
      note: 'Synthetic fixture only. Reports and worker logs are not included.',
    }, null, 2)}\n`, 'utf8');
    await rename(staging, resolvedTarget);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return resolvedTarget;
}

export interface CrashPointExportOptions {
  outputRoot: string;
}

/** Copy the preserved scenario and its declared fixtures, verifying them against the report. */
async function preservedInputs(
  inputsDir: string,
  scenarioId: string | undefined,
  provenance: Record<string, unknown> | undefined,
): Promise<{ scenarioText: string; scenario: Scenario; fixtures: Map<string, string> }> {
  const scenarioText = await readFile(join(inputsDir, 'scenario.json'), 'utf8');
  const scenario = validateScenario(JSON.parse(scenarioText) as unknown);
  if (scenarioId && scenarioId !== scenario.scenarioId) {
    throw new Error('Report scenario does not match the preserved inputs');
  }
  const fixtures = new Map<string, string>();
  for (const [kind, path] of [['schema', scenario.fixture.schema], ['seed', scenario.fixture.seed]] as const) {
    const content = await readFile(contained(inputsDir, path), 'utf8');
    const expected = (provenance?.fixtureDigests as Record<string, unknown> | undefined)?.[kind];
    if (typeof expected !== 'string' || digest(content) !== expected) {
      throw new Error(`Preserved ${kind} fixture does not match the report digest`);
    }
    fixtures.set(path, content);
  }
  return { scenarioText, scenario, fixtures };
}

/**
 * Export one observed crash point as a self-contained regression fixture. An unverified or
 * incomplete point is refused: a regression may document a known violation, but it may not claim
 * evidence the sweep did not observe.
 */
export async function exportCrashPoint(
  runId: string,
  crashPointId: string,
  target: string,
  options: CrashPointExportOptions,
): Promise<string> {
  if (!RUN_ID.test(runId)) throw new Error('Unsafe run ID');
  if (!CRASH_POINT_ID.test(crashPointId)) throw new Error('Unsafe crash point identity');

  const runDir = join(resolve(options.outputRoot, 'runs'), runId);
  const raw = JSON.parse(await readFile(join(runDir, 'report.json'), 'utf8')) as unknown;
  const version = raw && typeof raw === 'object' ? (raw as { schemaVersion?: unknown }).schemaVersion : undefined;
  if (version !== 2) {
    throw new Error('A crash-point export requires a schemaVersion 2 sweep report; use the single-run export for schemaVersion 1');
  }
  const report = validateSweepReport(raw);
  if (report.runId !== runId) throw new Error('Report identity does not match the requested run');
  if (report.cleanup !== 'completed') throw new Error('Cannot export a sweep with failed cleanup');

  const point = report.sweep.crashPoints.find(candidate => candidate.id === crashPointId);
  if (!point) {
    throw new Error(`Crash point ${crashPointId} is not recorded in this sweep`);
  }
  if (!point.crashVerified) throw new Error(`Cannot export an unverified crash point (${crashPointId})`);
  if (point.cleanup !== 'completed') throw new Error('Cannot export a crash point with failed cleanup');
  if (point.execution !== 'completed') throw new Error(`Cannot export a crash point that did not complete (execution: ${point.execution})`);
  if (point.coverage !== 'complete_for_declared_surfaces') {
    throw new Error(`Cannot export incomplete evidence (coverage: ${point.coverage})`);
  }

  const inputsDir = join(runDir, 'inputs');
  const { scenarioText, scenario, fixtures } = await preservedInputs(inputsDir, report.scenarioId, report.provenance);
  const template = await readFile(SWEEP_TEMPLATE, 'utf8');

  const resolvedTarget = resolve(target);
  if (await exists(resolvedTarget)) throw new Error('Export target already exists');

  const staging = `${resolvedTarget}.tmp-${randomBytes(4).toString('hex')}`;
  const files = ['scenario.json', ...fixtures.keys(), 'retry.test.ts', 'manifest.json'];
  try {
    await mkdir(staging);
    await writeFile(join(staging, 'scenario.json'), scenarioText, 'utf8');
    for (const [path, content] of fixtures) {
      const destination = join(staging, path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, content, 'utf8');
    }
    await writeFile(join(staging, 'retry.test.ts'), template, 'utf8');
    await writeFile(join(staging, 'manifest.json'), `${JSON.stringify({
      schemaVersion: 2,
      kind: 'crash-point',
      exportedAt: new Date().toISOString(),
      sourceRunId: report.runId,
      scenarioId: scenario.scenarioId,
      evidenceKind: report.evidenceKind,
      crashPoint: {
        id: point.id, index: point.index, seam: point.seam, label: point.label,
        crashAfter: point.index + 1,
      },
      command: `retryglass sweep --scenario scenario.json --crash-point ${point.id}`,
      point: {
        crashVerified: point.crashVerified, exitCode: point.exitCode, exitSignal: point.exitSignal,
        recovery: point.recovery, recoveryWaitMs: point.recoveryWaitMs,
        execution: point.execution, coverage: point.coverage, assertions: point.assertions, cleanup: point.cleanup,
      },
      sweep: {
        execution: report.execution, coverage: report.coverage,
        assertions: report.assertions, cleanup: report.cleanup,
        discovered: report.sweep.discovered, verified: report.sweep.verified,
      },
      // The observed values document the bug this regression was cut from.
      rules: point.rules,
      failingRules: point.rules.filter(rule => !rule.passed).map(rule => ({ id: rule.id, observed: rule.observed })),
      violations: point.violations,
      worker: scenario.worker,
      imageIds: report.provenance?.imageIds ?? null,
      reportDigest: digest(JSON.stringify(report)),
      scenarioDigest: digest(scenarioText),
      fixtureDigests: { schema: digest(fixtures.get(scenario.fixture.schema)!), seed: digest(fixtures.get(scenario.fixture.seed)!) },
      files,
      note: 'Synthetic fixture only. Reports and worker logs are not included.',
    }, null, 2)}\n`, 'utf8');
    await rename(staging, resolvedTarget);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return resolvedTarget;
}
