import type { PoolClient } from 'pg';

import { JOB_CALENDAR_OCCUPIED_ENDS_AT_SQL } from './job-card-duration.js';

/**
 * Core staff occupancy: the single SQL definition of "this staff member is
 * busy in [startsAt, endsAt)". Planning is core and does not depend on the
 * calendar module flag. Jobs always occupy; manual `calendar_events` occupy
 * only when the calendar module is enabled (`includeCalendarEvents`).
 */
type Queryable = Pick<PoolClient, 'query'>;

/**
 * RESCUE-004/A (SCH-001 addendum): the one SQL truth for "Staff may use this
 * job's planned interval again".
 *
 * The newest assignment offer is selected FIRST (`opened_at DESC, id DESC`)
 * and only then required to belong to the job's current assignee and to be
 * `DECLINED` or `RELEASED`. Therefore:
 *
 * - an older refusal never releases work that a newer offer re-acquired;
 * - another Staff member's answer never colors the current assignee's
 *   reservation;
 * - `OPEN`, `ACCEPTED`, `EXPIRED`, `WITHDRAWN`, no offer and any other job
 *   status keep the SCH-001 behavior exactly.
 *
 * Only a planned on-site `NEW` job can be released, and only while it still
 * carries a real (positive) persisted interval. A legacy START_ONLY row
 * (`scheduled_ends_at IS NULL`) is projected by the Calendar with a start and
 * no end, but it never occupied a Staff interval, so there is no reservation
 * to report as released. A non-positive interval is the same: it was never
 * occupancy.
 *
 * The predicate is reused verbatim by the Calendar job projection
 * (`staffReservationReleased`), so the conflict reader and the read model
 * cannot drift.
 */
export const JOB_STAFF_RESERVATION_RELEASED_SQL = `(
  j.status = 'NEW'
  AND j.type IN ('SALES_MEETING', 'PRODUCT_DELIVERY')
  AND j.scheduled_at IS NOT NULL
  AND j.scheduled_ends_at IS NOT NULL
  AND j.scheduled_ends_at > j.scheduled_at
  AND EXISTS (
    SELECT 1
    FROM (
      SELECT o.assignee_user_id, o.state
      FROM job_card_assignment_offers o
      WHERE o.organization_id = j.organization_id
        AND o.job_card_id = j.id
      ORDER BY o.opened_at DESC, o.id DESC
      LIMIT 1
    ) latest_offer
    WHERE latest_offer.assignee_user_id = j.assigned_to
      AND latest_offer.state IN ('DECLINED', 'RELEASED')
  )
)`;

export type StaffOccupancyQuery = {
  organizationId: string;
  assignedUserId: string;
  startsAt: string | Date;
  endsAt: string | Date;
  excludeJobCardId?: string | null;
  excludeCalendarEventId?: string | null;
  includeCalendarEvents: boolean;
};

export type StaffOccupancyConflict = {
  source: 'JOB' | 'MANUAL';
  id: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  assignedUserName: string;
  relatedJobPath: string | null;
};

type OccupancyRow = {
  source: 'JOB' | 'MANUAL';
  id: string;
  title: string;
  starts_at: Date;
  ends_at: Date;
  assigned_user_name: string;
  related_job_path: string | null;
};

const DEFAULT_CONFLICT_LIMIT = 10;

// `LIMIT NULL` is unlimited in PostgreSQL; `limit === null` means no cap.

async function queryOccupancy(
  client: Queryable,
  query: StaffOccupancyQuery,
  orderBy: string,
  limit: number | null,
): Promise<OccupancyRow[]> {
  const result = await client.query<OccupancyRow>(
    `SELECT 'MANUAL'::text AS source, e.id, e.title, e.starts_at, e.ends_at,
       u.name AS assigned_user_name, NULL::text AS related_job_path
     FROM calendar_events e
     JOIN users u ON u.organization_id = e.organization_id AND u.id = e.assigned_user_id
     WHERE $8::boolean
       AND e.organization_id = $1 AND e.assigned_user_id = $2
       AND e.status = 'ACTIVE'
       AND ($7::uuid IS NULL OR e.id <> $7)
       AND e.starts_at < $4 AND $3 < e.ends_at
     UNION ALL
     SELECT 'JOB', j.id, j.title, j.scheduled_at, ${JOB_CALENDAR_OCCUPIED_ENDS_AT_SQL},
       u.name, '/jobs/' || j.id::text
     FROM job_cards j
     JOIN users u ON u.organization_id = j.organization_id AND u.id = j.assigned_to
     WHERE j.organization_id = $1 AND j.assigned_to = $2
       AND ($5::uuid IS NULL OR j.id <> $5)
       AND j.type IN ('SALES_MEETING', 'PRODUCT_DELIVERY')
       AND j.scheduled_at IS NOT NULL AND j.scheduled_ends_at IS NOT NULL
       AND j.status IN ('NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED')
       AND NOT ${JOB_STAFF_RESERVATION_RELEASED_SQL}
       AND j.scheduled_at < ${JOB_CALENDAR_OCCUPIED_ENDS_AT_SQL}
       AND j.scheduled_at < $4 AND $3 < ${JOB_CALENDAR_OCCUPIED_ENDS_AT_SQL}
     ORDER BY ${orderBy} LIMIT $6::int`,
    [
      query.organizationId,
      query.assignedUserId,
      query.startsAt,
      query.endsAt,
      query.excludeJobCardId ?? null,
      limit,
      query.excludeCalendarEventId ?? null,
      query.includeCalendarEvents,
    ],
  );
  return result.rows;
}

/** Conflict rows, ordered by start then id, capped at `limit` (default 10). */
export async function findStaffOccupancyConflicts(
  client: Queryable,
  query: StaffOccupancyQuery,
  limit: number = DEFAULT_CONFLICT_LIMIT,
): Promise<StaffOccupancyConflict[]> {
  const rows = await queryOccupancy(client, query, 'starts_at ASC, id ASC', limit);
  return rows.map((row) => ({
    source: row.source,
    id: row.id,
    title: row.title,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    assignedUserName: row.assigned_user_name,
    relatedJobPath: row.related_job_path,
  }));
}

/** Busy intervals only (slot search, auto-scheduler), ordered by start then end. */
export async function listStaffOccupiedIntervals(
  client: Queryable,
  query: StaffOccupancyQuery,
): Promise<Array<{ startsAt: string; endsAt: string }>> {
  const rows = await queryOccupancy(client, query, 'starts_at ASC, ends_at ASC', null);
  return rows.map((row) => ({
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
  }));
}
