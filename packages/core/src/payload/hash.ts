import { createHash } from 'node:crypto';
import { canonicalize } from './canonical.js';
import type { PaymentPayload } from '../x402/payload.js';
import type { PaymentRequirements } from '../x402/requirements.js';

/**
 * The identity of a payment attempt. It binds the payload to the exact requirements it was signed
 * against, so the same signed authorization presented against a different price or a different
 * recipient is a different id and cannot reuse the first one's settlement.
 *
 * FR-4.4 needs this id to be stable across facilitators, which is why it is derived from the
 * payload and requirements only and never from a facilitator response.
 */
export function paymentId(payload: PaymentPayload, requirements: PaymentRequirements): string {
  return sha256Hex(canonicalize({ payload, requirements }));
}

/** The identity of the signed payload alone, used to dedupe settlement across facilitators. */
export function payloadHash(payload: PaymentPayload): string {
  return sha256Hex(canonicalize(payload));
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
