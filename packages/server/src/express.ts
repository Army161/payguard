import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { PayGuardServer, type PayGuardServerOptions } from './handler.js';
import type { GuardOutcome } from './types.js';

/** Attached to the request once payment is confirmed, so the route can log or bill against it. */
export interface PayGuardRequestContext {
  paymentId: string;
  transactionHash: string;
  facilitatorId: string;
  rail: string;
}

/**
 * Express's own Request type is not augmented here. A `declare module` on
 * `express-serve-static-core` would leak into every consumer's type graph whether or not they use
 * PayGuard, and would fail to resolve for anyone who has Express only as a transitive dependency.
 * Callers read the context through `payguardContext(request)` instead.
 */
type RequestWithContext = Request & { payguard?: PayGuardRequestContext };

/** Reads the payment context PayGuard attached, or undefined on an unprotected route. */
export function payguardContext(request: Request): PayGuardRequestContext | undefined {
  return (request as RequestWithContext).payguard;
}

/**
 * Express middleware.
 *
 * The response is buffered rather than streamed, because the resource has to be captured for the
 * idempotency store before the buyer sees it. FR-2.2 requires a retry to replay the same bytes,
 * and bytes already flushed to the socket cannot be replayed.
 */
export function payguardExpress(options: PayGuardServerOptions): RequestHandler {
  const server = new PayGuardServer(options);

  return function payguard(request: Request, response: Response, next: NextFunction): void {
    const url = absoluteUrl(request);

    server
      .guard({
        method: request.method,
        url,
        header: (name) => {
          const value = request.headers[name.toLowerCase()];
          return Array.isArray(value) ? value[0] : value;
        },
      })
      .then((outcome) => {
        if (outcome.kind === 'payment_required') {
          response.status(outcome.status).set(outcome.headers).json(outcome.body);
          return;
        }

        if (outcome.kind === 'replay_response') {
          response
            .status(outcome.status)
            .set(outcome.headers)
            .send(Buffer.from(outcome.bodyBase64, 'base64'));
          return;
        }

        attachCapture(response, outcome);
        (request as RequestWithContext).payguard = {
          paymentId: outcome.paymentId,
          transactionHash: outcome.transactionHash,
          facilitatorId: outcome.facilitatorId,
          rail: outcome.rail,
        };
        response.set(outcome.headers);
        next();
      })
      .catch(next);
  };
}

/**
 * Buffers whatever the downstream route writes, so the delivered bytes can be stored against the
 * idempotency key before they leave the process.
 */
function attachCapture(
  response: Response,
  outcome: Extract<GuardOutcome, { kind: 'settled' }>,
): void {
  if (outcome.idempotencyKey === null) return;

  const chunks: Buffer[] = [];
  const originalWrite = response.write.bind(response);
  const originalEnd = response.end.bind(response);

  response.write = function write(chunk: unknown, ...rest: unknown[]): boolean {
    if (chunk !== undefined && chunk !== null) chunks.push(toBuffer(chunk));
    return (originalWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
  } as Response['write'];

  response.end = function end(chunk?: unknown, ...rest: unknown[]): Response {
    if (typeof chunk !== 'function' && chunk !== undefined && chunk !== null) {
      chunks.push(toBuffer(chunk));
    }
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(response.getHeaders())) {
      if (value !== undefined) headers[key] = String(value);
    }
    void outcome.capture(response.statusCode, headers, Buffer.concat(chunks));
    return (originalEnd as (...args: unknown[]) => Response)(chunk, ...rest);
  } as Response['end'];
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk, 'utf8');
  return Buffer.from(String(chunk), 'utf8');
}

function absoluteUrl(request: Request): string {
  const host = request.headers.host ?? 'localhost';
  const proto = (request.headers['x-forwarded-proto'] as string | undefined) ?? request.protocol;
  return `${proto}://${host}${request.originalUrl}`;
}

export { PayGuardServer };
