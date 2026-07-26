import type { Pool } from 'pg';

import type { SafeUser } from '../auth/types.js';
import type { ReportsReadModel } from '../reports/ports.js';
import type {
  OverviewQuery,
  StaffOverviewResponse,
  ManagementOverviewResponse,
  OverviewUpcomingWork,
} from './types.js';

export interface OverviewReadModel {
  getStaffOverview(
    actor: SafeUser,
    query: OverviewQuery,
    requestTime: Date,
  ): Promise<Omit<StaffOverviewResponse, 'upcomingWork'>>;
  getManagementOverview(
    actor: SafeUser,
    query: OverviewQuery,
    requestTime: Date,
  ): Promise<Omit<ManagementOverviewResponse, 'upcomingWork'>>;
  getUpcomingWork?(
    actor: SafeUser,
    requestTime: Date,
  ): Promise<OverviewUpcomingWork>;
}

type RecentWorkRow = {
  id: string;
  title: string;
  customer_name: string | null;
  assignee_name: string | null;
  completed_at: Date;
};

type RecentNoteRow = {
  id: string;
  job_card_id: string;
  job_title: string;
  preview: string;
  author_name: string;
  created_at: Date;
};

const RECENT_COMPLETED_SQL = `
SELECT j.id, j.title, c.name AS customer_name, assignee.name AS assignee_name,
  j.manager_approved_at AS completed_at
FROM job_cards j
JOIN organizations o ON o.id = j.organization_id
LEFT JOIN customers c
  ON c.organization_id = j.organization_id AND c.id = j.customer_id
LEFT JOIN users assignee
  ON assignee.organization_id = j.organization_id AND assignee.id = j.assigned_to
WHERE j.organization_id = $1
  AND j.status = 'COMPLETED'
  AND j.manager_approved_at >= ($2::date AT TIME ZONE o.timezone)
  AND j.manager_approved_at < (($3::date + 1) AT TIME ZONE o.timezone)
  AND ($4::uuid IS NULL OR j.assigned_to = $4)
ORDER BY j.manager_approved_at DESC, j.id DESC
LIMIT 10`;

const RECENT_NOTES_SQL = `
SELECT n.id, n.job_card_id, j.title AS job_title, left(n.note, 160) AS preview,
  author.name AS author_name, n.created_at
FROM job_card_notes n
JOIN job_cards j
  ON j.organization_id = n.organization_id AND j.id = n.job_card_id
JOIN organizations o ON o.id = n.organization_id
JOIN users author
  ON author.organization_id = n.organization_id AND author.id = n.author_id
WHERE n.organization_id = $1
  AND n.created_at >= ($2::date AT TIME ZONE o.timezone)
  AND n.created_at < (($3::date + 1) AT TIME ZONE o.timezone)
  AND ($4::uuid IS NULL OR j.assigned_to = $4)
ORDER BY n.created_at DESC, n.id DESC
LIMIT 10`;

export class PostgresOverviewRepository implements OverviewReadModel {
  constructor(
    private readonly pool: Pick<Pool, 'query'>,
    private readonly reports: Pick<
      ReportsReadModel,
      'getOne' | 'getDashboard' | 'getApprovalSummary'
    >,
  ) {}

  async getStaffOverview(
    actor: SafeUser,
    query: OverviewQuery,
    requestTime: Date,
  ) {
    const summary = await this.reports.getOne({
      organizationId: actor.organizationId,
      staffUserId: actor.id,
      requestedRange: query.requestedRange,
      requestTime,
    });
    if (!summary) {
      throw new Error('Staff overview range could not be resolved.');
    }
    const [recentCompletedWork, recentNotes] = await this.recent(
      actor.organizationId,
      summary.range.from,
      summary.range.to,
      actor.id,
    );
    return {
      scope: 'staff' as const,
      range: summary.range,
      generatedAt: requestTime.toISOString(),
      openJobCards: summary.counters.openJobCards,
      waitingApproval: summary.counters.waitingApproval,
      revisionRequested: summary.counters.revisionRequested,
      completedInPeriod: summary.counters.completedInPeriod,
      recentCompletedWork,
      recentNotes,
    };
  }

  async getManagementOverview(
    actor: SafeUser,
    query: OverviewQuery,
    requestTime: Date,
  ) {
    const input = {
      organizationId: actor.organizationId,
      requestedRange: query.requestedRange,
      requestTime,
    };
    const [dashboard, approval] = await Promise.all([
      this.reports.getDashboard(input),
      this.reports.getApprovalSummary({
        organizationId: actor.organizationId,
        requestTime,
      }),
    ]);
    const [recentCompletedWork, recentNotes] = await this.recent(
      actor.organizationId,
      dashboard.range.from,
      dashboard.range.to,
      null,
    );
    return {
      scope: 'management' as const,
      range: dashboard.range,
      generatedAt: requestTime.toISOString(),
      active: dashboard.counters.activeJobCards,
      overdue: dashboard.counters.overdueJobCards,
      waitingApproval: dashboard.counters.waitingApproval,
      revisionRequested: dashboard.counters.revisionRequested,
      completedInPeriod: dashboard.counters.completedInPeriod,
      cancelledInPeriod: dashboard.counters.cancelledInPeriod,
      completionTrend: dashboard.completedTrend,
      approvalQueueSummary: {
        pendingCount: approval.pendingCount,
        oldestWaitingMinutes: approval.oldestWaitingMinutes,
      },
      recentCompletedWork,
      recentNotes,
    };
  }

  async getUpcomingWork(actor: SafeUser, requestTime: Date) {
    const from = requestTime.toISOString();
    const to = new Date(requestTime.valueOf() + 7 * 24 * 60 * 60 * 1_000).toISOString();
    const limit = actor.role === 'STAFF' ? 5 : 10;
    const result = await this.pool.query<{
      id: string; source: 'JOB' | 'MANUAL'; title: string; starts_at: Date;
      ends_at: Date | null; assigned_user_name: string;
    }>(
      `SELECT j.id, 'JOB'::text AS source, j.title, j.scheduled_at AS starts_at,
         j.scheduled_ends_at AS ends_at, u.name AS assigned_user_name
       FROM job_cards j
       JOIN users u ON u.organization_id = j.organization_id AND u.id = j.assigned_to
       WHERE j.organization_id = $1
         AND ($2::text <> 'STAFF' OR j.assigned_to = $3)
         AND ($2::text <> 'MANAGER' OR EXISTS (
           SELECT 1 FROM staff_profiles sp
           WHERE sp.organization_id = j.organization_id
             AND sp.user_id = j.assigned_to
             AND sp.manager_user_id = $3
         ))
         AND j.status NOT IN ('COMPLETED','CANCELLED')
         AND j.scheduled_at >= $4 AND j.scheduled_at < $5
       UNION ALL
       SELECT e.id, 'MANUAL', e.title, e.starts_at, e.ends_at, u.name
       FROM calendar_events e
       JOIN users u ON u.organization_id = e.organization_id AND u.id = e.assigned_user_id
       WHERE e.organization_id = $1
         AND ($2::text <> 'STAFF' OR e.assigned_user_id = $3)
         AND ($2::text <> 'MANAGER' OR EXISTS (
           SELECT 1 FROM staff_profiles sp
           WHERE sp.organization_id = e.organization_id
             AND sp.user_id = e.assigned_user_id
             AND sp.manager_user_id = $3
         ))
         AND e.status = 'ACTIVE' AND e.starts_at >= $4 AND e.starts_at < $5
       ORDER BY starts_at ASC, source ASC, id ASC LIMIT $6`,
      [actor.organizationId, actor.role, actor.id, from, to, limit],
    );
    return {
      items: result.rows.map((row) => ({
        id: row.id,
        source: row.source,
        title: row.title,
        startsAt: row.starts_at.toISOString(),
        endsAt: row.ends_at?.toISOString() ?? null,
        assignedUserName: row.assigned_user_name,
        path: row.source === 'JOB'
          ? `/jobs/${row.id}`
          : `/calendar?event=${row.id}`,
      })),
      window: { from, to },
    };
  }

  private async recent(
    organizationId: string,
    from: string,
    to: string,
    staffUserId: string | null,
  ) {
    const values = [organizationId, from, to, staffUserId];
    const [work, notes] = await Promise.all([
      this.pool.query<RecentWorkRow>(RECENT_COMPLETED_SQL, values),
      this.pool.query<RecentNoteRow>(RECENT_NOTES_SQL, values),
    ]);
    return [
      work.rows.map((row) => ({
        id: row.id,
        title: row.title,
        customerName: row.customer_name,
        assigneeName: row.assignee_name,
        completedAt: row.completed_at.toISOString(),
      })),
      notes.rows.map((row) => ({
        id: row.id,
        jobCardId: row.job_card_id,
        jobTitle: row.job_title,
        preview: row.preview,
        authorName: row.author_name,
        createdAt: row.created_at.toISOString(),
      })),
    ] as const;
  }
}
