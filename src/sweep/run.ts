import { randomBytes } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CrashPoint, Scenario, SweepCrashPoint, SweepReport } from '../contracts.js';
import { validateSweepReport } from '../contracts.js';
import {
  createCell, destroyCell, execCollector, imageIdentity, isWorkerRunning, prepareImages,
  readWorkerLogs, startWorker, stopWorker, TOOL_IMAGE,
} from '../docker/lifecycle.js';
import { sanitizeForReport } from '../report.js';
import { loadScenario } from '../scenario.js';
import { prefixFor } from './crash.js';
import { MAX_CRASH_POINTS, crashAfterFor, discoverCrashPoints } from './discovery.js';
import { runCrashPoint } from './point.js';
import { aggregateSweep } from './report.js';

export interface SweepOptions {
  outputRoot: string;
  maxCrashPoints?: number;
  discoveryRuns?: number;
  /** Restrict execution to these crash-point identities (used by an exported regression). */
  crashPoints?: string[];
  signal?: AbortSignal;
}

const DISCOVERY_DEADLINE_MS = 120_000;
const POLL_MS = 250;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One discovery run: the scenario's processor runs once without a crash, and its bounded stdout
 * becomes the only source of crash points. The cell is destroyed afterwards — nothing about the
 * discovery run is reused by a point.
 */
async function discoveryRun(args: {
  scenario: Scenario; fixtureRoot: string; runDir: string; runId: string; signal?: AbortSignal;
}): Promise<string> {
  const { scenario, fixtureRoot, runDir, runId } = args;
  args.signal?.throwIfAborted();
  const cell = await createCell(scenario, fixtureRoot, runDir, runId, undefined, args.signal);
  try {
    args.signal?.throwIfAborted();
    await execCollector(cell, 'job-add', { prefix: prefixFor(cell), job: scenario.job });
    args.signal?.throwIfAborted();
    await startWorker(cell, scenario, cell.networkId, { crashAfter: 0 });
    const deadline = Date.now() + DISCOVERY_DEADLINE_MS;
    for (;;) {
      args.signal?.throwIfAborted();
      const state = await execCollector(cell, 'job-state', {
        prefix: prefixFor(cell), jobId: scenario.job.id,
      }) as { exists?: boolean; state?: string };
      if (state.exists === false) throw new Error(`Discovery run lost input job ${scenario.job.id}`);
      if (state.state === 'failed' || state.state === 'completed') break;
      if (!await isWorkerRunning(cell)) break; // whatever it did, the log is the fact
      if (Date.now() >= deadline) throw new Error(`Discovery run did not reach a terminal state within ${DISCOVERY_DEADLINE_MS} ms`);
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
    }
    return await readWorkerLogs(cell);
  } finally {
    await stopWorker(cell, 'SIGTERM').catch(() => undefined);
    await destroyCell(cell);
  }
}

/**
 * Execute an enumerated crash sweep. Discovery runs enumerate the boundaries; every point then gets
 * a fresh cell, a verified crash, a documented stall recovery and an unchrashed retry. The sweep is
 * sequential and bounded, and any doubt becomes an explicit `missing` reason.
 */
export async function runSweep(path: string, options: SweepOptions): Promise<SweepReport> {
  const startedAt = new Date().toISOString();
  const loaded = await loadScenario(path);
  const { scenario, fixtureRoot, fixtureDigests, contents } = loaded;
  if (scenario.experiment !== 'crash-sweep') {
    throw new Error(`A sweep requires experiment 'crash-sweep' (this scenario declares '${scenario.experiment}'); use 'run' for a failed-retry rehearsal`);
  }

  const maxCrashPoints = options.maxCrashPoints ?? MAX_CRASH_POINTS;
  if (!Number.isInteger(maxCrashPoints) || maxCrashPoints < 1 || maxCrashPoints > MAX_CRASH_POINTS) {
    throw new Error('maxCrashPoints must be an integer from 1 to 64');
  }
  const discoveryRuns = options.discoveryRuns ?? 3;
  if (discoveryRuns !== 3) throw new Error('A sweep requires three discovery runs');
  const runId = `sweep-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  const runDir = join(options.outputRoot, 'runs', runId);
  await mkdir(join(options.outputRoot, 'runs'), { recursive: true });
  await mkdir(runDir);

  // Preserve exactly what was rehearsed, so an export cannot drift from the report.
  const inputsDir = join(runDir, 'inputs');
  await mkdir(inputsDir, { recursive: true });
  await writeFile(join(inputsDir, 'scenario.json'), contents.scenario, 'utf8');
  for (const [path, content] of [
    [scenario.fixture.schema, contents.schema],
    [scenario.fixture.seed, contents.seed],
  ] as const) {
    const destination = join(inputsDir, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content, 'utf8');
  }

  const extraMissing: string[] = [];
  let discoveryCleanupFailed = false;

  if (!options.signal?.aborted && scenario.worker.image === TOOL_IMAGE) await prepareImages();
  const imageIds = options.signal?.aborted ? undefined
    : { tool: await imageIdentity(TOOL_IMAGE), worker: await imageIdentity(scenario.worker.image) };
  const runtimeScenario: Scenario = imageIds ? { ...scenario, worker: { ...scenario.worker, image: imageIds.worker } } : scenario;

  // --- Discovery: enumerate the crash points the processor actually reaches. -----------------
  const logs: string[] = [];
  for (let run = 1; run <= discoveryRuns; run++) {
    if (options.signal?.aborted) break;
    try {
      logs.push(await discoveryRun({
        scenario: runtimeScenario, fixtureRoot: inputsDir, runDir,
        runId: `${runId}-d${run}`,
        signal: options.signal,
      }));
    } catch (error) {
      extraMissing.push(`discovery run ${run} failed: ${message(error)}`);
      discoveryCleanupFailed = !(options.signal?.aborted && error === options.signal.reason);
      break;
    }
  }
  for (const [index, log] of logs.entries()) {
    await writeFile(join(runDir, `discovery-${index + 1}.log`), log, 'utf8').catch(() => undefined);
  }

  const discovery = discoverCrashPoints(logs, { maxCrashPoints });
  const discovered = discovery.observed;
  await writeFile(join(runDir, 'crash-points.json'), `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    runs: logs.length,
    discovered,
    maxCrashPoints,
    stable: discovery.stable,
    reasons: discovery.reasons,
    unsupportedObservations: discovery.unsupported,
    unknownSeams: discovery.unknownSeams,
    points: discovery.points,
  }, null, 2)}\n`, 'utf8').catch(() => undefined);

  if (!discovery.stable) {
    for (const reason of discovery.reasons) extraMissing.push(`discovery: ${reason}`);
  }
  for (const observation of discovery.unsupported) {
    extraMissing.push(`undeclared I/O observed during discovery (${observation.kind} -> ${observation.target}); it is not a supported crash point`);
  }
  for (const seam of discovery.unknownSeams) {
    extraMissing.push(`undeclared seam reported by the worker (${seam}); it is not a supported crash point`);
  }

  // --- Execution: one fresh cell per crash point, sequentially. -------------------------------
  let points: CrashPoint[] = discovery.points;
  if (!options.signal?.aborted && options.crashPoints?.length) {
    const requested = new Set(options.crashPoints);
    for (const id of requested) {
      if (!points.some(point => point.id === id)) {
        throw new Error(`Crash point ${id} was not enumerated by this scenario (observed: ${points.map(point => point.id).join(', ') || 'none'})`);
      }
    }
    points = points.filter(point => requested.has(point.id));
  }

  const rehearsed: SweepCrashPoint[] = [];
  for (const point of points) {
    if (options.signal?.aborted) {
      extraMissing.push(`sweep interrupted before crash point ${point.id}`);
      break;
    }
    const pointDir = join(runDir, 'crash-points', point.id);
    await mkdir(pointDir, { recursive: true });
    const rehearsal = await runCrashPoint({
      scenario: runtimeScenario, fixtureRoot: inputsDir, runDir: pointDir,
      runId: `${runId}-${point.id}`,
      point,
      signal: options.signal,
    });
    const record: SweepCrashPoint = {
      id: point.id, index: point.index, seam: point.seam, label: point.label,
      crashVerified: rehearsal.crashVerified,
      exitCode: rehearsal.exitCode,
      exitSignal: rehearsal.exitSignal,
      recovery: rehearsal.recovery,
      recoveryWaitMs: rehearsal.recoveryWaitMs,
      evidence: sanitizeForReport(rehearsal.evidence) as SweepCrashPoint['evidence'],
      rules: sanitizeForReport(rehearsal.rules) as SweepCrashPoint['rules'],
      violations: rehearsal.violations.map(item => String(sanitizeForReport(item))),
      missing: rehearsal.missing.map(item => String(sanitizeForReport(item))),
      execution: rehearsal.execution,
      coverage: rehearsal.coverage,
      assertions: rehearsal.assertions,
      cleanup: rehearsal.cleanup,
      durationMs: rehearsal.durationMs,
    };
    rehearsed.push(record);
    await writeFile(join(pointDir, 'evidence.json'), `${JSON.stringify({
      ...record,
      crashAfter: crashAfterFor(point),
    }, null, 2)}\n`, 'utf8').catch(() => undefined);
  }

  // --- Aggregation ---------------------------------------------------------------------------
  const provenance: Record<string, unknown> = {
    runner: 'Retryglass local constrained crash sweep',
    scenarioPath: path,
    runDir,
    experiment: scenario.experiment,
    worker: { image: scenario.worker.image, processor: scenario.worker.processor, revision: scenario.worker.revision },
    fixtureDigests,
    provider: scenario.provider,
    jobId: scenario.job.id,
    operationKey: scenario.job.operationKey,
    discoveryRuns: logs.length,
    unsupportedObservations: discovery.unsupported,
    // A scoped sweep (an exported regression) rehearses a subset on purpose; the counters and
    // `missing` still state that the remaining observed points were not executed.
    restrictedTo: options.crashPoints?.length ? [...options.crashPoints] : null,
  };
  if (imageIds) provenance.imageIds = imageIds;
  const interrupted = options.signal?.aborted === true;
  if (interrupted) extraMissing.push('Sweep was interrupted');

  const report = validateSweepReport(sanitizeForReport(aggregateSweep(rehearsed, {
    runId,
    scenarioId: scenario.scenarioId,
    maxCrashPoints,
    discovered,
    discovery: { runs: logs.length, stable: discovery.stable, reasons: discovery.reasons, cleanupFailed: discoveryCleanupFailed,
      unsupported: discovery.unsupported, unknownSeams: discovery.unknownSeams },
    extraMissing,
    interrupted,
    startedAt,
    finishedAt: new Date().toISOString(),
    provenance,
  })));

  await writeFile(join(runDir, 'report.json.tmp'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await rename(join(runDir, 'report.json.tmp'), join(runDir, 'report.json'));
  return report;
}
