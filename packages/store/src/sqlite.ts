import Database from 'better-sqlite3';
import { AuditEntry } from '@payguard/core';
import { Store } from './interface.js';

export class SQLiteStore implements Store {
  private db: Database.Database;

  constructor(path: string = ':memory:') {
    this.db = new Database(path);
    this.init();
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nonces (
        key TEXT PRIMARY KEY,
        expiry INTEGER
      );
      CREATE TABLE IF NOT EXISTS idempotency (
        key TEXT PRIMARY KEY,
        response TEXT,
        expiry INTEGER
      );
      CREATE TABLE IF NOT EXISTS audit (
        id TEXT PRIMARY KEY,
        data TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_nonces_expiry ON nonces(expiry);
      CREATE INDEX IF NOT EXISTS idx_idem_expiry ON idempotency(expiry);
    `);
  }

  async claimNonce(key: string, ttlSeconds: number): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    const expiry = now + ttlSeconds;

    // Clean up expired nonces
    this.db.prepare('DELETE FROM nonces WHERE expiry < ?').run(now);

    try {
      const result = this.db.prepare('INSERT INTO nonces (key, expiry) VALUES (?, ?)').run(key, expiry);
      return result.changes > 0;
    } catch (e) {
      return false;
    }
  }

  async getIdempotentResponse<T>(key: string): Promise<T | null> {
    const now = Math.floor(Date.now() / 1000);
    const row = this.db.prepare('SELECT response FROM idempotency WHERE key = ? AND expiry > ?').get(key, now) as { response: string } | undefined;
    return row ? JSON.parse(row.response) : null;
  }

  async setIdempotentResponse<T>(key: string, response: T, ttlSeconds: number): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const expiry = now + ttlSeconds;
    this.db.prepare('INSERT OR REPLACE INTO idempotency (key, response, expiry) VALUES (?, ?, ?)').run(key, JSON.stringify(response), expiry);
  }

  async appendAudit(entry: AuditEntry): Promise<void> {
    this.db.prepare('INSERT INTO audit (id, data) VALUES (?, ?)').run(entry.id, JSON.stringify(entry));
  }

  async getAuditLog(): Promise<AuditEntry[]> {
    const rows = this.db.prepare('SELECT data FROM audit ORDER BY rowid ASC').all() as { data: string }[];
    return rows.map(r => JSON.parse(r.data));
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
