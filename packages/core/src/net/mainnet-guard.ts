import { PayGuardError } from '../errors.js';
import { isMainnet, type Network } from '../x402/network.js';

export const MAINNET_ENV_FLAG = 'PAYGUARD_ALLOW_MAINNET';

/**
 * plan.md: no mainnet before the third party audit. A policy flag alone is not enough, because a
 * misconfigured policy is exactly the failure this is guarding against, so the check also reads
 * the process environment and defaults to refusing.
 */
export function mainnetAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[MAINNET_ENV_FLAG] === 'true';
}

export function assertNetworkAllowed(network: Network, env: NodeJS.ProcessEnv = process.env): void {
  if (!isMainnet(network)) return;
  if (mainnetAllowed(env)) return;
  throw new PayGuardError(
    'mainnet_disabled',
    `refusing to operate on mainnet network ${network}; set ${MAINNET_ENV_FLAG}=true only after the third party audit`,
    { network },
  );
}
