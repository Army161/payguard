import type { PaymentPayload, PaymentRequirements } from '@payguard/core';

export const SELLER_BASE = '0x1111111111111111111111111111111111111111';
export const BUYER_BASE = '0x2222222222222222222222222222222222222222';
export const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
export const SELLER_XRPL = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe';
export const RLUSD_TESTNET = 'RLUSD.rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV';

export function requirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: 'exact',
    network: 'base-sepolia',
    maxAmountRequired: '10000',
    resource: 'https://seller.example/api/report',
    description: 'One generated report',
    mimeType: 'application/json',
    payTo: SELLER_BASE,
    maxTimeoutSeconds: 60,
    asset: USDC_BASE_SEPOLIA,
    ...overrides,
  };
}

export function evmPayload(
  overrides: {
    validAfter?: string;
    validBefore?: string;
    value?: string;
    nonce?: string;
    network?: PaymentPayload['network'];
  } = {},
): PaymentPayload {
  return {
    x402Version: 1,
    scheme: 'exact',
    network: overrides.network ?? 'base-sepolia',
    payload: {
      signature: `0x${'ab'.repeat(65)}`,
      authorization: {
        from: BUYER_BASE,
        to: SELLER_BASE,
        value: overrides.value ?? '10000',
        validAfter: overrides.validAfter ?? '1000',
        validBefore: overrides.validBefore ?? '2000',
        nonce: overrides.nonce ?? `0x${'cd'.repeat(32)}`,
      },
    },
  };
}

export function xrplPayload(transaction = '120000228000000024'): PaymentPayload {
  return {
    x402Version: 1,
    scheme: 'exact',
    network: 'xrpl-testnet',
    payload: { transaction },
  };
}
