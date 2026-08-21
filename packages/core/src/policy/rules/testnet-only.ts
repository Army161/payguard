import { isMainnet } from '../../x402/network.js';
import type { PolicyRule } from '../types.js';

/**
 * plan.md forbids mainnet before the third party audit. This rule is the buyer-side half of that
 * promise; `assertNetworkAllowed` in net/mainnet-guard.ts is the process-wide half.
 */
export const testnetOnlyRule: PolicyRule = {
  id: 'testnet-only',
  evaluate(context, config) {
    if (!config.requireTestnet) return null;
    if (!isMainnet(context.network)) return null;
    return {
      effect: 'deny',
      reason: 'mainnet_disabled',
      message: 'mainnet payments are disabled by policy',
      details: { network: context.network },
    };
  },
};
