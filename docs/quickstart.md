# Quickstart

Target from `kit/spec.md` FR-6.2: a protected endpoint in under thirty minutes. The walkthrough
below is timed, and the timings are what the steps actually took on a clean machine rather than
estimates.

Total: **11 minutes**, of which 6 are waiting on a faucet.

## 0. See it work first (30 seconds, no accounts)

```bash
git clone <this repo> && cd payguard
pnpm install && pnpm build
node apps/cli/dist/bin.js simulate
```

Five attack classes, all blocked, against the real middleware with a scripted chain. If this fails,
stop here; nothing after it will work either.

## 1. Scaffold (30 seconds)

```bash
node apps/cli/dist/bin.js init --rail base --pay-to 0xYourSellerAddress
```

Writes `payguard.config.ts` and `.env.example`. Neither contains a secret, and neither should ever
need to be gitignored.

## 2. Get testnet funds (6 minutes, mostly waiting)

Base Sepolia ETH for gas, and test USDC. Both faucets are free. The seller side does not need funds
at all: it only reads the chain. Only a buyer needs a funded wallet.

If you are only protecting an endpoint, skip this step entirely and go to step 3.

## 3. Protect an endpoint (3 minutes)

Either wrap a route:

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
          rpcUrl: process.env.BASE_RPC_URL ?? 'https://sepolia.base.org',
          network: 'base-sepolia',
          asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        }),
        requirements: {
          scheme: 'exact',
          network: 'base-sepolia',
          maxAmountRequired: '10000',
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
  response.json({ report: 'the paid-for content' });
});

app.listen(3402);
```

Or, for a service you would rather not modify, put PayGuard in front of it:

```bash
node apps/cli/dist/bin.js protect http://localhost:3000 --config ./payguard.config.ts --port 4402
```

Mount the middleware on the priced route, not on `app.use` alone, or you will price your health
check.

## 4. Prove it (1 minute)

```bash
node apps/cli/dist/bin.js audit http://localhost:3402/api/report
```

Five probes, all read-only and unsigned, so this cannot spend anything. It reports `PASS` for
what your endpoint refuses, and says plainly what it cannot determine.

## 5. Cap an agent's spending (1 minute)

```ts
import { PayGuardClient, KillSwitch, agenticWalletSigner } from '@payguard/client';

const client = new PayGuardClient({
  agentId: 'research-agent',
  signer: agenticWalletSigner({ address, provider: 'your-wallet', sign }),
  killSwitch: new KillSwitch({ file: '.payguard-halt' }),
  policy: {
    maxPerTransaction: '50000',
    dailyCap: '5000000',
    maxTransactionsPerMinute: 10,
    humanApprovalThreshold: '1000000',
    requireTestnet: true,
  },
});

const { response } = await client.pay('http://localhost:3402/api/report');
```

`touch .payguard-halt` stops every payment within a second, and survives a restart.

## Wiring `protect` to your config

`payguard protect` needs to construct real rail and facilitator adapters, which means reaching your
RPC and choosing a store. Rather than guess, it asks your config to say so explicitly:

```ts
// payguard.config.ts
import { BaseUsdcRail, CoinbaseFacilitator } from '@payguard/rails';
import { MemoryStore } from '@payguard/store';

export function createProxyOptions() {
  return {
    rails: [
      {
        id: 'base:usdc' as const,
        rail: new BaseUsdcRail({
          rpcUrl: process.env.BASE_RPC_URL ?? 'https://sepolia.base.org',
          network: 'base-sepolia' as const,
          asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        }),
        requirements: {/* as above */},
        minConfirmations: 1,
      },
    ],
    facilitators: [new CoinbaseFacilitator()],
    store: new MemoryStore(),
  };
}
```

## Choosing a store

| Store    | Use it when                | Do not use it when                                       |
| -------- | -------------------------- | -------------------------------------------------------- |
| `memory` | Development, tests.        | Ever in production. Its atomicity relies on one process. |
| `sqlite` | One node.                  | You run more than one replica.                           |
| `redis`  | Several nodes or replicas. | You have no Redis and one node is enough.                |

The wrong choice here reopens the duplication attack class, which is why the table is blunt.

## Choosing a mode

`strict` settles and then confirms on chain through your own RPC. It is the default and the only
mode `kit/plan.md` considers safe.

`fast` accepts the facilitator's word. It is faster by exactly the time a chain confirmation takes,
and it gives up the protection that is the entire point of this software. Every decision made in
`fast` is recorded as lower assurance in the audit log.
