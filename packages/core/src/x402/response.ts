import { z } from 'zod';
import { NetworkSchema } from './network.js';
import { PaymentRequirementsSchema } from './requirements.js';
import { X402_VERSION } from './version.js';

/**
 * Facilitator error reasons defined by x402 v1, plus the PayGuard extensions needed for XRPL and
 * for the guardrails x402 itself does not model. Unknown strings are preserved rather than
 * rejected, because a facilitator that invents a reason should not crash the seller.
 */
export const FacilitatorErrorReasonSchema = z.string().min(1);

export const VerifyResponseSchema = z.object({
  isValid: z.boolean(),
  invalidReason: FacilitatorErrorReasonSchema.optional(),
  payer: z.string().optional(),
});

export const SettleResponseSchema = z.object({
  success: z.boolean(),
  errorReason: FacilitatorErrorReasonSchema.optional(),
  payer: z.string().optional(),
  transaction: z.string(),
  network: NetworkSchema,
});

/** The body of a 402 response: what the seller will accept, and why this request was refused. */
export const X402ResponseSchema = z.object({
  x402Version: z.literal(X402_VERSION),
  accepts: z.array(PaymentRequirementsSchema),
  error: z.string(),
});

export type VerifyResponse = z.infer<typeof VerifyResponseSchema>;
export type SettleResponse = z.infer<typeof SettleResponseSchema>;
export type X402Response = z.infer<typeof X402ResponseSchema>;
