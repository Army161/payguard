/**
 * XRP travels as an integer number of drops, so it is already atomic. Issued currencies such as
 * RLUSD travel as arbitrary precision decimal strings, so "10.5" has to become atomic units
 * without ever touching a float. Parsing "0.1" as a double and multiplying by a million is how a
 * payment silently becomes one unit short.
 */

const DECIMAL = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

export class XrplAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XrplAmountError';
  }
}

/**
 * Converts a decimal string to an integer count of the smallest unit, exactly. Rejects a value
 * with more precision than the configured decimals allow rather than rounding it away, because
 * rounding here would mean accepting less than the price.
 */
export function decimalToAtomic(value: string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new XrplAmountError(`decimals must be an integer between 0 and 36, got ${decimals}`);
  }
  const match = DECIMAL.exec(value.trim());
  if (match === null) {
    throw new XrplAmountError(`not a decimal amount: ${JSON.stringify(value)}`);
  }
  const [, sign, whole = '0', fraction = '', exponent = '0'] = match;
  if (sign === '-') {
    throw new XrplAmountError(`negative amounts are not payments: ${value}`);
  }

  // Fold the exponent into the digit string, then shift by the asset's decimals.
  const digits = `${whole}${fraction}`;
  const pointFromRight = fraction.length - Number(exponent);
  const shift = decimals - pointFromRight;

  if (shift >= 0) {
    return stripLeadingZeros(digits + '0'.repeat(shift));
  }

  const cut = digits.length + shift;
  const kept = cut <= 0 ? '' : digits.slice(0, cut);
  const dropped = cut <= 0 ? digits : digits.slice(cut);
  if (/[1-9]/.test(dropped)) {
    throw new XrplAmountError(
      `amount ${value} carries more precision than ${decimals} decimals can represent`,
    );
  }
  return stripLeadingZeros(kept);
}

function stripLeadingZeros(digits: string): string {
  const trimmed = digits.replace(/^0+/, '');
  return trimmed === '' ? '0' : trimmed;
}
