# PayGuard - claude.md (read first, every session)

Product: non-custodial agent-payment guardrail middleware for x402 across XRPL (RLUSD/XRP) and Base (USDC). See plan.md, spec.md, design.md, build_v1.md, tasks.md, memory.md.
Hard rules: never custody keys/funds; local signing only; fail closed; testnet only until audit; no mock/placeholder data; RLS on all Supabase tables; atomic modularity (one file, one purpose); conventional commits; update memory.md after each phase; stop and ask only at architecture-level guesses.
Stack: TS/Node 20, pnpm+turborepo, zod, viem, xrpl.js, x402 SDK (pinned), Redis/SQLite/Postgres, Vitest, fast-check, OTel, Docker.
Style: clear engineering prose, no em dashes.
