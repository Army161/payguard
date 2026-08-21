# PayGuard - build_v1.md (ordered, checkable)

Rules: testnet only; no placeholders; every task ends green; commit per task (conventional commits); update memory.md after each phase.

## Phase 0 - Repo

- [ ] pnpm monorepo + turborepo; tsconfig strict; eslint; prettier; vitest; changesets
- [ ] CI (GitHub Actions): lint, typecheck, test, osv-scanner, gitleaks, SBOM
- [ ] Pin x402 SDK to latest audited version; record version + GHSA watch in SECURITY.md

## Phase 1 - @payguard/core (pure)

- [ ] Types: PaymentRequirements, PaymentPayload, Decision, AuditEntry (zod schemas)
- [ ] Policy engine with caps, allowlists, velocity, human threshold; property tests (fast-check)
- [ ] Verifier contract + expiry/skew logic; unit tests
- [ ] Hash-chained audit entry builder; tests

## Phase 2 - @payguard/store

- [ ] Store interface; SQLite impl (atomic claim); Redis impl (SET NX PX); contract tests run against both

## Phase 3 - @payguard/rails

- [ ] base:usdc verifier (viem, Base Sepolia); fixture + live test
- [ ] xrpl:xrp and xrpl:rlusd verifier (xrpl.js, Testnet); fixture + live test
- [ ] Facilitator adapters: coinbase, xrpl-t54 (v1); stripe, xpay stubs behind interface with TODO-free error "not implemented in v1" (documented)
- [ ] Health + circuit breaker

## Phase 4 - @payguard/server (thin slice)

- [ ] Express middleware implementing lifecycle steps 1-7 (design.md)
- [ ] Hono + Fastify adapters sharing core handler
- [ ] Reverse-proxy mode
- [ ] AT-1..AT-4, AT-8 green on Base Sepolia

## Phase 5 - @payguard/client

- [ ] Signer interface; dev raw-key signer (prod-disabled); KMS adapter; Coinbase Agentic Wallet adapter
- [ ] Policy + kill switch + router with failover
- [ ] AT-5, AT-6, AT-7 green across Base Sepolia + XRPL Testnet

## Phase 6 - apps/cli

- [ ] init, protect, simulate (5 attack classes), audit report (markdown + JSON)

## Phase 7 - Docs + packaging

- [ ] README quickstart (<30 min path, timed), threat-model.md, SECURITY.md, compliance-posture.md (non-custodial statement, ToS template)
- [ ] Dockerfile + compose; publish to npm under @payguard (dry-run if no token)
- [ ] Example apps: seller-express, buyer-agent (Claude tool-use)

## Phase 8 - Hosted gateway (slice 2, optional)

- [ ] Supabase schema + RLS; Hono gateway; Next.js dashboard; API keys; usage metering; Stripe billing

## Definition of done v1

All AT-1..AT-8 automated and green; coverage >= 95% core; quickstart timed <= 30 min; Docker image builds; SECURITY.md + threat model present; audit vendor RFQ sent; no mainnet config enabled.
