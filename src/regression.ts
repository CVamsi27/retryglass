import type { CrashPoint, SweepReport } from './contracts.js';

/** Judge one explicitly selected regression; omitted sweep points remain unassessed. */
export function assertCrashPointPassed(report: SweepReport, expected: CrashPoint, ruleIds: readonly string[]): void {
  const fail = (message: string): never => { throw new Error(`Crash-point regression incomplete or failed: ${message}`); };
  if (report.execution !== 'completed' || report.cleanup !== 'completed' || report.evidenceKind !== 'observed') fail('execution or cleanup');
  const discovery = report.provenance.discovery as Record<string, unknown> | undefined;
  if (!discovery) throw new Error('Crash-point regression incomplete: missing discovery');
  if (discovery.stable !== true || discovery.cleanupFailed !== false
    || typeof discovery.runs !== 'number' || discovery.runs < 3) fail('discovery was not fully verified');
  for (const field of ['reasons', 'unsupported', 'unknownSeams']) {
    if (!Array.isArray(discovery[field]) || (discovery[field] as unknown[]).length) fail(`discovery ${field}`);
  }
  if (!Array.isArray(report.provenance.executionIssues) || report.provenance.executionIssues.length) fail('sweep execution issues');
  if (report.sweep.executed !== 1 || report.sweep.crashPoints.length !== 1) fail('expected exactly one selected point');
  const point = report.sweep.crashPoints[0]!;
  if (point.id !== expected.id || point.index !== expected.index || point.seam !== expected.seam || point.label !== expected.label) fail('selected seam identity changed');
  if (!point.crashVerified || point.exitCode !== 137 || point.exitSignal !== 'SIGKILL' || point.recovery !== 'stalled') fail('crash or recovery was not verified');
  if (point.execution !== 'completed' || point.coverage !== 'complete_for_declared_surfaces'
    || point.assertions !== 'passed' || point.cleanup !== 'completed' || point.missing.length || point.violations.length) fail('selected point dimensions');
  const observed = new Set(point.rules.map(rule => rule.id));
  if (!ruleIds.length || observed.size !== ruleIds.length || point.rules.length !== ruleIds.length
    || ruleIds.some(id => !observed.has(id)) || point.rules.some(rule => !rule.passed)) fail('required assertions were not all evaluated and passing');
}
