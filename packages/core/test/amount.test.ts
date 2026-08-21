import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { AmountError, addAtomic, covers, isAtomic, parseAtomic, scaleByBps } from '@payguard/core';

describe('atomic amounts', () => {
  it('accepts canonical non-negative integers', () => {
    expect(parseAtomic('0')).toBe(0n);
    expect(parseAtomic('10000')).toBe(10000n);
    expect(isAtomic('123')).toBe(true);
  });

  it.each(['', '-1', '01', '1.5', '1e3', ' 1', '1 ', 'abc', '+1'])(
    'rejects %j as an atomic amount',
    (value) => {
      expect(isAtomic(value)).toBe(false);
      expect(() => parseAtomic(value)).toThrow(AmountError);
    },
  );

  it('rejects integers wider than 78 digits, which no token supply reaches', () => {
    expect(isAtomic('1'.repeat(78))).toBe(true);
    expect(isAtomic('1'.repeat(79))).toBe(false);
  });

  it('treats overpayment as covering the price and underpayment as not', () => {
    expect(covers('10000', '10000')).toBe(true);
    expect(covers('10001', '10000')).toBe(true);
    expect(covers('9999', '10000')).toBe(false);
  });

  it('adds without floating point loss at values a double cannot hold', () => {
    const big = '9007199254740993';
    expect(addAtomic(big, '1')).toBe('9007199254740994');
  });

  it('rounds the basis point ceiling up so one atomic unit cannot slip past', () => {
    expect(scaleByBps('10000', 0)).toBe('10000');
    expect(scaleByBps('10000', 500)).toBe('10500');
    // 1 * 1.0001 is 1.0001, which must become 2 rather than 1.
    expect(scaleByBps('1', 1)).toBe('2');
  });

  it('rejects negative or fractional basis points', () => {
    expect(() => scaleByBps('10', -1)).toThrow(AmountError);
    expect(() => scaleByBps('10', 1.5)).toThrow(AmountError);
  });

  const atomic = fc.bigInt({ min: 0n, max: 10n ** 30n }).map((v) => v.toString());

  it('property: covers is a total order agreeing with bigint comparison', () => {
    fc.assert(
      fc.property(atomic, atomic, (a, b) => {
        expect(covers(a, b)).toBe(BigInt(a) >= BigInt(b));
      }),
    );
  });

  it('property: scaling by n basis points never returns less than the input', () => {
    fc.assert(
      fc.property(atomic, fc.integer({ min: 0, max: 100_000 }), (value, bps) => {
        expect(BigInt(scaleByBps(value, bps))).toBeGreaterThanOrEqual(BigInt(value));
      }),
    );
  });

  it('property: addAtomic is commutative and associative', () => {
    fc.assert(
      fc.property(atomic, atomic, atomic, (a, b, c) => {
        expect(addAtomic(a, b)).toBe(addAtomic(b, a));
        expect(addAtomic(addAtomic(a, b), c)).toBe(addAtomic(a, addAtomic(b, c)));
      }),
    );
  });
});
