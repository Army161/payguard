import type { PolicyRule } from '../types.js';

/**
 * FR-3.1 velocity limit. Counts the payment about to be made, so a limit of 1 permits one payment
 * per minute rather than two.
 */
export const velocityRule: PolicyRule = {
  id: 'velocity',
  evaluate(context, config) {
    const limit = config.maxTransactionsPerMinute;
    if (limit === undefined) return null;
    const projected = context.snapshot.lastMinuteCount + 1;
    if (projected <= limit) return null;
    return {
      effect: 'deny',
      reason: 'velocity_exceeded',
      message: 'payment would exceed the per-minute transaction limit',
      details: {
        lastMinuteCount: context.snapshot.lastMinuteCount,
        maxTransactionsPerMinute: limit,
      },
    };
  },
};
