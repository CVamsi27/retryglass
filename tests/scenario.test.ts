import { afterEach, expect, test } from 'vitest';
import { mkdtemp, writeFile, mkdir, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const directories: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'retryglass-scenario-')); directories.push(root);
  const scenario = {
    schemaVersion: 1, scenarioId: 'invoice', experiment: 'failed-retry',
    worker: { image: 'retryglass:alpha', processor: 'dist/examples/invoice/corrected.js', revision: 'fixture-v1' },
    fixture: { schema: 'schema.sql', seed: 'seed.sql', expectedRows: { 'public.invoices': 0 } },
    job: { name: 'invoice', id: 'job-17', operationKey: 'op-17', data: { operationKey: 'op-17' } },
    tables: [{ table: 'public.invoices', key: ['operation_key'], columns: ['operation_key', 'status'] }],
    outputQueues: ['reminders'], provider: { idempotent: true, loseFirstAcknowledgement: true },
    rules: [
      { id: 'failed', kind: 'job_state', attempt: 1, equals: 'failed' },
      { id: 'completed', kind: 'job_state', attempt: 2, equals: 'completed' },
      { id: 'one-effect', kind: 'applied_count', equals: 1 },
    ],
  };
  await writeFile(join(root, 'scenario.json'), JSON.stringify(scenario));
  await writeFile(join(root, 'schema.sql'), 'CREATE TABLE invoices(id text);\n');
  await writeFile(join(root, 'seed.sql'), '-- synthetic seed\n');
  return { root, scenario };
}
afterEach(async () => { await Promise.all(directories.splice(0).map(p => rm(p, { recursive: true, force: true }))); });

test('loads data-only JSON and records the bytes actually selected for schema and seed', async () => {
  const { loadScenario } = await import('../src/scenario.js');
  const { root } = await fixture();
  const loaded = await loadScenario(join(root, 'scenario.json'));
  expect(loaded.fixtureRoot).toBe(await realpath(root));
  expect(loaded.fixtureDigests.schema).toBe(createHash('sha256').update('CREATE TABLE invoices(id text);\n').digest('hex'));
  expect(loaded.fixtureDigests.seed).toBe(createHash('sha256').update('-- synthetic seed\n').digest('hex'));
});

test('refuses a fixture symlink escaping the selected directory', async () => {
  const { loadScenario } = await import('../src/scenario.js');
  const { root, scenario } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), 'retryglass-outside-')); directories.push(outside);
  await writeFile(join(outside, 'secret.sql'), 'SELECT 1;');
  await symlink(join(outside, 'secret.sql'), join(root, 'escaped.sql'));
  scenario.fixture.schema = 'escaped.sql';
  await writeFile(join(root, 'scenario.json'), JSON.stringify(scenario));
  await expect(loadScenario(join(root, 'scenario.json'))).rejects.toThrow(/escape|outside/i);
});

test('refuses a directory masquerading as a seed file', async () => {
  const { loadScenario } = await import('../src/scenario.js');
  const { root, scenario } = await fixture();
  await mkdir(join(root, 'not-a-file'));
  scenario.fixture.seed = 'not-a-file';
  await writeFile(join(root, 'scenario.json'), JSON.stringify(scenario));
  await expect(loadScenario(join(root, 'scenario.json'))).rejects.toThrow(/regular file|file/i);
});

test('never imports a JavaScript configuration file', async () => {
  const { loadScenario } = await import('../src/scenario.js');
  const { root } = await fixture();
  await writeFile(join(root, 'scenario.js'), 'throw new Error("EXECUTED_CONFIG");');
  await expect(loadScenario(join(root, 'scenario.js'))).rejects.toThrow(/JSON/i);
});
