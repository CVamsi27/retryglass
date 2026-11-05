import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AssertionState, Cell, Cleanup, Coverage, CrashPoint, Evidence, Execution, Projection,
  RuleResult, Scenario,
} from '../contracts.js';
import {
  collectOutputs, createCell, destroyCell, execCollector, isWorkerRunning, readWorkerLogs,
  simulatorControl, startWorker, stopWorker,
} from '../docker/lifecycle.js';
import { CoverageError, decideAssertions, evaluate } from '../policy.js';
import { crashAfterFor, parseSeamLog } from './discovery.js';
import { prefixFor, recoverStalledJob, verifyCrash } from './crash.js';

/** One crash point rehearsal: exactly the single-retry rehearsal, with a killed first attempt. */
export interface PointRehearsal {
  crashVerified: boolean; exitCode: number | null; exitSignal: string | null;
  recovery: 'stalled' | 'not_recovered'; recoveryWaitMs: number;
  evidence: Evidence; rules: RuleResult[]; violations: string[]; missing: string[];
  execution: Execution; coverage: Coverage; assertions: AssertionState; cleanup: Cleanup;
  durationMs: number;
}

export interface CrashPointInput {
  scenario: Scenario;
  fixtureRoot: string;
  runDir: string;
  runId: string;
  point: CrashPoint;
  deadlineMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_POINT_DEADLINE_MS = 240_000;
const TERMINAL_DEADLINE_MS = 90_000;
const POLL_MS = 250;

class PhaseError extends Error {
  readonly execution: Execution;
  constructor(execution: Execution, message: string) {
    super(message); this.name = 'PhaseError'; this.execution = execution;
  }
}

interface BarrierResult { terminatedActive: boolean; remaining: number; }

interface TerminalObservation {
  exists: boolean; jobId: string; state: string; operationKey: string;
  attemptsMade: number; attemptsStarted: number;
}

function asTerminal(value: unknown): TerminalObservation {
  if (!value || typeof value !== 'object') throw new PhaseError('interrupted', 'Collector returned no job state');
  const record = value as Record<string, unknown>;
  return {
    exists: record.exists === true,
    jobId: String(record.jobId ?? ''),
    state: String(record.state ?? 'unknown'),
    operationKey: String(record.operationKey ?? ''),
    attemptsMade: Number(record.attemptsMade ?? 0),
    attemptsStarted: Number(record.attemptsStarted ?? 0),
  };
}

/**
 * Rehearse one enumerated crash point in its own fresh cell: crash the first attempt after the
 * point's seam, verify the crash, recover the same persisted job through BullMQ's documented stall
 * path, retry it unchrashed, then barrier, seal and observe. Every doubt becomes an explicit reason
 * and the point can never be evaluated as a pass.
 */
export async function runCrashPoint(input: CrashPointInput): Promise<PointRehearsal> {
  const { scenario, fixtureRoot, runDir, runId, point } = input;
  const started = Date.now();
  const deadlineMs = input.deadlineMs ?? DEFAULT_POINT_DEADLINE_MS;
  const deadline = started + deadlineMs;
  const crashAfter = crashAfterFor(point);

  const evidence: Evidence = {
    before: [], partial: [], after: [],
    httpAttempts: [], appliedOperations: [], outputJobs: [], jobAttempts: [],
  };
  const missing: string[] = [];
  let rules: RuleResult[] = [];
  let execution: Execution = 'completed';
  let coverage: Coverage = 'complete_for_declared_surfaces';
  let cleanup: Cleanup = 'failed';
  let crashVerified = false;
  let exitCode: number | null = null;
  let exitSignal: string | null = null;
  let recovery: 'stalled' | 'not_recovered' = 'not_recovered';
  let recoveryWaitMs = 0;
  let evaluated = false;
  let cell: Cell | undefined;
  let observationComplete = false;

  const note = (reason: string) => {
    if (!missing.includes(reason)) missing.push(reason);
    coverage = 'partial';
  };
  const observeUnsupported = (logs: string, phase: string) => {
    const parsed = parseSeamLog(logs);
    for (const observation of parsed.io) {
      note(`crash point ${point.id} ${phase}: undeclared I/O observed (${observation.kind} -> ${observation.target}); this boundary is not a supported crash point`);
    }
    for (const seam of parsed.unknownSeams) note(`crash point ${point.id} ${phase}: undeclared seam (${seam})`);
  };
  const guard = () => {
    if (input.signal?.aborted) throw new PhaseError('interrupted', 'Sweep was interrupted');
    if (Date.now() >= deadline) throw new PhaseError('timed_out', `Crash point ${point.id} exceeded its ${deadlineMs} ms budget`);
  };

  const waitForTerminal = async (jobId: string): Promise<TerminalObservation> => {
    const terminalDeadline = Math.min(Date.now() + TERMINAL_DEADLINE_MS, deadline);
    for (;;) {
      guard();
      let observed = asTerminal(await execCollector(cell!, 'job-state', { prefix: prefixFor(cell!), jobId }));
      if (!observed.exists) throw new PhaseError('interrupted', `Input job ${jobId} disappeared from the queue`);
      if (observed.state === 'failed' || observed.state === 'completed') return observed;
      if (!await isWorkerRunning(cell!)) {
        observed = asTerminal(await execCollector(cell!, 'job-state', { prefix: prefixFor(cell!), jobId }));
        if (observed.state === 'failed' || observed.state === 'completed') return observed;
        throw new PhaseError('interrupted', `Worker exited before the retried job reached a terminal state (last state: ${observed.state})`);
      }
      if (Date.now() >= terminalDeadline) {
        throw new PhaseError('timed_out', `Retried job ${jobId} did not reach a terminal state (last state: ${observed.state})`);
      }
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
    }
  };

  try {
    cell = await createCell(scenario, fixtureRoot, runDir, runId);
    guard();
    evidence.before = await execCollector(cell, 'snapshot', {
      tables: scenario.tables, expectedRows: scenario.fixture.expectedRows,
    }) as Projection[];
    await execCollector(cell, 'job-add', { prefix: prefixFor(cell), job: scenario.job });

    // Attempt 1: killed after the point's settled seam.
    await startWorker(cell, scenario, null, { crashAfter });
    const crash = await verifyCrash(cell, scenario, crashAfter);
    crashVerified = crash.crashVerified;
    exitCode = crash.exitCode;
    exitSignal = crash.exitCode === 137 ? 'SIGKILL' : null;
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, 'worker-crash.log'), crash.logs, 'utf8').catch(() => undefined);
    if (!crash.crashVerified) {
      for (const reason of crash.reasons) note(`crash point ${point.id}: ${reason}`);
    }
    observeUnsupported(crash.logs, 'crash');
    guard();

    // Recovery of the crashed job, by documented stall semantics only.
    const recovered = await recoverStalledJob(cell, scenario);
    recovery = recovered.recovery;
    recoveryWaitMs = recovered.recoveryWaitMs;
    if (recovery !== 'stalled') {
      note(`crash point ${point.id}: the crashed job was not recovered by the stall path within ${recoveryWaitMs} ms (state ${recovered.state}); recovery was refused, not forced`);
    }
    if (crashVerified) {
      evidence.jobAttempts.push({
        attempt: 1, jobId: scenario.job.id, operationKey: scenario.job.operationKey, state: 'failed',
        attemptsMade: recovered.attemptsMade, attemptsStarted: recovered.attemptsStarted,
      });
    }
    guard();

    // Barrier: stop writers, quiesce application logins, seal and drain the simulator, then observe.
    const barrier = await execCollector(cell, 'quiesce', { role: cell.applicationRole }) as BarrierResult;
    if (barrier.remaining !== 0) {
      note(`crash point ${point.id}: database barrier left ${barrier.remaining} application backend(s) after the crash`);
    }
    const sealed = await simulatorControl(cell, 'seal');
    if (sealed.sealed !== true) note(`crash point ${point.id}: the simulator did not confirm sealing`);
    const firstLedger = await simulatorControl(cell, 'read');
    evidence.httpAttempts = firstLedger.httpAttempts as Evidence['httpAttempts'];
    evidence.appliedOperations = firstLedger.appliedOperations as Evidence['appliedOperations'];
    for (const issue of firstLedger.issues) note(`crash point ${point.id}: simulator reported ${issue}`);
    evidence.partial = await execCollector(cell, 'snapshot', { tables: scenario.tables }) as Projection[];
    guard();

    if (crashVerified && recovery === 'stalled') {
      await execCollector(cell, 'resume-db', { role: cell.applicationRole });
      await simulatorControl(cell, 'resume');
      const retried = await execCollector(cell, 'job-retry', {
        prefix: prefixFor(cell), jobId: scenario.job.id,
      }) as { jobId: string; state: string };
      if (retried.jobId !== scenario.job.id) {
        throw new PhaseError('interrupted', `Retry changed the physical job identity to ${retried.jobId}`);
      }
      if (!['waiting', 'prioritized', 'delayed'].includes(retried.state)) {
        throw new PhaseError('interrupted', `Retried job entered an unexpected state: ${retried.state}`);
      }

      // Attempt 2 is never crashed.
      await startWorker(cell, scenario, null, { crashAfter: 0 });
      let terminal: TerminalObservation;
      try {
        terminal = await waitForTerminal(scenario.job.id);
      } finally {
        const logs = await readWorkerLogs(cell).catch(() => { note(`crash point ${point.id}: retry observation log unavailable`); return ''; });
        observeUnsupported(logs, 'retry');
        await writeFile(join(runDir, 'worker-retry.log'), logs, 'utf8').catch(() => undefined);
      }
      const stop = await stopWorker(cell, 'SIGTERM');
      if (stop.code !== 0) note(`crash point ${point.id}: the retry worker exited with code ${stop.code}`);
      const retryBarrier = await execCollector(cell, 'quiesce', { role: cell.applicationRole }) as BarrierResult;
      if (retryBarrier.remaining !== 0) {
        note(`crash point ${point.id}: database barrier left ${retryBarrier.remaining} application backend(s) after the retry`);
      }
      const sealedAgain = await simulatorControl(cell, 'seal');
      if (sealedAgain.sealed !== true) note(`crash point ${point.id}: the simulator did not confirm sealing after the retry`);
      const secondLedger = await simulatorControl(cell, 'read');
      evidence.httpAttempts = secondLedger.httpAttempts as Evidence['httpAttempts'];
      evidence.appliedOperations = secondLedger.appliedOperations as Evidence['appliedOperations'];
      for (const issue of secondLedger.issues) note(`crash point ${point.id}: simulator reported ${issue}`);
      evidence.jobAttempts.push({
        attempt: 2, jobId: terminal.jobId, operationKey: terminal.operationKey,
        state: terminal.state === 'failed' ? 'failed' : 'completed',
        attemptsMade: terminal.attemptsMade, attemptsStarted: terminal.attemptsStarted,
      });
      evidence.after = await execCollector(cell, 'snapshot', { tables: scenario.tables }) as Projection[];
      evidence.outputJobs = await collectOutputs(cell, scenario.outputQueues);
      observationComplete = coverage === 'complete_for_declared_surfaces' && crashVerified && evidence.jobAttempts.length === 2;
    } else {
      note(`crash point ${point.id}: the retry was not attempted because the crash point is not verified`);
    }
  } catch (error) {
    execution = error instanceof PhaseError ? error.execution : 'interrupted';
    note(error instanceof Error ? error.message : String(error));
  } finally {
    if (cell) {
      try { await destroyCell(cell); cleanup = 'completed'; }
      catch (error) { cleanup = 'failed'; note(`crash point ${point.id}: cleanup failed: ${error instanceof Error ? error.message : String(error)}`); }
    } else {
      cleanup = 'failed';
      if (!missing.length) note(`crash point ${point.id}: the disposable cell was never created`);
    }
  }

  if (execution === 'completed' && observationComplete) {
    try {
      rules = evaluate(evidence, scenario.rules);
      evaluated = true;
    } catch (error) {
      if (error instanceof CoverageError) {
        rules = error.results;
        for (const reason of error.missing) note(`crash point ${point.id}: ${reason}`);
      } else throw error;
    }
  }

  return {
    crashVerified, exitCode, exitSignal, recovery, recoveryWaitMs,
    evidence, rules,
    violations: rules.filter(rule => !rule.passed).map(rule => rule.id),
    missing,
    execution, coverage,
    assertions: rules.some(rule => !rule.passed) ? 'failed'
      : evaluated && execution === 'completed' && coverage === 'complete_for_declared_surfaces' && cleanup === 'completed'
      ? decideAssertions(rules)
      : 'not_evaluated',
    cleanup,
    durationMs: Date.now() - started,
  };
}
