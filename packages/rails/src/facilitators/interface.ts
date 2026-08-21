import type {
  PaymentPayload,
  PaymentRequirements,
  RailId,
  SettleResponse,
  VerifyResponse,
} from '@payguard/core';

export interface Health {
  healthy: boolean;
  /** Round trip latency of the last probe, in milliseconds. */
  latencyMs: number;
  /** Epoch milliseconds of the last successful call, or null if there has never been one. */
  lastSuccessMs: number | null;
  /** Consecutive failures since the last success. */
  consecutiveFailures: number;
  message?: string;
}

/**
 * A facilitator verifies and settles payment payloads. PayGuard treats every one of them as
 * untrusted: `verify` and `settle` results are inputs to a decision, never the decision itself.
 * In strict mode a successful settle still has to be confirmed on chain before anything ships.
 */
export interface Facilitator {
  readonly id: string;
  readonly rails: readonly RailId[];
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
  health(): Promise<Health>;
}

/** Every adapter failure normalizes to one of these, so callers do not parse vendor prose. */
export const FACILITATOR_ERROR_KINDS = [
  'network',
  'timeout',
  'unauthorized',
  'rate_limited',
  'bad_request',
  'server_error',
  'malformed_response',
  'not_implemented',
] as const;

export type FacilitatorErrorKind = (typeof FACILITATOR_ERROR_KINDS)[number];

export class FacilitatorError extends Error {
  readonly kind: FacilitatorErrorKind;
  readonly facilitatorId: string;
  readonly status: number | undefined;

  constructor(kind: FacilitatorErrorKind, facilitatorId: string, message: string, status?: number) {
    super(message);
    this.name = 'FacilitatorError';
    this.kind = kind;
    this.facilitatorId = facilitatorId;
    this.status = status;
  }

  /** True when trying a different facilitator is the right response, per FR-4.2. */
  get isRetryableElsewhere(): boolean {
    return (
      this.kind === 'network' ||
      this.kind === 'timeout' ||
      this.kind === 'rate_limited' ||
      this.kind === 'server_error' ||
      this.kind === 'not_implemented'
    );
  }
}

export function statusToKind(status: number): FacilitatorErrorKind {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  return 'bad_request';
}
