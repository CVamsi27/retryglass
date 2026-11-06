import { afterEach, expect, test } from 'vitest';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const implementation = await import('../src/preflight.js').catch(() => null);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root() { const value = await mkdtemp(join(tmpdir(), 'retryglass-preflight-')); roots.push(value); return value; }
async function validate(path: string) {
  expect(typeof implementation?.validateScenarioFile, 'preflight implementation is required').toBe('function');
  return implementation!.validateScenarioFile(path);
}
async function doctor(options: { executable: string; scenarioPath?: string; timeoutMs?: number }) {
  expect(typeof implementation?.inspectPrerequisites, 'doctor implementation is required').toBe('function');
  return implementation!.inspectPrerequisites(options);
}
async function scenario(change?: (input: any) => void) {
  const directory = await root();
  const input = JSON.parse(await readFile('examples/invoice/scenario-sweep.json', 'utf8'));
  change?.(input);
  await writeFile(join(directory, 'scenario.json'), JSON.stringify(input));
  for (const file of ['schema.sql', 'seed.sql']) await writeFile(join(directory, file), await readFile(`examples/invoice/${file}`));
  return join(directory, 'scenario.json');
}
async function fakeEngine({ version = '"29.8.2"', missing = '', hang = false } = {}) {
  const directory = await root();
  const executable = join(directory, 'engine');
  const log = join(directory, 'calls.jsonl');
  await writeFile(executable, `#!${process.execPath}\nimport fs from 'node:fs';\nconst args=process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');\nif(${hang})setInterval(()=>{},1000);\nelse if(args[0]==='info')process.stdout.write(${JSON.stringify(version)});\nelse if(args[0]==='image'&&args[1]==='inspect'){if(args.at(-1)===${JSON.stringify(missing)})process.exitCode=1;else process.stdout.write(JSON.stringify('sha256:'+'a'.repeat(64)));}\nelse {fs.writeFileSync(${JSON.stringify(join(directory, 'MUTATION'))},'unexpected');process.exitCode=1;}\n`);
  await chmod(executable, 0o755);
  return { executable, log, directory };
}

test('validates declared files and references without importing the worker processor', async () => {
  const path = await scenario(input => { input.worker.processor = 'dist/unavailable-but-container-owned.js'; });
  const result = await validate(path);
  expect(result.valid).toBe(true);
  expect(result.scope).toBe('configuration_and_fixture_files_only');
  expect(result.diagnostics.filter((item: any) => item.severity === 'error')).toEqual([]);
});

test('rejects selectors and columns outside the declared projection', async () => {
  for (const change of [
    (input: any) => { input.rules.find((rule: any) => rule.kind === 'row_value').column = 'unprojected'; },
    (input: any) => { input.rules.find((rule: any) => rule.kind === 'row_value').key = { other_key: 'op-17' }; },
  ]) {
    const result = await validate(await scenario(change));
    expect(result.valid).toBe(false);
    expect(result.diagnostics.some((item: any) => item.severity === 'error')).toBe(true);
  }
});

test('rejects missing projected keys and undeclared expected-row tables', async () => {
  for (const change of [
    (input: any) => { input.tables[0].columns = ['total_cents']; },
    (input: any) => { input.fixture.expectedRows['public.unknown'] = 0; },
  ]) {
    const result = await validate(await scenario(change));
    expect(result.valid).toBe(false);
    expect(result.diagnostics.some((item: any) => item.severity === 'error')).toBe(true);
  }
});

test('returns bounded invalid-input diagnostics instead of throwing or echoing JSON payloads', async () => {
  const directory = await root();
  const path = join(directory, 'bad.json');
  await writeFile(path, '{"private-payload":"SYNTHETIC_SECRET_SENTINEL"');
  const result = await validate(path);
  expect(result.valid).toBe(false);
  expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SECRET_SENTINEL');
  expect(JSON.stringify(result).length).toBeLessThan(3000);
});

test('doctor rejects successful wrapper chatter as unavailable daemon evidence', async () => {
  const engine = await fakeEngine({ version: 'App is already running' });
  const result = await doctor({ executable: engine.executable });
  expect(result.ready).toBe(false);
  expect(result.engine.status).toBe('unavailable');
});

test('doctor reports absent images separately and executes only bounded read-only probes', async () => {
  const engine = await fakeEngine({ missing: 'retryglass-tool:0.1.0-alpha.2' });
  const result = await doctor({ executable: engine.executable, scenarioPath: resolve('examples/invoice/scenario-sweep.json') });
  expect(result.ready).toBe(false);
  expect(result.engine).toMatchObject({ status: 'available', version: '29.8.2' });
  expect(result.images).toContainEqual(expect.objectContaining({ image: 'retryglass-tool:0.1.0-alpha.2', status: 'missing' }));
  const calls = (await readFile(engine.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(calls.length).toBeGreaterThan(1);
  expect(calls.every(args => args[0] === 'info' || args[0] === 'image' && args[1] === 'inspect')).toBe(true);
});

test('doctor bounds a hung engine and never converts the timeout into readiness', async () => {
  const engine = await fakeEngine({ hang: true });
  const result = await doctor({ executable: engine.executable, timeoutMs: 50 });
  expect(result.ready).toBe(false);
  expect(result.engine.status).toBe('unavailable');
});

test('an explicit OrbStack endpoint overrides a conflicting context only in the client', async () => {
  const directory = await root();
  const executable = join(directory, 'client');
  await writeFile(executable, `#!${process.execPath}\nif(process.env.DOCKER_CONTEXT || process.env.DOCKER_HOST !== 'unix:///synthetic/orbstack.sock')process.exit(1);process.stdout.write(JSON.stringify('29.8.2'));\n`);
  await chmod(executable, 0o755);
  const host = process.env.RETRYGLASS_CONTAINER_HOST, context = process.env.DOCKER_CONTEXT;
  try {
    process.env.RETRYGLASS_CONTAINER_HOST = 'unix:///synthetic/orbstack.sock';
    process.env.DOCKER_CONTEXT = 'synthetic-conflict';
    expect((await doctor({ executable })).ready).toBe(true);
    expect(process.env.DOCKER_CONTEXT).toBe('synthetic-conflict');
  } finally {
    if (host === undefined) delete process.env.RETRYGLASS_CONTAINER_HOST; else process.env.RETRYGLASS_CONTAINER_HOST = host;
    if (context === undefined) delete process.env.DOCKER_CONTEXT; else process.env.DOCKER_CONTEXT = context;
  }
});
