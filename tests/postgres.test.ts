import { describe, expect, test } from 'vitest';
import { MAX_PROJECTION_BYTES } from '../src/contracts.js';
import type { Projection } from '../src/contracts.js';
import { diffProjection } from '../src/postgres/diff.js';
import { quoteIdentifier, snapshotProjection, ProjectionError, type Queryable } from '../src/postgres/projection.js';
import { quiesceRole, resumeRole } from '../src/postgres/quiesce.js';

interface Column { column_name: string; data_type: string; }

class FakePostgres implements Queryable {
  readonly calls: { text: string; values?: unknown[] }[] = [];
  remaining: number;
  terminations = 0;
  terminatable = true;
  constructor(
    private readonly catalog: Column[],
    private readonly data: Record<string, unknown>[] = [],
    backends = 0,
  ) { this.remaining = backends; }

  async query<T extends Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }> {
    this.calls.push({ text, values });
    if (text.includes('information_schema.columns')) return { rows: this.catalog as unknown as T[] };
    if (text.includes('pg_terminate_backend')) {
      const terminated = this.terminatable ? this.remaining : 0;
      this.terminations += terminated;
      if (this.terminatable) this.remaining = 0;
      return { rows: [{ terminated: terminated }] as unknown as T[] };
    }
    if (text.includes('count(*)')) return { rows: [{ remaining: this.remaining }] as unknown as T[] };
    const limit = typeof values?.[0] === 'number' ? values[0] : this.data.length;
    return { rows: this.data.slice(0, limit) as unknown as T[] };
  }
}

const catalog: Column[] = [
  { column_name: 'operation_key', data_type: 'text' },
  { column_name: 'status', data_type: 'text' },
  { column_name: 'created_at', data_type: 'timestamp with time zone' },
  { column_name: 'details', data_type: 'jsonb' },
];
const spec = { table: 'public.invoices', key: ['operation_key'], columns: ['operation_key', 'status'] };

describe('bounded postgres projections', () => {
  test('observes the committed invoice in its declared projection', async () => {
    const client = new FakePostgres(catalog, [{ operation_key: 'op-17', status: 'created' }]);
    const projection = await snapshotProjection(client, spec);
    expect(projection.rows).toEqual([{ operation_key: 'op-17', status: 'created' }]);
    expect(projection.truncated).toBe(false);
    expect(client.calls[1]?.text).toContain('ORDER BY "operation_key"');
    expect(client.calls[1]?.values).toEqual([10_001]);
  });

  test('normalizes timestamps and preserves composite key ordering', async () => {
    const rows = [
      { operation_key: 'op-b', status: 'complete', created_at: new Date('2026-01-02T03:04:05.000Z') },
      { operation_key: 'op-a', status: 'created', created_at: new Date('2026-01-01T00:00:00.000Z') },
    ];
    const client = new FakePostgres(catalog, rows);
    const projection = await snapshotProjection(client, {
      table: 'public.invoices', key: ['operation_key'], columns: ['operation_key', 'status', 'created_at'],
    });
    expect(projection.rows[0]?.created_at).toBe('2026-01-02T03:04:05.000Z');
    expect(client.calls[1]?.text).toContain('ORDER BY "operation_key"');
  });

  test('rejects an unobservable projection instead of reporting zero rows', async () => {
    const missingTable = new FakePostgres([], []);
    await expect(snapshotProjection(missingTable, spec)).rejects.toBeInstanceOf(ProjectionError);
    await expect(snapshotProjection(missingTable, spec)).rejects.toThrow('Missing projection table');

    const missingColumn = new FakePostgres(catalog, []);
    await expect(snapshotProjection(missingColumn, {
      table: 'public.invoices', key: ['operation_key'], columns: ['operation_key', 'total_cents'],
    })).rejects.toThrow('Missing projected column');

    const unsupported = new FakePostgres(catalog, []);
    await expect(snapshotProjection(unsupported, {
      table: 'public.invoices', key: ['operation_key'], columns: ['operation_key', 'details'],
    })).rejects.toThrow('Unsupported projected type');
  });

  test('marks an over-limit projection truncated rather than silently clipping it', async () => {
    const rows = Array.from({ length: 10_001 }, (_, index) => ({ operation_key: `op-${index}`, status: 'created' }));
    const projection = await snapshotProjection(new FakePostgres(catalog, rows), spec);
    expect(projection.truncated).toBe(true);
    expect(projection.rows).toHaveLength(10_000);

    const wide = Array.from({ length: 10 }, (_, index) => ({
      operation_key: `op-${index}`, status: 'x'.repeat(MAX_PROJECTION_BYTES / 2),
    }));
    const oversized = await snapshotProjection(new FakePostgres(catalog, wide), spec);
    expect(oversized.truncated).toBe(true);
    expect(oversized.rows.length).toBeLessThan(2);
  });

  test('refuses an ambiguous duplicate projected key', async () => {
    const client = new FakePostgres(catalog, [
      { operation_key: 'op-17', status: 'created' },
      { operation_key: 'op-17', status: 'complete' },
    ]);
    await expect(snapshotProjection(client, spec)).rejects.toThrow('Ambiguous duplicate projection key');
  });

  test('quotes only catalog-safe identifiers', () => {
    expect(quoteIdentifier('invoices')).toBe('"invoices"');
    expect(() => quoteIdentifier('invoices"; DROP TABLE x')).toThrow(ProjectionError);
    expect(() => quoteIdentifier('Invoice')).toThrow(ProjectionError);
  });
});

const projection = (rows: Record<string, unknown>[]): Projection => ({
  table: 'public.invoices', key: ['operation_key'], columns: ['operation_key', 'status'], rows, truncated: false,
});

describe('projection diffs', () => {
  test('reports inserted, changed and deleted rows in key order', () => {
    const diff = diffProjection(
      projection([{ operation_key: 'op-1', status: 'created' }, { operation_key: 'op-2', status: 'created' }]),
      projection([{ operation_key: 'op-2', status: 'complete' }, { operation_key: 'op-3', status: 'created' }]),
    );
    expect(diff.inserted).toEqual([{ operation_key: 'op-3', status: 'created' }]);
    expect(diff.deleted).toEqual([{ operation_key: 'op-1', status: 'created' }]);
    expect(diff.changed).toEqual([{ key: ['op-2'], before: { operation_key: 'op-2', status: 'created' }, after: { operation_key: 'op-2', status: 'complete' } }]);
  });

  test('refuses to diff incomplete or mismatched observations', () => {
    const truncated = { ...projection([]), truncated: true };
    expect(() => diffProjection(truncated, projection([]))).toThrow('Cannot diff a truncated projection');
    const renamed = { ...projection([]), table: 'public.operations' };
    expect(() => diffProjection(renamed, projection([]))).toThrow('Cannot diff projections of different tables');
    const rekeyed = { ...projection([]), key: ['status'] };
    expect(() => diffProjection(rekeyed, projection([]))).toThrow('Projection keys differ');
  });
});

describe('application role barrier', () => {
  test('disables login, terminates remaining backends and verifies none survive', async () => {
    const client = new FakePostgres(catalog, [], 2);
    const result = await quiesceRole(client, 'retryglass_app_run1', { sleep: async () => {} });
    expect(result).toEqual({ terminatedActive: true, remaining: 0 });
    expect(client.calls[0]?.text).toBe('ALTER ROLE "retryglass_app_run1" NOLOGIN');
  });

  test('records a still-running backend as an incomplete intervention', async () => {
    const client = new FakePostgres(catalog, [], 1);
    client.terminatable = false;
    const result = await quiesceRole(client, 'retryglass_app_run1', { sleep: async () => {}, deadlineMs: 0 });
    expect(result.remaining).toBe(1);
  });

  test('restores login only through the explicit resume command', async () => {
    const client = new FakePostgres(catalog, []);
    await resumeRole(client, 'retryglass_app_run1');
    expect(client.calls.at(-1)?.text).toBe('ALTER ROLE "retryglass_app_run1" LOGIN');
    await expect(resumeRole(client, 'bad role')).rejects.toBeInstanceOf(ProjectionError);
  });
});
