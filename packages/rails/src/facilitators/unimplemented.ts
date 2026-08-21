import type {
  PaymentPayload,
  PaymentRequirements,
  RailId,
  SettleResponse,
  VerifyResponse,
} from '@payguard/core';
import { FacilitatorError, type Facilitator, type Health } from './interface.js';

/**
 * A facilitator that is named in the roadmap but not shipped in v1.
 *
 * It exists so the router's shape is honest: an operator who configures Stripe finds out at the
 * first call, with a message that says what is missing and where the work is tracked, rather than
 * finding a silently different code path. It never returns a successful verify or settle, so it
 * cannot be mistaken for a working adapter, and `health()` reports unhealthy so the router skips
 * it during failover instead of routing payments into a dead end.
 */
export class UnimplementedFacilitator implements Facilitator {
  readonly id: string;
  readonly rails: readonly RailId[];
  private readonly reason: string;

  constructor(id: string, rails: readonly RailId[], reason: string) {
    this.id = id;
    this.rails = rails;
    this.reason = reason;
  }

  private fail(operation: string): never {
    throw new FacilitatorError(
      'not_implemented',
      this.id,
      `${operation} is not implemented for the ${this.id} facilitator in v1: ${this.reason}`,
    );
  }

  async verify(
    _payload: PaymentPayload,
    _requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    this.fail('verify');
  }

  async settle(
    _payload: PaymentPayload,
    _requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    this.fail('settle');
  }

  async health(): Promise<Health> {
    return {
      healthy: false,
      latencyMs: 0,
      lastSuccessMs: null,
      consecutiveFailures: Number.MAX_SAFE_INTEGER,
      message: `${this.id} is not implemented in v1: ${this.reason}`,
    };
  }
}

/**
 * plan.md lists Stripe among the facilitator adapters and build_v1.md scopes it out of v1. The
 * adapter is declared so the interface is complete and the router can be configured against it.
 */
export function stripeFacilitator(): UnimplementedFacilitator {
  return new UnimplementedFacilitator(
    'stripe',
    ['base:usdc'],
    'the Stripe x402 charge flow is scheduled for v2, see build_v1.md Phase 3',
  );
}

/** xpay.sh, same status as Stripe. */
export function xpayFacilitator(): UnimplementedFacilitator {
  return new UnimplementedFacilitator(
    'xpay',
    ['base:usdc'],
    'the xpay.sh adapter is scheduled for v2, see build_v1.md Phase 3',
  );
}
