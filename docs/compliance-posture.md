# Compliance posture

**This document describes how the software is built. It is not legal advice, and it has not been
reviewed by counsel. `kit/todolist.md` lists a money transmitter opinion as a prerequisite for
general availability, and that item is open.**

## What PayGuard does with money

Nothing. It never receives, holds, controls, or transmits funds, and it never takes a fee from a
payment.

Payments move directly from the buyer's wallet to the seller's address, settled by a third party
facilitator the operator chooses. PayGuard reads the result and decides whether to release a
resource. That is the whole of its involvement.

## What PayGuard does with keys

Nothing. This is a property of the code, not a policy:

- The `Signer` interface has exactly two methods, `address()` and `signPayment(requirements)`.
  Neither returns a private key, a seed, a mnemonic, or anything one can be derived from.
- No PayGuard package imports a key derivation or key generation library.
- `RawKeySigner`, the development signer, does not accept a private key as an argument. The caller
  supplies a signing callback and keeps the key in its own closure, so no key material exists
  inside a PayGuard object at all.
- `RawKeySigner` throws on construction when `NODE_ENV=production`, and refuses to sign on any
  mainnet network regardless of environment.

Production deployments use `kmsSigner` or `agenticWalletSigner`, both of which delegate to a KMS,
HSM, MPC wallet, or TEE that holds the key. PayGuard receives a finished payload and validates it
against the x402 schema before use.

## No float, no yield, no issuance

PayGuard has no balance, no pooled account, no settlement account, and no mechanism to earn on
funds in transit, because no funds are ever in its transit. It does not issue, redeem, or
custody a stablecoin.

## Testnet only, enforced at runtime

`kit/plan.md` forbids mainnet before a third party audit. Two independent mechanisms enforce it:

1. `assertNetworkAllowed` refuses any mainnet network unless the environment variable
   `PAYGUARD_ALLOW_MAINNET` is exactly the string `true`. Anything else, including `1`, `TRUE`, and
   `yes`, is a refusal.
2. The buyer policy's `requireTestnet` defaults to true and refuses mainnet independently, so a
   misconfigured environment is caught by policy and a misconfigured policy is caught by the
   environment.

CI pins the flag to `false`.

## Audit trail

Every decision is written to an append-only, hash-chained log with the fields `kit/spec.md` FR-5.1
requires: request id, agent id, counterparty, rail, amount, facilitator, policy decision, reason
code, settlement proof, and timestamps. Editing an entry breaks the chain from that point on, which
`verifyChain` reports. Export is JSONL and CSV, and a webhook fires on every decision.

This is designed to be what an operator hands an auditor. It is not designed to be, and is not, a
regulatory filing.

## Screening

`kit/spec.md` NFR-5 describes optional screening hooks, off by default. They are not implemented in
v1. An operator with an obligation to screen counterparties must do so outside PayGuard today.

## Open items before general availability

From `kit/todolist.md`, none of which are engineering tasks:

- A money transmitter and non-custodial opinion from counsel.
- A third party security audit, and the bug bounty that should follow it.
- A terms of service that states plainly that the operator, not PayGuard, is the party to any
  payment.

Until the first two are done, this software is testnet only and says so at runtime.
