import { covers } from '../amount.js';
import type { ReasonCode } from '../errors.js';
import { chainOfRail, railSupportsNetwork, type RailId } from '../rail/id.js';
import type { Network } from '../x402/network.js';
import type { PaymentRequirements } from '../x402/requirements.js';
import { addressEquals } from './address.js';

/**
 * What the seller demands of a settlement. Built from the seller's own configuration, never from
 * anything the buyer or the facilitator sent, which is the whole point of FR-1.2.
 */
export interface SettlementExpectation {
  rail: RailId;
  network: Network;
  /** The seller's address on this rail. */
  payTo: string;
  /** ERC-20 contract on Base, or `currency.issuer` on XRPL. Compared case sensitively on XRPL. */
  asset: string;
  /** The price, in atomic units. A settlement may deliver more but never less. */
  minAmount: string;
  /** Confirmations required before the resource is released. */
  minConfirmations: number;
}

/** What an independent RPC actually observed on chain. */
export interface ChainObservation {
  network: Network;
  transactionHash: string;
  /** Recipient of the value, as reported by the chain, not by the facilitator. */
  recipient: string;
  /** Asset identifier, in the same form as SettlementExpectation.asset. */
  asset: string;
  /** Delivered amount in atomic units. */
  amount: string;
  confirmations: number;
  /** False when the transaction reverted or the ledger result was not success. */
  succeeded: boolean;
  /** XRPL memo or source tag used to correlate a payment with a request, per FR-5.2. */
  correlation?: string | undefined;
}

export type ExpectationResult =
  | { ok: true }
  | { ok: false; reason: ReasonCode; message: string; details: Record<string, unknown> };

function fail(
  reason: ReasonCode,
  message: string,
  details: Record<string, unknown>,
): ExpectationResult {
  return { ok: false, reason, message, details };
}

/**
 * The independent check that stands between a lying facilitator and a delivered resource.
 * Order matters: cheapest and most fundamental checks first, so the failure reason returned is the
 * most specific true statement about why this settlement is not acceptable.
 */
export function checkSettlement(
  observation: ChainObservation,
  expectation: SettlementExpectation,
): ExpectationResult {
  if (!railSupportsNetwork(expectation.rail, expectation.network)) {
    return fail('unsupported_rail', 'rail cannot settle on the expected network', {
      rail: expectation.rail,
      network: expectation.network,
    });
  }

  if (observation.network !== expectation.network) {
    return fail('chain_network_mismatch', 'settlement observed on the wrong network', {
      observed: observation.network,
      expected: expectation.network,
    });
  }

  if (!observation.succeeded) {
    return fail('chain_transaction_reverted', 'settlement transaction did not succeed on chain', {
      transactionHash: observation.transactionHash,
    });
  }

  const chain = chainOfRail(expectation.rail);

  if (!addressEquals(chain, observation.recipient, expectation.payTo)) {
    return fail('chain_recipient_mismatch', 'settlement paid an address other than the seller', {
      observed: observation.recipient,
      expected: expectation.payTo,
    });
  }

  if (!addressEquals(chain, observation.asset, expectation.asset)) {
    return fail('chain_asset_mismatch', 'settlement moved an asset other than the expected one', {
      observed: observation.asset,
      expected: expectation.asset,
    });
  }

  if (!covers(observation.amount, expectation.minAmount)) {
    return fail('chain_amount_insufficient', 'settlement delivered less than the price', {
      observed: observation.amount,
      expected: expectation.minAmount,
    });
  }

  if (observation.confirmations < expectation.minConfirmations) {
    return fail('chain_confirmation_failed', 'settlement is not confirmed deeply enough yet', {
      confirmations: observation.confirmations,
      required: expectation.minConfirmations,
    });
  }

  return { ok: true };
}

/**
 * Derives the expectation from the seller's own requirements entry. `requirements` is seller
 * authored, so this is safe. It exists so the middleware cannot accidentally build an expectation
 * out of buyer-controlled fields.
 */
export function expectationFromRequirements(
  requirements: PaymentRequirements,
  rail: RailId,
  minConfirmations: number,
): SettlementExpectation {
  return {
    rail,
    network: requirements.network,
    payTo: requirements.payTo,
    asset: requirements.asset,
    minAmount: requirements.maxAmountRequired,
    minConfirmations,
  };
}
