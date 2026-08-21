import type { PolicyRule } from '../types.js';

/**
 * FR-3.3. Nothing gets past an engaged kill switch, so this rule runs first and has no
 * configuration to misconfigure.
 */
export const killSwitchRule: PolicyRule = {
  id: 'kill-switch',
  evaluate(context) {
    if (!context.killSwitchEngaged) return null;
    return {
      effect: 'deny',
      reason: 'kill_switch_engaged',
      message: 'kill switch is engaged, all payments are halted',
      details: { agentId: context.agentId },
    };
  },
};
