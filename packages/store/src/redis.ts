import { Redis } from 'ioredis';
import {
  GENESIS_HASH,
  hashEntry,
  systemClock,
  type AuditBody,
  type AuditEntry,
  type Clock,
  type IdempotentResponse,
  type Store,
} from '@payguard/core';

/**
 * Appends one entry, but only if the chain is still where the caller last saw it.
 *
 * KEYS[1] audit list, KEYS[2] tail hash key
 * ARGV[1] expected length, ARGV[2] expected tail hash, ARGV[3] genesis hash,
 * ARGV[4] serialized entry, ARGV[5] new tail hash
 *
 * Returns 1 on success and 0 when the chain moved underneath the caller. The hash cannot be
 * computed here because Redis Lua ships sha1 only, so the caller computes it and this script
 * proves the assumptions it computed against still hold.
 */
const APPEND_SCRIPT = `
local seq = redis.call('LLEN', KEYS[1])
local prev = redis.call('GET', KEYS[2])
if prev == false then prev = ARGV[3] end
if tonumber(ARGV[1]) ~= seq or ARGV[2] ~= prev then
  return 0
end
redis.call('RPUSH', KEYS[1], ARGV[4])
redis.call('SET', KEYS[2], ARGV[5])
return 1
`;

/** Releases a lock only if this caller still owns it, so a slow writer cannot free someone else's. */
const UNLOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export interface RedisStoreOptions {
  /** A connection string, or an ioredis client the caller owns. */
  url?: string;
  client?: Redis;
  keyPrefix?: string;
  clock?: Clock;
  /** How long to wait for the audit append lock before giving up, in milliseconds. */
  appendLockWaitMs?: number;
  /** How long the append lock lives, so a crashed writer cannot wedge the chain forever. */
  appendLockTtlMs?: number;
}

/**
 * Multi-process production store.
 *
 * The nonce claim is `SET key value NX PX ttl`, atomic across every client connected to the same
 * Redis. That single operation is what makes AT-3 hold with fifty concurrent requests spread over
 * several processes, where an in-memory map cannot help.
 *
 * The audit append is different. A hash chain is inherently sequential: the next hash depends on
 * the previous one, and Redis Lua has no sha256, so the link cannot be computed server side. An
 * optimistic read-compute-compare-and-swap loop does not converge here, because with N concurrent
 * appenders only one wins per round. So appends take a short lived distributed lock and serialize.
 * The compare-and-swap inside the Lua script stays as a second line of defence for the case where
 * the lock expires under a stalled writer.
 */
export class RedisStore implements Store {
  private readonly redis: Redis;
  private readonly ownsClient: boolean;
  private readonly prefix: string;
  private readonly clock: Clock;
  private readonly appendLockWaitMs: number;
  private readonly appendLockTtlMs: number;
  private lockCounter = 0;

  constructor(options: RedisStoreOptions) {
    if (options.client !== undefined) {
      this.redis = options.client;
      this.ownsClient = false;
    } else if (options.url !== undefined) {
      this.redis = new Redis(options.url);
      this.ownsClient = true;
    } else {
      throw new Error('RedisStore requires either a url or an existing client');
    }
    this.prefix = options.keyPrefix ?? 'payguard:';
    this.clock = options.clock ?? systemClock;
    this.appendLockWaitMs = options.appendLockWaitMs ?? 5000;
    this.appendLockTtlMs = options.appendLockTtlMs ?? 5000;
  }

  private key(...parts: string[]): string {
    return `${this.prefix}${parts.join(':')}`;
  }

  async claimNonce(key: string, ttlMs: number): Promise<boolean> {
    const result = await this.redis.set(
      this.key('nonce', key),
      String(this.clock.now()),
      'PX',
      Math.max(1, Math.ceil(ttlMs)),
      'NX',
    );
    return result === 'OK';
  }

  async releaseNonce(key: string): Promise<void> {
    await this.redis.del(this.key('nonce', key));
  }

  async hasNonce(key: string): Promise<boolean> {
    return (await this.redis.exists(this.key('nonce', key))) === 1;
  }

  async getIdempotent(key: string): Promise<IdempotentResponse | null> {
    const raw = await this.redis.get(this.key('idem', key));
    return raw === null ? null : (JSON.parse(raw) as IdempotentResponse);
  }

  async putIdempotent(key: string, value: IdempotentResponse, ttlMs: number): Promise<boolean> {
    const result = await this.redis.set(
      this.key('idem', key),
      JSON.stringify(value),
      'PX',
      Math.max(1, Math.ceil(ttlMs)),
      'NX',
    );
    return result === 'OK';
  }

  async appendAudit(body: AuditBody): Promise<AuditEntry> {
    const lockKey = this.key('audit', 'lock');
    this.lockCounter += 1;
    const token = `${process.pid}-${this.clock.now()}-${this.lockCounter}`;
    const deadline = Date.now() + this.appendLockWaitMs;

    let held = false;
    while (Date.now() <= deadline) {
      const acquired = await this.redis.set(lockKey, token, 'PX', this.appendLockTtlMs, 'NX');
      if (acquired === 'OK') {
        held = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 3));
    }

    if (!held) {
      throw new Error(
        `could not acquire the audit append lock within ${this.appendLockWaitMs} ms; another writer is stalled or the chain is saturated`,
      );
    }

    try {
      const listKey = this.key('audit', 'log');
      const tailKey = this.key('audit', 'tail');
      const seq = await this.redis.llen(listKey);
      const prevHash = (await this.redis.get(tailKey)) ?? GENESIS_HASH;
      const hash = hashEntry(body, seq, prevHash);
      const entry: AuditEntry = { ...body, seq, prevHash, hash };

      const applied = (await this.redis.eval(
        APPEND_SCRIPT,
        2,
        listKey,
        tailKey,
        String(seq),
        prevHash,
        GENESIS_HASH,
        JSON.stringify(entry),
        hash,
      )) as number;

      if (applied !== 1) {
        throw new Error(
          'audit chain moved while the append lock was held, which means the lock expired under a stalled writer',
        );
      }
      return entry;
    } finally {
      await this.redis.eval(UNLOCK_SCRIPT, 1, lockKey, token);
    }
  }

  async readAudit(options: { fromSeq?: number; limit?: number } = {}): Promise<AuditEntry[]> {
    const from = options.fromSeq ?? 0;
    const to = options.limit === undefined ? -1 : from + options.limit - 1;
    const rows = await this.redis.lrange(this.key('audit', 'log'), from, to);
    return rows.map((row) => JSON.parse(row) as AuditEntry);
  }

  async close(): Promise<void> {
    if (this.ownsClient) {
      await this.redis.quit();
    }
  }
}

/** Exported so the contract tests can assert the linking rule without reading the source. */
export const REDIS_APPEND_SCRIPT = APPEND_SCRIPT;
export const REDIS_UNLOCK_SCRIPT = UNLOCK_SCRIPT;
