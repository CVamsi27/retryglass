import { Client as RealPgClient, Pool as RealPgPool } from 'pg';
import { Queue as RealQueue } from 'bullmq';
import RealDns from 'node:dns';
import RealChildProcess from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';

// Crash-seam instrumentation for the three declared seams: pg query, fetch, Queue.add.
// The gate counts settled seams in completion order; worker-entry writes one descriptor line
// per settled seam and at most one crash marker to stdout, then SIGKILLs itself when
// CRASH_AFTER is reached. Descriptor labels come from a fixed table — payloads never enter
// the stream.

export type Settled = (seam: string) => void;

const MAX_LABEL = 200;

const SEAM_LABELS: Record<string, string> = {
  'db.query': 'pg query',
  'http.request': 'http fetch',
  'queue.add': 'bullmq Queue.add',
};

export interface CrashEvent { index: number; descriptor: string; crash: boolean; }

export interface CrashGate {
  readonly completed: number;
  record(seam: string): CrashEvent;
  marker(): string | null;
}

/** Count settled seams in completion order. CRASH_AFTER=0 (or invalid) never crashes. */
export function createCrashGate(crashAfter: number): CrashGate {
  const bound = Number.isFinite(crashAfter) && crashAfter > 0 ? Math.floor(crashAfter) : 0;
  let completed = 0;
  let markerEmitted = false;
  return {
    get completed() { return completed; },
    record(seam: string): CrashEvent {
      const index = completed++;
      // Both fields are bounded so a descriptor line can never grow without limit.
      const boundedSeam = seam.length > 48 ? seam.slice(0, 47) + '\u2026' : seam;
      let label = SEAM_LABELS[seam] ?? boundedSeam;
      if (label.length > MAX_LABEL) label = label.slice(0, MAX_LABEL - 1) + '\u2026';
      const descriptor = JSON.stringify({ index, seam: boundedSeam, label });
      return { index, descriptor, crash: bound > 0 && completed >= bound };
    },
    marker(): string | null {
      if (markerEmitted) return null;
      markerEmitted = true;
      return JSON.stringify({ kind: 'crash-marker', crashAfter: bound, completed });
    },
  };
}

/** Settle-based reporting: runs after fulfillment AND after rejection (the seam "settles"). */
function reportSettled(result: unknown, seam: string, onSettled: Settled): unknown {
  if (result && typeof (result as Promise<unknown>).then === 'function') {
    (result as Promise<unknown>).then(() => onSettled(seam), () => onSettled(seam));
  } else {
    onSettled(seam); // synchronous completion
  }
  return result;
}

interface QueryCtor { prototype: { query?: unknown } }

export function patchPg(
  onSettled: Settled,
  modules: { Client?: unknown; Pool?: unknown } = { Client: RealPgClient, Pool: RealPgPool },
): void {
  // pg.Pool.query delegates asynchronously to Client.query. Count the public pool operation once.
  const poolQuery = new AsyncLocalStorage<boolean>();
  for (const key of ['Client', 'Pool'] as const) {
    const ctor = modules[key] as QueryCtor | undefined;
    const proto = ctor?.prototype;
    if (!proto || typeof proto.query !== 'function') continue;
    const original = proto.query;
    proto.query = function patched(this: unknown, ...args: unknown[]) {
      if (key === 'Client' && poolQuery.getStore()) {
        return (original as (...a: unknown[]) => unknown).apply(this, args);
      }
      const invoke = () => (original as (...a: unknown[]) => unknown).apply(this, args);
      const last = args[args.length - 1];
      if (typeof last === 'function') {
        args[args.length - 1] = function (this: unknown, ...callbackArgs: unknown[]) {
          onSettled('db.query');
          // User callback code starts a new application operation, outside Pool's delegation.
          return poolQuery.exit(() => (last as (...a: unknown[]) => unknown).apply(this, callbackArgs));
        };
        return key === 'Pool' ? poolQuery.run(true, invoke) : invoke();
      }
      return reportSettled(key === 'Pool' ? poolQuery.run(true, invoke) : invoke(), 'db.query', onSettled);
    };
  }
}

export function patchBullMq(
  onSettled: Settled,
  modules: { Queue?: unknown } = { Queue: RealQueue },
): void {
  const ctor = modules.Queue as { prototype: { add?: unknown } } | undefined;
  const proto = ctor?.prototype;
  if (!proto || typeof proto.add !== 'function') return;
  const original = proto.add;
  proto.add = function patched(this: unknown, ...args: unknown[]) {
    return reportSettled((original as (...a: unknown[]) => unknown).apply(this, args), 'queue.add', onSettled);
  };
}

export function patchFetch(
  onSettled: Settled,
  target: { fetch?: unknown } = globalThis as { fetch?: unknown },
): void {
  const original = target.fetch;
  if (typeof original !== 'function') return;
  target.fetch = function patched(this: unknown, ...args: unknown[]) {
    return reportSettled((original as (...a: unknown[]) => unknown).apply(this, args), 'http.request', onSettled);
  };
}

// ---------------------------------------------------------------------------
// Undeclared-I/O observation. This is deliberately narrow: the worker dials its own database,
// queue and simulator over `node:net`, so destination filtering on raw sockets would either break
// the rehearsal or produce false partials. A DNS lookup for a host outside the declared cell, or
// any subprocess spawn, is an unambiguous sign that a boundary outside the three declared seams
// was used. An IP literal dialled directly is NOT detected; that limitation is documented.
// ---------------------------------------------------------------------------

export type IoKind = 'dns.lookup' | 'child_process.spawn';
export interface IoObservation { kind: IoKind; target: string; declared: false; }
export type OnIo = (observation: IoObservation) => void;

const MAX_IO_TARGET = 120;
export const MAX_IO_OBSERVATIONS = 16;

export interface IoObserver {
  readonly observed: number;
  observe(kind: IoKind, rawTarget: string): IoObservation | null;
}

/** Bounded, deduplicated observation stream. Declared hosts are never reported. */
export function createIoObserver(declaredHosts: readonly string[]): IoObserver {
  const declared = new Set(declaredHosts.map(host => host.trim().toLowerCase()).filter(Boolean));
  const seen = new Set<string>();
  let observed = 0;
  return {
    get observed() { return observed; },
    observe(kind: IoKind, rawTarget: string): IoObservation | null {
      const target = (rawTarget || 'unknown').trim().toLowerCase().slice(0, MAX_IO_TARGET);
      if (kind === 'dns.lookup' && declared.has(target)) return null;
      const key = `${kind}:${target}`;
      if (seen.has(key) || observed >= MAX_IO_OBSERVATIONS) return null;
      seen.add(key);
      observed++;
      return { kind, target, declared: false };
    },
  };
}

function lookupHost(args: unknown[]): string {
  const first = args[0];
  if (typeof first === 'string') return first;
  if (first && typeof first === 'object') {
    const hostname = (first as { hostname?: unknown }).hostname;
    if (typeof hostname === 'string') return hostname;
  }
  return 'unknown';
}

function spawnCommand(args: unknown[]): string {
  const first = args[0];
  return typeof first === 'string' ? first.split(/[\\/]/).pop() ?? first : 'unknown';
}

export function patchDns(
  onIo: OnIo,
  observer: IoObserver,
  target: { lookup?: unknown } = RealDns as { lookup?: unknown },
): void {
  const original = target.lookup;
  if (typeof original !== 'function') return;
  target.lookup = function patched(this: unknown, ...args: unknown[]) {
    const event = observer.observe('dns.lookup', lookupHost(args));
    if (event) { try { onIo(event); } catch { /* observation is best-effort; it never changes the call */ } }
    return (original as (...a: unknown[]) => unknown).apply(this, args);
  };
}

export function patchChildProcess(
  onIo: OnIo,
  observer: IoObserver,
  target: { spawn?: unknown; exec?: unknown; execFile?: unknown } = RealChildProcess as { spawn?: unknown; exec?: unknown; execFile?: unknown },
): void {
  for (const key of ['spawn', 'exec', 'execFile'] as const) {
    const original = target[key];
    if (typeof original !== 'function') continue;
    target[key] = function patched(this: unknown, ...args: unknown[]) {
      const event = observer.observe('child_process.spawn', spawnCommand(args));
      if (event) { try { onIo(event); } catch { /* observation is best-effort */ } }
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    };
  }
}
