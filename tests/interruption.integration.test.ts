import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeAll, expect, test } from 'vitest';
import { waitForContainerCleanup, waitForNetworkCleanup } from '../src/docker/lifecycle.js';

const exec = promisify(execFile);
const roots: string[] = [];
const engine = process.env.RETRYGLASS_CONTAINER_CLI ?? 'docker';

beforeAll(async () => {
  await exec(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json']);
}, 30_000);
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function interrupt(command: string, scenario: string, workerSuffix: string, signal: 'SIGINT' | 'SIGTERM', expected: number) {
  const root = await mkdtemp(join(tmpdir(), 'retryglass-interruption-'));
  roots.push(root);
  const wrapper = join(root, 'client.mjs');
  const marker = join(root, 'interrupted');
  const allocations = join(root, 'late-allocations');
  await writeFile(wrapper, `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'network' && args[1] === 'create' && existsSync(${JSON.stringify(marker)})) {
  appendFileSync(${JSON.stringify(allocations)}, 'network created after signal\\n');
}
const result = spawnSync(${JSON.stringify(engine)}, args, { stdio: 'inherit' });
const name = args[args.indexOf('--name') + 1];
if (result.status === 0 && args[0] === 'run' && args.includes('--name') && name.endsWith(${JSON.stringify(workerSuffix)}) && !existsSync(${JSON.stringify(marker)})) {
  writeFileSync(${JSON.stringify(marker)}, name);
  process.kill(process.ppid, ${JSON.stringify(signal)});
}
process.exitCode = result.status ?? 2;
`, { mode: 0o700 });
  const result = await exec(process.execPath, [
    resolve('dist/src/cli.js'), command, '--scenario', resolve('examples/invoice', scenario), '--output-root', root, '--json',
  ], { env: { ...process.env, RETRYGLASS_CONTAINER_CLI: wrapper }, timeout: 150_000, maxBuffer: 2 * 1024 * 1024 })
    .then(value => ({ ...value, code: 0 }))
    .catch((error: { code: unknown; stdout: string; stderr: string }) => error);
  expect(result.code, result.stderr).toBe(expected);
  const report = JSON.parse(result.stdout);
  expect(report).toMatchObject({ execution: 'interrupted', coverage: 'partial', cleanup: 'completed' });
  expect(await readFile(marker, 'utf8')).toMatch(/-worker$/);
  await expect(readFile(allocations, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  const runIds = command === 'run' ? [report.runId] : [
    ...[1, 2, 3].map(index => `${report.runId}-d${index}`),
    ...report.sweep.crashPoints.map((point: { id: string }) => `${report.runId}-${point.id}`),
  ];
  for (const runId of runIds) {
    await waitForContainerCleanup(runId);
    await waitForNetworkCleanup(runId);
  }
  const stored = await readFile(join(root, 'runs', report.runId, 'report.json'), 'utf8');
  expect(JSON.parse(stored)).toEqual(report);
  return report;
}

test('SIGTERM interrupts a real discovery worker and cleans the cell', async () => {
  const report = await interrupt('sweep', 'scenario-sweep.json', '-d1-worker', 'SIGTERM', 3);
  expect(report.sweep.crashPoints).toEqual([]);
}, 180_000);

test('SIGINT interrupts a real rehearsal and retains the before snapshot', async () => {
  const report = await interrupt('run', 'scenario.json', '-worker', 'SIGINT', 3);
  expect(report.evidence.before.length).toBeGreaterThan(0);
  expect(report.assertions).toBe('not_evaluated');
}, 180_000);

test('SIGTERM in a later point preserves the previously observed provider duplication', async () => {
  const report = await interrupt('sweep', 'scenario-sweep-buggy.json', '-cp-04-worker', 'SIGTERM', 1);
  expect(report.sweep.firstViolationId).toBe('one-provider-action');
  expect(report.sweep.crashPoints.find((point: { id: string }) => point.id === 'cp-03').violations).toContain('one-provider-action');
}, 180_000);
