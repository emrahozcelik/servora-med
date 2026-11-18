import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { PostgresCalendarRepository } from '../src/modules/calendar/repository.js';
import { CalendarService } from '../src/modules/calendar/service.js';
import type { CalendarActor } from '../src/modules/calendar/types.js';
import { PostgresJobCardRepository, PostgresJobCardTransaction } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCardActor } from '../src/modules/job-cards/types.js';

/**
 * JOB-007: a job waiting for manager approval stops occupying its assignee's
 * calendar at the staff submission instant; the planned interval is unchanged.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const CLOCK = new Date('2026-08-01T08:00:00.000Z');

const PLANNED_START = '2026-08-20T10:00:00.000Z';
const PLANNED_END = '2026-08-20T11:00:00.000Z';
const EARLY_SUBMIT = '2026-08-20T10:05:00.000Z';

describe.skipIf(!databaseUrl)('JOB-007 submitted job calendar occupancy', () => {
  const adminPool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
  const schema = `job007_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool;
  let organizationId: string;
  let managerId: string;
  let service: JobCardService;
  let calendar: CalendarService;
  let manager: JobCardActor;

  async function insertUser(role: 'MANAGER' | 'STAFF', name: string) {
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

  /** Earlier delivery that the Staff member already started (and maybe submitted). */
  async function insertEarlierJob(input: {
    staffId: string;
    status: 'IN_PROGRESS' | 'WAITING_APPROVAL' | 'REVISION_REQUESTED';
    staffCompletedAt: string | null;
  }) {
    const customerId = await insertCustomer(`Önceki Klinik ${randomUUID().slice(0, 8)}`);
    return (await pool.query<{ id: string }>(
      `INSERT INTO job_cards
         (organization_id, type, status, title, customer_id, assigned_to, created_by,
          scheduled_at, scheduled_ends_at, started_at, staff_completed_at, staff_completed_by,
          revision_requested_at, revision_requested_by, revision_reason)
       VALUES ($1, 'PRODUCT_DELIVERY', $2::text, 'Önceki teslimat', $3, $4, $5,
               $6, $7, $6, $8::timestamptz, CASE WHEN $8::timestamptz IS NULL THEN NULL ELSE $4::uuid END,
               CASE WHEN $2::text = 'REVISION_REQUESTED' THEN $8::timestamptz END,
               CASE WHEN $2::text = 'REVISION_REQUESTED' THEN $5::uuid END,
               CASE WHEN $2::text = 'REVISION_REQUESTED' THEN 'Teslim notu eksik' END)
       RETURNING id`,
      [organizationId, input.status, customerId, input.staffId, managerId,
        PLANNED_START, PLANNED_END, input.staffCompletedAt],
    )).rows[0]!.id;
  }

  async function createMeeting(staffId: string, scheduledAt: string) {
    const customerId = await insertCustomer(`Yeni Klinik ${randomUUID().slice(0, 8)}`);
    return service.create(manager, {
      clientActionId: randomUUID(),
      type: 'SALES_MEETING',
      title: 'Yeni müşteri görüşmesi',
      description: null,
      customerId,
      contactId: null,
      assignedTo: staffId,
      priority: 'normal',
      dueDate: null,
      scheduledAt,
      scheduledEndsAt: new Date(Date.parse(scheduledAt) + 60 * 60_000).toISOString(),
      engagementKind: 'SALES_MEETING',
    });
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
       VALUES ('JOB-007 occupancy', 'Europe/Istanbul') RETURNING id`,
    )).rows[0]!.id;
    managerId = await insertUser('MANAGER', 'Yönetici');
    manager = { id: managerId, organizationId, role: 'MANAGER' };
    service = new JobCardService(
      new PostgresJobCardRepository(pool),
      () => CLOCK,
      { publish: () => undefined },
      { enabled: false },
      { enabled: false },
      { enabled: true, reminderLeadMinutes: 30 },
    );
    calendar = new CalendarService(true, new PostgresCalendarRepository(pool, 30, false), () => CLOCK);
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool?.end();
  });

  it('releases the rest of the planned interval once Staff submits for approval', async () => {
    const staffId = await insertUser('STAFF', 'Erken bitiren personel');
    const earlierId = await insertEarlierJob({
      staffId, status: 'WAITING_APPROVAL', staffCompletedAt: EARLY_SUBMIT,
    });

    const created = await createMeeting(staffId, EARLY_SUBMIT);
    expect(created).toMatchObject({ scheduledAt: EARLY_SUBMIT });

    // The planned interval of the submitted job is never rewritten.
    const earlier = await pool.query<{ scheduled_at: Date; scheduled_ends_at: Date }>(
      'SELECT scheduled_at, scheduled_ends_at FROM job_cards WHERE id = $1', [earlierId],
    );
    expect(earlier.rows[0]!.scheduled_at.toISOString()).toBe(PLANNED_START);
    expect(earlier.rows[0]!.scheduled_ends_at.toISOString()).toBe(PLANNED_END);
  });

  it('still rejects overlap with the part of the visit that actually happened', async () => {
    const staffId = await insertUser('STAFF', 'Gerçek çakışma');
    const earlierId = await insertEarlierJob({
      staffId, status: 'WAITING_APPROVAL', staffCompletedAt: EARLY_SUBMIT,
    });

    await expect(createMeeting(staffId, '2026-08-20T09:30:00.000Z')).rejects.toMatchObject({
      code: 'CALENDAR_CONFLICT',
      statusCode: 409,
      details: {
        conflicts: [expect.objectContaining({
          id: earlierId, source: 'JOB', startsAt: PLANNED_START, endsAt: EARLY_SUBMIT,
        })],
      },
    });
  });

  it('keeps the planned end when the submission came after it', async () => {
    const staffId = await insertUser('STAFF', 'Geç gönderen personel');
    const earlierId = await insertEarlierJob({
      staffId, status: 'WAITING_APPROVAL', staffCompletedAt: '2026-08-20T11:40:00.000Z',
    });

    await expect(createMeeting(staffId, '2026-08-20T10:30:00.000Z')).rejects.toMatchObject({
      code: 'CALENDAR_CONFLICT',
      details: { conflicts: [expect.objectContaining({ id: earlierId, endsAt: PLANNED_END })] },
    });
    await expect(createMeeting(staffId, PLANNED_END)).resolves.toMatchObject({ scheduledAt: PLANNED_END });
  });

  it.each(['IN_PROGRESS', 'REVISION_REQUESTED'] as const)(
    '%s keeps occupying the full planned interval',
    async (status) => {
      const staffId = await insertUser('STAFF', `Aktif ${status}`);
      const earlierId = await insertEarlierJob({
        staffId,
        status,
        // A withdrawn or revised job keeps its earlier submission instant.
        staffCompletedAt: EARLY_SUBMIT,
      });

      await expect(createMeeting(staffId, '2026-08-20T10:10:00.000Z')).rejects.toMatchObject({
        code: 'CALENDAR_CONFLICT',
        details: { conflicts: [expect.objectContaining({ id: earlierId, endsAt: PLANNED_END })] },
      });
    },
  );

  it('available-slot intervals report the occupied end', async () => {
    const staffId = await insertUser('STAFF', 'Slot arama');
    await insertEarlierJob({ staffId, status: 'WAITING_APPROVAL', staffCompletedAt: EARLY_SUBMIT });

    const client = await pool.connect();
    try {
      const intervals = await new PostgresJobCardTransaction(client).listAssigneeCalendarIntervals(
        organizationId, staffId,
        new Date('2026-08-20T00:00:00.000Z'), new Date('2026-08-21T00:00:00.000Z'), null,
      );
      expect(intervals).toEqual([{ startsAt: PLANNED_START, endsAt: EARLY_SUBMIT }]);
    } finally {
      client.release();
    }
  });

  it('manual calendar events use the same occupancy rule', async () => {
    const staffId = await insertUser('STAFF', 'Takvim planı');
    const earlierId = await insertEarlierJob({
      staffId, status: 'WAITING_APPROVAL', staffCompletedAt: EARLY_SUBMIT,
    });
    const calendarManager: CalendarActor = { id: managerId, organizationId, role: 'MANAGER' };
    const input = (startsAt: string, endsAt: string) => ({
      clientActionId: randomUUID(),
      assignedUserId: staffId,
      title: 'Klinik hazırlığı',
      description: null,
      startsAt,
      endsAt,
      timezone: 'Europe/Istanbul',
    });

    await expect(calendar.create(calendarManager, input(EARLY_SUBMIT, '2026-08-20T10:45:00.000Z')))
      .resolves.toMatchObject({ source: 'MANUAL' });
    await expect(calendar.create(calendarManager, input('2026-08-20T09:30:00.000Z', '2026-08-20T10:02:00.000Z')))
      .rejects.toMatchObject({
        code: 'CALENDAR_CONFLICT',
        details: { conflicts: [expect.objectContaining({ id: earlierId, source: 'JOB', endsAt: EARLY_SUBMIT })] },
      });
  });
});
