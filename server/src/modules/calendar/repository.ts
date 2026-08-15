import type { Pool, PoolClient } from 'pg';

import { AppError } from '../../errors/index.js';
import type {
  CalendarActor,
  CalendarConflict,
  CalendarEvent,
  CalendarQuery,
  CalendarUser,
  ManualEventCancelInput,
  ManualEventCreateInput,
  ManualEventPatchInput,
} from './types.js';
import { resolveSourceAccess } from '../job-cards/policy.js';

type CalendarRow = {
  id: string;
  source: 'JOB' | 'MANUAL';
  title: string;
  description: string | null;
  starts_at: Date;
  ends_at: Date | null;
  timezone: string;
  assigned_user_id: string;
  assigned_user_name: string;
  version: number;
  status: string;
  job_type: string | null;
  job_status: string | null;
  priority: string | null;
  customer_id: string | null;
  customer_name: string | null;
  created_by_id: string | null;
  created_by_name: string | null;
  updated_by_id: string | null;
  updated_by_name: string | null;
  source_job_card_id: string | null;
  source_assigned_to: string | null;
  source_job_type: string | null;
  source_planned_at: Date | null;
  source_started_at: Date | null;
  source_staff_completed_at: Date | null;
  source_meeting_at: Date | null;
  source_completed_at: Date | null;
};

const CALENDAR_LIST_SQL = `
SELECT j.id, 'JOB'::text AS source, j.title, NULL::text AS description,
  j.scheduled_at AS starts_at, j.scheduled_ends_at AS ends_at,
  o.timezone, j.assigned_to AS assigned_user_id, assignee.name AS assigned_user_name,
  j.version, j.status, j.type AS job_type, j.status AS job_status, j.priority,
  c.id AS customer_id, c.name AS customer_name,
  NULL::uuid AS created_by_id, NULL::text AS created_by_name,
  NULL::uuid AS updated_by_id, NULL::text AS updated_by_name,
  j.source_job_card_id,
  src.assigned_to AS source_assigned_to,
  src.type AS source_job_type,
  src.scheduled_at AS source_planned_at,
  src.started_at AS source_started_at,
  src.staff_completed_at AS source_staff_completed_at,
  md.meeting_at AS source_meeting_at,
  src.manager_approved_at AS source_completed_at
FROM job_cards j
JOIN organizations o ON o.id = j.organization_id
JOIN users assignee
  ON assignee.organization_id = j.organization_id AND assignee.id = j.assigned_to
LEFT JOIN customers c
  ON c.organization_id = j.organization_id AND c.id = j.customer_id
LEFT JOIN job_cards src
  ON src.organization_id = j.organization_id AND src.id = j.source_job_card_id
LEFT JOIN job_card_meeting_details md
  ON md.organization_id = src.organization_id AND md.job_card_id = src.id
WHERE j.organization_id = $1
  AND ($2::uuid IS NULL OR j.assigned_to = $2)
  AND ($5::text <> 'STAFF' OR j.assigned_to = $6)
  AND j.scheduled_at IS NOT NULL
  AND j.scheduled_at < $4
  AND COALESCE(j.scheduled_ends_at, j.scheduled_at) >= $3
UNION ALL
SELECT e.id, 'MANUAL'::text AS source, e.title, e.description,
  e.starts_at, e.ends_at, e.timezone,
  e.assigned_user_id, assignee.name, e.version, e.status,
  NULL::text, NULL::text, NULL::text, NULL::uuid, NULL::text,
  creator.id, creator.name, updater.id, updater.name,
  NULL::uuid, NULL::uuid, NULL::text, NULL::timestamptz, NULL::timestamptz,
  NULL::timestamptz, NULL::timestamptz, NULL::timestamptz
FROM calendar_events e
JOIN users assignee
  ON assignee.organization_id = e.organization_id AND assignee.id = e.assigned_user_id
JOIN users creator
  ON creator.organization_id = e.organization_id AND creator.id = e.created_by
JOIN users updater
  ON updater.organization_id = e.organization_id AND updater.id = e.updated_by
WHERE e.organization_id = $1
  AND ($2::uuid IS NULL OR e.assigned_user_id = $2)
  AND ($5::text <> 'STAFF' OR e.assigned_user_id = $6)
  AND e.status = 'ACTIVE'
  AND e.starts_at < $4
  AND e.ends_at > $3
ORDER BY starts_at ASC, source ASC, id ASC`;

function event(row: CalendarRow, actor: CalendarActor): CalendarEvent {
  const common = {
    id: row.id,
    source: row.source,
    title: row.title,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at?.toISOString() ?? null,
    timezone: row.timezone,
    assignedUser: { id: row.assigned_user_id, name: row.assigned_user_name },
    version: row.version,
    canEdit: false,
    canCancel: false,
  };
  if (row.source === 'JOB') {
    return {
      ...common,
      source: 'JOB',
      jobCardId: row.id,
      jobType: row.job_type!,
      jobStatus: row.job_status!,
      priority: row.priority!,
      customer: row.customer_id
        ? { id: row.customer_id, name: row.customer_name! }
        : null,
      relatedJobPath: `/jobs/${row.id}`,
      followUpContext: row.source_job_card_id === null || row.source_completed_at === null
        ? null
        : (() => {
            const sourceAccess = resolveSourceAccess(actor, {
              organizationId: actor.organizationId,
              assignedTo: row.source_assigned_to!,
            });
            return {
              sourceAccess,
              sourceJobPath: sourceAccess === 'FULL' ? `/jobs/${row.source_job_card_id}` : null,
              sourcePlannedAt: row.source_planned_at?.toISOString() ?? null,
              sourceOccurredAt: (row.source_job_type === 'SALES_MEETING'
                ? row.source_meeting_at
                : row.source_started_at)?.toISOString()
                ?? row.source_staff_completed_at?.toISOString()
                ?? null,
              sourceCompletedAt: row.source_completed_at.toISOString(),
            };
          })(),
    };
  }
  return {
    ...common,
    source: 'MANUAL',
    description: row.description,
    status: row.status as 'ACTIVE' | 'CANCELLED',
    createdBy: { id: row.created_by_id!, name: row.created_by_name! },
    updatedBy: { id: row.updated_by_id!, name: row.updated_by_name! },
  };
}

export interface CalendarRepository {
  list(actor: CalendarActor, query: CalendarQuery): Promise<CalendarEvent[]>;
  listAssignableUsers(actor: CalendarActor): Promise<CalendarUser[]>;
  getAssignableUser(actor: CalendarActor, userId: string): Promise<CalendarUser | null>;
  getManualEvent(actor: CalendarActor, eventId: string): Promise<CalendarEvent | null>;
  createManual(actor: CalendarActor, input: ManualEventCreateInput, now: Date): Promise<CalendarEvent>;
  patchManual(actor: CalendarActor, eventId: string, input: ManualEventPatchInput, now: Date): Promise<CalendarEvent>;
  cancelManual(actor: CalendarActor, eventId: string, input: ManualEventCancelInput, now: Date): Promise<CalendarEvent>;
}

export class PostgresCalendarRepository implements CalendarRepository {
  constructor(
    private readonly pool: Pool,
    private readonly reminderLeadMinutes = 30,
    private readonly webPushEnabled = false,
  ) {}

  async list(actor: CalendarActor, query: CalendarQuery) {
    const assignedTo = actor.role === 'STAFF' ? actor.id : query.assignedTo;
    const result = await this.pool.query<CalendarRow>(
      CALENDAR_LIST_SQL,
      [actor.organizationId, assignedTo, query.from, query.to, actor.role, actor.id],
    );
    return result.rows.map((row) => event(row, actor));
  }

  async listAssignableUsers(actor: CalendarActor) {
    const result = await this.pool.query<{
      id: string; organization_id: string; name: string; role: CalendarUser['role']; is_active: boolean;
    }>(
      `SELECT u.id, u.organization_id, u.name, u.role, u.is_active
       FROM users u
       WHERE u.organization_id = $1 AND u.role = 'STAFF' AND u.is_active = TRUE
         AND ($2::text <> 'STAFF' OR u.id = $3)
       ORDER BY u.name ASC, u.id ASC`,
      [actor.organizationId, actor.role, actor.id],
    );
    return result.rows.map((row) => ({
      id: row.id,
      organizationId: row.organization_id,
      name: row.name,
      role: row.role,
      isActive: row.is_active,
    }));
  }

  async getAssignableUser(actor: CalendarActor, userId: string) {
    const users = await this.listAssignableUsers(actor);
    return users.find((user) => user.id === userId) ?? null;
  }

  async getManualEvent(actor: CalendarActor, eventId: string) {
    const result = await this.pool.query<CalendarRow>(
      `SELECT e.id, 'MANUAL'::text AS source, e.title, e.description,
        e.starts_at, e.ends_at, e.timezone, e.assigned_user_id,
        assignee.name AS assigned_user_name, e.version, e.status,
        NULL::text AS job_type, NULL::text AS job_status, NULL::text AS priority,
        NULL::uuid AS customer_id, NULL::text AS customer_name,
        creator.id AS created_by_id, creator.name AS created_by_name,
        updater.id AS updated_by_id, updater.name AS updated_by_name
       FROM calendar_events e
       JOIN users assignee ON assignee.organization_id = e.organization_id AND assignee.id = e.assigned_user_id
       JOIN users creator ON creator.organization_id = e.organization_id AND creator.id = e.created_by
       JOIN users updater ON updater.organization_id = e.organization_id AND updater.id = e.updated_by
       WHERE e.organization_id = $1 AND e.id = $2`,
      [actor.organizationId, eventId],
    );
    return result.rows[0] ? event(result.rows[0], actor) : null;
  }

  createManual(actor: CalendarActor, input: ManualEventCreateInput, now: Date) {
    return this.transaction(async (client) => {
      const replay = await this.findReplay(client, actor, input.clientActionId, 'CREATED');
      if (replay) return replay;
      await this.lockUser(client, actor.organizationId, input.assignedUserId);
      await this.assertNoConflict(
        client, actor.organizationId, input.assignedUserId,
        input.startsAt, input.endsAt, null,
      );
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO calendar_events
          (organization_id, assigned_user_id, title, description, starts_at, ends_at,
           timezone, created_by, updated_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$9) RETURNING id`,
        [actor.organizationId, input.assignedUserId, input.title, input.description,
          input.startsAt, input.endsAt, input.timezone, actor.id, now],
      );
      const eventId = inserted.rows[0]!.id;
      await this.afterMutation(client, {
        actor, eventId, assignedUserId: input.assignedUserId,
        action: 'CREATED', clientActionId: input.clientActionId,
        changedFields: ['assignedUserId', 'title', 'description', 'startsAt', 'endsAt', 'timezone'],
        startsAt: input.startsAt, version: 1, now,
        notificationKind: 'calendar.assigned',
        skipActorRecipient: true,
      });
      return (await this.getManualWithClient(client, actor, eventId))!;
    });
  }

  patchManual(
    actor: CalendarActor,
    eventId: string,
    input: ManualEventPatchInput,
    now: Date,
  ) {
    return this.transaction(async (client) => {
      const replay = await this.findReplay(client, actor, input.clientActionId, 'UPDATED');
      if (replay) return replay;
      const current = await this.lockManual(client, actor, eventId);
      if (!current) throw new AppError('NOT_FOUND', 404, 'Takvim kaydı bulunamadı.');
      if (current.status !== 'ACTIVE') {
        throw new AppError('CALENDAR_NOT_EDITABLE', 409, 'İptal edilmiş takvim kaydı düzenlenemez.');
      }
      if (current.version !== input.expectedVersion) {
        throw new AppError('VERSION_CONFLICT', 409, 'Takvim kaydı başka bir işlem tarafından güncellendi.');
      }
      const assignedUserId = input.assignedUserId ?? current.assigned_user_id;
      const startsAt = input.startsAt ?? current.starts_at.toISOString();
      const endsAt = input.endsAt ?? current.ends_at.toISOString();
      if (Date.parse(endsAt) <= Date.parse(startsAt)) {
        throw new AppError('VALIDATION_ERROR', 400, 'Bitiş zamanı başlangıç zamanından sonra olmalıdır.');
      }
      await this.lockUser(client, actor.organizationId, assignedUserId);
      await this.assertNoConflict(
        client, actor.organizationId, assignedUserId, startsAt, endsAt, eventId,
      );
      const changedFields = Object.keys(input).filter(
        (key) => !['clientActionId', 'expectedVersion'].includes(key),
      );
      await client.query(
        `UPDATE calendar_events SET
          assigned_user_id = $3, title = $4, description = $5, starts_at = $6,
          ends_at = $7, timezone = $8, updated_by = $9,
          version = version + 1, updated_at = $10
         WHERE organization_id = $1 AND id = $2 AND version = $11`,
        [actor.organizationId, eventId, assignedUserId, input.title ?? current.title,
          input.description === undefined ? current.description : input.description,
          startsAt, endsAt, input.timezone ?? current.timezone, actor.id, now, input.expectedVersion],
      );
      await this.cancelReminders(client, actor.organizationId, eventId, now);
      await this.afterMutation(client, {
        actor, eventId, assignedUserId, action: 'UPDATED',
        clientActionId: input.clientActionId, changedFields, startsAt,
        version: input.expectedVersion + 1, now,
        notificationKind: 'calendar.rescheduled',
      });
      return (await this.getManualWithClient(client, actor, eventId))!;
    });
  }

  cancelManual(
    actor: CalendarActor,
    eventId: string,
    input: ManualEventCancelInput,
    now: Date,
  ) {
    return this.transaction(async (client) => {
      const replay = await this.findReplay(client, actor, input.clientActionId, 'CANCELLED');
      if (replay) return replay;
      const current = await this.lockManual(client, actor, eventId);
      if (!current) throw new AppError('NOT_FOUND', 404, 'Takvim kaydı bulunamadı.');
      if (current.status !== 'ACTIVE') {
        throw new AppError('CALENDAR_NOT_EDITABLE', 409, 'Takvim kaydı zaten iptal edilmiş.');
      }
      if (current.version !== input.expectedVersion) {
        throw new AppError('VERSION_CONFLICT', 409, 'Takvim kaydı başka bir işlem tarafından güncellendi.');
      }
      await client.query(
        `UPDATE calendar_events SET status = 'CANCELLED', cancelled_by = $3,
          cancelled_at = $4, cancel_reason = $5, updated_by = $3,
          version = version + 1, updated_at = $4
         WHERE organization_id = $1 AND id = $2 AND version = $6`,
        [actor.organizationId, eventId, actor.id, now, input.cancelReason, input.expectedVersion],
      );
      await this.cancelReminders(client, actor.organizationId, eventId, now);
      await this.afterMutation(client, {
        actor, eventId, assignedUserId: current.assigned_user_id,
        action: 'CANCELLED', clientActionId: input.clientActionId,
        changedFields: ['status'], startsAt: null,
        version: input.expectedVersion + 1, now,
        notificationKind: 'calendar.cancelled', reason: input.cancelReason,
      });
      return (await this.getManualWithClient(client, actor, eventId))!;
    });
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async lockManual(client: PoolClient, actor: CalendarActor, eventId: string) {
    const result = await client.query<{
      id: string; assigned_user_id: string; title: string; description: string | null;
      starts_at: Date; ends_at: Date; timezone: string; status: string; version: number;
    }>(
      `SELECT id, assigned_user_id, title, description, starts_at, ends_at,
        timezone, status, version FROM calendar_events
       WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
      [actor.organizationId, eventId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Serializes MANUAL calendar mutations against JobCard create/patch: the
   * assignee user row is locked FOR UPDATE before the availability check so a
   * concurrent JobCard create for the same assignee cannot slip in between the
   * conflict SELECT and the INSERT/UPDATE.
   */
  private async lockUser(client: PoolClient, organizationId: string, userId: string) {
    await client.query(
      `SELECT id FROM users WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
      [organizationId, userId],
    );
  }

  private async assertNoConflict(
    client: PoolClient,
    organizationId: string,
    assignedUserId: string,
    startsAt: string,
    endsAt: string,
    excludedEventId: string | null,
  ) {
    const result = await client.query<CalendarConflict & {
      starts_at: Date;
      ends_at: Date | null;
      assigned_user_name: string;
      related_job_path: string | null;
    }>(
      `SELECT 'MANUAL'::text AS source, e.id, e.title, e.starts_at, e.ends_at,
         u.name AS assigned_user_name, NULL::text AS related_job_path
       FROM calendar_events e
       JOIN users u ON u.organization_id = e.organization_id AND u.id = e.assigned_user_id
       WHERE e.organization_id = $1 AND e.assigned_user_id = $2 AND e.status = 'ACTIVE'
         AND e.id <> COALESCE($5::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
         AND e.starts_at < $4 AND $3 < e.ends_at
       UNION ALL
       SELECT 'JOB', j.id, j.title, j.scheduled_at, j.scheduled_ends_at,
         u.name, '/jobs/' || j.id::text
       FROM job_cards j
       JOIN users u ON u.organization_id = j.organization_id AND u.id = j.assigned_to
       WHERE j.organization_id = $1 AND j.assigned_to = $2
         AND j.scheduled_at IS NOT NULL AND j.scheduled_ends_at IS NOT NULL
         AND j.status NOT IN ('COMPLETED', 'CANCELLED')
         AND j.scheduled_at < $4 AND $3 < j.scheduled_ends_at
       ORDER BY starts_at ASC, id ASC LIMIT 10`,
      [organizationId, assignedUserId, startsAt, endsAt, excludedEventId],
    );
    if (result.rows.length > 0) {
      throw new AppError(
        'CALENDAR_CONFLICT',
        409,
        'Seçilen personelin bu zaman aralığında başka bir planı bulunuyor.',
        {
          conflicts: result.rows.map((row) => ({
            source: row.source,
            id: row.id,
            title: row.title,
            startsAt: row.starts_at.toISOString(),
            endsAt: row.ends_at?.toISOString() ?? null,
            assignedUser: { id: assignedUserId, name: row.assigned_user_name },
            relatedJobPath: row.related_job_path,
          })),
        },
      );
    }
  }

  private async findReplay(
    client: PoolClient,
    actor: CalendarActor,
    clientActionId: string,
    action: string,
  ) {
    const result = await client.query<{ calendar_event_id: string }>(
      `SELECT calendar_event_id FROM calendar_event_activity_logs
       WHERE organization_id = $1 AND actor_user_id = $2
         AND client_action_id = $3 AND action = $4`,
      [actor.organizationId, actor.id, clientActionId, action],
    );
    return result.rows[0]
      ? this.getManualWithClient(client, actor, result.rows[0].calendar_event_id)
      : null;
  }

  private getManualWithClient(client: PoolClient, actor: CalendarActor, eventId: string) {
    const repository = new PostgresCalendarRepository(
      { query: client.query.bind(client) } as Pool,
      this.reminderLeadMinutes,
      this.webPushEnabled,
    );
    return repository.getManualEvent(actor, eventId);
  }

  private async cancelReminders(
    client: PoolClient,
    organizationId: string,
    eventId: string,
    now: Date,
  ) {
    await client.query(
      `UPDATE calendar_reminders SET state = 'CANCELLED', cancelled_at = $3,
        lease_token = NULL, lease_until = NULL, updated_at = $3
       WHERE organization_id = $1 AND calendar_event_id = $2
         AND state IN ('PENDING', 'CLAIMED')`,
      [organizationId, eventId, now],
    );
  }

  private async afterMutation(client: PoolClient, input: {
    actor: CalendarActor;
    eventId: string;
    assignedUserId: string;
    action: 'CREATED' | 'UPDATED' | 'CANCELLED';
    clientActionId: string;
    changedFields: string[];
    startsAt: string | null;
    version: number;
    now: Date;
    notificationKind: 'calendar.assigned' | 'calendar.rescheduled' | 'calendar.cancelled' | null;
    skipActorRecipient?: boolean;
    reason?: string;
  }) {
    const shouldNotify = input.notificationKind !== null
      && (!input.skipActorRecipient || input.assignedUserId !== input.actor.id);
    const resourceKeys = [
      'calendar',
      `calendar:${input.assignedUserId}`,
      'overview',
      ...(shouldNotify ? ['notifications'] : []),
    ];
    const activity = await client.query<{ id: string }>(
      `INSERT INTO calendar_event_activity_logs
        (organization_id, calendar_event_id, actor_user_id, action,
         changed_fields, reason, client_action_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [input.actor.organizationId, input.eventId, input.actor.id, input.action,
        input.changedFields, input.reason ?? null, input.clientActionId, input.now],
    );
    const realtime = await client.query<{ id: bigint }>(
      `INSERT INTO realtime_events
        (organization_id, source_activity_id, calendar_activity_id, event_type,
         entity_type, entity_id, actor_user_id, audience_roles, audience_user_ids,
         resource_keys, created_at)
       VALUES ($1,NULL,$2,$3,'calendar-event',$4,$5,
         ARRAY['ADMIN','MANAGER']::varchar(20)[],ARRAY[$6]::uuid[],
         $7::text[], $8)
       RETURNING id`,
      [input.actor.organizationId, activity.rows[0]!.id,
        input.action === 'CREATED' ? 'calendar.created'
          : input.action === 'UPDATED' ? 'calendar.updated' : 'calendar.cancelled',
        input.eventId, input.actor.id, input.assignedUserId, resourceKeys, input.now],
    );
    if (shouldNotify) {
      const notification = await client.query<{ id: string }>(
        `INSERT INTO in_app_notifications
          (organization_id, recipient_user_id, source_realtime_event_id, kind,
           entity_type, entity_id, created_at)
         VALUES ($1,$2,$3,$4,'calendar-event',$5,$6) RETURNING id`,
        [input.actor.organizationId, input.assignedUserId, realtime.rows[0]!.id,
          input.notificationKind, input.eventId, input.now],
      );
      if (this.webPushEnabled) {
        await client.query(
          `INSERT INTO web_push_deliveries
            (organization_id, notification_id, subscription_id, next_attempt_at)
           SELECT s.organization_id, $1, s.id, $2
           FROM web_push_subscriptions s
           WHERE s.organization_id = $3 AND s.recipient_user_id = $4
             AND s.disabled_at IS NULL
           ON CONFLICT (notification_id, subscription_id) DO NOTHING`,
          [notification.rows[0]!.id, input.now, input.actor.organizationId, input.assignedUserId],
        );
      }
    }
    if (input.startsAt && Date.parse(input.startsAt) > input.now.valueOf()) {
      const remindAt = new Date(Math.max(
        input.now.valueOf(),
        Date.parse(input.startsAt) - this.reminderLeadMinutes * 60_000,
      ));
      await client.query(
        `INSERT INTO calendar_reminders
          (organization_id, calendar_event_id, recipient_user_id, remind_at,
           next_attempt_at, dedupe_key)
         VALUES ($1,$2,$3,$4,$4,$5)
         ON CONFLICT (dedupe_key) DO NOTHING`,
        [input.actor.organizationId, input.eventId, input.assignedUserId, remindAt,
          `MANUAL:${input.eventId}:${input.assignedUserId}:${input.startsAt}:v${input.version}:lead${this.reminderLeadMinutes}`],
      );
    }
  }
}
