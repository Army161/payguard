# PayGuard - Claude Code one-shot

Setup: cd into this folder; `claude`. Recommended: enable GitHub MCP, Supabase MCP, XRPL Docs MCP (https://xrpl.org/mcp), and web search. Use `--dangerously-skip-permissions` only inside a disposable container.
Prompt:
Read claude.md, plan.md, spec.md, design.md, build_v1.md, agent.md, tasks.md, memory.md. Then execute build_v1.md autonomously phase by phase using subagents for Builder, Tester, Security, Docs. Use the Task tool to parallelize packages. After each phase: run `pnpm -r test`, tick tasks.md, append memory.md, commit with conventional commits, push. Use the XRPL Docs MCP for every XRPL transaction field and the pinned x402 SDK docs for facilitator calls. Testnet only. Never read or store private keys except via the Signer interface. No placeholders. Do not stop for confirmation except under agent.md escalation rules; log blockers and keep going. Finish when Definition of done v1 is met and print the final report.
