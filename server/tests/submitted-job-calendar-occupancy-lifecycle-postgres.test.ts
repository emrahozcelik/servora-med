import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCardActor } from '../src/modules/job-cards/types.js';
import {
  MINUTE_MS,
  baselineAlignedToGrid,
  baselineIso,
  readDbBaseline,
} from './support/db-clock-baseline.js';

/**
 * JOB-007 through the real Staff lifecycle commands (no raw status writes).
 *
 * `submitted-job-calendar-occupancy-postgres.test.ts` seeds rows directly to
 * isolate the occupancy SQL. This file proves the same rule survives the
 * commands Staff and Managers actually call: CREATE -> START ->
 * SUBMIT_FOR_APPROVAL -> CREATE -> START, with the Manager doing nothing.
 *
 * Time: lifecycle business time is the PostgreSQL arbitration clock sampled
 * under the JobCard lock (see `support/db-clock-baseline.ts`), so the scenario
 * is anchored to that authoritative clock instead of a hard-coded date or a
 * real-time wait. The injected service clock only shapes the CREATE/read
 * instants it owns, exactly as it does in production wiring.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

describe.skipIf(!databaseUrl)('JOB-007 real Staff lifecycle', () => {
  const adminPool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
  const schema = `job007_lifecycle_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool;
  let organizationId: string;
  let manager: JobCardActor;
  let service: JobCardService;
  /** Scenario clock the service reads for the instants it owns (CREATE, detail). */
  let serviceNow = new Date('2026-01-01T00:00:00.000Z');

  function setClock(instant: Date | string) {
    serviceNow = instant instanceof Date ? instant : new Date(instant);
  }

  async function insertUser(name: string, role: 'STAFF' | 'MANAGER') {
    return (await pool.query<{ id: string }>(
      `INSERT INTO users (organization_id, name, email, password_hash, role, is_active)
       VALUES ($1, $2, $3, 'test-hash', $4, TRUE) RETURNING id`,
      [organizationId, name, `${randomUUID()}@test.local`, role],
    )).rows[0]!.id;
  }

  async function insertCustomer(name: string) {
    return (await pool.query<{ id: string }>(
      `INSERT INTO customers (organization_id, name, customer_type, status)
       VALUES ($1, $2, 'clinic', 'active') RETURNING id`,
      [organizationId, name],
    )).rows[0]!.id;
  }

  async function newStaff(name: string): Promise<JobCardActor> {
    const id = await insertUser(name, 'STAFF');
    return { id, organizationId, role: 'STAFF' };
  }

  /**
   * The scenario's "10:00" and "11:00" on the DB clock. `aligned` is a whole
   * minute at or before the DB baseline, so the planned visit has already
   * started (START is allowed) and still has ~48 minutes left (the submission
   * below is genuinely early).
   */
  async function plannedInterval() {
    const aligned = baselineAlignedToGrid(await readDbBaseline(pool), 1);
    return {
      plannedStart: baselineIso(aligned, -12 * MINUTE_MS),
      plannedEnd: baselineIso(aligned, 48 * MINUTE_MS),
    };
  }

  /** Staff self-creates a visit (self-assignment is auto-accepted). */
  async function createMeeting(
    actor: JobCardActor,
    assigneeId: string,
    customerId: string,
    scheduledAt: string,
  ) {
    return service.create(actor, {
      clientActionId: randomUUID(),
      type: 'SALES_MEETING',
      title: 'Müşteri ziyareti',
      description: null,
      customerId,
      contactId: null,
      assignedTo: assigneeId,
      priority: 'normal',
      dueDate: null,
      scheduledAt,
      scheduledEndsAt: new Date(Date.parse(scheduledAt) + 60 * MINUTE_MS).toISOString(),
      engagementKind: 'SALES_MEETING',
    });
  }

  async function startVisit(staff: JobCardActor, jobCardId: string, version: number) {
    const started = await service.start(staff, jobCardId, {
      clientActionId: randomUUID(),
      expectedVersion: version,
    });
    expect(started.status).toBe('IN_PROGRESS');
    return started;
  }

  /** Record the visit result and SUBMIT_FOR_APPROVAL — the real Staff commands. */
  async function submitVisit(
    staff: JobCardActor,
    jobCardId: string,
    version: number,
    meetingAt: string,
  ) {
    const details = await service.patchMeetingDetails(staff, jobCardId, {
      clientActionId: randomUUID(),
      expectedVersion: version,
      meetingAt,
      outcome: 'POSITIVE',
      meetingSummary: 'Klinik yetkilisiyle görüşüldü.',
      nextFollowUpAt: null,
    });
    const submitted = await service.submitForApproval(staff, jobCardId, {
      clientActionId: randomUUID(),
      expectedVersion: details.jobCardVersion,
      note: 'Görüşme sonucu kaydedildi.',
    });
    expect(submitted.status).toBe('WAITING_APPROVAL');
    return submitted;
  }

  async function readJob(jobCardId: string) {
    return (await pool.query<{
      status: string;
      version: number;
      scheduled_at: Date;
      scheduled_ends_at: Date;
      started_at: Date | null;
      staff_completed_at: Date | null;
      manager_approved_at: Date | null;
      manager_approved_by: string | null;
    }>(
      `SELECT status, version, scheduled_at, scheduled_ends_at, started_at,
              staff_completed_at, manager_approved_at, manager_approved_by
         FROM job_cards WHERE id = $1`,
      [jobCardId],
    )).rows[0]!;
  }

  beforeAll(async () => {
    await adminPool!.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
    await runMigrations({
      migrationsDirectory: MIGRATIONS_DIRECTORY,
      store: new PostgresMigrationStore(pool),
    });
    organizationId = (await pool.query<{ id: string }>(
      `INSERT INTO organizations (name, timezone)
       VALUES ('JOB-007 lifecycle', 'Europe/Istanbul') RETURNING id`,
    )).rows[0]!.id;
    const managerId = await insertUser('Yönetici', 'MANAGER');
    manager = { id: managerId, organizationId, role: 'MANAGER' };
    service = new JobCardService(
      new PostgresJobCardRepository(pool),
      () => serviceNow,
      { publish: () => undefined },
      { enabled: false },
      { enabled: false },
      { enabled: true, reminderLeadMinutes: 30 },
    );
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool?.end();
  });

  it('lets Staff start a different customer while the submitted job waits for approval', async () => {
    const staff = await newStaff('Erken bitiren personel');
    const firstCustomer = await insertCustomer('Klinik A');
    const secondCustomer = await insertCustomer('Klinik B');
    const { plannedStart, plannedEnd } = await plannedInterval();
    setClock(plannedStart);

    const first = await createMeeting(staff, staff.id, firstCustomer, plannedStart);
    expect(first).toMatchObject({
      status: 'ACCEPTED',
      scheduledAt: plannedStart,
      scheduledEndsAt: plannedEnd,
    });

    // Staff starts the planned 10:00 visit.
    const started = await startVisit(staff, first.id, first.version);

    // 10:05 — the staff member really submits, five minutes into the visit.
    const waiting = await submitVisit(staff, first.id, started.version, plannedStart);
    const waitingFacts = await readJob(first.id);
    const submittedAt = waitingFacts.staff_completed_at!;
    expect(waitingFacts.status).toBe('WAITING_APPROVAL');
    expect(waitingFacts.started_at).not.toBeNull();
    expect(submittedAt.getTime()).toBeGreaterThanOrEqual(Date.parse(plannedStart));
    expect(submittedAt.getTime()).toBeLessThan(Date.parse(plannedEnd));
    // The Manager has done nothing.
    expect(waitingFacts.manager_approved_at).toBeNull();
    expect(waitingFacts.manager_approved_by).toBeNull();

    // 10:06 — same Staff member opens a visit for a different customer. The DB
    // clock instant sampled now is at or after the submission instant, so the
    // new interval begins after the released occupancy.
    const nextStart = (await readDbBaseline(pool)).toISOString();
    expect(Date.parse(nextStart)).toBeGreaterThanOrEqual(submittedAt.getTime());
    setClock(nextStart);

    const second = await createMeeting(staff, staff.id, secondCustomer, nextStart);
    expect(second).toMatchObject({ status: 'ACCEPTED', scheduledAt: nextStart });

    // 10:06 — the second visit really starts for the other customer.
    await startVisit(staff, second.id, second.version);

    // The first job did not become COMPLETED on its own and kept its planned
    // interval and its version/history.
    const after = await service.detail(staff, first.id);
    expect(after).toMatchObject({
      status: 'WAITING_APPROVAL',
      version: waiting.version,
      scheduledAt: plannedStart,
      scheduledEndsAt: plannedEnd,
    });
    const finalFacts = await readJob(first.id);
    expect(finalFacts.status).toBe('WAITING_APPROVAL');
    expect(finalFacts.staff_completed_at!.toISOString()).toBe(submittedAt.toISOString());
    expect(finalFacts.manager_approved_at).toBeNull();
    expect(finalFacts.scheduled_at.toISOString()).toBe(plannedStart);
    expect(finalFacts.scheduled_ends_at.toISOString()).toBe(plannedEnd);

    // The planned interval is never rewritten: the create revision is intact
    // and no reschedule revision was appended by START or SUBMIT.
    const revisions = await pool.query<{
      revision_no: number; scheduled_at: Date; scheduled_ends_at: Date; source: string;
    }>(
      `SELECT revision_no, scheduled_at, scheduled_ends_at, source
         FROM job_card_schedule_revisions WHERE job_card_id = $1 ORDER BY revision_no`,
      [first.id],
    );
    expect(revisions.rows).toHaveLength(1);
    expect(revisions.rows[0]).toMatchObject({ revision_no: 1, source: 'CREATE' });
    expect(revisions.rows[0]!.scheduled_at.toISOString()).toBe(plannedStart);
    expect(revisions.rows[0]!.scheduled_ends_at.toISOString()).toBe(plannedEnd);

    const firstEvents = (await service.listActivity(staff, first.id, { limit: 50, offset: 0 }))
      .items.map((item) => item.eventType);
    expect(firstEvents).toEqual(expect.arrayContaining([
      'JOB_CREATED', 'JOB_STARTED', 'JOB_SUBMITTED_FOR_APPROVAL',
    ]));
    expect(firstEvents).not.toContain('JOB_APPROVED');
    const secondEvents = (await service.listActivity(staff, second.id, { limit: 50, offset: 0 }))
      .items.map((item) => item.eventType);
    expect(secondEvents).toEqual(expect.arrayContaining(['JOB_CREATED', 'JOB_STARTED']));
  });

  it('still rejects a second visit while the first job is IN_PROGRESS', async () => {
    const staff = await newStaff('Çalışan personel');
    const firstCustomer = await insertCustomer('Klinik C');
    const secondCustomer = await insertCustomer('Klinik D');
    const { plannedStart } = await plannedInterval();
    setClock(plannedStart);

    const running = await createMeeting(staff, staff.id, firstCustomer, plannedStart);
    await startVisit(staff, running.id, running.version);

    const overlapping = new Date(Date.parse(plannedStart) + 30 * MINUTE_MS).toISOString();
    // A Manager schedules the clash so the conflict payload is not redacted
    // (STAFF callers only learn that a conflict exists, per JOB-007 scope).
    await expect(createMeeting(manager, staff.id, secondCustomer, overlapping)).rejects.toMatchObject({
      code: 'CALENDAR_CONFLICT',
      statusCode: 409,
      details: {
        conflicts: [expect.objectContaining({
          id: running.id,
          source: 'JOB',
          startsAt: plannedStart,
          // Without a submission the whole planned interval is occupied.
          endsAt: new Date(Date.parse(plannedStart) + 60 * MINUTE_MS).toISOString(),
        })],
      },
    });
  });

  it('still rejects overlap with the part of the visit that actually happened', async () => {
    const staff = await newStaff('Gerçek çakışma personeli');
    const firstCustomer = await insertCustomer('Klinik E');
    const secondCustomer = await insertCustomer('Klinik F');
    const { plannedStart } = await plannedInterval();
    setClock(plannedStart);

    const first = await createMeeting(staff, staff.id, firstCustomer, plannedStart);
    const started = await startVisit(staff, first.id, first.version);
    const waiting = await submitVisit(staff, first.id, started.version, plannedStart);
    const submittedAt = (await readJob(first.id)).staff_completed_at!;

    // One millisecond before the submission instant is still inside the visit.
    const overlapStart = new Date(submittedAt.getTime() - 1).toISOString();
    setClock(overlapStart);
    await expect(createMeeting(manager, staff.id, secondCustomer, overlapStart)).rejects.toMatchObject({
      code: 'CALENDAR_CONFLICT',
      statusCode: 409,
      details: {
        conflicts: [expect.objectContaining({
          id: first.id,
          source: 'JOB',
          startsAt: plannedStart,
          endsAt: submittedAt.toISOString(),
        })],
      },
    });
    expect(waiting.status).toBe('WAITING_APPROVAL');
  });

  it('still refuses START before the new visit is planned to begin', async () => {
    const staff = await newStaff('Erken başlatmak isteyen personel');
    const customerId = await insertCustomer('Klinik G');
    const futureStart = baselineIso(await readDbBaseline(pool), 30 * MINUTE_MS);
    setClock(futureStart);

    const future = await createMeeting(staff, staff.id, customerId, futureStart);
    await expect(service.start(staff, future.id, {
      clientActionId: randomUUID(),
      expectedVersion: future.version,
    })).rejects.toMatchObject({ code: 'INVALID_TRANSITION', statusCode: 409 });

    const facts = await readJob(future.id);
    expect(facts.status).toBe('ACCEPTED');
    expect(facts.started_at).toBeNull();
  });
});
