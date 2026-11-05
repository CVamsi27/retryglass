import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { Worker, type Job } from 'bullmq';

import {
  patchPg, patchBullMq, patchFetch, createCrashGate, createIoObserver, patchDns, patchChildProcess,
} from '../runtime/instrument.js';
import { killWorkerForCrash } from './terminate.js';

const PROCESSOR_ROOT = '/app';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing worker configuration: ${name}`);
  return value;
}

function processorUrl(path: string): string {
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_./-]*\.js$/.test(path) || path.split('/').includes('..')) {
    throw new Error('Unsafe processor path');
  }
  return pathToFileURL(join(PROCESSOR_ROOT, path)).href;
}

async function loadProcessor(path: string): Promise<(job: Job) => Promise<unknown>> {
  const module = await import(processorUrl(path)) as { default?: unknown };
  if (typeof module.default !== 'function') throw new Error('Processor module must export a default function');
  return module.default as (job: Job) => Promise<unknown>;
}

async function main(): Promise<void> {
  const crashAfter = Number(process.env.CRASH_AFTER ?? '0');
  const gate = createCrashGate(Number.isFinite(crashAfter) ? crashAfter : 0);

  const writeLine = (line: string): void => {
    try { writeSync(1, `${line}\n`); } catch { /* verification reports a missing descriptor/marker */ }
  };

  // One descriptor per settled seam; on the k-th seam emit the marker and SIGKILL before the
  // processor can start its next operation. stdout is captured by `docker logs` as evidence.
  const onSettled = (seam: string): void => {
    const event = gate.record(seam);
    writeLine(event.descriptor);
    if (event.crash) {
      const marker = gate.marker();
      if (marker) writeLine(marker);
      killWorkerForCrash();
    }
  };

  // Install seam wrappers before any job can run.
  patchPg(onSettled);
  patchBullMq(onSettled);
  patchFetch(onSettled);

  // A DNS lookup for a host outside the cell, or a subprocess spawn, proves a boundary the sweep
  // cannot crash at. It degrades coverage instead of disappearing. Raw IP dialling is undetected.
  const observer = createIoObserver(
    (process.env.DECLARED_HOSTS ?? 'postgres,redis,simulator,localhost,127.0.0.1,::1').split(','),
  );
  const onIo = (observation: { kind: string; target: string; declared: boolean }): void =>
    writeLine(JSON.stringify({
      kind: 'io-observation', io: observation.kind, target: observation.target, declared: observation.declared,
    }));
  patchDns(onIo, observer);
  patchChildProcess(onIo, observer);
  syncBuiltinESMExports();

  const processorPath = required('PROCESSOR_PATH');
  const processor = await loadProcessor(processorPath);
  const worker = new Worker('input', async job => processor(job), {
    prefix: required('QUEUE_PREFIX'),
    connection: {
      host: required('REDIS_HOST'),
      port: Number(required('REDIS_PORT')),
      password: required('REDIS_PASSWORD'),
      maxRetriesPerRequest: null,
    },
    concurrency: 1,
    // M0 recovery contract: a dead worker's lock expires fast, the first stall is terminal,
    // and the pickup path fails the job with its deferred reason instead of re-running it.
    lockDuration: 2_000,
    stalledInterval: 1_000,
    maxStalledCount: 0,
  });

  let finished = false;
  async function finish(result: Record<string, unknown>): Promise<void> {
    if (finished) return;
    finished = true;
    process.stdout.write(`${JSON.stringify(result)}\n`);
    const hardStop = setTimeout(() => process.exit(0), 5_000);
    hardStop.unref();
    try { await worker.close(); } catch { /* termination is bounded by the supervisor */ }
    process.exit(0);
  }

  worker.on('completed', (job: Job) => void finish({
    state: 'completed', jobId: job.id ?? null, attemptsMade: job.attemptsMade,
  }));
  worker.on('failed', (job: Job | undefined, error: Error) => void finish({
    state: 'failed', jobId: job?.id ?? null, attemptsMade: job?.attemptsMade ?? null,
    reason: String(error instanceof Error ? error.message : error).slice(0, 512),
  }));
  worker.on('error', (error: Error) => {
    process.stderr.write(`Worker error: ${error.message}\n`);
  });

  const shutdown = () => { void finish({ state: 'interrupted' }); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Worker failed'}\n`);
  process.exit(1);
});
