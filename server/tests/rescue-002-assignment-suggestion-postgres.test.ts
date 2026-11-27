import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import type { AppError } from '../src/errors/index.js';
import { lifecycleRequestHash } from '../src/modules/job-cards/critical-action-request-hash.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import {
  JOB_ASSIGNMENT_OFFER_SUGGESTED_SOLUTIONS,
  type AssignmentOfferDecisionInput,
  type JobAssignmentOfferSuggestedSolution,
  type JobAssignmentOfferView,
  type JobCardActor,
  type JobCardActivityDetails,
  type JobCardDetail,
  type JobCardType,
} from '../src/modules/job-cards/types.js';
import type { RealtimeEventPublisher } from '../src/modules/realtime/event-bus.js';
import type { RealtimeEventRecord } from '../src/modules/realtime/types.js';
import { MINUTE_MS, readDbBaseline } from './support/db-clock-baseline.js';

/**
 * RESCUE-002 — typed suggested solution on a declined or released assignment.
 *
 * Contract: the lead-locked RESCUE-002 contract (2026-11-27). This suite covers
 * the server half:
 *   - the new-client path: any of the five suggestions on decline AND release,
 *     all eight reason codes, a time required only for RESCHEDULE_SELF and
 *     forbidden for every other suggestion;
 *   - the legacy path: no suggestion means the unchanged JOB-012 rules, the
 *     three new reason codes need a suggestion, and the stored column stays
 *     NULL;
 *   - idempotency: a legacy body keeps its pre-change hash, and the same key
 *     with a different suggestion is CLIENT_ACTION_REUSED;
 *   - JOB-012 management confirmation for an OUT_OF_TOWN + RESCHEDULE_SELF
 *     proposal;
 *   - migration 076: the new CHECKs reject violations, the widened vocabulary
 *     accepts the new codes, and pre-existing 075 rows survive the upgrade.
 *
 * Fixtures are placed relative to the DB arbitration clock and the service
 * clock is pinned to the same instant, exactly like the JOB-012 suite.
 */

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const MIGRATION_076 = '076_assignment_offer_suggested_solution';

const WINDOW_ON = { enabled: true } as const;
/** Calendar on: the proposal path runs the same occupancy reader as reschedule. */
const CALENDAR_ON = { enabled: true, reminderLeadMinutes: 30 } as const;

async function withSchema(run: (pool: Pool) => Promise<void>): Promise<void> {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `rescue002srv_${randomUUID().replaceAll('-', '')}`;
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

async function insertOrg(pool: Pool, name = 'RESCUE-002 Klinik'): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO organizations (name, timezone) VALUES ($1, 'Europe/Istanbul') RETURNING id`,
    [name],
  )).rows[0]!.id;
}

async function insertUser(
  pool: Pool,
  organizationId: string,
  role: 'ADMIN' | 'MANAGER' | 'STAFF',
  name = `${role} User`,
): Promise<string> {
  const id = (await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role, is_active)
     VALUES ($1, $2, $3, 'test-hash', $4, TRUE) RETURNING id`,
    [organizationId, name, `${randomUUID()}@test.local`, role],
  )).rows[0]!.id;
  if (role === 'STAFF') {
    await pool.query(
      `INSERT INTO staff_profiles (organization_id, user_id, title) VALUES ($1, $2, 'Saha Personeli')`,
      [organizationId, id],
    );
  }
  return id;
}

type FixtureJob = {
  id: string;
  version: number;
  status: string;
  scheduledAt: string;
  scheduledEndsAt: string;
};

async function insertJob(pool: Pool, input: {
  organizationId: string;
  type: JobCardType;
  status: 'NEW' | 'ACCEPTED';
  assignedTo: string;
  createdBy: string;
  scheduledAt: string;
  scheduledEndsAt: string;
  acceptedAt?: string;
}): Promise<FixtureJob> {
  const acceptedAt = input.status === 'ACCEPTED'
    ? input.acceptedAt ?? '2026-01-01T08:00:00.000Z'
    : null;
  const row = (await pool.query<{ id: string; version: number; status: string }>(
    `INSERT INTO job_cards
       (organization_id, type, status, title, customer_id, assigned_to, created_by,
        accepted_at, accepted_by, scheduled_at, scheduled_ends_at, engagement_kind)
     VALUES ($1, $2, $3, $4, NULL, $5, $6,
             $7::timestamptz, $8::uuid, $9::timestamptz, $10::timestamptz, $11)
     RETURNING id, version, status`,
    [
      input.organizationId, input.type, input.status,
      'RESCUE-002 çözüm önerisi işi',
      input.assignedTo, input.createdBy,
      acceptedAt, acceptedAt === null ? null : input.assignedTo,
      input.scheduledAt, input.scheduledEndsAt,
      input.type === 'SALES_MEETING' ? 'SALES_MEETING' : null,
    ],
  )).rows[0]!;
  const createdOffsetMs = -60 * MINUTE_MS;
  await pool.query(
    `INSERT INTO job_card_schedule_revisions
       (organization_id, job_card_id, revision_no, scheduled_at, scheduled_ends_at,
        organization_timezone, source, created_by, created_at)
     VALUES ($1, $2, 1, $3, $4, 'Europe/Istanbul', 'CREATE', $5, $6)`,
    [
      input.organizationId, row.id, input.scheduledAt, input.scheduledEndsAt,
      input.createdBy, new Date(Date.parse(input.scheduledAt) + createdOffsetMs),
    ],
  );
  await pool.query(
    `INSERT INTO job_card_assignment_history
       (organization_id, job_card_id, from_user_id, to_user_id, changed_by, source, changed_at)
     VALUES ($1, $2, NULL, $3, $4, 'CREATE', $5)`,
    [
      input.organizationId, row.id, input.assignedTo, input.createdBy,
      new Date(Date.parse(input.scheduledAt) + createdOffsetMs),
    ],
  );
  return {
    id: row.id,
    version: Number(row.version),
    status: String(row.status),
    scheduledAt: input.scheduledAt,
    scheduledEndsAt: input.scheduledEndsAt,
  };
}

async function insertOffer(pool: Pool, input: {
  organizationId: string;
  jobCardId: string;
  assigneeUserId: string;
  openedBy: string;
  openedAt: Date;
  acceptanceDueAt: Date;
  state?: 'OPEN' | 'ACCEPTED';
  closedAt?: Date | null;
  closedBy?: string | null;
}): Promise<string> {
  const state = input.state ?? 'OPEN';
  return (await pool.query<{ id: string }>(
    `INSERT INTO job_card_assignment_offers
       (organization_id, job_card_id, assignee_user_id, opened_at, opened_reason, opened_by,
        acceptance_due_at, state, closed_at, closed_by, close_reason, close_text)
     VALUES ($1, $2, $3, $4, 'CREATE', $5, $6, $7, $8, $9, NULL, NULL)
     RETURNING id`,
    [
      input.organizationId, input.jobCardId, input.assigneeUserId, input.openedAt,
      input.openedBy, input.acceptanceDueAt, state,
      state === 'ACCEPTED' ? input.closedAt ?? null : null,
      state === 'ACCEPTED' ? input.closedBy ?? null : null,
    ],
  )).rows[0]!.id;
}

type OfferRow = {
  id: string;
  state: string;
  closed_by: string | null;
  close_reason: string | null;
  close_text: string | null;
  proposed_scheduled_at: Date | null;
  suggested_solution: string | null;
  proposal_accepted_at: Date | null;
  proposal_accepted_by: string | null;
};

async function readOffers(pool: Pool, jobCardId: string): Promise<OfferRow[]> {
  return (await pool.query<OfferRow>(
    `SELECT id, state, closed_by, close_reason, close_text,
            proposed_scheduled_at, suggested_solution,
            proposal_accepted_at, proposal_accepted_by
       FROM job_card_assignment_offers
      WHERE job_card_id = $1
      ORDER BY opened_at ASC, id ASC`,
    [jobCardId],
  )).rows;
}

type JobRow = {
  status: string;
  version: number;
  assigned_to: string;
  accepted_at: Date | null;
  accepted_by: string | null;
  scheduled_at: Date | null;
  scheduled_ends_at: Date | null;
};

async function readJob(pool: Pool, jobCardId: string): Promise<JobRow> {
  return (await pool.query<JobRow>(
    `SELECT status, version, assigned_to, accepted_at, accepted_by,
            scheduled_at, scheduled_ends_at
       FROM job_cards WHERE id = $1`,
    [jobCardId],
  )).rows[0]!;
}

async function readJobEvidence(pool: Pool, jobCardId: string) {
  return {
    job: await readJob(pool, jobCardId),
    offers: await readOffers(pool, jobCardId),
    activities: (await pool.query<{ event_type: string }>(
      `SELECT event_type FROM job_card_activity_logs
        WHERE job_card_id = $1 ORDER BY created_at ASC, id ASC`,
      [jobCardId],
    )).rows.map((row) => row.event_type),
  };
}

function buildService(pool: Pool, clock: { now: Date }) {
  const published: RealtimeEventRecord[] = [];
  const publisher: RealtimeEventPublisher = { publish: (event) => published.push(event) };
  const service = new JobCardService(
    new PostgresJobCardRepository(pool),
    () => clock.now,
    publisher,
    { enabled: false },
    { enabled: false },
    CALENDAR_ON,
    {},
    WINDOW_ON,
  );
  return { service, published };
}

function actor(
  id: string,
  organizationId: string,
  role: 'ADMIN' | 'MANAGER' | 'STAFF',
): JobCardActor {
  return { id, organizationId, role };
}

function isoOffset(baseline: Date, offsetMs: number): string {
  return new Date(baseline.getTime() + offsetMs).toISOString();
}

function detailsOf(error: AppError): Record<string, unknown> {
  return (error.details ?? {}) as Record<string, unknown>;
}

async function rejectionOf(run: () => Promise<unknown>): Promise<AppError> {
  try {
    await run();
  } catch (caught) {
    return caught as AppError;
  }
  throw new Error('Expected the command to be rejected, but it succeeded.');
}

type Seed = {
  organizationId: string;
  managerId: string;
  staffId: string;
  manager: JobCardActor;
  staff: JobCardActor;
};

async function seedOrganization(pool: Pool, label: string): Promise<Seed> {
  const organizationId = await insertOrg(pool, `RESCUE-002 ${label}`);
  const managerId = await insertUser(pool, organizationId, 'MANAGER', `${label} Müdür`);
  const staffId = await insertUser(pool, organizationId, 'STAFF', `${label} Saha Personeli`);
  return {
    organizationId,
    managerId,
    staffId,
    manager: actor(managerId, organizationId, 'MANAGER'),
    staff: actor(staffId, organizationId, 'STAFF'),
  };
}

async function seedOfferedJob(
  pool: Pool,
  seed: Seed,
  baseline: Date,
  overrides: {
    status?: 'NEW' | 'ACCEPTED';
    startOffsetMs?: number;
    durationMs?: number;
    acceptedOffsetMs?: number;
    offerOpenedOffsetMs?: number;
    offerDueOffsetMs?: number;
  } = {},
): Promise<{ job: FixtureJob; offerId: string }> {
  const status = overrides.status ?? 'NEW';
  const startOffsetMs = overrides.startOffsetMs ?? 120 * MINUTE_MS;
  const durationMs = overrides.durationMs ?? 120 * MINUTE_MS;
  const acceptedOffsetMs = overrides.acceptedOffsetMs ?? -180 * MINUTE_MS;
  const job = await insertJob(pool, {
    organizationId: seed.organizationId,
    type: 'SALES_MEETING',
    status,
    assignedTo: seed.staffId,
    createdBy: seed.managerId,
    scheduledAt: isoOffset(baseline, startOffsetMs),
    scheduledEndsAt: isoOffset(baseline, startOffsetMs + durationMs),
    ...(status === 'ACCEPTED'
      ? { acceptedAt: isoOffset(baseline, acceptedOffsetMs) }
      : {}),
  });
  const offerId = await insertOffer(pool, {
    organizationId: seed.organizationId,
    jobCardId: job.id,
    assigneeUserId: seed.staffId,
    openedBy: seed.managerId,
    openedAt: new Date(baseline.getTime() + (overrides.offerOpenedOffsetMs ?? -60 * MINUTE_MS)),
    acceptanceDueAt: new Date(baseline.getTime() + (overrides.offerDueOffsetMs ?? 60 * MINUTE_MS)),
    ...(status === 'ACCEPTED'
      ? {
        state: 'ACCEPTED' as const,
        closedAt: new Date(baseline.getTime() + acceptedOffsetMs),
        closedBy: seed.staffId,
      }
      : {}),
  });
  return { job, offerId };
}

function offerViewOf(detail: JobCardDetail): JobAssignmentOfferView | null {
  return detail.assignmentOffer;
}

type AssignmentDecisionDetails = Extract<
  JobCardActivityDetails,
  { kind: 'ASSIGNMENT_DECISION' }
>;

async function assignmentDecisionDetails(
  service: JobCardService,
  viewer: JobCardActor,
  jobCardId: string,
): Promise<AssignmentDecisionDetails> {
  const page = await service.listActivity(viewer, jobCardId, { limit: 50, offset: 0 });
  const entry = page.items.find(
    (item) => item.eventType === 'JOB_ASSIGNMENT_DECLINED'
      || item.eventType === 'JOB_ASSIGNMENT_RELEASED',
  );
  if (entry === undefined) throw new Error('ASSIGNMENT_DECISION activity not found');
  return entry.details as AssignmentDecisionDetails;
}

function decision(input: {
  expectedVersion: number;
  reasonCode: AssignmentOfferDecisionInput['reasonCode'];
  reasonText?: string;
  suggestedSolution?: JobAssignmentOfferSuggestedSolution | null;
  proposedScheduledAt?: string | null;
  clientActionId?: string;
}): AssignmentOfferDecisionInput {
  return {
    clientActionId: input.clientActionId ?? randomUUID(),
    expectedVersion: input.expectedVersion,
    reasonCode: input.reasonCode,
    reasonText: input.reasonText ?? 'Planım bu iş için uygun değil.',
    suggestedSolution: input.suggestedSolution,
    proposedScheduledAt: input.proposedScheduledAt,
  };
}

describe.skipIf(!databaseUrl)('RESCUE-002 — assignment suggested solution', () => {
  it('new path: every suggested solution is accepted on decline and release', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const clock = { now: baseline };
      const { service } = buildService(pool, clock);

      for (const suggestion of JOB_ASSIGNMENT_OFFER_SUGGESTED_SOLUTIONS) {
        for (const command of ['decline', 'release'] as const) {
          const seed = await seedOrganization(pool, `${suggestion} ${command}`);
          const { job } = await seedOfferedJob(pool, seed, baseline, {
            ...(command === 'release'
              ? {
                status: 'ACCEPTED' as const,
                startOffsetMs: -60 * MINUTE_MS,
                durationMs: 30 * MINUTE_MS,
                acceptedOffsetMs: -180 * MINUTE_MS,
                offerOpenedOffsetMs: -240 * MINUTE_MS,
                offerDueOffsetMs: -120 * MINUTE_MS,
              }
              : {}),
          });
          const proposal = suggestion === 'RESCHEDULE_SELF'
            ? isoOffset(baseline, 300 * MINUTE_MS)
            : null;
          const input = decision({
            expectedVersion: job.version,
            reasonCode: 'OUT_OF_TOWN',
            suggestedSolution: suggestion,
            ...(proposal === null ? {} : { proposedScheduledAt: proposal }),
          });

          if (command === 'decline') {
            await service.declineAssignment(seed.staff, job.id, input);
          } else {
            await service.releaseAssignment(seed.staff, job.id, input);
          }

          const [offer] = await readOffers(pool, job.id);
          expect(offer).toMatchObject({
            state: command === 'decline' ? 'DECLINED' : 'RELEASED',
            closed_by: seed.staffId,
            close_reason: 'OUT_OF_TOWN',
            suggested_solution: suggestion,
          });
          expect(offer!.proposed_scheduled_at?.toISOString() ?? null).toBe(proposal);
          expect(offerViewOf(await service.detail(seed.manager, job.id))).toMatchObject({
            state: command === 'decline' ? 'DECLINED' : 'RELEASED',
            closeReason: 'OUT_OF_TOWN',
            suggestedSolution: suggestion,
            proposedScheduledAt: proposal,
          });
        }
      }
    });
  });

  it('new path: each new reason code is accepted with a suggestion', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const clock = { now: baseline };
      const { service } = buildService(pool, clock);

      for (const reasonCode of ['OUT_OF_TOWN', 'CUSTOMER_POSTPONED', 'WRONG_PRODUCT'] as const) {
        for (const command of ['decline', 'release'] as const) {
          const seed = await seedOrganization(pool, `${reasonCode} ${command}`);
          const { job } = await seedOfferedJob(pool, seed, baseline, {
            ...(command === 'release' ? { status: 'ACCEPTED' as const } : {}),
          });
          const input = decision({
            expectedVersion: job.version,
            reasonCode,
            suggestedSolution: 'MANAGEMENT_DECIDES',
          });
          if (command === 'decline') {
            await service.declineAssignment(seed.staff, job.id, input);
          } else {
            await service.releaseAssignment(seed.staff, job.id, input);
          }
          const [offer] = await readOffers(pool, job.id);
          expect(offer).toMatchObject({
            state: command === 'decline' ? 'DECLINED' : 'RELEASED',
            close_reason: reasonCode,
            suggested_solution: 'MANAGEMENT_DECIDES',
            proposed_scheduled_at: null,
          });
        }
      }
    });
  });

  it('new path: RESCHEDULE_SELF requires a future time', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const seed = await seedOrganization(pool, 'Gelecek zaman');
      const { job } = await seedOfferedJob(pool, seed, baseline);
      const clock = { now: baseline };
      const { service } = buildService(pool, clock);
      const before = await readJobEvidence(pool, job.id);

      const missing = await rejectionOf(() => service.declineAssignment(seed.staff, job.id, decision({
        expectedVersion: job.version,
        reasonCode: 'ON_LEAVE',
        suggestedSolution: 'RESCHEDULE_SELF',
      })));
      expect(missing).toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
      expect(detailsOf(missing)).toMatchObject({
        fieldErrors: { proposedScheduledAt: 'Önerilen zaman zorunludur.' },
      });
      expect(await readJobEvidence(pool, job.id)).toEqual(before);

      for (const past of [isoOffset(baseline, -30 * MINUTE_MS), baseline.toISOString()]) {
        const rejected = await rejectionOf(() => service.declineAssignment(seed.staff, job.id, decision({
          expectedVersion: job.version,
          reasonCode: 'ON_LEAVE',
          suggestedSolution: 'RESCHEDULE_SELF',
          proposedScheduledAt: past,
        })));
        expect(rejected).toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
        expect(detailsOf(rejected)).toMatchObject({
          fieldErrors: { proposedScheduledAt: 'Önerilen zaman gelecekte olmalı.' },
        });
        expect(await readJobEvidence(pool, job.id)).toEqual(before);
      }

      // The time is tied to the suggestion, independent of the reason.
      const accepted = await service.declineAssignment(seed.staff, job.id, decision({
        expectedVersion: job.version,
        reasonCode: 'MISSING_STOCK_OR_EQUIPMENT',
        suggestedSolution: 'RESCHEDULE_SELF',
        proposedScheduledAt: isoOffset(baseline, 300 * MINUTE_MS),
      }));
      expect(accepted).toMatchObject({ status: 'NEW', version: job.version + 1 });
      expect((await readOffers(pool, job.id))[0]).toMatchObject({
        close_reason: 'MISSING_STOCK_OR_EQUIPMENT',
        suggested_solution: 'RESCHEDULE_SELF',
      });
    });
  });

  it('new path: a time with any other suggestion is rejected with the contract copy', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const seed = await seedOrganization(pool, 'Yasak zaman');
      const { job } = await seedOfferedJob(pool, seed, baseline);
      const clock = { now: baseline };
      const { service } = buildService(pool, clock);
      const before = await readJobEvidence(pool, job.id);
      const copy = 'Önerilen zaman yalnızca "Başka bir zamanda kendim yapabilirim" seçildiğinde verilebilir.';

      for (const suggestion of [
        'REASSIGN', 'CORRECT_DETAILS', 'CANCEL_REQUEST', 'MANAGEMENT_DECIDES',
      ] as const) {
        const rejected = await rejectionOf(() => service.releaseAssignment(seed.staff, job.id, decision({
          expectedVersion: job.version,
          reasonCode: 'SCHEDULE_CONFLICT',
          suggestedSolution: suggestion,
          proposedScheduledAt: isoOffset(baseline, 300 * MINUTE_MS),
        })));
        expect(rejected).toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
        expect(detailsOf(rejected)).toMatchObject({
          fieldErrors: { proposedScheduledAt: copy },
        });
        expect(await readJobEvidence(pool, job.id)).toEqual(before);
      }

      // SCHEDULE_CONFLICT + REASSIGN without a time is valid on the new path.
      const declined = await service.declineAssignment(seed.staff, job.id, decision({
        expectedVersion: job.version,
        reasonCode: 'SCHEDULE_CONFLICT',
        suggestedSolution: 'REASSIGN',
      }));
      expect(declined).toMatchObject({ status: 'NEW', version: job.version + 1 });
      expect((await readOffers(pool, job.id))[0]).toMatchObject({
        state: 'DECLINED',
        close_reason: 'SCHEDULE_CONFLICT',
        suggested_solution: 'REASSIGN',
        proposed_scheduled_at: null,
      });
    });
  });

  it('new path: an unknown suggestion is rejected and writes nothing', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const seed = await seedOrganization(pool, 'Bilinmeyen öneri');
      const { job } = await seedOfferedJob(pool, seed, baseline);
      const clock = { now: baseline };
      const { service } = buildService(pool, clock);
      const before = await readJobEvidence(pool, job.id);

      const rejected = await rejectionOf(() => service.declineAssignment(seed.staff, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        reasonCode: 'ON_LEAVE',
        reasonText: 'Yıllık iznimdeyim.',
        suggestedSolution: 'NOT_A_SOLUTION' as JobAssignmentOfferSuggestedSolution,
      }));
      expect(rejected).toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
      expect(detailsOf(rejected)).toMatchObject({
        fieldErrors: { suggestedSolution: expect.any(String) },
      });
      expect(await readJobEvidence(pool, job.id)).toEqual(before);
    });
  });

  it('new path: the suggestion is stored and projected to management, the assignee and the timeline', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const seed = await seedOrganization(pool, 'Projeksiyon');
      const { job } = await seedOfferedJob(pool, seed, baseline);
      const clock = { now: baseline };
      const { service } = buildService(pool, clock);

      await service.declineAssignment(seed.staff, job.id, decision({
        expectedVersion: job.version,
        reasonCode: 'WRONG_PRODUCT',
        suggestedSolution: 'CORRECT_DETAILS',
        reasonText: 'Yanlış ürün seti planlanmış.',
      }));

      expect((await readOffers(pool, job.id))[0]).toMatchObject({
        state: 'DECLINED',
        close_reason: 'WRONG_PRODUCT',
        suggested_solution: 'CORRECT_DETAILS',
      });
      for (const viewer of [seed.manager, seed.staff]) {
        expect(offerViewOf(await service.detail(viewer, job.id))).toMatchObject({
          state: 'DECLINED',
          closeReason: 'WRONG_PRODUCT',
          suggestedSolution: 'CORRECT_DETAILS',
          proposedScheduledAt: null,
        });
      }
      expect(await assignmentDecisionDetails(service, seed.manager, job.id)).toMatchObject({
        kind: 'ASSIGNMENT_DECISION',
        decision: 'DECLINED',
        reasonCode: 'WRONG_PRODUCT',
        suggestedSolution: 'CORRECT_DETAILS',
        proposedScheduledAt: null,
      });
    });
  });

  it('legacy path: the JOB-012 rules and stored NULL suggestion are unchanged', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const seed = await seedOrganization(pool, 'Eski istemci');
      const { job } = await seedOfferedJob(pool, seed, baseline);
      const clock = { now: baseline };
      const { service } = buildService(pool, clock);
      const before = await readJobEvidence(pool, job.id);

      // SCHEDULE_CONFLICT still requires a time.
      const missingTime = await rejectionOf(() => service.declineAssignment(seed.staff, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        reasonCode: 'SCHEDULE_CONFLICT',
        reasonText: 'Planım dolu.',
      }));
      expect(missingTime).toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
      expect(detailsOf(missingTime)).toMatchObject({
        fieldErrors: { proposedScheduledAt: 'Önerilen zaman zorunludur.' },
      });
      expect(await readJobEvidence(pool, job.id)).toEqual(before);

      // ON_LEAVE + time keeps the pre-RESCUE-002 copy and writes nothing.
      const timeWithOtherReason = await rejectionOf(() => service.declineAssignment(seed.staff, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        reasonCode: 'ON_LEAVE',
        reasonText: 'Yıllık iznimdeyim.',
        proposedScheduledAt: isoOffset(baseline, 300 * MINUTE_MS),
      }));
      expect(timeWithOtherReason).toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
      expect(detailsOf(timeWithOtherReason)).toMatchObject({
        fieldErrors: {
          proposedScheduledAt: 'Önerilen zaman yalnızca plan çakışması nedeniyle verilebilir.',
        },
      });

      // A new reason code without a suggestion is a validation error, not a
      // fabricated suggestion.
      for (const body of [
        {
          clientActionId: randomUUID(),
          expectedVersion: job.version,
          reasonCode: 'OUT_OF_TOWN' as const,
          reasonText: 'Şehir dışındayım.',
        },
        {
          clientActionId: randomUUID(),
          expectedVersion: job.version,
          reasonCode: 'CUSTOMER_POSTPONED' as const,
          reasonText: 'Müşteri erteledi.',
          suggestedSolution: null,
        },
      ]) {
        const rejected = await rejectionOf(() => service.declineAssignment(seed.staff, job.id, body));
        expect(rejected).toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
        expect(detailsOf(rejected)).toMatchObject({
          fieldErrors: { suggestedSolution: 'Çözüm önerisi zorunludur.' },
        });
        expect(await readJobEvidence(pool, job.id)).toEqual(before);
      }

      // The legacy SCHEDULE_CONFLICT + time answer still works and stores no
      // suggestion.
      const proposal = isoOffset(baseline, 300 * MINUTE_MS);
      await service.declineAssignment(seed.staff, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version,
        reasonCode: 'SCHEDULE_CONFLICT',
        reasonText: 'Planım dolu.',
        proposedScheduledAt: proposal,
      });
      expect((await readOffers(pool, job.id))[0]).toMatchObject({
        state: 'DECLINED',
        close_reason: 'SCHEDULE_CONFLICT',
        suggested_solution: null,
      });
      expect((await readOffers(pool, job.id))[0]!.proposed_scheduled_at?.toISOString()).toBe(proposal);
      expect(offerViewOf(await service.detail(seed.manager, job.id))).toMatchObject({
        suggestedSolution: null,
        proposedScheduledAt: proposal,
      });
    });
  });

  it('idempotency: a legacy body keeps its pre-change hash', () => {
    const base = {
      command: 'DECLINE_ASSIGNMENT',
      jobCardId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      expectedVersion: 3,
      note: null,
      revisionReason: null,
      cancelReason: null,
    };
    // Captured from lifecycleRequestHash BEFORE RESCUE-002 (2026-11-27).
    expect(lifecycleRequestHash({
      ...base,
      assignmentReason: {
        code: 'SCHEDULE_CONFLICT',
        text: '  Çakışma var.  ',
        proposedScheduledAt: '2026-11-25T09:00:00.000Z',
      },
    })).toBe('34b6811ee84641b1ee3acf6ea7051d865ec7c07ff64b23256e03298397e0bb8c');
    expect(lifecycleRequestHash({
      ...base,
      assignmentReason: { code: 'ON_LEAVE', text: 'Yıllık iznimdeyim.' },
    })).toBe('287b0ea6c007d415c98ff2240933a098eea9e22c21b2e6d936c4348ae5e48326');
    expect(lifecycleRequestHash({
      ...base,
      command: 'RELEASE_ASSIGNMENT',
      assignmentReason: {
        code: 'SCHEDULE_CONFLICT',
        text: 'Çakışma var.',
        proposedScheduledAt: '2026-11-25T12:00:00+03:00',
      },
    })).toBe('5d62d8451694cd403bc73d8d726e348191bca250fd2e22df109e29850d44b871');
  });

  it('idempotency: an exact replay succeeds and the same key with a different suggestion is a mismatch', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const seed = await seedOrganization(pool, 'Idempotency');
      const { job } = await seedOfferedJob(pool, seed, baseline);
      const clock = { now: baseline };
      const { service } = buildService(pool, clock);
      const clientActionId = randomUUID();
      const first = decision({
        clientActionId,
        expectedVersion: job.version,
        reasonCode: 'OUT_OF_TOWN',
        suggestedSolution: 'MANAGEMENT_DECIDES',
      });

      const receipt = await service.declineAssignment(seed.staff, job.id, first);
      expect(receipt).toMatchObject({ status: 'NEW', version: job.version + 1 });

      // Exact replay: the completed answer replays byte-identically.
      const replay = await service.declineAssignment(seed.staff, job.id, { ...first });
      expect(replay).toEqual(receipt);
      expect((await readOffers(pool, job.id))[0]).toMatchObject({
        state: 'DECLINED',
        suggested_solution: 'MANAGEMENT_DECIDES',
      });

      // Same key, different suggestion: the existing mismatch error.
      const mismatch = await rejectionOf(() => service.declineAssignment(seed.staff, job.id, {
        ...first,
        suggestedSolution: 'REASSIGN',
      }));
      expect(mismatch).toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
      expect((await readOffers(pool, job.id))[0]).toMatchObject({
        suggested_solution: 'MANAGEMENT_DECIDES',
      });
    });
  });

  it('JOB-012: management confirms an OUT_OF_TOWN + RESCHEDULE_SELF proposal atomically', async () => {
    await withSchema(async (pool) => {
      const baseline = await readDbBaseline(pool);
      const seed = await seedOrganization(pool, 'Onay');
      const { job, offerId } = await seedOfferedJob(pool, seed, baseline);
      const clock = { now: baseline };
      const { service } = buildService(pool, clock);
      const proposal = isoOffset(baseline, 300 * MINUTE_MS);
      const proposalEndsAt = isoOffset(baseline, 420 * MINUTE_MS);

      await service.declineAssignment(seed.staff, job.id, decision({
        expectedVersion: job.version,
        reasonCode: 'OUT_OF_TOWN',
        suggestedSolution: 'RESCHEDULE_SELF',
        proposedScheduledAt: proposal,
      }));

      const confirmed = await service.acceptAssignmentProposal(seed.manager, job.id, {
        clientActionId: randomUUID(),
        expectedVersion: job.version + 1,
        offerId,
      });
      expect(confirmed).toEqual({
        jobCardId: job.id,
        offerId: expect.any(String),
        scheduledAt: proposal,
        scheduledEndsAt: proposalEndsAt,
      });
      expect(confirmed.offerId).not.toBe(offerId);

      const persisted = await readJob(pool, job.id);
      expect(persisted).toMatchObject({
        status: 'ACCEPTED',
        version: job.version + 2,
        assigned_to: seed.staffId,
        accepted_by: seed.staffId,
      });
      expect(persisted.accepted_at).not.toBeNull();
      expect(persisted.scheduled_at?.toISOString()).toBe(proposal);
      expect(persisted.scheduled_ends_at?.toISOString()).toBe(proposalEndsAt);

      const offers = await readOffers(pool, job.id);
      const answered = offers.find((row) => row.id === offerId)!;
      expect(answered).toMatchObject({
        state: 'DECLINED',
        close_reason: 'OUT_OF_TOWN',
        suggested_solution: 'RESCHEDULE_SELF',
        proposal_accepted_by: seed.managerId,
      });
      expect(answered.proposal_accepted_at?.valueOf()).toBe(baseline.valueOf());
      const confirmedOffer = offers.find((row) => row.id === confirmed.offerId)!;
      expect(confirmedOffer).toMatchObject({
        state: 'ACCEPTED',
        close_reason: null,
        suggested_solution: null,
        proposed_scheduled_at: null,
      });
    });
  });

  it('migration 076: pre-existing 075 rows survive and the new CHECKs reject each violation', async () => {
    const adminPool = new Pool({ connectionString: databaseUrl });
    const schema = `rescue002mig_${randomUUID().replaceAll('-', '')}`;
    const legacyDirectory = await mkdtemp(path.join(tmpdir(), 'rescue002-075-'));
    let pool: Pool | null = null;
    try {
      await adminPool.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${schema},public`,
      });
      for (const name of await readdir(MIGRATIONS_DIRECTORY)) {
        if (!name.endsWith('.sql') || name >= '076_') continue;
        await copyFile(
          path.join(MIGRATIONS_DIRECTORY, name),
          path.join(legacyDirectory, name),
        );
      }
      const store = new PostgresMigrationStore(pool);
      const before = await runMigrations({ migrationsDirectory: legacyDirectory, store });
      expect(before.appliedVersions.at(-1)).toBe('075_installation_module_registry_widening');

      const baseline = await readDbBaseline(pool);
      const seed = await seedOrganization(pool, 'Migration');
      const { job } = await seedOfferedJob(pool, seed, baseline);
      const proposal = isoOffset(baseline, 300 * MINUTE_MS);
      // The two pre-existing legacy shapes: a schedule conflict with a time,
      // and every other reason without one.
      await insertLegacyOffer(pool, {
        job, seed, closeReason: 'SCHEDULE_CONFLICT', closeText: 'Planım dolu.',
        proposedScheduledAt: proposal,
      });
      await insertLegacyOffer(pool, {
        job, seed, closeReason: 'ON_LEAVE', closeText: 'Yıllık iznimdeyim.',
        proposedScheduledAt: null,
      });

      const upgrade = await runMigrations({ migrationsDirectory: MIGRATIONS_DIRECTORY, store });
      expect(upgrade.appliedVersions).toEqual([MIGRATION_076]);

      const rows = (await readOffers(pool, job.id)).filter((row) => row.state === 'DECLINED');
      expect(rows).toHaveLength(2);
      const conflictRow = rows.find((row) => row.close_reason === 'SCHEDULE_CONFLICT')!;
      expect(conflictRow.suggested_solution).toBeNull();
      expect(conflictRow.proposed_scheduled_at?.toISOString()).toBe(proposal);
      const leaveRow = rows.find((row) => row.close_reason === 'ON_LEAVE')!;
      expect(leaveRow.suggested_solution).toBeNull();
      expect(leaveRow.proposed_scheduled_at).toBeNull();

      const constraints = (await pool.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint
          WHERE conrelid = 'job_card_assignment_offers'::regclass
            AND conname IN (
              'job_card_assignment_offers_suggested_solution_check',
              'job_card_assignment_offers_suggested_solution_state_check',
              'job_card_assignment_offers_proposal_state_check',
              'job_card_assignment_offers_reschedule_proposal_check',
              'job_card_assignment_offers_close_reason_check',
              'job_card_assignment_offers_closure_check'
            )
          ORDER BY conname`,
      )).rows.map((row) => row.conname);
      expect(constraints).toHaveLength(6);

      // Positive shapes: the widened vocabulary and the new suggestion column.
      await insertSuggestionOffer(pool, {
        job, seed, state: 'DECLINED', closeReason: 'OUT_OF_TOWN',
        closeText: 'Şehir dışındayım.', suggestedSolution: 'MANAGEMENT_DECIDES',
      });
      await insertSuggestionOffer(pool, {
        job, seed, state: 'RELEASED', closeReason: 'CUSTOMER_POSTPONED',
        closeText: 'Müşteri erteledi.', suggestedSolution: 'REASSIGN',
      });
      await insertSuggestionOffer(pool, {
        job, seed, state: 'DECLINED', closeReason: 'WRONG_PRODUCT',
        closeText: 'Yanlış ürün.', suggestedSolution: 'RESCHEDULE_SELF',
        proposedScheduledAt: proposal,
      });

      // Violation 1: unknown suggestion value.
      await expect(insertSuggestionOffer(pool, {
        job, seed, state: 'DECLINED', closeReason: 'ON_LEAVE',
        closeText: 'İzin.', suggestedSolution: 'NOT_A_SOLUTION' as never,
      })).rejects.toMatchObject({
        code: '23514',
        constraint: 'job_card_assignment_offers_suggested_solution_check',
      });

      // Violation 2: a suggestion on an OPEN offer.
      await expect(insertSuggestionOffer(pool, {
        job, seed, state: 'OPEN', closeReason: null, closeText: null,
        suggestedSolution: 'REASSIGN', distinctJob: true,
      })).rejects.toMatchObject({
        code: '23514',
        constraint: 'job_card_assignment_offers_suggested_solution_state_check',
      });

      // Violation 3: RESCHEDULE_SELF without a time.
      await expect(insertSuggestionOffer(pool, {
        job, seed, state: 'DECLINED', closeReason: 'ON_LEAVE',
        closeText: 'İzin.', suggestedSolution: 'RESCHEDULE_SELF',
      })).rejects.toMatchObject({
        code: '23514',
        constraint: 'job_card_assignment_offers_reschedule_proposal_check',
      });

      // Violation 4: a time with a non-RESCHEDULE_SELF suggestion.
      await expect(insertSuggestionOffer(pool, {
        job, seed, state: 'DECLINED', closeReason: 'ON_LEAVE',
        closeText: 'İzin.', suggestedSolution: 'REASSIGN',
        proposedScheduledAt: proposal,
      })).rejects.toMatchObject({
        code: '23514',
        constraint: 'job_card_assignment_offers_proposal_state_check',
      });

      // Violation 5: legacy shape with a time on a non-conflict reason.
      await expect(insertSuggestionOffer(pool, {
        job, seed, state: 'DECLINED', closeReason: 'ON_LEAVE',
        closeText: 'İzin.', suggestedSolution: null,
        proposedScheduledAt: proposal,
      })).rejects.toMatchObject({
        code: '23514',
        constraint: 'job_card_assignment_offers_proposal_state_check',
      });

      // Violation 6: an unknown close reason.
      await expect(insertSuggestionOffer(pool, {
        job, seed, state: 'DECLINED', closeReason: 'NOT_A_REASON',
        closeText: 'Bilinmeyen.', suggestedSolution: 'REASSIGN',
      })).rejects.toMatchObject({
        code: '23514',
        constraint: 'job_card_assignment_offers_close_reason_check',
      });

      // Violation 7: a new reason code without the mandatory answer text.
      await expect(insertSuggestionOffer(pool, {
        job, seed, state: 'DECLINED', closeReason: 'OUT_OF_TOWN',
        closeText: null, suggestedSolution: 'REASSIGN',
      })).rejects.toMatchObject({
        code: '23514',
        constraint: 'job_card_assignment_offers_closure_check',
      });

      // Violation 8: a suggestion on a WITHDRAWN offer.
      await expect(insertSuggestionOffer(pool, {
        job, seed, state: 'WITHDRAWN', closeReason: 'REASSIGNED',
        closeText: null, suggestedSolution: 'MANAGEMENT_DECIDES',
      })).rejects.toMatchObject({
        code: '23514',
        constraint: 'job_card_assignment_offers_suggested_solution_state_check',
      });
    } finally {
      await pool?.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
      await rm(legacyDirectory, { recursive: true, force: true });
    }
  });
});

/** A pre-076 offer row with no suggestion column value. */
async function insertLegacyOffer(pool: Pool, input: {
  job: FixtureJob;
  seed: Seed;
  closeReason: string;
  closeText: string;
  proposedScheduledAt: string | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO job_card_assignment_offers
       (organization_id, job_card_id, assignee_user_id, opened_at, opened_reason, opened_by,
        acceptance_due_at, state, closed_at, closed_by, close_reason, close_text,
        proposed_scheduled_at)
     VALUES ($1, $2, $3, now() - interval '2 hours', 'CREATE', $4,
             now() - interval '1 hour', 'DECLINED', now() - interval '90 minutes', $3,
             $5, $6, $7::timestamptz)`,
    [
      input.seed.organizationId, input.job.id, input.seed.staffId, input.seed.managerId,
      input.closeReason, input.closeText, input.proposedScheduledAt,
    ],
  );
}

/**
 * Direct INSERT for the migration CHECKs. `distinctJob` inserts one fresh OPEN
 * job so the partial unique index does not absorb the case.
 */
async function insertSuggestionOffer(pool: Pool, input: {
  job: FixtureJob;
  seed: Seed;
  state: 'OPEN' | 'DECLINED' | 'RELEASED' | 'WITHDRAWN';
  closeReason: string | null;
  closeText: string | null;
  suggestedSolution: string | null;
  proposedScheduledAt?: string | null;
  distinctJob?: boolean;
}): Promise<void> {
  let jobCardId = input.job.id;
  if (input.distinctJob === true) {
    const openJob = await insertJob(pool, {
      organizationId: input.seed.organizationId,
      type: 'SALES_MEETING',
      status: 'NEW',
      assignedTo: input.seed.staffId,
      createdBy: input.seed.managerId,
      scheduledAt: new Date(Date.now() + 120 * MINUTE_MS).toISOString(),
      scheduledEndsAt: new Date(Date.now() + 180 * MINUTE_MS).toISOString(),
    });
    jobCardId = openJob.id;
  }
  const closed = input.state !== 'OPEN';
  await pool.query(
    `INSERT INTO job_card_assignment_offers
       (organization_id, job_card_id, assignee_user_id, opened_at, opened_reason, opened_by,
        acceptance_due_at, state, closed_at, closed_by, close_reason, close_text,
        proposed_scheduled_at, suggested_solution)
     VALUES ($1, $2, $3, now() - interval '2 hours', 'CREATE', $4,
             now() - interval '1 hour', $5, $6::timestamptz, $7::uuid, $8, $9,
             $10::timestamptz, $11)`,
    [
      input.seed.organizationId, jobCardId, input.seed.staffId, input.seed.managerId,
      input.state,
      closed ? new Date().toISOString() : null,
      closed ? input.seed.staffId : null,
      input.closeReason, input.closeText,
      input.proposedScheduledAt ?? null, input.suggestedSolution,
    ],
  );
}
