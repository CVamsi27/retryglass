import type { Job } from 'bullmq';

/**
 * Negative fixture: the retry reaches the queue again but crashes before touching the database or
 * the provider. A rehearsal must show the failed terminal state, not a passing golden case.
 */
export default (_job: Job): Promise<never> => Promise.reject(new Error('Synthetic crash before useful work'));
