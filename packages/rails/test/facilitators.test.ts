import { describe, expect, it, vi } from 'vitest';
import {
  CoinbaseFacilitator,
  FacilitatorError,
  HttpFacilitator,
  T54Facilitator,
  VERIFIABLE_INTENT_HEADER,
  assertSafeFacilitatorUrl,
  statusToKind,
  stripeFacilitator,
  xpayFacilitator,
} from '@payguard/rails';
import type { PaymentPayload, PaymentRequirements } from '@payguard/core';

const requirements: PaymentRequirements = {
  scheme: 'exact',
  network: 'base-sepolia',
  maxAmountRequired: '10000',
  resource: 'https://seller.example/api/report',
  description: 'report',
  mimeType: 'application/json',
  payTo: '0x1111111111111111111111111111111111111111',
  maxTimeoutSeconds: 60,
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
};

const payload: PaymentPayload = {
  x402Version: 1,
  scheme: 'exact',
  network: 'base-sepolia',
  payload: {
    signature: `0x${'ab'.repeat(65)}`,
    authorization: {
      from: '0x2222222222222222222222222222222222222222',
      to: '0x1111111111111111111111111111111111111111',
      value: '10000',
      validAfter: '1000',
      validBefore: '2000',
      nonce: `0x${'cd'.repeat(32)}`,
    },
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function facilitator(fetchImpl: typeof fetch): HttpFacilitator {
  return new HttpFacilitator({
    id: 'test',
    url: 'https://facilitator.example',
    rails: ['base:usdc'],
    fetchImpl,
  });
}

describe('facilitator url safety', () => {
  it('accepts https', () => {
    expect(assertSafeFacilitatorUrl('https://x402.org/facilitator').protocol).toBe('https:');
  });

  it('accepts http only on a loopback host, for local development', () => {
    expect(assertSafeFacilitatorUrl('http://localhost:3001').hostname).toBe('localhost');
    expect(assertSafeFacilitatorUrl('http://127.0.0.1:3001').hostname).toBe('127.0.0.1');
  });

  it('refuses plain http to a remote host, which would leak the payload in transit', () => {
    expect(() => assertSafeFacilitatorUrl('http://facilitator.example')).toThrow(/must use https/);
  });

  it('refuses a url with embedded credentials', () => {
    expect(() => assertSafeFacilitatorUrl('https://user:pass@facilitator.example')).toThrow(
      /must not embed credentials/,
    );
  });

  it('refuses something that is not a url at all', () => {
    expect(() => assertSafeFacilitatorUrl('facilitator.example')).toThrow(/is not a url/);
  });

  it('refuses a non http scheme, which is the SSRF case in the threat model', () => {
    expect(() => assertSafeFacilitatorUrl('file:///etc/passwd')).toThrow(/must use https/);
  });
});

describe('http facilitator', () => {
  it('posts the x402 verify body and returns the parsed response', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ isValid: true, payer: '0xabc' }));
    const result = await facilitator(fetchImpl as unknown as typeof fetch).verify(
      payload,
      requirements,
    );
    expect(result).toEqual({ isValid: true, payer: '0xabc' });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://facilitator.example/verify');
    expect(JSON.parse(init.body as string)).toEqual({
      x402Version: 1,
      paymentPayload: payload,
      paymentRequirements: requirements,
    });
  });

  it('posts the x402 settle body and returns the parsed response', async () => {
    const settle = {
      success: true,
      transaction: `0x${'11'.repeat(32)}`,
      network: 'base-sepolia',
    };
    const fetchImpl = vi.fn(async () => jsonResponse(settle));
    const result = await facilitator(fetchImpl as unknown as typeof fetch).settle(
      payload,
      requirements,
    );
    expect(result).toEqual(settle);
    expect((fetchImpl.mock.calls[0] as [string, RequestInit])[0]).toBe(
      'https://facilitator.example/settle',
    );
  });

  it('strips a trailing slash from the base url rather than doubling it', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ isValid: true }));
    const f = new HttpFacilitator({
      id: 'test',
      url: 'https://facilitator.example/',
      rails: ['base:usdc'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await f.verify(payload, requirements);
    expect((fetchImpl.mock.calls[0] as [string, RequestInit])[0]).toBe(
      'https://facilitator.example/verify',
    );
  });

  it('normalizes an http status into a typed error kind', async () => {
    const cases: [number, string, boolean][] = [
      [400, 'bad_request', false],
      [401, 'unauthorized', false],
      [403, 'unauthorized', false],
      [429, 'rate_limited', true],
      [500, 'server_error', true],
      [503, 'server_error', true],
    ];
    for (const [status, kind, retryable] of cases) {
      const fetchImpl = vi.fn(async () => jsonResponse({}, status));
      const error = await facilitator(fetchImpl as unknown as typeof fetch)
        .verify(payload, requirements)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(FacilitatorError);
      expect((error as FacilitatorError).kind).toBe(kind);
      expect((error as FacilitatorError).status).toBe(status);
      expect((error as FacilitatorError).isRetryableElsewhere).toBe(retryable);
    }
  });

  it('maps a 408 to a timeout', () => {
    expect(statusToKind(408)).toBe('timeout');
  });

  it('reports a body that is not JSON as a malformed response', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>oops</html>', { status: 200 }));
    await expect(
      facilitator(fetchImpl as unknown as typeof fetch).verify(payload, requirements),
    ).rejects.toMatchObject({ kind: 'malformed_response' });
  });

  it('reports a verify body that is not an x402 verify response', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ looksFine: true }));
    await expect(
      facilitator(fetchImpl as unknown as typeof fetch).verify(payload, requirements),
    ).rejects.toThrow(/does not match the x402 schema/);
  });

  it('reports a settle body that is not an x402 settle response', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ success: true }));
    await expect(
      facilitator(fetchImpl as unknown as typeof fetch).settle(payload, requirements),
    ).rejects.toThrow(/does not match the x402 schema/);
  });

  it('reports an unreachable facilitator as a network failure that can be retried elsewhere', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const error = await facilitator(fetchImpl as unknown as typeof fetch)
      .verify(payload, requirements)
      .catch((e: unknown) => e as FacilitatorError);
    expect(error.kind).toBe('network');
    expect(error.isRetryableElsewhere).toBe(true);
  });

  it('gives up on a facilitator that does not answer within the timeout', async () => {
    const fetchImpl = vi.fn(
      async (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    );
    const slow = new HttpFacilitator({
      id: 'slow',
      url: 'https://facilitator.example',
      rails: ['base:usdc'],
      timeoutMs: 20,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const error = await slow
      .verify(payload, requirements)
      .catch((e: unknown) => e as FacilitatorError);
    expect(error.kind).toBe('timeout');
    expect(error.message).toMatch(/did not respond within 20 ms/);
  });

  it('reports healthy when /supported answers', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ kinds: [] }));
    const health = await facilitator(fetchImpl as unknown as typeof fetch).health();
    expect(health.healthy).toBe(true);
    expect(health.consecutiveFailures).toBe(0);
    expect(health.lastSuccessMs).not.toBeNull();
    expect((fetchImpl.mock.calls[0] as [string, RequestInit])[0]).toBe(
      'https://facilitator.example/supported',
    );
  });

  it('reports unhealthy on a bad status from /supported, and counts the failure', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 503));
    const f = facilitator(fetchImpl as unknown as typeof fetch);
    expect((await f.health()).healthy).toBe(false);
    expect((await f.health()).consecutiveFailures).toBe(2);
  });

  it('reports unhealthy when /supported cannot be reached', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ENOTFOUND');
    });
    const health = await facilitator(fetchImpl as unknown as typeof fetch).health();
    expect(health.healthy).toBe(false);
    expect(health.message).toMatch(/ENOTFOUND/);
    expect(health.lastSuccessMs).toBeNull();
  });

  it('records the latency of the most recent call', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ isValid: true }));
    const f = facilitator(fetchImpl as unknown as typeof fetch);
    await f.verify(payload, requirements);
    expect(f.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('clears the failure count once a call succeeds', async () => {
    let fail = true;
    const fetchImpl = vi.fn(async () =>
      fail ? jsonResponse({}, 500) : jsonResponse({ isValid: true }),
    );
    const f = facilitator(fetchImpl as unknown as typeof fetch);
    await f.verify(payload, requirements).catch(() => undefined);
    fail = false;
    await f.verify(payload, requirements);
    expect((await f.health().catch(() => ({ consecutiveFailures: -1 }))).consecutiveFailures).toBe(
      0,
    );
  });
});

describe('coinbase facilitator', () => {
  it('defaults to the public x402 facilitator and the base rail', () => {
    const f = new CoinbaseFacilitator();
    expect(f.id).toBe('coinbase');
    expect([...f.rails]).toEqual(['base:usdc']);
  });

  it('sends CDP credentials as basic auth when both are supplied', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ isValid: true }));
    const f = new CoinbaseFacilitator({
      apiKeyId: 'key-id',
      apiKeySecret: 'key-secret',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await f.verify(payload, requirements);
    const init = (fetchImpl.mock.calls[0] as [string, RequestInit])[1];
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(
      `Basic ${Buffer.from('key-id:key-secret', 'utf8').toString('base64')}`,
    );
  });

  it('sends no authorization header when credentials are absent', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ isValid: true }));
    const f = new CoinbaseFacilitator({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await f.verify(payload, requirements);
    const headers = (fetchImpl.mock.calls[0] as [string, RequestInit])[1].headers as Record<
      string,
      string
    >;
    expect(headers.authorization).toBeUndefined();
  });
});

describe('t54 xrpl facilitator', () => {
  it('serves the XRPL rails', () => {
    const f = new T54Facilitator({ url: 'https://t54.example' });
    expect([...f.rails]).toEqual(['xrpl:rlusd', 'xrpl:xrp']);
  });

  it('passes the Verifiable Intent header through on verify and settle', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('/verify')
        ? jsonResponse({ isValid: true })
        : jsonResponse({ success: true, transaction: 'AB', network: 'xrpl-testnet' }),
    );
    const f = new T54Facilitator({
      url: 'https://t54.example',
      verifiableIntent: 'intent-blob',
      apiKey: 'secret-key',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await f.verify(payload, requirements);
    await f.settle(payload, requirements);
    for (const call of fetchImpl.mock.calls) {
      const headers = (call as unknown as [string, RequestInit])[1].headers as Record<
        string,
        string
      >;
      expect(headers[VERIFIABLE_INTENT_HEADER]).toBe('intent-blob');
      expect(headers.authorization).toBe('Bearer secret-key');
    }
  });

  it('omits the intent header when the buyer supplied none', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ isValid: true }));
    const f = new T54Facilitator({
      url: 'https://t54.example',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await f.verify(payload, requirements);
    const headers = (fetchImpl.mock.calls[0] as [string, RequestInit])[1].headers as Record<
      string,
      string
    >;
    expect(headers[VERIFIABLE_INTENT_HEADER]).toBeUndefined();
  });
});

describe('facilitators declared but not implemented in v1', () => {
  it.each([
    ['stripe', stripeFacilitator],
    ['xpay', xpayFacilitator],
  ])('%s refuses verify and settle with a reason a human can act on', async (id, build) => {
    const f = build();
    expect(f.id).toBe(id);
    for (const call of [f.verify(payload, requirements), f.settle(payload, requirements)]) {
      const error = await call.catch((e: unknown) => e as FacilitatorError);
      expect(error).toBeInstanceOf(FacilitatorError);
      expect(error.kind).toBe('not_implemented');
      expect(error.message).toMatch(/not implemented for the .* facilitator in v1/);
      expect(error.message).toMatch(/build_v1\.md/);
    }
  });

  it('reports unhealthy, so the router never selects it during failover', async () => {
    const health = await stripeFacilitator().health();
    expect(health.healthy).toBe(false);
    expect(health.message).toMatch(/not implemented in v1/);
  });

  it('is retryable elsewhere, so a configured but unbuilt adapter falls through', async () => {
    const error = await stripeFacilitator()
      .verify(payload, requirements)
      .catch((e: unknown) => e as FacilitatorError);
    expect(error.isRetryableElsewhere).toBe(true);
  });
});
