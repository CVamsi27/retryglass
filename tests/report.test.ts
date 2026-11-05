import { describe, expect, it } from 'vitest';
import { renderMarkdown, sanitizeForReport } from '../src/report.js';
import type { RunReport } from '../src/contracts.js';

function report(): RunReport {
  return {
    schemaVersion: 1, runId: 'fixture-report', evidenceKind: 'observed',
    execution: 'completed', coverage: 'partial', assertions: 'not_evaluated', cleanup: 'failed',
    missing: ['http collector'], rules: [],
    evidence: { before: [], partial: [], after: [], httpAttempts: [], appliedOperations: [], outputJobs: [], jobAttempts: [] },
  };
}

describe('the developer-facing evidence report', () => {
  it('cannot hide partial capture or failed cleanup behind a completed execution', () => {
    const text = renderMarkdown(report());
    expect(text).toContain('Coverage: partial');
    expect(text).toContain('Cleanup: failed');
    expect(text).toContain('http collector');
    expect(text).toContain('declared surfaces');
    expect(text).not.toContain('safe to retry');
  });

  it('removes terminal control sequences and selected secret fields from exported evidence', () => {
    const clean = sanitizeForReport({
      password: 'SECRET_SENTINEL', nested: { authorization: 'Bearer SENTINEL', status: 'complete' },
      text: '\u001b[2J\u001b]0;title\u0007hello',
    });
    expect(JSON.stringify(clean)).not.toContain('SECRET_SENTINEL');
    expect(JSON.stringify(clean)).not.toContain('Bearer SENTINEL');
    expect(clean).toEqual({ password: '[REDACTED]', nested: { authorization: '[REDACTED]', status: 'complete' }, text: 'hello' });
  });

  it('shows requests and applied operations as different quantities', () => {
    const value = report();
    value.evidence.httpAttempts = [
      { attemptId: 'a1', operationKey: 'op-17', idempotencyKey: 'op-17', payloadDigest: 'digest', response: 'accepted_response_lost' },
      { attemptId: 'a2', operationKey: 'op-17', idempotencyKey: 'op-17', payloadDigest: 'digest', response: 'success' },
    ];
    value.evidence.appliedOperations = [{ operationId: 'effect-1', operationKey: 'op-17', idempotencyKey: 'op-17', payloadDigest: 'digest' }];
    const text = renderMarkdown(value);
    expect(text).toContain('HTTP attempts: 2');
    expect(text).toContain('Simulator-applied operations: 1');
  });

  it('preserves repeated acyclic observations while bounding genuine cycles', () => {
    const observations: string[] = [];
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(sanitizeForReport({ first: observations, discovery: { unsupported: observations }, cyclic }))
      .toEqual({ first: [], discovery: { unsupported: [] }, cyclic: { self: '[CIRCULAR]' } });
  });
});
