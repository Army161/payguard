import { X402_VERSION, type PaymentPayload, type PaymentRequirements } from '@payguard/core';
import { PROBES, fetchQuote, type Probe } from '../probes.js';
import {
  buildReport,
  renderMarkdown,
  renderText,
  resultToEntry,
  type AuditReport,
} from '../report.js';

export interface AuditOptions {
  url: string;
  fetchImpl?: typeof fetch;
  probes?: readonly Probe[];
  /** Fixed timestamp, so reports are reproducible in tests. */
  startedAt?: string;
}

/**
 * Builds a syntactically valid payload with an obviously invalid signature.
 *
 * The signature is a recognisable marker rather than random bytes, so an operator who finds this
 * in their logs can tell immediately that it came from `payguard audit` and not from an attacker.
 */
export function forgePayload(requirements: PaymentRequirements): PaymentPayload {
  const marker = 'payguardaudit';
  if (requirements.network.startsWith('xrpl') || requirements.network.startsWith('solana')) {
    return {
      x402Version: X402_VERSION,
      scheme: 'exact',
      network: requirements.network,
      payload: { transaction: Buffer.from(marker, 'utf8').toString('hex') },
    };
  }
  return {
    x402Version: X402_VERSION,
    scheme: 'exact',
    network: requirements.network,
    payload: {
      signature: `0x${'00'.repeat(65)}`,
      authorization: {
        from: '0x0000000000000000000000000000000000000000',
        to: requirements.payTo.startsWith('0x')
          ? requirements.payTo
          : '0x0000000000000000000000000000000000000000',
        value: requirements.maxAmountRequired,
        validAfter: String(Math.floor(Date.now() / 1000) - 60),
        validBefore: String(Math.floor(Date.now() / 1000) + requirements.maxTimeoutSeconds),
        nonce: `0x${'00'.repeat(32)}`,
      },
    },
  };
}

/**
 * Runs the five attack class probes against a live endpoint and returns a report.
 *
 * Probes run in sequence rather than in parallel, because the duplication probe deliberately
 * sends fifty concurrent requests and interleaving that with the others would make every result
 * a guess.
 */
export async function runAudit(options: AuditOptions): Promise<AuditReport> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const probes = options.probes ?? PROBES;
  const startedAt = options.startedAt ?? new Date().toISOString();

  const quote = await fetchQuote(options.url, fetchImpl);
  const entries = [];

  for (const probe of probes) {
    const startedMs = Date.now();
    // Every probe runs, whether or not the seller produced a readable 402. Skipping them all when
    // there is no quote would turn the most important finding, an endpoint that serves its
    // resource for free and therefore has no accepts list at all, into five inconclusive rows.
    const result = await probe
      .run({ url: options.url, fetchImpl, forgePayload, quote })
      .catch((error: unknown) => ({
        verdict: 'inconclusive' as const,
        detail: `the probe failed to run: ${error instanceof Error ? error.message : String(error)}`,
      }));
    entries.push(resultToEntry(probe, result, Date.now() - startedMs));
  }

  return buildReport(options.url, startedAt, entries);
}

export { renderMarkdown, renderText };
