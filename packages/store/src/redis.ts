import { Redis } from 'ioredis';
import { AuditEntry } from '@payguard/core';
import { Store } from './interface.js';

export class RedisStore implements Store {
  private redis: Redis;

  constructor(url: string) {
    this.redis = new Redis(url);
  }

  async claimNonce(key: string, ttlSeconds: number): Promise<boolean> {
    const res = await this.redis.set(`nonce:${key}`, '1', 'EX', ttlSeconds, 'NX');
    return res === 'OK';
  }

  async getIdempotentResponse<T>(key: string): Promise<T | null> {
    const res = await this.redis.get(`idem:${key}`);
    return res ? JSON.parse(res) : null;
  }

  async setIdempotentResponse<T>(key: string, response: T, ttlSeconds: number): Promise<void> {
    await this.redis.set(`idem:${key}`, JSON.stringify(response), 'EX', ttlSeconds);
  }

  async appendAudit(entry: AuditEntry): Promise<void> {
    await this.redis.rpush('audit_log', JSON.stringify(entry));
  }

  async getAuditLog(): Promise<AuditEntry[]> {
    const logs = await this.redis.lrange('audit_log', 0, -1);
    return logs.map(l => JSON.parse(l));
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
