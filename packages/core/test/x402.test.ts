import { describe, expect, it } from 'vitest';
import {
  HeaderDecodeError,
  MAX_PAYMENT_HEADER_BYTES,
  NETWORKS,
  NetworkSchema,
  PaymentPayloadSchema,
  PaymentRequirementsSchema,
  SettleResponseSchema,
  X402ResponseSchema,
  X402_VERSION,
  decodePaymentHeader,
  decodeSettleResponseHeader,
  encodePaymentHeader,
  encodeSettleResponseHeader,
  isExactEvmPayload,
  isExactTransactionPayload,
  isMainnet,
  isTestnet,
} from '@payguard/core';
import { evmPayload, requirements, xrplPayload } from './fixtures.js';

describe('network classification', () => {
  it('classifies every known network as exactly one of mainnet or testnet', () => {
    for (const network of NETWORKS) {
      expect(isMainnet(network)).toBe(!isTestnet(network));
    }
  });

  it('treats base-sepolia and xrpl-testnet as testnets and base and xrpl as mainnets', () => {
    expect(isTestnet('base-sepolia')).toBe(true);
    expect(isTestnet('xrpl-testnet')).toBe(true);
    expect(isMainnet('base')).toBe(true);
    expect(isMainnet('xrpl')).toBe(true);
  });

  it('rejects a network the enum does not contain', () => {
    expect(NetworkSchema.safeParse('ethereum').success).toBe(false);
  });
});

describe('payment requirements schema', () => {
  it('accepts a well formed entry', () => {
    expect(PaymentRequirementsSchema.parse(requirements())).toBeTruthy();
  });

  it.each([
    ['a fractional price', { maxAmountRequired: '1.5' }],
    ['a negative price', { maxAmountRequired: '-1' }],
    ['a zero timeout', { maxTimeoutSeconds: 0 }],
    ['a timeout beyond a day', { maxTimeoutSeconds: 86_401 }],
    ['an empty payTo', { payTo: '' }],
    ['a scheme x402 v1 does not define', { scheme: 'upto' }],
  ])('rejects %s', (_label, override) => {
    expect(PaymentRequirementsSchema.safeParse({ ...requirements(), ...override }).success).toBe(
      false,
    );
  });
});

describe('payment payload schema', () => {
  it('accepts an exact EVM payload and reports its variant', () => {
    const parsed = PaymentPayloadSchema.parse(evmPayload());
    expect(isExactEvmPayload(parsed.payload)).toBe(true);
    expect(isExactTransactionPayload(parsed.payload)).toBe(false);
  });

  it('accepts an opaque transaction payload for XRPL', () => {
    const parsed = PaymentPayloadSchema.parse(xrplPayload());
    expect(isExactTransactionPayload(parsed.payload)).toBe(true);
    expect(isExactEvmPayload(parsed.payload)).toBe(false);
  });

  it('rejects a payload claiming a protocol version PayGuard does not speak', () => {
    expect(
      PaymentPayloadSchema.safeParse({ ...evmPayload(), x402Version: X402_VERSION + 1 }).success,
    ).toBe(false);
  });

  it('rejects a malformed EVM address in the authorization', () => {
    const bad = evmPayload();
    (bad.payload as { authorization: { to: string } }).authorization.to = '0xnothex';
    expect(PaymentPayloadSchema.safeParse(bad).success).toBe(false);
  });
});

describe('x402 402 body', () => {
  it('carries the accepts list and the reason for the refusal', () => {
    const body = X402ResponseSchema.parse({
      x402Version: 1,
      accepts: [requirements()],
      error: 'replay_detected',
    });
    expect(body.accepts).toHaveLength(1);
  });
});

describe('payment headers', () => {
  it('round trips a payload', () => {
    const header = encodePaymentHeader(evmPayload());
    expect(decodePaymentHeader(header)).toEqual(evmPayload());
  });

  it('round trips a settle response', () => {
    const response = SettleResponseSchema.parse({
      success: true,
      transaction: '0xdeadbeef',
      network: 'base-sepolia',
      payer: '0x2222222222222222222222222222222222222222',
    });
    expect(decodeSettleResponseHeader(encodeSettleResponseHeader(response))).toEqual(response);
  });

  it('refuses an empty header', () => {
    expect(() => decodePaymentHeader('')).toThrow(HeaderDecodeError);
  });

  it('refuses a header past the byte ceiling before parsing it', () => {
    const oversized = 'A'.repeat(MAX_PAYMENT_HEADER_BYTES + 1);
    expect(() => decodePaymentHeader(oversized)).toThrow(/exceeds/);
  });

  it('honours a caller supplied ceiling', () => {
    const header = encodePaymentHeader(evmPayload());
    expect(() => decodePaymentHeader(header, 16)).toThrow(/exceeds 16 bytes/);
  });

  it('refuses a header that is not JSON once decoded', () => {
    const header = Buffer.from('not json at all', 'utf8').toString('base64');
    expect(() => decodePaymentHeader(header)).toThrow(/valid JSON/);
  });

  it('refuses valid JSON that is not a valid payload, naming the offending field', () => {
    const header = Buffer.from(JSON.stringify({ x402Version: 1 }), 'utf8').toString('base64');
    expect(() => decodePaymentHeader(header)).toThrow(/schema validation/);
  });

  it('refuses a settle response header that fails schema validation', () => {
    const header = Buffer.from(JSON.stringify({ success: true }), 'utf8').toString('base64');
    expect(() => decodeSettleResponseHeader(header)).toThrow(HeaderDecodeError);
  });
});

describe('base64 alphabet', () => {
  it('refuses a header containing characters outside the base64 alphabet', () => {
    expect(() => decodePaymentHeader('not base64 !!')).toThrow(/not valid base64/);
  });

  it('accepts padding', () => {
    const header = Buffer.from(JSON.stringify({ a: 1 }), 'utf8').toString('base64');
    expect(header.endsWith('=')).toBe(true);
    expect(() => decodePaymentHeader(header)).toThrow(/schema validation/);
  });
});
