import { describe, expect, it } from 'vitest';
import { verifyChain, type AuditBody, type IdempotentResponse, type Store } from '@payguard/core';

export interface StoreHarness {
  create(): Promise<Store>;
}

const body = (overrides: Partial<AuditBody> = {}): AuditBody => ({
  requestId: 'req-1',
  agentId: 'agent-1',
  counterparty: '0xseller',
  rail: 'base:usdc',
  network: 'base-sepolia',
  amount: '10000',
  asset: '0xusdc',
  facilitator: 'coinbase',
  mode: 'strict',
  stage: 'release',
  outcome: 'allowed',
  reason: null,
  message: 'released',
  transactionHash: '0xabc',
  paymentId: 'a'.repeat(64),
  timestampMs: 1_700_000_000_000,
  ...overrides,
});

const response = (status = 200): IdempotentResponse => ({
  status,
  headers: { 'content-type': 'application/json' },
  bodyBase64: Buffer.from('{"ok":true}', 'utf8').toString('base64'),
  paymentId: 'b'.repeat(64),
  storedAtMs: 1_700_000_000_000,
});

/**
 * Every Store implementation must pass this suite unchanged. The point is that swapping SQLite for
 * Redis cannot quietly weaken the guarantees the middleware relies on.
 */
export function runStoreContract(name: string, harness: StoreHarness): void {
  describe(`Store contract: ${name}`, () => {
    it('grants a nonce claim exactly once', async () => {
      const store = await harness.create();
      expect(await store.claimNonce('k1', 60_000)).toBe(true);
      expect(await store.claimNonce('k1', 60_000)).toBe(false);
      await store.close();
    });

    it('grants exactly one winner among many concurrent claims, per FR-2.3', async () => {
      const store = await harness.create();
      const attempts = await Promise.all(
        Array.from({ length: 50 }, () => store.claimNonce('race', 60_000)),
      );
      expect(attempts.filter(Boolean)).toHaveLength(1);
      await store.close();
    });

    it('keeps distinct keys independent', async () => {
      const store = await harness.create();
      expect(await store.claimNonce('a', 60_000)).toBe(true);
      expect(await store.claimNonce('b', 60_000)).toBe(true);
      await store.close();
    });

    it('reports whether a key is claimed', async () => {
      const store = await harness.create();
      expect(await store.hasNonce('k')).toBe(false);
      await store.claimNonce('k', 60_000);
      expect(await store.hasNonce('k')).toBe(true);
      await store.close();
    });

    it('allows a re-claim after the claim is released', async () => {
      const store = await harness.create();
      await store.claimNonce('k', 60_000);
      await store.releaseNonce('k');
      expect(await store.hasNonce('k')).toBe(false);
      expect(await store.claimNonce('k', 60_000)).toBe(true);
      await store.close();
    });

    it('releasing an unclaimed key is not an error', async () => {
      const store = await harness.create();
      await expect(store.releaseNonce('never-claimed')).resolves.toBeUndefined();
      await store.close();
    });

    it('returns null for an unknown idempotency key', async () => {
      const store = await harness.create();
      expect(await store.getIdempotent('missing')).toBeNull();
      await store.close();
    });

    it('stores and replays a response against an idempotency key', async () => {
      const store = await harness.create();
      expect(await store.putIdempotent('idem-1', response(), 60_000)).toBe(true);
      expect(await store.getIdempotent('idem-1')).toEqual(response());
      await store.close();
    });

    it('refuses to overwrite a live idempotency key, so a retry cannot re-charge', async () => {
      const store = await harness.create();
      await store.putIdempotent('idem-1', response(200), 60_000);
      expect(await store.putIdempotent('idem-1', response(500), 60_000)).toBe(false);
      expect((await store.getIdempotent('idem-1'))?.status).toBe(200);
      await store.close();
    });

    it('starts the audit chain at sequence zero', async () => {
      const store = await harness.create();
      const entry = await store.appendAudit(body());
      expect(entry.seq).toBe(0);
      expect(entry.prevHash).toBe('0'.repeat(64));
      await store.close();
    });

    it('links appended entries into a verifiable chain', async () => {
      const store = await harness.create();
      for (let i = 0; i < 10; i += 1) {
        await store.appendAudit(body({ requestId: `req-${i}` }));
      }
      const entries = await store.readAudit();
      expect(entries).toHaveLength(10);
      expect(verifyChain(entries)).toEqual({ ok: true, length: 10 });
      await store.close();
    });

    it('produces a verifiable chain even when appends are concurrent', async () => {
      const store = await harness.create();
      await Promise.all(
        Array.from({ length: 25 }, (_, i) => store.appendAudit(body({ requestId: `c-${i}` }))),
      );
      const entries = await store.readAudit();
      expect(entries).toHaveLength(25);
      expect(verifyChain(entries)).toEqual({ ok: true, length: 25 });
      await store.close();
    });

    it('reads from a sequence offset and honours a limit', async () => {
      const store = await harness.create();
      for (let i = 0; i < 5; i += 1) {
        await store.appendAudit(body({ requestId: `req-${i}` }));
      }
      expect(await store.readAudit({ fromSeq: 3 })).toHaveLength(2);
      expect(await store.readAudit({ limit: 2 })).toHaveLength(2);
      expect((await store.readAudit({ fromSeq: 2, limit: 1 }))[0]?.seq).toBe(2);
      await store.close();
    });

    it('returns an empty chain before anything is appended', async () => {
      const store = await harness.create();
      expect(await store.readAudit()).toEqual([]);
      await store.close();
    });
  });
}
