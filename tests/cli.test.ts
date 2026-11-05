import { afterEach, expect, test } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runDemo } from '../src/cli.js';

const cli = await import('../src/cli.js');
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root() { const path = await mkdtemp(join(tmpdir(), 'retryglass-cli-')); roots.push(path); return path; }
async function invoke(args: string[]) {
  expect(typeof (cli as any).runCli, 'testable CLI implementation is required').toBe('function');
  const out: string[] = [], err: string[] = [];
  const code = await (cli as any).runCli(args, { out: (value: string) => out.push(value), err: (value: string) => err.push(value) });
  return { code, stdout: out.join(''), stderr: err.join('') };
}

test('runs the local synthetic effect demo and reports incomplete coverage honestly', async () => {
  const result = await runDemo();
  expect(result.execution).toBe('completed');
  expect(result.coverage).toBe('partial');
  expect(result.assertions).toBe('not_evaluated');
  expect(result.cleanup).toBe('completed');
  expect(result.evidence.httpAttempts).toHaveLength(2);
  expect(result.evidence.appliedOperations).toHaveLength(1);
  expect(result.missing).toContain('PostgreSQL projection was not included in this demo');
});

test('help and version work without container prerequisites', async () => {
  const help = await invoke(['--help']);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain('init');
  expect(help.stdout).toContain('validate');
  const version = await invoke(['--version']);
  expect(version.code).toBe(0);
  expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
});

test('init and validation form a runnable configuration-only first step', async () => {
  const target = join(await root(), 'starter');
  const initialized = await invoke(['init', '--target', target, '--json']);
  expect(initialized.code).toBe(0);
  expect(JSON.parse(initialized.stdout).target).toBe(target);
  const result = await invoke(['validate', '--scenario', join(target, 'scenario.json'), '--json']);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ valid: true, scope: 'configuration_and_fixture_files_only' });
});

test('invalid setup and duplicate or unknown options always exit 2', async () => {
  const scenario = resolve('examples/invoice/scenario-sweep.json');
  for (const args of [
    ['run'], ['init'], ['export', '--run', 'missing'],
    ['validate', '--scenario', scenario, '--unknown', '--json'],
    ['validate', '--scenario', scenario, '--scenario', scenario, '--json'],
    ['validate', '--scenario', scenario, '--json', '--json'],
    ['validate', '--scenario', '--json'],
    ['sweep', '--scenario', scenario, '--max-crash-points', '0', '--json'],
  ]) {
    const result = await invoke(args);
    expect(result.code, args.join(' ')).toBe(2);
    if (args.includes('--json')) expect(JSON.parse(result.stdout).error).toBeTypeOf('string');
  }
});

test('repeatable sweep selection options are accepted without executing a help request', async () => {
  const result = await invoke(['sweep', '--crash-point', 'cp-01', '--crash-point', 'cp-02', '--help']);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain('--scenario');
});

test('invalid validation JSON returns a bounded configuration failure', async () => {
  const path = join(await root(), 'scenario.json');
  await writeFile(path, '{"payload":"SYNTHETIC_PRIVATE_VALUE"');
  const result = await invoke(['validate', '--scenario', path, '--json']);
  expect(result.code).toBe(2);
  expect(JSON.parse(result.stdout).valid).toBe(false);
  expect(result.stdout).not.toContain('SYNTHETIC_PRIVATE_VALUE');
});

test('the CLI preserves the partial synthetic demo exit and does not claim a passing rehearsal', async () => {
  const result = await invoke(['demo', '--json']);
  expect(result.code).toBe(3);
  expect(JSON.parse(result.stdout)).toMatchObject({ evidenceKind: 'synthetic', coverage: 'partial', assertions: 'not_evaluated' });
});

test('future report input is refused without changing the source report', async () => {
  const path = join(await root(), 'report.json');
  const source = '{"schemaVersion":999,"runId":"synthetic-future"}';
  await writeFile(path, source);
  const result = await invoke(['inspect', '--report', path, '--json']);
  expect(result.code).toBe(2);
  expect(JSON.parse(result.stdout).error).toMatch(/newer/);
  expect(await readFile(path, 'utf8')).toBe(source);
});
