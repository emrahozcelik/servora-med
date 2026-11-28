-- SCH-001 §7 read-only collision inventory for a release that contains the
-- RESCUE-004/A released-reservation predicate
-- (server/src/modules/job-cards/occupancy.ts, JOB_STAFF_RESERVATION_RELEASED_SQL).
--
-- Run only as a read-only REPEATABLE READ audit (under the write fence before
-- rollback, between operator-only reconciliation rounds until zero overlaps
-- remain, or as an optional post-check across return). It never edits a row.
-- The explicit READ ONLY REPEATABLE READ transaction pins one consistent MVCC
-- snapshot across all four result sets and causes any accidental write to fail.
--
-- Output privacy: emits opaque UUID identifiers, enums, booleans, and
-- timestamps only (no organization, user, or customer names and no titles).
--
-- Required psql variable: calendar_enabled = true|false
--   Use the target environment's CALENDAR_ENABLED value. Manual calendar plans
--   contribute to occupancy only when Calendar is enabled (SCH-001 §2).
--
-- Connection / credential rules:
--   - NEVER pass a credential-bearing PostgreSQL URL in psql process argv
--     (never `psql "$PRODUCTION_DATABASE_URL"`).
--   - Use local OS peer authentication as a preauthorized read-only role, OR
--     a preauthorized read-only service alias (`PGSERVICE` / `~/.pg_service.conf`)
--     paired with `PGPASSFILE` (mode 0600). This file does not create or assume
--     a preconfigured service alias or touch credentials.
--   - Validating this file against an isolated, disposable PostgreSQL 17
--     fixture is allowed and recommended; keep test outputs strictly separate
--     from production gate records.
--
-- Example usage (service alias + PGPASSFILE; no URL or password on argv):
--   PGSERVICE=<readonly_service_alias> PGPASSFILE=/path/to/readonly.pgpass \
--     psql \
--       --set=ON_ERROR_STOP=1 \
--       --set=calendar_enabled=true \
--       --file docs/operations/sql/rescue-004a-rollback-inventory.sql

BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '30s';

-- 1. Released reservations: NEW on-site jobs whose newest offer (by canonical
-- opened_at DESC, id DESC) belongs to the current assignee and is DECLINED or
-- RELEASED, with a positive persisted interval. This is the population the
-- older binary counts as occupying again.
WITH latest_offer AS (
  SELECT DISTINCT ON (o.organization_id, o.job_card_id)
         o.organization_id, o.job_card_id, o.id, o.assignee_user_id, o.state,
         o.opened_at, o.closed_at
    FROM job_card_assignment_offers o
   ORDER BY o.organization_id, o.job_card_id, o.opened_at DESC, o.id DESC
)
SELECT j.organization_id,
       j.id AS released_job_id,
       j.type AS released_job_type,
       j.assigned_to AS assignee_user_id,
       j.scheduled_at AS released_starts_at,
       j.scheduled_ends_at AS released_ends_at,
       lo.id AS newest_offer_id,
       lo.state AS newest_offer_state,
       lo.opened_at AS newest_offer_opened_at,
       lo.closed_at AS newest_offer_closed_at
  FROM job_cards j
  JOIN latest_offer lo
    ON lo.organization_id = j.organization_id
   AND lo.job_card_id = j.id
 WHERE j.status = 'NEW'
   AND j.type IN ('SALES_MEETING', 'PRODUCT_DELIVERY')
   AND j.scheduled_at IS NOT NULL
   AND j.scheduled_ends_at IS NOT NULL
   AND j.scheduled_ends_at > j.scheduled_at
   AND lo.assignee_user_id = j.assigned_to
   AND lo.state IN ('DECLINED', 'RELEASED')
 ORDER BY j.organization_id, j.scheduled_at, j.id;

-- 2. Same-assignee active job overlaps involving at least one released job.
-- Because the older binary counts every active job (including released ones),
-- both released+held and released+released overlapping pairs become conflicts
-- on rollback. Deduplicate ONLY when both jobs are released using canonical ID
-- order (r.id < b.id). Match legacy SQL (`occupancy.ts` before RESCUE-004/A)
-- by requiring the comparison job's JOB-007 occupied end to strictly exceed
-- its scheduled start.
WITH latest_offer AS (
  SELECT DISTINCT ON (o.organization_id, o.job_card_id)
         o.organization_id, o.job_card_id, o.assignee_user_id, o.state
    FROM job_card_assignment_offers o
   ORDER BY o.organization_id, o.job_card_id, o.opened_at DESC, o.id DESC
),
released AS (
  SELECT j.organization_id, j.id, j.type, j.assigned_to,
         j.scheduled_at, j.scheduled_ends_at
    FROM job_cards j
    JOIN latest_offer lo
      ON lo.organization_id = j.organization_id
     AND lo.job_card_id = j.id
   WHERE j.status = 'NEW'
     AND j.type IN ('SALES_MEETING', 'PRODUCT_DELIVERY')
     AND j.scheduled_at IS NOT NULL
     AND j.scheduled_ends_at IS NOT NULL
     AND j.scheduled_ends_at > j.scheduled_at
     AND lo.assignee_user_id = j.assigned_to
     AND lo.state IN ('DECLINED', 'RELEASED')
),
active_job AS (
  SELECT b.organization_id, b.id, b.type, b.status, b.assigned_to,
         b.scheduled_at,
         CASE
           WHEN b.status = 'WAITING_APPROVAL' AND b.staff_completed_at IS NOT NULL
             THEN LEAST(b.scheduled_ends_at, b.staff_completed_at)
           ELSE b.scheduled_ends_at
         END AS occupied_ends_at
    FROM job_cards b
   WHERE b.type IN ('SALES_MEETING', 'PRODUCT_DELIVERY')
     AND b.scheduled_at IS NOT NULL
     AND b.scheduled_ends_at IS NOT NULL
     AND b.status IN ('NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED')
     AND b.scheduled_at < (
       CASE
         WHEN b.status = 'WAITING_APPROVAL' AND b.staff_completed_at IS NOT NULL
           THEN LEAST(b.scheduled_ends_at, b.staff_completed_at)
         ELSE b.scheduled_ends_at
       END
     )
)
SELECT r.organization_id,
       r.assigned_to AS assignee_user_id,
       r.id AS released_job_id,
       r.type AS released_job_type,
       r.scheduled_at AS released_starts_at,
       r.scheduled_ends_at AS released_ends_at,
       b.id AS overlapping_job_id,
       b.type AS overlapping_job_type,
       b.status AS overlapping_status,
       b.scheduled_at AS overlapping_starts_at,
       b.occupied_ends_at AS overlapping_occupied_ends_at,
       (rb.id IS NOT NULL) AS overlapping_job_also_released
  FROM released r
  JOIN active_job b
    ON b.organization_id = r.organization_id
   AND b.assigned_to = r.assigned_to
   AND b.id <> r.id
   AND b.scheduled_at < r.scheduled_ends_at
   AND r.scheduled_at < b.occupied_ends_at
  LEFT JOIN released rb
    ON rb.organization_id = b.organization_id
   AND rb.id = b.id
 WHERE (rb.id IS NULL OR r.id < b.id)
 ORDER BY r.organization_id, r.scheduled_at, r.id, b.scheduled_at, b.id;

-- 3. Same-assignee ACTIVE manual calendar overlaps. Rows exist only when
-- :calendar_enabled is true (SCH-001 §2).
WITH latest_offer AS (
  SELECT DISTINCT ON (o.organization_id, o.job_card_id)
         o.organization_id, o.job_card_id, o.assignee_user_id, o.state
    FROM job_card_assignment_offers o
   ORDER BY o.organization_id, o.job_card_id, o.opened_at DESC, o.id DESC
),
released AS (
  SELECT j.organization_id, j.id, j.assigned_to,
         j.scheduled_at, j.scheduled_ends_at
    FROM job_cards j
    JOIN latest_offer lo
      ON lo.organization_id = j.organization_id
     AND lo.job_card_id = j.id
   WHERE j.status = 'NEW'
     AND j.type IN ('SALES_MEETING', 'PRODUCT_DELIVERY')
     AND j.scheduled_at IS NOT NULL
     AND j.scheduled_ends_at IS NOT NULL
     AND j.scheduled_ends_at > j.scheduled_at
     AND lo.assignee_user_id = j.assigned_to
     AND lo.state IN ('DECLINED', 'RELEASED')
)
SELECT :'calendar_enabled'::boolean AS calendar_enabled,
       r.organization_id,
       r.assigned_to AS assignee_user_id,
       r.id AS released_job_id,
       r.scheduled_at AS released_starts_at,
       r.scheduled_ends_at AS released_ends_at,
       e.id AS manual_event_id,
       e.starts_at AS manual_starts_at,
       e.ends_at AS manual_ends_at
  FROM released r
  JOIN calendar_events e
    ON e.organization_id = r.organization_id
   AND e.assigned_user_id = r.assigned_to
   AND e.status = 'ACTIVE'
   AND e.starts_at < r.scheduled_ends_at
   AND r.scheduled_at < e.ends_at
 WHERE :'calendar_enabled'::boolean
 ORDER BY r.organization_id, r.scheduled_at, r.id, e.starts_at, e.id;

-- 4. Summary for the gate record. Uses the exact same predicates in the same
-- REPEATABLE READ READ ONLY snapshot so counts agree with queries 1-3, and
-- explicitly records the manual calendar contribution flag.
WITH latest_offer AS (
  SELECT DISTINCT ON (o.organization_id, o.job_card_id)
         o.organization_id, o.job_card_id, o.assignee_user_id, o.state
    FROM job_card_assignment_offers o
   ORDER BY o.organization_id, o.job_card_id, o.opened_at DESC, o.id DESC
),
released AS (
  SELECT j.organization_id, j.id, j.assigned_to,
         j.scheduled_at, j.scheduled_ends_at
    FROM job_cards j
    JOIN latest_offer lo
      ON lo.organization_id = j.organization_id
     AND lo.job_card_id = j.id
   WHERE j.status = 'NEW'
     AND j.type IN ('SALES_MEETING', 'PRODUCT_DELIVERY')
     AND j.scheduled_at IS NOT NULL
     AND j.scheduled_ends_at IS NOT NULL
     AND j.scheduled_ends_at > j.scheduled_at
     AND lo.assignee_user_id = j.assigned_to
     AND lo.state IN ('DECLINED', 'RELEASED')
),
active_job AS (
  SELECT b.organization_id, b.id, b.assigned_to, b.scheduled_at,
         CASE
           WHEN b.status = 'WAITING_APPROVAL' AND b.staff_completed_at IS NOT NULL
             THEN LEAST(b.scheduled_ends_at, b.staff_completed_at)
           ELSE b.scheduled_ends_at
         END AS occupied_ends_at
    FROM job_cards b
   WHERE b.type IN ('SALES_MEETING', 'PRODUCT_DELIVERY')
     AND b.scheduled_at IS NOT NULL
     AND b.scheduled_ends_at IS NOT NULL
     AND b.status IN ('NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED')
     AND b.scheduled_at < (
       CASE
         WHEN b.status = 'WAITING_APPROVAL' AND b.staff_completed_at IS NOT NULL
           THEN LEAST(b.scheduled_ends_at, b.staff_completed_at)
         ELSE b.scheduled_ends_at
       END
     )
)
SELECT
  :'calendar_enabled'::boolean AS calendar_enabled,
  (SELECT count(*) FROM released) AS released_reservations,
  (SELECT count(*)
     FROM released r
     JOIN active_job b
       ON b.organization_id = r.organization_id
      AND b.assigned_to = r.assigned_to
      AND b.id <> r.id
      AND b.scheduled_at < r.scheduled_ends_at
      AND r.scheduled_at < b.occupied_ends_at
     LEFT JOIN released rb
       ON rb.organization_id = b.organization_id
      AND rb.id = b.id
    WHERE (rb.id IS NULL OR r.id < b.id)) AS overlapping_active_jobs,
  (SELECT count(*)
     FROM released r
     JOIN calendar_events e
       ON e.organization_id = r.organization_id
      AND e.assigned_user_id = r.assigned_to
      AND e.status = 'ACTIVE'
      AND e.starts_at < r.scheduled_ends_at
      AND r.scheduled_at < e.ends_at
    WHERE :'calendar_enabled'::boolean) AS overlapping_active_manual_plans;

COMMIT;
