import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { canonicalize, payloadHash, paymentId, sha256Hex } from '@payguard/core';
import { evmPayload, requirements } from './fixtures.js';

describe('canonical serialization', () => {
  it('is insensitive to key order', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  it('is sensitive to value changes', () => {
    expect(canonicalize({ a: 1 })).not.toBe(canonicalize({ a: 2 }));
  });

  it('preserves array order, because order is meaning in an accepts list', () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });

  it('drops undefined values so an explicit undefined hashes like an absent key', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
  });

  it('renders bigint as a decimal string rather than throwing', () => {
    expect(canonicalize({ a: 10n })).toBe('{"a":"10"}');
  });

  it('recurses into nested objects and arrays', () => {
    expect(canonicalize({ a: [{ z: 1, y: 2 }] })).toBe('{"a":[{"y":2,"z":1}]}');
  });

  it('handles null without treating it as an object', () => {
    expect(canonicalize({ a: null })).toBe('{"a":null}');
  });

  it('property: reordering keys never changes the hash', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.integer()), (obj) => {
        const shuffled = Object.fromEntries(Object.entries(obj).reverse());
        expect(sha256Hex(canonicalize(obj))).toBe(sha256Hex(canonicalize(shuffled)));
      }),
    );
  });
});

describe('payment identity', () => {
  it('binds the payload to the requirements it was signed against', () => {
    const payload = evmPayload();
    const a = paymentId(payload, requirements());
    const b = paymentId(payload, requirements({ maxAmountRequired: '20000' }));
    expect(a).not.toBe(b);
  });

  it('is stable across key ordering in the payload', () => {
    const payload = evmPayload();
    const reordered = JSON.parse(
      JSON.stringify({
        payload: payload.payload,
        network: payload.network,
        scheme: payload.scheme,
        x402Version: payload.x402Version,
      }),
    );
    expect(paymentId(reordered, requirements())).toBe(paymentId(payload, requirements()));
  });

  it('payloadHash ignores the requirements, so failover across facilitators dedupes', () => {
    const payload = evmPayload();
    expect(payloadHash(payload)).toBe(payloadHash({ ...payload }));
  });

  it('produces a 64 character lowercase hex digest', () => {
    expect(paymentId(evmPayload(), requirements())).toMatch(/^[0-9a-f]{64}$/);
  });
});
