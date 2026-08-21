import { describe, expect, it } from 'vitest';
import {
  XrplAmountError,
  currencyEquals,
  decimalToAtomic,
  formatXrplAsset,
  parseXrplAsset,
  toDisplayCurrency,
  toHexCurrency,
  xrplAssetEquals,
} from '@payguard/rails';

const RLUSD_HEX = '524C555344000000000000000000000000000000';
const ISSUER = 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV';

describe('XRPL currency codes', () => {
  it('encodes a five character code to the 40 character hex form', () => {
    expect(toHexCurrency('RLUSD')).toBe(RLUSD_HEX);
  });

  it('leaves an already hex code alone apart from case', () => {
    expect(toHexCurrency(RLUSD_HEX.toLowerCase())).toBe(RLUSD_HEX);
  });

  it('decodes hex back to the human spelling', () => {
    expect(toDisplayCurrency(RLUSD_HEX)).toBe('RLUSD');
    expect(toDisplayCurrency('USD')).toBe('USD');
  });

  it('treats a hex code and its ASCII spelling as the same currency', () => {
    expect(currencyEquals('RLUSD', RLUSD_HEX)).toBe(true);
    expect(currencyEquals(RLUSD_HEX, 'RLUSD')).toBe(true);
  });

  it('does not treat different currencies as equal', () => {
    expect(currencyEquals('RLUSD', 'USDC')).toBe(false);
    expect(currencyEquals('USD', 'EUR')).toBe(false);
  });

  it('compares three character codes exactly, since they travel as written', () => {
    expect(currencyEquals('USD', 'usd')).toBe(false);
  });

  it('falls back to the hex form when the bytes are not printable', () => {
    const opaque = '00'.repeat(20);
    expect(toDisplayCurrency(opaque)).toBe(opaque.toUpperCase());
  });

  it('refuses a code longer than twenty bytes', () => {
    expect(() => toHexCurrency('X'.repeat(21))).toThrow(/longer than 20 bytes/);
  });
});

describe('XRPL asset identifiers', () => {
  it('parses the native asset', () => {
    expect(parseXrplAsset('XRP')).toEqual({ currency: 'XRP' });
  });

  it('parses an issued currency', () => {
    expect(parseXrplAsset(`RLUSD.${ISSUER}`)).toEqual({ currency: 'RLUSD', issuer: ISSUER });
  });

  it.each(['', 'RLUSD', '.rIssuer', 'RLUSD.'])('refuses the malformed identifier %j', (value) => {
    expect(() => parseXrplAsset(value)).toThrow();
  });

  it('renders back to the same identifier', () => {
    expect(formatXrplAsset(parseXrplAsset(`RLUSD.${ISSUER}`))).toBe(`RLUSD.${ISSUER}`);
    expect(formatXrplAsset(parseXrplAsset('XRP'))).toBe('XRP');
  });

  it('renders a hex currency in its human spelling', () => {
    expect(formatXrplAsset({ currency: RLUSD_HEX, issuer: ISSUER })).toBe(`RLUSD.${ISSUER}`);
  });

  it('matches RLUSD however the currency code is spelled, as long as the issuer agrees', () => {
    expect(
      xrplAssetEquals(
        { currency: 'RLUSD', issuer: ISSUER },
        { currency: RLUSD_HEX, issuer: ISSUER },
      ),
    ).toBe(true);
  });

  it('refuses to match RLUSD from a different issuer', () => {
    expect(
      xrplAssetEquals(
        { currency: 'RLUSD', issuer: ISSUER },
        { currency: 'RLUSD', issuer: 'rOther' },
      ),
    ).toBe(false);
  });

  it('refuses to match XRP against an issued currency', () => {
    expect(xrplAssetEquals({ currency: 'XRP' }, { currency: 'XRP', issuer: ISSUER })).toBe(false);
  });
});

describe('XRPL decimal amounts', () => {
  it('shifts a whole number by the asset decimals', () => {
    expect(decimalToAtomic('10', 6)).toBe('10000000');
  });

  it('shifts a fractional value exactly, without touching a float', () => {
    expect(decimalToAtomic('0.1', 6)).toBe('100000');
    expect(decimalToAtomic('10.5', 6)).toBe('10500000');
    expect(decimalToAtomic('0.000001', 6)).toBe('1');
  });

  it('handles a value with fewer decimals than the asset allows', () => {
    expect(decimalToAtomic('1.5', 2)).toBe('150');
  });

  it('handles zero and leading zeros', () => {
    expect(decimalToAtomic('0', 6)).toBe('0');
    expect(decimalToAtomic('0.0', 6)).toBe('0');
    expect(decimalToAtomic('007', 2)).toBe('700');
  });

  it('folds scientific notation into the digit string', () => {
    expect(decimalToAtomic('1e3', 2)).toBe('100000');
    expect(decimalToAtomic('1.5e2', 0)).toBe('150');
    expect(decimalToAtomic('1e-3', 6)).toBe('1000');
  });

  it('refuses a value carrying more precision than the asset can hold', () => {
    expect(() => decimalToAtomic('0.0000001', 6)).toThrow(XrplAmountError);
    expect(() => decimalToAtomic('1.005', 2)).toThrow(/more precision/);
  });

  it('allows trailing zeros beyond the asset decimals, which carry no precision', () => {
    expect(decimalToAtomic('1.500000000', 2)).toBe('150');
  });

  it('refuses a negative amount rather than settling it as a payment', () => {
    expect(() => decimalToAtomic('-1', 6)).toThrow(/negative/);
  });

  it.each(['', 'abc', '1.2.3', '0x10', ' '])('refuses the non-numeric value %j', (value) => {
    expect(() => decimalToAtomic(value, 6)).toThrow(XrplAmountError);
  });

  it('refuses an out of range decimals argument', () => {
    expect(() => decimalToAtomic('1', -1)).toThrow(/between 0 and 36/);
    expect(() => decimalToAtomic('1', 1.5)).toThrow(/between 0 and 36/);
    expect(() => decimalToAtomic('1', 37)).toThrow(/between 0 and 36/);
  });
});
