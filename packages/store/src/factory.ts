import type { Clock, Store, StoreConfig } from '@payguard/core';
import { MemoryStore } from './memory.js';

/**
 * Builds a store from configuration. The SQLite and Redis implementations are imported lazily so
 * that a deployment using only the memory store never loads better-sqlite3 or ioredis, and so a
 * missing optional dependency fails at the point of use with a clear message rather than at the
 * top of an unrelated import.
 */
export async function createStore(
  config: StoreConfig,
  options: { clock?: Clock } = {},
): Promise<Store> {
  switch (config.kind) {
    case 'memory':
      return new MemoryStore(options);
    case 'sqlite': {
      const { SqliteStore } = await import('./sqlite.js');
      return new SqliteStore({ path: config.path, ...options });
    }
    case 'redis': {
      const { RedisStore } = await import('./redis.js');
      return new RedisStore({ url: config.url, keyPrefix: config.keyPrefix, ...options });
    }
  }
}
