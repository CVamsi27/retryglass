import type { RunReport, SweepReport } from './contracts.js';

const REDACTED = '[REDACTED]';
const MAX_DEPTH = 16;
const MAX_ITEMS = 1_000;
const MAX_STRING = 16_384;
const SECRET_FIELD = /(?:password|passwd|secret|token|authorization|cookie|credential|api[_-]?key|private[_-]?key)/i;

/** Remove terminal control sequences before data is written to JSON or Markdown. */
function stripTerminalControls(value: string): string {
  return value
    // OSC sequences (title, hyperlinks, clipboard, etc.), terminated by BEL or ST.
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    // CSI and the remaining two-byte ESC sequences.
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[ -/]*[@-~]/g, '')
    // C0/C1 controls other than newline and tab are not useful report content.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
    .slice(0, MAX_STRING);
}

/** Make arbitrary evidence safe for bounded JSON/Markdown export. */
export function sanitizeForReport(value: unknown): unknown {
  const seen = new WeakSet<object>();

  function visit(item: unknown, depth: number, key?: string): unknown {
    if (key && SECRET_FIELD.test(key)) return REDACTED;
    if (item === null || typeof item === 'boolean' || typeof item === 'number') {
      return typeof item === 'number' && !Number.isFinite(item) ? String(item) : item;
    }
    if (typeof item === 'string') return stripTerminalControls(item);
    if (typeof item === 'bigint') return item.toString();
    if (typeof item !== 'object') return `[${typeof item}]`;
    if (depth >= MAX_DEPTH) return '[MAX_DEPTH]';
    if (seen.has(item)) return '[CIRCULAR]';
    seen.add(item);

    if (Array.isArray(item)) {
      const result = item.slice(0, MAX_ITEMS).map(child => visit(child, depth + 1));
      if (item.length > MAX_ITEMS) result.push(`[TRUNCATED ${item.length - MAX_ITEMS} ITEMS]`);
      seen.delete(item);
      return result;
    }

    const result: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(item).slice(0, MAX_ITEMS)) {
      const safeKey = stripTerminalControls(childKey);
      result[safeKey] = visit(child, depth + 1, childKey);
    }
    if (Object.keys(item).length > MAX_ITEMS) result['[TRUNCATED]'] = true;
    seen.delete(item);
    return result;
  }

  return visit(value, 0);
}

function markdown(value: unknown): string {
  return String(value).replaceAll('\\', '\\\\').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

/** Render the four independent result dimensions; never collapse them to a single pass label. */
export function renderMarkdown(report: RunReport): string {
  const clean = sanitizeForReport(report) as RunReport;
  const lines = [
    `# Retryglass run ${markdown(clean.runId)}`,
    '',
    `- Evidence: ${markdown(clean.evidenceKind)}`,
    `- Execution: ${markdown(clean.execution)}`,
    `- Coverage: ${markdown(clean.coverage)} (declared surfaces)`,
    `- Assertions: ${markdown(clean.assertions)}`,
    `- Cleanup: ${markdown(clean.cleanup)}`,
    '',
    '## Observed effects',
    '',
    `- HTTP attempts: ${clean.evidence.httpAttempts.length}`,
    `- Simulator-applied operations: ${clean.evidence.appliedOperations.length}`,
    `- Declared output jobs: ${clean.evidence.outputJobs.length}`,
    `- Job attempts observed: ${clean.evidence.jobAttempts.length}`,
    `- Database projections: before ${clean.evidence.before.length}, partial ${clean.evidence.partial.length}, after ${clean.evidence.after.length}`,
    '',
  ];
  lines.push('## Rule results', '', ...(clean.rules.length
    ? clean.rules.map(rule => `- ${markdown(rule.passed ? 'PASS' : 'FAIL')} ${markdown(rule.id)}: ${markdown(rule.observed)}`)
    : ['- No rule results recorded.']));
  lines.push('', '## Missing evidence', '', ...(clean.missing.length
    ? clean.missing.map(item => `- ${markdown(item)}`)
    : ['- None recorded.']));
  lines.push('', '> A rehearsal describes only its supplied scenario and declared observations. It does not establish that a production retry is safe.', '');
  return lines.join('\n');
}

/**
 * Render a crash sweep: the aggregate first, then one row per observed crash point. No single
 * "safe" label is emitted, and an incomplete point is never rendered as a pass.
 */
export function renderSweepMarkdown(report: SweepReport): string {
  const clean = sanitizeForReport(report) as SweepReport;
  const sweep = clean.sweep;
  const lines = [
    `# Retryglass crash sweep ${markdown(clean.runId)}`,
    '',
    `- Evidence: ${markdown(clean.evidenceKind)}`,
    `- Scenario: ${markdown(clean.scenarioId)}`,
    `- Execution: ${markdown(clean.execution)}`,
    `- Coverage: ${markdown(clean.coverage)} (declared surfaces)`,
    `- Assertions: ${markdown(clean.assertions)}`,
    `- Cleanup: ${markdown(clean.cleanup)}`,
    `- Crash points observed: ${sweep.discovered} (executed ${sweep.executed}; verified ${sweep.verified}; incomplete ${sweep.incomplete})`,
    ...(sweep.discovered > sweep.maxCrashPoints
      ? [`- Sweep cap: ${sweep.maxCrashPoints} of ${sweep.discovered} observed crash points were enumerated`]
      : []),
    `- First violated rule: ${markdown(sweep.firstViolationId ?? 'none')}`,
    '',
    '## Crash points',
    '',
  ];

  if (!sweep.crashPoints.length) {
    lines.push('- No crash point was executed in this sweep.');
  } else {
    lines.push(
      '| Point | Seam | Crash verified | Recovery | Budget used (ms) | Execution | Coverage | Assertions | Violations |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      ...sweep.crashPoints.map(point => `| ${[
        point.id, point.seam, point.crashVerified ? 'yes' : 'no',
        `${point.recovery} (${point.recoveryWaitMs} ms)`,
        String(point.durationMs),
        point.execution, point.coverage, point.assertions,
        point.violations.length ? point.violations.join(', ') : 'none',
      ].map(value => markdown(value)).join(' | ')} |`),
    );
  }

  lines.push('', '## Missing evidence', '', ...(clean.missing.length
    ? clean.missing.map(item => `- ${markdown(item)}`)
    : ['- None recorded.']));
  lines.push('', '> A sweep describes only the crash points Retryglass observed in the declared seams for this scenario. It does not establish that the worker\'s retry is safe, and it does not cover crash points outside those seams.', '');
  return lines.join('\n');
}
