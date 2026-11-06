import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, open, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Cell, OutputJob, Scenario, StopResult } from '../contracts.js';
import { MAX_FIXTURE_BYTES } from '../contracts.js';
import { PACKAGE_ROOT } from '../package-root.js';
import { POSTGRES_IMAGE, REDIS_IMAGE, TOOL_IMAGE } from './images.js';
export { POSTGRES_IMAGE, REDIS_IMAGE, TOOL_IMAGE } from './images.js';

const OWNER_LABEL = 'com.retryglass.owner';
const RUN_LABEL = 'com.retryglass.run';
const COLLECTOR_COMMANDS = new Set(['snapshot', 'quiesce', 'job-add', 'job-state', 'job-retry', 'outputs', 'resume-db', 'probe']);
const MAX_OUTPUT = 16 * 1024 * 1024;
const MAX_DIAGNOSTIC = 65_536;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
interface DockerResult { stdout: string; stderr: string; code: number; }

/** The supervisor uses the OrbStack-compatible client; neither override enters workers. */
function docker(args: string[], input = '', timeoutMs = 15_000): Promise<DockerResult> {
  return new Promise((resolve, reject) => {
    const environment = { ...process.env };
    if (process.env.RETRYGLASS_CONTAINER_HOST) {
      environment.DOCKER_HOST = process.env.RETRYGLASS_CONTAINER_HOST;
      delete environment.DOCKER_CONTEXT;
    }
    const child = spawn(process.env.RETRYGLASS_CONTAINER_CLI ?? 'docker', args, {
      stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true,
      detached: process.platform !== 'win32', env: environment,
    });
    const out: Buffer[] = [], err: Buffer[] = [];
    let outBytes = 0, errBytes = 0;
    let failure: Error | undefined;
    const kill = () => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* The client may have already exited. */ }
    };
    const timer = setTimeout(() => { failure = new Error('Container command timed out'); kill(); }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > MAX_OUTPUT) { failure = new Error('Container output exceeded its limit'); kill(); }
      else out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      errBytes += chunk.length;
      if (errBytes > MAX_DIAGNOSTIC) { failure = new Error('Container diagnostic output exceeded its limit'); kill(); }
      else err.push(chunk);
    });
    child.once('error', () => { clearTimeout(timer); reject(new Error('Container client could not be started')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (failure) { reject(failure); return; }
      resolve({ code: code ?? -1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
function safeDiagnostic(value: string): string {
  return value.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[database URL redacted]')
    .replace(/(password[=\s]+)'?[^'\s]+/gi, '$1[redacted]').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 1000);
}
async function must(args: string[], input = '', timeoutMs = 15_000): Promise<string> {
  const result = await docker(args, input, timeoutMs);
  if (result.code !== 0) throw new Error(`Container ${args[0]} failed (${result.code}): ${safeDiagnostic(result.stderr)}`);
  return result.stdout.trim();
}
function safeName(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,191}$/.test(value)) throw new Error('Unsafe container resource name');
  return value;
}
function labelArgs(runId: string): string[] { return ['--label', `${OWNER_LABEL}=retryglass`, '--label', `${RUN_LABEL}=${runId}`]; }
function credential(): string { return randomBytes(24).toString('hex'); }
function contained(root: string, path: string): boolean { const within = relative(root, path); return within === '' || (within !== '..' && !within.startsWith(`..${sep}`) && !isAbsolute(within)); }
async function jsonObservation(args: string[], input = '', timeoutMs = 15_000): Promise<unknown> {
  const output = await must(args, input, timeoutMs);
  try { return JSON.parse(output) as unknown; } catch { throw new Error('Container returned invalid JSON observation'); }
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === 'string'; }
function count(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }

export async function imageIdentity(image: string): Promise<string> {
  const value = await must(['image', 'inspect', '--format', '{{.Id}}', image]);
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error('Image did not resolve to an immutable image ID');
  return value;
}

async function packageDirectory(name: string, from: string): Promise<string> {
  const require = createRequire(join(from, 'package.json'));
  let entry: string;
  try { entry = require.resolve(`${name}/package.json`); }
  catch { entry = require.resolve(name); }
  let at = dirname(await realpath(entry));
  for (;;) {
    try {
      const manifest = JSON.parse(await readFile(join(at, 'package.json'), 'utf8')) as { name?: unknown };
      if (manifest.name === name) return at;
    } catch { /* Continue through a package subpath. */ }
    const parent = dirname(at);
    if (at === parent) throw new Error(`Runtime dependency root could not be resolved: ${name}`);
    at = parent;
  }
}

/**
 * Copy only shipped build files and actual resolved runtime packages. pnpm's external store links
 * are dereferenced; controlled relative links inside this standalone context preserve versioned
 * dependency resolution without importing the user's workspace or development dependencies.
 */
export async function stageImageBuildContext(packageRoot = PACKAGE_ROOT): Promise<{ root: string; cleanup(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'retryglass-image-'));
  const cleanup = () => rm(root, { recursive: true, force: true });
  try {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
    await cp(join(packageRoot, 'package.json'), join(root, 'package.json'));
    await cp(join(packageRoot, 'dist'), join(root, 'dist'), { recursive: true, dereference: true });
    await cp(join(packageRoot, 'examples'), join(root, 'examples'), { recursive: true, dereference: true });
    await cp(join(packageRoot, 'templates', 'collector.Dockerfile'), join(root, 'collector.Dockerfile'));
    await mkdir(join(root, 'node_modules', '.runtime'), { recursive: true });
    const copied = new Map<string, string>();
    async function link(name: string, from: string, modules: string): Promise<void> {
      const actual = await packageDirectory(name, from);
      let destination = copied.get(actual);
      if (!destination) {
        destination = join(root, 'node_modules', '.runtime', createHash('sha256').update(actual).digest('hex').slice(0, 24));
        copied.set(actual, destination);
        await cp(actual, destination, {
          recursive: true, dereference: true,
          filter: path => !relative(actual, path).split(sep).some(part => part === 'node_modules' || part === '.git'),
        });
        const dependencyManifest = JSON.parse(await readFile(join(actual, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }> };
        await mkdir(join(destination, 'node_modules'), { recursive: true });
        const dependencies = { ...dependencyManifest.dependencies };
        for (const optional of Object.keys(dependencyManifest.optionalDependencies ?? {})) {
          // Optional native msgpackr extraction is deliberately disabled in the portable image.
          if (optional === 'msgpackr-extract' || optional.startsWith('@msgpackr-extract/')) continue;
          try { await packageDirectory(optional, actual); dependencies[optional] = '*'; } catch { /* Absent optional dependencies remain optional. */ }
        }
        for (const peer of Object.keys(dependencyManifest.peerDependencies ?? {})) {
          if (dependencyManifest.peerDependenciesMeta?.[peer]?.optional) continue;
          dependencies[peer] = '*';
        }
        for (const dependency of Object.keys(dependencies).sort()) await link(dependency, actual, join(destination, 'node_modules'));
      }
      const at = join(modules, name);
      await mkdir(dirname(at), { recursive: true });
      await symlink(relative(dirname(at), destination), at, 'dir');
    }
    for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) await link(dependency, packageRoot, join(root, 'node_modules'));
    return { root, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
export async function prepareImages(): Promise<void> {
  const staged = await stageImageBuildContext();
  try { await must(['build', '--tag', TOOL_IMAGE, '--file', join(staged.root, 'collector.Dockerfile'), staged.root], '', 600_000); }
  finally { await staged.cleanup(); }
}

interface Resource { kind: 'container' | 'network'; id: string; }
async function ownedResource(cell: Cell, resource: Resource): Promise<boolean> {
  const result = await docker(resource.kind === 'network' ? ['network', 'inspect', resource.id] : ['inspect', resource.id]);
  if (result.code !== 0) {
    if (/No such (?:object|container|network)/i.test(result.stderr)) return false;
    throw new Error(`Could not verify resource ownership: ${resource.id}`);
  }
  let raw: unknown;
  try { raw = JSON.parse(result.stdout) as unknown; } catch { throw new Error('Invalid resource ownership observation'); }
  const first = Array.isArray(raw) ? raw[0] : raw;
  const labels = object(first) ? (object(first.Config) ? first.Config.Labels : first.Labels ?? first) : undefined;
  if (!object(labels) || labels[OWNER_LABEL] !== 'retryglass' || labels[RUN_LABEL] !== cell.runId) throw new Error(`Resource ownership mismatch: ${resource.id}`);
  return true;
}
async function removeResource(cell: Cell, resource: Resource): Promise<void> {
  if (!await ownedResource(cell, resource)) return;
  await must(resource.kind === 'network' ? ['network', 'rm', resource.id] : ['rm', '--force', resource.id]);
}
export async function destroyCell(cell: Cell): Promise<void> {
  const resources: Resource[] = [...new Set([cell.workerContainerId, cell.collectorContainerId, cell.simulatorContainerId, cell.redisContainerId, cell.postgresContainerId].filter((id): id is string => Boolean(id)))].map(id => ({ kind: 'container', id }));
  if (cell.networkId) resources.push({ kind: 'network', id: cell.networkId });
  const errors: string[] = [];
  for (const resource of resources) {
    try { await removeResource(cell, resource); } catch (error) { errors.push(error instanceof Error ? error.message : 'Unknown cleanup failure'); }
  }
  if (errors.length) throw new Error(`Cell cleanup failed: ${errors.join('; ')}`);
  cell.workerContainerId = undefined;
}
async function fixtureSql(root: string, path: string): Promise<string> {
  const actualRoot = await realpath(root);
  if (!path || isAbsolute(path) || path.split(/[\\/]/).includes('..')) throw new Error('Fixture SQL path must stay inside its scenario directory');
  const actual = await realpath(resolve(actualRoot, path));
  if (!contained(actualRoot, actual)) throw new Error('Fixture SQL symlink escapes its scenario directory');
  const handle = await open(actual, 'r');
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_FIXTURE_BYTES) throw new Error('Fixture SQL exceeds its regular-file size limit');
    const buffer = Buffer.alloc(MAX_FIXTURE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_FIXTURE_BYTES) throw new Error('Fixture SQL exceeds its size limit');
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}
export async function waitForDatabaseReady(container: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    const result = await docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'retryglass'], '', 3_000);
    if (result.code === 0) return;
    await sleep(200);
  } while (Date.now() < deadline);
  throw new Error('Disposable PostgreSQL did not become ready');
}

export async function createCell(scenario: Scenario, fixtureRoot: string, runDir: string, runId: string, customNetworkName?: string | null, signal?: AbortSignal): Promise<Cell> {
  signal?.throwIfAborted();
  safeName(runId);
  const prefix = safeName(`retryglass-${runId}`);
  const applicationRole = `retryglass_app_${createHash('sha256').update(runId).digest('hex').slice(0, 16)}`;
  const cell: Cell = {
    runId, projectName: prefix, runDir,
    collectorContainerId: `${prefix}-collector`, postgresContainerId: `${prefix}-postgres`, redisContainerId: `${prefix}-redis`, simulatorContainerId: `${prefix}-simulator`,
    networkId: safeName(customNetworkName ?? `${prefix}-network`),
    applicationRole, applicationPassword: credential(), redisPassword: credential(), toolImage: TOOL_IMAGE,
  };
  const [schema, seed] = await Promise.all([fixtureSql(fixtureRoot, scenario.fixture.schema), fixtureSql(fixtureRoot, scenario.fixture.seed)]);
  const postgresPassword = credential(), collectorPassword = credential();
  const created: Resource[] = [];
  await mkdir(runDir, { recursive: true });
  const preserveResources = () => writeFile(join(runDir, 'resources.json'), `${JSON.stringify({ schemaVersion: 1, runId, resources: created }, null, 2)}\n`, 'utf8');
  const create = async (resource: Resource, args: string[]) => {
    created.push(resource); // A client can fail after the daemon created the resource.
    await preserveResources();
    signal?.throwIfAborted();
    await must(args, '', 30_000);
  };
  try {
    const tool = await imageIdentity(TOOL_IMAGE), postgres = await imageIdentity(POSTGRES_IMAGE), redis = await imageIdentity(REDIS_IMAGE);
    await create({ kind: 'network', id: cell.networkId }, ['network', 'create', '--internal', '--driver', 'bridge', '--opt', 'com.docker.network.bridge.gateway_mode_ipv4=isolated', ...labelArgs(runId), cell.networkId]);
    await create({ kind: 'container', id: cell.postgresContainerId }, [
      'run', '--detach', '--name', cell.postgresContainerId, ...labelArgs(runId), '--network', cell.networkId, '--network-alias', 'postgres',
      '--user', '999:999', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '512m', '--cpus', '1',
      '--tmpfs', '/var/lib/postgresql/data:rw,nosuid,nodev,uid=999,gid=999,mode=0700,size=256m', '--tmpfs', '/var/run/postgresql:rw,nosuid,nodev,uid=999,gid=999,mode=0775,size=16m', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m',
      '--env', 'PGDATA=/var/lib/postgresql/data/pgdata', '--env', 'POSTGRES_DB=retryglass', '--env', `POSTGRES_PASSWORD=${postgresPassword}`, postgres,
    ]);
    await waitForDatabaseReady(cell.postgresContainerId);
    signal?.throwIfAborted();
    const sql = async (body: string) => must(['exec', '-i', cell.postgresContainerId, 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'retryglass'], body, 30_000);
    await sql(`CREATE ROLE ${applicationRole} LOGIN PASSWORD '${cell.applicationPassword}';\nCREATE ROLE retryglass_collector LOGIN CREATEROLE PASSWORD '${collectorPassword}';\nGRANT ${applicationRole} TO retryglass_collector WITH ADMIN TRUE;\nGRANT ${applicationRole} TO retryglass_collector WITH INHERIT FALSE;\nGRANT ${applicationRole} TO retryglass_collector WITH SET FALSE;\nGRANT pg_signal_backend TO retryglass_collector;`);
    await sql(schema); await sql(seed);
    await sql(`GRANT USAGE ON SCHEMA public TO ${applicationRole},retryglass_collector;\nGRANT SELECT ON ALL TABLES IN SCHEMA public TO ${applicationRole},retryglass_collector;\nGRANT INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO ${applicationRole};\nGRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${applicationRole};`);
    await create({ kind: 'container', id: cell.redisContainerId }, [
      'run', '--detach', '--name', cell.redisContainerId, ...labelArgs(runId), '--network', cell.networkId, '--network-alias', 'redis',
      '--user', '999:999', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '128m', '--cpus', '0.5', '--tmpfs', '/data:rw,nosuid,nodev,uid=999,gid=999,size=16m',
      redis, 'redis-server', '--save', '', '--appendonly', 'no', '--requirepass', cell.redisPassword,
    ]);
    const restricted = ['--user', '10001:10001', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '256m', '--cpus', '0.5', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m'];
    await create({ kind: 'container', id: cell.simulatorContainerId }, [
      'run', '--detach', '--name', cell.simulatorContainerId, ...labelArgs(runId), '--network', cell.networkId, '--network-alias', 'simulator', ...restricted,
      '--env', `SIMULATOR_IDEMPOTENT=${scenario.provider.idempotent}`, '--env', `SIMULATOR_LOSE_FIRST_ACK=${scenario.provider.loseFirstAcknowledgement}`,
      tool, 'node', 'dist/src/http/simulator.js',
    ]);
    await create({ kind: 'container', id: cell.collectorContainerId }, [
      'run', '--detach', '--name', cell.collectorContainerId, ...labelArgs(runId), '--network', cell.networkId, ...restricted,
      '--env', `COLLECTOR_DATABASE_URL=postgresql://retryglass_collector:${collectorPassword}@postgres:5432/retryglass`,
      '--env', 'REDIS_HOST=redis', '--env', 'REDIS_PORT=6379', '--env', `REDIS_PASSWORD=${cell.redisPassword}`, tool,
      'node', '-e', 'setInterval(() => {}, 30000)',
    ]);
    const readyBy = Date.now() + 30_000;
    for (const [host, port] of [['redis', 6379], ['simulator', 4010]] as const) {
      for (;;) {
        signal?.throwIfAborted();
        try { await execCollector(cell, 'probe', { host, port }); break; }
        catch { if (Date.now() >= readyBy) throw new Error(`Disposable ${host} did not become ready`); await sleep(200); }
      }
    }
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, 'resources.json'), `${JSON.stringify({ schemaVersion: 1, runId, resources: created }, null, 2)}\n`, 'utf8');
    return cell;
  } catch (error) {
    const failures: string[] = [];
    for (const resource of created.reverse()) { try { await removeResource(cell, resource); } catch (cleanupError) { failures.push(cleanupError instanceof Error ? cleanupError.message : 'Unknown cleanup failure'); } }
    if (failures.length) throw new Error(`Cell setup failed and cleanup failed: ${failures.join('; ')}`);
    throw error;
  }
}

export async function startWorker(cell: Cell, scenario: Scenario, networkId?: string | null, options: { crashAfter?: number } = {}): Promise<string> {
  const selectedNetwork = networkId ?? cell.networkId;
  if (selectedNetwork !== cell.networkId) throw new Error('Worker network must be its own internal cell network');
  const crashAfter = options.crashAfter ?? 0;
  if (!Number.isInteger(crashAfter) || crashAfter < 0 || crashAfter > 64) throw new Error('Invalid crash boundary');
  if (cell.workerContainerId) throw new Error('A worker is already tracked in this cell');
  const name = safeName(`${cell.projectName}-worker`);
  const image = await imageIdentity(scenario.worker.image);
  // Preserve a scoped cleanup identity even if the client loses the start acknowledgement.
  cell.workerContainerId = name;
  const output = await must([
    'run', '--detach', '--name', name, ...labelArgs(cell.runId), '--init', '--network', selectedNetwork,
    '--user', '10001:10001', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '256m', '--cpus', '0.5', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m',
    '--env', `RUN_ID=${cell.runId}`, '--env', `PROCESSOR_PATH=${scenario.worker.processor}`,
    '--env', `DATABASE_URL=postgresql://${cell.applicationRole}:${cell.applicationPassword}@postgres:5432/retryglass`,
    '--env', 'REDIS_HOST=redis', '--env', 'REDIS_PORT=6379', '--env', `REDIS_PASSWORD=${cell.redisPassword}`, '--env', `QUEUE_PREFIX=retryglass-${cell.runId}`,
    '--env', 'PROVIDER_URL=http://simulator:4010', '--env', 'DECLARED_HOSTS=postgres,redis,simulator,localhost,127.0.0.1,::1', '--env', `CRASH_AFTER=${crashAfter}`,
    image, 'node', 'dist/src/runtime/worker-entry.js',
  ], '', 30_000);
  if (!/^[a-f0-9]{12,64}$/.test(output)) throw new Error('Container runtime returned no usable worker identity');
  cell.workerContainerId = output;
  return output;
}
function collectorObservation(command: string, raw: unknown, argument: unknown): boolean {
  const arg = object(argument) ? argument : {};
  if (command === 'snapshot') return Array.isArray(raw) && raw.length === (Array.isArray(arg.tables) ? arg.tables.length : 0) && raw.every(value => object(value) && text(value.table) && Array.isArray(value.key) && value.key.every(text) && Array.isArray(value.columns) && value.columns.every(text) && Array.isArray(value.rows) && value.rows.every(object) && typeof value.truncated === 'boolean');
  if (command === 'outputs') return Array.isArray(raw) && raw.every(value => object(value) && ['queue', 'jobId', 'name', 'operationKey'].every(key => text(value[key])));
  if (!object(raw)) return false;
  if (command === 'probe') return raw.reachable === true && raw.host === arg.host && raw.port === arg.port;
  if (command === 'quiesce') return typeof raw.terminatedActive === 'boolean' && count(raw.remaining);
  if (command === 'resume-db') return raw.resumed === true && raw.role === arg.role;
  if (command === 'job-state') return typeof raw.exists === 'boolean' && text(raw.jobId) && text(raw.state) && text(raw.operationKey) && count(raw.attemptsMade) && count(raw.attemptsStarted);
  if (command === 'job-add' || command === 'job-retry') return text(raw.jobId) && text(raw.state);
  return false;
}
export async function execCollector(cell: Cell, command: string, argument?: unknown): Promise<unknown> {
  if (!COLLECTOR_COMMANDS.has(command)) throw new Error('Unsupported collector command');
  const input = JSON.stringify(argument ?? null);
  if (Buffer.byteLength(input) > 65_536) throw new Error('Collector input exceeds 64 KiB');
  const value = await jsonObservation(['exec', '-i', cell.collectorContainerId, 'node', 'dist/src/runtime/collector-entry.js', command], `${input}\n`, 15_000);
  if (object(value) && Object.hasOwn(value, 'error')) throw new Error(`Collector failed: ${safeDiagnostic(String(value.error))}`);
  if (!collectorObservation(command, value, argument)) throw new Error(`Collector returned a missing or malformed ${command} observation`);
  return value;
}
export async function simulatorControl(cell: Cell, action: 'read' | 'seal' | 'resume'): Promise<{ httpAttempts: unknown[]; appliedOperations: unknown[]; issues: string[]; sealed: boolean }> {
  if (!['read', 'seal', 'resume'].includes(action)) throw new Error('Unsupported simulator action');
  const value = await jsonObservation(['exec', cell.simulatorContainerId, 'node', 'dist/src/http/simulator.js', 'control', action]);
  if (!object(value) || Object.hasOwn(value, 'error') || !Array.isArray(value.httpAttempts) || !Array.isArray(value.appliedOperations) || !Array.isArray(value.issues) || !value.issues.every(text) || typeof value.sealed !== 'boolean' || !count(value.active)) throw new Error('Simulator returned a missing or malformed ledger observation');
  if (action === 'seal' && (value.sealed !== true || value.active !== 0)) throw new Error('Simulator did not seal and drain its handlers');
  if (action === 'resume' && value.sealed !== false) throw new Error('Simulator did not resume intake');
  if (!value.httpAttempts.every(item => object(item) && ['attemptId', 'operationKey', 'payloadDigest'].every(key => text(item[key])) && (item.idempotencyKey === null || text(item.idempotencyKey)) && ['success', 'accepted_response_lost', 'rejected'].includes(String(item.response))) || !value.appliedOperations.every(item => object(item) && ['operationId', 'operationKey', 'payloadDigest'].every(key => text(item[key])) && (item.idempotencyKey === null || text(item.idempotencyKey)))) throw new Error('Simulator ledger records were malformed');
  return { httpAttempts: value.httpAttempts, appliedOperations: value.appliedOperations, issues: value.issues, sealed: value.sealed };
}
export async function collectOutputs(cell: Cell, queues: string[]): Promise<OutputJob[]> {
  return await execCollector(cell, 'outputs', { prefix: `retryglass-${cell.runId}`, queues }) as OutputJob[];
}
interface WorkerState { Running: boolean; ExitCode: number; OOMKilled: boolean; }
async function workerState(id: string): Promise<WorkerState> {
  const value = await jsonObservation(['inspect', '--format', '{{json .State}}', id]);
  if (!object(value) || typeof value.Running !== 'boolean' || !Number.isInteger(value.ExitCode) || typeof value.OOMKilled !== 'boolean') throw new Error('Worker state observation was missing or malformed');
  return value as unknown as WorkerState;
}
export async function stopWorker(cell: Cell, signal = 'SIGTERM'): Promise<StopResult> {
  const id = cell.workerContainerId;
  if (!id) return { code: -1, signal, oomKilled: false, forced: false };
  if (!await ownedResource(cell, { kind: 'container', id })) throw new Error('Tracked worker disappeared before its termination was observed');
  const before = await workerState(id);
  if (before.Running) await must(['stop', '--signal', signal, '--time', '5', id], '', 15_000);
  const after = await workerState(id);
  if (after.Running) throw new Error('Worker remained running after bounded stop');
  await removeResource(cell, { kind: 'container', id });
  cell.workerContainerId = undefined;
  return { code: after.ExitCode, signal: after.ExitCode === 137 ? 'SIGKILL' : signal, oomKilled: after.OOMKilled, forced: before.Running && after.ExitCode === 137, workerContainerId: id };
}
export async function isWorkerRunning(cell: Cell): Promise<boolean> {
  if (!cell.workerContainerId) throw new Error('No worker identity is available to observe');
  return (await workerState(cell.workerContainerId)).Running;
}
export async function readWorkerLogs(cell: Cell): Promise<string> {
  if (!cell.workerContainerId) throw new Error('No worker identity is available for log collection');
  return await must(['logs', '--tail', '200', cell.workerContainerId]);
}

async function ownedResources(runId: string, network: boolean): Promise<string[]> {
  safeName(runId);
  const args = network ? ['network', 'ls', '--filter', `label=${OWNER_LABEL}=retryglass`, '--filter', `label=${RUN_LABEL}=${runId}`, '--format', '{{.ID}}'] : ['ps', '-aq', '--filter', `label=${OWNER_LABEL}=retryglass`, '--filter', `label=${RUN_LABEL}=${runId}`];
  const output = await must(args);
  return output ? output.split('\n').filter(Boolean) : [];
}
async function waitForCleanup(runId: string, network: boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do { if (!(await ownedResources(runId, network)).length) return; await sleep(100); } while (Date.now() < deadline);
  throw new Error(`Owned ${network ? 'network' : 'container'} resources remained after cleanup: ${runId}`);
}
export function waitForContainerCleanup(runId: string): Promise<void> { return waitForCleanup(runId, false); }
export function waitForNetworkCleanup(runId: string): Promise<void> { return waitForCleanup(runId, true); }
