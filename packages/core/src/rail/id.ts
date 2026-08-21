import { z } from 'zod';
import type { Network } from '../x402/network.js';

/** A rail is a chain and asset pair. v1 ships three. */
export const RAIL_IDS = ['base:usdc', 'xrpl:rlusd', 'xrpl:xrp'] as const;

export const RailIdSchema = z.enum(RAIL_IDS);
export type RailId = z.infer<typeof RailIdSchema>;

export const CHAINS = ['base', 'xrpl'] as const;
export type Chain = (typeof CHAINS)[number];

export function chainOfRail(rail: RailId): Chain {
  return rail.split(':')[0] as Chain;
}

const NETWORK_CHAIN: Partial<Record<Network, Chain>> = {
  base: 'base',
  'base-sepolia': 'base',
  xrpl: 'xrpl',
  'xrpl-testnet': 'xrpl',
};

/** The chain a network belongs to, or undefined for a network no rail in v1 covers. */
export function chainOfNetwork(network: Network): Chain | undefined {
  return NETWORK_CHAIN[network];
}

/** True when a rail can settle on a network. Guards against a base rail on an XRPL network. */
export function railSupportsNetwork(rail: RailId, network: Network): boolean {
  const chain = chainOfNetwork(network);
  return chain !== undefined && chain === chainOfRail(rail);
}
