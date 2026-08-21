import type { AuditEntry } from './entry.js';

/**
 * FR-5.3 export. Two formats because they answer different questions: JSONL keeps the entry
 * exactly as it was hashed, so an auditor can re-verify the chain from the export; CSV flattens it
 * for a spreadsheet, which necessarily loses the nested details field and therefore cannot be
 * re-verified. The CSV header says so.
 */

/** One entry per line, byte-identical to what the hash covers, so the chain survives the export. */
export function toJsonl(entries: readonly AuditEntry[]): string {
  return (
    entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length > 0 ? '\n' : '')
  );
}

const CSV_COLUMNS = [
  'seq',
  'timestampMs',
  'requestId',
  'agentId',
  'counterparty',
  'rail',
  'network',
  'asset',
  'amount',
  'facilitator',
  'mode',
  'stage',
  'outcome',
  'reason',
  'message',
  'transactionHash',
  'paymentId',
  'prevHash',
  'hash',
] as const;

export function toCsv(entries: readonly AuditEntry[]): string {
  const rows = [CSV_COLUMNS.join(',')];
  for (const entry of entries) {
    rows.push(CSV_COLUMNS.map((column) => csvCell(entry[column])).join(','));
  }
  return rows.join('\n') + '\n';
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  // Quote whenever the value could otherwise change the shape of the row. Doubling an embedded
  // quote is what RFC 4180 asks for, and what every spreadsheet expects.
  if (/[",\n\r]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

/** Parses a JSONL export back into entries, so a chain can be re-verified from a file. */
export function fromJsonl(text: string): AuditEntry[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as AuditEntry);
}
