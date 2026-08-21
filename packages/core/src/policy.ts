import { SpendContext, Decision } from './types.js';

export interface PolicyConfig {
  maxPerTx: bigint;
  dailyCap: bigint;
  hourlyCap: bigint;
  maxVelocity: number;
  allowList?: string[];
  denyList?: string[];
  humanThreshold?: bigint;
}

export class PolicyEngine {
  constructor(private config: PolicyConfig) {}

  evaluate(ctx: SpendContext, history: { dailyTotal: bigint, hourlyTotal: bigint }): Decision {
    const amount = BigInt(ctx.amount);

    // 1. Deny List
    if (this.config.denyList?.includes(ctx.counterparty)) {
      return { type: 'deny', reason: 'COUNTERPARTY_DENIED' };
    }

    // 2. Allow List (if present, only allow those)
    if (this.config.allowList && !this.config.allowList.includes(ctx.counterparty)) {
      return { type: 'deny', reason: 'COUNTERPARTY_NOT_IN_ALLOWLIST' };
    }

    // 3. Max Per Tx
    if (amount > this.config.maxPerTx) {
      return { type: 'deny', reason: 'EXCEEDS_MAX_PER_TX' };
    }

    // 4. Velocity
    if (ctx.velocity > this.config.maxVelocity) {
      return { type: 'deny', reason: 'VELOCITY_LIMIT_EXCEEDED' };
    }

    // 5. Caps
    if (history.dailyTotal + amount > this.config.dailyCap) {
      return { type: 'deny', reason: 'DAILY_CAP_EXCEEDED' };
    }
    if (history.hourlyTotal + amount > this.config.hourlyCap) {
      return { type: 'deny', reason: 'HOURLY_CAP_EXCEEDED' };
    }

    // 6. Human Approval Threshold
    if (this.config.humanThreshold && amount > this.config.humanThreshold) {
      return { type: 'require_human', reason: 'ABOVE_HUMAN_THRESHOLD' };
    }

    return { type: 'allow' };
  }
}
