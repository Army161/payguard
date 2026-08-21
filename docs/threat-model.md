# Threat model

PayGuard is a control that sits between parties who do not trust each other, so the threat model
starts from the assumption that every one of them may be hostile.

## Trust boundaries

| Party              | Trusted with                                                | Not trusted with                                                                                        |
| ------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Buyer agent        | Nothing. Every field it sends is attacker-controlled input. | Amounts, addresses, nonces, timestamps, headers, idempotency keys.                                      |
| Seller application | Producing the resource after PayGuard says to.              | Nothing about payment. It never sees a payload.                                                         |
| Facilitator        | Being one input to a decision.                              | The decision itself. A `settle` success is not release.                                                 |
| Chain RPC          | Reporting what the chain says.                              | Being available or honest, which is why confirmations and expectations are checked rather than assumed. |
| Signer             | The private key.                                            | The protocol. Its output is schema validated.                                                           |
| PayGuard           | The decision.                                               | Keys, funds, or custody of either. There is no code path that reads a key.                              |

## Attack classes and controls

### 1. Free shopping (grant before settle)

**Attack.** Get the resource without paying, by exploiting a seller that releases on the
facilitator's word, on a `verify` response, or on nothing at all.

**Control.** In `strict` mode the resource is released only after the facilitator settles AND an
independent read of the chain, through an RPC the seller controls, confirms the transaction and
checks recipient, asset, amount, network, and confirmation depth. The reverse proxy does not
contact the upstream at all until that has happened.

**Residual risk.** `fast` mode trades this away deliberately, and every decision made in it is
recorded as lower assurance. An operator who has chosen `fast` has accepted this class.

### 2. Replay

**Attack.** Present the same signed payload more than once.

**Control.** The payment identity is a hash binding the payload to the exact requirements it was
signed against, so the same authorization presented against a different price or recipient is a
different identity and cannot inherit the first one's settlement. That identity is claimed in the
store before verification runs, with a TTL that outlives the payload's validity window.

**Residual risk.** A store whose TTL is shorter than the payload's validity window reopens this.
`nonceTtlMs` computes the TTL from the payload rather than from configuration for that reason.

### 3. Duplication and TOCTOU

**Attack.** Fire many identical requests at once and exploit the window between "check whether this
was used" and "record that it was".

**Control.** There is no window, because there is no check-then-write. The claim is a single atomic
operation in every store implementation: `INSERT ... ON CONFLICT ... WHERE expires_at <= now` in
SQLite, `SET NX PX` in Redis. All three implementations run the same contract suite, which includes
fifty concurrent claims resolving to exactly one winner.

**Residual risk.** The memory store relies on Node being single threaded. That holds in one process
and not in two, which is why it is documented as development only.

### 4. Asset theft (wrong recipient, asset, or amount)

**Attack.** Settle a transaction that looks successful but pays an attacker, pays in a worthless
token, or pays less than the price.

**Control.** The expectation is built from the seller's own configuration, never from anything the
buyer or facilitator sent. On Base, the ERC-20 `Transfer` log is decoded and only logs from the
expected token contract are considered; transfers are grouped by recipient and the largest is
reported rather than the sum, so a payment split between the seller and an attacker cannot look
like a full payment. On XRPL, `meta.delivered_amount` is read rather than the `Amount` field,
because a partial payment delivers less than `Amount` claims.

**Residual risk.** A malicious RPC could lie about a receipt. Running your own node, or two, is the
mitigation; PayGuard cannot check an RPC against itself.

### 5. Service denial

**Attack.** Make the seller unavailable, or make it expensive to refuse you.

**Controls.**

- The payment header has a byte ceiling checked before `JSON.parse` and before zod, so an oversized
  header is not a cheap way to burn CPU.
- A replay is refused without contacting any facilitator, so replaying costs the attacker more than
  it costs the seller.
- A facilitator that fails repeatedly has its circuit breaker opened; half-open admits exactly one
  trial request, so requests queued during an outage do not stampede a recovering facilitator.
- A facilitator adapter that throws anything at all, including an untyped error from a third party
  SDK, is treated as a transport failure of that facilitator rather than becoming a 500 on the
  seller's endpoint.
- The reverse proxy caps request body size and times out upstream requests.

**Residual risk.** PayGuard does not rate limit by IP or by agent identity. Put that in front of it.

### 6. Metadata manipulation of `accepts`

**Attack.** A seller quotes one price, watches the agent commit, then re-quotes higher. Or lists its
most expensive rail first to steer a naive buyer.

**Control.** The buyer's price tolerance rule refuses a re-quote more than a configured number of
basis points above the original, with the ceiling rounded up so it cannot be crossed by one atomic
unit. Rail selection uses the buyer's preference order, not the seller's advertisement order.

### 7. SSRF through facilitator URLs

**Attack.** In a multi-tenant gateway, a facilitator URL read from a database or a dashboard is
attacker-influenced. Point it at an internal address and use PayGuard as a request forwarder.

**Control.** Facilitator URLs must be `https`, or `http` on a loopback host for local development,
and must not embed credentials. The check runs at construction, so a bad URL fails at startup
rather than at the first payment.

**Residual risk.** An `https` URL can still resolve to an internal address. A network egress policy
is the answer to that, not a URL check.

### 8. Dependency compromise

**Attack.** A malicious release of a transitive dependency.

**Controls.** Every runtime dependency is pinned to an exact version with a committed lockfile.
`osv-scanner` runs against the lockfile on every push and pull request, `gitleaks` runs over full
history, and a CycloneDX SBOM is produced per build. The x402 SDK is deliberately a development
dependency rather than a runtime one, which keeps Solana, wagmi, and a second zod major out of a
seller's production process entirely. See ADR 0001.

### 9. Key exfiltration

**Attack.** Get PayGuard to reveal, log, or transmit a private key.

**Control.** There is nothing to reveal. The `Signer` interface has two methods, `address()` and
`signPayment()`, and neither returns key material. `RawKeySigner` does not even accept a private
key: the caller passes a signing callback and keeps the key in its own closure, so no key material
exists inside a PayGuard object to leak. `RawKeySigner` refuses to construct under
`NODE_ENV=production` and refuses mainnet networks outright.

**Residual risk.** Anything in the same process as an in-process key can read it. That is a property
of the process, not of PayGuard, and it is why the raw key signer is development only.

### 10. Audit log tampering

**Attack.** Settle a payment, take the resource, then edit the log.

**Control.** Each entry's hash covers its sequence number, the previous entry's hash, and every body
field, so editing an entry changes its hash and orphans every entry after it. `verifyChain`
recomputes the whole chain and reports where it broke. Appends are serialized: `BEGIN IMMEDIATE` in
SQLite, a token-checked distributed lock in Redis, because a hash chain is inherently sequential
and two concurrent appenders reading the same tail would fork it.

**Residual risk.** An attacker who can rewrite the whole chain from a chosen point can produce a
self-consistent forgery. Anchoring periodic chain heads externally, which v1 does not do, is the
answer. What the chain gives you today is that a partial edit cannot hide.

## Known gaps in v1

- No rate limiting by identity. Use a proxy or gateway in front.
- No external anchoring of audit chain heads.
- Screening hooks (Chainalysis, TRM, Notabene) are named in `kit/spec.md` NFR-5 as optional and
  off by default; they are not implemented in v1.
- The hosted multi-tenant gateway, and its Postgres row-level security, is slice 2.
- `payguard audit` probes are unsigned, so they cannot verify that settlement checking works,
  only that refusal works.
