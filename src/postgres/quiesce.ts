import { quoteIdentifier, type Queryable } from './projection.js';

export interface QuiesceResult {
  terminatedActive: boolean;
  remaining: number;
}

export interface QuiesceOptions {
  deadlineMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

interface TerminateRow extends Record<string, unknown> { terminated: string | number; }
interface CountRow extends Record<string, unknown> { remaining: string | number; }

const defaultSleep = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));

/**
 * Block new application logins, then terminate the backends that outlived the worker container.
 * A server-side statement can survive its client, so the barrier verifies no backend remains rather
 * than trusting the container exit.
 */
export async function quiesceRole(
  client: Queryable,
  role: string,
  options: QuiesceOptions = {},
): Promise<QuiesceResult> {
  const identifier = quoteIdentifier(role);
  const deadlineMs = options.deadlineMs ?? 5_000;
  const pollMs = options.pollMs ?? 50;
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? defaultSleep;

  await client.query(`ALTER ROLE ${identifier} NOLOGIN`);
  const { rows: terminated } = await client.query<TerminateRow>(
    'SELECT count(pg_terminate_backend(pid)) AS terminated FROM pg_stat_activity WHERE usename = $1 AND pid <> pg_backend_pid()',
    [role],
  );
  const terminatedCount = Number(terminated[0]?.terminated ?? 0);

  const deadline = now() + deadlineMs;
  let remaining = Number.NaN;
  for (;;) {
    const { rows } = await client.query<CountRow>(
      'SELECT count(*) AS remaining FROM pg_stat_activity WHERE usename = $1 AND pid <> pg_backend_pid()',
      [role],
    );
    remaining = Number(rows[0]?.remaining ?? Number.NaN);
    if (!Number.isFinite(remaining)) {
      throw new Error(`Backend barrier returned an unusable count for ${role}`);
    }
    if (remaining === 0 || now() >= deadline) break;
    await sleep(pollMs);
  }
  return { terminatedActive: terminatedCount > 0, remaining };
}

/** Restore login only for the explicitly started next worker. */
export async function resumeRole(client: Queryable, role: string): Promise<void> {
  await client.query(`ALTER ROLE ${quoteIdentifier(role)} LOGIN`);
}
