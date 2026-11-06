import type {
  AssertionState, Cleanup, Coverage, Execution, SweepCrashPoint, SweepReport,
} from '../contracts.js';

export interface SweepMeta {
  runId: string;
  scenarioId: string;
  maxCrashPoints: number;
  discovered: number;
  discovery: { runs: number; stable: boolean; reasons: string[]; cleanupFailed?: boolean; unsupported?: unknown[]; unknownSeams?: string[] };
  extraMissing?: string[];
  interrupted?: boolean;
  startedAt: string;
  finishedAt: string;
  provenance?: Record<string, unknown>;
}

const EXECUTION_RANK: Record<Execution, number> = {
  completed: 0, interrupted: 1, timed_out: 2, setup_failed: 3,
};

/**
 * Aggregate per-point rehearsals into the v2 report.
 *
 * Precedence, stated once: a violation at any evaluated point keeps `assertions: failed` even when
 * other points are incomplete. `passed` requires every discovered point to be executed, verified,
 * recovered, evaluated and passing under complete coverage. Anything else is `not_evaluated`.
 */
export function aggregateSweep(points: SweepCrashPoint[], meta: SweepMeta): SweepReport {
  const verified = points.filter(point => point.crashVerified).length;
  const incomplete = points.length - verified;
  const reasons: string[] = [...(meta.extraMissing ?? [])];

  if (meta.discovered > meta.maxCrashPoints) {
    reasons.push(`sweep cap reached: ${meta.discovered} crash points were observed but only ${meta.maxCrashPoints} were enumerated`);
  }
  if (!meta.discovery.stable) {
    reasons.push(...(meta.discovery.reasons.length ? meta.discovery.reasons : ['discovery order was not stable across runs']));
  }
  if (points.length < meta.discovered) {
    reasons.push(`${meta.discovered - points.length} enumerated crash point(s) were not executed`);
  }
  for (const point of points) {
    for (const reason of point.missing) reasons.push(reason);
    // Only state the generic fact when the point did not already record why it is incomplete.
    if (!point.missing.length) {
      if (!point.crashVerified) reasons.push(`crash point ${point.id}: the crash was not verified`);
      if (point.recovery !== 'stalled') reasons.push(`crash point ${point.id}: the crashed job was not recovered by the stall path`);
    }
  }

  const noSeams = meta.discovered === 0;
  const coverage: Coverage = noSeams && !meta.interrupted
    ? 'unsupported'
    : reasons.length
      ? 'partial'
      : 'complete_for_declared_surfaces';

  const anyViolation = points.some(point => point.assertions === 'failed' || point.violations.length > 0);
  const everyPointPassed = points.length > 0
    && points.length === meta.discovered
    && points.every(point => point.assertions === 'passed'
      && point.crashVerified
      && point.recovery === 'stalled'
      && point.execution === 'completed'
      && point.coverage === 'complete_for_declared_surfaces');
  const assertions: AssertionState = anyViolation
    ? 'failed'
    : everyPointPassed && coverage === 'complete_for_declared_surfaces'
      ? 'passed'
      : 'not_evaluated';

  const execution = points.length
    ? points.reduce<Execution>((worst, point) => (
      EXECUTION_RANK[point.execution] > EXECUTION_RANK[worst] ? point.execution : worst
    ), meta.interrupted ? 'interrupted' : 'completed')
    : 'interrupted';

  const cleanup: Cleanup = meta.discovery.cleanupFailed || points.some(point => point.cleanup === 'failed')
    ? 'failed'
    : 'completed';

  const firstViolation = points.find(point => point.violations.length > 0);

  return {
    schemaVersion: 2,
    mode: 'crash-sweep',
    runId: meta.runId,
    scenarioId: meta.scenarioId,
    evidenceKind: 'observed',
    execution,
    coverage,
    assertions,
    cleanup,
    sweep: {
      maxCrashPoints: meta.maxCrashPoints,
      discovered: meta.discovered,
      executed: points.length,
      verified,
      incomplete,
      crashPoints: points,
      firstViolationId: firstViolation ? firstViolation.violations[0]! : null,
    },
    missing: [...new Set(reasons)],
    provenance: {
      ...(meta.provenance ?? {}),
      executionIssues: meta.extraMissing ?? [],
      discovery: {
        runs: meta.discovery.runs,
        stable: meta.discovery.stable,
        reasons: meta.discovery.reasons,
        cleanupFailed: meta.discovery.cleanupFailed ?? false,
        unsupported: meta.discovery.unsupported ?? [],
        unknownSeams: meta.discovery.unknownSeams ?? [],
      },
    },
    timing: { startedAt: meta.startedAt, finishedAt: meta.finishedAt },
  };
}
