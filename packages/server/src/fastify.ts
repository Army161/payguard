import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { PayGuardServer, type PayGuardServerOptions } from './handler.js';
import type { GuardOutcome } from './types.js';

declare module 'fastify' {
  interface FastifyRequest {
    payguard?: {
      paymentId: string;
      transactionHash: string;
      facilitatorId: string;
      rail: string;
    };
  }
}

const SETTLED = Symbol('payguard.settled');

/**
 * Fastify creates a new encapsulation context for every registered plugin, and hooks added inside
 * one only apply to routes registered inside that same context. A guard that silently does not
 * cover the routes you registered on the parent instance is the worst possible failure mode for
 * this package, so the plugin opts out of encapsulation.
 *
 * `skip-override` is the same mechanism the fastify-plugin package uses. Setting it directly keeps
 * PayGuard's dependency footprint at zero, which plan.md requires.
 */
const SKIP_OVERRIDE = Symbol.for('skip-override');

/**
 * Fastify plugin. Runs the lifecycle in onRequest and captures the delivered payload in
 * onSend, which is Fastify's own hook for seeing the serialized body.
 */
export function payguardFastify(options: PayGuardServerOptions): FastifyPluginAsync {
  const server = new PayGuardServer(options);

  const plugin = async function plugin(fastify: FastifyInstance) {
    fastify.decorateRequest('payguard', undefined);

    fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
      const url = absoluteUrl(request);
      const outcome = await server.guard({
        method: request.method,
        url,
        header: (name) => {
          const value = request.headers[name.toLowerCase()];
          return Array.isArray(value) ? value[0] : value;
        },
      });

      if (outcome.kind === 'payment_required') {
        // Returning the reply is how an async Fastify hook says the response is handled. The send
        // is deliberately not awaited: awaiting a Fastify reply waits for the response to finish
        // flushing, which deadlocks against the hook that is supposed to be returning it.
        void reply.status(outcome.status).headers(outcome.headers).send(outcome.body);
        return reply;
      }

      if (outcome.kind === 'replay_response') {
        void reply
          .status(outcome.status)
          .headers(outcome.headers)
          .send(Buffer.from(outcome.bodyBase64, 'base64'));
        return reply;
      }

      request.payguard = {
        paymentId: outcome.paymentId,
        transactionHash: outcome.transactionHash,
        facilitatorId: outcome.facilitatorId,
        rail: outcome.rail,
      };
      void reply.headers(outcome.headers);
      (request as FastifyRequest & { [SETTLED]?: GuardOutcome })[SETTLED] = outcome;
      return undefined;
    });

    fastify.addHook('onSend', async (request, reply, payload) => {
      const outcome = (request as FastifyRequest & { [SETTLED]?: GuardOutcome })[SETTLED];
      if (outcome === undefined || outcome.kind !== 'settled' || outcome.idempotencyKey === null) {
        return payload;
      }
      const body =
        typeof payload === 'string'
          ? Buffer.from(payload, 'utf8')
          : Buffer.isBuffer(payload)
            ? payload
            : Buffer.from(JSON.stringify(payload ?? null), 'utf8');
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(reply.getHeaders())) {
        if (value !== undefined) headers[key] = String(value);
      }
      await outcome.capture(reply.statusCode, headers, body);
      return payload;
    });
  };

  (plugin as FastifyPluginAsync & { [SKIP_OVERRIDE]?: boolean })[SKIP_OVERRIDE] = true;
  return plugin;
}

function absoluteUrl(request: FastifyRequest): string {
  const host = request.headers.host ?? 'localhost';
  const proto = (request.headers['x-forwarded-proto'] as string | undefined) ?? request.protocol;
  return `${proto}://${host}${request.url}`;
}
