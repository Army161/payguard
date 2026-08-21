import { createServer, type Server } from 'node:http';
import {
  X402_VERSION,
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

/**
 * `payguard simulate` stands up a guarded endpoint backed by a scripted chain and facilitator,
 * then runs every documented attack against it. It is the demonstration an operator can run in
 * thirty seconds without a wallet, a faucet, or a testnet connection, and it exercises the same
 * code path a real deployment does.
 */

const SELLER = '0x1111111111111111111111111111111111111111';
const BUYER = '0x2222222222222222222222222222222222222222';
const ATTACKER = '0x9999999999999999999999999999999999999999';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

export interface SimulationCase {
  id: string;
  title: string;
  expectation: string;
}

export interface SimulationOutcome extends SimulationCase {
  blocked: boolean;
  detail: string;
}

export interface SimulationReport {
  cases: SimulationOutcome[];
  blocked: number;
  total: number;
  passed: boolean;
}

class ScriptedRail implements Rail {
  readonly id = 'base:usdc' as const;
  readonly networks: readonly Network[] = ['base-sepolia'];
  observation: Partial<ChainObservation> = {};

  async observe(lookup: RailLookup): Promise<ChainObservation> {
    return {
      network: 'base-sepolia',
      transactionHash: lookup.transactionHash,
      recipient: SELLER,
      asset: USDC,
      amount: '10000',
      confirmations: 1,
      succeeded: true,
      ...this.observation,
    };
  }

  async close(): Promise<void> {}
}

class ScriptedFacilitator implements Facilitator {
  readonly id = 'simulated';
  readonly rails = ['base:usdc'] as const;
  settleCalls = 0;

  /**
   * Stands in for signature verification. A real facilitator refuses an unsigned payload, so the
   * simulation has to as well, otherwise `payguard audit` run against `payguard protect --demo`
   * correctly reports a vulnerability that only exists in the stub.
   */
  async verify(payload: PaymentPayload): Promise<VerifyResponse> {
    const inner = payload.payload;
    const signature = 'signature' in inner ? inner.signature : '';
    if (/^0x0+$/.test(signature)) {
      return { isValid: false, invalidReason: 'invalid_exact_evm_payload_signature' };
    }
    if (
      'transaction' in inner &&
      Buffer.from(inner.transaction, 'hex').toString('utf8') === 'payguardaudit'
    ) {
      return { isValid: false, invalidReason: 'invalid_payload' };
    }
    return { isValid: true, payer: BUYER };
  }

  async settle(): Promise<SettleResponse> {
    this.settleCalls += 1;
    return {
      success: true,
      transaction: `0x${'11'.repeat(32)}`,
      network: 'base-sepolia',
      payer: BUYER,
    };
  }

  async health(): Promise<Health> {
    return { healthy: true, latencyMs: 1, lastSuccessMs: Date.now(), consecutiveFailures: 0 };
  }
}

function requirements(): Omit<PaymentRequirements, 'resource'> {
  return {
    scheme: 'exact',
    network: 'base-sepolia',
    maxAmountRequired: '10000',
    description: 'Simulated priced resource',
    mimeType: 'application/json',
    payTo: SELLER,
    maxTimeoutSeconds: 300,
    asset: USDC,
  };
}

function payload(nonce: string): PaymentPayload {
  const now = Math.floor(Date.now() / 1000);
  return {
    x402Version: X402_VERSION,
    scheme: 'exact',
    network: 'base-sepolia',
    payload: {
      signature: `0x${'ab'.repeat(65)}`,
      authorization: {
        from: BUYER,
        to: SELLER,
        value: '10000',
        validAfter: String(now - 60),
        validBefore: String(now + 300),
        nonce,
      },
    },
  };
}

let nonceCounter = 0;
const nextNonce = () => `0x${(nonceCounter += 1).toString(16).padStart(64, '0')}`;

/** Runs the simulation in process, without opening a socket. Used by the tests and by the CLI. */
export async function runSimulation(): Promise<SimulationReport> {
  const cases: SimulationOutcome[] = [];

  const build = (railOverrides: Partial<ChainObservation> = {}) => {
    const rail = new ScriptedRail();
    rail.observation = railOverrides;
    const facilitator = new ScriptedFacilitator();
    const store = new MemoryStore();
    const protectedRail: ProtectedRail = {
      id: 'base:usdc',
      rail,
      requirements: requirements(),
      minConfirmations: 1,
    };
    const server = new PayGuardServer({
      rails: [protectedRail],
      facilitators: [facilitator],
      store,
      confirmationTimeoutMs: 300,
      confirmationPollIntervalMs: 10,
    });
    const call = (headers: Record<string, string> = {}) =>
      server.guard({
        method: 'GET',
        url: 'https://simulated.local/api/resource',
        header: (name) => headers[name.toLowerCase()],
      });
    return { call, facilitator, store };
  };

  // Free shopping
  {
    const { call, facilitator } = build();
    const outcome = await call();
    cases.push({
      id: 'free-shopping',
      title: 'Free shopping: resource released before settlement',
      expectation: 'An unpaid request gets 402 and no facilitator is contacted.',
      blocked: outcome.kind === 'payment_required' && facilitator.settleCalls === 0,
      detail: `unpaid request produced ${outcome.kind}, facilitator settle calls: ${facilitator.settleCalls}`,
    });
  }

  // Replay
  {
    const { call } = build();
    const header = encodePaymentHeader(payload(nextNonce()));
    const first = await call({ 'x-payment': header });
    const second = await call({ 'x-payment': header });
    cases.push({
      id: 'replay',
      title: 'Replay: the same payload spent twice',
      expectation: 'The first presentation settles, the second is refused.',
      blocked: first.kind === 'settled' && second.kind === 'payment_required',
      detail: `first: ${first.kind}, second: ${second.kind}${
        second.kind === 'payment_required' ? ` (${second.reason})` : ''
      }`,
    });
  }

  // Duplication and TOCTOU
  {
    const { call, facilitator } = build();
    const header = encodePaymentHeader(payload(nextNonce()));
    const outcomes = await Promise.all(
      Array.from({ length: 50 }, () => call({ 'x-payment': header })),
    );
    const delivered = outcomes.filter((o) => o.kind === 'settled').length;
    cases.push({
      id: 'duplication',
      title: 'Duplication and TOCTOU: fifty concurrent identical requests',
      expectation: 'Exactly one delivery and exactly one settlement.',
      blocked: delivered === 1 && facilitator.settleCalls === 1,
      detail: `${delivered} of 50 delivered, ${facilitator.settleCalls} settlement(s)`,
    });
  }

  // Asset theft: paid to the wrong recipient
  {
    const { call } = build({ recipient: ATTACKER });
    const outcome = await call({ 'x-payment': encodePaymentHeader(payload(nextNonce())) });
    cases.push({
      id: 'asset-theft',
      title: 'Asset theft: settlement paid to someone other than the seller',
      expectation: 'The chain check refuses it with chain_recipient_mismatch.',
      blocked: outcome.kind === 'payment_required' && outcome.reason === 'chain_recipient_mismatch',
      detail:
        outcome.kind === 'payment_required'
          ? `refused with ${outcome.reason}`
          : `delivered anyway (${outcome.kind})`,
    });
  }

  // Short payment
  {
    const { call } = build({ amount: '1' });
    const outcome = await call({ 'x-payment': encodePaymentHeader(payload(nextNonce())) });
    cases.push({
      id: 'short-payment',
      title: 'Short payment: settlement delivered less than the price',
      expectation: 'The chain check refuses it with chain_amount_insufficient.',
      blocked:
        outcome.kind === 'payment_required' && outcome.reason === 'chain_amount_insufficient',
      detail:
        outcome.kind === 'payment_required'
          ? `refused with ${outcome.reason}`
          : `delivered anyway (${outcome.kind})`,
    });
  }

  const blocked = cases.filter((c) => c.blocked).length;
  return { cases, blocked, total: cases.length, passed: blocked === cases.length };
}

export function renderSimulation(report: SimulationReport): string {
  const lines = ['PayGuard attack simulation', ''];
  for (const item of report.cases) {
    lines.push(`  [${item.blocked ? 'BLOCKED' : 'FAILED '}] ${item.title}`);
    lines.push(`            ${item.detail}`);
  }
  lines.push('');
  lines.push(`  ${report.blocked} of ${report.total} attack classes blocked`);
  return lines.join('\n');
}

/**
 * Stands up the simulated seller on a real port, for `payguard protect --demo` and for anyone who
 * wants to point their own agent at it.
 */
export async function startSimulatedSeller(port = 0): Promise<{ url: string; server: Server }> {
  const rail = new ScriptedRail();
  const store = new MemoryStore();
  const server = new PayGuardServer({
    rails: [{ id: 'base:usdc', rail, requirements: requirements(), minConfirmations: 1 }],
    facilitators: [new ScriptedFacilitator()],
    store,
    confirmationTimeoutMs: 300,
    confirmationPollIntervalMs: 10,
  });

  const http = createServer((request, response) => {
    const url = `http://${request.headers.host ?? 'localhost'}${request.url ?? '/'}`;
    void server
      .guard({
        method: request.method ?? 'GET',
        url,
        header: (name) => {
          const value = request.headers[name.toLowerCase()];
          return Array.isArray(value) ? value[0] : value;
        },
      })
      .then(async (outcome) => {
        if (outcome.kind === 'payment_required') {
          const body = Buffer.from(JSON.stringify(outcome.body), 'utf8');
          response.writeHead(402, { ...outcome.headers, 'content-length': String(body.length) });
          response.end(body);
          return;
        }
        if (outcome.kind === 'replay_response') {
          response.writeHead(outcome.status, outcome.headers);
          response.end(Buffer.from(outcome.bodyBase64, 'base64'));
          return;
        }
        const body = Buffer.from(JSON.stringify({ resource: 'simulated payload' }), 'utf8');
        const headers = {
          ...outcome.headers,
          'content-type': 'application/json',
          'content-length': String(body.length),
        };
        await outcome.capture(200, headers, body);
        response.writeHead(200, headers);
        response.end(body);
      })
      .catch(() => {
        response.writeHead(500).end();
      });
  });

  const url = await new Promise<string>((resolve) => {
    http.listen(port, '127.0.0.1', () => {
      const address = http.address();
      if (address === null || typeof address === 'string') throw new Error('no port');
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });

  return { url, server: http };
}
