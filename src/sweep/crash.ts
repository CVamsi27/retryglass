import { execCollector, isWorkerRunning, readWorkerLogs, startWorker, stopWorker } from '../docker/lifecycle.js';
import type { Cell, Scenario } from '../contracts.js';

export interface ParsedMarker { crashAfter: number; completed: number; }

export interface ObservedJob {
  exists: boolean; jobId: string; operationKey: string; state: string;
  attemptsMade: number; attemptsStarted: number; failedReason: string | null;
}

export interface CrashVerification {
  crashVerified: boolean; exitCode: number | null; marker: ParsedMarker | null;
  job: ObservedJob | null; reasons: string[]; logs: string;
}

export interface RecoveryResult {
  recovery: 'stalled' | 'not_recovered'; recoveryWaitMs: number;
  state: string; failedReason: string | null;
  attemptsMade: number; attemptsStarted: number;
}

/** One positive integer marker is required; multiple markers are ambiguous. */
export function parseCrashMarker(logs: string): ParsedMarker | null {
  let found: ParsedMarker | null = null;
  for (const line of logs.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes('crash-marker')) continue;
    try {
      const parsed = JSON.parse(trimmed) as { kind?: unknown; crashAfter?: unknown; completed?: unknown };
      if (parsed.kind !== 'crash-marker') continue;
      if (typeof parsed.crashAfter !== 'number' || typeof parsed.completed !== 'number') continue;
      if (!Number.isSafeInteger(parsed.crashAfter) || !Number.isSafeInteger(parsed.completed)
        || parsed.crashAfter < 1 || parsed.completed < 1) continue;
      if (found) return null;
      found = { crashAfter: parsed.crashAfter, completed: parsed.completed };
    } catch { /* malformed marker candidates are skipped; absence is a failed verification */ }
  }
  return found;
}

export function prefixFor(cell: Cell): string {
  return `retryglass-${cell.runId}`;
}

async function observeJob(cell: Cell, scenario: Scenario): Promise<ObservedJob | null> {
  try {
    const value = await execCollector(cell, 'job-state', {
      prefix: prefixFor(cell), jobId: scenario.job.id,
    }) as Record<string, unknown>;
    return {
      exists: value.exists === true,
      jobId: String(value.jobId ?? ''),
      operationKey: String(value.operationKey ?? ''),
      state: String(value.state ?? 'unknown'),
      attemptsMade: Number(value.attemptsMade ?? 0),
      attemptsStarted: Number(value.attemptsStarted ?? 0),
      failedReason: typeof value.failedReason === 'string' ? value.failedReason : null,
    };
  } catch {
    return null; // collector failure must surface as a reason, never as a pass
  }
}

export async function waitForWorkerExit(cell: Cell, deadlineMs = 30_000, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    signal?.throwIfAborted();
    if (!await isWorkerRunning(cell)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

/**
 * Read container evidence, remove the crashed worker, and decide — with explicit reasons —
 * whether the crash is verified: exit 137, marker for exactly this crash point, and the input
 * job still present under the same jobId with the same business key.
 */
export async function verifyCrash(cell: Cell, scenario: Scenario, crashAfter: number, signal?: AbortSignal): Promise<CrashVerification> {
  const reasons: string[] = [];
  const exited = await waitForWorkerExit(cell, undefined, signal);
  if (!exited) reasons.push(`worker did not exit within the deadline (CRASH_AFTER=${crashAfter})`);
  const logs = await readWorkerLogs(cell).catch(() => '');
  const stop = await stopWorker(cell, 'SIGTERM'); // inspects then removes the crashed container
  const marker = parseCrashMarker(logs);
  if (stop.code !== 137) reasons.push(`worker exit code was ${stop.code}, expected 137 (SIGKILL)`);
  if (stop.oomKilled !== false) reasons.push('worker OOM termination was not ruled out');
  if (stop.forced !== false) reasons.push('worker required supervisor termination or its stop state was not observed');
  if (!marker) reasons.push('crash marker missing from worker log');
  else if (marker.crashAfter !== crashAfter || marker.completed !== crashAfter) {
    reasons.push(`marker recorded crashAfter=${marker.crashAfter} completed=${marker.completed}, expected ${crashAfter}`);
  }
  const job = await observeJob(cell, scenario);
  if (!job) reasons.push('collector could not observe the input job');
  else if (!job.exists) reasons.push(`input job ${scenario.job.id} disappeared after the crash`);
  else {
    if (job.jobId !== scenario.job.id) reasons.push(`job id changed to ${job.jobId}`);
    if (job.operationKey !== scenario.job.operationKey) reasons.push(`business key changed to ${job.operationKey}`);
  }
  return { crashVerified: reasons.length === 0, exitCode: stop.code, marker, job, reasons, logs };
}

/**
 * Let BullMQ's documented stall path fail the crashed job: a recovery worker runs the stalled
 * checker, the first stall sets the deferred failure (maxStalledCount: 0), and the pickup fails
 * the job with `job stalled more than allowable limit` without re-running the processor.
 * Bounded by deadlineMs; never forces the state.
 */
export async function recoverStalledJob(
  cell: Cell,
  scenario: Scenario,
  options?: { deadlineMs?: number; signal?: AbortSignal },
): Promise<RecoveryResult> {
  const deadlineMs = options?.deadlineMs ?? 15_000;
  const started = Date.now();
  options?.signal?.throwIfAborted();
  await startWorker(cell, scenario, null, { crashAfter: 0 });
  let job: ObservedJob | null = null;
  const deadline = started + deadlineMs;
  for (;;) {
    options?.signal?.throwIfAborted();
    job = await observeJob(cell, scenario);
    if (job?.state === 'failed') break;
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const recoveryWaitMs = Date.now() - started;
  await stopWorker(cell, 'SIGTERM');
  const stalled = job?.state === 'failed' && /stalled more than allowable limit/i.test(job.failedReason ?? '')
    && job.jobId === scenario.job.id && job.operationKey === scenario.job.operationKey;
  return {
    recovery: stalled ? 'stalled' : 'not_recovered',
    recoveryWaitMs,
    state: job?.state ?? 'unknown',
    failedReason: job?.failedReason ?? null,
    attemptsMade: job?.attemptsMade ?? 0,
    attemptsStarted: job?.attemptsStarted ?? 0,
  };
}
