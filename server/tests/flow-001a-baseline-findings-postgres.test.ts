/**
 * FLOW-001/A baseline audit — characterization tests (PostgreSQL 17).
 *
 * These tests assert the behaviour of the current checkout at
 * 873c4285cbcf. They are evidence, not acceptance criteria: every expectation
 * below documents what the code does today for findings F01–F08 of
 * docs/backlog/2026-11-26-connected-workflows/01-baseline-decisions.md §2.
 * F09 is documentation-only and has no runtime test.
 *
 * Fixed product data is synthetic. Lifecycle commands (create/start/submit/
 * approve) take their business time from the 049 PostgreSQL arbitration clock,
 * so those fixtures derive their instants from the DB baseline instead of
 * hard-coded calendar dates (see tests/support/db-clock-baseline.ts). Report
 * reads receive an explicit requestTime and therefore use fixed dates.
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { normalizeFollowUpDueDate } from '../src/modules/job-cards/create-input.js';
import { requiresMandatoryFollowUpProposal } from '../src/modules/job-cards/follow-up-policy.js';
import { localDateKey } from '../src/modules/job-cards/local-calendar.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type {
  JobCardActor,
  JobCardEngagementKind,
  JobCardType,
} from '../src/modules/job-cards/types.js';
import { PostgresReportsRepository } from '../src/modules/reports/repository.js';
import {
  baselineAlignedToGrid,
  baselineIso,
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  readDbBaseline,
} from './support/db-clock-baseline.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const TIMEZONE = 'Europe/Istanbul';

type Organization = {
  organizationId: string;
  managerId: string;
  staffId: string;
  customerId: string;
  contactId: string;
  productId: string;
  manager: JobCardActor;
  staff: JobCardActor;
};

async function seedOrganization(pool: Pool, name: string): Promise<Organization> {
  const organizationId = (await pool.query<{ id: string }>(
    `INSERT INTO organizations (name, timezone) VALUES ($1, $2) RETURNING id`,
    [name, TIMEZONE],
  )).rows[0]!.id;
  async function user(role: 'STAFF' | 'MANAGER') {
    return (await pool.query<{ id: string }>(
      `INSERT INTO users (organization_id, name, email, password_hash, role, is_active)
       VALUES ($1, $2, $3, 'test-hash', $4, TRUE) RETURNING id`,
      [organizationId, `${role} ${name}`, `${randomUUID()}@flow001a.test`, role],
    )).rows[0]!.id;
  }
  const staffId = await user('STAFF');
  const managerId = await user('MANAGER');
  await pool.query(
    `INSERT INTO staff_profiles (organization_id, user_id, manager_user_id)
     VALUES ($1, $2, $3)`,
    [organizationId, staffId, managerId],
  );
  const customerId = (await pool.query<{ id: string }>(
    `INSERT INTO customers (organization_id, name, customer_type, status)
     VALUES ($1, $2, 'clinic', 'active') RETURNING id`,
    [organizationId, `Klinik ${name}`],
  )).rows[0]!.id;
  const contactId = (await pool.query<{ id: string }>(
    `INSERT INTO contacts (organization_id, customer_id, name, title)
     VALUES ($1, $2, 'Dr. Ayşe', 'Dr.') RETURNING id`,
    [organizationId, customerId],
  )).rows[0]!.id;
  const productId = (await pool.query<{ id: string }>(
    `INSERT INTO products (organization_id, name, sku, unit)
     VALUES ($1, 'İmplant seti', $2, 'adet') RETURNING id`,
    [organizationId, `FLOW-001A-${randomUUID().slice(0, 8)}`],
  )).rows[0]!.id;
  return {
    organizationId,
    managerId,
    staffId,
    customerId,
    contactId,
    productId,
    manager: { id: managerId, organizationId, role: 'MANAGER' },
    staff: { id: staffId, organizationId, role: 'STAFF' },
  };
}

type MeetingOutcome = 'POSITIVE' | 'FOLLOW_UP_REQUIRED' | 'NO_DECISION' | 'NOT_INTERESTED';

/** Creates a scheduled Sales Meeting owned by the Staff member and starts it. */
async function createStartedMeeting(
  service: JobCardService,
  staff: JobCardActor,
  customerId: string,
  input: {
    clientActionId: string;
    engagementKind: JobCardEngagementKind;
    scheduledAt: string;
  },
) {
  const created = await service.create(staff, {
    clientActionId: `${input.clientActionId}-create`,
    type: 'SALES_MEETING',
    title: 'Klinik ziyareti',
    description: null,
    customerId,
    contactId: null,
    assignedTo: staff.id,
    priority: 'normal',
    dueDate: null,
    scheduledAt: input.scheduledAt,
    engagementKind: input.engagementKind,
  });
  return service.start(staff, created.id, {
    clientActionId: `${input.clientActionId}-start`,
    expectedVersion: created.version,
  });
}

type CardFixture = {
  organizationId: string;
  assignedTo: string;
  createdBy: string;
  type: JobCardType;
  status:
    | 'NEW' | 'ACCEPTED' | 'IN_PROGRESS' | 'WAITING_APPROVAL'
    | 'REVISION_REQUESTED' | 'COMPLETED' | 'CANCELLED' | 'INVALIDATED';
  title?: string;
  customerId?: string | null;
  engagementKind?: JobCardEngagementKind | null;
  sourceJobCardId?: string | null;
  saleSourceVisitId?: string | null;
  deliverySourceSaleId?: string | null;
  dueDate?: string | null;
  scheduledAt?: string | null;
  createdAt?: string;
};

/**
 * Minimal synthetic JobCard fixture for read-model tests. Timestamps are fixed
 * because report reads receive an explicit requestTime instead of the DB clock.
 */
async function insertCard(pool: Pool, input: CardFixture): Promise<string> {
  const createdAt = input.createdAt ?? '2026-09-01T08:00:00.000Z';
  const startedStatuses = new Set(['IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED', 'COMPLETED']);
  const startedAt = startedStatuses.has(input.status) && input.type !== 'SALE'
    ? new Date(Date.parse(createdAt) + HOUR_MS).toISOString()
    : null;
  const staffCompletedAt = ['WAITING_APPROVAL', 'REVISION_REQUESTED', 'COMPLETED'].includes(input.status)
    ? new Date(Date.parse(createdAt) + 2 * HOUR_MS).toISOString()
    : null;
  const managerApprovedAt = input.status === 'COMPLETED'
    ? new Date(Date.parse(createdAt) + 3 * HOUR_MS).toISOString()
    : null;
  const cancelledAt = input.status === 'CANCELLED' ? createdAt : null;
  const invalidatedAt = input.status === 'INVALIDATED' ? createdAt : null;
  const saleType = input.type === 'SALE';
  const sourceJobCardId = saleType ? null : input.sourceJobCardId ?? null;
  // 022 present-iff contract: a linked child always carries instructions, a
  // root card never does.
  const followUpInstructions = sourceJobCardId === null ? null : 'FLOW-001/A takip talimatı';
  return (await pool.query<{ id: string }>(
    `INSERT INTO job_cards (
       organization_id, type, title, status, customer_id, assigned_to, created_by,
       priority, due_date, scheduled_at, engagement_kind, source_job_card_id,
       follow_up_instructions, sale_source_visit_id, delivery_source_sale_id, created_at,
       started_at, staff_completed_at, staff_completed_by,
       manager_approved_at, manager_approved_by,
       cancelled_at, cancelled_by, cancel_reason,
       invalidated_at, invalidated_by, invalidation_reason_code
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7,
       'normal', $8, $9, $10, $11,
       $12, $13, $14, $15,
       $16, $17, $18,
       $19, $20,
       $21, $22, $23,
       $24, $25, $26
     ) RETURNING id`,
    [
      input.organizationId,
      input.type,
      input.title ?? `FLOW-001/A ${input.type}`,
      input.status,
      input.customerId ?? null,
      input.assignedTo,
      input.createdBy,
      saleType ? null : input.dueDate ?? null,
      saleType ? null : input.scheduledAt ?? null,
      saleType ? null : input.engagementKind ?? null,
      sourceJobCardId,
      followUpInstructions,
      saleType ? input.saleSourceVisitId ?? null : null,
      input.deliverySourceSaleId ?? null,
      createdAt,
      startedAt,
      staffCompletedAt,
      staffCompletedAt ? input.assignedTo : null,
      managerApprovedAt,
      managerApprovedAt ? input.createdBy : null,
      cancelledAt,
      cancelledAt ? input.createdBy : null,
      cancelledAt ? 'FLOW-001/A cancellation' : null,
      invalidatedAt,
      invalidatedAt ? input.createdBy : null,
      invalidatedAt ? 'DUPLICATE' : null,
    ],
  )).rows[0]!.id;
}

async function insertMeetingDetails(
  pool: Pool,
  organizationId: string,
  jobCardId: string,
  meetingAt: string,
  outcome: MeetingOutcome,
) {
  await pool.query(
    `INSERT INTO job_card_meeting_details
       (organization_id, job_card_id, meeting_at, outcome, meeting_summary)
     VALUES ($1, $2, $3, $4, 'Görüşme tamamlandı.')`,
    [organizationId, jobCardId, meetingAt, outcome],
  );
}

async function insertSaleDetails(
  pool: Pool,
  organizationId: string,
  jobCardId: string,
  soldAt: string,
  source: { visitTitle: string; customerName: string } | null,
) {
  await pool.query(
    `INSERT INTO job_card_sale_details (
       organization_id, job_card_id, sold_at,
       source_visit_version, source_visit_title_snapshot, source_customer_name_snapshot
     ) VALUES ($1, $2, $3, $4, $5, $6)`,
    source === null
      ? [organizationId, jobCardId, soldAt, null, null, null]
      : [organizationId, jobCardId, soldAt, 1, source.visitTitle, source.customerName],
  );
}

describe.skipIf(!databaseUrl)('FLOW-001/A baseline findings (PostgreSQL)', () => {
  const schema = `flow001a_${randomUUID().replaceAll('-', '')}`;
  let adminPool: Pool;
  let pool: Pool;
  let reports: PostgresReportsRepository;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrl });
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema},public`,
    });
    await runMigrations({
      migrationsDirectory,
      store: new PostgresMigrationStore(pool),
    });
    reports = new PostgresReportsRepository(pool);
  });

  afterAll(async () => {
    await pool.end();
    await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);
    await adminPool.end();
  });

  // ---------------------------------------------------------------------------
  // F01 — meeting-details-input.ts validateMeetingDetailsCandidate;
  //        submission-policy.ts:100–206; web/src/jobs/MeetingDetails.tsx:332–353.
  // A held POSITIVE meeting requires a follow-up without claiming failure; a
  // held FOLLOW_UP_REQUIRED meeting requires an *unsuccessful* reason; a held
  // NO_DECISION meeting cannot request a follow-up at all.
  // ---------------------------------------------------------------------------
  describe('F01 meeting outcome vs follow-up intent', () => {
    it('auto-creates the follow-up proposal for a held POSITIVE meeting without a failure reason', async () => {
      const org = await seedOrganization(pool, 'F01 positive');
      const service = new JobCardService(new PostgresJobCardRepository(pool));
      const baseline = baselineAlignedToGrid(await readDbBaseline(pool));
      const visit = await createStartedMeeting(service, org.staff, org.customerId, {
        clientActionId: randomUUID(),
        engagementKind: 'CUSTOMER_VISIT',
        scheduledAt: baselineIso(baseline, -HOUR_MS),
      });
      const detailed = await service.patchMeetingDetails(org.staff, visit.id, {
        clientActionId: randomUUID(),
        expectedVersion: visit.version,
        meetingAt: baselineIso(baseline, -30 * MINUTE_MS),
        outcome: 'POSITIVE',
        meetingSummary: 'Karar olumlu, sözleşme bekleniyor.',
      });

      // POSITIVE is a held, successful meeting: no unsuccessful reason exists,
      // and the mandatory proposal is generated server-side even when the
      // client sends none. A POSITIVE visit can never close without a next one.
      const submitted = await service.submitForApproval(org.staff, visit.id, {
        clientActionId: randomUUID(),
        expectedVersion: detailed.jobCardVersion,
        note: 'Görüşme tamamlandı.',
      });
      expect(submitted.status).toBe('WAITING_APPROVAL');
      expect(submitted.followUpProposal).toMatchObject({
        type: 'SALES_MEETING',
        assignedTo: org.staffId,
        origin: 'SYSTEM',
      });
      expect(submitted.followUpProposal?.scheduledAt).toBeTruthy();
    });

    it('rejects FOLLOW_UP_REQUIRED without an unsuccessful reason at write time and at submit time', async () => {
      const org = await seedOrganization(pool, 'F01 follow-up required');
      const service = new JobCardService(new PostgresJobCardRepository(pool));
      const baseline = baselineAlignedToGrid(await readDbBaseline(pool));
      const visit = await createStartedMeeting(service, org.staff, org.customerId, {
        clientActionId: randomUUID(),
        engagementKind: 'CUSTOMER_VISIT',
        scheduledAt: baselineIso(baseline, -HOUR_MS),
      });
      const heldAt = baselineIso(baseline, -30 * MINUTE_MS);

      // Write-time guard: the merged record cannot be FOLLOW_UP_REQUIRED
      // without a reason, even though the meeting was actually held.
      await expect(service.patchMeetingDetails(org.staff, visit.id, {
        clientActionId: randomUUID(),
        expectedVersion: visit.version,
        meetingAt: heldAt,
        outcome: 'FOLLOW_UP_REQUIRED',
        meetingSummary: 'Görüşme yapıldı, karar bekliyor.',
      })).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        statusCode: 400,
        details: { fieldErrors: { unsuccessfulReason: expect.any(String) } },
      });

      // A pre-existing/legacy row can still hold that combination (042 did not
      // add a DB CHECK for it); submission then names the missing reason.
      await pool.query(
        `UPDATE job_card_meeting_details
            SET outcome = 'FOLLOW_UP_REQUIRED',
                unsuccessful_reason_code = NULL,
                meeting_at = $2,
                meeting_summary = 'Görüşme yapıldı, karar bekliyor.'
          WHERE organization_id = $1 AND job_card_id = $3`,
        [org.organizationId, heldAt, visit.id],
      );
      const current = await service.detail(org.staff, visit.id);
      await expect(service.submitForApproval(org.staff, visit.id, {
        clientActionId: randomUUID(),
        expectedVersion: current.version,
        note: 'Görüşme tamamlandı.',
      })).rejects.toMatchObject({
        code: 'MEETING_NOT_READY',
        statusCode: 400,
        details: { fieldErrors: { unsuccessfulReason: expect.any(String) } },
      });
    });

    it('does not let a held undecided meeting request a follow-up unless it is declared an unsuccessful visit', async () => {
      const org = await seedOrganization(pool, 'F01 undecided');
      const service = new JobCardService(new PostgresJobCardRepository(pool));
      const baseline = baselineAlignedToGrid(await readDbBaseline(pool));
      const undecided = await createStartedMeeting(service, org.staff, org.customerId, {
        clientActionId: randomUUID(),
        engagementKind: 'CUSTOMER_VISIT',
        scheduledAt: baselineIso(baseline, -2 * HOUR_MS),
      });
      const undecidedDetails = await service.patchMeetingDetails(org.staff, undecided.id, {
        clientActionId: randomUUID(),
        expectedVersion: undecided.version,
        meetingAt: baselineIso(baseline, -90 * MINUTE_MS),
        outcome: 'NO_DECISION',
        meetingSummary: 'Görüşme yapıldı, müşteri kararını henüz vermedi.',
      });

      // A held, undecided meeting is not a failed visit, so the mandatory loop
      // predicate is false and the proposal is rejected as unsupported...
      await expect(service.submitForApproval(org.staff, undecided.id, {
        clientActionId: randomUUID(),
        expectedVersion: undecidedDetails.jobCardVersion,
        note: 'Görüşme tamamlandı.',
        followUpProposal: {
          type: 'SALES_MEETING',
          assignedTo: org.staffId,
          followUpInstructions: 'Kararı teyit etmek için tekrar ziyaret.',
        },
      })).rejects.toMatchObject({
        code: 'FOLLOW_UP_PROPOSAL_INVALID',
        statusCode: 400,
      });

      // ...and submitting it without a proposal closes the meeting with no next
      // visit. This is the model limitation: no outcome means "held, decision
      // pending, schedule another visit".
      const submitted = await service.submitForApproval(org.staff, undecided.id, {
        clientActionId: randomUUID(),
        expectedVersion: undecidedDetails.jobCardVersion,
        note: 'Görüşme tamamlandı.',
      });
      expect(submitted.status).toBe('WAITING_APPROVAL');
      expect(submitted.followUpProposal).toBeNull();

      // The only reachable way to keep the cycle is to declare the held visit
      // FOLLOW_UP_REQUIRED with one of the failure reason codes (042 list).
      const followUpVisit = await createStartedMeeting(service, org.staff, org.customerId, {
        clientActionId: randomUUID(),
        engagementKind: 'CUSTOMER_VISIT',
        scheduledAt: baselineIso(baseline, -3 * HOUR_MS),
      });
      const followUpDetails = await service.patchMeetingDetails(org.staff, followUpVisit.id, {
        clientActionId: randomUUID(),
        expectedVersion: followUpVisit.version,
        meetingAt: baselineIso(baseline, -150 * MINUTE_MS),
        outcome: 'FOLLOW_UP_REQUIRED',
        unsuccessfulReason: 'OTHER',
        meetingSummary: 'Görüşme yapıldı, karar için ek ziyaret gerekiyor.',
      });
      const followUpSubmitted = await service.submitForApproval(org.staff, followUpVisit.id, {
        clientActionId: randomUUID(),
        expectedVersion: followUpDetails.jobCardVersion,
        note: 'Görüşme tamamlandı.',
        followUpProposal: {
          type: 'SALES_MEETING',
          assignedTo: org.staffId,
          followUpInstructions: 'Karar için tekrar ziyaret.',
        },
      });
      expect(followUpSubmitted.status).toBe('WAITING_APPROVAL');
      expect(followUpSubmitted.followUpProposal).toMatchObject({
        type: 'SALES_MEETING',
        origin: 'SYSTEM',
      });
      const row = (await pool.query<{ meeting_at: string | null; unsuccessful_reason_code: string }>(
        `SELECT meeting_at, unsuccessful_reason_code FROM job_card_meeting_details
          WHERE organization_id = $1 AND job_card_id = $2`,
        [org.organizationId, followUpVisit.id],
      )).rows[0]!;
      expect(row.unsuccessful_reason_code).toBe('OTHER');
      expect(row.meeting_at).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // F02 — reports/repository.ts:911–948,1480–1557; reports/business-trend.ts:22–57.
  // Business trend calls every completed SALES_MEETING that has a meeting_at a
  // "visit"; the sales follow-up outcome distribution groups every completed
  // SALES_MEETING (held or not). Neither exposes an engagement-kind breakdown.
  // ---------------------------------------------------------------------------
  describe('F02 aggregate outcome totals group every SALES_MEETING', () => {
    it('counts CUSTOMER_VISIT, manual FOLLOW_UP and PRODUCT_DEMO meetings as the same outcome/visit row', async () => {
      const org = await seedOrganization(pool, 'F02 grouped outcomes');
      const visitIds = {
        customerVisit: await insertCard(pool, {
          organizationId: org.organizationId, assignedTo: org.staffId, createdBy: org.managerId,
          type: 'SALES_MEETING', status: 'COMPLETED', engagementKind: 'CUSTOMER_VISIT',
          customerId: org.customerId, scheduledAt: '2026-09-05T07:00:00.000Z',
          createdAt: '2026-09-05T06:00:00.000Z',
        }),
        manualFollowUp: await insertCard(pool, {
          organizationId: org.organizationId, assignedTo: org.staffId, createdBy: org.managerId,
          type: 'SALES_MEETING', status: 'COMPLETED', engagementKind: 'FOLLOW_UP',
          customerId: org.customerId, scheduledAt: '2026-09-08T07:00:00.000Z',
          createdAt: '2026-09-08T06:00:00.000Z',
        }),
        productDemo: await insertCard(pool, {
          organizationId: org.organizationId, assignedTo: org.staffId, createdBy: org.managerId,
          type: 'SALES_MEETING', status: 'COMPLETED', engagementKind: 'PRODUCT_DEMO',
          customerId: org.customerId, scheduledAt: '2026-09-11T07:00:00.000Z',
          createdAt: '2026-09-11T06:00:00.000Z',
        }),
      };
      for (const [index, id] of Object.values(visitIds).entries()) {
        await insertMeetingDetails(
          pool, org.organizationId, id,
          `2026-09-${String(5 + index * 3).padStart(2, '0')}T07:30:00.000Z`,
          'POSITIVE',
        );
      }
      // One completed not-held visit (JOB-010 release 2a shape): no meeting_at,
      // FOLLOW_UP_REQUIRED plus its structured reason. It is NOT a "visit" for
      // the business trend but IS present in the outcome distribution, which
      // attributes it to staff_completed_at.
      const notHeld = await insertCard(pool, {
        organizationId: org.organizationId, assignedTo: org.staffId, createdBy: org.managerId,
        type: 'SALES_MEETING', status: 'COMPLETED', engagementKind: 'CUSTOMER_VISIT',
        customerId: org.customerId, scheduledAt: '2026-09-14T07:00:00.000Z',
        createdAt: '2026-09-14T06:00:00.000Z',
      });
      await pool.query(
        `INSERT INTO job_card_meeting_details (
           organization_id, job_card_id, meeting_at, outcome, unsuccessful_reason_code, meeting_summary
         ) VALUES ($1, $2, NULL, 'FOLLOW_UP_REQUIRED', 'CUSTOMER_UNREACHABLE', 'Müşteriye ulaşılamadı.')`,
        [org.organizationId, notHeld],
      );

      const trend = await reports.getBusinessTrend({
        organizationId: org.organizationId,
        requestedRange: { from: '2026-09-01', to: '2026-09-30' },
        requestTime: new Date('2026-10-05T12:00:00.000Z'),
        includeSaleCapability: true,
      });
      expect(trend.totals).toEqual({ visits: 3, followUps: 0, sales: 0 });
      // The response has no engagement-kind dimension at all.
      expect(Object.keys(trend.totals).sort()).toEqual(['followUps', 'sales', 'visits']);
      expect(Object.keys(trend.relationships).sort()).toEqual([
        'followUpsWithSale', 'visitsWithFollowUp', 'visitsWithSale',
      ]);

      const salesFollowUp = await reports.getSalesFollowUpReport({
        organizationId: org.organizationId,
        requestedRange: { from: '2026-09-01', to: '2026-09-30' },
        requestTime: new Date('2026-10-05T12:00:00.000Z'),
        limit: 50, offset: 0, proposalLimit: 50, proposalOffset: 0,
      });
      // Business trend still says three visits: the not-held record has no
      // meeting_at and is not a visit. The outcome distribution counts it.
      expect(salesFollowUp.period.meetingOutcomeDistribution).toEqual([
        { outcome: 'POSITIVE', count: 3 },
        { outcome: 'FOLLOW_UP_REQUIRED', count: 1 },
        { outcome: 'NO_DECISION', count: 0 },
        { outcome: 'NOT_INTERESTED', count: 0 },
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // F07 — business-trend.ts:23–35,49–57 vs follow-up-policy.ts:124–133.
  // Follow-up provenance (source_job_card_id) is not the same dimension as the
  // engagement kind: a manual FOLLOW_UP meeting without a source is invisible
  // to the follow-up counter, while a linked child with an unrelated kind is
  // counted as a follow-up.
  // ---------------------------------------------------------------------------
  describe('F07 follow-up provenance differs from engagement kind', () => {
    it('counts a linked PRODUCT_DEMO child as a follow-up and omits a source-less manual FOLLOW_UP meeting', async () => {
      const org = await seedOrganization(pool, 'F07 provenance vs kind');
      const parent = await insertCard(pool, {
        organizationId: org.organizationId, assignedTo: org.staffId, createdBy: org.managerId,
        type: 'SALES_MEETING', status: 'COMPLETED', engagementKind: 'CUSTOMER_VISIT',
        customerId: org.customerId, scheduledAt: '2026-09-05T07:00:00.000Z',
        createdAt: '2026-09-05T06:00:00.000Z',
      });
      await insertMeetingDetails(pool, org.organizationId, parent, '2026-09-05T07:30:00.000Z', 'POSITIVE');
      const manualFollowUp = await insertCard(pool, {
        organizationId: org.organizationId, assignedTo: org.staffId, createdBy: org.managerId,
        type: 'SALES_MEETING', status: 'COMPLETED', engagementKind: 'FOLLOW_UP',
        customerId: org.customerId, scheduledAt: '2026-09-08T07:00:00.000Z',
        createdAt: '2026-09-08T06:00:00.000Z',
      });
      await insertMeetingDetails(
        pool, org.organizationId, manualFollowUp, '2026-09-08T07:30:00.000Z', 'POSITIVE',
      );
      const linkedDemoChild = await insertCard(pool, {
        organizationId: org.organizationId, assignedTo: org.staffId, createdBy: org.managerId,
        type: 'SALES_MEETING', status: 'COMPLETED', engagementKind: 'PRODUCT_DEMO',
        customerId: org.customerId, sourceJobCardId: parent,
        scheduledAt: '2026-09-11T07:00:00.000Z', createdAt: '2026-09-11T06:00:00.000Z',
      });
      await insertMeetingDetails(
        pool, org.organizationId, linkedDemoChild, '2026-09-11T07:30:00.000Z', 'POSITIVE',
      );
      // Current workload is active-only, so one linked child stays IN_PROGRESS
      // to show that `current.followUpChildren` also buckets by provenance, not
      // by engagement kind (its kind is PRODUCT_DEMO, not FOLLOW_UP).
      const activeDemoChild = await insertCard(pool, {
        organizationId: org.organizationId, assignedTo: org.staffId, createdBy: org.managerId,
        type: 'SALES_MEETING', status: 'IN_PROGRESS', engagementKind: 'PRODUCT_DEMO',
        customerId: org.customerId, sourceJobCardId: parent,
        scheduledAt: '2026-09-15T07:00:00.000Z', createdAt: '2026-09-15T06:00:00.000Z',
      });
      expect(activeDemoChild).toBeTruthy();

      const trend = await reports.getBusinessTrend({
        organizationId: org.organizationId,
        requestedRange: { from: '2026-09-01', to: '2026-09-30' },
        requestTime: new Date('2026-10-05T12:00:00.000Z'),
        includeSaleCapability: true,
      });
      expect(trend.totals).toEqual({ visits: 3, followUps: 1, sales: 0 });
      expect(trend.relationships).toEqual({
        visitsWithFollowUp: 1,
        visitsWithSale: 0,
        followUpsWithSale: 0,
      });

      const salesFollowUp = await reports.getSalesFollowUpReport({
        organizationId: org.organizationId,
        requestedRange: { from: '2026-09-01', to: '2026-09-30' },
        requestTime: new Date('2026-10-05T12:00:00.000Z'),
        limit: 50, offset: 0, proposalLimit: 50, proposalOffset: 0,
      });
      // Two linked children (both JobCard type SALES_MEETING): one completed
      // PRODUCT_DEMO meeting and one active PRODUCT_DEMO meeting. Provenance,
      // not the engagement kind, puts them in the follow-up counters.
      expect(salesFollowUp.relationships.directFollowUpLinks).toBe(2);
      expect(salesFollowUp.current.followUpChildren.total).toBe(1);
      expect(salesFollowUp.current.followUpChildren.typeDistribution).toEqual([
        { type: 'PRODUCT_DELIVERY', count: 0 },
        { type: 'GENERAL_TASK', count: 0 },
        { type: 'SALES_MEETING', count: 1 },
      ]);
      expect(salesFollowUp.period.followUpChildrenCreated).toBe(2);
      // The manual FOLLOW_UP meeting is present only in the outcome dimension.
      expect(salesFollowUp.period.meetingOutcomeDistribution[0]).toEqual({
        outcome: 'POSITIVE', count: 3,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // F08 — business-trend.ts:49–79; reports/types.ts.
  // Direct visit→sale / visit→follow-up links are counted, the chain is not a
  // funnel, and there is no delivery dimension in the query.
  // ---------------------------------------------------------------------------
  describe('F08 direct relationship projections only, without a delivery dimension', () => {
    it('reports the direct links, misses the visit→follow-up→sale chain, and is unchanged by a completed delivery', async () => {
      const org = await seedOrganization(pool, 'F08 direct links');
      const visit = await insertCard(pool, {
        organizationId: org.organizationId, assignedTo: org.staffId, createdBy: org.managerId,
        type: 'SALES_MEETING', status: 'COMPLETED', engagementKind: 'CUSTOMER_VISIT',
        customerId: org.customerId, scheduledAt: '2026-09-05T07:00:00.000Z',
        createdAt: '2026-09-05T06:00:00.000Z',
      });
      await insertMeetingDetails(pool, org.organizationId, visit, '2026-09-05T07:30:00.000Z', 'POSITIVE');
      const child = await insertCard(pool, {
        organizationId: org.organizationId, assignedTo: org.staffId, createdBy: org.managerId,
        type: 'SALES_MEETING', status: 'COMPLETED', engagementKind: 'FOLLOW_UP',
        customerId: org.customerId, sourceJobCardId: visit,
        scheduledAt: '2026-09-12T07:00:00.000Z', createdAt: '2026-09-12T06:00:00.000Z',
      });
      await insertMeetingDetails(pool, org.organizationId, child, '2026-09-12T07:30:00.000Z', 'POSITIVE');
      // The only sale belongs to the follow-up child; the chain is not folded
      // back onto the visit.
      const sale = await insertCard(pool, {
        organizationId: org.organizationId, assignedTo: org.staffId, createdBy: org.managerId,
        type: 'SALE', status: 'COMPLETED', customerId: org.customerId,
        saleSourceVisitId: child, createdAt: '2026-09-13T06:00:00.000Z',
      });
      await insertSaleDetails(pool, org.organizationId, sale, '2026-09-13T07:00:00.000Z', {
        visitTitle: 'Klinik ziyareti', customerName: `Klinik F08 direct links`,
      });

      const range = { from: '2026-09-01', to: '2026-09-30' };
      const requestTime = new Date('2026-10-05T12:00:00.000Z');
      const before = await reports.getBusinessTrend({
        organizationId: org.organizationId,
        requestedRange: range,
        requestTime,
        includeSaleCapability: true,
      });
      expect(before.totals).toEqual({ visits: 2, followUps: 1, sales: 1 });
      // The cohort includes the follow-up child as a "visit" row, so the one
      // visitsWithSale match is the child itself, not the original visit. The
      // response therefore has no root-visit conversion attribution: a
      // visit→follow-up→sale chain produces visitsWithSale and
      // followUpsWithSale on different cohort rows without a funnel link.
      expect(before.relationships).toEqual({
        visitsWithFollowUp: 1,
        visitsWithSale: 1,
        followUpsWithSale: 1,
      });

      // A completed delivery (and its item) linked to the sale adds no metric.
      const delivery = await insertCard(pool, {
        organizationId: org.organizationId, assignedTo: org.staffId, createdBy: org.managerId,
        type: 'PRODUCT_DELIVERY', status: 'COMPLETED', customerId: org.customerId,
        deliverySourceSaleId: sale, createdAt: '2026-09-14T06:00:00.000Z',
      });
      await pool.query(
        `INSERT INTO job_card_delivery_items (
           organization_id, job_card_id, product_id, delivery_purpose,
           delivered_at, quantity, unit, product_name_snapshot
         ) VALUES ($1, $2, $3, 'SALE', '2026-09-14T07:00:00.000Z', 1, 'adet', 'İmplant seti')`,
        [org.organizationId, delivery, org.productId],
      );

      const after = await reports.getBusinessTrend({
        organizationId: org.organizationId,
        requestedRange: range,
        requestTime,
        includeSaleCapability: true,
      });
      expect(after).toEqual(before);
      expect(Object.keys(after)).not.toContain('delivery');
    });
  });

  // ---------------------------------------------------------------------------
  // F03 — migration 071:38–43; SALE-002 Q4 (DECISIONS.md SALE-002 §6).
  // The unique index keeps the delivery slot for the lifetime of the sale, so a
  // cancelled or invalidated linked delivery still blocks a replacement.
  // ---------------------------------------------------------------------------
  describe('F03 one-delivery-per-sale slot survives cancellation and invalidation', () => {
    it('rejects a second linked delivery after the first is cancelled or invalidated', async () => {
      const org = await seedOrganization(pool, 'F03 delivery slot');
      const saleOne = await insertCard(pool, {
        organizationId: org.organizationId, assignedTo: org.staffId, createdBy: org.managerId,
        type: 'SALE', status: 'NEW', customerId: org.customerId,
      });
      const cancelledDelivery = await insertCard(pool, {
        organizationId: org.organizationId, assignedTo: org.staffId, createdBy: org.managerId,
        type: 'PRODUCT_DELIVERY', status: 'NEW', customerId: org.customerId,
        deliverySourceSaleId: saleOne,
      });
      await pool.query(
        `UPDATE job_cards SET status = 'CANCELLED', cancelled_at = NOW(),
           cancelled_by = $2, cancel_reason = 'FLOW-001/A cancelled attempt'
         WHERE id = $1`,
        [cancelledDelivery, org.managerId],
      );
      const replacementOne = await insertCard(pool, {
        organizationId: org.organizationId, assignedTo: org.staffId, createdBy: org.managerId,
        type: 'PRODUCT_DELIVERY', status: 'NEW', customerId: org.customerId,
      });
      await expect(pool.query(
        'UPDATE job_cards SET delivery_source_sale_id = $2 WHERE id = $1',
        [replacementOne, saleOne],
      )).rejects.toMatchObject({
        code: '23505',
        constraint: 'job_cards_one_delivery_per_sale_idx',
      });

      const saleTwo = await insertCard(pool, {
        organizationId: org.organizationId, assignedTo: org.staffId, createdBy: org.managerId,
        type: 'SALE', status: 'NEW', customerId: org.customerId,
      });
      const invalidatedDelivery = await insertCard(pool, {
        organizationId: org.organizationId, assignedTo: org.staffId, createdBy: org.managerId,
        type: 'PRODUCT_DELIVERY', status: 'NEW', customerId: org.customerId,
        deliverySourceSaleId: saleTwo,
      });
      await pool.query(
        `UPDATE job_cards SET status = 'INVALIDATED', invalidated_at = NOW(),
           invalidated_by = $2, invalidation_reason_code = 'DUPLICATE'
         WHERE id = $1`,
        [invalidatedDelivery, org.managerId],
      );
      const replacementTwo = await insertCard(pool, {
        organizationId: org.organizationId, assignedTo: org.staffId, createdBy: org.managerId,
        type: 'PRODUCT_DELIVERY', status: 'NEW', customerId: org.customerId,
      });
      await expect(pool.query(
        'UPDATE job_cards SET delivery_source_sale_id = $2 WHERE id = $1',
        [replacementTwo, saleTwo],
      )).rejects.toMatchObject({
        code: '23505',
        constraint: 'job_cards_one_delivery_per_sale_idx',
      });

      // Control: an unused sale still accepts exactly one linked delivery.
      const saleThree = await insertCard(pool, {
        organizationId: org.organizationId, assignedTo: org.staffId, createdBy: org.managerId,
        type: 'SALE', status: 'NEW', customerId: org.customerId,
      });
      const linked = await insertCard(pool, {
        organizationId: org.organizationId, assignedTo: org.staffId, createdBy: org.managerId,
        type: 'PRODUCT_DELIVERY', status: 'NEW', customerId: org.customerId,
      });
      await pool.query(
        'UPDATE job_cards SET delivery_source_sale_id = $2 WHERE id = $1',
        [linked, saleThree],
      );
      expect((await pool.query<{ delivery_source_sale_id: string }>(
        'SELECT delivery_source_sale_id FROM job_cards WHERE id = $1', [linked],
      )).rows[0]!.delivery_source_sale_id).toBe(saleThree);
    });
  });

  // ---------------------------------------------------------------------------
  // F04 — create-input.ts:85–91; reports/repository.ts:1464–1478,1593–1603;
  //        web/src/reports/SalesFollowUpReport.tsx OVERDUE_HINT.
  // A SALES_MEETING follow-up child may not carry a dueDate, and the report's
  // "overdue" counter is due-date-only, so an approval-created follow-up whose
  // planned start has passed is not counted as overdue.
  // ---------------------------------------------------------------------------
  describe('F04 due-date-only overdue metric excludes scheduled follow-up children', () => {
    it('rejects a dueDate on a SALES_MEETING follow-up and does not count a past-start automatic child', async () => {
      // Pure SSOT guard: general tasks accept a due date, meeting children do not.
      expect(() => normalizeFollowUpDueDate('2026-10-30', 'SALES_MEETING')).toThrowError(
        expect.objectContaining({
          code: 'VALIDATION_ERROR',
          details: { fieldErrors: { dueDate: expect.any(String) } },
        }),
      );
      expect(normalizeFollowUpDueDate('2026-10-30', 'GENERAL_TASK')).toBe('2026-10-30');

      const org = await seedOrganization(pool, 'F04 overdue scope');
      const baseline = baselineAlignedToGrid(await readDbBaseline(pool));
      const service = new JobCardService(new PostgresJobCardRepository(pool));
      const visit = await createStartedMeeting(service, org.staff, org.customerId, {
        clientActionId: randomUUID(),
        engagementKind: 'CUSTOMER_VISIT',
        scheduledAt: baselineIso(baseline, -HOUR_MS),
      });
      const details = await service.patchMeetingDetails(org.staff, visit.id, {
        clientActionId: randomUUID(),
        expectedVersion: visit.version,
        meetingAt: baselineIso(baseline, -30 * MINUTE_MS),
        outcome: 'POSITIVE',
        meetingSummary: 'Görüşme olumlu; takip ziyareti gerekli.',
      });
      const submitted = await service.submitForApproval(org.staff, visit.id, {
        clientActionId: randomUUID(),
        expectedVersion: details.jobCardVersion,
        note: 'Görüşme tamamlandı.',
        followUpProposal: {
          type: 'SALES_MEETING',
          assignedTo: org.staffId,
          followUpInstructions: 'Takip ziyareti planla.',
        },
      });
      expect(submitted.status).toBe('WAITING_APPROVAL');

      // Manager override with a dueDate is rejected for a meeting child.
      await expect(service.approve(org.manager, visit.id, {
        clientActionId: randomUUID(),
        expectedVersion: submitted.version,
        note: 'Onaylandı.',
        followUp: {
          type: 'SALES_MEETING',
          assignedTo: org.staffId,
          followUpInstructions: 'Takip ziyareti planla.',
          dueDate: localDateKey(new Date(baseline.getTime() + 20 * DAY_MS), TIMEZONE),
        },
      })).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        statusCode: 400,
        details: { fieldErrors: { dueDate: expect.any(String) } },
      });

      const approved = await service.approve(org.manager, visit.id, {
        clientActionId: randomUUID(),
        expectedVersion: submitted.version,
        note: 'Onaylandı.',
      });
      expect(approved.status).toBe('COMPLETED');
      const child = (await pool.query<{
        id: string; type: string; status: string;
        due_date: string | null; scheduled_at: Date; engagement_kind: string;
      }>(
        `SELECT id, type, status, due_date, scheduled_at, engagement_kind
           FROM job_cards WHERE organization_id = $1 AND source_job_card_id = $2`,
        [org.organizationId, visit.id],
      )).rows[0]!;
      expect(child).toMatchObject({
        type: 'SALES_MEETING',
        status: 'ACCEPTED',
        due_date: null,
        engagement_kind: 'FOLLOW_UP',
      });
      const childScheduledAt = child.scheduled_at;
      expect(childScheduledAt.valueOf()).toBeGreaterThan(baseline.valueOf());

      // Read the report after the child's planned start has passed.
      const reportTime = new Date(baseline.getTime() + 30 * DAY_MS);
      const range = {
        from: localDateKey(new Date(baseline.getTime() - 10 * DAY_MS), TIMEZONE),
        to: localDateKey(new Date(baseline.getTime() + 40 * DAY_MS), TIMEZONE),
      };
      const readReport = () => reports.getSalesFollowUpReport({
        organizationId: org.organizationId,
        requestedRange: range,
        requestTime: reportTime,
        limit: 50, offset: 0, proposalLimit: 50, proposalOffset: 0,
      });
      const noDueDateReport = await readReport();
      expect(noDueDateReport.current.followUpChildren.total).toBe(1);
      expect(noDueDateReport.current.followUpChildren.overdueDueDatedFollowUpChildren).toBe(0);

      // No other current operational list covers an accepted past start either:
      // the JOB-010 list is NEW-only (unaccepted past start).
      const laterService = new JobCardService(
        new PostgresJobCardRepository(pool), () => reportTime,
      );
      const unaccepted = await laterService.listUnacceptedPastStart(org.manager, {
        limit: 50, offset: 0,
      });
      expect(unaccepted.total).toBe(0);

      // Control: the same counter does see an active child that has a past due date.
      await insertCard(pool, {
        organizationId: org.organizationId, assignedTo: org.staffId, createdBy: org.managerId,
        type: 'GENERAL_TASK', status: 'NEW', customerId: org.customerId,
        sourceJobCardId: visit.id,
        dueDate: localDateKey(new Date(baseline.getTime() - DAY_MS), TIMEZONE),
        createdAt: baselineIso(baseline, DAY_MS),
      });
      const withDueDateReport = await readReport();
      expect(withDueDateReport.current.followUpChildren.total).toBe(2);
      expect(withDueDateReport.current.followUpChildren.overdueDueDatedFollowUpChildren).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // F05 — follow-up-policy.ts:86–122,213–216;
  //        job-cards/service.ts:3111–3113,8583–8598.
  // SALE is not a follow-up source; a mandatory-loop child may only be a
  // SALES_MEETING; the mandatory loop exists only for CUSTOMER_VISIT/FOLLOW_UP.
  // ---------------------------------------------------------------------------
  describe('F05 follow-up source and type restrictions', () => {
    it('rejects a completed SALE as a follow-up source', async () => {
      const org = await seedOrganization(pool, 'F05 sale source');
      const service = new JobCardService(new PostgresJobCardRepository(pool),
        () => new Date('2026-10-14T08:00:00.000Z'));
      const sale = await service.createStandaloneSale(org.staff, {
        clientActionId: randomUUID(),
        title: 'Telefon siparişi',
        description: null,
        customerId: org.customerId,
        assignedTo: org.staffId,
        soldAt: '2026-10-14T08:00:00.000Z',
        saleContactId: org.contactId,
        items: [{ productId: org.productId, quantity: 1 }],
      });
      const submitted = await service.submitForApproval(org.staff, sale.jobCardId, {
        clientActionId: randomUUID(),
        expectedVersion: sale.version,
        note: 'Satış onaya hazır.',
      });
      const approved = await service.approve(org.manager, sale.jobCardId, {
        clientActionId: randomUUID(),
        expectedVersion: submitted.version,
        note: 'Onaylandı.',
      });
      expect(approved.status).toBe('COMPLETED');

      await expect(service.createFollowUp(org.manager, sale.jobCardId, {
        clientActionId: randomUUID(),
        type: 'GENERAL_TASK',
        title: 'Takip araması',
        followUpInstructions: 'Satış sonrası arama.',
        scheduledAt: null,
        assignedTo: org.staffId,
        priority: 'normal',
        dueDate: null,
        contactId: null,
        engagementKind: null,
      })).rejects.toMatchObject({
        code: 'INVALID_JOB_TYPE',
        statusCode: 400,
      });
    });

    it('rejects a Staff non-SALES_MEETING follow-up type on the mandatory loop', async () => {
      const org = await seedOrganization(pool, 'F05 staff type');
      const baseline = baselineAlignedToGrid(await readDbBaseline(pool));
      const service = new JobCardService(new PostgresJobCardRepository(pool));
      const visit = await createStartedMeeting(service, org.staff, org.customerId, {
        clientActionId: randomUUID(),
        engagementKind: 'CUSTOMER_VISIT',
        scheduledAt: baselineIso(baseline, -HOUR_MS),
      });
      const details = await service.patchMeetingDetails(org.staff, visit.id, {
        clientActionId: randomUUID(),
        expectedVersion: visit.version,
        meetingAt: baselineIso(baseline, -30 * MINUTE_MS),
        outcome: 'POSITIVE',
        meetingSummary: 'Görüşme olumlu.',
      });
      await expect(service.submitForApproval(org.staff, visit.id, {
        clientActionId: randomUUID(),
        expectedVersion: details.jobCardVersion,
        note: 'Görüşme tamamlandı.',
        followUpProposal: {
          type: 'GENERAL_TASK',
          assignedTo: org.staffId,
          followUpInstructions: 'Serbest görev olarak takip.',
        },
      })).rejects.toMatchObject({
        code: 'FOLLOW_UP_PROPOSAL_INVALID',
        statusCode: 400,
      });
    });

    it('requires the loop only for CUSTOMER_VISIT/FOLLOW_UP and lets a PRODUCT_DEMO submit without a proposal', async () => {
      const fixed = { type: 'SALES_MEETING' as const };
      expect(requiresMandatoryFollowUpProposal({
        ...fixed, engagementKind: 'CUSTOMER_VISIT', outcome: 'POSITIVE',
      })).toBe(true);
      expect(requiresMandatoryFollowUpProposal({
        ...fixed, engagementKind: 'FOLLOW_UP', outcome: 'POSITIVE',
      })).toBe(true);
      expect(requiresMandatoryFollowUpProposal({
        ...fixed, engagementKind: 'FOLLOW_UP', outcome: 'FOLLOW_UP_REQUIRED',
        unsuccessfulReason: 'REQUESTED_LATER',
      })).toBe(true);
      expect(requiresMandatoryFollowUpProposal({
        ...fixed, engagementKind: 'FOLLOW_UP', outcome: 'FOLLOW_UP_REQUIRED',
        unsuccessfulReason: null,
      })).toBe(false);
      expect(requiresMandatoryFollowUpProposal({
        ...fixed, engagementKind: 'CUSTOMER_VISIT', outcome: 'NO_DECISION',
      })).toBe(false);
      expect(requiresMandatoryFollowUpProposal({
        ...fixed, engagementKind: 'PRODUCT_DEMO', outcome: 'POSITIVE',
      })).toBe(false);
      expect(requiresMandatoryFollowUpProposal({
        ...fixed, engagementKind: 'SALES_MEETING', outcome: 'POSITIVE',
      })).toBe(false);
      expect(requiresMandatoryFollowUpProposal({
        ...fixed, engagementKind: 'TRAINING', outcome: 'POSITIVE',
      })).toBe(false);
      expect(requiresMandatoryFollowUpProposal({
        type: 'PRODUCT_DELIVERY', engagementKind: null, outcome: 'POSITIVE',
      })).toBe(false);

      // Service-level control: the predicate above is what submission uses.
      const org = await seedOrganization(pool, 'F05 product demo');
      const baseline = baselineAlignedToGrid(await readDbBaseline(pool));
      const service = new JobCardService(new PostgresJobCardRepository(pool));
      const demo = await createStartedMeeting(service, org.staff, org.customerId, {
        clientActionId: randomUUID(),
        engagementKind: 'PRODUCT_DEMO',
        scheduledAt: baselineIso(baseline, -HOUR_MS),
      });
      const details = await service.patchMeetingDetails(org.staff, demo.id, {
        clientActionId: randomUUID(),
        expectedVersion: demo.version,
        meetingAt: baselineIso(baseline, -30 * MINUTE_MS),
        outcome: 'POSITIVE',
        meetingSummary: 'Demo yapıldı, karar bekleniyor.',
      });
      const submitted = await service.submitForApproval(org.staff, demo.id, {
        clientActionId: randomUUID(),
        expectedVersion: details.jobCardVersion,
        note: 'Demo tamamlandı.',
      });
      expect(submitted.status).toBe('WAITING_APPROVAL');
      expect(submitted.followUpProposal).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // F06 — sale-policy.ts:5–18 (SALE_SOURCE_ENGAGEMENT_KINDS).
  // TRAINING and OTHER are valid engagement kinds but not eligible sale origins.
  // ---------------------------------------------------------------------------
  describe('F06 TRAINING and OTHER are not eligible sale origins', () => {
    it('rejects a sale from TRAINING/OTHER visits while CUSTOMER_VISIT still works', async () => {
      const org = await seedOrganization(pool, 'F06 sale origins');
      const service = new JobCardService(new PostgresJobCardRepository(pool),
        () => new Date('2026-10-14T08:00:00.000Z'));
      const saleInput = (expectedSourceVersion: number) => ({
        clientActionId: randomUUID(),
        expectedSourceVersion,
        title: 'Ürün anlaşması',
        soldAt: '2026-10-14T08:00:00.000Z',
        saleContactId: org.contactId,
        items: [{ productId: org.productId, quantity: 1 }],
      });

      for (const [index, engagementKind] of (['TRAINING', 'OTHER'] as const).entries()) {
        const visit = await createStartedMeeting(service, org.staff, org.customerId, {
          clientActionId: randomUUID(),
          engagementKind,
          scheduledAt: `2026-10-14T0${4 + index}:00:00.000Z`,
        });
        await expect(service.createSaleFromVisit(org.staff, visit.id, saleInput(visit.version)))
          .rejects.toMatchObject({
            code: 'SALE_FROM_VISIT_SOURCE_NOT_ELIGIBLE',
            statusCode: 409,
          });
      }

      const eligibleVisit = await createStartedMeeting(service, org.staff, org.customerId, {
        clientActionId: randomUUID(),
        engagementKind: 'CUSTOMER_VISIT',
        scheduledAt: '2026-10-14T07:00:00.000Z',
      });
      const created = await service.createSaleFromVisit(
        org.staff, eligibleVisit.id, saleInput(eligibleVisit.version),
      );
      const row = (await pool.query<{ sale_source_visit_id: string }>(
        'SELECT sale_source_visit_id FROM job_cards WHERE id = $1', [created.jobCardId],
      )).rows[0]!;
      expect(row.sale_source_visit_id).toBe(eligibleVisit.id);
    });
  });
});
