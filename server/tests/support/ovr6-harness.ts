import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { PostgresMigrationStore } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrate-runner.js';
import {
  PostgresAssignmentOfferExpiryRepository,
  createAssignmentOfferExpiryWorker,
} from '../../src/modules/job-cards/assignment-offer-expiry-worker.js';
import {
  PostgresLatenessAlertWorkerRepository,
  createLatenessAlertWorker,
} from '../../src/modules/job-cards/lateness-alert-worker.js';
import {
  addCalendarDaysToDateKey,
  instantFromLocal,
  localDateKey,
  weekdayOfDateKey,
} from '../../src/modules/job-cards/local-calendar.js';
import {
  PostgresOverdueReminderWorkerRepository,
  createOverdueReminderWorker,
} from '../../src/modules/job-cards/overdue-reminder-worker.js';
import { PostgresJobCardRepository } from '../../src/modules/job-cards/repository.js';
import { JobCardService } from '../../src/modules/job-cards/service.js';
import type { JobCardActor, JobCardStatus, JobCardType } from '../../src/modules/job-cards/types.js';
import type { NotificationWindowPolicy } from '../../src/modules/notifications/quiet-hours.js';
import type { RealtimeEventPublisher } from '../../src/modules/realtime/event-bus.js';
import type { RealtimeEventRecord } from '../../src/modules/realtime/types.js';
import { HOUR_MS, MINUTE_MS } from './db-clock-baseline.js';

/**
 * OVR-6 shared PostgreSQL fixtures.
 *
 * Every scenario anchors its instants on the organization-local calendar
 * (`Europe/Istanbul` by default) and derives them from the DB arbitration
 * clock, so a suite never ages and the injected service clock stays at or
 * before the scan instant it is compared with.
 */

export const databaseUrl = process.env.TEST_DATABASE_URL;
export const MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL('../../src/db/migrations', import.meta.url),
);
export const DEFAULT_TIMEZONE = 'Europe/Istanbul';

export { HOUR_MS, MINUTE_MS };

export async function withSchema(
  prefix: string,
  run: (pool: Pool) => Promise<void>,
): Promise<void> {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `${prefix}_${randomUUID().replaceAll('-', '')}`.toLowerCase();
  let pool: Pool | null = null;
  try {
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema},public`,
    });
    await runMigrations({
      migrationsDirectory: MIGRATIONS_DIRECTORY,
      store: new PostgresMigrationStore(pool),
    });
    await run(pool);
  } finally {
    await pool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }
}

export async function insertOrg(
  pool: Pool,
  name = 'OVR-6 Klinik',
  timezone = DEFAULT_TIMEZONE,
): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO organizations (name, timezone) VALUES ($1, $2) RETURNING id`,
    [name, timezone],
  )).rows[0]!.id;
}

export async function insertUser(
  pool: Pool,
  input: {
    organizationId: string;
    role: 'ADMIN' | 'MANAGER' | 'STAFF';
    name?: string;
    isActive?: boolean;
    staffProfile?: boolean;
  },
): Promise<string> {
  const id = (await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role, is_active)
     VALUES ($1, $2, $3, 'test-hash', $4, $5) RETURNING id`,
    [
      input.organizationId,
      input.name ?? `${input.role} User`,
      `${randomUUID()}@test.local`,
      input.role,
      input.isActive ?? true,
    ],
  )).rows[0]!.id;
  const withProfile = input.staffProfile ?? input.role === 'STAFF';
  if (withProfile) {
    await pool.query(
      `INSERT INTO staff_profiles (organization_id, user_id, title)
       VALUES ($1, $2, 'Saha Personeli')`,
      [input.organizationId, id],
    );
  }
  return id;
}

export async function insertCustomer(
  pool: Pool,
  organizationId: string,
  name = 'Marmara Diş Kliniği',
): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO customers (organization_id, name, customer_type, status)
     VALUES ($1, $2, 'clinic', 'active') RETURNING id`,
    [organizationId, name],
  )).rows[0]!.id;
}

export type JobSeed = {
  organizationId: string;
  type: JobCardType;
  status: JobCardStatus;
  assignedTo: string;
  createdBy: string;
  title?: string;
  customerId?: string | null;
  dueDate?: string | null;
  scheduledAt?: Date | null;
  scheduledEndsAt?: Date | null;
  acceptedAt?: Date | null;
  startedAt?: Date | null;
  staffCompletedAt?: Date | null;
  managerApprovedAt?: Date | null;
  /** Fixture clock used only to derive metadata defaults (acceptance/start/revision). */
  baseNow?: Date;
  revisionNo?: number;
  revisionCreatedAt?: Date;
};

export type SeededJob = {
  id: string;
  version: number;
  status: JobCardStatus;
  scheduledAt: Date | null;
};

export async function insertJob(pool: Pool, input: JobSeed): Promise<SeededJob> {
  const scheduledAt = input.scheduledAt ?? null;
  const base = input.baseNow ?? scheduledAt ?? new Date();
  // Both the schedule revision and every lifecycle instant of a fixture job
  // precede its planned start (and therefore every scan instant that observes
  // it): revision, acceptance, start, completion, approval.
  const anchor = scheduledAt ?? base;
  const revisionCreatedAt = input.revisionCreatedAt
    ?? new Date(anchor.getTime() - 3 * HOUR_MS);
  const accepted = input.status !== 'NEW';
  const acceptedAt = input.acceptedAt
    ?? (accepted ? new Date(anchor.getTime() - 150 * MINUTE_MS) : null);
  const started = ['IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED', 'COMPLETED']
    .includes(input.status);
  const startedAt = input.startedAt
    ?? (started ? new Date(anchor.getTime() - 2 * HOUR_MS) : null);
  const staffCompleted = ['WAITING_APPROVAL', 'REVISION_REQUESTED', 'COMPLETED']
    .includes(input.status);
  const staffCompletedAt = input.staffCompletedAt
    ?? (staffCompleted ? new Date(anchor.getTime() - 90 * MINUTE_MS) : null);
  const completed = input.status === 'COMPLETED';
  const managerApprovedAt = input.managerApprovedAt
    ?? (completed ? new Date(anchor.getTime() - HOUR_MS) : null);
  const revisionRequested = input.status === 'REVISION_REQUESTED';
  const engagementKind = input.type === 'SALES_MEETING' ? 'SALES_MEETING' : null;
  const row = (await pool.query<{ id: string; version: number; status: JobCardStatus }>(
    `INSERT INTO job_cards
       (organization_id, type, status, title, customer_id, assigned_to, created_by,
        accepted_at, accepted_by, started_at, staff_completed_at, staff_completed_by,
        manager_approved_at, manager_approved_by,
        revision_requested_at, revision_requested_by, revision_reason,
        scheduled_at, scheduled_ends_at, due_date, engagement_kind)
     VALUES ($1, $2, $3, $4, $5, $6, $7,
             $8::timestamptz, $9::uuid, $10::timestamptz, $11::timestamptz, $12::uuid,
             $13::timestamptz, $14::uuid,
             $15::timestamptz, $16::uuid, $17,
             $18::timestamptz, $19::timestamptz, $20::date, $21)
     RETURNING id, version, status`,
    [
      input.organizationId, input.type, input.status,
      input.title ?? 'OVR-6 planlı iş', input.customerId ?? null,
      input.assignedTo, input.createdBy,
      acceptedAt, acceptedAt === null ? null : input.assignedTo,
      startedAt, staffCompletedAt, staffCompletedAt === null ? null : input.assignedTo,
      managerApprovedAt, managerApprovedAt === null ? null : input.createdBy,
      revisionRequested ? new Date(base.getTime() - 5 * MINUTE_MS) : null,
      revisionRequested ? input.createdBy : null,
      revisionRequested ? 'Fixture düzeltme nedeni' : null,
      scheduledAt, input.scheduledEndsAt ?? null, input.dueDate ?? null,
      engagementKind,
    ],
  )).rows[0]!;
  // Every incident references (organization, job, revision), so even a job
  // without a planned window gets its baseline revision row.
  await pool.query(
    `INSERT INTO job_card_schedule_revisions
       (organization_id, job_card_id, revision_no, scheduled_at, scheduled_ends_at,
        organization_timezone, source, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.organizationId, row.id, input.revisionNo ?? 1, scheduledAt,
      input.scheduledEndsAt ?? null, DEFAULT_TIMEZONE,
      scheduledAt ? 'CREATE' : 'BASELINE', input.createdBy, revisionCreatedAt,
    ],
  );
  if (scheduledAt) {
    await pool.query(
      `INSERT INTO job_card_assignment_history
         (organization_id, job_card_id, from_user_id, to_user_id, changed_by, source, changed_at)
       VALUES ($1, $2, NULL, $3, $4, 'CREATE', $5)`,
      [input.organizationId, row.id, input.assignedTo, input.createdBy, revisionCreatedAt],
    );
  }
  return {
    id: row.id,
    version: Number(row.version),
    status: row.status,
    scheduledAt,
  };
}

export async function insertScheduleRevision(
  pool: Pool,
  input: {
    organizationId: string;
    jobCardId: string;
    revisionNo: number;
    scheduledAt: Date;
    scheduledEndsAt: Date | null;
    createdBy: string;
    createdAt: Date;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO job_card_schedule_revisions
       (organization_id, job_card_id, revision_no, scheduled_at, scheduled_ends_at,
        organization_timezone, source, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'RESCHEDULE', $7, $8)`,
    [
      input.organizationId, input.jobCardId, input.revisionNo, input.scheduledAt,
      input.scheduledEndsAt, DEFAULT_TIMEZONE, input.createdBy, input.createdAt,
    ],
  );
}

export type OfferState = 'OPEN' | 'ACCEPTED' | 'DECLINED' | 'RELEASED' | 'EXPIRED' | 'WITHDRAWN';

export async function insertOffer(
  pool: Pool,
  input: {
    organizationId: string;
    jobCardId: string;
    assigneeUserId: string;
    openedBy: string;
    openedAt: Date;
    acceptanceDueAt: Date;
    state?: OfferState;
    urgentReason?: 'SHORT_NOTICE' | 'START_PASSED' | null;
    closedAt?: Date | null;
    closedBy?: string | null;
    closeReason?: string | null;
    closeText?: string | null;
  },
): Promise<string> {
  const state = input.state ?? 'OPEN';
  const closedAt = state === 'OPEN' ? null : input.closedAt ?? new Date(input.openedAt.getTime() + MINUTE_MS);
  const closedBy = state === 'OPEN' || state === 'EXPIRED'
    ? null
    : input.closedBy ?? input.openedBy;
  return (await pool.query<{ id: string }>(
    `INSERT INTO job_card_assignment_offers
       (organization_id, job_card_id, assignee_user_id, opened_at, opened_reason, opened_by,
        acceptance_due_at, urgent_reason, state, closed_at, closed_by, close_reason, close_text)
     VALUES ($1, $2, $3, $4, 'CREATE', $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      input.organizationId, input.jobCardId, input.assigneeUserId, input.openedAt,
      input.openedBy, input.acceptanceDueAt, input.urgentReason ?? null,
      state, closedAt, closedBy, input.closeReason ?? null, input.closeText ?? null,
    ],
  )).rows[0]!.id;
}

export async function insertOpenChangeRequest(
  pool: Pool,
  input: {
    organizationId: string;
    jobCardId: string;
    requestedBy: string;
    requestedAt: Date;
    jobStatusAtRequest: JobCardStatus;
    reasonCode?: string;
    reasonText?: string;
  },
): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO job_card_change_requests
       (organization_id, job_card_id, requested_by, requested_at, job_status_at_request,
        reason_code, reason_text, client_action_id, state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'OPEN')
     RETURNING id`,
    [
      input.organizationId, input.jobCardId, input.requestedBy, input.requestedAt,
      input.jobStatusAtRequest, input.reasonCode ?? 'OTHER',
      input.reasonText ?? 'Plan değişikliği talep edildi.', randomUUID(),
    ],
  )).rows[0]!.id;
}

export async function closeChangeRequest(
  pool: Pool,
  input: {
    changeRequestId: string;
    resolvedBy: string;
    resolvedAt: Date;
    resolution?: 'REJECTED' | 'CORRECTED' | 'RESCHEDULED' | 'CANCELLED';
    note?: string | null;
  },
): Promise<void> {
  const resolution = input.resolution ?? 'REJECTED';
  await pool.query(
    `UPDATE job_card_change_requests
        SET state = 'CLOSED', resolution = $2, resolved_by = $3, resolved_at = $4,
            resolution_note = $5
      WHERE id = $1 AND state = 'OPEN'`,
    [
      input.changeRequestId, resolution, input.resolvedBy, input.resolvedAt,
      resolution === 'REJECTED' ? input.note ?? 'Yönetici talebi reddetti.' : input.note ?? null,
    ],
  );
}

export async function insertIncident(
  pool: Pool,
  input: {
    organizationId: string;
    jobCardId: string;
    delayType?: 'LATE_START' | 'LATE_SUBMISSION' | 'APPROVAL_WAIT';
    episodeNo?: number;
    scheduleRevisionNo?: number;
    deadlineAt: Date;
    breachedAt: Date;
    accountableUserId?: string | null;
    accountableRole?: 'STAFF' | 'MANAGEMENT';
    source?: 'SCANNER' | 'TRANSITION' | 'MUTATION';
  },
): Promise<string> {
  const delayType = input.delayType ?? 'APPROVAL_WAIT';
  return (await pool.query<{ id: string }>(
    `INSERT INTO job_card_overdue_incidents
       (organization_id, job_card_id, delay_type, episode_no, schedule_revision_no,
        deadline_at, breached_at, accountable_user_id, accountable_role,
        accountable_source, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      input.organizationId, input.jobCardId, delayType, input.episodeNo ?? 1,
      input.scheduleRevisionNo ?? 1, input.deadlineAt, input.breachedAt,
      input.accountableUserId ?? null,
      input.accountableRole ?? (delayType === 'APPROVAL_WAIT' ? 'MANAGEMENT' : 'STAFF'),
      input.accountableUserId != null
        ? 'ASSIGNMENT_AT_BREACH'
        : delayType === 'APPROVAL_WAIT' ? 'ROLE_POLICY' : 'UNKNOWN',
      input.source ?? 'SCANNER',
    ],
  )).rows[0]!.id;
}

export type IncidentRow = {
  id: string;
  delay_type: string;
  episode_no: number;
  deadline_at: Date;
  breached_at: Date;
  recovered_at: Date | null;
  ended_at: Date | null;
};

export async function selectIncidents(
  pool: Pool,
  organizationId: string,
  jobCardId: string,
): Promise<IncidentRow[]> {
  return (await pool.query<IncidentRow>(
    `SELECT id, delay_type, episode_no, deadline_at, breached_at, recovered_at, ended_at
       FROM job_card_overdue_incidents
      WHERE organization_id = $1 AND job_card_id = $2
      ORDER BY breached_at ASC, id ASC`,
    [organizationId, jobCardId],
  )).rows;
}

export type NotificationRow = {
  recipient_user_id: string;
  kind: string;
  created_at: Date;
  source_realtime_event_id: string;
};

export async function selectNotifications(
  pool: Pool,
  organizationId: string,
  jobCardId: string,
): Promise<NotificationRow[]> {
  return (await pool.query<NotificationRow>(
    `SELECT recipient_user_id, kind, created_at, source_realtime_event_id::text
       FROM in_app_notifications
      WHERE organization_id = $1 AND entity_type = 'job-card' AND entity_id = $2
      ORDER BY created_at ASC, id ASC`,
    [organizationId, jobCardId],
  )).rows;
}

export async function selectActivities(
  pool: Pool,
  organizationId: string,
  jobCardId: string,
): Promise<Array<{ id: string; event_type: string; created_at: Date }>> {
  return (await pool.query<{ id: string; event_type: string; created_at: Date }>(
    `SELECT id, event_type, created_at
       FROM job_card_activity_logs
      WHERE organization_id = $1 AND job_card_id = $2
      ORDER BY created_at ASC, id ASC`,
    [organizationId, jobCardId],
  )).rows;
}

export type LatenessDeliveryRow = {
  kind: string;
  planned_start_at: Date | null;
  recipient_user_id: string | null;
  incident_id: string | null;
  sent_at: Date;
};

export async function selectLatenessDeliveries(
  pool: Pool,
  organizationId: string,
  jobCardId: string,
): Promise<LatenessDeliveryRow[]> {
  return (await pool.query<LatenessDeliveryRow>(
    `SELECT kind, planned_start_at, recipient_user_id, incident_id, sent_at
       FROM job_card_lateness_alert_deliveries
      WHERE organization_id = $1 AND job_card_id = $2
      ORDER BY sent_at ASC, kind ASC`,
    [organizationId, jobCardId],
  )).rows;
}

export type OverdueDeliveryRow = {
  kind: string;
  episode_no: number;
  recipient_user_id: string | null;
  sent_at: Date;
};

/** OVR-4 delivery rows (the pre-existing OVR-6-amended producer). */
export async function selectOverdueDeliveries(
  pool: Pool,
  organizationId: string,
  jobCardId: string,
): Promise<OverdueDeliveryRow[]> {
  return (await pool.query<OverdueDeliveryRow>(
    `SELECT kind, episode_no, recipient_user_id, sent_at
       FROM job_card_overdue_notification_deliveries
      WHERE organization_id = $1 AND job_card_id = $2
      ORDER BY sent_at ASC, kind ASC`,
    [organizationId, jobCardId],
  )).rows;
}

export async function selectRealtimeEvents(
  pool: Pool,
  organizationId: string,
  jobCardId: string,
): Promise<Array<{ id: string; event_type: string; source_activity_id: string }>> {
  return (await pool.query<{ id: string; event_type: string; source_activity_id: string }>(
    `SELECT id::text, event_type, source_activity_id
       FROM realtime_events
      WHERE organization_id = $1 AND entity_type = 'job-card' AND entity_id = $2
      ORDER BY id ASC`,
    [organizationId, jobCardId],
  )).rows;
}

export async function selectOfferNotifications(
  pool: Pool,
  offerId: string,
): Promise<Array<{ kind: string; sent_at: Date }>> {
  return (await pool.query<{ kind: string; sent_at: Date }>(
    `SELECT kind, sent_at FROM job_card_assignment_offer_notifications
      WHERE offer_id = $1 ORDER BY sent_at ASC, kind ASC`,
    [offerId],
  )).rows;
}

export type RollbackEvidence = {
  notificationCount: number;
  activityCount: number;
  deliveryCount: number;
};

/** Contract §9.2 rollback-evidence query (read-only). */
export async function readRollbackEvidence(pool: Pool): Promise<RollbackEvidence> {
  return (await pool.query<RollbackEvidence>(
    `SELECT
       (SELECT COUNT(*)::int FROM in_app_notifications
         WHERE kind IN ('job.start_reminder', 'job.approval_wait_alert',
                        'job.pending_acceptance_alert')) AS "notificationCount",
       (SELECT COUNT(*)::int FROM job_card_activity_logs
         WHERE event_type IN ('JOB_START_REMINDER_SENT', 'JOB_APPROVAL_WAIT_ALERT_SENT',
                              'JOB_PENDING_ACCEPTANCE_ALERT_SENT')) AS "activityCount",
       (SELECT COUNT(*)::int FROM job_card_lateness_alert_deliveries) AS "deliveryCount"`,
  )).rows[0]!;
}

export type Clock = { now: Date };

export function actor(
  id: string,
  organizationId: string,
  role: 'ADMIN' | 'MANAGER' | 'STAFF',
): JobCardActor {
  return { id, organizationId, role } as JobCardActor;
}

export function buildJobCardService(
  pool: Pool,
  clock: Clock,
  options: { assignmentWindowEnabled?: boolean } = {},
): { service: JobCardService; published: RealtimeEventRecord[] } {
  const published: RealtimeEventRecord[] = [];
  const publisher: RealtimeEventPublisher = { publish: (event) => published.push(event) };
  const service = new JobCardService(
    new PostgresJobCardRepository(pool),
    () => clock.now,
    publisher,
    { enabled: false },
    { enabled: false },
    { enabled: false, reminderLeadMinutes: 30 },
    {},
    { enabled: options.assignmentWindowEnabled === true },
  );
  return { service, published };
}

export function buildOverdueReminderWorker(
  pool: Pool,
  options: {
    now: () => Date;
    notificationWindow?: NotificationWindowPolicy;
    batchSize?: number;
    timing?: { staffReminderDelayMs?: number; escalationDelayMs?: number };
  },
) {
  // Contract §3.7: the window policy is a constructor argument of the
  // repository (it owns both the discovery SQL and the under-lock re-check).
  // `createOverdueReminderWorker` has no such option; passing it there would be
  // silently ignored and the real window would keep gating the fixture.
  return createOverdueReminderWorker(
    new PostgresOverdueReminderWorkerRepository(
      new PostgresJobCardRepository(pool),
      false,
      options.notificationWindow,
    ),
    {
      now: options.now,
      publisher: { publish: () => undefined },
      timing: options.timing ?? {},
      batchSize: options.batchSize ?? 50,
    },
  );
}

export function buildLatenessAlertWorker(
  pool: Pool,
  options: {
    now: () => Date;
    notificationWindow?: NotificationWindowPolicy;
    batchSize?: number;
    timing?: { startReminderDelayMs: number };
    webPushEnabled?: boolean;
    publisher?: RealtimeEventPublisher;
  },
) {
  return createLatenessAlertWorker({
    repository: new PostgresLatenessAlertWorkerRepository(new PostgresJobCardRepository(pool)),
    now: options.now,
    notificationWindow: options.notificationWindow,
    timing: options.timing,
    batchSize: options.batchSize,
    webPushEnabled: options.webPushEnabled,
    publisher: options.publisher,
  });
}

export function buildAssignmentOfferExpiryWorker(
  pool: Pool,
  options: { now: () => Date; batchSize?: number },
) {
  return createAssignmentOfferExpiryWorker(
    new PostgresAssignmentOfferExpiryRepository(new PostgresJobCardRepository(pool), false),
    {
      now: options.now,
      pollIntervalMs: 60_000,
      batchSize: options.batchSize ?? 50,
      publisher: { publish: () => undefined },
      onReport: () => undefined,
      onError: () => undefined,
    },
  );
}

/** Organization-local date key `offsetDays` away from `base`. */
export function localDateKeyAt(base: Date, timezone: string, offsetDays: number): string {
  return addCalendarDaysToDateKey(localDateKey(base, timezone), offsetDays);
}

/** Next Mon–Sat date key (a Sunday is skipped) at or after `offsetDays`. */
export function nextOpenDateKey(
  base: Date,
  timezone: string,
  offsetDays = 1,
): string {
  let key = localDateKeyAt(base, timezone, offsetDays);
  while (weekdayOfDateKey(key) === 0) key = addCalendarDaysToDateKey(key, 1);
  return key;
}

/** An open date key whose following day is also open (so 21:00 → 08:00 is in-window). */
export function dateKeyWithOpenFollowingDay(base: Date, timezone: string): string {
  let key = nextOpenDateKey(base, timezone, 1);
  while (weekdayOfDateKey(addCalendarDaysToDateKey(key, 1)) === 0) {
    key = addCalendarDaysToDateKey(key, 1);
  }
  return key;
}

/**
 * Next Sunday date key strictly after `base`'s local date (ISO 7, local
 * calendar weekday 0). Strictly future so fixture instants never follow the
 * scan instant they are compared with.
 */
export function nextSundayDateKey(base: Date, timezone: string): string {
  let key = localDateKeyAt(base, timezone, 1);
  while (weekdayOfDateKey(key) !== 0) key = addCalendarDaysToDateKey(key, 1);
  return key;
}

/** UTC instant for a local wall-clock time on a date key. */
export function atLocal(
  dateKey: string,
  hour: number,
  minute: number,
  timezone = DEFAULT_TIMEZONE,
  second = 0,
): Date {
  return instantFromLocal(dateKey, hour, minute, timezone, second);
}

export function addDays(dateKey: string, days: number): string {
  return addCalendarDaysToDateKey(dateKey, days);
}

export function shift(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}
