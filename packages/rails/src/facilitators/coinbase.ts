import type { RailId } from '@payguard/core';
import { HttpFacilitator } from './http.js';

export interface CoinbaseFacilitatorOptions {
  /** Defaults to the public x402 facilitator. Point this at CDP for authenticated access. */
  url?: string;
  rails?: readonly RailId[];
  timeoutMs?: number;
  /** CDP API key id. Read from the environment by the caller, never from a config file. */
  apiKeyId?: string;
  apiKeySecret?: string;
  fetchImpl?: typeof fetch;
}

export const COINBASE_PUBLIC_FACILITATOR = 'https://x402.org/facilitator';

/**
 * Coinbase x402 facilitator. Speaks the plain x402 HTTP contract, so the only thing this adds is
 * the default endpoint and the CDP credentials when the caller supplies them.
 *
 * The credentials are held in memory only, are never written to the audit log, and are not read
 * from `payguard.config.ts`. NFR-1 forbids secrets in config files.
 */
export class CoinbaseFacilitator extends HttpFacilitator {
  constructor(options: CoinbaseFacilitatorOptions = {}) {
    const headers: Record<string, string> = {};
    if (options.apiKeyId !== undefined && options.apiKeySecret !== undefined) {
      headers.authorization = `Basic ${Buffer.from(
        `${options.apiKeyId}:${options.apiKeySecret}`,
        'utf8',
      ).toString('base64')}`;
    }
    super({
      id: 'coinbase',
      url: options.url ?? COINBASE_PUBLIC_FACILITATOR,
      rails: options.rails ?? ['base:usdc'],
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      headers,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
  }
}
