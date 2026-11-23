# Decision delivery tracking — agent working instructions

This directory tracks **execution and verification**, not product policy. The authoritative accepted decision remains [DECISIONS.md](../../DECISIONS.md) plus the applicable approved feature contract. [AGENTS.md](../../AGENTS.md) governs all agents. Neither a checkbox nor a PR can approve a new business rule.

## Read and update workflow

1. At the start of a task, read `AGENTS.md`, the relevant decision and approved contract, then the matching entry in [REGISTER.md](REGISTER.md). An unlisted task is not automatically authorized.
2. If the task changes a tracked milestone, update its entry **in the same task PR**. Add a narrowly scoped entry when needed; do not conduct an unrelated global backlog rewrite. Preserve existing IDs and links.
3. Record separately: **policy acceptance**, **implemented source**, **merged to main**, **production release/activation**, and **functional acceptance**. These are different events; do not infer later gates from an earlier one.
4. Tick `[x]` only with a directly linked or named verifiable receipt: accepted decision/contract; exact PR + merged state; exact CI/check result when required; deployment/activation report with release identity; reproducible acceptance evidence. If evidence was not inspected, use `[ ]` and say `NOT_VERIFIED`. Record evidence limits and remaining follow-ups in the entry.
5. Use `[x] Closed` only when the scoped acceptance criteria **and all applicable gates** are proven. For production-enabled workers, activation alone is not functional acceptance when initial in-window executions are still unobserved. For documentation-only items, production gates are `NOT_APPLICABLE`; close after documentation review/merge if that is the agreed scope.
6. If code differs from accepted policy, report the drift per AGENTS.md §15. Do not adjust `DECISIONS.md` to match code or mark work complete to suppress the disagreement. A proposal or chat-derived note remains **PROPOSED** until an accepted repository decision/feature contract explicitly authorizes it.
7. Never use the register as permission to deploy, enable flags, migrate, merge, or modify production. Those actions retain their independent authorization, CI, backup, and release gates. Do not auto-close issues or merge PRs merely because a checkbox was updated.

## Entry rules

- Stable identifier: reuse the accepted decision ID when it maps one-to-one (`OVR-6`, `WR-WEEK`); use a distinct `*-DISCOVERY` ID when several deliveries depend on one accepted boundary.
- Always link the authoritative rule and any implementation PR or operational receipt. Include the latest checked date when reporting a changing state.
- Maintain pending proof explicitly. `Unknown` is not the same as `failed`, `not deployed`, or `done`.
- Historical decisions remain in `DECISIONS.md`; this register should remain short and operational. Do not duplicate requirements, acceptance tests, schemas, or state machines here.
- If parallel PRs touch the same entry, reconcile against the current main branch and preserve the other PR's evidence.

The initial register is a **seeded, partial inventory** (2026-11-23), not a claim to cover every existing decision. Expand it with the owning feature work, with verified evidence.
