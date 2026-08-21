import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_VALIDITY_WINDOW_MS,
  PayGuardError,
  addressEquals,
  assertWithinValidity,
  checkSettlement,
  expectationFromRequirements,
  nonceTtlMs,
  payloadValidityWindow,
  type ChainObservation,
  type SettlementExpectation,
} from '@payguard/core';
import {
  RLUSD_TESTNET,
  SELLER_BASE,
  SELLER_XRPL,
  USDC_BASE_SEPOLIA,
  evmPayload,
  requirements,
  xrplPayload,
} from './fixtures.js';

describe('address equality', () => {
  it('folds case on Base, because a checksummed address is the same account', () => {
    expect(addressEquals('base', SELLER_BASE.toUpperCase().replace('0X', '0x'), SELLER_BASE)).toBe(
      true,
    );
  });

  it('does not fold case on XRPL, where case carries account identity', () => {
    expect(addressEquals('xrpl', SELLER_XRPL.toLowerCase(), SELLER_XRPL)).toBe(false);
    expect(addressEquals('xrpl', SELLER_XRPL, SELLER_XRPL)).toBe(true);
  });

  it('ignores surrounding whitespace on both chains', () => {
    expect(addressEquals('base', ` ${SELLER_BASE} `, SELLER_BASE)).toBe(true);
    expect(addressEquals('xrpl', ` ${SELLER_XRPL} `, SELLER_XRPL)).toBe(true);
  });
});

describe('payload validity window', () => {
  const nowMs = 1_500_000;

  it('reads the window from an EVM authorization, converting seconds to milliseconds', () => {
    expect(payloadValidityWindow(evmPayload())).toEqual({
      validAfterMs: 1_000_000,
      validBeforeMs: 2_000_000,
    });
  });

  it('reports no window for an opaque transaction payload', () => {
    expect(payloadValidityWindow(xrplPayload())).toEqual({
      validAfterMs: null,
      validBeforeMs: null,
    });
  });

  it('accepts a payload inside its window', () => {
    expect(() => assertWithinValidity(evmPayload(), requirements(), { nowMs })).not.toThrow();
  });

  it('refuses a payload whose window has closed', () => {
    expect(() => assertWithinValidity(evmPayload(), requirements(), { nowMs: 2_100_000 })).toThrow(
      expect.objectContaining({ reason: 'payload_expired' }),
    );
  });

  it('refuses a payload whose window has not opened', () => {
    expect(() => assertWithinValidity(evmPayload(), requirements(), { nowMs: 900_000 })).toThrow(
      expect.objectContaining({ reason: 'payload_not_yet_valid' }),
    );
  });

  it('forgives a clock difference inside the tolerance on both edges', () => {
    expect(() =>
      assertWithinValidity(evmPayload(), requirements(), {
        nowMs: 2_030_000,
        clockSkewToleranceMs: 60_000,
      }),
    ).not.toThrow();
    expect(() =>
      assertWithinValidity(evmPayload(), requirements(), {
        nowMs: 970_000,
        clockSkewToleranceMs: 60_000,
      }),
    ).not.toThrow();
  });

  it('refuses a standing authorization dressed up as a payment', () => {
    const payload = evmPayload({ validAfter: '0', validBefore: '31536000' });
    expect(() => assertWithinValidity(payload, requirements(), { nowMs: 1000 })).toThrow(
      expect.objectContaining({ reason: 'clock_skew_exceeded' }),
    );
  });

  it('refuses requirements whose timeout exceeds the accepted window when the payload is opaque', () => {
    expect(() =>
      assertWithinValidity(xrplPayload(), requirements({ maxTimeoutSeconds: 7200 }), {
        nowMs,
        maxValidityWindowMs: DEFAULT_MAX_VALIDITY_WINDOW_MS,
      }),
    ).toThrow(PayGuardError);
  });

  it('accepts an opaque payload whose requirements timeout is inside the window', () => {
    expect(() => assertWithinValidity(xrplPayload(), requirements(), { nowMs })).not.toThrow();
  });
});

describe('nonce ttl', () => {
  it('outlives the remaining payload window, per FR-2.1', () => {
    const ttl = nonceTtlMs(evmPayload(), requirements(), { nowMs: 1_500_000 });
    expect(ttl).toBeGreaterThanOrEqual(2_000_000 - 1_500_000);
  });

  it('falls back to the requirements timeout for an opaque payload', () => {
    const ttl = nonceTtlMs(xrplPayload(), requirements({ maxTimeoutSeconds: 120 }), {
      nowMs: 0,
      clockSkewToleranceMs: 1000,
    });
    expect(ttl).toBe(121_000);
  });

  it('never returns a negative ttl for an already expired payload', () => {
    const ttl = nonceTtlMs(evmPayload(), requirements(), {
      nowMs: 9_000_000,
      clockSkewToleranceMs: 0,
    });
    expect(ttl).toBe(60_000);
  });
});

describe('independent settlement verification', () => {
  const expectation: SettlementExpectation = {
    rail: 'base:usdc',
    network: 'base-sepolia',
    payTo: SELLER_BASE,
    asset: USDC_BASE_SEPOLIA,
    minAmount: '10000',
    minConfirmations: 1,
  };

  const observation = (overrides: Partial<ChainObservation> = {}): ChainObservation => ({
    network: 'base-sepolia',
    transactionHash: '0xfeed',
    recipient: SELLER_BASE,
    asset: USDC_BASE_SEPOLIA,
    amount: '10000',
    confirmations: 1,
    succeeded: true,
    ...overrides,
  });

  it('accepts a settlement that matches on every dimension', () => {
    expect(checkSettlement(observation(), expectation)).toEqual({ ok: true });
  });

  it('accepts an overpayment', () => {
    expect(checkSettlement(observation({ amount: '10001' }), expectation).ok).toBe(true);
  });

  it('rejects a rail that cannot settle on the expected network', () => {
    const result = checkSettlement(observation(), { ...expectation, rail: 'xrpl:xrp' });
    expect(result).toMatchObject({ ok: false, reason: 'unsupported_rail' });
  });

  it('rejects a settlement seen on another network', () => {
    const result = checkSettlement(observation({ network: 'base' }), expectation);
    expect(result).toMatchObject({ ok: false, reason: 'chain_network_mismatch' });
  });

  it('rejects a reverted transaction', () => {
    const result = checkSettlement(observation({ succeeded: false }), expectation);
    expect(result).toMatchObject({ ok: false, reason: 'chain_transaction_reverted' });
  });

  it('rejects payment to an address that is not the seller, which is the asset theft class', () => {
    const result = checkSettlement(
      observation({ recipient: '0x9999999999999999999999999999999999999999' }),
      expectation,
    );
    expect(result).toMatchObject({ ok: false, reason: 'chain_recipient_mismatch' });
  });

  it('rejects a different asset paid to the right address', () => {
    const result = checkSettlement(
      observation({ asset: '0x0000000000000000000000000000000000000001' }),
      expectation,
    );
    expect(result).toMatchObject({ ok: false, reason: 'chain_asset_mismatch' });
  });

  it('rejects an underpayment', () => {
    const result = checkSettlement(observation({ amount: '9999' }), expectation);
    expect(result).toMatchObject({ ok: false, reason: 'chain_amount_insufficient' });
  });

  it('rejects a transaction that is not confirmed deeply enough', () => {
    const result = checkSettlement(observation({ confirmations: 0 }), expectation);
    expect(result).toMatchObject({ ok: false, reason: 'chain_confirmation_failed' });
  });

  it('accepts a checksummed recipient on Base', () => {
    const result = checkSettlement(
      observation({ recipient: SELLER_BASE.toUpperCase().replace('0X', '0x') }),
      expectation,
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a case-shifted XRPL recipient', () => {
    const xrplExpectation: SettlementExpectation = {
      rail: 'xrpl:rlusd',
      network: 'xrpl-testnet',
      payTo: SELLER_XRPL,
      asset: RLUSD_TESTNET,
      minAmount: '10000',
      minConfirmations: 1,
    };
    const result = checkSettlement(
      {
        network: 'xrpl-testnet',
        transactionHash: 'ABC',
        recipient: SELLER_XRPL.toLowerCase(),
        asset: RLUSD_TESTNET,
        amount: '10000',
        confirmations: 1,
        succeeded: true,
      },
      xrplExpectation,
    );
    expect(result).toMatchObject({ ok: false, reason: 'chain_recipient_mismatch' });
  });

  it('builds an expectation from seller authored requirements only', () => {
    expect(expectationFromRequirements(requirements(), 'base:usdc', 3)).toEqual({
      rail: 'base:usdc',
      network: 'base-sepolia',
      payTo: SELLER_BASE,
      asset: USDC_BASE_SEPOLIA,
      minAmount: '10000',
      minConfirmations: 3,
    });
  });
});
