import type { PaymentPayload, PaymentRequirements, RailId } from '@payguard/core';
import { FacilitatorError, type Facilitator, type HealthMonitor } from '@payguard/rails';
import type { SettleResponse, VerifyResponse } from '@payguard/core';

export interface SettlementAttempt {
  facilitatorId: string;
  stage: 'verify' | 'settle';
  error: FacilitatorError;
}

export type SettlementResult =
  | {
      ok: true;
      facilitatorId: string;
      verify: VerifyResponse;
      settle: SettleResponse;
      attempts: SettlementAttempt[];
    }
  | {
      ok: false;
      kind: 'rejected';
      facilitatorId: string;
      verify: VerifyResponse;
      attempts: SettlementAttempt[];
    }
  | {
      ok: false;
      kind: 'settle_failed';
      facilitatorId: string;
      settle: SettleResponse;
      attempts: SettlementAttempt[];
    }
  | { ok: false; kind: 'no_facilitator'; attempts: SettlementAttempt[] };

/**
 * Runs verify then settle, moving to the next healthy facilitator only when the current one fails
 * in a way that another facilitator could succeed at.
 *
 * A facilitator that says "this payload is invalid" has answered the question. Retrying that
 * against a second facilitator is not failover, it is shopping for a yes, and it is how a bad
 * payload eventually finds a lenient verifier. So a rejection stops the loop, and only transport
 * level failures move on.
 *
 * Settling the same signed payload twice cannot double charge: the payload carries a single-use
 * on-chain nonce, so the second settlement fails at the chain. Even so, a successful settle stops
 * the loop immediately, and the caller has already claimed the payment id before reaching here.
 */
export async function verifyAndSettle(
  monitor: HealthMonitor,
  rail: RailId,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
): Promise<SettlementResult> {
  const attempts: SettlementAttempt[] = [];
  const candidates: Facilitator[] = monitor.available(rail);

  for (const facilitator of candidates) {
    let verify: VerifyResponse;
    try {
      verify = await facilitator.verify(payload, requirements);
      monitor.recordSuccess(facilitator.id);
    } catch (error) {
      monitor.recordFailure(facilitator.id, error);
      if (error instanceof FacilitatorError) {
        attempts.push({ facilitatorId: facilitator.id, stage: 'verify', error });
        if (error.isRetryableElsewhere) continue;
        return { ok: false, kind: 'no_facilitator', attempts };
      }
      throw error;
    }

    if (!verify.isValid) {
      return { ok: false, kind: 'rejected', facilitatorId: facilitator.id, verify, attempts };
    }

    let settle: SettleResponse;
    try {
      settle = await facilitator.settle(payload, requirements);
      monitor.recordSuccess(facilitator.id);
    } catch (error) {
      monitor.recordFailure(facilitator.id, error);
      if (error instanceof FacilitatorError) {
        attempts.push({ facilitatorId: facilitator.id, stage: 'settle', error });
        if (error.isRetryableElsewhere) continue;
        return { ok: false, kind: 'no_facilitator', attempts };
      }
      throw error;
    }

    if (!settle.success) {
      return { ok: false, kind: 'settle_failed', facilitatorId: facilitator.id, settle, attempts };
    }

    return { ok: true, facilitatorId: facilitator.id, verify, settle, attempts };
  }

  return { ok: false, kind: 'no_facilitator', attempts };
}
