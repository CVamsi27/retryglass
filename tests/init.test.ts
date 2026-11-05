import { afterEach, expect, test } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadScenario } from '../src/scenario.js';

const implementation = await import('../src/init.js').catch(() => null);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root() { const value = await mkdtemp(join(tmpdir(), 'retryglass-init-')); roots.push(value); return value; }
async function initialize(target: string) {
  expect(typeof implementation?.initializeStarter, 'starter implementation is required').toBe('function');
  return implementation!.initializeStarter(target);
}

test('writes a self-contained synthetic corrected/buggy starter that validates without loading a processor', async () => {
  const target = join(await root(), 'rehearsal');
  const result = await initialize(target);
  expect(result.target).toBe(target);
  expect(await readdir(target)).toEqual(expect.arrayContaining(['scenario.json', 'scenario-buggy.json', 'schema.sql', 'seed.sql', 'retry.test.ts', 'README.md', 'Dockerfile.worker', 'processor']));
  const corrected = await loadScenario(join(target, 'scenario.json'));
  const buggy = await loadScenario(join(target, 'scenario-buggy.json'));
  expect(corrected.scenario.experiment).toBe('crash-sweep');
  expect(corrected.scenario.worker.image).toBe('retryglass-tool:0.1.0-alpha.1');
  expect(corrected.scenario.worker.processor).toBe('dist/examples/invoice/corrected.js');
  expect(buggy.scenario.worker.processor).toBe('dist/examples/invoice/buggy.js');
  expect(corrected.scenario.job.operationKey).toBe('op-17');
  expect(corrected.contents.schema).toContain('CREATE TABLE operations');
  expect(corrected.fixtureDigests).toEqual(buggy.fixtureDigests);
});

test('refuses an existing target without changing any of its files', async () => {
  const target = await root();
  await writeFile(join(target, 'kept.txt'), 'original');
  await expect(initialize(target)).rejects.toThrow(/already exists/);
  expect(await readFile(join(target, 'kept.txt'), 'utf8')).toBe('original');
  expect(await readdir(target)).toEqual(['kept.txt']);
});

test('rejects a traversal target before creating files', async () => {
  const target = await root();
  await expect(initialize(join(target, 'safe') + '/../escaped')).rejects.toThrow(/traversal/);
  expect(await readdir(target)).toEqual([]);
});
