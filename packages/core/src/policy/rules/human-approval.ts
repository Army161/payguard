import { parseAtomic } from '../../amount.js';
import type { PolicyRule } from '../types.js';

/**
 * FR-3.1 human approval threshold. This is the only rule that returns require_human, and the
 * engine ranks any deny above it, so a payment that is both large and over the daily cap is
 * refused rather than escalated.
 */
export const humanApprovalRule: PolicyRule = {
  id: 'human-approval',
  evaluate(context, config) {
    const threshold = config.humanApprovalThreshold;
    if (threshold === undefined) return null;
    if (parseAtomic(context.amount) < parseAtomic(threshold)) return null;
    return {
      effect: 'require_human',
      reason: 'human_approval_required',
      message: 'payment is at or above the human approval threshold',
      details: { amount: context.amount, humanApprovalThreshold: threshold },
    };
  },
};
