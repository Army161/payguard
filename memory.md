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
2026-08-21 Phase 5 done. Buyer client, 47 tests. AT-5, AT-6 and AT-7 are green, driven against a
real Express seller guarded by @payguard/server over a socket rather than against a mock.
2026-08-21 The Signer interface returns a signed payload and nothing else. It has no method that
returns a key, a seed or a mnemonic, and no PayGuard code path asks for one. RawKeySigner does not
even accept a private key: the caller supplies a signing callback and keeps the key in its own
closure, so no key material ever lives inside a PayGuard object. RawKeySigner throws under
NODE_ENV=production and refuses mainnet networks outright.
2026-08-21 RemoteSigner schema validates whatever the backend returns and checks the network
matches. A signing backend is trusted with the key, not with the protocol; a malformed payload
from a wallet SDK should fail at the buyer rather than as a confusing 402 at the seller.
2026-08-21 The kill switch caches its file check for at most one second. A synchronous stat on
every payment costs latency NFR-2 has a budget for, and the cap is what keeps AT-7's one second
requirement satisfiable. The clamp has its own test.
2026-08-21 Two real bugs found by the AT-5 tests, both fixed:
(a) Seller: a facilitator adapter that threw a plain Error (rather than FacilitatorError)
escaped verifyAndSettle and became a 500 on the seller's endpoint. Third party adapter code can
throw anything, so one misbehaving facilitator was a denial of service the buyer got for free.
Unrecognised throws are now wrapped as a transport failure of that one facilitator and the
router moves on.
(b) Buyer: the client treated every non-402 response as a successful payment, so a 500 was
recorded as a completed spend and returned as success. Now only 2xx is reported as delivered.
2026-08-21 Deliberate design decision on buyer failover: only an explicit 402 triggers trying
another rail. A 5xx is ambiguous about whether the payload settled, and paying again on another
rail after an ambiguous failure is exactly the double charge FR-4.4 forbids. A non-2xx response is
still recorded as spent, because a spend cap that under-counts is worse than one that over-counts.
2026-08-21 Phase 6 done. CLI with init, protect, simulate and audit. 26 tests, including running
the built binary as a subprocess so the wiring is covered rather than just the library functions.
2026-08-21 `payguard simulate` runs all five attack classes against a real PayGuardServer with a
scripted chain and facilitator. No wallet, no faucet, no network. It is the thirty second
demonstration, and it exercises the same code path a deployment does rather than a parallel one.
2026-08-21 `payguard audit` probes are unsigned and read only by design. An operator runs this
against their own endpoint, so it must not be able to move money even by accident and must not
need a funded wallet to be useful. The cost is that it cannot prove settlement is verified, only
that the endpoint refuses what it should refuse, and every report says so in a Limits section.
The forged payload carries a recognisable marker ("payguardaudit", all-zero signature) so an
operator finding it in their logs can tell it apart from an attacker.
2026-08-21 Two bugs found while testing the CLI:
(a) runAudit skipped every probe when the seller produced no readable 402 body. That turned the
single most important finding, an endpoint serving its resource for free and therefore having no
accepts list at all, into five inconclusive rows. Probes that do not need the quote now always
run.
(b) The simulated facilitator accepted any payload, so `payguard audit` against
`payguard protect --demo` correctly reported a vulnerability that existed only in the stub. The
scripted facilitator now refuses an all-zero signature and the audit marker, the way a real one
refuses an unsigned payload.
2026-08-21 audit exit codes: 0 everything blocked, 1 something vulnerable, 2 nothing vulnerable but
something inconclusive. An unreachable endpoint must not look like a clean bill of health in CI.
2026-08-21 Phase 7 done. README, timed quickstart, threat model, compliance posture, Dockerfile,
docker-compose, and both example apps. All six packages pass npm pack --dry-run.
2026-08-21 The threat model documents residual risk for every control rather than only the control.
A threat model that lists only what is defended reads as marketing; the useful part is where the
line is. Ten classes covered, with the v1 gaps listed explicitly at the end (no identity rate
limiting, no external anchoring of audit chain heads, screening hooks not implemented, hosted
gateway is slice 2, audit probes are unsigned so they cannot verify settlement checking).
2026-08-21 The compliance posture document states the non-custodial claim as properties of the code
that a reader can check: the Signer interface has two methods and neither returns key material, no
package imports a key derivation library, and RawKeySigner does not accept a private key at all.
Also states plainly that it is not legal advice and that counsel has not reviewed it.
2026-08-21 Docker could not be built here (no daemon), logged as blocker 1. Rather than assert the
NFR-6 size target on faith, scripts/image-size.sh reproduces the Dockerfile's prune exactly and
measures it: 101 MB of runtime payload, and the pruned tree still passes payguard simulate.
2026-08-21 The prod install for the image excludes optional peers (express, hono, fastify,
better-sqlite3, ioredis) and then removes TypeScript, which viem, zod and abitype declare as an
optional peer for type-level features only and which is 23 MB of pure dead weight at runtime. That
took the payload from 175 MB to 101 MB.
2026-08-21 The quickstart is timed with real measured numbers, 11 minutes of which 6 are faucet
waiting, against the 30 minute target in spec.md FR-6.2. The 30 second no-account path
(pnpm install, pnpm build, payguard simulate) is first, so a reader can decide whether to continue
before creating any account.
2026-08-21 Gap found by re-reading spec.md against the README: FR-5.3 requires JSONL and CSV export
and the README claimed it, but it was not implemented. Written now, with `payguard export`.
JSONL preserves each entry byte-identically to what the hash covers, so a recipient can re-verify
the chain from the file; CSV flattens for a spreadsheet and therefore cannot be re-verified, and
the two formats are documented as answering different questions rather than as interchangeable.
The chain is verified during export, so an operator cannot hand an auditor a tampered file without
being told, and a partial export says outright that it cannot be verified from its own contents.
2026-08-21 Added docs/acceptance-tests.md mapping AT-1 to AT-8 to the specific test suites that
cover each, plus a Definition of Done table with honest status. Docker image build is the one item
marked not verified, with the reason and the mitigation.
