/**
 * OVR-7 lateness reports — server-side acceptance on real PostgreSQL.
 *
 * Contract: `docs/features/reporting/lateness-reports.md` (§3 cohort, §4
 * classification, §5 Staff section, §6 Staff list, §7 organization card, §9
 * acceptance scenarios) and `DECISIONS.md` OVR-7. Every server-side scenario of
 * §9 is covered here except LR-14, which is a web-only visual scenario.
 *
 * The read model is exercised through `ReportsService`, so the assertions cover
 * the SQL classification and the composed DTO in one pass: `generatedAt`,
 * `trackingStartedOn` and every invariant belong to the service, everything
 * else to the repository query.
 *
 * Fixture policy: incidents, change requests and assignment history are
 * inserted directly where the lifecycle cannot produce the state (a historical
 * breach of a specific instant, a resolver whose current role changed later, a
 * recovery before the breach to prove the canonical clamp, a revision round
 * that never happened). Those rows are named in the test title. Organisation
 * time zone is the default `Europe/Istanbul` (UTC+03 all year), so
 * organization-local dates and their UTC instants differ by three hours on
 * purpose: a period boundary is only provable through the organisation's zone.
 */
import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import type { SafeUser } from '../src/modules/auth/types.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type {
  JobChangeRequestReasonCode,
  JobChangeRequestResolution,
  JobCardType,
} from '../src/modules/job-cards/types.js';
import { PostgresReportsRepository } from '../src/modules/reports/repository.js';
import { PostgresReportReadSnapshot } from '../src/modules/reports/read-snapshot.js';
import { ReportsService } from '../src/modules/reports/service.js';
import { insertProofOrg, withIntentSchema } from './support/lifecycle-intent-harness.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

/** Europe/Istanbul is UTC+03 all year: no DST since 2016. */
const LOCAL_OFFSET = '+03:00';
const local = (isoLocal: string) => new Date(`${isoLocal}${LOCAL_OFFSET}`);
const iso = (instant: Date) => instant.toISOString();

/** Whole seconds between two organization-local 2026 instants. */
function sec(fromLocal: string, toLocal: string): number {
  return Math.round((local(toLocal).getTime() - local(fromLocal).getTime()) / 1000);
}

const OCTOBER = { from: '2026-10-01', to: '2026-10-31' } as const;
const NOVEMBER = { from: '2026-11-01', to: '2026-11-30' } as const;
const RESOLVED_OCTOBER = {
  from: OCTOBER.from,
  to: OCTOBER.to,
  timezone: 'Europe/Istanbul',
} as const;
const REQUEST_TIME = local('2026-11-05T12:00:00');

// ---------------------------------------------------------------------------
// Fixtures. Direct SQL only: no production write path is required to build a
// historical incident, and report reads never mutate.
// ---------------------------------------------------------------------------

async function seedUser(
  pool: Pool,
  organizationId: string,
  role: SafeUser['role'],
  name: string,
): Promise<SafeUser> {
  const row = (await pool.query<{
    id: string;
    organization_id: string;
    name: string;
    email: string;
    role: SafeUser['role'];
    is_active: boolean;
    version: number;
  }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role, is_active)
     VALUES ($1, $2, $3, 'test-hash', $4, TRUE)
     RETURNING id, organization_id, name, email, role, is_active, version`,
    [organizationId, name, `${name.toLowerCase().replaceAll(' ', '-')}-${randomUUID()}@test.local`, role],
  )).rows[0]!;
  if (role === 'STAFF') {
    await pool.query(
      `INSERT INTO staff_profiles (organization_id, user_id, title)
       VALUES ($1, $2, 'Saha Personeli')`,
      [organizationId, row.id],
    );
  }
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    email: row.email,
    role: row.role,
    mustChangePassword: false,
    isActive: row.is_active,
    version: row.version,
  };
}

type JobSeed = {
  organizationId: string;
  assignedTo: string;
  createdBy: string;
  title: string;
  type?: JobCardType;
  status?: 'NEW' | 'ACCEPTED' | 'IN_PROGRESS' | 'INVALIDATED';
  createdAt?: Date;
  customerId?: string | null;
  saleSourceVisitId?: string | null;
  engagementKind?: 'CUSTOMER_VISIT' | null;
  invalidation?: {
    at: Date;
    by: string;
    reasonCode: 'DUPLICATE' | 'WRONG_CUSTOMER' | 'CREATED_BY_MISTAKE'
      | 'TRAINING_OR_TEST_RECORD' | 'OTHER';
  };
};

/** A readable JobCard with its baseline schedule revision and assignment row. */
async function seedJob(pool: Pool, seed: JobSeed): Promise<string> {
  const createdAt = seed.createdAt ?? local('2026-09-25T09:00:00');
  const status = seed.status ?? 'NEW';
  const jobId = (await pool.query<{ id: string }>(
    `INSERT INTO job_cards (
       organization_id, type, status, title, assigned_to, created_by, created_at,
       started_at, customer_id, sale_source_visit_id, engagement_kind,
       invalidated_at, invalidated_by, invalidation_reason_code
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING id`,
    [
      seed.organizationId,
      seed.type ?? 'GENERAL_TASK',
      status,
      seed.title,
      seed.assignedTo,
      seed.createdBy,
      createdAt,
      status === 'IN_PROGRESS' ? createdAt : null,
      seed.customerId ?? null,
      seed.saleSourceVisitId ?? null,
      seed.engagementKind ?? null,
      seed.invalidation?.at ?? null,
      seed.invalidation?.by ?? null,
      seed.invalidation?.reasonCode ?? null,
    ],
  )).rows[0]!.id;
  await addScheduleRevision(pool, seed.organizationId, jobId, 1, createdAt, seed.createdBy);
  await addAssignmentHistory(pool, {
    organizationId: seed.organizationId,
    jobId,
    fromUserId: null,
    toUserId: seed.assignedTo,
    changedBy: seed.createdBy,
    changedAt: createdAt,
    source: 'CREATE',
  });
  return jobId;
}

async function addScheduleRevision(
  pool: Pool,
  organizationId: string,
  jobId: string,
  revisionNo: number,
  at: Date,
  createdBy: string,
  source: 'CREATE' | 'RESCHEDULE' | 'BASELINE' = 'RESCHEDULE',
): Promise<void> {
  await pool.query(
    `INSERT INTO job_card_schedule_revisions (
       organization_id, job_card_id, revision_no, organization_timezone, source,
       created_by, created_at)
     SELECT $1, $2, $3, o.timezone, $4, $5, $6
       FROM organizations o WHERE o.id = $1`,
    [organizationId, jobId, revisionNo, revisionNo === 1 ? 'CREATE' : source, createdBy, at],
  );
}

async function addAssignmentHistory(
  pool: Pool,
  seed: {
    organizationId: string;
    jobId: string;
    fromUserId: string | null;
    toUserId: string;
    changedBy: string;
    changedAt: Date;
    source: 'CREATE' | 'PATCH_REASSIGN' | 'OFFBOARDING' | 'BASELINE';
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO job_card_assignment_history (
       organization_id, job_card_id, from_user_id, to_user_id, changed_by, source, changed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      seed.organizationId,
      seed.jobId,
      seed.fromUserId,
      seed.toUserId,
      seed.changedBy,
      seed.source,
      seed.changedAt,
    ],
  );
}

type IncidentSeed = {
  organizationId: string;
  jobId: string;
  delayType: 'LATE_START' | 'LATE_SUBMISSION' | 'APPROVAL_WAIT';
  deadlineAt: Date;
  breachedAt: Date;
  episodeNo?: number;
  scheduleRevisionNo?: number;
  accountableRole?: 'STAFF' | 'MANAGEMENT';
  accountableSource?: 'ASSIGNMENT_AT_BREACH' | 'ROLE_POLICY' | 'UNKNOWN';
  accountableUserId?: string | null;
  source?: 'TRANSITION' | 'MUTATION' | 'SCANNER';
  recovery?: { at: Date; actorUserId: string };
  ending?: { at: Date; byUserId: string; note: string; scheduleRevisionNo: number };
  cardInvalidation?: { at: Date; byUserId: string };
};

async function addIncident(pool: Pool, seed: IncidentSeed): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO job_card_overdue_incidents (
       organization_id, job_card_id, delay_type, episode_no, schedule_revision_no,
       deadline_at, breached_at, accountable_role, accountable_source,
       accountable_user_id, source, recovered_at, recovery_actor_user_id,
       ended_at, ended_by_user_id, end_reason, end_note, ended_by_schedule_revision_no)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
             $16, $17, $18)
     RETURNING id`,
    [
      seed.organizationId,
      seed.jobId,
      seed.delayType,
      seed.episodeNo ?? 1,
      seed.scheduleRevisionNo ?? 1,
      seed.deadlineAt,
      seed.breachedAt,
      seed.accountableRole ?? 'STAFF',
      seed.accountableSource ?? 'ASSIGNMENT_AT_BREACH',
      seed.accountableUserId ?? null,
      seed.source ?? 'TRANSITION',
      seed.recovery?.at ?? null,
      seed.recovery?.actorUserId ?? null,
      seed.ending?.at ?? seed.cardInvalidation?.at ?? null,
      seed.ending?.byUserId ?? seed.cardInvalidation?.byUserId ?? null,
      seed.ending !== undefined
        ? 'DEADLINE_EXTENDED'
        : seed.cardInvalidation === undefined ? null : 'CARD_INVALIDATED',
      seed.ending?.note ?? null,
      seed.ending?.scheduleRevisionNo ?? null,
    ],
  )).rows[0]!.id;
}

type ChangeRequestSeed = {
  organizationId: string;
  jobId: string;
  requestedBy: string;
  requestedAt: Date;
  reasonCode: JobChangeRequestReasonCode;
  closure?: {
    resolution: JobChangeRequestResolution;
    resolvedAt: Date;
    resolvedBy: string | null;
    note?: string;
  };
};

async function addChangeRequest(pool: Pool, seed: ChangeRequestSeed): Promise<string> {
  const closure = seed.closure;
  return (await pool.query<{ id: string }>(
    `INSERT INTO job_card_change_requests (
       organization_id, job_card_id, requested_by, requested_at, job_status_at_request,
       reason_code, reason_text, client_action_id, state, resolution, resolved_by,
       resolved_at, resolution_note)
     VALUES ($1, $2, $3, $4, 'NEW', $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      seed.organizationId,
      seed.jobId,
      seed.requestedBy,
      seed.requestedAt,
      seed.reasonCode,
      'Plan değişikliği talebi',
      randomUUID(),
      closure === undefined ? 'OPEN' : 'CLOSED',
      closure?.resolution ?? null,
      closure?.resolvedBy ?? null,
      closure?.resolvedAt ?? null,
      closure?.note ?? null,
    ],
  )).rows[0]!.id;
}

async function seedCustomer(pool: Pool, organizationId: string): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO customers (organization_id, name, customer_type)
     VALUES ($1, 'OVR-7 Klinik', 'clinic') RETURNING id`,
    [organizationId],
  )).rows[0]!.id;
}

function buildReports(pool: Pool, now: () => Date = () => REQUEST_TIME): ReportsService {
  return new ReportsService(
    new PostgresReportsRepository(pool),
    new PostgresReportReadSnapshot(pool, new PostgresJobCardRepository(pool)),
    now,
  );
}

function buildJobCards(pool: Pool): JobCardService {
  return new JobCardService(new PostgresJobCardRepository(pool));
}

function jobRef(
  jobId: string,
  title: string,
  type: JobCardType = 'GENERAL_TASK',
) {
  return { id: jobId, title, type, jobPath: `/jobs/${jobId}` };
}

function delayTypeBreakdown(
  delayType: 'LATE_START' | 'LATE_SUBMISSION',
  incidentCount: number,
  outcomes: {
    recovered?: { count: number; medianSeconds: number | null; maxSeconds: number | null };
    extended?: { count: number; medianSeconds: number | null; maxSeconds: number | null };
    open?: { count: number; maxElapsedSeconds: number | null };
  } = {},
) {
  return {
    delayType,
    incidentCount,
    recovered: outcomes.recovered ?? { count: 0, medianSeconds: null, maxSeconds: null },
    extended: outcomes.extended ?? { count: 0, medianSeconds: null, maxSeconds: null },
    open: outcomes.open ?? { count: 0, maxElapsedSeconds: null },
  };
}

async function expectNotFound(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    code: 'STAFF_PROFILE_NOT_FOUND',
    statusCode: 404,
  });
}

// ---------------------------------------------------------------------------
// LR-01 / LR-13: cohort period membership and the organization time zone.
// ---------------------------------------------------------------------------

describe.skipIf(!databaseUrl)('OVR-7 lateness cohort period', () => {
  it('LR-01: a 31 October local breach stays in October with its recovered duration, and a 1 November local breach is only in November', async () => {
    await withIntentSchema(databaseUrl, async (pool) => {
      const organizationId = await insertProofOrg(pool, 'LR-01');
      const manager = await seedUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staff = await seedUser(pool, organizationId, 'STAFF', 'Personel A');
      const octoberJob = await seedJob(pool, {
        organizationId,
        assignedTo: staff.id,
        createdBy: manager.id,
        title: 'Ekim gecikmesi',
      });
      const novemberJob = await seedJob(pool, {
        organizationId,
        assignedTo: staff.id,
        createdBy: manager.id,
        title: 'Kasım gecikmesi',
      });
      const breachedAt = local('2026-10-31T23:30:00');
      const recoveredAt = local('2026-11-03T09:00:00');
      const octoberIncident = await addIncident(pool, {
        organizationId,
        jobId: octoberJob,
        delayType: 'LATE_START',
        deadlineAt: local('2026-10-31T22:00:00'),
        breachedAt,
        accountableUserId: staff.id,
        recovery: { at: recoveredAt, actorUserId: manager.id },
      });
      // 2026-11-01 00:30 in organization time is still 2026-10-31 in UTC: only
      // the organization zone can put this breach in November.
      await addIncident(pool, {
        organizationId,
        jobId: novemberJob,
        delayType: 'LATE_START',
        deadlineAt: local('2026-10-31T21:00:00'),
        breachedAt: local('2026-11-01T00:30:00'),
        accountableUserId: staff.id,
      });

      const reports = buildReports(pool);
      const october = await reports.getStaffReport(manager, staff.id, {
        requestedRange: OCTOBER,
      });

      // 2026-10-31 23:30 -> 2026-11-03 09:00 = 2 days 9 h 30 min.
      const recoveredSeconds = 2 * 86_400 + 34_200;
      expect(recoveredSeconds).toBe(207_000);
      expect(october.range).toEqual(RESOLVED_OCTOBER);
      expect(october.lateness).toEqual({
        trackingStartedOn: '2026-09-21',
        generatedAt: iso(REQUEST_TIME),
        staffResponsibility: {
          delayedJobCount: 1,
          incidentCount: 1,
          byType: [
            delayTypeBreakdown('LATE_START', 1, {
              recovered: { count: 1, medianSeconds: recoveredSeconds, maxSeconds: recoveredSeconds },
            }),
            delayTypeBreakdown('LATE_SUBMISSION', 0),
          ],
        },
        operational: { delayedJobCount: 0, incidentCount: 0, byReason: [] },
      });

      const octoberList = await reports.listStaffLatenessIncidents(
        manager,
        staff.id,
        { requestedRange: OCTOBER, limit: 50, offset: 0 },
      );
      expect(octoberList).toEqual({
        range: RESOLVED_OCTOBER,
        items: [{
          incidentId: octoberIncident,
          delayType: 'LATE_START',
          episodeNo: 1,
          scheduleRevisionNo: 1,
          deadlineAt: iso(local('2026-10-31T22:00:00')),
          breachedAt: iso(breachedAt),
          outcome: 'RECOVERED',
          closedAt: iso(recoveredAt),
          durationSeconds: recoveredSeconds,
          operationalReason: null,
          job: jobRef(octoberJob, 'Ekim gecikmesi'),
        }],
        total: 1,
        limit: 50,
        offset: 0,
      });

      // November holds the November breach only; the recover-on-3-November
      // incident did not move into the period of its recovery.
      const november = await reports.getStaffReport(manager, staff.id, {
        requestedRange: NOVEMBER,
      });
      expect(november.lateness.staffResponsibility).toEqual({
        delayedJobCount: 1,
        incidentCount: 1,
        byType: [
          delayTypeBreakdown('LATE_START', 1, {
            open: {
              count: 1,
              maxElapsedSeconds: sec('2026-11-01T00:30:00', '2026-11-05T12:00:00'),
            },
          }),
          delayTypeBreakdown('LATE_SUBMISSION', 0),
        ],
      });
    });
  });

  it('LR-13: a period before tracking start and an empty period return explicit zeros with the tracking start', async () => {
    await withIntentSchema(databaseUrl, async (pool) => {
      const organizationId = await insertProofOrg(pool, 'LR-13');
      const manager = await seedUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staff = await seedUser(pool, organizationId, 'STAFF', 'Personel A');

      const reports = buildReports(pool);
      const august = { from: '2026-08-01', to: '2026-08-31' } as const;
      const augustRange = { ...august, timezone: 'Europe/Istanbul' };
      const report = await reports.getStaffReport(manager, staff.id, {
        requestedRange: august,
      });

      expect(report.range).toEqual(augustRange);
      expect(august.from < report.lateness.trackingStartedOn).toBe(true);
      expect(report.lateness).toEqual({
        trackingStartedOn: '2026-09-21',
        generatedAt: iso(REQUEST_TIME),
        staffResponsibility: {
          delayedJobCount: 0,
          incidentCount: 0,
          byType: [
            delayTypeBreakdown('LATE_START', 0),
            delayTypeBreakdown('LATE_SUBMISSION', 0),
          ],
        },
        operational: { delayedJobCount: 0, incidentCount: 0, byReason: [] },
      });

      const card = await reports.getOrganizationLateness(manager, {
        requestedRange: august,
      });
      expect(card).toEqual({
        range: augustRange,
        trackingStartedOn: '2026-09-21',
        generatedAt: iso(REQUEST_TIME),
        totalIncidentCount: 0,
        staffResponsibility: { delayedJobCount: 0, incidentCount: 0 },
        operational: { delayedJobCount: 0, incidentCount: 0 },
        unknownAccountability: { delayedJobCount: 0, incidentCount: 0 },
        managementApprovalWait: {
          delayedJobCount: 0,
          incidentCount: 0,
          recovered: { count: 0, medianSeconds: null, maxSeconds: null },
          open: { count: 0, maxElapsedSeconds: null },
        },
      });

      const list = await reports.listStaffLatenessIncidents(manager, staff.id, {
        requestedRange: august,
        limit: 20,
        offset: 0,
      });
      expect(list).toEqual({
        range: augustRange,
        items: [],
        total: 0,
        limit: 20,
        offset: 0,
      });
    });
  });
});

// ---------------------------------------------------------------------------
// LR-02, LR-15: accountability is frozen at the breach instant.
// ---------------------------------------------------------------------------

describe.skipIf(!databaseUrl)('OVR-7 accountability is frozen at the breach', () => {
  it('LR-02: a reassignment after the breach keeps the incident in the former assignee report only', async () => {
    await withIntentSchema(databaseUrl, async (pool) => {
      const organizationId = await insertProofOrg(pool, 'LR-02');
      const manager = await seedUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffA = await seedUser(pool, organizationId, 'STAFF', 'Personel A');
      const staffB = await seedUser(pool, organizationId, 'STAFF', 'Personel B');
      const jobId = await seedJob(pool, {
        organizationId,
        assignedTo: staffA.id,
        createdBy: manager.id,
        title: 'Devredilen iş',
        createdAt: local('2026-10-01T09:00:00'),
      });
      await addIncident(pool, {
        organizationId,
        jobId,
        delayType: 'LATE_SUBMISSION',
        deadlineAt: local('2026-10-12T14:00:00'),
        breachedAt: local('2026-10-12T15:00:00'),
        accountableUserId: staffA.id,
      });
      // The breach is attributed to A; the job belongs to B afterwards.
      await addAssignmentHistory(pool, {
        organizationId,
        jobId,
        fromUserId: staffA.id,
        toUserId: staffB.id,
        changedBy: manager.id,
        changedAt: local('2026-10-14T10:00:00'),
        source: 'PATCH_REASSIGN',
      });
      await pool.query('UPDATE job_cards SET assigned_to = $2 WHERE id = $1', [jobId, staffB.id]);

      const reports = buildReports(pool);
      const former = await reports.getStaffReport(manager, staffA.id, {
        requestedRange: OCTOBER,
      });
      const current = await reports.getStaffReport(manager, staffB.id, {
        requestedRange: OCTOBER,
      });

      expect(former.lateness.staffResponsibility.delayedJobCount).toBe(1);
      expect(former.lateness.staffResponsibility.incidentCount).toBe(1);
      expect(current.lateness.staffResponsibility.delayedJobCount).toBe(0);
      expect(current.lateness.staffResponsibility.incidentCount).toBe(0);
      expect(current.lateness.operational.incidentCount).toBe(0);

      const card = await reports.getOrganizationLateness(manager, {
        requestedRange: OCTOBER,
      });
      expect(card.staffResponsibility).toEqual({ delayedJobCount: 1, incidentCount: 1 });
      expect(card.unknownAccountability).toEqual({ delayedJobCount: 0, incidentCount: 0 });
      expect(card.totalIncidentCount).toBe(1);
    });
  });

  it('LR-15: a later assignee own resolved change request never regroups the former assignee incident or reveals its reason', async () => {
    await withIntentSchema(databaseUrl, async (pool) => {
      const organizationId = await insertProofOrg(pool, 'LR-15');
      const manager = await seedUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffA = await seedUser(pool, organizationId, 'STAFF', 'Personel A');
      const staffB = await seedUser(pool, organizationId, 'STAFF', 'Personel B');
      const jobId = await seedJob(pool, {
        organizationId,
        assignedTo: staffA.id,
        createdBy: manager.id,
        title: 'Devredilen gecikme',
        createdAt: local('2026-10-01T09:00:00'),
      });
      await addIncident(pool, {
        organizationId,
        jobId,
        delayType: 'LATE_SUBMISSION',
        deadlineAt: local('2026-10-10T09:00:00'),
        breachedAt: local('2026-10-10T10:00:00'),
        accountableUserId: staffA.id,
      });
      await addAssignmentHistory(pool, {
        organizationId,
        jobId,
        fromUserId: staffA.id,
        toUserId: staffB.id,
        changedBy: manager.id,
        changedAt: local('2026-10-20T10:00:00'),
        source: 'PATCH_REASSIGN',
      });
      await pool.query('UPDATE job_cards SET assigned_to = $2 WHERE id = $1', [jobId, staffB.id]);
      // B asks while the incident is still open; management reschedules.
      await addChangeRequest(pool, {
        organizationId,
        jobId,
        requestedBy: staffB.id,
        requestedAt: local('2026-10-21T09:00:00'),
        reasonCode: 'CUSTOMER_POSTPONED',
        closure: {
          resolution: 'RESCHEDULED',
          resolvedAt: local('2026-10-22T09:00:00'),
          resolvedBy: manager.id,
        },
      });

      const reports = buildReports(pool);
      const report = await reports.getStaffReport(manager, staffA.id, {
        requestedRange: OCTOBER,
      });
      expect(report.lateness.staffResponsibility).toEqual({
        delayedJobCount: 1,
        incidentCount: 1,
        byType: [
          delayTypeBreakdown('LATE_START', 0),
          delayTypeBreakdown('LATE_SUBMISSION', 1, {
            open: { count: 1, maxElapsedSeconds: sec('2026-10-10T10:00:00', '2026-11-05T12:00:00') },
          }),
        ],
      });
      expect(report.lateness.operational).toEqual({
        delayedJobCount: 0,
        incidentCount: 0,
        byReason: [],
      });

      const incidents = await reports.listStaffLatenessIncidents(manager, staffA.id, {
        requestedRange: OCTOBER,
        limit: 20,
        offset: 0,
      });
      expect(incidents.items).toHaveLength(1);
      expect(incidents.items[0]!.operationalReason).toBeNull();

      const assigneeReport = await reports.getStaffReport(manager, staffB.id, {
        requestedRange: OCTOBER,
      });
      expect(assigneeReport.lateness.staffResponsibility.incidentCount).toBe(0);
      expect(assigneeReport.lateness.operational.incidentCount).toBe(0);

      const card = await reports.getOrganizationLateness(manager, {
        requestedRange: OCTOBER,
      });
      expect(card.staffResponsibility).toEqual({ delayedJobCount: 1, incidentCount: 1 });
      expect(card.operational).toEqual({ delayedJobCount: 0, incidentCount: 0 });
    });
  });
});

// ---------------------------------------------------------------------------
// LR-03, LR-04: the organization card partition.
// ---------------------------------------------------------------------------

describe.skipIf(!databaseUrl)('OVR-7 organization accountability partition', () => {
  it('LR-03: an APPROVAL_WAIT incident is management approval wait only and never enters a Staff report', async () => {
    await withIntentSchema(databaseUrl, async (pool) => {
      const organizationId = await insertProofOrg(pool, 'LR-03');
      const manager = await seedUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staff = await seedUser(pool, organizationId, 'STAFF', 'Personel A');
      const jobId = await seedJob(pool, {
        organizationId,
        assignedTo: staff.id,
        createdBy: manager.id,
        title: 'Onay bekleyen iş',
      });
      await addIncident(pool, {
        organizationId,
        jobId,
        delayType: 'APPROVAL_WAIT',
        deadlineAt: local('2026-10-15T09:00:00'),
        breachedAt: local('2026-10-15T10:00:00'),
        accountableRole: 'MANAGEMENT',
        accountableSource: 'ROLE_POLICY',
        accountableUserId: null,
        recovery: {
          at: local('2026-10-15T14:00:00'),
          actorUserId: manager.id,
        },
      });

      const reports = buildReports(pool);
      const report = await reports.getStaffReport(manager, staff.id, {
        requestedRange: OCTOBER,
      });
      expect(report.lateness.staffResponsibility.incidentCount).toBe(0);
      expect(report.lateness.operational.incidentCount).toBe(0);
      expect(report.lateness.staffResponsibility.byType).toEqual([
        delayTypeBreakdown('LATE_START', 0),
        delayTypeBreakdown('LATE_SUBMISSION', 0),
      ]);

      const card = await reports.getOrganizationLateness(manager, {
        requestedRange: OCTOBER,
      });
      expect(card).toEqual({
        range: RESOLVED_OCTOBER,
        trackingStartedOn: '2026-09-21',
        generatedAt: iso(REQUEST_TIME),
        totalIncidentCount: 1,
        staffResponsibility: { delayedJobCount: 0, incidentCount: 0 },
        operational: { delayedJobCount: 0, incidentCount: 0 },
        unknownAccountability: { delayedJobCount: 0, incidentCount: 0 },
        managementApprovalWait: {
          delayedJobCount: 1,
          incidentCount: 1,
          // 2026-10-15 10:00 -> 14:00 = 4 h.
          recovered: { count: 1, medianSeconds: 14_400, maxSeconds: 14_400 },
          open: { count: 0, maxElapsedSeconds: null },
        },
      });

      const list = await reports.listStaffLatenessIncidents(manager, staff.id, {
        requestedRange: OCTOBER,
        limit: 20,
        offset: 0,
      });
      expect(list.total).toBe(0);
      expect(list.items).toEqual([]);
    });
  });

  it('LR-04: unprovable Staff accountability stays in the unknown group of the organization card only', async () => {
    await withIntentSchema(databaseUrl, async (pool) => {
      const organizationId = await insertProofOrg(pool, 'LR-04');
      const manager = await seedUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staff = await seedUser(pool, organizationId, 'STAFF', 'Personel A');
      const unmeasuredJob = await seedJob(pool, {
        organizationId,
        assignedTo: staff.id,
        createdBy: manager.id,
        title: 'Sorumlusu belirlenemeyen iş',
      });
      const policyJob = await seedJob(pool, {
        organizationId,
        assignedTo: staff.id,
        createdBy: manager.id,
        title: 'Rol politikası işi',
      });
      await addIncident(pool, {
        organizationId,
        jobId: unmeasuredJob,
        delayType: 'LATE_SUBMISSION',
        deadlineAt: local('2026-10-16T10:00:00'),
        breachedAt: local('2026-10-16T11:00:00'),
        accountableSource: 'UNKNOWN',
        accountableUserId: null,
      });
      // A source other than ASSIGNMENT_AT_BREACH is unprovable even when a user
      // id happens to be stored: the partition reads the frozen source.
      await addIncident(pool, {
        organizationId,
        jobId: policyJob,
        delayType: 'LATE_START',
        deadlineAt: local('2026-10-17T10:00:00'),
        breachedAt: local('2026-10-17T11:00:00'),
        accountableSource: 'ROLE_POLICY',
        accountableUserId: staff.id,
      });

      const reports = buildReports(pool);
      const report = await reports.getStaffReport(manager, staff.id, {
        requestedRange: OCTOBER,
      });
      expect(report.lateness.staffResponsibility.incidentCount).toBe(0);
      expect(report.lateness.operational.incidentCount).toBe(0);

      const card = await reports.getOrganizationLateness(manager, {
        requestedRange: OCTOBER,
      });
      expect(card.unknownAccountability).toEqual({ delayedJobCount: 2, incidentCount: 2 });
      expect(card.staffResponsibility).toEqual({ delayedJobCount: 0, incidentCount: 0 });
      expect(card.operational).toEqual({ delayedJobCount: 0, incidentCount: 0 });
      expect(card.managementApprovalWait.incidentCount).toBe(0);
      expect(card.totalIncidentCount).toBe(2);

      const list = await reports.listStaffLatenessIncidents(manager, staff.id, {
        requestedRange: OCTOBER,
        limit: 20,
        offset: 0,
      });
      expect(list.total).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// LR-05: an OVR-5 ended incident is EXTENDED, never RECOVERED.
// ---------------------------------------------------------------------------

describe.skipIf(!databaseUrl)('OVR-7 lateness outcomes', () => {
  it('LR-05: an extended incident is EXTENDED with its ended duration and never RECOVERED', async () => {
    await withIntentSchema(databaseUrl, async (pool) => {
      const organizationId = await insertProofOrg(pool, 'LR-05');
      const manager = await seedUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staff = await seedUser(pool, organizationId, 'STAFF', 'Personel A');
      const jobId = await seedJob(pool, {
        organizationId,
        assignedTo: staff.id,
        createdBy: manager.id,
        title: 'Süresi uzatılan iş',
      });
      const breachedAt = local('2026-10-20T16:00:00');
      const endedAt = local('2026-10-22T08:00:00');
      await addScheduleRevision(pool, organizationId, jobId, 2, endedAt, manager.id);
      const incidentId = await addIncident(pool, {
        organizationId,
        jobId,
        delayType: 'LATE_SUBMISSION',
        deadlineAt: local('2026-10-20T15:00:00'),
        breachedAt,
        accountableUserId: staff.id,
        ending: {
          at: endedAt,
          byUserId: manager.id,
          note: 'Plan sürümü 2',
          scheduleRevisionNo: 2,
        },
      });

      const reports = buildReports(pool);
      const report = await reports.getStaffReport(manager, staff.id, {
        requestedRange: OCTOBER,
      });
      // 2026-10-20 16:00 -> 2026-10-22 08:00 = 1 day 16 h.
      const extendedSeconds = 86_400 + 57_600;
      expect(extendedSeconds).toBe(144_000);
      expect(report.lateness).toEqual({
        trackingStartedOn: '2026-09-21',
        generatedAt: iso(REQUEST_TIME),
        staffResponsibility: {
          delayedJobCount: 1,
          incidentCount: 1,
          byType: [
            delayTypeBreakdown('LATE_START', 0),
            delayTypeBreakdown('LATE_SUBMISSION', 1, {
              extended: {
                count: 1,
                medianSeconds: extendedSeconds,
                maxSeconds: extendedSeconds,
              },
            }),
          ],
        },
        operational: { delayedJobCount: 0, incidentCount: 0, byReason: [] },
      });

      const list = await reports.listStaffLatenessIncidents(manager, staff.id, {
        requestedRange: OCTOBER,
        limit: 20,
        offset: 0,
      });
      expect(list.items).toEqual([{
        incidentId,
        delayType: 'LATE_SUBMISSION',
        episodeNo: 1,
        scheduleRevisionNo: 1,
        deadlineAt: iso(local('2026-10-20T15:00:00')),
        breachedAt: iso(breachedAt),
        outcome: 'EXTENDED',
        closedAt: iso(endedAt),
        durationSeconds: extendedSeconds,
        operationalReason: null,
        job: jobRef(jobId, 'Süresi uzatılan iş'),
      }]);

      const card = await reports.getOrganizationLateness(manager, {
        requestedRange: OCTOBER,
      });
      expect(card.staffResponsibility).toEqual({ delayedJobCount: 1, incidentCount: 1 });
      expect(card.totalIncidentCount).toBe(1);
    });
  });

  it('LR-11: durations, medians and maxima stay per type and outcome, are non-negative integers and equal the per-job history', async () => {
    await withIntentSchema(databaseUrl, async (pool) => {
      const organizationId = await insertProofOrg(pool, 'LR-11');
      const manager = await seedUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staff = await seedUser(pool, organizationId, 'STAFF', 'Personel A');
      const jobId = await seedJob(pool, {
        organizationId,
        assignedTo: staff.id,
        createdBy: manager.id,
        title: 'Süre ölçümü',
      });
      // One period that ends one second after the last October local instant.
      const measurementTime = local('2026-11-01T00:00:30');
      const breachedAt = local('2026-10-05T10:00:00');

      const submissionIncidentIds = [
        // recovered: 100 s, 400 s, 1000 s -> median 400, max 1000.
        await addIncident(pool, {
          organizationId, jobId, delayType: 'LATE_SUBMISSION', episodeNo: 1,
          deadlineAt: breachedAt, breachedAt,
          accountableUserId: staff.id,
          recovery: { at: new Date(breachedAt.getTime() + 100_000), actorUserId: manager.id },
        }),
        await addIncident(pool, {
          organizationId, jobId, delayType: 'LATE_SUBMISSION', episodeNo: 2,
          deadlineAt: breachedAt, breachedAt,
          accountableUserId: staff.id,
          recovery: { at: new Date(breachedAt.getTime() + 400_000), actorUserId: manager.id },
        }),
        await addIncident(pool, {
          organizationId, jobId, delayType: 'LATE_SUBMISSION', episodeNo: 3,
          deadlineAt: breachedAt, breachedAt,
          accountableUserId: staff.id,
          recovery: { at: new Date(breachedAt.getTime() + 1_000_000), actorUserId: manager.id },
        }),
        // ended: 200 s, 901 s -> median floor(550.5) = 550, max 901.
        await addIncident(pool, {
          organizationId, jobId, delayType: 'LATE_SUBMISSION', episodeNo: 4,
          deadlineAt: breachedAt, breachedAt,
          accountableUserId: staff.id,
          ending: {
            at: new Date(breachedAt.getTime() + 200_000),
            byUserId: manager.id,
            note: 'Uzatma 1',
            scheduleRevisionNo: 1,
          },
        }),
        await addIncident(pool, {
          organizationId, jobId, delayType: 'LATE_SUBMISSION', episodeNo: 5,
          deadlineAt: breachedAt, breachedAt,
          accountableUserId: staff.id,
          ending: {
            at: new Date(breachedAt.getTime() + 901_000),
            byUserId: manager.id,
            note: 'Uzatma 2',
            scheduleRevisionNo: 1,
          },
        }),
        // open at request time: 300 s elapsed.
        await addIncident(pool, {
          organizationId, jobId, delayType: 'LATE_SUBMISSION', episodeNo: 6,
          deadlineAt: local('2026-10-31T23:50:30'),
          breachedAt: local('2026-10-31T23:55:30'),
          accountableUserId: staff.id,
        }),
        // open at request time: 7000 s elapsed.
        await addIncident(pool, {
          organizationId, jobId, delayType: 'LATE_SUBMISSION', episodeNo: 7,
          deadlineAt: local('2026-10-31T21:50:00'),
          breachedAt: local('2026-10-31T22:03:50'),
          accountableUserId: staff.id,
        }),
      ];
      // LATE_START: 50 s recovered and one recovered-before-breach row that the
      // lifecycle cannot produce. The canonical GREATEST(0, ...) expression
      // must clamp it to 0 instead of reporting a negative duration.
      const lateStartIncidentIds = [
        await addIncident(pool, {
          organizationId, jobId, delayType: 'LATE_START',
          deadlineAt: local('2026-10-06T10:00:00'),
          breachedAt: local('2026-10-06T10:00:00'),
          accountableUserId: staff.id,
          recovery: {
            at: new Date(local('2026-10-06T10:00:00').getTime() + 50_000),
            actorUserId: manager.id,
          },
        }),
        await addIncident(pool, {
          organizationId, jobId, delayType: 'LATE_START', episodeNo: 2,
          deadlineAt: local('2026-10-06T09:59:00'),
          breachedAt: local('2026-10-06T10:00:00'),
          accountableUserId: staff.id,
          recovery: { at: local('2026-10-06T09:59:00'), actorUserId: manager.id },
        }),
      ];

      const reports = buildReports(pool, () => measurementTime);
      const report = await reports.getStaffReport(manager, staff.id, {
        requestedRange: OCTOBER,
      });

      expect(report.lateness).toEqual({
        trackingStartedOn: '2026-09-21',
        generatedAt: iso(measurementTime),
        staffResponsibility: {
          delayedJobCount: 1,
          incidentCount: 9,
          byType: [
            {
              delayType: 'LATE_START',
              incidentCount: 2,
              recovered: { count: 2, medianSeconds: 25, maxSeconds: 50 },
              extended: { count: 0, medianSeconds: null, maxSeconds: null },
              open: { count: 0, maxElapsedSeconds: null },
            },
            {
              delayType: 'LATE_SUBMISSION',
              incidentCount: 7,
              recovered: { count: 3, medianSeconds: 400, maxSeconds: 1000 },
              extended: { count: 2, medianSeconds: 550, maxSeconds: 901 },
              open: { count: 2, maxElapsedSeconds: 7000 },
            },
          ],
        },
        operational: { delayedJobCount: 0, incidentCount: 0, byReason: [] },
      });

      const list = await reports.listStaffLatenessIncidents(manager, staff.id, {
        requestedRange: OCTOBER,
        limit: 200,
        offset: 0,
      });
      expect(list.total).toBe(9);
      for (const item of list.items) {
        expect(Number.isInteger(item.durationSeconds)).toBe(true);
        expect(item.durationSeconds).toBeGreaterThanOrEqual(0);
      }

      // The same rows must read the same canonical integer in the existing
      // per-job history: one duration rule, not a second copy.
      const history = await buildJobCards(pool).listOverdueIncidents(
        manager,
        jobId,
        { limit: 200, offset: 0 },
      );
      const historyById = new Map(history.items.map((item) => [item.id, item]));
      for (const incidentId of [...submissionIncidentIds, ...lateStartIncidentIds]) {
        const listed = list.items.find((item) => item.incidentId === incidentId);
        expect(listed).toBeDefined();
        const historical = historyById.get(incidentId);
        expect(historical).toBeDefined();
        // No fallback to the value under test: each outcome is compared with its
        // own independent source (history field, or the open elapsed rule).
        const canonical = listed!.outcome === 'RECOVERED'
          ? historical!.totalDelaySeconds
          : listed!.outcome === 'EXTENDED'
            ? historical!.endedDurationSeconds
            : Math.max(0, Math.floor(
              (measurementTime.getTime() - new Date(historical!.breachedAt).getTime()) / 1000,
            ));
        expect(canonical).not.toBeNull();
        expect(listed!.durationSeconds).toBe(canonical);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// LR-06, LR-07, LR-17: operational flag and incident/job counting.
// ---------------------------------------------------------------------------

describe.skipIf(!databaseUrl)('OVR-7 operational flag', () => {
  it('LR-06: only the accountable Staff member own management-resolved request regroups an incident, once, with the latest reason', async () => {
    await withIntentSchema(databaseUrl, async (pool) => {
      const organizationId = await insertProofOrg(pool, 'LR-06');
      const manager = await seedUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staff = await seedUser(pool, organizationId, 'STAFF', 'Personel A');

      async function jobWithIncident(
        title: string,
        delayType: 'LATE_START' | 'LATE_SUBMISSION',
        breachedLocal: string,
        recoveredLocal?: string,
      ) {
        const jobId = await seedJob(pool, {
          organizationId,
          assignedTo: staff.id,
          createdBy: manager.id,
          title,
          createdAt: local('2026-09-25T09:00:00'),
        });
        const incidentId = await addIncident(pool, {
          organizationId,
          jobId,
          delayType,
          deadlineAt: local(breachedLocal),
          breachedAt: local(breachedLocal),
          accountableUserId: staff.id,
          ...(recoveredLocal === undefined
            ? {}
            : { recovery: { at: local(recoveredLocal), actorUserId: manager.id } }),
        });
        return { jobId, incidentId };
      }

      // (a) opened before the deadline, resolved while the incident is open.
      const beforeDeadline = await jobWithIncident(
        'Erken açılan talep', 'LATE_START', '2026-10-05T10:00:00',
      );
      await addChangeRequest(pool, {
        organizationId,
        jobId: beforeDeadline.jobId,
        requestedBy: staff.id,
        requestedAt: local('2026-10-04T09:00:00'),
        reasonCode: 'CUSTOMER_ABSENT',
        closure: {
          resolution: 'RESCHEDULED',
          resolvedAt: local('2026-10-06T10:00:00'),
          resolvedBy: manager.id,
        },
      });

      // (b) resolved before the breach.
      const resolvedBeforeBreach = await jobWithIncident(
        'Önce sonuçlanan talep', 'LATE_START', '2026-10-07T10:00:00',
      );
      await addChangeRequest(pool, {
        organizationId,
        jobId: resolvedBeforeBreach.jobId,
        requestedBy: staff.id,
        requestedAt: local('2026-10-05T09:00:00'),
        reasonCode: 'WRONG_PRODUCT',
        closure: {
          resolution: 'CORRECTED',
          resolvedAt: local('2026-10-06T09:00:00'),
          resolvedBy: manager.id,
        },
      });

      // (c) REJECTED never qualifies.
      const rejected = await jobWithIncident(
        'Reddedilen talep', 'LATE_SUBMISSION', '2026-10-09T10:00:00',
      );
      await addChangeRequest(pool, {
        organizationId,
        jobId: rejected.jobId,
        requestedBy: staff.id,
        requestedAt: local('2026-10-09T12:00:00'),
        reasonCode: 'OTHER',
        closure: {
          resolution: 'REJECTED',
          resolvedAt: local('2026-10-10T10:00:00'),
          resolvedBy: manager.id,
          note: 'Talep uygun değil',
        },
      });

      // (d) SUPERSEDED never qualifies.
      const superseded = await jobWithIncident(
        'Geçersiz kılınan talep', 'LATE_SUBMISSION', '2026-10-11T10:00:00',
      );
      await addChangeRequest(pool, {
        organizationId,
        jobId: superseded.jobId,
        requestedBy: staff.id,
        requestedAt: local('2026-10-11T11:00:00'),
        reasonCode: 'CUSTOMER_CHANGED_MIND',
        closure: {
          resolution: 'SUPERSEDED',
          resolvedAt: local('2026-10-12T10:00:00'),
          resolvedBy: null,
        },
      });

      // (e) a Staff self-CANCEL: the canceller was the assignee at resolution.
      const selfCancelled = await jobWithIncident(
        'Kendi iptal eden personel', 'LATE_START', '2026-10-13T10:00:00',
      );
      await addChangeRequest(pool, {
        organizationId,
        jobId: selfCancelled.jobId,
        requestedBy: staff.id,
        requestedAt: local('2026-10-13T11:00:00'),
        reasonCode: 'CUSTOMER_POSTPONED',
        closure: {
          resolution: 'CANCELLED',
          resolvedAt: local('2026-10-14T10:00:00'),
          resolvedBy: staff.id,
        },
      });

      // (f) two qualifying requests: counted once, the later reason is shown.
      const twoRequests = await jobWithIncident(
        'İki talepli iş', 'LATE_SUBMISSION', '2026-10-15T10:00:00',
      );
      await addChangeRequest(pool, {
        organizationId,
        jobId: twoRequests.jobId,
        requestedBy: staff.id,
        requestedAt: local('2026-10-15T11:00:00'),
        reasonCode: 'CUSTOMER_ABSENT',
        closure: {
          resolution: 'CORRECTED',
          resolvedAt: local('2026-10-16T10:00:00'),
          resolvedBy: manager.id,
        },
      });
      await addChangeRequest(pool, {
        organizationId,
        jobId: twoRequests.jobId,
        requestedBy: staff.id,
        requestedAt: local('2026-10-15T12:00:00'),
        reasonCode: 'MISSING_STOCK_OR_EQUIPMENT',
        closure: {
          resolution: 'RESCHEDULED',
          resolvedAt: local('2026-10-18T09:00:00'),
          resolvedBy: manager.id,
        },
      });

      // (g) second CUSTOMER_ABSENT so reason ordering has a real count order.
      const secondAbsent = await jobWithIncident(
        'İkinci müşteri yok talebi', 'LATE_START', '2026-10-17T10:00:00',
      );
      await addChangeRequest(pool, {
        organizationId,
        jobId: secondAbsent.jobId,
        requestedBy: staff.id,
        requestedAt: local('2026-10-17T11:00:00'),
        reasonCode: 'CUSTOMER_ABSENT',
        closure: {
          resolution: 'CORRECTED',
          resolvedAt: local('2026-10-18T10:00:00'),
          resolvedBy: manager.id,
        },
      });

      // (h) same one-count as (f): the reason code order breaks the tie, and
      // OTHER qualifies because the management resolution is the approval.
      const otherReason = await jobWithIncident(
        'Diğer nedenli talep', 'LATE_START', '2026-10-19T10:00:00',
      );
      await addChangeRequest(pool, {
        organizationId,
        jobId: otherReason.jobId,
        requestedBy: staff.id,
        requestedAt: local('2026-10-19T11:00:00'),
        reasonCode: 'OTHER',
        closure: {
          resolution: 'CORRECTED',
          resolvedAt: local('2026-10-20T10:00:00'),
          resolvedBy: manager.id,
        },
      });

      // (i) opened after the incident had already closed: no overlap.
      const closedThenRequested = await jobWithIncident(
        'Kapandıktan sonra talep', 'LATE_SUBMISSION',
        '2026-10-20T10:00:00', '2026-10-21T10:00:00',
      );
      await addChangeRequest(pool, {
        organizationId,
        jobId: closedThenRequested.jobId,
        requestedBy: staff.id,
        requestedAt: local('2026-10-22T09:00:00'),
        reasonCode: 'CUSTOMER_ABSENT',
        closure: {
          resolution: 'RESCHEDULED',
          resolvedAt: local('2026-10-23T10:00:00'),
          resolvedBy: manager.id,
        },
      });

      const reports = buildReports(pool);
      const report = await reports.getStaffReport(manager, staff.id, {
        requestedRange: OCTOBER,
      });

      expect(report.lateness.staffResponsibility.delayedJobCount).toBe(5);
      expect(report.lateness.staffResponsibility.incidentCount).toBe(5);
      expect(report.lateness.staffResponsibility.byType).toEqual([
        delayTypeBreakdown('LATE_START', 2, {
          open: {
            count: 2,
            maxElapsedSeconds: sec('2026-10-07T10:00:00', '2026-11-05T12:00:00'),
          },
        }),
        delayTypeBreakdown('LATE_SUBMISSION', 3, {
          // Closed after the breach: 2026-10-20 10:00 -> 2026-10-21 10:00 = 24 h.
          recovered: { count: 1, medianSeconds: 86_400, maxSeconds: 86_400 },
          open: {
            count: 2,
            maxElapsedSeconds: sec('2026-10-09T10:00:00', '2026-11-05T12:00:00'),
          },
        }),
      ]);
      expect(report.lateness.operational).toEqual({
        delayedJobCount: 4,
        incidentCount: 4,
        byReason: [
          { reasonCode: 'CUSTOMER_ABSENT', incidentCount: 2 },
          { reasonCode: 'MISSING_STOCK_OR_EQUIPMENT', incidentCount: 1 },
          { reasonCode: 'OTHER', incidentCount: 1 },
        ],
      });

      const list = await reports.listStaffLatenessIncidents(manager, staff.id, {
        requestedRange: OCTOBER,
        limit: 50,
        offset: 0,
      });
      expect(list.total).toBe(9);
      const operationalReasons = new Map(
        list.items.map((item) => [item.incidentId, item.operationalReason]),
      );
      expect(operationalReasons.get(beforeDeadline.incidentId)).toEqual({
        reasonCode: 'CUSTOMER_ABSENT',
        resolution: 'RESCHEDULED',
        resolvedAt: iso(local('2026-10-06T10:00:00')),
      });
      expect(operationalReasons.get(twoRequests.incidentId)).toEqual({
        reasonCode: 'MISSING_STOCK_OR_EQUIPMENT',
        resolution: 'RESCHEDULED',
        resolvedAt: iso(local('2026-10-18T09:00:00')),
      });
      expect(operationalReasons.get(secondAbsent.incidentId)).toEqual({
        reasonCode: 'CUSTOMER_ABSENT',
        resolution: 'CORRECTED',
        resolvedAt: iso(local('2026-10-18T10:00:00')),
      });
      expect(operationalReasons.get(otherReason.incidentId)).toEqual({
        reasonCode: 'OTHER',
        resolution: 'CORRECTED',
        resolvedAt: iso(local('2026-10-20T10:00:00')),
      });
      for (const incidentId of [
        resolvedBeforeBreach.incidentId,
        rejected.incidentId,
        superseded.incidentId,
        selfCancelled.incidentId,
        closedThenRequested.incidentId,
      ]) {
        expect(operationalReasons.get(incidentId)).toBeNull();
      }

      const card = await reports.getOrganizationLateness(manager, {
        requestedRange: OCTOBER,
      });
      expect(card.staffResponsibility).toEqual({ delayedJobCount: 5, incidentCount: 5 });
      expect(card.operational).toEqual({ delayedJobCount: 4, incidentCount: 4 });
      expect(card.totalIncidentCount).toBe(9);
    });
  });

  it('LR-07 / LR-17: repeated episodes and plan revisions count incidents per row and delayed jobs per job', async () => {
    await withIntentSchema(databaseUrl, async (pool) => {
      const organizationId = await insertProofOrg(pool, 'LR-07');
      const manager = await seedUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staff = await seedUser(pool, organizationId, 'STAFF', 'Personel A');
      const repeated = await seedJob(pool, {
        organizationId,
        assignedTo: staff.id,
        createdBy: manager.id,
        title: 'İki turlu iş',
      });
      await addIncident(pool, {
        organizationId,
        jobId: repeated,
        delayType: 'LATE_SUBMISSION',
        episodeNo: 1,
        deadlineAt: local('2026-10-06T09:00:00'),
        breachedAt: local('2026-10-06T10:00:00'),
        accountableUserId: staff.id,
      });
      await addIncident(pool, {
        organizationId,
        jobId: repeated,
        delayType: 'LATE_SUBMISSION',
        episodeNo: 2,
        deadlineAt: local('2026-10-09T09:00:00'),
        breachedAt: local('2026-10-09T10:00:00'),
        accountableUserId: staff.id,
      });

      const mixed = await seedJob(pool, {
        organizationId,
        assignedTo: staff.id,
        createdBy: manager.id,
        title: 'Bir operasyonel bir değil',
      });
      await addIncident(pool, {
        organizationId,
        jobId: mixed,
        delayType: 'LATE_START',
        deadlineAt: local('2026-10-12T08:00:00'),
        breachedAt: local('2026-10-12T08:00:00'),
        accountableUserId: staff.id,
      });
      // Breached after the request was resolved: a request only regroups the
      // incidents its own interval overlaps, not every incident of the job.
      await addIncident(pool, {
        organizationId,
        jobId: mixed,
        delayType: 'LATE_SUBMISSION',
        deadlineAt: local('2026-10-13T07:00:00'),
        breachedAt: local('2026-10-13T08:00:00'),
        accountableUserId: staff.id,
      });
      await addChangeRequest(pool, {
        organizationId,
        jobId: mixed,
        requestedBy: staff.id,
        requestedAt: local('2026-10-12T09:00:00'),
        reasonCode: 'CUSTOMER_POSTPONED',
        closure: {
          resolution: 'RESCHEDULED',
          resolvedAt: local('2026-10-12T10:00:00'),
          resolvedBy: manager.id,
        },
      });

      const reports = buildReports(pool);
      const report = await reports.getStaffReport(manager, staff.id, {
        requestedRange: OCTOBER,
      });
      expect(report.lateness.staffResponsibility).toMatchObject({
        delayedJobCount: 2,
        incidentCount: 3,
      });
      expect(report.lateness.staffResponsibility.byType.map(({ delayType, incidentCount }) => (
        [delayType, incidentCount]
      ))).toEqual([['LATE_START', 0], ['LATE_SUBMISSION', 3]]);
      expect(report.lateness.operational).toEqual({
        delayedJobCount: 1,
        incidentCount: 1,
        byReason: [{ reasonCode: 'CUSTOMER_POSTPONED', incidentCount: 1 }],
      });

      const list = await reports.listStaffLatenessIncidents(manager, staff.id, {
        requestedRange: OCTOBER,
        limit: 50,
        offset: 0,
      });
      expect(list.total).toBe(4);
      expect(list.items.filter(({ job }) => job?.id === repeated)).toHaveLength(2);
      expect(list.items.filter(({ job }) => job?.id === mixed)).toHaveLength(2);

      const card = await reports.getOrganizationLateness(manager, {
        requestedRange: OCTOBER,
      });
      expect(card.staffResponsibility).toEqual({ delayedJobCount: 2, incidentCount: 3 });
      expect(card.operational).toEqual({ delayedJobCount: 1, incidentCount: 1 });
      expect(card.totalIncidentCount).toBe(4);
    });
  });

  it('LR-17: revision rounds and mixed delay types on one job keep the incident and delayed-job counts exact', async () => {
    await withIntentSchema(databaseUrl, async (pool) => {
      const organizationId = await insertProofOrg(pool, 'LR-17');
      const manager = await seedUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staff = await seedUser(pool, organizationId, 'STAFF', 'Personel A');
      const revised = await seedJob(pool, {
        organizationId,
        assignedTo: staff.id,
        createdBy: manager.id,
        title: 'Revizyonlu iş',
      });
      await addScheduleRevision(pool, organizationId, revised, 2, local('2026-10-16T09:00:00'), manager.id);
      const rounds = [
        await addIncident(pool, {
          organizationId, jobId: revised, delayType: 'LATE_START', episodeNo: 1,
          scheduleRevisionNo: 1,
          deadlineAt: local('2026-10-05T09:00:00'),
          breachedAt: local('2026-10-05T10:00:00'),
          accountableUserId: staff.id,
          // Closed before the change request opens, so the request interval
          // does not overlap this round.
          recovery: { at: local('2026-10-07T09:00:00'), actorUserId: manager.id },
        }),
        await addIncident(pool, {
          organizationId, jobId: revised, delayType: 'LATE_SUBMISSION', episodeNo: 1,
          scheduleRevisionNo: 1,
          deadlineAt: local('2026-10-06T09:00:00'),
          breachedAt: local('2026-10-06T10:00:00'),
          accountableUserId: staff.id,
          recovery: { at: local('2026-10-08T09:00:00'), actorUserId: manager.id },
        }),
        await addIncident(pool, {
          organizationId, jobId: revised, delayType: 'LATE_SUBMISSION', episodeNo: 2,
          scheduleRevisionNo: 2,
          deadlineAt: local('2026-10-16T08:00:00'),
          breachedAt: local('2026-10-16T09:00:00'),
          accountableUserId: staff.id,
        }),
      ];
      await addChangeRequest(pool, {
        organizationId,
        jobId: revised,
        requestedBy: staff.id,
        requestedAt: local('2026-10-16T10:00:00'),
        reasonCode: 'CUSTOMER_ABSENT',
        closure: {
          resolution: 'LINKED_JOB_CREATED',
          resolvedAt: local('2026-10-17T10:00:00'),
          resolvedBy: manager.id,
        },
      });
      const single = await seedJob(pool, {
        organizationId,
        assignedTo: staff.id,
        createdBy: manager.id,
        title: 'Tek kayıt',
      });
      await addIncident(pool, {
        organizationId,
        jobId: single,
        delayType: 'LATE_START',
        deadlineAt: local('2026-10-20T09:00:00'),
        breachedAt: local('2026-10-20T10:00:00'),
        accountableUserId: staff.id,
      });

      const reports = buildReports(pool);
      const report = await reports.getStaffReport(manager, staff.id, {
        requestedRange: OCTOBER,
      });
      expect(report.lateness.staffResponsibility).toMatchObject({
        delayedJobCount: 2,
        incidentCount: 3,
      });
      expect(report.lateness.staffResponsibility.byType.map(({ delayType, incidentCount }) => (
        [delayType, incidentCount]
      ))).toEqual([['LATE_START', 2], ['LATE_SUBMISSION', 1]]);
      expect(report.lateness.operational.incidentCount).toBe(1);

      const list = await reports.listStaffLatenessIncidents(manager, staff.id, {
        requestedRange: OCTOBER,
        limit: 50,
        offset: 0,
      });
      expect(list.total).toBe(4);
      const revisedRows = list.items.filter(({ job }) => job?.id === revised);
      expect(revisedRows.map(({ episodeNo, scheduleRevisionNo }) => (
        [episodeNo, scheduleRevisionNo]
      ))).toEqual([[2, 2], [1, 1], [1, 1]]);
      expect(new Set(revisedRows.map(({ incidentId }) => incidentId)))
        .toEqual(new Set(rounds));

      const card = await reports.getOrganizationLateness(manager, {
        requestedRange: OCTOBER,
      });
      expect(card.staffResponsibility).toEqual({ delayedJobCount: 2, incidentCount: 3 });
      expect(card.operational).toEqual({ delayedJobCount: 1, incidentCount: 1 });
      expect(card.totalIncidentCount).toBe(4);
    });
  });
});

// ---------------------------------------------------------------------------
// LR-08: the cohort gate (invalidated jobs, Sale capability).
// ---------------------------------------------------------------------------

describe.skipIf(!databaseUrl)('OVR-7 lateness cohort gate', () => {
  it('LR-08: invalidated jobs never count and Sale jobs follow the capability gate', async () => {
    await withIntentSchema(databaseUrl, async (pool) => {
      const organizationId = await insertProofOrg(pool, 'LR-08');
      const manager = await seedUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staff = await seedUser(pool, organizationId, 'STAFF', 'Personel A');
      const customerId = await seedCustomer(pool, organizationId);
      const readable = await seedJob(pool, {
        organizationId,
        assignedTo: staff.id,
        createdBy: manager.id,
        title: 'Geçerli iş',
      });
      const invalidated = await seedJob(pool, {
        organizationId,
        assignedTo: staff.id,
        createdBy: manager.id,
        title: 'Yanlışlıkla oluşturulan iş',
        status: 'INVALIDATED',
        invalidation: {
          at: local('2026-10-02T09:00:00'),
          by: manager.id,
          reasonCode: 'CREATED_BY_MISTAKE',
        },
      });
      const visit = await seedJob(pool, {
        organizationId,
        assignedTo: staff.id,
        createdBy: manager.id,
        title: 'Kaynak ziyaret',
        type: 'SALES_MEETING',
        engagementKind: 'CUSTOMER_VISIT',
        customerId,
      });
      const sale = await seedJob(pool, {
        organizationId,
        assignedTo: staff.id,
        createdBy: manager.id,
        title: 'Satış kaydı',
        type: 'SALE',
        customerId,
        saleSourceVisitId: visit,
      });
      for (const [jobId, breachedLocal] of [
        [readable, '2026-10-05T10:00:00'],
        [invalidated, '2026-10-06T10:00:00'],
        [sale, '2026-10-07T10:00:00'],
      ] as const) {
        await addIncident(pool, {
          organizationId,
          jobId,
          delayType: 'LATE_SUBMISSION',
          deadlineAt: local('2026-10-01T10:00:00'),
          breachedAt: local(breachedLocal),
          accountableUserId: staff.id,
        });
      }

      const reports = buildReports(pool);
      const withoutSales = await reports.getOrganizationLateness(manager, {
        requestedRange: OCTOBER,
        includeSaleCapability: false,
      });
      expect(withoutSales.totalIncidentCount).toBe(1);
      expect(withoutSales.staffResponsibility).toEqual({ delayedJobCount: 1, incidentCount: 1 });

      const withSales = await reports.getOrganizationLateness(manager, {
        requestedRange: OCTOBER,
        includeSaleCapability: true,
      });
      expect(withSales.totalIncidentCount).toBe(2);
      expect(withSales.staffResponsibility).toEqual({ delayedJobCount: 2, incidentCount: 2 });

      const staffWithoutSales = await reports.getStaffReport(manager, staff.id, {
        requestedRange: OCTOBER,
        includeSaleCapability: false,
      });
      expect(staffWithoutSales.lateness.staffResponsibility.incidentCount).toBe(1);
      const staffWithSales = await reports.getStaffReport(manager, staff.id, {
        requestedRange: OCTOBER,
        includeSaleCapability: true,
      });
      expect(staffWithSales.lateness.staffResponsibility.incidentCount).toBe(2);

      const list = await reports.listStaffLatenessIncidents(manager, staff.id, {
        requestedRange: OCTOBER,
        includeSaleCapability: false,
        limit: 20,
        offset: 0,
      });
      expect(list.items.map(({ job }) => job?.id)).toEqual([readable]);
      expect(list.items.some(({ job }) => job?.id === sale)).toBe(false);
    });
  });

  it('LR-08 regression: a card-invalidated incident is never classified as EXTENDED', async () => {
    await withIntentSchema(databaseUrl, async (pool) => {
      const organizationId = await insertProofOrg(pool, 'LR-08b');
      const manager = await seedUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staff = await seedUser(pool, organizationId, 'STAFF', 'Personel A');
      const invalidated = await seedJob(pool, {
        organizationId,
        assignedTo: staff.id,
        createdBy: manager.id,
        title: 'Geçersiz kılınan iş',
        status: 'INVALIDATED',
        invalidation: {
          at: local('2026-10-02T09:00:00'),
          by: manager.id,
          reasonCode: 'DUPLICATE',
        },
      });
      // Unreachable through the product (an INVALIDATED card cannot come back),
      // but the classification guard is local: a CARD_INVALIDATED row is not
      // an outcome even if the job-status exclusion is ever loosened.
      const stillReadable = await seedJob(pool, {
        organizationId,
        assignedTo: staff.id,
        createdBy: manager.id,
        title: 'Sınıflandırma koruması',
      });
      const extended = await seedJob(pool, {
        organizationId,
        assignedTo: staff.id,
        createdBy: manager.id,
        title: 'Süresi uzatılan iş',
      });
      const closedAt = local('2026-10-06T11:00:00');
      await addScheduleRevision(pool, organizationId, extended, 2, closedAt, manager.id);
      await addIncident(pool, {
        organizationId,
        jobId: invalidated,
        delayType: 'LATE_SUBMISSION',
        deadlineAt: local('2026-10-01T10:00:00'),
        breachedAt: local('2026-10-05T10:00:00'),
        accountableUserId: staff.id,
        cardInvalidation: { at: local('2026-10-05T12:00:00'), byUserId: manager.id },
      });
      await addIncident(pool, {
        organizationId,
        jobId: stillReadable,
        delayType: 'LATE_SUBMISSION',
        deadlineAt: local('2026-10-01T10:00:00'),
        breachedAt: local('2026-10-06T10:00:00'),
        accountableUserId: staff.id,
        cardInvalidation: { at: closedAt, byUserId: manager.id },
      });
      const extendedIncidentId = await addIncident(pool, {
        organizationId,
        jobId: extended,
        delayType: 'LATE_SUBMISSION',
        deadlineAt: local('2026-10-01T10:00:00'),
        breachedAt: local('2026-10-07T10:00:00'),
        accountableUserId: staff.id,
        ending: {
          at: local('2026-10-07T12:00:00'),
          byUserId: manager.id,
          note: 'Plan sürümü 2',
          scheduleRevisionNo: 2,
        },
      });

      const reports = buildReports(pool);
      const card = await reports.getOrganizationLateness(manager, {
        requestedRange: OCTOBER,
      });
      expect(card.totalIncidentCount).toBe(1);
      expect(card.staffResponsibility).toEqual({ delayedJobCount: 1, incidentCount: 1 });
      const list = await reports.listStaffLatenessIncidents(manager, staff.id, {
        requestedRange: OCTOBER,
        limit: 20,
        offset: 0,
      });
      expect(list.items.map(({ incidentId }) => incidentId)).toEqual([extendedIncidentId]);
      expect(list.items[0]!.outcome).toBe('EXTENDED');
    });
  });
});

// ---------------------------------------------------------------------------
// LR-09, LR-10: Staff self read, transferred job concealment, 403 and 404.
// ---------------------------------------------------------------------------

describe.skipIf(!databaseUrl)('OVR-7 lateness access boundaries', () => {
  it('LR-09: Staff self reads return only their own proven incidents and hide a transferred job', async () => {
    await withIntentSchema(databaseUrl, async (pool) => {
      const organizationId = await insertProofOrg(pool, 'LR-09');
      const manager = await seedUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffA = await seedUser(pool, organizationId, 'STAFF', 'Personel A');
      const staffB = await seedUser(pool, organizationId, 'STAFF', 'Personel B');
      const retained = await seedJob(pool, {
        organizationId,
        assignedTo: staffA.id,
        createdBy: manager.id,
        title: 'Elde tutulan iş',
      });
      const transferred = await seedJob(pool, {
        organizationId,
        assignedTo: staffA.id,
        createdBy: manager.id,
        title: 'Devredilen iş',
      });
      const otherStaffJob = await seedJob(pool, {
        organizationId,
        assignedTo: staffB.id,
        createdBy: manager.id,
        title: 'Başka personelin işi',
      });
      await addIncident(pool, {
        organizationId,
        jobId: retained,
        delayType: 'LATE_START',
        deadlineAt: local('2026-10-08T09:00:00'),
        breachedAt: local('2026-10-08T10:00:00'),
        accountableUserId: staffA.id,
      });
      const transferredIncident = await addIncident(pool, {
        organizationId,
        jobId: transferred,
        delayType: 'LATE_SUBMISSION',
        deadlineAt: local('2026-10-09T09:00:00'),
        breachedAt: local('2026-10-09T10:00:00'),
        accountableUserId: staffA.id,
      });
      await addIncident(pool, {
        organizationId,
        jobId: otherStaffJob,
        delayType: 'LATE_SUBMISSION',
        deadlineAt: local('2026-10-10T09:00:00'),
        breachedAt: local('2026-10-10T10:00:00'),
        accountableUserId: staffB.id,
      });
      await addAssignmentHistory(pool, {
        organizationId,
        jobId: transferred,
        fromUserId: staffA.id,
        toUserId: staffB.id,
        changedBy: manager.id,
        changedAt: local('2026-10-11T10:00:00'),
        source: 'PATCH_REASSIGN',
      });
      await pool.query('UPDATE job_cards SET assigned_to = $2 WHERE id = $1', [
        transferred,
        staffB.id,
      ]);

      const reports = buildReports(pool);
      const own = await reports.listOwnLatenessIncidents(staffA, {
        requestedRange: OCTOBER,
        limit: 20,
        offset: 0,
      });
      expect(own.total).toBe(2);
      // Newest breach first; the transferred job's row is concealed (job: null).
      expect(own.items.map(({ job }) => job?.id ?? null)).toEqual([null, retained]);
      const concealed = own.items.find(({ incidentId }) => incidentId === transferredIncident)!;
      expect(concealed.job).toBeNull();
      expect(own.items.find(({ incidentId }) => incidentId !== transferredIncident)?.job)
        .toEqual(jobRef(retained, 'Elde tutulan iş'));

      const ownReport = await reports.getOwnStaffReport(staffA, {
        requestedRange: OCTOBER,
      });
      expect(ownReport.lateness.staffResponsibility.incidentCount).toBe(2);

      // Ordering and paging: breached_at DESC, id DESC.
      const firstPage = await reports.listOwnLatenessIncidents(staffA, {
        requestedRange: OCTOBER,
        limit: 1,
        offset: 0,
      });
      expect(firstPage.total).toBe(2);
      expect(firstPage.items.map(({ incidentId }) => incidentId)).toEqual([transferredIncident]);
      const secondPage = await reports.listOwnLatenessIncidents(staffA, {
        requestedRange: OCTOBER,
        limit: 1,
        offset: 1,
      });
      expect(secondPage.items).toHaveLength(1);
      expect(secondPage.items[0]!.incidentId).not.toBe(transferredIncident);

      await expect(reports.listOwnLatenessIncidents(manager, {
        requestedRange: OCTOBER,
        limit: 20,
        offset: 0,
      })).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
      await expect(reports.listStaffLatenessIncidents(staffA, staffB.id, {
        requestedRange: OCTOBER,
        limit: 20,
        offset: 0,
      })).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
      await expect(reports.getOrganizationLateness(staffA, { requestedRange: OCTOBER }))
        .rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    });
  });

  it('LR-10: cross-organization incidents never appear and an unknown Staff id is concealed as 404', async () => {
    await withIntentSchema(databaseUrl, async (pool) => {
      const ownOrganization = await insertProofOrg(pool, 'LR-10 own');
      const manager = await seedUser(pool, ownOrganization, 'MANAGER', 'Müdür');
      const staff = await seedUser(pool, ownOrganization, 'STAFF', 'Personel A');
      const ownJob = await seedJob(pool, {
        organizationId: ownOrganization,
        assignedTo: staff.id,
        createdBy: manager.id,
        title: 'Kendi organizasyonu',
      });
      await addIncident(pool, {
        organizationId: ownOrganization,
        jobId: ownJob,
        delayType: 'LATE_SUBMISSION',
        deadlineAt: local('2026-10-05T09:00:00'),
        breachedAt: local('2026-10-05T10:00:00'),
        accountableUserId: staff.id,
      });

      const foreignOrganization = await insertProofOrg(pool, 'LR-10 foreign');
      const foreignManager = await seedUser(pool, foreignOrganization, 'MANAGER', 'Yabancı Müdür');
      const foreignStaff = await seedUser(pool, foreignOrganization, 'STAFF', 'Yabancı Personel');
      const foreignJob = await seedJob(pool, {
        organizationId: foreignOrganization,
        assignedTo: foreignStaff.id,
        createdBy: foreignManager.id,
        title: 'Yabancı iş',
      });
      await addIncident(pool, {
        organizationId: foreignOrganization,
        jobId: foreignJob,
        delayType: 'LATE_SUBMISSION',
        deadlineAt: local('2026-10-06T09:00:00'),
        breachedAt: local('2026-10-06T10:00:00'),
        accountableUserId: foreignStaff.id,
      });

      const reports = buildReports(pool);
      const card = await reports.getOrganizationLateness(manager, {
        requestedRange: OCTOBER,
      });
      expect(card.totalIncidentCount).toBe(1);
      expect(card.staffResponsibility).toEqual({ delayedJobCount: 1, incidentCount: 1 });

      const list = await reports.listStaffLatenessIncidents(manager, staff.id, {
        requestedRange: OCTOBER,
        limit: 20,
        offset: 0,
      });
      expect(list.items.map(({ job }) => job?.id)).toEqual([ownJob]);

      await expectNotFound(reports.listStaffLatenessIncidents(manager, foreignStaff.id, {
        requestedRange: OCTOBER,
        limit: 20,
        offset: 0,
      }));
      // A management user is not a Staff target: same concealment as the report.
      await expectNotFound(reports.listStaffLatenessIncidents(manager, manager.id, {
        requestedRange: OCTOBER,
        limit: 20,
        offset: 0,
      }));
      await expectNotFound(reports.getStaffReport(manager, foreignStaff.id, {
        requestedRange: OCTOBER,
      }));

      const foreignCard = await reports.getOrganizationLateness(foreignManager, {
        requestedRange: OCTOBER,
      });
      expect(foreignCard.totalIncidentCount).toBe(1);
      expect(foreignCard.staffResponsibility).toEqual({ delayedJobCount: 1, incidentCount: 1 });
    });
  });
});

// ---------------------------------------------------------------------------
// LR-12: reconciliation of the organization card.
// ---------------------------------------------------------------------------

describe.skipIf(!databaseUrl)('OVR-7 organization reconciliation', () => {
  it('LR-12: the four organization groups partition the cohort without a remainder', async () => {
    await withIntentSchema(databaseUrl, async (pool) => {
      const organizationId = await insertProofOrg(pool, 'LR-12');
      const manager = await seedUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staff = await seedUser(pool, organizationId, 'STAFF', 'Personel A');
      const provenJob = await seedJob(pool, {
        organizationId, assignedTo: staff.id, createdBy: manager.id, title: 'Kanıtlı iş',
      });
      await addIncident(pool, {
        organizationId, jobId: provenJob, delayType: 'LATE_START',
        deadlineAt: local('2026-10-05T09:00:00'), breachedAt: local('2026-10-05T10:00:00'),
        accountableUserId: staff.id,
      });
      const operationalJob = await seedJob(pool, {
        organizationId, assignedTo: staff.id, createdBy: manager.id, title: 'Operasyonel iş',
      });
      await addIncident(pool, {
        organizationId, jobId: operationalJob, delayType: 'LATE_SUBMISSION',
        deadlineAt: local('2026-10-06T09:00:00'), breachedAt: local('2026-10-06T10:00:00'),
        accountableUserId: staff.id,
      });
      await addChangeRequest(pool, {
        organizationId, jobId: operationalJob, requestedBy: staff.id,
        requestedAt: local('2026-10-06T11:00:00'),
        reasonCode: 'CUSTOMER_ABSENT',
        closure: {
          resolution: 'RESCHEDULED',
          resolvedAt: local('2026-10-07T10:00:00'),
          resolvedBy: manager.id,
        },
      });
      const unknownJob = await seedJob(pool, {
        organizationId, assignedTo: staff.id, createdBy: manager.id, title: 'Belirsiz iş',
      });
      await addIncident(pool, {
        organizationId, jobId: unknownJob, delayType: 'LATE_SUBMISSION',
        deadlineAt: local('2026-10-08T09:00:00'), breachedAt: local('2026-10-08T10:00:00'),
        accountableSource: 'UNKNOWN', accountableUserId: null,
      });
      const managementJob = await seedJob(pool, {
        organizationId, assignedTo: staff.id, createdBy: manager.id, title: 'Onay beklemesi',
      });
      await addIncident(pool, {
        organizationId, jobId: managementJob, delayType: 'APPROVAL_WAIT',
        deadlineAt: local('2026-10-09T09:00:00'), breachedAt: local('2026-10-09T10:00:00'),
        accountableRole: 'MANAGEMENT', accountableSource: 'ROLE_POLICY',
        accountableUserId: null,
      });

      const reports = buildReports(pool);
      const card = await reports.getOrganizationLateness(manager, {
        requestedRange: OCTOBER,
      });

      expect(card.totalIncidentCount).toBe(4);
      expect(card.staffResponsibility).toEqual({ delayedJobCount: 1, incidentCount: 1 });
      expect(card.operational).toEqual({ delayedJobCount: 1, incidentCount: 1 });
      expect(card.unknownAccountability).toEqual({ delayedJobCount: 1, incidentCount: 1 });
      expect(card.managementApprovalWait.incidentCount).toBe(1);
      expect(card.managementApprovalWait.delayedJobCount).toBe(1);
      expect(card.managementApprovalWait.recovered).toEqual({
        count: 0, medianSeconds: null, maxSeconds: null,
      });
      // Open since 2026-10-09 10:00 local, measured at REQUEST_TIME.
      expect(card.managementApprovalWait.open).toEqual({
        count: 1,
        maxElapsedSeconds: Math.floor(
          (REQUEST_TIME.getTime() - local('2026-10-09T10:00:00').getTime()) / 1000,
        ),
      });
      expect(
        card.staffResponsibility.incidentCount
        + card.operational.incidentCount
        + card.unknownAccountability.incidentCount
        + card.managementApprovalWait.incidentCount,
      ).toBe(card.totalIncidentCount);

      const staffReport = await reports.getStaffReport(manager, staff.id, {
        requestedRange: OCTOBER,
      });
      expect(
        staffReport.lateness.staffResponsibility.incidentCount
        + staffReport.lateness.operational.incidentCount,
      ).toBe(2);
    });
  });
});

// ---------------------------------------------------------------------------
// LR-16: provable management at the time of the decision.
// ---------------------------------------------------------------------------

describe.skipIf(!databaseUrl)('OVR-7 provable management decision', () => {
  it('LR-16: a later role change never rewrites the decision, and an assignee self-CANCELLED closure never qualifies', async () => {
    await withIntentSchema(databaseUrl, async (pool) => {
      const organizationId = await insertProofOrg(pool, 'LR-16');
      const admin = await seedUser(pool, organizationId, 'ADMIN', 'Yönetici');
      const resolver = await seedUser(pool, organizationId, 'MANAGER', 'Karar Veren Müdür');
      const staff = await seedUser(pool, organizationId, 'STAFF', 'Personel A');

      const correctedJob = await seedJob(pool, {
        organizationId, assignedTo: staff.id, createdBy: admin.id, title: 'Düzeltilen iş',
      });
      await addIncident(pool, {
        organizationId, jobId: correctedJob, delayType: 'LATE_SUBMISSION',
        deadlineAt: local('2026-10-05T09:00:00'), breachedAt: local('2026-10-05T10:00:00'),
        accountableUserId: staff.id,
      });
      await addChangeRequest(pool, {
        organizationId, jobId: correctedJob, requestedBy: staff.id,
        requestedAt: local('2026-10-05T11:00:00'),
        reasonCode: 'WRONG_PRODUCT',
        closure: {
          resolution: 'CORRECTED',
          resolvedAt: local('2026-10-06T10:00:00'),
          resolvedBy: resolver.id,
        },
      });

      const cancelledForStaffJob = await seedJob(pool, {
        organizationId, assignedTo: staff.id, createdBy: admin.id, title: 'Yönetimce iptal',
      });
      await addIncident(pool, {
        organizationId, jobId: cancelledForStaffJob, delayType: 'LATE_START',
        deadlineAt: local('2026-10-07T09:00:00'), breachedAt: local('2026-10-07T10:00:00'),
        accountableUserId: staff.id,
      });
      await addChangeRequest(pool, {
        organizationId, jobId: cancelledForStaffJob, requestedBy: staff.id,
        requestedAt: local('2026-10-07T11:00:00'),
        reasonCode: 'CUSTOMER_POSTPONED',
        closure: {
          resolution: 'CANCELLED',
          resolvedAt: local('2026-10-08T10:00:00'),
          resolvedBy: resolver.id,
        },
      });

      const selfCancelledJob = await seedJob(pool, {
        organizationId, assignedTo: staff.id, createdBy: admin.id, title: 'Personelin iptali',
      });
      await addIncident(pool, {
        organizationId, jobId: selfCancelledJob, delayType: 'LATE_START',
        deadlineAt: local('2026-10-09T09:00:00'), breachedAt: local('2026-10-09T10:00:00'),
        accountableUserId: staff.id,
      });
      await addChangeRequest(pool, {
        organizationId, jobId: selfCancelledJob, requestedBy: staff.id,
        requestedAt: local('2026-10-09T11:00:00'),
        reasonCode: 'OTHER',
        closure: {
          resolution: 'CANCELLED',
          resolvedAt: local('2026-10-10T10:00:00'),
          resolvedBy: staff.id,
        },
      });

      const reports = buildReports(pool);
      const list = await reports.listStaffLatenessIncidents(admin, staff.id, {
        requestedRange: OCTOBER,
        limit: 20,
        offset: 0,
      });
      const byJob = new Map(list.items.map((item) => [item.job?.title, item.operationalReason]));
      expect(byJob.get('Düzeltilen iş')).toEqual({
        reasonCode: 'WRONG_PRODUCT',
        resolution: 'CORRECTED',
        resolvedAt: iso(local('2026-10-06T10:00:00')),
      });
      expect(byJob.get('Yönetimce iptal')).toEqual({
        reasonCode: 'CUSTOMER_POSTPONED',
        resolution: 'CANCELLED',
        resolvedAt: iso(local('2026-10-08T10:00:00')),
      });
      expect(byJob.get('Personelin iptali')).toBeNull();
      const beforeRoleChange = await reports.getOrganizationLateness(admin, {
        requestedRange: OCTOBER,
      });

      // Direct fixture write: the contract forbids deriving the decision from
      // the resolver current role, so both users change role after the fact.
      await pool.query("UPDATE users SET role = 'STAFF' WHERE id = $1", [resolver.id]);
      await pool.query("UPDATE users SET role = 'MANAGER' WHERE id = $1", [staff.id]);

      const card = await reports.getOrganizationLateness(admin, {
        requestedRange: OCTOBER,
      });
      expect(card).toEqual(beforeRoleChange);
      expect(card.totalIncidentCount).toBe(3);
      expect(card.operational).toEqual({ delayedJobCount: 2, incidentCount: 2 });
      expect(card.staffResponsibility).toEqual({ delayedJobCount: 1, incidentCount: 1 });

      // The Staff report keeps its existing identity rule: a user who is no
      // longer Staff is concealed, and their history stays on the card.
      await expectNotFound(reports.getStaffReport(admin, staff.id, {
        requestedRange: OCTOBER,
      }));
    });
  });
});

// ---------------------------------------------------------------------------
// LR-18: freshness after an OVR-3 scanner write.
// ---------------------------------------------------------------------------

describe.skipIf(!databaseUrl)('OVR-7 lateness freshness', () => {
  it('LR-18: a scanner-written incident appears on the next read with an advanced generatedAt', async () => {
    await withIntentSchema(databaseUrl, async (pool) => {
      const organizationId = await insertProofOrg(pool, 'LR-18');
      const manager = await seedUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staff = await seedUser(pool, organizationId, 'STAFF', 'Personel A');
      const jobId = await seedJob(pool, {
        organizationId,
        assignedTo: staff.id,
        createdBy: manager.id,
        title: 'Tarayıcı kaydı',
      });

      let now = local('2026-10-20T12:00:00');
      const reports = buildReports(pool, () => now);
      const first = await reports.getOrganizationLateness(manager, {
        requestedRange: OCTOBER,
      });
      expect(first.totalIncidentCount).toBe(0);
      expect(first.generatedAt).toBe(iso(now));

      // OVR-3 publishes no realtime event when it writes an incident.
      await addIncident(pool, {
        organizationId,
        jobId,
        delayType: 'LATE_SUBMISSION',
        deadlineAt: local('2026-10-19T09:00:00'),
        breachedAt: local('2026-10-19T10:00:00'),
        accountableUserId: staff.id,
        source: 'SCANNER',
      });

      // The loaded payload is a completed response: it does not change itself.
      expect(first.totalIncidentCount).toBe(0);
      expect(first.staffResponsibility.incidentCount).toBe(0);

      now = local('2026-10-20T12:05:00');
      const refreshed = await reports.getOrganizationLateness(manager, {
        requestedRange: OCTOBER,
      });
      expect(refreshed.totalIncidentCount).toBe(1);
      expect(refreshed.staffResponsibility).toEqual({ delayedJobCount: 1, incidentCount: 1 });
      expect(new Date(refreshed.generatedAt).getTime())
        .toBeGreaterThan(new Date(first.generatedAt).getTime());
      expect(refreshed.generatedAt).toBe(iso(now));

      const staffReport = await reports.getStaffReport(manager, staff.id, {
        requestedRange: OCTOBER,
      });
      expect(staffReport.lateness.generatedAt).toBe(iso(now));
      expect(staffReport.lateness.staffResponsibility.incidentCount).toBe(1);
    });
  });

  it('LR-16: a CANCELLED closure is not provable management when the historical assignee cannot be read', async () => {
    await withIntentSchema(databaseUrl, async (pool) => {
      const organizationId = await insertProofOrg(pool, 'LR-16-unreadable');
      const manager = await seedUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staff = await seedUser(pool, organizationId, 'STAFF', 'Personel A');
      const jobId = await seedJob(pool, {
        organizationId, assignedTo: staff.id, createdBy: manager.id, title: 'Geçmişi okunamayan iş',
      });
      await addIncident(pool, {
        organizationId, jobId, delayType: 'LATE_START',
        deadlineAt: local('2026-10-07T09:00:00'), breachedAt: local('2026-10-07T10:00:00'),
        accountableUserId: staff.id,
      });
      await addChangeRequest(pool, {
        organizationId, jobId, requestedBy: staff.id,
        requestedAt: local('2026-10-07T11:00:00'),
        reasonCode: 'CUSTOMER_POSTPONED',
        closure: {
          resolution: 'CANCELLED',
          resolvedAt: local('2026-10-08T10:00:00'),
          resolvedBy: manager.id,
        },
      });
      // Direct fixture write: the lifecycle always records assignment history;
      // removing it models a job whose historical assignee is unreadable.
      await pool.query('DELETE FROM job_card_assignment_history WHERE job_card_id = $1', [jobId]);

      const reports = buildReports(pool);
      const list = await reports.listStaffLatenessIncidents(manager, staff.id, {
        requestedRange: OCTOBER,
        limit: 20,
        offset: 0,
      });
      expect(list.items).toHaveLength(1);
      expect(list.items[0]!.operationalReason).toBeNull();
      const card = await reports.getOrganizationLateness(manager, { requestedRange: OCTOBER });
      expect(card.operational).toEqual({ delayedJobCount: 0, incidentCount: 0 });
      expect(card.staffResponsibility).toEqual({ delayedJobCount: 1, incidentCount: 1 });
    });
  });
});
