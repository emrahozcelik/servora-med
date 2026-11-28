/**
 * OVR-5a readers: correction deadline, incident ending and the patch instant.
 *
 * OVR-5a ships readers only. OVR-5b owns every writer of
 * `correction_due_at` and of the five ending columns, so the acceptance
 * scenarios below simulate those writes with direct SQL and assert that every
 * current-state reader treats an ended row as closed while the immutable
 * evidence stays untouched. Contract:
 * docs/features/overdue-correction-deadline-and-extension.md (§3.6, §4.0,
 * §4.9, §6, §7), DECISIONS.md OVR-5.
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { loadMigrationCatalog } from '../src/db/migration-catalog.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import {
  PostgresOverdueBreachScannerRepository,
  createOverdueBreachScanner,
} from '../src/modules/job-cards/overdue-breach-scanner.js';
import {
  effectiveSubmissionDeadlineAt,
  effectiveSubmissionDeadlineSql,
} from '../src/modules/job-cards/overdue-incidents.js';
import { resolveOverdueReminderTiming } from '../src/modules/job-cards/overdue-reminder-policy.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCard, JobCardActor } from '../src/modules/job-cards/types.js';
import { mapJobCardActivityToRealtime } from '../src/modules/realtime/event-mapper.js';
import { waitFor } from './support/lifecycle-intent-harness.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const TIMING = resolveOverdueReminderTiming({});

/** Monday 2026-08-03 06:00Z: a fixed, clearly-past evidence instant. */
const EVIDENCE_AT = new Date('2026-08-03T06:00:00.000Z');
const BREACHED_AT = new Date('2026-08-03T07:30:00.000Z');
const ENDED_AT = new Date('2026-08-03T08:30:00.000Z');

async function withSchema(run: (pool: Pool, schema: string) => Promise<void>): Promise<void> {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `ovr5a_${randomUUID().replaceAll('-', '')}`;
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
    await run(pool, schema);
  } finally {
    await pool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }
}

async function insertOrg(pool: Pool, name: string, timezone = 'UTC'): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO organizations (name, timezone) VALUES ($1, $2) RETURNING id`,
    [name, timezone],
  )).rows[0]!.id;
}

async function insertUser(
  pool: Pool,
  organizationId: string,
  role: 'ADMIN' | 'MANAGER' | 'STAFF',
  name: string,
): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role, is_active)
     VALUES ($1, $2, $3, 'test-hash', $4, TRUE) RETURNING id`,
    [organizationId, name, `${randomUUID()}@test.local`, role],
  )).rows[0]!.id;
}

function actors(organizationId: string, managerId: string, staffId: string) {
  return {
    manager: { id: managerId, organizationId, role: 'MANAGER' } as JobCardActor,
    staff: { id: staffId, organizationId, role: 'STAFF' } as JobCardActor,
  };
}

function buildService(pool: Pool, now: () => Date): JobCardService {
  return new JobCardService(
    new PostgresJobCardRepository(pool),
    now,
    { publish: () => undefined },
    { enabled: false },
    { enabled: false },
    { enabled: false, reminderLeadMinutes: 30 },
  );
}

async function dbBaseline(pool: Pool): Promise<Date> {
  return (await pool.query<{ now: Date }>(
    "SELECT date_trunc('milliseconds', clock_timestamp()) AS now",
  )).rows[0]!.now;
}

function shiftMs(base: Date, ms: number): Date {
  return new Date(base.getTime() + ms);
}

function dateKeyShift(base: Date, days: number): string {
  return new Date(base.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

/** UTC-only helper: the organization-local midnight after a due date. */
function utcMidnightAfter(dateKey: string): Date {
  return new Date(`${dateKey}T00:00:00.000Z`);
}

function utcBoundaryAfter(dateKey: string): Date {
  return new Date(utcMidnightAfter(dateKey).getTime() + 86_400_000);
}

async function createTask(
  service: JobCardService,
  staff: JobCardActor,
  input: { title: string; dueDate: string | null },
): Promise<JobCard> {
  return (await service.create(staff, {
    clientActionId: randomUUID(),
    type: 'GENERAL_TASK',
    title: input.title,
    description: null,
    customerId: null,
    contactId: null,
    assignedTo: staff.id,
    priority: 'normal',
    dueDate: input.dueDate,
    scheduledAt: null,
    scheduledEndsAt: undefined,
    engagementKind: undefined,
  } as never)) as unknown as JobCard;
}

async function startJob(service: JobCardService, staff: JobCardActor, job: JobCard): Promise<JobCard> {
  return (await service.start(staff, job.id, {
    clientActionId: randomUUID(), expectedVersion: job.version,
  })) as unknown as JobCard;
}

async function submitJob(service: JobCardService, staff: JobCardActor, job: JobCard): Promise<JobCard> {
  return (await service.submitForApproval(staff, job.id, {
    clientActionId: randomUUID(),
    expectedVersion: job.version,
    note: 'Tamamlandı, kontrole gönderildi.',
  })) as unknown as JobCard;
}

async function requestRevision(
  service: JobCardService,
  manager: JobCardActor,
  job: JobCard,
): Promise<JobCard> {
  return (await service.requestRevision(manager, job.id, {
    clientActionId: randomUUID(),
    expectedVersion: job.version,
    revisionReason: 'Düzeltme gerekli.',
  })) as unknown as JobCard;
}

async function scanOnce(pool: Pool, scanTime: Date) {
  const repository = new PostgresJobCardRepository(pool);
  return createOverdueBreachScanner(
    new PostgresOverdueBreachScannerRepository(repository), { batchSize: 50 },
  ).runOnce(scanTime);
}

type IncidentRow = {
  id: string;
  delay_type: string;
  episode_no: number;
  schedule_revision_no: number;
  deadline_at: Date;
  breached_at: Date;
  source: string;
  recovered_at: Date | null;
  recovery_actor_user_id: string | null;
  ended_at: Date | null;
  ended_by_user_id: string | null;
  end_reason: string | null;
  end_note: string | null;
  ended_by_schedule_revision_no: number | null;
};

async function selectIncidents(
  pool: Pool, organizationId: string, jobId: string,
): Promise<IncidentRow[]> {
  return (await pool.query(
    `SELECT id, delay_type, episode_no, schedule_revision_no,
            deadline_at, breached_at, source,
            recovered_at, recovery_actor_user_id,
            ended_at, ended_by_user_id, end_reason, end_note,
            ended_by_schedule_revision_no
       FROM job_card_overdue_incidents
      WHERE organization_id = $1 AND job_card_id = $2
      ORDER BY breached_at ASC, id ASC`,
    [organizationId, jobId],
  )).rows as IncidentRow[];
}

async function selectActivation(
  pool: Pool, organizationId: string, jobId: string,
): Promise<{ episode_no: number; activated_at: Date; activated_by_command: string; correction_due_at: Date | null }> {
  const row = (await pool.query<{
    episode_no: number; activated_at: Date; activated_by_command: string;
    correction_due_at: Date | null;
  }>(
    `SELECT episode_no, activated_at, activated_by_command, correction_due_at
       FROM job_card_submission_episode_activations
      WHERE organization_id = $1 AND job_card_id = $2
      ORDER BY episode_no DESC LIMIT 1`,
    [organizationId, jobId],
  )).rows[0];
  if (!row) throw new Error('missing submission episode activation');
  return row;
}

async function setCorrectionDueAt(
  pool: Pool, organizationId: string, jobId: string, episodeNo: number, instant: Date | null,
): Promise<void> {
  await pool.query(
    `UPDATE job_card_submission_episode_activations
        SET correction_due_at = $4
      WHERE organization_id = $1 AND job_card_id = $2 AND episode_no = $3`,
    [organizationId, jobId, episodeNo, instant],
  );
}

async function setEnding(
  pool: Pool,
  incidentId: string,
  ending: {
    endedAt: Date | null;
    endedByUserId: string | null;
    endReason: string | null;
    endNote: string | null;
    endedByScheduleRevisionNo: number | null;
    recoveredAt?: Date | null;
    recoveryActorUserId?: string | null;
  },
): Promise<void> {
  await pool.query(
    `UPDATE job_card_overdue_incidents
        SET ended_at = $2,
            ended_by_user_id = $3,
            end_reason = $4,
            end_note = $5,
            ended_by_schedule_revision_no = $6,
            recovered_at = $7,
            recovery_actor_user_id = $8
      WHERE id = $1`,
    [
      incidentId, ending.endedAt, ending.endedByUserId, ending.endReason,
      ending.endNote, ending.endedByScheduleRevisionNo,
      ending.recoveredAt ?? null, ending.recoveryActorUserId ?? null,
    ],
  );
}

async function selectScheduleRevisions(
  pool: Pool, organizationId: string, jobId: string,
): Promise<Array<{ revision_no: number; created_at: Date }>> {
  return (await pool.query(
    `SELECT revision_no, created_at FROM job_card_schedule_revisions
      WHERE organization_id = $1 AND job_card_id = $2
      ORDER BY revision_no ASC`,
    [organizationId, jobId],
  )).rows as Array<{ revision_no: number; created_at: Date }>;
}

async function reservedAtFor(
  pool: Pool, organizationId: string, jobId: string, operationKey: string,
): Promise<Date> {
  const row = (await pool.query<{ reserved_at: Date }>(
    `SELECT reserved_at FROM job_card_lifecycle_intents
      WHERE organization_id = $1 AND job_card_id = $2 AND operation_key = $3
      ORDER BY reserved_at DESC, id DESC LIMIT 1`,
    [organizationId, jobId, operationKey],
  )).rows[0];
  if (!row) throw new Error(`missing lifecycle intent for ${operationKey}`);
  return row.reserved_at;
}

// ---------------------------------------------------------------------------
// M1: migration 066 schema and constraint guards.
// ---------------------------------------------------------------------------

async function seedIncidentFixture(
  pool: Pool, organizationId: string, staffId: string,
): Promise<string> {
  const jobId = (await pool.query<{ id: string }>(
    `INSERT INTO job_cards
       (organization_id, type, status, title, assigned_to, created_by,
        accepted_at, accepted_by, started_at)
     VALUES ($1, 'GENERAL_TASK', 'IN_PROGRESS', 'OVR5a fixture', $2, $2, $3, $2, $3)
     RETURNING id`,
    [organizationId, staffId, EVIDENCE_AT],
  )).rows[0]!.id;
  for (const revisionNo of [1, 2]) {
    await pool.query(
      `INSERT INTO job_card_schedule_revisions
         (organization_id, job_card_id, revision_no, organization_timezone,
          source, created_by, created_at)
       VALUES ($1, $2, $3, 'UTC', 'BASELINE', $4, $5)`,
      [organizationId, jobId, revisionNo, staffId, EVIDENCE_AT],
    );
  }
  return jobId;
}

async function insertIncident(
  pool: Pool,
  input: {
    organizationId: string;
    jobId: string;
    episodeNo: number;
    scheduleRevisionNo?: number;
    deadlineAt?: Date;
    breachedAt?: Date;
  },
): Promise<string> {
  const deadlineAt = input.deadlineAt ?? BREACHED_AT;
  const breachedAt = input.breachedAt ?? BREACHED_AT;
  return (await pool.query<{ id: string }>(
    `INSERT INTO job_card_overdue_incidents
       (organization_id, job_card_id, delay_type, episode_no, schedule_revision_no,
        deadline_at, breached_at, accountable_role, accountable_source, source)
     VALUES ($1, $2, 'LATE_SUBMISSION', $3, $4, $5, $6, 'STAFF', 'UNKNOWN', 'TRANSITION')
     RETURNING id`,
    [
      input.organizationId, input.jobId, input.episodeNo,
      input.scheduleRevisionNo ?? 1, deadlineAt, breachedAt,
    ],
  )).rows[0]!.id;
}

describe.skipIf(!databaseUrl)('OVR-5a readers (PostgreSQL)', () => {
  it('M1: migration 067 is the schema head and keeps the ending and correction columns', async () => {
    await withSchema(async (pool) => {
      const catalog = await loadMigrationCatalog(MIGRATIONS_DIRECTORY);
      expect(catalog.head?.version).toBe('077_change_request_acknowledged_only');
      const applied = await pool.query<{ version: string }>(
        'SELECT version FROM schema_migrations ORDER BY version',
      );
      expect(applied.rows.at(-1)?.version)
        .toBe('077_change_request_acknowledged_only');

      const columns = await pool.query<{
        table_name: string; column_name: string; data_type: string; is_nullable: string;
      }>(
        `SELECT table_name, column_name, data_type, is_nullable
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND (
              (table_name = 'job_card_overdue_incidents'
                AND column_name IN ('ended_at', 'ended_by_user_id', 'end_reason',
                                    'end_note', 'ended_by_schedule_revision_no'))
              OR (table_name = 'job_card_submission_episode_activations'
                AND column_name = 'correction_due_at')
            )
          ORDER BY table_name, column_name`,
      );
      expect(columns.rows).toHaveLength(6);
      for (const row of columns.rows) {
        expect(row.is_nullable).toBe('YES');
      }
      expect(columns.rows.find((row) => row.column_name === 'correction_due_at')?.data_type)
        .toBe('timestamp with time zone');
      expect(columns.rows.find((row) => row.column_name === 'ended_by_schedule_revision_no')?.data_type)
        .toBe('integer');

      const constraints = await pool.query<{ conname: string; definition: string }>(
        `SELECT conname, pg_get_constraintdef(oid) AS definition
           FROM pg_constraint
          WHERE conrelid IN (
            'job_card_overdue_incidents'::regclass,
            'job_card_submission_episode_activations'::regclass)`,
      );
      const names = constraints.rows.map((row) => row.conname);
      expect(names).toEqual(expect.arrayContaining([
        'job_card_submission_episode_activations_correction_due_check',
        'job_card_overdue_incidents_ending_set_check',
        'job_card_overdue_incidents_ending_exclusive_check',
        'job_card_overdue_incidents_ending_instant_check',
        'job_card_overdue_incidents_end_reason_check',
        'job_card_overdue_incidents_end_note_check',
      ]));
      // The five ending columns are either all NULL or all set.
      const endingSet = constraints.rows.find(
        (row) => row.conname === 'job_card_overdue_incidents_ending_set_check',
      )!;
      expect(endingSet.definition).toContain('ended_at');
      expect(endingSet.definition).toContain('ended_by_schedule_revision_no');
      // Ending and recovery stay mutually exclusive and one-way.
      const exclusive = constraints.rows.find(
        (row) => row.conname === 'job_card_overdue_incidents_ending_exclusive_check',
      )!;
      expect(exclusive.definition).toContain('recovered_at');
      expect(exclusive.definition).toContain('ended_at');
    });
  });

  it('M1: ending constraints reject half-set, recovered, retroactive, bad-reason and bad-note rows', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'OVR5a M1');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe');
      const jobId = await seedIncidentFixture(pool, organizationId, staffId);

      let episodeNo = 1;
      const freshIncident = () => insertIncident(pool, {
        organizationId, jobId, episodeNo: episodeNo++,
      });
      const validEnding = {
        endedAt: ENDED_AT,
        endedByUserId: managerId,
        endReason: 'DEADLINE_EXTENDED',
        endNote: 'Müşteri randevusu ertelendi.',
        endedByScheduleRevisionNo: 1,
      };

      // All five columns are set together, or none is.
      const halfSet = await freshIncident();
      await expect(setEnding(pool, halfSet, { ...validEnding, endNote: null }))
        .rejects.toMatchObject({ code: '23514' });
      await expect(setEnding(pool, halfSet, { ...validEnding, endedByScheduleRevisionNo: null }))
        .rejects.toMatchObject({ code: '23514' });

      // An ended row can never also look recovered.
      const bothClosed = await freshIncident();
      await expect(setEnding(pool, bothClosed, {
        ...validEnding,
        recoveredAt: ENDED_AT,
        recoveryActorUserId: managerId,
      })).rejects.toMatchObject({ code: '23514' });

      // Ending never predates the breach it ends.
      const retroactive = await freshIncident();
      await expect(setEnding(pool, retroactive, {
        ...validEnding,
        endedAt: new Date(BREACHED_AT.getTime() - 1),
      })).rejects.toMatchObject({ code: '23514' });

      // The reason vocabulary is closed.
      const badReason = await freshIncident();
      await expect(setEnding(pool, badReason, { ...validEnding, endReason: 'OTHER' }))
        .rejects.toMatchObject({ code: '23514' });

      // The reason text is 1..500 trimmed characters.
      const emptyNote = await freshIncident();
      await expect(setEnding(pool, emptyNote, { ...validEnding, endNote: '   ' }))
        .rejects.toMatchObject({ code: '23514' });
      const longNote = await freshIncident();
      await expect(setEnding(pool, longNote, { ...validEnding, endNote: 'x'.repeat(501) }))
        .rejects.toMatchObject({ code: '23514' });
      const boundaryNote = await freshIncident();
      await setEnding(pool, boundaryNote, { ...validEnding, endNote: 'x'.repeat(500) });
      const stored = (await selectIncidents(pool, organizationId, jobId))
        .find((row) => row.id === boundaryNote)!;
      expect(stored.ended_at).toEqual(ENDED_AT);
      expect(stored.end_reason).toBe('DEADLINE_EXTENDED');
      expect(stored.end_note).toHaveLength(500);

      // A complete ending is accepted and preserves every evidence column.
      const accepted = await freshIncident();
      await setEnding(pool, accepted, validEnding);
      const row = (await selectIncidents(pool, organizationId, jobId))
        .find((candidate) => candidate.id === accepted)!;
      expect(row).toMatchObject({
        episode_no: episodeNo - 1,
        schedule_revision_no: 1,
        source: 'TRANSITION',
        recovered_at: null,
        ended_by_user_id: managerId,
        end_reason: 'DEADLINE_EXTENDED',
        ended_by_schedule_revision_no: 1,
      });
      expect(row.deadline_at).toEqual(BREACHED_AT);
      expect(row.breached_at).toEqual(BREACHED_AT);
    });
  });

  it('M1/OVR-2: a card-invalidated ending needs instant, actor and reason but no schedule revision', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'OVR2 M1');
      const adminId = await insertUser(pool, organizationId, 'ADMIN', 'Yönetici');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe');
      const jobId = await seedIncidentFixture(pool, organizationId, staffId);
      let episodeNo = 1;
      const freshIncident = () => insertIncident(pool, {
        organizationId, jobId, episodeNo: episodeNo++,
      });

      // The accepted shape: instant, actor and reason; nothing proves a new
      // boundary, so the appended revision must be absent and the note is not
      // required.
      const accepted = await freshIncident();
      await setEnding(pool, accepted, {
        endedAt: ENDED_AT,
        endedByUserId: adminId,
        endReason: 'CARD_INVALIDATED',
        endNote: null,
        endedByScheduleRevisionNo: null,
      });
      const row = (await selectIncidents(pool, organizationId, jobId))
        .find((candidate) => candidate.id === accepted)!;
      expect(row).toMatchObject({
        recovered_at: null,
        recovery_actor_user_id: null,
        ended_at: ENDED_AT,
        ended_by_user_id: adminId,
        end_reason: 'CARD_INVALIDATED',
        end_note: null,
        ended_by_schedule_revision_no: null,
      });

      // The OVR-5 shape stays strict, and a card invalidation cannot borrow a
      // revision or drop its actor.
      const withRevision = await freshIncident();
      await expect(setEnding(pool, withRevision, {
        endedAt: ENDED_AT,
        endedByUserId: adminId,
        endReason: 'CARD_INVALIDATED',
        endNote: null,
        endedByScheduleRevisionNo: 1,
      })).rejects.toMatchObject({ code: '23514' });
      const withoutActor = await freshIncident();
      await expect(setEnding(pool, withoutActor, {
        endedAt: ENDED_AT,
        endedByUserId: null,
        endReason: 'CARD_INVALIDATED',
        endNote: null,
        endedByScheduleRevisionNo: null,
      })).rejects.toMatchObject({ code: '23514' });
      const extendedWithoutRevision = await freshIncident();
      await expect(setEnding(pool, extendedWithoutRevision, {
        endedAt: ENDED_AT,
        endedByUserId: adminId,
        endReason: 'DEADLINE_EXTENDED',
        endNote: 'Tarih güncellendi.',
        endedByScheduleRevisionNo: null,
      })).rejects.toMatchObject({ code: '23514' });
    });
  });

  it('M1: correction_due_at is revision-only, future-only and withdraw-ineligible', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'OVR5a M1 correction');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe');
      const jobId = await seedIncidentFixture(pool, organizationId, staffId);
      const activationAt = EVIDENCE_AT;

      const insertActivation = (
        episodeNo: number,
        command: 'REQUEST_REVISION' | 'WITHDRAW_FROM_APPROVAL',
        correctionDueAt: Date | null,
      ) => pool.query(
        `INSERT INTO job_card_submission_episode_activations
           (organization_id, job_card_id, episode_no, activated_at,
            activated_by_command, correction_due_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [organizationId, jobId, episodeNo, activationAt, command, correctionDueAt],
      );

      await insertActivation(2, 'REQUEST_REVISION', null);
      // Equality with the activation instant is not a correction deadline.
      await expect(insertActivation(3, 'REQUEST_REVISION', activationAt))
        .rejects.toMatchObject({ code: '23514' });
      // A past correction deadline is rejected.
      await expect(insertActivation(4, 'REQUEST_REVISION', shiftMs(activationAt, -1)))
        .rejects.toMatchObject({ code: '23514' });
      // A future correction deadline is representable.
      await insertActivation(5, 'REQUEST_REVISION', shiftMs(activationAt, 3_600_000));

      // Only REQUEST_REVISION may carry a correction deadline.
      await expect(insertActivation(6, 'WITHDRAW_FROM_APPROVAL', shiftMs(activationAt, 3_600_000)))
        .rejects.toMatchObject({ code: '23514' });
      await insertActivation(7, 'WITHDRAW_FROM_APPROVAL', null);
      await expect(
        pool.query(
          `UPDATE job_card_submission_episode_activations
              SET correction_due_at = $4
            WHERE organization_id = $1 AND job_card_id = $2 AND episode_no = $3`,
          [organizationId, jobId, 7, shiftMs(activationAt, 3_600_000)],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });

  it('M1: delivery identity is per incident and kind after migration 067', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'OVR5a M1 delivery');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe');
      const jobId = await seedIncidentFixture(pool, organizationId, staffId);
      const firstIncidentId = await insertIncident(pool, {
        organizationId, jobId, episodeNo: 10, scheduleRevisionNo: 1,
      });
      const secondIncidentId = await insertIncident(pool, {
        organizationId, jobId, episodeNo: 10, scheduleRevisionNo: 2,
      });

      const insertDelivery = (incidentId: string, kind: 'STAFF_REMINDER' | 'MANAGEMENT_ESCALATION') =>
        pool.query(
          `INSERT INTO job_card_overdue_notification_deliveries
             (organization_id, job_card_id, delay_type, episode_no, kind,
              incident_id, sent_at)
           VALUES ($1, $2, 'LATE_SUBMISSION', 10, $3, $4, $5)`,
          [organizationId, jobId, kind, incidentId, BREACHED_AT],
        );

      await insertDelivery(firstIncidentId, 'STAFF_REMINDER');
      // The incident key still allows exactly one delivery per incident/kind.
      await expect(insertDelivery(firstIncidentId, 'STAFF_REMINDER'))
        .rejects.toMatchObject({ code: '23505' });
      // 067 drops the superseded per-episode key: a different incident of the
      // same episode may start its own reminder cycle (§4.9 / N1).
      await insertDelivery(secondIncidentId, 'STAFF_REMINDER');
      // A different kind is a different delivery under the incident key.
      await insertDelivery(secondIncidentId, 'MANAGEMENT_ESCALATION');

      const constraints = await pool.query<{ conname: string; definition: string }>(
        `SELECT conname, pg_get_constraintdef(oid) AS definition
           FROM pg_constraint
          WHERE conrelid = 'job_card_overdue_notification_deliveries'::regclass
            AND contype = 'u'`,
      );
      expect(constraints.rows).toHaveLength(1);
      const incidentKey = constraints.rows.find(
        (row) => row.conname === 'job_card_overdue_notification_deliveries_incident_kind_key',
      );
      expect(incidentKey).toBeDefined();
      expect(incidentKey!.definition).toContain('incident_id');
      expect(incidentKey!.definition).toContain('kind');
      // The 053 per-episode identity is gone in 067.
      expect(constraints.rows.some((row) => row.definition.includes('episode_no'))).toBe(false);
    });
  });

  it('M1: the activity vocabulary accepts JOB_OVERDUE_ENDED_BY_EXTENSION', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'OVR5a M1 activity');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe');
      const jobId = await seedIncidentFixture(pool, organizationId, staffId);

      await pool.query(
        `INSERT INTO job_card_activity_logs
           (organization_id, job_card_id, actor_id, event_type, metadata)
         VALUES ($1, $2, $3, 'JOB_OVERDUE_ENDED_BY_EXTENSION', '{}'::jsonb)`,
        [organizationId, jobId, managerId],
      );
      const stored = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM job_card_activity_logs
          WHERE organization_id = $1 AND job_card_id = $2
            AND event_type = 'JOB_OVERDUE_ENDED_BY_EXTENSION'`,
        [organizationId, jobId],
      );
      expect(stored.rows[0]!.count).toBe('1');
    });
  });

  // -------------------------------------------------------------------------
  // C1/C7, C2, C4: correction deadline renderers and scanner candidates.
  // -------------------------------------------------------------------------

  it('C1/C7: the scanner breaches at the correction instant +1 ms, not before', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'OVR5a C1');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe');
      const { manager, staff } = actors(organizationId, managerId, staffId);
      const clock = { now: await dbBaseline(pool) };
      const service = buildService(pool, () => clock.now);

      // The original deadline is the local midnight after a three-day-past
      // due date: clearly before activation, so the correction deadline is
      // strictly later than it.
      let job = await createTask(service, staff, {
        title: 'Düzeltme tarihli iş', dueDate: dateKeyShift(clock.now, -3),
      });
      job = await startJob(service, staff, job);
      job = await submitJob(service, staff, job);
      job = await requestRevision(service, manager, job);

      const activation = await selectActivation(pool, organizationId, job.id);
      expect(activation.episode_no).toBe(2);
      expect(activation.activated_by_command).toBe('REQUEST_REVISION');
      // OVR-5b materializes the 24h default on a REQUEST_REVISION activation.
      expect(activation.correction_due_at).toEqual(shiftMs(activation.activated_at, 24 * 3_600_000));
      const correctionDueAt = shiftMs(activation.activated_at, 3_600_000);
      await setCorrectionDueAt(pool, organizationId, job.id, 2, correctionDueAt);

      // At the correction instant the submission is still on time.
      const atCorrection = await scanOnce(pool, correctionDueAt);
      expect(atCorrection.candidates).toBe(0);
      expect(atCorrection.inserted).toBe(0);
      expect((await selectIncidents(pool, organizationId, job.id))
        .filter((row) => row.episode_no === 2)).toHaveLength(0);

      // One millisecond later the scanner prefilter and producer agree.
      const firstLate = shiftMs(correctionDueAt, 1);
      const atFirstLate = await scanOnce(pool, firstLate);
      expect(atFirstLate.candidates).toBe(1);
      expect(atFirstLate.inserted).toBe(1);
      const episodeTwo = (await selectIncidents(pool, organizationId, job.id))
        .filter((row) => row.episode_no === 2);
      expect(episodeTwo).toHaveLength(1);
      expect(episodeTwo[0]).toMatchObject({
        delay_type: 'LATE_SUBMISSION',
        episode_no: 2,
        schedule_revision_no: 1,
        source: 'SCANNER',
      });
      expect(episodeTwo[0]!.deadline_at).toEqual(firstLate);
      expect(episodeTwo[0]!.breached_at).toEqual(firstLate);
    });
  });

  it('C2: an earlier correction deadline never shortens the original deadline', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'OVR5a C2');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe');
      const { manager, staff } = actors(organizationId, managerId, staffId);
      const clock = { now: await dbBaseline(pool) };
      const service = buildService(pool, () => clock.now);

      // Original deadline is a few days in the future, so a correction one hour
      // after activation is earlier than it and must be ignored.
      const dueDate = dateKeyShift(clock.now, 3);
      const originalDeadline = utcBoundaryAfter(dueDate);
      let job = await createTask(service, staff, { title: 'Özgün tarih işi', dueDate });
      job = await startJob(service, staff, job);
      job = await submitJob(service, staff, job);
      job = await requestRevision(service, manager, job);

      const activation = await selectActivation(pool, organizationId, job.id);
      const correctionDueAt = shiftMs(activation.activated_at, 3_600_000);
      expect(correctionDueAt.getTime()).toBeLessThan(originalDeadline.getTime());
      await setCorrectionDueAt(pool, organizationId, job.id, 2, correctionDueAt);

      // Renderer agreement: max(original, correction) === original.
      const effective = effectiveSubmissionDeadlineAt({
        scheduledEndsAt: originalDeadline.toISOString(),
        scheduledAt: null,
        type: 'GENERAL_TASK',
        dueDate: null,
        timezone: 'UTC',
        correctionDueAt: correctionDueAt.toISOString(),
      });
      expect(effective).toEqual(originalDeadline);
      const sql = effectiveSubmissionDeadlineSql({
        scheduledEndsAt: `'${originalDeadline.toISOString()}'::timestamptz`,
        scheduledAt: 'NULL::timestamptz',
        type: "'GENERAL_TASK'",
        dueDate: 'NULL::date',
        timezone: "'UTC'",
        requestTime: 'NULL::timestamptz',
        correctionDueAt: `'${correctionDueAt.toISOString()}'::timestamptz`,
      });
      const rendered = await pool.query<{ deadline: Date }>(
        `SELECT (${sql}) AS deadline`,
      );
      expect(rendered.rows[0]!.deadline).toEqual(originalDeadline);

      // At the original deadline the submission is on time.
      const atOriginal = await scanOnce(pool, originalDeadline);
      expect(atOriginal.candidates).toBe(0);
      expect(atOriginal.inserted).toBe(0);
      // The original deadline +1ms is late.
      const firstLate = shiftMs(originalDeadline, 1);
      const atFirstLate = await scanOnce(pool, firstLate);
      expect(atFirstLate.candidates).toBe(1);
      expect(atFirstLate.inserted).toBe(1);
      const episodeTwo = (await selectIncidents(pool, organizationId, job.id))
        .filter((row) => row.episode_no === 2);
      expect(episodeTwo).toHaveLength(1);
      expect(episodeTwo[0]!.deadline_at).toEqual(firstLate);
      expect(episodeTwo[0]!.breached_at).toEqual(firstLate);
    });
  });

  it('C4: a job without an original deadline stays unbreached beside a stored correction', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'OVR5a C4');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe');
      const { manager, staff } = actors(organizationId, managerId, staffId);
      const clock = { now: await dbBaseline(pool) };
      const service = buildService(pool, () => clock.now);

      let job = await createTask(service, staff, { title: 'Tarihsiz iş', dueDate: null });
      job = await startJob(service, staff, job);
      job = await submitJob(service, staff, job);
      job = await requestRevision(service, manager, job);

      const activation = await selectActivation(pool, organizationId, job.id);
      const correctionDueAt = shiftMs(activation.activated_at, 3_600_000);
      // Simulated defensive write: OVR-5b stores NULL for this job (§3.4);
      // the reader must never let a correction deadline create lateness.
      await setCorrectionDueAt(pool, organizationId, job.id, 2, correctionDueAt);

      // TypeScript renderer: NULL original wins over any correction input.
      expect(effectiveSubmissionDeadlineAt({
        scheduledEndsAt: null,
        scheduledAt: null,
        type: 'GENERAL_TASK',
        dueDate: null,
        timezone: 'UTC',
      })).toBeNull();
      expect(effectiveSubmissionDeadlineAt({
        scheduledEndsAt: null,
        scheduledAt: null,
        type: 'GENERAL_TASK',
        dueDate: null,
        timezone: 'UTC',
        correctionDueAt: correctionDueAt.toISOString(),
      })).toBeNull();

      // SQL renderer: PostgreSQL GREATEST(NULL, x) is x, so the CASE guard is
      // required and must render NULL too.
      const sql = effectiveSubmissionDeadlineSql({
        scheduledEndsAt: 'NULL::timestamptz',
        scheduledAt: 'NULL::timestamptz',
        type: "'GENERAL_TASK'",
        dueDate: 'NULL::date',
        timezone: "'UTC'",
        requestTime: 'NULL::timestamptz',
        correctionDueAt: `'${correctionDueAt.toISOString()}'::timestamptz`,
      });
      const rendered = await pool.query<{ deadline: Date | null }>(
        `SELECT (${sql}) AS deadline`,
      );
      expect(rendered.rows[0]!.deadline).toBeNull();

      const report = await scanOnce(pool, shiftMs(correctionDueAt, 3_600_000));
      expect(report.candidates).toBe(0);
      expect(report.inserted).toBe(0);
      expect(await selectIncidents(pool, organizationId, job.id)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // RC1: lifecycle recovery only closes rows that are neither recovered nor ended.
  // -------------------------------------------------------------------------

  it('RC1: recovery closes only the open row of an ended-plus-open episode', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'OVR5a RC1');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe');
      const { manager, staff } = actors(organizationId, managerId, staffId);
      const clock = { now: await dbBaseline(pool) };
      const service = buildService(pool, () => clock.now);

      let job = await createTask(service, staff, {
        title: 'Kapanmış ve açık gecikme', dueDate: dateKeyShift(clock.now, 3),
      });
      job = await startJob(service, staff, job);
      // A second revision gives the episode two rows: an ended older one and
      // an open current one (the E1 then E5 state).
      job = await service.patch(manager, job.id, {
        expectedVersion: job.version, dueDate: dateKeyShift(clock.now, 4),
      } as never) as unknown as JobCard;

      const endedIncidentId = await insertIncident(pool, {
        organizationId, jobId: job.id, episodeNo: 1, scheduleRevisionNo: 1,
        deadlineAt: BREACHED_AT, breachedAt: BREACHED_AT,
      });
      await setEnding(pool, endedIncidentId, {
        endedAt: ENDED_AT,
        endedByUserId: managerId,
        endReason: 'DEADLINE_EXTENDED',
        endNote: 'Tarih uzatıldı.',
        endedByScheduleRevisionNo: 1,
      });
      const openIncidentId = await insertIncident(pool, {
        organizationId, jobId: job.id, episodeNo: 1, scheduleRevisionNo: 2,
        deadlineAt: ENDED_AT, breachedAt: ENDED_AT,
      });

      // Without `AND ended_at IS NULL` the UPDATE would also stamp the ended
      // row, and the ending/recovery exclusivity CHECK would fail the whole
      // SUBMIT transaction.
      job = await submitJob(service, staff, job);
      expect(job.status).toBe('WAITING_APPROVAL');

      const reservedAt = await reservedAtFor(
        pool, organizationId, job.id, `JOB_SUBMIT_FOR_APPROVAL:${job.id}`,
      );
      const rows = await selectIncidents(pool, organizationId, job.id);
      const endedRow = rows.find((row) => row.id === endedIncidentId)!;
      const openRow = rows.find((row) => row.id === openIncidentId)!;

      // The ended row is evidence: untouched, never recovered.
      expect(endedRow.recovered_at).toBeNull();
      expect(endedRow.recovery_actor_user_id).toBeNull();
      expect(endedRow.ended_at).toEqual(ENDED_AT);
      expect(endedRow.ended_by_user_id).toBe(managerId);
      expect(endedRow.end_reason).toBe('DEADLINE_EXTENDED');
      expect(endedRow.end_note).toBe('Tarih uzatıldı.');
      expect(endedRow.ended_by_schedule_revision_no).toBe(1);

      // Only the open row is recovered by the lifecycle command.
      expect(openRow.recovered_at).toEqual(reservedAt);
      expect(openRow.recovery_actor_user_id).toBe(staffId);
      expect(openRow.ended_at).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // O1: every current-state reader says "not open" for an ended incident.
  // -------------------------------------------------------------------------

  it('O1: open readers ignore an ended LATE_SUBMISSION incident', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'OVR5a O1');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe');
      const { manager, staff } = actors(organizationId, managerId, staffId);
      const clock = { now: await dbBaseline(pool) };
      const service = buildService(pool, () => clock.now);

      let job = await createTask(service, staff, {
        title: 'Uzatılmış gecikme', dueDate: dateKeyShift(clock.now, -3),
      });
      job = await startJob(service, staff, job);
      const scanTime = await dbBaseline(pool);
      await scanOnce(pool, scanTime);
      const incidents = await selectIncidents(pool, organizationId, job.id);
      expect(incidents).toHaveLength(1);
      const incidentId = incidents[0]!.id;

      await setEnding(pool, incidentId, {
        endedAt: shiftMs(incidents[0]!.breached_at, 30 * 60_000),
        endedByUserId: managerId,
        endReason: 'DEADLINE_EXTENDED',
        endNote: 'Yönetim tarih uzattı.',
        endedByScheduleRevisionNo: 1,
      });

      // Management open-late list.
      const openLate = await service.listOpenSubmissionLate(manager, { limit: 25, offset: 0 });
      expect(openLate.items.filter((item) => item.jobCardId === job.id)).toHaveLength(0);
      expect(openLate.total).toBe(0);

      // Per-job submission-lateness snapshot.
      expect((await service.getSubmissionLateness(staff, job.id)).open).toBeNull();

      // OVR-4 discovery.
      const repository = new PostgresJobCardRepository(pool);
      const due = await repository.listDueOpenSubmissionLateEpisodes({
        scanTime: shiftMs(scanTime, 60 * 60_000), timing: TIMING, limit: 50,
      });
      expect(due.filter((candidate) => candidate.jobCardId === job.id)).toHaveLength(0);

      // Manual reminder guard: the ended incident is not an open lateness.
      await expect(service.sendSubmissionReminder(manager, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      })).rejects.toMatchObject({ code: 'SUBMISSION_NOT_LATE', statusCode: 409 });
      const reminders = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM job_card_submission_reminders
          WHERE organization_id = $1 AND job_card_id = $2`,
        [organizationId, job.id],
      );
      expect(reminders.rows[0]!.count).toBe('0');
    });
  });

  // -------------------------------------------------------------------------
  // H1: history DTO exposes the ending record.
  // -------------------------------------------------------------------------

  it('H1: history exposes the ending record and stops reminder statistics at endedAt', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'OVR5a H1');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe');
      const { manager, staff } = actors(organizationId, managerId, staffId);
      const clock = { now: await dbBaseline(pool) };
      const service = buildService(pool, () => clock.now);

      let endedJob = await createTask(service, staff, {
        title: 'Sonlandırılan gecikme', dueDate: dateKeyShift(clock.now, -3),
      });
      endedJob = await startJob(service, staff, endedJob);
      await scanOnce(pool, await dbBaseline(pool));
      const endedIncident = (await selectIncidents(pool, organizationId, endedJob.id))[0]!;

      // One manual reminder while the episode is open.
      clock.now = shiftMs(endedIncident.breached_at, 10 * 60_000);
      const reminderSentAt = clock.now;
      await service.sendSubmissionReminder(manager, endedJob.id, {
        clientActionId: randomUUID(), expectedVersion: endedJob.version,
      });

      const endedAt = shiftMs(endedIncident.breached_at, 30 * 60_000);
      await setEnding(pool, endedIncident.id, {
        endedAt,
        endedByUserId: managerId,
        endReason: 'DEADLINE_EXTENDED',
        endNote: 'Müşteri toplantısı ertelendi.',
        endedByScheduleRevisionNo: 1,
      });
      // A reminder recorded after the ending is not part of this obligation.
      await pool.query(
        `INSERT INTO job_card_submission_reminders
           (organization_id, job_card_id, incident_id, episode_no,
            schedule_revision_no, manager_user_id, target_staff_user_id,
            sent_at, client_action_id, operation_key)
         VALUES ($1, $2, $3, 1, 1, $4, $5, $6, $7, $8)`,
        [
          organizationId, endedJob.id, endedIncident.id, managerId, staffId,
          shiftMs(endedAt, 10 * 60_000), randomUUID(),
          `JOB_SUBMISSION_REMINDER:${endedJob.id}`,
        ],
      );

      const endedHistory = await service.listOverdueIncidents(
        manager, endedJob.id, { limit: 25, offset: 0 },
      );
      expect(endedHistory.items).toHaveLength(1);
      const endedItem = endedHistory.items[0]!;
      expect(endedItem.endedAt).toBe(endedAt.toISOString());
      expect(endedItem.endedBy).toEqual({ id: managerId, name: 'Müdür' });
      expect(endedItem.endReason).toBe('DEADLINE_EXTENDED');
      expect(endedItem.endNote).toBe('Müşteri toplantısı ertelendi.');
      expect(endedItem.endedByScheduleRevisionNo).toBe(1);
      expect(endedItem.endedDurationSeconds).toBe(
        Math.floor((endedAt.getTime() - endedIncident.breached_at.getTime()) / 1000),
      );
      expect(endedItem.totalDelaySeconds).toBeNull();
      expect(endedItem.postReminderDelaySeconds).toBeNull();
      expect(endedItem.recoveredAt).toBeNull();
      expect(endedItem.recoveryActor).toBeNull();
      expect(endedItem.manualReminderCount).toBe(1);
      expect(endedItem.manualReminderSentAt).toBe(reminderSentAt.toISOString());

      // A row that is still open carries no ending fields at all. Reset the
      // service clock to the DB baseline so the job's initial schedule revision
      // precedes the scan instant.
      clock.now = await dbBaseline(pool);
      let openJob = await createTask(service, staff, {
        title: 'Açık gecikme', dueDate: dateKeyShift(clock.now, -3),
      });
      openJob = await startJob(service, staff, openJob);
      await scanOnce(pool, await dbBaseline(pool));
      const openHistory = await service.listOverdueIncidents(
        manager, openJob.id, { limit: 25, offset: 0 },
      );
      expect(openHistory.items).toHaveLength(1);
      const openItem = openHistory.items[0]!;
      expect(openItem.endedAt).toBeNull();
      expect(openItem.endedBy).toBeNull();
      expect(openItem.endReason).toBeNull();
      expect(openItem.endNote).toBeNull();
      expect(openItem.endedByScheduleRevisionNo).toBeNull();
      expect(openItem.endedDurationSeconds).toBeNull();
      expect(openItem.recoveredAt).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // T1: the patch instant is sampled after the JobCard lock.
  // -------------------------------------------------------------------------

  it('T1: a patch waiting on the JobCard lock uses the post-lock clock sample', async () => {
    await withSchema(async (pool, schema) => {
      const organizationId = await insertOrg(pool, 'OVR5a T1');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe');
      const { manager, staff } = actors(organizationId, managerId, staffId);

      const preLock = await dbBaseline(pool);
      const postLock = shiftMs(preLock, 5 * 60_000);
      const clock = { now: preLock, reads: [] as Date[] };
      const service = buildService(pool, () => {
        clock.reads.push(clock.now);
        return clock.now;
      });

      let job = await createTask(service, staff, {
        title: 'Kilit bekleyen plan', dueDate: dateKeyShift(preLock, 10),
      });
      clock.reads.length = 0;

      const schemaOptions = `-c search_path=${schema},public`;
      const holder = new Pool({ connectionString: databaseUrl, options: schemaOptions });
      const holderClient = await holder.connect();
      const blockedPool = new Pool({
        connectionString: databaseUrl,
        options: schemaOptions,
        max: 1,
        application_name: 'ovr5a-t1-blocked',
      });
      try {
        await holderClient.query('BEGIN');
        await holderClient.query(
          'SELECT id FROM job_cards WHERE organization_id = $1 AND id = $2 FOR UPDATE',
          [organizationId, job.id],
        );

        const blockedService = buildService(blockedPool, () => {
          clock.reads.push(clock.now);
          return clock.now;
        });
        const pending = blockedService.patch(manager, job.id, {
          expectedVersion: job.version,
          dueDate: dateKeyShift(preLock, 12),
        } as never);

        // Prove the patch is blocked on the JobCard row lock: no sleep-based
        // assumption. Only after that is the business clock advanced.
        await waitFor(async () => {
          const waiting = await pool.query<{ n: string }>(
            `SELECT COUNT(*)::text AS n FROM pg_stat_activity
              WHERE application_name = 'ovr5a-t1-blocked'
                AND wait_event_type = 'Lock'`,
          );
          return waiting.rows[0]!.n !== '0';
        }, 5_000, 'patch waiting on the JobCard row lock');
        clock.now = postLock;
        await holderClient.query('COMMIT');

        const patched = await pending as unknown as { id: string };
        expect(patched.id).toBe(job.id);

        const revisions = await selectScheduleRevisions(pool, organizationId, job.id);
        expect(revisions).toHaveLength(2);
        // A pre-lock sample would have written `preLock`; the contract is the
        // instant sampled after the lock was acquired.
        expect(revisions[1]!.revision_no).toBe(2);
        expect(revisions[1]!.created_at).toEqual(postLock);
        expect(clock.reads.length).toBeGreaterThan(0);
        expect(clock.reads.at(-1)).toEqual(postLock);
      } finally {
        await holderClient.query('ROLLBACK').catch(() => undefined);
        holderClient.release();
        await blockedPool.end();
        await holder.end();
      }
    });
  });

  // -------------------------------------------------------------------------
  // A1: the new activity event is a plain fact and maps to job.updated.
  // -------------------------------------------------------------------------

  it('A1: JOB_OVERDUE_ENDED_BY_EXTENSION presents as NONE and maps to job.updated', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'OVR5a A1');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe');
      const { manager } = actors(organizationId, managerId, staffId);
      const clock = { now: EVIDENCE_AT };
      const service = buildService(pool, () => clock.now);
      const job = await createTask(service, { id: staffId, organizationId, role: 'STAFF' }, {
        title: 'Aktivite işi', dueDate: null,
      });

      const activityId = (await pool.query<{ id: string }>(
        `INSERT INTO job_card_activity_logs
           (organization_id, job_card_id, actor_id, event_type, metadata)
         VALUES ($1, $2, $3, 'JOB_OVERDUE_ENDED_BY_EXTENSION', $4::jsonb)
         RETURNING id`,
        [
          organizationId, job.id, managerId,
          JSON.stringify({
            incidentIds: [randomUUID()],
            delayTypes: ['LATE_SUBMISSION'],
            episodeNo: 1,
            reason: 'Müşteri randevusu ertelendi.',
          }),
        ],
      )).rows[0]!.id;

      const activity = await service.listActivity(
        manager, job.id, { limit: 25, offset: 0 },
      );
      const item = activity.items.find((entry) => entry.id === activityId)!;
      expect(item.eventType).toBe('JOB_OVERDUE_ENDED_BY_EXTENSION');
      expect(item.details).toEqual({ kind: 'NONE' });

      const mapped = mapJobCardActivityToRealtime({
        activityId,
        organizationId,
        jobCardId: job.id,
        actorUserId: managerId,
        event: 'JOB_OVERDUE_ENDED_BY_EXTENSION',
        occurredAt: EVIDENCE_AT,
        beforeAssigneeId: null,
        afterAssigneeId: staffId,
      });
      expect(mapped).not.toBeNull();
      expect(mapped!.type).toBe('job.updated');
      expect(mapped!.entityType).toBe('job-card');
      expect(mapped!.entityId).toBe(job.id);
    });
  });
});
