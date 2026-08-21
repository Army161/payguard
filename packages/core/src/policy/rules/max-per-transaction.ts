import { parseAtomic } from '../../amount.js';
import type { PolicyRule } from '../types.js';

/** FR-3.1 per-transaction ceiling. */
export const maxPerTransactionRule: PolicyRule = {
  id: 'max-per-transaction',
  evaluate(context, config) {
    const max = config.maxPerTransaction;
    if (max === undefined) return null;
    if (parseAtomic(context.amount) <= parseAtomic(max)) return null;
    return {
      effect: 'deny',
      reason: 'max_per_transaction_exceeded',
      message: 'payment exceeds the per-transaction maximum',
      details: { amount: context.amount, maxPerTransaction: max },
    };
  },
};
