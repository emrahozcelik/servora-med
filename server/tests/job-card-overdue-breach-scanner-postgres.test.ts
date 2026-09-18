import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import {
  PostgresOverdueBreachScannerRepository,
  createOverdueBreachScanner,
  type OverdueBreachScannerRepository,
  type OverdueScanCandidateOutcome,
} from '../src/modules/job-cards/overdue-breach-scanner.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { ReverseGeocoder } from '../src/modules/job-cards/reverse-geocoder.js';
import type { JobCardActor, JobCardStatus } from '../src/modules/job-cards/types.js';
import {
  insertProofUser,
  readDbClock,
  waitFor,
  withIntentSchema,
} from './support/lifecycle-intent-harness.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

// ---------------------------------------------------------------------------
// Worker loop (no database): bounded batches, per-candidate failure isolation.
// ---------------------------------------------------------------------------

type StubOutcome = OverdueScanCandidateOutcome | 'throw';

function stubScannerRepository(plan: {
  candidates: Record<string, readonly string[]>;
  outcomes: Map<string, StubOutcome>;
  seen: string[];
}): OverdueBreachScannerRepository {
  return {
    async listCandidates({ delayType, limit }) {
      return (plan.candidates[delayType] ?? []).slice(0, limit).map((jobCardId) => ({
        organizationId: 'org-1',
        jobCardId,
      }));
    },
    async scanCandidate({ candidate }) {
      plan.seen.push(candidate.jobCardId);
      const outcome = plan.outcomes.get(candidate.jobCardId) ?? { kind: 'converged' };
      if (outcome === 'throw') throw new Error('deliberate candidate failure');
      return outcome;
    },
  };
}

describe('OVR-3 scanner worker loop', () => {
  it('bounds the batch, isolates one failing candidate and keeps the rest', async () => {
    const plan = {
      candidates: { LATE_START: ['a', 'b', 'c'], LATE_SUBMISSION: [], APPROVAL_WAIT: ['d', 'e'] },
      outcomes: new Map<string, StubOutcome>([
        ['a', 'throw'],
        ['b', { kind: 'inserted' }],
        ['c', { kind: 'inserted' }],
        ['d', { kind: 'skipped-in-flight-request' }],
        ['e', { kind: 'converged' }],
      ]),
      seen: [] as string[],
    };
    const scanner = createOverdueBreachScanner(stubScannerRepository(plan), { batchSize: 2 });
    const report = await scanner.runOnce(new Date('2026-08-03T10:00:00.000Z'));
    // 'c' is the third LATE_START candidate and must be cut off by the bound,
    // while the later APPROVAL_WAIT delay type is still evaluated.
    expect(plan.seen).toEqual(['a', 'b', 'd', 'e']);
    expect(report.candidates).toBe(4);
    expect(report.failed).toBe(1);
    expect(report.inserted).toBe(1);
    expect(report.converged).toBe(1);
    expect(report.skippedInFlightRequest).toBe(1);
    expect(report.byDelayType).toEqual({ LATE_START: 2, LATE_SUBMISSION: 0, APPROVAL_WAIT: 2 });
    expect(report.scanTime).toBe('2026-08-03T10:00:00.000Z');
  });

  it('never lets a candidate failure abort the iteration and reports a failed tick explicitly', async () => {
    const plan = {
      candidates: {},
      outcomes: new Map<string, StubOutcome>(),
      seen: [] as string[],
    };
    const repository: OverdueBreachScannerRepository = {
      listCandidates: () => { throw new Error('discovery unavailable'); },
      scanCandidate: async () => ({ kind: 'converged' }),
    };
    const scanner = createOverdueBreachScanner(repository, {});
    await expect(scanner.runOnce(new Date('2026-08-03T10:00:00.000Z')))
      .rejects.toThrow('discovery unavailable');
    void stubScannerRepository(plan);
  });

  it('start/stop is non-overlapping and shutdown awaits the active iteration', async () => {
    let running = 0;
    let maxConcurrent = 0;
    let ticks = 0;
    const repository: OverdueBreachScannerRepository = {
      async listCandidates() {
        running += 1;
        maxConcurrent = Math.max(maxConcurrent, running);
        try {
          await new Promise((resolve) => setTimeout(resolve, 15));
          ticks += 1;
          return [];
        } finally {
          running -= 1;
        }
      },
      scanCandidate: async () => ({ kind: 'converged' }),
    };
    const scanner = createOverdueBreachScanner(repository, { pollIntervalMs: 5 });
    scanner.start();
    await waitFor(async () => ticks >= 2, 2_000, 'two scanner ticks');
    await scanner.stop();
    expect(maxConcurrent).toBe(1);
    const after = ticks;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(ticks).toBe(after);
  });
});

// ---------------------------------------------------------------------------
// PostgreSQL integration and concurrency proofs.
// ---------------------------------------------------------------------------

function scannerFor(pool: Pool, batchSize = 50) {
  return createOverdueBreachScanner(
    new PostgresOverdueBreachScannerRepository(new PostgresJobCardRepository(pool)),
    { batchSize, onError: (error) => { console.error('SCANNER_DEBUG', error); } },
  );
}

function buildService(pool: Pool, clock: { now: Date }, geocoder?: ReverseGeocoder) {
  return new JobCardService(
    new PostgresJobCardRepository(pool),
    () => clock.now,
    { publish: () => undefined },
    geocoder ? { enabled: true, reverseGeocoder: geocoder } : { enabled: false },
    { enabled: false },
    { enabled: false, reminderLeadMinutes: 30 },
  );
}

async function seedOrganization(pool: Pool, timezone = 'Europe/Istanbul'): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO organizations (name, timezone) VALUES ($1, $2) RETURNING id`,
    [`OVR3 ${randomUUID()}`, timezone],
  )).rows[0]!.id;
}

async function seedStaff(pool: Pool, organizationId: string): Promise<string> {
  return insertProofUser(pool, organizationId, 'STAFF');
}

type SeedJobInput = {
  organizationId: string;
  staffId: string;
  status: JobCardStatus;
  acceptedAt?: Date | null;
  startedAt?: Date | null;
  scheduledAt?: Date | null;
  scheduledEndsAt?: Date | null;
  dueDate?: string | null;
  revisionCreatedAt?: Date;
  withRevision?: boolean;
  withAssignmentHistory?: boolean;
};

/** Status-implied timestamps the job_cards CHECK constraints require. */
const REQUIRES_STARTED = ['IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED', 'COMPLETED'];
const REQUIRES_COMPLETION = ['WAITING_APPROVAL', 'REVISION_REQUESTED', 'COMPLETED'];

/**
 * OVR-3 timing fixtures are written directly: the scanner decides from
 * persisted facts against an injected `scanTime`, so tests need exact
 * activation / revision / deadline instants rather than "now"-relative ones.
 * The rows written are exactly the rows the product writes (job + governing
 * revision + assignment history).
 */
async function seedJob(pool: Pool, input: SeedJobInput): Promise<string> {
  const timezone = (await pool.query<{ timezone: string }>(
    'SELECT timezone FROM organizations WHERE id = $1',
    [input.organizationId],
  )).rows[0]!.timezone;
  const revisionCreatedAt = input.revisionCreatedAt ?? input.acceptedAt ?? new Date();
  const startedAt = input.startedAt
    ?? (REQUIRES_STARTED.includes(input.status) ? revisionCreatedAt : null);
  const completedAt = REQUIRES_COMPLETION.includes(input.status) ? revisionCreatedAt : null;
  const jobCardId = (await pool.query<{ id: string }>(
    `INSERT INTO job_cards
       (organization_id, type, status, title, assigned_to, created_by,
        accepted_at, accepted_by, started_at, staff_completed_at, staff_completed_by,
        scheduled_at, scheduled_ends_at, due_date)
     VALUES ($1, 'GENERAL_TASK', $2, 'OVR3 fixture', $3, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      input.organizationId, input.status, input.staffId,
      input.acceptedAt ?? null, input.acceptedAt ? input.staffId : null,
      startedAt, completedAt, completedAt ? input.staffId : null,
      input.scheduledAt ?? null, input.scheduledEndsAt ?? null, input.dueDate ?? null,
    ],
  )).rows[0]!.id;
  if (input.withRevision !== false) {
    await pool.query(
      `INSERT INTO job_card_schedule_revisions
         (organization_id, job_card_id, revision_no, scheduled_at, scheduled_ends_at,
          due_date, organization_timezone, source, created_by, created_at)
       VALUES ($1, $2, 1, $3, $4, $5, $6, 'BASELINE', $7, $8)`,
      [
        input.organizationId, jobCardId, input.scheduledAt ?? null,
        input.scheduledEndsAt ?? null, input.dueDate ?? null, timezone,
        input.staffId, revisionCreatedAt,
      ],
    );
  }
  if (input.withAssignmentHistory !== false) {
    await pool.query(
      `INSERT INTO job_card_assignment_history
         (organization_id, job_card_id, from_user_id, to_user_id, changed_by, source, changed_at)
       VALUES ($1, $2, NULL, $3, $3, 'BASELINE', $4)`,
      [input.organizationId, jobCardId, input.staffId, revisionCreatedAt],
    );
  }
  return jobCardId;
}

async function incidents(pool: Pool, organizationId: string, jobCardId: string) {
  return (await pool.query(
    `SELECT id, delay_type, episode_no, schedule_revision_no, deadline_at, breached_at,
            accountable_user_id, accountable_role, accountable_source, source,
            recovered_at, recovery_actor_user_id
       FROM job_card_overdue_incidents
      WHERE organization_id = $1 AND job_card_id = $2
      ORDER BY id`,
    [organizationId, jobCardId],
  )).rows as Record<string, unknown>[];
}

const EARLY = new Date('2026-08-03T06:00:00.000Z');
const BOUNDARY = new Date('2026-08-03T07:30:00.000Z');

describe.skipIf(!databaseUrl)('OVR-3 clock-only breach scanner (PostgreSQL)', () => {
  it('migration 050 accepts SCANNER, keeps the existing sources and backfills nothing', async () => {
    await withIntentSchema(databaseUrl, async (pool) => {
      const organizationId = await seedOrganization(pool, 'UTC');
      const staffId = await seedStaff(pool, organizationId);
      const jobCardId = await seedJob(pool, {
        organizationId, staffId, status: 'ACCEPTED', acceptedAt: EARLY,
        scheduledAt: EARLY, scheduledEndsAt: BOUNDARY, revisionCreatedAt: EARLY,
      });
      const empty = await pool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM job_card_overdue_incidents',
      );
      expect(empty.rows[0]!.count).toBe('0');
      const insert = (source: string) => pool.query(
        `INSERT INTO job_card_overdue_incidents
           (organization_id, job_card_id, delay_type, episode_no, schedule_revision_no,
            deadline_at, breached_at, accountable_role, accountable_source, source)
         VALUES ($1, $2, 'LATE_START', 1, 1, $3, $3, 'STAFF', 'UNKNOWN', $4)`,
        [organizationId, jobCardId, BOUNDARY, source],
      );
      await insert('SCANNER');
      await expect(insert('NOT_A_PRODUCER')).rejects.toMatchObject({ code: '23514' });
      await expect(insert('TRANSITION')).rejects.toMatchObject({ code: '23505' });
    });
  });

  it('LATE_START: no obligation clock-only for NEW, boundary at equality, one incident per episode', async () => {
    await withIntentSchema(databaseUrl, async (pool) => {
      const organizationId = await seedOrganization(pool, 'UTC');
      const staffId = await seedStaff(pool, organizationId);
      // NEW never becomes a clock-only accepted obligation.
      const newJob = await seedJob(pool, {
        organizationId, staffId, status: 'NEW', scheduledAt: EARLY,
        scheduledEndsAt: BOUNDARY, revisionCreatedAt: EARLY,
      });
      const acceptedJob = await seedJob(pool, {
        organizationId, staffId, status: 'ACCEPTED', acceptedAt: EARLY,
        scheduledAt: EARLY, scheduledEndsAt: BOUNDARY, revisionCreatedAt: EARLY,
      });
      const scanner = scannerFor(pool);

      const before = await scanner.runOnce(new Date(BOUNDARY.getTime() - 1));
      expect(before.inserted).toBe(0);
      expect(await incidents(pool, organizationId, newJob)).toHaveLength(0);
      expect(await incidents(pool, organizationId, acceptedJob)).toHaveLength(0);

      // Equality at scheduled_ends_at is late.
      const at = await scanner.runOnce(BOUNDARY);
      expect(at.inserted).toBe(1);
      const rows = await incidents(pool, organizationId, acceptedJob);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        delay_type: 'LATE_START',
        episode_no: 1,
        schedule_revision_no: 1,
        source: 'SCANNER',
        accountable_user_id: staffId,
        accountable_role: 'STAFF',
        accountable_source: 'ASSIGNMENT_AT_BREACH',
        recovered_at: null,
        recovery_actor_user_id: null,
      });
      expect((rows[0]!.deadline_at as Date).getTime()).toBe(BOUNDARY.getTime());
      expect((rows[0]!.breached_at as Date).getTime()).toBe(BOUNDARY.getTime());

      // After the boundary and on every later scan the same single incident
      // stands. Once the identity is materialized, discovery no longer offers
      // it as a candidate at all, so repeated scans stay a no-op rather than
      // relying on insert-time conflict handling.
      const after = await scanner.runOnce(new Date(BOUNDARY.getTime() + 3_600_000));
      expect(after.inserted).toBe(0);
      expect(after.candidates).toBe(0);
      expect(after.converged).toBe(0);
      expect(await incidents(pool, organizationId, acceptedJob)).toHaveLength(1);
      expect(await incidents(pool, organizationId, newJob)).toHaveLength(0);
    });
  });

  it('LATE_START: a late acceptance never backdates the breach before it existed', async () => {
    await withIntentSchema(databaseUrl, async (pool) => {
      const organizationId = await seedOrganization(pool, 'UTC');
      const staffId = await seedStaff(pool, organizationId);
      const acceptedAt = new Date(BOUNDARY.getTime() + 1_800_000);
      const jobCardId = await seedJob(pool, {
        organizationId, staffId, status: 'ACCEPTED', acceptedAt,
        scheduledAt: EARLY, scheduledEndsAt: BOUNDARY, revisionCreatedAt: acceptedAt,
      });
      const scanner = scannerFor(pool);
      const midway = new Date(BOUNDARY.getTime() + 900_000);
      const beforeAcceptance = await scanner.runOnce(midway);
      expect(beforeAcceptance.inserted).toBe(0);
      expect(await incidents(pool, organizationId, jobCardId)).toHaveLength(0);

      const atAcceptance = await scanner.runOnce(acceptedAt);
      expect(atAcceptance.inserted).toBe(1);
      const rows = await incidents(pool, organizationId, jobCardId);
      expect((rows[0]!.deadline_at as Date).getTime()).toBe(BOUNDARY.getTime());
      expect((rows[0]!.breached_at as Date).getTime()).toBe(acceptedAt.getTime());
    });
  });

  it('LATE_SUBMISSION: effective deadline is inclusive on time and +1ms is late', async () => {
    await withIntentSchema(databaseUrl, async (pool) => {
      const organizationId = await seedOrganization(pool, 'UTC');
      const staffId = await seedStaff(pool, organizationId);
      // Started inside the window, never submitted: the obligation is real.
      const jobCardId = await seedJob(pool, {
        organizationId, staffId, status: 'IN_PROGRESS', acceptedAt: EARLY,
        startedAt: EARLY, scheduledAt: EARLY, scheduledEndsAt: BOUNDARY,
        revisionCreatedAt: EARLY,
      });
      const scanner = scannerFor(pool);
      const atDeadline = await scanner.runOnce(BOUNDARY);
      expect(atDeadline.inserted).toBe(0);
      expect(await incidents(pool, organizationId, jobCardId)).toHaveLength(0);

      const firstLate = new Date(BOUNDARY.getTime() + 1);
      const late = await scanner.runOnce(firstLate);
      expect(late.inserted).toBe(1);
      const rows = await incidents(pool, organizationId, jobCardId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        delay_type: 'LATE_SUBMISSION',
        episode_no: 1,
        schedule_revision_no: 1,
        source: 'SCANNER',
        accountable_user_id: staffId,
      });
      expect((rows[0]!.deadline_at as Date).getTime()).toBe(firstLate.getTime());
      expect((rows[0]!.breached_at as Date).getTime()).toBe(firstLate.getTime());
    });
  });

  it('LATE_SUBMISSION: the due-date fallback honours the organization timezone', async () => {
    await withIntentSchema(databaseUrl, async (pool) => {
      const istanbulId = await seedOrganization(pool, 'Europe/Istanbul');
      const utcId = await seedOrganization(pool, 'UTC');
      const istanbulStaff = await seedStaff(pool, istanbulId);
      const utcStaff = await seedStaff(pool, utcId);
      const dueDate = '2026-08-03';
      const istanbulJob = await seedJob(pool, {
        organizationId: istanbulId, staffId: istanbulStaff, status: 'IN_PROGRESS',
        acceptedAt: EARLY, startedAt: EARLY, dueDate, revisionCreatedAt: EARLY,
      });
      const utcJob = await seedJob(pool, {
        organizationId: utcId, staffId: utcStaff, status: 'IN_PROGRESS',
        acceptedAt: EARLY, startedAt: EARLY, dueDate, revisionCreatedAt: EARLY,
      });
      // 2026-08-04T00:00 +03:00 == 2026-08-03T21:00:00Z (Istanbul local midnight).
      const istanbulBoundary = new Date('2026-08-03T21:00:00.000Z');
      const scanner = scannerFor(pool);
      const atIstanbulMidnight = await scanner.runOnce(istanbulBoundary);
      expect(atIstanbulMidnight.inserted).toBe(0);
      expect(await incidents(pool, istanbulId, istanbulJob)).toHaveLength(0);
      expect(await incidents(pool, utcId, utcJob)).toHaveLength(0);

      const late = await scanner.runOnce(new Date(istanbulBoundary.getTime() + 1));
      expect(late.inserted).toBe(1);
      const istanbulRows = await incidents(pool, istanbulId, istanbulJob);
      expect(istanbulRows).toHaveLength(1);
      expect((istanbulRows[0]!.deadline_at as Date).getTime())
        .toBe(istanbulBoundary.getTime() + 1);
      // The UTC organization's local midnight is three hours later: not late yet.
      expect(await incidents(pool, utcId, utcJob)).toHaveLength(0);
    });
  });

  it('LATE_SUBMISSION: an unprovable legacy episode activation is never fabricated', async () => {
    await withIntentSchema(databaseUrl, async (pool) => {
      const organizationId = await seedOrganization(pool, 'UTC');
      const staffId = await seedStaff(pool, organizationId);
      const clock = { now: EARLY };
      const service = buildService(pool, clock);
      let job = (await service.create(staffActor(staffId, organizationId), {
        clientActionId: randomUUID(), type: 'GENERAL_TASK', title: 'Legacy düzeltme',
        description: null, customerId: null, contactId: null, assignedTo: staffId,
        priority: 'normal', dueDate: '2026-08-03', scheduledAt: null,
        scheduledEndsAt: null, engagementKind: null,
      } as never)) as unknown as { id: string; version: number };
      job = await service.start(staffActor(staffId, organizationId), job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      }) as unknown as { id: string; version: number };
      job = await service.submitForApproval(staffActor(staffId, organizationId), job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version, note: 'İlk teslim.',
      }) as unknown as { id: string; version: number };
      job = await service.requestRevision(
        managerActor(await insertProofUser(pool, organizationId, 'MANAGER'), organizationId),
        job.id,
        {
          clientActionId: randomUUID(), expectedVersion: job.version,
          revisionReason: 'Düzeltme gerekli.',
        },
      ) as unknown as { id: string; version: number };
      // Legacy state: the re-armed episode has no durable activation row.
      await pool.query(
        'DELETE FROM job_card_submission_episode_activations WHERE job_card_id = $1',
        [job.id],
      );
      const beforeScan = await incidents(pool, organizationId, job.id);
      const report = await scannerFor(pool).runOnce(new Date('2026-08-10T00:00:00.000Z'));
      expect(report.inserted).toBe(0);
      const rows = await incidents(pool, organizationId, job.id);
      // No fabricated episode: the scanner adds no LATE_SUBMISSION row of its
      // own for an episode whose exact activation cannot be proven.
      expect(rows.length).toBe(beforeScan.length);
      expect(rows.filter((row) => row.source === 'SCANNER')).toHaveLength(0);
    });
  });

  it('LATE_SUBMISSION: a reopened legacy episode 1 without activation is never inferred from started_at', async () => {
    await withIntentSchema(databaseUrl, async (pool) => {
      const organizationId = await seedOrganization(pool, 'UTC');
      const staffId = await seedStaff(pool, organizationId);
      const jobCardId = await seedJob(pool, {
        organizationId, staffId, status: 'IN_PROGRESS', acceptedAt: EARLY,
        startedAt: EARLY, scheduledAt: EARLY, scheduledEndsAt: BOUNDARY,
        revisionCreatedAt: EARLY,
      });
      await pool.query(
        `UPDATE job_cards
            SET status = 'REVISION_REQUESTED',
                staff_completed_at = $3, staff_completed_by = $4,
                revision_requested_at = $3, revision_requested_by = $4,
                revision_reason = 'Legacy fixture'
          WHERE organization_id = $1 AND id = $2`,
        [organizationId, jobCardId, EARLY, staffId],
      );
      const report = await scannerFor(pool).runOnce(new Date('2026-08-04T00:00:00.000Z'));
      expect(report.skippedIncompleteEvidence).toBe(1);
      expect(await incidents(pool, organizationId, jobCardId)).toHaveLength(0);
    });
  });

  it('APPROVAL_WAIT: 24h threshold, proven SUBMITTED fact and fact-bound identity', async () => {
    await withIntentSchema(databaseUrl, async (pool) => {
      const organizationId = await seedOrganization(pool, 'UTC');
      const staffId = await seedStaff(pool, organizationId);
      const clock = { now: EARLY };
      const service = buildService(pool, clock);
      const staff = staffActor(staffId, organizationId);
      let job = (await service.create(staff, {
        clientActionId: randomUUID(), type: 'GENERAL_TASK', title: 'Onay bekleyen',
        description: null, customerId: null, contactId: null, assignedTo: staffId,
        priority: 'normal', dueDate: null, scheduledAt: null,
        scheduledEndsAt: null, engagementKind: null,
      } as never)) as unknown as { id: string; version: number };
      job = await service.start(staff, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version,
      }) as unknown as { id: string; version: number };
      job = await service.submitForApproval(staff, job.id, {
        clientActionId: randomUUID(), expectedVersion: job.version, note: 'Teslim edildi.',
      }) as unknown as { id: string; version: number };
      const fact = (await pool.query<{ occurred_at: Date; schedule_revision_no: number; seq_no: number }>(
        `SELECT occurred_at, schedule_revision_no, seq_no FROM job_card_accountability_facts
          WHERE job_card_id = $1 AND fact_type = 'SUBMITTED' ORDER BY seq_no DESC LIMIT 1`,
        [job.id],
      )).rows[0]!;
      expect(await incidents(pool, organizationId, job.id)).toHaveLength(0);
      const scanner = scannerFor(pool);
      const before = await scanner.runOnce(new Date(fact.occurred_at.getTime() + 86_400_000 - 1));
      expect(before.inserted).toBe(0);

      // Equality at submitted_at + 24h is late.
      const at = await scanner.runOnce(new Date(fact.occurred_at.getTime() + 86_400_000));
      expect(at.inserted).toBe(1);
      const rows = await incidents(pool, organizationId, job.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        delay_type: 'APPROVAL_WAIT',
        episode_no: fact.seq_no,
        schedule_revision_no: fact.schedule_revision_no,
        source: 'SCANNER',
        accountable_user_id: null,
        accountable_role: 'MANAGEMENT',
        accountable_source: 'ROLE_POLICY',
      });
      const after = await scanner.runOnce(new Date(fact.occurred_at.getTime() + 172_800_000));
      expect(after.inserted).toBe(0);
      expect(after.candidates).toBe(0);
      expect(await incidents(pool, organizationId, job.id)).toHaveLength(1);
    });
  });

  it('APPROVAL_WAIT: a legacy WAITING_APPROVAL row without a SUBMITTED fact stays unprovable', async () => {
    await withIntentSchema(databaseUrl, async (pool) => {
      const organizationId = await seedOrganization(pool, 'UTC');
      const staffId = await seedStaff(pool, organizationId);
      const jobCardId = await seedJob(pool, {
        organizationId, staffId, status: 'WAITING_APPROVAL', acceptedAt: EARLY,
        startedAt: EARLY, revisionCreatedAt: EARLY,
      });
      // Legacy mutable field present; the immutable fact deliberately absent.
      await pool.query(
        'UPDATE job_cards SET staff_completed_at = $2, staff_completed_by = $3 WHERE id = $1',
        [jobCardId, EARLY, staffId],
      );
      const scanner = scannerFor(pool);
      const report = await scanner.runOnce(new Date('2026-08-10T00:00:00.000Z'));
      expect(report.inserted).toBe(0);
      expect(await incidents(pool, organizationId, jobCardId)).toHaveLength(0);
    });
  });

  it('two concurrent scanners converge on exactly one durable incident', async () => {
    await withIntentSchema(databaseUrl, async (pool) => {
      const organizationId = await seedOrganization(pool, 'UTC');
      const staffId = await seedStaff(pool, organizationId);
      const jobCardId = await seedJob(pool, {
        organizationId, staffId, status: 'ACCEPTED', acceptedAt: EARLY,
        scheduledAt: EARLY, scheduledEndsAt: BOUNDARY, revisionCreatedAt: EARLY,
      });
      const scanTime = new Date(BOUNDARY.getTime() + 60_000);
      const [first, second] = await Promise.all([
        scannerFor(pool).runOnce(scanTime),
        scannerFor(pool).runOnce(scanTime),
      ]);
      expect(first.inserted + second.inserted).toBe(1);
      expect(first.failed + second.failed).toBe(0);
      expect(await incidents(pool, organizationId, jobCardId)).toHaveLength(1);
    });
  });

  it('a lifecycle transition that lands first leaves no stale clock-only incident', async () => {
    await withIntentSchema(databaseUrl, async (pool) => {
      const organizationId = await seedOrganization(pool, 'UTC');
      const staffId = await seedStaff(pool, organizationId);
      const jobCardId = await seedJob(pool, {
        organizationId, staffId, status: 'ACCEPTED', acceptedAt: EARLY,
        scheduledAt: EARLY, scheduledEndsAt: BOUNDARY, revisionCreatedAt: EARLY,
      });
      const clock = { now: new Date(BOUNDARY.getTime() + 600_000) };
      const service = buildService(pool, clock);
      await service.start(staffActor(staffId, organizationId), jobCardId, {
        clientActionId: randomUUID(), expectedVersion: 1,
      });
      const scanner = scannerFor(pool);
      const report = await scanner.runOnce(new Date(BOUNDARY.getTime() + 1_200_000));
      const rows = await incidents(pool, organizationId, jobCardId);
      // The late START is the request path's own history; the scanner must not
      // add a stale ACCEPTED-era LATE_START for a job that already moved on.
      const lateStarts = rows.filter((row) => row.delay_type === 'LATE_START');
      expect(lateStarts).toHaveLength(1);
      expect(lateStarts[0]!.source).toBe('TRANSITION');
      expect(report.inserted).toBe(0);
    });
  });

  it('a scanner incident inserted first is recovered correctly by the later lifecycle action', async () => {
    await withIntentSchema(databaseUrl, async (pool) => {
      const organizationId = await seedOrganization(pool, 'UTC');
      const staffId = await seedStaff(pool, organizationId);
      const jobCardId = await seedJob(pool, {
        organizationId, staffId, status: 'ACCEPTED', acceptedAt: EARLY,
        scheduledAt: EARLY, scheduledEndsAt: BOUNDARY, revisionCreatedAt: EARLY,
      });
      const scanner = scannerFor(pool);
      const insertedAt = new Date(BOUNDARY.getTime() + 60_000);
      const report = await scanner.runOnce(insertedAt);
      expect(report.inserted).toBe(1);
      const open = await incidents(pool, organizationId, jobCardId);
      expect(open).toHaveLength(1);
      expect(open[0]!.recovered_at).toBeNull();

      const clock = { now: insertedAt };
      const service = buildService(pool, clock);
      await service.start(staffActor(staffId, organizationId), jobCardId, {
        clientActionId: randomUUID(), expectedVersion: 1,
      });
      const recovered = await incidents(pool, organizationId, jobCardId);
      expect(recovered).toHaveLength(1);
      expect(recovered[0]!.source).toBe('SCANNER');
      expect(recovered[0]!.recovery_actor_user_id).toBe(staffId);
      // Recovery is a real resolution of a real breach: never before it.
      expect((recovered[0]!.recovered_at as Date).getTime())
        .toBeGreaterThanOrEqual((recovered[0]!.breached_at as Date).getTime());
    });
  });

  it('a pre-deadline request still in flight is never contradicted by the scanner', async () => {
    await withIntentSchema(databaseUrl, async (pool, schema) => {
      void schema;
      const organizationId = await seedOrganization(pool, 'UTC');
      const staffId = await seedStaff(pool, organizationId);
      const customerId = (await pool.query<{ id: string }>(
        `INSERT INTO customers (organization_id, name, customer_type, status)
         VALUES ($1, 'OVR3 Klinik', 'clinic', 'active') RETURNING id`,
        [organizationId],
      )).rows[0]!.id;
      const clock = { now: await readDbClock(pool) };
      let providerEntered = false;
      let releaseProvider: (() => void) | null = null;
      const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
      const geocoder: ReverseGeocoder = {
        reverse: async () => {
          providerEntered = true;
          await providerGate;
          return { neighborhood: 'N', district: 'D', city: 'C', approximateLabel: 'N, D' };
        },
      };
      const service = buildService(pool, clock, geocoder);
      const staff = staffActor(staffId, organizationId);
      const created = (await service.create(staff, {
        clientActionId: randomUUID(), type: 'PRODUCT_DELIVERY', title: 'Yarış işi',
        description: null, customerId, contactId: null, assignedTo: staffId,
        priority: 'normal', dueDate: null,
        scheduledAt: new Date(clock.now.getTime() - 3_600_000).toISOString(),
        scheduledEndsAt: undefined, engagementKind: undefined,
      } as never)) as unknown as { id: string; version: number };
      expect(await incidents(pool, organizationId, created.id)).toHaveLength(0);

      // The planned end must fall inside this test's window, so the boundary
      // passes while the request is still in flight.
      const plannedEnd = new Date(Date.now() + 2_000);
      await pool.query(
        'UPDATE job_cards SET scheduled_ends_at = $2 WHERE id = $1',
        [created.id, plannedEnd],
      );
      await pool.query(
        `UPDATE job_card_schedule_revisions SET scheduled_ends_at = $2
          WHERE job_card_id = $1 AND revision_no = (
            SELECT MAX(revision_no) FROM job_card_schedule_revisions WHERE job_card_id = $1)`,
        [created.id, plannedEnd],
      );

      const started = service.start(staff, created.id, {
        clientActionId: randomUUID(),
        expectedVersion: created.version,
        locationCapture: {
          outcome: 'captured',
          latitude: 39.9,
          longitude: 32.8,
          accuracyMeters: 10,
          capturedAt: new Date().toISOString(),
        },
      });
      try {
        // The reservation is committed and the provider is still blocked, so
        // the request's business time is fixed inside the boundary.
        await waitFor(async () => providerEntered, 5_000, 'provider call entered');
        const reservedAt = (await pool.query<{ reserved_at: Date }>(
          `SELECT reserved_at FROM job_card_lifecycle_intents
            WHERE job_card_id = $1 AND command = 'START'`,
          [created.id],
        )).rows[0]!.reserved_at;
        expect(reservedAt.getTime()).toBeLessThan(plannedEnd.getTime());

        // Let the boundary actually pass before scanning.
        await waitFor(
          async () => (await readDbClock(pool)).getTime() >= plannedEnd.getTime(),
          5_000,
          'deadline passing while START is in flight',
        );
        const scanTime = await readDbClock(pool);
        const report = await scannerFor(pool).runOnce(scanTime);
        expect(report.skippedInFlightRequest).toBe(1);
        expect(report.inserted).toBe(0);
        expect(await incidents(pool, organizationId, created.id)).toHaveLength(0);
      } finally {
        releaseProvider?.();
      }
      const detail = await started as unknown as { status: string };
      expect(detail.status).toBe('IN_PROGRESS');
      // The pre-deadline request completes on its own business time: no breach,
      // and therefore no recovered-before-breached contradiction.
      expect(await incidents(pool, organizationId, created.id)).toHaveLength(0);
    });
  });

  it('a request between the nominal deadline and a later revision breach boundary is still protected', async () => {
    await withIntentSchema(databaseUrl, async (pool) => {
      const organizationId = await seedOrganization(pool, 'UTC');
      const staffId = await seedStaff(pool, organizationId);
      const clock = { now: await readDbClock(pool) };
      const scheduledAt = new Date(clock.now.getTime() - 60_000);
      const nominalDeadline = new Date(clock.now.getTime() - 2_000);
      const revisionEffectiveAt = new Date(clock.now.getTime() + 1_500);
      const jobCardId = await seedJob(pool, {
        organizationId, staffId, status: 'ACCEPTED', acceptedAt: scheduledAt,
        scheduledAt, scheduledEndsAt: nominalDeadline,
        revisionCreatedAt: revisionEffectiveAt,
      });
      let providerEntered = false;
      let releaseProvider: (() => void) | null = null;
      const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
      const geocoder: ReverseGeocoder = {
        reverse: async () => {
          providerEntered = true;
          await providerGate;
          return { neighborhood: 'N', district: 'D', city: 'C', approximateLabel: 'N, D' };
        },
      };
      const service = buildService(pool, clock, geocoder);
      const staff = staffActor(staffId, organizationId);
      const started = service.start(staff, jobCardId, {
        clientActionId: randomUUID(), expectedVersion: 1,
        locationCapture: {
          outcome: 'captured', latitude: 39.9, longitude: 32.8,
          accuracyMeters: 10, capturedAt: new Date().toISOString(),
        },
      });
      try {
        await waitFor(async () => providerEntered, 5_000, 'provider call entered');
        const reservation = (await pool.query<{ reserved_at: Date }>(
          `SELECT reserved_at FROM job_card_lifecycle_intents
             WHERE job_card_id = $1 AND command = 'START'`,
          [jobCardId],
        )).rows[0]!;
        expect(reservation.reserved_at.getTime()).toBeGreaterThanOrEqual(nominalDeadline.getTime());
        expect(reservation.reserved_at.getTime()).toBeLessThan(revisionEffectiveAt.getTime());

        await waitFor(
          async () => (await readDbClock(pool)).getTime() >= revisionEffectiveAt.getTime(),
          5_000,
          'revision-effective breach boundary',
        );
        const report = await scannerFor(pool).runOnce(await readDbClock(pool));
        expect(report.skippedInFlightRequest).toBe(1);
        expect(report.inserted).toBe(0);
        expect(await incidents(pool, organizationId, jobCardId)).toHaveLength(0);
      } finally {
        releaseProvider?.();
      }
      await started;
      expect(await incidents(pool, organizationId, jobCardId)).toHaveLength(0);
    });
  });

  it('reassignment and a later revision never rewrite historical accountability or identity', async () => {
    await withIntentSchema(databaseUrl, async (pool) => {
      const organizationId = await seedOrganization(pool, 'UTC');
      const staffA = await seedStaff(pool, organizationId);
      const staffB = await seedStaff(pool, organizationId);
      const jobCardId = await seedJob(pool, {
        organizationId, staffId: staffA, status: 'ACCEPTED', acceptedAt: EARLY,
        scheduledAt: EARLY, scheduledEndsAt: BOUNDARY, revisionCreatedAt: EARLY,
      });
      const report = await scannerFor(pool).runOnce(new Date(BOUNDARY.getTime() + 60_000));
      expect(report.inserted).toBe(1);
      const before = await incidents(pool, organizationId, jobCardId);
      expect(before[0]).toMatchObject({
        accountable_user_id: staffA, schedule_revision_no: 1, episode_no: 1,
      });

      await pool.query('UPDATE job_cards SET assigned_to = $2 WHERE id = $1', [jobCardId, staffB]);
      await pool.query(
        `INSERT INTO job_card_schedule_revisions
           (organization_id, job_card_id, revision_no, scheduled_at, scheduled_ends_at,
            organization_timezone, source, created_by, created_at)
         VALUES ($1, $2, 2, $3, $4, 'UTC', 'RESCHEDULE', $5, $3)`,
        [
          organizationId, jobCardId,
          new Date(BOUNDARY.getTime() + 300_000),
          new Date(BOUNDARY.getTime() + 600_000),
          staffB,
        ],
      );
      await scannerFor(pool).runOnce(new Date(BOUNDARY.getTime() + 900_000));
      const after = await incidents(pool, organizationId, jobCardId);
      const original = after.find((row) => row.id === before[0]!.id)!;
      expect(original).toMatchObject({
        accountable_user_id: staffA,
        schedule_revision_no: 1,
        episode_no: 1,
      });
      expect((original.breached_at as Date).getTime())
        .toBe((before[0]!.breached_at as Date).getTime());
      // A new governing revision may add its own immutable row, never mutate
      // or re-bind the previous one.
      expect(after.filter((row) => row.schedule_revision_no === 1)).toHaveLength(1);
    });
  });

  it('scanner is organization-scoped, writes no recovery actor and fabricates no user', async () => {
    await withIntentSchema(databaseUrl, async (pool) => {
      const orgA = await seedOrganization(pool, 'UTC');
      const orgB = await seedOrganization(pool, 'UTC');
      const staffA = await seedStaff(pool, orgA);
      const staffB = await seedStaff(pool, orgB);
      const jobA = await seedJob(pool, {
        organizationId: orgA, staffId: staffA, status: 'ACCEPTED', acceptedAt: EARLY,
        scheduledAt: EARLY, scheduledEndsAt: BOUNDARY, revisionCreatedAt: EARLY,
      });
      const jobB = await seedJob(pool, {
        organizationId: orgB, staffId: staffB, status: 'ACCEPTED', acceptedAt: EARLY,
        scheduledAt: EARLY, scheduledEndsAt: BOUNDARY, revisionCreatedAt: EARLY,
      });
      const unassignedJob = await seedJob(pool, {
        organizationId: orgA, staffId: staffA, status: 'WAITING_APPROVAL',
        acceptedAt: EARLY, startedAt: EARLY, revisionCreatedAt: EARLY,
        withAssignmentHistory: false,
      });
      const report = await scannerFor(pool).runOnce(new Date(BOUNDARY.getTime() + 60_000));
      expect(report.inserted).toBe(2);
      const rowsA = await incidents(pool, orgA, jobA);
      const rowsB = await incidents(pool, orgB, jobB);
      expect(rowsA).toHaveLength(1);
      expect(rowsB).toHaveLength(1);
      expect(rowsA[0]!.accountable_user_id).toBe(staffA);
      expect(rowsB[0]!.accountable_user_id).toBe(staffB);
      // The scanner never acts as a user and never resolves recovery.
      const recoveryWrites = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM job_card_overdue_incidents
          WHERE recovery_actor_user_id IS NOT NULL OR recovered_at IS NOT NULL`,
      );
      expect(recoveryWrites.rows[0]!.count).toBe('0');
      // Legacy WAITING_APPROVAL without a proven fact stays untouched.
      expect(await incidents(pool, orgA, unassignedJob)).toHaveLength(0);
      // Accountability is never guessed from the current assignee: the fixture
      // with no assignment history at the breach instant stays UNKNOWN.
      const unknown = await seedJob(pool, {
        organizationId: orgA, staffId: staffA, status: 'ACCEPTED', acceptedAt: EARLY,
        scheduledAt: EARLY, scheduledEndsAt: BOUNDARY, revisionCreatedAt: EARLY,
        withAssignmentHistory: false,
      });
      await scannerFor(pool).runOnce(new Date(BOUNDARY.getTime() + 60_000));
      const unknownRows = await incidents(pool, orgA, unknown);
      expect(unknownRows).toHaveLength(1);
      expect(unknownRows[0]).toMatchObject({
        accountable_user_id: null, accountable_source: 'UNKNOWN',
      });
    });
  });
});

function staffActor(userId: string, organizationId: string): JobCardActor {
  return { id: userId, organizationId, role: 'STAFF' };
}

function managerActor(userId: string, organizationId: string): JobCardActor {
  return { id: userId, organizationId, role: 'MANAGER' };
}
