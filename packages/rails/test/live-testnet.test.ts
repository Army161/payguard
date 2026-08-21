import { describe, expect, it } from 'vitest';
import { createPublicClient, http, type PublicClient } from 'viem';
import { Client } from 'xrpl';
import { checkSettlement } from '@payguard/core';
import {
  BaseUsdcRail,
  RailLookupError,
  XrplJsonRpcTransport,
  XrplRail,
  createXrpRail,
} from '@payguard/rails';

/**
 * Live rail tests against public testnets. Skipped unless PAYGUARD_LIVE is set, so a contributor
 * without network access still gets a green suite, and CI runs them nightly.
 *
 * These prove something the fixtures cannot: that the shape a real node returns is the shape the
 * adapters read. A fixture that drifts from reality is worse than no fixture, and a nightly live
 * run is what catches the drift.
 *
 * Nothing here spends money. Every test reads.
 */
const live = process.env.PAYGUARD_LIVE === '1';
const BASE_RPC = process.env.BASE_RPC_URL ?? 'https://sepolia.base.org';
const XRPL_WSS = process.env.XRPL_WSS_URL ?? 'wss://s.altnet.rippletest.net:51233';
// Some networks allow outbound HTTPS only. Set XRPL_RPC_URL to run the XRPL live tests over
// JSON-RPC instead of a websocket; the rail supports both transports for exactly this reason.
const XRPL_RPC = process.env.XRPL_RPC_URL;
const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

/**
 * Settled transactions pinned from the public testnets, so the live suite decodes real chain data
 * rather than only proving that a node answers. Both are permanent: a validated XRPL ledger and a
 * Base Sepolia block never change. Neither test spends anything, both only read.
 *
 * The XRPL entry is the Testnet faucet funding a fresh account, which is an ordinary Payment. Its
 * seed was discarded and never left the machine that requested it.
 */
const SETTLED_BASE_TX = {
  hash: '0x0394c6577df3daee5112254c6773acf55196184cfe6495dfcc853380778113a0',
  recipient: '0xf006A181978e33F3068037A09BF952B382c404B8',
  amount: '1000',
} as const;

const SETTLED_XRPL_TX = {
  hash: '2B72C0CA95FA68EBDB92574CBA26F2D013229CCCA61AA541FC35E422E89CD8AB',
  recipient: 'rKZaYLb4TtUFWGTGP8qggPLjJAEcQNjHpc',
  drops: '100000000',
} as const;

describe.runIf(live)('live: Base Sepolia', () => {
  it('reaches the configured RPC and reports a plausible head', async () => {
    const client = createPublicClient({ transport: http(BASE_RPC) }) as unknown as PublicClient;
    const head = await client.getBlockNumber();
    expect(head).toBeGreaterThan(0n);
  }, 60_000);

  it('reports a transaction the chain does not have rather than inventing one', async () => {
    const rail = new BaseUsdcRail({
      rpcUrl: BASE_RPC,
      network: 'base-sepolia',
      asset: USDC_BASE_SEPOLIA,
    });
    await expect(
      rail.observe({ transactionHash: `0x${'00'.repeat(32)}`, network: 'base-sepolia' }),
    ).rejects.toThrow(/not found/);
    await rail.close();
  }, 60_000);

  it('decodes a settled USDC transfer and accepts it against a matching expectation', async () => {
    const rail = new BaseUsdcRail({
      rpcUrl: BASE_RPC,
      network: 'base-sepolia',
      asset: USDC_BASE_SEPOLIA,
    });
    const observation = await rail.observe({
      transactionHash: SETTLED_BASE_TX.hash,
      network: 'base-sepolia',
    });
    expect(observation.succeeded).toBe(true);
    expect(observation.recipient).toBe(SETTLED_BASE_TX.recipient.toLowerCase());
    expect(observation.amount).toBe(SETTLED_BASE_TX.amount);
    expect(observation.confirmations).toBeGreaterThan(0);

    expect(
      checkSettlement(observation, {
        rail: 'base:usdc',
        network: 'base-sepolia',
        payTo: SETTLED_BASE_TX.recipient,
        asset: USDC_BASE_SEPOLIA,
        minAmount: SETTLED_BASE_TX.amount,
        minConfirmations: 1,
      }),
    ).toEqual({ ok: true });
    await rail.close();
  }, 60_000);

  it('refuses the same settled transfer when the seller expects a different recipient', async () => {
    const rail = new BaseUsdcRail({
      rpcUrl: BASE_RPC,
      network: 'base-sepolia',
      asset: USDC_BASE_SEPOLIA,
    });
    const observation = await rail.observe({
      transactionHash: SETTLED_BASE_TX.hash,
      network: 'base-sepolia',
    });
    expect(
      checkSettlement(observation, {
        rail: 'base:usdc',
        network: 'base-sepolia',
        payTo: '0x0000000000000000000000000000000000000001',
        asset: USDC_BASE_SEPOLIA,
        minAmount: SETTLED_BASE_TX.amount,
        minConfirmations: 1,
      }),
    ).toMatchObject({ ok: false, reason: 'chain_recipient_mismatch' });
    await rail.close();
  }, 60_000);
});

const xrplRailOptions = () =>
  XRPL_RPC === undefined ? { wssUrl: XRPL_WSS } : { rpcUrl: XRPL_RPC };

describe.runIf(live && XRPL_RPC === undefined)('live: XRPL Testnet over websocket', () => {
  it('connects and reports a validated ledger index', async () => {
    const client = new Client(XRPL_WSS, { connectionTimeout: 20_000 });
    await client.connect();
    const ledger = await client.request({ command: 'ledger', ledger_index: 'validated' });
    expect(ledger.result.ledger_index).toBeGreaterThan(0);
    await client.disconnect();
  }, 60_000);
});

describe.runIf(live && XRPL_RPC !== undefined)('live: XRPL Testnet over JSON-RPC', () => {
  it('reaches the endpoint and reports a validated ledger index', async () => {
    const transport = new XrplJsonRpcTransport({ rpcUrl: XRPL_RPC as string });
    const result = await transport.request('ledger', { ledger_index: 'validated' });
    expect(result.ledger_index).toBeGreaterThan(0);
    await transport.close();
  }, 60_000);
});

describe.runIf(live)('live: XRPL Testnet', () => {
  it('reports a transaction the ledger does not have rather than inventing one', async () => {
    const rail = createXrpRail({ ...xrplRailOptions(), network: 'xrpl-testnet' });
    await expect(
      rail.observe({ transactionHash: '0'.repeat(64), network: 'xrpl-testnet' }),
    ).rejects.toThrow(RailLookupError);
    await rail.close();
  }, 60_000);

  it('decodes a settled XRP payment and accepts it against a matching expectation', async () => {
    const rail = new XrplRail({
      ...xrplRailOptions(),
      network: 'xrpl-testnet',
      asset: 'XRP',
      decimals: 6,
    });
    const observation = await rail.observe({
      transactionHash: SETTLED_XRPL_TX.hash,
      network: 'xrpl-testnet',
    });
    expect(observation.succeeded).toBe(true);
    expect(observation.recipient).toBe(SETTLED_XRPL_TX.recipient);
    expect(observation.amount).toBe(SETTLED_XRPL_TX.drops);
    expect(observation.confirmations).toBeGreaterThan(0);

    expect(
      checkSettlement(observation, {
        rail: 'xrpl:xrp',
        network: 'xrpl-testnet',
        payTo: SETTLED_XRPL_TX.recipient,
        asset: 'XRP',
        minAmount: SETTLED_XRPL_TX.drops,
        minConfirmations: 1,
      }),
    ).toEqual({ ok: true });
    await rail.close();
  }, 60_000);

  it('refuses the same settled payment when the seller expects RLUSD', async () => {
    const rail = new XrplRail({
      ...xrplRailOptions(),
      network: 'xrpl-testnet',
      asset: 'XRP',
      decimals: 6,
    });
    const observation = await rail.observe({
      transactionHash: SETTLED_XRPL_TX.hash,
      network: 'xrpl-testnet',
    });
    expect(
      checkSettlement(observation, {
        rail: 'xrpl:rlusd',
        network: 'xrpl-testnet',
        payTo: SETTLED_XRPL_TX.recipient,
        asset: 'RLUSD.rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV',
        minAmount: '1',
        minConfirmations: 1,
      }),
    ).toMatchObject({ ok: false, reason: 'chain_asset_mismatch' });
    await rail.close();
  }, 60_000);
});

describe.runIf(!live)('live testnet suite', () => {
  it('is skipped without PAYGUARD_LIVE=1, and this test records that fact', () => {
    expect(live).toBe(false);
  });
});
