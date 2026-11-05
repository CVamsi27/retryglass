import { spawn } from 'node:child_process';
import type { Job } from 'bullmq';
import { processInvoice } from './process.js';

/** Synthetic negative: unsupported work appears only on the retried execution. */
export default async function retryUnsupported(job: Job): Promise<unknown> {
  if (job.attemptsStarted > 1) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error('Synthetic subprocess failed')));
    });
  }
  return processInvoice(job, true);
}
