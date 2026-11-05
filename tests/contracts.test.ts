import { expect, test } from 'vitest';

const scenario = () => ({
  schemaVersion: 1, scenarioId: 'invoice-ack-loss', experiment: 'failed-retry',
  worker: { image: 'retryglass:alpha', processor: 'dist/examples/invoice/corrected.js', revision: 'fixture-v1' },
  fixture: { schema: 'schema.sql', seed: 'seed.sql', expectedRows: { 'public.invoices': 0 } },
  job: { name: 'invoice', id: 'job-17', operationKey: 'op-17', data: { operationKey: 'op-17' } },
  tables: [{ table: 'public.invoices', key: ['operation_key'], columns: ['operation_key', 'status'] }],
  outputQueues: ['reminders'], provider: { idempotent: true, loseFirstAcknowledgement: true },
  rules: [
    { id: 'failed', kind: 'job_state', attempt: 1, equals: 'failed' },
    { id: 'completed', kind: 'job_state', attempt: 2, equals: 'completed' },
    { id: 'one-effect', kind: 'applied_count', equals: 1 },
    { id: 'one-output', kind: 'output_count', queue: 'reminders', equals: 1 },
  ],
});

test('accepts a bounded data-only failed-job experiment', async () => {
  const { validateScenario } = await import('../src/contracts.js');
  expect(validateScenario(scenario()).job.id).toBe('job-17');
});

test.each([
  ['future schema', (s: any) => { s.schemaVersion = 2; }],
  ['unknown mode', (s: any) => { s.experiment = 'production-replay'; }],
  ['Docker flags', (s: any) => { s.docker = { privileged: true }; }],
  ['absolute processor path', (s: any) => { s.worker.processor = '/tmp/worker.js'; }],
  ['escaping fixture', (s: any) => { s.fixture.schema = '../production.sql'; }],
  ['reserved input queue', (s: any) => { s.outputQueues = ['input']; }],
  ['duplicate rule identities', (s: any) => { s.rules[1].id = s.rules[0].id; }],
  ['missing second terminal state', (s: any) => { s.rules.splice(1, 1); }],
  ['undeclared table rule', (s: any) => { s.rules.push({ id: 'outside', kind: 'row_count', table: 'private.people', equals: 0 }); }],
  ['undeclared queue rule', (s: any) => { s.rules.push({ id: 'outside', kind: 'output_max', queue: 'payments', maximum: 0 }); }],
  ['ambiguous row key', (s: any) => { s.rules.push({ id: 'row', kind: 'row_value', table: 'public.invoices', key: {}, column: 'status', equals: 'complete' }); }],
])('rejects %s before invoking runtime services', async (_name, mutate) => {
  const { validateScenario } = await import('../src/contracts.js');
  const value = scenario(); mutate(value);
  expect(() => validateScenario(value)).toThrow();
});

test('accepts the crash-sweep experiment mode Revision 2 defines', async () => {
  const { validateScenario } = await import('../src/contracts.js');
  const value = scenario(); value.experiment = 'crash-sweep';
  expect(validateScenario(value).experiment).toBe('crash-sweep');
});

test('rejects a scenario body above the byte ceiling', async () => {
  const { validateScenario } = await import('../src/contracts.js');
  const value = scenario(); value.job.data = { operationKey: 'x'.repeat(1_048_577) };
  expect(() => validateScenario(value)).toThrow(/size|large|byte/i);
});

test('requires a positive effect assertion rather than only upper bounds', async () => {
  const { validateScenario } = await import('../src/contracts.js');
  const value = scenario();
  value.rules.splice(2, 2);
  (value.rules as any[]).push({ id: 'at-most-one', kind: 'applied_max', maximum: 1 });
  expect(() => validateScenario(value)).toThrow(/presence|positive/i);
});

test('allows an upper bound alongside a separate positive effect rule without inventing an equals field', async () => {
  const { validateScenario } = await import('../src/contracts.js');
  const value = scenario();
  (value.rules as any[]).push({ id: 'at-most-one', kind: 'applied_max', maximum: 1 });
  expect(() => validateScenario(value)).not.toThrow();
});

test('rejects missing collector evidence instead of interpreting it as an empty observation', async () => {
  const { validateReport } = await import('../src/contracts.js');
  expect(() => validateReport({
    schemaVersion: 1, runId: 'run-missing-ledger', evidenceKind: 'observed',
    execution: 'completed', coverage: 'complete_for_declared_surfaces', assertions: 'passed', cleanup: 'completed',
    evidence: { before: [], partial: [], after: [], outputJobs: [], jobAttempts: [] },
    rules: [{ id: 'one-effect', passed: true, observed: 1 }], missing: [],
  })).toThrow();
});
