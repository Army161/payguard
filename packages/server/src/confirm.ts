import {
  checkSettlement,
  type ChainObservation,
  type Clock,
  type ExpectationResult,
  type SettlementExpectation,
} from '@payguard/core';
import type { Rail } from '@payguard/rails';

export interface ConfirmOptions {
  /** How long to keep waiting for the transaction to reach the required depth. */
  timeoutMs: number;
  /** How often to re-read the chain while waiting. */
  pollIntervalMs: number;
  clock: Clock;
  sleep?: (ms: number) => Promise<void>;
}

export interface ConfirmResult {
  result: ExpectationResult;
  observation: ChainObservation | null;
  attempts: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Waits for the chain to agree with the seller's expectation, or gives up.
 *
 * Only a shortfall in confirmation depth is worth waiting on, because it is the only failure that
 * time can fix. A wrong recipient or a short payment will still be wrong in thirty seconds, and
 * retrying those would hold the buyer's connection open for no reason.
 */
export async function confirmSettlement(
  rail: Rail,
  transactionHash: string,
  expectation: SettlementExpectation,
  options: ConfirmOptions,
): Promise<ConfirmResult> {
  const deadline = options.clock.now() + options.timeoutMs;
  const sleep = options.sleep ?? defaultSleep;
  let attempts = 0;
  let observation: ChainObservation | null = null;
  let result: ExpectationResult = {
    ok: false,
    reason: 'chain_transaction_not_found',
    message: 'settlement was never observed on chain',
    details: { transactionHash },
  };

  for (;;) {
    attempts += 1;
    try {
      observation = await rail.observe({
        transactionHash,
        network: expectation.network,
      });
      result = checkSettlement(observation, expectation);
      if (result.ok) return { result, observation, attempts };
      if (result.reason !== 'chain_confirmation_failed') {
        return { result, observation, attempts };
      }
    } catch (error) {
      result = {
        ok: false,
        reason: 'chain_transaction_not_found',
        message: error instanceof Error ? error.message : String(error),
        details: { transactionHash },
      };
    }

    if (options.clock.now() + options.pollIntervalMs > deadline) {
      return { result, observation, attempts };
    }
    await sleep(options.pollIntervalMs);
  }
}
