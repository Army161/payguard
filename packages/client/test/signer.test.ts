import { describe, expect, it, vi } from 'vitest';
import { PaymentPayloadSchema, type PaymentRequirements } from '@payguard/core';
import {
  RawKeySigner,
  RemoteSigner,
  SignerError,
  agenticWalletSigner,
  chooseRail,
  kmsSigner,
  railOf,
} from '@payguard/client';

const BUYER = '0x2222222222222222222222222222222222222222';
const SELLER = '0x1111111111111111111111111111111111111111';

function requirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: 'exact',
    network: 'base-sepolia',
    maxAmountRequired: '10000',
    resource: 'https://seller.example/api/report',
    description: 'report',
    mimeType: 'application/json',
    payTo: SELLER,
    maxTimeoutSeconds: 300,
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    ...overrides,
  };
}

const rawKey = (overrides: Partial<ConstructorParameters<typeof RawKeySigner>[0]> = {}) =>
  new RawKeySigner({
    address: BUYER,
    env: {},
    warn: () => {},
    sign: async () => `0x${'ab'.repeat(65)}`,
    ...overrides,
  });

describe('the development raw key signer', () => {
  it('refuses to exist under NODE_ENV=production', () => {
    expect(() => rawKey({ env: { NODE_ENV: 'production' } })).toThrow(SignerError);
  });

  it('warns loudly on construction, because it is not for production', () => {
    const warn = vi.fn();
    rawKey({ warn });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatch(/development only/);
  });

  it('produces a payload that validates against the x402 schema', async () => {
    const payload = await rawKey({ nowSeconds: () => 1_000_000 }).signPayment(requirements());
    expect(PaymentPayloadSchema.parse(payload)).toBeTruthy();
    expect(payload.payload).toMatchObject({
      authorization: {
        from: BUYER,
        to: SELLER,
        value: '10000',
        validAfter: '999940',
        validBefore: '1000300',
      },
    });
  });

  it('never takes a private key, so no key material lives inside the signer', () => {
    const signer = rawKey();
    expect(JSON.stringify(signer)).not.toMatch(/0x[0-9a-f]{64}/i);
    expect(Object.keys(signer)).not.toContain('privateKey');
  });

  it('generates a distinct nonce per payment by default', async () => {
    const signer = rawKey();
    const a = await signer.signPayment(requirements());
    const b = await signer.signPayment(requirements());
    expect(a.payload).not.toEqual(b.payload);
  });

  it('refuses to sign on a mainnet network at all', async () => {
    await expect(rawKey().signPayment(requirements({ network: 'base' }))).rejects.toThrow(
      /refuses to sign on the mainnet network/,
    );
  });

  it('refuses a scheme it does not implement', async () => {
    await expect(
      rawKey().signPayment({ ...requirements(), scheme: 'upto' } as unknown as PaymentRequirements),
    ).rejects.toThrow(/only implements the exact scheme/);
  });

  it('reports its address', async () => {
    expect(await rawKey().address()).toBe(BUYER);
  });
});

describe('remote signers', () => {
  const goodPayload = (network = 'base-sepolia') => ({
    x402Version: 1,
    scheme: 'exact',
    network,
    payload: {
      signature: `0x${'cd'.repeat(65)}`,
      authorization: {
        from: BUYER,
        to: SELLER,
        value: '10000',
        validAfter: '1',
        validBefore: '99999999',
        nonce: `0x${'ef'.repeat(32)}`,
      },
    },
  });

  it('returns whatever the backend signed, once validated', async () => {
    const signer = new RemoteSigner({
      address: BUYER,
      backend: 'test',
      sign: async () => goodPayload(),
    });
    expect((await signer.signPayment(requirements())).network).toBe('base-sepolia');
    expect(await signer.address()).toBe(BUYER);
    expect(signer.backend).toBe('test');
  });

  it('refuses a backend response that is not a valid x402 payload', async () => {
    const signer = new RemoteSigner({
      address: BUYER,
      backend: 'flaky-wallet',
      sign: async () => ({ nope: true }),
    });
    await expect(signer.signPayment(requirements())).rejects.toThrow(
      /flaky-wallet returned something that is not a valid x402 payment payload/,
    );
  });

  it('refuses a payload signed for the wrong network', async () => {
    const signer = new RemoteSigner({
      address: BUYER,
      backend: 'confused-wallet',
      sign: async () => goodPayload('base'),
    });
    await expect(signer.signPayment(requirements())).rejects.toThrow(
      /signed for network base but the seller requires base-sepolia/,
    );
  });

  it('names the backend so the audit trail records what signed', () => {
    expect(kmsSigner({ address: BUYER, sign: async () => goodPayload() }).backend).toBe('kms');
    expect(
      agenticWalletSigner({ address: BUYER, provider: 'coinbase', sign: async () => goodPayload() })
        .backend,
    ).toBe('agentic-wallet:coinbase');
  });

  it('passes the requirements through to the backend unchanged', async () => {
    const sign = vi.fn(async () => goodPayload());
    const signer = kmsSigner({ address: BUYER, sign });
    const reqs = requirements();
    await signer.signPayment(reqs);
    expect(sign).toHaveBeenCalledWith(reqs);
  });
});

describe('rail routing', () => {
  it('maps a Base network to the USDC rail', () => {
    expect(railOf(requirements())).toBe('base:usdc');
  });

  it('distinguishes the two XRPL rails by the asset, not the network', () => {
    expect(railOf(requirements({ network: 'xrpl-testnet', asset: 'XRP' }))).toBe('xrpl:xrp');
    expect(railOf(requirements({ network: 'xrpl-testnet', asset: 'RLUSD.rIssuer' }))).toBe(
      'xrpl:rlusd',
    );
  });

  it('has no rail for a network v1 does not cover', () => {
    expect(railOf(requirements({ network: 'solana' }))).toBeUndefined();
  });

  it('takes the seller order when the buyer expressed no preference', () => {
    const accepts = [requirements({ network: 'xrpl-testnet', asset: 'XRP' }), requirements()];
    expect(chooseRail(accepts)?.rail).toBe('xrpl:xrp');
  });

  it('takes the buyer preference order over the seller advertisement order', () => {
    const accepts = [requirements({ network: 'xrpl-testnet', asset: 'XRP' }), requirements()];
    expect(chooseRail(accepts, { allowRails: ['base:usdc', 'xrpl:xrp'] })?.rail).toBe('base:usdc');
  });

  it('skips a rail already tried', () => {
    const accepts = [requirements(), requirements({ network: 'xrpl-testnet', asset: 'XRP' })];
    expect(chooseRail(accepts, { exclude: new Set(['base:usdc']) })?.rail).toBe('xrpl:xrp');
  });

  it('returns nothing when no accepted rail is allowed', () => {
    expect(chooseRail([requirements()], { allowRails: ['xrpl:xrp'] })).toBeUndefined();
  });

  it('returns nothing for an empty accepts list', () => {
    expect(chooseRail([])).toBeUndefined();
  });

  it('ignores accepted entries on networks it cannot pay', () => {
    expect(chooseRail([requirements({ network: 'solana' })])).toBeUndefined();
  });
});
