import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  createCell, destroyCell, execCollector, prepareImages, simulatorControl, startWorker,
  waitForContainerCleanup, waitForNetworkCleanup,
} from '../src/docker/lifecycle.js';
import { recoverStalledJob, verifyCrash } from '../src/sweep/crash.js';
import { loadScenario } from '../src/scenario.js';

const roots: string[] = [];
const REPEAT = Number(process.env.RETRYGLASS_CRASH_REPEAT ?? '3');
if (!Number.isInteger(REPEAT) || REPEAT < 1 || REPEAT > 100) throw new Error('RETRYGLASS_CRASH_REPEAT must be an integer from 1 to 100');
const CRASH_AFTER = 3;

function build(): void {
  execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'], {
    stdio: 'inherit',
  });
}

async function outputRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'retryglass-crash-'));
  roots.push(root);
  return root;
}

beforeAll(async()=>{build();await prepareImages();},600_000);

afterAll(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});

test(`crash after seam ${CRASH_AFTER} is verified, recovers to stalled failure, and retries the same job`, async () => {
  const { scenario, fixtureRoot } = await loadScenario(resolve('examples/invoice/scenario.json'));
  const measurements: Array<Record<string, unknown>> = [];

  for (let iteration = 1; iteration <= REPEAT; iteration++) {
    const root = await outputRoot();
    const runId = `crash-${Date.now().toString(36)}-${iteration}`;
    const networkName = `invoice-network-${runId.substring(runId.length - 5)}`; // Append runId suffix to network name
    const cell = await createCell(scenario, fixtureRoot, root, runId, networkName);
    try {
      const prefix = `retryglass-${runId}`;
      await execCollector(cell, 'job-add', { prefix, job: scenario.job });
      await startWorker(cell, scenario, cell.networkId, { crashAfter: CRASH_AFTER });

      // 1. Crash verification: exit 137, marker for exactly this point, same persisted job.
      const recoveryStarted = Date.now();
      const crash = await verifyCrash(cell, scenario, CRASH_AFTER);
      expect(crash.reasons).toEqual([]);
      expect(crash.crashVerified).toBe(true);
      expect(crash.exitCode).toBe(137);
      expect(crash.marker).toEqual({ crashAfter: CRASH_AFTER, completed: CRASH_AFTER });
      expect(crash.job).toMatchObject({
        exists: true, jobId: 'job-17', operationKey: 'op-17',
        state: 'active', attemptsStarted: 1,
      });

      // 2. Documented stall recovery: the job becomes failed without the processor re-running.
      const recovery = await recoverStalledJob(cell, scenario);
      expect(recovery.recovery).toBe('stalled');
      expect(recovery.failedReason).toMatch(/stalled/);
      expect(recovery.recoveryWaitMs).toBeLessThan(15_000);

      // 3. The same persisted job and business key are retryable.
      const retried = await execCollector(cell, 'job-retry', { prefix, jobId: 'job-17' }) as { state: string };
      expect(['waiting', 'prioritized', 'delayed']).toContain(retried.state);

      await startWorker(cell, scenario, cell.networkId, { crashAfter: 0 });
      const deadline = Date.now() + 60_000;
      let finalState = '';
      let attemptsMade = 0;
      let attemptsStarted = 0;
      for (;;) {
        const state = await execCollector(cell, 'job-state', { prefix, jobId: 'job-17' }) as {
          state: string; attemptsMade: number; attemptsStarted: number; operationKey: string;
        };
        finalState = state.state;
        attemptsMade = state.attemptsMade;
        attemptsStarted = state.attemptsStarted;
        expect(state.operationKey).toBe('op-17');
        if (state.state === 'completed' || state.state === 'failed' || Date.now() >= deadline) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      expect(finalState).toBe('completed');
      const crashToRetryMs = Date.now() - recoveryStarted;
      expect(crashToRetryMs).toBeLessThan(15_000);

      // 4. Golden invariants still hold at this crash point: one applied effect, two HTTP attempts.
      const ledger = await simulatorControl(cell, 'read');
      expect(ledger.appliedOperations).toHaveLength(1);
      expect(ledger.httpAttempts).toHaveLength(2);

      measurements.push({
        iteration,
        recoveryWaitMs: recovery.recoveryWaitMs,
        crashToRetryMs,
        attemptsMade,
        attemptsStarted,
        crashExit: crash.exitCode,
      });

    } finally {
      await destroyCell(cell);
      // Wait for container and network cleanup after test iteration completes
      await waitForContainerCleanup(runId);
      await waitForNetworkCleanup(runId);
    }
    await mkdir('.retryglass/verification', { recursive: true });
    await writeFile('.retryglass/verification/crash-recovery.json', `${JSON.stringify({
      node: process.version, platform: process.platform, architecture: process.arch,
      requested: REPEAT, measurements,
    }, null, 2)}\n`);
  }

  console.log('M0 measurements:', JSON.stringify(measurements));
}, 1_500_000);
