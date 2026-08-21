import { z } from 'zod';

export const RailIdSchema = z.enum(['base:usdc', 'xrpl:rlusd', 'xrpl:xrp']);
export type RailId = z.infer<typeof RailIdSchema>;

export const PaymentRequirementsSchema = z.object({
  amount: z.string(),
  asset: z.string(),
  recipient: z.string(),
  network: z.string(),
  nonce: z.string(),
  expiry: z.number(),
  accepts: z.array(z.object({
    rail: RailIdSchema,
    facilitators: z.array(z.string()),
  })),
});

export type PaymentRequirements = z.infer<typeof PaymentRequirementsSchema>;

export const PaymentPayloadSchema = z.object({
  requirementHash: z.string(),
  rail: RailIdSchema,
  facilitator: z.string(),
  proof: z.record(z.any()),
  timestamp: z.number(),
});

export type PaymentPayload = z.infer<typeof PaymentPayloadSchema>;

export interface VerifyResult {
  valid: boolean;
  reason?: string;
  txHash?: string;
}

export interface SettleResult {
  success: boolean;
  txHash?: string;
  error?: string;
}

export interface Health {
  status: 'healthy' | 'degraded' | 'down';
  latencyMs?: number;
  errorRate?: number;
}

export const SpendContextSchema = z.object({
  amount: z.string(),
  counterparty: z.string(),
  rail: RailIdSchema,
  velocity: z.number(), // tx per minute
  caps: z.object({
    daily: z.string(),
    hourly: z.string(),
  }),
});

export type SpendContext = z.infer<typeof SpendContextSchema>;

export type Decision = 
  | { type: 'allow' }
  | { type: 'deny', reason: string }
  | { type: 'require_human', reason: string };

export interface AuditEntry {
  id: string;
  prevHash: string;
  hash: string;
  timestamp: number;
  agentId: string;
  counterparty: string;
  rail: RailId;
  amount: string;
  facilitator: string;
  decision: Decision;
  proof?: string;
}
