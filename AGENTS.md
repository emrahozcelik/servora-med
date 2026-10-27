# AGENTS.md — Servora-Med Coding Discipline

This file is the mandatory operating contract for every AI agent, coding assistant, or human contributor working on Servora-Med.

Servora-Med is a web-based B2B sales, CRM, Kanban job tracking, product delivery, and staff management system for medical/dental product companies.

Reliability, data integrity, operational auditability, mobile usability, and small verifiable changes matter more than clever abstractions or broad refactors.

---

## 0. Primary Goal

Build Servora-Med as a VPS-ready, browser-based business operations platform.

Core product goals:

* Web-based access from office and field
* Mobile-friendly browser UI
* PostgreSQL database
* Fastify backend
* React/Vite frontend
* Role-based access
* Customer and contact tracking
* Product catalog
* Staff profiles
* JobCard-based Kanban workflow
* Product delivery tracking
* Manager approval workflow
* Activity/audit history
* Basic reports
* Backup and restore safety

Do not import domain concepts from unrelated legacy systems. Model medical/dental B2B sales only.

---

## 1. Non-Negotiable Core Rules

1. **Do not assume. Surface uncertainty.**
   If something is unclear, state what is unclear instead of silently guessing.

2. **Prefer the smallest correct solution.**
   Follow KISS and YAGNI. Do not add speculative flexibility, new abstraction layers, new configuration systems, new dependencies, or new frameworks unless directly required by the current slice.

3. **Make surgical changes only.**
   Every changed line must be traceable to the user request, plan item, issue description, or acceptance criteria.

4. **No drive-by refactors.**
   Do not fix unrelated code, comments, formatting, naming, or structure.

5. **Do not mark unclear work as done.**
   If the success criteria are not clear, define what “done” means before claiming completion.

6. **Never fake verification.**
   If a command was not run, say it was not run. If a command failed, report the failure.

7. **Prefer one safe vertical slice over broad risky work.**
   If the task is large, complete one correct slice with tests and clear notes instead of touching many areas loosely.

8. **Documentation-only tasks stay documentation-only.**
   Do not start implementation when the requested task is planning, review, or documentation.

---

## 2. Architecture Principles

Servora-Med should remain a modular monolith until the MVP is stable.

### 2.1 Single Source of Truth

* Do not duplicate state, schemas, constants, permissions, or business logic.
* Backend domain rules are the source of truth.
* Frontend must not invent business rules that contradict backend validation.
* Database constraints should protect critical invariants whenever possible.
* Reports must be derived from persisted data, not frontend state.

### 2.2 Fix the Source

* Do not patch symptoms downstream.
* If data is missing or wrong, fix the producer, mapper, contract, query, or service that owns it.
* Do not add compatibility fallbacks unless a migration path explicitly requires it.

### 2.3 SOLID / GRASP / Practical Modularity

* Keep handlers, services, repositories/queries, mappers, UI components, and hooks focused.
* Keep business logic out of route/handler glue.
* Keep database access isolated from UI/client logic.
* Place behavior near the data and rules it needs.
* Prefer high cohesion and low coupling.
* Avoid speculative generic abstractions.

### 2.4 Separation of Concerns

Backend:

* `routes.ts` wires endpoints and middleware.
* `handlers.ts` translates HTTP/WebSocket input/output.
* `service.ts` owns domain behavior and transactions.
* `types.ts` owns DTOs, row mapping, and module-level types.
* DB migrations own schema changes.

Frontend:

* Pages compose user flows.
* Hooks own reusable client-side behavior.
* Services own API/WebSocket calls.
* Store holds UI/app state only.
* UI components must not call raw backend endpoints directly when a service function exists.

### 2.5 Repository Discovery

When Codebase Memory is available, agents may use it to discover relevant files,
directories, symbols, and relationships before broad filesystem searches. Its
graph is an advisory index; verify paths and behavior against the current Git
checkout, source files, and tests. Cache updates alone are not source drift.
If unavailable or stale, use `rg`, `git grep`, or equivalent tools. Do not reset
or reindex the graph unless the task needs it and the user authorizes it.

---

## 3. Domain Change Protocol

Domain policy belongs to the accepted documents in §15. Read the latest
applicable `DECISIONS.md` record, product requirement, and approved feature
contract before changing a business rule. Backend services, DTOs, migrations,
and tests show the implemented behavior; they do not authorize new policy.

* Keep JobCard operations inside their accepted ownership boundaries. Read
  `PRODUCT_REQUIREMENTS.md` for workflows and the applicable `docs/features/`
  contract for later slices; do not introduce a competing workflow or schema.
* For lifecycle work, inspect `server/src/modules/job-cards/types.ts`,
  `policy.ts`, and the named command service. Reference their vocabularies
  instead of maintaining another type/status/transition list here or in UI.
  Terminal status sets constrain normal lifecycle commands and active-slot
  occupancy. They do **not** prohibit the separate, authorized ADMIN
  invalidation command on a completed or cancelled historical card. See the
  accepted [data lifecycle contract](docs/features/visit-to-sale/visit-to-sale-data-lifecycle.md)
  and the existing `invalidate()` service; invalidation does not reopen work.
* Preserve mandatory manager approval and backend role/scoping enforcement.
  Submission readiness, structured delivery fields, contact/customer
  relationships, staff profile visibility, and report attribution follow their
  owning product/API/schema contracts. Do not substitute free-text notes for
  fields the contract requires to be structured.
* Critical mutations and their audit/activity records commit together. Preserve
  historical snapshots and append-only history; do not infer report facts from
  client state or reinterpret existing business events.
* Product catalog semantics belong to `DECISIONS.md` DOM-004 and
  `SERVORA_MED_API_DRAFT.md` §9. Compare the canonical Product DTO in
  `server/src/modules/products/types.ts` before changing fields. Storage column
  names do not authorize pricing, inventory, tracking-policy, or financial
  features. Future module boundaries belong to MOD-001.
* When implementation and accepted policy disagree, follow §15's drift process;
  do not silently change either side to make them match.

---

## 4. Scope and Change Authorization

`PRODUCT_REQUIREMENTS.md` owns product scope; the latest accepted decisions and
approved feature plans record explicit extensions and their rollout boundaries.
`SERVORA_MED_MVP_SLICES.md` owns delivery order and slice acceptance. Do not keep a
second MVP feature inventory in this contract.

Read the applicable plan before implementation. Distinguish accepted intent,
implemented behavior, verified behavior, and deferred work in reports. An approved
design or a stub is not proof that a feature has shipped.

Keep changes inside the requested vertical slice. New modules, integrations,
frameworks, dependencies, or product behavior require concrete authorization;
§13 and `DECISIONS.md` UI-002 / MOD-001 remain binding. Do not create empty future
modules or generic infrastructure without a current producer/consumer need.

---

## 5. Security Rules

* Do not weaken authentication to make a UI flow easier.
* Do not store raw passwords, PINs, tokens, or secrets.
* Do not log passwords, PINs, tokens, session IDs, or sensitive payloads.
* Production CORS must not be open-ended.
* Manager-only actions must be enforced on the backend, not only hidden in the UI.
* Staff-scoped data access must be filtered by authenticated user and role.
* Do not expose detailed health, environment, or infrastructure information to unauthenticated clients.
* Error messages should be useful but must not leak sensitive internals.
* VPS/public internet assumptions require rate limiting and careful auth handling.

---

## 6. Database and Migration Rules

* Schema changes must be done through migrations.
* Never modify an already-applied migration unless this is a pre-production reset task explicitly approved by the user.
* Critical invariants should be protected by backend validation and, where possible, database constraints.
* Migrations must be safe to run once and fail clearly if assumptions are wrong.
* Do not rely only on frontend validation for business-critical data.
* Do not introduce drift between SQL schema, TypeScript row types, and API DTOs.
* Prefer soft delete or status-based deactivation for business records.

Critical invariants include:

* staff cannot directly complete a manager-approved job
* completed jobs cannot be edited by normal staff
* cancelled jobs cannot be silently reactivated
* product delivery approval requires valid delivery items
* every critical JobCard transition creates an activity log
* idempotent actions cannot create duplicate business events

---

## 7. Idempotency and Concurrency Rules

Any operation that creates or changes important business state must be idempotent.

Examples:

* JobCard creation
* status transition
* approval request
* manager approval
* revision request
* cancellation
* product delivery item creation
* activity log creation tied to mutations

Rules:

* `clientActionId` or equivalent idempotency key must be validated and persisted consistently where needed.
* Avoid check-then-act races.
* Use transactions for multi-step domain operations.
* Use row locking or atomic claims where duplicate execution would cause damage.
* Duplicate requests must either return the original result or a clear in-progress/conflict response.
* Do not create side effects before idempotency state is safely claimed.

---

## 8. Frontend Rules

* Frontend state must reflect backend truth.
* Do not implement hidden business rules only in React.
* Every critical action must show loading, success, and error states.
* Mobile usability is required from the start.
* Do not assume realtime is always connected.
* Optimistic UI is allowed only where rollback/reconciliation is safe.
* Staff and manager views may differ, but permission enforcement must remain backend-owned.
* Avoid adding large UI frameworks unless explicitly requested.

---

## 9. Testing and Verification Rules

Every meaningful implementation change must include or update tests unless the user explicitly scopes the task as documentation-only.

Minimum expected commands:

```bash
cd server && npm run build
cd server && npm test -- --run
cd web && npm run build
```

Local server test environment contract (fail-closed):

* `npm test` requires an explicit `TEST_DATABASE_URL`. There is no `DATABASE_URL`
  fallback and no silent database-name rewrite, so two worktrees cannot silently
  share one persistent database.
* The URL must be password-bearing and loopback. Local runs must use an
  explicitly isolated database name such as `servora_med_test_<suffix>`; the
  shared `servora_med_test` is reserved for CI's ephemeral service container.
* PostgreSQL 17 is required for both the server and the
  `psql`/`pg_dump`/`pg_restore` client tools. A PostgreSQL 16 host is refused
  before Vitest starts.
* The database schema must be at the exact repository migration head. The
  preflight is read-only and never migrates.
* Build before test: `npm run build` produces `dist/db/migrate.js`,
  `dist/db/schema-check.js` and `dist/db/migrations`, which the suite executes.
* An environment-dependent test that cannot execute must report SKIPPED, never
  PASSED.

See [docs/operations/local-test-environment.md](./docs/operations/local-test-environment.md).

Local-first CI (when GitHub-hosted runners are unavailable):

* Reproduce the full CI contract locally with `ops/local-ci/run.sh --sha <sha>`
  (Colima Docker: Ubuntu `node:22` containers + `postgres:17` service). It emits
  a hash-bound evidence bundle outside the checkout; verify it with
  `ops/local-ci/verify-evidence.sh`. Never report unexecuted checks as passed —
  `ABSENT`/`NOT_RUN` fail the manifest.
* Production deploys keep the existing safety chain in `ops/deploy-production.sh`.
  GitHub-CI mode is the default; local-evidence mode (`--ci-mode local
  --evidence <bundle>`) is explicitly selected per invocation. There is no
  `--skip-ci`/`--force` bypass. Credential file provisioning and the full gate
  list live in [docs/operations/production-deployment.md](./docs/operations/production-deployment.md).
* The production release artifact must be Linux-compatible: `linux-compat`
  evidence requires zero native/platform-restricted production dependencies.
  Do not package a platform-specific `node_modules` into a release.
* Local CI resource safety: `ops/local-ci/run.sh` pins the verified Colima
  daemon and removes only resources with proven run ownership. Docker removes
  the owned PG container and its anonymous volumes together; named/shared
  volumes remain protected. Cleanup diagnostics are preserved separately from
  the original CI result. Never run broad cleanups (`docker system/volume prune`, `colima
  delete`, `limactl delete`) as part of CI work. Never use `git stash` to
  juggle worktree state; use explicit patch files or commits instead.
  See [docs/operations/local-ci-resource-recovery.md](./docs/operations/local-ci-resource-recovery.md).

* Post-merge resource retirement is a **separate, mandatory closure step**,
  never part of an active CI run. After an authorized merge, first complete
  resulting-main exact-SHA CI, cleanup/verifier, and the merge report.
* Inventory the precise Colima Docker daemon and Lima instances, active
  processes/CI locks, owned containers/networks/volumes, VM disks, and
  downstream evidence requirements before any destructive operation.
* Retire only positively identified, quiescent, **disposable Servora-Med-only**
  environments no longer needed by an authorized task. The dedicated
  `colima true` CI profile may be stopped/deleted to reclaim its VM disk
  after those gates; individually identified test-only Lima guests may be
  retired on the same terms. Never use wildcard deletion, global Docker
  prune, or infer ownership from a name alone. Unknown, shared, active, or
  still-needed resources are **HOLD**, not delete.
* Never touch production hosts, the canonical checkout, unrelated worktrees,
  stashes, or other projects' VM/volume data. Preserve acceptance/deploy-needed
  exact-SHA evidence **as actual files** in independently verified storage
  before deleting any VM/workspace; manifest hashes without referenced
  logs/artifacts are not a verifiable bundle.
* Record identities, before/after disk space, retained evidence, deletions
  and HOLD reasons in the final merge report. See the runbook's post-merge
  section; CI's in-run ownership cleanup and broad-cleanup prohibition remain.


Use additional commands only when they exist in the touched package:

```bash
node --test ops/tests/ci-resource-cleanup.test.mjs
```

There is no `npm run lint` script in `server/` or `web/` and no eslint
configuration in the repository. Do not present `npm run lint` as an
available or required command. Static analysis runs through `npm run build`
(`tsc`) and the CI `server-shellcheck` gate over `ops/` and local-CI tooling.

Testing priorities:

1. auth and role permissions
2. staff access boundaries
3. JobCard creation
4. JobCard state transitions
5. invalid transition rejection
6. manager approval
7. revision request
8. product delivery required fields
9. activity log creation
10. idempotency and duplicate requests
11. basic report correctness
12. frontend vertical user flows

If tests do not exist yet, create the smallest useful test harness for the touched module instead of skipping tests.

---

## 10. Dependency Rules

* Do not add a dependency for trivial helpers.
* Do not add a framework to solve a small local problem.
* Check whether the existing stack already provides the needed capability.
* Any new dependency must be justified in the final response:

  * why it is needed
  * why existing code cannot handle it
  * what risk it introduces
* Update lockfiles when package files change.

---

## 11. Documentation Rules

* Keep documentation operational and current.
* Update the relevant plan file when a task is completed or intentionally deferred.
* Do not let docs claim a feature exists if the implementation is still a stub.
* Document verification commands and results.
* Keep examples realistic for medical/dental B2B sales and product delivery usage.
* Do not use unrelated-domain examples in Servora-Med docs.

---

## 12. Task Completion Format

When finishing work, report in Turkish using this structure:

```text
Tamamlananlar:
- ...

Değişen dosyalar:
- ...

Doğrulama:
- [passed/failed/not run] command

Notlar / riskler:
- ...
```

Do not claim success without verification.

---

## 13. Forbidden Changes Without Explicit Approval

Do not do these unless the user explicitly asks:

* Convert the app to Electron, Tauri, Next.js, NestJS, Prisma, or another major framework.
* Replace PostgreSQL.
* Replace Fastify.
* Replace the React/Vite frontend.
* Rewrite the whole app without a plan.
* Reformat the whole repository.
* Carry unrelated legacy domain concepts into Servora-Med.
* Add native mobile app.
* Add full warehouse module.
* Add full accounting module.
* Add e-invoice/e-archive integration.
* Add multi-tenant SaaS architecture.
* Add user-defined Notion-style custom table system.
* Remove audit/event history.
* Weaken authentication, idempotency, role checks, or approval rules.

---

## 14. Language Rule

* Code, identifiers, commit messages, task names, and acceptance criteria should be in English.
* User-facing product text may be Turkish.
* Assistant progress reports and final explanations to the user must be in Turkish.

---

## 15. Document Authority and Reading Map

AGENTS.md owns engineering discipline and reading responsibilities. The documents
below own product, domain, design, and operations policy. Do not copy their field
lists, state machines, or MVP inventories into this contract.

Code and tests describe observed implementation. The latest explicitly accepted
`DECISIONS.md` records and applicable product/approved feature policy describe
intended behavior; drafts and historical plans do not grant implementation
permission. Supersession must be explicit, not inferred from document order.

Historical implementation plans preserve their original execution instructions.
Those instructions, including tool and sub-agent suggestions, do not override
this contract or authorize work outside the current task. Use the documentation
index in [docs/README.md](docs/README.md) to distinguish current owners from
historical plans and evidence; the index does not create another policy source.

On disagreement, report concrete drift with file/section references, observed
behavior, and the conflicting accepted rule. Stop the affected unauthorized
business-rule or policy rewrite; continue independent work already authorized.
Do not automatically rewrite policy to match code or change code to match an
unapproved interpretation. Reconcile through an authorized decision and then
update the owning document and verification.

For **every UI, UX, interaction, responsive, or accessibility task**, read
`DECISIONS.md` UI-001, `DESIGN.md`, and `PRODUCT.md` together with the applicable
workflow/acceptance criteria before implementation or review. UI-001 owns design
skill precedence and accessibility completion requirements.

| Document | Owns | Read when |
| -------- | ---- | --------- |
| `DECISIONS.md` | Accepted architectural and domain decisions (UI/DOM/ARC/SEC/SALE/MOD) | Before changing behavior, scope, or boundaries |
| `DESIGN.md` | Visual system, components, interaction and responsive rules | Before any UI/UX/accessibility implementation or review (with PRODUCT.md and UI-001) |
| `PRODUCT.md` | Users, product context, UX and accessibility expectations | Before any UI/UX/accessibility implementation or review, and product wording |
| `PRODUCT_REQUIREMENTS.md` | Workflows, JobCard lifecycle diagram, MVP scope | Before workflow, lifecycle, or scope questions |
| `SERVORA_MED_ARCHITECTURE_PLAN.md` | Module contracts, topology, ownership boundaries | Before cross-module or infrastructure changes |
| `SERVORA_MED_SCHEMA_DRAFT.md` | Table design, vocabularies, invariants, migration groups | Before schema, migration, or invariant work |
| `SERVORA_MED_API_DRAFT.md` | HTTP, idempotency, and concurrency contracts | Before endpoint or client-contract work |
| `docs/features/` | Approved feature contracts, rollout boundaries and integration plans | Before working inside a feature area; distinguish accepted from draft/historical text |
| `SERVORA_MED_MVP_SLICES.md` | Delivery order and slice acceptance | Before planning or claiming a slice complete |
| `docs/operations/` | Test env, deployment, backup, CI recovery runbooks | Before test/CI/ops execution or incident recovery |
| `ops/local-ci/` | Reproducible CI entrypoint, gates, evidence format | Before running or changing local CI |

Task-based reading order: AGENTS.md (contract) → the owning document above →
the code/tests it cites → compare intent with implementation. Report drift; never
invent policy or treat an implementation defect as an accepted decision.
