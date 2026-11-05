import { randomBytes } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  Cleanup, Coverage, Evidence, Execution, JobAttempt, Projection, RunOptions,
  RunReport, Scenario, StopResult,
} from './contracts.js';
import { validateReport } from './contracts.js';
import {
  collectOutputs, createCell, destroyCell, execCollector, imageIdentity, isWorkerRunning,
  prepareImages, readWorkerLogs, simulatorControl, startWorker, stopWorker, TOOL_IMAGE,
} from './docker/lifecycle.js';
import { evaluate, decideAssertions, CoverageError } from './policy.js';
import { sanitizeForReport } from './report.js';
import { loadScenario } from './scenario.js';
import type { Cell } from './contracts.js';

const WORKER_DEADLINE_MS = 90_000;
const POLL_MS = 250;

class PhaseError extends Error {
  readonly execution: Execution;
  constructor(execution: Execution, message: string) {
    super(message); this.name = 'PhaseError'; this.execution = execution;
  }
}

interface JobObservation {
  exists: boolean;
  jobId: string;
  state: string;
  operationKey: string;
  attemptsMade: number;
  attemptsStarted: number;
  failedReason: string | null;
}

interface BarrierResult { terminatedActive: boolean; remaining: number; }

function prefixFor(runId: string): string {
  return `retryglass-${runId}`;
}

function asObservation(value: unknown): JobObservation {
  if (!value || typeof value !== 'object') throw new PhaseError('interrupted', 'Collector returned no job state');
  const record = value as Record<string, unknown>;
  return {
    exists: record.exists === true,
    jobId: String(record.jobId ?? ''),
    state: String(record.state ?? 'unknown'),
    operationKey: String(record.operationKey ?? ''),
    attemptsMade: Number(record.attemptsMade ?? 0),
    attemptsStarted: Number(record.attemptsStarted ?? 0),
    failedReason: typeof record.failedReason === 'string' ? record.failedReason : null,
  };
}

async function waitForTerminalState(
  cell: Cell,
  jobId: string,
  expected: 'failed' | 'completed',
  signal?: AbortSignal,
): Promise<JobObservation> {
  const deadline = Date.now() + WORKER_DEADLINE_MS;
  const observe = () => execCollector(cell, 'job-state', { prefix: prefixFor(cell.runId), jobId })
    .then(asObservation);
  for (;;) {
    if (signal?.aborted) throw new PhaseError('interrupted', 'Rehearsal was interrupted while waiting for the worker');
    let last = await observe();
    if (!last.exists) throw new PhaseError('interrupted', `Input job ${jobId} disappeared from the queue`);
    if (last.state === 'failed' || last.state === 'completed') return last;
    if (!await isWorkerRunning(cell)) {
      // The worker may have exited between the state read and this check; confirm before failing.
      last = await observe();
      if (last.state === 'failed' || last.state === 'completed') return last;
      throw new PhaseError('interrupted', `Worker exited before the job reached a terminal state (last state: ${last.state})`);
    }
    if (Date.now() >= deadline) {
      throw new PhaseError('timed_out', `Job ${jobId} did not reach a terminal state within ${WORKER_DEADLINE_MS} ms (last state: ${last.state})`);
    }
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}

interface AttemptEvidence {
  attempt: JobAttempt;
  stop: StopResult;
  job: JobObservation;
}

/**
 * Run one attempt on a fresh worker process, then stop the writer, block its database logins and
 * seal the simulator before anything is observed.
 */
async function runAttempt(
  cell: Cell,
  scenario: Scenario,
  ordinal: 1 | 2,
  expected: 'failed' | 'completed',
  runDir: string,
  signal?: AbortSignal,
): Promise<AttemptEvidence> {
  await startWorker(cell, scenario, cell.networkId);
  let job: JobObservation;
  try {
    job = await waitForTerminalState(cell, scenario.job.id, expected, signal);
  } finally {
    const logs = await readWorkerLogs(cell).catch(() => '');
    await writeFile(join(runDir, `worker-attempt-${ordinal}.log`), logs, 'utf8').catch(() => undefined);
  }
  const stop = await stopWorker(cell, 'SIGTERM');
  const barrier = await execCollector(cell, 'quiesce', { role: cell.applicationRole }) as BarrierResult;
  const sealed = await simulatorControl(cell, 'seal');
  const terminal = job.state === 'failed' ? 'failed' : 'completed';
  return {
    stop: { ...stop, remainingDatabaseBackends: barrier.remaining, simulatorDrained: sealed.sealed === true },
    job,
    attempt: {
      attempt: ordinal,
      jobId: job.jobId,
      operationKey: job.operationKey,
      state: terminal,
      attemptsMade: job.attemptsMade,
      attemptsStarted: job.attemptsStarted,
    },
  };
}

function classify(error: unknown): Execution {
  if (error instanceof PhaseError) return error.execution;
  return 'interrupted';
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Execute one declared rehearsal. Every observation is bounded and a failure in collection can only
 * degrade the result to partial/not-evaluated; it can never become a passing run.
 */
export async function runScenario(path: string, options: RunOptions): Promise<RunReport> {
  const startedAt = new Date().toISOString();
  const loaded = await loadScenario(path);
  const { scenario, fixtureRoot, fixtureDigests, contents } = loaded;
  const runId = `run-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
  const runDir = join(options.outputRoot, 'runs', runId);
  await mkdir(join(options.outputRoot, 'runs'), { recursive: true });
  await mkdir(runDir);
  // Preserve exactly what was rehearsed so a later export cannot drift from the report.
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

  const evidence: Evidence = {
    before: [], partial: [], after: [],
    httpAttempts: [], appliedOperations: [], outputJobs: [], jobAttempts: [],
  };
  const missing: string[] = [];
  const stops: StopResult[] = [];
  let coverage: Coverage = 'complete_for_declared_surfaces';
  let execution: Execution = 'completed';
  let cleanup: Cleanup = 'failed';
  let attemptOne: AttemptEvidence | undefined;
  let attemptTwo: AttemptEvidence | undefined;
  let cell: Cell | undefined;
  let observationComplete = false;
  let imageIds: { tool: string; worker: string } | undefined;

  const note = (reason: string) => {
    if (!missing.includes(reason)) missing.push(reason);
    coverage = 'partial';
  };

  try {
    // The local example image is built from this checkout, so a stale local build must never run.
    if (scenario.worker.image === TOOL_IMAGE) await prepareImages();
    imageIds = { tool: await imageIdentity(TOOL_IMAGE), worker: await imageIdentity(scenario.worker.image) };
    const runtimeScenario: Scenario = { ...scenario, worker: { ...scenario.worker, image: imageIds.worker } };
    cell = await createCell(runtimeScenario, inputsDir, runDir, runId);
    evidence.before = await execCollector(cell, 'snapshot', {
      tables: scenario.tables, expectedRows: scenario.fixture.expectedRows,
    }) as Projection[];
    await execCollector(cell, 'job-add', { prefix: prefixFor(runId), job: scenario.job });

    attemptOne = await runAttempt(cell, runtimeScenario, 1, 'failed', runDir, options.signal);
    stops.push(attemptOne.stop);
    evidence.jobAttempts.push(attemptOne.attempt);
    const firstLedger = await simulatorControl(cell, 'read');
    evidence.httpAttempts = firstLedger.httpAttempts as Evidence['httpAttempts'];
    evidence.appliedOperations = firstLedger.appliedOperations as Evidence['appliedOperations'];
    for (const issue of firstLedger.issues) note(`Simulator reported: ${issue}`);
    if (attemptOne.stop.remainingDatabaseBackends !== 0) {
      note(`Database barrier left ${attemptOne.stop.remainingDatabaseBackends} application backend(s) after attempt 1`);
    }
    evidence.partial = await execCollector(cell, 'snapshot', { tables: scenario.tables }) as Projection[];

    await execCollector(cell, 'resume-db', { role: cell.applicationRole });
    await simulatorControl(cell, 'resume');
    const retry = await execCollector(cell, 'job-retry', {
      prefix: prefixFor(runId), jobId: attemptOne.attempt.jobId,
    }) as { jobId: string; state: string };
    if (retry.state !== 'waiting' && retry.state !== 'prioritized' && retry.state !== 'delayed') {
      throw new PhaseError('interrupted', `Retried job entered an unexpected state: ${retry.state}`);
    }

    attemptTwo = await runAttempt(cell, runtimeScenario, 2, 'completed', runDir, options.signal);
    stops.push(attemptTwo.stop);
    evidence.jobAttempts.push(attemptTwo.attempt);
    if (attemptTwo.stop.remainingDatabaseBackends !== 0) {
      note(`Database barrier left ${attemptTwo.stop.remainingDatabaseBackends} application backend(s) after attempt 2`);
    }
    const secondLedger = await simulatorControl(cell, 'read');
    evidence.httpAttempts = secondLedger.httpAttempts as Evidence['httpAttempts'];
    evidence.appliedOperations = secondLedger.appliedOperations as Evidence['appliedOperations'];
    for (const issue of secondLedger.issues) note(`Simulator reported: ${issue}`);
    evidence.after = await execCollector(cell, 'snapshot', { tables: scenario.tables }) as Projection[];
    evidence.outputJobs = await collectOutputs(cell, scenario.outputQueues);
    observationComplete = coverage === 'complete_for_declared_surfaces' && evidence.jobAttempts.length === 2;
  } catch (error) {
    execution = classify(error);
    note(message(error));
  } finally {
    if (cell) {
      try { await destroyCell(cell); cleanup = 'completed'; }
      catch (error) { cleanup = 'failed'; note(`Cleanup failed: ${message(error)}`); }
    }
  }

  if (!cell) {
    cleanup = 'failed';
    if (!missing.length) note('The disposable cell was never created');
  }
  let rules: RunReport['rules'] = [];
  let assertions: RunReport['assertions'] = 'not_evaluated';
  if (execution === 'completed' && observationComplete) {
    try {
      rules = evaluate(evidence, scenario.rules);
      assertions = decideAssertions(rules);
    } catch (error) {
      if (error instanceof CoverageError) {
        for (const reason of error.missing) note(reason);
        rules = error.results;
      } else throw error;
    }
    const decision = decideAssertions(rules);
    assertions = decision === 'failed' ? 'failed'
      : coverage === 'complete_for_declared_surfaces' && cleanup === 'completed' ? decision : 'not_evaluated';
  }

  const provenance: Record<string, unknown> = {
    runner: 'Retryglass local constrained cell',
    scenarioPath: path,
    runDir,
    worker: { image: scenario.worker.image, processor: scenario.worker.processor, revision: scenario.worker.revision },
    fixtureDigests,
    provider: scenario.provider,
    jobId: scenario.job.id,
    operationKey: scenario.job.operationKey,
    stops: stops.map(stop => ({ ...stop })),
    attemptOneFailedReason: attemptOne?.job.failedReason ?? null,
    attemptTwoFailedReason: attemptTwo?.job.failedReason ?? null,
  };
  if (imageIds) provenance.imageIds = imageIds;
  else note('Image identity was not available before execution');

  const finishedAt = new Date().toISOString();
  const report = validateReport({
    schemaVersion: 1,
    runId,
    scenarioId: scenario.scenarioId,
    evidenceKind: 'observed',
    execution,
    coverage,
    assertions,
    cleanup,
    evidence: sanitizeForReport(evidence),
    rules: sanitizeForReport(rules),
    missing: missing.map(item => String(sanitizeForReport(item))),
    provenance: sanitizeForReport(provenance),
    timing: { startedAt, finishedAt },
  });

  await writeFile(join(runDir, 'report.json.tmp'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await rename(join(runDir, 'report.json.tmp'), join(runDir, 'report.json'));
  return report;
}
