import {
  appendEntry,
  type AuditBody,
  type AuditEntry,
  type IdempotentResponse,
  type Store,
} from '@payguard/core';
import type { Clock } from '@payguard/core';
import { systemClock } from '@payguard/core';

interface Claim {
  expiresAtMs: number;
}

/**
 * Single process store. Node runs one JavaScript thread, so a synchronous check-then-set inside a
 * single function body is genuinely atomic here: nothing can interleave between the read and the
 * write. That property does not survive a second process, which is why this is the development
 * and test store and Redis is the production one.
 */
export class MemoryStore implements Store {
  private readonly nonces = new Map<string, Claim>();
  private readonly idempotency = new Map<
    string,
    { value: IdempotentResponse; expiresAtMs: number }
  >();
  private readonly audit: AuditEntry[] = [];
  private readonly clock: Clock;

  constructor(options: { clock?: Clock } = {}) {
    this.clock = options.clock ?? systemClock;
  }

  async claimNonce(key: string, ttlMs: number): Promise<boolean> {
    const now = this.clock.now();
    const existing = this.nonces.get(key);
    if (existing !== undefined && existing.expiresAtMs > now) {
      return false;
    }
    this.nonces.set(key, { expiresAtMs: now + ttlMs });
    return true;
  }

  async releaseNonce(key: string): Promise<void> {
    this.nonces.delete(key);
  }

  async hasNonce(key: string): Promise<boolean> {
    const existing = this.nonces.get(key);
    return existing !== undefined && existing.expiresAtMs > this.clock.now();
  }

  async getIdempotent(key: string): Promise<IdempotentResponse | null> {
    const entry = this.idempotency.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAtMs <= this.clock.now()) {
      this.idempotency.delete(key);
      return null;
    }
    return entry.value;
  }

  async putIdempotent(key: string, value: IdempotentResponse, ttlMs: number): Promise<boolean> {
    const now = this.clock.now();
    const existing = this.idempotency.get(key);
    if (existing !== undefined && existing.expiresAtMs > now) {
      return false;
    }
    this.idempotency.set(key, { value, expiresAtMs: now + ttlMs });
    return true;
  }

  async appendAudit(body: AuditBody): Promise<AuditEntry> {
    const entry = appendEntry(this.audit[this.audit.length - 1] ?? null, body);
    this.audit.push(entry);
    return entry;
  }

  async readAudit(options: { fromSeq?: number; limit?: number } = {}): Promise<AuditEntry[]> {
    const from = options.fromSeq ?? 0;
    const slice = this.audit.filter((e) => e.seq >= from);
    return options.limit === undefined ? slice : slice.slice(0, options.limit);
  }

  async close(): Promise<void> {
    this.nonces.clear();
    this.idempotency.clear();
  }
}
