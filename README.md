# PayGuard

Autonomous Payment Security for AI Agents and APIs.

## Quickstart

1. Install the CLI:
   ```bash
   pnpm install -g ./apps/cli
   ```

2. Initialize configuration:
   ```bash
   payguard init
   ```

3. Protect an endpoint:
   ```bash
   payguard protect http://localhost:3000
   ```

## Architecture

PayGuard consists of a monorepo with the following packages:

- `@payguard/core`: Types, policy engine, and audit logging.
- `@payguard/store`: Storage interfaces and implementations (SQLite, Redis).
- `@payguard/rails`: Blockchain verifiers (Base, XRPL) and facilitator adapters.
- `@payguard/server`: Web server middleware (Express, Hono, Fastify).
- `@payguard/client`: Buyer-side client with local signing and policy enforcement.
- `payguard-cli`: Command-line tool for management and simulation.

## Security Rules

- **Testnet only**: Never touch mainnet in current version.
- **Non-custodial**: PayGuard never handles private keys outside the Signer interface.
- **Strict Verification**: Settlement-gated release with independent on-chain confirmation.
- **Replay Protection**: Atomic nonce claiming and idempotency.

## License

MIT
