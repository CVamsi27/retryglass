import { describe, expect, it } from 'vitest';
import type { SweepCrashPoint, SweepReport } from '../src/contracts.js';
import { validateSweepReport } from '../src/contracts.js';
import { exitCode } from '../src/policy.js';
import { renderSweepMarkdown } from '../src/report.js';
import { aggregateSweep, type SweepMeta } from '../src/sweep/report.js';

function point(overrides: Partial<SweepCrashPoint> = {}): SweepCrashPoint {
  return {
    id: 'cp-01', index: 0, seam: 'db.query', label: 'pg query',
    crashVerified: true, exitCode: 137, exitSignal: 'SIGKILL',
    recovery: 'stalled', recoveryWaitMs: 1_800,
    evidence: { before: [], partial: [], after: [], httpAttempts: [], appliedOperations: [], outputJobs: [], jobAttempts: [] },
    rules: [{ id: 'one-provider-action', passed: true, observed: 1 }],
    violations: [], missing: [],
    execution: 'completed', coverage: 'complete_for_declared_surfaces',
    assertions: 'passed', cleanup: 'completed', durationMs: 1_234,
    ...overrides,
  };
}

function meta(overrides: Partial<SweepMeta> = {}): SweepMeta {
  return {
    runId: 'sweep-fixture',
    scenarioId: 'invoice-ack-loss-sweep',
    maxCrashPoints: 64,
    discovered: 1,
    discovery: { runs: 3, stable: true, reasons: [] },
    startedAt: '2026-11-01T00:00:00.000Z',
    finishedAt: '2026-11-01T00:01:00.000Z',
    ...overrides,
  };
}

function failing(id: string, index: number): SweepCrashPoint {
  return point({
    id, index,
    rules: [{ id: 'one-provider-action', passed: false, observed: 2 }],
    violations: ['one-provider-action'],
    assertions: 'failed',
  });
}

describe('sweep aggregation', () => {
  it('passes only when every discovered point was executed, verified and passing', () => {
    const report = aggregateSweep([point(), point({ id: 'cp-02', index: 1, seam: 'http.request' })], meta({ discovered: 2 }));
    expect(report).toMatchObject({
      schemaVersion: 2, mode: 'crash-sweep', evidenceKind: 'observed',
      execution: 'completed', coverage: 'complete_for_declared_surfaces',
      assertions: 'passed', cleanup: 'completed',
    });
    expect(report.sweep).toMatchObject({ discovered: 2, executed: 2, verified: 2, incomplete: 0, firstViolationId: null });
    expect(report.missing).toEqual([]);
    expect(exitCode(report)).toBe(0);
    expect(validateSweepReport(report)).toEqual(report);
  });

  it('keeps a violation visible even when another point is incomplete', () => {
    const incomplete = point({
      id: 'cp-02', index: 1, seam: 'http.request',
      crashVerified: false, exitCode: 0, exitSignal: null,
      recovery: 'not_recovered', recoveryWaitMs: 0,
      assertions: 'not_evaluated', missing: ['crash point cp-02: worker survived the crash'],
    });
    const report = aggregateSweep([failing('cp-01', 0), incomplete], meta({ discovered: 2 }));

    expect(report.assertions).toBe('failed');
    expect(report.coverage).toBe('partial');
    expect(report.sweep).toMatchObject({ verified: 1, incomplete: 1, firstViolationId: 'one-provider-action' });
    // The point's own recorded reason survives; the counters make the incompleteness explicit.
    expect(report.missing.join(' ')).toMatch(/worker survived the crash/);
    expect(report.sweep).toMatchObject({ executed: 2, verified: 1, incomplete: 1 });
    expect(exitCode(report)).toBe(1);

    const text = renderSweepMarkdown(report);
    expect(text).toContain('Assertions: failed');
    expect(text).toContain('Coverage: partial');
    expect(text).toContain('one-provider-action');
    expect(text).toContain('| cp-02 | http.request | no |');
    expect(text).not.toContain('safe to retry');
  });

  it('never reports passed when a point could not be evaluated', () => {
    const report = aggregateSweep([
      point({ id: 'cp-02', index: 1, crashVerified: false, exitCode: null, exitSignal: null, recovery: 'not_recovered', assertions: 'not_evaluated' }),
    ], meta({ discovered: 1 }));
    expect(report.assertions).toBe('not_evaluated');
    expect(report.coverage).toBe('partial');
    // With no recorded reason of its own, the aggregate states the generic fact.
    expect(report.missing.join(' ')).toMatch(/crash point cp-02: the crash was not verified/);
    expect(report.missing.join(' ')).toMatch(/not recovered by the stall path/);
    expect(exitCode(report)).toBe(3);
  });

  it('records the cap as a missing entry rather than a complete sweep', () => {
    const report = aggregateSweep([point()], meta({ discovered: 70, maxCrashPoints: 64 }));
    expect(report.coverage).toBe('partial');
    expect(report.assertions).toBe('not_evaluated');
    expect(report.missing.join(' ')).toMatch(/sweep cap reached/);
    expect(report.missing.join(' ')).toMatch(/69 enumerated crash point\(s\) were not executed/);
    expect(exitCode(report)).toBe(3);
  });

  it('refuses to execute or pass a sweep whose discovery order was unstable', () => {
    const report = aggregateSweep([], meta({
      discovered: 3,
      discovery: { runs: 2, stable: false, reasons: ['discovery run 2 enumerated a different seam order than discovery run 1'] },
    }));
    expect(report.execution).toBe('interrupted');
    expect(report.assertions).toBe('not_evaluated');
    expect(report.coverage).toBe('partial');
    expect(report.missing.join(' ')).toMatch(/different seam order/);
    expect(exitCode(report)).toBe(3);
  });

  it('marks a sweep with no observed seam as unsupported', () => {
    const report = aggregateSweep([], meta({ discovered: 0 }));
    expect(report.coverage).toBe('unsupported');
    expect(report.assertions).toBe('not_evaluated');
  });

  it('keeps a cleanup failure at exit 2 while retaining the violation', () => {
    const report = aggregateSweep([
      failing('cp-01', 0),
      point({ id: 'cp-02', index: 1, cleanup: 'failed', missing: ['crash point cp-02: cleanup failed'] }),
    ], meta({ discovered: 2 }));
    expect(report.cleanup).toBe('failed');
    expect(report.assertions).toBe('failed');
    expect(exitCode(report)).toBe(2);
  });
});

describe('sweep report validation', () => {
  const valid = (): SweepReport => aggregateSweep([point()], meta());

  it('refuses a future schema version instead of interpreting it', () => {
    expect(() => validateSweepReport({ ...valid(), schemaVersion: 3 })).toThrow(/newer than this tool supports/);
  });

  it('refuses an unknown seam or recovery instead of defaulting it', () => {
    const unknownSeam = valid();
    (unknownSeam.sweep.crashPoints[0] as unknown as { seam: string }).seam = 'grpc.call';
    expect(() => validateSweepReport(unknownSeam)).toThrow();

    const unknownRecovery = valid();
    (unknownRecovery.sweep.crashPoints[0] as unknown as { recovery: string }).recovery = 'forced';
    expect(() => validateSweepReport(unknownRecovery)).toThrow();
  });

  it('refuses a point without its own dimensions', () => {
    const partial = valid();
    delete (partial.sweep.crashPoints[0] as unknown as Record<string, unknown>).assertions;
    expect(() => validateSweepReport(partial)).toThrow();
  });

  it('refuses counters that disagree with the recorded points', () => {
    const wrong = valid();
    wrong.sweep.verified = 5;
    expect(() => validateSweepReport(wrong)).toThrow(/verified count/);

    const executed = valid();
    executed.sweep.executed = 9;
    expect(() => validateSweepReport(executed)).toThrow(/executed count/);

    const duplicate = aggregateSweep([point(), point({ index: 1 })], meta({ discovered: 2 }));
    expect(() => validateSweepReport(duplicate)).toThrow(/Duplicate crash point/);
  });

  it('refuses a v1 report through the sweep validator', () => {
    expect(() => validateSweepReport({
      schemaVersion: 1, runId: 'r', evidenceKind: 'observed', execution: 'completed',
      coverage: 'partial', assertions: 'not_evaluated', cleanup: 'completed',
      evidence: {}, rules: [], missing: [],
    })).toThrow(/schemaVersion 2/);
  });
});
