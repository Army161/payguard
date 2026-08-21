import { X402_VERSION, type PaymentRequirements, type X402Response } from '@payguard/core';
import type { ProtectedRail } from './types.js';

/**
 * Builds the seller's `accepts` list for one resource. FR-4.3 wants several rails advertised at
 * once so a buyer whose preferred facilitator is down has somewhere to go without another round
 * trip.
 */
export function buildAccepts(
  rails: readonly ProtectedRail[],
  resource: string,
): PaymentRequirements[] {
  return rails.map((entry) => ({ ...entry.requirements, resource }));
}

export function paymentRequiredBody(
  rails: readonly ProtectedRail[],
  resource: string,
  error: string,
): X402Response {
  return {
    x402Version: X402_VERSION,
    accepts: buildAccepts(rails, resource),
    error,
  };
}

/**
 * Finds the rail the buyer's payload is for. The match is on network and asset, and the seller's
 * own advertised entry is what gets returned, so a buyer cannot select a rail by naming one.
 */
export function matchRail(
  rails: readonly ProtectedRail[],
  network: string,
): ProtectedRail | undefined {
  return rails.find((entry) => entry.requirements.network === network);
}
