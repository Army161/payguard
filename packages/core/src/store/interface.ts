import type { AuditEntry, AuditBody } from '../audit/entry.js';

/** A response cached against an idempotency key, so a retry replays instead of re-charging. */
export interface IdempotentResponse {
  status: number;
  headers: Record<string, string>;
  /** Base64 of the original body, so binary resources survive the round trip. */
  bodyBase64: string;
  /** The payment that paid for it, for the audit trail. */
  paymentId: string;
  storedAtMs: number;
}

/**
 * The only stateful surface PayGuard depends on. Everything here must be atomic against concurrent
 * callers, because FR-2.3 turns a non-atomic claim into a duplication vulnerability.
 */
export interface Store {
  /**
   * Claims a nonce. Returns true exactly once per key across all concurrent callers, false on
   * every later attempt while the key lives. This single operation is what makes AT-2 and AT-3
   * pass, so an implementation that reads then writes is wrong.
   */
  claimNonce(key: string, ttlMs: number): Promise<boolean>;

  /** Releases a claim, used when verification fails and the payload was never actually spent. */
  releaseNonce(key: string): Promise<void>;

  /** True while the key is claimed. Diagnostics only, never a substitute for claimNonce. */
  hasNonce(key: string): Promise<boolean>;

  getIdempotent(key: string): Promise<IdempotentResponse | null>;

  /**
   * Stores a response against an idempotency key. Returns false when the key was already taken,
   * which the middleware treats as another request having won the race.
   */
  putIdempotent(key: string, value: IdempotentResponse, ttlMs: number): Promise<boolean>;

  /**
   * Appends to the hash chained audit log. The store owns the linking, because only the store
   * knows the current tail, and two processes appending concurrently must not fork the chain.
   */
  appendAudit(body: AuditBody): Promise<AuditEntry>;

  /** Reads the chain in order, for export and for tamper verification. */
  readAudit(options?: { fromSeq?: number; limit?: number }): Promise<AuditEntry[]>;

  /** Releases connections and file handles. */
  close(): Promise<void>;
}
