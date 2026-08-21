import { describe, expect, it } from 'vitest';
import {
  AuditEntrySchema,
  GENESIS_HASH,
  appendEntry,
  fromJsonl,
  hashEntry,
  toCsv,
  toJsonl,
  verifyChain,
  type AuditBody,
  type AuditEntry,
} from '@payguard/core';
import { SELLER_BASE, USDC_BASE_SEPOLIA } from './fixtures.js';

function body(overrides: Partial<AuditBody> = {}): AuditBody {
  return {
    requestId: 'req-1',
    agentId: 'agent-1',
    counterparty: SELLER_BASE,
    rail: 'base:usdc',
    network: 'base-sepolia',
    amount: '10000',
    asset: USDC_BASE_SEPOLIA,
    facilitator: 'coinbase',
    mode: 'strict',
    stage: 'release',
    outcome: 'allowed',
    reason: null,
    message: 'released',
    transactionHash: '0xabc',
    paymentId: 'a'.repeat(64),
    timestampMs: 1_700_000_000_000,
    ...overrides,
  };
}

function chainOf(count: number): AuditEntry[] {
  const entries: AuditEntry[] = [];
  let previous: AuditEntry | null = null;
  for (let i = 0; i < count; i += 1) {
    previous = appendEntry(previous, body({ requestId: `req-${i}` }));
    entries.push(previous);
  }
  return entries;
}

describe('audit entries', () => {
  it('validates a complete entry against the schema', () => {
    expect(AuditEntrySchema.parse(appendEntry(null, body()))).toBeTruthy();
  });

  it('starts a chain at sequence zero with the genesis prev hash', () => {
    const first = appendEntry(null, body());
    expect(first.seq).toBe(0);
    expect(first.prevHash).toBe(GENESIS_HASH);
  });

  it('links each entry to the previous hash', () => {
    const [first, second] = chainOf(2);
    expect(second?.prevHash).toBe(first?.hash);
    expect(second?.seq).toBe(1);
  });

  it('hashes the same body to the same digest at the same position', () => {
    expect(hashEntry(body(), 0, GENESIS_HASH)).toBe(hashEntry(body(), 0, GENESIS_HASH));
  });

  it('hashes differently at a different position, so entries cannot be reordered', () => {
    expect(hashEntry(body(), 0, GENESIS_HASH)).not.toBe(hashEntry(body(), 1, GENESIS_HASH));
  });
});

describe('tamper evidence, AT-8', () => {
  it('verifies an untouched chain', () => {
    expect(verifyChain(chainOf(5))).toEqual({ ok: true, length: 5 });
  });

  it('verifies an empty chain', () => {
    expect(verifyChain([])).toEqual({ ok: true, length: 0 });
  });

  it('detects an edited entry body', () => {
    const entries = chainOf(3);
    entries[1] = { ...entries[1]!, amount: '1' };
    expect(verifyChain(entries)).toEqual({ ok: false, brokenAt: 1, reason: 'bad_hash' });
  });

  it('detects a removed entry', () => {
    const entries = chainOf(3);
    entries.splice(1, 1);
    expect(verifyChain(entries)).toMatchObject({ ok: false, brokenAt: 1 });
  });

  it('detects a re-hashed entry whose link no longer matches its predecessor', () => {
    // The strongest attacker: edits an entry and recomputes its hash correctly. The edit still
    // orphans every following entry, because their prevHash points at the old digest.
    const entries = chainOf(3);
    const { seq, prevHash, hash: _stale, ...tamperedBody } = { ...entries[1]!, amount: '1' };
    entries[1] = {
      ...tamperedBody,
      seq,
      prevHash,
      hash: hashEntry(tamperedBody as AuditBody, seq, prevHash),
    };
    expect(verifyChain(entries)).toEqual({ ok: false, brokenAt: 2, reason: 'bad_prev_hash' });
  });

  it('detects an out of order sequence number', () => {
    const entries = chainOf(2);
    entries[1] = { ...entries[1]!, seq: 5 };
    expect(verifyChain(entries)).toEqual({ ok: false, brokenAt: 1, reason: 'bad_sequence' });
  });

  it('detects a hole punched in the array', () => {
    const entries = chainOf(2);
    // A sparse array is what a partial read from a broken exporter looks like.
    delete (entries as unknown as (AuditEntry | undefined)[])[1];
    expect(verifyChain(entries)).toEqual({ ok: false, brokenAt: 1, reason: 'bad_sequence' });
  });
});

describe('audit export, FR-5.3', () => {
  it('round trips through JSONL with the chain still verifiable', () => {
    const entries = chainOf(4);
    const restored = fromJsonl(toJsonl(entries));
    expect(restored).toEqual(entries);
    expect(verifyChain(restored)).toEqual({ ok: true, length: 4 });
  });

  it('emits one line per entry and nothing for an empty chain', () => {
    expect(toJsonl(chainOf(3)).trimEnd().split('\n')).toHaveLength(3);
    expect(toJsonl([])).toBe('');
  });

  it('detects tampering after a JSONL round trip, which is the point of exporting it', () => {
    const text = toJsonl(chainOf(3)).replace('"amount":"10000"', '"amount":"1"');
    expect(verifyChain(fromJsonl(text)).ok).toBe(false);
  });

  it('emits a CSV header naming every column', () => {
    const [header] = toCsv(chainOf(1)).split('\n');
    expect(header).toContain('seq,timestampMs,requestId');
    expect(header).toContain('prevHash,hash');
  });

  it('emits one CSV row per entry', () => {
    expect(toCsv(chainOf(3)).trimEnd().split('\n')).toHaveLength(4);
    expect(toCsv([]).trim()).toBe(
      'seq,timestampMs,requestId,agentId,counterparty,rail,network,asset,amount,facilitator,mode,stage,outcome,reason,message,transactionHash,paymentId,prevHash,hash',
    );
  });

  it('renders a null field as an empty cell rather than the string null', () => {
    const entry = appendEntry(null, body({ agentId: null, reason: null }));
    const [, row] = toCsv([entry]).split('\n');
    expect(row?.split(',')[3]).toBe('');
  });

  it('quotes a value containing a comma, a quote, or a newline', () => {
    const entry = appendEntry(null, body({ message: 'refused, because "x"\nsee log' }));
    const csv = toCsv([entry]);
    expect(csv).toContain('"refused, because ""x""\nsee log"');
  });

  it('does not quote a value that needs no quoting', () => {
    const entry = appendEntry(null, body({ message: 'released' }));
    expect(toCsv([entry])).toContain(',released,');
  });
});
