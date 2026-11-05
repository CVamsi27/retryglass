import { describe, expect, it } from 'vitest';
import {
  createCrashGate, createIoObserver, patchBullMq, patchChildProcess, patchDns, patchFetch, patchPg,
  MAX_IO_OBSERVATIONS, type IoObservation,
} from '../src/runtime/instrument.js';

describe('createCrashGate', () => {
  it('assigns a global monotonic index and fixed labels in completion order', () => {
    const gate = createCrashGate(0);
    const first = gate.record('db.query');
    const second = gate.record('http.request');
    expect(first.index).toBe(0);
    expect(second.index).toBe(1);
    expect(JSON.parse(first.descriptor)).toEqual({ index: 0, seam: 'db.query', label: 'pg query' });
    expect(JSON.parse(second.descriptor).label).toBe('http fetch');
    expect(gate.completed).toBe(2);
  });

  it('crashes exactly on the k-th completed seam and never with CRASH_AFTER=0', () => {
    expect(createCrashGate(0).record('db.query').crash).toBe(false);
    expect(createCrashGate(-3).record('db.query').crash).toBe(false);
    expect(createCrashGate(Number.NaN).record('db.query').crash).toBe(false);
    const gate = createCrashGate(2);
    expect(gate.record('db.query').crash).toBe(false);
    expect(gate.record('db.query').crash).toBe(true);
  });

  it('emits one crash marker that reflects the crash point', () => {
    const gate = createCrashGate(3);
    while (!gate.record('queue.add').crash) { /* until the third seam */ }
    const marker = gate.marker();
    expect(marker).not.toBeNull();
    expect(JSON.parse(marker!)).toEqual({ kind: 'crash-marker', crashAfter: 3, completed: 3 });
    expect(gate.marker()).toBeNull();
  });

  it('bounds descriptor lines and never leaks payloads', () => {
    const gate = createCrashGate(0);
    const event = gate.record('weird.seam.'.repeat(40));
    expect(event.descriptor.length).toBeLessThan(300);
    expect(JSON.parse(event.descriptor).label.length).toBeLessThanOrEqual(200);
    // fixed-table labels: no SQL text can appear for a declared seam
    expect(JSON.parse(gate.record('db.query').descriptor).label).toBe('pg query');
  });
});

describe('settled-seam wrappers', () => {
  it('patchPg reports db.query after fulfillment and after rejection', async () => {
    let resolve!: (v: unknown) => void; let reject!: (e: unknown) => void;
    class FakeClient {
      query() { return new Promise((res, rej) => { resolve = res; reject = rej; }); }
    }
    const seen: string[] = [];
    patchPg(seam => seen.push(seam), { Client: FakeClient });
    const client = new FakeClient();
    const good = client.query();
    expect(seen).toEqual([]);
    resolve('ok'); await good;
    expect(seen).toEqual(['db.query']);
    const bad = client.query();
    const observed = bad.catch(() => 'rejected');
    reject(new Error('boom'));
    await observed;
    expect(seen).toEqual(['db.query', 'db.query']);
  });

  it('patchPg reports db.query when a callback style is used', async () => {
    const seen: string[] = [];
    class CallbackClient {
      query(_sql: string, cb: (err: Error | null) => void) { setTimeout(() => cb(null), 1); return this; }
    }
    patchPg(seam => seen.push(seam), { Client: CallbackClient });
    const client = new CallbackClient();
    await new Promise<void>(done => { client.query('SELECT 1', () => done()); });
    expect(seen).toEqual(['db.query']);
  });

  it('records a callback query before application callback code can start another effect', async () => {
    const order: string[] = [];
    class CallbackClient { query(_sql: string, cb: () => void) { cb(); } }
    patchPg(() => order.push('settled'), { Client: CallbackClient });
    new CallbackClient().query('SELECT 1', () => order.push('application'));
    expect(order).toEqual(['settled', 'application']);
  });

  it('counts one public pool query once even when it delegates to a patched client', async () => {
    const seen: string[] = [];
    class Client { query() { return Promise.resolve('ok'); } }
    class Pool { query() { return new Client().query(); } }
    patchPg(seam => seen.push(seam), { Client, Pool });
    await new Pool().query();
    expect(seen).toEqual(['db.query']);
  });

  it('counts a new client query started by a pool callback as a separate application effect', async () => {
    const seen: string[] = [];
    class Client { query(_sql: string, callback: () => void) { setTimeout(callback, 0); } }
    class Pool { query(sql: string, callback: () => void) { new Client().query(sql, callback); } }
    patchPg(seam => seen.push(seam), { Client, Pool });
    await new Promise<void>(done => new Pool().query('SELECT 1', () => new Client().query('SELECT 2', done)));
    expect(seen).toEqual(['db.query', 'db.query']);
  });

  it('patchBullMq reports queue.add only after the job is persisted', async () => {
    let resolve!: (v: unknown) => void;
    class FakeQueue { add() { return new Promise(res => { resolve = res; }); } }
    const seen: string[] = [];
    patchBullMq(seam => seen.push(seam), { Queue: FakeQueue });
    const queue = new FakeQueue();
    const pending = queue.add();
    expect(seen).toEqual([]);
    resolve({ id: 'j1' }); await pending;
    expect(seen).toEqual(['queue.add']);
  });

  it('patchFetch reports http.request on settle', async () => {
    const seen: string[] = [];
    const target = { fetch: () => Promise.resolve('response') } as { fetch?: unknown };
    patchFetch(seam => seen.push(seam), target);
    await (target.fetch as () => Promise<unknown>)();
    expect(seen).toEqual(['http.request']);
  });

  it('patchFetch is a no-op when fetch is missing', () => {
    const seen: string[] = [];
    expect(() => patchFetch(seam => seen.push(seam), {})).not.toThrow();
    expect(seen).toEqual([]);
  });
});

describe('undeclared-I/O observation', () => {
  it('ignores declared cell hosts and reports each undeclared destination once', () => {
    const observer = createIoObserver(['postgres', 'redis', 'simulator']);
    expect(observer.observe('dns.lookup', 'postgres')).toBeNull();
    expect(observer.observe('dns.lookup', 'example.com')).toEqual({ kind: 'dns.lookup', target: 'example.com', declared: false });
    expect(observer.observe('dns.lookup', 'EXAMPLE.COM')).toBeNull(); // deduplicated, case-folded
    expect(observer.observed).toBe(1);
  });

  it('bounds the observation stream', () => {
    const observer = createIoObserver([]);
    for (let index = 0; index < 40; index++) observer.observe('dns.lookup', `host-${index}.example`);
    expect(observer.observed).toBe(MAX_IO_OBSERVATIONS);
    expect(observer.observe('dns.lookup', 'another.example')).toBeNull();
  });

  it('patchDns reports an undeclared host and always calls through', async () => {
    const seen: IoObservation[] = [];
    const target = {
      lookup: (host: string, callback: (error: null, address: string) => void) =>
        setTimeout(() => callback(null, '127.0.0.1'), 1),
    };
    patchDns(observation => seen.push(observation), createIoObserver(['postgres']), target);
    const address = await new Promise<string>((resolve) => {
      (target.lookup as unknown as (host: string, cb: (error: null, address: string) => void) => void)('example.com', (_error, value) => resolve(value));
    });
    expect(address).toBe('127.0.0.1');
    expect(seen).toEqual([{ kind: 'dns.lookup', target: 'example.com', declared: false }]);
  });

  it('patchChildProcess reports a spawn and still returns the original result', () => {
    const seen: IoObservation[] = [];
    const target = { spawn: (...args: unknown[]) => ({ ok: true, args }) };
    patchChildProcess(observation => seen.push(observation), createIoObserver([]), target);
    const result = (target.spawn as unknown as (...args: unknown[]) => { ok: boolean })('/usr/bin/curl', ['--version']);
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: 'child_process.spawn', target: 'curl', declared: false });
  });

  it('patchDns and patchChildProcess are no-ops when the function is missing', () => {
    const seen: IoObservation[] = [];
    expect(() => patchDns(observation => seen.push(observation), createIoObserver([]), {})).not.toThrow();
    expect(() => patchChildProcess(observation => seen.push(observation), createIoObserver([]), {})).not.toThrow();
    expect(seen).toEqual([]);
  });
});
