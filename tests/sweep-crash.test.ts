import { describe, expect, it } from 'vitest';
import { parseCrashMarker } from '../src/sweep/crash.js';

describe('parseCrashMarker', () => {
  it('reads the last valid marker from mixed worker stdout', () => {
    const logs = [
      '{"index":0,"seam":"db.query","label":"pg query"}',
      'some worker noise',
      '{"kind":"crash-marker","crashAfter":3,"completed":3}',
    ].join('\n');
    expect(parseCrashMarker(logs)).toEqual({ crashAfter: 3, completed: 3 });
  });

  it('returns null when no marker is present or fields are invalid', () => {
    expect(parseCrashMarker('{"index":0,"seam":"db.query","label":"pg query"}')).toBeNull();
    expect(parseCrashMarker('{"kind":"crash-marker","crashAfter":"3","completed":3}')).toBeNull();
    expect(parseCrashMarker('not json')).toBeNull();
    expect(parseCrashMarker('')).toBeNull();
    expect(parseCrashMarker('{"kind":"crash-marker","crashAfter":1.5,"completed":1.5}')).toBeNull();
  });
  it('refuses ambiguous repeated markers rather than selecting a convenient final marker', () => {
    const marker = '{"kind":"crash-marker","crashAfter":3,"completed":3}';
    expect(parseCrashMarker(`${marker}\n${marker}`)).toBeNull();
  });
});
