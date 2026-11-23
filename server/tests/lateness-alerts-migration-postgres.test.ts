import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { loadMigrationCatalog } from '../src/db/migration-catalog.js';
import { readDbBaseline } from './support/db-clock-baseline.js';
import {
  insertIncident,
  insertJob,
  insertOrg,
  insertUser,
  databaseUrl,
  MIGRATIONS_DIRECTORY,
  withSchema,
} from './support/ovr6-harness.js';

/**
 * OVR-6 §7.7/§8 — migration 069 `lateness_alerts_and_quiet_hours`.
 *
 * The delivery table, the incident composite key, the widened notification
 * and activity CHECKs, and the schema head. Contract §10 DB.
 */

const SCHEMA_VERSION = '071_sale_standalone_and_delivery_link';

/**
 * Complete `in_app_notifications_kind_check` vocabulary before 069 (065 is the
 * last migration that redefined it; 066–068 did not).
 */
const NOTIFICATION_KINDS_BEFORE_069 = [
  'job.assigned',
  'job.reassigned',
  'job.awaiting_approval',
  'job.approved',
  'job.revision_requested',
  'job.cancelled',
  'job.invalidated',
  'job.note_added',
  'job.submission_reminder',
  'job.submission_auto_reminder',
  'job.submission_auto_escalation',
  'job.change_requested',
  'job.change_request_resolved',
  'job.acceptance_reminder',
  'job.assignment_declined',
  'job.acceptance_expired',
  'calendar.assigned',
  'calendar.rescheduled',
  'calendar.cancelled',
  'calendar.reminder',
  'message.received',
] as const;

const NOTIFICATION_KINDS_ADDED = [
  'job.start_reminder',
  'job.approval_wait_alert',
  'job.pending_acceptance_alert',
] as const;

/** Complete activity vocabulary before 069 (066 is the last redefinition). */
const ACTIVITY_EVENTS_BEFORE_069 = [
  'WEEKLY_REPORT_REMOVED',
  'JOB_CREATED',
  'JOB_ASSIGNED',
  'JOB_PLANNED',
  'JOB_ACCEPTED',
  'JOB_STARTED',
  'JOB_SUBMITTED_FOR_APPROVAL',
  'JOB_APPROVED',
  'JOB_REVISION_REQUESTED',
  'JOB_RESUMED',
  'JOB_CANCELLED',
  'JOB_INVALIDATED',
  'JOB_FIELDS_UPDATED',
  'DELIVERY_ITEM_ADDED',
  'DELIVERY_ITEM_UPDATED',
  'DELIVERY_ITEM_REMOVED',
  'NOTE_ADDED',
  'MEETING_DETAILS_UPDATED',
  'JOB_APPROVAL_WITHDRAWN',
  'JOB_SUBMISSION_REMINDER_SENT',
  'JOB_SUBMISSION_AUTO_REMINDER_SENT',
  'JOB_SUBMISSION_AUTO_ESCALATION_SENT',
  'SALE_FROM_VISIT_CREATED',
  'SALE_DETAILS_UPDATED',
  'SALE_ITEM_ADDED',
  'SALE_ITEM_UPDATED',
  'SALE_ITEM_REMOVED',
  'JOB_EARLY_START_AUTHORIZED',
  'JOB_CHANGE_REQUESTED',
  'JOB_CHANGE_REQUEST_RESOLVED',
  'JOB_ASSIGNMENT_OFFER_OPENED',
  'JOB_ASSIGNMENT_REMINDER_SENT',
  'JOB_ASSIGNMENT_DECLINED',
  'JOB_ASSIGNMENT_RELEASED',
  'JOB_ASSIGNMENT_OFFER_EXPIRED',
  'JOB_ASSIGNMENT_OFFER_WITHDRAWN',
  'JOB_OVERDUE_ENDED_BY_EXTENSION',
] as const;

const ACTIVITY_EVENTS_ADDED = [
  'JOB_START_REMINDER_SENT',
  'JOB_APPROVAL_WAIT_ALERT_SENT',
  'JOB_PENDING_ACCEPTANCE_ALERT_SENT',
] as const;

async function constraintDefinition(
  pool: Pool,
  table: string,
  constraint: string,
): Promise<string> {
  const result = await pool.query<{ definition: string }>(
    `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
      WHERE conrelid = $1::regclass AND conname = $2`,
    [table, constraint],
  );
  return result.rows[0]?.definition ?? '';
}

async function insertRealtimeFor(
  pool: Pool,
  input: { organizationId: string; jobCardId: string; createdBy: string },
): Promise<string> {
  const activity = await pool.query<{ id: string }>(
    `INSERT INTO job_card_activity_logs
       (organization_id, job_card_id, actor_id, event_type)
     VALUES ($1, $2, $3, 'JOB_CREATED') RETURNING id`,
    [input.organizationId, input.jobCardId, input.createdBy],
  );
  const realtime = await pool.query<{ id: string }>(
    `INSERT INTO realtime_events
       (organization_id, source_activity_id, event_type, entity_type, entity_id,
        audience_roles, resource_keys)
     VALUES ($1, $2, 'job.updated', 'job-card', $3,
             ARRAY['ADMIN']::VARCHAR(20)[], '{job-list}') RETURNING id::text`,
    [input.organizationId, activity.rows[0]!.id, input.jobCardId],
  );
  return realtime.rows[0]!.id;
}

async function insertDelivery(
  pool: Pool,
  input: {
    organizationId: string;
    jobCardId: string;
    kind: string;
    plannedStartAt?: Date | null;
    recipientUserId?: string | null;
    incidentId?: string | null;
    sentAt: Date;
  },
): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO job_card_lateness_alert_deliveries
       (organization_id, job_card_id, kind, planned_start_at, recipient_user_id,
        incident_id, sent_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      input.organizationId, input.jobCardId, input.kind, input.plannedStartAt ?? null,
      input.recipientUserId ?? null, input.incidentId ?? null, input.sentAt,
    ],
  )).rows[0]!.id;
}

describe.skipIf(!databaseUrl)('OVR-6 migration 069', () => {
  it('DB: 069 is the schema head, the delivery table starts empty and the env examples agree', async () => {
    const catalog = await loadMigrationCatalog(MIGRATIONS_DIRECTORY);
    expect(catalog.head?.version).toBe(SCHEMA_VERSION);

    await withSchema('ovr6_mig', async (pool) => {
      const table = await pool.query<{ regclass: string | null }>(
        `SELECT to_regclass('job_card_lateness_alert_deliveries')::text AS regclass`,
      );
      expect(table.rows[0]?.regclass).toBe('job_card_lateness_alert_deliveries');
      const count = await pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM job_card_lateness_alert_deliveries`,
      );
      expect(count.rows[0]!.count).toBe(0);

      const incidentKey = await constraintDefinition(
        pool, 'job_card_overdue_incidents', 'job_card_overdue_incidents_org_job_id_key',
      );
      expect(incidentKey).toContain('(organization_id, job_card_id, id)');

      const identity = await constraintDefinition(
        pool, 'job_card_lateness_alert_deliveries',
        'job_card_lateness_alert_deliveries_identity_key',
      );
      expect(identity).toContain('UNIQUE NULLS NOT DISTINCT');
      expect(identity).toContain(
        '(organization_id, job_card_id, kind, planned_start_at, recipient_user_id, incident_id)',
      );
    });

    const examples = fileURLToPath(new URL('../../ops/examples/', import.meta.url));
    for (const file of ['servora-med.env.example', 'servora-med-staging.env.example']) {
      const contents = await readFile(`${examples}${file}`, 'utf8');
      expect(contents, file).toContain(`HEALTH_SCHEMA_VERSION=${SCHEMA_VERSION}`);
    }
  });

  it('DB: kind and key-shape CHECKs fix the columns each kind owns', async () => {
    await withSchema('ovr6_chk', async (pool) => {
      const baseline = await readDbBaseline(pool);
      const organizationId = await insertOrg(pool, 'OVR-6 CHECK Klinik');
      const managerId = await insertUser(pool, { organizationId, role: 'MANAGER' });
      const staffId = await insertUser(pool, { organizationId, role: 'STAFF' });
      const jobA = await insertJob(pool, {
        organizationId, type: 'GENERAL_TASK', status: 'ACCEPTED',
        assignedTo: staffId, createdBy: managerId, baseNow: baseline,
      });
      const jobB = await insertJob(pool, {
        organizationId, type: 'GENERAL_TASK', status: 'NEW',
        assignedTo: staffId, createdBy: managerId, baseNow: baseline,
      });
      const jobC = await insertJob(pool, {
        organizationId, type: 'GENERAL_TASK', status: 'WAITING_APPROVAL',
        assignedTo: staffId, createdBy: managerId, baseNow: baseline,
      });
      const incidentId = await insertIncident(pool, {
        organizationId, jobCardId: jobC.id,
        deadlineAt: new Date(baseline.getTime() - 60_000),
        breachedAt: baseline,
      });
      const plannedStartAt = baseline;

      await insertDelivery(pool, {
        organizationId, jobCardId: jobA.id, kind: 'START_REMINDER',
        plannedStartAt, recipientUserId: staffId, sentAt: baseline,
      });
      await insertDelivery(pool, {
        organizationId, jobCardId: jobB.id, kind: 'PENDING_ACCEPTANCE_ALERT',
        plannedStartAt, sentAt: baseline,
      });
      await insertDelivery(pool, {
        organizationId, jobCardId: jobC.id, kind: 'APPROVAL_WAIT_ALERT',
        incidentId, sentAt: baseline,
      });

      const invalidRows = [
        {
          label: 'unknown kind',
          values: [organizationId, jobA.id, 'OTHER', plannedStartAt, staffId, null, baseline],
        },
        {
          label: 'start reminder without planned start',
          values: [organizationId, jobA.id, 'START_REMINDER', null, staffId, null, baseline],
        },
        {
          label: 'start reminder without recipient',
          values: [organizationId, jobA.id, 'START_REMINDER', plannedStartAt, null, null, baseline],
        },
        {
          label: 'start reminder with incident',
          values: [organizationId, jobA.id, 'START_REMINDER', plannedStartAt, staffId, incidentId, baseline],
        },
        {
          label: 'pending acceptance with recipient',
          values: [organizationId, jobB.id, 'PENDING_ACCEPTANCE_ALERT', plannedStartAt, staffId, null, baseline],
        },
        {
          label: 'pending acceptance with incident',
          values: [organizationId, jobB.id, 'PENDING_ACCEPTANCE_ALERT', plannedStartAt, null, incidentId, baseline],
        },
        {
          label: 'approval wait without incident',
          values: [organizationId, jobC.id, 'APPROVAL_WAIT_ALERT', null, null, null, baseline],
        },
        {
          label: 'approval wait with planned start',
          values: [organizationId, jobC.id, 'APPROVAL_WAIT_ALERT', plannedStartAt, null, incidentId, baseline],
        },
      ] as const;
      for (const row of invalidRows) {
        await expect(
          pool.query(
            `INSERT INTO job_card_lateness_alert_deliveries
               (organization_id, job_card_id, kind, planned_start_at, recipient_user_id,
                incident_id, sent_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [...row.values],
          ),
          row.label,
        ).rejects.toMatchObject({ code: '23514' });
      }
    });
  });

  it('DB: NULLS NOT DISTINCT identity makes one delivery per planned start and incident', async () => {
    await withSchema('ovr6_identity', async (pool) => {
      const baseline = await readDbBaseline(pool);
      const organizationId = await insertOrg(pool, 'OVR-6 Identity Klinik');
      const managerId = await insertUser(pool, { organizationId, role: 'MANAGER' });
      const staffId = await insertUser(pool, { organizationId, role: 'STAFF' });
      const startJob = await insertJob(pool, {
        organizationId, type: 'GENERAL_TASK', status: 'ACCEPTED',
        assignedTo: staffId, createdBy: managerId, baseNow: baseline,
      });
      const pendingJob = await insertJob(pool, {
        organizationId, type: 'GENERAL_TASK', status: 'NEW',
        assignedTo: staffId, createdBy: managerId, baseNow: baseline,
      });
      const approvalJob = await insertJob(pool, {
        organizationId, type: 'GENERAL_TASK', status: 'WAITING_APPROVAL',
        assignedTo: staffId, createdBy: managerId, baseNow: baseline,
      });
      const incidentId = await insertIncident(pool, {
        organizationId, jobCardId: approvalJob.id,
        deadlineAt: new Date(baseline.getTime() - 60_000), breachedAt: baseline,
      });

      const startInput = {
        organizationId, jobCardId: startJob.id, kind: 'START_REMINDER',
        plannedStartAt: baseline, recipientUserId: staffId, incidentId: null, sentAt: baseline,
      };
      await insertDelivery(pool, startInput);
      await expect(insertDelivery(pool, startInput)).rejects.toMatchObject({ code: '23505' });

      // Two NULL key columns must still collide: that is the whole point of
      // NULLS NOT DISTINCT.
      const pendingInput = {
        organizationId, jobCardId: pendingJob.id, kind: 'PENDING_ACCEPTANCE_ALERT',
        plannedStartAt: baseline, recipientUserId: null, incidentId: null, sentAt: baseline,
      };
      await insertDelivery(pool, pendingInput);
      await expect(insertDelivery(pool, pendingInput)).rejects.toMatchObject({ code: '23505' });

      const approvalInput = {
        organizationId, jobCardId: approvalJob.id, kind: 'APPROVAL_WAIT_ALERT',
        plannedStartAt: null, recipientUserId: null, incidentId, sentAt: baseline,
      };
      await insertDelivery(pool, approvalInput);
      await expect(insertDelivery(pool, approvalInput)).rejects.toMatchObject({ code: '23505' });

      // A different planned start is a different delivery.
      await insertDelivery(pool, {
        ...startInput, plannedStartAt: new Date(baseline.getTime() + 60_000),
      });
    });
  });

  it('DB: the incident composite FK rejects another job or organization', async () => {
    await withSchema('ovr6_fk', async (pool) => {
      const baseline = await readDbBaseline(pool);
      const organizationId = await insertOrg(pool, 'OVR-6 FK Klinik');
      const otherOrganizationId = await insertOrg(pool, 'OVR-6 Komşu Klinik');
      const managerId = await insertUser(pool, { organizationId, role: 'MANAGER' });
      const staffId = await insertUser(pool, { organizationId, role: 'STAFF' });
      const otherManagerId = await insertUser(pool, {
        organizationId: otherOrganizationId, role: 'MANAGER',
      });
      const otherStaffId = await insertUser(pool, {
        organizationId: otherOrganizationId, role: 'STAFF',
      });

      const jobA = await insertJob(pool, {
        organizationId, type: 'GENERAL_TASK', status: 'WAITING_APPROVAL',
        assignedTo: staffId, createdBy: managerId, baseNow: baseline,
      });
      const jobB = await insertJob(pool, {
        organizationId, type: 'GENERAL_TASK', status: 'WAITING_APPROVAL',
        assignedTo: staffId, createdBy: managerId, baseNow: baseline,
      });
      const incidentOfB = await insertIncident(pool, {
        organizationId, jobCardId: jobB.id,
        deadlineAt: new Date(baseline.getTime() - 60_000), breachedAt: baseline,
      });

      // Another job's incident cannot be referenced by job A.
      await expect(insertDelivery(pool, {
        organizationId, jobCardId: jobA.id, kind: 'APPROVAL_WAIT_ALERT',
        incidentId: incidentOfB, sentAt: baseline,
      })).rejects.toMatchObject({ code: '23503' });

      const foreignJob = await insertJob(pool, {
        organizationId: otherOrganizationId, type: 'GENERAL_TASK', status: 'WAITING_APPROVAL',
        assignedTo: otherStaffId, createdBy: otherManagerId, baseNow: baseline,
      });
      const foreignIncident = await insertIncident(pool, {
        organizationId: otherOrganizationId, jobCardId: foreignJob.id,
        deadlineAt: new Date(baseline.getTime() - 60_000), breachedAt: baseline,
      });

      // Another organization's incident cannot be referenced either.
      await expect(insertDelivery(pool, {
        organizationId, jobCardId: jobA.id, kind: 'APPROVAL_WAIT_ALERT',
        incidentId: foreignIncident, sentAt: baseline,
      })).rejects.toMatchObject({ code: '23503' });
    });
  });

  it('DB: widened notification and activity CHECKs keep every earlier value', async () => {
    await withSchema('ovr6_widen', async (pool) => {
      const baseline = await readDbBaseline(pool);
      const organizationId = await insertOrg(pool, 'OVR-6 Widened Klinik');
      const managerId = await insertUser(pool, { organizationId, role: 'MANAGER' });
      const adminId = await insertUser(pool, { organizationId, role: 'ADMIN' });
      const staffId = await insertUser(pool, { organizationId, role: 'STAFF' });
      const otherStaffId = await insertUser(pool, { organizationId, role: 'STAFF', name: 'Mehmet' });
      const job = await insertJob(pool, {
        organizationId, type: 'GENERAL_TASK', status: 'ACCEPTED',
        assignedTo: staffId, createdBy: managerId, baseNow: baseline,
      });

      const notificationDefinition = await constraintDefinition(
        pool, 'in_app_notifications', 'in_app_notifications_kind_check',
      );
      for (const kind of [...NOTIFICATION_KINDS_BEFORE_069, ...NOTIFICATION_KINDS_ADDED]) {
        expect(notificationDefinition, kind).toContain(`'${kind}'`);
      }
      const activityDefinition = await constraintDefinition(
        pool, 'job_card_activity_logs', 'job_card_activity_logs_event_type_check',
      );
      for (const event of [...ACTIVITY_EVENTS_BEFORE_069, ...ACTIVITY_EVENTS_ADDED]) {
        expect(activityDefinition, event).toContain(`'${event}'`);
      }

      // Behavioral proof: an earlier kind and every new kind are accepted.
      const realtimeId = await insertRealtimeFor(pool, {
        organizationId, jobCardId: job.id, createdBy: managerId,
      });
      const recipients = [managerId, adminId, staffId, otherStaffId];
      const acceptedKinds = ['job.acceptance_expired', ...NOTIFICATION_KINDS_ADDED];
      for (const [index, kind] of acceptedKinds.entries()) {
        await pool.query(
          `INSERT INTO in_app_notifications
             (organization_id, recipient_user_id, source_realtime_event_id, kind,
              entity_type, entity_id)
           VALUES ($1, $2, $3, $4, 'job-card', $5)`,
          [organizationId, recipients[index]!, realtimeId, kind, job.id],
        );
      }
      // A second event keeps the unique (recipient, event) identity out of the
      // way so the kind CHECK is the constraint under test.
      const unknownRealtimeId = await insertRealtimeFor(pool, {
        organizationId, jobCardId: job.id, createdBy: managerId,
      });
      await expect(pool.query(
        `INSERT INTO in_app_notifications
           (organization_id, recipient_user_id, source_realtime_event_id, kind,
            entity_type, entity_id)
         VALUES ($1, $2, $3, 'job.lateness_unknown', 'job-card', $4)`,
        [organizationId, managerId, unknownRealtimeId, job.id],
      )).rejects.toMatchObject({ code: '23514' });

      // Behavioral proof for the activity ledger: earlier and new events pass.
      const acceptedEvents = [
        'JOB_OVERDUE_ENDED_BY_EXTENSION',
        'JOB_ASSIGNMENT_OFFER_EXPIRED',
        ...ACTIVITY_EVENTS_ADDED,
      ];
      for (const event of acceptedEvents) {
        await pool.query(
          `INSERT INTO job_card_activity_logs (organization_id, job_card_id, event_type)
           VALUES ($1, $2, $3)`,
          [organizationId, job.id, event],
        );
      }
      await expect(pool.query(
        `INSERT INTO job_card_activity_logs (organization_id, job_card_id, event_type)
         VALUES ($1, $2, 'JOB_LATENESS_UNKNOWN')`,
        [organizationId, job.id],
      )).rejects.toMatchObject({ code: '23514' });
    });
  });
});
