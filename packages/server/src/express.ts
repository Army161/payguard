import { Request, Response, NextFunction } from 'express';
import { 
  PaymentRequirements, 
  PaymentPayloadSchema, 
  AuditLogger,
  RailId
} from '@payguard/core';
import { Store } from '@payguard/store';
import { Rail, Facilitator } from '@payguard/rails';
import crypto from 'node:crypto';

export interface PayGuardOptions {
  store: Store;
  rails: Rail[];
  facilitators: Facilitator[];
  sellerAddress: string;
  asset: string;
  amount: string;
  network: string;
  mode?: 'strict' | 'fast';
  auditLogger: AuditLogger;
}

export function payguard(options: PayGuardOptions) {
  const { store, rails, facilitators, sellerAddress, asset, amount, network, mode = 'strict', auditLogger } = options;

  return async (req: Request, res: Response, next: NextFunction) => {
    const paymentHeader = req.header('PAYMENT');
    const idempotencyKey = req.header('Idempotency-Key');

    // Check idempotency first
    if (idempotencyKey) {
      const cachedResponse = await store.getIdempotentResponse(idempotencyKey);
      if (cachedResponse) {
        return res.json(cachedResponse);
      }
    }

    if (!paymentHeader) {
      // Return 402 Payment Required
      const nonce = crypto.randomUUID();
      const requirements: PaymentRequirements = {
        amount,
        asset,
        recipient: sellerAddress,
        network,
        nonce,
        expiry: Math.floor(Date.now() / 1000) + 3600, // 1 hour
        accepts: rails.map(r => ({
          rail: r.id as RailId,
          facilitators: facilitators.map(f => f.id),
        })),
      };

      return res.status(402).json(requirements);
    }

    try {
      const payload = PaymentPayloadSchema.parse(JSON.parse(paymentHeader));
      
      // 1. Claim Nonce
      const nonceClaimed = await store.claimNonce(payload.requirementHash, 3600);
      if (!nonceClaimed) {
        return res.status(402).json({ error: 'REPLAY_DETECTED' });
      }

      // 2. Find Facilitator
      const facilitator = facilitators.find(f => f.id === payload.facilitator);
      if (!facilitator) {
        return res.status(400).json({ error: 'UNSUPPORTED_FACILITATOR' });
      }

      // 3. Verify and Settle
      // In a real scenario, we'd verify the payload matches the requirements hash
      const settleResult = await facilitator.settle(payload, {} as any);
      if (!settleResult.success || !settleResult.txHash) {
        return res.status(402).json({ error: 'SETTLEMENT_FAILED', detail: settleResult.error });
      }

      // 4. Independent Chain Verification (Strict Mode)
      if (mode === 'strict') {
        const rail = rails.find(r => r.id === payload.rail);
        if (!rail) {
          return res.status(400).json({ error: 'UNSUPPORTED_RAIL' });
        }

        const chainVerify = await rail.verifyOnChain(settleResult.txHash, {
          to: sellerAddress,
          asset,
          amount,
          network,
        });

        if (!chainVerify.valid) {
          return res.status(402).json({ error: 'CHAIN_VERIFICATION_FAILED', reason: chainVerify.reason });
        }
      }

      // 5. Audit
      const auditEntry = auditLogger.createEntry({
        id: crypto.randomUUID(),
        agentId: 'unknown', // Would come from auth or payload
        counterparty: sellerAddress,
        rail: payload.rail,
        amount,
        facilitator: payload.facilitator,
        decision: { type: 'allow' },
        proof: settleResult.txHash,
      });
      await store.appendAudit(auditEntry);

      // 6. Idempotency Store (Wrap next() and capture response)
      // For this slice, we'll just call next()
      // Real impl would use a response interceptor
      
      next();
    } catch (e) {
      return res.status(400).json({ error: 'INVALID_PAYMENT_PAYLOAD' });
    }
  };
}
