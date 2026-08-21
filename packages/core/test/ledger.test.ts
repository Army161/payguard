import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  DAY_MS,
  HOUR_MS,
  InMemorySpendLedger,
  MINUTE_MS,
  summarize,
  type SpendRecord,
} from '@payguard/core';
import { USDC_BASE_SEPOLIA } from './fixtures.js';

const NOW = 1_700_000_000_000;

const record = (overrides: Partial<SpendRecord> = {}): SpendRecord => ({
  agentId: 'agent-1',
  asset: USDC_BASE_SEPOLIA,
  amount: '1000',
  timestampMs: NOW,
  ...overrides,
});

describe('spend summarization', () => {
  const query = { agentId: 'agent-1', asset: USDC_BASE_SEPOLIA, nowMs: NOW };

  it('returns zeros for an empty ledger', () => {
    expect(summarize([], query)).toEqual({
      hourAtomic: '0',
      dayAtomic: '0',
      lastMinuteCount: 0,
    });
  });

  it('counts a payment in every window it falls inside', () => {
    expect(summarize([record()], query)).toEqual({
      hourAtomic: '1000',
      dayAtomic: '1000',
      lastMinuteCount: 1,
    });
  });

  it('drops a payment older than the widest window', () => {
    expect(summarize([record({ timestampMs: NOW - DAY_MS })], query)).toEqual({
      hourAtomic: '0',
      dayAtomic: '0',
      lastMinuteCount: 0,
    });
  });

  it('keeps an hour-old payment in the day window but not the hour window', () => {
    expect(summarize([record({ timestampMs: NOW - HOUR_MS })], query)).toMatchObject({
      hourAtomic: '0',
      dayAtomic: '1000',
      lastMinuteCount: 0,
    });
  });

  it('keeps a minute-old payment out of the velocity count', () => {
    expect(summarize([record({ timestampMs: NOW - MINUTE_MS })], query).lastMinuteCount).toBe(0);
  });

  it('ignores records belonging to another agent', () => {
    expect(summarize([record({ agentId: 'agent-2' })], query)).toEqual({
      hourAtomic: '0',
      dayAtomic: '0',
      lastMinuteCount: 0,
    });
  });

  it('sums caps per asset but counts velocity across assets', () => {
    const summary = summarize([record(), record({ asset: 'XRP', amount: '500' })], query);
    expect(summary.hourAtomic).toBe('1000');
    expect(summary.lastMinuteCount).toBe(2);
  });

  it('ignores a record stamped in the future rather than trusting a skewed clock', () => {
    expect(summarize([record({ timestampMs: NOW + 1 })], query).dayAtomic).toBe('0');
  });

  it('property: the hour total never exceeds the day total', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            ageMs: fc.integer({ min: 0, max: DAY_MS * 2 }),
            amount: fc.bigInt({ min: 0n, max: 10n ** 9n }).map(String),
          }),
          { maxLength: 50 },
        ),
        (rows) => {
          const records = rows.map((r) => record({ timestampMs: NOW - r.ageMs, amount: r.amount }));
          const summary = summarize(records, query);
          expect(BigInt(summary.hourAtomic)).toBeLessThanOrEqual(BigInt(summary.dayAtomic));
        },
      ),
    );
  });
});

describe('in memory spend ledger', () => {
  it('records and reports spending', () => {
    const ledger = new InMemorySpendLedger();
    ledger.record(record());
    expect(ledger.snapshot({ agentId: 'agent-1', asset: USDC_BASE_SEPOLIA, nowMs: NOW })).toEqual({
      hourAtomic: '1000',
      dayAtomic: '1000',
      lastMinuteCount: 1,
    });
  });

  it('short circuits an empty ledger without scanning', () => {
    const ledger = new InMemorySpendLedger();
    expect(ledger.snapshot({ agentId: 'a', asset: 'b', nowMs: NOW }).dayAtomic).toBe('0');
  });

  it('prunes records past the widest window so memory stays bounded', () => {
    const ledger = new InMemorySpendLedger();
    ledger.record(record({ timestampMs: NOW - DAY_MS * 3 }));
    expect(ledger.size).toBe(1);
    ledger.record(record({ timestampMs: NOW }));
    expect(ledger.size).toBe(1);
  });

  it('leaves the array alone when the oldest record is still inside the window', () => {
    const ledger = new InMemorySpendLedger();
    ledger.record(record());
    ledger.record(record());
    ledger.prune(NOW);
    expect(ledger.size).toBe(2);
  });
});
