/**
 * A seller protecting one endpoint on Base Sepolia, which is the thinnest shippable slice from
 * plan.md. Run it with `pnpm --filter @payguard/example-seller-express start`.
 *
 * Everything here is testnet. PayGuard refuses mainnet at runtime until the audit is done.
 */
import express from 'express';
import { BaseUsdcRail, CoinbaseFacilitator } from '@payguard/rails';
import { createStore } from '@payguard/store';
import { payguardExpress, payguardContext } from '@payguard/server/express';
import type { ProtectedRail } from '@payguard/server';

const PORT = Number(process.env.PORT ?? 3402);

// The seller's own address. PayGuard verifies that settlement actually paid THIS address, reading
// the chain through the RPC below rather than believing the facilitator.
const SELLER_ADDRESS = process.env.SELLER_ADDRESS_BASE ?? '0xYOUR_SELLER_ADDRESS';
const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const RPC_URL = process.env.BASE_RPC_URL ?? 'https://sepolia.base.org';

const rail: ProtectedRail = {
  id: 'base:usdc',
  rail: new BaseUsdcRail({
    rpcUrl: RPC_URL,
    network: 'base-sepolia',
    asset: USDC_BASE_SEPOLIA,
  }),
  requirements: {
    scheme: 'exact',
    network: 'base-sepolia',
    // Atomic units. USDC has six decimals, so this is one cent.
    maxAmountRequired: '10000',
    description: 'One generated report',
    mimeType: 'application/json',
    payTo: SELLER_ADDRESS,
    maxTimeoutSeconds: 300,
    asset: USDC_BASE_SEPOLIA,
  },
  // Base is an L2, so one confirmation is a reasonable default. Raise it for larger amounts.
  minConfirmations: 1,
};

const app = express();

// Mounted on the priced route only. Mounting on app.use would put a price on every path.
app.use(
  '/api/report',
  payguardExpress({
    rails: [rail],
    facilitators: [
      new CoinbaseFacilitator({
        // Credentials come from the environment, never from a config file.
        ...(process.env.COINBASE_CDP_API_KEY_ID === undefined
          ? {}
          : {
              apiKeyId: process.env.COINBASE_CDP_API_KEY_ID,
              apiKeySecret: process.env.COINBASE_CDP_API_KEY_SECRET,
            }),
      }),
    ],
    store: await createStore({ kind: 'sqlite', path: './payguard.sqlite' }),
    // strict is the default and the only mode plan.md considers safe: the facilitator settles,
    // then an independent RPC read confirms recipient, asset, amount, network, and depth.
    mode: 'strict',
    onAudit: (entry) => {
      console.log(
        `[payguard] ${entry.stage} ${entry.outcome}${entry.reason === null ? '' : ` ${entry.reason}`}`,
      );
    },
  }),
);

app.get('/api/report', (request, response) => {
  // Reaching here means settlement was confirmed on chain. Nothing else can get past the guard.
  const payment = payguardContext(request);
  response.json({
    report: 'the paid-for content',
    generatedAt: new Date().toISOString(),
    paidWith: payment?.transactionHash,
  });
});

app.get('/health', (_request, response) => response.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`seller listening on http://localhost:${PORT}`);
  console.log(`  GET /api/report  costs 0.01 USDC on Base Sepolia`);
  console.log(`  GET /health      is free`);
  console.log('');
  console.log('Probe it with: npx payguard audit http://localhost:' + PORT + '/api/report');
});
