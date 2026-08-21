import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  DEFAULT_RULES,
  EMPTY_SNAPSHOT,
  PolicyEngine,
  strictPolicy,
  type PolicyConfigInput,
  type SpendContext,
  type SpendSnapshot,
} from '@payguard/core';
import { SELLER_BASE, USDC_BASE_SEPOLIA } from './fixtures.js';

function context(overrides: Partial<SpendContext> = {}): SpendContext {
  return {
    agentId: 'agent-1',
    counterparty: SELLER_BASE,
    rail: 'base:usdc',
    network: 'base-sepolia',
    asset: USDC_BASE_SEPOLIA,
    amount: '10000',
    killSwitchEngaged: false,
    snapshot: EMPTY_SNAPSHOT,
    nowMs: 1_700_000_000_000,
    ...overrides,
  };
}

const decide = (config: PolicyConfigInput, ctx: Partial<SpendContext> = {}) =>
  new PolicyEngine(config).evaluate(context(ctx));

describe('policy engine', () => {
  it('allows when nothing is configured and the network is a testnet', () => {
    expect(decide({})).toMatchObject({ effect: 'allow', reason: null });
  });

  it('exposes the parsed policy including defaults', () => {
    expect(new PolicyEngine({}).policy.requireTestnet).toBe(true);
  });

  it('blocks everything while the kill switch is engaged, per AT-7', () => {
    expect(decide({}, { killSwitchEngaged: true })).toMatchObject({
      effect: 'deny',
      reason: 'kill_switch_engaged',
      rule: 'kill-switch',
    });
  });

  it('blocks mainnet by default, per plan.md', () => {
    expect(decide({}, { network: 'base' })).toMatchObject({
      effect: 'deny',
      reason: 'mainnet_disabled',
    });
  });

  it('permits mainnet only when the policy explicitly opts in', () => {
    expect(decide({ requireTestnet: false }, { network: 'base' })).toMatchObject({
      effect: 'allow',
    });
  });

  it('blocks a rail that is not on the allowlist', () => {
    expect(decide({ allowRails: ['xrpl:rlusd'] })).toMatchObject({
      effect: 'deny',
      reason: 'rail_not_allowlisted',
    });
  });

  it('allows a rail that is on the allowlist', () => {
    expect(decide({ allowRails: ['base:usdc'] })).toMatchObject({ effect: 'allow' });
  });

  it('blocks a denied counterparty even when it is also allowlisted', () => {
    expect(
      decide({ allowCounterparties: [SELLER_BASE], denyCounterparties: [SELLER_BASE] }),
    ).toMatchObject({ effect: 'deny', reason: 'counterparty_denied' });
  });

  it('blocks a counterparty missing from a configured allowlist', () => {
    expect(decide({ allowCounterparties: ['0xother'] })).toMatchObject({
      effect: 'deny',
      reason: 'counterparty_not_allowlisted',
    });
  });

  it('enforces the per-transaction maximum at the boundary', () => {
    expect(decide({ maxPerTransaction: '10000' })).toMatchObject({ effect: 'allow' });
    expect(decide({ maxPerTransaction: '9999' })).toMatchObject({
      effect: 'deny',
      reason: 'max_per_transaction_exceeded',
    });
  });

  it('counts the pending payment against the hourly cap, per AT-6', () => {
    const snapshot: SpendSnapshot = { ...EMPTY_SNAPSHOT, hourAtomic: '95000' };
    expect(decide({ hourlyCap: '100000' }, { snapshot, amount: '5000' })).toMatchObject({
      effect: 'allow',
    });
    expect(decide({ hourlyCap: '100000' }, { snapshot, amount: '5001' })).toMatchObject({
      effect: 'deny',
      reason: 'spend_cap_exceeded',
      details: { window: 'hour' },
    });
  });

  it('enforces the daily cap independently of the hourly one', () => {
    const snapshot: SpendSnapshot = { ...EMPTY_SNAPSHOT, hourAtomic: '0', dayAtomic: '990000' };
    expect(decide({ dailyCap: '1000000' }, { snapshot, amount: '10001' })).toMatchObject({
      effect: 'deny',
      reason: 'spend_cap_exceeded',
      details: { window: 'day' },
    });
  });

  it('counts the pending payment against the velocity limit', () => {
    const snapshot: SpendSnapshot = { ...EMPTY_SNAPSHOT, lastMinuteCount: 4 };
    expect(decide({ maxTransactionsPerMinute: 5 }, { snapshot })).toMatchObject({
      effect: 'allow',
    });
    expect(decide({ maxTransactionsPerMinute: 4 }, { snapshot })).toMatchObject({
      effect: 'deny',
      reason: 'velocity_exceeded',
    });
  });

  it('blocks a re-quote that moves further above the original than tolerance allows', () => {
    expect(
      decide({ priceToleranceBps: 500 }, { amount: '10500', quotedAmount: '10000' }),
    ).toMatchObject({ effect: 'allow' });
    expect(
      decide({ priceToleranceBps: 500 }, { amount: '10501', quotedAmount: '10000' }),
    ).toMatchObject({ effect: 'deny', reason: 'price_change_exceeded' });
  });

  it('has no opinion on price when there was no earlier quote', () => {
    expect(decide({ priceToleranceBps: 0 }, { amount: '999999' })).toMatchObject({
      effect: 'allow',
    });
  });

  it('escalates at or above the human approval threshold', () => {
    expect(decide({ humanApprovalThreshold: '10001' })).toMatchObject({ effect: 'allow' });
    expect(decide({ humanApprovalThreshold: '10000' })).toMatchObject({
      effect: 'require_human',
      reason: 'human_approval_required',
    });
  });

  it('prefers a deny over an escalation when a context trips both', () => {
    const decision = decide(
      { humanApprovalThreshold: '1', maxPerTransaction: '1' },
      { amount: '10000' },
    );
    expect(decision).toMatchObject({ effect: 'deny', reason: 'max_per_transaction_exceeded' });
  });

  it('runs a caller supplied rule set instead of the default one', () => {
    const engine = new PolicyEngine({}, { rules: [] });
    expect(engine.evaluate(context({ killSwitchEngaged: true }))).toMatchObject({
      effect: 'allow',
    });
  });

  it('ships a strict starting policy rather than an empty one', () => {
    const policy = strictPolicy();
    expect(policy.requireTestnet).toBe(true);
    expect(policy.maxPerTransaction).toBe('1000000');
    expect(strictPolicy({ maxPerTransaction: '5' }).maxPerTransaction).toBe('5');
  });

  it('rejects a policy with a negative velocity limit at parse time', () => {
    expect(() => new PolicyEngine({ maxTransactionsPerMinute: -1 })).toThrow();
  });
});

describe('policy engine properties', () => {
  const amount = fc.bigInt({ min: 1n, max: 10n ** 12n }).map(String);

  it('an engaged kill switch denies for every configuration and every context', () => {
    fc.assert(
      fc.property(amount, fc.boolean(), (value, requireTestnet) => {
        const decision = decide(
          { requireTestnet, maxPerTransaction: value, humanApprovalThreshold: '1' },
          { killSwitchEngaged: true, amount: value },
        );
        expect(decision.effect).toBe('deny');
        expect(decision.reason).toBe('kill_switch_engaged');
      }),
    );
  });

  it('a payment at or below every configured limit is never denied', () => {
    fc.assert(
      fc.property(amount, (value) => {
        const decision = decide(
          {
            maxPerTransaction: value,
            hourlyCap: value,
            dailyCap: value,
            maxTransactionsPerMinute: 1,
          },
          { amount: value },
        );
        expect(decision.effect).toBe('allow');
      }),
    );
  });

  it('raising the amount past the per-transaction cap always denies', () => {
    fc.assert(
      fc.property(amount, (value) => {
        const over = (BigInt(value) + 1n).toString();
        expect(decide({ maxPerTransaction: value }, { amount: over }).effect).toBe('deny');
      }),
    );
  });

  it('every rule id in the default set is unique, so decisions are attributable', () => {
    const ids = DEFAULT_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('decision shape', () => {
  it('omits details entirely when a rule supplies none', () => {
    const engine = new PolicyEngine(
      {},
      {
        rules: [
          {
            id: 'bare-deny',
            evaluate: () => ({ effect: 'deny', reason: 'internal_error', message: 'no details' }),
          },
        ],
      },
    );
    const decision = engine.evaluate(context());
    expect(decision).toEqual({
      effect: 'deny',
      rule: 'bare-deny',
      reason: 'internal_error',
      message: 'no details',
    });
    expect('details' in decision).toBe(false);
  });

  it('omits details on a bare escalation too', () => {
    const engine = new PolicyEngine(
      {},
      {
        rules: [
          {
            id: 'bare-escalate',
            evaluate: () => ({
              effect: 'require_human',
              reason: 'human_approval_required',
              message: 'ask someone',
            }),
          },
        ],
      },
    );
    expect(engine.evaluate(context())).toEqual({
      effect: 'require_human',
      rule: 'bare-escalate',
      reason: 'human_approval_required',
      message: 'ask someone',
    });
  });

  it('keeps the first escalation when two rules both escalate', () => {
    const escalate = (id: string) => ({
      id,
      evaluate: () => ({
        effect: 'require_human' as const,
        reason: 'human_approval_required' as const,
        message: id,
      }),
    });
    const engine = new PolicyEngine({}, { rules: [escalate('first'), escalate('second')] });
    expect(engine.evaluate(context())).toMatchObject({ rule: 'first' });
  });
});
