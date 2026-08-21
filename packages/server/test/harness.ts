import {
  encodePaymentHeader,
  type ChainObservation,
  type Network,
  type PaymentPayload,
  type PaymentRequirements,
  type SettleResponse,
  type VerifyResponse,
} from '@payguard/core';
import type { Facilitator, Health, Rail, RailLookup } from '@payguard/rails';
import { MemoryStore } from '@payguard/store';
import { PayGuardServer, type ProtectedRail } from '@payguard/server';

export const SELLER = '0x1111111111111111111111111111111111111111';
export const BUYER = '0x2222222222222222222222222222222222222222';
export const ATTACKER = '0x9999999999999999999999999999999999999999';
export const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
export const RESOURCE = 'https://seller.example/api/report';

export function requirementsTemplate(
  overrides: Partial<Omit<PaymentRequirements, 'resource'>> = {},
): Omit<PaymentRequirements, 'resource'> {
  return {
    scheme: 'exact',
    network: 'base-sepolia',
    maxAmountRequired: '10000',
    description: 'One generated report',
    mimeType: 'application/json',
    payTo: SELLER,
    maxTimeoutSeconds: 300,
    asset: USDC,
    ...overrides,
  };
}

export function payload(
  overrides: { nonce?: string; network?: Network; value?: string } = {},
): PaymentPayload {
  const now = Math.floor(Date.now() / 1000);
  return {
    x402Version: 1,
    scheme: 'exact',
    network: overrides.network ?? 'base-sepolia',
    payload: {
      signature: `0x${'ab'.repeat(65)}`,
      authorization: {
        from: BUYER,
        to: SELLER,
        value: overrides.value ?? '10000',
        validAfter: String(now - 60),
        validBefore: String(now + 600),
        nonce: overrides.nonce ?? `0x${'cd'.repeat(32)}`,
      },
    },
  };
}

export const paymentHeader = (p: PaymentPayload = payload()) => encodePaymentHeader(p);

/** A rail whose observation the test controls, standing in for a chain. */
export class StubRail implements Rail {
  readonly id = 'base:usdc' as const;
  readonly networks: readonly Network[] = ['base-sepolia'];
  observations: ChainObservation[] = [];
  lookups: RailLookup[] = [];
  failWith: Error | null = null;
  private index = 0;

  constructor(private readonly defaults: Partial<ChainObservation> = {}) {}

  /** Queues one observation per call; the last queued value repeats once exhausted. */
  queue(...observations: Partial<ChainObservation>[]): void {
    this.observations.push(...observations.map((o) => this.build(o)));
  }

  private build(overrides: Partial<ChainObservation>): ChainObservation {
    return {
      network: 'base-sepolia',
      transactionHash: `0x${'11'.repeat(32)}`,
      recipient: SELLER,
      asset: USDC,
      amount: '10000',
      confirmations: 1,
      succeeded: true,
      ...this.defaults,
      ...overrides,
    };
  }

  async observe(lookup: RailLookup): Promise<ChainObservation> {
    this.lookups.push(lookup);
    if (this.failWith !== null) throw this.failWith;
    if (this.observations.length === 0) return this.build({});
    const next = this.observations[Math.min(this.index, this.observations.length - 1)]!;
    this.index += 1;
    return next;
  }

  async close(): Promise<void> {}
}

export interface StubFacilitatorOptions {
  id?: string;
  verifyResult?: VerifyResponse;
  settleResult?: SettleResponse;
  verifyError?: Error;
  settleError?: Error;
  healthy?: boolean;
}

/** A facilitator whose answers the test controls, standing in for a third party. */
export class StubFacilitator implements Facilitator {
  readonly id: string;
  readonly rails = ['base:usdc'] as const;
  verifyCalls = 0;
  settleCalls = 0;

  constructor(private readonly options: StubFacilitatorOptions = {}) {
    this.id = options.id ?? 'stub';
  }

  async verify(): Promise<VerifyResponse> {
    this.verifyCalls += 1;
    if (this.options.verifyError !== undefined) throw this.options.verifyError;
    return this.options.verifyResult ?? { isValid: true, payer: BUYER };
  }

  async settle(): Promise<SettleResponse> {
    this.settleCalls += 1;
    if (this.options.settleError !== undefined) throw this.options.settleError;
    return (
      this.options.settleResult ?? {
        success: true,
        transaction: `0x${'11'.repeat(32)}`,
        network: 'base-sepolia',
        payer: BUYER,
      }
    );
  }

  async health(): Promise<Health> {
    return {
      healthy: this.options.healthy ?? true,
      latencyMs: 1,
      lastSuccessMs: 1,
      consecutiveFailures: 0,
    };
  }
}

export interface HarnessOptions {
  rail?: StubRail;
  facilitators?: Facilitator[];
  store?: MemoryStore;
  mode?: 'strict' | 'fast';
  minConfirmations?: number;
  requirements?: Partial<Omit<PaymentRequirements, 'resource'>>;
}

export interface Harness {
  server: PayGuardServer;
  store: MemoryStore;
  rail: StubRail;
  facilitators: Facilitator[];
  request(headers?: Record<string, string>): Promise<ReturnType<PayGuardServer['guard']>>;
}

export function harness(options: HarnessOptions = {}): Harness {
  const rail = options.rail ?? new StubRail();
  const store = options.store ?? new MemoryStore();
  const facilitators = options.facilitators ?? [new StubFacilitator()];
  const protectedRail: ProtectedRail = {
    id: 'base:usdc',
    rail,
    requirements: requirementsTemplate(options.requirements),
    minConfirmations: options.minConfirmations ?? 1,
  };

  const server = new PayGuardServer({
    rails: [protectedRail],
    facilitators,
    store,
    mode: options.mode ?? 'strict',
    confirmationTimeoutMs: 200,
    confirmationPollIntervalMs: 10,
    inFlightWaitMs: 500,
  });

  return {
    server,
    store,
    rail,
    facilitators,
    request: (headers: Record<string, string> = {}) =>
      server.guard({
        method: 'GET',
        url: RESOURCE,
        header: (name) => headers[name.toLowerCase()],
      }),
  };
}
