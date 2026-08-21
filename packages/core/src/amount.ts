/**
 * Amounts are always atomic integers carried as decimal strings, never floats. A float here is a
 * rounding bug that silently under-charges or over-pays, so the type system never sees a number.
 */

export class AmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmountError';
  }
}

const ATOMIC = /^(0|[1-9][0-9]{0,77})$/;

export function parseAtomic(value: string): bigint {
  if (!ATOMIC.test(value)) {
    throw new AmountError(`not a non-negative atomic amount: ${JSON.stringify(value)}`);
  }
  return BigInt(value);
}

export function isAtomic(value: string): boolean {
  return ATOMIC.test(value);
}

/** True when `paid` covers `price`. x402 prices are maxima, so paying more is acceptable. */
export function covers(paid: string, price: string): boolean {
  return parseAtomic(paid) >= parseAtomic(price);
}

export function addAtomic(a: string, b: string): string {
  return (parseAtomic(a) + parseAtomic(b)).toString();
}

/**
 * Scales an atomic amount by a ratio expressed in basis points, rounding up. Used for the buyer's
 * price-change tolerance, where rounding down would let a seller sneak past the cap by one unit.
 */
export function scaleByBps(value: string, bps: number): string {
  if (!Number.isInteger(bps) || bps < 0) {
    throw new AmountError(`basis points must be a non-negative integer, got ${bps}`);
  }
  const v = parseAtomic(value);
  const numerator = v * BigInt(10_000 + bps);
  const quotient = numerator / 10_000n;
  return (numerator % 10_000n === 0n ? quotient : quotient + 1n).toString();
}
