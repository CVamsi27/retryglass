import type { Projection } from '../contracts.js';
import { ProjectionError } from './projection.js';

export interface ChangedRow {
  key: unknown[];
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

export interface ProjectionDiff {
  table: string;
  inserted: Record<string, unknown>[];
  deleted: Record<string, unknown>[];
  changed: ChangedRow[];
}

function keyOf(projection: Projection, row: Record<string, unknown>): unknown[] {
  const values: unknown[] = [];
  for (const column of projection.key) {
    if (!Object.hasOwn(row, column)) throw new ProjectionError(`Missing key value ${column}: ${projection.table}`);
    values.push(row[column]);
  }
  return values;
}

function compareKeys(left: unknown[], right: unknown[]): number {
  const a = JSON.stringify(left);
  const b = JSON.stringify(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Compare two snapshots of the same declared projection. The result is sorted by projected key so
 * a diff is reproducible regardless of the server's physical row order.
 */
export function diffProjection(before: Projection, after: Projection): ProjectionDiff {
  if (before.table !== after.table) throw new ProjectionError('Cannot diff projections of different tables');
  if (before.truncated || after.truncated) throw new ProjectionError(`Cannot diff a truncated projection: ${before.table}`);
  if (JSON.stringify(before.key) !== JSON.stringify(after.key)) throw new ProjectionError(`Projection keys differ: ${before.table}`);
  if (JSON.stringify(before.columns) !== JSON.stringify(after.columns)) throw new ProjectionError(`Projection columns differ: ${before.table}`);

  const beforeRows = new Map<string, { key: unknown[]; row: Record<string, unknown> }>();
  for (const row of before.rows) {
    const key = keyOf(before, row);
    const serialized = JSON.stringify(key);
    if (beforeRows.has(serialized)) throw new ProjectionError(`Ambiguous duplicate key in before snapshot: ${before.table}`);
    beforeRows.set(serialized, { key, row });
  }
  const afterRows = new Map<string, { key: unknown[]; row: Record<string, unknown> }>();
  for (const row of after.rows) {
    const key = keyOf(after, row);
    const serialized = JSON.stringify(key);
    if (afterRows.has(serialized)) throw new ProjectionError(`Ambiguous duplicate key in after snapshot: ${before.table}`);
    afterRows.set(serialized, { key, row });
  }

  const inserted: { key: unknown[]; row: Record<string, unknown> }[] = [];
  const deleted: { key: unknown[]; row: Record<string, unknown> }[] = [];
  const changed: ChangedRow[] = [];
  for (const [serialized, entry] of afterRows) {
    const prior = beforeRows.get(serialized);
    if (!prior) inserted.push(entry);
    else if (JSON.stringify(prior.row) !== JSON.stringify(entry.row)) {
      changed.push({ key: entry.key, before: prior.row, after: entry.row });
    }
  }
  for (const [serialized, entry] of beforeRows) {
    if (!afterRows.has(serialized)) deleted.push(entry);
  }
  const byKey = (left: { key: unknown[] }, right: { key: unknown[] }) => compareKeys(left.key, right.key);
  return {
    table: before.table,
    inserted: inserted.sort(byKey).map(entry => entry.row),
    deleted: deleted.sort(byKey).map(entry => entry.row),
    changed: changed.sort((left, right) => compareKeys(left.key, right.key)),
  };
}
