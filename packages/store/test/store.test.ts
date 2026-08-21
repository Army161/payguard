import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fixedClock, verifyChain } from '@payguard/core';
import { MemoryStore, createStore } from '@payguard/store';
import { SqliteStore } from '../src/sqlite.js';
import { runStoreContract } from './contract.js';

const dir = mkdtempSync(join(tmpdir(), 'payguard-store-'));
let counter = 0;

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

runStoreContract('MemoryStore', { create: async () => new MemoryStore() });

runStoreContract('SqliteStore (on disk)', {
  create: async () => {
    counter += 1;
    return new SqliteStore({ path: join(dir, `store-${counter}.sqlite`) });
  },
});

describe('ttl behaviour', () => {
  it('memory store releases a claim once the ttl passes', async () => {
    const clock = fixedClock(0);
    const store = new MemoryStore({ clock });
    expect(await store.claimNonce('k', 1000)).toBe(true);
    clock.advance(999);
    expect(await store.claimNonce('k', 1000)).toBe(false);
    clock.advance(2);
    expect(await store.hasNonce('k')).toBe(false);
    expect(await store.claimNonce('k', 1000)).toBe(true);
    await store.close();
  });

  it('sqlite store releases a claim once the ttl passes', async () => {
    const clock = fixedClock(0);
    const store = new SqliteStore({ path: ':memory:', clock });
    expect(await store.claimNonce('k', 1000)).toBe(true);
    clock.advance(999);
    expect(await store.claimNonce('k', 1000)).toBe(false);
    clock.advance(2);
    expect(await store.hasNonce('k')).toBe(false);
    expect(await store.claimNonce('k', 1000)).toBe(true);
    await store.close();
  });

  it('memory store expires a cached idempotent response', async () => {
    const clock = fixedClock(0);
    const store = new MemoryStore({ clock });
    await store.putIdempotent(
      'k',
      { status: 200, headers: {}, bodyBase64: '', paymentId: 'p', storedAtMs: 0 },
      1000,
    );
    clock.advance(1001);
    expect(await store.getIdempotent('k')).toBeNull();
    expect(
      await store.putIdempotent(
        'k',
        { status: 201, headers: {}, bodyBase64: '', paymentId: 'p', storedAtMs: 0 },
        1000,
      ),
    ).toBe(true);
    await store.close();
  });

  it('sqlite store expires a cached idempotent response', async () => {
    const clock = fixedClock(0);
    const store = new SqliteStore({ path: ':memory:', clock });
    await store.putIdempotent(
      'k',
      { status: 200, headers: {}, bodyBase64: '', paymentId: 'p', storedAtMs: 0 },
      1000,
    );
    clock.advance(1001);
    expect(await store.getIdempotent('k')).toBeNull();
    await store.close();
  });

  it('sqlite vacuum removes rows that have already expired', async () => {
    const clock = fixedClock(0);
    const store = new SqliteStore({ path: ':memory:', clock });
    await store.claimNonce('k', 1000);
    clock.advance(2000);
    store.vacuumExpired();
    expect(await store.claimNonce('k', 1000)).toBe(true);
    await store.close();
  });
});

describe('store factory', () => {
  it('builds a memory store', async () => {
    const store = await createStore({ kind: 'memory' });
    expect(store).toBeInstanceOf(MemoryStore);
    await store.close();
  });

  it('builds a sqlite store on disk', async () => {
    const path = join(dir, 'factory.sqlite');
    const store = await createStore({ kind: 'sqlite', path });
    expect(await store.claimNonce('k', 1000)).toBe(true);
    await store.close();
  });

  it('a sqlite store survives a reopen, so a restart does not forget a nonce', async () => {
    const path = join(dir, 'persist.sqlite');
    const first = await createStore({ kind: 'sqlite', path });
    expect(await first.claimNonce('k', 60_000)).toBe(true);
    await first.appendAudit({
      requestId: 'r',
      agentId: null,
      counterparty: null,
      rail: null,
      network: null,
      amount: null,
      asset: null,
      facilitator: null,
      mode: null,
      stage: 'policy',
      outcome: 'allowed',
      reason: null,
      message: 'first run',
      transactionHash: null,
      paymentId: null,
      timestampMs: 1,
    });
    await first.close();

    const second = await createStore({ kind: 'sqlite', path });
    expect(await second.claimNonce('k', 60_000)).toBe(false);
    const entries = await second.readAudit();
    expect(entries).toHaveLength(1);
    expect(verifyChain(entries).ok).toBe(true);
    await second.close();
  });
});
