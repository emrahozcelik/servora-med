import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { PostgresCalendarRepository } from '../src/modules/calendar/repository.js';
import { CalendarService } from '../src/modules/calendar/service.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCardActor, NormalizedJobCardCreateInput } from '../src/modules/job-cards/types.js';

/**
 * WORKING-DAY CONTRACT RECONCILIATION — HUMAN / MANUAL side (RED probe).
 *
 * Authoritative product rule: the organization-local Sunday is a SYSTEM /
 * AUTOMATIC scheduling constraint only. A human being who explicitly chooses a
 * Sunday time is allowed to do so — the write must succeed and the chosen
 * instant must be persisted verbatim, never silently advanced to Monday.
 *
 * PR #283 generalised the Sunday rule to every write path, so on the
 * pre-reconciliation tree every case below fails with NON_WORKING_DAY / 400.
 * That is the regression this file pins: it is RED before the fix and GREEN
 * after, and it asserts ALLOW, not merely "does not throw NON_WORKING_DAY".
 *
 * The SYSTEM / AUTOMATIC half of the contract lives in
 * `working-day-contract-system-sunday.test.ts`, which must stay GREEN
 * throughout: the fix removes enforcement from human paths only.
 *
 * Calendar fixtures (organization timezone UTC):
 *   2026-09-12 = Saturday   2026-09-13 = Sunday   2026-09-14 = Monday
 * Suite clock: 2026-09-10T08:00:00Z (Thursday), so every Sunday fixture is
 * strictly future and can only be refused by the working-day rule.
 */

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const fixedNow = new Date('2026-09-10T08:00:00.000Z');

const SAT = '2026-09-12';
const SUN = '2026-09-13';
const MON = '2026-09-14';

const SUNDAY_START = `${SUN}T10:00:00.000Z`;
const SUNDAY_END = `${SUN}T11:00:00.000Z`;

async function createSchemaPool(): Promise<{ pool: Pool; cleanup: () => Promise<void> }> {
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  const schema = `wdcontract_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 4,
    options: `-c search_path=${schema},public`,
  });
  await runMigrations({ migrationsDirectory, store: new PostgresMigrationStore(pool) });
  const cleanup = async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  };
  return { pool, cleanup };
}

type Org = {
  organizationId: string;
  manager: JobCardActor;
  staff: JobCardActor;
  customerId: string;
};

async function setupOrg(pool: Pool, timezone = 'UTC'): Promise<Org> {
  const organizationId = randomUUID();
  await pool.query(
    `INSERT INTO organizations (id, name, timezone) VALUES ($1, $2, $3)`,
    [organizationId, `WD contract ${randomUUID()}`, timezone],
  );
  const managerRow = await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role)
     VALUES ($1, 'Contract Manager', $2, 'test-hash', 'MANAGER') RETURNING id`,
    [organizationId, `${randomUUID()}@wd-contract.test`],
  );
  const staffRow = await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role)
     VALUES ($1, 'Contract Staff', $2, 'test-hash', 'STAFF') RETURNING id`,
    [organizationId, `${randomUUID()}@wd-contract.test`],
  );
  await pool.query(
    `INSERT INTO staff_profiles (organization_id, user_id, title) VALUES ($1, $2, 'Field')`,
    [organizationId, staffRow.rows[0]!.id],
  );
  const customerRow = await pool.query<{ id: string }>(
    `INSERT INTO customers (organization_id, name, customer_type, status)
     VALUES ($1, 'Contract Clinic', 'clinic', 'active') RETURNING id`,
    [organizationId],
  );
  return {
    organizationId,
    manager: { id: managerRow.rows[0]!.id, organizationId, role: 'MANAGER' },
    staff: { id: staffRow.rows[0]!.id, organizationId, role: 'STAFF' },
    customerId: customerRow.rows[0]!.id,
  };
}

function jobCards(pool: Pool): JobCardService {
  return new JobCardService(new PostgresJobCardRepository(pool), () => fixedNow);
}

function calendar(pool: Pool): CalendarService {
  return new CalendarService(true, new PostgresCalendarRepository(pool, 30, false), () => fixedNow);
}

function meetingCreate(
  o: Org,
  scheduledAt: string,
  clientActionId = randomUUID(),
): NormalizedJobCardCreateInput {
  return {
    clientActionId,
    type: 'SALES_MEETING',
    title: 'Contract meeting',
    description: null,
    customerId: o.customerId,
    contactId: null,
    assignedTo: o.staff.id,
    priority: 'normal',
    dueDate: null,
    scheduledAt,
    engagementKind: 'SALES_MEETING',
    overrideReason: null,
  } as unknown as NormalizedJobCardCreateInput;
}

async function insertCompletedSourceJob(pool: Pool, o: Org): Promise<string> {
  // `job_cards_check1` + `job_cards_started_status_timestamp_check` require the
  // full COMPLETED lifecycle stamp set, so the raw fixture supplies it.
  const row = await pool.query<{ id: string }>(
    `INSERT INTO job_cards
       (organization_id, type, status, title, customer_id, assigned_to, created_by,
        scheduled_at, scheduled_ends_at, engagement_kind,
        started_at, staff_completed_at, staff_completed_by,
        manager_approved_at, manager_approved_by)
     VALUES ($1, 'SALES_MEETING', 'COMPLETED', 'Completed source visit', $2, $3, $4, $5, $6, 'CUSTOMER_VISIT',
             $5, $5, $3, $5, $4)
     RETURNING id`,
    [
      o.organizationId, o.customerId, o.staff.id, o.manager.id,
      `${MON}T08:00:00.000Z`, `${MON}T09:00:00.000Z`,
    ],
  );
  return row.rows[0]!.id;
}

async function version(pool: Pool, jobId: string): Promise<number> {
  const row = await pool.query<{ version: number }>(
    `SELECT version FROM job_cards WHERE id = $1`,
    [jobId],
  );
  return row.rows[0]!.version;
}

async function persistedJobSchedule(pool: Pool, jobId: string) {
  const row = await pool.query<{ scheduled_at: Date | null; scheduled_ends_at: Date | null }>(
    `SELECT scheduled_at, scheduled_ends_at FROM job_cards WHERE id = $1`,
    [jobId],
  );
  return {
    scheduledAt: row.rows[0]!.scheduled_at?.toISOString() ?? null,
    scheduledEndsAt: row.rows[0]!.scheduled_ends_at?.toISOString() ?? null,
  };
}

describe.skipIf(!databaseUrl)('WORKING-DAY contract — HUMAN: JobCard writes may land on Sunday', () => {
  let pool: Pool | null = null;
  let cleanup: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    const fixture = await createSchemaPool();
    pool = fixture.pool;
    cleanup = fixture.cleanup;
  });
  afterAll(async () => { await cleanup?.(); });

  it('1: allows a human JobCard create on Sunday and persists the chosen instant', async () => {
    const o = await setupOrg(pool!);
    const created = await jobCards(pool!).create(o.manager, meetingCreate(o, SUNDAY_START));

    expect(created).toMatchObject({
      scheduledAt: SUNDAY_START,
      scheduledEndsAt: SUNDAY_END,
    });
    // No silent advance to Monday: the human's instant is what is stored.
    await expect(persistedJobSchedule(pool!, created.id)).resolves.toEqual({
      scheduledAt: SUNDAY_START,
      scheduledEndsAt: SUNDAY_END,
    });
  });

  it('1b: allows a human PRODUCT_DELIVERY create on Sunday', async () => {
    const o = await setupOrg(pool!);
    const product = await pool!.query<{ id: string }>(
      `INSERT INTO products (organization_id, sku, name, unit)
       VALUES ($1, $2, 'Contract Product', 'adet') RETURNING id`,
      [o.organizationId, `WD-${randomUUID()}`],
    );
    const created = await jobCards(pool!).createProductDelivery(o.manager, {
      clientActionId: randomUUID(),
      type: 'PRODUCT_DELIVERY',
      title: 'Contract delivery',
      description: null,
      customerId: o.customerId,
      contactId: null,
      assignedTo: o.staff.id,
      priority: 'normal',
      dueDate: null,
      scheduledAt: SUNDAY_START,
      scheduledEndsAt: new Date(Date.parse(SUNDAY_START) + 30 * 60 * 1000).toISOString(),
      overrideReason: null,
      deliveryPurpose: 'SALE',
      deliveryNote: null,
      items: [{ productId: product.rows[0]!.id, quantity: 1 }],
    } as never);

    await expect(persistedJobSchedule(pool!, created.jobCardId)).resolves.toEqual({
      scheduledAt: SUNDAY_START,
      scheduledEndsAt: `${SUN}T10:30:00.000Z`,
    });
  });

  it('2: allows a human JobCard reschedule onto Sunday', async () => {
    const o = await setupOrg(pool!);
    const created = await jobCards(pool!).create(o.manager, meetingCreate(o, `${MON}T10:00:00.000Z`));

    const patched = await jobCards(pool!).patch(o.manager, created.id, {
      expectedVersion: await version(pool!, created.id),
      scheduledAt: SUNDAY_START,
    });

    expect(patched.scheduledAt).toBe(SUNDAY_START);
    await expect(persistedJobSchedule(pool!, created.id)).resolves.toEqual({
      scheduledAt: SUNDAY_START,
      scheduledEndsAt: SUNDAY_END,
    });
  });

  it('2b: allows a human JobCard reschedule from Saturday onto Sunday', async () => {
    const o = await setupOrg(pool!);
    const created = await jobCards(pool!).create(o.manager, meetingCreate(o, `${SAT}T10:00:00.000Z`));

    const patched = await jobCards(pool!).patch(o.manager, created.id, {
      expectedVersion: await version(pool!, created.id),
      scheduledAt: SUNDAY_START,
      scheduledEndsAt: SUNDAY_END,
    });

    expect(patched.scheduledAt).toBe(SUNDAY_START);
    expect(patched.scheduledEndsAt).toBe(SUNDAY_END);
  });

  it('3b: allows a manually created follow-up child on Sunday', async () => {
    const o = await setupOrg(pool!);
    const sourceId = await insertCompletedSourceJob(pool!, o);

    const child = await jobCards(pool!).createFollowUp(o.manager, sourceId, {
      clientActionId: randomUUID(),
      type: 'SALES_MEETING',
      title: 'Sunday follow-up child',
      followUpInstructions: 'Pazar günü takip.',
      scheduledAt: SUNDAY_START,
      assignedTo: o.staff.id,
      priority: 'normal',
      dueDate: null,
      contactId: null,
      // `job_cards_engagement_kind_check` requires a SALES_MEETING row to carry
      // a non-null engagement kind.
      engagementKind: 'FOLLOW_UP',
    });

    expect(child).toMatchObject({
      scheduledAt: SUNDAY_START,
      scheduledEndsAt: SUNDAY_END,
    });
    // The child really is a follow-up of the source: confirm the persisted link
    // rather than relying on the detail projection's shape.
    const link = await pool!.query<{ source_job_card_id: string | null }>(
      `SELECT source_job_card_id FROM job_cards WHERE id = $1`,
      [child.id],
    );
    expect(link.rows[0]!.source_job_card_id).toBe(sourceId);
  });
});

describe.skipIf(!databaseUrl)('WORKING-DAY contract — HUMAN: manual CalendarEvent writes may land on Sunday', () => {
  let pool: Pool | null = null;
  let cleanup: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    const fixture = await createSchemaPool();
    pool = fixture.pool;
    cleanup = fixture.cleanup;
  });
  afterAll(async () => { await cleanup?.(); });

  function createInput(o: Org, startsAt: string, endsAt: string, timezone = 'UTC') {
    return {
      clientActionId: randomUUID(),
      assignedUserId: o.staff.id,
      title: 'Contract manual event',
      description: null,
      startsAt,
      endsAt,
      timezone,
    };
  }

  it('5: allows a manual CalendarEvent create on Sunday', async () => {
    const o = await setupOrg(pool!);
    const created = await calendar(pool!).create(
      o.manager,
      createInput(o, SUNDAY_START, SUNDAY_END),
    );
    expect(created).toMatchObject({ startsAt: SUNDAY_START, endsAt: SUNDAY_END });
  });

  it('6: allows a manual CalendarEvent reschedule onto Sunday', async () => {
    const o = await setupOrg(pool!);
    const created = await calendar(pool!).create(
      o.manager,
      createInput(o, `${MON}T10:00:00.000Z`, `${MON}T11:00:00.000Z`),
    );

    const patched = await calendar(pool!).patch(o.manager, created.id, {
      clientActionId: randomUUID(),
      expectedVersion: created.version,
      startsAt: SUNDAY_START,
    });

    // The human's start is honoured verbatim and the duration survives
    // (delta-shifted end), proving nothing was silently moved to Monday.
    expect(patched.startsAt).toBe(SUNDAY_START);
    expect(patched.endsAt).toBe(SUNDAY_END);
  });
});
