import { parseAtomic } from '../../amount.js';
import type { PolicyRule } from '../types.js';

/**
 * FR-3.1 hourly and daily caps. The pending amount is added to what has already been spent before
 * the comparison, so a payment that would cross the cap is refused rather than being the one that
 * discovers the cap was crossed.
 */
export const spendCapRule: PolicyRule = {
  id: 'spend-cap',
  evaluate(context, config) {
    const pending = parseAtomic(context.amount);

    if (config.hourlyCap !== undefined) {
      const projected = parseAtomic(context.snapshot.hourAtomic) + pending;
      const cap = parseAtomic(config.hourlyCap);
      if (projected > cap) {
        return {
          effect: 'deny',
          reason: 'spend_cap_exceeded',
          message: 'payment would exceed the hourly spend cap',
          details: {
            window: 'hour',
            spent: context.snapshot.hourAtomic,
            amount: context.amount,
            cap: config.hourlyCap,
          },
        };
      }
    }

    if (config.dailyCap !== undefined) {
      const projected = parseAtomic(context.snapshot.dayAtomic) + pending;
      const cap = parseAtomic(config.dailyCap);
      if (projected > cap) {
        return {
          effect: 'deny',
          reason: 'spend_cap_exceeded',
          message: 'payment would exceed the daily spend cap',
          details: {
            window: 'day',
            spent: context.snapshot.dayAtomic,
            amount: context.amount,
            cap: config.dailyCap,
          },
        };
      }
    }

    return null;
  },
};
