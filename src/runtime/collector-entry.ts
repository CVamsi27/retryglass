import { createConnection } from 'node:net';
import { Queue } from 'bullmq';
import { Client } from 'pg';
import type { OutputJob, Projection } from '../contracts.js';
import { snapshotProjection, type ProjectionSpec } from '../postgres/projection.js';
import { quiesceRole, resumeRole } from '../postgres/quiesce.js';

const MAX_INPUT = 65_536;
const MAX_OUTPUT = 1_048_576;
const COMMANDS = new Set(['snapshot', 'quiesce', 'resume-db', 'job-add', 'job-state', 'job-retry', 'outputs', 'probe']);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing collector configuration: ${name}`);
  return value;
}

function redisConnection() {
  return {
    host: required('REDIS_HOST'),
    port: Number(required('REDIS_PORT')),
    password: required('REDIS_PASSWORD'),
    maxRetriesPerRequest: null as null,
  };
}

async function readInput(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_INPUT) throw new Error('Collector input exceeds 64 KiB');
    chunks.push(bytes);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return null;
  return JSON.parse(text) as unknown;
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Expected an object for ${name}`);
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, name: string): string {
  const field = value[name];
  if (typeof field !== 'string' || !field.length || field.length > 512) throw new Error(`Invalid ${name}`);
  return field;
}

function queueFor(name: string, prefix: string): Queue {
  return new Queue(name, { prefix, connection: redisConnection() });
}

async function withQueue<T>(queue: Queue, action: () => Promise<T>): Promise<T> {
  try { return await action(); } finally { await queue.close(); }
}

async function snapshot(argument: Record<string, unknown>): Promise<Projection[]> {
  const tables = argument.tables;
  if (!Array.isArray(tables) || !tables.length || tables.length > 16) throw new Error('Expected bounded projection tables');
  const expectedRows = argument.expectedRows === undefined ? undefined : object(argument.expectedRows, 'expectedRows');
  const client = new Client({ connectionString: required('COLLECTOR_DATABASE_URL'), connectionTimeoutMillis: 5_000, statement_timeout: 10_000 });
  await client.connect();
  try {
    const projections: Projection[] = [];
    for (const entry of tables) {
      const spec = object(entry, 'table') as unknown as ProjectionSpec;
      projections.push(await snapshotProjection(client, spec));
    }
    for (const [table, expected] of Object.entries(expectedRows ?? {})) {
      const projection = projections.find(item => item.table === table);
      if (!projection) throw new Error(`Missing projection for expected row count: ${table}`);
      if (projection.truncated) throw new Error(`Truncated projection cannot verify expected rows: ${table}`);
      if (projection.rows.length !== expected) {
        throw new Error(`Expected ${String(expected)} seeded rows in ${table}, observed ${projection.rows.length}`);
      }
    }
    return projections;
  } finally {
    await client.end();
  }
}

async function withPostgres<T>(action: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: required('COLLECTOR_DATABASE_URL'), connectionTimeoutMillis: 5_000, statement_timeout: 10_000 });
  await client.connect();
  try { return await action(client); } finally { await client.end(); }
}

async function jobState(argument: Record<string, unknown>): Promise<Record<string, unknown>> {
  const prefix = stringField(argument, 'prefix');
  const jobId = stringField(argument, 'jobId');
  const queue = queueFor('input', prefix);
  return withQueue(queue, async () => {
    const job = await queue.getJob(jobId);
    if (!job) return { exists: false, jobId, state: 'unknown', attemptsMade: 0, attemptsStarted: 0, operationKey: '' };
    const data = typeof job.data === 'object' && job.data ? job.data as Record<string, unknown> : {};
    return {
      exists: true,
      jobId: String(job.id),
      state: await job.getState(),
      operationKey: typeof data.operationKey === 'string' ? data.operationKey : '',
      attemptsMade: job.attemptsMade,
      attemptsStarted: job.attemptsStarted ?? 0,
      failedReason: typeof job.failedReason === 'string' ? job.failedReason : null,
      data,
    };
  });
}

async function jobAdd(argument: Record<string, unknown>): Promise<Record<string, unknown>> {
  const prefix = stringField(argument, 'prefix');
  const job = object(argument.job, 'job');
  const name = stringField(job, 'name');
  const id = stringField(job, 'id');
  const queue = queueFor('input', prefix);
  return withQueue(queue, async () => {
    const existing = await queue.getJob(id);
    if (existing) throw new Error(`Job ${id} already exists in this run namespace`);
    const created = await queue.add(name, job.data, {
      jobId: id, attempts: 1, removeOnFail: false, removeOnComplete: false,
    });
    if (!created) throw new Error(`Queue did not persist job ${id}`);
    return { jobId: String(created.id), state: await created.getState() };
  });
}

async function jobRetry(argument: Record<string, unknown>): Promise<Record<string, unknown>> {
  const prefix = stringField(argument, 'prefix');
  const jobId = stringField(argument, 'jobId');
  const queue = queueFor('input', prefix);
  return withQueue(queue, async () => {
    const job = await queue.getJob(jobId);
    if (!job) throw new Error(`Cannot retry a missing job: ${jobId}`);
    const state = await job.getState();
    if (state !== 'failed') throw new Error(`Cannot retry job ${jobId} from state ${state}`);
    const before = { attemptsMade: job.attemptsMade, attemptsStarted: job.attemptsStarted ?? 0 };
    await job.retry('failed');
    const updated = await queue.getJob(jobId);
    return {
      jobId, previousState: state, state: await updated!.getState(),
      attemptsMade: updated!.attemptsMade, attemptsStarted: updated!.attemptsStarted ?? 0, before,
    };
  });
}

async function outputs(argument: Record<string, unknown>): Promise<OutputJob[]> {
  const prefix = stringField(argument, 'prefix');
  const queues = argument.queues;
  if (!Array.isArray(queues) || queues.length > 16) throw new Error('Expected bounded output queues');
  const collected: OutputJob[] = [];
  for (const name of queues) {
    if (typeof name !== 'string') throw new Error('Invalid output queue name');
    if (name === 'input') throw new Error('The input queue cannot be observed as an output queue');
    const queue = queueFor(name, prefix);
    try {
      const jobs = await queue.getJobs(['waiting', 'paused', 'prioritized', 'delayed', 'active', 'completed', 'failed'], 0, 999, true);
      for (const job of jobs) {
        const data = typeof job.data === 'object' && job.data ? job.data as Record<string, unknown> : {};
        const operationKey = data.operationKey;
        if (typeof operationKey !== 'string' || !operationKey) continue;
        collected.push({ queue: name, jobId: String(job.id), name: job.name, operationKey });
      }
    } finally {
      await queue.close();
    }
  }
  return collected.sort((left, right) =>
    left.queue.localeCompare(right.queue) || left.jobId.localeCompare(right.jobId));
}

async function probe(argument: Record<string, unknown>): Promise<Record<string, unknown>> {
  const host = stringField(argument, 'host');
  const port = Number(argument.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Invalid probe port');
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    const fail = (error: Error) => { socket.destroy(); reject(error); };
    socket.setTimeout(2_000, () => fail(new Error(`Probe timed out: ${host}:${port}`)));
    socket.once('error', fail);
    socket.once('connect', () => { socket.destroy(); resolve({ reachable: true, host, port }); });
  });
}

async function dispatch(command: string, argument: unknown): Promise<unknown> {
  switch (command) {
    case 'snapshot': return snapshot(object(argument, 'snapshot input'));
    case 'quiesce': {
      const role = stringField(object(argument, 'quiesce input'), 'role');
      return withPostgres(client => quiesceRole(client, role));
    }
    case 'resume-db': {
      const role = stringField(object(argument, 'resume input'), 'role');
      return withPostgres(async client => { await resumeRole(client, role); return { resumed: true, role }; });
    }
    case 'job-add': return jobAdd(object(argument, 'job-add input'));
    case 'job-state': return jobState(object(argument, 'job-state input'));
    case 'job-retry': return jobRetry(object(argument, 'job-retry input'));
    case 'outputs': return outputs(object(argument, 'outputs input'));
    case 'probe': return probe(object(argument, 'probe input'));
    default: throw new Error('Unsupported collector command');
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? '';
  if (!COMMANDS.has(command)) throw new Error('Unsupported collector command');
  const result = await dispatch(command, await readInput());
  const serialized = JSON.stringify(result);
  if (Buffer.byteLength(serialized) > MAX_OUTPUT) throw new Error('Collector output exceeded its limit');
  process.stdout.write(`${serialized}\n`);
}

main().catch(error => {
  process.stdout.write(`${JSON.stringify({ error: error instanceof Error ? error.message : 'Collector failed' })}\n`);
  process.exitCode = 1;
});
