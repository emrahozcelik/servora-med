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
import { canonicalScheduledEnd } from '../src/modules/job-cards/job-card-duration.js';
import type {
  JobCard,
  JobCardActor,
  JobCardEngagementKind,
  MeetingOutcome,
  UnsuccessfulVisitReasonCode,
  JobCardType,
} from '../src/modules/job-cards/types.js';
import type { RealtimeEventPublisher } from '../src/modules/realtime/event-bus.js';
import type { RealtimeEventRecord } from '../src/modules/realtime/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

const CLOCK = new Date('2026-08-01T10:00:00.000Z');
const PROPOSAL_AT = '2026-08-08T10:00:00.000Z';

function withUserLockHold(pool: Pool): {
  waitForFirstLock: () => Promise<void>;
  waitForContenderLock: () => Promise<void>;
  release: () => void;
} {
  let firstLockArrived!: () => void;
  const firstLockReady = new Promise<void>((resolve) => { firstLockArrived = resolve; });
  let contenderLockArrived!: () => void;
  const contenderLockReady = new Promise<void>((resolve) => { contenderLockArrived = resolve; });
  let releaseLock!: () => void;
  const lockReleased = new Promise<void>((resolve) => { releaseLock = resolve; });
  let userLockCount = 0;

  const originalConnect = pool.connect.bind(pool);
  pool.connect = (...args: unknown[]) => {
    const last = args[args.length - 1];
    if (typeof last === 'function') {
      const callback = args.pop() as (
        error: Error | null,
        client?: unknown,
        release?: () => void,
      ) => void;
      originalConnect(...args, (error: Error | null, client?: unknown, release?: () => void) => {
        if (error) return callback(error);
        callback(null, client ? wrapClient(client) : client, release);
      });
      return;
    }
    return originalConnect(...args).then((client: unknown) => wrapClient(client));
  };

  function wrapClient(client: any): any {
    const originalQuery = client.query.bind(client);
    client.query = (...queryArgs: unknown[]) => {
      const text = typeof queryArgs[0] === 'string'
        ? queryArgs[0]
        : (queryArgs[0] as { text?: string } | undefined)?.text;
      if (text?.includes('FROM users') && text.includes('FOR UPDATE')) {
        userLockCount += 1;
        if (userLockCount === 1) {
          return Promise.resolve(originalQuery(...queryArgs)).then((result) => {
            firstLockArrived();
            return lockReleased.then(() => result);
          });
        }
        if (userLockCount === 2) contenderLockArrived();
      }
      return originalQuery(...queryArgs);
    };
    return client;
  }

  return {
    waitForFirstLock: () => firstLockReady,
    waitForContenderLock: () => contenderLockReady,
    release: () => releaseLock(),
  };
}

type Fixture = {
  pool: Pool;
  service: JobCardService;
  calendar: CalendarService;
  published: RealtimeEventRecord[];
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
    engagementKind?: JobCardEngagementKind;
    outcome?: MeetingOutcome;
    unsuccessfulReason?: UnsuccessfulVisitReasonCode | null;
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
    const service = new JobCardService(
      repository,
      () => CLOCK,
      publisher,
      undefined,
      undefined,
      { enabled: true, reminderLeadMinutes: 30 },
    );
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
      const engagementKind = type === 'SALES_MEETING'
        ? input.engagementKind ?? 'CUSTOMER_VISIT'
        : undefined;
      const scheduledAt = input.scheduledAt === undefined ? '2026-08-01T10:00:00.000Z' : input.scheduledAt;
      const scheduledEndsAt = scheduledAt === null
        ? null
        : canonicalScheduledEnd(type, scheduledAt);
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
        scheduledEndsAt: type === 'GENERAL_TASK' ? undefined : scheduledEndsAt,
        engagementKind,
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
        const outcome = input.outcome
          ?? (engagementKind === 'CUSTOMER_VISIT' ? 'FOLLOW_UP_REQUIRED' : 'POSITIVE');
        const unsuccessfulReason = outcome === 'FOLLOW_UP_REQUIRED'
          ? input.unsuccessfulReason ?? 'REQUESTED_LATER'
          : null;
        const details = await service.patchMeetingDetails(staffA, job.id, {
          clientActionId: randomUUID(),
          expectedVersion: started.version,
          meetingAt: '2026-08-01T09:30:00.000Z',
          outcome,
          unsuccessfulReason,
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
      published,
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
  it('D1-1: CUSTOMER_VISIT still rejects a Staff submission without a follow-up proposal', async () => {
    await withFixture(async ({ service, staffA, createInProgressJob }) => {
      const job = await createInProgressJob({
        type: 'SALES_MEETING',
        engagementKind: 'CUSTOMER_VISIT',
        title: 'Klinik ziyareti',
        assignedTo: staffA.id,
      });
      await expect(service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Ziyaret tamamlandı.',
      })).rejects.toMatchObject(appError('FOLLOW_UP_PROPOSAL_REQUIRED', 400));
      const after = await service.detail(staffA, job.id);
      expect(after.status).toBe('IN_PROGRESS');
    });
  });

  it('D1-2: Product Delivery submits and approves without a follow-up proposal', async () => {
    await withFixture(async ({ service, manager, staffA, createInProgressJob }) => {
      const job = await createInProgressJob({
        type: 'PRODUCT_DELIVERY', title: 'Teslim', assignedTo: staffA.id,
      });
      const submitted = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Teslim tamamlandı.',
      });
      expect(submitted.status).toBe('WAITING_APPROVAL');
      expect(submitted.followUpProposal).toBeNull();

      const approved = await service.approve(manager, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: submitted.version,
      });
      expect(approved.status).toBe('COMPLETED');
      expect(approved.followUpProposal).toBeNull();
    });
  });

  it('D1-3/D1-8: non-visit Sales Meeting kinds submit without recursive proposal requirements', async () => {
    await withFixture(async ({ service, manager, staffA, createInProgressJob }) => {
      for (const [index, engagementKind] of [
        'TRAINING', 'PRODUCT_DEMO', 'SALES_MEETING', 'FOLLOW_UP', 'OTHER',
      ].entries() as IterableIterator<[number, JobCardEngagementKind]>) {
        const scheduledAt = new Date('2026-07-31T10:00:00.000Z');
        scheduledAt.setUTCDate(scheduledAt.getUTCDate() - index);
        const job = await createInProgressJob({
          type: 'SALES_MEETING',
          engagementKind,
          title: `${engagementKind} işi`,
          assignedTo: staffA.id,
          scheduledAt: scheduledAt.toISOString(),
        });
        const submitted = await service.submitForApproval(staffA, job.id, {
          clientActionId: randomUUID(),
          expectedVersion: job.version,
          note: `${engagementKind} tamamlandı.`,
        });
        expect(submitted.status).toBe('WAITING_APPROVAL');
        expect(submitted.followUpProposal).toBeNull();

        const approved = await service.approve(manager, job.id, {
          clientActionId: randomUUID(),
          expectedVersion: submitted.version,
        });
        expect(approved.status).toBe('COMPLETED');
        expect(approved.followUpProposal).toBeNull();
      }
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

  it('D1-16: rejects a new non-visit workflow proposal write before assignee validation', async () => {
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
      })).rejects.toMatchObject(appError('FOLLOW_UP_PROPOSAL_INVALID', 400));
    });
  });

  it('D1-16: rejects a non-visit Sales Meeting workflow proposal write', async () => {
    await withFixture(async ({ service, staffA, createInProgressJob }) => {
      const job = await createInProgressJob({
        type: 'SALES_MEETING',
        engagementKind: 'TRAINING',
        title: 'Eğitim görüşmesi',
        assignedTo: staffA.id,
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
      })).rejects.toMatchObject(appError('FOLLOW_UP_PROPOSAL_INVALID', 400));
      const after = await service.detail(staffA, job.id);
      expect(after.status).toBe('IN_PROGRESS');
      expect(after.followUpProposal).toBeNull();
    });
  });

  it('D1-16: rejects a Product Delivery workflow proposal write', async () => {
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
      })).rejects.toMatchObject(appError('FOLLOW_UP_PROPOSAL_INVALID', 400));
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
      service, calendar, manager, staffA, createInProgressJob, customerId, pool, published,
    }) => {
      const job = await createInProgressJob({
        type: 'SALES_MEETING',
        engagementKind: 'CUSTOMER_VISIT',
        title: 'Ziyaret',
        assignedTo: staffA.id,
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
        status: 'ACCEPTED',
        type: 'SALES_MEETING',
        customerId,
        scheduledAt: PROPOSAL_AT,
        scheduledEndsAt: '2026-08-08T11:00:00.000Z',
        engagementKind: 'FOLLOW_UP',
      });
      expect(child.workflowContext.lifecycle).toMatchObject({
        acceptedAt: CLOCK.toISOString(),
        acceptedBy: { id: staffA.id, name: 'Staff A' },
      });
      expect(child.followUpContext).toMatchObject({
        sourceJobCardId: job.id,
        followUpInstructions: 'Takip: Klinik ile karar durumunu teyit edin.',
      });
      expect(published.find((event) => event.entityId === child.id)).toMatchObject({
        type: 'job.created',
        entityType: 'job-card',
      });
      expect((await pool.query(
        `SELECT kind, recipient_user_id FROM in_app_notifications WHERE entity_id = $1`,
        [child.id],
      )).rows).toEqual([
        expect.objectContaining({ kind: 'job.assigned', recipient_user_id: staffA.id }),
      ]);

      const calendarItems = await calendar.list(manager, {
        from: '2026-08-08T00:00:00.000Z',
        to: '2026-08-09T00:00:00.000Z',
        assignedTo: null,
      });
      expect(calendarItems.items.map((item) => item.id)).toContain(child.id);

      const activity = await service.listActivity(manager, job.id, { limit: 50, offset: 0 });
      const approveActivity = activity.items.find((item) => item.eventType === 'JOB_APPROVED');
      expect(approveActivity).toMatchObject({ actor: { id: manager.id, name: 'Manager' } });
    });
  });

  it('FUP-M14/M10: replays return the original child and never create a second one', async () => {
    await withFixture(async ({ service, manager, staffA, createInProgressJob }) => {
      const job = await createInProgressJob({
        type: 'SALES_MEETING',
        engagementKind: 'CUSTOMER_VISIT',
        title: 'Ziyaret',
        assignedTo: staffA.id,
      });
      const submitted = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Görev tamamlandı.',
        followUpProposal: {
          scheduledAt: PROPOSAL_AT,
          type: 'SALES_MEETING',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Görev',
        },
      });
      const approveId = randomUUID();
      const first = await service.approve(manager, job.id, {
        clientActionId: approveId,
        expectedVersion: submitted.version,
      }) as JobCard & { followUpJobCardId: string };
      const childBeforeReplay = await service.detail(manager, first.followUpJobCardId);
      const second = await service.approve(manager, job.id, {
        clientActionId: approveId,
        expectedVersion: submitted.version,
      }) as JobCard & { followUpJobCardId: string };
      const childAfterReplay = await service.detail(manager, second.followUpJobCardId);
      expect(second).toEqual(first);
      expect(childAfterReplay.workflowContext.lifecycle).toEqual(
        childBeforeReplay.workflowContext.lifecycle,
      );
      expect(childAfterReplay).toMatchObject({ status: 'ACCEPTED' });
      const children = await service.listFollowUps(manager, job.id, { limit: 10, offset: 0 });
      expect(children.total).toBe(1);
    });
  });

  it('D4-FUP-AVAILABILITY: approval rejects an assignee overlap and rolls back the child', async () => {
    await withFixture(async ({
      service, pool, manager, staffA, organizationId, customerId, createInProgressJob,
    }) => {
      const otherCustomerId = (await pool.query<{ id: string }>(
        `INSERT INTO customers (organization_id, name, customer_type, status)
         VALUES ($1, 'Başka Klinik', 'clinic', 'active') RETURNING id`,
        [organizationId],
      )).rows[0]!.id;
      await pool.query(
        `INSERT INTO job_cards (
           organization_id, type, status, title, customer_id, assigned_to, created_by,
           scheduled_at, scheduled_ends_at, engagement_kind
         ) VALUES ($1, 'SALES_MEETING', 'NEW', 'Çakışan iş', $2, $3, $4, $5, $6, 'SALES_MEETING')`,
        [
          organizationId,
          otherCustomerId,
          staffA.id,
          manager.id,
          PROPOSAL_AT,
          '2026-08-08T11:00:00.000Z',
        ],
      );
      const job = await createInProgressJob({
        type: 'SALES_MEETING',
        engagementKind: 'CUSTOMER_VISIT',
        title: 'Ziyaret',
        assignedTo: staffA.id,
      });
      const submitted = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Görüşme tamamlandı.',
        followUpProposal: {
          scheduledAt: PROPOSAL_AT,
          type: 'SALES_MEETING',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Çakışma kontrolü.',
        },
      });

      await expect(service.approve(manager, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: submitted.version,
      })).rejects.toMatchObject(appError('CALENDAR_CONFLICT', 409));

      await expect(service.detail(manager, job.id)).resolves.toMatchObject({
        status: 'WAITING_APPROVAL',
        version: submitted.version,
        customerId,
      });
      const children = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM job_cards WHERE source_job_card_id = $1`,
        [job.id],
      );
      expect(children.rows[0]!.count).toBe('0');
    });
  });

  it('D4-C1: approval serializes against a normal interval create for the same assignee', async () => {
    await withFixture(async ({
      service, pool, manager, staffA, organizationId, customerId, createInProgressJob,
    }) => {
      const otherCustomerId = (await pool.query<{ id: string }>(
        `INSERT INTO customers (organization_id, name, customer_type, status)
         VALUES ($1, 'Başka Klinik', 'clinic', 'active') RETURNING id`,
        [organizationId],
      )).rows[0]!.id;
      const job = await createInProgressJob({
        type: 'SALES_MEETING',
        engagementKind: 'CUSTOMER_VISIT',
        title: 'Ziyaret',
        assignedTo: staffA.id,
      });
      const submitted = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Görüşme tamamlandı.',
        followUpProposal: {
          scheduledAt: PROPOSAL_AT,
          type: 'SALES_MEETING',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Seri hale getirme.',
        },
      });
      const barrier = withUserLockHold(pool);
      try {
        const approval = service.approve(manager, job.id, {
          clientActionId: randomUUID(),
          expectedVersion: submitted.version,
        });
        await barrier.waitForFirstLock();
        const create = service.create(manager, {
          clientActionId: randomUUID(),
          type: 'SALES_MEETING',
          title: 'Rakip görüşme',
          description: null,
          customerId: otherCustomerId,
          contactId: null,
          assignedTo: staffA.id,
          priority: 'normal',
          dueDate: null,
          scheduledAt: PROPOSAL_AT,
          scheduledEndsAt: '2026-08-08T11:00:00.000Z',
          engagementKind: 'SALES_MEETING',
        });
        await barrier.waitForContenderLock();
        barrier.release();

        const results = await Promise.allSettled([approval, create]);
        expect(results[0]).toMatchObject({ status: 'fulfilled' });
        expect(results[1]).toMatchObject({
          status: 'rejected',
          reason: { code: 'CALENDAR_CONFLICT', statusCode: 409 },
        });
        const commitments = await pool.query<{ total: string }>(
          `SELECT COUNT(*)::text AS total FROM job_cards
           WHERE organization_id = $1 AND assigned_to = $2
             AND scheduled_at < $3 AND $4 < scheduled_ends_at
             AND status NOT IN ('COMPLETED', 'CANCELLED')`,
          [organizationId, staffA.id, '2026-08-08T11:00:00.000Z', PROPOSAL_AT],
        );
        expect(commitments.rows[0]!.total).toBe('1');
        await expect(service.detail(manager, job.id)).resolves.toMatchObject({
          status: 'COMPLETED',
          customerId,
        });
      } finally {
        barrier.release();
      }
    });
  });

  it('D4-C2: approval serializes against a MANUAL interval create for the same assignee', async () => {
    await withFixture(async ({ service, pool, manager, staffA, createInProgressJob }) => {
      const job = await createInProgressJob({
        type: 'SALES_MEETING',
        engagementKind: 'CUSTOMER_VISIT',
        title: 'Ziyaret',
        assignedTo: staffA.id,
      });
      const submitted = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Görüşme tamamlandı.',
        followUpProposal: {
          scheduledAt: PROPOSAL_AT,
          type: 'SALES_MEETING',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Manuel seri hale getirme.',
        },
      });
      const calendar = new CalendarService(
        true,
        new PostgresCalendarRepository(pool),
        () => CLOCK,
      );
      const barrier = withUserLockHold(pool);
      try {
        const approval = service.approve(manager, job.id, {
          clientActionId: randomUUID(),
          expectedVersion: submitted.version,
        });
        await barrier.waitForFirstLock();
        const manual = calendar.create(manager, {
          clientActionId: randomUUID(),
          assignedUserId: staffA.id,
          title: 'Rakip manuel plan',
          description: null,
          startsAt: PROPOSAL_AT,
          endsAt: '2026-08-08T11:00:00.000Z',
          timezone: 'Europe/Istanbul',
        });
        await barrier.waitForContenderLock();
        barrier.release();

        const results = await Promise.allSettled([approval, manual]);
        expect(results[0]).toMatchObject({ status: 'fulfilled' });
        expect(results[1]).toMatchObject({
          status: 'rejected',
          reason: { code: 'CALENDAR_CONFLICT', statusCode: 409 },
        });
        const commitments = await pool.query<{ total: string }>(
          `SELECT (
             SELECT COUNT(*) FROM job_cards
              WHERE organization_id = $1 AND assigned_to = $2
                AND scheduled_at < $3 AND $4 < scheduled_ends_at
                AND status NOT IN ('COMPLETED', 'CANCELLED')
           ) + (
             SELECT COUNT(*) FROM calendar_events
              WHERE organization_id = $1 AND assigned_user_id = $2
                AND starts_at < $3 AND $4 < ends_at AND status = 'ACTIVE'
           ) AS total`,
          [manager.organizationId, staffA.id, '2026-08-08T11:00:00.000Z', PROPOSAL_AT],
        );
        expect(commitments.rows[0]!.total).toBe('1');
      } finally {
        barrier.release();
      }
    });
  });

  it('D2-9/10: auto-accepted future children cannot start early but start at exact scheduledAt', async () => {
    await withFixture(async ({ service, pool, manager, staffA, createInProgressJob }) => {
      const job = await createInProgressJob({
        type: 'SALES_MEETING',
        engagementKind: 'CUSTOMER_VISIT',
        title: 'Ziyaret',
        assignedTo: staffA.id,
      });
      const submitted = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Görüşme tamamlandı.',
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
      const child = await service.detail(staffA, approved.followUpJobCardId);

      await expect(service.start(staffA, child.id, {
        clientActionId: randomUUID(),
        expectedVersion: child.version,
      })).rejects.toMatchObject({ code: 'INVALID_TRANSITION', statusCode: 409 });
      await expect(service.detail(staffA, child.id)).resolves.toMatchObject({
        status: 'ACCEPTED',
        version: child.version,
        workflowContext: { allowedCommands: ['CANCEL'] },
      });

      const atScheduledTime = new JobCardService(
        new PostgresJobCardRepository(pool),
        () => new Date(PROPOSAL_AT),
      );
      await expect(atScheduledTime.start(staffA, child.id, {
        clientActionId: randomUUID(),
        expectedVersion: child.version,
      })).resolves.toMatchObject({ status: 'IN_PROGRESS', version: child.version + 1 });
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
        type: 'SALES_MEETING',
        engagementKind: 'CUSTOMER_VISIT',
        title: 'Ziyaret',
        assignedTo: staffA.id,
      });
      const submitted = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Görev tamamlandı.',
        followUpProposal: {
          scheduledAt: PROPOSAL_AT,
          type: 'SALES_MEETING',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Görev',
        },
      });
      const approved = await service.approve(manager, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: submitted.version,
        followUp: {
          scheduledAt: PROPOSAL_AT,
          type: 'SALES_MEETING',
          assignedTo: staffB.id,
          followUpInstructions: 'Takip: Görev',
        },
      }) as JobCard & { followUpJobCardId: string };
      const child = await service.detail(manager, approved.followUpJobCardId);
      expect(child).toMatchObject({ assignedTo: staffB.id, status: 'NEW' });
      expect(child.workflowContext.lifecycle).toMatchObject({
        acceptedAt: null,
        acceptedBy: null,
      });
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

  it('D1-4/CSI-16: customerless General Tasks submit and approve without a proposal', async () => {
    await withFixture(async ({ service, manager, staffA, createInProgressJob }) => {
      const job = await createInProgressJob({
        type: 'GENERAL_TASK', title: 'Uzaktan görev', assignedTo: staffA.id, customerId: null,
      });
      const submitted = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Görev tamamlandı.',
      });
      expect(submitted.followUpProposal).toBeNull();
      const approved = await service.approve(manager, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: submitted.version,
      });
      expect(approved.status).toBe('COMPLETED');
      expect(approved.followUpProposal).toBeNull();
    });
  });

  it('D1-15: legacy non-visit approval rows remain resolvable with and without persisted proposals', async () => {
    await withFixture(async ({ service, pool, manager, staffA, organizationId }) => {
      const noProposal = await pool.query<{ id: string }>(
        `INSERT INTO job_cards (organization_id, type, status, version, title, assigned_to, created_by,
           started_at, staff_completed_at, staff_completed_by)
         VALUES ($1, 'GENERAL_TASK', 'WAITING_APPROVAL', 2, 'Eski iş', $2, $3, NOW(), NOW(), $2) RETURNING id`,
        [organizationId, staffA.id, manager.id],
      );
      const approvedWithoutProposal = await service.approve(manager, noProposal.rows[0]!.id, {
        clientActionId: randomUUID(),
        expectedVersion: 2,
      });
      expect(approvedWithoutProposal.status).toBe('COMPLETED');
      expect(approvedWithoutProposal.followUpProposal).toBeNull();
      expect((approvedWithoutProposal as JobCard & { followUpJobCardId?: string }).followUpJobCardId)
        .toBeUndefined();

      const persistedProposal = await pool.query<{ id: string }>(
        `INSERT INTO job_cards (
           organization_id, type, status, version, title, assigned_to, created_by,
           started_at, staff_completed_at, staff_completed_by,
           follow_up_proposed_at, follow_up_proposed_type, follow_up_proposed_assignee,
           follow_up_proposal_instructions, follow_up_proposal_origin, follow_up_proposed_by
         )
         VALUES ($1, 'GENERAL_TASK', 'WAITING_APPROVAL', 2, 'Eski teklifli iş', $2, $3,
           NOW(), NOW(), $2, $4, 'GENERAL_TASK', $2, 'Takip: Eski iş takibi', 'SYSTEM', $3)
         RETURNING id`,
        [organizationId, staffA.id, manager.id, PROPOSAL_AT],
      );
      const approvedWithProposal = await service.approve(manager, persistedProposal.rows[0]!.id, {
        clientActionId: randomUUID(),
        expectedVersion: 2,
      }) as JobCard & { followUpJobCardId: string };
      expect(approvedWithProposal.followUpJobCardId).toBeTypeOf('string');
      const child = await service.detail(manager, approvedWithProposal.followUpJobCardId);
      expect(child).toMatchObject({
        type: 'GENERAL_TASK',
        scheduledAt: PROPOSAL_AT,
      });
      expect(child.followUpContext).toMatchObject({
        sourceJobCardId: persistedProposal.rows[0]!.id,
      });
    });
  });

  it('keeps a legacy near-term persisted proposal valid under the new lead policy', async () => {
    await withFixture(async ({ service, pool, manager, staffA, organizationId }) => {
      const legacyScheduledAt = '2026-08-01T10:05:00.000Z';
      const persisted = await pool.query<{ id: string }>(
        `INSERT INTO job_cards (
           organization_id, type, status, version, title, assigned_to, created_by,
           started_at, staff_completed_at, staff_completed_by,
           follow_up_proposed_at, follow_up_proposed_type, follow_up_proposed_assignee,
           follow_up_proposal_instructions, follow_up_proposal_origin, follow_up_proposed_by
         )
         VALUES ($1, 'GENERAL_TASK', 'WAITING_APPROVAL', 2, 'Eski yakın tarihli teklif', $2, $3,
           NOW(), NOW(), $2, $4, 'GENERAL_TASK', $2, 'Takip: Eski iş', 'SYSTEM', $3)
         RETURNING id`,
        [organizationId, staffA.id, manager.id, legacyScheduledAt],
      );

      const approved = await service.approve(manager, persisted.rows[0]!.id, {
        clientActionId: randomUUID(), expectedVersion: 2,
      }) as JobCard & { followUpJobCardId: string };
      const child = await service.detail(manager, approved.followUpJobCardId);
      expect(child.scheduledAt).toBe(legacyScheduledAt);
    });
  });

  it('R2-AP-1: approval without priority/dueDate defaults the child to normal/null (backward compat)', async () => {
    await withFixture(async ({ service, manager, staffA, createInProgressJob }) => {
      const job = await createInProgressJob({
        type: 'SALES_MEETING', engagementKind: 'CUSTOMER_VISIT', title: 'Ziyaret', assignedTo: staffA.id,
      });
      const submitted = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Tamamlandı.',
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
      const child = await service.detail(manager, approved.followUpJobCardId);
      expect(child).toMatchObject({ priority: 'normal', dueDate: null });
    });
  });

  it('R2-AP-2: approval priority override lands on the child and same-assignee stays ACCEPTED', async () => {
    await withFixture(async ({ service, manager, staffA, createInProgressJob }) => {
      const job = await createInProgressJob({
        type: 'SALES_MEETING', engagementKind: 'CUSTOMER_VISIT', title: 'Ziyaret', assignedTo: staffA.id,
      });
      const submitted = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Tamamlandı.',
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
        followUp: {
          scheduledAt: PROPOSAL_AT,
          type: 'SALES_MEETING',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Klinik ile karar durumunu teyit edin.',
          priority: 'urgent',
        },
      }) as JobCard & { followUpJobCardId: string };
      const child = await service.detail(manager, approved.followUpJobCardId);
      expect(child).toMatchObject({ priority: 'urgent', dueDate: null, status: 'ACCEPTED' });
      expect(child.workflowContext.lifecycle).toMatchObject({
        acceptedAt: CLOCK.toISOString(),
        acceptedBy: { id: staffA.id, name: 'Staff A' },
      });
    });
  });

  it('R2-AP-3: approval priority/dueDate override lands on a GENERAL_TASK child (legacy persisted proposal)', async () => {
    await withFixture(async ({ service, pool, manager, staffA, organizationId }) => {
      const job = await pool.query<{ id: string }>(
        `INSERT INTO job_cards (
           organization_id, type, status, version, title, assigned_to, created_by,
           started_at, staff_completed_at, staff_completed_by,
           follow_up_proposed_at, follow_up_proposed_type, follow_up_proposed_assignee,
           follow_up_proposal_instructions, follow_up_proposal_origin, follow_up_proposed_by
         )
         VALUES ($1, 'GENERAL_TASK', 'WAITING_APPROVAL', 2, 'Eski teklifli iş', $2, $3,
           NOW(), NOW(), $2, $4, 'GENERAL_TASK', $2, 'Takip: Eski iş takibi', 'SYSTEM', $3)
         RETURNING id`,
        [organizationId, staffA.id, manager.id, PROPOSAL_AT],
      );
      const approved = await service.approve(manager, job.rows[0]!.id, {
        clientActionId: randomUUID(),
        expectedVersion: 2,
        followUp: {
          scheduledAt: PROPOSAL_AT,
          type: 'GENERAL_TASK',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Eski iş takibi',
          priority: 'urgent',
          dueDate: '2026-09-15',
        },
      }) as JobCard & { followUpJobCardId: string };
      const child = await service.detail(manager, approved.followUpJobCardId);
      expect(child).toMatchObject({
        type: 'GENERAL_TASK',
        priority: 'urgent',
        dueDate: '2026-09-15',
      });
    });
  });

  it('R2-AP-4: approval rejects a non-null dueDate for a SALES_MEETING child', async () => {
    await withFixture(async ({ service, manager, staffA, createInProgressJob }) => {
      const job = await createInProgressJob({
        type: 'SALES_MEETING', engagementKind: 'CUSTOMER_VISIT', title: 'Ziyaret', assignedTo: staffA.id,
      });
      const submitted = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Tamamlandı.',
        followUpProposal: {
          scheduledAt: PROPOSAL_AT,
          type: 'SALES_MEETING',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Klinik ile karar durumunu teyit edin.',
        },
      });
      await expect(service.approve(manager, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: submitted.version,
        followUp: {
          scheduledAt: PROPOSAL_AT,
          type: 'SALES_MEETING',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Klinik ile karar durumunu teyit edin.',
          dueDate: '2026-09-15',
        },
      })).rejects.toMatchObject(appError('VALIDATION_ERROR', 400));
    });
  });

  it('R2-AP-5: approval rejects an invalid priority value', async () => {
    await withFixture(async ({ service, manager, staffA, createInProgressJob }) => {
      const job = await createInProgressJob({
        type: 'SALES_MEETING', engagementKind: 'CUSTOMER_VISIT', title: 'Ziyaret', assignedTo: staffA.id,
      });
      const submitted = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Tamamlandı.',
        followUpProposal: {
          scheduledAt: PROPOSAL_AT,
          type: 'SALES_MEETING',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Klinik ile karar durumunu teyit edin.',
        },
      });
      await expect(service.approve(manager, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: submitted.version,
        followUp: {
          scheduledAt: PROPOSAL_AT,
          type: 'SALES_MEETING',
          assignedTo: staffA.id,
          followUpInstructions: 'Takip: Klinik ile karar durumunu teyit edin.',
          priority: 'bogus' as never,
        },
      })).rejects.toMatchObject(appError('VALIDATION_ERROR', 400));
    });
  });

  it('R2-AP-6: different-assignee approval stays NEW with priority override applied', async () => {
    await withFixture(async ({ service, manager, staffA, staffB, createInProgressJob }) => {
      const job = await createInProgressJob({
        type: 'SALES_MEETING', engagementKind: 'CUSTOMER_VISIT', title: 'Ziyaret', assignedTo: staffA.id,
      });
      const submitted = await service.submitForApproval(staffA, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        note: 'Tamamlandı.',
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
        followUp: {
          scheduledAt: PROPOSAL_AT,
          type: 'SALES_MEETING',
          assignedTo: staffB.id,
          followUpInstructions: 'Takip: Klinik ile karar durumunu teyit edin.',
          priority: 'high',
        },
      }) as JobCard & { followUpJobCardId: string };
      const child = await service.detail(manager, approved.followUpJobCardId);
      expect(child).toMatchObject({ priority: 'high', dueDate: null, status: 'NEW' });
      expect(child.workflowContext.lifecycle).toMatchObject({ acceptedAt: null, acceptedBy: null });
    });
  });
});
