# PayGuard Build Memory

## Status
- **Phase 0-7**: Completed.
- **Monorepo**: pnpm + turborepo established.
- **Core**: Policy engine, types, and hash-chained audit implemented and tested.
- **Store**: SQLite and Redis implementations completed. SQLite tested.
- **Rails**: Base USDC and XRPL verifiers implemented.
- **Server**: Express middleware and adapters implemented.
- **Client**: Signer interface and client logic implemented.
- **CLI**: Basic commands (init, protect, simulate, audit) implemented.

## Blockers & External Dependencies
- **Coinbase CDP API Keys**: Required for real `CoinbaseFacilitator` operation. Currently using mock implementation.
- **GitHub Token**: Required for `gh` CLI integration (built locally instead).
- **Testnet Faucets**: Required for live end-to-end tests on Base Sepolia and XRPL Testnet.
- **C Compiler**: Required for `better-sqlite3` compilation (installed `build-essential` in sandbox).

## Future Tasks
- Implement full ERC-20 log parsing in `BaseUSDCRail`.
- Implement full XRPL payment verification in `XRPLRail`.
- Add response interceptor for idempotency in `Express` middleware.
- Expand CLI `protect` command to handle full proxy logic.
