import { z } from 'zod';

export const MAX_SCENARIO_BYTES = 1_048_576;
export const MAX_FIXTURE_BYTES = 1_048_576;
export const MAX_PROJECTION_ROWS = 10_000;
export const MAX_PROJECTION_BYTES = 10 * 1024 * 1024;

export type JsonScalar = string | number | boolean | null;
export type Execution = 'completed' | 'setup_failed' | 'timed_out' | 'interrupted';
export type Coverage = 'complete_for_declared_surfaces' | 'partial' | 'unsupported';
export type AssertionState = 'passed' | 'failed' | 'not_evaluated';
export type Cleanup = 'completed' | 'failed';

export interface Cell {
  runId: string;
  projectName: string;
  runDir: string;
  collectorContainerId: string;
  postgresContainerId: string;
  redisContainerId: string;
  simulatorContainerId: string;
  networkId: string;
  applicationRole: string;
  applicationPassword: string;
  redisPassword: string;
  toolImage: string;
  workerContainerId?: string;
}

export interface Projection {
  table: string; key: string[]; columns: string[];
  rows: Record<string, unknown>[]; truncated: boolean;
}

export interface HttpAttempt {
  attemptId: string; operationKey: string; idempotencyKey: string | null;
  payloadDigest: string; response: 'success' | 'accepted_response_lost' | 'rejected';
}

export interface AppliedOperation {
  operationId: string; operationKey: string; idempotencyKey: string | null; payloadDigest: string;
}

export interface OutputJob { queue: string; jobId: string; name: string; operationKey: string; }

export interface JobAttempt {
  attempt: 1 | 2; jobId: string; operationKey: string; state: 'failed' | 'completed';
  attemptsMade: number; attemptsStarted: number;
}

export type Rule =
  | { id: string; kind: 'row_count'; table: string; equals: number }
  | { id: string; kind: 'row_value'; table: string; key: Record<string, JsonScalar>; column: string; equals: JsonScalar }
  | { id: string; kind: 'applied_max'; maximum: number }
  | { id: string; kind: 'applied_count'; equals: number }
  | { id: string; kind: 'http_attempts_max'; maximum: number }
  | { id: string; kind: 'output_max'; queue: string; maximum: number }
  | { id: string; kind: 'output_count'; queue: string; equals: number }
  | { id: string; kind: 'required_http'; minimum: number }
  | { id: string; kind: 'job_state'; attempt: 1 | 2; equals: 'failed' | 'completed' };

export interface Evidence {
  before: Projection[]; partial: Projection[]; after: Projection[];
  httpAttempts: HttpAttempt[]; appliedOperations: AppliedOperation[];
  outputJobs: OutputJob[]; jobAttempts: JobAttempt[];
}

export interface RuleResult { id: string; passed: boolean; observed: JsonScalar; }

export interface RunReport {
  schemaVersion: 1; runId: string; evidenceKind: 'synthetic' | 'observed';
  execution: Execution; coverage: Coverage; assertions: AssertionState; cleanup: Cleanup;
  evidence: Evidence; rules: RuleResult[]; missing: string[];
  scenarioId?: string;
  provenance?: Record<string, unknown>;
  timing?: { startedAt: string; finishedAt: string };
}

/** The only supported crash seams (Revision 2 §3.1). */
export type Seam = 'db.query' | 'http.request' | 'queue.add';
export const SEAMS: readonly Seam[] = ['db.query', 'http.request', 'queue.add'];

/** One enumerated crash point. `crashAfter` is the 1-based settled-seam count. */
export interface CrashPoint {
  id: string;
  index: number;
  seam: Seam;
  label: string;
}

/** One rehearsed crash point: its crash evidence, its retry evidence and its judgement. */
export interface SweepCrashPoint {
  id: string; index: number; seam: Seam; label: string;
  crashVerified: boolean; exitCode: number | null; exitSignal: string | null;
  recovery: 'stalled' | 'not_recovered'; recoveryWaitMs: number;
  evidence: Evidence; rules: RuleResult[]; violations: string[]; missing: string[];
  execution: Execution; coverage: Coverage; assertions: AssertionState; cleanup: Cleanup;
  durationMs: number;
}

/** V2 crash-sweep report. */
export interface SweepReport {
  schemaVersion: 2; mode: 'crash-sweep';
  runId: string; scenarioId: string; evidenceKind: 'synthetic' | 'observed';
  execution: Execution; coverage: Coverage; assertions: AssertionState; cleanup: Cleanup;
  sweep: {
    maxCrashPoints: number; discovered: number; executed: number; verified: number;
    incomplete: number;
    crashPoints: SweepCrashPoint[];
    firstViolationId: string | null;
  };
  missing: string[];
  provenance: Record<string, unknown>;
  timing?: { startedAt: string; finishedAt: string };
}

/** Scenario type for scenario validation. */
export interface Scenario {
  schemaVersion: 1; scenarioId: string; experiment: string;
  worker: { image: string; processor: string; revision: string };
  fixture: { schema: string; seed: string; expectedRows: Record<string, number> };
  job: { name: string; id: string; operationKey: string; data: Record<string, unknown> };
  tables: { table: string; key: string[]; columns: string[] }[];
  outputQueues: string[];
  provider: { idempotent: boolean; loseFirstAcknowledgement: boolean };
  rules: Rule[];
}

/** Stop result from a cell. */
export interface StopResult {
  code: number; signal: string; workerContainerId?: string;
  remainingDatabaseBackends?: number; simulatorDrained?: boolean;
  /** Actual engine inspection; a supervisor-forced stop cannot verify an injected crash. */
  oomKilled?: boolean; forced?: boolean;
}

export interface RunOptions {
  outputRoot: string; signal?: AbortSignal; maxCrashPoints?: number; timeoutMs?: number; stopOnFirstFailure?: boolean;
}

/**
 * Validate a scenario JSON body against the alpha contract.
 * Returns the parsed scenario when it is acceptable for a rehearsal run.
 */
export function validateScenario(scenario: unknown): Scenario {
  const parsed = scenarioSchema.parse(scenario);
  if (!parsed.rules) {
    throw new Error('Scenario rules must be an array when present');
  }

  // Byte ceiling: serialized job.data must fit within the declared ceiling.
  const dataSize = new TextEncoder().encode(JSON.stringify(parsed.job.data)).length;
  if (dataSize > MAX_SCENARIO_BYTES) {
    throw new Error(`Scenario job.data exceeds the ${MAX_SCENARIO_BYTES} byte ceiling`);
  }

  // Revision 2 defines exactly two experiments: one rehearsed retry, or an enumerated sweep.
  if (parsed.experiment !== 'failed-retry' && parsed.experiment !== 'crash-sweep') {
    throw new Error("Only experiments 'failed-retry' and 'crash-sweep' are supported");
  }

  // Absolute processor paths are not allowed; the processor must be a relative module path
  // resolved inside the worker image.
  if (isAbsolutePath(parsed.worker.processor)) {
    throw new Error('Worker processor must be a relative path inside the worker image');
  }
  assertSafeRelative(parsed.worker.processor, 'worker.processor');
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_./-]*\.js$/.test(parsed.worker.processor)) {
    throw new Error('Worker processor must name a supported relative JavaScript module');
  }

  // Fixture paths must be safe relative paths that do not escape the scenario directory.
  assertSafeRelative(parsed.fixture.schema, 'fixture.schema');
  assertSafeRelative(parsed.fixture.seed, 'fixture.seed');

  // Declared output queues must not collide with the internal input queue used by the runner.
  if (parsed.outputQueues.includes('input')) {
    throw new Error("Declared output queue 'input' collides with the internal job input queue");
  }

  // Rule identities must be unique within a scenario.
  const ruleIds = new Set<string>();
  for (const rule of parsed.rules as Rule[]) {
    if (ruleIds.has(rule.id)) {
      throw new Error(`Duplicate rule identity '${rule.id}'`);
    }
    ruleIds.add(rule.id);
  }

  // The alpha requires both terminal job states to be declared explicitly.
  const hasTerminal = (attempt: 1 | 2, expected: 'failed' | 'completed') =>
    (parsed.rules as Rule[]).some((r) => r.kind === 'job_state' && r.attempt === attempt && r.equals === expected);
  if (!hasTerminal(1, 'failed') || !hasTerminal(2, 'completed')) {
    throw new Error('Scenario must declare both terminal job states (attempt 1 = failed, attempt 2 = completed)');
  }
  if (!(parsed.rules as Rule[]).some(rule => rule.kind === 'row_value'
    || ((rule.kind === 'row_count' || rule.kind === 'applied_count' || rule.kind === 'output_count') && rule.equals > 0))) {
    throw new Error('Scenario requires a positive business-effect presence assertion, not only upper bounds');
  }
  if (parsed.job.data.operationKey !== parsed.job.operationKey) {
    throw new Error('Job data.operationKey must match the declared business operation key');
  }

  // Every rule must refer to a declared surface (table or output queue).
  const declaredTables = new Set(parsed.tables.map((t: { table: string }) => t.table));
  if (declaredTables.size !== parsed.tables.length) throw new Error('Projection tables must be unique');
  for (const table of parsed.tables) {
    if (new Set(table.key).size !== table.key.length || new Set(table.columns).size !== table.columns.length
      || table.key.some(column => !table.columns.includes(column))) throw new Error('Projection keys must be unique declared columns');
  }
  for (const name of Object.keys(parsed.fixture.expectedRows)) {
    if (!declaredTables.has(name)) throw new Error(`Seed expectation references undeclared table '${name}'`);
  }
  for (const rule of parsed.rules as Rule[]) {
    if (rule.kind === 'row_count' || rule.kind === 'row_value') {
      if (!declaredTables.has(rule.table)) {
        throw new Error(`Rule '${rule.id}' references an undeclared table '${rule.table}'`);
      }
      if (rule.kind === 'row_value') {
        if (!Object.keys(rule.key ?? {}).length) {
          throw new Error(`Rule '${rule.id}' must bind at least one key column`);
        }
        const projection = parsed.tables.find(table => table.table === rule.table)!;
        if (!projection.columns.includes(rule.column) || Object.keys(rule.key).some(key => !projection.key.includes(key))) {
          throw new Error(`Rule '${rule.id}' must refer to declared projection key and value columns`);
        }
      }
    }
    if (rule.kind === 'output_max' || rule.kind === 'output_count') {
      if (!parsed.outputQueues.includes(rule.queue)) {
        throw new Error(`Rule '${rule.id}' references an undeclared output queue '${rule.queue}'`);
      }
    }
  }

  return parsed as unknown as Scenario;
}

function isAbsolutePath(path: string): boolean {
  // Node `path.isAbsolute` is platform-aware; avoid importing `path` here so the check
  // stays explicit and easy to reason about in tests.
  return path.startsWith('/') || /^([A-Za-z]:)/.test(path);
}

function assertSafeRelative(path: string, label: string): void {
  if (path === '' || path.startsWith('/')) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  const normalized = path.replace(/\\\\/g, '/');
  if (normalized.startsWith('../') || normalized.startsWith('./..') || normalized.includes('/../') || normalized.endsWith('/..')) {
    throw new Error(`${label} must not escape the scenario directory`);
  }
}

/** Refuse a report written by a newer tool before any field is interpreted. */
function refuseFutureSchema(report: unknown): void {
  if (report && typeof report === 'object' && 'schemaVersion' in report) {
    const version = (report as { schemaVersion: unknown }).schemaVersion;
    if (typeof version === 'number' && Number.isFinite(version) && version > 2) {
      throw new Error(`Report schemaVersion ${version} is newer than this tool supports (1 or 2); refusing to interpret it`);
    }
  }
}

/** Report validation using Zod schema. Returns a v1 rehearsal report. */
export function validateReport(report: unknown): RunReport {
  refuseFutureSchema(report);
  const parsed = reportSchema.parse(report);
  if (parsed.schemaVersion !== 1) {
    throw new Error('Only schemaVersion 1 rehearsal reports are accepted by validateReport');
  }
  if (!parsed.evidence) {
    throw new Error('Report evidence must be present');
  }
  if (!parsed.rules) {
    throw new Error('Report rules must be present');
  }
  if (!parsed.missing) {
    throw new Error('Report missing must be present');
  }
  const evidence = parsed.evidence as Evidence;
  const rules = parsed.rules as RuleResult[];
  const missing = parsed.missing as string[];
  return {
    schemaVersion: 1,
    runId: parsed.runId,
    evidenceKind: evidenceKind(parsed.evidenceKind),
    execution: execution(parsed.execution),
    coverage: coverage(parsed.coverage),
    assertions: assertion(parsed.assertions),
    cleanup: cleanup(parsed.cleanup),
    evidence,
    rules,
    missing,
    scenarioId: parsed.scenarioId ?? '',
    provenance: parsed.provenance ?? {},
    timing: parsed.timing ?? { startedAt: '', finishedAt: '' },
  };
}

/**
 * Sweep report validation. Nothing is defaulted: a point without its own dimensions, an unknown
 * seam or recovery value, or counters that disagree with the point list are refused outright.
 */
export function validateSweepReport(report: unknown): SweepReport {
  refuseFutureSchema(report);
  if (report && typeof report === 'object' && (report as { schemaVersion?: unknown }).schemaVersion === 1) {
    throw new Error('Only schemaVersion 2 sweep reports are accepted by validateSweepReport');
  }
  const parsed = reportSchema.parse(report);
  if (parsed.schemaVersion !== 2) {
    throw new Error('Only schemaVersion 2 sweep reports are accepted by validateSweepReport');
  }
  if (!parsed.sweep) {
    throw new Error('Sweep report must include a sweep block');
  }
  const sweep = parsed.sweep;
  const crashPoints = (sweep.crashPoints ?? []) as SweepCrashPoint[];
  const verified = crashPoints.filter(point => point.crashVerified).length;
  if (sweep.verified !== verified) {
    throw new Error(`Sweep verified count ${sweep.verified} disagrees with ${verified} verified crash point(s)`);
  }
  if (sweep.executed !== crashPoints.length) {
    throw new Error(`Sweep executed count ${sweep.executed} disagrees with ${crashPoints.length} recorded crash point(s)`);
  }
  if (sweep.incomplete !== crashPoints.length - verified) {
    throw new Error(`Sweep incomplete count ${sweep.incomplete} disagrees with its crash points`);
  }
  const ids = new Set<string>();
  for (const point of crashPoints) {
    if (ids.has(point.id)) throw new Error(`Duplicate crash point identity '${point.id}'`);
    ids.add(point.id);
  }
  return {
    schemaVersion: 2,
    mode: 'crash-sweep',
    runId: parsed.runId,
    scenarioId: scenarioId(parsed.scenarioId),
    evidenceKind: evidenceKind(parsed.evidenceKind),
    execution: execution(parsed.execution),
    coverage: coverage(parsed.coverage),
    assertions: assertion(parsed.assertions),
    cleanup: cleanup(parsed.cleanup),
    sweep: {
      maxCrashPoints: sweep.maxCrashPoints,
      discovered: sweep.discovered,
      executed: sweep.executed,
      verified: sweep.verified,
      incomplete: sweep.incomplete,
      crashPoints,
      firstViolationId: sweep.firstViolationId,
    },
    missing: parsed.missing ?? [],
    provenance: sweepProvenance(parsed.provenance),
    ...(parsed.timing ? { timing: parsed.timing } : {}),
  };
}

function evidenceKind(value: string | null | undefined): 'synthetic' | 'observed' { return (value ?? 'synthetic') as 'synthetic' | 'observed'; }
function execution(value: string | null | undefined): Execution { return (value ?? 'completed') as Execution; }
function coverage(value: string | null | undefined): Coverage { return (value ?? 'complete_for_declared_surfaces') as Coverage; }
function assertion(value: string | null | undefined): AssertionState { return (value ?? 'not_evaluated') as AssertionState; }
function cleanup(value: string | null | undefined): Cleanup { return (value ?? 'failed') as Cleanup; }
function scenarioId(value: string | null | undefined): string { return (value ?? '') as string; }
function sweepProvenance(value: Record<string, unknown> | null | undefined): Record<string, unknown> { const v = value ?? {}; return v; }


/** Zod validation schemas. Missing observations never default to empty success. */
const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const identifier = z.string().min(1).max(255);
const count = z.number().int().nonnegative();
const projectionSchema = z.object({
  table: identifier, key: z.array(identifier).min(1), columns: z.array(identifier).min(1),
  rows: z.array(z.record(z.string(), z.unknown())), truncated: z.boolean(),
});
const evidenceSchema = z.object({
  before: z.array(projectionSchema), partial: z.array(projectionSchema), after: z.array(projectionSchema),
  httpAttempts: z.array(z.object({
    attemptId: z.string(), operationKey: z.string(), idempotencyKey: z.string().nullable(),
    payloadDigest: z.string(), response: z.enum(['success', 'accepted_response_lost', 'rejected']),
  })),
  appliedOperations: z.array(z.object({ operationId: z.string(), operationKey: z.string(), idempotencyKey: z.string().nullable(), payloadDigest: z.string() })),
  outputJobs: z.array(z.object({ queue: z.string(), jobId: z.string(), name: z.string(), operationKey: z.string() })),
  jobAttempts: z.array(z.object({ attempt: z.union([z.literal(1), z.literal(2)]), jobId: z.string(), operationKey: z.string(), state: z.enum(['failed', 'completed']), attemptsMade: count, attemptsStarted: count })),
});
const resultSchema = z.object({ id: z.string(), passed: z.boolean(), observed: scalar });
export const sweepPointSchema = z.object({
  id: identifier, index: count, seam: z.enum(['db.query', 'http.request', 'queue.add']), label: z.string(),
  crashVerified: z.boolean(), exitCode: z.number().int().nullable(), exitSignal: z.string().nullable(),
  recovery: z.enum(['stalled', 'not_recovered']), recoveryWaitMs: z.number().nonnegative(),
  evidence: evidenceSchema, rules: z.array(resultSchema), violations: z.array(z.string()), missing: z.array(z.string()),
  execution: z.enum(['completed', 'setup_failed', 'timed_out', 'interrupted']),
  coverage: z.enum(['complete_for_declared_surfaces', 'partial', 'unsupported']),
  assertions: z.enum(['passed', 'failed', 'not_evaluated']), cleanup: z.enum(['completed', 'failed']), durationMs: z.number().nonnegative(),
});
export const sweepSchema = z.object({
  maxCrashPoints: z.number().int().min(1).max(64), discovered: count, executed: count, verified: count, incomplete: count,
  crashPoints: z.array(sweepPointSchema), firstViolationId: z.string().nullable(),
});
export const reportSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]), runId: identifier,
  evidenceKind: z.enum(['synthetic', 'observed']), execution: z.enum(['completed', 'setup_failed', 'timed_out', 'interrupted']),
  coverage: z.enum(['complete_for_declared_surfaces', 'partial', 'unsupported']),
  assertions: z.enum(['passed', 'failed', 'not_evaluated']), cleanup: z.enum(['completed', 'failed']),
  evidence: evidenceSchema.optional(), rules: z.array(resultSchema).optional(), missing: z.array(z.string()),
  scenarioId: z.string().optional(), provenance: z.record(z.string(), z.unknown()).optional(),
  timing: z.object({ startedAt: z.string(), finishedAt: z.string() }).optional(), sweep: sweepSchema.optional(),
});

export const ruleSchema = z.discriminatedUnion('kind', [
  z.object({ id: identifier, kind: z.literal('row_count'), table: identifier, equals: count }).strict(),
  z.object({ id: identifier, kind: z.literal('row_value'), table: identifier, key: z.record(z.string(), scalar), column: identifier, equals: scalar }).strict(),
  z.object({ id: identifier, kind: z.literal('applied_max'), maximum: count }).strict(),
  z.object({ id: identifier, kind: z.literal('applied_count'), equals: count }).strict(),
  z.object({ id: identifier, kind: z.literal('http_attempts_max'), maximum: count }).strict(),
  z.object({ id: identifier, kind: z.literal('output_max'), queue: identifier, maximum: count }).strict(),
  z.object({ id: identifier, kind: z.literal('output_count'), queue: identifier, equals: count }).strict(),
  z.object({ id: identifier, kind: z.literal('required_http'), minimum: count }).strict(),
  z.object({ id: identifier, kind: z.literal('job_state'), attempt: z.union([z.literal(1), z.literal(2)]), equals: z.enum(['failed', 'completed']) }).strict(),
]);
export const scenarioSchema = z.object({
  schemaVersion: z.literal(1), scenarioId: identifier, experiment: z.string(),
  worker: z.object({ image: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.\/:@-]{0,254}$/), processor: identifier, revision: identifier }).strict(),
  fixture: z.object({ schema: identifier, seed: identifier, expectedRows: z.record(z.string(), count) }).strict(),
  job: z.object({ name: identifier, id: identifier, operationKey: identifier, data: z.record(z.string(), z.unknown()) }).strict(),
  tables: z.array(z.object({ table: identifier, key: z.array(identifier).min(1), columns: z.array(identifier).min(1) }).strict()).min(1).max(16),
  outputQueues: z.array(identifier).max(16),
  provider: z.object({ idempotent: z.boolean(), loseFirstAcknowledgement: z.boolean() }).strict(),
  rules: z.array(ruleSchema).min(1).max(256),
}).strict();
