import {
  PolicyConfigSchema,
  type Decision,
  type PolicyConfig,
  type PolicyConfigInput,
  type PolicyRule,
  type SpendContext,
} from './types.js';
import { counterpartyRule } from './rules/counterparty.js';
import { humanApprovalRule } from './rules/human-approval.js';
import { killSwitchRule } from './rules/kill-switch.js';
import { maxPerTransactionRule } from './rules/max-per-transaction.js';
import { priceToleranceRule } from './rules/price-tolerance.js';
import { railAllowlistRule } from './rules/rail-allowlist.js';
import { spendCapRule } from './rules/spend-cap.js';
import { testnetOnlyRule } from './rules/testnet-only.js';
import { velocityRule } from './rules/velocity.js';

/**
 * Evaluation order. Every rule runs, then the engine ranks the outcomes: any deny beats any
 * require_human, and the first deny in this order wins. Running every rule instead of returning at
 * the first hit means a context that trips several controls reports the most severe one, not
 * whichever happened to be checked first.
 */
export const DEFAULT_RULES: readonly PolicyRule[] = Object.freeze([
  killSwitchRule,
  testnetOnlyRule,
  railAllowlistRule,
  counterpartyRule,
  maxPerTransactionRule,
  priceToleranceRule,
  velocityRule,
  spendCapRule,
  humanApprovalRule,
]);

export interface PolicyEngineOptions {
  rules?: readonly PolicyRule[];
}

export class PolicyEngine {
  private readonly config: PolicyConfig;
  private readonly rules: readonly PolicyRule[];

  constructor(config: PolicyConfigInput = {}, options: PolicyEngineOptions = {}) {
    this.config = PolicyConfigSchema.parse(config);
    this.rules = options.rules ?? DEFAULT_RULES;
  }

  /** The parsed configuration, with defaults applied. Useful for logging what is actually on. */
  get policy(): PolicyConfig {
    return this.config;
  }

  evaluate(context: SpendContext): Decision {
    let escalation: Decision | null = null;

    for (const rule of this.rules) {
      const outcome = rule.evaluate(context, this.config);
      if (outcome === null) continue;

      if (outcome.effect === 'deny') {
        return {
          effect: 'deny',
          rule: rule.id,
          reason: outcome.reason,
          message: outcome.message,
          ...(outcome.details === undefined ? {} : { details: outcome.details }),
        };
      }

      escalation ??= {
        effect: 'require_human',
        rule: rule.id,
        reason: outcome.reason,
        message: outcome.message,
        ...(outcome.details === undefined ? {} : { details: outcome.details }),
      };
    }

    return escalation ?? { effect: 'allow', rule: null, reason: null, message: 'policy allows' };
  }
}

/**
 * A policy tight enough to be the documented starting point rather than an example. Operators are
 * expected to raise these, not to discover they were never set.
 */
export function strictPolicy(overrides: PolicyConfigInput = {}): PolicyConfig {
  return PolicyConfigSchema.parse({
    maxPerTransaction: '1000000',
    hourlyCap: '10000000',
    dailyCap: '50000000',
    maxTransactionsPerMinute: 30,
    priceToleranceBps: 500,
    humanApprovalThreshold: '5000000',
    requireTestnet: true,
    ...overrides,
  });
}
