import { MAX_PROJECTION_BYTES, MAX_PROJECTION_ROWS, type Projection } from '../contracts.js';

/** Minimal query surface so a pooled client, a bare client and a test double are interchangeable. */
export interface Queryable {
  query<T extends Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

export interface ProjectionSpec {
  table: string;
  key: string[];
  columns: string[];
}

/** A projection that cannot be trusted is never reported as an empty or partial success. */
export class ProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectionError';
  }
}

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

/** Reject anything the scenario schema would not have produced, then quote it for SQL. */
export function quoteIdentifier(identifier: string): string {
  if (!IDENTIFIER.test(identifier)) throw new ProjectionError(`Unsafe SQL identifier: ${identifier}`);
  return `"${identifier}"`;
}

function splitTable(table: string): { schema: string; name: string } {
  const parts = table.split('.');
  if (parts.length !== 2) throw new ProjectionError(`Projection table must be schema-qualified: ${table}`);
  const [schema, name] = parts;
  if (!schema || !name || !IDENTIFIER.test(schema) || !IDENTIFIER.test(name)) {
    throw new ProjectionError(`Unsafe projection table: ${table}`);
  }
  return { schema, name };
}

const SUPPORTED_TYPES = new Set([
  'smallint', 'integer', 'bigint', 'numeric', 'real', 'double precision', 'boolean',
  'text', 'character varying', 'character', 'uuid',
  'date', 'time without time zone', 'time with time zone',
  'timestamp without time zone', 'timestamp with time zone', 'interval',
]);

interface ColumnRow extends Record<string, unknown> { column_name: string; data_type: string; }

/**
 * A projection value must be a JSON scalar. Timestamps become ISO strings and bigints become
 * decimal strings so a snapshot does not silently depend on driver parsing.
 */
export function normalizeValue(value: unknown, table: string, column: string): string | number | boolean | null {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ProjectionError(`Non-finite projected number: ${table}.${column}`);
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new ProjectionError(`Invalid projected date: ${table}.${column}`);
    return value.toISOString();
  }
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
  throw new ProjectionError(`Unsupported projected value type for ${table}.${column}`);
}

async function validateCatalog(client: Queryable, spec: ProjectionSpec): Promise<void> {
  const { schema, name } = splitTable(spec.table);
  const { rows } = await client.query<ColumnRow>(
    'SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
    [schema, name],
  );
  if (!rows.length) throw new ProjectionError(`Missing projection table: ${spec.table}`);
  const types = new Map<string, string>();
  for (const row of rows) types.set(String(row.column_name), String(row.data_type).toLowerCase());
  if (!spec.key.length) throw new ProjectionError(`Projection key is empty: ${spec.table}`);
  if (spec.key.length !== new Set(spec.key).size) throw new ProjectionError(`Duplicate projection key: ${spec.table}`);
  for (const column of spec.key) {
    if (!types.has(column)) throw new ProjectionError(`Missing key column: ${spec.table}.${column}`);
  }
  for (const column of spec.columns) {
    const type = types.get(column);
    if (type === undefined) throw new ProjectionError(`Missing projected column: ${spec.table}.${column}`);
    if (!SUPPORTED_TYPES.has(type)) throw new ProjectionError(`Unsupported projected type ${type}: ${spec.table}.${column}`);
  }
  for (const column of spec.key) {
    if (!spec.columns.includes(column)) throw new ProjectionError(`Projection key is not selected: ${spec.table}.${column}`);
  }
}

/**
 * Read one bounded, committed projection. Duplicate key values make the observation ambiguous and
 * are rejected instead of being collapsed into one row.
 */
export async function snapshotProjection(client: Queryable, spec: ProjectionSpec): Promise<Projection> {
  await validateCatalog(client, spec);
  const { schema, name } = splitTable(spec.table);
  const columns = spec.columns.map(column => quoteIdentifier(column)).join(', ');
  const ordering = spec.key.map(column => quoteIdentifier(column)).join(', ');
  const sql = `SELECT ${columns} FROM ${quoteIdentifier(schema)}.${quoteIdentifier(name)} ORDER BY ${ordering} LIMIT $1`;
  const { rows } = await client.query(sql, [MAX_PROJECTION_ROWS + 1]);

  const truncatedByRows = rows.length > MAX_PROJECTION_ROWS;
  const selected = truncatedByRows ? rows.slice(0, MAX_PROJECTION_ROWS) : rows;
  const projected: Record<string, unknown>[] = [];
  const keys = new Set<string>();
  let bytes = 0;
  let truncatedByBytes = false;
  for (const row of selected) {
    const entry: Record<string, unknown> = {};
    for (const column of spec.columns) {
      if (!Object.hasOwn(row, column)) throw new ProjectionError(`Query omitted column: ${spec.table}.${column}`);
      entry[column] = normalizeValue(row[column], spec.table, column);
    }
    const key = JSON.stringify(spec.key.map(column => entry[column]));
    if (keys.has(key)) throw new ProjectionError(`Ambiguous duplicate projection key: ${spec.table}`);
    keys.add(key);
    bytes += Buffer.byteLength(JSON.stringify(entry));
    if (bytes > MAX_PROJECTION_BYTES) { truncatedByBytes = true; break; }
    projected.push(entry);
  }
  return {
    table: spec.table,
    key: [...spec.key],
    columns: [...spec.columns],
    rows: projected,
    truncated: truncatedByRows || truncatedByBytes,
  };
}
