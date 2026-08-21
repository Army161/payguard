# PayGuard Threat Model

## Attack Classes

1. **Free-shopping**: Attempting to access a resource without payment.
   - *Mitigation*: Settlement-gated release and independent on-chain verification.
2. **Replay Attacks**: Reusing a valid payment payload for multiple requests.
   - *Mitigation*: Atomic nonce claiming with TTL-based storage.
3. **Duplication (TOCTOU)**: Concurrent requests using the same payload.
   - *Mitigation*: Atomic set-if-absent operations in the store.
4. **Asset Theft**: Redirecting payments to a wrong recipient or asset.
   - *Mitigation*: Independent verification of recipient, asset, and amount.
5. **Service Denial**: Facilitator DoS or failure.
   - *Mitigation*: Multi-rail routing and automatic failover.

## Trust Assumptions

- The buyer's Signer implementation is secure and handles keys safely.
- The RPC nodes used for on-chain verification are reliable.
- The store (Redis/SQLite) is protected from unauthorized access.
