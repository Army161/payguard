import { describe, it, expect, vi } from 'vitest';
import { payguard } from './express.js';
import { SQLiteStore } from '@payguard/store';
import { AuditLogger } from '@payguard/core';

describe('Express Middleware', () => {
  it('should return 402 if PAYMENT header is missing', async () => {
    const store = new SQLiteStore(':memory:');
    const auditLogger = new AuditLogger();
    const middleware = payguard({
      store,
      rails: [],
      facilitators: [],
      sellerAddress: '0x123',
      asset: 'USDC',
      amount: '10',
      network: 'base-sepolia',
      auditLogger,
    });

    const req = { header: vi.fn().mockReturnValue(undefined) } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    const next = vi.fn();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      amount: '10',
      nonce: expect.any(String),
    }));
  });
});
