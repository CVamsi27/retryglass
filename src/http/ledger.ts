import { createHash, randomUUID } from 'node:crypto';
import type { AppliedOperation, HttpAttempt } from '../contracts.js';

export interface ProviderProfile {
  idempotent: boolean;
  loseFirstAcknowledgement: boolean;
  maxAttempts?: number;
}

export interface EffectPayload { operationKey: string; recipient: string; }
export interface LedgerSnapshot {
  httpAttempts: HttpAttempt[];
  appliedOperations: AppliedOperation[];
  issues: string[];
}

export class EffectLedger {
  readonly #profile: ProviderProfile;
  readonly #attempts: HttpAttempt[] = [];
  readonly #applied: AppliedOperation[] = [];
  readonly #keys = new Map<string, AppliedOperation>();
  readonly #issues: string[] = [];
  #acknowledgementLost = false;

  constructor(profile: ProviderProfile) {
    this.#profile = profile;
  }

  issue(message: string): void {
    if (!this.#issues.includes(message) && this.#issues.length < 20) this.#issues.push(message);
  }

  accept(payload: EffectPayload, idempotencyKey: string | null): {
    status: 200 | 409 | 429; loseResponse: boolean; operationId?: string;
  } {
    if (this.#attempts.length >= (this.#profile.maxAttempts ?? 100)) {
      this.issue('HTTP attempt limit exceeded');
      return { status: 429, loseResponse: false };
    }
    const payloadDigest = createHash('sha256').update(JSON.stringify({
      operationKey: payload.operationKey, recipient: payload.recipient,
    })).digest('hex');
    const prior = this.#profile.idempotent && idempotencyKey ? this.#keys.get(idempotencyKey) : undefined;
    const attempt: HttpAttempt = {
      attemptId: randomUUID(), operationKey: payload.operationKey, idempotencyKey, payloadDigest,
      response: 'success',
    };
    this.#attempts.push(attempt);
    if (prior && prior.payloadDigest !== payloadDigest) {
      attempt.response = 'rejected';
      return { status: 409, loseResponse: false };
    }
    let operation = prior;
    if (!operation) {
      operation = { operationId: randomUUID(), operationKey: payload.operationKey, idempotencyKey, payloadDigest };
      this.#applied.push(operation);
      if (this.#profile.idempotent && idempotencyKey) this.#keys.set(idempotencyKey, operation);
    }
    const loseResponse = !this.#acknowledgementLost && this.#profile.loseFirstAcknowledgement;
    if (loseResponse) {
      this.#acknowledgementLost = true;
      attempt.response = 'accepted_response_lost';
    }
    return { status: 200, loseResponse, operationId: operation.operationId };
  }

  snapshot(): LedgerSnapshot {
    return structuredClone({ httpAttempts: this.#attempts, appliedOperations: this.#applied, issues: this.#issues });
  }
}
