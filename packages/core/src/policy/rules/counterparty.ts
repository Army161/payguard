import type { PolicyRule } from '../types.js';

/**
 * FR-3.1 counterparty control. The deny list wins over the allow list, so adding an address to the
 * deny list is always sufficient to stop payments to it.
 */
export const counterpartyRule: PolicyRule = {
  id: 'counterparty',
  evaluate(context, config) {
    const target = context.counterparty;
    if (config.denyCounterparties?.includes(target) === true) {
      return {
        effect: 'deny',
        reason: 'counterparty_denied',
        message: 'counterparty is on the deny list',
        details: { counterparty: target },
      };
    }
    const allow = config.allowCounterparties;
    if (allow !== undefined && !allow.includes(target)) {
      return {
        effect: 'deny',
        reason: 'counterparty_not_allowlisted',
        message: 'counterparty is not on the allow list',
        details: { counterparty: target },
      };
    }
    return null;
  },
};
