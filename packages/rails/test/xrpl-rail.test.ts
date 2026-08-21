import { describe, expect, it, vi } from 'vitest';
import type { Client } from 'xrpl';
import { PayGuardError, checkSettlement, type SettlementExpectation } from '@payguard/core';
import {
  RailLookupError,
  XrplJsonRpcTransport,
  XrplRail,
  createRlusdRail,
  createXrpRail,
} from '@payguard/rails';

const SELLER = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe';
const BUYER = 'rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH';
const ATTACKER = 'rJb5KsHsDHF1YS5B5DU6QCkH5NsPaXQEZQ';
const ISSUER = 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV';
const RLUSD_HEX = '524C555344000000000000000000000000000000';
const TX = 'AB'.repeat(32);

interface StubOptions {
  destination?: string;
  transactionType?: string;
  transactionResult?: string;
  validated?: boolean;
  deliveredAmount?: unknown;
  ledgerIndex?: number;
  latestLedger?: number;
  memoData?: string;
  destinationTag?: number;
  metaBinary?: boolean;
  noMeta?: boolean;
  noTxJson?: boolean;
  throwOnTx?: boolean;
}

function stubClient(options: StubOptions = {}): Client {
  return {
    isConnected: () => true,
    connect: async () => undefined,
    disconnect: async () => undefined,
    request: async (request: { command: string }) => {
      if (request.command === 'ledger') {
        return { result: { ledger_index: options.latestLedger ?? 100 } };
      }
      if (options.throwOnTx === true) throw new Error('txnNotFound');
      const tx_json =
        options.noTxJson === true
          ? undefined
          : {
              TransactionType: options.transactionType ?? 'Payment',
              Account: BUYER,
              Destination: options.destination ?? SELLER,
              ...(options.memoData === undefined
                ? {}
                : {
                    Memos: [
                      { Memo: { MemoData: Buffer.from(options.memoData, 'utf8').toString('hex') } },
                    ],
                  }),
              ...(options.destinationTag === undefined
                ? {}
                : { DestinationTag: options.destinationTag }),
            };
      const meta =
        options.noMeta === true
          ? undefined
          : options.metaBinary === true
            ? 'DEADBEEF'
            : {
                TransactionResult: options.transactionResult ?? 'tesSUCCESS',
                delivered_amount:
                  options.deliveredAmount === undefined ? '10000' : options.deliveredAmount,
              };
      return {
        result: {
          tx_json,
          meta,
          validated: options.validated ?? true,
          ledger_index: options.ledgerIndex ?? 100,
          hash: TX,
        },
      };
    },
  } as unknown as Client;
}

const xrpRail = (options: StubOptions = {}) =>
  new XrplRail({
    wssUrl: 'wss://s.altnet.rippletest.net:51233',
    network: 'xrpl-testnet',
    asset: 'XRP',
    decimals: 6,
    client: stubClient(options),
  });

const rlusdRail = (options: StubOptions = {}) =>
  new XrplRail({
    wssUrl: 'wss://s.altnet.rippletest.net:51233',
    network: 'xrpl-testnet',
    asset: `RLUSD.${ISSUER}`,
    decimals: 6,
    client: stubClient(options),
  });

const xrpExpectation: SettlementExpectation = {
  rail: 'xrpl:xrp',
  network: 'xrpl-testnet',
  payTo: SELLER,
  asset: 'XRP',
  minAmount: '10000',
  minConfirmations: 1,
};

const rlusdExpectation: SettlementExpectation = {
  rail: 'xrpl:rlusd',
  network: 'xrpl-testnet',
  payTo: SELLER,
  asset: `RLUSD.${ISSUER}`,
  minAmount: '10000000',
  minConfirmations: 1,
};

describe('xrpl:xrp rail', () => {
  it('reads drops directly, since they are already atomic', async () => {
    const observation = await xrpRail().observe({ transactionHash: TX, network: 'xrpl-testnet' });
    expect(observation).toMatchObject({
      asset: 'XRP',
      amount: '10000',
      recipient: SELLER,
      succeeded: true,
    });
    expect(checkSettlement(observation, xrpExpectation)).toEqual({ ok: true });
  });

  it('derives the rail id from the asset', () => {
    expect(xrpRail().id).toBe('xrpl:xrp');
    expect(rlusdRail().id).toBe('xrpl:rlusd');
  });

  it('counts the including ledger as one confirmation', async () => {
    const observation = await xrpRail({ ledgerIndex: 100, latestLedger: 100 }).observe({
      transactionHash: TX,
      network: 'xrpl-testnet',
    });
    expect(observation.confirmations).toBe(1);
  });

  it('counts deeper confirmations as ledgers close', async () => {
    const observation = await xrpRail({ ledgerIndex: 100, latestLedger: 103 }).observe({
      transactionHash: TX,
      network: 'xrpl-testnet',
    });
    expect(observation.confirmations).toBe(4);
  });

  it('reports zero confirmations for an unvalidated transaction, however good it looks', async () => {
    const observation = await xrpRail({ validated: false }).observe({
      transactionHash: TX,
      network: 'xrpl-testnet',
    });
    expect(observation.confirmations).toBe(0);
    expect(observation.succeeded).toBe(false);
  });

  it('reports a non-tesSUCCESS result as not succeeded', async () => {
    const observation = await xrpRail({ transactionResult: 'tecPATH_PARTIAL' }).observe({
      transactionHash: TX,
      network: 'xrpl-testnet',
    });
    expect(observation.succeeded).toBe(false);
  });

  it('reports a transaction that is not a Payment as not succeeded', async () => {
    const observation = await xrpRail({ transactionType: 'OfferCreate' }).observe({
      transactionHash: TX,
      network: 'xrpl-testnet',
    });
    expect(observation.succeeded).toBe(false);
  });

  it('reads delivered_amount, so a partial payment cannot pass as a full one', async () => {
    const observation = await xrpRail({ deliveredAmount: '9999' }).observe({
      transactionHash: TX,
      network: 'xrpl-testnet',
    });
    expect(observation.amount).toBe('9999');
    expect(checkSettlement(observation, xrpExpectation)).toMatchObject({
      reason: 'chain_amount_insufficient',
    });
  });

  it('treats an unavailable delivered amount as zero rather than as the full price', async () => {
    const observation = await xrpRail({ deliveredAmount: 'unavailable' }).observe({
      transactionHash: TX,
      network: 'xrpl-testnet',
    });
    expect(observation.amount).toBe('0');
  });

  it('rejects a payment to an account that is not the seller', async () => {
    const observation = await xrpRail({ destination: ATTACKER }).observe({
      transactionHash: TX,
      network: 'xrpl-testnet',
    });
    expect(checkSettlement(observation, xrpExpectation)).toMatchObject({
      reason: 'chain_recipient_mismatch',
    });
  });

  it('carries a memo through as the request correlation, per FR-5.2', async () => {
    const observation = await xrpRail({ memoData: 'req-42' }).observe({
      transactionHash: TX,
      network: 'xrpl-testnet',
    });
    expect(observation.correlation).toBe('req-42');
  });

  it('falls back to the destination tag when there is no memo', async () => {
    const observation = await xrpRail({ destinationTag: 4242 }).observe({
      transactionHash: TX,
      network: 'xrpl-testnet',
    });
    expect(observation.correlation).toBe('4242');
  });

  it('reports no correlation when the payment carries neither', async () => {
    const observation = await xrpRail().observe({ transactionHash: TX, network: 'xrpl-testnet' });
    expect(observation.correlation).toBeUndefined();
  });
});

describe('xrpl:rlusd rail', () => {
  it('converts an issued currency decimal value to atomic units', async () => {
    const observation = await rlusdRail({
      deliveredAmount: { currency: RLUSD_HEX, issuer: ISSUER, value: '10.5' },
    }).observe({ transactionHash: TX, network: 'xrpl-testnet' });
    expect(observation.amount).toBe('10500000');
    expect(observation.asset).toBe(`RLUSD.${ISSUER}`);
  });

  it('accepts a settlement that covers the price', async () => {
    const observation = await rlusdRail({
      deliveredAmount: { currency: RLUSD_HEX, issuer: ISSUER, value: '10' },
    }).observe({ transactionHash: TX, network: 'xrpl-testnet' });
    expect(checkSettlement(observation, rlusdExpectation)).toEqual({ ok: true });
  });

  it('rejects RLUSD from a different issuer, which is a different asset', async () => {
    const observation = await rlusdRail({
      deliveredAmount: { currency: RLUSD_HEX, issuer: ATTACKER, value: '10' },
    }).observe({ transactionHash: TX, network: 'xrpl-testnet' });
    expect(checkSettlement(observation, rlusdExpectation)).toMatchObject({
      reason: 'chain_asset_mismatch',
    });
  });

  it('reports a native XRP delivery on an RLUSD rail as XRP, so the asset check catches it', async () => {
    const observation = await rlusdRail({ deliveredAmount: '10000000' }).observe({
      transactionHash: TX,
      network: 'xrpl-testnet',
    });
    expect(observation.asset).toBe('XRP');
    expect(checkSettlement(observation, rlusdExpectation)).toMatchObject({
      reason: 'chain_asset_mismatch',
    });
  });
});

describe('xrpl rail failure handling', () => {
  it('refuses a lookup on a network it is not configured for', async () => {
    await expect(xrpRail().observe({ transactionHash: TX, network: 'xrpl' })).rejects.toThrow(
      RailLookupError,
    );
  });

  it('refuses something that is not an XRPL transaction hash', async () => {
    await expect(
      xrpRail().observe({ transactionHash: '0xabc', network: 'xrpl-testnet' }),
    ).rejects.toThrow(/not an XRPL transaction hash/);
  });

  it('surfaces a lookup failure rather than reporting a zero payment', async () => {
    await expect(
      xrpRail({ throwOnTx: true }).observe({ transactionHash: TX, network: 'xrpl-testnet' }),
    ).rejects.toThrow(/transaction lookup failed/);
  });

  it('refuses a response with no transaction body', async () => {
    await expect(
      xrpRail({ noTxJson: true }).observe({ transactionHash: TX, network: 'xrpl-testnet' }),
    ).rejects.toThrow(/carried no transaction/);
  });

  it('refuses binary metadata rather than guessing the delivered amount', async () => {
    await expect(
      xrpRail({ metaBinary: true }).observe({ transactionHash: TX, network: 'xrpl-testnet' }),
    ).rejects.toThrow(/absent or binary/);
  });

  it('refuses a response with no metadata at all', async () => {
    await expect(
      xrpRail({ noMeta: true }).observe({ transactionHash: TX, network: 'xrpl-testnet' }),
    ).rejects.toThrow(/absent or binary/);
  });

  it('normalizes the transaction hash to upper case, as XRPL reports it', async () => {
    const observation = await xrpRail().observe({
      transactionHash: TX.toLowerCase(),
      network: 'xrpl-testnet',
    });
    expect(observation.transactionHash).toBe(TX);
  });

  it('leaves a caller supplied client connected on close', async () => {
    await expect(xrpRail().close()).resolves.toBeUndefined();
  });
});

describe('rail constructors', () => {
  it('createXrpRail fixes the asset and decimals so an issuer cannot be passed by mistake', () => {
    const rail = createXrpRail({
      wssUrl: 'wss://s.altnet.rippletest.net:51233',
      network: 'xrpl-testnet',
      client: stubClient(),
    });
    expect(rail.id).toBe('xrpl:xrp');
  });

  it('createRlusdRail requires an XRPL classic address as the issuer', () => {
    expect(() =>
      createRlusdRail({
        wssUrl: 'wss://s.altnet.rippletest.net:51233',
        network: 'xrpl-testnet',
        decimals: 6,
        issuer: '0xnotanxrpladdress',
      }),
    ).toThrow(PayGuardError);
  });

  it('createRlusdRail builds a working rail from an issuer', () => {
    const rail = createRlusdRail({
      wssUrl: 'wss://s.altnet.rippletest.net:51233',
      network: 'xrpl-testnet',
      decimals: 6,
      issuer: ISSUER,
      client: stubClient(),
    });
    expect(rail.id).toBe('xrpl:rlusd');
  });
});

describe('xrpl transports', () => {
  it('refuses a JSON-RPC endpoint that is not https', () => {
    expect(() => new XrplJsonRpcTransport({ rpcUrl: 'http://xrpl.example/' })).toThrow(
      /must use https/,
    );
  });

  it('allows http on a loopback host for local development', () => {
    expect(() => new XrplJsonRpcTransport({ rpcUrl: 'http://127.0.0.1:5005/' })).not.toThrow();
  });

  it('posts the rippled JSON-RPC envelope', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ result: { ledger_index: 42 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const transport = new XrplJsonRpcTransport({
      rpcUrl: 'https://xrpl.example/',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await transport.request('ledger', { ledger_index: 'validated' })).toEqual({
      ledger_index: 42,
    });
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      method: 'ledger',
      params: [{ ledger_index: 'validated' }],
    });
    await transport.close();
  });

  it('treats an application level error inside a 200 as a failure', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ result: { error: 'txnNotFound', error_message: 'not found' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const transport = new XrplJsonRpcTransport({
      rpcUrl: 'https://xrpl.example/',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(transport.request('tx', { transaction: TX })).rejects.toThrow(
      /XRPL node reported txnNotFound: not found/,
    );
  });

  it('reports a non 200 status', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 502 }));
    const transport = new XrplJsonRpcTransport({
      rpcUrl: 'https://xrpl.example/',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(transport.request('tx', {})).rejects.toThrow(/returned 502/);
  });

  it('reports a response body with no result', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const transport = new XrplJsonRpcTransport({
      rpcUrl: 'https://xrpl.example/',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(transport.request('tx', {})).rejects.toThrow(/carried no result/);
  });

  it('reports an unreachable endpoint', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ENOTFOUND');
    });
    const transport = new XrplJsonRpcTransport({
      rpcUrl: 'https://xrpl.example/',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(transport.request('tx', {})).rejects.toThrow(/could not reach/);
  });

  it('gives up on an endpoint that does not answer within the timeout', async () => {
    const fetchImpl = vi.fn(
      async (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    );
    const transport = new XrplJsonRpcTransport({
      rpcUrl: 'https://xrpl.example/',
      timeoutMs: 20,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(transport.request('tx', {})).rejects.toThrow(/did not respond within 20 ms/);
  });

  it('reads a rail through the JSON-RPC transport, including the older inline result shape', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { method: string };
      const result =
        body.method === 'ledger'
          ? { ledger_index: 105 }
          : {
              // Older rippled JSON-RPC inlines the transaction fields on the result itself
              // rather than nesting them under tx_json.
              TransactionType: 'Payment',
              Account: BUYER,
              Destination: SELLER,
              validated: true,
              ledger_index: 100,
              meta: { TransactionResult: 'tesSUCCESS', delivered_amount: '10000' },
            };
      return new Response(JSON.stringify({ result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const rail = new XrplRail({
      network: 'xrpl-testnet',
      asset: 'XRP',
      decimals: 6,
      transport: new XrplJsonRpcTransport({
        rpcUrl: 'https://xrpl.example/',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    });
    const observation = await rail.observe({ transactionHash: TX, network: 'xrpl-testnet' });
    expect(observation).toMatchObject({ amount: '10000', recipient: SELLER, succeeded: true });
    expect(observation.confirmations).toBe(6);
    await rail.close();
  });

  it('refuses to build a rail with no transport at all', () => {
    expect(() => new XrplRail({ network: 'xrpl-testnet', asset: 'XRP', decimals: 6 })).toThrow(
      PayGuardError,
    );
  });
});
