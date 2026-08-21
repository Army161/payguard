/**
 * XRPL currency codes are three ASCII characters, or a 40 character hex blob for anything longer.
 * RLUSD is five characters, so it always travels as hex on the wire while humans write "RLUSD".
 * Comparing the two forms directly is how a correct RLUSD payment gets rejected as the wrong asset.
 */

const HEX_40 = /^[0-9A-Fa-f]{40}$/;
const ASCII_3 = /^[A-Za-z0-9?!@#$%^&*<>(){}[\]|]{3}$/;

/** Converts any accepted spelling of a currency code to its canonical 40 character hex form. */
export function toHexCurrency(code: string): string {
  if (HEX_40.test(code)) return code.toUpperCase();
  const bytes = Buffer.from(code, 'ascii');
  if (bytes.length > 20) {
    throw new Error(`currency code is longer than 20 bytes: ${code}`);
  }
  return Buffer.concat([bytes, Buffer.alloc(20 - bytes.length)])
    .toString('hex')
    .toUpperCase();
}

/** Renders a currency code the way a human wrote it, when that is possible. */
export function toDisplayCurrency(code: string): string {
  if (!HEX_40.test(code)) return code;
  const trimmed = Buffer.from(code, 'hex').toString('ascii').replace(/\0+$/, '');
  return trimmed.length === 0 ? code.toUpperCase() : trimmed;
}

export function currencyEquals(a: string, b: string): boolean {
  if (ASCII_3.test(a) && ASCII_3.test(b)) return a === b;
  return toHexCurrency(a) === toHexCurrency(b);
}

export interface XrplAsset {
  /** "XRP", or the currency code as written in configuration. */
  currency: string;
  /** Issuer account, absent for XRP. */
  issuer?: string;
}

/**
 * Parses the asset identifier PayGuard uses in configuration and in PaymentRequirements.asset:
 * "XRP" for the native asset, or "CURRENCY.rIssuerAddress" for an issued currency such as
 * "RLUSD.rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV".
 */
export function parseXrplAsset(asset: string): XrplAsset {
  if (asset === 'XRP') return { currency: 'XRP' };
  const separator = asset.indexOf('.');
  if (separator <= 0 || separator === asset.length - 1) {
    throw new Error(`XRPL asset must be "XRP" or "CURRENCY.rIssuer", got ${JSON.stringify(asset)}`);
  }
  return {
    currency: asset.slice(0, separator),
    issuer: asset.slice(separator + 1),
  };
}

export function formatXrplAsset(asset: XrplAsset): string {
  return asset.issuer === undefined
    ? 'XRP'
    : `${toDisplayCurrency(asset.currency)}.${asset.issuer}`;
}

export function xrplAssetEquals(a: XrplAsset, b: XrplAsset): boolean {
  if (a.issuer === undefined || b.issuer === undefined) {
    return a.issuer === b.issuer && a.currency === b.currency;
  }
  return a.issuer === b.issuer && currencyEquals(a.currency, b.currency);
}
