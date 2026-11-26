import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import type { SafeUser } from '../src/modules/auth/types.js';
import {
  PostgresOverdueBreachScannerRepository,
  createOverdueBreachScanner,
} from '../src/modules/job-cards/overdue-breach-scanner.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCardActor } from '../src/modules/job-cards/types.js';
import { PostgresReportsRepository } from '../src/modules/reports/repository.js';
import { PostgresReportReadSnapshot } from '../src/modules/reports/read-snapshot.js';
import { ReportsService } from '../src/modules/reports/service.js';
import { insertProofOrg, withIntentSchema } from './support/lifecycle-intent-harness.js';

/**
 * RESCUE-001 P2 — OVR-7 record-only change-request closure.
 *
 * Pins the CURRENT accepted behavior of OVR-7 §4 and
 * `docs/features/reporting/lateness-reports.md` §4.3: a STAFF_PROVEN incident
 * overlapped by the accountable Staff member's own change request that
 * management resolved with RESCHEDULED is regrouped into the operational group
 * "Yönetimce sonuçlandırılan değişiklik talebiyle ilişkili gecikmeler", even
 * when the resolution is record-only and the JobCard schedule/version never
 * changed. The RESCUE-003 neutral acknowledgement proposal would change this
 * classification, so the assertions below must be updated intentionally with
 * that accepted decision — not to make a future implementation pass.
 *
 * The incident is produced by the real OVR-3 breach scanner (not hand-inserted)
 * and the change request is opened/resolved by the real JobCardService command
 * path. Only the JobCard activation fixture is written directly, matching
 * `job-card-overdue-breach-scanner-postgres.test.ts`, because the scanner needs
 * exact accepted/revision instants rather than a "now"-relative lifecycle.
 */

const databaseUrl = process.env.TEST_DATABASE_URL;

const OCTOBER = { from: '2026-10-01', to: '2026-10-31' } as const;
const RESOLVED_OCTOBER = {
  from: OCTOBER.from,
  to: OCTOBER.to,
  timezone: 'Europe/Istanbul',
} as const;

// Europe/Istanbul is UTC+03 all year. 10:00 local is the planned end.
const SCHEDULED_AT = new Date('2026-10-05T06:00:00.000Z');
const SCHEDULED_ENDS_AT = new Date('2026-10-05T07:00:00.000Z');
const ACCEPTED_AT = new Date('2026-10-05T06:30:00.000Z');
const REQUESTED_AT = new Date('2026-10-05T08:00:00.000Z');
const RESOLVED_AT = new Date('2026-10-05T09:00:00.000Z');
const REPORT_TIME = new Date('2026-10-05T10:00:00.000Z');

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
    [organizationId, name, `${randomUUID()}@rescue001.local`, role],
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

/**
 * ACCEPTED GENERAL_TASK with the governing revision and assignment history the
 * scanner needs to prove a STAFF incident at the planned-end boundary. This is
 * the fixture shape owned by `job-card-overdue-breach-scanner-postgres.test.ts`.
 */
async function seedAcceptedJob(
  pool: Pool,
  input: {
    organizationId: string;
    staffId: string;
    managerId: string;
    title: string;
  },
): Promise<{ id: string; version: number }> {
  const row = (await pool.query<{ id: string; version: number }>(
    `INSERT INTO job_cards
       (organization_id, type, status, title, assigned_to, created_by,
        accepted_at, accepted_by, scheduled_at, scheduled_ends_at)
     VALUES ($1, 'GENERAL_TASK', 'ACCEPTED', $2, $3, $4, $5, $3, $6, $7)
     RETURNING id, version`,
    [
      input.organizationId,
      input.title,
      input.staffId,
      input.managerId,
      ACCEPTED_AT,
      SCHEDULED_AT,
      SCHEDULED_ENDS_AT,
    ],
  )).rows[0]!;
  await pool.query(
    `INSERT INTO job_card_schedule_revisions
       (organization_id, job_card_id, revision_no, scheduled_at, scheduled_ends_at,
        organization_timezone, source, created_by, created_at)
     SELECT $1, $2, 1, $3, $4, o.timezone, 'BASELINE', $5, $6
       FROM organizations o WHERE o.id = $1`,
    [
      input.organizationId,
      row.id,
      SCHEDULED_AT,
      SCHEDULED_ENDS_AT,
      input.staffId,
      ACCEPTED_AT,
    ],
  );
  await pool.query(
    `INSERT INTO job_card_assignment_history
       (organization_id, job_card_id, from_user_id, to_user_id, changed_by, source, changed_at)
     VALUES ($1, $2, NULL, $3, $3, 'BASELINE', $4)`,
    [input.organizationId, row.id, input.staffId, ACCEPTED_AT],
  );
  return { id: row.id, version: Number(row.version) };
}

function scannerFor(pool: Pool) {
  return createOverdueBreachScanner(
    new PostgresOverdueBreachScannerRepository(new PostgresJobCardRepository(pool)),
    { batchSize: 50 },
  );
}

function buildJobCards(pool: Pool, clock: { now: Date }): JobCardService {
  return new JobCardService(
    new PostgresJobCardRepository(pool),
    () => clock.now,
  );
}

function buildReports(pool: Pool): ReportsService {
  return new ReportsService(
    new PostgresReportsRepository(pool),
    new PostgresReportReadSnapshot(pool, new PostgresJobCardRepository(pool)),
    () => REPORT_TIME,
  );
}

function actorOf(user: SafeUser): JobCardActor {
  return { id: user.id, organizationId: user.organizationId, role: user.role };
}

async function jobSchedule(pool: Pool, jobCardId: string) {
  return (await pool.query<{
    version: number;
    scheduled_at: Date;
    scheduled_ends_at: Date;
  }>(
    `SELECT version, scheduled_at, scheduled_ends_at FROM job_cards WHERE id = $1`,
    [jobCardId],
  )).rows[0]!;
}

async function scannerIncident(pool: Pool, jobCardId: string) {
  return (await pool.query<{
    id: string;
    delay_type: string;
    accountable_role: string;
    accountable_source: string;
    accountable_user_id: string | null;
    source: string;
    recovered_at: Date | null;
  }>(
    `SELECT id, delay_type, accountable_role, accountable_source,
            accountable_user_id, source, recovered_at
       FROM job_card_overdue_incidents
      WHERE job_card_id = $1`,
    [jobCardId],
  )).rows[0]!;
}

async function seedScenario(
  pool: Pool,
  label: string,
  resolution: 'RESCHEDULED' | 'REJECTED',
) {
  const organizationId = await insertProofOrg(pool, `RESCUE-001 P2 ${label}`);
  const manager = await seedUser(pool, organizationId, 'MANAGER', `${label} Müdür`);
  const staff = await seedUser(pool, organizationId, 'STAFF', `${label} Personel`);
  const job = await seedAcceptedJob(pool, {
    organizationId,
    staffId: staff.id,
    managerId: manager.id,
    title: `${label} kabul edilmiş iş`,
  });

  // Real OVR-3 clock-only scanner at the planned-end boundary.
  const scan = await scannerFor(pool).runOnce(SCHEDULED_ENDS_AT);
  expect(scan.inserted).toBe(1);
  const incident = await scannerIncident(pool, job.id);
  expect(incident).toMatchObject({
    delay_type: 'LATE_START',
    accountable_role: 'STAFF',
    accountable_source: 'ASSIGNMENT_AT_BREACH',
    accountable_user_id: staff.id,
    source: 'SCANNER',
    recovered_at: null,
  });

  const clock = { now: REQUESTED_AT };
  const service = buildJobCards(pool, clock);
  const created = await service.createChangeRequest(actorOf(staff), job.id, {
    clientActionId: randomUUID(),
    reasonCode: 'CUSTOMER_POSTPONED',
    reasonText: 'Müşteri randevuyu erteledi.',
  });

  clock.now = RESOLVED_AT;
  const resolved = await service.resolveChangeRequest(
    actorOf(manager),
    job.id,
    created.changeRequestId,
    {
      clientActionId: randomUUID(),
      resolution,
      ...(resolution === 'REJECTED' ? { note: 'Talep uygun değil.' } : {}),
    },
  );

  return { organizationId, manager, staff, job, incident, created, resolved };
}

describe.skipIf(!databaseUrl)(
  'RESCUE-001 P2 OVR-7 §4 / lateness-reports §4.3 record-only closure (pins current accepted behavior; RESCUE-003 neutral acknowledgement would change it)',
  () => {
    it('RESCHEDULED on an unchanged JobCard regroups the overlapping STAFF_PROVEN incident into the operational group', async () => {
      await withIntentSchema(databaseUrl, async (pool) => {
        const seed = await seedScenario(pool, 'RESCHEDULED', 'RESCHEDULED');
        expect(seed.resolved.resolution).toBe('RESCHEDULED');

        // Record-only closure: job schedule and version stay untouched.
        const jobAfter = await jobSchedule(pool, seed.job.id);
        expect(jobAfter.version).toBe(seed.job.version);
        expect(jobAfter.scheduled_at.toISOString()).toBe(SCHEDULED_AT.toISOString());
        expect(jobAfter.scheduled_ends_at.toISOString()).toBe(SCHEDULED_ENDS_AT.toISOString());

        const requestRow = (await pool.query<{
          state: string;
          resolution: string | null;
          resolved_by: string | null;
        }>(
          `SELECT state, resolution, resolved_by
             FROM job_card_change_requests WHERE id = $1`,
          [seed.created.changeRequestId],
        )).rows[0]!;
        expect(requestRow).toEqual({
          state: 'CLOSED',
          resolution: 'RESCHEDULED',
          resolved_by: seed.manager.id,
        });

        const reports = buildReports(pool);
        const report = await reports.getStaffReport(seed.manager, seed.staff.id, {
          requestedRange: OCTOBER,
        });
        expect(report.range).toEqual(RESOLVED_OCTOBER);
        expect(report.lateness.staffResponsibility).toEqual({
          delayedJobCount: 0,
          incidentCount: 0,
          byType: [
            {
              delayType: 'LATE_START',
              incidentCount: 0,
              recovered: { count: 0, medianSeconds: null, maxSeconds: null },
              extended: { count: 0, medianSeconds: null, maxSeconds: null },
              open: { count: 0, maxElapsedSeconds: null },
            },
            {
              delayType: 'LATE_SUBMISSION',
              incidentCount: 0,
              recovered: { count: 0, medianSeconds: null, maxSeconds: null },
              extended: { count: 0, medianSeconds: null, maxSeconds: null },
              open: { count: 0, maxElapsedSeconds: null },
            },
          ],
        });
        expect(report.lateness.operational).toEqual({
          delayedJobCount: 1,
          incidentCount: 1,
          byReason: [{ reasonCode: 'CUSTOMER_POSTPONED', incidentCount: 1 }],
        });

        const list = await reports.listStaffLatenessIncidents(seed.manager, seed.staff.id, {
          requestedRange: OCTOBER,
          limit: 50,
          offset: 0,
        });
        expect(list.total).toBe(1);
        expect(list.items).toHaveLength(1);
        expect(list.items[0]).toMatchObject({
          incidentId: seed.incident.id,
          delayType: 'LATE_START',
          outcome: 'OPEN',
          operationalReason: {
            reasonCode: 'CUSTOMER_POSTPONED',
            resolution: 'RESCHEDULED',
            resolvedAt: RESOLVED_AT.toISOString(),
          },
        });
      });
    });

    it('REJECTED control on an unchanged JobCard leaves the incident in Staff responsibility', async () => {
      await withIntentSchema(databaseUrl, async (pool) => {
        const seed = await seedScenario(pool, 'REJECTED', 'REJECTED');
        expect(seed.resolved.resolution).toBe('REJECTED');

        const jobAfter = await jobSchedule(pool, seed.job.id);
        expect(jobAfter.version).toBe(seed.job.version);
        expect(jobAfter.scheduled_at.toISOString()).toBe(SCHEDULED_AT.toISOString());
        expect(jobAfter.scheduled_ends_at.toISOString()).toBe(SCHEDULED_ENDS_AT.toISOString());

        const requestRow = (await pool.query<{
          state: string;
          resolution: string | null;
          resolved_by: string | null;
        }>(
          `SELECT state, resolution, resolved_by
             FROM job_card_change_requests WHERE id = $1`,
          [seed.created.changeRequestId],
        )).rows[0]!;
        expect(requestRow).toEqual({
          state: 'CLOSED',
          resolution: 'REJECTED',
          resolved_by: seed.manager.id,
        });

        const reports = buildReports(pool);
        const report = await reports.getStaffReport(seed.manager, seed.staff.id, {
          requestedRange: OCTOBER,
        });
        // 07:00Z breach -> 10:00Z report time = 3 hours, open.
        const elapsedSeconds = 3 * 60 * 60;
        expect(report.lateness.staffResponsibility).toEqual({
          delayedJobCount: 1,
          incidentCount: 1,
          byType: [
            {
              delayType: 'LATE_START',
              incidentCount: 1,
              recovered: { count: 0, medianSeconds: null, maxSeconds: null },
              extended: { count: 0, medianSeconds: null, maxSeconds: null },
              open: { count: 1, maxElapsedSeconds: elapsedSeconds },
            },
            {
              delayType: 'LATE_SUBMISSION',
              incidentCount: 0,
              recovered: { count: 0, medianSeconds: null, maxSeconds: null },
              extended: { count: 0, medianSeconds: null, maxSeconds: null },
              open: { count: 0, maxElapsedSeconds: null },
            },
          ],
        });
        expect(report.lateness.operational).toEqual({
          delayedJobCount: 0,
          incidentCount: 0,
          byReason: [],
        });

        const list = await reports.listStaffLatenessIncidents(seed.manager, seed.staff.id, {
          requestedRange: OCTOBER,
          limit: 50,
          offset: 0,
        });
        expect(list.total).toBe(1);
        expect(list.items).toHaveLength(1);
        expect(list.items[0]).toMatchObject({
          incidentId: seed.incident.id,
          delayType: 'LATE_START',
          outcome: 'OPEN',
          operationalReason: null,
        });
      });
    });
  },
);
