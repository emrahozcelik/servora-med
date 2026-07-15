# Slice 11 — Production Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use  
> superpowers:subagent-driven-development (recommended) or  
> superpowers:executing-plans to implement this plan task-by-task.  
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved Slice 11 production deployment, backup, and  
hardening design so Servora-Med can run safely on a public VPS with restorable  
PostgreSQL backups and generic readiness — without domain feature work.

**Architecture:** Harden config and Fastify trust/health/shutdown; stop  
migrate-on-start; add production npm scripts; ship bash backup/restore, systemd,  
and Caddy ops artifacts; prove log redaction on serialized output; document  
deploy and rehearsal.

**Tech Stack:** Node 22, Fastify 5, PostgreSQL, bash, systemd, Caddy, Vitest,  
GitHub Actions.

**Design SSOT:** `docs/superpowers/specs/2026-07-15-production-deployment-design.md`  
**Baseline:** `main` @ `23031b39599e3f16fab232987a288577aad717f4`

## Global constraints

- No Docker/K8s/Terraform/HA/auto-deploy/monitoring platform.
- No product `backup_status` table or schema migration for ops status.
- No admin `/api/health/detailed` in this slice.
- No secret literals in systemd units or Caddyfile examples.
- Production API binds loopback only.
- Production CORS is a single `https` origin.
- Trusted proxy is loopback hop only — never bare `trustProxy: true` for all.
- Migrate is explicit `migrate:prod`, not part of `start:prod`.
- Do not claim offsite or live VPS restore unless actually performed.
- Prefer surgical changes; no drive-by refactors.

## File map

### Application

- Modify: `server/src/config.ts`
- Modify: `server/src/app.ts`
- Modify: `server/src/index.ts`
- Modify: `server/src/db/index.ts`
- Modify: `server/src/db/migrate-runner.ts` and/or `server/src/db/index.ts` store
- Modify: `server/src/db/migrate.ts` (compiled entry compatibility)
- Modify: `server/src/modules/health/service.ts`
- Modify: `server/src/modules/health/handlers.ts`
- Modify: `server/src/modules/health/routes.ts` (if signature needs DI)
- Modify: `server/package.json`
- Modify: `server/.env.example`
- Possibly add: `server/src/db/migrate-cli.ts` if needed for clean dist entry

### Tests

- Modify: `server/tests/config.test.ts`
- Modify: `server/tests/app.test.ts`
- Create: `server/tests/health-readiness.test.ts`
- Create: `server/tests/trust-proxy-rate-limit.test.ts`
- Create: `server/tests/log-redaction.test.ts`
- Create: `server/tests/graceful-shutdown.test.ts`
- Create: `server/tests/migrate-lock.test.ts` (PG-gated if needed)
- Create: `server/tests/ops-scripts.test.ts` (bash -n + fixture behaviors)
- Modify: `server/tests/auth-routes.test.ts` only if Origin/proxy cases need extension
- Modify: `.github/workflows/ci.yml` if ops script checks or extra env required

### Ops artifacts

- Create: `ops/scripts/backup-postgres.sh`
- Create: `ops/scripts/restore-rehearsal.sh`
- Create: `ops/systemd/servora-med.service`
- Create: `ops/systemd/servora-med-backup.service`
- Create: `ops/systemd/servora-med-backup.timer`
- Create: `ops/caddy/Caddyfile.example`
- Create: `ops/examples/servora-med.env.example`

### Documentation

- Create: `docs/operations/production-deployment.md`
- Create: `docs/operations/backup-restore.md`
- Create: `docs/operations/restore-rehearsals/README.md` (template)
- Modify after verification only: `README.md`, `SERVORA_MED_MVP_SLICES.md`,  
  `SERVORA_MED_ARCHITECTURE_PLAN.md`, `SERVORA_MED_API_DRAFT.md`, `DECISIONS.md`  
  (if durable decision text is required)

---

### Task 1: Production config contract (TDD)

**Files:**
- Modify: `server/src/config.ts`
- Modify: `server/tests/config.test.ts`
- Modify: `server/.env.example`

- [ ] **Step 1: Write failing tests**

Cover:

```text
production rejects http CORS_ORIGIN
production rejects missing CORS_ORIGIN
production rejects HOST=0.0.0.0
production accepts HOST=127.0.0.1 with https CORS
rejects LOG_LEVEL=verbose
rejects DATABASE_URL=mysql://...
production requires TRUSTED_PROXY=loopback (or 127.0.0.1 / ::1)
rejects TRUSTED_PROXY=true and TRUSTED_PROXY=*
development still allows http://127.0.0.1:5173 and default host
```

- [ ] **Step 2: Run RED**

```bash
cd server && npm test -- --run tests/config.test.ts
```

- [ ] **Step 3: Implement `loadConfig` extensions**

Add `trustedProxy: 'loopback' | '127.0.0.1' | '::1'` (dev default `loopback`).  
Optional `healthSchemaVersion: string | null`.  
Export typed config fields used by app/db.

- [ ] **Step 4: GREEN + commit**

```bash
cd server && npm test -- --run tests/config.test.ts && npm run build
git add server/src/config.ts server/tests/config.test.ts server/.env.example
git commit -m "feat: harden production config validation"
```

---

### Task 2: Trusted proxy + login rate-limit identity (TDD)

**Files:**
- Modify: `server/src/app.ts`
- Create: `server/tests/trust-proxy-rate-limit.test.ts`
- Possibly modify: `server/tests/auth-routes.test.ts`

- [ ] **Step 1: Write failing tests**

Using Fastify inject / light HTTP where needed:

1. With trust enabled for loopback simulation, two different `X-Forwarded-For`  
   client identities receive independent login rate-limit buckets  
   (or document exact Fastify inject limitation and use controlled peer mock).
2. Untrusted path does not treat arbitrary `X-Forwarded-For` as the rate-limit key.
3. `buildApp` receives `trustProxy` derived only from validated config.

If inject cannot fully emulate peer address, unit-test the mapping function  
`resolveTrustProxyOption(config)` and integration-test rate limit still applies  
per connection identity in the best available harness; do not ship untested  
`trustProxy: true`.

- [ ] **Step 2: RED**

```bash
cd server && npm test -- --run tests/trust-proxy-rate-limit.test.ts
```

- [ ] **Step 3: Implement**

```ts
Fastify({
  trustProxy: /* from config — loopback only */,
  logger: { level, redact: LOGGER_REDACT_PATHS },
})
```

- [ ] **Step 4: GREEN + commit**

```bash
git commit -m "feat: trust loopback proxy for client IP rate limits"
```

---

### Task 3: Generic readiness health (TDD)

**Files:**
- Modify: `server/src/modules/health/*`
- Modify: `server/src/app.ts` / `server/src/index.ts` wiring
- Create: `server/tests/health-readiness.test.ts`
- Modify: `server/tests/app.test.ts`

- [ ] **Step 1: Failing tests**

```text
ready → 200 {"status":"ok"}
db down → 503 {"status":"unavailable"}
body never contains database / migration / error detail keys
```

- [ ] **Step 2: RED**

- [ ] **Step 3: Implement readiness port**

```ts
type HealthReadinessPort = {
  check(): Promise<'ok' | 'unavailable'>;
};
```

Default Postgres implementation: `SELECT 1` + schema_migrations presence  
(or exact version when `HEALTH_SCHEMA_VERSION` set).  
Wire through `buildApp` dependencies so unit tests can inject fakes.

- [ ] **Step 4: GREEN + commit**

```bash
git commit -m "feat: report generic readiness on public health"
```

---

### Task 4: Stop migrate-on-start + production scripts + pool + migrate lock (TDD)

**Files:**
- Modify: `server/src/index.ts`
- Modify: `server/src/db/index.ts`
- Modify: `server/src/db/migrate-runner.ts` and/or migration store
- Modify: `server/package.json`
- Create: `server/tests/migrate-lock.test.ts` (prefer `TEST_DATABASE_URL`)
- Ensure `build` emits migrate CLI in `dist/`

- [ ] **Step 1: Failing tests / contract checks**

1. Source contract: `index.ts` production start path does not call `runMigrations`.
2. PG-gated: two concurrent migrate runners under advisory lock do not double-apply  
   (or second waits safely); applied versions remain unique.
3. Pool factory applies `application_name` and finite `max` when configured.

- [ ] **Step 2: Implement**

- Remove migrate from `main()` listen path.
- `migrate:prod` → compiled migrate entry.
- `start:prod` → `node dist/index.js`.
- `bootstrap:admin:prod` → compiled bootstrap.
- Advisory lock key constant documented in design (stable int).

- [ ] **Step 3: GREEN + commit**

```bash
git commit -m "feat: separate production migrate from process start"
```

---

### Task 5: Graceful shutdown contract (TDD)

**Files:**
- Modify: `server/src/index.ts` (extract testable shutdown helper if needed)
- Create: `server/tests/graceful-shutdown.test.ts`

- [ ] **Step 1: Failing tests**

```text
first signal closes app and pool
second signal is idempotent
close failure yields exit code 1 path
timeout path documented/tested with fake timers or short timeout inject
```

Prefer testing a pure `createShutdown({ closeApp, closeDb, timeoutMs, exit })`  
helper to avoid process-killing the test runner.

- [ ] **Step 2: Implement + GREEN + commit**

```bash
git commit -m "feat: harden graceful shutdown exit semantics"
```

---

### Task 6: Serialized log redaction (TDD)

**Files:**
- Create: `server/tests/log-redaction.test.ts`
- Modify: `server/src/app.ts` only if paths need extension

- [ ] **Step 1: Failing test with real logger destination**

Build app with logger stream/destination capturing JSON lines.  
Inject login (or log a request object) containing:

```text
password, currentPassword, newPassword, temporaryPassword
Cookie header, Authorization header
Set-Cookie response path if logged
```

Assert serialized output does **not** contain raw secrets; does contain safe  
request id / generic error category where applicable.

- [ ] **Step 2: GREEN + commit**

```bash
git commit -m "test: prove sensitive fields are redacted in log output"
```

---

### Task 7: Backup script (TDD / fixture)

**Files:**
- Create: `ops/scripts/backup-postgres.sh`
- Create: `server/tests/ops-scripts.test.ts` or `ops/scripts/tests/...`

- [ ] **Step 1: Specify expected behaviors in tests**

Using disposable Postgres when `TEST_DATABASE_URL` set:

```text
successful dump creates .dump + .sha256, no .partial left
failed dump removes partial and exits non-zero
flock prevents concurrent double-run
ops log line has no password substring
bash -n passes always
```

Without PG, still run `bash -n` and unit-style tempdir dry runs where possible.

- [ ] **Step 2: Implement script to design §14**

- [ ] **Step 3: GREEN + commit**

```bash
git commit -m "feat: add PostgreSQL backup script with atomic output"
```

---

### Task 8: Restore rehearsal script (TDD)

**Files:**
- Create: `ops/scripts/restore-rehearsal.sh`
- Extend ops script tests

- [ ] **Step 1: Failing tests**

```text
refuses when target equals PRODUCTION_PGDATABASE / production guard
refuses checksum mismatch
bash -n passes
```

Optional PG-gated happy path on disposable DB (create/restore/drop).

- [ ] **Step 2: Implement + GREEN + commit**

```bash
git commit -m "feat: add safe PostgreSQL restore rehearsal script"
```

---

### Task 9: systemd + Caddy + env example

**Files:**
- Create: `ops/systemd/servora-med.service`
- Create: `ops/systemd/servora-med-backup.service`
- Create: `ops/systemd/servora-med-backup.timer`
- Create: `ops/caddy/Caddyfile.example`
- Create: `ops/examples/servora-med.env.example`

- [ ] **Step 1: Author units matching design §12–13**

No secrets. Placeholders only.

- [ ] **Step 2: Verify where possible**

```bash
bash -n ops/scripts/*.sh
command -v systemd-analyze >/dev/null && systemd-analyze verify ops/systemd/*.service || true
```

- [ ] **Step 3: Commit**

```bash
git commit -m "docs: add systemd and Caddy production templates"
```

---

### Task 10: Operations documentation

**Files:**
- Create: `docs/operations/production-deployment.md`
- Create: `docs/operations/backup-restore.md`
- Create: `docs/operations/restore-rehearsals/README.md`

- [ ] **Step 1: Write runbooks**

Must include: topology, env table, deploy sequence, migrate policy, smoke checks,  
backup/offsite/retention, restore guards, rehearsal template fields, non-claims.

- [ ] **Step 2: Commit**

```bash
git commit -m "docs: add production deployment and backup runbooks"
```

---

### Task 11: CI hooks for ops scripts

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add lightweight checks**

```yaml
# e.g. server job or separate ops job:
- run: bash -n ops/scripts/backup-postgres.sh ops/scripts/restore-rehearsal.sh
```

Do not require real VPS. Keep PG suite as today.

- [ ] **Step 2: Commit**

```bash
git commit -m "ci: syntax-check operations scripts"
```

---

### Task 12: Full verification and SSOT closeout

**Do not update SSOT claims before gates pass.**

- [ ] **Step 1: Run gates**

```bash
cd server && npm run build
cd server && npm test -- --run
cd server && TEST_DATABASE_URL="$TEST_DATABASE_URL" npm test -- --run
cd server && npm audit --audit-level=high
cd web && npm test -- --run
cd web && npm run build
cd web && npm audit --audit-level=high
bash -n ops/scripts/*.sh
git diff --check
```

Expected: all pass; PG-gated tests execute when URL set.

- [ ] **Step 2: Optional disposable backup/restore acceptance**

If `TEST_DATABASE_URL` available, run backup script against disposable DB and  
restore rehearsal into a second disposable DB; record result in  
`docs/operations/restore-rehearsals/` **without secrets**.

- [ ] **Step 3: Update SSOT**

- `README.md` — production scripts, link ops docs, health 200/503  
- `SERVORA_MED_MVP_SLICES.md` — check Slice 11 acceptance  
- `SERVORA_MED_ARCHITECTURE_PLAN.md` — Caddy canonical; no migrate-on-start  
- `SERVORA_MED_API_DRAFT.md` — public health 200/503; `/detailed` deferred  
- `DECISIONS.md` — only if adding durable ops decisions (trust loopback; explicit migrate)

- [ ] **Step 4: Final commit + push (no PR until asked)**

```bash
git commit -m "docs: close Slice 11 production deployment"
git push -u origin feature/slice-11-production-deployment
```

- [ ] **Step 5: Stop and report**

Report exact SHAs, test totals, what was **not** claimed (live offsite, live VPS).

---

## Task dependency graph

```text
Task 1 config
  → Task 2 trustProxy / rate limit
  → Task 3 health readiness
  → Task 4 migrate split + pool + lock
  → Task 5 shutdown
  → Task 6 log redaction
Task 7 backup script ─┐
Task 8 restore script ─┼→ Task 9 systemd/Caddy → Task 10 docs → Task 11 CI → Task 12 closeout
(Tasks 7–8 can parallelize after Task 1; prefer after Task 4 if restore needs migrate)
```

## Plan self-review

- Every design blocker B1–B8 maps to a task.
- TDD order: fail → implement → pass → commit.
- No domain features, no backup table, no Docker.
- Production secrets never in git.
- Manual VPS acceptance listed but not faked in CI.

## Execution stop

**Do not implement Tasks 1–12 until the user explicitly approves this plan and**  
`docs/superpowers/specs/2026-07-15-production-deployment-design.md`.
