import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { EffectLedger } from '../src/http/ledger.js';
import { controlSimulator, startSimulator } from '../src/http/simulator.js';

const body = { operationKey: 'op-17', recipient: 'synthetic@example.invalid' };

describe('provider effect evidence', () => {
  test('a lost acknowledgement records an applied action before its same-key retry', () => {
    const ledger = new EffectLedger({ idempotent: true, loseFirstAcknowledgement: true });
    const first = ledger.accept(body, 'op-17');
    expect(first.loseResponse).toBe(true);
    expect(ledger.snapshot().appliedOperations).toHaveLength(1);
    const second = ledger.accept(body, 'op-17');
    expect(second.loseResponse).toBe(false);
    expect(second.operationId).toBe(first.operationId);
    expect(ledger.snapshot().httpAttempts).toHaveLength(2);
    expect(ledger.snapshot().appliedOperations).toHaveLength(1);
  });

  test('new provider keys duplicate a stable business operation', () => {
    const ledger = new EffectLedger({ idempotent: true, loseFirstAcknowledgement: true });
    ledger.accept(body, 'attempt-key-one');
    ledger.accept(body, 'attempt-key-two');
    expect(ledger.snapshot().appliedOperations.map(action => action.operationKey)).toEqual(['op-17', 'op-17']);
  });

  test('reusing a provider key with different payload is a conflict, not another effect', () => {
    const ledger = new EffectLedger({ idempotent: true, loseFirstAcknowledgement: false });
    ledger.accept(body, 'key');
    expect(ledger.accept({ ...body, recipient: 'another@example.invalid' }, 'key').status).toBe(409);
    expect(ledger.snapshot().httpAttempts[1]?.response).toBe('rejected');
    expect(ledger.snapshot().appliedOperations).toHaveLength(1);
  });

  test('a provider that ignores keys applies both requests', () => {
    const ledger = new EffectLedger({ idempotent: false, loseFirstAcknowledgement: false });
    ledger.accept(body, 'same-key');
    ledger.accept(body, 'same-key');
    expect(ledger.snapshot().appliedOperations).toHaveLength(2);
  });

  test('exceeding capture limits leaves a visible incomplete-evidence issue', () => {
    const ledger = new EffectLedger({ idempotent: true, loseFirstAcknowledgement: false, maxAttempts: 1 });
    ledger.accept(body, 'one');
    expect(ledger.accept(body, 'two').status).toBe(429);
    expect(ledger.snapshot().issues).toContain('HTTP attempt limit exceeded');
  });
});

describe('real HTTP capture endpoint and private control channel', () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

  test('records actual HTTP attempts, loses only the first accepted response, and seals intake', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'retryglass-http-'));
    const socketPath = join(directory, 'control.sock');
    const server = await startSimulator({
      host: '127.0.0.1', port: 0, socketPath,
      profile: { idempotent: true, loseFirstAcknowledgement: true },
    });
    cleanup.push(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
    const send = () => fetch(`${server.url}/effects/email`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'op-17' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(2000),
    });
    await expect(send()).rejects.toThrow();
    expect((await send()).status).toBe(200);
    const captured = await controlSimulator(socketPath, 'read');
    expect(captured.httpAttempts).toHaveLength(2);
    expect(captured.appliedOperations).toHaveLength(1);
    await controlSimulator(socketPath, 'seal');
    expect((await send()).status).toBe(503);
    await controlSimulator(socketPath, 'resume');
    expect((await send()).status).toBe(200);
  });

  test('the HTTP surface cannot read the journal or change its profile', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'retryglass-http-'));
    const server = await startSimulator({ host: '127.0.0.1', port: 0, socketPath: join(directory, 'control.sock'), profile: { idempotent: true, loseFirstAcknowledgement: false } });
    cleanup.push(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
    expect((await fetch(`${server.url}/read`)).status).toBe(404);
    expect((await fetch(`${server.url}/seal`, { method: 'POST' })).status).toBe(404);
    expect((await controlSimulator(join(directory, 'control.sock'), 'read')).issues).toContain('Unmatched HTTP request');
  });
});
