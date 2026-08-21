import { describe, it, expect, vi } from 'vitest';
import { PayGuardClient } from './client.js';
import { LocalSigner } from './signer.js';

describe('PayGuard Client', () => {
  it('should sign a payment if policy allows', async () => {
    const signer = new LocalSigner('0x123');
    const client = new PayGuardClient({
      signer,
      policyConfig: {
        maxPerTx: BigInt(1000),
        dailyCap: BigInt(5000),
        hourlyCap: BigInt(2000),
        maxVelocity: 10,
      },
    });

    const req = {
      amount: '100',
      asset: 'USDC',
      recipient: '0xabc',
      network: 'base-sepolia',
      nonce: 'n1',
      expiry: Date.now() + 3600,
      accepts: [{ rail: 'base:usdc', facilitators: ['coinbase'] }],
    } as any;

    const payload = await client.requestPayment(req, { dailyTotal: BigInt(0), hourlyTotal: BigInt(0) });
    expect(payload.requirementHash).toBeDefined();
    expect(payload.rail).toBe('base:usdc');
  });

  it('should throw if daily cap exceeded', async () => {
    const signer = new LocalSigner('0x123');
    const client = new PayGuardClient({
      signer,
      policyConfig: {
        maxPerTx: BigInt(1000),
        dailyCap: BigInt(5000),
        hourlyCap: BigInt(2000),
        maxVelocity: 10,
      },
    });

    const req = {
      amount: '1000',
      asset: 'USDC',
      recipient: '0xabc',
      network: 'base-sepolia',
      nonce: 'n1',
      expiry: Date.now() + 3600,
      accepts: [{ rail: 'base:usdc', facilitators: ['coinbase'] }],
    } as any;

    await expect(client.requestPayment(req, { dailyTotal: BigInt(5000), hourlyTotal: BigInt(0) }))
      .rejects.toThrow('POLICY_DENIED: DAILY_CAP_EXCEEDED');
  });
});
