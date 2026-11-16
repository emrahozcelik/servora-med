# Weekly Report removal — 060 → 061 migration evidence gate

**Status:** HOLD / rehearsal required; no production authorization.  
**Scope:** PR #417, PostgreSQL 17, migration `061_weekly_report_removal.sql`.  
**Source of truth:** Exact current PR head and the actual production schema head, never a guessed release SHA.

## Preconditions

1. Independently verify PR head/tree, production release SHA and schema 060 (or stop if they differ), R4/trusted-time preflight, health, sufficient free space and migration intent.
2. Obtain a verifiable, sealed **predeploy** backup using the normal production backup tooling; preserve its SHA-256/receipt and all timestamps. Do not download production secrets or raw PII into review artifacts.
3. Restore the encrypted dump **only into an isolated disposable PostgreSQL 17 environment** (or an authorized sanitized 060 fixture). Confirm restore integrity, FK counts, row counts and effective migration head 060 before any write.
4. Capture baseline for `weekly_reports`, `weekly_report_submissions`, `job_cards`, `job_card_activity_logs`, `audit_events`, `processed_actions`, `job_card_lifecycle_intents` (where present), affected PDFs and organizational boundaries. For each, record **counts and digests**, not private row data. Capture current unique constraint/index names.

## Dry-run migration (disposable database only)

- The acceptance script `server/scripts/acceptance/060-061-rehearsal.mjs`
  deliberately refuses all database names except
  `servora_med_rehearsal_060_061` and
  `servora_med_rehearsal_060_061_restored`. It also requires
  `SERVORA_REHEARSAL_ACK=DISPOSABLE_ONLY` before connecting or applying SQL.
  Always verify the actual database host and name are isolated; the guard is
  defense in depth, not authorization to touch production.
- Run the **existing forward-only migration runner** for target 061 with the **exact PR head**. Do not hand-apply fragments or rewrite 051/060, and never point this rehearsal at live production.
- Verify `061` appears once in the migration catalog; target schema readiness and `HEALTH_SCHEMA_VERSION=061` align. Migration 061 must add removal metadata, drop the lifetime Staff/week constraint, create **unique partial index** `weekly_reports_current_staff_week_key` with predicate `removed_at IS NULL`, and expand activity/audit enum-like CHECK lists.
- Verify old rows have `removed_at IS NULL`, preserve their original staff/week claims, and are *bitwise/content-equivalent* for all other columns and relations.
- Validate **no duplicate active** Staff/week keys; any legacy row conflict or failed index creation is a release blocker.

### Invariant SQL (on disposable 061 schema only)

```sql
SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1;
SELECT indexname, indexdef FROM pg_indexes
 WHERE tablename = 'weekly_reports' AND indexname = 'weekly_reports_current_staff_week_key';
SELECT organization_id, staff_user_id, period_start, COUNT(*)
 FROM weekly_reports WHERE removed_at IS NULL
 GROUP BY organization_id, staff_user_id, period_start HAVING COUNT(*) > 1;
SELECT COUNT(*) AS removed_rows FROM weekly_reports WHERE removed_at IS NOT NULL;
SELECT COUNT(*) AS total_reports FROM weekly_reports;
SELECT COUNT(*) AS submission_rows FROM weekly_report_submissions;
```

The catalog table/column names must be confirmed against the repository migration store before running the optional catalog query above; do not blindly assume `schema_migrations.version`.

## Business and concurrency acceptance on disposable database

1. Preserve a completed report with frozen PDF/submission and unrelated source work. Remove with mandatory reason, then create new independent Staff/week; historical original remains readable, original receipt replays old identity.
2. Cancel/invalidate alone must not release week; remove once must release it; a second new action must conflict. A repeated identical action must converge.
3. Multiple remove/create attempts under concurrent transactions must yield only **one active staff/week**, with no 40P01 deadlock or half-committed activity/audit/receipt.
4. Perform real concurrent SUBMIT and REMOVE with different actors, preserving ordered user/job/report locks; assert one valid serialized outcome, no 500/deadlock.
5. Active follow-up child must make preview ineligible; removing command must refuse with `JOB_HAS_ACTIVE_FOLLOW_UPS`; resolving child must restore preview eligibility.
6. Confirm offboarding behavior: explicit removal makes the *removed* report terminal; independent active work and future follow-up responsibility still block as before.
7. Verify older clients without removal capability receive unchanged strict response shapes; new clients parse `removalBlocker` in the **preview only**.

## Backup/restore and release gates

- Record migration duration, lock/wait profile and longest observed exclusive lock time; define an outage/timeout budget **with explicit user approval**. No invented long observation window.
- Run full server/web, schema checks, migration catalog/readiness, document receipt verification, browser smoke and restore rehearsal. Preserve exact SHA, tree and evidence manifest.
- Post-migration restore integrity: prove historical tables, PDFs, idempotency receipts and non-weekly business tables unchanged. Any mismatched count/digest requires HOLD.
- **Do not** merge/deploy/apply production migration in this rehearsal. To release later, request independent approval for forward-only 060→061 migration, backup readiness and production workflow inputs. `allow_migrations=false` cannot deliver 061-required server code before the schema update.
- If critical gate fails, stop. Do **not** attempt unapproved down migrations, direct data deletion or a silent partial deployment.
