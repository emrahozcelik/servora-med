import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { loadMigrationCatalog } from '../src/db/migration-catalog.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import type { RestoreManifestV1 } from '../src/modules/backup/restore/manifest.js';
import { validateRestoredDatabase } from '../src/modules/backup/restore/postgres.js';
import { DemoDatasetService } from '../src/modules/demo-data/service.js';
import { PostgresDemoDatasetRepository } from '../src/modules/demo-data/repository.js';
import type { SafeUser } from '../src/modules/auth/types.js';
import {
  PostgresJobCardRepository,
} from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type {
  JobCard,
  JobCardActor,
} from '../src/modules/job-cards/types.js';
import { PostgresPeopleRepository } from '../src/modules/people/repository.js';
import {
  PostgresStaffOffboardingService,
} from '../src/modules/people/offboarding.js';
import type { RealtimeEventPublisher } from '../src/modules/realtime/event-bus.js';
import type { RealtimeEventRecord } from '../src/modules/realtime/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

const CLOCK = new Date('2026-08-01T10:00:00.000Z');
const PROPOSAL_AT = '2026-08-08T10:00:00.000Z';

type FactRow = {
  id: string;
  organization_id: string;
  job_card_id: string;
  fact_type: string;
  seq_no: number;
  occurred_at: Date;
  recorded_at: Date;
  schedule_revision_no: number;
  responsible_user_id: string;
  actor_user_id: string;
  source_activity_id: string;
};

async function withSchema(
  run: (pool: Pool) => Promise<void>,
): Promise<void> {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `f2facts_${randomUUID().replaceAll('-', '')}`;
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

function buildJobService(pool: Pool): { service: JobCardService; published: RealtimeEventRecord[] } {
  const published: RealtimeEventRecord[] = [];
  const publisher: RealtimeEventPublisher = { publish: (event) => published.push(event) };
  const service = new JobCardService(
    new PostgresJobCardRepository(pool),
    () => CLOCK,
    publisher,
    undefined,
    undefined,
    { enabled: true, reminderLeadMinutes: 30 },
  );
  return { service, published };
}

function actors(organizationId: string, managerId: string, staffAId: string, staffBId: string) {
  const manager: JobCardActor = { id: managerId, organizationId, role: 'MANAGER' };
  const staffA: JobCardActor = { id: staffAId, organizationId, role: 'STAFF' };
  const staffB: JobCardActor = { id: staffBId, organizationId, role: 'STAFF' };
  return { manager, staffA, staffB };
}

async function selectFacts(pool: Pool, organizationId: string, jobId: string): Promise<FactRow[]> {
  return (await pool.query<FactRow>(
    `SELECT id, organization_id, job_card_id, fact_type, seq_no, occurred_at, recorded_at,
            schedule_revision_no, responsible_user_id, actor_user_id, source_activity_id
       FROM job_card_accountability_facts
      WHERE organization_id = $1 AND job_card_id = $2
      ORDER BY fact_type, seq_no`,
    [organizationId, jobId],
  )).rows;
}

async function activityEventForFact(pool: Pool, fact: FactRow): Promise<string> {
  return (await pool.query<{ event_type: string }>(
    `SELECT event_type FROM job_card_activity_logs WHERE id = $1`,
    [fact.source_activity_id],
  )).rows[0]!.event_type;
}

async function createGeneralTask(
  service: JobCardService,
  staff: JobCardActor,
  title: string,
): Promise<JobCard> {
  return await service.create(staff, {
    clientActionId: randomUUID(),
    type: 'GENERAL_TASK',
    title,
    description: null,
    customerId: null,
    contactId: null,
    assignedTo: staff.id,
    priority: 'normal',
    dueDate: null,
    scheduledAt: null,
    scheduledEndsAt: undefined,
    engagementKind: undefined,
  } as never);
}

describe.skipIf(!databaseUrl)('FOUNDATION-2 accountability facts on real PostgreSQL', () => {
  it('migration 044 creates an empty fact table on top of 043 data', async () => {
    const adminPool = new Pool({ connectionString: databaseUrl });
    const schema = `f2mig_${randomUUID().replaceAll('-', '')}`;
    let pool: Pool | null = null;
    const dir = await mkdtemp(path.join(tmpdir(), 'f2-migrations-'));
    try {
      await adminPool.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${schema},public`,
      });
      const entries = await readdir(MIGRATIONS_DIRECTORY);
      for (const entry of entries) {
        if (!/^\d{3}_[A-Za-z0-9_]+\.sql$/.test(entry)) continue;
        if (Number(entry.slice(0, 3)) > 43) continue;
        await symlink(path.join(MIGRATIONS_DIRECTORY, entry), path.join(dir, entry));
      }
      await runMigrations({ migrationsDirectory: dir, store: new PostgresMigrationStore(pool) });

      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('F2 legacy', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Legacy Manager');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Legacy Staff');
      await pool.query(
        `INSERT INTO job_cards (organization_id, type, status, title, assigned_to, created_by, priority,
                                scheduled_at, scheduled_ends_at, engagement_kind)
         VALUES ($1, 'SALES_MEETING', 'NEW', $2, $3, $4, 'normal',
                 '2026-08-01T10:00:00.000Z', '2026-08-01T11:00:00.000Z', 'CUSTOMER_VISIT')`,
        [organizationId, 'Legacy visit', staffId, managerId],
      );
      const before = await pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM job_cards');
      expect(before.rows[0]!.count).toBe('1');

      const applied = await runMigrations({
        migrationsDirectory: MIGRATIONS_DIRECTORY,
        store: new PostgresMigrationStore(pool),
      });
      expect(applied.appliedVersions).toEqual(['044_job_card_accountability_facts', '045_calendar_request_hash']);

      const catalog = await loadMigrationCatalog(MIGRATIONS_DIRECTORY);
      expect(catalog.count).toBe(45);
      expect(catalog.head?.version).toBe('045_calendar_request_hash');

      const after = await pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM job_cards');
      expect(after.rows[0]!.count).toBe('1');
      const facts = await pool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM job_card_accountability_facts',
      );
      expect(facts.rows[0]!.count).toBe('0');
      const support = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM pg_constraint
          WHERE conname = 'job_card_activity_logs_org_job_id_key'
            AND connamespace = current_schema()::regnamespace`,
      );
      expect(support.rows[0]!.count).toBe('1');
    } finally {
      await pool?.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('STARTED fact freezes responsible user, actor, revision, and activity', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('F2 started', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Manager');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Staff A');
      const staffBId = await insertUser(pool, organizationId, 'STAFF', 'Staff B');
      const { staffA } = actors(organizationId, managerId, staffAId, staffBId);
      const { service } = buildJobService(pool);

      const job = await createGeneralTask(service, staffA, 'Depo sayımı');
      expect(job.status).toBe('ACCEPTED');
      const started = await service.start(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
      });
      expect(started.status).toBe('IN_PROGRESS');

      const facts = await selectFacts(pool, organizationId, job.id);
      expect(facts).toHaveLength(1);
      const fact = facts[0]!;
      expect(fact.fact_type).toBe('STARTED');
      expect(fact.seq_no).toBe(1);
      expect(fact.responsible_user_id).toBe(staffAId);
      expect(fact.actor_user_id).toBe(staffAId);
      expect(fact.schedule_revision_no).toBe(1);
      expect(new Date(fact.occurred_at).toISOString()).toBe(CLOCK.toISOString());
      expect(await activityEventForFact(pool, fact)).toBe('JOB_STARTED');
      const activityOrg = await pool.query<{ organization_id: string; job_card_id: string }>(
        `SELECT organization_id, job_card_id FROM job_card_activity_logs WHERE id = $1`,
        [fact.source_activity_id],
      );
      expect(activityOrg.rows[0]).toMatchObject({ organization_id: organizationId, job_card_id: job.id });
    });
  });

  it('STARTED fact captures the governing revision after a pre-start reschedule', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('F2 revision', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Manager');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Staff A');
      const staffBId = await insertUser(pool, organizationId, 'STAFF', 'Staff B');
      const { manager, staffA } = actors(organizationId, managerId, staffAId, staffBId);
      const { service } = buildJobService(pool);

      const created = await service.create(manager, {
        clientActionId: randomUUID(),
        type: 'GENERAL_TASK',
        title: 'Ekipman bakımı',
        description: null,
        customerId: null,
        contactId: null,
        assignedTo: staffAId,
        priority: 'normal',
        dueDate: null,
        scheduledAt: '2026-08-01T09:00:00.000Z',
        scheduledEndsAt: undefined,
        engagementKind: undefined,
      } as never);
      expect(created.status).toBe('NEW');
      const rescheduled = await service.patch(manager, created.id, {
        expectedVersion: created.version,
        scheduledAt: '2026-08-01T09:30:00.000Z',
      } as never);
      const accepted = await service.acceptAssignment(staffA, rescheduled.id, {
        clientActionId: randomUUID(),
        expectedVersion: rescheduled.version,
      });
      await service.start(staffA, accepted.id, {
        clientActionId: randomUUID(),
        expectedVersion: accepted.version,
      });

      const revision = await pool.query<{ max: number }>(
        `SELECT MAX(revision_no)::int AS max FROM job_card_schedule_revisions
          WHERE organization_id = $1 AND job_card_id = $2`,
        [organizationId, created.id],
      );
      expect(revision.rows[0]!.max).toBe(2);
      const facts = await selectFacts(pool, organizationId, created.id);
      expect(facts).toHaveLength(1);
      expect(facts[0]!.schedule_revision_no).toBe(2);
    });
  });

  it('STARTED responsible snapshot survives later offboarding transfer', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('F2 offboard', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const adminId = await insertUser(pool, organizationId, 'ADMIN', 'Admin');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Manager');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Staff A');
      const staffBId = await insertUser(pool, organizationId, 'STAFF', 'Staff B');
      const { staffA } = actors(organizationId, managerId, staffAId, staffBId);
      const { service } = buildJobService(pool);

      const job = await createGeneralTask(service, staffA, 'Saha kontrolü');
      const started = await service.start(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
      });
      expect(started.status).toBe('IN_PROGRESS');

      const admin: SafeUser = {
        id: adminId, organizationId, name: 'Admin',
        email: `admin-${randomUUID()}@test.local`, role: 'ADMIN',
        mustChangePassword: false, isActive: true, version: 1,
      };
      const offboarding = new PostgresStaffOffboardingService(
        pool, { disconnectUser: () => undefined }, () => CLOCK,
      );
      const plan = await offboarding.preview(admin, staffAId);
      expect(plan.jobs.map((item) => item.id)).toContain(job.id);
      await offboarding.execute(admin, staffAId, {
        clientActionId: randomUUID(),
        planHash: plan.planHash,
        reasonCode: 'ACCESS_ENDED',
        jobDecisions: plan.jobs.map((item) => ({ jobCardId: item.id, replacementUserId: staffBId })),
        calendarDecisions: [],
        followUpDecisions: [],
        customerDecisions: [],
        reminderDecisions: [],
      });

      const current = await pool.query<{ assigned_to: string }>(
        `SELECT assigned_to FROM job_cards WHERE id = $1`, [job.id],
      );
      expect(current.rows[0]!.assigned_to).toBe(staffBId);
      const facts = await selectFacts(pool, organizationId, job.id);
      expect(facts).toHaveLength(1);
      expect(facts[0]!.responsible_user_id).toBe(staffAId);
    });
  });

  it('SUBMITTED seq preserves the first completion claim across revision and resubmit', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('F2 submit', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Manager');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Staff A');
      const staffBId = await insertUser(pool, organizationId, 'STAFF', 'Staff B');
      const { manager, staffA } = actors(organizationId, managerId, staffAId, staffBId);
      const customerId = (await pool.query<{ id: string }>(
        `INSERT INTO customers (organization_id, name, customer_type, status)
         VALUES ($1, 'Dünya Klinik', 'clinic', 'active') RETURNING id`,
        [organizationId],
      )).rows[0]!.id;
      const { service } = buildJobService(pool);

      const created = await service.create(staffA, {
        clientActionId: randomUUID(),
        type: 'SALES_MEETING',
        title: 'Klinik ziyareti',
        description: null,
        customerId,
        contactId: null,
        assignedTo: staffAId,
        priority: 'normal',
        dueDate: null,
        scheduledAt: '2026-08-01T10:00:00.000Z',
        scheduledEndsAt: '2026-08-01T11:00:00.000Z',
        engagementKind: 'CUSTOMER_VISIT',
      } as never);
      const started = await service.start(staffA, created.id, {
        clientActionId: randomUUID(),
        expectedVersion: created.version,
      });
      const detailed = await service.patchMeetingDetails(staffA, started.id, {
        clientActionId: randomUUID(),
        expectedVersion: started.version,
        meetingAt: '2026-08-01T09:30:00.000Z',
        outcome: 'FOLLOW_UP_REQUIRED',
        unsuccessfulReason: 'REQUESTED_LATER',
        meetingSummary: 'Karar sonraki hafta teyit edilecek.',
      });
      const proposal = {
        scheduledAt: PROPOSAL_AT,
        type: 'SALES_MEETING',
        assignedTo: staffAId,
        followUpInstructions: 'Takip: Klinik ile karar durumunu teyit edin.',
      } as const;
      const submitted = await service.submitForApproval(staffA, created.id, {
        clientActionId: randomUUID(),
        expectedVersion: detailed.jobCardVersion,
        note: 'Ziyaret tamamlandı.',
        followUpProposal: { ...proposal },
      });
      expect(submitted.status).toBe('WAITING_APPROVAL');

      const revised = await service.requestRevision(manager, created.id, {
        clientActionId: randomUUID(),
        expectedVersion: submitted.version,
        revisionReason: 'Özet eksik, tamamlayın.',
      });
      const resumed = await service.resume(staffA, created.id, {
        clientActionId: randomUUID(),
        expectedVersion: revised.version,
      });
      const resubmitted = await service.submitForApproval(staffA, created.id, {
        clientActionId: randomUUID(),
        expectedVersion: resumed.version,
        note: 'Özet tamamlandı.',
        followUpProposal: { ...proposal },
      });
      expect(resubmitted.status).toBe('WAITING_APPROVAL');

      const facts = await selectFacts(pool, organizationId, created.id);
      const submittedFacts = facts.filter((fact) => fact.fact_type === 'SUBMITTED');
      expect(submittedFacts.map((fact) => fact.seq_no)).toEqual([1, 2]);
      for (const fact of submittedFacts) {
        expect(fact.responsible_user_id).toBe(staffAId);
        expect(fact.actor_user_id).toBe(staffAId);
        expect(fact.schedule_revision_no).toBe(1);
        expect(new Date(fact.occurred_at).toISOString()).toBe(CLOCK.toISOString());
        expect(await activityEventForFact(pool, fact)).toBe('JOB_SUBMITTED_FOR_APPROVAL');
      }
      const startedFacts = facts.filter((fact) => fact.fact_type === 'STARTED');
      expect(startedFacts).toHaveLength(1);
      expect(startedFacts[0]!.seq_no).toBe(1);
    });
  });

  it('replaying a lifecycle client action creates no duplicate fact', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('F2 replay', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Manager');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Staff A');
      const staffBId = await insertUser(pool, organizationId, 'STAFF', 'Staff B');
      const { staffA } = actors(organizationId, managerId, staffAId, staffBId);
      const { service } = buildJobService(pool);

      const job = await createGeneralTask(service, staffA, 'Tekrar denemesi');
      const clientActionId = randomUUID();
      const first = await service.start(staffA, job.id, { clientActionId, expectedVersion: job.version });
      const replayed = await service.start(staffA, job.id, { clientActionId, expectedVersion: job.version });
      expect(replayed.id).toBe(first.id);

      expect((await selectFacts(pool, organizationId, job.id))).toHaveLength(1);
      const activities = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM job_card_activity_logs
          WHERE organization_id = $1 AND job_card_id = $2 AND event_type = 'JOB_STARTED'`,
        [organizationId, job.id],
      );
      expect(activities.rows[0]!.count).toBe('1');
    });
  });

  it('a failing fact insert rolls back the lifecycle mutation', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('F2 rollback', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Manager');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Staff A');
      const staffBId = await insertUser(pool, organizationId, 'STAFF', 'Staff B');
      const { staffA } = actors(organizationId, managerId, staffAId, staffBId);
      const { service } = buildJobService(pool);

      const job = await createGeneralTask(service, staffA, 'Geri alma denemesi');
      const decoyActivity = (await pool.query<{ id: string }>(
        `INSERT INTO job_card_activity_logs (organization_id, job_card_id, actor_id, event_type)
         VALUES ($1, $2, $3, 'NOTE_ADDED') RETURNING id`,
        [organizationId, job.id, staffAId],
      )).rows[0]!.id;
      await pool.query(
        `INSERT INTO job_card_accountability_facts
           (organization_id, job_card_id, fact_type, seq_no, occurred_at,
            schedule_revision_no, responsible_user_id, actor_user_id, source_activity_id)
         VALUES ($1, $2, 'STARTED', 1, NOW(), 1, $3, $3, $4)`,
        [organizationId, job.id, staffAId, decoyActivity],
      );

      const clientActionId = randomUUID();
      await expect(service.start(staffA, job.id, {
        clientActionId, expectedVersion: job.version,
      })).rejects.toMatchObject({ code: '23505' });

      const current = await pool.query<{ status: string; started_at: Date | null }>(
        `SELECT status, started_at FROM job_cards WHERE id = $1`, [job.id],
      );
      expect(current.rows[0]!.status).toBe('ACCEPTED');
      expect(current.rows[0]!.started_at).toBeNull();
      const startedActivities = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM job_card_activity_logs
          WHERE organization_id = $1 AND job_card_id = $2 AND event_type = 'JOB_STARTED'`,
        [organizationId, job.id],
      );
      expect(startedActivities.rows[0]!.count).toBe('0');
      const claim = await pool.query<{ status: string }>(
        `SELECT status FROM processed_actions
          WHERE organization_id = $1 AND user_id = $2 AND client_action_id = $3`,
        [organizationId, staffAId, clientActionId],
      );
      expect(claim.rows).toHaveLength(0);
    });
  });

  it('rejects cross-organization fact relationships', async () => {
    await withSchema(async (pool) => {
      const orgA = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name) VALUES ('F2 tenant A') RETURNING id`,
      )).rows[0]!.id;
      const orgB = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name) VALUES ('F2 tenant B') RETURNING id`,
      )).rows[0]!.id;
      const staffA = await insertUser(pool, orgA, 'STAFF', 'Staff A');
      const { service } = buildJobService(pool);
      const actor: JobCardActor = { id: staffA, organizationId: orgA, role: 'STAFF' };
      const job = await createGeneralTask(service, actor, 'Kiracı denemesi');
      await service.start(actor, job.id, { clientActionId: randomUUID(), expectedVersion: job.version });
      const fact = (await selectFacts(pool, orgA, job.id))[0]!;

      await expect(pool.query(
        `INSERT INTO job_card_accountability_facts
           (organization_id, job_card_id, fact_type, seq_no, occurred_at,
            schedule_revision_no, responsible_user_id, actor_user_id, source_activity_id)
         VALUES ($1, $2, 'STARTED', 1, NOW(), 1, $3, $3, $4)`,
        [orgB, job.id, staffA, fact.source_activity_id],
      )).rejects.toMatchObject({ code: '23503' });
    });
  });

  it('rejects a fact linked to another job\u2019s schedule revision', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name) VALUES ('F2 revision guard') RETURNING id`,
      )).rows[0]!.id;
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Manager');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Staff A');
      const staffBId = await insertUser(pool, organizationId, 'STAFF', 'Staff B');
      const { manager, staffA } = actors(organizationId, managerId, staffAId, staffBId);
      const { service } = buildJobService(pool);

      const first = await createGeneralTask(service, staffA, 'Birinci iş');
      const second = await createGeneralTask(service, staffA, 'İkinci iş');
      await service.start(staffA, first.id, { clientActionId: randomUUID(), expectedVersion: first.version });
      // Give the second job a second revision so revision_no 2 exists globally but not for the first job.
      const patched = await service.patch(manager, second.id, {
        expectedVersion: second.version,
        scheduledAt: '2026-08-01T09:00:00.000Z',
      } as never);
      const freshActivity = (await pool.query<{ id: string }>(
        `INSERT INTO job_card_activity_logs (organization_id, job_card_id, actor_id, event_type)
         VALUES ($1, $2, $3, 'NOTE_ADDED') RETURNING id`,
        [organizationId, first.id, staffAId],
      )).rows[0]!.id;

      await expect(pool.query(
        `INSERT INTO job_card_accountability_facts
           (organization_id, job_card_id, fact_type, seq_no, occurred_at,
            schedule_revision_no, responsible_user_id, actor_user_id, source_activity_id)
         VALUES ($1, $2, 'SUBMITTED', 1, NOW(), 2, $3, $3, $4)`,
        [organizationId, first.id, staffAId, freshActivity],
      )).rejects.toMatchObject({ code: '23503' });
      void patched;
    });
  });

  it('rejects a fact linked to another job\u2019s activity', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name) VALUES ('F2 activity guard') RETURNING id`,
      )).rows[0]!.id;
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Manager');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Staff A');
      const staffBId = await insertUser(pool, organizationId, 'STAFF', 'Staff B');
      const { staffA } = actors(organizationId, managerId, staffAId, staffBId);
      const { service } = buildJobService(pool);

      const first = await createGeneralTask(service, staffA, 'Birinci iş');
      const second = await createGeneralTask(service, staffA, 'İkinci iş');
      await service.start(staffA, first.id, { clientActionId: randomUUID(), expectedVersion: first.version });
      await service.start(staffA, second.id, { clientActionId: randomUUID(), expectedVersion: second.version });
      const firstFact = (await selectFacts(pool, organizationId, first.id))[0]!;
      const secondFact = (await selectFacts(pool, organizationId, second.id))[0]!;

      await expect(pool.query(
        `INSERT INTO job_card_accountability_facts
           (organization_id, job_card_id, fact_type, seq_no, occurred_at,
            schedule_revision_no, responsible_user_id, actor_user_id, source_activity_id)
         VALUES ($1, $2, 'SUBMITTED', 2, NOW(), 1, $3, $3, $4)`,
        [organizationId, first.id, staffAId, secondFact.source_activity_id],
      )).rejects.toMatchObject({ code: '23503' });
      void firstFact;
    });
  });

  it('demo purge removes only targeted demo facts', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name) VALUES ('F2 purge') RETURNING id`,
      )).rows[0]!.id;
      const adminId = await insertUser(pool, organizationId, 'ADMIN', 'Admin');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Manager');
      const demoStaffId = await insertUser(pool, organizationId, 'STAFF', 'Demo Staff');
      const businessStaffId = await insertUser(pool, organizationId, 'STAFF', 'Business Staff');
      const datasetId = (await pool.query<{ id: string }>(
        `INSERT INTO demo_datasets (organization_id, dataset_key, seed_version, created_by)
         VALUES ($1, $2, 'f2-acceptance', $3) RETURNING id`,
        [organizationId, `dataset-${randomUUID()}`, demoStaffId],
      )).rows[0]!.id;
      await pool.query(
        `UPDATE users SET data_class = 'DEMO', demo_dataset_id = $2
          WHERE organization_id = $1 AND id = $3`,
        [organizationId, datasetId, demoStaffId],
      );
      const insertJobWithFact = async (title: string, assignee: string, dataClass: string, ds: string | null) => {
        const jobId = (await pool.query<{ id: string }>(
          `INSERT INTO job_cards
             (organization_id, type, status, title, assigned_to, created_by, priority, started_at,
              data_class, demo_dataset_id)
           VALUES ($1, 'GENERAL_TASK', 'IN_PROGRESS', $2, $3, $3, 'normal', NOW(), $4, $5) RETURNING id`,
          [organizationId, title, assignee, dataClass, ds],
        )).rows[0]!.id;
        await pool.query(
          `INSERT INTO job_card_schedule_revisions
             (organization_id, job_card_id, revision_no, organization_timezone, source)
           VALUES ($1, $2, 1, 'Europe/Istanbul', 'BASELINE')`,
          [organizationId, jobId],
        );
        const activityId = (await pool.query<{ id: string }>(
          `INSERT INTO job_card_activity_logs (organization_id, job_card_id, actor_id, event_type)
           VALUES ($1, $2, $3, 'JOB_STARTED') RETURNING id`,
          [organizationId, jobId, assignee],
        )).rows[0]!.id;
        await pool.query(
          `INSERT INTO job_card_accountability_facts
             (organization_id, job_card_id, fact_type, seq_no, occurred_at,
              schedule_revision_no, responsible_user_id, actor_user_id, source_activity_id)
           VALUES ($1, $2, 'STARTED', 1, NOW(), 1, $3, $3, $4)`,
          [organizationId, jobId, assignee, activityId],
        );
        return jobId;
      };
      const demoJobId = await insertJobWithFact('Demo iş', demoStaffId, 'DEMO', datasetId);
      const businessJobId = await insertJobWithFact('Business iş', businessStaffId, 'BUSINESS', null);

      const admin: SafeUser = {
        id: adminId, organizationId, name: 'Admin',
        email: `admin-${randomUUID()}@test.local`, role: 'ADMIN',
        mustChangePassword: false, isActive: true, version: 1,
      };
      const purgeService = new DemoDatasetService(new PostgresDemoDatasetRepository(pool));
      const preview = await purgeService.preview(admin, datasetId);
      expect(preview.safeToPurge).toBe(true);
      await purgeService.purge(admin, datasetId, {
        clientActionId: randomUUID(),
        planHash: preview.planHash,
      });

      const remaining = await pool.query<{ job_card_id: string }>(
        `SELECT job_card_id FROM job_card_accountability_facts WHERE organization_id = $1`,
        [organizationId],
      );
      expect(remaining.rows.map((row) => row.job_card_id)).toEqual([businessJobId]);
      const jobs = await pool.query<{ id: string }>(
        `SELECT id FROM job_cards WHERE organization_id = $1`, [organizationId],
      );
      expect(jobs.rows.map((row) => row.id)).toEqual([businessJobId]);
      void demoJobId;
    });
  });

  it('user deletion inspection flags accountability fact references', async () => {
    await withSchema(async (pool) => {
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name) VALUES ('F2 guard') RETURNING id`,
      )).rows[0]!.id;
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Manager');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Staff A');
      const staffBId = await insertUser(pool, organizationId, 'STAFF', 'Staff B');
      const cleanId = await insertUser(pool, organizationId, 'STAFF', 'Clean Staff');
      const { staffA } = actors(organizationId, managerId, staffAId, staffBId);
      const { service } = buildJobService(pool);

      const job = await createGeneralTask(service, staffA, 'Koruma denemesi');
      await service.start(staffA, job.id, { clientActionId: randomUUID(), expectedVersion: job.version });

      const repository = new PostgresPeopleRepository(
        pool,
        { prepare: async () => { throw new Error('not needed'); } } as never,
        { revokeSessionsForUser: async () => undefined } as never,
      );
      const flagged = await repository.getUserDeletionFacts(organizationId, staffAId);
      expect(flagged?.hasBusinessHistory).toBe(true);
      const clean = await repository.getUserDeletionFacts(organizationId, cleanId);
      expect(clean?.hasBusinessHistory).toBe(false);
    });
  });

  it('restore validation accepts a 044 database with consistent facts', async () => {
    const adminPool = new Pool({ connectionString: databaseUrl });
    const database = `f2restore_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    let pool: Pool | null = null;
    try {
      await adminPool.query(`CREATE DATABASE ${database}`);
      const url = new URL(databaseUrl!);
      url.pathname = `/${database}`;
      pool = new Pool({ connectionString: url.toString() });
      await runMigrations({ migrationsDirectory: MIGRATIONS_DIRECTORY, store: new PostgresMigrationStore(pool) });
      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone) VALUES ('F2 restore', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Manager');
      const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Staff A');
      const staffBId = await insertUser(pool, organizationId, 'STAFF', 'Staff B');
      const { staffA } = actors(organizationId, managerId, staffAId, staffBId);
      const { service } = buildJobService(pool);
      const job = await createGeneralTask(service, staffA, 'Yedek denemesi');
      await service.start(staffA, job.id, { clientActionId: randomUUID(), expectedVersion: job.version });

      const manifest = {
        database: { schemaVersion: '045_calendar_request_hash' },
      } as unknown as RestoreManifestV1;
      const evidence = await validateRestoredDatabase(url.toString(), manifest);
      expect(evidence.schemaVersion).toBe('045_calendar_request_hash');
      expect(evidence.relations).toContain('job_card_accountability_facts');
      expect(evidence.orphanJobCards).toBe(0);
    } finally {
      await pool?.end();
      await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
      await adminPool.end();
    }
  });

  it('restore validation fails closed when the fact table is absent', async () => {
    const adminPool = new Pool({ connectionString: databaseUrl });
    const database = `f2restore_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    let pool: Pool | null = null;
    const dir = await mkdtemp(path.join(tmpdir(), 'f2-restore-'));
    try {
      await adminPool.query(`CREATE DATABASE ${database}`);
      const url = new URL(databaseUrl!);
      url.pathname = `/${database}`;
      pool = new Pool({ connectionString: url.toString() });
      const entries = await readdir(MIGRATIONS_DIRECTORY);
      for (const entry of entries) {
        if (!/^\d{3}_[A-Za-z0-9_]+\.sql$/.test(entry)) continue;
        if (Number(entry.slice(0, 3)) > 43) continue;
        await symlink(path.join(MIGRATIONS_DIRECTORY, entry), path.join(dir, entry));
      }
      await runMigrations({ migrationsDirectory: dir, store: new PostgresMigrationStore(pool) });

      const manifest = {
        database: { schemaVersion: '043_job_card_schedule_and_assignment_history' },
      } as unknown as RestoreManifestV1;
      await expect(validateRestoredDatabase(url.toString(), manifest)).rejects.toMatchObject({
        code: 'RESTORE_INTEGRITY_FAILED',
      });
    } finally {
      await pool?.end();
      await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
      await adminPool.end();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
