export interface InitOptions {
  /** Rail to scaffold for. */
  rail: 'base' | 'xrpl';
  /** Seller receiving address, if the operator supplied one. */
  payTo?: string;
}

/**
 * The scaffolded config is deliberately incomplete in one specific way: it has no secrets and no
 * placeholder that looks like one. NFR-1 forbids secrets in config files, so the file reads them
 * from the environment and says so.
 */
export function renderConfig(options: InitOptions): string {
  const base = options.rail === 'base';
  const payTo = options.payTo ?? (base ? '0xYOUR_SELLER_ADDRESS' : 'rYOUR_SELLER_ADDRESS');

  return `import { defineConfig } from '@payguard/core';

// PayGuard reads every secret from the environment. Nothing secret belongs in this file, and
// nothing in this file should ever need to be gitignored.
export default defineConfig({
  // strict: settle, then confirm on chain independently before releasing the resource.
  // fast: trust the facilitator. Lower assurance, recorded as such in the audit log.
  mode: 'strict',

  rails: [
${
  base
    ? `    {
      id: 'base:usdc',
      network: 'base-sepolia',
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      payTo: '${payTo}',
      decimals: 6,
      minConfirmations: 1,
      rpcUrl: process.env.BASE_RPC_URL ?? 'https://sepolia.base.org',
    },`
    : `    {
      id: 'xrpl:rlusd',
      network: 'xrpl-testnet',
      // "CURRENCY.rIssuer". RLUSD from a different issuer is a different asset.
      asset: 'RLUSD.rYOUR_TESTNET_ISSUER',
      payTo: '${payTo}',
      decimals: 6,
      minConfirmations: 1,
      rpcUrl: process.env.XRPL_WSS_URL ?? 'wss://s.altnet.rippletest.net:51233',
    },`
}
  ],

  facilitators: [
${
  base
    ? `    {
      id: 'coinbase',
      url: 'https://x402.org/facilitator',
      rails: ['base:usdc'],
    },`
    : `    {
      id: 'xrpl-t54',
      url: process.env.T54_FACILITATOR_URL ?? 'https://facilitator.example',
      rails: ['xrpl:rlusd', 'xrpl:xrp'],
    },`
}
  ],

  // memory is single process only. Use sqlite for one node, redis for several.
  store: { kind: 'sqlite', path: './payguard.sqlite' },

  // Buyer side policy. Everything here is off until you set it.
  policy: {
    maxPerTransaction: '1000000',
    dailyCap: '50000000',
    maxTransactionsPerMinute: 30,
    priceToleranceBps: 500,
    requireTestnet: true,
  },

  audit: {
    exportDir: './payguard-audit',
  },

  killSwitch: {
    // Creating this file halts every payment within a second.
    file: '.payguard-halt',
    envVar: 'PAYGUARD_HALT',
  },
});
`;
}

export function renderEnvExample(options: InitOptions): string {
  const base = options.rail === 'base';
  return `# PayGuard environment. Never commit a filled in copy of this file.
NODE_ENV=development

# Mainnet is refused at runtime unless this is exactly "true". Leave it unset until the
# third party audit is complete.
# PAYGUARD_ALLOW_MAINNET=false

${
  base
    ? `BASE_RPC_URL=https://sepolia.base.org
COINBASE_CDP_API_KEY_ID=
COINBASE_CDP_API_KEY_SECRET=`
    : `XRPL_WSS_URL=wss://s.altnet.rippletest.net:51233
# Set this instead when your egress policy allows https only.
# XRPL_RPC_URL=
T54_FACILITATOR_URL=`
}

# Creating the halt file, or setting this to 1, stops every payment.
# PAYGUARD_HALT=1

# NEVER put a private key here. The buyer signer is injected in code through the Signer
# interface, and PayGuard has no code path that reads a key.
`;
}
