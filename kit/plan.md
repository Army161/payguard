# PayGuard - plan.md

## One-line

PayGuard is a non-custodial, self-hostable middleware that sits between an AI agent (or a seller's API) and any x402 facilitator, enforcing settlement-gated release, replay and idempotency protection, spend policies, kill-switches, and rail-agnostic failover across XRPL (RLUSD/XRP) and Base (USDC).

## Gate 0 - Validation verdict (done, Aug 21 2026 research)

- Pain: every one of 15 real x402 facilitators (99% of volume) violates at least one security rule; 31 previously unknown vulns; documented attack classes: free-shopping (grant-before-settle), asset theft, service denial, gas abuse, TOCTOU duplication, replay (USENIX Security '26, arXiv 2607.19545; arXiv 2605.11781).
- Who: teams already deploying paying agents (API sellers, agent frameworks, enterprises piloting agent spend).
- Willingness to pay: enterprise governance budgets exist independent of x402 consumer volume. Must be confirmed with 3 design partners (see kill criteria).
- Forward signal: Gartner forecasts 40% of enterprise apps integrate task agents by end-2026. Every rail (Coinbase, Stripe, Cloudflare, XRPL/t54) is locked-in by design; none ships a neutral safety layer.
- Honest risk: x402 settlement volume is down ~93% YTD. We sell correctness/governance, not rail volume.

## Gate 1 - One-page PRD

1. What it does: gates resource delivery on confirmed on-chain settlement, blocks replays and duplicates, enforces per-agent spend caps / allowlists / velocity limits, emits an audit trail, and routes payments across facilitators with automatic failover.
2. Who uses it: (a) sellers exposing x402-priced endpoints; (b) operators running agents that spend; (c) platform teams who need policy + audit.
3. Success (v1 done): a seller wraps an endpoint in under 30 minutes; all 5 documented attack classes are blocked by automated tests; a buyer agent with local keys is hard-capped and killable; one facilitator outage triggers failover with zero lost payments; 95%+ test coverage on core; third-party audit scheduled.
4. NOT do: never custody keys or funds; no float; no yield; no stablecoin issuance; no KYC as VASP; no consumer wallet UI; no its-own-facilitator in v1; no mainnet before audit.
5. Top death risk: "feature not a company" / category shrinks. Mitigation: rail- and protocol-agnostic (x402 now, ACP/AP2/MCP metering adapters next), enterprise framing, open-core distribution.

## Gate 2 - Stack (locked)

- Language: TypeScript (Node 20+). Reason: x402 reference SDKs, xrpl.js, viem are TS-first.
- Packages (monorepo, pnpm + turborepo):
  - @payguard/core - policy engine, settlement verifier, nonce/idempotency store interfaces (pure, no IO)
  - @payguard/server - seller middleware for Express/Hono/Fastify + reverse-proxy mode
  - @payguard/client - buyer-side local-signing wrapper with spend policy + kill switch
  - @payguard/rails - adapters: base-usdc (viem), xrpl-rlusd + xrpl-xrp (xrpl.js), facilitator adapters: coinbase, stripe, xpay, xrpl-t54
  - @payguard/store - Redis and SQLite stores for nonces/idempotency/audit
  - apps/gateway - optional hosted gateway (Hono) with dashboard (Next.js), Postgres via Supabase (RLS on all tables)
  - apps/cli - `payguard init | protect | audit | simulate`
- Auth (hosted only): Supabase Auth, API keys hashed at rest.
- Hosting: self-host via Docker; hosted gateway on Fly.io or Vercel + Supabase.
- Testing: Vitest, testnet-only (Base Sepolia, XRPL Testnet), attack-class test suite, fuzzing via fast-check.
- Observability: OpenTelemetry traces + structured logs; Prometheus metrics.

## Build approach

1. Core policy + verifier (pure, fully tested) -> 2. Base USDC rail + Coinbase facilitator adapter -> 3. XRPL rail + t54 adapter -> 4. Server middleware -> 5. Client wrapper -> 6. Failover router -> 7. CLI -> 8. Attack-class test suite green -> 9. Docker + docs -> 10. Hosted gateway + dashboard (optional slice 2).

## Thinnest shippable slice (Gate 4.5)

Express middleware that protects one endpoint on Base Sepolia via Coinbase facilitator with settlement-gated release + nonce replay protection + idempotency, and passes the free-shopping and replay attack tests. Everything else is slice 2+.

## Monetization

Open-core (Apache-2.0 core). Hosted pro: per protected endpoint + per policy-evaluation tiers. Enterprise: support, SSO, audit exports. No take-rate on payments.

## Kill criteria

- <3 paying pilots within 6 months of GA -> pivot to pure audited SDK or stop.
- Agentic settlement volume still down YoY at 9 months -> reassess.
- Coinbase/Stripe/Cloudflare ship neutral cross-facilitator safety layer -> sell or narrow.
- Counsel says design is money transmission -> stop.
