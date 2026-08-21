import { z } from 'zod';
import { RailIdSchema } from '../rail/id.js';
import { NetworkSchema } from '../x402/network.js';
import { PolicyConfigSchema } from '../policy/types.js';
import { VerificationModeSchema } from '../verify/mode.js';
import {
  DEFAULT_CLOCK_SKEW_TOLERANCE_MS,
  DEFAULT_MAX_VALIDITY_WINDOW_MS,
} from '../verify/expiry.js';

/** One rail the seller accepts, or the buyer is willing to pay on. */
export const RailConfigSchema = z.object({
  id: RailIdSchema,
  network: NetworkSchema,
  /** ERC-20 contract address, or `CURRENCY.issuer` on XRPL. */
  asset: z.string().min(1),
  /** The seller's receiving address on this rail. Unused on the buyer side. */
  payTo: z.string().min(1).optional(),
  /** Decimals, used only for rendering amounts in reports. Settlement always uses atomic units. */
  decimals: z.number().int().min(0).max(36),
  /** Confirmations required before release. 1 is reasonable on an L2, higher on L1. */
  minConfirmations: z.number().int().min(0).max(1000).default(1),
  /** RPC endpoint. Base takes an HTTP URL, XRPL takes a websocket URL. */
  rpcUrl: z.string().url(),
});

export const FacilitatorConfigSchema = z.object({
  id: z.string().min(1),
  /** Base URL of the facilitator. Only https is accepted outside localhost. */
  url: z.string().url(),
  /** Rails this facilitator can settle. Used by the router to pick a fallback. */
  rails: z.array(RailIdSchema).nonempty(),
  /** Request timeout in milliseconds. */
  timeoutMs: z.number().int().positive().max(120_000).default(10_000),
  /** Consecutive failures before the breaker opens. */
  failureThreshold: z.number().int().positive().default(5),
  /** How long the breaker stays open before a trial request. */
  resetTimeoutMs: z.number().int().positive().default(30_000),
});

export const StoreConfigSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('memory') }),
  z.object({ kind: z.literal('sqlite'), path: z.string().min(1) }),
  z.object({
    kind: z.literal('redis'),
    url: z.string().min(1),
    keyPrefix: z.string().default('payguard:'),
  }),
]);

export const AuditConfigSchema = z.object({
  /** Emit every decision to this webhook, per FR-5.3. */
  webhookUrl: z.string().url().optional(),
  /** Where `payguard audit --export` writes JSONL and CSV. */
  exportDir: z.string().min(1).default('./payguard-audit'),
});

export const KillSwitchConfigSchema = z.object({
  /** Presence of this file halts every payment, per FR-3.3. */
  file: z.string().min(1).default('.payguard-halt'),
  /** Setting this environment variable to "1" or "true" halts every payment. */
  envVar: z.string().min(1).default('PAYGUARD_HALT'),
  /** How often the file is polled, in milliseconds. AT-7 requires a halt within one second. */
  pollIntervalMs: z.number().int().positive().max(1000).default(250),
});

export const PayGuardConfigSchema = z.object({
  mode: VerificationModeSchema.default('strict'),
  rails: z.array(RailConfigSchema).nonempty(),
  facilitators: z.array(FacilitatorConfigSchema).nonempty(),
  store: StoreConfigSchema.default({ kind: 'memory' }),
  policy: PolicyConfigSchema.prefault({}),
  audit: AuditConfigSchema.prefault({}),
  killSwitch: KillSwitchConfigSchema.prefault({}),
  clockSkewToleranceMs: z.number().int().nonnegative().default(DEFAULT_CLOCK_SKEW_TOLERANCE_MS),
  maxValidityWindowMs: z.number().int().positive().default(DEFAULT_MAX_VALIDITY_WINDOW_MS),
  /** Ceiling on the base64 X-PAYMENT header, in bytes. */
  maxPaymentHeaderBytes: z.number().int().positive().default(8192),
  /** Ceiling on a proxied request body, in bytes. */
  maxRequestBodyBytes: z.number().int().positive().default(1_048_576),
});

export type RailConfig = z.infer<typeof RailConfigSchema>;
export type FacilitatorConfig = z.infer<typeof FacilitatorConfigSchema>;
export type StoreConfig = z.infer<typeof StoreConfigSchema>;
export type AuditConfig = z.infer<typeof AuditConfigSchema>;
export type KillSwitchConfig = z.infer<typeof KillSwitchConfigSchema>;
export type PayGuardConfig = z.infer<typeof PayGuardConfigSchema>;
export type PayGuardConfigInput = z.input<typeof PayGuardConfigSchema>;

export function defineConfig(config: PayGuardConfigInput): PayGuardConfig {
  return PayGuardConfigSchema.parse(config);
}
