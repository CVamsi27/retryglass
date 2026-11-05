import { describe, expect, it } from 'vitest';
import { crashAfterFor, discoverCrashPoints, parseSeamLog } from '../src/sweep/discovery.js';

/** Worker stdout as `src/runtime/worker-entry.ts` writes it: one JSON object per line. */
function descriptor(index: number, seam: string, label = seam): string {
  return JSON.stringify({ index, seam, label });
}

function log(seams: Array<string>, options?: { marker?: number }): string {
  const lines = seams.map((seam, index) => descriptor(index, seam, seam === 'db.query' ? 'pg query' : 'http fetch'));
  if (options?.marker !== undefined) {
    lines.push(JSON.stringify({ kind: 'crash-marker', crashAfter: options.marker, completed: options.marker }));
  }
  return lines.join('\n');
}

describe('parseSeamLog', () => {
  it('reads descriptors, the crash marker and worker noise separately', () => {
    const parsed = parseSeamLog([
      descriptor(0, 'db.query', 'pg query'),
      'worker noise that is not json',
      descriptor(1, 'http.request', 'http fetch'),
      JSON.stringify({ kind: 'crash-marker', crashAfter: 2, completed: 2 }),
      JSON.stringify({ state: 'completed', jobId: 'job-17', attemptsMade: 2 }),
    ].join('\n'));

    expect(parsed.descriptors).toEqual([
      { index: 0, seam: 'db.query', label: 'pg query' },
      { index: 1, seam: 'http.request', label: 'http fetch' },
    ]);
    expect(parsed.marker).toEqual({ crashAfter: 2, completed: 2 });
    expect(parsed.malformed).toBe(1);
  });

  it('records undeclared I/O and undeclared seams instead of silently accepting them', () => {
    const parsed = parseSeamLog([
      JSON.stringify({ kind: 'io-observation', io: 'dns.lookup', target: 'example.com', declared: false }),
      JSON.stringify({ kind: 'io-observation', io: 'dns.lookup', target: 'example.com', declared: false }),
      JSON.stringify({ kind: 'io-observation', io: 'dns.lookup', target: 'postgres', declared: true }),
      JSON.stringify({ kind: 'io-observation', io: 'child_process.spawn', target: 'curl', declared: false }),
      descriptor(0, 'grpc.call', 'grpc'),
    ].join('\n'));

    expect(parsed.io).toEqual([
      { kind: 'dns.lookup', target: 'example.com', declared: false },
      { kind: 'child_process.spawn', target: 'curl', declared: false },
    ]);
    expect(parsed.unknownSeams).toEqual(['grpc.call']);
    expect(parsed.descriptors).toEqual([]);
  });

  it('bounds labels and rejects oversized or non-descriptor lines', () => {
    const parsed = parseSeamLog([
      JSON.stringify({ index: 0, seam: 'db.query', label: 'x'.repeat(300) }),
      JSON.stringify({ index: 'not-a-number', seam: 'db.query' }),
      `${'a'.repeat(600)}`,
    ].join('\n'));

    expect(parsed.descriptors).toHaveLength(1);
    expect(parsed.descriptors[0]!.label.length).toBe(200);
    expect(parsed.malformed).toBe(1); // the 600-character line is not a descriptor

    // A label too long for the bounded line is rejected rather than interpreted.
    const oversized = parseSeamLog(JSON.stringify({ index: 0, seam: 'db.query', label: 'x'.repeat(500) }));
    expect(oversized.descriptors).toEqual([]);
    expect(oversized.malformed).toBe(1);
  });
});

describe('discoverCrashPoints', () => {
  it('enumerates one crash point per settled seam, in completion order', () => {
    const seams = ['db.query', 'db.query', 'http.request', 'queue.add', 'db.query'];
    const result = discoverCrashPoints([log(seams), log(seams), log(seams)]);

    expect(result.stable).toBe(true);
    expect(result.observed).toBe(5);
    expect(result.points.map(point => point.seam)).toEqual(seams);
    expect(result.points.map(point => point.id)).toEqual(['cp-01', 'cp-02', 'cp-03', 'cp-04', 'cp-05']);
    expect(result.points.map(crashAfterFor)).toEqual([1, 2, 3, 4, 5]);
    expect(result.reasons).toEqual([]);
  });

  it('refuses an unstable order instead of guessing', () => {
    const result = discoverCrashPoints([
      log(['db.query', 'http.request']),
      log(['http.request', 'db.query']),
    ]);
    expect(result.stable).toBe(false);
    expect(result.points).toEqual([]);
    expect(result.reasons.join(' ')).toMatch(/different seam order/);
  });

  it('treats a missing or repeated descriptor as instability', () => {
    const gapped = parseSeamLog([descriptor(0, 'db.query'), descriptor(2, 'db.query')].join('\n'));
    expect(gapped.descriptors).toHaveLength(2);
    const result = discoverCrashPoints([[descriptor(0, 'db.query'), descriptor(2, 'db.query')].join('\n')]);
    expect(result.stable).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/missing or repeated/);

    const repeated = discoverCrashPoints([[descriptor(0, 'db.query'), descriptor(0, 'db.query')].join('\n')]);
    expect(repeated.stable).toBe(false);
  });

  it('caps enumeration and records the cap explicitly', () => {
    const many = Array.from({ length: 70 }, () => 'db.query');
    const result = discoverCrashPoints([log(many)], { maxCrashPoints: 64 });
    expect(result.observed).toBe(70);
    expect(result.points).toHaveLength(64);
    expect(result.moreObserved).toBe(true);
    expect(result.reasons.join(' ')).toMatch(/sweep cap reached/);
  });

  it('reports an empty or missing discovery instead of inventing points', () => {
    expect(discoverCrashPoints([]).stable).toBe(false);
    const empty = discoverCrashPoints(['worker started\nworker stopped']);
    expect(empty.stable).toBe(false);
    expect(empty.points).toEqual([]);
    expect(empty.reasons.join(' ')).toMatch(/observed no declared seam/);
  });

  it('surfaces undeclared observations from every discovery run', () => {
    const io = JSON.stringify({ kind: 'io-observation', io: 'dns.lookup', target: 'example.com', declared: false });
    const result = discoverCrashPoints([`${log(['db.query'])}\n${io}`, log(['db.query'])]);
    expect(result.unsupported).toEqual([{ kind: 'dns.lookup', target: 'example.com', declared: false }]);
  });
});
