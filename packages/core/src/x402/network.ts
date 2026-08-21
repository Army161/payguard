import { z } from 'zod';

/**
 * Networks defined by the x402 v1 reference SDK. Kept in this order and spelling so the
 * conformance tests in @payguard/rails can compare it against the SDK's own enum.
 */
export const X402_NETWORKS = [
  'abstract',
  'abstract-testnet',
  'base-sepolia',
  'base',
  'avalanche-fuji',
  'avalanche',
  'iotex',
  'solana-devnet',
  'solana',
  'sei',
  'sei-testnet',
  'polygon',
  'polygon-amoy',
  'peaq',
  'story',
  'educhain',
  'skale-base-sepolia',
] as const;

/**
 * XRPL networks. x402 v1 has no XRPL entry, so PayGuard extends the enum. The XRPL x402
 * facilitators (t54) advertise these names.
 */
export const PAYGUARD_EXTRA_NETWORKS = ['xrpl', 'xrpl-testnet'] as const;

export const NETWORKS = [...X402_NETWORKS, ...PAYGUARD_EXTRA_NETWORKS] as const;

export const NetworkSchema = z.enum(NETWORKS);
export type Network = z.infer<typeof NetworkSchema>;

/**
 * Networks that move real money. PayGuard refuses these unless the operator sets
 * PAYGUARD_ALLOW_MAINNET, because plan.md forbids mainnet before the third party audit.
 */
const MAINNET_NETWORKS = new Set<Network>([
  'abstract',
  'base',
  'avalanche',
  'iotex',
  'solana',
  'sei',
  'polygon',
  'peaq',
  'story',
  'educhain',
  'xrpl',
]);

export function isMainnet(network: Network): boolean {
  return MAINNET_NETWORKS.has(network);
}

export function isTestnet(network: Network): boolean {
  return !isMainnet(network);
}
