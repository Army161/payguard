import { createHash } from 'crypto';
import { AuditEntry, Decision, RailId } from './types.js';

export function calculateHash(entry: Omit<AuditEntry, 'hash'>): string {
  const data = JSON.stringify({
    id: entry.id,
    prevHash: entry.prevHash,
    timestamp: entry.timestamp,
    agentId: entry.agentId,
    counterparty: entry.counterparty,
    rail: entry.rail,
    amount: entry.amount,
    facilitator: entry.facilitator,
    decision: entry.decision,
    proof: entry.proof,
  });
  return createHash('sha256').update(data).digest('hex');
}

export class AuditLogger {
  private lastHash: string = '0'.repeat(64);

  createEntry(params: {
    id: string;
    agentId: string;
    counterparty: string;
    rail: RailId;
    amount: string;
    facilitator: string;
    decision: Decision;
    proof?: string;
  }): AuditEntry {
    const entryBase = {
      ...params,
      prevHash: this.lastHash,
      timestamp: Date.now(),
    };
    const hash = calculateHash(entryBase);
    const entry: AuditEntry = { ...entryBase, hash };
    this.lastHash = hash;
    return entry;
  }

  verifyChain(entries: AuditEntry[]): boolean {
    let expectedPrevHash = '0'.repeat(64);
    for (const entry of entries) {
      if (entry.prevHash !== expectedPrevHash) return false;
      const actualHash = calculateHash(entry);
      if (entry.hash !== actualHash) return false;
      expectedPrevHash = entry.hash;
    }
    return true;
  }
}
