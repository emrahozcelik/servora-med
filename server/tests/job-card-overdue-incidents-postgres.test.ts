import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { loadMigrationCatalog } from '../src/db/migration-catalog.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCard, JobCardActor } from '../src/modules/job-cards/types.js';
import type { RealtimeEventPublisher } from '../src/modules/realtime/event-bus.js';
import type { RealtimeEventRecord } from '../src/modules/realtime/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

// Monday 2026-08-03 (working day, Europe/Istanbul = UTC+3).
const CREATE_AT = new Date('2026-08-03T06:00:00.000Z');
const LATE_AT = new Date('2026-08-03T08:00:00.000Z');
const DELIVERY_START = '2026-08-03T07:00:00.000Z'; // 10:00 +03, canonical end 07:30Z.

async function withSchema(run: (pool: Pool) => Promise<void>): Promise<void> {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `ovr2_${randomUUID().replaceAll('-', '')}`;
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

async function insertCustomer(pool: Pool, organizationId: string): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO customers (organization_id, name, customer_type, status)
     VALUES ($1, 'OVR2 Klinik', 'clinic', 'active') RETURNING id`,
    [organizationId],
  )).rows[0]!.id;
}

function buildService(pool: Pool, clock: { now: Date }): JobCardService {
  const published: RealtimeEventRecord[] = [];
  const publisher: RealtimeEventPublisher = { publish: (event) => published.push(event) };
  return new JobCardService(
    new PostgresJobCardRepository(pool),
    () => clock.now,
    publisher,
    { enabled: false },
    { enabled: false },
    { enabled: false, reminderLeadMinutes: 30 },
  );
}

function actors(organizationId: string, managerId: string, staffAId: string, staffBId: string) {
  return {
    manager: { id: managerId, organizationId, role: 'MANAGER' } as JobCardActor,
    staffA: { id: staffAId, organizationId, role: 'STAFF' } as JobCardActor,
    staffB: { id: staffBId, organizationId, role: 'STAFF' } as JobCardActor,
  };
}

async function createLateDelivery(
  service: JobCardService,
  staff: JobCardActor,
  customerId: string,
): Promise<JobCard> {
  return (await service.create(staff, {
    clientActionId: randomUUID(),
    type: 'PRODUCT_DELIVERY',
    title: 'Geç başlanan teslim',
    description: null,
    customerId,
    contactId: null,
    assignedTo: staff.id,
    priority: 'normal',
    dueDate: null,
    scheduledAt: DELIVERY_START,
    scheduledEndsAt: undefined,
    engagementKind: undefined,
  } as never)) as JobCard;
}

async function selectIncidents(pool: Pool, organizationId: string, jobId: string) {
  return (await pool.query(
    `SELECT id, delay_type, episode_no, schedule_revision_no,
            deadline_at, breached_at,
            accountable_user_id, accountable_role, accountable_source,
            source, recorded_at, recovered_at, recovery_actor_user_id
       FROM job_card_overdue_incidents
      WHERE organization_id = $1 AND job_card_id = $2
      ORDER BY breached_at DESC, id DESC`,
    [organizationId, jobId],
  )).rows as Record<string, unknown>[];
}

describe.skipIf(!databaseUrl)('OVR-2 overdue accountability incidents', () => {
  it('migration 047 exists and becomes the schema head', async () => {
    await withSchema(async (pool) => {
      const catalog = await loadMigrationCatalog(MIGRATIONS_DIRECTORY);
      expect(catalog.head?.version).toBe('047_job_card_overdue_incidents');
      const applied = await pool.query<{ version: string }>(
        'SELECT version FROM schema_migrations ORDER BY version',
      );
      expect(applied.rows.map((row) => row.version).at(-1))
        .toBe('047_job_card_overdue_incidents');
    });
  });

  it('late START materializes a recovered LATE_START incident', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('OVR2 Org', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'OVR2 Manager');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe Personel');
      await insertUser(pool, organizationId, 'STAFF', 'Mehmet Personel');
      const customerId = await insertCustomer(pool, organizationId);
      const { manager, staffA } = actors(organizationId, managerId, staffAId, staffAId);
      void manager;
      const clock = { now: CREATE_AT };
      const service = buildService(pool, clock);

      let job = await createLateDelivery(service, staffA, customerId);
      clock.now = LATE_AT;
      job = await service.start(staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      expect(job.status).toBe('IN_PROGRESS');

      const incidents = await selectIncidents(pool, organizationId, job.id);
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({
        delay_type: 'LATE_START',
        episode_no: 1,
        schedule_revision_no: 1,
        accountable_user_id: staffAId,
        accountable_role: 'STAFF',
        accountable_source: 'ASSIGNMENT_AT_BREACH',
      });
      expect(incidents[0]!.deadline_at).toEqual(new Date('2026-08-03T07:30:00.000Z'));
      expect(incidents[0]!.breached_at).toEqual(new Date('2026-08-03T07:30:00.000Z'));
      expect(incidents[0]!.recovered_at).toEqual(LATE_AT);
      expect(incidents[0]!.recovery_actor_user_id).toBe(staffAId);
    });
  });

  it('late SUBMIT materializes a recovered LATE_SUBMISSION incident', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('OVR2 Org', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'OVR2 Manager');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe Personel');
      const { staffA } = actors(organizationId, managerId, staffAId, staffAId);
      // Created before the due date so assignment history proves the
      // assignee at the breach instant; submitted after it.
      const clock = { now: new Date('2026-07-30T09:00:00.000Z') };
      const service = buildService(pool, clock);

      let job = (await service.create(staffA, {
        clientActionId: randomUUID(),
        type: 'GENERAL_TASK',
        title: 'Geç teslim edilen görev',
        description: null,
        customerId: null,
        contactId: null,
        assignedTo: staffA.id,
        priority: 'normal',
        dueDate: '2026-08-01',
        scheduledAt: null,
        scheduledEndsAt: undefined,
        engagementKind: undefined,
      } as never)) as JobCard;
      job = await service.start(staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      clock.now = new Date('2026-08-04T09:00:00.000Z');
      job = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
        note: 'Geç de olsa tamamlandı.',
      });
      expect(job.status).toBe('WAITING_APPROVAL');

      const incidents = await selectIncidents(pool, organizationId, job.id);
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({
        delay_type: 'LATE_SUBMISSION',
        episode_no: 1,
        accountable_user_id: staffAId,
        accountable_role: 'STAFF',
      });
      // due_date 2026-08-01 Europe/Istanbul local end = 2026-08-01T21:00Z;
      // first late instant is one millisecond later (domain clock is
      // millisecond-quantized end-to-end; see overdue-incidents.ts).
      expect((incidents[0]!.deadline_at as Date).getTime())
        .toBeGreaterThan(new Date('2026-08-01T21:00:00.000Z').getTime());
      expect(incidents[0]!.recovered_at).toEqual(clock.now);
    });
  });

  it('approval after the 24h threshold materializes APPROVAL_WAIT for MANAGEMENT', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('OVR2 Org', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'OVR2 Manager');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe Personel');
      const { manager, staffA } = actors(organizationId, managerId, staffAId, staffAId);
      const clock = { now: new Date('2026-08-04T09:00:00.000Z') };
      const service = buildService(pool, clock);

      let job = (await service.create(staffA, {
        clientActionId: randomUUID(),
        type: 'GENERAL_TASK',
        title: 'Onayı geciken görev',
        description: null,
        customerId: null,
        contactId: null,
        assignedTo: staffA.id,
        priority: 'normal',
        dueDate: null,
        scheduledAt: null,
        scheduledEndsAt: undefined,
        engagementKind: undefined,
      } as never)) as JobCard;
      job = await service.start(staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      job = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
        note: 'Onaya gönderildi.',
      });
      clock.now = new Date('2026-08-05T10:00:00.000Z'); // 25h later.
      job = await service.approve(manager, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      expect(job.status).toBe('COMPLETED');

      const incidents = await selectIncidents(pool, organizationId, job.id);
      const waits = incidents.filter((row) => row.delay_type === 'APPROVAL_WAIT');
      expect(waits).toHaveLength(1);
      expect(waits[0]).toMatchObject({
        episode_no: 1,
        accountable_user_id: null,
        accountable_role: 'MANAGEMENT',
      });
      expect(waits[0]!.recovered_at).toEqual(clock.now);
      expect(waits[0]!.recovery_actor_user_id).toBe(managerId);
    });
  });

  it('deadline revision after breach preserves the old-revision incident', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('OVR2 Org', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'OVR2 Manager');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe Personel');
      const customerId = await insertCustomer(pool, organizationId);
      const { manager, staffA } = actors(organizationId, managerId, staffAId, staffAId);
      const clock = { now: CREATE_AT };
      const service = buildService(pool, clock);

      let job = await createLateDelivery(service, staffA, customerId);
      clock.now = LATE_AT;
      // Deadline (07:30Z) already passed; manager moves it forward.
      job = await service.patch(manager, job.id, {
        expectedVersion: job.version,
        scheduledAt: '2026-08-03T09:00:00.000Z',
      } as never);

      const incidents = await selectIncidents(pool, organizationId, job.id);
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({
        delay_type: 'LATE_START',
        episode_no: 1,
        schedule_revision_no: 1,
        accountable_user_id: staffAId,
      });
      expect(incidents[0]!.deadline_at).toEqual(new Date('2026-08-03T07:30:00.000Z'));
      expect(incidents[0]!.recovered_at).toBeNull();
    });
  });

  it('START recovers every open LATE_START revision incident for the episode', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('OVR2 Recovery', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Recovery Manager');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Recovery Ayşe');
      const customerId = await insertCustomer(pool, organizationId);
      const { manager, staffA } = actors(organizationId, managerId, staffAId, staffAId);
      const clock = { now: CREATE_AT };
      const service = buildService(pool, clock);

      let job = await createLateDelivery(service, staffA, customerId);
      clock.now = new Date('2026-08-03T10:00:00.000Z');
      job = await service.patch(staffA, job.id, {
        expectedVersion: job.version,
        scheduledAt: '2026-08-03T08:00:00.000Z',
      } as never);
      job = await service.patch(staffA, job.id, {
        expectedVersion: job.version,
        scheduledAt: '2026-08-03T06:00:00.000Z',
      } as never);

      const open = await selectIncidents(pool, organizationId, job.id);
      expect(open).toHaveLength(3);
      expect(open.every((row) => row.recovered_at === null)).toBe(true);

      clock.now = new Date('2026-08-03T11:00:00.000Z');
      job = await service.start(staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      expect(job.status).toBe('IN_PROGRESS');
      const recovered = await selectIncidents(pool, organizationId, job.id);
      expect(recovered).toHaveLength(3);
      expect(recovered.every((row) => row.recovered_at?.getTime() === clock.now.getTime())).toBe(true);
      expect(recovered.every((row) => row.recovery_actor_user_id === staffAId)).toBe(true);
      void manager;
    });
  });

  it('reassignment after breach keeps the old assignee accountable', async () => {    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('OVR2 Org', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'OVR2 Manager');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe Personel');
      const staffBId = await insertUser(pool, organizationId, 'STAFF', 'Mehmet Personel');
      const customerId = await insertCustomer(pool, organizationId);
      const { manager, staffA, staffB } = actors(organizationId, managerId, staffAId, staffBId);
      void staffB;
      const clock = { now: CREATE_AT };
      const service = buildService(pool, clock);

      let job = await createLateDelivery(service, staffA, customerId);
      clock.now = LATE_AT;
      job = await service.patch(manager, job.id, {
        expectedVersion: job.version,
        assignedTo: staffBId,
      } as never);

      const incidents = await selectIncidents(pool, organizationId, job.id);
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({
        delay_type: 'LATE_START',
        accountable_user_id: staffAId,
        accountable_source: 'ASSIGNMENT_AT_BREACH',
      });
      expect(incidents[0]!.recovered_at).toBeNull();

      // Mehmet accepts and STARTs the late work: same incident recovered by Mehmet.
      clock.now = new Date('2026-08-03T09:00:00.000Z');
      const accepted = await service.acceptAssignment(staffB, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      const started = await service.start(staffB, job.id, {
        clientActionId: randomUUID(), expectedVersion: accepted.version,
      });
      expect(started.status).toBe('IN_PROGRESS');
      const after = await selectIncidents(pool, organizationId, job.id);
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({
        accountable_user_id: staffAId,
        recovered_at: clock.now,
        recovery_actor_user_id: staffBId,
      });
    });
  });

  it('history read is management-only with 404 concealment', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('OVR2 Org', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const otherOrgId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('OVR2 Other', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'OVR2 Manager');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe Personel');
      const foreignManagerId = await insertUser(pool, otherOrgId, 'MANAGER', 'Foreign Manager');
      const { manager, staffA } = actors(organizationId, managerId, staffAId, staffAId);
      const foreignManager: JobCardActor = {
        id: foreignManagerId, organizationId: otherOrgId, role: 'MANAGER',
      };
      const clock = { now: CREATE_AT };
      const service = buildService(pool, clock);
      const job = await createLateDelivery(service, staffA, await insertCustomer(pool, organizationId));

      await expect(service.listOverdueIncidents(staffA, job.id, { limit: 25, offset: 0 }))
        .rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
      await expect(service.listOverdueIncidents(foreignManager, job.id, { limit: 25, offset: 0 }))
        .rejects.toMatchObject({ code: 'JOB_CARD_NOT_FOUND', statusCode: 404 });
      await expect(service.listOverdueIncidents(
        manager, '22222222-2222-4222-8222-222222222222', { limit: 25, offset: 0 },
      )).rejects.toMatchObject({ code: 'JOB_CARD_NOT_FOUND', statusCode: 404 });

      const page = await service.listOverdueIncidents(manager, job.id, { limit: 25, offset: 0 });
      expect(page).toMatchObject({ items: [], total: 0, limit: 25, offset: 0 });
    });
  });

  it('history page returns incident DTOs in breached_at DESC order', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('OVR2 Org', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'OVR2 Manager');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe Personel');
      const customerId = await insertCustomer(pool, organizationId);
      const { manager, staffA } = actors(organizationId, managerId, staffAId, staffAId);
      const clock = { now: CREATE_AT };
      const service = buildService(pool, clock);

      let job = await createLateDelivery(service, staffA, customerId);
      clock.now = LATE_AT;
      job = await service.start(staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });

      const page = await service.listOverdueIncidents(manager, job.id, { limit: 1, offset: 0 });
      expect(page.total).toBe(1);
      expect(page.limit).toBe(1);
      expect(page.offset).toBe(0);
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toEqual({
        id: expect.any(String),
        delayType: 'LATE_START',
        episodeNo: 1,
        scheduleRevisionNo: 1,
        deadlineAt: '2026-08-03T07:30:00.000Z',
        breachedAt: '2026-08-03T07:30:00.000Z',
        accountableRole: 'STAFF',
        accountableSource: 'ASSIGNMENT_AT_BREACH',
        accountableUser: { id: staffAId, name: 'Ayşe Personel' },
        source: 'TRANSITION',
        recordedAt: expect.any(String),
        recoveredAt: '2026-08-03T08:00:00.000Z',
        recoveryActor: { id: staffAId, name: 'Ayşe Personel' },
      });
      const empty = await service.listOverdueIncidents(manager, job.id, { limit: 1, offset: 1 });
      expect(empty).toMatchObject({ items: [], total: 1, limit: 1, offset: 1 });
    });
  });

  it('on-time START and end-less jobs create no incident', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('OVR2 Org', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'OVR2 Manager');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe Personel');
      const customerId = await insertCustomer(pool, organizationId);
      const { staffA } = actors(organizationId, managerId, staffAId, staffAId);
      const clock = { now: CREATE_AT };
      const service = buildService(pool, clock);

      // Before the end: on time, no incident.
      let job = await createLateDelivery(service, staffA, customerId);
      clock.now = new Date('2026-08-03T07:15:00.000Z');
      job = await service.start(staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      expect(job.status).toBe('IN_PROGRESS');
      expect(await selectIncidents(pool, organizationId, job.id)).toHaveLength(0);

      // GENERAL_TASK has no interval end: never attributable as LATE_START.
      const task = (await service.create(staffA, {
        clientActionId: randomUUID(),
        type: 'GENERAL_TASK',
        title: 'Araliksiz gorev',
        description: null,
        customerId: null,
        contactId: null,
        assignedTo: staffA.id,
        priority: 'normal',
        dueDate: null,
        scheduledAt: null,
        scheduledEndsAt: undefined,
        engagementKind: undefined,
      } as never)) as JobCard;
      await service.start(staffA, task.id, {
        clientActionId: randomUUID(), expectedVersion: task.version,
      });
      expect(await selectIncidents(pool, organizationId, task.id)).toHaveLength(0);
    });
  });

  it('SUBMIT exactly at the effective deadline stays on time', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('OVR2 Org', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'OVR2 Manager');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe Personel');
      const { staffA } = actors(organizationId, managerId, staffAId, staffAId);
      const clock = { now: new Date('2026-07-30T09:00:00.000Z') };
      const service = buildService(pool, clock);

      let job = (await service.create(staffA, {
        clientActionId: randomUUID(),
        type: 'GENERAL_TASK',
        title: 'Tam sinirda teslim',
        description: null,
        customerId: null,
        contactId: null,
        assignedTo: staffA.id,
        priority: 'normal',
        dueDate: '2026-08-01',
        scheduledAt: null,
        scheduledEndsAt: undefined,
        engagementKind: undefined,
      } as never)) as JobCard;
      job = await service.start(staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      // due 2026-08-01 Europe/Istanbul local end = 2026-08-01T21:00Z.
      clock.now = new Date('2026-08-01T21:00:00.000Z');
      job = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
        note: 'Tam zamanında.',
      });
      expect(job.status).toBe('WAITING_APPROVAL');
      expect(await selectIncidents(pool, organizationId, job.id)).toHaveLength(0);
    });
  });

  it('replay and resubmission keep one incident per episode', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('OVR2 Org', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'OVR2 Manager');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe Personel');
      const { manager, staffA } = actors(organizationId, managerId, staffAId, staffAId);
      const clock = { now: new Date('2026-07-30T09:00:00.000Z') };
      const service = buildService(pool, clock);

      let job = (await service.create(staffA, {
        clientActionId: randomUUID(),
        type: 'GENERAL_TASK',
        title: 'Tekrar gonderilen gorev',
        description: null,
        customerId: null,
        contactId: null,
        assignedTo: staffA.id,
        priority: 'normal',
        dueDate: '2026-08-01',
        scheduledAt: null,
        scheduledEndsAt: undefined,
        engagementKind: undefined,
      } as never)) as JobCard;
      job = await service.start(staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      clock.now = new Date('2026-08-04T09:00:00.000Z');
      const submitId = randomUUID();
      job = await service.submitForApproval(staffA, job.id, {
        clientActionId: submitId, expectedVersion: job.version,
        note: 'Ilk gonderim.',
      });
      // Exact replay of the same logical command: no second incident.
      const replayed = await service.submitForApproval(staffA, job.id, {
        clientActionId: submitId, expectedVersion: job.version - 1,
        note: 'Ilk gonderim.',
      });
      expect(replayed.status).toBe('WAITING_APPROVAL');
      let incidents = await selectIncidents(pool, organizationId, job.id);
      expect(incidents).toHaveLength(1);

      // Genuine second cycle: revision -> resume -> late submit again.
      job = await service.requestRevision(manager, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
        revisionReason: 'Detay ekleyin.',
      });
      job = await service.resume(staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      job = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
        note: 'Ikinci gonderim.',
      });
      incidents = await selectIncidents(pool, organizationId, job.id);
      expect(incidents).toHaveLength(2);
      const episodes = incidents.map((row) => row.episode_no).sort();
      expect(episodes).toEqual([1, 2]);
      const facts = await pool.query<{ seq_no: number }>(
        `SELECT seq_no FROM job_card_accountability_facts
          WHERE organization_id = $1 AND job_card_id = $2 AND fact_type = 'SUBMITTED'
          ORDER BY seq_no`,
        [organizationId, job.id],
      );
      expect(facts.rows.map((row) => Number(row.seq_no))).toEqual([1, 2]);
    });
  });

  it('approval under 24h stays clean; exactly 24h breaches', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('OVR2 Org', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'OVR2 Manager');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe Personel');
      const { manager, staffA } = actors(organizationId, managerId, staffAId, staffAId);

      async function submittedJob(title: string) {
        const clock = { now: new Date('2026-08-04T09:00:00.000Z') };
        const service = buildService(pool, clock);
        let job = (await service.create(staffA, {
          clientActionId: randomUUID(),
          type: 'GENERAL_TASK',
          title,
          description: null,
          customerId: null,
          contactId: null,
          assignedTo: staffA.id,
          priority: 'normal',
          dueDate: null,
          scheduledAt: null,
          scheduledEndsAt: undefined,
          engagementKind: undefined,
        } as never)) as JobCard;
        job = await service.start(staffA, job.id, {
          clientActionId: randomUUID(), expectedVersion: job.version,
        });
        job = await service.submitForApproval(staffA, job.id, {
          clientActionId: randomUUID(), expectedVersion: job.version,
          note: 'Onaya gönderildi.',
        });
        return { service, clock, job };
      }

      const early = await submittedJob('Hizli onay');
      early.clock.now = new Date('2026-08-05T08:59:59.000Z');
      const completed = await early.service.approve(manager, early.job.id, {
        clientActionId: randomUUID(), expectedVersion: early.job.version,
      });
      expect(completed.status).toBe('COMPLETED');
      expect(await selectIncidents(pool, organizationId, early.job.id)).toHaveLength(0);

      const exact = await submittedJob('Sinirda onay');
      exact.clock.now = new Date('2026-08-05T09:00:00.000Z');
      await exact.service.approve(manager, exact.job.id, {
        clientActionId: randomUUID(), expectedVersion: exact.job.version,
      });
      const incidents = await selectIncidents(pool, organizationId, exact.job.id);
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({
        delay_type: 'APPROVAL_WAIT',
        episode_no: 1,
        accountable_user_id: null,
        accountable_role: 'MANAGEMENT',
      });
      expect(incidents[0]!.deadline_at).toEqual(new Date('2026-08-05T09:00:00.000Z'));
      expect(incidents[0]!.recovered_at).toEqual(exact.clock.now);
    });
  });

  it('revision request past the threshold recovers APPROVAL_WAIT', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('OVR2 Org', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'OVR2 Manager');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe Personel');
      const { manager, staffA } = actors(organizationId, managerId, staffAId, staffAId);
      const clock = { now: new Date('2026-08-04T09:00:00.000Z') };
      const service = buildService(pool, clock);

      let job = (await service.create(staffA, {
        clientActionId: randomUUID(),
        type: 'GENERAL_TASK',
        title: 'Duzeltmeye donen onay',
        description: null,
        customerId: null,
        contactId: null,
        assignedTo: staffA.id,
        priority: 'normal',
        dueDate: null,
        scheduledAt: null,
        scheduledEndsAt: undefined,
        engagementKind: undefined,
      } as never)) as JobCard;
      job = await service.start(staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      job = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
        note: 'Onaya gönderildi.',
      });
      clock.now = new Date('2026-08-05T10:00:00.000Z');
      job = await service.requestRevision(manager, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
        revisionReason: 'Eksik bilgi var.',
      });
      expect(job.status).toBe('REVISION_REQUESTED');
      const incidents = await selectIncidents(pool, organizationId, job.id);
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({
        delay_type: 'APPROVAL_WAIT',
        recovered_at: clock.now,
        recovery_actor_user_id: managerId,
      });
    });
  });

  it('revision before breach creates nothing; later breach binds the new revision', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('OVR2 Org', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'OVR2 Manager');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe Personel');
      const customerId = await insertCustomer(pool, organizationId);
      const { manager, staffA } = actors(organizationId, managerId, staffAId, staffAId);
      void manager;
      const clock = { now: CREATE_AT };
      const service = buildService(pool, clock);

      const job = await createLateDelivery(service, staffA, customerId);
      // 06:30Z is before the 07:30Z deadline: pure revision, no breach.
      // Staff edit keeps ACCEPTED (a manager edit would void acceptance).
      clock.now = new Date('2026-08-03T06:30:00.000Z');
      const moved = await service.patch(staffA, job.id, {
        expectedVersion: job.version,
        scheduledAt: '2026-08-03T09:00:00.000Z',
      } as never);
      expect(await selectIncidents(pool, organizationId, job.id)).toHaveLength(0);

      // Move the deadline into the past: the 09:30 breach binds revision 2
      // (it governed at 10:00) while the new 07:30 deadline binds revision 3.
      // Revision 3 was only activated at 10:00, so its breach starts there —
      // never backdated to the nominal 07:30.
      // Both stay open: no lifecycle recovery happened.
      clock.now = new Date('2026-08-03T10:00:00.000Z');
      await service.patch(staffA, moved.id, {
        expectedVersion: moved.version,
        scheduledAt: '2026-08-03T07:00:00.000Z',
      } as never);
      const incidents = await selectIncidents(pool, organizationId, job.id);
      expect(incidents).toHaveLength(2);
      const byRev = new Map(incidents.map((row) => [row.schedule_revision_no, row]));
      expect(byRev.get(2)).toMatchObject({
        delay_type: 'LATE_START',
        episode_no: 1,
        schedule_revision_no: 2,
        accountable_user_id: staffAId,
      });
      expect(byRev.get(2)!.deadline_at).toEqual(new Date('2026-08-03T09:30:00.000Z'));
      expect(byRev.get(2)!.breached_at).toEqual(new Date('2026-08-03T09:30:00.000Z'));
      expect(byRev.get(2)!.recovered_at).toBeNull();
      expect(byRev.get(3)).toMatchObject({
        delay_type: 'LATE_START',
        episode_no: 1,
        schedule_revision_no: 3,
        accountable_user_id: staffAId,
      });
      expect(byRev.get(3)!.deadline_at).toEqual(new Date('2026-08-03T07:30:00.000Z'));
      expect(byRev.get(3)!.breached_at).toEqual(new Date('2026-08-03T10:00:00.000Z'));
      expect(byRev.get(3)!.recovered_at).toBeNull();
    });
  });

  it('cancel past the approval threshold recovers without deleting history', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('OVR2 Org', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'OVR2 Manager');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe Personel');
      const { manager, staffA } = actors(organizationId, managerId, staffAId, staffAId);
      const clock = { now: new Date('2026-08-04T09:00:00.000Z') };
      const service = buildService(pool, clock);

      let job = (await service.create(staffA, {
        clientActionId: randomUUID(),
        type: 'GENERAL_TASK',
        title: 'Iptal edilen bekleme',
        description: null,
        customerId: null,
        contactId: null,
        assignedTo: staffA.id,
        priority: 'normal',
        dueDate: null,
        scheduledAt: null,
        scheduledEndsAt: undefined,
        engagementKind: undefined,
      } as never)) as JobCard;
      job = await service.start(staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      job = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
        note: 'Onaya gönderildi.',
      });
      clock.now = new Date('2026-08-05T10:00:00.000Z');
      job = await service.cancel(manager, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
        cancelReason: 'Müşteri vazgeçti.',
      });
      expect(job.status).toBe('CANCELLED');
      const incidents = await selectIncidents(pool, organizationId, job.id);
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({
        delay_type: 'APPROVAL_WAIT',
        recovered_at: clock.now,
        recovery_actor_user_id: managerId,
      });
    });
  });

  it('invalidation creates no incident and preserves history', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('OVR2 Org', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const adminId = await insertUser(pool, organizationId, 'ADMIN', 'OVR2 Admin');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe Personel');
      const customerId = await insertCustomer(pool, organizationId);
      const admin: JobCardActor = { id: adminId, organizationId, role: 'ADMIN' };
      const { staffA } = actors(organizationId, adminId, staffAId, staffAId);
      const clock = { now: CREATE_AT };
      const service = buildService(pool, clock);

      let job = await createLateDelivery(service, staffA, customerId);
      clock.now = LATE_AT;
      job = await service.start(staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      const before = await selectIncidents(pool, organizationId, job.id);
      expect(before).toHaveLength(1);

      job = await service.invalidate(admin, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        reasonCode: 'DUPLICATE',
        note: null,
      } as never);
      expect(job.status).toBe('INVALIDATED');
      const after = await selectIncidents(pool, organizationId, job.id);
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({
        delay_type: 'LATE_START',
        accountable_user_id: staffAId,
        recovered_at: LATE_AT,
        recovery_actor_user_id: staffAId,
      });
    });
  });

  it('unprovable history attributes UNKNOWN without current-assignee fallback', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('OVR2 Org', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe Personel');
      const staffA: JobCardActor = { id: staffAId, organizationId, role: 'STAFF' };
      const clock = { now: LATE_AT };
      const service = buildService(pool, clock);

      // Legacy-style row: no assignment history at all.
      const jobId = (await pool.query<{ id: string }>(
        `INSERT INTO job_cards (organization_id, type, status, title, assigned_to, created_by,
                                scheduled_at, scheduled_ends_at, accepted_at, accepted_by)
         VALUES ($1, 'PRODUCT_DELIVERY', 'ACCEPTED', 'Tarihsel kayıtsız iş', $2, $2,
                 '2026-08-03T07:00:00.000Z', '2026-08-03T07:30:00.000Z',
                 '2026-08-03T06:30:00.000Z', $2)
         RETURNING id`,
        [organizationId, staffAId],
      )).rows[0]!.id;
      await pool.query(
        `INSERT INTO job_card_schedule_revisions
           (organization_id, job_card_id, revision_no, scheduled_at, scheduled_ends_at,
            organization_timezone, source)
         VALUES ($1, $2, 1, '2026-08-03T07:00:00.000Z', '2026-08-03T07:30:00.000Z',
                 'Europe/Istanbul', 'BASELINE')`,
        [organizationId, jobId],
      );
      const started = await service.start(staffA, jobId, {
        clientActionId: randomUUID(), expectedVersion: 1,
      });
      expect(started.status).toBe('IN_PROGRESS');
      const incidents = await selectIncidents(pool, organizationId, jobId);
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({
        delay_type: 'LATE_START',
        accountable_user_id: null,
        accountable_role: 'STAFF',
        accountable_source: 'UNKNOWN',
      });
    });
  });

  it('failed mutations persist no incident; duplicate identity converges', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('OVR2 Org', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'OVR2 Manager');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe Personel');
      const { staffA } = actors(organizationId, managerId, staffAId, staffAId);
      const clock = { now: new Date('2026-07-30T09:00:00.000Z') };
      const service = buildService(pool, clock);
      const repository = new PostgresJobCardRepository(pool);

      const job = (await service.create(staffA, {
        clientActionId: randomUUID(),
        type: 'GENERAL_TASK',
        title: 'Catismali gonderim',
        description: null,
        customerId: null,
        contactId: null,
        assignedTo: staffA.id,
        priority: 'normal',
        dueDate: '2026-08-01',
        scheduledAt: null,
        scheduledEndsAt: undefined,
        engagementKind: undefined,
      } as never)) as JobCard;
      const started = await service.start(staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      // Stale version: the protected mutation rolls back, nothing persists.
      await expect(service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: 1,
        note: 'Bayat deneme.',
      })).rejects.toMatchObject({ code: 'VERSION_CONFLICT', statusCode: 409 });
      expect(await selectIncidents(pool, organizationId, job.id)).toHaveLength(0);

      const identity = {
        organizationId,
        jobCardId: job.id,
        delayType: 'LATE_SUBMISSION' as const,
        episodeNo: 1,
        scheduleRevisionNo: 1,
        deadlineAt: new Date('2026-08-01T21:00:01.000Z'),
        breachedAt: new Date('2026-08-01T21:00:01.000Z'),
        accountableUserId: staffAId,
        accountableRole: 'STAFF' as const,
        accountableSource: 'ASSIGNMENT_AT_BREACH' as const,
        source: 'TRANSITION' as const,
      };
      const first = await repository.executeTransaction((tx) =>
        tx.insertOverdueIncident(identity));
      const second = await repository.executeTransaction((tx) =>
        tx.insertOverdueIncident(identity));
      expect(second.created).toBe(false);
      expect(second.id).toBe(first.id);
      expect(await selectIncidents(pool, organizationId, job.id)).toHaveLength(1);
      void started;
    });
  });

  it('schema guards hold: empty start, cross references, pairs', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('OVR2 Org', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const otherOrgId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('OVR2 Other', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe Personel');
      const { staffA } = actors(organizationId, organizationId, staffAId, staffAId);
      const clock = { now: CREATE_AT };
      const service = buildService(pool, clock);
      const job = await createLateDelivery(service, staffA, await insertCustomer(pool, organizationId));
      const otherJob = (await pool.query<{ id: string }>(
        `INSERT INTO job_cards (organization_id, type, status, title, assigned_to, created_by)
         VALUES ($1, 'GENERAL_TASK', 'NEW', 'Diger is', $2, $2) RETURNING id`,
        [otherOrgId, await insertUser(pool, otherOrgId, 'STAFF', 'Yabanci')],
      )).rows[0]!.id;

      const empty = await pool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM job_card_overdue_incidents',
      );
      expect(empty.rows[0]!.count).toBe('0');

      const valid = {
        organization_id: organizationId,
        job_card_id: job.id,
        delay_type: 'LATE_START',
        episode_no: 1,
        schedule_revision_no: 1,
        deadline_at: '2026-08-03T07:30:00.000Z',
        breached_at: '2026-08-03T07:30:00.000Z',
        accountable_user_id: staffAId,
        accountable_role: 'STAFF',
        accountable_source: 'ASSIGNMENT_AT_BREACH',
        source: 'TRANSITION',
      };
      const cols = Object.keys(valid).join(', ');
      const params = Object.keys(valid).map((_, index) => `$${index + 1}`).join(', ');
      const insert = (row: Record<string, unknown>) =>
        pool.query(
          `INSERT INTO job_card_overdue_incidents (${cols}) VALUES (${params})`,
          Object.values({ ...valid, ...row }),
        );
      // Cross-org job reference is rejected.
      await expect(insert({ organization_id: otherOrgId })).rejects.toMatchObject({ code: '23503' });
      // Cross-job schedule revision is rejected.
      await insert({
        job_card_id: otherJob,
        organization_id: otherOrgId,
        schedule_revision_no: 1,
      }).then(
        () => { throw new Error('expected cross-job revision to fail'); },
        (error: { code?: string }) => {
          // otherJob has no revision rows at all: FK violation either way.
          expect(['23503', '23514']).toContain(error.code);
        },
      );
      // Semantic duplicates are rejected at the DB level.
      await insert({});
      await expect(insert({})).rejects.toMatchObject({ code: '23505' });
      // Half-populated recovery pair is rejected.
      await expect(
        pool.query(
          `UPDATE job_card_overdue_incidents SET recovered_at = NOW()
            WHERE organization_id = $1 AND job_card_id = $2`,
          [organizationId, job.id],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      // Breach instant must not precede the nominal deadline.
      await expect(insert({
        episode_no: 2,
        breached_at: '2026-08-03T07:29:00.000Z',
      })).rejects.toMatchObject({ code: '23514' });
      // Episode numbers start at 1.
      await expect(insert({ episode_no: 0 })).rejects.toMatchObject({ code: '23514' });
      // OVR-2 has no scanner producer/source contract.
      await expect(insert({
        episode_no: 3,
        source: 'SCANNER',
      })).rejects.toMatchObject({ code: '23514' });
      // Submission episode activations are one row per next episode.
      await pool.query(
        `INSERT INTO job_card_submission_episode_activations
           (organization_id, job_card_id, episode_no, activated_at, activated_by_command)
         VALUES ($1, $2, 2, $3, 'WITHDRAW_FROM_APPROVAL')`,
        [organizationId, job.id, new Date('2026-08-03T08:00:00.000Z')],
      );
      await expect(pool.query(
        `INSERT INTO job_card_submission_episode_activations
           (organization_id, job_card_id, episode_no, activated_at, activated_by_command)
         VALUES ($1, $2, 2, $3, 'REQUEST_REVISION')`,
        [organizationId, job.id, new Date('2026-08-03T09:00:00.000Z')],
      )).rejects.toMatchObject({ code: '23505' });
    });
  });
});

describe.skipIf(!databaseUrl)('OVR-2 contract reconciliation (candidate RED)', () => {
  async function setupOrg(pool: Pool) {
    const organizationId = (await pool.query<{ id: string }>(
      `INSERT INTO organizations (name, timezone) VALUES ('OVR2 Reconcile', 'Europe/Istanbul') RETURNING id`,
    )).rows[0]!.id;
    const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Reconcile Manager');
    const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Reconcile Ayşe');
    const staffBId = await insertUser(pool, organizationId, 'STAFF', 'Reconcile Mehmet');
    const customerId = await insertCustomer(pool, organizationId);
    return { organizationId, ...actors(organizationId, managerId, staffAId, staffBId), staffAId, staffBId, managerId, customerId };
  }

  /** Manager creates for staff: no self-accept, the job stays NEW. */
  async function createNewLateDelivery(
    service: JobCardService,
    manager: JobCardActor,
    staffId: string,
    customerId: string,
  ): Promise<JobCard> {
    return (await service.create(manager, {
      clientActionId: randomUUID(),
      type: 'PRODUCT_DELIVERY',
      title: 'Kabul edilmemiş teslim',
      description: null,
      customerId,
      contactId: null,
      assignedTo: staffId,
      priority: 'normal',
      dueDate: null,
      scheduledAt: DELIVERY_START,
      scheduledEndsAt: undefined,
      engagementKind: undefined,
    } as never)) as JobCard;
  }

  it('NEW past deadline + reassign creates no incident', async () => {
    await withSchema(async (pool) => {
      const ctx = await setupOrg(pool);
      const clock = { now: CREATE_AT };
      const service = buildService(pool, clock);
      let job = await createNewLateDelivery(service, ctx.manager, ctx.staffAId, ctx.customerId);
      expect(job.status).toBe('NEW');
      clock.now = LATE_AT;
      job = await service.patch(ctx.manager, job.id, {
        expectedVersion: job.version,
        assignedTo: ctx.staffBId,
      } as never);
      expect(await selectIncidents(pool, ctx.organizationId, job.id)).toHaveLength(0);
    });
  });

  it('NEW past deadline + cancel creates no incident', async () => {
    await withSchema(async (pool) => {
      const ctx = await setupOrg(pool);
      const clock = { now: CREATE_AT };
      const service = buildService(pool, clock);
      const job = await createNewLateDelivery(service, ctx.manager, ctx.staffAId, ctx.customerId);
      clock.now = LATE_AT;
      const cancelled = await service.cancel(ctx.manager, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
        cancelReason: 'Müşteri vazgeçti.',
      });
      expect(cancelled.status).toBe('CANCELLED');
      expect(await selectIncidents(pool, ctx.organizationId, job.id)).toHaveLength(0);
    });
  });

  it('NEW past deadline + schedule patch creates no incident', async () => {
    await withSchema(async (pool) => {
      const ctx = await setupOrg(pool);
      const clock = { now: CREATE_AT };
      const service = buildService(pool, clock);
      let job = await createNewLateDelivery(service, ctx.manager, ctx.staffAId, ctx.customerId);
      clock.now = LATE_AT;
      job = await service.patch(ctx.manager, job.id, {
        expectedVersion: job.version,
        scheduledAt: '2026-08-03T07:15:00.000Z',
      } as never);
      expect(await selectIncidents(pool, ctx.organizationId, job.id)).toHaveLength(0);
    });
  });

  it('late ACCEPT_ASSIGNMENT materializes an OPEN incident at acceptance', async () => {
    await withSchema(async (pool) => {
      const ctx = await setupOrg(pool);
      const clock = { now: CREATE_AT };
      const service = buildService(pool, clock);
      const job = await createNewLateDelivery(service, ctx.manager, ctx.staffAId, ctx.customerId);
      const acceptedAt = new Date('2026-08-03T08:00:00.000Z');
      clock.now = acceptedAt;
      const accepted = await service.acceptAssignment(ctx.staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      expect(accepted.status).toBe('ACCEPTED');
      const incidents = await selectIncidents(pool, ctx.organizationId, job.id);
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({
        delay_type: 'LATE_START',
        episode_no: 1,
        schedule_revision_no: 1,
        accountable_user_id: ctx.staffAId,
        accountable_role: 'STAFF',
      });
      expect(incidents[0]!.deadline_at).toEqual(new Date('2026-08-03T07:30:00.000Z'));
      // No backdating before the commitment existed: breach starts at acceptance.
      expect(incidents[0]!.breached_at).toEqual(acceptedAt);
      expect(incidents[0]!.recovered_at).toBeNull();
    });
  });

  it('IN_PROGRESS late + CANCEL recovers the pending LATE_SUBMISSION', async () => {
    await withSchema(async (pool) => {
      const ctx = await setupOrg(pool);
      const clock = { now: CREATE_AT };
      const service = buildService(pool, clock);
      let job = await createLateDelivery(service, ctx.staffA, ctx.customerId);
      clock.now = new Date('2026-08-03T07:10:00.000Z');
      job = await service.start(ctx.staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      const cancelledAt = new Date('2026-08-03T09:00:00.000Z');
      clock.now = cancelledAt;
      job = await service.cancel(ctx.manager, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
        cancelReason: 'Müşteri vazgeçti.',
      });
      expect(job.status).toBe('CANCELLED');
      const incidents = await selectIncidents(pool, ctx.organizationId, job.id);
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({
        delay_type: 'LATE_SUBMISSION',
        episode_no: 1,
        schedule_revision_no: 1,
        accountable_user_id: ctx.staffAId,
      });
      expect(incidents[0]!.deadline_at).toEqual(new Date('2026-08-03T07:30:00.001Z'));
      expect(incidents[0]!.breached_at).toEqual(new Date('2026-08-03T07:30:00.001Z'));
      expect(incidents[0]!.recovered_at).toEqual(cancelledAt);
      expect(incidents[0]!.recovery_actor_user_id).toBe(ctx.managerId);
    });
  });

  it('REVISION_REQUESTED late + CANCEL preserves the submission episode', async () => {
    await withSchema(async (pool) => {
      const ctx = await setupOrg(pool);
      const clock = { now: new Date('2026-07-30T09:00:00.000Z') };
      const service = buildService(pool, clock);
      let job = (await service.create(ctx.staffA, {
        clientActionId: randomUUID(),
        type: 'GENERAL_TASK',
        title: 'Düzeltmede iptal',
        description: null,
        customerId: null,
        contactId: null,
        assignedTo: ctx.staffA.id,
        priority: 'normal',
        dueDate: '2026-08-01',
        scheduledAt: null,
        scheduledEndsAt: undefined,
        engagementKind: undefined,
      } as never)) as JobCard;
      job = await service.start(ctx.staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      clock.now = new Date('2026-08-04T09:00:00.000Z');
      job = await service.submitForApproval(ctx.staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
        note: 'Geç de olsa tamamlandı.',
      });
      // Simulate a pre-OVR-2 submit: the breach is provable from immutable
      // facts, but no incident row was persisted for it.
      await pool.query(
        `DELETE FROM job_card_overdue_incidents
          WHERE organization_id = $1 AND job_card_id = $2`,
        [ctx.organizationId, job.id],
      );
      clock.now = new Date('2026-08-04T10:00:00.000Z');
      job = await service.requestRevision(ctx.manager, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
        revisionReason: 'Eksik bilgi var.',
      });
      expect(job.status).toBe('REVISION_REQUESTED');
      clock.now = new Date('2026-08-04T11:00:00.000Z');
      job = await service.cancel(ctx.manager, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
        cancelReason: 'Müşteri vazgeçti.',
      });
      expect(job.status).toBe('CANCELLED');
      const incidents = await selectIncidents(pool, ctx.organizationId, job.id);
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({
        delay_type: 'LATE_SUBMISSION',
        episode_no: 2,
        schedule_revision_no: 1,
        accountable_user_id: ctx.staffAId,
      });
      // The next obligation starts exactly when REQUEST_REVISION armed it;
      // it must never be backdated to the previous SUBMITTED fact/deadline.
      expect(incidents[0]!.breached_at).toEqual(new Date('2026-08-04T10:00:00.000Z'));
      expect(incidents[0]!.recovered_at).toEqual(clock.now);
      expect(incidents[0]!.recovery_actor_user_id).toBe(ctx.managerId);
    });
  });

  it('WITHDRAW before 24h creates nothing; at/after 24h recovers APPROVAL_WAIT', async () => {
    await withSchema(async (pool) => {
      const ctx = await setupOrg(pool);
      async function submittedAt(at: Date) {
        const clock = { now: at };
        const service = buildService(pool, clock);
        let job = (await service.create(ctx.staffA, {
          clientActionId: randomUUID(),
          type: 'GENERAL_TASK',
          title: 'Geri çekilen onay',
          description: null,
          customerId: null,
          contactId: null,
          assignedTo: ctx.staffA.id,
          priority: 'normal',
          dueDate: null,
          scheduledAt: null,
          scheduledEndsAt: undefined,
          engagementKind: undefined,
        } as never)) as JobCard;
        job = await service.start(ctx.staffA, job.id, {
          clientActionId: randomUUID(), expectedVersion: job.version,
        });
        job = await service.submitForApproval(ctx.staffA, job.id, {
          clientActionId: randomUUID(), expectedVersion: job.version,
          note: 'Onaya gönderildi.',
        });
        return { clock, service, job };
      }
      const submittedAtInstant = new Date('2026-08-04T09:00:00.000Z');

      const early = await submittedAt(submittedAtInstant);
      early.clock.now = new Date('2026-08-05T08:59:59.000Z');
      const withdrawnEarly = await early.service.withdrawFromApproval(ctx.staffA, early.job.id, {
        clientActionId: randomUUID(), expectedVersion: early.job.version,
      });
      expect(withdrawnEarly.status).toBe('IN_PROGRESS');
      expect(await selectIncidents(pool, ctx.organizationId, early.job.id)).toHaveLength(0);

      const exact = await submittedAt(submittedAtInstant);
      exact.clock.now = new Date('2026-08-05T09:00:00.000Z');
      const withdrawnExact = await exact.service.withdrawFromApproval(ctx.staffA, exact.job.id, {
        clientActionId: randomUUID(), expectedVersion: exact.job.version,
      });
      expect(withdrawnExact.status).toBe('IN_PROGRESS');
      const exactIncidents = await selectIncidents(pool, ctx.organizationId, exact.job.id);
      expect(exactIncidents).toHaveLength(1);
      expect(exactIncidents[0]).toMatchObject({
        delay_type: 'APPROVAL_WAIT',
        episode_no: 1,
        accountable_user_id: null,
        accountable_role: 'MANAGEMENT',
        accountable_source: 'ROLE_POLICY',
        recovered_at: exact.clock.now,
        // The recovering actor may be STAFF; accountability stays MANAGEMENT.
        recovery_actor_user_id: ctx.staffAId,
      });

      const late = await submittedAt(submittedAtInstant);
      late.clock.now = new Date('2026-08-05T10:00:00.000Z');
      await late.service.withdrawFromApproval(ctx.staffA, late.job.id, {
        clientActionId: randomUUID(), expectedVersion: late.job.version,
      });
      const lateIncidents = await selectIncidents(pool, ctx.organizationId, late.job.id);
      expect(lateIncidents).toHaveLength(1);
      expect(lateIncidents[0]).toMatchObject({
        delay_type: 'APPROVAL_WAIT',
        recovered_at: late.clock.now,
      });

      // Replay converges on the same identity.
      await late.service.withdrawFromApproval(ctx.staffA, late.job.id, {
        clientActionId: randomUUID(), expectedVersion: late.job.version,
      }).catch(() => undefined);
    });
  });

  it('retroactive revision never backdates before revision activation', async () => {
    await withSchema(async (pool) => {
      const ctx = await setupOrg(pool);
      const clock = { now: CREATE_AT };
      const service = buildService(pool, clock);
      let job = await createLateDelivery(service, ctx.staffA, ctx.customerId);
      // Staff edit keeps ACCEPTED (manager edit would void acceptance).
      clock.now = new Date('2026-08-03T06:30:00.000Z');
      job = await service.patch(ctx.staffA, job.id, {
        expectedVersion: job.version,
        scheduledAt: '2026-08-03T09:00:00.000Z',
      } as never);
      expect(await selectIncidents(pool, ctx.organizationId, job.id)).toHaveLength(0);

      clock.now = new Date('2026-08-03T10:00:00.000Z');
      job = await service.patch(ctx.staffA, job.id, {
        expectedVersion: job.version,
        scheduledAt: '2026-08-03T07:00:00.000Z',
      } as never);
      const incidents = await selectIncidents(pool, ctx.organizationId, job.id);
      expect(incidents).toHaveLength(2);
      const byRev = new Map(incidents.map((row) => [row.schedule_revision_no, row]));
      expect(byRev.get(2)!.deadline_at).toEqual(new Date('2026-08-03T09:30:00.000Z'));
      expect(byRev.get(2)!.breached_at).toEqual(new Date('2026-08-03T09:30:00.000Z'));
      // Nominal 07:30 predates the revision that introduced it: the breach
      // starts at revision activation (10:00), never at 07:30.
      expect(byRev.get(3)!.deadline_at).toEqual(new Date('2026-08-03T07:30:00.000Z'));
      expect(byRev.get(3)!.breached_at).toEqual(new Date('2026-08-03T10:00:00.000Z'));
      for (const row of incidents) expect(row.recovered_at).toBeNull();
    });
  });

  it('second submission episode breaches no earlier than its activation', async () => {
    await withSchema(async (pool) => {
      const ctx = await setupOrg(pool);
      const clock = { now: CREATE_AT };
      const service = buildService(pool, clock);
      // GENERAL_TASK needs no delivery items; scheduledAt is the phase
      // deadline for non-meeting types (E = 07:30Z).
      let job = (await service.create(ctx.staffA, {
        clientActionId: randomUUID(),
        type: 'GENERAL_TASK',
        title: 'Ikinci episode gorevi',
        description: null,
        customerId: null,
        contactId: null,
        assignedTo: ctx.staffA.id,
        priority: 'normal',
        dueDate: null,
        scheduledAt: '2026-08-03T07:30:00.000Z',
        scheduledEndsAt: undefined,
        engagementKind: undefined,
      } as never)) as JobCard;
      clock.now = new Date('2026-08-03T07:30:00.000Z');
      job = await service.start(ctx.staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      // First submit exactly at the deadline: on time, no incident.
      job = await service.submitForApproval(ctx.staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
        note: 'Ilk gonderim.',
      });
      // Revision requested after the nominal deadline re-arms the episode.
      const revisionRequestedAt = new Date('2026-08-03T08:00:00.000Z');
      clock.now = revisionRequestedAt;
      job = await service.requestRevision(ctx.manager, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
        revisionReason: 'Detay ekleyin.',
      });
      clock.now = new Date('2026-08-03T08:05:00.000Z');
      job = await service.resume(ctx.staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      clock.now = new Date('2026-08-03T08:10:00.000Z');
      job = await service.submitForApproval(ctx.staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
        note: 'Ikinci gonderim.',
      });
      const incidents = await selectIncidents(pool, ctx.organizationId, job.id);
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({
        delay_type: 'LATE_SUBMISSION',
        episode_no: 2,
        schedule_revision_no: 1,
        accountable_user_id: ctx.staffAId,
      });
      // Nominal first-late (07:30:00.001) predates the episode: breach starts
      // at the provable episode activation, not at the nominal instant.
      expect(incidents[0]!.deadline_at).toEqual(new Date('2026-08-03T07:30:00.001Z'));
      expect(incidents[0]!.breached_at).toEqual(revisionRequestedAt);
      expect(incidents[0]!.recovered_at).toEqual(clock.now);
    });
  });

  it('database still rejects breached_at before deadline_at', async () => {
    await withSchema(async (pool) => {
      const ctx = await setupOrg(pool);
      const clock = { now: CREATE_AT };
      const service = buildService(pool, clock);
      const job = await createLateDelivery(service, ctx.staffA, ctx.customerId);
      await expect(pool.query(
        `INSERT INTO job_card_overdue_incidents
           (organization_id, job_card_id, delay_type, episode_no, schedule_revision_no,
            deadline_at, breached_at, accountable_role, accountable_source, source)
         VALUES ($1, $2, 'LATE_START', 1, 1,
           '2026-08-03T07:30:00.000Z', '2026-08-03T07:29:00.000Z', 'STAFF', 'UNKNOWN', 'TRANSITION')`,
        [ctx.organizationId, job.id],
      )).rejects.toMatchObject({ code: '23514' });
    });
  });
});

describe.skipIf(!databaseUrl)('OVR-2 exact episode activation (candidate RED)', () => {
  async function setupOrg(pool: Pool) {
    const organizationId = (await pool.query<{ id: string }>(
      `INSERT INTO organizations (name, timezone) VALUES ('OVR2 Exact', 'Europe/Istanbul') RETURNING id`,
    )).rows[0]!.id;
    const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Exact Manager');
    const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Exact Ayşe');
    const staffBId = await insertUser(pool, organizationId, 'STAFF', 'Exact Mehmet');
    const customerId = await insertCustomer(pool, organizationId);
    return { organizationId, ...actors(organizationId, managerId, staffAId, staffBId), staffAId, staffBId, managerId, customerId };
  }

  /** GENERAL_TASK with due fallback: E = 2026-08-01T21:00Z, no delivery items. */
  async function createDueTask(service: JobCardService, staff: JobCardActor): Promise<JobCard> {
    return (await service.create(staff, {
      clientActionId: randomUUID(),
      type: 'GENERAL_TASK',
      title: 'Teslim gorevi',
      description: null,
      customerId: null,
      contactId: null,
      assignedTo: staff.id,
      priority: 'normal',
      dueDate: '2026-08-01',
      scheduledAt: null,
      scheduledEndsAt: undefined,
      engagementKind: undefined,
    } as never)) as JobCard;
  }

  async function selectActivations(pool: Pool, organizationId: string, jobId: string) {
    return (await pool.query(
      `SELECT episode_no, activated_at, activated_by_command
         FROM job_card_submission_episode_activations
        WHERE organization_id = $1 AND job_card_id = $2
        ORDER BY episode_no`,
      [organizationId, jobId],
    )).rows as Record<string, unknown>[];
  }

  async function submittedSeqs(pool: Pool, organizationId: string, jobId: string) {
    return (await pool.query<{ seq_no: number }>(
      `SELECT seq_no FROM job_card_accountability_facts
        WHERE organization_id = $1 AND job_card_id = $2 AND fact_type = 'SUBMITTED'
        ORDER BY seq_no`,
      [organizationId, jobId],
    )).rows.map((row) => Number(row.seq_no));
  }

  it('A. withdraw after deadline opens the new episode at withdraw time', async () => {
    await withSchema(async (pool) => {
      const ctx = await setupOrg(pool);
      const clock = { now: new Date('2026-07-30T09:00:00.000Z') };
      const service = buildService(pool, clock);
      let job = await createDueTask(service, ctx.staffA);
      job = await service.start(ctx.staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      // On-time first submit: episode 1 leaves no incident.
      clock.now = new Date('2026-08-01T09:00:00.000Z');
      job = await service.submitForApproval(ctx.staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
        note: 'Ilk gonderim.',
      });
      // Withdraw at 12:00 next day, past the 21:00Z deadline: the new
      // obligation starts HERE, not at the nominal deadline.
      const withdrawnAt = new Date('2026-08-02T12:00:00.000Z');
      clock.now = withdrawnAt;
      job = await service.withdrawFromApproval(ctx.staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      expect(job.status).toBe('IN_PROGRESS');

      const activations = await selectActivations(pool, ctx.organizationId, job.id);
      expect(activations).toHaveLength(1);
      expect(activations[0]).toMatchObject({
        episode_no: 2,
        activated_by_command: 'WITHDRAW_FROM_APPROVAL',
      });
      expect(activations[0]!.activated_at).toEqual(withdrawnAt);

      const incidents = await selectIncidents(pool, ctx.organizationId, job.id);
      // Two legitimate effects in one transaction (§15): the 27h approval
      // wait is recovered (MANAGEMENT), the new staff episode opens.
      expect(incidents).toHaveLength(2);
      const byType = new Map(incidents.map((row) => [row.delay_type, row]));
      expect(byType.get('APPROVAL_WAIT')).toMatchObject({
        episode_no: 1,
        accountable_role: 'MANAGEMENT',
        recovered_at: withdrawnAt,
      });
      const late = byType.get('LATE_SUBMISSION')!;
      expect(late).toMatchObject({
        episode_no: 2,
        schedule_revision_no: 1,
        accountable_user_id: ctx.staffAId,
        accountable_role: 'STAFF',
      });
      expect(late.deadline_at).toEqual(new Date('2026-08-01T21:00:00.001Z'));
      expect(late.breached_at).toEqual(withdrawnAt);
      expect(late.recovered_at).toBeNull();

      // The later submit recovers the same incident; seq aligns with episode.
      clock.now = new Date('2026-08-02T13:00:00.000Z');
      job = await service.submitForApproval(ctx.staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
        note: 'Ikinci gonderim.',
      });
      expect(await submittedSeqs(pool, ctx.organizationId, job.id)).toEqual([1, 2]);
      const after = await selectIncidents(pool, ctx.organizationId, job.id);
      expect(after).toHaveLength(2);
      const afterByType = new Map(after.map((row) => [row.delay_type, row]));
      expect(afterByType.get('APPROVAL_WAIT')).toMatchObject({
        recovered_at: withdrawnAt,
      });
      expect(afterByType.get('LATE_SUBMISSION')).toMatchObject({
        episode_no: 2,
        recovered_at: clock.now,
        recovery_actor_user_id: ctx.staffAId,
      });
    });
  });

  it('B. withdraw before deadline persists activation; later cancel proves breach', async () => {
    await withSchema(async (pool) => {
      const ctx = await setupOrg(pool);
      const clock = { now: new Date('2026-07-30T09:00:00.000Z') };
      const service = buildService(pool, clock);
      let job = await createDueTask(service, ctx.staffA);
      job = await service.start(ctx.staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      clock.now = new Date('2026-08-01T09:00:00.000Z');
      job = await service.submitForApproval(ctx.staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
        note: 'Ilk gonderim.',
      });
      // Withdraw before the deadline: activation persisted, no incident yet.
      const withdrawnAt = new Date('2026-08-01T12:00:00.000Z');
      clock.now = withdrawnAt;
      job = await service.withdrawFromApproval(ctx.staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      const activations = await selectActivations(pool, ctx.organizationId, job.id);
      expect(activations).toHaveLength(1);
      expect(activations[0]!.activated_at).toEqual(withdrawnAt);
      expect(await selectIncidents(pool, ctx.organizationId, job.id)).toHaveLength(0);

      // Later cancel proves the episode was already active at the deadline:
      // breach at the first-late instant, from durable evidence.
      clock.now = new Date('2026-08-02T11:00:00.000Z');
      job = await service.cancel(ctx.manager, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
        cancelReason: 'Müşteri vazgeçti.',
      });
      expect(job.status).toBe('CANCELLED');
      const incidents = await selectIncidents(pool, ctx.organizationId, job.id);
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({
        delay_type: 'LATE_SUBMISSION',
        episode_no: 2,
        recovered_at: clock.now,
      });
      expect(incidents[0]!.deadline_at).toEqual(new Date('2026-08-01T21:00:00.001Z'));
      expect(incidents[0]!.breached_at).toEqual(new Date('2026-08-01T21:00:00.001Z'));
    });
  });

  it('C. repeated withdraw cycles keep independent episode identities', async () => {
    await withSchema(async (pool) => {
      const ctx = await setupOrg(pool);
      const clock = { now: new Date('2026-07-30T09:00:00.000Z') };
      const service = buildService(pool, clock);
      let job = await createDueTask(service, ctx.staffA);
      job = await service.start(ctx.staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      clock.now = new Date('2026-08-01T09:00:00.000Z');
      job = await service.submitForApproval(ctx.staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
        note: 'Ilk gonderim.',
      });
      const withdraw1At = new Date('2026-08-01T12:00:00.000Z');
      clock.now = withdraw1At;
      const withdrawId = randomUUID();
      const withdraw1Version = job.version;
      job = await service.withdrawFromApproval(ctx.staffA, job.id, {
        clientActionId: withdrawId, expectedVersion: withdraw1Version,
      });
      clock.now = new Date('2026-08-01T13:00:00.000Z');
      job = await service.submitForApproval(ctx.staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
        note: 'Ikinci gonderim.',
      });
      const withdraw2At = new Date('2026-08-02T09:00:00.000Z');
      clock.now = withdraw2At;
      job = await service.withdrawFromApproval(ctx.staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      });
      clock.now = new Date('2026-08-02T10:00:00.000Z');
      job = await service.submitForApproval(ctx.staffA, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
        note: 'Ucuncu gonderim.',
      });

      expect(await submittedSeqs(pool, ctx.organizationId, job.id)).toEqual([1, 2, 3]);
      const activations = await selectActivations(pool, ctx.organizationId, job.id);
      expect(activations.map((row) => row.episode_no)).toEqual([2, 3]);
      expect(activations[0]!.activated_at).toEqual(withdraw1At);
      expect(activations[1]!.activated_at).toEqual(withdraw2At);
      const incidents = await selectIncidents(pool, ctx.organizationId, job.id);
      // Episode 2 lived fully before the deadline; only episode 3 breached.
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({
        delay_type: 'LATE_SUBMISSION',
        episode_no: 3,
        recovered_at: clock.now,
      });
      expect(incidents[0]!.breached_at).toEqual(withdraw2At);

      // Replay of the first withdraw converges: still one activation row.
      await service.withdrawFromApproval(ctx.staffA, job.id, {
        clientActionId: withdrawId, expectedVersion: withdraw1Version,
      });
      expect(await selectActivations(pool, ctx.organizationId, job.id)).toHaveLength(2);
    });
  });
});
