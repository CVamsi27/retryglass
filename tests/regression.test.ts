import { expect, test } from 'vitest';
import * as regression from '../src/regression.js';
import type { SweepReport, SweepCrashPoint } from '../src/contracts.js';

const expected = { id: 'cp-03', index: 2, seam: 'http.request' as const, label: 'http fetch' };
function report(): SweepReport {
  const point: SweepCrashPoint = {
    ...expected, crashVerified: true, exitCode: 137, exitSignal: 'SIGKILL', recovery: 'stalled', recoveryWaitMs: 2000,
    evidence: { before: [], partial: [], after: [], httpAttempts: [], appliedOperations: [], outputJobs: [], jobAttempts: [] },
    rules: [{ id: 'required-effect', passed: true, observed: 1 }], violations: [], missing: [],
    execution: 'completed', coverage: 'complete_for_declared_surfaces', assertions: 'passed', cleanup: 'completed', durationMs: 10,
  };
  return {
    schemaVersion: 2, mode: 'crash-sweep', runId: 'selected', scenarioId: 'fixture', evidenceKind: 'observed',
    execution: 'completed', coverage: 'partial', assertions: 'not_evaluated', cleanup: 'completed',
    sweep: { maxCrashPoints: 64, discovered: 5, executed: 1, verified: 1, incomplete: 0, crashPoints: [point], firstViolationId: null },
    missing: ['4 enumerated crash point(s) were not executed'],
    provenance: { discovery: { runs: 3, stable: true, reasons: [], unsupported: [], unknownSeams: [], cleanupFailed: false }, executionIssues: [] },
  };
}
function check(value: SweepReport) {
  expect(typeof regression.assertCrashPointPassed).toBe('function');
  regression.assertCrashPointPassed(value, expected, ['required-effect']);
}
test('accepts a complete selected point without claiming the omitted full sweep passed', () => {
  expect(() => check(report())).not.toThrow();
});
test.each([
  ['empty rules', (r: SweepReport) => { r.sweep.crashPoints[0]!.rules = []; }],
  ['not evaluated', (r: SweepReport) => { r.sweep.crashPoints[0]!.assertions = 'not_evaluated'; }],
  ['partial evidence', (r: SweepReport) => { r.sweep.crashPoints[0]!.coverage = 'partial'; }],
  ['cleanup failure', (r: SweepReport) => { r.cleanup = 'failed'; }],
  ['changed seam', (r: SweepReport) => { r.sweep.crashPoints[0]!.seam = 'db.query'; }],
  ['unsupported discovery', (r: SweepReport) => { (r.provenance.discovery as Record<string, unknown>).unsupported = ['external']; }],
  ['missing discovery', (r: SweepReport) => { delete r.provenance.discovery; }],
  ['execution problem', (r: SweepReport) => { r.provenance.executionIssues = ['collector unavailable']; }],
])('rejects %s in a selected regression', (_name, mutate) => {
  const value = report(); mutate(value);
  // The exported test must fail on incomplete observations even if there are no failed rule entries.
  expect(() => check(value)).toThrow();
});
