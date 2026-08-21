import {
  SettleResponseSchema,
  VerifyResponseSchema,
  X402_VERSION,
  type PaymentPayload,
  type PaymentRequirements,
  type RailId,
  type SettleResponse,
  type VerifyResponse,
} from '@payguard/core';
import { FacilitatorError, statusToKind, type Facilitator, type Health } from './interface.js';

export interface HttpFacilitatorOptions {
  id: string;
  /** Base URL. Anything other than https is refused unless the host is a loopback address. */
  url: string;
  rails: readonly RailId[];
  timeoutMs?: number;
  /** Extra headers, for example an API key. Never logged. */
  headers?: Record<string, string>;
  /** Injected in tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Refuses a facilitator URL that would let an attacker steer PayGuard's own requests. design.md
 * lists SSRF via facilitator URLs in the threat model: a configuration read from a database or a
 * dashboard is attacker-influenced in a multi-tenant gateway, so the check belongs here rather
 * than in the operator's head.
 */
export function assertSafeFacilitatorUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`facilitator url is not a url: ${raw}`);
  }
  const loopback = LOOPBACK.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(
      `facilitator url must use https, or http on a loopback host for local development: ${raw}`,
    );
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('facilitator url must not embed credentials');
  }
  return url;
}

/**
 * The x402 facilitator HTTP contract: POST /verify, POST /settle, GET /supported. Every adapter
 * that speaks plain x402 extends this rather than reimplementing the transport, so the timeout,
 * the SSRF check, the schema validation, and the error normalization are written once.
 */
export class HttpFacilitator implements Facilitator {
  readonly id: string;
  readonly rails: readonly RailId[];

  protected readonly base: URL;
  protected readonly timeoutMs: number;
  protected readonly headers: Record<string, string>;
  protected readonly fetchImpl: typeof fetch;

  private lastSuccessMs: number | null = null;
  private consecutiveFailures = 0;
  private lastLatencyMs = 0;

  constructor(options: HttpFacilitatorOptions) {
    this.id = options.id;
    this.rails = options.rails;
    this.base = assertSafeFacilitatorUrl(options.url);
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.headers = options.headers ?? {};
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  protected endpoint(path: string): string {
    const base = this.base.toString().replace(/\/$/, '');
    return `${base}${path}`;
  }

  protected async post(path: string, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const startedAt = Date.now();
    try {
      const response = await this.fetchImpl(this.endpoint(path), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      this.lastLatencyMs = Date.now() - startedAt;

      if (!response.ok) {
        this.consecutiveFailures += 1;
        throw new FacilitatorError(
          statusToKind(response.status),
          this.id,
          `facilitator ${this.id} returned ${response.status} for ${path}`,
          response.status,
        );
      }

      const parsed: unknown = await response.json().catch(() => {
        throw new FacilitatorError(
          'malformed_response',
          this.id,
          `facilitator ${this.id} returned a body that is not JSON`,
        );
      });
      this.consecutiveFailures = 0;
      this.lastSuccessMs = Date.now();
      return parsed;
    } catch (error) {
      this.lastLatencyMs = Date.now() - startedAt;
      if (error instanceof FacilitatorError) throw error;
      this.consecutiveFailures += 1;
      const aborted = error instanceof Error && error.name === 'AbortError';
      throw new FacilitatorError(
        aborted ? 'timeout' : 'network',
        this.id,
        aborted
          ? `facilitator ${this.id} did not respond within ${this.timeoutMs} ms`
          : `facilitator ${this.id} was unreachable: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  protected requestBody(payload: PaymentPayload, requirements: PaymentRequirements) {
    return {
      x402Version: X402_VERSION,
      paymentPayload: payload,
      paymentRequirements: requirements,
    };
  }

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const raw = await this.post('/verify', this.requestBody(payload, requirements));
    const parsed = VerifyResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new FacilitatorError(
        'malformed_response',
        this.id,
        `facilitator ${this.id} returned a verify response that does not match the x402 schema`,
      );
    }
    return parsed.data;
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const raw = await this.post('/settle', this.requestBody(payload, requirements));
    const parsed = SettleResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new FacilitatorError(
        'malformed_response',
        this.id,
        `facilitator ${this.id} returned a settle response that does not match the x402 schema`,
      );
    }
    return parsed.data;
  }

  async health(): Promise<Health> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const startedAt = Date.now();
    try {
      const response = await this.fetchImpl(this.endpoint('/supported'), {
        method: 'GET',
        headers: this.headers,
        signal: controller.signal,
      });
      const latencyMs = Date.now() - startedAt;
      if (response.ok) {
        this.lastSuccessMs = Date.now();
        this.consecutiveFailures = 0;
        return {
          healthy: true,
          latencyMs,
          lastSuccessMs: this.lastSuccessMs,
          consecutiveFailures: 0,
        };
      }
      this.consecutiveFailures += 1;
      return {
        healthy: false,
        latencyMs,
        lastSuccessMs: this.lastSuccessMs,
        consecutiveFailures: this.consecutiveFailures,
        message: `/supported returned ${response.status}`,
      };
    } catch (error) {
      this.consecutiveFailures += 1;
      return {
        healthy: false,
        latencyMs: Date.now() - startedAt,
        lastSuccessMs: this.lastSuccessMs,
        consecutiveFailures: this.consecutiveFailures,
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Latency of the most recent call, for the router's cost comparison. */
  get latencyMs(): number {
    return this.lastLatencyMs;
  }
}
