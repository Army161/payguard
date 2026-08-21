# PayGuard

Non-custodial guardrails for agent payments over [x402](https://x402.org), across Base (USDC) and
XRPL (RLUSD, XRP).

PayGuard sits between an AI agent and a seller, or between a seller and any x402 facilitator, and
enforces the things the protocol leaves to the implementer: the resource is not released until
settlement is confirmed on chain, a payload cannot be spent twice, concurrent duplicates charge
once, spend is capped, and everything is written to a tamper-evident log.

**Status: pre-audit, testnet only.** Mainnet is refused at runtime unless `PAYGUARD_ALLOW_MAINNET`
is set explicitly, and that flag stays unset until a third party audit is complete.

## Why

A 2026 survey of fifteen production x402 facilitators, covering roughly 99% of settlement volume,
found that every one of them violated at least one security rule, with 31 previously unknown
vulnerabilities across five attack classes: free shopping, replay, duplication and TOCTOU, asset
theft, and service denial.

Every rail ships its own facilitator. None of them ships a neutral safety layer that a seller or a
buyer can put in front of all of them. That is what this is.

## Thirty seconds

```bash
pnpm install && pnpm build
node apps/cli/dist/bin.js simulate
```

```
PayGuard attack simulation

  [BLOCKED] Free shopping: resource released before settlement
            unpaid request produced payment_required, facilitator settle calls: 0
  [BLOCKED] Replay: the same payload spent twice
            first: settled, second: payment_required (replay_detected)
  [BLOCKED] Duplication and TOCTOU: fifty concurrent identical requests
            1 of 50 delivered, 1 settlement(s)
  [BLOCKED] Asset theft: settlement paid to someone other than the seller
            refused with chain_recipient_mismatch
  [BLOCKED] Short payment: settlement delivered less than the price
            refused with chain_amount_insufficient

  5 of 5 attack classes blocked
```

No wallet, no faucet, no network. It runs the real `PayGuardServer` against a scripted chain.

## Protect an endpoint

```ts
import express from 'express';
import { BaseUsdcRail, CoinbaseFacilitator } from '@payguard/rails';
import { createStore } from '@payguard/store';
import { payguardExpress } from '@payguard/server/express';

const app = express();

app.use(
  '/api/report',
  payguardExpress({
    rails: [
      {
        id: 'base:usdc',
        rail: new BaseUsdcRail({
          rpcUrl: process.env.BASE_RPC_URL!,
          network: 'base-sepolia',
          asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        }),
        requirements: {
          scheme: 'exact',
          network: 'base-sepolia',
          maxAmountRequired: '10000', // atomic units: one cent of USDC
          description: 'One generated report',
          mimeType: 'application/json',
          payTo: process.env.SELLER_ADDRESS_BASE!,
          maxTimeoutSeconds: 300,
          asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        },
        minConfirmations: 1,
      },
    ],
    facilitators: [new CoinbaseFacilitator()],
    store: await createStore({ kind: 'sqlite', path: './payguard.sqlite' }),
    mode: 'strict',
  }),
);

app.get('/api/report', (_request, response) => {
  // Reaching here means settlement was confirmed on chain against your own RPC.
  response.json({ report: 'the paid-for content' });
});
```

Hono and Fastify adapters are `@payguard/server/hono` and `@payguard/server/fastify`. For a service
you would rather not modify, `payguard protect <upstream>` runs the same lifecycle as a reverse
proxy and contacts the upstream only after settlement is confirmed.

## Cap what an agent can spend

```ts
import { PayGuardClient, KillSwitch, agenticWalletSigner } from '@payguard/client';

const client = new PayGuardClient({
  agentId: 'research-agent',
  // Whatever holds the key returns a signed payload. PayGuard never sees the key, and has no
  // method that could return one.
  signer: agenticWalletSigner({ address, provider: 'your-wallet', sign }),
  killSwitch: new KillSwitch({ file: '.payguard-halt' }),
  allowRails: ['base:usdc', 'xrpl:rlusd'],
  policy: {
    maxPerTransaction: '50000',
    dailyCap: '5000000',
    maxTransactionsPerMinute: 10,
    priceToleranceBps: 500,
    humanApprovalThreshold: '1000000',
    requireTestnet: true,
  },
  onHumanApproval: async ({ requirements }) => askSomeone(requirements),
});

const { response, payment } = await client.pay('https://seller.example/api/report');
```

`touch .payguard-halt` stops every payment within a second, and survives a restart.

## Audit an endpoint you already run

```bash
npx payguard audit https://your-api.example/priced-endpoint --markdown report.md
```

Every probe is unsigned and read-only, so it cannot move money and does not need a funded wallet.
That also bounds what it can tell you: it shows that an endpoint refuses what it should refuse, not
that it settles correctly. Every report says so. Exit codes are 0 for all-blocked, 1 for a finding,
and 2 for inconclusive, because an endpoint that could not be reached is not a pass.

## What it does

| Requirement                     | How                                                                                                                                                                                                                                                        |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Settlement-gated release (FR-1) | `strict` mode reads the chain through your own RPC after the facilitator settles, and checks recipient, asset, amount, network, and confirmation depth. `fast` mode skips the chain read and is recorded as lower assurance.                               |
| Replay and duplication (FR-2)   | One atomic store operation claims the payment before anything else runs. Fifty concurrent identical requests resolve to exactly one winner.                                                                                                                |
| Buyer policy (FR-3)             | Nine single-purpose rules: kill switch, testnet-only, rail allowlist, counterparty allow and deny, per-transaction max, price tolerance, velocity, hourly and daily caps, human approval. Every rule runs and the outcomes are ranked, deny over escalate. |
| Rail-agnostic failover (FR-4)   | Sellers advertise several rails; buyers pick by their own preference order. Only an explicit 402 triggers trying another rail, because a 5xx is ambiguous about whether the payload settled.                                                               |
| Audit trail (FR-5)              | Hash-chained entries covering sequence and previous hash, so editing one orphans every entry after it. JSONL and CSV export, webhook on every decision.                                                                                                    |

## Packages

| Package            | What it is                                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@payguard/core`   | The policy engine, the verification contract, the x402 wire format, and the audit chain. Pure: no network, no filesystem, no global clock. 100% statement coverage. |
| `@payguard/store`  | Nonce, idempotency, and audit storage. Memory, SQLite, and Redis, all against one shared contract suite.                                                            |
| `@payguard/rails`  | Base (viem) and XRPL (xrpl.js) verifiers, plus Coinbase and t54 facilitator adapters.                                                                               |
| `@payguard/server` | Seller middleware for Express, Hono, and Fastify, plus reverse-proxy mode.                                                                                          |
| `@payguard/client` | Buyer wrapper: policy, kill switch, local signing, failover.                                                                                                        |
| `@payguard/cli`    | `init`, `protect`, `simulate`, `audit`.                                                                                                                             |

## What it does not do

No custody of keys or funds. No float, no yield, no stablecoin issuance. No KYC. No consumer
wallet. PayGuard is not itself a facilitator and does not become one in v1. See
[`docs/compliance-posture.md`](docs/compliance-posture.md).

## Documentation

- [Quickstart](docs/quickstart.md), timed
- [Threat model](docs/threat-model.md)
- [Compliance posture](docs/compliance-posture.md)
- [Security policy](SECURITY.md)
- [ADR 0001: why the x402 SDK is a dev dependency](docs/adr/0001-x402-sdk-is-a-dev-dependency.md)

The original product brief this was built from lives in [`kit/`](kit/): `plan.md`, `spec.md`,
`design.md`, and `build_v1.md`.

## Development

```bash
pnpm install
pnpm build
pnpm test              # unit, attack class, and property tests
pnpm test:coverage     # enforces 95% statements on core
PAYGUARD_LIVE=1 pnpm test:live   # runs against public testnets
```

The Redis store suite boots a real `redis-server` rather than a fake, so install it to run that
part locally.

## Licence

Apache-2.0.
