import { beforeAll, describe, expect, it } from 'vitest';
import { checkSettlement } from '@payguard/core';
import { BaseUsdcRail, RailLookupError, XrplRail, createXrpRail } from '@payguard/rails';
import {
  BASE_SEPOLIA_RPCS,
  XRPL_TESTNET_RPCS,
  findBaseTransfer,
  findXrplPayment,
  fundFromFaucet,
  waitForValidated,
  withEndpoint,
  xrplTransport,
  type DiscoveredTransfer,
} from './live-discovery.js';

/**
 * Live rail tests against public testnets. Skipped unless PAYGUARD_LIVE is set, so a contributor
 * without network access still gets a green suite, and CI runs them nightly.
 *
 * These prove what fixtures cannot: that the shape a real node returns is the shape the adapters
 * read. A fixture that drifts from reality is worse than no fixture, and a nightly live run is
 * what catches the drift.
 *
 * Three outcomes, deliberately distinct:
 *   pass    the chain answered and the rail decoded it correctly
 *   skip    the public endpoint was unhealthy or rate limited, reported loudly with the reason
 *   fail    the rail read real chain data and got it wrong
 *
 * Collapsing the middle case into a failure is how a live suite becomes noise that nobody reads.
 */
const live = process.env.PAYGUARD_LIVE === '1';

const baseRpcs =
  process.env.BASE_RPC_URL === undefined
    ? BASE_SEPOLIA_RPCS
    : [process.env.BASE_RPC_URL, ...BASE_SEPOLIA_RPCS];
const XRPL_WSS = process.env.XRPL_WSS_URL ?? 'wss://s.altnet.rippletest.net:51233';
// Some networks allow outbound HTTPS only. Set XRPL_RPC_URL to run the XRPL live tests over
// JSON-RPC instead of a websocket; the rail supports both transports for exactly this reason.
const XRPL_RPC = process.env.XRPL_RPC_URL;
const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

describe.runIf(live)('live: Base Sepolia', () => {
  let transfer: DiscoveredTransfer | null = null;
  let unavailable: string | null = null;
  let rpcUrl = baseRpcs[0] as string;

  // Never throws. A beforeAll that throws skips the whole suite silently, which is exactly the
  // outcome this file exists to avoid.
  beforeAll(async () => {
    try {
      rpcUrl = await withEndpoint(baseRpcs, async (url) => {
        const probe = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}',
        });
        if (!probe.ok) throw new Error(`probe returned ${probe.status}`);
        const body = (await probe.json()) as { result?: string; error?: unknown };
        if (typeof body.result !== 'string') throw new Error(`probe body: ${JSON.stringify(body)}`);
        return url;
      });
      transfer = await findBaseTransfer([rpcUrl, ...baseRpcs], USDC_BASE_SEPOLIA);
    } catch (error) {
      unavailable = error instanceof Error ? error.message : String(error);
    }
  }, 180_000);

  const rail = () =>
    new BaseUsdcRail({ rpcUrl, network: 'base-sepolia', asset: USDC_BASE_SEPOLIA });

  it('reaches a Base Sepolia RPC', (context) => {
    if (unavailable !== null) return context.skip(`Base Sepolia unavailable. ${unavailable}`);
    expect(rpcUrl).toMatch(/^https:/);
  });

  it('reports a transaction the chain does not have rather than inventing one', async (context) => {
    if (unavailable !== null) return context.skip(`Base Sepolia unavailable. ${unavailable}`);
    const r = rail();
    await expect(
      r.observe({ transactionHash: `0x${'00'.repeat(32)}`, network: 'base-sepolia' }),
    ).rejects.toThrow(/not found/);
    await r.close();
  }, 60_000);

  it('decodes a settled USDC transfer and accepts it against a matching expectation', async (context) => {
    if (unavailable !== null) return context.skip(`Base Sepolia unavailable. ${unavailable}`);
    if (transfer === null) {
      return context.skip('no USDC transfer in the scanned range of Base Sepolia');
    }
    const r = rail();
    const observation = await r.observe({
      transactionHash: transfer.hash,
      network: 'base-sepolia',
    });

    expect(observation.succeeded).toBe(true);
    expect(observation.recipient).toBe(transfer.recipient.toLowerCase());
    expect(BigInt(observation.amount)).toBeGreaterThanOrEqual(BigInt(transfer.amount));
    expect(observation.confirmations).toBeGreaterThan(0);

    expect(
      checkSettlement(observation, {
        rail: 'base:usdc',
        network: 'base-sepolia',
        payTo: transfer.recipient,
        asset: USDC_BASE_SEPOLIA,
        minAmount: transfer.amount,
        minConfirmations: 1,
      }),
    ).toEqual({ ok: true });
    await r.close();
  }, 60_000);

  it('refuses the same settled transfer when the seller expects a different recipient', async (context) => {
    if (unavailable !== null) return context.skip(`Base Sepolia unavailable. ${unavailable}`);
    if (transfer === null) return context.skip('no USDC transfer found to test against');
    const r = rail();
    const observation = await r.observe({
      transactionHash: transfer.hash,
      network: 'base-sepolia',
    });
    expect(
      checkSettlement(observation, {
        rail: 'base:usdc',
        network: 'base-sepolia',
        payTo: '0x0000000000000000000000000000000000000001',
        asset: USDC_BASE_SEPOLIA,
        minAmount: transfer.amount,
        minConfirmations: 1,
      }),
    ).toMatchObject({ ok: false, reason: 'chain_recipient_mismatch' });
    await r.close();
  }, 60_000);
});

describe.runIf(live)('live: XRPL Testnet', () => {
  let payment: DiscoveredTransfer | null = null;
  let unavailable: string | null = null;
  let endpoint: string | undefined = XRPL_RPC;

  const railOptions = () => (endpoint === undefined ? { wssUrl: XRPL_WSS } : { rpcUrl: endpoint });

  beforeAll(async () => {
    try {
      if (endpoint === undefined && XRPL_RPC === undefined) {
        // No explicit endpoint: try the websocket first, then fall back to public JSON-RPC.
        const ws = xrplTransport(undefined, XRPL_WSS);
        const reachable = await ws
          .request('ledger', { ledger_index: 'validated' })
          .then(() => true)
          .catch(() => false);
        await ws.close();
        if (!reachable) {
          endpoint = await withEndpoint(XRPL_TESTNET_RPCS, async (url) => {
            const probe = xrplTransport(url, XRPL_WSS);
            await probe.request('ledger', { ledger_index: 'validated' });
            await probe.close();
            return url;
          });
        }
      }

      const transport = xrplTransport(endpoint, XRPL_WSS);
      try {
        payment = await findXrplPayment(transport);
        if (payment === null) {
          // Recent ledgers carried no XRP Payment. Funding a throwaway account from the free
          // faucet produces one, which is the only reliable source on a quiet net.
          payment = await fundFromFaucet();
          if (payment !== null && !(await waitForValidated(transport, payment.hash))) {
            payment = null;
          }
        }
      } finally {
        await transport.close();
      }
    } catch (error) {
      unavailable = error instanceof Error ? error.message : String(error);
    }
  }, 180_000);

  const rail = () =>
    new XrplRail({ ...railOptions(), network: 'xrpl-testnet', asset: 'XRP', decimals: 6 });

  it('reaches the ledger and reports a validated index', async (context) => {
    if (unavailable !== null) return context.skip(`XRPL Testnet unavailable. ${unavailable}`);
    const transport = xrplTransport(endpoint, XRPL_WSS);
    const result = await transport.request('ledger', { ledger_index: 'validated' });
    expect(result.ledger_index).toBeGreaterThan(0);
    await transport.close();
  }, 60_000);

  it('reports a transaction the ledger does not have rather than inventing one', async (context) => {
    if (unavailable !== null) return context.skip(`XRPL Testnet unavailable. ${unavailable}`);
    const r = createXrpRail({ ...railOptions(), network: 'xrpl-testnet' });
    await expect(
      r.observe({ transactionHash: '0'.repeat(64), network: 'xrpl-testnet' }),
    ).rejects.toThrow(RailLookupError);
    await r.close();
  }, 60_000);

  it('decodes a settled XRP payment and accepts it against a matching expectation', async (context) => {
    if (unavailable !== null) return context.skip(`XRPL Testnet unavailable. ${unavailable}`);
    if (payment === null) {
      return context.skip('no XRP Payment in recent ledgers and the faucet was unreachable');
    }
    const r = rail();
    const observation = await r.observe({
      transactionHash: payment.hash,
      network: 'xrpl-testnet',
    });

    expect(observation.succeeded).toBe(true);
    expect(observation.recipient).toBe(payment.recipient);
    expect(observation.asset).toBe('XRP');
    expect(BigInt(observation.amount)).toBeGreaterThan(0n);
    expect(observation.confirmations).toBeGreaterThan(0);

    expect(
      checkSettlement(observation, {
        rail: 'xrpl:xrp',
        network: 'xrpl-testnet',
        payTo: payment.recipient,
        asset: 'XRP',
        minAmount: observation.amount,
        minConfirmations: 1,
      }),
    ).toEqual({ ok: true });
    await r.close();
  }, 90_000);

  it('refuses the same settled payment when the seller expects RLUSD', async (context) => {
    if (unavailable !== null) return context.skip(`XRPL Testnet unavailable. ${unavailable}`);
    if (payment === null) return context.skip('no XRP Payment found to test against');
    const r = rail();
    const observation = await r.observe({
      transactionHash: payment.hash,
      network: 'xrpl-testnet',
    });
    expect(
      checkSettlement(observation, {
        rail: 'xrpl:rlusd',
        network: 'xrpl-testnet',
        payTo: payment.recipient,
        asset: 'RLUSD.rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV',
        minAmount: '1',
        minConfirmations: 1,
      }),
    ).toMatchObject({ ok: false, reason: 'chain_asset_mismatch' });
    await r.close();
  }, 90_000);
});

describe.runIf(!live)('live testnet suite', () => {
  it('is skipped without PAYGUARD_LIVE=1, and this test records that fact', () => {
    expect(live).toBe(false);
  });
});
