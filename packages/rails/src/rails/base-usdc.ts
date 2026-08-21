import {
  createPublicClient,
  erc20Abi,
  http,
  isAddress,
  parseEventLogs,
  type PublicClient,
} from 'viem';
import { PayGuardError, type ChainObservation, type Network, type RailId } from '@payguard/core';
import { RailLookupError, type Rail, type RailLookup } from './interface.js';

export interface BaseUsdcRailOptions {
  rpcUrl: string;
  network: Network;
  /** The USDC contract on the configured network. */
  asset: string;
  /** Injected for tests and for callers that already hold a client. */
  client?: PublicClient;
}

/**
 * Base rail. Reads the receipt through an RPC the seller controls, not through the facilitator,
 * which is the whole point of FR-1.1.
 *
 * A receipt with status "success" is not enough on its own: a transaction can succeed while paying
 * someone else, or paying the right person in the wrong token. So the Transfer log is decoded and
 * the recipient, token contract, and value are read from the log itself.
 */
export class BaseUsdcRail implements Rail {
  readonly id: RailId = 'base:usdc';
  readonly networks: readonly Network[];

  private readonly client: PublicClient;
  private readonly asset: `0x${string}`;
  private readonly network: Network;

  constructor(options: BaseUsdcRailOptions) {
    if (!isAddress(options.asset)) {
      throw new PayGuardError(
        'unsupported_rail',
        `base:usdc asset must be a contract address, got ${options.asset}`,
      );
    }
    this.asset = options.asset as `0x${string}`;
    this.network = options.network;
    this.networks = [options.network];
    this.client =
      options.client ??
      (createPublicClient({ transport: http(options.rpcUrl) }) as unknown as PublicClient);
  }

  async observe(lookup: RailLookup): Promise<ChainObservation> {
    if (lookup.network !== this.network) {
      throw new RailLookupError(
        `base:usdc rail is configured for ${this.network}, not ${lookup.network}`,
        lookup.transactionHash,
      );
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(lookup.transactionHash)) {
      throw new RailLookupError('not an EVM transaction hash', lookup.transactionHash);
    }

    const hash = lookup.transactionHash as `0x${string}`;
    const receipt = await this.client.getTransactionReceipt({ hash }).catch(() => null);
    if (receipt === null) {
      throw new RailLookupError(
        'transaction not found on the configured RPC',
        lookup.transactionHash,
      );
    }

    const currentBlock = await this.client.getBlockNumber();
    const confirmations =
      currentBlock >= receipt.blockNumber ? Number(currentBlock - receipt.blockNumber) + 1 : 0;

    const succeeded = receipt.status === 'success';

    // Only logs emitted by the expected token contract are considered. A transfer of some other
    // ERC-20 in the same transaction must not be able to stand in for the payment.
    const transfers = parseEventLogs({
      abi: erc20Abi,
      eventName: 'Transfer',
      logs: receipt.logs,
    }).filter((log) => log.address.toLowerCase() === this.asset.toLowerCase());

    // The largest transfer to any single recipient is reported. checkSettlement then decides
    // whether that recipient is the seller. Summing across recipients would let a payment split
    // between the seller and an attacker look like a full payment.
    const byRecipient = new Map<string, bigint>();
    for (const log of transfers) {
      const to = log.args.to.toLowerCase();
      byRecipient.set(to, (byRecipient.get(to) ?? 0n) + log.args.value);
    }

    let recipient = '';
    let amount = 0n;
    for (const [to, value] of byRecipient) {
      if (value > amount) {
        recipient = to;
        amount = value;
      }
    }

    return {
      network: this.network,
      transactionHash: lookup.transactionHash,
      recipient,
      asset: this.asset,
      amount: amount.toString(),
      confirmations,
      succeeded: succeeded && transfers.length > 0,
    };
  }

  async close(): Promise<void> {
    // The HTTP transport holds no persistent connection to release.
  }
}
