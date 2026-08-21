import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { Hono } from 'hono';
import Fastify from 'fastify';
import { IDEMPOTENCY_HEADER, PAYMENT_HEADER, type X402Response } from '@payguard/core';
import { MemoryStore } from '@payguard/store';
import { createProxy, type ProtectedRail } from '@payguard/server';
import { payguardExpress, payguardContext } from '../src/express.js';
import { payguardHono } from '../src/hono.js';
import { payguardFastify } from '../src/fastify.js';
import { StubFacilitator, StubRail, paymentHeader, requirementsTemplate } from './harness.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

function listen(server: Server): Promise<string> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('no port');
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function guardOptions(store = new MemoryStore()) {
  const rail: ProtectedRail = {
    id: 'base:usdc',
    rail: new StubRail(),
    requirements: requirementsTemplate(),
    minConfirmations: 1,
  };
  return {
    rails: [rail],
    facilitators: [new StubFacilitator()],
    store,
    confirmationTimeoutMs: 200,
    confirmationPollIntervalMs: 10,
  };
}

/**
 * Each adapter is driven over a real socket rather than with a mocked framework, because the
 * failure these tests exist to catch is an adapter that gets the response lifecycle wrong, and a
 * mock would let that pass.
 */

describe('express adapter', () => {
  async function app() {
    const store = new MemoryStore();
    const server = express();
    server.use(payguardExpress(guardOptions(store)));
    server.get('/api/report', (request, response) => {
      response.json({ report: 'generated', paymentId: payguardContext(request)?.paymentId });
    });
    return { base: await listen(createServer(server)), store };
  }

  it('answers 402 with an accepts list when unpaid', async () => {
    const { base } = await app();
    const response = await fetch(`${base}/api/report`);
    expect(response.status).toBe(402);
    const body = (await response.json()) as X402Response;
    expect(body.accepts[0]?.resource).toContain('/api/report');
  });

  it('serves the route and exposes the payment context once paid', async () => {
    const { base } = await app();
    const response = await fetch(`${base}/api/report`, {
      headers: { [PAYMENT_HEADER]: paymentHeader() },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-payment-response')).toBeTruthy();
    const body = (await response.json()) as { report: string; paymentId: string };
    expect(body.report).toBe('generated');
    expect(body.paymentId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('replays the identical response for a repeated idempotency key', async () => {
    const { base } = await app();
    const headers = { [PAYMENT_HEADER]: paymentHeader(), [IDEMPOTENCY_HEADER]: 'idem-express' };
    const first = await fetch(`${base}/api/report`, { headers });
    const firstBody = await first.text();
    const second = await fetch(`${base}/api/report`, { headers });
    expect(second.status).toBe(200);
    expect(await second.text()).toBe(firstBody);
  });

  it('refuses a replayed payload that carries no idempotency key', async () => {
    const { base } = await app();
    const headers = { [PAYMENT_HEADER]: paymentHeader() };
    await fetch(`${base}/api/report`, { headers });
    const second = await fetch(`${base}/api/report`, { headers });
    expect(second.status).toBe(402);
  });
});

describe('hono adapter', () => {
  async function app() {
    const store = new MemoryStore();
    const hono = new Hono();
    hono.use('*', payguardHono(guardOptions(store)));
    hono.get('/api/report', (context) => context.json({ report: 'generated' }));

    const server = createServer((request, response) => {
      const url = `http://${request.headers.host ?? 'localhost'}${request.url ?? '/'}`;
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (typeof value === 'string') headers.set(key, value);
      }
      void hono
        .fetch(new Request(url, { method: request.method, headers }))
        .then(async (result) => {
          const body = Buffer.from(await result.arrayBuffer());
          const out: Record<string, string> = {};
          result.headers.forEach((value, key) => {
            out[key] = value;
          });
          response.writeHead(result.status, out);
          response.end(body);
        });
    });
    return { base: await listen(server), store };
  }

  it('answers 402 when unpaid', async () => {
    const { base } = await app();
    expect((await fetch(`${base}/api/report`)).status).toBe(402);
  });

  it('serves the route once paid and attaches the settlement header', async () => {
    const { base } = await app();
    const response = await fetch(`${base}/api/report`, {
      headers: { [PAYMENT_HEADER]: paymentHeader() },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-payment-response')).toBeTruthy();
    expect(await response.json()).toEqual({ report: 'generated' });
  });

  it('replays the identical response for a repeated idempotency key', async () => {
    const { base } = await app();
    const headers = { [PAYMENT_HEADER]: paymentHeader(), [IDEMPOTENCY_HEADER]: 'idem-hono' };
    const first = await fetch(`${base}/api/report`, { headers });
    const firstBody = await first.text();
    const second = await fetch(`${base}/api/report`, { headers });
    expect(await second.text()).toBe(firstBody);
  });
});

describe('fastify adapter', () => {
  async function app() {
    const store = new MemoryStore();
    const fastify = Fastify();
    await fastify.register(payguardFastify(guardOptions(store)));
    fastify.get('/api/report', async (request) => ({
      report: 'generated',
      paymentId: request.payguard?.paymentId,
    }));
    await fastify.ready();
    return { base: await listen(fastify.server), store, fastify };
  }

  it('answers 402 when unpaid', async () => {
    const { base } = await app();
    expect((await fetch(`${base}/api/report`)).status).toBe(402);
  });

  it('serves the route once paid and exposes the payment context', async () => {
    const { base } = await app();
    const response = await fetch(`${base}/api/report`, {
      headers: { [PAYMENT_HEADER]: paymentHeader() },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { paymentId: string };
    expect(body.paymentId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('replays the identical response for a repeated idempotency key', async () => {
    const { base } = await app();
    const headers = { [PAYMENT_HEADER]: paymentHeader(), [IDEMPOTENCY_HEADER]: 'idem-fastify' };
    const first = await fetch(`${base}/api/report`, { headers });
    const firstBody = await first.text();
    const second = await fetch(`${base}/api/report`, { headers });
    expect(await second.text()).toBe(firstBody);
  });
});

describe('reverse proxy mode', () => {
  async function upstreamAndProxy() {
    let upstreamHits = 0;
    const upstream = createServer((request, response) => {
      upstreamHits += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ report: 'from upstream', path: request.url }));
    });
    const upstreamBase = await listen(upstream);
    const proxy = createProxy({ ...guardOptions(), upstream: upstreamBase });
    const proxyBase = await listen(proxy);
    return { proxyBase, hits: () => upstreamHits };
  }

  it('never reaches the upstream for an unpaid request', async () => {
    const { proxyBase, hits } = await upstreamAndProxy();
    const response = await fetch(`${proxyBase}/api/report`);
    expect(response.status).toBe(402);
    expect(hits()).toBe(0);
  });

  it('forwards to the upstream once settlement is confirmed', async () => {
    const { proxyBase, hits } = await upstreamAndProxy();
    const response = await fetch(`${proxyBase}/api/report`, {
      headers: { [PAYMENT_HEADER]: paymentHeader() },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ report: 'from upstream', path: '/api/report' });
    expect(hits()).toBe(1);
  });

  it('does not forward the payment header to the upstream', async () => {
    let seen: string | undefined;
    const upstream = createServer((request, response) => {
      seen = request.headers[PAYMENT_HEADER] as string | undefined;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
    const upstreamBase = await listen(upstream);
    const proxy = createProxy({ ...guardOptions(), upstream: upstreamBase });
    const proxyBase = await listen(proxy);
    await fetch(`${proxyBase}/api/report`, { headers: { [PAYMENT_HEADER]: paymentHeader() } });
    expect(seen).toBeUndefined();
  });

  it('replays the upstream response for a repeated idempotency key without re-forwarding', async () => {
    const { proxyBase, hits } = await upstreamAndProxy();
    const headers = { [PAYMENT_HEADER]: paymentHeader(), [IDEMPOTENCY_HEADER]: 'idem-proxy' };
    const first = await fetch(`${proxyBase}/api/report`, { headers });
    const firstBody = await first.text();
    const second = await fetch(`${proxyBase}/api/report`, { headers });
    expect(await second.text()).toBe(firstBody);
    expect(hits()).toBe(1);
  });
});
