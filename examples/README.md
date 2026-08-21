# Examples

Two halves of one exchange.

- `seller-express` protects a single endpoint on Base Sepolia with settlement-gated release. It is
  the thinnest shippable slice from `kit/plan.md`.
- `buyer-agent` pays for that endpoint under a hard spend policy, with a kill switch and a human
  approval threshold, and exposes the whole thing as one tool an LLM can call.

Neither example contains a private key, and neither can be made to reveal one. The buyer hands
requirements to a `Signer` and receives a signed payload. That is the entire interface.

## Running them

```bash
pnpm install
pnpm --filter @payguard/example-seller-express start
```

Then, in another terminal, probe it without spending anything:

```bash
node apps/cli/dist/bin.js audit http://localhost:3402/api/report
```

The buyer example needs a wallet provider wired into its signer before it can pay. Until then it
fails with a message telling you exactly what to implement, rather than pretending to work.

To see the whole thing work with no wallet at all:

```bash
node apps/cli/dist/bin.js simulate
```
