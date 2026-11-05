import { expect, test } from 'vitest';
import type { Evidence, RunReport } from '../src/contracts.js';

function evidence(): Evidence {
  return {
    before: [], partial: [],
    after: [{ table: 'public.invoices', key: ['operation_key'], columns: ['operation_key', 'status'], rows: [{ operation_key: 'op-17', status: 'complete' }], truncated: false }],
    httpAttempts: [
      { attemptId: 'a1', operationKey: 'op-17', idempotencyKey: 'op-17', payloadDigest: 'body', response: 'accepted_response_lost' },
      { attemptId: 'a2', operationKey: 'op-17', idempotencyKey: 'op-17', payloadDigest: 'body', response: 'success' },
    ],
    appliedOperations: [{ operationId: 'effect-1', operationKey: 'op-17', idempotencyKey: 'op-17', payloadDigest: 'body' }],
    outputJobs: [{ queue: 'reminders', jobId: 'reminder-op-17', name: 'reminder', operationKey: 'op-17' }],
    jobAttempts: [
      { attempt: 1, jobId: 'job-17', operationKey: 'op-17', state: 'failed', attemptsMade: 1, attemptsStarted: 1 },
      { attempt: 2, jobId: 'job-17', operationKey: 'op-17', state: 'completed', attemptsMade: 2, attemptsStarted: 2 },
    ],
  };
}

test('distinguishes two HTTP attempts from one applied operation', async () => {
  const { evaluate } = await import('../src/policy.js');
  expect(evaluate(evidence(), [
    { id: 'attempts', kind: 'required_http', minimum: 2 },
    { id: 'effect', kind: 'applied_count', equals: 1 },
  ])).toEqual([
    { id: 'attempts', passed: true, observed: 2 },
    { id: 'effect', passed: true, observed: 1 },
  ]);
});

test('rejects zero applied effects and missing follow-up work', async () => {
  const { evaluate } = await import('../src/policy.js');
  const input = evidence(); input.appliedOperations = []; input.outputJobs = [];
  expect(evaluate(input, [
    { id: 'effect', kind: 'applied_count', equals: 1 },
    { id: 'output', kind: 'output_count', queue: 'reminders', equals: 1 },
  ])).toEqual([
    { id: 'effect', passed: false, observed: 0 },
    { id: 'output', passed: false, observed: 0 },
  ]);
});

test('a failed second attempt cannot borrow useful work from the first attempt', async () => {
  const { evaluate } = await import('../src/policy.js');
  const input = evidence(); input.jobAttempts[1]!.state = 'failed';
  expect(evaluate(input, [{ id: 'retry', kind: 'job_state', attempt: 2, equals: 'completed' }]))
    .toEqual([{ id: 'retry', passed: false, observed: 'failed' }]);
});

test('checks the selected projected row value, not merely row existence', async () => {
  const { evaluate } = await import('../src/policy.js');
  const input = evidence(); input.after[0]!.rows[0]!.status = 'created';
  expect(evaluate(input, [{ id: 'status', kind: 'row_value', table: 'public.invoices', key: { operation_key: 'op-17' }, column: 'status', equals: 'complete' }]))
    .toEqual([{ id: 'status', passed: false, observed: 'created' }]);
});

test('missing and truncated projections are incomplete rather than empty successful tables', async () => {
  const { evaluate } = await import('../src/policy.js');
  const input = evidence(); input.after[0]!.truncated = true;
  expect(() => evaluate(input, [{ id: 'rows', kind: 'row_count', table: 'public.invoices', equals: 1 }])).toThrow(/truncated/i);
  input.after = [];
  expect(() => evaluate(input, [{ id: 'rows', kind: 'row_count', table: 'public.invoices', equals: 0 }])).toThrow(/missing/i);
});

test('preserves evaluated violations when another rule lacks evidence', async () => {
  const { evaluate, CoverageError } = await import('../src/policy.js');
  const input = evidence(); input.appliedOperations.push({ ...input.appliedOperations[0]!, operationId: 'effect-2' });
  try {
    evaluate(input, [
      { id: 'duplicate', kind: 'applied_count', equals: 1 },
      { id: 'missing', kind: 'row_count', table: 'public.absent', equals: 0 },
    ]);
    throw new Error('Expected incomplete evidence');
  } catch (error) {
    expect(error).toBeInstanceOf(CoverageError);
    expect((error as InstanceType<typeof CoverageError>).results).toContainEqual({ id: 'duplicate', passed: false, observed: 2 });
  }
});

test.each([
  ['completed', 'complete_for_declared_surfaces', 'passed', 'completed', 0],
  ['completed', 'complete_for_declared_surfaces', 'failed', 'completed', 1],
  ['completed', 'partial', 'passed', 'completed', 3],
  ['completed', 'complete_for_declared_surfaces', 'passed', 'failed', 2],
  ['timed_out', 'complete_for_declared_surfaces', 'passed', 'completed', 3],
  ['completed', 'complete_for_declared_surfaces', 'not_evaluated', 'completed', 3],
] as const)('returns the actual dimensions as a non-vacuous exit status', async (execution, coverage, assertions, cleanup, expected) => {
  const { exitCode } = await import('../src/policy.js');
  const report: RunReport = { schemaVersion: 1, runId: 'run-1', evidenceKind: 'observed', execution, coverage, assertions, cleanup, evidence: evidence(), rules: [], missing: [] };
  expect(exitCode(report)).toBe(expected);
});

test('does not treat an empty rule list as a passing assertion set', async () => {
  const { decideAssertions } = await import('../src/policy.js');
  expect(decideAssertions([])).toBe('not_evaluated');
  expect(decideAssertions([{ id: 'violation', passed: false, observed: 2 }])).toBe('failed');
});
