import { expect, test } from 'vitest';
import * as termination from '../src/runtime/terminate.js';

test('requests a real SIGKILL and refuses to manufacture a successful crash if it returns', () => {
  const calls: unknown[] = [];
  expect(() => termination.killWorkerForCrash((pid, signal) => { calls.push([pid, signal]); })).toThrow(/survived SIGKILL/);
  expect(calls).toEqual([[process.pid, 'SIGKILL']]);
});
test('a failed signal remains an error rather than an ordinary exit 137', () => {
  expect(() => termination.killWorkerForCrash(() => { throw new Error('synthetic signal denied'); })).toThrow('synthetic signal denied');
});
