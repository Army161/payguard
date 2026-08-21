import { z } from 'zod';

/**
 * strict: the facilitator settles and an independent RPC confirms the transaction on chain before
 * the resource is released. This is the default and the only mode plan.md considers safe.
 *
 * fast: the facilitator's word is accepted without independent confirmation. Lower assurance, and
 * every decision made in this mode is recorded as such in the audit log.
 */
export const VerificationModeSchema = z.enum(['strict', 'fast']);
export type VerificationMode = z.infer<typeof VerificationModeSchema>;
