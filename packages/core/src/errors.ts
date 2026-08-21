/**
 * Every refusal PayGuard can emit, as a stable machine-readable code. FR-2.1 requires the buyer to
 * be able to tell a replay from an expired payload without parsing prose, and FR-3.4 requires
 * every policy decision to carry a reason. Codes are append-only: never renumber, never reuse.
 */
export const REASON_CODES = [
  // Payload and protocol
  'payload_missing',
  'payload_malformed',
  'payload_too_large',
  'unsupported_x402_version',
  'unsupported_scheme',
  'unsupported_network',
  'unsupported_rail',
  'requirements_mismatch',

  // Time
  'payload_expired',
  'payload_not_yet_valid',
  'clock_skew_exceeded',

  // Replay and duplication
  'replay_detected',
  'settlement_in_flight',

  // Verification
  'facilitator_rejected',
  'facilitator_unavailable',
  'settlement_failed',
  'chain_confirmation_failed',
  'chain_recipient_mismatch',
  'chain_asset_mismatch',
  'chain_amount_insufficient',
  'chain_network_mismatch',
  'chain_transaction_not_found',
  'chain_transaction_reverted',

  // Buyer policy
  'kill_switch_engaged',
  'max_per_transaction_exceeded',
  'counterparty_denied',
  'counterparty_not_allowlisted',
  'rail_not_allowlisted',
  'spend_cap_exceeded',
  'velocity_exceeded',
  'price_change_exceeded',
  'human_approval_required',

  // Operational
  'mainnet_disabled',
  'not_implemented',
  'internal_error',
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

/** The machine-readable body PayGuard attaches to a refusal. */
export interface PayGuardErrorBody {
  reason: ReasonCode;
  message: string;
  details?: Record<string, unknown>;
}

export class PayGuardError extends Error {
  readonly reason: ReasonCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(reason: ReasonCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'PayGuardError';
    this.reason = reason;
    this.details = details;
  }

  toBody(): PayGuardErrorBody {
    return this.details === undefined
      ? { reason: this.reason, message: this.message }
      : { reason: this.reason, message: this.message, details: this.details };
  }
}

export function isPayGuardError(value: unknown): value is PayGuardError {
  return value instanceof PayGuardError;
}
