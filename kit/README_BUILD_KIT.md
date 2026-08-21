# PayGuard build kit - how to use

1. Drop this whole folder into the agent platform of choice and paste the matching SUPER_PROMPT_*.md.
2. Before launching, fill env.example values you can (faucets are free); leave the rest, agents will log blockers.
3. Recommended connectors/MCPs for zero-touch builds: GitHub, Supabase MCP, Vercel or Fly, XRPL Docs MCP (https://xrpl.org/mcp), web search, Docker. Claude Code: also the XRPL Agent Wallet and Payment Skills from the XRPL AI Starter Kit for the buyer example.
4. Run order: Claude Code or Codex for core code quality; Manus for 24/7 browser-heavy chores (faucets, repo, deploy); Newly for landing page + demo deploy; Grok Build as a second-opinion regeneration of any weak package.
5. Human items live in todolist.md (counsel opinion, audit RFQ, design partners). Everything else is agent work.
6. Files: plan.md (PRD + kill criteria), spec.md (requirements + acceptance tests), design.md (architecture), build_v1.md (ordered tasks), claude.md/agent.md (agent rules), tasks.md/memory.md (state), todolist.md (human), env.example.
