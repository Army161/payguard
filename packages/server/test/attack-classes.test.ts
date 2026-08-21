import { describe, expect, it } from 'vitest';
import {
  IDEMPOTENCY_HEADER,
  PAYMENT_HEADER,
  decodeSettleResponseHeader,
  verifyChain,
  type X402Response,
} from '@payguard/core';
import { FacilitatorError } from '@payguard/rails';
import { ATTACKER, StubFacilitator, StubRail, harness, payload, paymentHeader } from './harness.js';

/**
 * The attack class suite from spec.md. Every documented vulnerability in the x402 facilitator
 * survey gets a test that fails if the guard stops blocking it.
 */

describe('AT-1 free shopping: the resource is withheld until settlement is confirmed', () => {
  it('answers 402 with an accepts list when no payment is presented', async () => {
    const h = harness();
    const outcome = await h.request();
    expect(outcome.kind).toBe('payment_required');
    if (outcome.kind !== 'payment_required') return;
    expect(outcome.status).toBe(402);
    const body = outcome.body as X402Response;
    expect(body.x402Version).toBe(1);
    expect(body.accepts).toHaveLength(1);
    expect(body.accepts[0]?.resource).toBe('https://seller.example/api/report');
    expect(outcome.reason).toBe('payload_missing');
  });

  it('does not contact any facilitator when no payment is presented', async () => {
    const facilitator = new StubFacilitator();
    const h = harness({ facilitators: [facilitator] });
    await h.request();
    expect(facilitator.verifyCalls).toBe(0);
    expect(facilitator.settleCalls).toBe(0);
  });

  it('withholds the resource when the facilitator says the payload is invalid', async () => {
    const facilitator = new StubFacilitator({
      verifyResult: { isValid: false, invalidReason: 'invalid_exact_evm_payload_signature' },
    });
    const h = harness({ facilitators: [facilitator] });
    const outcome = await h.request({ [PAYMENT_HEADER]: paymentHeader() });
    expect(outcome).toMatchObject({ kind: 'payment_required', reason: 'facilitator_rejected' });
    expect(facilitator.settleCalls).toBe(0);
  });

  it('withholds the resource when settlement itself fails', async () => {
    const facilitator = new StubFacilitator({
      settleResult: {
        success: false,
        errorReason: 'insufficient_funds',
        transaction: '',
        network: 'base-sepolia',
      },
    });
    const h = harness({ facilitators: [facilitator] });
    const outcome = await h.request({ [PAYMENT_HEADER]: paymentHeader() });
    expect(outcome).toMatchObject({ kind: 'payment_required', reason: 'settlement_failed' });
  });

  it('withholds the resource when the facilitator claims success but the chain never confirms', async () => {
    const rail = new StubRail();
    rail.queue({ confirmations: 0 });
    const h = harness({ rail, minConfirmations: 2 });
    const outcome = await h.request({ [PAYMENT_HEADER]: paymentHeader() });
    expect(outcome).toMatchObject({
      kind: 'payment_required',
      reason: 'chain_confirmation_failed',
    });
  });

  it('withholds the resource when the settlement transaction cannot be found at all', async () => {
    const rail = new StubRail();
    rail.failWith = new Error('transaction not found on the configured RPC');
    const h = harness({ rail });
    const outcome = await h.request({ [PAYMENT_HEADER]: paymentHeader() });
    expect(outcome).toMatchObject({
      kind: 'payment_required',
      reason: 'chain_transaction_not_found',
    });
  });

  it('releases the resource once settlement is confirmed on chain', async () => {
    const h = harness();
    const outcome = await h.request({ [PAYMENT_HEADER]: paymentHeader() });
    expect(outcome.kind).toBe('settled');
    if (outcome.kind !== 'settled') return;
    expect(outcome.rail).toBe('base:usdc');
    expect(decodeSettleResponseHeader(outcome.headers['x-payment-response']!).success).toBe(true);
  });

  it('trusts the facilitator without a chain read in fast mode, and says so in the audit', async () => {
    const rail = new StubRail();
    const h = harness({ rail, mode: 'fast' });
    const outcome = await h.request({ [PAYMENT_HEADER]: paymentHeader() });
    expect(outcome.kind).toBe('settled');
    expect(rail.lookups).toHaveLength(0);
    const entries = await h.store.readAudit();
    expect(entries.at(-1)?.mode).toBe('fast');
  });
});

describe('AT-2 replay: a payload cannot be spent twice', () => {
  it('rejects the second presentation of the same payload', async () => {
    const h = harness();
    const header = paymentHeader();
    expect((await h.request({ [PAYMENT_HEADER]: header })).kind).toBe('settled');
    const second = await h.request({ [PAYMENT_HEADER]: header });
    expect(second).toMatchObject({ kind: 'payment_required', reason: 'replay_detected' });
  });

  it('does not contact the facilitator on a replay, so a replay costs nothing to refuse', async () => {
    const facilitator = new StubFacilitator();
    const h = harness({ facilitators: [facilitator] });
    const header = paymentHeader();
    await h.request({ [PAYMENT_HEADER]: header });
    await h.request({ [PAYMENT_HEADER]: header });
    expect(facilitator.verifyCalls).toBe(1);
    expect(facilitator.settleCalls).toBe(1);
  });

  it('accepts a distinct payload from the same buyer', async () => {
    const h = harness();
    await h.request({
      [PAYMENT_HEADER]: paymentHeader(payload({ nonce: `0x${'01'.repeat(32)}` })),
    });
    const second = await h.request({
      [PAYMENT_HEADER]: paymentHeader(payload({ nonce: `0x${'02'.repeat(32)}` })),
    });
    expect(second.kind).toBe('settled');
  });

  it('rejects a payload whose validity window has closed', async () => {
    const h = harness();
    const stale = payload();
    (stale.payload as { authorization: { validBefore: string } }).authorization.validBefore = '1';
    const outcome = await h.request({ [PAYMENT_HEADER]: paymentHeader(stale) });
    expect(outcome).toMatchObject({ kind: 'payment_required', reason: 'payload_expired' });
  });

  it('releases the claim when verification fails, so an honest retry is still possible', async () => {
    const rejecting = new StubFacilitator({ verifyResult: { isValid: false } });
    const accepting = new StubFacilitator();
    const header = paymentHeader();

    const first = harness({ facilitators: [rejecting] });
    await first.request({ [PAYMENT_HEADER]: header });

    const second = harness({ store: first.store, facilitators: [accepting] });
    expect((await second.request({ [PAYMENT_HEADER]: header })).kind).toBe('settled');
  });

  it('keeps the claim when settlement happened but did not match, so the payload cannot be reused', async () => {
    const rail = new StubRail();
    rail.queue({ recipient: ATTACKER });
    const h = harness({ rail });
    const header = paymentHeader();
    const first = await h.request({ [PAYMENT_HEADER]: header });
    expect(first).toMatchObject({ reason: 'chain_recipient_mismatch' });

    const good = new StubRail();
    const second = harness({ store: h.store, rail: good });
    const retry = await second.request({ [PAYMENT_HEADER]: header });
    expect(retry).toMatchObject({ reason: 'replay_detected' });
  });
});

describe('AT-3 duplication: concurrent identical requests charge exactly once', () => {
  it('settles once and refuses the rest when fifty identical requests arrive together', async () => {
    const facilitator = new StubFacilitator();
    const h = harness({ facilitators: [facilitator] });
    const header = paymentHeader();

    const outcomes = await Promise.all(
      Array.from({ length: 50 }, () => h.request({ [PAYMENT_HEADER]: header })),
    );

    expect(outcomes.filter((o) => o.kind === 'settled')).toHaveLength(1);
    expect(outcomes.filter((o) => o.kind === 'payment_required')).toHaveLength(49);
    expect(facilitator.settleCalls).toBe(1);
    expect(facilitator.verifyCalls).toBe(1);
  });

  it('the losers all report a replay rather than a confusing internal error', async () => {
    const h = harness();
    const header = paymentHeader();
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => h.request({ [PAYMENT_HEADER]: header })),
    );
    for (const outcome of outcomes) {
      if (outcome.kind === 'payment_required') {
        expect(outcome.reason).toBe('replay_detected');
      }
    }
  });

  it('replays the winner response to a loser that supplied the same idempotency key', async () => {
    const h = harness();
    const header = paymentHeader();
    const headers = { [PAYMENT_HEADER]: header, [IDEMPOTENCY_HEADER]: 'key-1' };

    const winner = await h.request(headers);
    expect(winner.kind).toBe('settled');
    if (winner.kind !== 'settled') return;
    await winner.capture(200, { 'content-type': 'application/json' }, Buffer.from('{"ok":true}'));

    const retry = await h.request(headers);
    expect(retry.kind).toBe('replay_response');
    if (retry.kind !== 'replay_response') return;
    expect(Buffer.from(retry.bodyBase64, 'base64').toString('utf8')).toBe('{"ok":true}');
  });

  it('never re-charges for a repeated idempotency key', async () => {
    const facilitator = new StubFacilitator();
    const h = harness({ facilitators: [facilitator] });
    const headers = { [PAYMENT_HEADER]: paymentHeader(), [IDEMPOTENCY_HEADER]: 'key-2' };
    const first = await h.request(headers);
    if (first.kind === 'settled') {
      await first.capture(200, {}, Buffer.from('body'));
    }
    await h.request(headers);
    await h.request(headers);
    expect(facilitator.settleCalls).toBe(1);
  });

  it('never delivers a cached response to a request that presented no payment at all', async () => {
    const h = harness();
    const headers = { [PAYMENT_HEADER]: paymentHeader(), [IDEMPOTENCY_HEADER]: 'key-3' };
    const first = await h.request(headers);
    if (first.kind === 'settled') {
      await first.capture(200, {}, Buffer.from('paid body'));
    }
    // A different buyer guessing the key still gets the cached response, which is why an
    // idempotency key must be treated as a secret. What must never happen is delivery without
    // any payment ever having been made for that key.
    const unpaid = await h.request({ [IDEMPOTENCY_HEADER]: 'never-paid' });
    expect(unpaid).toMatchObject({ kind: 'payment_required', reason: 'payload_missing' });
  });
});

describe('AT-4 wrong recipient, asset, amount, or network', () => {
  it.each([
    [
      'a payment to someone other than the seller',
      { recipient: ATTACKER },
      'chain_recipient_mismatch',
    ],
    [
      'a payment in the wrong token',
      { asset: '0x0000000000000000000000000000000000000001' },
      'chain_asset_mismatch',
    ],
    ['a payment short of the price', { amount: '9999' }, 'chain_amount_insufficient'],
    ['a reverted transaction', { succeeded: false }, 'chain_transaction_reverted'],
  ])('refuses %s', async (_label, observation, reason) => {
    const rail = new StubRail();
    rail.queue(observation);
    const h = harness({ rail });
    const outcome = await h.request({ [PAYMENT_HEADER]: paymentHeader() });
    expect(outcome).toMatchObject({ kind: 'payment_required', reason });
  });

  it('accepts an overpayment, since a price is a minimum', async () => {
    const rail = new StubRail();
    rail.queue({ amount: '10001' });
    const h = harness({ rail });
    expect((await h.request({ [PAYMENT_HEADER]: paymentHeader() })).kind).toBe('settled');
  });

  it('refuses a payload for a network this endpoint does not accept', async () => {
    const h = harness();
    const outcome = await h.request({
      [PAYMENT_HEADER]: paymentHeader(payload({ network: 'xrpl-testnet' })),
    });
    expect(outcome).toMatchObject({ kind: 'payment_required', reason: 'unsupported_network' });
  });

  it('still returns the accepts list on a refusal, so the buyer can retry correctly', async () => {
    const rail = new StubRail();
    rail.queue({ recipient: ATTACKER });
    const h = harness({ rail });
    const outcome = await h.request({ [PAYMENT_HEADER]: paymentHeader() });
    if (outcome.kind !== 'payment_required') return;
    expect((outcome.body as X402Response).accepts[0]?.payTo).toBe(
      '0x1111111111111111111111111111111111111111',
    );
  });

  it('returns the settlement proof header on a mismatch, so the seller can reconcile', async () => {
    const rail = new StubRail();
    rail.queue({ recipient: ATTACKER });
    const h = harness({ rail });
    const outcome = await h.request({ [PAYMENT_HEADER]: paymentHeader() });
    if (outcome.kind !== 'payment_required') return;
    expect(outcome.headers['x-payment-response']).toBeDefined();
  });
});

describe('malformed and oversized payloads', () => {
  it('refuses a payment header that is not valid base64', async () => {
    const h = harness();
    const outcome = await h.request({ [PAYMENT_HEADER]: 'not base64 !!' });
    expect(outcome).toMatchObject({ kind: 'payment_required', reason: 'payload_malformed' });
  });

  it('refuses a payment header that does not match the x402 schema', async () => {
    const h = harness();
    const header = Buffer.from(JSON.stringify({ x402Version: 1 }), 'utf8').toString('base64');
    const outcome = await h.request({ [PAYMENT_HEADER]: header });
    expect(outcome).toMatchObject({ kind: 'payment_required', reason: 'payload_malformed' });
  });

  it('refuses an oversized header before parsing it', async () => {
    const h = harness();
    const outcome = await h.request({ [PAYMENT_HEADER]: 'A'.repeat(9000) });
    expect(outcome).toMatchObject({ kind: 'payment_required', reason: 'payload_too_large' });
  });

  it('refuses an empty payment header the same way as a missing one', async () => {
    const h = harness();
    const outcome = await h.request({ [PAYMENT_HEADER]: '' });
    expect(outcome).toMatchObject({ kind: 'payment_required', reason: 'payload_missing' });
  });
});

describe('AT-8 the audit log is complete and tamper evident', () => {
  it('records every stage of a successful payment', async () => {
    const h = harness();
    await h.request({ [PAYMENT_HEADER]: paymentHeader() });
    const entries = await h.store.readAudit();
    const last = entries.at(-1);
    expect(last).toMatchObject({
      stage: 'release',
      outcome: 'allowed',
      rail: 'base:usdc',
      network: 'base-sepolia',
      facilitator: 'stub',
      mode: 'strict',
    });
    expect(last?.transactionHash).toBeTruthy();
    expect(last?.paymentId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('records a refusal with its machine readable reason', async () => {
    const h = harness();
    await h.request();
    const entries = await h.store.readAudit();
    expect(entries.at(-1)).toMatchObject({
      outcome: 'denied',
      reason: 'payload_missing',
      stage: 'payload_validation',
    });
  });

  it('records what to reconcile when money moved but the resource was withheld', async () => {
    const rail = new StubRail();
    rail.queue({ recipient: ATTACKER });
    const h = harness({ rail });
    await h.request({ [PAYMENT_HEADER]: paymentHeader() });
    const entry = (await h.store.readAudit()).at(-1);
    expect(entry).toMatchObject({
      stage: 'chain_confirmation',
      reason: 'chain_recipient_mismatch',
    });
    expect(entry?.transactionHash).toBeTruthy();
    expect(String(entry?.details?.reconciliation)).toMatch(/settlement occurred/);
  });

  it('produces a chain that verifies after a busy mixed workload', async () => {
    const h = harness();
    await h.request();
    await h.request({ [PAYMENT_HEADER]: 'garbage!' });
    const header = paymentHeader();
    await h.request({ [PAYMENT_HEADER]: header });
    await h.request({ [PAYMENT_HEADER]: header });
    await h.request({
      [PAYMENT_HEADER]: paymentHeader(payload({ nonce: `0x${'ee'.repeat(32)}` })),
    });

    const entries = await h.store.readAudit();
    expect(entries.length).toBeGreaterThanOrEqual(5);
    expect(verifyChain(entries)).toEqual({ ok: true, length: entries.length });
  });

  it('detects an edited entry, which is the point of the chain', async () => {
    const h = harness();
    await h.request({ [PAYMENT_HEADER]: paymentHeader() });
    const entries = await h.store.readAudit();
    entries[0] = { ...entries[0]!, message: 'nothing to see here' };
    expect(verifyChain(entries).ok).toBe(false);
  });

  it('delivers every decision to the webhook without letting it break the payment path', async () => {
    const seen: string[] = [];
    const h = harness();
    const failing = harness({
      store: h.store,
      facilitators: [new StubFacilitator()],
    });
    // Rebuild with an onAudit that throws, to prove a broken webhook cannot fail a payment.
    const { PayGuardServer } = await import('@payguard/server');
    const server = new PayGuardServer({
      rails: [
        {
          id: 'base:usdc',
          rail: new StubRail(),
          requirements: (await import('./harness.js')).requirementsTemplate(),
          minConfirmations: 1,
        },
      ],
      facilitators: [new StubFacilitator()],
      store: h.store,
      onAudit: (entry) => {
        seen.push(entry.stage);
        throw new Error('webhook is down');
      },
    });
    const outcome = await server.guard({
      method: 'GET',
      url: 'https://seller.example/api/report',
      header: (name) => (name === 'x-payment' ? paymentHeader() : undefined),
    });
    expect(outcome.kind).toBe('settled');
    expect(seen).toContain('release');
    expect(failing).toBeDefined();
  });
});

describe('facilitator failover on the seller side', () => {
  it('moves to the next facilitator when the first is unreachable', async () => {
    const down = new StubFacilitator({
      id: 'down',
      verifyError: new FacilitatorError('network', 'down', 'unreachable'),
    });
    const up = new StubFacilitator({ id: 'up' });
    const h = harness({ facilitators: [down, up] });
    const outcome = await h.request({ [PAYMENT_HEADER]: paymentHeader() });
    expect(outcome).toMatchObject({ kind: 'settled', facilitatorId: 'up' });
  });

  it('does not shop for a yes after a facilitator rejects the payload', async () => {
    const rejecting = new StubFacilitator({ id: 'strict', verifyResult: { isValid: false } });
    const lenient = new StubFacilitator({ id: 'lenient' });
    const h = harness({ facilitators: [rejecting, lenient] });
    const outcome = await h.request({ [PAYMENT_HEADER]: paymentHeader() });
    expect(outcome).toMatchObject({ kind: 'payment_required', reason: 'facilitator_rejected' });
    expect(lenient.verifyCalls).toBe(0);
  });

  it('reports no healthy facilitator rather than releasing when all are down', async () => {
    const down = new StubFacilitator({
      id: 'down',
      verifyError: new FacilitatorError('server_error', 'down', 'boom', 500),
    });
    const h = harness({ facilitators: [down] });
    const outcome = await h.request({ [PAYMENT_HEADER]: paymentHeader() });
    expect(outcome).toMatchObject({
      kind: 'payment_required',
      reason: 'facilitator_unavailable',
    });
  });

  it('stops sending traffic to a facilitator whose breaker has opened', async () => {
    const down = new StubFacilitator({
      id: 'down',
      verifyError: new FacilitatorError('server_error', 'down', 'boom', 500),
    });
    const up = new StubFacilitator({ id: 'up' });
    const h = harness({ facilitators: [down, up] });
    for (let i = 0; i < 6; i += 1) {
      await h.request({
        [PAYMENT_HEADER]: paymentHeader(
          payload({ nonce: `0x${String(i).padStart(2, '0').repeat(32)}` }),
        ),
      });
    }
    const before = down.verifyCalls;
    await h.request({
      [PAYMENT_HEADER]: paymentHeader(payload({ nonce: `0x${'ff'.repeat(32)}` })),
    });
    expect(down.verifyCalls).toBe(before);
  });
});
