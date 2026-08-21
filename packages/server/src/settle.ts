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
      const failure = asFacilitatorError(facilitator.id, 'verify', error);
      monitor.recordFailure(facilitator.id, failure);
      attempts.push({ facilitatorId: facilitator.id, stage: 'verify', error: failure });
      if (failure.isRetryableElsewhere) continue;
      return { ok: false, kind: 'no_facilitator', attempts };
    }

    if (!verify.isValid) {
      return { ok: false, kind: 'rejected', facilitatorId: facilitator.id, verify, attempts };
    }

    let settle: SettleResponse;
    try {
      settle = await facilitator.settle(payload, requirements);
      monitor.recordSuccess(facilitator.id);
    } catch (error) {
      const failure = asFacilitatorError(facilitator.id, 'settle', error);
      monitor.recordFailure(facilitator.id, failure);
      attempts.push({ facilitatorId: facilitator.id, stage: 'settle', error: failure });
      if (failure.isRetryableElsewhere) continue;
      return { ok: false, kind: 'no_facilitator', attempts };
    }

    if (!settle.success) {
      return { ok: false, kind: 'settle_failed', facilitatorId: facilitator.id, settle, attempts };
    }

    return { ok: true, facilitatorId: facilitator.id, verify, settle, attempts };
  }

  return { ok: false, kind: 'no_facilitator', attempts };
}

/**
 * A facilitator adapter is third party code reaching a third party service, so it can throw
 * anything: a TypeError from an SDK, an AggregateError from a DNS lookup, a string. Letting an
 * untyped throw escape would turn one misbehaving facilitator into a 500 on the seller's endpoint,
 * which is a denial of service the buyer did not have to work for. Everything unrecognised is
 * treated as a transport failure of that one facilitator, so the router moves on.
 */
function asFacilitatorError(
  facilitatorId: string,
  stage: 'verify' | 'settle',
  error: unknown,
): FacilitatorError {
  if (error instanceof FacilitatorError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new FacilitatorError(
    'network',
    facilitatorId,
    `facilitator ${facilitatorId} threw an unrecognised error during ${stage}: ${message}`,
  );
}
