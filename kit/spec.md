# PayGuard - spec.md (functional + non-functional requirements)

## Terms

- Seller: HTTP service pricing resources via x402 (HTTP 402 + PAYMENT-REQUIRED header).
- Buyer: agent/client that signs payments locally.
- Facilitator: third party that verifies and settles payment payloads (Coinbase, Stripe, xpay.sh, XRPL/t54).
- Rail: chain + asset pair (base:usdc, xrpl:rlusd, xrpl:xrp).

## FR-1 Settlement-gated release (seller)

- FR-1.1 Resource MUST NOT be returned until facilitator `/settle` returns success AND (configurable) on-chain confirmation is observed via independent RPC (Base: tx receipt status=1 on configured confirmations; XRPL: validated ledger containing tx hash with tesSUCCESS).
- FR-1.2 Independent verification MUST check recipient == seller address, asset == expected, amount >= price, network == expected.
- FR-1.3 Modes: `strict` (settle + independent chain confirm), `fast` (facilitator settle only, logged as lower assurance). Default strict.

## FR-2 Replay and duplication protection

- FR-2.1 Every accepted payment payload nonce/tx hash MUST be stored with TTL >= max payment validity window; reuse MUST be rejected with 402 + machine-readable error.
- FR-2.2 Idempotency-Key header support: identical key within window returns cached response, never re-charges, never re-delivers without payment.
- FR-2.3 TOCTOU guard: verify and deliver within a single transaction against the store (atomic set-if-absent).
- FR-2.4 Clock skew tolerance and payload expiry enforced server-side.

## FR-3 Buyer policy engine (client)

- FR-3.1 Policies: per-tx max, per-counterparty allow/deny list, daily/hourly spend cap, velocity (tx per minute), asset/rail allowlist, price-change tolerance, human-approval threshold.
- FR-3.2 Local signing only: client accepts a signer interface; PayGuard never reads or stores private keys. Supports raw key signer (dev only), KMS/HSM signer, MPC/TEE wallet signers (Coinbase Agentic Wallets, Turnkey, Privy) via adapter.
- FR-3.3 Kill switch: global and per-agent; toggled via file, env, API, or signal; persists across restarts.
- FR-3.4 Policy decisions logged with reason codes.

## FR-4 Rail-agnostic routing and failover (both sides)

- FR-4.1 Facilitator health checks (latency, error rate, last success); circuit breaker per facilitator.
- FR-4.2 Buyer: if preferred facilitator unhealthy, choose next accepted facilitator/rail advertised by seller.
- FR-4.3 Seller: advertise multiple `accepts` entries (Base USDC, XRPL RLUSD, XRPL XRP) with per-rail facilitator list.
- FR-4.4 Zero double-charge on failover: settlement idempotency enforced across facilitators via payload hash.

## FR-5 Audit trail

- FR-5.1 Append-only log: request id, agent id, counterparty, rail, amount, facilitator, policy decision, settlement proof (tx hash), timestamps.
- FR-5.2 XRPL payments carry SourceTag/Memo with request id; Base payments correlated by tx hash.
- FR-5.3 Export: JSONL and CSV; webhook on every decision.

## FR-6 Developer experience

- FR-6.1 `npx payguard init` scaffolds config; `payguard protect <url>` runs proxy mode; `payguard simulate` replays attack classes against a target; `payguard audit` scans a live endpoint for the 5 attack classes and prints a report.
- FR-6.2 Time-to-first-protected-endpoint <= 30 minutes measured in docs walkthrough.

## FR-7 Hosted gateway (slice 2)

- Multi-tenant proxy, dashboard, API keys, usage metering, Supabase Postgres with RLS on every table, no customer keys ever stored.

## NFR

- NFR-1 Security: no secrets in config files; env/vault only; dependency pinning; SCA in CI; x402 SDK pinned to audited version with GHSA watch (class: GHSA-qr2g-p6q7-w82m).
- NFR-2 Performance: added p95 latency <= 50 ms excluding chain confirmation; store ops O(1).
- NFR-3 Reliability: gateway 99.9%; self-host has no external dependency beyond RPC + facilitator.
- NFR-4 Testing: >= 95% statement coverage on core; attack-class suite MUST pass on every PR; property tests on policy engine.
- NFR-5 Compliance posture: non-custodial, no float, no yield; ToS disclaims custody; optional screening hooks (Chainalysis/TRM/Notabene adapters) off by default.
- NFR-6 Portability: Node 20+, Docker image < 200 MB, runs on Linux/macOS/Windows; client usable from React Native/Electron/Tauri hosts via the same package.

## Out of scope v1

Own facilitator, consumer wallet, fiat on/off ramp, KYC, mainnet before audit, ACP/AP2 adapters (v2).

## Acceptance tests (must be automated)

AT-1 free-shopping: seller returns 402 until settle confirmed. AT-2 replay: second use of same payload rejected. AT-3 duplication: 50 concurrent identical requests -> exactly one charge, one delivery. AT-4 wrong recipient/asset/amount -> reject. AT-5 facilitator down -> buyer fails over to second rail, single settlement. AT-6 spend cap exceeded -> blocked with reason. AT-7 kill switch -> all payments halted within 1 s. AT-8 audit log complete and tamper-evident (hash chain).
