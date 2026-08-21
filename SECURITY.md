# Security policy

PayGuard is security middleware. Treat every finding as production affecting even while the
project is pre-audit and testnet only.

## Reporting a vulnerability

Report privately through GitHub Security Advisories on this repository. Do not open a public
issue for an exploitable finding. We aim to acknowledge within 3 business days and to ship a
fix or a documented mitigation within 30 days.

## Supported versions

Pre-1.0. Only the latest published minor receives fixes. There is no long term support branch
until after the third party audit.

## Custody statement

PayGuard never holds customer funds and never reads, stores, transmits, or derives private keys.
Buyer signing happens behind the `Signer` interface in the buyer's own process. See
`docs/compliance-posture.md`.

## Pinned dependencies

Supply chain compromise is part of the threat model, so runtime dependencies are pinned to exact
versions with no caret or tilde ranges, and the lockfile is committed.

| Dependency | Pinned version | Why it is pinned                                                              |
| ---------- | -------------- | ----------------------------------------------------------------------------- |
| `x402`     | `1.2.0`        | x402 protocol reference SDK. Latest published release at the time of pinning. |
| `viem`     | `2.55.19`      | Base rail RPC and receipt/log decoding.                                       |
| `xrpl`     | `5.0.0`        | XRPL rail transaction lookup and validated ledger checks.                     |
| `zod`      | `4.4.3`        | Every untrusted payload boundary is schema validated with zod.                |

### Advisory watch list

We track the following advisory classes and re-evaluate the pin on every release:

- **GHSA-qr2g-p6q7-w82m** (x402 SDK class, recorded in `spec.md` NFR-1). Watch the `x402`
  npm package and the x402 protocol repository advisories. If a fixed version ships, bump the
  pin in `packages/rails/package.json`, re-run the attack class suite, and record the change in
  `memory.md`.
- Advisories affecting `viem`, `xrpl`, `better-sqlite3`, and `ioredis`.

`osv-scanner` runs against `pnpm-lock.yaml` on every push and pull request. A failing scan blocks
the merge.

## Independent verification is mandatory

PayGuard deliberately does not trust a facilitator's word that a payment settled. In `strict` mode
the resource is released only after an independent RPC confirms the on-chain transaction, checks
the recipient, asset, amount, and network, and the nonce claim succeeded atomically. `fast` mode
skips the independent chain confirmation and is recorded in the audit log as lower assurance.

## Mainnet

Mainnet configuration is refused at runtime unless `PAYGUARD_ALLOW_MAINNET=true` is set
explicitly. That flag must stay unset until the third party audit is complete. CI pins it to
`false`.

## Secrets

No secret ever belongs in `payguard.config.ts` or in a committed `.env`. Secrets come from the
environment or a vault adapter. `gitleaks` runs in CI on the full history.
