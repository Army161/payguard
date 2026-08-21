import { randomUUID } from 'node:crypto';
import {
  HeaderDecodeError,
  IDEMPOTENCY_HEADER,
  PAYMENT_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PayGuardError,
  assertWithinValidity,
  decodePaymentHeader,
  encodeSettleResponseHeader,
  expectationFromRequirements,
  isPayGuardError,
  nonceTtlMs,
  paymentId as computePaymentId,
  systemClock,
  type AuditBody,
  type AuditStage,
  type Clock,
  type PaymentPayload,
  type PaymentRequirements,
  type ReasonCode,
  type Store,
  type VerificationMode,
} from '@payguard/core';
import { HealthMonitor } from '@payguard/rails';
import { matchRail, paymentRequiredBody } from './accepts.js';
import { confirmSettlement } from './confirm.js';
import { verifyAndSettle } from './settle.js';
import type { GuardOptions, GuardOutcome, GuardRequest, ProtectedRail } from './types.js';

/** How long a losing racer waits for the winner's response before giving up. */
const IN_FLIGHT_POLL_MS = 25;

export interface PayGuardServerOptions extends GuardOptions {
  /** How long to wait for the chain to reach the required confirmation depth. */
  confirmationTimeoutMs?: number;
  confirmationPollIntervalMs?: number;
  /** How long a losing racer waits for an in-flight identical request to finish. */
  inFlightWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The seller side of PayGuard. Implements design.md's request lifecycle in one framework-neutral
 * place, so the Express, Hono, and Fastify adapters are transport only and cannot each get the
 * ordering subtly wrong.
 *
 * The ordering is the security property. Claim the nonce before verifying, verify before settling,
 * settle before confirming, and confirm before releasing. Any reordering reintroduces one of the
 * documented attack classes.
 */
export class PayGuardServer {
  private readonly rails: readonly ProtectedRail[];
  private readonly monitor: HealthMonitor;
  private readonly store: Store;
  private readonly mode: VerificationMode;
  private readonly clock: Clock;
  private readonly options: PayGuardServerOptions;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: PayGuardServerOptions) {
    if (options.rails.length === 0) {
      throw new PayGuardError('unsupported_rail', 'a protected endpoint needs at least one rail');
    }
    this.rails = options.rails;
    this.monitor = new HealthMonitor(options.facilitators, { clock: options.clock });
    this.store = options.store;
    this.mode = options.mode ?? 'strict';
    this.clock = options.clock ?? systemClock;
    this.options = options;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get verificationMode(): VerificationMode {
    return this.mode;
  }

  get health(): HealthMonitor {
    return this.monitor;
  }

  /**
   * Runs the lifecycle for one request. Returns what the adapter should do, never writes a
   * response itself, so the same logic serves a middleware, a proxy, and the CLI's audit command.
   */
  async guard(request: GuardRequest): Promise<GuardOutcome> {
    const requestId = this.options.requestId?.() ?? randomUUID();
    const resource = request.url;
    const idempotencyKey = request.header(IDEMPOTENCY_HEADER) ?? null;

    // FR-2.2. A retry with a key we have already answered replays the stored response. This runs
    // before anything else, because re-charging a buyer who retried is the failure being avoided.
    if (idempotencyKey !== null) {
      const cached = await this.store.getIdempotent(idempotencyKey);
      if (cached !== null) {
        await this.audit(requestId, 'release', 'allowed', null, 'replayed a cached response', {
          paymentId: cached.paymentId,
          idempotencyKey,
        });
        return {
          kind: 'replay_response',
          status: cached.status,
          headers: cached.headers,
          bodyBase64: cached.bodyBase64,
        };
      }
    }

    // Step 1: no payment, so quote the price on every rail this endpoint accepts.
    const header = request.header(PAYMENT_HEADER);
    if (header === undefined || header === '') {
      return this.paymentRequired(requestId, resource, 'payload_missing', 'payment required');
    }

    // Step 2: decode and schema validate before anything trusts a field.
    let payload: PaymentPayload;
    try {
      payload = decodePaymentHeader(header, this.options.maxPaymentHeaderBytes);
    } catch (error) {
      const reason: ReasonCode =
        error instanceof HeaderDecodeError && /exceeds/.test(error.message)
          ? 'payload_too_large'
          : 'payload_malformed';
      return this.paymentRequired(
        requestId,
        resource,
        reason,
        error instanceof Error ? error.message : 'payment payload could not be read',
        'payload_validation',
      );
    }

    const protectedRail = matchRail(this.rails, payload.network);
    if (protectedRail === undefined) {
      return this.paymentRequired(
        requestId,
        resource,
        'unsupported_network',
        `this endpoint does not accept payment on ${payload.network}`,
        'payload_validation',
      );
    }

    const requirements: PaymentRequirements = { ...protectedRail.requirements, resource };

    try {
      assertWithinValidity(payload, requirements, {
        nowMs: this.clock.now(),
        ...(this.options.clockSkewToleranceMs === undefined
          ? {}
          : { clockSkewToleranceMs: this.options.clockSkewToleranceMs }),
        ...(this.options.maxValidityWindowMs === undefined
          ? {}
          : { maxValidityWindowMs: this.options.maxValidityWindowMs }),
      });
    } catch (error) {
      const reason = isPayGuardError(error) ? error.reason : 'payload_malformed';
      return this.paymentRequired(
        requestId,
        resource,
        reason,
        error instanceof Error ? error.message : 'payment payload is outside its validity window',
        'payload_validation',
        { rail: protectedRail },
      );
    }

    const paymentId = computePaymentId(payload, requirements);

    // Step 3: claim the payment atomically. This single call is what makes AT-2 and AT-3 hold:
    // the first caller wins, everyone else is a replay, and nothing in between can interleave.
    const ttl = nonceTtlMs(payload, requirements, {
      nowMs: this.clock.now(),
      ...(this.options.clockSkewToleranceMs === undefined
        ? {}
        : { clockSkewToleranceMs: this.options.clockSkewToleranceMs }),
    });
    const claimed = await this.store.claimNonce(paymentId, ttl);
    if (!claimed) {
      // Two different things land here: a genuine replay, and a concurrent duplicate whose winner
      // is still working. When the buyer supplied an idempotency key we can tell them apart by
      // waiting briefly for the winner to publish its response.
      if (idempotencyKey !== null) {
        const cached = await this.waitForInFlight(idempotencyKey);
        if (cached !== null) {
          return {
            kind: 'replay_response',
            status: cached.status,
            headers: cached.headers,
            bodyBase64: cached.bodyBase64,
          };
        }
      }
      return this.paymentRequired(
        requestId,
        resource,
        'replay_detected',
        'this payment payload has already been used',
        'nonce_claim',
        { rail: protectedRail, paymentId },
      );
    }

    try {
      // Steps 4 and 5: verify, then settle, failing over only on transport level failures.
      const settlement = await verifyAndSettle(
        this.monitor,
        protectedRail.id,
        payload,
        requirements,
      );

      if (!settlement.ok) {
        await this.store.releaseNonce(paymentId);
        return this.settlementFailure(requestId, resource, protectedRail, paymentId, settlement);
      }

      const { settle, facilitatorId } = settlement;

      // Step 6: independent confirmation. This is the line between PayGuard and a facilitator's
      // own word, and it is the whole reason strict mode exists.
      if (this.mode === 'strict') {
        const expectation = expectationFromRequirements(
          requirements,
          protectedRail.id,
          protectedRail.minConfirmations,
        );
        const confirmation = await confirmSettlement(
          protectedRail.rail,
          settle.transaction,
          expectation,
          {
            timeoutMs: this.options.confirmationTimeoutMs ?? 60_000,
            pollIntervalMs: this.options.confirmationPollIntervalMs ?? 2_000,
            clock: this.clock,
            sleep: this.sleep,
          },
        );

        if (!confirmation.result.ok) {
          // The payload was spent, so the claim is NOT released. Releasing it would let the same
          // payload be presented again, and the money has already moved. The audit entry is what
          // reconciliation works from.
          await this.audit(
            requestId,
            'chain_confirmation',
            'denied',
            confirmation.result.reason,
            confirmation.result.message,
            {
              rail: protectedRail,
              paymentId,
              facilitatorId,
              transactionHash: settle.transaction,
              details: {
                ...confirmation.result.details,
                attempts: confirmation.attempts,
                reconciliation:
                  'settlement occurred but did not match the expectation; the resource was not released',
              },
            },
          );
          return {
            kind: 'payment_required',
            status: 402,
            reason: confirmation.result.reason,
            headers: {
              'content-type': 'application/json',
              [PAYMENT_RESPONSE_HEADER]: encodeSettleResponseHeader(settle),
            },
            body: paymentRequiredBody(this.rails, resource, confirmation.result.reason),
          };
        }
      }

      // Step 7: release. The adapter produces the resource and calls capture, which is what
      // stores the idempotent copy.
      await this.audit(requestId, 'release', 'allowed', null, 'settlement confirmed, releasing', {
        rail: protectedRail,
        paymentId,
        facilitatorId,
        transactionHash: settle.transaction,
        details: { mode: this.mode },
      });

      return {
        kind: 'settled',
        headers: { [PAYMENT_RESPONSE_HEADER]: encodeSettleResponseHeader(settle) },
        idempotencyKey,
        paymentId,
        transactionHash: settle.transaction,
        facilitatorId,
        rail: protectedRail.id,
        capture: async (status, headers, body) => {
          if (idempotencyKey === null) return;
          await this.store.putIdempotent(
            idempotencyKey,
            {
              status,
              headers,
              bodyBase64: body.toString('base64'),
              paymentId,
              storedAtMs: this.clock.now(),
            },
            this.options.idempotencyTtlMs ?? 3_600_000,
          );
        },
      };
    } catch (error) {
      // An unexpected failure leaves the claim in place rather than releasing it, because we do
      // not know whether the payload was spent. Fail closed, per design.md.
      await this.audit(
        requestId,
        'facilitator_settle',
        'error',
        'internal_error',
        error instanceof Error ? error.message : String(error),
        { rail: protectedRail, paymentId },
      );
      throw error;
    }
  }

  private async waitForInFlight(
    idempotencyKey: string,
  ): Promise<Awaited<ReturnType<Store['getIdempotent']>>> {
    const budget = this.options.inFlightWaitMs ?? 2_000;
    const deadline = Date.now() + budget;
    for (;;) {
      const cached = await this.store.getIdempotent(idempotencyKey);
      if (cached !== null) return cached;
      if (Date.now() + IN_FLIGHT_POLL_MS > deadline) return null;
      await this.sleep(IN_FLIGHT_POLL_MS);
    }
  }

  private async settlementFailure(
    requestId: string,
    resource: string,
    rail: ProtectedRail,
    paymentId: string,
    settlement: Extract<Awaited<ReturnType<typeof verifyAndSettle>>, { ok: false }>,
  ): Promise<GuardOutcome> {
    const reason: ReasonCode =
      settlement.kind === 'rejected'
        ? 'facilitator_rejected'
        : settlement.kind === 'settle_failed'
          ? 'settlement_failed'
          : 'facilitator_unavailable';

    const message =
      settlement.kind === 'rejected'
        ? `facilitator rejected the payment: ${settlement.verify.invalidReason ?? 'no reason given'}`
        : settlement.kind === 'settle_failed'
          ? `facilitator could not settle: ${settlement.settle.errorReason ?? 'no reason given'}`
          : 'no healthy facilitator could handle this rail';

    return this.paymentRequired(
      requestId,
      resource,
      reason,
      message,
      settlement.kind === 'settle_failed' ? 'facilitator_settle' : 'facilitator_verify',
      {
        rail,
        paymentId,
        ...('facilitatorId' in settlement ? { facilitatorId: settlement.facilitatorId } : {}),
        details: {
          attempts: settlement.attempts.map((a) => ({
            facilitator: a.facilitatorId,
            stage: a.stage,
            kind: a.error.kind,
            message: a.error.message,
          })),
        },
      },
    );
  }

  private async paymentRequired(
    requestId: string,
    resource: string,
    reason: ReasonCode,
    message: string,
    stage: AuditStage = 'payload_validation',
    extra: {
      rail?: ProtectedRail;
      paymentId?: string;
      facilitatorId?: string;
      details?: Record<string, unknown>;
    } = {},
  ): Promise<GuardOutcome> {
    await this.audit(requestId, stage, 'denied', reason, message, extra);
    return {
      kind: 'payment_required',
      status: 402,
      reason,
      headers: { 'content-type': 'application/json' },
      body: paymentRequiredBody(this.rails, resource, reason),
    };
  }

  private async audit(
    requestId: string,
    stage: AuditStage,
    outcome: AuditBody['outcome'],
    reason: ReasonCode | null,
    message: string,
    extra: {
      rail?: ProtectedRail;
      paymentId?: string;
      facilitatorId?: string;
      transactionHash?: string;
      idempotencyKey?: string;
      details?: Record<string, unknown>;
    } = {},
  ): Promise<void> {
    const rail = extra.rail;
    const body: AuditBody = {
      requestId,
      agentId: null,
      counterparty: null,
      rail: rail?.id ?? null,
      network: rail?.requirements.network ?? null,
      amount: rail?.requirements.maxAmountRequired ?? null,
      asset: rail?.requirements.asset ?? null,
      facilitator: extra.facilitatorId ?? null,
      mode: this.mode,
      stage,
      outcome,
      reason,
      message,
      transactionHash: extra.transactionHash ?? null,
      paymentId: extra.paymentId ?? null,
      timestampMs: this.clock.now(),
      ...(extra.details === undefined ? {} : { details: extra.details }),
    };

    await this.store.appendAudit(body);

    // A webhook that is down must never take the payment path with it, per FR-5.3.
    if (this.options.onAudit !== undefined) {
      try {
        await this.options.onAudit(body);
      } catch {
        // Deliberately swallowed. The append above is the durable record.
      }
    }
  }
}
