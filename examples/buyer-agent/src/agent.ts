/**
 * An agent that pays for a resource under a hard spend policy, exposed as a tool an LLM can call.
 *
 * The point of this example is what is NOT here: there is no private key anywhere in this file,
 * and no code path that could read one. The agent hands requirements to a Signer and gets a signed
 * payload back. Swap the signer for a KMS, an HSM, or an MPC wallet and nothing else changes.
 */
import { KillSwitch, PayGuardClient, PolicyDenied, agenticWalletSigner } from '@payguard/client';
import type { PaymentRequirements } from '@payguard/core';

const SELLER_URL = process.env.SELLER_URL ?? 'http://localhost:3402/api/report';

/**
 * Stands in for a Coinbase Agentic Wallet, Turnkey, Privy, or any MPC or TEE custodian. Whatever
 * is behind this call holds the key and returns a payload. PayGuard never learns which.
 */
const signer = agenticWalletSigner({
  address: process.env.BUYER_ADDRESS ?? '0xYOUR_AGENT_ADDRESS',
  provider: 'your-wallet-provider',
  sign: async (requirements: PaymentRequirements) => {
    // Replace this with a call to your wallet provider's SDK. It must return an x402
    // PaymentPayload; PayGuard schema validates it before use, so a malformed response from the
    // wallet fails here rather than as a confusing 402 at the seller.
    throw new Error(
      `wire this to your wallet provider: it should sign ${requirements.maxAmountRequired} of ` +
        `${requirements.asset} to ${requirements.payTo} on ${requirements.network}`,
    );
  },
});

/** Creating .payguard-halt, or setting PAYGUARD_HALT=1, stops every payment within a second. */
const halt = new KillSwitch({ file: '.payguard-halt' });

const client = new PayGuardClient({
  signer,
  agentId: 'research-agent',
  killSwitch: halt,
  // Rails this agent may pay on, most preferred first. A seller cannot steer the choice by
  // listing its most expensive rail first.
  allowRails: ['base:usdc', 'xrpl:rlusd'],
  policy: {
    // Atomic units. USDC has six decimals, so this is 5 cents per call, 1 dollar per hour,
    // 5 dollars per day.
    maxPerTransaction: '50000',
    hourlyCap: '1000000',
    dailyCap: '5000000',
    maxTransactionsPerMinute: 10,
    // Refuse a re-quote more than 5% above the price first advertised.
    priceToleranceBps: 500,
    // Anything at or above 1 dollar needs a person.
    humanApprovalThreshold: '1000000',
    requireTestnet: true,
  },
  onHumanApproval: async ({ requirements, decision }) => {
    console.log(
      `[approval needed] ${requirements.maxAmountRequired} to ${requirements.payTo}: ${decision.message}`,
    );
    // Wire this to Slack, email, or a dashboard. Returning false refuses the payment.
    return false;
  },
  onAudit: (entry) => {
    console.log(`[audit] ${entry.outcome} ${entry.reason ?? ''} ${entry.message}`);
  },
});

/**
 * The tool an LLM calls. Everything the agent can do to your money is bounded by the policy above,
 * and stoppable by the kill switch, regardless of what the model decides to do.
 */
export async function fetchPaidReport(): Promise<unknown> {
  try {
    const result = await client.pay(SELLER_URL);
    if (result.payment !== undefined && !result.payment.delivered) {
      // A payment was presented and the seller answered with something other than a 2xx. Whether
      // the money moved is a question for the audit log, not something the client can assert.
      return {
        error: `seller responded ${result.response.status} after payment on ${result.payment.rail}`,
      };
    }
    return await result.response.json();
  } catch (error) {
    if (error instanceof PolicyDenied) {
      // A refusal is a normal outcome with a machine readable reason, not a crash.
      return { refused: true, reason: error.reason, message: error.message };
    }
    throw error;
  }
}

if (process.argv[1]?.endsWith('agent.ts') === true) {
  console.log(await fetchPaidReport());
}
