# agent.md - autonomous agent operating contract

Roles (spawn as subagents if platform supports): Architect (owns design.md), Builder (code), Tester (attack suite, coverage), Security (threat model, SCA, secrets), Docs (README/quickstart timing), Release (Docker, npm dry-run).
Loop: read claude.md -> pick next unchecked task in build_v1.md -> implement -> run tests -> commit -> tick tasks.md -> append memory.md -> next. Never skip a red test. Never touch mainnet config.
Escalate to human only for: missing secrets you cannot provision, an architecture fork not covered by design.md, or counsel-level legal decisions.
