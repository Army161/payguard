# memory.md - decisions and state

2026-08-21 Product selected after 3 research passes: PayGuard (replaces Agent CFO; Coinbase Agentic Wallets + Catena Labs own that lane).
2026-08-21 Stack locked: TS monorepo. Rails v1: Base USDC, XRPL RLUSD/XRP. Facilitators v1: Coinbase, XRPL/t54.
2026-08-21 Regulatory posture: non-custodial, no float, no yield; counsel opinion required before GA.
2026-08-21 Phase 0 done. Monorepo is pnpm 10.33 + turborepo, TypeScript 5.9 strict with
noUncheckedIndexedAccess, eslint 9 flat config, prettier, vitest 4, changesets. CI runs lint,
format check, build, typecheck, coverage-gated tests, osv-scanner against the lockfile, gitleaks
over full history, and a CycloneDX SBOM. A separate nightly workflow runs the live testnet suite.
2026-08-21 Architecture decision, recorded as docs/adr/0001: the x402 SDK is pinned at 1.2.0 as a
DEV dependency only, not a runtime one. Its runtime closure pulls @solana/kit, four
@solana-program packages, wagmi (a React hooks library), and zod 3. Putting that inside a seller
side security middleware contradicts design.md's dependency-compromise threat and would force two
zod majors. PayGuard implements the x402 v1 wire format directly with zod 4 and proves equivalence
with conformance tests against the pinned SDK's own schemas. SECURITY.md keeps the pin and the
GHSA-qr2g-p6q7-w82m watch as Phase 0 requires.
2026-08-21 x402 v1.2.0 has no XRPL entry in its Network enum. PayGuard's NetworkSchema is a
superset adding `xrpl` and `xrpl-testnet`. XRPL and Solana payloads both carry an opaque signed
transaction blob under `payload.transaction`, so one schema covers both.
2026-08-21 Phase 1 done. @payguard/core is pure: no network, no filesystem, no global clock.
153 tests, 100% statement and line coverage, 98.84% branch, against a 95/90 gate. Property tests
with fast-check cover atomic arithmetic, canonical hashing, and the policy engine invariants
(an engaged kill switch denies under every configuration; a payment inside every limit is never
denied; crossing the per-transaction cap always denies).
2026-08-21 Policy engine design: every rule runs, then outcomes are ranked, deny over
require_human. Returning at the first hit would report whichever control happened to be checked
first rather than the most severe one, and would let a large over-cap payment escalate to a human
instead of being refused outright.
