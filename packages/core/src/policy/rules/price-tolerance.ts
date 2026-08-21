import { parseAtomic, scaleByBps } from '../../amount.js';
import type { PolicyRule } from '../types.js';

/**
 * FR-3.1 price-change tolerance. A seller that quotes one price, watches the agent commit, then
 * re-quotes higher is the metadata manipulation case in the threat model. Without a tolerance the
 * agent pays whatever the second quote says.
 */
export const priceToleranceRule: PolicyRule = {
  id: 'price-tolerance',
  evaluate(context, config) {
    const bps = config.priceToleranceBps;
    const quoted = context.quotedAmount;
    if (bps === undefined || quoted === undefined) return null;
    const ceiling = scaleByBps(quoted, bps);
    if (parseAtomic(context.amount) <= parseAtomic(ceiling)) return null;
    return {
      effect: 'deny',
      reason: 'price_change_exceeded',
      message: 'price moved further above the original quote than policy allows',
      details: {
        quotedAmount: quoted,
        amount: context.amount,
        priceToleranceBps: bps,
        ceiling,
      },
    };
  },
};
