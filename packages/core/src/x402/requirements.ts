import { z } from 'zod';
import { NetworkSchema } from './network.js';
import { X402_SCHEMES } from './version.js';

/** A non-negative integer written as a decimal string, in the asset's smallest unit. */
export const AtomicAmountSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,77})$/, 'must be a non-negative integer in atomic units');

/**
 * One entry of the seller's `accepts` array: a single rail and price the seller will take.
 * Field names and types match x402 v1 exactly.
 */
export const PaymentRequirementsSchema = z.object({
  scheme: z.enum(X402_SCHEMES),
  network: NetworkSchema,
  maxAmountRequired: AtomicAmountSchema,
  resource: z.string().min(1),
  description: z.string(),
  mimeType: z.string(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  payTo: z.string().min(1),
  maxTimeoutSeconds: z.number().int().positive().max(86_400),
  asset: z.string().min(1),
  extra: z.record(z.string(), z.unknown()).optional(),
});

export type PaymentRequirements = z.infer<typeof PaymentRequirementsSchema>;
