# Staging acceptance and no-go gates — Servora-Med

Checklist for declaring the synthetic-data staging environment operational.
Every item must be independently verified; a checklist item is never assumed.

## Acceptance checklist

```text
exact deployed commit recorded
exact-head CI server/web success
DATABASE_URL points to staging DB
41/41 migrations
HEALTH_SCHEMA_VERSION exact
/api/health = 200
login works
active jobs load
completed jobs load
board loads
Staff profile loads
confidential notes Admin/Manager boundary works
Staff cannot see confidential notes
Web Push disabled
geolocation disabled
only synthetic data
no blocking browser/server errors
backup execution verified
restore rehearsal recorded
```

Detail notes:

- **Exact commit** — the installed release contains no Git checkout; the
  release directory itself carries the SHA
  (`/opt/servora-med/releases/<git-sha>` with `current` as a symlink).
  Deployed identity is proven from the resolved symlink basename, never from
  Git inside the release:

  ```bash
  EXPECTED_SHA="<approved-exact-sha>"

  ACTIVE_RELEASE="$(
    realpath /opt/servora-med/current
  )"

  DEPLOYED_SHA="$(
    basename "$ACTIVE_RELEASE"
  )"

  test "$DEPLOYED_SHA" = "$EXPECTED_SHA"
  printf 'DEPLOYED_SHA=%s\n' "$DEPLOYED_SHA"
  ```

  The builder checkout Git identity is verified separately at build time (Git
  tooling in the builder checkout is not the installed-release identity).
- **Exact-head CI** — the CI run for the deployed commit shows server and web
  jobs `SUCCESS`.
- **Database** — `DATABASE_URL` resolves to `servora_med_staging`;
  `schema_migrations` holds exactly the 41 canonical migrations.
- **Readiness** — `HEALTH_SCHEMA_VERSION` equals the exact latest migration in
  the release (currently `041_user_lifecycle_reconciliation`); `GET /api/health`
  returns `200 {"status":"ok"}`.
- **Feature flags** — `OVERVIEW_DASHBOARD_ENABLED=true`,
  `CALENDAR_ENABLED=true`, and `MESSAGING_ENABLED=true`; `WEB_PUSH_ENABLED=false`
  and `ACTION_SCOPED_GEOLOCATION_ENABLED=false` are confirmed in the staging
  environment; no VAPID or Google credentials are present.
- **Privacy boundary** — the confidential-notes section is visible to
  Admin/Manager actors only and absent for Staff actors (backend-enforced).
- **Data** — inventory confirms synthetic fixtures only; no real customer,
  patient, staff, credential, or token data.
- **Operations** — a backup has been executed and verified via
  `ops/scripts/backup-postgres.sh` (see [backup-restore.md](./backup-restore.md));
  a live restore rehearsal is recorded under `docs/operations/restore-rehearsals/`.

## No-go gates

Any single item forces the staging environment to be treated as **not ready**:

```text
health 503
migration mismatch
unknown DB ownership
real personal/customer/patient data
missing backup
failed restore rehearsal
unresolved secret exposure
public origin without HTTPS
production feature flags accidentally enabled
```

- **health 503** — stale or incorrect `HEALTH_SCHEMA_VERSION`, or unreachable
  database.
- **migration mismatch** — applied migration set differs from the release set.
- **unknown DB ownership** — the target database is not explicitly recorded as
  the owned disposable staging database.
- **secret exposure** — any credential, token, or private key observed in
  logs, docs, or process listings.
- **public origin without HTTPS** — staging is reachable only over HTTPS; a
  plain-HTTP public origin is a no-go.

## Recorded state after a no-go

A no-go does not reset anything. The operator records the failing gate, the
exact commit, and the observed evidence; remediation is a separate authorized
batch.

Related documents: [staging-contract.md](./staging-contract.md),
[staging-database-runbook.md](./staging-database-runbook.md),
[backup-restore.md](./backup-restore.md).
