# ADR 0001: the x402 SDK is a development dependency, not a runtime one

Status: accepted, 2026-08-21

## Context

`build_v1.md` Phase 0 requires pinning the x402 SDK to its latest audited version and recording a
GHSA watch. The natural reading is a runtime dependency on `x402`.

Inspecting `x402@1.2.0` changes that reading. Its runtime dependency closure includes
`@solana/kit`, four `@solana-program/*` packages, `@wallet-standard/*`, `wagmi`, `viem`, and
`zod@^3`. `wagmi` is a React hooks library. Pulling that closure into PayGuard would mean a
security middleware whose seller-side process depends on a Solana client and a React state
library that it never calls, and would force `zod@3` alongside the `zod@4` the rest of the
monorepo uses.

`design.md` lists dependency compromise as an explicit threat and calls for a pure core with thin
IO edges. A facilitator is reached over HTTP: `POST /verify`, `POST /settle`, `GET /supported`.
PayGuard needs the wire format, not the SDK's wallet machinery.

## Decision

1. PayGuard implements the x402 v1 wire format directly in `@payguard/core` with `zod@4` schemas.
2. `x402@1.2.0` is pinned as a **development** dependency of `@payguard/rails` and is used only by
   conformance tests, which assert that PayGuard's schemas accept and produce exactly what the
   reference SDK's schemas accept and produce.
3. `SECURITY.md` records the pin and the GHSA watch, as Phase 0 requires. If a fixed version
   ships, the pin moves and the conformance tests re-run.

## Consequences

Good: the runtime tree of a seller-side middleware stays small and auditable. No React, no Solana,
one zod major. A vulnerability in the SDK cannot reach a PayGuard production process, because the
SDK is not in one.

Bad: PayGuard must track x402 spec changes by hand. The conformance tests are the mitigation. They
fail loudly when the reference schemas drift from ours.

Note: `x402@1.2.0` has no XRPL network in its `Network` enum. PayGuard's network schema is a
superset that adds `xrpl` and `xrpl-testnet`. The conformance tests assert the superset relation
in one direction only, so an x402 network added upstream shows up as a failure rather than as a
silent gap.
