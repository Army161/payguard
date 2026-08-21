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
2026-08-21 Phase 2 done. Three Store implementations behind one interface, all run against the
same exported contract suite: memory, SQLite (better-sqlite3), Redis (ioredis). The Redis suite
boots a real redis-server on a unix socket rather than testing a fake, and CI installs the binary
so the same suite runs there.
2026-08-21 Correction during Phase 2: the first Redis audit append used an optimistic
read-compute-CAS retry loop. It failed the 30-concurrent-appender test, and correctly so. A hash
chain is inherently sequential and Redis Lua has no sha256, so the link cannot be computed server
side; with N concurrent appenders an optimistic loop only lets one win per round and does not
converge. Replaced with a short lived distributed lock (SET NX PX plus a token-checked Lua
unlock), keeping the compare-and-swap inside the append script as a second line of defence for a
lock that expires under a stalled writer. Nonce claims stayed optimistic, because SET NX PX is a
single atomic operation and needs no lock.
2026-08-21 SQLite claim is one INSERT ... ON CONFLICT DO UPDATE ... WHERE expires_at <= now
statement, so SQLite picks the winner. The audit append runs inside BEGIN IMMEDIATE, which takes
the write lock up front; without IMMEDIATE two appenders can read the same tail and fork the chain.
2026-08-21 Phase 3 done. Rails and facilitator adapters, 155 tests, plus a live suite that runs
against real public testnets.
2026-08-21 The x402 conformance tests pass against the pinned SDK's own zod schemas. PayGuard's
hand-written wire format accepts and rejects exactly what x402 1.2.0 does for requirements,
payloads, verify responses, and settle responses, and its network enum is a strict superset in the
order the SDK declares. One deliberate divergence, asserted explicitly: PayGuard accepts any
non-empty facilitator error reason string where the SDK pins an enum, because a facilitator that
invents a reason should not crash a seller.
2026-08-21 Base rail reads the ERC-20 Transfer log rather than trusting the receipt status. It
groups transfers by recipient and reports the largest, never the sum across recipients: summing
would let a payment split between the seller and an attacker look like a full payment.
2026-08-21 XRPL rail reads meta.delivered_amount, not the Amount field. A partial payment delivers
less than Amount claims, and reading Amount is exactly how a partial payment passes as a full one.
Issued currency values are decimal strings, converted to atomic units with string arithmetic that
refuses excess precision rather than rounding it away.
2026-08-21 Architecture addition beyond design.md: the XRPL rail takes a pluggable transport,
websocket (xrpl.js) or HTTPS JSON-RPC. Independent verification is the security critical path and
many enterprise egress policies allow outbound HTTPS only. Forcing a websocket there would leave
the seller choosing between no independent check and a hole in its egress policy. Both transports
run the same rail code. Also handles both rippled response shapes: API v2 nests the transaction
under tx_json, older JSON-RPC inlines it on the result.
2026-08-21 Live testnet verification performed and pinned. Base Sepolia USDC transfer
0x0394c657...113a0 decodes to recipient 0xf006A181...404B8 for 1000 atomic units and passes
checkSettlement; the same observation is refused with chain_recipient_mismatch against a different
expected seller. XRPL Testnet Payment 2B72C0CA...D8AB decodes to rKZaYLb4...jHpc for 100000000
drops and passes; the same observation is refused with chain_asset_mismatch when the seller expects
RLUSD. The XRPL fixture is the Testnet faucet funding a fresh account; its seed was discarded.
2026-08-21 Facilitator adapters refuse a non-https URL and a URL with embedded credentials, which
is the SSRF entry in design.md's threat model. Stripe and xpay are declared as explicitly
unimplemented adapters that throw a typed not_implemented error naming build_v1.md and report
unhealthy, so the router skips them during failover rather than routing payments into a dead end.
2026-08-21 The health monitor does not count a facilitator's legitimate rejection (a malformed
payload, a 400) against its breaker. Counting it would open the breaker on a buyer's mistake.
2026-08-21 Phase 4 done. Seller middleware, 55 tests. AT-1, AT-2, AT-3, AT-4 and AT-8 are green.
2026-08-21 The lifecycle lives in one framework-neutral handler, and Express, Hono, Fastify and
the reverse proxy are transport only. The ordering is the security property: claim the nonce
before verifying, verify before settling, settle before confirming, confirm before releasing. Any
reordering reintroduces one of the documented attack classes, so it is written once rather than
four times.
2026-08-21 Failover rule on the seller side: a facilitator that says "this payload is invalid" has
answered the question, so a rejection stops the loop. Only transport level failures move to the
next facilitator. Retrying a rejection elsewhere is not failover, it is shopping for a yes, and it
is how a bad payload eventually finds a lenient verifier. There is a test for this.
2026-08-21 When settlement happened but did not match the expectation (wrong recipient, short
payment), the nonce claim is deliberately NOT released. The money moved, so releasing the claim
would let the same payload be presented again. The audit entry carries the transaction hash and a
reconciliation note instead. Verification failures before settlement do release the claim, so an
honest buyer can retry.
2026-08-21 Correction during Phase 4: the first Fastify adapter was an ordinary encapsulated
plugin, so its hooks never applied to routes registered on the parent instance and every request
sailed through unguarded. Caught by driving a real Fastify server over a socket. Fixed by setting
Symbol.for('skip-override') on the plugin, which is what fastify-plugin does, keeping the
dependency count at zero. Also stopped awaiting reply.send() inside the onRequest hook: awaiting a
Fastify reply waits for the response to flush, which deadlocks against the hook that returns it.
2026-08-21 Express buffers the downstream response rather than streaming it, because FR-2.2
requires a retry to replay the same bytes and bytes already flushed to a socket cannot be
replayed. Documented in the adapter.
2026-08-21 Dropped the `declare module 'express-serve-static-core'` augmentation. It leaks into
every consumer's type graph whether or not they use PayGuard and fails to resolve for anyone with
Express as a transitive dependency. Callers use payguardContext(request) instead.
2026-08-21 A failing audit webhook is swallowed. The durable append already happened, and FR-5.3
must not be able to take the payment path down with it. There is a test that a throwing onAudit
still yields a settled outcome.
