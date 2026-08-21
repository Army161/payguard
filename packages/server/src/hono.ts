import type { Context, MiddlewareHandler } from 'hono';
import { PayGuardServer, type PayGuardServerOptions } from './handler.js';

/**
 * Hono middleware. Hono hands back a Response object, so the delivered bytes are readable without
 * monkey patching the way Express requires.
 */
export function payguardHono(options: PayGuardServerOptions): MiddlewareHandler {
  const server = new PayGuardServer(options);

  return async function payguard(context: Context, next: () => Promise<void>) {
    const outcome = await server.guard({
      method: context.req.method,
      url: context.req.url,
      header: (name) => context.req.header(name),
    });

    if (outcome.kind === 'payment_required') {
      return context.json(outcome.body as Record<string, unknown>, 402, outcome.headers);
    }

    if (outcome.kind === 'replay_response') {
      return new Response(Buffer.from(outcome.bodyBase64, 'base64'), {
        status: outcome.status,
        headers: outcome.headers,
      });
    }

    context.set('payguard', {
      paymentId: outcome.paymentId,
      transactionHash: outcome.transactionHash,
      facilitatorId: outcome.facilitatorId,
      rail: outcome.rail,
    });

    await next();

    for (const [key, value] of Object.entries(outcome.headers)) {
      context.res.headers.set(key, value);
    }

    if (outcome.idempotencyKey !== null) {
      // Read the body without consuming the one the client receives.
      const cloned = context.res.clone();
      const body = Buffer.from(await cloned.arrayBuffer());
      const headers: Record<string, string> = {};
      context.res.headers.forEach((value, key) => {
        headers[key] = value;
      });
      await outcome.capture(context.res.status, headers, body);
    }
    return undefined;
  };
}
