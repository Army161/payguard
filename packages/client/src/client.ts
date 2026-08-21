import { randomUUID } from 'node:crypto';
import {
  IDEMPOTENCY_HEADER,
  InMemorySpendLedger,
  PAYMENT_HEADER,
  PayGuardError,
  PolicyEngine,
  X402ResponseSchema,
  encodePaymentHeader,
  systemClock,
  type AuditBody,
  type Clock,
  type Decision,
  type PaymentRequirements,
  type PolicyConfigInput,
  type RailId,
  type Store,
} from '@payguard/core';
import { KillSwitch, type KillSwitchOptions } from './kill-switch.js';
import { chooseRail, railOf } from './router.js';
import type { Signer } from './signer/interface.js';

export interface PayGuardClientOptions {
  signer: Signer;
  /** Identifies this agent in policy decisions and in the audit trail. */
  agentId: string;
  policy?: PolicyConfigInput;
  /** Rails this buyer will pay on, most preferred first. */
  allowRails?: readonly RailId[];
  killSwitch?: KillSwitch | KillSwitchOptions;
  /** Records decisions. Optional: a buyer with no store still gets policy enforcement. */
  store?: Store;
  clock?: Clock;
  /** Injected in tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** How many rails to try before giving up on one resource. */
  maxRailAttempts?: number;
  /** Called when policy says a human must approve. Returning false refuses the payment. */
  onHumanApproval?: (context: HumanApprovalRequest) => Promise<boolean>;
  onAudit?: (entry: AuditBody) => void | Promise<void>;
}

export interface HumanApprovalRequest {
  agentId: string;
  requirements: PaymentRequirements;
  rail: RailId;
  decision: Decision;
}

export interface PayResult {
  response: Response;
  /** Absent when the resource needed no payment. */
  payment?: {
    rail: RailId;
    amount: string;
    counterparty: string;
    attempts: RailId[];
    /**
     * True when the seller returned a 2xx. False means a payment was presented and the seller
     * answered with something else, so whether the money moved is between the buyer and the audit
     * log rather than something the client can assert.
     */
    delivered: boolean;
  };
}

export class PolicyDenied extends PayGuardError {
  readonly decision: Decision;

  constructor(decision: Decision) {
    super(decision.reason ?? 'internal_error', decision.message, { rule: decision.rule });
    this.name = 'PolicyDenied';
    this.decision = decision;
  }
}

/**
 * The buyer side. Wraps fetch so an agent can call a priced endpoint the way it calls any other
 * one, while the policy engine, the kill switch, and the failover router sit in between.
 *
 * PayGuard never sees a key. It hands requirements to a Signer and gets a payload back.
 */
export class PayGuardClient {
  private readonly signer: Signer;
  private readonly agentId: string;
  private readonly engine: PolicyEngine;
  private readonly killSwitch: KillSwitch;
  private readonly ledger = new InMemorySpendLedger();
  private readonly clock: Clock;
  private readonly fetchImpl: typeof fetch;
  private readonly options: PayGuardClientOptions;

  constructor(options: PayGuardClientOptions) {
    this.signer = options.signer;
    this.agentId = options.agentId;
    this.engine = new PolicyEngine(options.policy ?? {});
    this.killSwitch =
      options.killSwitch instanceof KillSwitch
        ? options.killSwitch
        : new KillSwitch({
            ...options.killSwitch,
            ...(options.clock === undefined ? {} : { clock: options.clock }),
          });
    this.clock = options.clock ?? systemClock;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.options = options;
  }

  get policy(): PolicyEngine {
    return this.engine;
  }

  get halt(): KillSwitch {
    return this.killSwitch;
  }

  /**
   * Fetches a resource, paying for it if the seller asks.
   *
   * Failover walks the seller's accepted rails: a rail whose payment the seller refuses for a
   * transport reason is excluded and the next one is tried. FR-4.4 holds because each attempt
   * signs a distinct payload and only one of them can ever be settled: the seller claims the
   * payment id atomically before it verifies anything.
   */
  async pay(input: string, init: RequestInit = {}): Promise<PayResult> {
    const requestId = randomUUID();
    const idempotencyKey = readHeader(init.headers, IDEMPOTENCY_HEADER) ?? requestId;

    const first = await this.fetchImpl(input, withHeader(init, IDEMPOTENCY_HEADER, idempotencyKey));
    if (first.status !== 402) {
      return { response: first };
    }

    const quote = X402ResponseSchema.safeParse(
      await first
        .clone()
        .json()
        .catch(() => null),
    );
    if (!quote.success) {
      throw new PayGuardError(
        'requirements_mismatch',
        'seller returned 402 without a readable x402 accepts list',
      );
    }

    const attempted: RailId[] = [];
    const excluded = new Set<RailId>();
    const maxAttempts = this.options.maxRailAttempts ?? 3;
    let quotedAmount: string | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const choice = chooseRail(quote.data.accepts, {
        ...(this.options.allowRails === undefined ? {} : { allowRails: this.options.allowRails }),
        exclude: excluded,
      });

      if (choice === undefined) {
        throw new PayGuardError(
          'rail_not_allowlisted',
          attempted.length === 0
            ? 'the seller accepts no rail this agent is allowed to pay on'
            : 'every acceptable rail has been tried',
          { accepts: quote.data.accepts.map((a) => a.network), attempted },
        );
      }

      const { requirements, rail } = choice;
      attempted.push(rail);
      excluded.add(rail);

      const decision = this.evaluate(requirements, rail, quotedAmount);
      quotedAmount ??= requirements.maxAmountRequired;

      if (decision.effect === 'deny') {
        await this.audit(requestId, 'denied', decision, requirements, rail);
        throw new PolicyDenied(decision);
      }

      if (decision.effect === 'require_human') {
        const approved = await this.options.onHumanApproval?.({
          agentId: this.agentId,
          requirements,
          rail,
          decision,
        });
        if (approved !== true) {
          await this.audit(requestId, 'requires_human', decision, requirements, rail);
          throw new PolicyDenied(decision);
        }
      }

      // Local signing. The key is behind the Signer and never enters this process's reach.
      const payload = await this.signer.signPayment(requirements);
      const header = encodePaymentHeader(payload);

      const paid = await this.fetchImpl(
        input,
        withHeader(withHeader(init, IDEMPOTENCY_HEADER, idempotencyKey), PAYMENT_HEADER, header),
      );

      if (paid.status !== 402) {
        // Anything other than a 402 means the exchange finished on this rail. It is recorded as
        // spent even on a 4xx or 5xx, because the seller may well have settled before failing, and
        // a spend cap that under-counts is worse than one that over-counts.
        //
        // Notably this does NOT fail over. A 5xx is ambiguous about whether the payload settled,
        // and paying again on another rail after an ambiguous failure is exactly the double charge
        // FR-4.4 forbids. Only an explicit 402 is a safe signal to try elsewhere.
        this.ledger.record({
          agentId: this.agentId,
          asset: requirements.asset,
          amount: requirements.maxAmountRequired,
          timestampMs: this.clock.now(),
        });
        const delivered = paid.status >= 200 && paid.status < 300;
        await this.audit(requestId, delivered ? 'allowed' : 'error', decision, requirements, rail);
        return {
          response: paid,
          payment: {
            rail,
            amount: requirements.maxAmountRequired,
            counterparty: requirements.payTo,
            attempts: [...attempted],
            delivered,
          },
        };
      }

      // The seller refused this rail with a 402. Try the next one rather than replaying the same
      // payload, which the seller would reject as a replay anyway.
    }

    throw new PayGuardError('facilitator_unavailable', 'every acceptable rail was refused', {
      attempted,
    });
  }

  private evaluate(
    requirements: PaymentRequirements,
    rail: RailId,
    quotedAmount: string | undefined,
  ): Decision {
    return this.engine.evaluate({
      agentId: this.agentId,
      counterparty: requirements.payTo,
      rail,
      network: requirements.network,
      asset: requirements.asset,
      amount: requirements.maxAmountRequired,
      quotedAmount,
      killSwitchEngaged: this.killSwitch.engaged,
      snapshot: this.ledger.snapshot({
        agentId: this.agentId,
        asset: requirements.asset,
        nowMs: this.clock.now(),
      }),
      nowMs: this.clock.now(),
    });
  }

  private async audit(
    requestId: string,
    outcome: AuditBody['outcome'],
    decision: Decision,
    requirements: PaymentRequirements,
    rail: RailId,
  ): Promise<void> {
    const body: AuditBody = {
      requestId,
      agentId: this.agentId,
      counterparty: requirements.payTo,
      rail,
      network: requirements.network,
      amount: requirements.maxAmountRequired,
      asset: requirements.asset,
      facilitator: null,
      mode: null,
      stage: 'policy',
      outcome,
      reason: decision.reason,
      message: decision.message,
      transactionHash: null,
      paymentId: null,
      timestampMs: this.clock.now(),
      details: { rule: decision.rule, resource: requirements.resource },
    };

    await this.options.store?.appendAudit(body);
    if (this.options.onAudit !== undefined) {
      try {
        await this.options.onAudit(body);
      } catch {
        // A broken webhook must not stop an agent from paying, per FR-5.3.
      }
    }
  }
}

export { railOf };

function readHeader(headers: RequestInit['headers'], name: string): string | undefined {
  if (headers === undefined) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) {
    return headers.find((entry) => entry[0]?.toLowerCase() === name)?.[1];
  }
  const entry = Object.entries(headers as Record<string, string>).find(
    ([key]) => key.toLowerCase() === name,
  );
  return entry?.[1];
}

function withHeader(init: RequestInit, name: string, value: string): RequestInit {
  const headers = new Headers(init.headers);
  headers.set(name, value);
  return { ...init, headers };
}
