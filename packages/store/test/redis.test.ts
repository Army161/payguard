import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { fixedClock, verifyChain } from '@payguard/core';
import { RedisStore } from '../src/redis.js';
import { runStoreContract } from './contract.js';

/**
 * The Redis store is the one that has to survive multiple processes, so testing it against a fake
 * would test the fake. This boots a real redis-server on a unix socket when the binary is present
 * (CI installs it), and otherwise skips with a visible message rather than passing quietly.
 */
const dir = mkdtempSync(join(tmpdir(), 'payguard-redis-'));
const socket = join(dir, 'redis.sock');
let server: ChildProcess | null = null;
let available = false;

async function waitForSocket(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const probe = new Redis({ path: socket, lazyConnect: true, retryStrategy: () => null });
      // Attempts before the server binds are expected; swallow them so the run stays readable.
      probe.on('error', () => {});
      await probe.connect();
      await probe.ping();
      await probe.quit();
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  return false;
}

beforeAll(async () => {
  try {
    server = spawn(
      'redis-server',
      ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'],
      { stdio: 'ignore' },
    );
    server.on('error', () => {
      available = false;
    });
    available = await waitForSocket(10_000);
  } catch {
    available = false;
  }
}, 20_000);

afterAll(async () => {
  server?.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

function client(): Redis {
  return new Redis({ path: socket, maxRetriesPerRequest: 2 });
}

let namespace = 0;

describe.runIf(true)('RedisStore', () => {
  it('the test redis is reachable, otherwise the suite below proves nothing', () => {
    expect(available, 'redis-server did not start; install redis to run this suite').toBe(true);
  });
});

runStoreContract('RedisStore', {
  create: async () => {
    namespace += 1;
    return new RedisStore({ client: client(), keyPrefix: `pgtest:${namespace}:` });
  },
});

describe('RedisStore specifics', () => {
  it('expires a nonce claim after the ttl, without a sweeper', async () => {
    const store = new RedisStore({ client: client(), keyPrefix: 'pgttl:' });
    expect(await store.claimNonce('k', 60)).toBe(true);
    expect(await store.claimNonce('k', 60)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(await store.claimNonce('k', 60)).toBe(true);
    await store.close();
  });

  it('rounds a sub-millisecond ttl up rather than asking Redis for zero', async () => {
    const store = new RedisStore({ client: client(), keyPrefix: 'pground:' });
    expect(await store.claimNonce('k', 0.2)).toBe(true);
    await store.close();
  });

  it('keeps the chain verifiable when two stores append to the same log', async () => {
    const prefix = 'pgshared:';
    const a = new RedisStore({ client: client(), keyPrefix: prefix });
    const b = new RedisStore({ client: client(), keyPrefix: prefix });
    const body = (id: string) => ({
      requestId: id,
      agentId: null,
      counterparty: null,
      rail: null,
      network: null,
      amount: null,
      asset: null,
      facilitator: null,
      mode: null,
      stage: 'policy' as const,
      outcome: 'allowed' as const,
      reason: null,
      message: id,
      transactionHash: null,
      paymentId: null,
      timestampMs: 1,
    });
    await Promise.all([
      ...Array.from({ length: 15 }, (_, i) => a.appendAudit(body(`a-${i}`))),
      ...Array.from({ length: 15 }, (_, i) => b.appendAudit(body(`b-${i}`))),
    ]);
    const entries = await a.readAudit();
    expect(entries).toHaveLength(30);
    expect(verifyChain(entries)).toEqual({ ok: true, length: 30 });
    await a.close();
    await b.close();
  });

  it('gives up with a clear message rather than waiting forever for the append lock', async () => {
    const shared = client();
    // Hold the lock from outside, exactly as a stalled peer process would.
    await shared.set('pgcontend:audit:lock', 'someone-else', 'PX', 5000);
    const store = new RedisStore({
      client: client(),
      keyPrefix: 'pgcontend:',
      appendLockWaitMs: 50,
    });
    await expect(
      store.appendAudit({
        requestId: 'x',
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
        message: 'x',
        transactionHash: null,
        paymentId: null,
        timestampMs: 1,
      }),
    ).rejects.toThrow(/could not acquire the audit append lock/);
    await store.close();
    await shared.quit();
  });

  it('releases the append lock so the next writer proceeds immediately', async () => {
    const store = new RedisStore({ client: client(), keyPrefix: 'pgrelease:' });
    const body = (id: string) => ({
      requestId: id,
      agentId: null,
      counterparty: null,
      rail: null,
      network: null,
      amount: null,
      asset: null,
      facilitator: null,
      mode: null,
      stage: 'policy' as const,
      outcome: 'allowed' as const,
      reason: null,
      message: id,
      transactionHash: null,
      paymentId: null,
      timestampMs: 1,
    });
    await store.appendAudit(body('one'));
    await store.appendAudit(body('two'));
    expect(await client().exists('pgrelease:audit:lock')).toBe(0);
    await store.close();
  });

  it('uses the injected clock rather than the wall clock', async () => {
    const clock = fixedClock(12345);
    const store = new RedisStore({ client: client(), keyPrefix: 'pgclock:', clock });
    await store.claimNonce('k', 60_000);
    const raw = await client().get('pgclock:nonce:k');
    expect(raw).toBe('12345');
    await store.close();
  });

  it('refuses to construct without a url or a client', () => {
    expect(() => new RedisStore({})).toThrow(/url or an existing client/);
  });

  it('closes a client it created but leaves a caller supplied one alone', async () => {
    const shared = client();
    const store = new RedisStore({ client: shared, keyPrefix: 'pgown:' });
    await store.close();
    expect(await shared.ping()).toBe('PONG');
    await shared.quit();
  });
});
