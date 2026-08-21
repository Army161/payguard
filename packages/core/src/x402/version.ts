/**
 * x402 protocol constants. PayGuard implements the v1 wire format directly rather than depending
 * on the reference SDK at runtime. See docs/adr/0001-x402-sdk-is-a-dev-dependency.md.
 */

/** The only x402 protocol version PayGuard speaks. */
export const X402_VERSION = 1 as const;

/** The only payment scheme defined by x402 v1. */
export const X402_SCHEMES = ['exact'] as const;

export type X402Scheme = (typeof X402_SCHEMES)[number];
