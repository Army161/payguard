import { describe, it, expect, beforeEach } from 'vitest';
import { SQLiteStore } from './sqlite.js';
import { AuditEntry } from '@payguard/core';

describe('Store Contract Tests (SQLite)', () => {
  let store: SQLiteStore;

  beforeEach(() => {
    store = new SQLiteStore(':memory:');
  });

  it('should claim a nonce once', async () => {
    const key = 'test-nonce';
    expect(await store.claimNonce(key, 60)).toBe(true);
    expect(await store.claimNonce(key, 60)).toBe(false);
  });

  it('should handle idempotency', async () => {
    const key = 'test-idem';
    const response = { foo: 'bar' };
    
    expect(await store.getIdempotentResponse(key)).toBe(null);
    await store.setIdempotentResponse(key, response, 60);
    expect(await store.getIdempotentResponse(key)).toEqual(response);
  });

  it('should append and retrieve audit logs', async () => {
    const entry: AuditEntry = {
      id: '1',
      prevHash: '0',
      hash: 'h1',
      timestamp: Date.now(),
      agentId: 'a1',
      counterparty: 'c1',
      rail: 'base:usdc',
      amount: '100',
      facilitator: 'f1',
      decision: { type: 'allow' },
    };

    await store.appendAudit(entry);
    const logs = await store.getAuditLog();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toEqual(entry);
  });
});
