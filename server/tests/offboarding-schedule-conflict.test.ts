import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { canonicalScheduledEnd } from '../src/modules/job-cards/job-card-duration.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import { PostgresStaffOffboardingService } from '../src/modules/people/offboarding.js';
import type { JobCardActor } from '../src/modules/job-cards/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
}>;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

type QueryContext = Readonly<{
  text: string;
  values: readonly unknown[];
  processId: number;
}>;

type QueryObserver = Readonly<{
  before?: (query: QueryContext) => void;
  after?: (query: QueryContext) => Promise<void> | void;
}>;

function observePoolQueries(pool: Pool, observer: QueryObserver) {
  const originalConnect = pool.connect.bind(pool) as (...args: any[]) => any;
  (pool as any).connect = (...args: any[]) => {
    const last = args[args.length - 1];
    if (typeof last === 'function') {
      const callback = args.pop() as (
        error: Error | null,
        client?: any,
        release?: () => void,
      ) => void;
      originalConnect(...args, (error: Error | null, client?: any, release?: () => void) => {
        if (error || !client) return callback(error, client, release);
        callback(null, wrapClient(client), release);
      });
      return;
    }
    return originalConnect(...args).then((client: any) => wrapClient(client));
  };

  function wrapClient(client: any) {
    const originalQuery = client.query.bind(client);
    client.query = (...queryArgs: any[]) => {
      const first = queryArgs[0];
      const text = typeof first === 'string' ? first : first?.text ?? '';
      const values = typeof first === 'string'
        ? (Array.isArray(queryArgs[1]) ? queryArgs[1] : [])
        : (first?.values ?? []);
      const query = { text, values, processId: client.processID } satisfies QueryContext;
      observer.before?.(query);
      const result = originalQuery(...queryArgs);
      if (result && typeof result.then === 'function' && observer.after) {
        return Promise.resolve(result).then(async (value) => {
          await observer.after!(query);
          return value;
        });
      }
      observer.after?.(query);
      return result;
    };
    return client;
  }
}

function queryIncludesUserId(values: readonly unknown[], userId: string) {
  return values.some((value) => value === userId
    || (Array.isArray(value) && value.includes(userId)));
}

async function waitForBlockingPid(pool: Pool, waitingPid: number, blockingPid: number) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await pool.query<{ blocking_pids: number[]; state: string; wait_event_type: string | null }>(
      `SELECT pg_blocking_pids($1)::int[] AS blocking_pids,
              state, wait_event_type
         FROM pg_stat_activity
        WHERE pid = $1`,
      [waitingPid],
    );
    const row = result.rows[0];
    if (row?.blocking_pids?.map(Number).includes(blockingPid)) return row;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Expected PostgreSQL pid ${waitingPid} to be blocked by ${blockingPid}.`);
}

async function insertUser(pool: Pool, organizationId: string, role: string, name: string) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO users (id, organization_id, email, name, role, is_active, version, password_hash)
     VALUES ($1, $2, $3, $4, $5, TRUE, 1, 'x')`,
    [id, organizationId, `${id}@test.local`, name, role],
  );
  if (role === 'STAFF') {
    await pool.query(
      `INSERT INTO staff_profiles (organization_id, user_id, title) VALUES ($1, $2, 'Field Staff') ON CONFLICT DO NOTHING`,
      [organizationId, id],
    );
  }
  return { id, organizationId, role, name };
}

const at = new Date('2026-08-25T09:00:00.000Z');

async function insertJob(
  pool: Pool,
  input: { organizationId: string; assignedTo: string; createdBy: string; scheduledAt?: Date | null; scheduledEndsAt?: Date | null; status?: string; customerId?: string | null; type?: 'GENERAL_TASK' | 'SALES_MEETING' | 'PRODUCT_DELIVERY'; engagementKind?: 'SALES_MEETING' | 'CUSTOMER_VISIT' | 'PRODUCT_DEMO' | 'TRAINING' | 'FOLLOW_UP' | 'OTHER' },
) {
  const id = randomUUID();
  const status = input.status ?? 'ACCEPTED';
  const fields = {
    startedAt: ['IN_PROGRESS', 'WAITING_APPROVAL', 'COMPLETED'].includes(status) ? at : null,
    acceptedAt: status === 'ACCEPTED' ? at : null,
    acceptedBy: status === 'ACCEPTED' ? input.assignedTo : null,
    staffCompletedAt: ['WAITING_APPROVAL', 'COMPLETED'].includes(status) ? at : null,
    staffCompletedBy: ['WAITING_APPROVAL', 'COMPLETED'].includes(status) ? input.assignedTo : null,
    managerApprovedAt: status === 'COMPLETED' ? at : null,
    managerApprovedBy: status === 'COMPLETED' ? input.createdBy : null,
    cancelledAt: status === 'CANCELLED' ? at : null,
    cancelledBy: status === 'CANCELLED' ? input.createdBy : null,
    cancelReason: status === 'CANCELLED' ? 'test' : null,
    invalidatedAt: status === 'INVALIDATED' ? at : null,
    invalidatedBy: status === 'INVALIDATED' ? input.createdBy : null,
    invalidationReasonCode: status === 'INVALIDATED' ? 'DUPLICATE' : null,
    revisionRequestedAt: null,
    revisionRequestedBy: null,
    revisionReason: null,
    followUpAt: null,
    followUpType: null,
    followUpOrigin: null,
    followUpBy: null,
    followUpInstructions: null,
  };
  await pool.query(
    `INSERT INTO job_cards (
       id, organization_id, type, status, title, customer_id, assigned_to, created_by,
       scheduled_at, scheduled_ends_at, started_at, accepted_at, accepted_by,
       staff_completed_at, staff_completed_by, manager_approved_at, manager_approved_by,
       cancelled_at, cancelled_by, cancel_reason, invalidated_at, invalidated_by,
       invalidation_reason_code, revision_requested_at, revision_requested_by, revision_reason,
       follow_up_proposed_at, follow_up_proposed_type, follow_up_proposed_assignee,
       follow_up_proposal_instructions, follow_up_proposal_origin, follow_up_proposed_by,
       engagement_kind
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8,
       $9, $10, $11, $12, $13, $14, $15, $16, $17,
       $18, $19, $20, $21, $22, $23, $24, $25, $26,
       $27, $28, $29, $30, $31, $32, $33
     )`,
    [id, input.organizationId, input.type ?? 'GENERAL_TASK', status, 'Test Job', input.customerId ?? null,
      input.assignedTo, input.createdBy, input.scheduledAt ?? null, input.scheduledEndsAt ?? null,
      fields.startedAt, fields.acceptedAt, fields.acceptedBy, fields.staffCompletedAt,
      fields.staffCompletedBy, fields.managerApprovedAt, fields.managerApprovedBy,
      fields.cancelledAt, fields.cancelledBy, fields.cancelReason, fields.invalidatedAt,
      fields.invalidatedBy, fields.invalidationReasonCode, fields.revisionRequestedAt,
      fields.revisionRequestedBy, fields.revisionReason, fields.followUpAt, fields.followUpType,
      null, fields.followUpInstructions, fields.followUpOrigin,
      fields.followUpBy, input.engagementKind ?? null],
  );
  return id;
}

async function insertCalendar(pool: Pool, organizationId: string, assignedUserId: string, createdBy: string, startsAt: string, endsAt: string) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO calendar_events (id, organization_id, assigned_user_id, title, starts_at, ends_at, timezone, created_by, updated_by)
     VALUES ($1, $2, $3, 'Manual', $4, $5, 'Europe/Istanbul', $6, $6)`,
    [id, organizationId, assignedUserId, startsAt, endsAt, createdBy],
  );
  return id;
}

async function withFixture(run: (ctx: { pool: Pool; createPool: () => Pool; organizationId: string; admin: any; target: any; replacement: any; customerId: string }) => Promise<void>) {
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL required');
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `off_sched_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool | null = null;
  try {
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
    const createPool = () => new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema},public`,
    });
    await runMigrations({ migrationsDirectory, store: new PostgresMigrationStore(pool) });
    const organizationId = (await pool.query<{ id: string }>(`INSERT INTO organizations (name, timezone) VALUES ('Test Org','Europe/Istanbul') RETURNING id`)).rows[0]!.id;
    const admin = await insertUser(pool, organizationId, 'ADMIN', 'Admin');
    const target = await insertUser(pool, organizationId, 'STAFF', 'Target');
    const replacement = await insertUser(pool, organizationId, 'STAFF', 'Replacement');
    const customerId = (await pool.query<{ id: string }>(`INSERT INTO customers (organization_id, name, customer_type, status, assigned_staff_user_id) VALUES ($1, 'Clinic', 'clinic', 'active', $2) RETURNING id`, [organizationId, target.id])).rows[0]!.id;
    await run({ pool, createPool, organizationId, admin, target, replacement, customerId });
  } finally {
    if (pool) await pool.end().catch(() => {});
    await adminPool.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
    await adminPool.end().catch(() => {});
  }
}

describe.skipIf(!databaseUrl)('offboarding schedule conflict', () => {
  it('rejects replacement with existing interval JobCard', async () => {
    await withFixture(async ({ pool, organizationId, admin, target, replacement, customerId }) => {
      // Replacement has 10:00-11:00
      await insertJob(pool, {
        organizationId,
        assignedTo: replacement.id,
        createdBy: admin.id,
        scheduledAt: new Date('2026-09-10T10:00:00.000Z'),
        scheduledEndsAt: new Date('2026-09-10T11:00:00.000Z'),
      });
      // Target has overlapping 10:30-11:30 to be transferred
      const jobToTransfer = await insertJob(pool, {
        organizationId,
        assignedTo: target.id,
        createdBy: admin.id,
        scheduledAt: new Date('2026-09-10T10:30:00.000Z'),
        scheduledEndsAt: new Date('2026-09-10T11:30:00.000Z'),
      });
      const service = new PostgresStaffOffboardingService(pool);
      const adminUser = { id: admin.id, organizationId, role: 'ADMIN' } as any;
      const plan = await service.preview(adminUser, target.id);
      const decisionInput = {
        clientActionId: randomUUID(),
        planHash: plan.planHash,
        reasonCode: 'OTHER_ADMINISTRATIVE' as const,
        jobDecisions: [{ jobCardId: jobToTransfer, replacementUserId: replacement.id }],
        calendarDecisions: [],
        followUpDecisions: [],
        customerDecisions: [{ customerId, action: 'REASSIGN' as const, replacementUserId: replacement.id }],
        reminderDecisions: [],
      };
      await expect(service.execute(adminUser, target.id, decisionInput)).rejects.toMatchObject({ code: 'CALENDAR_CONFLICT' });
      // Verify no partial mutation
      const after = await pool.query<{ assigned_to: string }>(`SELECT assigned_to FROM job_cards WHERE id = $1`, [jobToTransfer]);
      expect(after.rows[0]!.assigned_to).toBe(target.id);
      const targetRow = await pool.query<{ is_active: boolean }>(`SELECT is_active FROM users WHERE id = $1`, [target.id]);
      expect(targetRow.rows[0]!.is_active).toBe(true);
    });
  });

  it('rejects replacement with existing manual calendar event', async () => {
    await withFixture(async ({ pool, organizationId, admin, target, replacement, customerId }) => {
      await insertCalendar(pool, organizationId, replacement.id, admin.id, '2026-09-10T10:00:00Z', '2026-09-10T11:00:00Z');
      const jobToTransfer = await insertJob(pool, {
        organizationId,
        assignedTo: target.id,
        createdBy: admin.id,
        scheduledAt: new Date('2026-09-10T10:30:00.000Z'),
        scheduledEndsAt: new Date('2026-09-10T11:30:00.000Z'),
      });
      const service = new PostgresStaffOffboardingService(pool);
      const adminUser = { id: admin.id, organizationId, role: 'ADMIN' } as any;
      const plan = await service.preview(adminUser, target.id);
      const input = {
        clientActionId: randomUUID(),
        planHash: plan.planHash,
        reasonCode: 'OTHER_ADMINISTRATIVE' as const,
        jobDecisions: [{ jobCardId: jobToTransfer, replacementUserId: replacement.id }],
        calendarDecisions: [],
        followUpDecisions: [],
        customerDecisions: [{ customerId, action: 'REASSIGN' as const, replacementUserId: replacement.id }],
        reminderDecisions: [],
      };
      await expect(service.execute(adminUser, target.id, input)).rejects.toMatchObject({ code: 'CALENDAR_CONFLICT' });
    });
  });

  it('allows back-to-back transfer', async () => {
    await withFixture(async ({ pool, organizationId, admin, target, replacement, customerId }) => {
      await insertJob(pool, {
        organizationId,
        assignedTo: replacement.id,
        createdBy: admin.id,
        scheduledAt: new Date('2026-09-10T10:00:00.000Z'),
        scheduledEndsAt: new Date('2026-09-10T11:00:00.000Z'),
      });
      const jobToTransfer = await insertJob(pool, {
        organizationId,
        assignedTo: target.id,
        createdBy: admin.id,
        scheduledAt: new Date('2026-09-10T11:00:00.000Z'),
        scheduledEndsAt: new Date('2026-09-10T12:00:00.000Z'),
      });
      const service = new PostgresStaffOffboardingService(pool);
      const adminUser = { id: admin.id, organizationId, role: 'ADMIN' } as any;
      const plan = await service.preview(adminUser, target.id);
      const input = {
        clientActionId: randomUUID(),
        planHash: plan.planHash,
        reasonCode: 'OTHER_ADMINISTRATIVE' as const,
        jobDecisions: [{ jobCardId: jobToTransfer, replacementUserId: replacement.id }],
        calendarDecisions: [],
        followUpDecisions: [],
        customerDecisions: [{ customerId, action: 'REASSIGN' as const, replacementUserId: replacement.id }],
        reminderDecisions: [],
      };
      const res = await service.execute(adminUser, target.id, input);
      expect(res.status).toBe('OFFBOARDED');
    });
  });

  it('allows non-conflicting transfer', async () => {
    await withFixture(async ({ pool, organizationId, admin, target, replacement, customerId }) => {
      const jobToTransfer = await insertJob(pool, {
        organizationId,
        assignedTo: target.id,
        createdBy: admin.id,
        scheduledAt: new Date('2026-09-10T10:00:00.000Z'),
        scheduledEndsAt: new Date('2026-09-10T11:00:00.000Z'),
      });
      const service = new PostgresStaffOffboardingService(pool);
      const adminUser = { id: admin.id, organizationId, role: 'ADMIN' } as any;
      const plan = await service.preview(adminUser, target.id);
      const input = {
        clientActionId: randomUUID(),
        planHash: plan.planHash,
        reasonCode: 'OTHER_ADMINISTRATIVE' as const,
        jobDecisions: [{ jobCardId: jobToTransfer, replacementUserId: replacement.id }],
        calendarDecisions: [],
        followUpDecisions: [],
        customerDecisions: [{ customerId, action: 'REASSIGN' as const, replacementUserId: replacement.id }],
        reminderDecisions: [],
      };
      const res = await service.execute(adminUser, target.id, input);
      expect(res.status).toBe('OFFBOARDED');
    });
  });

  it('rejects multi-job batch internal overlap', async () => {
    await withFixture(async ({ pool, organizationId, admin, target, replacement, customerId }) => {
      const j1 = await insertJob(pool, {
        organizationId,
        assignedTo: target.id,
        createdBy: admin.id,
        scheduledAt: new Date('2026-09-10T10:00:00.000Z'),
        scheduledEndsAt: new Date('2026-09-10T11:00:00.000Z'),
      });
      const j2 = await insertJob(pool, {
        organizationId,
        assignedTo: target.id,
        createdBy: admin.id,
        scheduledAt: new Date('2026-09-10T10:30:00.000Z'),
        scheduledEndsAt: new Date('2026-09-10T11:30:00.000Z'),
      });
      const service = new PostgresStaffOffboardingService(pool);
      const adminUser = { id: admin.id, organizationId, role: 'ADMIN' } as any;
      const plan = await service.preview(adminUser, target.id);
      const input = {
        clientActionId: randomUUID(),
        planHash: plan.planHash,
        reasonCode: 'OTHER_ADMINISTRATIVE' as const,
        jobDecisions: [
          { jobCardId: j1, replacementUserId: replacement.id },
          { jobCardId: j2, replacementUserId: replacement.id },
        ],
        calendarDecisions: [],
        followUpDecisions: [],
        customerDecisions: [{ customerId, action: 'REASSIGN' as const, replacementUserId: replacement.id }],
        reminderDecisions: [],
      };
      await expect(service.execute(adminUser, target.id, input)).rejects.toMatchObject({ code: 'CALENDAR_CONFLICT' });
      // Ensure no partial
      const rows = await pool.query<{ assigned_to: string }>(`SELECT id, assigned_to FROM job_cards WHERE id IN ($1,$2) ORDER BY id`, [j1, j2]);
      for (const r of rows.rows) expect(r.assigned_to).toBe(target.id);
    });
  });

  it('precommitted blocker rejects offboarding transfer without mutation', async () => {
    await withFixture(async ({ pool, organizationId, admin, target, replacement, customerId }) => {
      const jobToTransfer = await insertJob(pool, {
        organizationId,
        assignedTo: target.id,
        createdBy: admin.id,
        scheduledAt: new Date('2026-09-10T10:00:00.000Z'),
        scheduledEndsAt: new Date('2026-09-10T11:00:00.000Z'),
      });
      const service = new PostgresStaffOffboardingService(pool);
      const adminUser = { id: admin.id, organizationId, role: 'ADMIN' } as any;
      const plan = await service.preview(adminUser, target.id);
      const input = {
        clientActionId: randomUUID(),
        planHash: plan.planHash,
        reasonCode: 'OTHER_ADMINISTRATIVE' as const,
        jobDecisions: [{ jobCardId: jobToTransfer, replacementUserId: replacement.id }],
        calendarDecisions: [],
        followUpDecisions: [],
        customerDecisions: [{ customerId, action: 'REASSIGN' as const, replacementUserId: replacement.id }],
        reminderDecisions: [],
      };
      // The blocker is committed before offboarding starts; this is conflict regression coverage, not a race proof.
      await insertJob(pool, {
        organizationId,
        assignedTo: replacement.id,
        createdBy: admin.id,
        scheduledAt: new Date('2026-09-10T10:30:00.000Z'),
        scheduledEndsAt: new Date('2026-09-10T11:00:00.000Z'),
      });
      await expect(service.execute(adminUser, target.id, input)).rejects.toMatchObject({ code: 'CALENDAR_CONFLICT' });
      const after = await pool.query<{ count: string }>(`SELECT COUNT(*) FROM job_cards WHERE assigned_to = $1 AND status IN ('NEW','ACCEPTED','IN_PROGRESS','WAITING_APPROVAL','REVISION_REQUESTED') AND scheduled_at IS NOT NULL`, [replacement.id]);
      expect(Number(after.rows[0]!.count)).toBe(1);
    });
  });

  it('proves AUTO approval and offboarding serialize on the replacement Staff lock', async () => {
    await withFixture(async ({
      pool, createPool, organizationId, admin, target, replacement, customerId,
    }) => {
      const raceNow = new Date('2026-09-10T09:00:00.000Z');
      const sourceCustomerId = (await pool.query<{ id: string }>(
        `INSERT INTO customers (organization_id, name, customer_type, status, assigned_staff_user_id)
         VALUES ($1, 'AUTO source clinic', 'clinic', 'active', $2) RETURNING id`,
        [organizationId, replacement.id],
      )).rows[0]!.id;
      const approvalPool = createPool();
      const offboardingPool = createPool();
      const approvalLockAcquired = deferred<number>();
      const releaseApprovalLock = deferred<void>();
      const offboardingLockAttempted = deferred<number>();
      let approvalLockObserved = false;
      let offboardingLockObserved = false;
      let approvalPromise: Promise<unknown> | undefined;
      let offboardingPromise: Promise<unknown> | undefined;
      let offboardingSettled = false;

      try {
        const replacementActor: JobCardActor = {
          id: replacement.id,
          organizationId,
          role: 'STAFF',
        };
        const managerActor: JobCardActor = {
          id: admin.id,
          organizationId,
          role: 'ADMIN',
        };
        const adminUser = { id: admin.id, organizationId, role: 'ADMIN' } as any;
        const approvalService = new JobCardService(
          new PostgresJobCardRepository(approvalPool),
          () => raceNow,
          undefined,
          undefined,
          undefined,
          { enabled: true, reminderLeadMinutes: 30 },
        );

        const source = await approvalService.create(replacementActor, {
          clientActionId: randomUUID(),
          type: 'SALES_MEETING',
          title: 'AUTO approval source',
          description: null,
          customerId: sourceCustomerId,
          contactId: null,
          assignedTo: replacement.id,
          priority: 'normal',
          dueDate: null,
          scheduledAt: '2026-09-09T08:00:00.000Z',
          scheduledEndsAt: canonicalScheduledEnd('SALES_MEETING', '2026-09-09T08:00:00.000Z'),
          engagementKind: 'CUSTOMER_VISIT',
        } as never);
        const started = await approvalService.start(replacementActor, source.id, {
          clientActionId: randomUUID(),
          expectedVersion: source.version,
        });
        const meeting = await approvalService.patchMeetingDetails(replacementActor, source.id, {
          clientActionId: randomUUID(),
          expectedVersion: started.version,
          meetingAt: '2026-09-09T08:30:00.000Z',
          outcome: 'FOLLOW_UP_REQUIRED',
          unsuccessfulReason: 'REQUESTED_LATER',
          meetingSummary: 'AUTO approval race fixture.',
        });
        const submitted = await approvalService.submitForApproval(replacementActor, source.id, {
          clientActionId: randomUUID(),
          expectedVersion: meeting.jobCardVersion,
          note: 'AUTO proposal for concurrency proof.',
        });
        const proposal = submitted.followUpProposal;
        if (!proposal) throw new Error('Expected an AUTO follow-up proposal.');
        expect(proposal.scheduledAt).toBe('2026-09-10T09:15:00.000Z');

        const jobToTransfer = await insertJob(pool, {
          organizationId,
          assignedTo: target.id,
          createdBy: admin.id,
          customerId,
          type: 'SALES_MEETING',
          engagementKind: 'CUSTOMER_VISIT',
          scheduledAt: new Date(proposal.scheduledAt),
          scheduledEndsAt: new Date(canonicalScheduledEnd('SALES_MEETING', proposal.scheduledAt)),
        });
        const offboardingService = new PostgresStaffOffboardingService(
          offboardingPool,
          undefined,
          () => raceNow,
        );
        const plan = await offboardingService.preview(adminUser, target.id);
        expect(plan.jobs.map((item) => item.id)).toContain(jobToTransfer);
        const offboardingInput = {
          clientActionId: randomUUID(),
          planHash: plan.planHash,
          reasonCode: 'OTHER_ADMINISTRATIVE' as const,
          jobDecisions: plan.jobs.map((item) => ({
            jobCardId: item.id,
            replacementUserId: replacement.id,
          })),
          calendarDecisions: [],
          followUpDecisions: [],
          customerDecisions: plan.customers.map((item) => ({
            customerId: item.id,
            action: 'REASSIGN' as const,
            replacementUserId: replacement.id,
          })),
          reminderDecisions: [],
        };

        observePoolQueries(approvalPool, {
          after: async (query) => {
            if (!approvalLockObserved
              && query.text.includes('FROM users')
              && query.text.includes('FOR UPDATE')
              && queryIncludesUserId(query.values, replacement.id)) {
              approvalLockObserved = true;
              approvalLockAcquired.resolve(query.processId);
              await releaseApprovalLock.promise;
            }
          },
        });
        observePoolQueries(offboardingPool, {
          before: (query) => {
            if (!offboardingLockObserved
              && query.text.includes('FROM users')
              && query.text.includes('id = ANY')
              && query.text.includes('FOR UPDATE')
              && queryIncludesUserId(query.values, replacement.id)) {
              offboardingLockObserved = true;
              offboardingLockAttempted.resolve(query.processId);
            }
          },
        });

        approvalPromise = approvalService.approve(managerActor, source.id, {
          clientActionId: randomUUID(),
          expectedVersion: submitted.version,
        });
        const approvalProcessId = await approvalLockAcquired.promise;
        expect(approvalLockObserved).toBe(true);

        offboardingPromise = offboardingService.execute(adminUser, target.id, offboardingInput)
          .finally(() => { offboardingSettled = true; });
        const offboardingProcessId = await offboardingLockAttempted.promise;
        expect(offboardingLockObserved).toBe(true);
        expect(offboardingProcessId).not.toBe(approvalProcessId);
        expect(offboardingSettled).toBe(false);

        const blockingState = await waitForBlockingPid(pool, offboardingProcessId, approvalProcessId);
        expect(blockingState.wait_event_type).toBe('Lock');

        releaseApprovalLock.resolve(undefined);
        const approved = await approvalPromise as { followUpJobCardId?: string };
        expect(approved.followUpJobCardId).toEqual(expect.any(String));

        const committedChild = await pool.query<{
          id: string;
          status: string;
          assigned_to: string;
          scheduled_at: Date;
          scheduled_ends_at: Date;
        }>(
          `SELECT id, status, assigned_to, scheduled_at, scheduled_ends_at
             FROM job_cards
            WHERE organization_id = $1 AND source_job_card_id = $2`,
          [organizationId, source.id],
        );
        expect(committedChild.rows).toHaveLength(1);
        expect(committedChild.rows[0]).toMatchObject({
          id: approved.followUpJobCardId,
          status: 'ACCEPTED',
          assigned_to: replacement.id,
        });
        expect(committedChild.rows[0]!.scheduled_at.toISOString()).toBe(proposal.scheduledAt);
        expect(committedChild.rows[0]!.scheduled_ends_at.toISOString()).toBe(
          canonicalScheduledEnd('SALES_MEETING', proposal.scheduledAt),
        );

        const offboardingOutcome = await offboardingPromise.then(
          (value) => ({ kind: 'fulfilled' as const, value }),
          (reason) => ({ kind: 'rejected' as const, reason }),
        );

        const childRows = await pool.query<{
          id: string;
          source_job_card_id: string;
          assigned_to: string;
          scheduled_at: Date;
          scheduled_ends_at: Date;
        }>(
          `SELECT id, source_job_card_id, assigned_to, scheduled_at, scheduled_ends_at
             FROM job_cards
            WHERE organization_id = $1 AND source_job_card_id = $2`,
          [organizationId, source.id],
        );
        expect(childRows.rows).toHaveLength(1);
        expect(childRows.rows[0]!.id).toBe(approved.followUpJobCardId);
        expect(childRows.rows[0]!.source_job_card_id).toBe(source.id);
        expect(childRows.rows[0]!.assigned_to).toBe(replacement.id);
        expect(childRows.rows[0]!.scheduled_at.toISOString()).toBe(proposal.scheduledAt);
        expect(childRows.rows[0]!.scheduled_ends_at.toISOString()).toBe(
          canonicalScheduledEnd('SALES_MEETING', proposal.scheduledAt),
        );

        const rollbackState = await pool.query<{
          target_active: boolean;
          transferred_assignee: string;
          customer_assignee: string;
          offboarded_audits: string;
          transferred_calendar_events: string;
        }>(
          `SELECT
             (SELECT is_active FROM users WHERE organization_id = $1 AND id = $2) AS target_active,
             (SELECT assigned_to FROM job_cards WHERE organization_id = $1 AND id = $3) AS transferred_assignee,
             (SELECT assigned_staff_user_id FROM customers WHERE organization_id = $1 AND id = $4) AS customer_assignee,
             (SELECT COUNT(*)::text FROM audit_events
               WHERE organization_id = $1 AND subject_id = $2 AND event_type = 'USER_OFFBOARDED') AS offboarded_audits,
             (SELECT COUNT(*)::text FROM calendar_events
               WHERE organization_id = $1 AND assigned_user_id = $5
                 AND starts_at < $7 AND $6 < ends_at) AS transferred_calendar_events`,
          [organizationId, target.id, jobToTransfer, customerId, replacement.id,
            proposal.scheduledAt, canonicalScheduledEnd('SALES_MEETING', proposal.scheduledAt)],
        );
        const overlapRows = await pool.query(
          `WITH intervals AS (
             SELECT 'JOB'::text AS source, j.id::text AS id, j.scheduled_at AS starts_at,
                    j.scheduled_ends_at AS ends_at
               FROM job_cards j
              WHERE j.organization_id = $1 AND j.assigned_to = $2
                AND j.status IN ('NEW','ACCEPTED','IN_PROGRESS','WAITING_APPROVAL','REVISION_REQUESTED')
                AND j.scheduled_at IS NOT NULL AND j.scheduled_ends_at IS NOT NULL
             UNION ALL
             SELECT 'MANUAL'::text, e.id::text, e.starts_at, e.ends_at
               FROM calendar_events e
              WHERE e.organization_id = $1 AND e.assigned_user_id = $2 AND e.status = 'ACTIVE'
           ), numbered AS (
             SELECT ROW_NUMBER() OVER (ORDER BY source, id) AS row_no, * FROM intervals
           )
           SELECT a.source AS source_a, a.id AS id_a, b.source AS source_b, b.id AS id_b
             FROM numbered a
             JOIN numbered b ON a.row_no < b.row_no
                              AND a.starts_at < b.ends_at
                              AND b.starts_at < a.ends_at`,
          [organizationId, replacement.id],
        );

        if (offboardingOutcome.kind === 'fulfilled') {
          throw new Error(
            `REAL_RACE_EXPOSED_SOURCE_DEFECT: offboarding committed after approval child; `
            + `overlapping interval pairs=${overlapRows.rows.length}`,
          );
        }
        expect(offboardingOutcome.reason).toMatchObject({
          code: 'CALENDAR_CONFLICT',
          statusCode: 409,
        });
        expect(rollbackState.rows[0]).toMatchObject({
          target_active: true,
          transferred_assignee: target.id,
          customer_assignee: target.id,
          offboarded_audits: '0',
          transferred_calendar_events: '0',
        });
        expect(overlapRows.rows).toHaveLength(0);
      } finally {
        releaseApprovalLock.resolve(undefined);
        const pending = [approvalPromise, offboardingPromise]
          .filter((promise): promise is Promise<unknown> => promise !== undefined);
        await Promise.allSettled(pending);
        await Promise.all([approvalPool.end(), offboardingPool.end()]);
      }
    });
  });
});
