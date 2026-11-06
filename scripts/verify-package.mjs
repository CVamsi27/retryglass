import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { manager: { type: 'string', default: 'all' }, containers: { type: 'boolean', default: false } } });
if (!['npm', 'pnpm', 'all'].includes(values.manager)) throw new Error('--manager must be npm, pnpm or all');
const managers = values.manager === 'all' ? ['npm', 'pnpm'] : [values.manager];
const temporary = await mkdtemp(join(tmpdir(), 'retryglass-package-'));
const evidence = join(root, '.retryglass', 'verification');
await mkdir(evidence, { recursive: true });
const results = [];
async function command(binary, args, cwd, expected = 0, timeout = 900_000) {
  const started = performance.now();
  let result;
  try { result = { code: 0, ...await exec(binary, args, { cwd, timeout, maxBuffer: 4 * 1024 * 1024, env: process.env }) }; }
  catch (error) {
    if (typeof error.code !== 'number') throw error;
    result = { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
  if (result.code !== expected) throw new Error(`${binary} ${args[0]} exited ${result.code}, expected ${expected}: ${(result.stderr || result.stdout).slice(-1500)}`);
  return { ...result, durationMs: Math.round(performance.now() - started) };
}
try {
  const packed = JSON.parse((await command('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], root)).stdout)[0];
  const files = packed.files.map(file => file.path);
  for (const file of ['LICENSE', 'dist/src/cli.js', 'dist/src/index.js', 'dist/src/index.d.ts', 'templates/sweep-regression.test.ts', 'templates/collector.Dockerfile', 'templates/starter/scenario.json']) {
    if (!files.includes(file)) throw new Error(`Tarball is missing ${file}`);
  }
  if (files.some(file => /(^|\/)(node_modules|\.env|\.retryglass|tests|\.git)(\/|$)/.test(file))) throw new Error('Tarball contains local or development files');
  const tarball = join(temporary, packed.filename);
  for (const manager of managers) {
    const consumer = join(temporary, manager);
    await mkdir(consumer);
    await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: `retryglass-${manager}-consumer`, private: true, type: 'module' }));
    const install = await command(manager, ['install', '--ignore-scripts', tarball, ...(values.containers ? ['vitest@5.0.5'] : [])], consumer);
    const binary = join(consumer, 'node_modules', '.bin', 'retryglass');
    const help = await command(binary, ['--help'], consumer);
    if (!help.stdout.includes('retryglass init')) throw new Error('Installed CLI produced no command help');
    const version = (await command(binary, ['--version'], consumer)).stdout.trim();
    if (version !== '0.1.0-alpha.2') throw new Error('Installed CLI version mismatch');
    await command(binary, ['init', '--target', 'starter', '--json'], consumer);
    const validation = JSON.parse((await command(binary, ['validate', '--scenario', 'starter/scenario.json', '--json'], consumer)).stdout);
    if (!validation.valid) throw new Error('Installed starter validation failed');
    await writeFile(join(consumer, 'api.mjs'), "import {runSweep, assertCrashPointPassed, initializeStarter, validateScenarioFile, inspectPrerequisites} from 'retryglass'; if (![runSweep, assertCrashPointPassed, initializeStarter, validateScenarioFile, inspectPrerequisites].every(v=>typeof v==='function')) throw Error('Missing public API');\n");
    await command(process.execPath, ['api.mjs'], consumer);
    const result = { manager, version, installMs: install.durationMs, helpMs: help.durationMs, standalone: true };
    if (values.containers) {
      await command(binary, ['doctor', '--scenario', 'starter/scenario.json', '--json'], consumer);
      const output = join(consumer, 'runs');
      const sweep = await command(binary, ['sweep', '--scenario', 'starter/scenario-buggy.json', '--crash-point', 'cp-03', '--output-root', output, '--json'], consumer, 1);
      const report = JSON.parse(sweep.stdout);
      const point = report.sweep.crashPoints[0];
      if (!point?.crashVerified || point.assertions !== 'failed' || !point.violations.includes('one-provider-action') || report.cleanup !== 'completed') throw new Error('Installed sweep did not find the synthetic duplicate');
      await writeFile(join(evidence, `pack-${manager}-buggy.json`), sweep.stdout);
      await command(binary, ['export', '--run', report.runId, '--crash-point', point.id, '--target', 'regression', '--output-root', output, '--json'], consumer);
      const vitest = join(consumer, 'node_modules', '.bin', 'vitest');
      await command(vitest, ['run', 'regression/retry.test.ts'], consumer, 1);
      const path = join(consumer, 'regression', 'scenario.json');
      const scenario = JSON.parse(await readFile(path, 'utf8'));
      scenario.worker.processor = 'dist/examples/invoice/corrected.js';
      await writeFile(path, JSON.stringify(scenario));
      const fixed = await command(vitest, ['run', 'regression/retry.test.ts'], consumer);
      result.containers = { selectedPoint: point.id, verified: true, duplicateFound: true, buggyRegressionExit: 1, correctedRegressionExit: 0, sweepMs: sweep.durationMs, correctedRegressionMs: fixed.durationMs };
    }
    results.push(result);
  }
  const summary = { status: 'passed', node: process.version, containers: values.containers, tarball: { files: files.length, bytes: packed.size, unpackedBytes: packed.unpackedSize }, results };
  await writeFile(join(evidence, 'packaging.json'), JSON.stringify(summary, null, 2) + '\n');
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({ status: 'failed', completed: results, reason: error.message }) + '\n');
  process.exitCode = 1;
} finally { await rm(temporary, { recursive: true, force: true }); }
