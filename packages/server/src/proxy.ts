import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { PAYMENT_HEADER } from '@payguard/core';
import { PayGuardServer, type PayGuardServerOptions } from './handler.js';

export interface ProxyOptions extends PayGuardServerOptions {
  /** Where confirmed requests are forwarded, for example http://localhost:3000 */
  upstream: string;
  /** Ceiling on a proxied request body. An unbounded body is a denial of service. */
  maxRequestBodyBytes?: number;
  /** Timeout for the upstream request. */
  upstreamTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Reverse proxy mode, for protecting a service you cannot or would rather not modify.
 *
 * The upstream is only ever contacted after settlement is confirmed. That ordering is the point:
 * a proxy that forwards first and charges afterwards is the free-shopping vulnerability with
 * extra steps.
 */
export function createProxy(options: ProxyOptions): Server {
  const guard = new PayGuardServer(options);
  const upstream = new URL(options.upstream);
  const maxBody = options.maxRequestBodyBytes ?? 1_048_576;
  const fetchImpl = options.fetchImpl ?? fetch;

  return createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      respond(
        response,
        502,
        { 'content-type': 'application/json' },
        {
          error: 'proxy_failure',
          message: error instanceof Error ? error.message : String(error),
        },
      );
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const host = request.headers.host ?? upstream.host;
    const url = `http://${host}${request.url ?? '/'}`;

    const outcome = await guard.guard({
      method: request.method ?? 'GET',
      url,
      header: (name) => {
        const value = request.headers[name.toLowerCase()];
        return Array.isArray(value) ? value[0] : value;
      },
    });

    if (outcome.kind === 'payment_required') {
      respond(response, outcome.status, outcome.headers, outcome.body);
      return;
    }

    if (outcome.kind === 'replay_response') {
      response.writeHead(outcome.status, outcome.headers);
      response.end(Buffer.from(outcome.bodyBase64, 'base64'));
      return;
    }

    const body = await readBody(request, maxBody);
    const target = new URL(request.url ?? '/', upstream);

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      if (value === undefined) continue;
      const lower = key.toLowerCase();
      // The payment header is PayGuard's business, not the upstream's, and hop-by-hop headers
      // must not be forwarded.
      if (lower === PAYMENT_HEADER || lower === 'host' || lower === 'connection') continue;
      headers[lower] = Array.isArray(value) ? value.join(', ') : String(value);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.upstreamTimeoutMs ?? 30_000);
    try {
      const upstreamResponse = await fetchImpl(target.toString(), {
        method: request.method ?? 'GET',
        headers,
        ...(body.length === 0 ? {} : { body }),
        signal: controller.signal,
      });

      const responseBody = Buffer.from(await upstreamResponse.arrayBuffer());
      const responseHeaders: Record<string, string> = { ...outcome.headers };
      upstreamResponse.headers.forEach((value, key) => {
        if (key.toLowerCase() === 'content-encoding') return;
        responseHeaders[key] = value;
      });
      delete responseHeaders['content-length'];

      await outcome.capture(upstreamResponse.status, responseHeaders, responseBody);
      response.writeHead(upstreamResponse.status, responseHeaders);
      response.end(responseBody);
    } finally {
      clearTimeout(timer);
    }
  }
}

function respond(
  response: ServerResponse,
  status: number,
  headers: Record<string, string>,
  body: unknown,
): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  response.writeHead(status, { ...headers, 'content-length': String(payload.length) });
  response.end(payload);
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) {
      throw new Error(`request body exceeds ${limit} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
