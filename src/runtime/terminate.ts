/** Only the engine-observed result of a real signal can verify a crash. */
export function killWorkerForCrash(kill: (pid: number, signal: 'SIGKILL') => unknown = process.kill): never {
  if (process.pid === 1) throw new Error('Crash rehearsal requires a container init process');
  kill(process.pid, 'SIGKILL');
  throw new Error('Worker survived SIGKILL; crash verification must fail');
}
