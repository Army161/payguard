import { createServer, type Server } from 'node:http';
import express from 'express';
import {
  X402_VERSION,
  type ChainObservation,
  type Network,
  type PaymentRequirements,
  type SettleResponse,
  type VerifyResponse,
} from '@payguard/core';
import type { Facilitator, Health, Rail, RailLookup } from '@payguard/rails';
import { MemoryStore } from '@payguard/store';
import { payguardExpress } from '@payguard/server/express';
import type { ProtectedRail } from '@payguard/server';
import { RemoteSigner } from '@payguard/client';

export const SELLER_BASE = '0x1111111111111111111111111111111111111111';
export const SELLER_XRPL = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe';
export const BUYER_BASE = '0x2222222222222222222222222222222222222222';
export const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
export const RLUSD = 'RLUSD.rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV';

export class TestRail implements Rail {
  readonly networks: readonly Network[];
  lookups: RailLookup[] = [];

  constructor(
    readonly id: 'base:usdc' | 'xrpl:rlusd' | 'xrpl:xrp',
    private readonly observation: Omit<ChainObservation, 'transactionHash'>,
  ) {
    this.networks = [observation.network];
  }

  async observe(lookup: RailLookup): Promise<ChainObservation> {
    this.lookups.push(lookup);
    return { ...this.observation, transactionHash: lookup.transactionHash };
  }

  async close(): Promise<void> {}
}

export class TestFacilitator implements Facilitator {
  verifyCalls = 0;
  settleCalls = 0;
  down = false;

  constructor(
    readonly id: string,
    readonly rails: readonly ('base:usdc' | 'xrpl:rlusd' | 'xrpl:xrp')[],
    private readonly network: Network,
  ) {}

  async verify(): Promise<VerifyResponse> {
    this.verifyCalls += 1;
    if (this.down) throw new Error(`${this.id} is down`);
    return { isValid: true, payer: BUYER_BASE };
  }

  async settle(): Promise<SettleResponse> {
    this.settleCalls += 1;
    if (this.down) throw new Error(`${this.id} is down`);
    return {
      success: true,
      transaction: this.network.startsWith('xrpl') ? 'AB'.repeat(32) : `0x${'11'.repeat(32)}`,
      network: this.network,
      payer: BUYER_BASE,
    };
  }

  async health(): Promise<Health> {
    return {
      healthy: !this.down,
      latencyMs: 1,
      lastSuccessMs: 1,
      consecutiveFailures: this.down ? 5 : 0,
    };
  }
}

export function baseRequirements(
  overrides: Partial<Omit<PaymentRequirements, 'resource'>> = {},
): Omit<PaymentRequirements, 'resource'> {
  return {
    scheme: 'exact',
    network: 'base-sepolia',
    maxAmountRequired: '10000',
    description: 'One generated report',
    mimeType: 'application/json',
    payTo: SELLER_BASE,
    maxTimeoutSeconds: 300,
    asset: USDC,
    ...overrides,
  };
}

export function xrplRequirements(
  overrides: Partial<Omit<PaymentRequirements, 'resource'>> = {},
): Omit<PaymentRequirements, 'resource'> {
  return {
    scheme: 'exact',
    network: 'xrpl-testnet',
    maxAmountRequired: '10000',
    description: 'One generated report',
    mimeType: 'application/json',
    payTo: SELLER_XRPL,
    maxTimeoutSeconds: 300,
    asset: RLUSD,
    ...overrides,
  };
}

export interface SellerHandle {
  base: string;
  store: MemoryStore;
  facilitators: TestFacilitator[];
  close(): Promise<void>;
  hits(): number;
}

/**
 * A real Express server guarded by PayGuard, so the buyer tests exercise the actual 402 exchange
 * over a socket rather than a mock of one.
 */
export async function startSeller(
  rails: { rail: TestRail; requirements: Omit<PaymentRequirements, 'resource'> }[],
  facilitators: TestFacilitator[],
): Promise<SellerHandle> {
  const store = new MemoryStore();
  let hits = 0;

  const protectedRails: ProtectedRail[] = rails.map((entry) => ({
    id: entry.rail.id,
    rail: entry.rail,
    requirements: entry.requirements,
    minConfirmations: 1,
  }));

  const app = express();
  // Mounted on the priced route only, the way a real seller does it. A guard on `app.use` would
  // put a price on every path including the ones that do not have one.
  app.use(
    '/api/report',
    payguardExpress({
      rails: protectedRails,
      facilitators,
      store,
      confirmationTimeoutMs: 200,
      confirmationPollIntervalMs: 10,
    }),
  );
  app.get('/api/report', (_request, response) => {
    hits += 1;
    response.json({ report: 'generated' });
  });

  const server: Server = createServer(app);
  const base = await new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('no port');
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });

  return {
    base,
    store,
    facilitators,
    hits: () => hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A signer that produces a well formed payload without holding anything key shaped. */
export function testSigner(address = BUYER_BASE): RemoteSigner {
  let counter = 0;
  return new RemoteSigner({
    address,
    backend: 'test',
    sign: async (requirements: PaymentRequirements) => {
      counter += 1;
      const now = Math.floor(Date.now() / 1000);
      if (requirements.network.startsWith('xrpl')) {
        return {
          x402Version: X402_VERSION,
          scheme: 'exact',
          network: requirements.network,
          payload: { transaction: `120000${counter.toString(16).padStart(4, '0')}` },
        };
      }
      return {
        x402Version: X402_VERSION,
        scheme: 'exact',
        network: requirements.network,
        payload: {
          signature: `0x${'ab'.repeat(65)}`,
          authorization: {
            from: address,
            to: requirements.payTo,
            value: requirements.maxAmountRequired,
            validAfter: String(now - 60),
            validBefore: String(now + requirements.maxTimeoutSeconds),
            nonce: `0x${counter.toString(16).padStart(64, '0')}`,
          },
        },
      };
    },
  });
}

export const baseObservation: Omit<ChainObservation, 'transactionHash'> = {
  network: 'base-sepolia',
  recipient: SELLER_BASE,
  asset: USDC,
  amount: '10000',
  confirmations: 1,
  succeeded: true,
};

export const xrplObservation: Omit<ChainObservation, 'transactionHash'> = {
  network: 'xrpl-testnet',
  recipient: SELLER_XRPL,
  asset: RLUSD,
  amount: '10000',
  confirmations: 1,
  succeeded: true,
};
