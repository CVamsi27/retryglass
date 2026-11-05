import type { Job } from 'bullmq';
import { processInvoice } from './process.js';

export default (job: Job) => processInvoice(job, false);
