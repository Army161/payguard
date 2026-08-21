# tasks.md - mirror of build_v1.md checkboxes; agents tick here and log in memory.md

Current phase: 3 complete. Blockers: see BLOCKERS below.

## Phase 0 - Repo

- [x] pnpm monorepo + turborepo; tsconfig strict; eslint; prettier; vitest; changesets
- [x] CI (GitHub Actions): lint, typecheck, test, osv-scanner, gitleaks, SBOM
- [x] Pin x402 SDK to latest audited version; record version + GHSA watch in SECURITY.md

## Phase 1 - @payguard/core (pure)

- [x] Types: PaymentRequirements, PaymentPayload, Decision, AuditEntry (zod schemas)
- [x] Policy engine with caps, allowlists, velocity, human threshold; property tests (fast-check)
- [x] Verifier contract + expiry/skew logic; unit tests
- [x] Hash-chained audit entry builder; tests

## Phase 2 - @payguard/store

- [x] Store interface; SQLite impl (atomic claim); Redis impl (SET NX PX); contract tests run against both

## Phase 3 - @payguard/rails

- [x] base:usdc verifier (viem, Base Sepolia); fixture + live test
- [x] xrpl:xrp and xrpl:rlusd verifier (xrpl.js, Testnet); fixture + live test
- [x] Facilitator adapters: coinbase, xrpl-t54 (v1); stripe, xpay stubs behind interface
- [x] Health + circuit breaker

## Phase 4 - @payguard/server

- [ ] Express middleware implementing lifecycle steps 1-7
- [ ] Hono + Fastify adapters sharing core handler
- [ ] Reverse-proxy mode
- [ ] AT-1..AT-4, AT-8 green

## Phase 5 - @payguard/client

- [ ] Signer interface; dev raw-key signer (prod-disabled); KMS adapter; agentic wallet adapter
- [ ] Policy + kill switch + router with failover
- [ ] AT-5, AT-6, AT-7 green

## Phase 6 - apps/cli

- [ ] init, protect, simulate (5 attack classes), audit report (markdown + JSON)

## Phase 7 - Docs + packaging

- [ ] README quickstart, threat-model.md, SECURITY.md, compliance-posture.md
- [ ] Dockerfile + compose; npm publish dry-run
- [ ] Example apps: seller-express, buyer-agent

## Phase 8 - Hosted gateway (slice 2, optional)

- [ ] Deferred. Slice 2 per plan.md.

## BLOCKERS (logged, build continues per agent.md)

None yet.
