import Database from 'better-sqlite3';
import {
  appendEntry,
  systemClock,
  type AuditBody,
  type AuditEntry,
  type Clock,
  type IdempotentResponse,
  type Store,
} from '@payguard/core';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nonces (
  key         TEXT PRIMARY KEY,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS nonces_expires_at ON nonces (expires_at);

CREATE TABLE IF NOT EXISTS idempotency (
  key         TEXT PRIMARY KEY,
  payload     TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idempotency_expires_at ON idempotency (expires_at);

CREATE TABLE IF NOT EXISTS audit (
  seq        INTEGER PRIMARY KEY,
  prev_hash  TEXT NOT NULL,
  hash       TEXT NOT NULL,
  body       TEXT NOT NULL
);
`;

export interface SqliteStoreOptions {
  /** File path, or ":memory:" for an ephemeral database. */
  path: string;
  clock?: Clock;
}

/**
 * Single node production store. Correctness rests on two things.
 *
 * The nonce claim is one INSERT ... ON CONFLICT DO UPDATE ... WHERE statement, so SQLite decides
 * the winner rather than this process. A read followed by a write would leave a window between
 * them, and FR-2.3 exists precisely because that window is the duplication vulnerability.
 *
 * The audit append reads the chain tail and inserts the new entry inside a BEGIN IMMEDIATE
 * transaction, which takes the write lock up front. Without IMMEDIATE, two concurrent appenders
 * can both read the same tail and then fight over the insert, forking the hash chain.
 */
export class SqliteStore implements Store {
  private readonly db: Database.Database;
  private readonly clock: Clock;

  private readonly claimStmt: Database.Statement;
  private readonly releaseStmt: Database.Statement;
  private readonly hasStmt: Database.Statement;
  private readonly getIdemStmt: Database.Statement;
  private readonly putIdemStmt: Database.Statement;
  private readonly tailStmt: Database.Statement;
  private readonly insertAuditStmt: Database.Statement;
  private readonly readAuditStmt: Database.Statement;

  constructor(options: SqliteStoreOptions) {
    this.clock = options.clock ?? systemClock;
    this.db = new Database(options.path);
    // WAL lets readers proceed while a writer holds the lock, which keeps the p95 latency budget
    // in NFR-2 reachable under concurrent settlement.
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(SCHEMA);

    this.claimStmt = this.db.prepare(
      `INSERT INTO nonces (key, expires_at) VALUES (@key, @expiresAt)
       ON CONFLICT(key) DO UPDATE SET expires_at = @expiresAt
       WHERE nonces.expires_at <= @now`,
    );
    this.releaseStmt = this.db.prepare(`DELETE FROM nonces WHERE key = ?`);
    this.hasStmt = this.db.prepare(`SELECT 1 FROM nonces WHERE key = ? AND expires_at > ?`);
    this.getIdemStmt = this.db.prepare(
      `SELECT payload FROM idempotency WHERE key = ? AND expires_at > ?`,
    );
    this.putIdemStmt = this.db.prepare(
      `INSERT INTO idempotency (key, payload, expires_at) VALUES (@key, @payload, @expiresAt)
       ON CONFLICT(key) DO UPDATE SET payload = @payload, expires_at = @expiresAt
       WHERE idempotency.expires_at <= @now`,
    );
    this.tailStmt = this.db.prepare(
      `SELECT seq, prev_hash AS prevHash, hash, body FROM audit ORDER BY seq DESC LIMIT 1`,
    );
    this.insertAuditStmt = this.db.prepare(
      `INSERT INTO audit (seq, prev_hash, hash, body) VALUES (@seq, @prevHash, @hash, @body)`,
    );
    this.readAuditStmt = this.db.prepare(
      `SELECT seq, prev_hash AS prevHash, hash, body FROM audit WHERE seq >= ? ORDER BY seq ASC`,
    );
  }

  async claimNonce(key: string, ttlMs: number): Promise<boolean> {
    const now = this.clock.now();
    const result = this.claimStmt.run({ key, expiresAt: now + ttlMs, now });
    return result.changes === 1;
  }

  async releaseNonce(key: string): Promise<void> {
    this.releaseStmt.run(key);
  }

  async hasNonce(key: string): Promise<boolean> {
    return this.hasStmt.get(key, this.clock.now()) !== undefined;
  }

  async getIdempotent(key: string): Promise<IdempotentResponse | null> {
    const row = this.getIdemStmt.get(key, this.clock.now()) as { payload: string } | undefined;
    return row === undefined ? null : (JSON.parse(row.payload) as IdempotentResponse);
  }

  async putIdempotent(key: string, value: IdempotentResponse, ttlMs: number): Promise<boolean> {
    const now = this.clock.now();
    const result = this.putIdemStmt.run({
      key,
      payload: JSON.stringify(value),
      expiresAt: now + ttlMs,
      now,
    });
    return result.changes === 1;
  }

  async appendAudit(body: AuditBody): Promise<AuditEntry> {
    const append = this.db.transaction((entryBody: AuditBody): AuditEntry => {
      const tail = this.tailStmt.get() as
        { seq: number; prevHash: string; hash: string; body: string } | undefined;
      const previous: AuditEntry | null =
        tail === undefined
          ? null
          : {
              ...(JSON.parse(tail.body) as AuditBody),
              seq: tail.seq,
              prevHash: tail.prevHash,
              hash: tail.hash,
            };
      const entry = appendEntry(previous, entryBody);
      this.insertAuditStmt.run({
        seq: entry.seq,
        prevHash: entry.prevHash,
        hash: entry.hash,
        body: JSON.stringify(entryBody),
      });
      return entry;
    });
    return append.immediate(body);
  }

  async readAudit(options: { fromSeq?: number; limit?: number } = {}): Promise<AuditEntry[]> {
    const rows = this.readAuditStmt.all(options.fromSeq ?? 0) as {
      seq: number;
      prevHash: string;
      hash: string;
      body: string;
    }[];
    const entries = rows.map((row) => ({
      ...(JSON.parse(row.body) as AuditBody),
      seq: row.seq,
      prevHash: row.prevHash,
      hash: row.hash,
    }));
    return options.limit === undefined ? entries : entries.slice(0, options.limit);
  }

  /** Deletes expired rows. Callers may run this on a timer; nothing depends on it for safety. */
  vacuumExpired(): void {
    const now = this.clock.now();
    this.db.prepare(`DELETE FROM nonces WHERE expires_at <= ?`).run(now);
    this.db.prepare(`DELETE FROM idempotency WHERE expires_at <= ?`).run(now);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
