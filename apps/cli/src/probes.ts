import {
  IDEMPOTENCY_HEADER,
  PAYMENT_HEADER,
  X402ResponseSchema,
  encodePaymentHeader,
  type PaymentPayload,
  type PaymentRequirements,
  type X402Response,
} from '@payguard/core';

/** One of the five documented attack classes, run against a live endpoint. */
export interface Probe {
  id: string;
  title: string;
  /** What a correct implementation does, in one sentence. */
  expectation: string;
  run(context: ProbeContext): Promise<ProbeResult>;
}

export interface ProbeContext {
  url: string;
  fetchImpl: typeof fetch;
  /** Produces a syntactically valid but unsigned payload for the given requirements. */
  forgePayload(requirements: PaymentRequirements): PaymentPayload;
  /**
   * The seller's 402 body, or null when it did not produce a readable one. Probes that need it
   * report inconclusive; probes that do not, such as free shopping, still run. An endpoint that
   * serves its resource for free has no accepts list to read, and that is exactly the case the
   * free shopping probe exists to catch.
   */
  quote: X402Response | null;
}

export type ProbeVerdict = 'blocked' | 'vulnerable' | 'inconclusive';

export interface ProbeResult {
  verdict: ProbeVerdict;
  detail: string;
  evidence?: Record<string, unknown>;
}

/**
 * The probes are deliberately read-only and unsigned. `payguard audit` is something an operator
 * runs against their own endpoint, so it must not be able to move money even by accident, and it
 * must not need a funded wallet to be useful.
 *
 * The cost of that choice is honesty about its limits: an unsigned probe cannot prove a seller
 * settles correctly, only that it refuses what it should refuse. Anything it cannot determine is
 * reported as inconclusive rather than as a pass.
 */

const freeShopping: Probe = {
  id: 'free-shopping',
  title: 'Free shopping (resource released before settlement)',
  expectation: 'An unpaid request is answered with 402 and never with the resource.',
  async run({ url, fetchImpl }) {
    const response = await fetchImpl(url, { method: 'GET' });
    if (response.status === 402) {
      return { verdict: 'blocked', detail: 'unpaid request was answered with 402' };
    }
    if (response.status >= 200 && response.status < 300) {
      return {
        verdict: 'vulnerable',
        detail: `unpaid request returned ${response.status}; the resource is served without payment`,
        evidence: { status: response.status },
      };
    }
    return {
      verdict: 'inconclusive',
      detail: `unpaid request returned ${response.status}, which is neither a 402 nor a delivery`,
      evidence: { status: response.status },
    };
  },
};

const unsignedPayload: Probe = {
  id: 'unsigned-payload',
  title: 'Grant before settle (unsigned payload accepted)',
  expectation: 'A well formed but unsigned payload is refused with 402.',
  async run({ url, fetchImpl, forgePayload, quote }) {
    const requirements = quote?.accepts[0];
    if (requirements === undefined) {
      return {
        verdict: 'inconclusive',
        detail: 'the endpoint advertised no accepts entry to build a payload against',
      };
    }
    const header = encodePaymentHeader(forgePayload(requirements));
    const response = await fetchImpl(url, { headers: { [PAYMENT_HEADER]: header } });
    if (response.status === 402) {
      return { verdict: 'blocked', detail: 'unsigned payload was refused with 402' };
    }
    if (response.status >= 200 && response.status < 300) {
      return {
        verdict: 'vulnerable',
        detail: `unsigned payload returned ${response.status}; settlement is not being verified`,
        evidence: { status: response.status },
      };
    }
    return {
      verdict: 'inconclusive',
      detail: `unsigned payload returned ${response.status}`,
      evidence: { status: response.status },
    };
  },
};

const replay: Probe = {
  id: 'replay',
  title: 'Replay (same payload accepted twice)',
  expectation: 'Presenting the same payload twice is refused the second time.',
  async run({ url, fetchImpl, forgePayload, quote }) {
    const requirements = quote?.accepts[0];
    if (requirements === undefined) {
      return {
        verdict: 'inconclusive',
        detail: 'the endpoint advertised no accepts entry to build a payload against',
      };
    }
    const header = encodePaymentHeader(forgePayload(requirements));
    const first = await fetchImpl(url, { headers: { [PAYMENT_HEADER]: header } });
    const second = await fetchImpl(url, { headers: { [PAYMENT_HEADER]: header } });

    if (first.status >= 200 && first.status < 300) {
      return {
        verdict: 'vulnerable',
        detail:
          'the endpoint accepted an unsigned payload, so replay cannot be assessed separately',
        evidence: { firstStatus: first.status },
      };
    }
    if (second.status === 402) {
      return {
        verdict: 'blocked',
        detail: 'the repeated payload was refused',
        evidence: { firstStatus: first.status, secondStatus: second.status },
      };
    }
    return {
      verdict: 'inconclusive',
      detail: `the repeated payload returned ${second.status}; a signed payload is needed to test replay properly`,
      evidence: { firstStatus: first.status, secondStatus: second.status },
    };
  },
};

const duplication: Probe = {
  id: 'duplication',
  title: 'Duplication and TOCTOU (concurrent identical requests)',
  expectation: 'Fifty concurrent identical requests deliver the resource at most once.',
  async run({ url, fetchImpl, forgePayload, quote }) {
    const requirements = quote?.accepts[0];
    if (requirements === undefined) {
      return {
        verdict: 'inconclusive',
        detail: 'the endpoint advertised no accepts entry to build a payload against',
      };
    }
    const header = encodePaymentHeader(forgePayload(requirements));
    const responses = await Promise.all(
      Array.from({ length: 50 }, () => fetchImpl(url, { headers: { [PAYMENT_HEADER]: header } })),
    );
    const delivered = responses.filter((r) => r.status >= 200 && r.status < 300).length;

    if (delivered === 0) {
      return {
        verdict: 'blocked',
        detail:
          'no concurrent request was delivered, and none should have been for an unsigned payload',
        evidence: { delivered, total: responses.length },
      };
    }
    return {
      verdict: 'vulnerable',
      detail: `${delivered} of ${responses.length} concurrent unsigned requests were delivered`,
      evidence: { delivered, total: responses.length },
    };
  },
};

const idempotency: Probe = {
  id: 'idempotency',
  title: 'Idempotency (retry re-charges or re-delivers)',
  expectation: 'A retry with the same Idempotency-Key never delivers without payment.',
  async run({ url, fetchImpl }) {
    const key = `payguard-audit-${Date.now().toString(36)}`;
    const first = await fetchImpl(url, { headers: { [IDEMPOTENCY_HEADER]: key } });
    const second = await fetchImpl(url, { headers: { [IDEMPOTENCY_HEADER]: key } });

    if (second.status >= 200 && second.status < 300 && first.status === 402) {
      return {
        verdict: 'vulnerable',
        detail: 'a repeated idempotency key produced a delivery after an unpaid 402',
        evidence: { firstStatus: first.status, secondStatus: second.status },
      };
    }
    if (first.status === 402 && second.status === 402) {
      return {
        verdict: 'blocked',
        detail: 'a repeated idempotency key without payment stayed at 402',
      };
    }
    return {
      verdict: 'inconclusive',
      detail: `unpaid requests returned ${first.status} then ${second.status}`,
      evidence: { firstStatus: first.status, secondStatus: second.status },
    };
  },
};

export const PROBES: readonly Probe[] = Object.freeze([
  freeShopping,
  unsignedPayload,
  replay,
  duplication,
  idempotency,
]);

/** Reads the seller's 402 so the probes know what it claims to accept. */
export async function fetchQuote(
  url: string,
  fetchImpl: typeof fetch,
): Promise<X402Response | null> {
  const response = await fetchImpl(url, { method: 'GET' }).catch(() => null);
  if (response === null || response.status !== 402) return null;
  const parsed = X402ResponseSchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data : null;
}
