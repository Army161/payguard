import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { PolicyEngine, PolicyConfig } from './policy.js';
import { SpendContext } from './types.js';

describe('PolicyEngine Property Tests', () => {
  const defaultConfig: PolicyConfig = {
    maxPerTx: BigInt(1000),
    dailyCap: BigInt(5000),
    hourlyCap: BigInt(2000),
    maxVelocity: 10,
  };

  it('should always deny if amount exceeds maxPerTx', () => {
    fc.assert(
      fc.property(fc.bigUint().map(n => n + BigInt(1001)), (amount) => {
        const engine = new PolicyEngine(defaultConfig);
        const ctx: SpendContext = {
          amount: amount.toString(),
          counterparty: 'test',
          rail: 'base:usdc',
          velocity: 1,
          caps: { daily: '5000', hourly: '2000' },
        };
        const decision = engine.evaluate(ctx, { dailyTotal: BigInt(0), hourlyTotal: BigInt(0) });
        expect(decision.type).toBe('deny');
        if (decision.type === 'deny') {
          expect(decision.reason).toBe('EXCEEDS_MAX_PER_TX');
        }
      })
    );
  });

  it('should deny if daily cap is exceeded', () => {
    fc.assert(
      fc.property(fc.bigUint({ min: BigInt(1), max: BigInt(1000) }), (amount) => {
        const engine = new PolicyEngine(defaultConfig);
        const ctx: SpendContext = {
          amount: amount.toString(),
          counterparty: 'test',
          rail: 'base:usdc',
          velocity: 1,
          caps: { daily: '5000', hourly: '2000' },
        };
        // Set history so that adding amount exceeds 5000
        const history = { dailyTotal: BigInt(5001) - amount, hourlyTotal: BigInt(0) };
        const decision = engine.evaluate(ctx, history);
        expect(decision.type).toBe('deny');
        if (decision.type === 'deny') {
          expect(decision.reason).toBe('DAILY_CAP_EXCEEDED');
        }
      })
    );
  });

  it('should allow if all conditions are met', () => {
    const engine = new PolicyEngine(defaultConfig);
    const ctx: SpendContext = {
      amount: '100',
      counterparty: 'test',
      rail: 'base:usdc',
      velocity: 1,
      caps: { daily: '5000', hourly: '2000' },
    };
    const decision = engine.evaluate(ctx, { dailyTotal: BigInt(0), hourlyTotal: BigInt(0) });
    expect(decision.type).toBe('allow');
  });
});
