import { PayGuardError } from '../errors.js';
import { isExactEvmPayload, type PaymentPayload } from '../x402/payload.js';
import type { PaymentRequirements } from '../x402/requirements.js';

export interface ValidityWindow {
  /** Epoch milliseconds the payload becomes valid, or null when the payload does not say. */
  validAfterMs: number | null;
  /** Epoch milliseconds the payload stops being valid, or null when the payload does not say. */
  validBeforeMs: number | null;
}

export interface ExpiryOptions {
  /** Current time in epoch milliseconds. */
  nowMs: number;
  /**
   * How far the buyer's clock may differ from ours before we refuse. Enforced server side, per
   * FR-2.4, so a buyer cannot widen its own window by lying about the time.
   */
  clockSkewToleranceMs?: number;
  /**
   * The longest validity window we accept regardless of what the payload claims. A payload valid
   * for a year is a standing authorization, not a payment for one request.
   */
  maxValidityWindowMs?: number;
}

export const DEFAULT_CLOCK_SKEW_TOLERANCE_MS = 60_000;
export const DEFAULT_MAX_VALIDITY_WINDOW_MS = 3_600_000;

/**
 * The window an `exact` EVM payload declares. Opaque transaction payloads (XRPL, Solana) carry no
 * window of their own, so both bounds come back null and the requirements supply the timeout.
 */
export function payloadValidityWindow(payload: PaymentPayload): ValidityWindow {
  if (!isExactEvmPayload(payload.payload)) {
    return { validAfterMs: null, validBeforeMs: null };
  }
  const { validAfter, validBefore } = payload.payload.authorization;
  return {
    validAfterMs: Number(BigInt(validAfter) * 1000n),
    validBeforeMs: Number(BigInt(validBefore) * 1000n),
  };
}

/**
 * Refuses a payload that has expired, has not started, or claims an unreasonably long window.
 * Throws a PayGuardError with a reason code rather than returning a boolean, because there is no
 * caller that should continue past a failure here.
 */
export function assertWithinValidity(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  options: ExpiryOptions,
): void {
  const skew = options.clockSkewToleranceMs ?? DEFAULT_CLOCK_SKEW_TOLERANCE_MS;
  const maxWindow = options.maxValidityWindowMs ?? DEFAULT_MAX_VALIDITY_WINDOW_MS;
  const now = options.nowMs;
  const { validAfterMs, validBeforeMs } = payloadValidityWindow(payload);

  if (validAfterMs !== null && validAfterMs > now + skew) {
    throw new PayGuardError('payload_not_yet_valid', 'payment payload is not valid yet', {
      validAfterMs,
      nowMs: now,
      clockSkewToleranceMs: skew,
    });
  }

  if (validBeforeMs !== null && validBeforeMs < now - skew) {
    throw new PayGuardError('payload_expired', 'payment payload has expired', {
      validBeforeMs,
      nowMs: now,
      clockSkewToleranceMs: skew,
    });
  }

  if (validAfterMs !== null && validBeforeMs !== null) {
    const declared = validBeforeMs - validAfterMs;
    if (declared > maxWindow) {
      throw new PayGuardError(
        'clock_skew_exceeded',
        'payment payload declares a validity window longer than this seller accepts',
        { declaredWindowMs: declared, maxValidityWindowMs: maxWindow },
      );
    }
  }

  const timeoutMs = requirements.maxTimeoutSeconds * 1000;
  if (validBeforeMs === null && timeoutMs > maxWindow) {
    throw new PayGuardError(
      'clock_skew_exceeded',
      'payment requirements declare a timeout longer than this seller accepts',
      { maxTimeoutSeconds: requirements.maxTimeoutSeconds, maxValidityWindowMs: maxWindow },
    );
  }
}

/**
 * How long a nonce claim must live. FR-2.1 requires the TTL to be at least the maximum payment
 * validity window, otherwise a payload outlives the record that says it was already used and
 * becomes replayable.
 */
export function nonceTtlMs(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  options: ExpiryOptions,
): number {
  const skew = options.clockSkewToleranceMs ?? DEFAULT_CLOCK_SKEW_TOLERANCE_MS;
  const timeoutMs = requirements.maxTimeoutSeconds * 1000;
  const { validBeforeMs } = payloadValidityWindow(payload);
  const remaining = validBeforeMs === null ? 0 : validBeforeMs - options.nowMs;
  return Math.max(timeoutMs, remaining, 0) + skew;
}
