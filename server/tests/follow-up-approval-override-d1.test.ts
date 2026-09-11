import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type {
  JobCard,
  JobCardActor,
} from '../src/modules/job-cards/types.js';
import type { RealtimeEventPublisher } from '../src/modules/realtime/event-bus.js';
import type { RealtimeEventRecord } from '../src/modules/realtime/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

const CLOCK = new Date('2026-08-01T10:00:00.000Z');
const PROPOSAL_AT = '2026-08-08T10:00:00.000Z';
const EXPLICIT_AT = '2026-08-09T10:00:00.000Z';
const STAFF_ADJUSTED_AT = '2026-08-10T10:00:00.000Z';

type Fixture = {
  pool: Pool;
  service: JobCardService;
  published: RealtimeEventRecord[];
  organizationId: string;
  manager: JobCardActor;
  staffA: JobCardActor;
  staffB: JobCardActor;
  customerId: string;
  defaultInstructions: string;
  submitSystemProposal(input: {
    title?: string;
    assignedTo?: string;
  }): Promise<JobCard>;
  submitExplicitProposal(input: {
    title?: string;
    scheduledAt?: string;
    instructions?: string;
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
  const schema = `follow_up_approve_d1_${randomUUID().replaceAll('-', '')}`;
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
       VALUES ('D1 approval overrides', 'Europe/Istanbul') RETURNING id`,
    )).rows[0]!.id;
    const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Manager');
    const staffAId = await insertUser(pool, organizationId, 'STAFF', 'Staff A');
    const staffBId = await insertUser(pool, organizationId, 'STAFF', 'Staff B');

    const customerId = (await pool.query<{ id: string }>(
      `INSERT INTO customers (organization_id, name, customer_type, status)
       VALUES ($1, 'Dünya Klinik', 'clinic', 'active') RETURNING id`,
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
    const manager: JobCardActor = { id: managerId, organizationId, role: 'MANAGER' };
    const staffA: JobCardActor = { id: staffAId, organizationId, role: 'STAFF' };
    const staffB: JobCardActor = { id: staffBId, organizationId, role: 'STAFF' };

    const submitSystemProposal: Fixture['submitSystemProposal'] = async (input = {}) => {
      const title = input.title ?? 'Klinik ziyareti';
      const assignedTo = input.assignedTo ?? staffA.id;
      const created = await service.create(staffA, {
        clientActionId: randomUUID(),
        type: 'SALES_MEETING',
        title,
        description: null,
        customerId,
        contactId: null,
        assignedTo,
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
      await service.patchMeetingDetails(staffA, created.id, {
        clientActionId: randomUUID(),
        expectedVersion: started.version,
        meetingAt: '2026-08-01T09:30:00.000Z',
        outcome: 'FOLLOW_UP_REQUIRED',
        unsuccessfulReason: 'REQUESTED_LATER',
        meetingSummary: 'Görüşme tamamlandı.',
      });
      const inProgress = await service.detail(staffA, created.id) as unknown as JobCard;
      // scheduledAt omitted => server auto-schedules and persists a SYSTEM proposal.
      const submitted = await service.submitForApproval(staffA, created.id, {
        clientActionId: randomUUID(),
        expectedVersion: inProgress.version,
        note: 'Görüşme tamamlandı.',
      });
      expect(submitted.followUpProposal).toMatchObject({ origin: 'SYSTEM' });
      return submitted as unknown as JobCard;
    };

    const submitExplicitProposal: Fixture['submitExplicitProposal'] = async (input = {}) => {
      const title = input.title ?? 'Klinik ziyareti';
      const created = await service.create(staffA, {
        clientActionId: randomUUID(),
        type: 'SALES_MEETING',
        title,
        description: null,
        customerId,
        contactId: null,
        assignedTo: staffA.id,
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
      await service.patchMeetingDetails(staffA, created.id, {
        clientActionId: randomUUID(),
        expectedVersion: started.version,
        meetingAt: '2026-08-01T09:30:00.000Z',
        outcome: 'FOLLOW_UP_REQUIRED',
        unsuccessfulReason: 'REQUESTED_LATER',
        meetingSummary: 'Görüşme tamamlandı.',
      });
      const inProgress = await service.detail(staffA, created.id) as unknown as JobCard;
      // Explicit schedule => server persists a STAFF_ADJUSTED proposal.
      const submitted = await service.submitForApproval(staffA, created.id, {
        clientActionId: randomUUID(),
        expectedVersion: inProgress.version,
        note: 'Görüşme tamamlandı.',
        followUpProposal: {
          scheduledAt: input.scheduledAt ?? STAFF_ADJUSTED_AT,
          type: 'SALES_MEETING',
          assignedTo: staffA.id,
          followUpInstructions: input.instructions ?? 'Takip: Klinik ziyareti',
        },
      });
      expect(submitted.followUpProposal).toMatchObject({ origin: 'STAFF_ADJUSTED' });
      return submitted as unknown as JobCard;
    };

    await run({
      pool,
      service,
      published,
      organizationId,
      manager,
      staffA,
      staffB,
      customerId,
      defaultInstructions: 'Takip: Klinik ziyareti',
      submitSystemProposal,
      submitExplicitProposal,
    });
  } finally {
    await pool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }
}

type ApprovedChild = JobCard & { followUpJobCardId: string };

const appError = (code: string, statusCode: number) => expect.objectContaining({ code, statusCode });

describe.skipIf(!databaseUrl)('D1: SYSTEM follow-up proposal approval overrides', () => {
  it('D1-1: omitted schedule + changed assignee honors the new assignee while auto-scheduling', async () => {
    await withFixture(async ({ service, manager, staffA, staffB, defaultInstructions, submitSystemProposal }) => {
      const submitted = await submitSystemProposal();
      const approved = await service.approve(manager, submitted.id, {
        clientActionId: randomUUID(),
        expectedVersion: submitted.version,
        followUp: {
          type: 'SALES_MEETING',
          assignedTo: staffB.id,
          followUpInstructions: defaultInstructions,
        },
      }) as ApprovedChild;

      const child = await service.detail(manager, approved.followUpJobCardId);
      expect(child).toMatchObject({
        assignedTo: staffB.id,
        type: 'SALES_MEETING',
        scheduledAt: PROPOSAL_AT,
        scheduledEndsAt: '2026-08-08T11:00:00.000Z',
        status: 'NEW',
      });
      expect(child.followUpContext).toMatchObject({
        sourceJobCardId: submitted.id,
        followUpInstructions: defaultInstructions,
      });
      expect(staffA.id).not.toBe(staffB.id);
    });
  });

  it('D1-2: omitted schedule + changed instructions honors the new instructions while auto-scheduling', async () => {
    await withFixture(async ({ service, manager, staffA, submitSystemProposal }) => {
      const submitted = await submitSystemProposal();
      const approved = await service.approve(manager, submitted.id, {
        clientActionId: randomUUID(),
        expectedVersion: submitted.version,
        followUp: {
          type: 'SALES_MEETING',
          assignedTo: staffA.id,
          followUpInstructions: 'Yönetici revizyonu: karar vericiyle yeniden görüşün.',
        },
      }) as ApprovedChild;

      const child = await service.detail(manager, approved.followUpJobCardId);
      expect(child).toMatchObject({
        assignedTo: staffA.id,
        scheduledAt: PROPOSAL_AT,
        status: 'ACCEPTED',
      });
      expect(child.followUpContext).toMatchObject({
        sourceJobCardId: submitted.id,
        followUpInstructions: 'Yönetici revizyonu: karar vericiyle yeniden görüşün.',
      });
    });
  });

  it('D1-3: omitted schedule + changed assignee and instructions honors both', async () => {
    await withFixture(async ({ service, manager, staffB, submitSystemProposal }) => {
      const submitted = await submitSystemProposal();
      const approved = await service.approve(manager, submitted.id, {
        clientActionId: randomUUID(),
        expectedVersion: submitted.version,
        followUp: {
          type: 'SALES_MEETING',
          assignedTo: staffB.id,
          followUpInstructions: 'Yönetici revizyonu: sabah erken arayın.',
        },
      }) as ApprovedChild;

      const child = await service.detail(manager, approved.followUpJobCardId);
      expect(child).toMatchObject({
        assignedTo: staffB.id,
        scheduledAt: PROPOSAL_AT,
        scheduledEndsAt: '2026-08-08T11:00:00.000Z',
        status: 'NEW',
      });
      expect(child.followUpContext).toMatchObject({
        followUpInstructions: 'Yönetici revizyonu: sabah erken arayın.',
      });
    });
  });

  it('D1-4: the automatic slot stays server-selected with canonical duration', async () => {
    await withFixture(async ({ service, manager, staffB, defaultInstructions, submitSystemProposal }) => {
      const submitted = await submitSystemProposal();
      const approved = await service.approve(manager, submitted.id, {
        clientActionId: randomUUID(),
        expectedVersion: submitted.version,
        followUp: {
          type: 'SALES_MEETING',
          assignedTo: staffB.id,
          followUpInstructions: defaultInstructions,
        },
      }) as ApprovedChild;

      const child = await service.detail(manager, approved.followUpJobCardId);
      // The caller supplied no schedule, so the slot must be the existing
      // automatic policy target with the canonical SALES_MEETING duration.
      expect(child.scheduledAt).toBe(PROPOSAL_AT);
      expect(child.scheduledEndsAt).toBe('2026-08-08T11:00:00.000Z');
    });
  });

  it('D1-5: availability is evaluated for the final overridden assignee', async () => {
    await withFixture(async ({
      service, pool, manager, staffB, organizationId, defaultInstructions, submitSystemProposal,
    }) => {
      const submitted = await submitSystemProposal();
      // Block only the new assignee at the automatic target; the persisted
      // assignee stays free there. A stale persisted-assignee decision would
      // keep PROPOSAL_AT, while the correct final-assignee decision moves on.
      await pool.query(
        `INSERT INTO calendar_events (
           organization_id, assigned_user_id, title, starts_at, ends_at, timezone,
           created_by, updated_by
         ) VALUES ($1, $2, 'Engel', $3, $4, 'Europe/Istanbul', $5, $5)`,
        [organizationId, staffB.id, PROPOSAL_AT, '2026-08-08T11:00:00.000Z', manager.id],
      );

      const approved = await service.approve(manager, submitted.id, {
        clientActionId: randomUUID(),
        expectedVersion: submitted.version,
        followUp: {
          type: 'SALES_MEETING',
          assignedTo: staffB.id,
          followUpInstructions: defaultInstructions,
        },
      }) as ApprovedChild;

      const child = await service.detail(manager, approved.followUpJobCardId);
      expect(child.assignedTo).toBe(staffB.id);
      expect(child.scheduledAt).toBe('2026-08-08T11:00:00.000Z');
      expect(child.scheduledEndsAt).toBe('2026-08-08T12:00:00.000Z');
    });
  });

  it('D1-5B: an unknown overridden assignee is rejected instead of silently using the persisted one', async () => {
    await withFixture(async ({ service, manager, defaultInstructions, submitSystemProposal }) => {
      const submitted = await submitSystemProposal();
      await expect(service.approve(manager, submitted.id, {
        clientActionId: randomUUID(),
        expectedVersion: submitted.version,
        followUp: {
          type: 'SALES_MEETING',
          assignedTo: randomUUID(),
          followUpInstructions: defaultInstructions,
        },
      })).rejects.toMatchObject(appError('ASSIGNEE_NOT_FOUND', 404));

      await expect(service.detail(manager, submitted.id)).resolves.toMatchObject({
        status: 'WAITING_APPROVAL',
        version: submitted.version,
      });
    });
  });

  it('D1-6: explicit scheduledAt approval path is unchanged', async () => {
    await withFixture(async ({ service, manager, staffB, submitSystemProposal }) => {
      const submitted = await submitSystemProposal();
      const approved = await service.approve(manager, submitted.id, {
        clientActionId: randomUUID(),
        expectedVersion: submitted.version,
        followUp: {
          scheduledAt: EXPLICIT_AT,
          type: 'SALES_MEETING',
          assignedTo: staffB.id,
          followUpInstructions: 'Yönetici planı: net tarihte arayın.',
        },
      }) as ApprovedChild;

      const child = await service.detail(manager, approved.followUpJobCardId);
      expect(child).toMatchObject({
        assignedTo: staffB.id,
        scheduledAt: EXPLICIT_AT,
        scheduledEndsAt: '2026-08-09T11:00:00.000Z',
        status: 'NEW',
      });
      expect(child.followUpContext).toMatchObject({
        followUpInstructions: 'Yönetici planı: net tarihte arayın.',
      });
    });
  });

  it('D1-7: no-change SYSTEM approval still auto-schedules persisted values', async () => {
    await withFixture(async ({
      service, manager, staffA, defaultInstructions, submitSystemProposal,
    }) => {
      const submitted = await submitSystemProposal();
      const approved = await service.approve(manager, submitted.id, {
        clientActionId: randomUUID(),
        expectedVersion: submitted.version,
      }) as ApprovedChild;

      const child = await service.detail(manager, approved.followUpJobCardId);
      expect(child).toMatchObject({
        assignedTo: staffA.id,
        type: 'SALES_MEETING',
        scheduledAt: PROPOSAL_AT,
        status: 'ACCEPTED',
      });
      expect(child.followUpContext).toMatchObject({
        followUpInstructions: defaultInstructions,
      });
    });
  });

  it('D1-8: STAFF_ADJUSTED path honors persisted and overridden values', async () => {
    await withFixture(async ({ service, manager, staffA, submitExplicitProposal }) => {
      const created = await submitExplicitProposal();

      // No overrides: persisted STAFF_ADJUSTED schedule wins.
      const approved = await service.approve(manager, created.id, {
        clientActionId: randomUUID(),
        expectedVersion: created.version,
      }) as ApprovedChild;
      const child = await service.detail(manager, approved.followUpJobCardId);
      expect(child).toMatchObject({
        assignedTo: staffA.id,
        scheduledAt: STAFF_ADJUSTED_AT,
      });
      expect(child.followUpContext).toMatchObject({
        followUpInstructions: 'Takip: Klinik ziyareti',
      });
    });
  });

  it('D1-8B: STAFF_ADJUSTED + omitted schedule + changed instructions honors the override', async () => {
    await withFixture(async ({ service, manager, staffA, submitExplicitProposal }) => {
      const submitted = await submitExplicitProposal();

      const approved = await service.approve(manager, submitted.id, {
        clientActionId: randomUUID(),
        expectedVersion: submitted.version,
        followUp: {
          type: 'SALES_MEETING',
          assignedTo: staffA.id,
          followUpInstructions: 'Yönetici revizyonu: STAFF_ADJUSTED talimat.',
        },
      }) as ApprovedChild;
      const child = await service.detail(manager, approved.followUpJobCardId);
      expect(child.scheduledAt).toBe(STAFF_ADJUSTED_AT);
      expect(child.followUpContext).toMatchObject({
        followUpInstructions: 'Yönetici revizyonu: STAFF_ADJUSTED talimat.',
      });
    });
  });

  it('D1-9: priority override still lands on the auto-scheduled child; SALES_MEETING dueDate still rejected', async () => {
    await withFixture(async ({
      service, manager, staffB, defaultInstructions, submitSystemProposal,
    }) => {
      const submitted = await submitSystemProposal();
      const approved = await service.approve(manager, submitted.id, {
        clientActionId: randomUUID(),
        expectedVersion: submitted.version,
        followUp: {
          type: 'SALES_MEETING',
          assignedTo: staffB.id,
          followUpInstructions: defaultInstructions,
          priority: 'urgent',
        },
      }) as ApprovedChild;
      const child = await service.detail(manager, approved.followUpJobCardId);
      expect(child).toMatchObject({
        assignedTo: staffB.id,
        priority: 'urgent',
        dueDate: null,
      });

      const second = await submitSystemProposal({ title: 'İkinci ziyaret' });
      await expect(service.approve(manager, second.id, {
        clientActionId: randomUUID(),
        expectedVersion: second.version,
        followUp: {
          type: 'SALES_MEETING',
          assignedTo: staffB.id,
          followUpInstructions: 'Takip: İkinci ziyaret',
          dueDate: '2026-09-15',
        },
      })).rejects.toMatchObject(appError('VALIDATION_ERROR', 400));
    });
  });

  it('D1-10: exact retry replays the overridden approval; changed semantics conflict', async () => {
    await withFixture(async ({
      service, pool, manager, staffB, defaultInstructions, submitSystemProposal,
    }) => {
      const submitted = await submitSystemProposal();
      const actionId = randomUUID();
      const payload = {
        clientActionId: actionId,
        expectedVersion: submitted.version,
        followUp: {
          type: 'SALES_MEETING' as const,
          assignedTo: staffB.id,
          followUpInstructions: defaultInstructions,
        },
      };
      const first = await service.approve(manager, submitted.id, payload) as ApprovedChild;
      const second = await service.approve(manager, submitted.id, payload) as ApprovedChild;
      expect(second).toEqual(first);
      const children = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM job_cards WHERE source_job_card_id = $1`,
        [submitted.id],
      );
      expect(children.rows[0]!.count).toBe('1');

      await expect(service.approve(manager, submitted.id, {
        clientActionId: actionId,
        expectedVersion: submitted.version,
        followUp: {
          type: 'SALES_MEETING',
          assignedTo: staffB.id,
          followUpInstructions: 'Farklı talimatla yeniden deneme.',
        },
      })).rejects.toMatchObject(appError('CLIENT_ACTION_REUSED', 409));
    });
  });

  it('D1-11: manager-supplied type stays authoritative input; non-SALES_MEETING is rejected on the mandatory path', async () => {
    await withFixture(async ({ service, manager, staffB, defaultInstructions, submitSystemProposal }) => {
      const submitted = await submitSystemProposal();
      // Same (only valid) type plus an assignee override still honors the assignee.
      const approved = await service.approve(manager, submitted.id, {
        clientActionId: randomUUID(),
        expectedVersion: submitted.version,
        followUp: {
          type: 'SALES_MEETING',
          assignedTo: staffB.id,
          followUpInstructions: defaultInstructions,
        },
      }) as ApprovedChild;
      const child = await service.detail(manager, approved.followUpJobCardId);
      expect(child).toMatchObject({ type: 'SALES_MEETING', assignedTo: staffB.id });

      // The mandatory follow-up contract pins valid types to SALES_MEETING, so
      // a different caller-supplied type must be rejected rather than silently
      // replaced by the persisted value.
      const second = await submitSystemProposal({ title: 'Üçüncü ziyaret' });
      await expect(service.approve(manager, second.id, {
        clientActionId: randomUUID(),
        expectedVersion: second.version,
        followUp: {
          type: 'GENERAL_TASK',
          assignedTo: staffB.id,
          followUpInstructions: 'Takip: Üçüncü ziyaret',
        },
      })).rejects.toMatchObject(appError('FOLLOW_UP_PROPOSAL_INVALID', 400));
    });
  });
});
