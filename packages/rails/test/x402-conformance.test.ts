import { describe, expect, it } from 'vitest';
import {
  PaymentPayloadSchema,
  PaymentRequirementsSchema,
  SettleResponseSchema,
  VerifyResponseSchema,
  X402_NETWORKS,
  X402_SCHEMES,
  X402_VERSION,
  NETWORKS,
} from '@payguard/core';
import {
  PaymentPayloadSchema as SdkPaymentPayloadSchema,
  PaymentRequirementsSchema as SdkPaymentRequirementsSchema,
  SettleResponseSchema as SdkSettleResponseSchema,
  VerifyResponseSchema as SdkVerifyResponseSchema,
  schemes as sdkSchemes,
  x402Versions as sdkVersions,
} from 'x402/types';

/**
 * PayGuard implements the x402 wire format itself rather than depending on the reference SDK at
 * runtime. See docs/adr/0001. These tests are what keeps that honest: they run PayGuard's schemas
 * and the pinned SDK's schemas against the same values and require them to agree.
 */

const requirements = {
  scheme: 'exact' as const,
  network: 'base-sepolia' as const,
  maxAmountRequired: '10000',
  resource: 'https://seller.example/api/report',
  description: 'One generated report',
  mimeType: 'application/json',
  payTo: '0x1111111111111111111111111111111111111111',
  maxTimeoutSeconds: 60,
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
};

const payload = {
  x402Version: 1,
  scheme: 'exact' as const,
  network: 'base-sepolia' as const,
  payload: {
    signature: `0x${'ab'.repeat(65)}`,
    authorization: {
      from: '0x2222222222222222222222222222222222222222',
      to: '0x1111111111111111111111111111111111111111',
      value: '10000',
      validAfter: '1000',
      validBefore: '2000',
      nonce: `0x${'cd'.repeat(32)}`,
    },
  },
};

describe('x402 constants match the pinned SDK', () => {
  it('agrees on the protocol version', () => {
    expect([...sdkVersions]).toContain(X402_VERSION);
  });

  it('agrees on the set of schemes', () => {
    expect([...X402_SCHEMES]).toEqual([...sdkSchemes]);
  });

  it('lists exactly the SDK networks, in the same order, before the XRPL extension', () => {
    const sdkNetworks = SdkPaymentRequirementsSchema.shape.network.options as readonly string[];
    expect([...X402_NETWORKS]).toEqual([...sdkNetworks]);
  });

  it('extends the SDK network set rather than replacing it', () => {
    const sdkNetworks = new Set(
      SdkPaymentRequirementsSchema.shape.network.options as readonly string[],
    );
    for (const network of sdkNetworks) {
      expect(NETWORKS).toContain(network);
    }
    expect(NETWORKS).toContain('xrpl-testnet');
    expect(sdkNetworks.has('xrpl-testnet')).toBe(false);
  });
});

describe('x402 schemas match the pinned SDK', () => {
  it('both accept the same payment requirements', () => {
    expect(SdkPaymentRequirementsSchema.safeParse(requirements).success).toBe(true);
    expect(PaymentRequirementsSchema.safeParse(requirements).success).toBe(true);
  });

  it('both accept the same exact EVM payload', () => {
    expect(SdkPaymentPayloadSchema.safeParse(payload).success).toBe(true);
    expect(PaymentPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it('both accept the same verify response', () => {
    const value = { isValid: false, invalidReason: 'invalid_payment' };
    expect(SdkVerifyResponseSchema.safeParse(value).success).toBe(true);
    expect(VerifyResponseSchema.safeParse(value).success).toBe(true);
  });

  it('both accept the same settle response', () => {
    const value = {
      success: true,
      transaction: `0x${'11'.repeat(32)}`,
      network: 'base-sepolia',
      payer: '0x2222222222222222222222222222222222222222',
    };
    expect(SdkSettleResponseSchema.safeParse(value).success).toBe(true);
    expect(SettleResponseSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ['a fractional price', { maxAmountRequired: '1.5' }],
    ['an unknown scheme', { scheme: 'upto' }],
    ['an unknown network', { network: 'ethereum' }],
  ])('both reject %s', (_label, override) => {
    const value = { ...requirements, ...override };
    expect(SdkPaymentRequirementsSchema.safeParse(value).success).toBe(false);
    expect(PaymentRequirementsSchema.safeParse(value).success).toBe(false);
  });

  it('PayGuard is stricter about the error reason vocabulary staying open', () => {
    // A facilitator that invents a reason should not crash the seller, so PayGuard accepts any
    // non-empty string here while the SDK pins the enum. This difference is deliberate.
    const invented = { isValid: false, invalidReason: 'facilitator_specific_reason' };
    expect(VerifyResponseSchema.safeParse(invented).success).toBe(true);
    expect(SdkVerifyResponseSchema.safeParse(invented).success).toBe(false);
  });
});
