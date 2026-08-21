import type { Chain } from '../rail/id.js';

/**
 * Address equality is chain specific. EVM hex addresses are case insensitive, so comparing them
 * with === lets a checksummed address slip past a lowercase expectation and look like a recipient
 * mismatch. XRPL classic addresses are base58 and case sensitive, so folding case there would let
 * a different account pass as the seller.
 */
export function addressEquals(chain: Chain, a: string, b: string): boolean {
  if (chain === 'base') {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }
  return a.trim() === b.trim();
}
