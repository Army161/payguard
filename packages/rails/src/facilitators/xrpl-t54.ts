import type {
  PaymentPayload,
  PaymentRequirements,
  RailId,
  SettleResponse,
  VerifyResponse,
} from '@payguard/core';
import { HttpFacilitator } from './http.js';

export interface T54FacilitatorOptions {
  url: string;
  rails?: readonly RailId[];
  timeoutMs?: number;
  apiKey?: string;
  /**
   * The Verifiable Intent header the t54 XRPL facilitator accepts, passed through from the buyer.
   * PayGuard neither produces nor interprets it; it forwards what the buyer signed.
   */
  verifiableIntent?: string;
  fetchImpl?: typeof fetch;
}

export const VERIFIABLE_INTENT_HEADER = 'x-verifiable-intent';

/**
 * XRPL x402 facilitator (t54). Two differences from the plain contract.
 *
 * It serves XRPL rails, which x402 v1's own network enum does not name, so PayGuard's extended
 * network schema is what makes the requirements serializable at all.
 *
 * It accepts a Verifiable Intent header. PayGuard passes it through untouched. Interpreting it
 * here would mean PayGuard vouching for something it did not verify, and a middleware that vouches
 * for a buyer's intent is doing the facilitator's job badly.
 */
export class T54Facilitator extends HttpFacilitator {
  private readonly verifiableIntent: string | undefined;

  constructor(options: T54FacilitatorOptions) {
    const headers: Record<string, string> = {};
    if (options.apiKey !== undefined) {
      headers.authorization = `Bearer ${options.apiKey}`;
    }
    super({
      id: 'xrpl-t54',
      url: options.url,
      rails: options.rails ?? ['xrpl:rlusd', 'xrpl:xrp'],
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      headers,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
    this.verifiableIntent = options.verifiableIntent;
  }

  private withIntent(): void {
    if (this.verifiableIntent !== undefined) {
      this.headers[VERIFIABLE_INTENT_HEADER] = this.verifiableIntent;
    }
  }

  override async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    this.withIntent();
    return super.verify(payload, requirements);
  }

  override async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    this.withIntent();
    return super.settle(payload, requirements);
  }
}
