# PayGuard - design.md (architecture)

## Principles

1. Never touch keys or funds. 2. Verify independently; never trust a facilitator alone. 3. Pure core, thin IO edges. 4. Every decision logged with a reason. 5. Fail closed.

## Component diagram (text)

Buyer agent -> @payguard/client (policy engine -> local signer -> facilitator router) -> HTTP 402 flow -> Seller
Seller app <- @payguard/server (middleware: parse PAYMENT -> verify via facilitator -> independent chain verify -> atomic nonce claim -> settle -> release) <- @payguard/rails
Both -> @payguard/store (nonce, idempotency, audit) -> Redis | SQLite | Postgres
Optional: apps/gateway (multi-tenant proxy + dashboard)

## Core interfaces (TS)

interface Signer { address(): Promise<string>; signPayment(req: PaymentRequirements): Promise<PaymentPayload>; }
interface Rail { id: 'base:usdc'|'xrpl:rlusd'|'xrpl:xrp'; verifyOnChain(proof, expect): Promise<VerifyResult>; }
interface Facilitator { id: string; verify(payload, req): Promise<VerifyResult>; settle(payload, req): Promise<SettleResult>; health(): Promise<Health>; }
interface Store { claimNonce(key, ttl): Promise<boolean>; idem(get|set); appendAudit(entry): Promise<void>; }
interface Policy { evaluate(ctx: SpendContext): Decision; }

## Seller request lifecycle

1. Request without PAYMENT header -> 402 with `accepts[]` (multi-rail), nonce, expiry.
2. Request with PAYMENT header -> parse + schema validate -> expiry/skew check.
3. `store.claimNonce(hash(payload))` atomic; if false -> 402 REPLAY.
4. facilitator.verify -> if fail release nonce claim, 402.
5. facilitator.settle -> tx hash.
6. rail.verifyOnChain(tx hash, {to: seller, asset, amount, network}) with confirmation policy (Base: N blocks; XRPL: validated ledger).
7. Store idempotency response; append audit; release resource.
   Failure at 5/6 in strict mode: resource NOT released; audit records state for reconciliation (no refunds handled by PayGuard; seller tooling exported).

## Buyer lifecycle

1. Receive 402 -> parse accepts -> filter by rail allowlist -> choose by facilitator health + cost.
2. policy.evaluate({amount, counterparty, rail, velocity, caps}) -> allow | deny | require_human.
3. Kill switch check (memory + persisted flag).
4. signer.signPayment (local) -> retry request with PAYMENT header.
5. On facilitator 5xx/timeout -> circuit breaker opens -> next accepted rail; payload hash dedupe prevents double settle.

## Rails

- base:usdc - viem; verify ERC-20 Transfer log to seller, amount, contract == USDC (Base Sepolia / mainnet addresses in config), receipt status 1, confirmations configurable (default 1 on L2).
- xrpl:rlusd / xrpl:xrp - xrpl.js; verify `tx` validated, TransactionType Payment, Destination, delivered_amount (issuer + currency for RLUSD), Memo/SourceTag correlation.

## Facilitator adapters

coinbase (x402 v2 API), stripe (x402 charge), xpay.sh, xrpl-t54 (XRPL x402 facilitator, Verifiable Intent header passthrough). Each adapter normalizes errors to a common enum.

## Store

Redis (SET NX PX) for prod; SQLite (better-sqlite3, BEGIN IMMEDIATE) for single-node; Postgres for gateway (RLS per tenant). Audit log is hash-chained (prev_hash) for tamper evidence.

## Security design

- No private keys in any PayGuard process except the buyer's injected signer (dev raw-key signer prints loud warning; disabled when NODE_ENV=production).
- Secrets from env or vault adapters (AWS Secrets Manager, Doppler, 1Password CLI).
- Rate limiting + body size limits on middleware. Strict JSON schema for PAYMENT payload (zod).
- Threat model doc covers: free-shopping, replay, duplication/TOCTOU, asset theft (wrong recipient), service denial (facilitator DoS), gas abuse, metadata manipulation of `accepts`, SSRF via facilitator URLs (allowlist only), dependency compromise (pinning, provenance).
- CI: lint, typecheck, unit, attack suite on testnets (recorded fixtures + live nightly), SCA (osv-scanner), secret scan (gitleaks), SBOM.

## Data model (gateway)

tenants, api_keys(hash), endpoints, policies, decisions, settlements, audit_entries(prev_hash, hash). RLS: tenant_id = auth.uid() mapping on every table.

## Config (payguard.config.ts)

{ mode:'strict', rails:[...], facilitators:[...], store:{...}, policy:{...}, audit:{...}, killSwitch:{file:'.payguard-halt'} }

## Deploy

Dockerfile (distroless node), docker-compose (app + redis), Helm chart optional; Fly.io for gateway; Vercel for dashboard; Supabase for Postgres/Auth.

## Observability

OTel spans per lifecycle step; metrics: payments_total{rail,facilitator,outcome}, policy_decisions_total{reason}, facilitator_latency, replay_rejections_total.
