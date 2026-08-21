import type { ChainObservation, Network, RailId } from '@payguard/core';

export interface RailLookup {
  /** The settlement transaction hash reported by the facilitator. */
  transactionHash: string;
  /** The network the seller expects. A rail refuses a lookup on a network it does not serve. */
  network: Network;
}

/**
 * A rail turns a transaction hash into an independent observation of what the chain actually did.
 * It never decides whether that observation is acceptable; `checkSettlement` in @payguard/core
 * does, using the seller's own expectation. Keeping the two apart is what stops a rail adapter
 * from being able to wave a payment through.
 */
export interface Rail {
  readonly id: RailId;
  /** Networks this rail instance can query. */
  readonly networks: readonly Network[];
  observe(lookup: RailLookup): Promise<ChainObservation>;
  close(): Promise<void>;
}

export class RailLookupError extends Error {
  readonly transactionHash: string;

  constructor(message: string, transactionHash: string) {
    super(message);
    this.name = 'RailLookupError';
    this.transactionHash = transactionHash;
  }
}
