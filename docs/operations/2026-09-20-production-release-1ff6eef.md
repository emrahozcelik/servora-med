# Production Release — 2026-09-20

Historical, release-specific record. The reusable deployment procedure lives in
[production-deployment.md](./production-deployment.md); this file only records
what happened for the `1ff6eef` release. Repository: `emrahozcelik/servora-med`.

## Release identity

| Item | Value |
|------|-------|
| Production SHA (this release) | `1ff6eefc4b2d425c3ced0447ad5593c250a83bdd` |
| Previous production | `20de90ccb97876bf5680d51e0ad4786509cd76f5` |
| Intermediate canonical mains not separately deployed | `97b3872…`, `2b1f94a…`, `1d5eac44…` |
| Canonical main after release | `1ff6eefc4b2d425c3ced0447ad5593c250a83bdd` |

### Why production skipped past three intermediate mains

Production moved directly `20de90c… → 1ff6eef…` as a single release. The three
intermediate mains were not separately deployed:

| Intermediate main | Contents | Why it was not a separate release |
|-------------------|----------|-----------------------------------|
| `97b3872` | #310 — test-only fixture remediation | Test-only; no runtime behaviour change |
| `2b1f94a` | #309 — SSE-blocked shutdown root cause | Bundled so the OVR-3 outage remediation ships with the working-day reconciliation |
| `1d5eac44` | #312 — geocoding daily quota boundary | Bundled so the geocoding fix and the working-day fix ship together, on the combined tree that was already verified conflict-free |

This was a deliberate release-bundling decision, **not** skipped validation.
Each intermediate main had already passed its own merge gate and exact-head CI
(listed below), and the combination was verified before merge: the two
source-touching changesets (#312 and #311) have **disjoint file sets**, and
`git merge-tree --write-tree` combined them with zero conflicts.

## Included changes

Five pull requests are included in `20de90c… → 1ff6eef…`.

- **PR #308 — docs: record 2026-09-19 production release 20de90c.** Head
  `cdca7941c8993b58471f39ab560c79028430cc7e`, exact-head CI run `35439384455`
  (SUCCESS). Merged as `105b927`. Documentation only.
- **PR #310 — test: keep DB-clock fixture slots off the organization-local
  Sunday.** Head `85fca9cf191e330bc9c0652dd4fb1b8f199edcbb`, exact-head CI run
  `35497995993` (SUCCESS). Merged as `97b3872`. Test-only.
- **PR #309 — fix: close SSE-blocked shutdown that forced exit 1 (OVR-3 outage
  root cause).** Head `cb2d1d4eae6bb1c3ea88c74222aa8d4a1d8dd2b3`, exact-head CI
  run `35505196434` (SUCCESS). Merged as `2b1f94a`. Realtime teardown moved from
  `onClose` to `preClose` and `forceCloseConnections` was dropped, so a hijacked
  SSE stream no longer stalls shutdown while ordinary in-flight requests still
  drain.
- **PR #312 — fix(geocoding): resolve the daily quota boundary to the NEXT
  Istanbul midnight.** Head `1ba4ce6956578ad74d69e09fb395726b057cd426`,
  exact-head CI run `35515612760` (SUCCESS). Merged as `1d5eac4`. This fixed a
  **production-impacting** defect: `istanbulDayExclusiveEnd()` returned an
  instant *before* `now`, so `dailyBucketExpiresAt()` produced an
  already-expired timestamp and the guard's opening
  `DELETE … WHERE expires_at < NOW()` wiped the `ORGANIZATION_DAY` and
  `USER_DAY` buckets on every reservation, resetting the organization and
  per-user daily quotas early. `GLOBAL_MONTH` was unaffected.
- **PR #311 — fix(job-cards): restrict the Sunday rule to SYSTEM scheduling,
  allow human Sunday.** Head `88ce36fd68545badae5e28ec54f20fb00a4deeb1`,
  exact-head CI run `35516993762` (SUCCESS). Merged as `1ff6eef`. Seven
  misplaced `assertWorkingDay()` calls were removed from the explicit human
  write paths in `src/modules/job-cards/service.ts` and
  `src/modules/calendar/service.ts`; every automatic/SYSTEM path and the
  canonical primitives in `working-day-policy.ts` are unchanged.

### Source files changed between previous production and this release

```text
server/src/app.ts
server/src/index.ts
server/src/modules/calendar/service.ts
server/src/modules/geocoding/quota-periods.ts
server/src/modules/job-cards/service.ts
server/src/modules/realtime/service.ts
docs/operations/2026-09-19-production-release-20de90c.md
docs/operations/production-deployment.md
docs/superpowers/plans/2026-07-21-minimal-install-web-push.md
```

plus 11 files under `server/tests/`. Total diffstat: **20 files changed,
1510 insertions(+), 339 deletions(-)**.

## Verification chain

```text
PR #311 exact head CI (run 35516993762: server PASS, web PASS)
→ squash merge into main
   expected merge tree 4e9c940cfaeec734696eebd99277f073f4a648a7
   actual   merge tree 4e9c940cfaeec734696eebd99277f073f4a648a7   (TREE PROOF MATCH)
   squash commit 1ff6eefc4b2d425c3ced0447ad5593c250a83bdd, single parent 1d5eac44…
→ resulting-main exact SHA 1ff6eefc4b2d425c3ced0447ad5593c250a83bdd
→ resulting-main push CI (run 35521481854: event=push, SUCCESS; server SUCCESS, web SUCCESS)
→ migration comparison 20de90c… → 1ff6eef… (server/src/db/migrations diff empty → EXACT expected)
→ Production Deploy (run 35522123163, workflow_dispatch, deploy_sha=1ff6eef…, SUCCESS)
→ deployment health + public Playwright browser smoke (PASS)
→ post-deploy backup (PASS)
→ independent health check: GET https://dunyadentalapp.com/api/health → HTTP 200,
  releaseSha exactly 1ff6eefc4b2d425c3ced0447ad5593c250a83bdd; app shell HTTP 200
```

Resulting-main CI test totals on `1ff6eef`:

| Job | Test files | Tests | Failed |
| --- | --- | --- | --- |
| server | 276 passed \| 3 skipped (279) | 3253 passed \| 4 skipped (3257) | 0 |
| web | 166 passed (166) | 2110 passed (2110) | 0 |

Deployment summary line recorded by the workflow:

```text
PRODUCTION_DEPLOYMENT_COMPLETE sha=1ff6eefc4b2d425c3ced0447ad5593c250a83bdd
previous=/opt/servora-med/releases/20de90ccb97876bf5680d51e0ad4786509cd76f5
migrations_applied=0 browser_smoke=PASS postdeploy_backup=PASS
```

Other deployment parameters: `allow_migrations=false`; rollback was not required
and was not executed.

### Approval provenance (accuracy note)

The `production` environment carries a `required_reviewers` protection rule with
`emrahozcelik` as the reviewer and `prevent_self_review=false`; only the `main`
branch may deploy. The deployment record `6554875644` (sha `1ff6eef…`,
ref `main`) was approved through the GitHub API from the operator's own
credentials, at the operator's explicit direction, before the run left
`waiting`. The workflow's own identity gates (`DEPLOY_SHA` must match
`^[0-9a-f]{40}$`, `GITHUB_REF == refs/heads/main`, `GITHUB_SHA == DEPLOY_SHA`,
and the post-checkout `CHECKED_OUT_SHA == DEPLOY_SHA` assertion) all passed
inside the run.

## Database

- Migrations applied by this release: **0**
- Schema migration files changed between previous production (`20de90c…`) and
  target (`1ff6eef…`): **none**

## Backup state

These are three separate facts; do not conflate them.

- **DEPLOYMENT BACKUP: PASS.** The mandatory deployment backup gates ran as part
  of the fail-closed deployment sequence and the post-deploy backup recorded
  `PASS` in the deployment summary.
- **BR5 WORKER: disabled.** `BACKUP_WORKER_ENABLED=false` remains the safe
  default; the BR5 worker authorization gates in
  [production-deployment.md](./production-deployment.md) are unchanged.
- **HEALTH BACKUP AGGREGATE: `unavailable`.** The observed health response
  reports `backup.status = "unavailable"` with every evidence field `null`,
  which indicates no verified successful `backup_run` evidence existed at that
  moment. This is **not** evidence that the deployment's mandatory predeploy or
  postdeploy backup failed; those are a separate workflow gate, and this
  release's postdeploy backup recorded `PASS`.

## OVR safety

**Effective scanner state remained disabled.** Production forensics found
`OVERDUE_SCANNER_ENABLED` unset; config resolves unset to `false`. This
deployment did not modify the production environment and no scanner activation
occurred.

Supporting evidence:

- `ops/deploy-production.sh` contains **no** reference to `OVERDUE` or to the
  scanner, and it excludes the environment file from the release transfer
  (`--exclude='*/.env'`, `--exclude='*/.env.*'`), so the production environment
  file is not touched by a deployment.
- `server/src/config.ts` reads the flag through the fail-closed `readBoolean`
  helper — `if (!resolved || resolved === 'false') return false;` — so unset
  resolves to `false`.
- `server/src/index.ts` constructs the scanner only when
  `config.overdueScanner?.enabled === true`.
- None of the six changed `server/src` files touches scanner enablement.
- Existing OVR incident history was not modified.

Accuracy note: the runtime value is not exposed by `GET /api/health` (which
returns only `status`, `releaseSha`, and `backup`), so the effective state above
is derived from the config resolution rule plus the production forensic finding,
not from a direct runtime read.

## Web Push field acceptance (closed since the previous release)

The Web Push physical-iOS acceptance that was **PENDING** at the `20de90c`
release has since been **completed and passed**: after a normal logout and
re-login as the same user, the device-notification preference is preserved and
push works, with no new notification permission prompt. The corrected status is
recorded in
[2026-09-19-production-release-20de90c.md](./2026-09-19-production-release-20de90c.md).

This closes **only** the `#307` logout/login subscription-preference regression.
The broader **Phase S** mobile Web Push acceptance (Chrome Android physical
matrix, iPhone/iPad Home Screen matrix, lock-screen privacy, mobile
logout/account-switch, Focus/DND, production VAPID/enablement) remains separate
and **open**.

## Rollback

- The previous release remains installed at
  `/opt/servora-med/releases/20de90ccb97876bf5680d51e0ad4786509cd76f5`.
- Because migrations applied = 0, this release introduced no schema rollback
  step; the previous release remains schema-compatible.
- Rollback was **not** executed (it was not required).

## Run references

- Resulting-main CI: run `35521481854` (push, `main`)
- PR #311 head CI: run `35516993762` (pull_request)
- PR #312 head CI: run `35515612760` (pull_request)
- PR #309 head CI: run `35505196434` (pull_request)
- PR #310 head CI: run `35497995993` (pull_request)
- PR #308 head CI: run `35439384455` (pull_request)
- Production Deploy: run `35522123163` (workflow_dispatch, `main`)
