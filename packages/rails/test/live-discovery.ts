import { createPublicClient, erc20Abi, http, parseEventLogs, type PublicClient } from 'viem';
import { XrplJsonRpcTransport, XrplWebSocketTransport, type XrplTransport } from '@payguard/rails';

/**
 * Support for the live testnet suite.
 *
 * Two lessons are baked in here, both learned by watching this suite fail for reasons that had
 * nothing to do with PayGuard.
 *
 * First, the transaction under test is discovered at run time rather than pinned. XRPL public
 * nodes retain only recent ledgers, so a pinned hash starts returning txnNotFound within days.
 *
 * Second, public testnet endpoints are best effort. They go unhealthy ("no backend is currently
 * healthy to serve traffic") and they rate limit an enthusiastic client (418, 429). A live suite
 * that treats those as failures cries wolf, and a suite that cries wolf stops being read. So this
 * module retries politely across several endpoints, and reports "unavailable" as a distinct
 * outcome from "wrong", which the tests turn into a loud skip rather than a red failure.
 *
 * Nothing here spends anything. The one write is the free XRPL Testnet faucet funding a throwaway
 * account, and only when recent ledgers carry no Payment to read.
 */

export const BASE_SEPOLIA_RPCS = [
  'https://sepolia.base.org',
  'https://base-sepolia-rpc.publicnode.com',
  'https://base-sepolia.drpc.org',
] as const;

export const XRPL_TESTNET_RPCS = ['https://testnet.xrpl-labs.com/'] as const;

export interface DiscoveredTransfer {
  hash: string;
  recipient: string;
  amount: string;
  source: string;
}

/** Distinguishes "the endpoint would not talk to us" from "the rail decoded it wrongly". */
export class EndpointUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EndpointUnavailable';
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs an operation against each endpoint in turn, with backoff, and reports unavailability rather
 * than throwing whatever the last endpoint happened to say.
 */
export async function withEndpoint<T>(
  endpoints: readonly string[],
  operation: (endpoint: string) => Promise<T>,
  options: { attemptsPerEndpoint?: number; baseDelayMs?: number } = {},
): Promise<T> {
  const attempts = options.attemptsPerEndpoint ?? 2;
  const baseDelay = options.baseDelayMs ?? 800;
  const failures: string[] = [];

  for (const endpoint of endpoints) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await operation(endpoint);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${endpoint}: ${message.split('\n')[0]}`);
        if (attempt + 1 < attempts) await sleep(baseDelay * 2 ** attempt);
      }
    }
  }

  throw new EndpointUnavailable(`every endpoint refused or failed:\n  ${failures.join('\n  ')}`);
}

/** Walks back from the chain head looking for a Transfer of the given token. */
export async function findBaseTransfer(
  endpoints: readonly string[],
  token: string,
  options: { maxBlocks?: number; step?: bigint } = {},
): Promise<DiscoveredTransfer | null> {
  const step = options.step ?? 400n;
  const maxBlocks = BigInt(options.maxBlocks ?? 2000);

  return withEndpoint(endpoints, async (rpcUrl) => {
    const client = createPublicClient({ transport: http(rpcUrl) }) as unknown as PublicClient;
    const head = await client.getBlockNumber();

    for (let back = 0n; back < maxBlocks; back += step) {
      const toBlock = head - back;
      const logs = await client.getLogs({
        address: token as `0x${string}`,
        fromBlock: toBlock - (step - 1n),
        toBlock,
      });
      const found = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs }).find(
        (log) => log.args.value > 0n,
      );
      if (found !== undefined) {
        return {
          hash: found.transactionHash,
          recipient: found.args.to,
          amount: found.args.value.toString(),
          source: `${rpcUrl} block ${found.blockNumber}`,
        };
      }
      await sleep(150);
    }
    return null;
  });
}

/**
 * Scans a few recent validated ledgers for a successful native XRP Payment.
 *
 * Deliberately shallow. Each expanded ledger is a large response, and scanning a dozen of them is
 * what earned a 418 from the public endpoint the first time this was written.
 */
export async function findXrplPayment(
  transport: XrplTransport,
  options: { maxLedgers?: number } = {},
): Promise<DiscoveredTransfer | null> {
  const validated = await transport.request('ledger', { ledger_index: 'validated' });
  const head = validated.ledger_index;
  if (typeof head !== 'number') return null;

  const maxLedgers = options.maxLedgers ?? 3;
  for (let i = 0; i < maxLedgers; i += 1) {
    if (i > 0) await sleep(400);
    const ledger = await transport
      .request('ledger', { ledger_index: head - i, transactions: true, expand: true })
      .catch(() => null);
    const body = ledger?.ledger as { transactions?: unknown[] } | undefined;

    for (const raw of body?.transactions ?? []) {
      const entry = raw as {
        hash?: string;
        tx_json?: { TransactionType?: string; Destination?: string };
        TransactionType?: string;
        Destination?: string;
        meta?: { TransactionResult?: string; delivered_amount?: unknown };
      };
      const tx = entry.tx_json ?? entry;
      if (tx.TransactionType !== 'Payment') continue;
      if (entry.meta?.TransactionResult !== 'tesSUCCESS') continue;
      const delivered = entry.meta.delivered_amount;
      // Native XRP only: an issued currency needs the rail configured for that exact issuer.
      if (typeof delivered !== 'string' || delivered === 'unavailable') continue;
      if (entry.hash === undefined || tx.Destination === undefined) continue;
      return {
        hash: entry.hash,
        recipient: tx.Destination,
        amount: delivered,
        source: `ledger ${head - i}`,
      };
    }
  }
  return null;
}

/**
 * Asks the XRPL Testnet faucet to fund a fresh account, which is an ordinary Payment and the only
 * reliable way to get something decodable when recent ledgers carry none.
 *
 * The faucet also returns a seed for the new account. It is deliberately not read, not stored, and
 * not returned. Nothing in this repository has any use for a key.
 */
export async function fundFromFaucet(
  faucetUrl = 'https://faucet.altnet.rippletest.net/accounts',
): Promise<DiscoveredTransfer | null> {
  const response = await fetch(faucetUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }).catch(() => null);
  if (response === null || !response.ok) return null;

  const body = (await response.json().catch(() => null)) as {
    account?: { address?: string };
    amount?: number;
    transactionHash?: string;
  } | null;

  if (
    body?.transactionHash === undefined ||
    body.account?.address === undefined ||
    body.amount === undefined
  ) {
    return null;
  }

  return {
    hash: body.transactionHash,
    recipient: body.account.address,
    // The faucet reports XRP; the ledger reports drops.
    amount: (BigInt(Math.round(body.amount)) * 1_000_000n).toString(),
    source: 'testnet faucet',
  };
}

/** Waits for a freshly submitted transaction to appear in a validated ledger. */
export async function waitForValidated(
  transport: XrplTransport,
  hash: string,
  timeoutMs = 30_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await transport
      .request('tx', { transaction: hash, binary: false })
      .catch(() => null);
    if (result?.validated === true) return true;
    await sleep(2000);
  }
  return false;
}

export function xrplTransport(rpcUrl: string | undefined, wssUrl: string): XrplTransport {
  return rpcUrl === undefined
    ? new XrplWebSocketTransport({ wssUrl, connectionTimeoutMs: 20_000 })
    : new XrplJsonRpcTransport({ rpcUrl });
}
