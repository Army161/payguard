import { z } from 'zod';
import { AtomicAmountSchema } from '../x402/requirements.js';
import { NetworkSchema } from '../x402/network.js';
import { RailIdSchema } from '../rail/id.js';
import { REASON_CODES } from '../errors.js';
import { VerificationModeSchema } from '../verify/mode.js';

export const AUDIT_OUTCOMES = ['allowed', 'denied', 'requires_human', 'error'] as const;
export const AuditOutcomeSchema = z.enum(AUDIT_OUTCOMES);
export type AuditOutcome = z.infer<typeof AuditOutcomeSchema>;

export const AUDIT_STAGES = [
  'policy',
  'payload_validation',
  'nonce_claim',
  'facilitator_verify',
  'facilitator_settle',
  'chain_confirmation',
  'release',
] as const;
export const AuditStageSchema = z.enum(AUDIT_STAGES);
export type AuditStage = z.infer<typeof AuditStageSchema>;

/**
 * The body of one audit record. FR-5.1 fixes the fields; the hash chain in chain.ts fixes the
 * order. Everything optional here is optional because it is genuinely unknown at some stages, not
 * because it is nice to have.
 */
export const AuditBodySchema = z.object({
  /** Correlates every record produced while handling one HTTP request. */
  requestId: z.string().min(1),
  /** Which agent or tenant spent. Null on the seller side when the buyer is anonymous. */
  agentId: z.string().min(1).nullable(),
  /** The other side of the payment: seller address for a buyer, payer for a seller. */
  counterparty: z.string().nullable(),
  rail: RailIdSchema.nullable(),
  network: NetworkSchema.nullable(),
  amount: AtomicAmountSchema.nullable(),
  asset: z.string().nullable(),
  facilitator: z.string().nullable(),
  mode: VerificationModeSchema.nullable(),
  stage: AuditStageSchema,
  outcome: AuditOutcomeSchema,
  reason: z.enum(REASON_CODES).nullable(),
  message: z.string(),
  /** Settlement proof: the on-chain transaction hash, once one exists. */
  transactionHash: z.string().nullable(),
  /** Stable identity of the payment attempt, from payload/hash.ts. */
  paymentId: z.string().nullable(),
  /** Epoch milliseconds. */
  timestampMs: z.number().int().nonnegative(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export type AuditBody = z.infer<typeof AuditBodySchema>;

export const AuditEntrySchema = AuditBodySchema.extend({
  /** Position in the chain, starting at 0. */
  seq: z.number().int().nonnegative(),
  /** Hash of the previous entry, or GENESIS_HASH for the first. */
  prevHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** Hash of this entry, covering seq, prevHash, and every body field. */
  hash: z.string().regex(/^[0-9a-f]{64}$/),
});

export type AuditEntry = z.infer<typeof AuditEntrySchema>;

/** A partial body, for callers that only know some fields at the point they log. */
export type AuditDraft = Omit<AuditBody, 'timestampMs'> & { timestampMs?: number };
