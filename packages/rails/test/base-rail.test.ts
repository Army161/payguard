import { describe, expect, it } from 'vitest';
import { encodeEventTopics, erc20Abi, pad, toHex, type PublicClient } from 'viem';
import { PayGuardError, checkSettlement, type SettlementExpectation } from '@payguard/core';
import { BaseUsdcRail, RailLookupError } from '@payguard/rails';

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const OTHER_TOKEN = '0x0000000000000000000000000000000000000dEaD';
const SELLER = '0x1111111111111111111111111111111111111111';
const BUYER = '0x2222222222222222222222222222222222222222';
const ATTACKER = '0x9999999999999999999999999999999999999999';
const TX = `0x${'ab'.repeat(32)}` as const;

/** Builds an ERC-20 Transfer log the way a node would return it. */
function transferLog(token: string, from: string, to: string, value: bigint) {
  return {
    address: token as `0x${string}`,
    topics: encodeEventTopics({
      abi: erc20Abi,
      eventName: 'Transfer',
      args: { from: from as `0x${string}`, to: to as `0x${string}` },
    }),
    data: pad(toHex(value), { size: 32 }),
    blockNumber: 100n,
    blockHash: `0x${'cc'.repeat(32)}` as const,
    transactionHash: TX,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  };
}

interface StubOptions {
  status?: 'success' | 'reverted';
  logs?: ReturnType<typeof transferLog>[];
  blockNumber?: bigint;
  currentBlock?: bigint;
  missing?: boolean;
}

function stubClient(options: StubOptions = {}): PublicClient {
  return {
    getTransactionReceipt: async () => {
      if (options.missing === true) throw new Error('not found');
      return {
        status: options.status ?? 'success',
        blockNumber: options.blockNumber ?? 100n,
        logs: options.logs ?? [transferLog(USDC, BUYER, SELLER, 10_000n)],
      };
    },
    getBlockNumber: async () => options.currentBlock ?? 100n,
  } as unknown as PublicClient;
}

function rail(options: StubOptions = {}): BaseUsdcRail {
  return new BaseUsdcRail({
    rpcUrl: 'https://sepolia.base.org',
    network: 'base-sepolia',
    asset: USDC,
    client: stubClient(options),
  });
}

const expectation: SettlementExpectation = {
  rail: 'base:usdc',
  network: 'base-sepolia',
  payTo: SELLER,
  asset: USDC,
  minAmount: '10000',
  minConfirmations: 1,
};

describe('base:usdc rail', () => {
  it('refuses a configuration whose asset is not a contract address', () => {
    expect(
      () =>
        new BaseUsdcRail({
          rpcUrl: 'https://sepolia.base.org',
          network: 'base-sepolia',
          asset: 'USDC',
        }),
    ).toThrow(PayGuardError);
  });

  it('reads the recipient, asset, and amount out of the Transfer log', async () => {
    const observation = await rail().observe({ transactionHash: TX, network: 'base-sepolia' });
    expect(observation).toMatchObject({
      network: 'base-sepolia',
      recipient: SELLER.toLowerCase(),
      asset: USDC,
      amount: '10000',
      succeeded: true,
    });
    expect(checkSettlement(observation, expectation)).toEqual({ ok: true });
  });

  it('counts the including block as one confirmation', async () => {
    const observation = await rail({ blockNumber: 100n, currentBlock: 100n }).observe({
      transactionHash: TX,
      network: 'base-sepolia',
    });
    expect(observation.confirmations).toBe(1);
  });

  it('counts deeper confirmations as the chain advances', async () => {
    const observation = await rail({ blockNumber: 100n, currentBlock: 104n }).observe({
      transactionHash: TX,
      network: 'base-sepolia',
    });
    expect(observation.confirmations).toBe(5);
  });

  it('reports zero confirmations when the head is behind the receipt, as during a reorg', async () => {
    const observation = await rail({ blockNumber: 100n, currentBlock: 99n }).observe({
      transactionHash: TX,
      network: 'base-sepolia',
    });
    expect(observation.confirmations).toBe(0);
  });

  it('reports a reverted transaction as not succeeded', async () => {
    const observation = await rail({ status: 'reverted' }).observe({
      transactionHash: TX,
      network: 'base-sepolia',
    });
    expect(observation.succeeded).toBe(false);
    expect(checkSettlement(observation, expectation)).toMatchObject({
      reason: 'chain_transaction_reverted',
    });
  });

  it('ignores a Transfer emitted by a different token contract', async () => {
    const observation = await rail({
      logs: [transferLog(OTHER_TOKEN, BUYER, SELLER, 1_000_000n)],
    }).observe({ transactionHash: TX, network: 'base-sepolia' });
    expect(observation.amount).toBe('0');
    expect(observation.succeeded).toBe(false);
  });

  it('does not sum a split payment across recipients, so a partial payment is caught', async () => {
    const observation = await rail({
      logs: [transferLog(USDC, BUYER, SELLER, 4_000n), transferLog(USDC, BUYER, ATTACKER, 6_000n)],
    }).observe({ transactionHash: TX, network: 'base-sepolia' });
    expect(observation.recipient).toBe(ATTACKER.toLowerCase());
    expect(observation.amount).toBe('6000');
    expect(checkSettlement(observation, expectation)).toMatchObject({
      reason: 'chain_recipient_mismatch',
    });
  });

  it('sums repeated transfers to the same recipient in one transaction', async () => {
    const observation = await rail({
      logs: [transferLog(USDC, BUYER, SELLER, 4_000n), transferLog(USDC, BUYER, SELLER, 6_000n)],
    }).observe({ transactionHash: TX, network: 'base-sepolia' });
    expect(observation.amount).toBe('10000');
  });

  it('treats a receipt with no token transfer as unsuccessful', async () => {
    const observation = await rail({ logs: [] }).observe({
      transactionHash: TX,
      network: 'base-sepolia',
    });
    expect(observation.succeeded).toBe(false);
  });

  it('refuses a lookup on a network it is not configured for', async () => {
    await expect(rail().observe({ transactionHash: TX, network: 'base' })).rejects.toThrow(
      RailLookupError,
    );
  });

  it('refuses something that is not an EVM transaction hash', async () => {
    await expect(
      rail().observe({ transactionHash: 'not-a-hash', network: 'base-sepolia' }),
    ).rejects.toThrow(/not an EVM transaction hash/);
  });

  it('reports a missing transaction rather than inventing an observation', async () => {
    await expect(
      rail({ missing: true }).observe({ transactionHash: TX, network: 'base-sepolia' }),
    ).rejects.toThrow(/not found/);
  });

  it('closes without holding a connection open', async () => {
    await expect(rail().close()).resolves.toBeUndefined();
  });
});
