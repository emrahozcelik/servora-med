import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import { PostgresCalendarRepository } from '../src/modules/calendar/repository.js';
import { CalendarService } from '../src/modules/calendar/service.js';
import type {
  JobCard,
  JobCardActor,
  JobCardType,
} from '../src/modules/job-cards/types.js';
import type { RealtimeEventPublisher } from '../src/modules/realtime/event-bus.js';
import type { RealtimeEventRecord } from '../src/modules/realtime/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

const CLOCK = new Date('2026-08-01T10:00:00.000Z');
const PROPOSAL_AT = '2026-08-08T10:00:00.000Z';

type Fixture = {
  pool: Pool;
  service: JobCardService;
  calendar: CalendarService;
  organizationId: string;
  otherOrganizationId: string;
  manager: JobCardActor;
  staffA: JobCardActor;
  staffB: JobCardActor;
  otherStaff: JobCardActor;
  customerId: string;
  productId: string;
  proposalFor(assignedTo: string, scheduledAt?: string, type?: JobCardType): {
    scheduledAt: string;
    type: JobCardType;
    assignedTo: string;
    followUpInstructions: string;
  };
  createInProgressJob(input: {
    type: JobCardType;
    title: string;
    customerId?: string | null;
    assignedTo: string;
    scheduledAt?: string | null;
  }): Promise<JobCard>;
};

async function insertUser(pool: Pool, organizationId: string, role: JobCardActor['role'], name: string) {
  return (await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role, is_active)
     VALUES ($1, $2, $3, 'test-hash', $4, TRUE) RETURNING id`,
    [organizationId, name, `${randomUUID()}@test.local`, role],
  )).rows[0]!.id;
}

async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `follow_up_proposal_${randomUUID().replaceAll('-', '')}`;
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

    const organizationId = (await pool.query<{ id: string }>(
      `INSERT INTO organizations (name, timezone)
       VALUES ('Follow-up proposal', 'Europe/Istanbul') RETURNING id`,
    )).rows[0]!.id;
    const otherOrganizationId = (await pool.query<{ id: string }>(
      `INSERT INTO organizations (name) VALUES ('Other org') RETURNING id`,
    )).rows[0]!.id;
    const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Manager');
    const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Staff A');
    const staffBId = await insertUser(pool, organizationId, 'STAFF', 'Staff B');
    const otherStaffId = await insertUser(pool, otherOrganizationId, 'STAFF', 'Other Staff');

    const customerId = (await pool.query<{ id: string }>(
      `INSERT INTO customers (organization_id, name, customer_type, status)
       VALUES ($1, 'Dünya Klinik', 'clinic', 'active') RETURNING id`,
      [organizationId],
    )).rows[0]!.id;
    const productId = (await pool.query<{ id: string }>(
      `INSERT INTO products (organization_id, name, unit)
       VALUES ($1, 'İmplant Seti', 'adet') RETURNING id`,
      [organizationId],
    )).rows[0]!.id;

    const published: RealtimeEventRecord[] = [];
    const publisher: RealtimeEventPublisher = { publish: (event) => published.push(event) };
    const repository = new PostgresJobCardRepository(pool);
    const service = new JobCardService(repository, () => CLOCK, publisher);
    const calendar = new CalendarService(
      true,
      new PostgresCalendarRepository(pool),
      () => CLOCK,
    );
    const manager: JobCardActor = { id: managerId, organizationId, role: 'MANAGER' };
    const staffA: JobCardActor = { id: staffAId, organizationId, role: 'STAFF' };
    const staffB: JobCardActor = { id: staffBId, organizationId, role: 'STAFF' };
    const otherStaff: JobCardActor = { id: otherStaffId, organizationId: otherOrganizationId, role: 'STAFF' };

    const proposalFor: Fixture['proposalFor'] = (assignedTo, scheduledAt = PROPOSAL_AT, type = 'SALES_MEETING') => ({
      scheduledAt,
      type,
      assignedTo,
      followUpInstructions: 'Takip: Klinik ile karar durumunu teyit edin.',
    });

    const createInProgressJob: Fixture['createInProgressJob'] = async (input) => {
      const type = input.type;
      const resolvedCustomerId = input.customerId === undefined ? customerId : input.customerId;
      const assignedTo = input.assignedTo;
      const scheduledAt = input.scheduledAt === undefined ? '2026-08-01T10:00:00.000Z' : input.scheduledAt;
      const job = await service.create(staffA, {
        clientActionId: randomUUID(),
        type,
        title: input.title,
        description: null,
        customerId: type === 'GENERAL_TASK' ? null : resolvedCustomerId,
        contactId: null,
        assignedTo,
        priority: 'normal',
        dueDate: null,
        scheduledAt,
        scheduledEndsAt: type === 'GENERAL_TASK' ? undefined : '2026-08-01T11:00:00.000Z',
        engagementKind: type === 'SALES_MEETING' ? 'SALES_MEETING' : undefined,
      } as never);
      const started = await service.start(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
      });
      if (type === 'PRODUCT_DELIVERY') {
        const planned = await service.addDeliveryItem(staffA, job.id, {
          clientActionId: randomUUID(),
          expectedVersion: started.version,
          productId,
          deliveryPurpose: 'SALE',
          deliveredAt: null,
          quantity: 2,
        });
        await service.patchDeliveryItem(staffA, job.id, planned.item.id, {
          expectedVersion: planned.jobCardVersion,
          deliveredAt: '2026-08-01T09:30:00.000Z',
        });
        return service.detail(staffA, job.id) as unknown as Promise<JobCard>;
      }
      if (type === 'SALES_MEETING') {
        const details = await service.patchMeetingDetails(staffA, job.id, {
          clientActionId: randomUUID(),
          expectedVersion: started.version,
          meetingAt: '2026-08-01T09:30:00.000Z',
          outcome: 'POSITIVE',
          meetingSummary: 'Görüşme tamamlandı.',
        });
        void details;
        return service.detail(staffA, job.id) as unknown as Promise<JobCard>;
      }
      return started;
    };

    await run({
      pool,
      service,
      calendar,
      organizationId,
      otherOrganizationId,
      manager,
      staffA,
      staffB,
      otherStaff,
      customerId,
      productId,
      proposalFor,
      createInProgressJob,
    });
  } finally {
    await pool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }
}

const appError = (code: string, statusCode: number) => expect.objectContaining({ code, statusCode });

describe.skipIf(!databaseUrl)('mandatory follow-up proposal PostgreSQL contract', () => {
  it('FUP-M1: rejects a Staff submission without a follow-up proposal', async () => {
    await withFixture(async ({ service, staffA, createInProgressJob }) => {
      const job = await createInProgressJob({
        type: 'PRODUCT_DELIVERY', title: 'Teslim', assignedTo: staffA.id,
      });
      await expect(service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Teslim tamamlandı.',
      })).rejects.toMatchObject(appError('FOLLOW_UP_PROPOSAL_REQUIRED', 400));
      const after = await service.detail(staffA, job.id);
      expect(after.status).toBe('IN_PROGRESS');
    });
  });

  it('FUP-M2/M3: suggests +7 days with the source clock and persists a SYSTEM origin when accepted unchanged', async () => {
    await withFixture(async ({ service, staffA, createInProgressJob }) => {
      const job = await createInProgressJob({
        type: 'SALES_MEETING', title: 'Kontrol görüşmesi', assignedTo: staffA.id,
      });
      const suggestion = await service.getFollowUpSuggestion(staffA, job.id);
      expect(suggestion).toMatchObject({
        scheduledAt: '2026-08-08T10:00:00.000Z',
        type: 'SALES_MEETING',
        assignedTo: staffA.id,
        followUpInstructions: 'Takip: Kontrol görüşmesi',
      });
      expect(suggestion.evaluation.level).toBe('CLEAR');

      const submitted = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Görüşme tamamlandı.',
        followUpProposal: {
          scheduledAt: suggestion.scheduledAt!,
          type: suggestion.type,
          assignedTo: suggestion.assignedTo,
          followUpInstructions: suggestion.followUpInstructions,
        },
      });
      expect(submitted.status).toBe('WAITING_APPROVAL');
      expect(submitted.followUpProposal).toMatchObject({
        scheduledAt: '2026-08-08T10:00:00.000Z',
        type: 'SALES_MEETING',
        assignedTo: staffA.id,
        origin: 'SYSTEM',
      });
    });
  });

  it('FUP-M4/M5: marks edited proposals STAFF_ADJUSTED and rejects past dates', async () => {
    await withFixture(async ({ service, staffA, createInProgressJob }) => {
      const job = await createInProgressJob({
        type: 'SALES_MEETING', title: 'Kontrol görüşmesi', assignedTo: staffA.id,
      });
      await expect(service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Görüşme tamamlandı.',
        followUpProposal: {
          scheduledAt: '2026-07-20T10:00:00.000Z',
          type: 'SALES_MEETING',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Kontrol görüşmesi',
        },
      })).rejects.toMatchObject(appError('FOLLOW_UP_PROPOSAL_INVALID', 400));

      const submitted = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Görüşme tamamlandı.',
        followUpProposal: {
          scheduledAt: '2026-08-09T10:00:00.000Z',
          type: 'SALES_MEETING',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Kontrol görüşmesi',
        },
      });
      expect(submitted.followUpProposal).toMatchObject({
        scheduledAt: '2026-08-09T10:00:00.000Z',
        origin: 'STAFF_ADJUSTED',
      });
    });
  });

  it('FUP-M18: forbids Staff from proposing another assignee', async () => {
    await withFixture(async ({ service, staffA, staffB, createInProgressJob }) => {
      const job = await createInProgressJob({
        type: 'GENERAL_TASK', title: 'Görev', assignedTo: staffA.id, customerId: null,
      });
      await expect(service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Görev tamamlandı.',
        followUpProposal: {
          scheduledAt: '2026-08-08T10:00:00.000Z',
          type: 'GENERAL_TASK',
          assignedTo: staffB.id,
          followUpInstructions: 'Takip: Görev',
        },
      })).rejects.toMatchObject(appError('FORBIDDEN', 403));
    });
  });

  it('FUP-M18B: forbids Staff from overriding the follow-up type on a SALES_MEETING source', async () => {
    await withFixture(async ({ service, staffA, createInProgressJob }) => {
      const job = await createInProgressJob({
        type: 'SALES_MEETING', title: 'Kontrol görüşmesi', assignedTo: staffA.id,
      });
      await expect(service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Görüşme tamamlandı.',
        followUpProposal: {
          scheduledAt: PROPOSAL_AT,
          type: 'PRODUCT_DELIVERY',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Kontrol görüşmesi',
        },
      })).rejects.toMatchObject(appError('FORBIDDEN', 403));
      const after = await service.detail(staffA, job.id);
      expect(after.status).toBe('IN_PROGRESS');
      expect(after.followUpProposal).toBeNull();
    });
  });

  it('FUP-M18B: forbids Staff from overriding the PRODUCT_DELIVERY default type (SALES_MEETING)', async () => {
    await withFixture(async ({ service, staffA, createInProgressJob }) => {
      const job = await createInProgressJob({
        type: 'PRODUCT_DELIVERY', title: 'Teslim', assignedTo: staffA.id,
      });
      await expect(service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Teslim tamamlandı.',
        followUpProposal: {
          scheduledAt: PROPOSAL_AT,
          type: 'PRODUCT_DELIVERY',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Teslim',
        },
      })).rejects.toMatchObject(appError('FORBIDDEN', 403));
    });
  });

  it('R1-6: Staff receives the frequency warning with Manager-review wording and no override surface', async () => {
    await withFixture(async ({
      service, pool, manager, staffA, staffB, organizationId, customerId, createInProgressJob,
    }) => {
      const job = await createInProgressJob({
        type: 'SALES_MEETING', title: 'Kontrol görüşmesi', assignedTo: staffA.id,
      });
      for (const [index, at] of ['2026-08-01T09:00:00.000Z', '2026-08-02T09:00:00.000Z', '2026-08-03T09:00:00.000Z'].entries()) {
        const visit = await pool.query<{ id: string }>(
          `INSERT INTO job_cards (organization_id, type, status, title, customer_id, assigned_to, created_by,
             started_at, staff_completed_at, staff_completed_by, manager_approved_at, manager_approved_by,
             engagement_kind)
           VALUES ($1, 'SALES_MEETING', 'COMPLETED', $2, $3, $4, $5, NOW(), NOW(), $6, NOW(), $5, 'SALES_MEETING')
           RETURNING id`,
          [organizationId, `Ziyaret ${index}`, customerId, staffB.id, manager.id, staffB.id],
        );
        await pool.query(
          `INSERT INTO job_card_meeting_details (organization_id, job_card_id, meeting_at, outcome, meeting_summary)
           VALUES ($1, $2, $3, 'POSITIVE', 'Geçmiş ziyaret')`,
          [organizationId, visit.rows[0]!.id, at],
        );
      }
      const staffSuggestion = await service.getFollowUpSuggestion(staffA, job.id);
      expect(staffSuggestion.evaluation.level).toBe('FREQUENCY_EXCEEDED');
      expect(staffSuggestion.evaluation.safeMessage).toContain('yönetici onayında ayrıca değerlendirilecek');
      expect(staffSuggestion.evaluation.safeMessage).not.toContain('nedeni belirtin');
      const managerSuggestion = await service.getFollowUpSuggestion(manager, job.id);
      expect(managerSuggestion.evaluation.safeMessage).toContain('14 günlük bir dönemde ziyaret sıklığı sınırını aşıyor');
    });
  });

  it('FUP-M17: cross-organization access fails closed', async () => {
    await withFixture(async ({ service, otherStaff, staffA, createInProgressJob }) => {
      const job = await createInProgressJob({
        type: 'GENERAL_TASK', title: 'Görev', assignedTo: staffA.id, customerId: null,
      });
      await expect(service.submitForApproval(otherStaff, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Yetkisiz.',
        followUpProposal: {
          scheduledAt: '2026-08-08T10:00:00.000Z',
          type: 'GENERAL_TASK',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Görev',
        },
      })).rejects.toMatchObject(appError('JOB_CARD_NOT_FOUND', 404));
    });
  });

  it('FUP-M9/M11/M13 + CSI-17: unified approval creates exactly one linked child and Calendar shows it', async () => {
    await withFixture(async ({
      service, calendar, manager, staffA, createInProgressJob, customerId,
    }) => {
      const job = await createInProgressJob({
        type: 'PRODUCT_DELIVERY', title: 'Teslim', assignedTo: staffA.id,
      });
      const submitted = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Teslim tamamlandı.',
        followUpProposal: {
          scheduledAt: PROPOSAL_AT,
          type: 'SALES_MEETING',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Klinik ile karar durumunu teyit edin.',
        },
      });
      const approved = await service.approve(manager, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: submitted.version,
      }) as JobCard & { followUpJobCardId: string };
      expect(approved.status).toBe('COMPLETED');
      expect(approved.followUpJobCardId).toBeTypeOf('string');

      const child = await service.detail(manager, approved.followUpJobCardId);
      expect(child).toMatchObject({
        status: 'NEW',
        type: 'SALES_MEETING',
        customerId,
        scheduledAt: PROPOSAL_AT,
        engagementKind: 'FOLLOW_UP',
      });
      expect(child.followUpContext).toMatchObject({
        sourceJobCardId: job.id,
        followUpInstructions: 'Takip: Klinik ile karar durumunu teyit edin.',
      });

      const calendarItems = await calendar.list(manager, {
        from: '2026-08-08T00:00:00.000Z',
        to: '2026-08-09T00:00:00.000Z',
        assignedTo: null,
      });
      expect(calendarItems.items.map((item) => item.id)).toContain(child.id);

      const activity = await service.listActivity(manager, job.id, { limit: 50, offset: 0 });
      const approveActivity = activity.items.find((item) => item.eventType === 'JOB_APPROVED');
      expect(approveActivity).toBeDefined();
    });
  });

  it('FUP-M14/M10: replays return the original child and never create a second one', async () => {
    await withFixture(async ({ service, manager, staffA, createInProgressJob }) => {
      const job = await createInProgressJob({
        type: 'GENERAL_TASK', title: 'Görev', assignedTo: staffA.id, customerId: null,
      });
      const submitted = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Görev tamamlandı.',
        followUpProposal: {
          scheduledAt: PROPOSAL_AT,
          type: 'GENERAL_TASK',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Görev',
        },
      });
      const approveId = randomUUID();
      const first = await service.approve(manager, job.id, {
        clientActionId: approveId,
        expectedVersion: submitted.version,
      }) as JobCard & { followUpJobCardId: string };
      const second = await service.approve(manager, job.id, {
        clientActionId: approveId,
        expectedVersion: submitted.version,
      }) as JobCard & { followUpJobCardId: string };
      expect(second).toEqual(first);
      const children = await service.listFollowUps(manager, job.id, { limit: 10, offset: 0 });
      expect(children.total).toBe(1);
    });
  });

  it('FUP-M15: revision preserves the proposal and resubmission updates it', async () => {
    await withFixture(async ({ service, manager, staffA, createInProgressJob }) => {
      const job = await createInProgressJob({
        type: 'SALES_MEETING', title: 'Kontrol görüşmesi', assignedTo: staffA.id,
      });
      const submitted = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Görüşme tamamlandı.',
        followUpProposal: {
          scheduledAt: PROPOSAL_AT,
          type: 'SALES_MEETING',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Kontrol görüşmesi',
        },
      });
      const revised = await service.requestRevision(manager, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: submitted.version,
        revisionReason: 'Özeti düzeltin.',
      });
      const detail = await service.detail(manager, job.id);
      expect(detail.followUpProposal).toMatchObject({
        scheduledAt: PROPOSAL_AT,
        proposedBy: { id: staffA.id, name: 'Staff A' },
      });

      const resumed = await service.resume(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: revised.version,
      });
      const resubmitted = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: resumed.version,
        note: 'Görüşme düzeltildi.',
        followUpProposal: {
          scheduledAt: '2026-08-10T10:00:00.000Z',
          type: 'SALES_MEETING',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Kontrol görüşmesi',
        },
      });
      expect(resubmitted.followUpProposal).toMatchObject({ scheduledAt: '2026-08-10T10:00:00.000Z' });

      const approved = await service.approve(manager, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: resubmitted.version,
      }) as JobCard & { followUpJobCardId: string };
      const child = await service.detail(manager, approved.followUpJobCardId);
      expect(child.scheduledAt).toBe('2026-08-10T10:00:00.000Z');
    });
  });

  it('FUP-M8: Manager may change the assignee at approval', async () => {
    await withFixture(async ({ service, manager, staffA, staffB, createInProgressJob }) => {
      const job = await createInProgressJob({
        type: 'GENERAL_TASK', title: 'Görev', assignedTo: staffA.id, customerId: null,
      });
      const submitted = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Görev tamamlandı.',
        followUpProposal: {
          scheduledAt: PROPOSAL_AT,
          type: 'GENERAL_TASK',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Görev',
        },
      });
      const approved = await service.approve(manager, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: submitted.version,
        followUp: {
          scheduledAt: PROPOSAL_AT,
          type: 'GENERAL_TASK',
          assignedTo: staffB.id,
          followUpInstructions: 'Takip: Görev',
        },
      }) as JobCard & { followUpJobCardId: string };
      const child = await service.detail(manager, approved.followUpJobCardId);
      expect(child.assignedTo).toBe(staffB.id);
    });
  });

  it('CSI-1/2/3/4 + CSI-8/9: suggestions skip same-Customer ON_SITE days regardless of assignee', async () => {
    await withFixture(async ({ service, pool, manager, staffA, staffB, organizationId, customerId, createInProgressJob }) => {
      const job = await createInProgressJob({
        type: 'SALES_MEETING', title: 'Kontrol görüşmesi', assignedTo: staffA.id,
      });
      // A cancelled ON_SITE job on the base day does not block (CSI-3).
      await pool.query(
        `INSERT INTO job_cards (organization_id, type, status, title, customer_id, assigned_to, created_by,
           scheduled_at, started_at, cancelled_at, cancelled_by, cancel_reason)
         VALUES ($1, 'PRODUCT_DELIVERY', 'CANCELLED', 'İptal teslim', $2, $3, $4, $5, NOW(), NOW(), $4, 'İptal')`,
        [organizationId, customerId, staffB.id, manager.id, '2026-08-08T10:00:00.000Z'],
      );
      // A GENERAL_TASK for the same Customer on the base day does not block (CSI-4).
      await pool.query(
        `INSERT INTO job_cards (organization_id, type, status, title, customer_id, assigned_to, created_by,
           scheduled_at)
         VALUES ($1, 'GENERAL_TASK', 'NEW', 'Uzaktan görev', $2, $3, $4, $5)`,
        [organizationId, customerId, staffB.id, manager.id, '2026-08-08T10:00:00.000Z'],
      );
      let suggestion = await service.getFollowUpSuggestion(staffA, job.id);
      expect(suggestion.scheduledAt).toBe('2026-08-08T10:00:00.000Z');

      // Another Staff member's ON_SITE job on the base day forces a skip (CSI-1/2/8/9).
      await pool.query(
        `INSERT INTO job_cards (organization_id, type, status, title, customer_id, assigned_to, created_by,
           scheduled_at)
         VALUES ($1, 'PRODUCT_DELIVERY', 'NEW', 'Başka personelin teslimi', $2, $3, $4, $5)`,
        [organizationId, customerId, staffB.id, manager.id, '2026-08-08T09:00:00.000Z'],
      );
      suggestion = await service.getFollowUpSuggestion(staffA, job.id);
      expect(suggestion.scheduledAt).toBe('2026-08-09T10:00:00.000Z');
      expect(suggestion.evaluation.safeMessage).toContain('sonraki uygun tarih önerildi');
      // Staff projection leaks no conflict details (CSI-7).
      expect(suggestion.evaluation.conflicts).toEqual([]);
      expect(suggestion.evaluation.recentVisit).toBeNull();

      // Manager receives rich conflict details (CSI-6).
      const evaluation = await service.getFollowUpSuggestion(manager, job.id, PROPOSAL_AT);
      expect(evaluation.evaluation.level).toBe('CONFLICT');
      expect(evaluation.evaluation.conflicts).toEqual([
        expect.objectContaining({ title: 'Başka personelin teslimi' }),
      ]);
      expect(evaluation.evaluation.suggestedAlternativeAt).toBe('2026-08-09T10:00:00.000Z');
    });
  });

  it('CSI-10: approval revalidates authoritatively when a conflict appears after submission', async () => {
    await withFixture(async ({
      service, pool, manager, staffA, staffB, organizationId, customerId, createInProgressJob,
    }) => {
      const job = await createInProgressJob({
        type: 'SALES_MEETING', title: 'Kontrol görüşmesi', assignedTo: staffA.id,
      });
      const submitted = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Görüşme tamamlandı.',
        followUpProposal: {
          scheduledAt: PROPOSAL_AT,
          type: 'SALES_MEETING',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Kontrol görüşmesi',
        },
      });
      // Another Manager schedules a conflicting ON_SITE job after submission.
      await pool.query(
        `INSERT INTO job_cards (organization_id, type, status, title, customer_id, assigned_to, created_by,
           scheduled_at)
         VALUES ($1, 'PRODUCT_DELIVERY', 'NEW', 'Sonradan planlanan teslim', $2, $3, $4, $5)`,
        [organizationId, customerId, staffB.id, manager.id, '2026-08-08T09:00:00.000Z'],
      );

      await expect(service.approve(manager, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: submitted.version,
      })).rejects.toMatchObject(appError('FOLLOW_UP_CUSTOMER_CONFLICT', 409));

      const approved = await service.approve(manager, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: submitted.version,
        followUp: {
          scheduledAt: '2026-08-09T10:00:00.000Z',
          type: 'SALES_MEETING',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Kontrol görüşmesi',
        },
      }) as JobCard & { followUpJobCardId: string };
      const child = await service.detail(manager, approved.followUpJobCardId);
      expect(child.scheduledAt).toBe('2026-08-09T10:00:00.000Z');
    });
  });

  it('CSI-12/13/14: the 4th visit in 14 days requires a Manager override reason that is audited', async () => {
    await withFixture(async ({
      service, pool, manager, staffA, staffB, organizationId, customerId, createInProgressJob,
    }) => {
      const job = await createInProgressJob({
        type: 'SALES_MEETING', title: 'Kontrol görüşmesi', assignedTo: staffA.id,
      });
      for (const [index, at] of ['2026-08-01T09:00:00.000Z', '2026-08-02T09:00:00.000Z', '2026-08-03T09:00:00.000Z'].entries()) {
        const visit = await pool.query<{ id: string }>(
          `INSERT INTO job_cards (organization_id, type, status, title, customer_id, assigned_to, created_by,
             started_at, staff_completed_at, staff_completed_by, manager_approved_at, manager_approved_by,
             engagement_kind)
           VALUES ($1, 'SALES_MEETING', 'COMPLETED', $2, $3, $4, $5, NOW(), NOW(), $6, NOW(), $5, 'SALES_MEETING')
           RETURNING id`,
          [organizationId, `Ziyaret ${index}`, customerId, staffB.id, manager.id, staffB.id],
        );
        await pool.query(
          `INSERT INTO job_card_meeting_details (organization_id, job_card_id, meeting_at, outcome, meeting_summary)
           VALUES ($1, $2, $3, 'POSITIVE', 'Geçmiş ziyaret')`,
          [organizationId, visit.rows[0]!.id, at],
        );
      }
      const submitted = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Görüşme tamamlandı.',
        followUpProposal: {
          scheduledAt: PROPOSAL_AT,
          type: 'SALES_MEETING',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Kontrol görüşmesi',
        },
      });

      const evaluation = await service.getFollowUpSuggestion(manager, job.id, PROPOSAL_AT);
      expect(evaluation.evaluation.level).toBe('FREQUENCY_EXCEEDED');
      expect(evaluation.evaluation.recentVisit).toMatchObject({ jobType: 'SALES_MEETING' });

      await expect(service.approve(manager, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: submitted.version,
      })).rejects.toMatchObject(appError('FOLLOW_UP_OVERRIDE_REASON_REQUIRED', 400));

      const approved = await service.approve(manager, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: submitted.version,
        followUp: {
          scheduledAt: PROPOSAL_AT,
          type: 'SALES_MEETING',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Kontrol görüşmesi',
          overrideReason: 'Klinik acil takip istedi.',
        },
      }) as JobCard & { followUpJobCardId: string };

      const approveActivity = await pool.query(
        `SELECT metadata FROM job_card_activity_logs
          WHERE job_card_id = $1 AND event_type = 'JOB_APPROVED'`,
        [job.id],
      );
      expect(approveActivity.rows[0]!.metadata).toMatchObject({
        customerVisitOverrideReason: 'Klinik acil takip istedi.',
      });
      const childActivity = await pool.query(
        `SELECT metadata FROM job_card_activity_logs
          WHERE job_card_id = $1 AND event_type = 'JOB_CREATED'`,
        [approved.followUpJobCardId],
      );
      expect(childActivity.rows[0]!.metadata).toMatchObject({
        sourceJobCardId: job.id,
        customerVisitOverrideReason: 'Klinik acil takip istedi.',
      });
    });
  });

  it('CSI-16: customerless General Tasks skip scheduling evaluation and still require a proposal', async () => {
    await withFixture(async ({ service, manager, staffA, createInProgressJob }) => {
      const job = await createInProgressJob({
        type: 'GENERAL_TASK', title: 'Uzaktan görev', assignedTo: staffA.id, customerId: null,
      });
      const submitted = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Görev tamamlandı.',
        followUpProposal: {
          scheduledAt: PROPOSAL_AT,
          type: 'GENERAL_TASK',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Uzaktan görev',
        },
      });
      const approved = await service.approve(manager, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: submitted.version,
      }) as JobCard & { followUpJobCardId: string };
      const child = await service.detail(manager, approved.followUpJobCardId);
      expect(child).toMatchObject({
        type: 'GENERAL_TASK', customerId: null, contactId: null,
        scheduledAt: PROPOSAL_AT, scheduledEndsAt: null,
      });
    });
  });

  it('legacy WAITING_APPROVAL rows without a proposal require a Manager-supplied one at approval', async () => {
    await withFixture(async ({ service, pool, manager, staffA, organizationId }) => {
      const legacy = await pool.query<{ id: string }>(
        `INSERT INTO job_cards (organization_id, type, status, version, title, assigned_to, created_by,
           started_at, staff_completed_at, staff_completed_by)
         VALUES ($1, 'GENERAL_TASK', 'WAITING_APPROVAL', 2, 'Eski iş', $2, $3, NOW(), NOW(), $2) RETURNING id`,
        [organizationId, staffA.id, manager.id],
      );
      await expect(service.approve(manager, legacy.rows[0]!.id, {
        clientActionId: randomUUID(),
        expectedVersion: 2,
      })).rejects.toMatchObject(appError('FOLLOW_UP_PROPOSAL_REQUIRED', 400));

      const approved = await service.approve(manager, legacy.rows[0]!.id, {
        clientActionId: randomUUID(),
        expectedVersion: 2,
        followUp: {
          scheduledAt: PROPOSAL_AT,
          type: 'GENERAL_TASK',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Eski iş takibi',
        },
      }) as JobCard & { followUpJobCardId: string };
      expect(approved.followUpJobCardId).toBeTypeOf('string');
    });
  });
});
