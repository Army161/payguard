import type { PaymentPayload, PaymentRequirements } from '@payguard/core';

/**
 * The only door between PayGuard and a private key, and PayGuard is on the wrong side of it.
 *
 * A Signer returns a signed payload. It never hands back a key, a seed, a mnemonic, or anything a
 * key can be derived from, and no PayGuard code path asks for one. That is what makes the
 * non-custodial claim in docs/compliance-posture.md a property of the code rather than a promise.
 */
export interface Signer {
  /** The address this signer pays from. */
  address(): Promise<string>;
  /** Signs a payment for the given requirements, locally. */
  signPayment(requirements: PaymentRequirements): Promise<PaymentPayload>;
}

export class SignerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignerError';
  }
}
