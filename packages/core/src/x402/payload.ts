import { z } from 'zod';
import { NetworkSchema } from './network.js';
import { AtomicAmountSchema } from './requirements.js';
import { X402_SCHEMES, X402_VERSION } from './version.js';

/** EIP-3009 TransferWithAuthorization fields, as carried by the x402 `exact` EVM payload. */
export const ExactEvmAuthorizationSchema = z.object({
  from: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  to: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  value: AtomicAmountSchema,
  validAfter: z.string().regex(/^[0-9]+$/),
  validBefore: z.string().regex(/^[0-9]+$/),
  nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});

export const ExactEvmPayloadSchema = z.object({
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
  authorization: ExactEvmAuthorizationSchema,
});

/** Solana and XRPL both carry an opaque signed transaction blob under `transaction`. */
export const ExactTransactionPayloadSchema = z.object({
  transaction: z.string().min(1),
});

export const ExactPayloadSchema = z.union([ExactEvmPayloadSchema, ExactTransactionPayloadSchema]);

export const PaymentPayloadSchema = z.object({
  x402Version: z.literal(X402_VERSION),
  scheme: z.enum(X402_SCHEMES),
  network: NetworkSchema,
  payload: ExactPayloadSchema,
});

export type ExactEvmAuthorization = z.infer<typeof ExactEvmAuthorizationSchema>;
export type ExactEvmPayload = z.infer<typeof ExactEvmPayloadSchema>;
export type ExactTransactionPayload = z.infer<typeof ExactTransactionPayloadSchema>;
export type PaymentPayload = z.infer<typeof PaymentPayloadSchema>;

export function isExactEvmPayload(payload: PaymentPayload['payload']): payload is ExactEvmPayload {
  return 'authorization' in payload;
}

export function isExactTransactionPayload(
  payload: PaymentPayload['payload'],
): payload is ExactTransactionPayload {
  return 'transaction' in payload;
}
