import { describe, expect, it } from 'vitest';
import {
  MAINNET_ENV_FLAG,
  PayGuardError,
  assertNetworkAllowed,
  chainOfNetwork,
  chainOfRail,
  defineConfig,
  fixedClock,
  isPayGuardError,
  mainnetAllowed,
  railSupportsNetwork,
  systemClock,
  PayGuardConfigSchema,
  RAIL_IDS,
} from '@payguard/core';
import { SELLER_BASE, USDC_BASE_SEPOLIA } from './fixtures.js';

const minimal = {
  rails: [
    {
      id: 'base:usdc' as const,
      network: 'base-sepolia' as const,
      asset: USDC_BASE_SEPOLIA,
      payTo: SELLER_BASE,
      decimals: 6,
      rpcUrl: 'https://sepolia.base.org',
    },
  ],
  facilitators: [
    { id: 'coinbase', url: 'https://x402.org/facilitator', rails: ['base:usdc' as const] },
  ],
};

describe('rail identity', () => {
  it('maps each rail to its chain', () => {
    expect(chainOfRail('base:usdc')).toBe('base');
    expect(chainOfRail('xrpl:rlusd')).toBe('xrpl');
    expect(chainOfRail('xrpl:xrp')).toBe('xrpl');
  });

  it('maps networks to chains and leaves unrelated networks unmapped', () => {
    expect(chainOfNetwork('base-sepolia')).toBe('base');
    expect(chainOfNetwork('xrpl-testnet')).toBe('xrpl');
    expect(chainOfNetwork('solana')).toBeUndefined();
  });

  it('rejects a rail and network combination from different chains', () => {
    expect(railSupportsNetwork('base:usdc', 'base-sepolia')).toBe(true);
    expect(railSupportsNetwork('base:usdc', 'xrpl-testnet')).toBe(false);
    expect(railSupportsNetwork('xrpl:xrp', 'solana')).toBe(false);
  });

  it('ships exactly the three rails v1 promises', () => {
    expect([...RAIL_IDS]).toEqual(['base:usdc', 'xrpl:rlusd', 'xrpl:xrp']);
  });
});

describe('configuration', () => {
  it('defaults to strict mode with a memory store and a testnet-only policy', () => {
    const config = defineConfig(minimal);
    expect(config.mode).toBe('strict');
    expect(config.store).toEqual({ kind: 'memory' });
    expect(config.policy.requireTestnet).toBe(true);
    expect(config.killSwitch.file).toBe('.payguard-halt');
    expect(config.rails[0]?.minConfirmations).toBe(1);
  });

  it('requires at least one rail and one facilitator', () => {
    expect(PayGuardConfigSchema.safeParse({ ...minimal, rails: [] }).success).toBe(false);
    expect(PayGuardConfigSchema.safeParse({ ...minimal, facilitators: [] }).success).toBe(false);
  });

  it('rejects a facilitator url that is not a url', () => {
    expect(
      PayGuardConfigSchema.safeParse({
        ...minimal,
        facilitators: [{ id: 'x', url: 'not a url', rails: ['base:usdc'] }],
      }).success,
    ).toBe(false);
  });

  it('accepts a sqlite and a redis store', () => {
    expect(
      defineConfig({ ...minimal, store: { kind: 'sqlite', path: './p.sqlite' } }).store,
    ).toEqual({ kind: 'sqlite', path: './p.sqlite' });
    expect(defineConfig({ ...minimal, store: { kind: 'redis', url: 'redis://x' } }).store).toEqual({
      kind: 'redis',
      url: 'redis://x',
      keyPrefix: 'payguard:',
    });
  });

  it('caps the kill switch poll interval at one second so AT-7 stays achievable', () => {
    expect(
      PayGuardConfigSchema.safeParse({ ...minimal, killSwitch: { pollIntervalMs: 5000 } }).success,
    ).toBe(false);
  });
});

describe('mainnet guard', () => {
  it('allows testnets regardless of the flag', () => {
    expect(() => assertNetworkAllowed('base-sepolia', {})).not.toThrow();
    expect(() => assertNetworkAllowed('xrpl-testnet', {})).not.toThrow();
  });

  it('refuses mainnet when the flag is unset', () => {
    expect(() => assertNetworkAllowed('base', {})).toThrow(PayGuardError);
    expect(mainnetAllowed({})).toBe(false);
  });

  it('refuses mainnet when the flag is anything other than the exact string true', () => {
    expect(mainnetAllowed({ [MAINNET_ENV_FLAG]: '1' })).toBe(false);
    expect(mainnetAllowed({ [MAINNET_ENV_FLAG]: 'TRUE' })).toBe(false);
    expect(() => assertNetworkAllowed('xrpl', { [MAINNET_ENV_FLAG]: 'yes' })).toThrow();
  });

  it('allows mainnet only on an exact opt in', () => {
    expect(mainnetAllowed({ [MAINNET_ENV_FLAG]: 'true' })).toBe(true);
    expect(() => assertNetworkAllowed('base', { [MAINNET_ENV_FLAG]: 'true' })).not.toThrow();
  });

  it('reads process.env when no environment is passed', () => {
    expect(typeof mainnetAllowed()).toBe('boolean');
  });

  it('carries a machine readable reason', () => {
    try {
      assertNetworkAllowed('base', {});
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isPayGuardError(error)).toBe(true);
      expect((error as PayGuardError).toBody()).toMatchObject({ reason: 'mainnet_disabled' });
    }
  });
});

describe('errors', () => {
  it('serializes with details when present and without when absent', () => {
    expect(new PayGuardError('replay_detected', 'seen before').toBody()).toEqual({
      reason: 'replay_detected',
      message: 'seen before',
    });
    expect(new PayGuardError('replay_detected', 'seen before', { k: 1 }).toBody()).toEqual({
      reason: 'replay_detected',
      message: 'seen before',
      details: { k: 1 },
    });
  });

  it('recognises only its own error type', () => {
    expect(isPayGuardError(new Error('nope'))).toBe(false);
    expect(isPayGuardError(null)).toBe(false);
  });
});

describe('clocks', () => {
  it('the system clock returns a plausible epoch time', () => {
    expect(systemClock.now()).toBeGreaterThan(1_600_000_000_000);
  });

  it('a fixed clock only moves when told to', () => {
    const clock = fixedClock(1000);
    expect(clock.now()).toBe(1000);
    clock.advance(500);
    expect(clock.now()).toBe(1500);
    clock.set(42);
    expect(clock.now()).toBe(42);
  });
});
