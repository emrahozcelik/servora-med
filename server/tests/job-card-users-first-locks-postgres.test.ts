import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool, type PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import {
  PostgresOverdueBreachScannerRepository,
  createOverdueBreachScanner,
} from '../src/modules/job-cards/overdue-breach-scanner.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCard, JobCardActor } from '../src/modules/job-cards/types.js';
import type { RealtimeEventPublisher } from '../src/modules/realtime/event-bus.js';
import type { RealtimeEventRecord } from '../src/modules/realtime/types.js';

/**
 * Lock-order regressions for the staff-user contract in `assignee-lock.ts`:
 * every writer that touches `users` rows locks them FIRST, before JobCard,
 * Customer or Calendar rows, in one deterministic sorted order.
 *
 * Each test blocks the writer on the later lock and proves the earlier lock is
 * already held — the same shape as
 * `job-card-overdue-submission-reminders-postgres.test.ts` test 23.
 */

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

async function withSchema(run: (pool: Pool) => Promise<void>): Promise<void> {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `usersfirst_${randomUUID().replaceAll('-', '')}`;
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

async function insertOrg(pool: Pool, name: string): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO organizations (name, timezone) VALUES ($1, 'Europe/Istanbul') RETURNING id`,
    [name],
  )).rows[0]!.id;
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

function buildService(pool: Pool, clock: { now: Date }): { service: JobCardService } {
  const published: RealtimeEventRecord[] = [];
  const publisher: RealtimeEventPublisher = { publish: (event) => published.push(event) };
  const service = new JobCardService(
    new PostgresJobCardRepository(pool),
    () => clock.now,
    publisher,
    { enabled: false },
    { enabled: false },
    { enabled: false, reminderLeadMinutes: 30 },
  );
  return { service };
}

function actors(organizationId: string, adminId: string, managerId: string, staffId: string) {
  return {
    admin: { id: adminId, organizationId, role: 'ADMIN' } as JobCardActor,
    manager: { id: managerId, organizationId, role: 'MANAGER' } as JobCardActor,
    staff: { id: staffId, organizationId, role: 'STAFF' } as JobCardActor,
  };
}

async function dbBaseline(pool: Pool): Promise<Date> {
  return (await pool.query<{ now: Date }>(
    "SELECT date_trunc('milliseconds', clock_timestamp()) AS now",
  )).rows[0]!.now;
}

function shiftMs(base: Date, ms: number): Date {
  return new Date(base.getTime() + ms);
}

async function createTask(
  service: JobCardService,
  staff: JobCardActor,
  input: { title: string; dueDate: string | null },
): Promise<JobCard> {
  return (await service.create(staff, {
    clientActionId: randomUUID(),
    type: 'GENERAL_TASK',
    title: input.title,
    description: null,
    customerId: null,
    contactId: null,
    assignedTo: staff.id,
    priority: 'normal',
    dueDate: input.dueDate,
    scheduledAt: null,
    scheduledEndsAt: undefined,
    engagementKind: undefined,
  } as never)) as JobCard;
}

async function startJob(service: JobCardService, staff: JobCardActor, job: JobCard): Promise<JobCard> {
  return service.start(staff, job.id, {
    clientActionId: randomUUID(), expectedVersion: job.version,
  });
}

async function scanOnce(pool: Pool, scanTime: Date) {
  const repository = new PostgresJobCardRepository(pool);
  const scanner = createOverdueBreachScanner(
    new PostgresOverdueBreachScannerRepository(repository), { batchSize: 50 },
  );
  return scanner.runOnce(scanTime);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** Keeps a background command's rejection handled while the test inspects locks. */
function capture<T>(promise: Promise<T>): Promise<Outcome<T>> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

function unwrap<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

/**
 * `FOR NO KEY UPDATE` is the precise probe: it conflicts with the contract's
 * `getAssigneeForUpdate` lock but stays compatible with the `KEY SHARE` that a
 * critical-action foreign key already holds on the actor's users row.
 */
async function usersRowLockedByOther(
  probe: PoolClient,
  organizationId: string,
  userId: string,
): Promise<boolean> {
  await probe.query('BEGIN');
  try {
    await probe.query(
      `SELECT id FROM users WHERE organization_id = $1 AND id = $2 FOR NO KEY UPDATE NOWAIT`,
      [organizationId, userId],
    );
    await probe.query('ROLLBACK');
    return false;
  } catch (error) {
    await probe.query('ROLLBACK');
    if ((error as { code?: string }).code === '55P03') return true;
    throw error;
  }
}

/** Acquires and immediately releases the JobCard row; false means it is held. */
async function jobCardRowFree(
  probe: PoolClient,
  organizationId: string,
  jobCardId: string,
): Promise<boolean> {
  await probe.query('BEGIN');
  try {
    await probe.query(
      `SELECT id FROM job_cards WHERE organization_id = $1 AND id = $2 FOR UPDATE NOWAIT`,
      [organizationId, jobCardId],
    );
    await probe.query('ROLLBACK');
    return true;
  } catch (error) {
    await probe.query('ROLLBACK');
    if ((error as { code?: string }).code === '55P03') return false;
    throw error;
  }
}

async function waitForUsersLock(
  probe: PoolClient,
  organizationId: string,
  userId: string,
  timeoutMs = 10_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await usersRowLockedByOther(probe, organizationId, userId)) return true;
    await sleep(25);
  }
  return false;
}

async function waitForJobCardFree(
  probe: PoolClient,
  organizationId: string,
  jobCardId: string,
  timeoutMs = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await jobCardRowFree(probe, organizationId, jobCardId)) return true;
    await sleep(25);
  }
  return false;
}

/** Rolls back the blocker and releases both helper connections, always. */
async function releaseLocker(
  locker: PoolClient,
  probe: PoolClient,
  blockerOpen: { value: boolean },
): Promise<void> {
  if (blockerOpen.value) {
    try {
      await locker.query('ROLLBACK');
    } catch {
      // the transaction is already gone
    }
    blockerOpen.value = false;
  }
  locker.release();
  probe.release();
}

describe('staff-user lock order (users before JobCard)', () => {
  it('1: sendSubmissionReminder locks the target users row before the JobCard row', { timeout: 30_000 }, async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'Lock Order Org');
      const adminId = await insertUser(pool, organizationId, 'ADMIN', 'Yönetici');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe');
      const { manager, staff } = actors(organizationId, adminId, managerId, staffId);
      const clock = { now: await dbBaseline(pool) };
      const { service } = buildService(pool, clock);
      const dueDate = shiftMs(clock.now, -3 * 24 * 60 * 60_000).toISOString().slice(0, 10);

      const created = await createTask(service, staff, { title: 'Hatırlatma kilidi', dueDate });
      const job = await startJob(service, staff, created);
      await scanOnce(pool, await dbBaseline(pool));

      const locker = await pool.connect();
      const probe = await pool.connect();
      const blockerOpen = { value: false };
      let outcome: Outcome<Awaited<ReturnType<JobCardService['sendSubmissionReminder']>>> | null = null;
      try {
        // Hold only the JobCard row. Users-first means the reminder locks the
        // manager and the target staff row, then waits here.
        await locker.query('BEGIN');
        blockerOpen.value = true;
        await locker.query(
          `SELECT id FROM job_cards WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
          [organizationId, job.id],
        );
        outcome = capture(service.sendSubmissionReminder(manager, job.id, {
          clientActionId: randomUUID(), expectedVersion: job.version,
        }));
        const targetLocked = await waitForUsersLock(probe, organizationId, staffId);
        expect(
          targetLocked,
          'the reminder reached the JobCard lock before locking the target users row',
        ).toBe(true);
        await locker.query('ROLLBACK');
        blockerOpen.value = false;
      } finally {
        await releaseLocker(locker, probe, blockerOpen);
      }
      const reminder = unwrap(await outcome!);
      expect(reminder.jobCardId).toBe(job.id);
      const facts = await pool.query(
        `SELECT 1 FROM job_card_submission_reminders
          WHERE organization_id = $1 AND job_card_id = $2`,
        [organizationId, job.id],
      );
      expect(facts.rowCount).toBe(1);
    });
  });

  it('2: a noted SUBMIT_FOR_APPROVAL waits for the users lock before taking the JobCard lock', { timeout: 30_000 }, async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'Lock Order Org');
      const adminId = await insertUser(pool, organizationId, 'ADMIN', 'Yönetici');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe');
      const { staff } = actors(organizationId, adminId, managerId, staffId);
      const clock = { now: await dbBaseline(pool) };
      const { service } = buildService(pool, clock);

      const created = await createTask(service, staff, {
        title: 'Onaya gönderme kilidi', dueDate: null,
      });
      const job = await startJob(service, staff, created);

      const locker = await pool.connect();
      const probe = await pool.connect();
      const blockerOpen = { value: false };
      let settled = false;
      let outcome: Outcome<Awaited<ReturnType<JobCardService['submitForApproval']>>> | null = null;
      try {
        // FOR SHARE is compatible with the KEY SHARE taken by the lifecycle
        // intent / critical-action foreign keys, so the reservation still runs;
        // it only blocks the users-first NO KEY UPDATE that the finalize phase
        // now takes before the JobCard. The pre-fix order took the JobCard lock
        // first and finished without waiting on a conflicting users lock.
        await locker.query('BEGIN');
        blockerOpen.value = true;
        await locker.query(
          `SELECT id FROM users WHERE organization_id = $1 AND id = $2 FOR SHARE`,
          [organizationId, staffId],
        );
        outcome = capture(service.submitForApproval(staff, job.id, {
          clientActionId: randomUUID(),
          expectedVersion: job.version,
          note: 'Tamamlandı, kontrole gönderildi.',
        }).then((value) => {
          settled = true;
          return value;
        }));
        const settleDeadline = Date.now() + 2_000;
        while (!settled && Date.now() < settleDeadline) await sleep(25);
        expect(
          settled,
          'the noted submit finished without waiting for the note-author users row',
        ).toBe(false);
        // Blocked on the users row, the finalize transaction must hold no
        // JobCard lock at all.
        const jobFree = await waitForJobCardFree(probe, organizationId, job.id);
        expect(
          jobFree,
          'the noted submit held the JobCard lock while waiting for the users row',
        ).toBe(true);
        await locker.query('ROLLBACK');
        blockerOpen.value = false;
      } finally {
        await releaseLocker(locker, probe, blockerOpen);
      }
      expect(unwrap(await outcome!).status).toBe('WAITING_APPROVAL');
    });
  });

  it('3: addNote locks the note-author users row before the JobCard row', { timeout: 30_000 }, async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'Lock Order Org');
      const adminId = await insertUser(pool, organizationId, 'ADMIN', 'Yönetici');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe');
      const { staff } = actors(organizationId, adminId, managerId, staffId);
      const clock = { now: await dbBaseline(pool) };
      const { service } = buildService(pool, clock);

      const job = await createTask(service, staff, { title: 'Not kilidi', dueDate: null });

      const locker = await pool.connect();
      const probe = await pool.connect();
      const blockerOpen = { value: false };
      let outcome: Outcome<Awaited<ReturnType<JobCardService['addNote']>>> | null = null;
      try {
        await locker.query('BEGIN');
        blockerOpen.value = true;
        await locker.query(
          `SELECT id FROM job_cards WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
          [organizationId, job.id],
        );
        outcome = capture(service.addNote(staff, job.id, {
          clientActionId: randomUUID(), note: 'Klinik arandı, dönüş bekleniyor.',
        }));
        const authorLocked = await waitForUsersLock(probe, organizationId, staffId);
        expect(
          authorLocked,
          'addNote reached the JobCard lock before locking the note-author users row',
        ).toBe(true);
        await locker.query('ROLLBACK');
        blockerOpen.value = false;
      } finally {
        await releaseLocker(locker, probe, blockerOpen);
      }
      expect(unwrap(await outcome!).note).toBe('Klinik arandı, dönüş bekleniyor.');
    });
  });

  it('4: invalidate locks the note-author users row before the JobCard row', { timeout: 30_000 }, async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool, 'Lock Order Org');
      const adminId = await insertUser(pool, organizationId, 'ADMIN', 'Yönetici');
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Müdür');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Ayşe');
      const { admin, staff } = actors(organizationId, adminId, managerId, staffId);
      const clock = { now: await dbBaseline(pool) };
      const { service } = buildService(pool, clock);

      const job = await createTask(service, staff, { title: 'Geçersiz kılma kilidi', dueDate: null });

      const locker = await pool.connect();
      const probe = await pool.connect();
      const blockerOpen = { value: false };
      let outcome: Outcome<Awaited<ReturnType<JobCardService['invalidate']>>> | null = null;
      try {
        await locker.query('BEGIN');
        blockerOpen.value = true;
        await locker.query(
          `SELECT id FROM job_cards WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
          [organizationId, job.id],
        );
        outcome = capture(service.invalidate(admin, job.id, {
          clientActionId: randomUUID(),
          expectedVersion: job.version,
          reasonCode: 'OTHER',
          note: 'Yanlış kayıt açıldı, geçersiz kılındı.',
        }));
        const authorLocked = await waitForUsersLock(probe, organizationId, adminId);
        expect(
          authorLocked,
          'invalidate reached the JobCard lock before locking the note-author users row',
        ).toBe(true);
        await locker.query('ROLLBACK');
        blockerOpen.value = false;
      } finally {
        await releaseLocker(locker, probe, blockerOpen);
      }
      expect(unwrap(await outcome!).status).toBe('INVALIDATED');
    });
  });
});
