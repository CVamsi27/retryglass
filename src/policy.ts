import type { AssertionState, Evidence, JsonScalar, Projection, Rule, RuleResult, RunReport } from './contracts.js';

export class CoverageError extends Error {
  readonly missing: string[];
  readonly results: RuleResult[];
  constructor(missing: string[], results: RuleResult[] = []) {
    super(missing.join('; ')); this.name = 'CoverageError'; this.missing = missing; this.results = results;
  }
}

function projectionFor(evidence: Evidence, table: string): Projection {
  const matches = evidence.after.filter(projection => projection.table === table);
  if (matches.length !== 1) throw new CoverageError([`${matches.length ? 'Ambiguous' : 'Missing'} projection: ${table}`]);
  const projection = matches[0]!;
  if (projection.truncated) throw new CoverageError([`Truncated projection: ${table}`]);
  const seen = new Set<string>();
  for (const row of projection.rows) {
    if (projection.key.some(key => !Object.hasOwn(row, key))) throw new CoverageError([`Missing projection key: ${table}`]);
    const key = JSON.stringify(projection.key.map(column => row[column]));
    if (seen.has(key)) throw new CoverageError([`Ambiguous duplicate projection key: ${table}`]);
    seen.add(key);
  }
  return projection;
}

function result(rule: Rule, observed: JsonScalar, passed: boolean): RuleResult {
  return { id: rule.id, passed, observed };
}

function evaluateRule(evidence: Evidence, rule: Rule): RuleResult {
  switch (rule.kind) {
    case 'row_count': {
      const observed = projectionFor(evidence, rule.table).rows.length;
      return result(rule, observed, observed === rule.equals);
    }
    case 'row_value': {
      const projection = projectionFor(evidence, rule.table);
      if (!projection.columns.includes(rule.column)) throw new CoverageError([`Missing projected column: ${rule.table}.${rule.column}`]);
      const rows = projection.rows.filter(row => Object.entries(rule.key).every(([key, value]) => Object.is(row[key], value)));
      if (rows.length > 1) throw new CoverageError([`Ambiguous row selector: ${rule.id}`]);
      if (!rows.length) return result(rule, 'missing-row', false);
      const value = rows[0]![rule.column];
      if (value === undefined || (typeof value === 'object' && value !== null) || !['string', 'number', 'boolean', 'object'].includes(typeof value)) {
        throw new CoverageError([`Unsupported or missing projected scalar: ${rule.id}`]);
      }
      return result(rule, value as JsonScalar, Object.is(value, rule.equals));
    }
    case 'applied_count': {
      if (!Array.isArray(evidence.appliedOperations)) throw new CoverageError(['Missing applied-operation ledger']);
      return result(rule, evidence.appliedOperations.length, evidence.appliedOperations.length === rule.equals);
    }
    case 'applied_max': {
      if (!Array.isArray(evidence.appliedOperations)) throw new CoverageError(['Missing applied-operation ledger']);
      return result(rule, evidence.appliedOperations.length, evidence.appliedOperations.length <= rule.maximum);
    }
    case 'required_http': {
      if (!Array.isArray(evidence.httpAttempts)) throw new CoverageError(['Missing HTTP-attempt ledger']);
      return result(rule, evidence.httpAttempts.length, evidence.httpAttempts.length >= rule.minimum);
    }
    case 'http_attempts_max': {
      if (!Array.isArray(evidence.httpAttempts)) throw new CoverageError(['Missing HTTP-attempt ledger']);
      return result(rule, evidence.httpAttempts.length, evidence.httpAttempts.length <= rule.maximum);
    }
    case 'output_count':
    case 'output_max': {
      if (!Array.isArray(evidence.outputJobs)) throw new CoverageError(['Missing output-job observation']);
      const observed = evidence.outputJobs.filter(job => job.queue === rule.queue).length;
      return result(rule, observed, rule.kind === 'output_count' ? observed === rule.equals : observed <= rule.maximum);
    }
    case 'job_state': {
      const matches = evidence.jobAttempts.filter(attempt => attempt.attempt === rule.attempt);
      if (matches.length !== 1) throw new CoverageError([`${matches.length ? 'Ambiguous' : 'Missing'} terminal state for attempt ${rule.attempt}`]);
      return result(rule, matches[0]!.state, matches[0]!.state === rule.equals);
    }
  }
}

export function evaluate(evidence: Evidence, rules: Rule[]): RuleResult[] {
  const results: RuleResult[] = []; const missing: string[] = [];
  if (evidence.jobAttempts.length === 2) {
    const [first, second] = evidence.jobAttempts;
    if (first!.jobId !== second!.jobId || first!.operationKey !== second!.operationKey) missing.push('Retry changed the physical job identity or business operation key');
  }
  for (const rule of rules) {
    try { results.push(evaluateRule(evidence, rule)); }
    catch (error) {
      if (error instanceof CoverageError) missing.push(...error.missing);
      else throw error;
    }
  }
  if (missing.length) throw new CoverageError(missing, results);
  return results;
}

export function decideAssertions(results: RuleResult[], _previousAssertions?: AssertionState): AssertionState {
  if (!results.length) return 'not_evaluated';
  return results.some(rule => !rule.passed) ? 'failed' : 'passed';
}

/** The four dimensions every result carries, in both schema versions. */
export interface ResultDimensions {
  execution: RunReport['execution'];
  coverage: RunReport['coverage'];
  assertions: RunReport['assertions'];
  cleanup: RunReport['cleanup'];
}

/**
 * Exit precedence: `2` setup/cleanup failure, `1` an evaluated violation, `3` incomplete evidence,
 * `0` only when the run is complete and passing. An observed violation outranks incompleteness so
 * a real finding cannot be hidden behind a partial sweep; v1 reports never reach the `1` branch with
 * incomplete coverage because their rules are only evaluated under complete coverage.
 */
export function exitCode(report: ResultDimensions): 0 | 1 | 2 | 3 {
  if (report.execution === 'setup_failed' || report.cleanup === 'failed') return 2;
  if (report.assertions === 'failed') return 1;
  if (report.execution !== 'completed' || report.coverage !== 'complete_for_declared_surfaces' || report.assertions === 'not_evaluated') return 3;
  return 0;
}
