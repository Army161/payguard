import { addAtomic } from '../amount.js';
import { EMPTY_SNAPSHOT, type SpendSnapshot } from './types.js';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** One completed or attempted payment, as the ledger remembers it. */
export interface SpendRecord {
  agentId: string;
  asset: string;
  /** Atomic units. */
  amount: string;
  timestampMs: number;
}

export interface SummarizeQuery {
  agentId: string;
  asset: string;
  nowMs: number;
}

/**
 * Folds a list of spend records into the windowed view the policy rules need.
 *
 * Caps are per asset, because summing USDC atomic units with XRP drops would compare six decimal
 * places against six decimal places of an entirely different thing. Velocity is deliberately not
 * per asset: the point of a rate limit is to bound how fast an agent acts at all.
 */
export function summarize(records: readonly SpendRecord[], query: SummarizeQuery): SpendSnapshot {
  let hourAtomic = '0';
  let dayAtomic = '0';
  let lastMinuteCount = 0;

  for (const record of records) {
    if (record.agentId !== query.agentId) continue;
    const age = query.nowMs - record.timestampMs;
    if (age < 0 || age >= DAY_MS) continue;

    if (age < MINUTE_MS) {
      lastMinuteCount += 1;
    }
    if (record.asset !== query.asset) continue;
    dayAtomic = addAtomic(dayAtomic, record.amount);
    if (age < HOUR_MS) {
      hourAtomic = addAtomic(hourAtomic, record.amount);
    }
  }

  return { hourAtomic, dayAtomic, lastMinuteCount };
}

/**
 * An in-process ledger. Correct for a single agent process, which is the v1 buyer deployment.
 * Multi-process buyers should back the same interface with the Redis store instead, so two
 * replicas cannot each spend the full daily cap.
 */
export class InMemorySpendLedger {
  private records: SpendRecord[] = [];

  record(entry: SpendRecord): void {
    this.records.push(entry);
    this.prune(entry.timestampMs);
  }

  snapshot(query: SummarizeQuery): SpendSnapshot {
    if (this.records.length === 0) return EMPTY_SNAPSHOT;
    return summarize(this.records, query);
  }

  /** Drops anything older than the widest window, so memory is bounded by the daily rate. */
  prune(nowMs: number): void {
    const cutoff = nowMs - DAY_MS;
    if (this.records.length > 0 && (this.records[0]?.timestampMs ?? 0) >= cutoff) return;
    this.records = this.records.filter((r) => r.timestampMs >= cutoff);
  }

  get size(): number {
    return this.records.length;
  }
}
