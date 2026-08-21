import { z } from 'zod';
import type { ReasonCode } from '../errors.js';
import { RailIdSchema, type RailId } from '../rail/id.js';
import { AtomicAmountSchema } from '../x402/requirements.js';
import type { Network } from '../x402/network.js';

/**
 * The buyer's spend policy. Every field is optional: an empty policy allows everything except what
 * the mainnet guard blocks, and an operator opts in to each control. Defaults live in
 * `strictPolicy()` rather than in the schema, so "no policy configured" is visibly permissive
 * rather than quietly half enforced.
 */
export const PolicyConfigSchema = z.object({
  maxPerTransaction: AtomicAmountSchema.optional(),
  hourlyCap: AtomicAmountSchema.optional(),
  dailyCap: AtomicAmountSchema.optional(),
  maxTransactionsPerMinute: z.number().int().positive().optional(),
  /** When present, only these counterparties are payable. Absent means no allowlist. */
  allowCounterparties: z.array(z.string().min(1)).optional(),
  /** Always refused, and checked before the allowlist. */
  denyCounterparties: z.array(z.string().min(1)).optional(),
  allowRails: z.array(RailIdSchema).nonempty().optional(),
  /** How far above the originally quoted price a re-quote may move, in basis points. */
  priceToleranceBps: z.number().int().nonnegative().max(1_000_000).optional(),
  /** At or above this amount a human must approve before the payment is signed. */
  humanApprovalThreshold: AtomicAmountSchema.optional(),
  /** Refuse mainnet networks. True until the third party audit completes, per plan.md. */
  requireTestnet: z.boolean().default(true),
});

export type PolicyConfig = z.infer<typeof PolicyConfigSchema>;
export type PolicyConfigInput = z.input<typeof PolicyConfigSchema>;

/** A summary of what this agent has already spent, windowed by the ledger. */
export interface SpendSnapshot {
  /** Atomic amount spent in the trailing hour, on the same asset. */
  hourAtomic: string;
  /** Atomic amount spent in the trailing 24 hours, on the same asset. */
  dayAtomic: string;
  /** Payments attempted in the trailing minute, across all assets. */
  lastMinuteCount: number;
}

export const EMPTY_SNAPSHOT: SpendSnapshot = {
  hourAtomic: '0',
  dayAtomic: '0',
  lastMinuteCount: 0,
};

/** Everything a rule may look at. Pure data: no clock, no store, no network. */
export interface SpendContext {
  agentId: string;
  counterparty: string;
  rail: RailId;
  network: Network;
  asset: string;
  /** The amount about to be paid, in atomic units. */
  amount: string;
  /**
   * The price the seller quoted earlier in this exchange, if this is a re-quote. Absent on a first
   * quote, in which case the price tolerance rule has nothing to compare against.
   */
  quotedAmount?: string | undefined;
  killSwitchEngaged: boolean;
  snapshot: SpendSnapshot;
  nowMs: number;
}

export type RuleOutcome =
  | { effect: 'deny'; reason: ReasonCode; message: string; details?: Record<string, unknown> }
  | {
      effect: 'require_human';
      reason: 'human_approval_required';
      message: string;
      details?: Record<string, unknown>;
    };

export interface PolicyRule {
  readonly id: string;
  /** Returns null when the rule has no opinion about this context. */
  evaluate(context: SpendContext, config: PolicyConfig): RuleOutcome | null;
}

export type Decision =
  | { effect: 'allow'; rule: null; reason: null; message: string }
  | {
      effect: 'deny' | 'require_human';
      rule: string;
      reason: ReasonCode;
      message: string;
      details?: Record<string, unknown>;
    };
