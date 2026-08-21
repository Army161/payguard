import { z } from 'zod';
import { PaymentPayloadSchema, type PaymentPayload } from './payload.js';
import { SettleResponseSchema, type SettleResponse } from './response.js';

/** The request header a buyer sends its signed payment payload in. */
export const PAYMENT_HEADER = 'x-payment';

/** The response header a seller returns the settlement result in. */
export const PAYMENT_RESPONSE_HEADER = 'x-payment-response';

/** The buyer-supplied key that makes a paid request safe to retry. */
export const IDEMPOTENCY_HEADER = 'idempotency-key';

/**
 * Hard ceiling on a base64 payment header, in bytes. An unbounded header is a cheap denial of
 * service against JSON.parse and against zod, so the limit is enforced before either runs.
 */
export const MAX_PAYMENT_HEADER_BYTES = 8 * 1024;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export class HeaderDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeaderDecodeError';
  }
}

function decodeBase64Json(header: string, limitBytes: number): unknown {
  if (header.length === 0) {
    throw new HeaderDecodeError('header is empty');
  }
  if (Buffer.byteLength(header, 'utf8') > limitBytes) {
    throw new HeaderDecodeError(`header exceeds ${limitBytes} bytes`);
  }
  // Buffer.from is lenient: it silently drops anything outside the base64 alphabet, so a header
  // full of junk decodes to junk instead of failing. Check the alphabet ourselves first.
  if (!BASE64.test(header)) {
    throw new HeaderDecodeError('header is not valid base64');
  }
  const json = Buffer.from(header, 'base64').toString('utf8');
  try {
    return JSON.parse(json) as unknown;
  } catch {
    throw new HeaderDecodeError('header does not contain valid JSON');
  }
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new HeaderDecodeError(
      `header failed schema validation: ${parsed.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

export function encodePaymentHeader(payload: PaymentPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

export function decodePaymentHeader(
  header: string,
  limitBytes: number = MAX_PAYMENT_HEADER_BYTES,
): PaymentPayload {
  return parseOrThrow(PaymentPayloadSchema, decodeBase64Json(header, limitBytes));
}

export function encodeSettleResponseHeader(response: SettleResponse): string {
  return Buffer.from(JSON.stringify(response), 'utf8').toString('base64');
}

export function decodeSettleResponseHeader(
  header: string,
  limitBytes: number = MAX_PAYMENT_HEADER_BYTES,
): SettleResponse {
  return parseOrThrow(SettleResponseSchema, decodeBase64Json(header, limitBytes));
}
