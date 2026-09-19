# Production Release — 2026-09-19

Historical, release-specific record. The reusable deployment procedure lives in
[production-deployment.md](./production-deployment.md); this file only records
what happened for the `20de90c` release. Repository: `emrahozcelik/servora-med`.

## Release identity

| Item | Value |
|------|-------|
| Production SHA (this release) | `20de90ccb97876bf5680d51e0ad4786509cd76f5` |
| Previous production | `6270f55962a801d77624a4283b72d47ffaca5e20` |
| Intermediate canonical main not separately deployed | `4f80abce4fab9a176872dcdb11786bdb7a04718f` |
| Canonical main after release | `20de90ccb97876bf5680d51e0ad4786509cd76f5` |

### Why production skipped past the intermediate main

The intermediate main `4f80abce` contained the already-merged #305 and #306
work, but its separate production deployment was intentionally deferred so the
#307 Web Push logout/login remediation could join the same resulting-main
release. Production therefore moved directly
`6270f55… → 20de90c…` as a single release.

This was a deliberate release-bundling decision, **not** skipped validation:
#305 and #306 had already passed their normal merge and CI gates on `main`
(push CI run `35429841288` succeeded for `4f80abc`).

## Included changes

- **PR #305 — follow-up legacy CONFLICT dead-code cleanup.** Removed the
  unreachable follow-up CONFLICT UI and contract remnants
  (`d164fc6`, merged as `4f80abc`).
- **PR #306 — deterministic follow-up PostgreSQL working-day test fixture.**
  Made the follow-up future fixture working-day deterministic (`a2b86fc`,
  merged as `f6ed43b`).
- **PR #307 — preserve Web Push subscription across normal logout/login.**
  Approved implementation head `9617d44ba2f9c49f404138bc938569a17fac6442`
  (`db203a2` fix + `9617d44` test), merged as `20de90c`.

### Review provenance (accuracy note)

PR #307 has **no GitHub-native APPROVE review object**: at documentation time
the GitHub review API held zero recorded review entries for the pull request.
The implementation was independently re-reviewed outside the GitHub review
record before merge. This record does not speculate about branch-protection or
bypass mechanics; only the absence of a GitHub review object is stated.

## Verification chain

```text
PR #307 exact head CI (run 35434735795: server PASS, web PASS)
→ merge into main
→ resulting-main exact SHA 20de90ccb97876bf5680d51e0ad4786509cd76f5
→ resulting-main push CI (run 35436495389: event=push, SUCCESS; server SUCCESS, web SUCCESS)
→ migration comparison 6270f55… → 20de90c… (server/src/db/migrations diff empty → EXACT expected)
→ Production Deploy (run 35437182240, workflow_dispatch, deploy_sha=20de90c…, SUCCESS)
→ deployment health + public Playwright browser smoke (PASS)
→ post-deploy backup (PASS)
→ independent health check: GET https://dunyadentalapp.com/api/health → HTTP 200,
  releaseSha exactly 20de90ccb97876bf5680d51e0ad4786509cd76f5; app shell HTTP 200
```

Deployment summary line recorded by the workflow:

```text
PRODUCTION_DEPLOYMENT_COMPLETE sha=20de90ccb97876bf5680d51e0ad4786509cd76f5
previous=/opt/servora-med/releases/6270f55962a801d77624a4283b72d47ffaca5e20
migrations_applied=0 browser_smoke=PASS postdeploy_backup=PASS
```

Other deployment parameters: `allow_migrations=false`; rollback was not
required and was not executed.

## Database

- Migrations applied by this release: **0**
- Schema migration files changed between previous production (`6270f55…`) and
  target (`20de90c…`): **none**

## Backup state

These are three separate facts; do not conflate them.

- **DEPLOYMENT BACKUP: PASS.** The mandatory deployment backup gates ran as
  part of the fail-closed deployment sequence and the post-deploy backup
  recorded `PASS` in the deployment summary.
- **BR5 WORKER: disabled.** `BACKUP_WORKER_ENABLED=false` remains the safe
  default; the BR5 worker authorization gates in
  [production-deployment.md](./production-deployment.md) are unchanged.
- **HEALTH BACKUP AGGREGATE:** `/api/health` may report the backup aggregate
  as `unavailable` while the worker remains intentionally disabled. Observed in
  this release's health response. This is an expected state under the current
  policy and is **not** evidence that the deployment's mandatory predeploy or
  postdeploy backup failed.

## Web Push rollout status (PR #307)

- Automated/code status: **FIXED / MERGED / DEPLOYED** (release `20de90c…`).
- Physical affected-iOS validation: **PENDING**.

Manual acceptance on the affected device is still required before the field
regression can be closed:

1. Open the installed PWA on the affected iPhone.
2. Confirm device notifications currently show `Cihaz bildirimlerini kapat`.
3. Logout normally.
4. Do not change iOS notification permission/settings.
5. Login again as the same user.
6. Open `Kurulum ve cihaz bildirimleri`.
7. Wait for reconciliation.
8. Expected: `Cihaz bildirimlerini kapat`.
9. No new notification permission prompt.
10. Record: iOS version, standalone PWA yes/no, production SHA, before state,
    after state.

Until that succeeds, do not write "iOS issue fully closed". Accurate wording:
**"Code/production remediation deployed; affected-device field acceptance
pending."**

## OVR safety

- `OVERDUE_SCANNER_ENABLED=false`.
- No OVR scanner activation occurred in this release.
- Existing OVR incident history was not modified.

## Rollback

- The previous release remains installed at
  `/opt/servora-med/releases/6270f55962a801d77624a4283b72d47ffaca5e20`.
- Because migrations applied = 0, this release introduced no schema rollback
  step; the previous release remains schema-compatible.
- Rollback was **not** executed (it was not required).

## Run references

- Resulting-main CI: run `35436495389` (push, `main`)
- PR #307 head CI: run `35434735795` (pull_request)
- Production Deploy: run `35437182240` (workflow_dispatch, `main`)
