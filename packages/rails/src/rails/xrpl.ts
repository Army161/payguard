import type { Client, Payment, TransactionMetadata } from 'xrpl';
import { PayGuardError, type ChainObservation, type Network, type RailId } from '@payguard/core';
import { RailLookupError, type Rail, type RailLookup } from './interface.js';
import { decimalToAtomic } from './xrpl-amount.js';
import { formatXrplAsset, parseXrplAsset, type XrplAsset } from './xrpl-currency.js';
import {
  XrplJsonRpcTransport,
  XrplWebSocketTransport,
  type XrplTransport,
} from './xrpl-transport.js';

export interface XrplRailOptions {
  network: Network;
  /** "XRP", or "CURRENCY.rIssuer" such as "RLUSD.rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV". */
  asset: string;
  /** Atomic decimals. 6 for drops of XRP, and the issuer's convention for an issued currency. */
  decimals: number;
  /** Websocket endpoint, for example wss://s.altnet.rippletest.net:51233 */
  wssUrl?: string;
  /** HTTPS JSON-RPC endpoint, for example https://testnet.xrpl-labs.com/ */
  rpcUrl?: string;
  /** An already connected xrpl.js client. Takes precedence over wssUrl. */
  client?: Client;
  /** A transport the caller built. Takes precedence over everything else. */
  transport?: XrplTransport;
}

type DeliveredAmount = string | { currency: string; issuer: string; value: string };

/**
 * XRPL rail, covering both the native asset and issued currencies such as RLUSD.
 *
 * Two XRPL specifics drive this code. First, `delivered_amount` from the transaction metadata is
 * the authoritative figure, not the `Amount` field of the transaction: a partial payment delivers
 * less than `Amount` says, and reading `Amount` is how a partial payment passes as a full one.
 * Second, a transaction is only final once it appears in a validated ledger, so `validated` is
 * checked before anything else is believed.
 */
export class XrplRail implements Rail {
  readonly id: RailId;
  readonly networks: readonly Network[];

  private readonly transport: XrplTransport;
  private readonly network: Network;
  private readonly asset: XrplAsset;
  private readonly assetLabel: string;
  private readonly decimals: number;

  constructor(options: XrplRailOptions) {
    this.asset = parseXrplAsset(options.asset);
    this.assetLabel = formatXrplAsset(this.asset);
    this.id = this.asset.issuer === undefined ? 'xrpl:xrp' : 'xrpl:rlusd';
    this.network = options.network;
    this.networks = [options.network];
    this.decimals = options.decimals;
    this.transport = selectTransport(options);
  }

  async observe(lookup: RailLookup): Promise<ChainObservation> {
    if (lookup.network !== this.network) {
      throw new RailLookupError(
        `${this.id} rail is configured for ${this.network}, not ${lookup.network}`,
        lookup.transactionHash,
      );
    }
    if (!/^[0-9A-Fa-f]{64}$/.test(lookup.transactionHash)) {
      throw new RailLookupError('not an XRPL transaction hash', lookup.transactionHash);
    }

    const hash = lookup.transactionHash.toUpperCase();
    const result = await this.transport
      .request('tx', { transaction: hash, binary: false })
      .catch((error: unknown) => {
        if (error instanceof RailLookupError) throw error;
        throw new RailLookupError(
          `transaction lookup failed: ${error instanceof Error ? error.message : String(error)}`,
          lookup.transactionHash,
        );
      });

    // API v2 returns the transaction under tx_json. Older JSON-RPC nodes inline the fields on the
    // result itself, so both shapes are read rather than assuming one deployment's rippled version.
    const tx = (result.tx_json ?? result) as Payment | undefined;
    if (tx === undefined || tx.TransactionType === undefined) {
      throw new RailLookupError(
        'transaction response carried no transaction',
        lookup.transactionHash,
      );
    }

    const meta = (result.meta ?? result.metaData) as TransactionMetadata | string | undefined;
    if (meta === undefined || typeof meta === 'string') {
      throw new RailLookupError(
        'transaction metadata was absent or binary, so the delivered amount cannot be read',
        lookup.transactionHash,
      );
    }

    const validated = result.validated === true;
    const succeeded =
      validated && tx.TransactionType === 'Payment' && meta.TransactionResult === 'tesSUCCESS';

    const delivered = (meta as TransactionMetadata & { delivered_amount?: DeliveredAmount })
      .delivered_amount;
    const observed = this.readDelivered(delivered);

    const ledgerIndex = typeof result.ledger_index === 'number' ? result.ledger_index : undefined;
    const confirmations = await this.confirmations(ledgerIndex, validated);

    return {
      network: this.network,
      transactionHash: hash,
      recipient: tx.Destination ?? '',
      asset: observed.asset,
      amount: observed.amount,
      confirmations,
      succeeded,
      correlation: readCorrelation(tx),
    };
  }

  /**
   * Reads the delivered amount into atomic units and an asset label in PayGuard's own form, so
   * `checkSettlement` compares like with like. An amount in a currency other than the configured
   * one is reported honestly rather than coerced, so the asset mismatch is what gets rejected
   * rather than the number.
   */
  private readDelivered(delivered: DeliveredAmount | undefined): { asset: string; amount: string } {
    if (delivered === undefined || delivered === 'unavailable') {
      return { asset: this.assetLabel, amount: '0' };
    }
    if (typeof delivered === 'string') {
      // Native XRP, already an integer count of drops.
      return { asset: 'XRP', amount: delivered };
    }
    return {
      asset: formatXrplAsset({ currency: delivered.currency, issuer: delivered.issuer }),
      amount: decimalToAtomic(delivered.value, this.decimals),
    };
  }

  private async confirmations(
    ledgerIndex: number | undefined,
    validated: boolean,
  ): Promise<number> {
    if (!validated || ledgerIndex === undefined) return 0;
    const ledger = await this.transport.request('ledger', { ledger_index: 'validated' });
    const latest = ledger.ledger_index;
    if (typeof latest !== 'number') return 0;
    return latest >= ledgerIndex ? latest - ledgerIndex + 1 : 0;
  }

  async close(): Promise<void> {
    await this.transport.close();
  }
}

function selectTransport(options: XrplRailOptions): XrplTransport {
  if (options.transport !== undefined) return options.transport;
  if (options.client !== undefined) {
    return new XrplWebSocketTransport({ wssUrl: '', client: options.client });
  }
  if (options.wssUrl !== undefined) {
    return new XrplWebSocketTransport({ wssUrl: options.wssUrl });
  }
  if (options.rpcUrl !== undefined) {
    return new XrplJsonRpcTransport({ rpcUrl: options.rpcUrl });
  }
  throw new PayGuardError(
    'unsupported_rail',
    'XRPL rail needs a wssUrl, an rpcUrl, an xrpl.js client, or a transport',
  );
}

/** Reads the request correlation FR-5.2 requires: a PayGuard memo, or the destination tag. */
function readCorrelation(tx: Payment): string | undefined {
  const memos = tx.Memos;
  if (Array.isArray(memos)) {
    for (const wrapper of memos) {
      const data = wrapper?.Memo?.MemoData;
      if (typeof data === 'string' && data.length > 0) {
        return Buffer.from(data, 'hex').toString('utf8');
      }
    }
  }
  return tx.DestinationTag === undefined ? undefined : String(tx.DestinationTag);
}

/** Builds the XRP rail. Kept separate so a caller cannot accidentally pass an issuer to it. */
export function createXrpRail(options: Omit<XrplRailOptions, 'asset' | 'decimals'>): XrplRail {
  return new XrplRail({ ...options, asset: 'XRP', decimals: 6 });
}

/** Builds the RLUSD rail. The issuer is required, because RLUSD from another issuer is not RLUSD. */
export function createRlusdRail(
  options: Omit<XrplRailOptions, 'asset'> & { issuer: string; currency?: string },
): XrplRail {
  if (!options.issuer.startsWith('r')) {
    throw new PayGuardError(
      'unsupported_rail',
      `RLUSD issuer must be an XRPL classic address, got ${options.issuer}`,
    );
  }
  return new XrplRail({ ...options, asset: `${options.currency ?? 'RLUSD'}.${options.issuer}` });
}
