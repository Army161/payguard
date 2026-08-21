import type {
  AuditBody,
  Clock,
  PaymentRequirements,
  RailId,
  ReasonCode,
  Store,
  VerificationMode,
} from '@payguard/core';
import type { Facilitator, Rail } from '@payguard/rails';

/** One rail the seller advertises in its 402, plus how to verify settlement on it. */
export interface ProtectedRail {
  id: RailId;
  rail: Rail;
  /** The seller's requirements template for this rail. `resource` is filled per request. */
  requirements: Omit<PaymentRequirements, 'resource'>;
  minConfirmations: number;
}

export interface GuardOptions {
  rails: readonly ProtectedRail[];
  facilitators: readonly Facilitator[];
  store: Store;
  mode?: VerificationMode;
  clock?: Clock;
  /** Emitted for every decision, per FR-5.3. Failures here never block a response. */
  onAudit?: (entry: AuditBody) => void | Promise<void>;
  /** Byte ceiling on the X-PAYMENT header. */
  maxPaymentHeaderBytes?: number;
  clockSkewToleranceMs?: number;
  maxValidityWindowMs?: number;
  /** How long an idempotent response is replayable. */
  idempotencyTtlMs?: number;
  /** Generates the request id used to correlate audit entries. */
  requestId?: () => string;
}

/** The framework-neutral view of an incoming request the handler needs. */
export interface GuardRequest {
  method: string;
  /** Absolute URL of the resource being paid for. */
  url: string;
  header(name: string): string | undefined;
}

export type GuardOutcome =
  | {
      kind: 'payment_required';
      status: 402;
      body: unknown;
      headers: Record<string, string>;
      reason: ReasonCode;
    }
  | {
      kind: 'replay_response';
      status: number;
      headers: Record<string, string>;
      bodyBase64: string;
    }
  | {
      kind: 'settled';
      headers: Record<string, string>;
      /** Present so the handler can record the delivered response against the key. */
      idempotencyKey: string | null;
      paymentId: string;
      transactionHash: string;
      facilitatorId: string;
      rail: RailId;
      /** Called by the framework adapter once the resource has been produced. */
      capture(status: number, headers: Record<string, string>, body: Buffer): Promise<void>;
    };
