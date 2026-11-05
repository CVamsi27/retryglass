import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, expect, test } from 'vitest';
import { prepareImages, waitForContainerCleanup, waitForNetworkCleanup } from '../src/docker/lifecycle.js';
import { loadScenario } from '../src/scenario.js';
import { runCrashPoint } from '../src/sweep/point.js';

beforeAll(async () => {
  execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json']);
  await prepareImages();
}, 600_000);

test('unsupported I/O used only during retry cannot become a passing point', async () => {
  const { scenario, fixtureRoot } = await loadScenario(resolve('examples/invoice/scenario-sweep.json'));
  scenario.worker.processor = 'dist/examples/invoice/retry-unsupported.js';
  const root = await mkdtemp(join(tmpdir(), 'retryglass-negative-'));
  const runId = `negative-${Date.now().toString(36)}`;
  try {
    const point = await runCrashPoint({ scenario, fixtureRoot, runDir: root, runId,
      point: { id: 'cp-01', index: 0, seam: 'db.query', label: 'pg query' } });
    expect(point.execution).toBe('completed');
    expect(point.crashVerified).toBe(true);
    expect(point.coverage).toBe('partial');
    expect(point.assertions).toBe('not_evaluated');
    expect(point.missing.join('\n')).toMatch(/retry.*undeclared I\/O.*child_process.spawn/);
    expect(point.cleanup).toBe('completed');
    await waitForContainerCleanup(runId);
    await waitForNetworkCleanup(runId);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 180_000);
