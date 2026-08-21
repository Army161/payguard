import {
  chainOfNetwork,
  type PaymentRequirements,
  type RailId,
  type Network,
} from '@payguard/core';

export interface RailChoice {
  requirements: PaymentRequirements;
  rail: RailId;
}

export interface RouteOptions {
  /** Rails this buyer is willing to pay on, in order of preference. */
  allowRails?: readonly RailId[];
  /** Rails already tried and failed in this exchange. */
  exclude?: ReadonlySet<RailId>;
}

/**
 * Maps a seller's advertised entry to a PayGuard rail id.
 *
 * The asset shape is what distinguishes the two XRPL rails: the native asset is written "XRP" and
 * an issued currency as "CURRENCY.rIssuer". Guessing from the network alone would route an RLUSD
 * price to the XRP rail and verify the wrong asset.
 */
export function railOf(requirements: PaymentRequirements): RailId | undefined {
  const chain = chainOfNetwork(requirements.network as Network);
  if (chain === 'base') return 'base:usdc';
  if (chain === 'xrpl') return requirements.asset === 'XRP' ? 'xrpl:xrp' : 'xrpl:rlusd';
  return undefined;
}

/**
 * Picks which of the seller's accepted rails to pay on, per FR-4.2.
 *
 * Order is the buyer's preference list, not the seller's advertisement order. A seller that lists
 * its most expensive rail first should not be able to steer the buyer by ordering alone.
 */
export function chooseRail(
  accepts: readonly PaymentRequirements[],
  options: RouteOptions = {},
): RailChoice | undefined {
  const candidates: RailChoice[] = [];
  for (const requirements of accepts) {
    const rail = railOf(requirements);
    if (rail === undefined) continue;
    if (options.exclude?.has(rail) === true) continue;
    if (options.allowRails !== undefined && !options.allowRails.includes(rail)) continue;
    candidates.push({ requirements, rail });
  }

  if (options.allowRails === undefined) return candidates[0];

  for (const preferred of options.allowRails) {
    const match = candidates.find((c) => c.rail === preferred);
    if (match !== undefined) return match;
  }
  return undefined;
}
