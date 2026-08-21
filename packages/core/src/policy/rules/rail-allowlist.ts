import type { PolicyRule } from '../types.js';

/** FR-3.1 asset and rail allowlist. Absent list means every rail the build supports. */
export const railAllowlistRule: PolicyRule = {
  id: 'rail-allowlist',
  evaluate(context, config) {
    const allowed = config.allowRails;
    if (allowed === undefined) return null;
    if (allowed.includes(context.rail)) return null;
    return {
      effect: 'deny',
      reason: 'rail_not_allowlisted',
      message: 'rail is not on the allowlist',
      details: { rail: context.rail, allowRails: allowed },
    };
  },
};
