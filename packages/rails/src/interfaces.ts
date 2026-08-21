import { VerifyResult, SettleResult, Health, PaymentPayload, PaymentRequirements } from '@payguard/core';

export interface Rail {
  id: string;
  verifyOnChain(txHash: string, expect: {
    to: string;
    asset: string;
    amount: string;
    network: string;
  }, confirmations?: number): Promise<VerifyResult>;
}

export interface Facilitator {
  id: string;
  verify(payload: PaymentPayload, req: PaymentRequirements): Promise<VerifyResult>;
  settle(payload: PaymentPayload, req: PaymentRequirements): Promise<SettleResult>;
  health(): Promise<Health>;
}
