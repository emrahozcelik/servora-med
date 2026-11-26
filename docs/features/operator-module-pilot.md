# Installation operator and runtime module state — Overview pilot

Status: **accepted contract**, implemented in PR #511 (owner direction 2026-11-25:
separate operator account and session; first module = Overview; later the operator may
receive powerful capabilities such as customer delete or staff permanent delete).
Decision record: DECISIONS.md MOD-002. The registry, its CHECKs and the takeover were
widened for further modules by DECISIONS.md MOD-003 (migration 075); §5 below describes
the pilot as shipped, and MOD-003 / `SERVORA_MED_SCHEMA_DRAFT.md` §8.2 own the widened
rules.
Research: [docs/backlog/2026-11-25-core-modules-architecture-research.md](../backlog/2026-11-25-core-modules-architecture-research.md) §4–§6.
Independent review: Sol advisor run `20261125-232041-sol-37b0` (AGREE_WITH_CHANGES; all
changes incorporated below).

Base: `origin/main` @ 66eaffa.

## 1. Goal and scope

The installation operator (the person who installs and runs Servora-Med for a
customer) turns product modules on and off from inside the application instead of
editing the env file. This slice proves the mechanism end to end with exactly one
module, **Overview** (`OVERVIEW_DASHBOARD_ENABLED` today).

In scope:

- Operator identity, separate from customer users, with its own login and session.
- Host CLI to grant, reset and revoke operators.
- A code-level module registry with one entry, a typed installation module state
  and an operator audit trail.
- Overview enabled/disabled at runtime; customers already logged in pick it up.
- Operator "Modüller" page with the Overview switch only.
- Restore safety for operator identities.

Out of scope (later slices, each with its own contract/decision): other modules
(Messaging, Calendar, Web Push, alerts, backup, demo data) and their display on the
panel; prerequisite/env-ceiling mechanics; install profiles; operator capabilities on
business data (customer delete, staff permanent delete) and their re-authentication;
origin separation for the operator area; 2FA; operator administration UI.

## 2. Operator identity

- **Installation level.** Operator rows carry no `organization_id` (precedent:
  backup tables). The operator is never a row in `users`; customer roles, `sessions`,
  `processed_actions` and `audit_events` are untouched.
- **Tables (migration 074):**
  - `operator_accounts`: `id`, `email` (unique, case-insensitive, normalized),
    `name`, `password_hash`, `is_active`, `version`, `created_at`, `updated_at`.
  - `operator_account_capabilities`: (`operator_id` FK, `capability`), `capability`
    CHECK `IN ('MODULE_MANAGEMENT')`. The list is fixed in code; later slices extend
    the CHECK and the list.
  - `operator_sessions`: `id`, `operator_id` FK, `token_hash` (unique, SHA-256 of an
    opaque token, SEC-001 pattern), `created_at`, `expires_at`, `revoked_at`.
- **Password hashing:** the existing scrypt V2 writer and the pre-warmed fixed-work
  verifier from `server/src/modules/auth/crypto.ts`; not the customer user repository.

## 3. Operator session and API

- Routes under `/api/operator`. The customer session cookie authenticates none of
  them; the operator cookie authenticates nothing outside `/api/operator`.
- Cookie `servora_operator_session`: host-only, `HttpOnly`, `SameSite=Strict`,
  `Path=/api/operator`, `Secure` in production, **2 hours absolute** (no sliding
  renewal). Logout clears it with the same `Path`.
- **Origin enforcement in every environment:** every operator write route
  (including login and logout) requires the request `Origin` to equal the configured
  `CORS_ORIGIN`; missing, `null` or different origin → `403`. (The existing global
  hook only enforces this in production.) The dev Vite proxy flow is verified in a
  real browser.
- **Login:** unknown email, inactive account and wrong password all spend the same
  fixed KDF work and return the same `401` body. Small body limit; short per-IP and
  per-normalized-email limits evaluated before the KDF, separate from the customer
  login limit, keyed on the trusted client address behind the proxy. Failed logins are
  tracked as identity-free counters/logs, not audit rows. A successful login locks the
  account row, re-checks hash and `is_active`, then writes the session and the
  `OPERATOR_LOGIN_SUCCEEDED` audit event in one transaction.
- Each authenticated request validates the session (not expired, not revoked, account
  active). Mutations re-validate the session and the capability inside their
  transaction under the account lock (same lock order everywhere).
- Endpoints:
  - `POST /api/operator/login` `{ email, password }` → `{ operator }` + cookie.
  - `POST /api/operator/logout`.
  - `GET /api/operator/me` → `{ operator: { id, name, email, capabilities } }`.
  - `GET /api/operator/modules` → `[ { key, label, enabled, version, updatedAt } ]`.
  - `PUT /api/operator/modules/:key` `{ enabled, expectedVersion }` → module row.
    Requires `MODULE_MANAGEMENT`. Unknown key → `404`.
- Nothing about operators is exposed by customer APIs or `/api/health`.

## 4. Host CLI

`npm run operator -- <command>` (dev) and a `:prod` variant, following the
`bootstrap-admin` pattern, with a narrow DB configuration:

- `grant --email <e> --name <n>`: create an operator with `MODULE_MANAGEMENT`. An
  already active account → conflict error. Reactivating an inactive account always
  sets a new password.
- `reset-password --email <e>`: new password; revokes all sessions of the account.
- `revoke --email <e>`: deactivate and revoke all sessions.
- `list`: email, name, active, capabilities, last successful login (derived from the
  audit table). Read-only.
- Passwords are read from a no-echo TTY prompt or an explicit `--password-stdin`;
  never from argv or env. A generated password is offered only on an interactive TTY
  and printed once there.

Mutating commands write an operator audit event with actor kind `HOST_CLI` in the same
transaction as the change.

## 5. Module registry and state

- `server/src/modules/installation-modules/registry.ts`: fixed entries known at
  compile time. Descriptor for this slice: `key`, `label` (Turkish), `capability`
  (the `user.capabilities` field it drives), `legacyEnvKey` (takeover source). One
  entry: `OVERVIEW` → `overviewDashboard`, `OVERVIEW_DASHBOARD_ENABLED`. No
  prerequisites, dependency graph, worker hooks, menu metadata or dynamic loading.
- Table `installation_module_state`: `module_key` (PK, CHECK `IN ('OVERVIEW')`),
  `enabled`, `version`, `source` (`ENV_TAKEOVER` | `OPERATOR`), `updated_at`,
  `updated_by_operator_id` (nullable FK). No `organization_id`. One typed row per
  registry key, not a generic settings bag (UI-002).
- **Effective state = `enabled`.** Env is not a ceiling for Overview: it has no
  secret or infrastructure prerequisite, and `OVERVIEW_DASHBOARD_ENABLED` defaults to
  false and is absent from the production example, so a ceiling would make Overview
  impossible to enable.
- **One-time takeover** runs in the API process only (never in the backup worker),
  after schema verification and before the server starts listening: `INSERT …
  ON CONFLICT DO NOTHING RETURNING` from the current `OVERVIEW_DASHBOARD_ENABLED`
  value (`source = ENV_TAKEOVER`); only the process whose insert returned a row writes
  the `MODULE_STATE_TAKEN_OVER` audit event (actor kind `SYSTEM`) in the same
  transaction. Any failure stops startup. After takeover the env key is ignored for
  Overview and documented as legacy. Fresh empty DB: env `true` → on, unset → off.
- If the row is missing but a `MODULE_STATE_TAKEN_OVER` event exists (e.g. a damaged
  or partial restore), startup fails closed and requires a controlled recovery
  decision instead of silently re-deriving from env.

## 6. Mutation, idempotency and audit

- `PUT /api/operator/modules/:key` in one transaction: lock the operator account and
  re-validate session/capability, lock the state row (`FOR UPDATE`), compare
  `expectedVersion`.
  - Stale `expectedVersion` → `409 MODULE_VERSION_CONFLICT` (also when the requested value
    equals the stored one).
  - Current version and same value → `200` with the row, no new audit event.
  - Current version and different value → update, bump `version`, insert
    `MODULE_STATE_CHANGED` in the same transaction.
- Table `operator_audit_events` (installation level): `id`, `actor_kind`
  (`OPERATOR` | `HOST_CLI` | `SYSTEM`), `operator_id` (FK `ON DELETE RESTRICT`;
  CHECK: required iff `actor_kind = OPERATOR`), `event_type` (CHECK:
  `OPERATOR_GRANTED`, `OPERATOR_PASSWORD_RESET`, `OPERATOR_REVOKED`,
  `OPERATOR_LOGIN_SUCCEEDED`, `MODULE_STATE_TAKEN_OVER`, `MODULE_STATE_CHANGED`,
  `OPERATOR_ACCESS_RESET_BY_RESTORE`), `target_operator_id` (account events),
  `module_key` (module events), `old_value`/`new_value` (small JSONB, shape limited
  per event type), `occurred_at`. CHECKs tie each event type to the target column it
  needs.
- Later operator actions on business data (e.g. customer delete) must keep the owning
  module's organization scope, history guards and normal audit in the same
  transaction; that slice defines a real operator actor for `audit_events` and, if
  needed, a correlation id to the operator event. Not part of MOD-002.

## 7. Runtime reads and failure behaviour

- One `ModuleStateReader` (single primary-key read per request, no cache) used by
  `/api/auth/login`, `/api/auth/me` and the `OverviewService` gate.
- Read succeeded and `enabled = false` → Overview keeps the existing `404 NOT_FOUND`
  ("Sayfa bulunamadı."). Missing row or read failure → Overview and the operator
  modules API return `503`; `/api/auth/me` still answers with
  `overviewDashboard: false` and the error is logged. No env fallback.
- A request that already passed the gate may complete. Overview routes stay always
  registered (already true today).

## 8. Web

- A separate top-level component matches `/operator` and `/operator/*` before the
  customer tree mounts; the customer bootstrap (`/api/auth/me`), customer providers,
  shell, navigation and realtime mount only for the customer subtree. Both share
  `ServoraAntProvider`, `styles.css` and build identity.
- Screens: `OperatorLogin` and `OperatorModulesPage` (Overview row with label, state,
  last change, a switch with a confirmation dialog; loading, success, error and
  version-conflict states). Turkish copy; DESIGN.md / UI-001 rules; UI-003 evidence at
  390 px and 1440 px.
- Customer `/api/auth/me` revalidation: on window focus / `visibilitychange` (visible
  tab only), throttled, single in-flight request; responses arriving after logout,
  a new login or unmount are ignored. `401` logs out; network/5xx keeps the current
  identity. An Overview `404` triggers one revalidation. When Overview becomes
  disabled the router moves an open Overview page to `/jobs`; when enabled, navigation
  and the next landing route update without interrupting the current page.

## 9. Backup, restore and deploy

- Operator tables are included in database backups; dumps therefore contain operator
  password and session hashes. The runbook confirms the existing dump encryption,
  temporary-file and offsite-access coverage applies.
- **Restore reset:** in both the BR7 restore cutover and the host recovery path,
  before traffic is opened: revoke all operator sessions and deactivate all operator
  accounts (`OPERATOR_ACCESS_RESET_BY_RESTORE`, actor `SYSTEM`). The host operator
  re-grants needed accounts with a new password. Module state and audit return to the
  backup instant (documented).
- A pre-074 backup restores through the existing verified-release flow; the first
  start on 074 performs takeover. Staging/f4 acceptance that expects Overview on must
  verify the DB state after the first takeover.
- Migration 074 requires `allow_migrations` on deploy. Real head expectations and the
  two ops env examples move to 074; historical migration fixtures keep their targets.
  `ops/ci/verify-env-examples.sh` already finds the head dynamically.
- After deploy the owner grants the first operator through the host CLI over the root
  channel (explicit owner approval per run).
- Docs updated in the same PR: DECISIONS.md MOD-002, SERVORA_MED_API_DRAFT.md
  (operator endpoints), SERVORA_MED_SCHEMA_DRAFT.md (074 tables), rollout/restore
  runbook notes, `.env.example` legacy note for `OVERVIEW_DASHBOARD_ENABLED`.

## 10. Acceptance scenarios

Server (PostgreSQL):

- OP1 Valid login sets the operator cookie; unknown email, inactive account and wrong
  password → identical `401` with the same KDF work; per-IP and per-email limits apply.
- OP2 Customer cookie on any `/api/operator/*` → `401`; operator cookie on customer
  routes (`/api/auth/me`, `/api/overview`) → `401`.
- OP3 Missing, `null` or foreign `Origin` on operator writes → `403` in test/dev
  configuration too.
- OP4 Expired, revoked (logout, CLI revoke, reset-password) and deactivated sessions
  → `401`; a session revoked between gate and mutation cannot commit a change.
- OP5 Operator without `MODULE_MANAGEMENT` → `403` on `PUT`.
- OP6 Toggle off → `/api/overview` `404` and `/api/auth/me` `overviewDashboard:false`
  without restart; toggle on → both reflect it.
- OP7 Stale version → `409` (even for the same value); current version + same value →
  `200`, zero new audit events.
- OP8 State change and audit commit together (forced audit failure rolls back state).
- OP9 Unknown key → `404`, nothing written.
- OP10 Takeover: concurrent startups with a missing row → exactly one row and one
  audit event; restart does not duplicate; env changes after takeover have no effect.
- OP11 Empty DB, env unset → disabled; env `true` → enabled.
- OP12 Row missing with an existing takeover event → startup fails closed; read
  failure → Overview `503`, `/api/auth/me` `overviewDashboard:false`.
- OP13 Restore reset: after a restore, old operator cookies and old passwords are
  rejected; accounts are inactive until re-granted.
- CLI: grant/reset/revoke/list behave as §4; password never in argv; audit written.

Web:

- `/operator` renders without calling `/api/auth/me`; customer routes never call
  `/api/operator/*`.
- Login and Modules page states; switch requires confirmation; version conflict shown.
- Customer revalidation: single flight, throttled, stale responses ignored, `401`
  logs out, 5xx keeps identity; disabled Overview moves an open Overview page to
  `/jobs`.

## 11. Open questions for the owner

1. Session lifetime: 2 hours absolute (proposed) — acceptable?
2. Fresh install default: keep the env value (proposed; install profiles decide
   later) or default Overview to on?

## 12. Implementation interfaces (fixed for parallel authors)

Owner approval 2026-11-26 ("Onaylıyorum, başla"): 2-hour absolute operator session;
fresh installs take the env value.

Server module layout:

- `server/src/modules/operator/`: `types.ts`, `repository.ts`
  (`PostgresOperatorRepository`), `service.ts` (`OperatorService`), `routes.ts`
  (`operatorRoutes`, registered with prefix `/api/operator`), `restore-reset.ts`
  exporting `resetOperatorAccessAfterRestore(client: PoolClient, now: Date):
  Promise<{ revokedSessions: number; deactivatedAccounts: number }>`.
- `server/src/modules/installation-modules/`: `registry.ts` (`INSTALLATION_MODULES`,
  `InstallationModuleKey = 'OVERVIEW'`), `state.ts` (`ModuleStateReader` with
  `read(key): Promise<ModuleStateRow | null>` that throws on DB failure, and
  `PostgresModuleStateReader`), `takeover.ts` exporting
  `takeOverInstallationModules(pool: Pool, legacy: { overviewDashboard: boolean },
  now?: () => Date): Promise<void>` (throws → startup stops).
- `server/src/db/operator-cli.ts` exporting `runOperatorCli(argv: string[], io:
  { stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream; stderr:
  NodeJS.WritableStream; isTTY: boolean }, pool: Pool): Promise<number>` with
  commands `grant`, `reset-password`, `revoke`, `list`, `reset-after-restore`;
  npm scripts `operator` (tsx) and `operator:prod` (dist).
- `buildApp`: new optional dependency `moduleStateReader?: ModuleStateReader`. When
  `dependencies.pool` is present and no reader is injected, a
  `PostgresModuleStateReader(pool)` is used and operator routes are registered.
  Without a pool (in-memory unit tests) the reader defaults to a static reader built
  from `config.capabilities.overviewDashboard`, and operator routes are not
  registered. `index.ts` calls `takeOverInstallationModules` after
  `assertStartupSchemaCompatible` and before `app.listen`.
- Migration `074_installation_operator_and_module_state.sql`.

HTTP contract (bodies are JSON; `version` is an integer):

| Endpoint | Success | Errors |
| --- | --- | --- |
| `POST /api/operator/login` `{ email, password }` | `200 { operator: { id, name, email, capabilities: string[] } }` + `Set-Cookie: servora_operator_session` | `400 VALIDATION_ERROR`, `401 INVALID_CREDENTIALS`, `403 INVALID_ORIGIN`, `429` (fastify rate-limit) |
| `POST /api/operator/logout` | `204`, cookie cleared | `403 INVALID_ORIGIN` |
| `GET /api/operator/me` | `200 { operator }` | `401 OPERATOR_UNAUTHENTICATED` |
| `GET /api/operator/modules` | `200 { modules: [ { key, label, enabled, version, source, updatedAt } ] }` | `401`, `403 FORBIDDEN` (no capability), `503 MODULE_STATE_UNAVAILABLE` |
| `PUT /api/operator/modules/:key` `{ enabled, expectedVersion }` | `200 { module }` | `400 VALIDATION_ERROR`, `401`, `403 FORBIDDEN` / `INVALID_ORIGIN`, `404 NOT_FOUND`, `409 MODULE_VERSION_CONFLICT`, `503 MODULE_STATE_UNAVAILABLE` |

Customer contract changes: `/api/auth/login` and `/api/auth/me` compute
`capabilities.overviewDashboard` from the reader per request (read failure →
`false` + error log). `GET /api/overview` keeps `404 NOT_FOUND` when disabled and
returns `503 MODULE_STATE_UNAVAILABLE` when the state cannot be read.
