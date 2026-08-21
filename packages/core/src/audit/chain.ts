import { canonicalize } from '../payload/canonical.js';
import { sha256Hex } from '../payload/hash.js';
import type { AuditBody, AuditEntry } from './entry.js';

/** The prevHash of the first entry in a chain. */
export const GENESIS_HASH = '0'.repeat(64);

/**
 * The hash of one entry. Covers seq and prevHash as well as the body, so an attacker cannot
 * reorder entries or splice one chain into another without breaking the link.
 */
export function hashEntry(body: AuditBody, seq: number, prevHash: string): string {
  return sha256Hex(canonicalize({ seq, prevHash, body }));
}

/**
 * Appends a body to a chain. Stateless on purpose: the caller owns storage, this owns the linking
 * rule. Pass the previous entry, or null to start a chain.
 */
export function appendEntry(previous: AuditEntry | null, body: AuditBody): AuditEntry {
  const seq = previous === null ? 0 : previous.seq + 1;
  const prevHash = previous === null ? GENESIS_HASH : previous.hash;
  return { ...body, seq, prevHash, hash: hashEntry(body, seq, prevHash) };
}

export type ChainVerification =
  | { ok: true; length: number }
  | { ok: false; brokenAt: number; reason: 'bad_hash' | 'bad_prev_hash' | 'bad_sequence' };

/**
 * Recomputes every hash and every link. This is what makes the log tamper evident: editing an
 * entry changes its hash, which orphans every entry after it.
 */
export function verifyChain(entries: readonly AuditEntry[]): ChainVerification {
  let expectedPrev = GENESIS_HASH;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry === undefined) {
      return { ok: false, brokenAt: i, reason: 'bad_sequence' };
    }
    if (entry.seq !== i) {
      return { ok: false, brokenAt: i, reason: 'bad_sequence' };
    }
    if (entry.prevHash !== expectedPrev) {
      return { ok: false, brokenAt: i, reason: 'bad_prev_hash' };
    }
    const { seq: _seq, prevHash: _prevHash, hash, ...body } = entry;
    if (hashEntry(body as AuditBody, entry.seq, entry.prevHash) !== hash) {
      return { ok: false, brokenAt: i, reason: 'bad_hash' };
    }
    expectedPrev = hash;
  }
  return { ok: true, length: entries.length };
}
