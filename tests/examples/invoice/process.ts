import { randomUUID } from 'node:crypto';
import { Queue, type Job } from 'bullmq';
import { Client } from 'pg';
import { z } from 'zod';

const InvoiceData = z.object({
  operationKey: z.string().regex(/^[a-z0-9-]{1,80}$/),
  recipient: z.string().min(1).max(128),
}).strict();

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing test configuration: ${name}`);
  return value;
}

/**
 * A deliberately small synthetic processor: it records the invoice, calls the simulator, queues one
 * follow-up business job and completes the invoice. `stableProviderKey` is the only difference
 * between the buggy and corrected fixtures.
 */
export async function processInvoice(job: Job, stableProviderKey: boolean): Promise<{ operationKey: string }> {
  const data = InvoiceData.parse(job.data);
  const db = new Client({ connectionString: required('DATABASE_URL'), connectionTimeoutMillis: 5_000 });
  const reminders = new Queue('reminders', {
    prefix: required('QUEUE_PREFIX'),
    connection: {
      host: required('REDIS_HOST'), port: 6379, password: required('REDIS_PASSWORD'),
      maxRetriesPerRequest: null,
    },
  });
  try {
    await db.connect();
    const operation = await db.query(
      'SELECT operation_key FROM operations WHERE operation_key = $1', [data.operationKey],
    );
    if (operation.rowCount !== 1) throw new Error('Missing fixture operation');
    await db.query(
      "INSERT INTO invoices(operation_key,status) VALUES ($1,'created') ON CONFLICT DO NOTHING",
      [data.operationKey],
    );
    const response = await fetch(new URL('/effects/email', required('PROVIDER_URL')), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': stableProviderKey ? data.operationKey : randomUUID(),
      },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Simulator returned ${response.status}`);
    await response.arrayBuffer();
    await reminders.add('reminder', { operationKey: data.operationKey }, {
      jobId: `reminder-${data.operationKey}`, removeOnComplete: false,
    });
    await db.query("UPDATE invoices SET status='complete' WHERE operation_key=$1", [data.operationKey]);
    return { operationKey: data.operationKey };
  } finally {
    await Promise.all([db.end(), reminders.close()]);
  }
}
