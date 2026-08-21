import { PaymentRequirements, PaymentPayload } from '@payguard/core';
import { createHash } from 'node:crypto';

export interface Signer {
  address(): Promise<string>;
  signPayment(req: PaymentRequirements): Promise<PaymentPayload>;
}

export class LocalSigner implements Signer {
  constructor(private privateKey: string) {
    if (process.env.NODE_ENV === 'production') {
      console.warn('WARNING: LocalSigner with raw private key used in production!');
    }
  }

  async address(): Promise<string> {
    // In a real implementation, derive address from private key
    return '0xmockaddress';
  }

  async signPayment(req: PaymentRequirements): Promise<PaymentPayload> {
    const requirementHash = createHash('sha256').update(JSON.stringify(req)).digest('hex');
    
    // In a real implementation, this would involve signing the hash
    // and interacting with a facilitator to get the proof.
    // For this slice, we return a mock payload.
    
    return {
      requirementHash,
      rail: req.accepts[0].rail,
      facilitator: req.accepts[0].facilitators[0],
      proof: { signature: '0xmocksignature' },
      timestamp: Date.now(),
    };
  }
}
