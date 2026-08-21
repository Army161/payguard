/**
 * Deterministic JSON for hashing. Two payloads that differ only in key order or in whitespace must
 * hash the same, or a replay is one `JSON.stringify` away from slipping past the nonce store.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const entry = source[key];
      if (entry === undefined) continue;
      out[key] = sortValue(entry);
    }
    return out;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return value;
}
