import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { CalendarService } from '../src/modules/calendar/service.js';
import { PostgresCalendarRepository } from '../src/modules/calendar/repository.js';
import { manualEventPatchRequestHash } from '../src/modules/calendar/request-hash.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCardActor, NormalizedJobCardCreateInput } from '../src/modules/job-cards/types.js';

/**
 * WORKING-DAY V1 acceptance on real PostgreSQL — HUMAN / MANUAL write paths.
 *
 * Contract under test (§3, §4, §5, §9, §10, §11, §12, §13, §21, §22, §36):
 *
 *   The organization-local Sunday is a SYSTEM / AUTOMATIC scheduling
 *   constraint ONLY. Every write path in this file is an explicit human
 *   choice, so Sunday is ALLOWED: the write succeeds and the chosen instant
 *   is persisted verbatim — never rejected, never silently advanced.
 *
 *   TIMEZONE: the organization timezone (`organizations.timezone`) is the only
 *   authority for deciding whether a local date is Sunday. It is honoured
 *   wherever the rule applies — i.e. on the automatic paths pinned in
 *   `working-day-contract-system-sunday.test.ts`. A client-supplied manual-event
 *   timezone remains display provenance and never gates a write.
 *
 * The automatic half of the contract (never advertise, return or spill into
 * Sunday) is pinned in `working-day-contract-system-sunday.test.ts`; the
 * focused human-side regression probe is
 * `working-day-contract-human-sunday-postgres.test.ts`.
 *
 * Calendar fixtures (org timezone UTC unless stated):
 *   2026-09-12 = Saturday (working day)
 *   2026-09-13 = Sunday   (non-working day for SYSTEM scheduling only)
 *   2026-09-14 = Monday   (working day)
 */

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const fixedNow = new Date('2026-09-10T08:00:00.000Z');

const SAT = '2026-09-12';
const SUN = '2026-09-13';
const MON = '2026-09-14';

async function createSchemaPool(): Promise<{ pool: Pool; cleanup: () => Promise<void> }> {
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  const schema = `wd1_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema},public` });
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
    [organizationId, `WD1 ${randomUUID()}`, timezone],
  );
  const managerRow = await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role)
     VALUES ($1, 'WD1 Manager', $2, 'test-hash', 'MANAGER') RETURNING id`,
    [organizationId, `${randomUUID()}@wd1.test`],
  );
  const staffRow = await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role)
     VALUES ($1, 'WD1 Staff', $2, 'test-hash', 'STAFF') RETURNING id`,
    [organizationId, `${randomUUID()}@wd1.test`],
  );
  await pool.query(
    `INSERT INTO staff_profiles (organization_id, user_id, title) VALUES ($1, $2, 'Field')`,
    [organizationId, staffRow.rows[0]!.id],
  );
  const customerRow = await pool.query<{ id: string }>(
    `INSERT INTO customers (organization_id, name, customer_type, status)
     VALUES ($1, 'WD1 Clinic', 'clinic', 'active') RETURNING id`,
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

function meetingCreate(o: Org, scheduledAt: string, clientActionId = randomUUID()): NormalizedJobCardCreateInput {
  return {
    clientActionId,
    type: 'SALES_MEETING',
    title: 'WD1 Meeting',
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

function taskCreate(o: Org, scheduledAt: string | null, clientActionId = randomUUID()): NormalizedJobCardCreateInput {
  return {
    clientActionId,
    type: 'GENERAL_TASK',
    title: 'WD1 Task',
    description: null,
    customerId: null,
    contactId: null,
    assignedTo: o.staff.id,
    priority: 'normal',
    dueDate: null,
    scheduledAt,
  } as unknown as NormalizedJobCardCreateInput;
}

async function insertLegacySundayMeeting(pool: Pool, o: Org): Promise<string> {
  const row = await pool.query<{ id: string }>(
    `INSERT INTO job_cards
       (organization_id, type, status, title, customer_id, assigned_to, created_by,
        scheduled_at, scheduled_ends_at, engagement_kind)
     VALUES ($1, 'SALES_MEETING', 'NEW', 'Legacy Sunday meeting', $2, $3, $4, $5, $6, 'SALES_MEETING')
     RETURNING id`,
    [
      o.organizationId, o.customerId, o.staff.id, o.manager.id,
      `${SUN}T10:00:00.000Z`, `${SUN}T11:00:00.000Z`,
    ],
  );
  return row.rows[0]!.id;
}

async function insertLegacySundayEvent(pool: Pool, o: Org, timezone = 'Europe/Istanbul'): Promise<string> {
  const row = await pool.query<{ id: string }>(
    `INSERT INTO calendar_events
       (organization_id, assigned_user_id, title, starts_at, ends_at, timezone, created_by, updated_by)
     VALUES ($1, $2, 'Legacy Sunday event', $3, $4, $5, $6, $6)
     RETURNING id`,
    [o.organizationId, o.staff.id, `${SUN}T10:00:00.000Z`, `${SUN}T11:00:00.000Z`, timezone, o.manager.id],
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

describe.skipIf(!databaseUrl)('WORKING-DAY V1 — JobCard create (human)', () => {
  let pool: Pool | null = null;
  let cleanup: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    const fixture = await createSchemaPool();
    pool = fixture.pool;
    cleanup = fixture.cleanup;
  });
  afterAll(async () => { await cleanup?.(); });

  it('allows a Sunday SALES_MEETING (2026-09-13) and persists it verbatim', async () => {
    const o = await setupOrg(pool!);
    const created = await jobCards(pool!).create(o.manager, meetingCreate(o, `${SUN}T10:00:00.000Z`));
    expect(created).toMatchObject({
      scheduledAt: `${SUN}T10:00:00.000Z`,
      scheduledEndsAt: `${SUN}T11:00:00.000Z`,
    });
    await expect(persistedJobSchedule(pool!, created.id)).resolves.toEqual({
      scheduledAt: `${SUN}T10:00:00.000Z`,
      scheduledEndsAt: `${SUN}T11:00:00.000Z`,
    });
  });

  it('allows a Saturday SALES_MEETING whose canonical hour spills into Sunday', async () => {
    const o = await setupOrg(pool!);
    const created = await jobCards(pool!).create(o.manager, meetingCreate(o, `${SAT}T23:30:00.000Z`));
    expect(created).toMatchObject({
      scheduledAt: `${SAT}T23:30:00.000Z`,
      scheduledEndsAt: `${SUN}T00:30:00.000Z`,
    });
  });

  it('allows a Saturday SALES_MEETING ending exactly at Sunday 00:00', async () => {
    const o = await setupOrg(pool!);
    const created = await jobCards(pool!).create(o.manager, meetingCreate(o, `${SAT}T23:00:00.000Z`));
    expect(created).toMatchObject({ scheduledAt: `${SAT}T23:00:00.000Z` });
    expect(created.scheduledEndsAt).toBe(`${SUN}T00:00:00.000Z`);
  });

  it('allows a Sunday GENERAL_TASK point and a Monday point', async () => {
    const o = await setupOrg(pool!);
    const sunday = await jobCards(pool!).create(o.manager, taskCreate(o, `${SUN}T00:00:00.000Z`));
    expect(sunday.scheduledAt).toBe(`${SUN}T00:00:00.000Z`);
    expect(sunday.scheduledEndsAt).toBeNull();

    const monday = await jobCards(pool!).create(o.manager, taskCreate(o, `${MON}T00:00:00.000Z`));
    expect(monday.scheduledAt).toBe(`${MON}T00:00:00.000Z`);
    expect(monday.scheduledEndsAt).toBeNull();
  });

  it('allows an unscheduled GENERAL_TASK (no occupied point at all)', async () => {
    const o = await setupOrg(pool!);
    const created = await jobCards(pool!).create(o.manager, taskCreate(o, null));
    expect(created.scheduledAt).toBeNull();
  });

  it('does not gate human writes on the organization timezone Sunday rule', async () => {
    // 2026-09-12T21:30Z is Sunday 00:30 in Europe/Istanbul (UTC+3) and still
    // Saturday in UTC. A human create must succeed under either organization
    // timezone: the Sunday rule does not apply to this write path.
    const istanbul = await setupOrg(pool!, 'Europe/Istanbul');
    const istanbulCreated = await jobCards(pool!).create(
      istanbul.manager,
      meetingCreate(istanbul, `${SAT}T21:30:00.000Z`),
    );
    expect(istanbulCreated.scheduledAt).toBe(`${SAT}T21:30:00.000Z`);

    const utc = await setupOrg(pool!, 'UTC');
    const utcCreated = await jobCards(pool!).create(utc.manager, meetingCreate(utc, `${SAT}T21:30:00.000Z`));
    expect(utcCreated.scheduledAt).toBe(`${SAT}T21:30:00.000Z`);
  });
});

describe.skipIf(!databaseUrl)('WORKING-DAY V1 — PRODUCT_DELIVERY create (human)', () => {
  let pool: Pool | null = null;
  let cleanup: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    const fixture = await createSchemaPool();
    pool = fixture.pool;
    cleanup = fixture.cleanup;
  });
  afterAll(async () => { await cleanup?.(); });

  async function createDelivery(o: Org, scheduledAt: string) {
    const product = await pool!.query<{ id: string }>(
      `INSERT INTO products (organization_id, sku, name, unit)
       VALUES ($1, $2, 'WD1 Product', 'adet') RETURNING id`,
      [o.organizationId, `WD1-${randomUUID()}`],
    );
    return jobCards(pool!).createProductDelivery(o.manager, {
      clientActionId: randomUUID(),
      type: 'PRODUCT_DELIVERY',
      title: 'WD1 Delivery',
      description: null,
      customerId: o.customerId,
      contactId: null,
      assignedTo: o.staff.id,
      priority: 'normal',
      dueDate: null,
      scheduledAt,
      scheduledEndsAt: new Date(Date.parse(scheduledAt) + 30 * 60 * 1000).toISOString(),
      overrideReason: null,
      deliveryPurpose: 'SALE',
      deliveryNote: null,
      items: [{ productId: product.rows[0]!.id, quantity: 1 }],
    } as never);
  }

  it('allows a Sunday PRODUCT_DELIVERY', async () => {
    const o = await setupOrg(pool!);
    const created = await createDelivery(o, `${SUN}T10:00:00.000Z`);
    await expect(persistedJobSchedule(pool!, created.jobCardId)).resolves.toEqual({
      scheduledAt: `${SUN}T10:00:00.000Z`,
      scheduledEndsAt: `${SUN}T10:30:00.000Z`,
    });
  });

  it('allows a Saturday PRODUCT_DELIVERY ending exactly at Sunday 00:00', async () => {
    const o = await setupOrg(pool!);
    const created = await createDelivery(o, `${SAT}T23:30:00.000Z`);
    const row = await pool!.query<{ scheduled_at: Date; scheduled_ends_at: Date }>(
      `SELECT scheduled_at, scheduled_ends_at FROM job_cards WHERE id = $1`,
      [created.jobCardId],
    );
    expect(row.rows[0]!.scheduled_at.toISOString()).toBe(`${SAT}T23:30:00.000Z`);
    expect(row.rows[0]!.scheduled_ends_at.toISOString()).toBe(`${SUN}T00:00:00.000Z`);
  });

  it('allows a Saturday PRODUCT_DELIVERY spilling 15 minutes into Sunday', async () => {
    const o = await setupOrg(pool!);
    const created = await createDelivery(o, `${SAT}T23:45:00.000Z`);
    await expect(persistedJobSchedule(pool!, created.jobCardId)).resolves.toEqual({
      scheduledAt: `${SAT}T23:45:00.000Z`,
      scheduledEndsAt: `${SUN}T00:15:00.000Z`,
    });
  });
});

describe.skipIf(!databaseUrl)('WORKING-DAY V1 — JobCard patch / reschedule (human)', () => {
  let pool: Pool | null = null;
  let cleanup: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    const fixture = await createSchemaPool();
    pool = fixture.pool;
    cleanup = fixture.cleanup;
  });
  afterAll(async () => { await cleanup?.(); });

  it('allows a startsAt-only reschedule onto Sunday', async () => {
    const o = await setupOrg(pool!);
    const created = await jobCards(pool!).create(o.manager, meetingCreate(o, `${MON}T10:00:00.000Z`));
    const patched = await jobCards(pool!).patch(o.manager, created.id, {
      expectedVersion: await version(pool!, created.id),
      scheduledAt: `${SUN}T10:00:00.000Z`,
    });
    expect(patched.scheduledAt).toBe(`${SUN}T10:00:00.000Z`);
    await expect(persistedJobSchedule(pool!, created.id)).resolves.toEqual({
      scheduledAt: `${SUN}T10:00:00.000Z`,
      scheduledEndsAt: `${SUN}T11:00:00.000Z`,
    });
  });

  it('allows an endsAt-only change that extends a Saturday plan into Sunday', async () => {
    const o = await setupOrg(pool!);
    const created = await jobCards(pool!).create(o.manager, meetingCreate(o, `${SAT}T23:00:00.000Z`));
    const patched = await jobCards(pool!).patch(o.manager, created.id, {
      expectedVersion: await version(pool!, created.id),
      scheduledAt: `${SAT}T23:30:00.000Z`,
      scheduledEndsAt: `${SUN}T00:30:00.000Z`,
    });
    expect(patched.scheduledAt).toBe(`${SAT}T23:30:00.000Z`);
    expect(patched.scheduledEndsAt).toBe(`${SUN}T00:30:00.000Z`);
  });

  it('allows an unrelated edit on a legacy Sunday row (no schedule change)', async () => {
    const o = await setupOrg(pool!);
    const legacyId = await insertLegacySundayMeeting(pool!, o);
    const patched = await jobCards(pool!).patch(o.manager, legacyId, {
      expectedVersion: await version(pool!, legacyId),
      title: 'Legacy Sunday meeting (renamed)',
    });
    expect(patched.title).toBe('Legacy Sunday meeting (renamed)');
    expect(patched.scheduledAt).toBe(`${SUN}T10:00:00.000Z`);
  });

  it('allows a schedule-changing patch on a legacy Sunday row', async () => {
    const o = await setupOrg(pool!);
    const legacyId = await insertLegacySundayMeeting(pool!, o);
    const patched = await jobCards(pool!).patch(o.manager, legacyId, {
      expectedVersion: await version(pool!, legacyId),
      scheduledAt: `${SUN}T12:00:00.000Z`,
    });
    expect(patched.scheduledAt).toBe(`${SUN}T12:00:00.000Z`);
    await expect(persistedJobSchedule(pool!, legacyId)).resolves.toEqual({
      scheduledAt: `${SUN}T12:00:00.000Z`,
      scheduledEndsAt: `${SUN}T13:00:00.000Z`,
    });
  });

  it('allows rescheduling a legacy Sunday row onto a working day', async () => {
    const o = await setupOrg(pool!);
    const legacyId = await insertLegacySundayMeeting(pool!, o);
    const patched = await jobCards(pool!).patch(o.manager, legacyId, {
      expectedVersion: await version(pool!, legacyId),
      scheduledAt: `${MON}T10:00:00.000Z`,
    });
    expect(patched.scheduledAt).toBe(`${MON}T10:00:00.000Z`);
  });

  it('reads a legacy Sunday row without rejection (§36 read regression)', async () => {
    const o = await setupOrg(pool!);
    const legacyId = await insertLegacySundayMeeting(pool!, o);
    const detail = await jobCards(pool!).detail(o.manager, legacyId);
    expect(detail).toMatchObject({
      id: legacyId,
      scheduledAt: `${SUN}T10:00:00.000Z`,
      scheduledEndsAt: `${SUN}T11:00:00.000Z`,
    });
  });
});

describe.skipIf(!databaseUrl)('WORKING-DAY V1 — manual CalendarEvent (human)', () => {
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
      title: 'WD1 manual',
      description: null,
      startsAt,
      endsAt,
      timezone,
    };
  }

  it('allows a Sunday manual event', async () => {
    const o = await setupOrg(pool!);
    const created = await calendar(pool!).create(o.manager, createInput(
      o, `${SUN}T10:00:00.000Z`, `${SUN}T11:00:00.000Z`,
    ));
    expect(created).toMatchObject({
      startsAt: `${SUN}T10:00:00.000Z`,
      endsAt: `${SUN}T11:00:00.000Z`,
    });
  });

  it('allows a Saturday manual event spilling into Sunday', async () => {
    const o = await setupOrg(pool!);
    const created = await calendar(pool!).create(o.manager, createInput(
      o, `${SAT}T23:30:00.000Z`, `${SUN}T00:30:00.000Z`,
    ));
    expect(created).toMatchObject({
      startsAt: `${SAT}T23:30:00.000Z`,
      endsAt: `${SUN}T00:30:00.000Z`,
    });
  });

  it('allows a Saturday manual event ending exactly at Sunday 00:00', async () => {
    const o = await setupOrg(pool!);
    const created = await calendar(pool!).create(o.manager, createInput(
      o, `${SAT}T23:00:00.000Z`, `${SUN}T00:00:00.000Z`,
    ));
    expect(created).toMatchObject({ startsAt: `${SAT}T23:00:00.000Z`, endsAt: `${SUN}T00:00:00.000Z` });
  });

  it('treats a client-supplied event timezone as display provenance only', async () => {
    // The organization timezone (UTC) decides nothing here: a human manual
    // event carries no Sunday constraint at all, and the submitted timezone is
    // stored verbatim as display provenance.
    const o = await setupOrg(pool!, 'UTC');
    const created = await calendar(pool!).create(o.manager, createInput(
      o, `${SUN}T10:00:00.000Z`, `${SUN}T11:00:00.000Z`, 'Pacific/Kiritimati',
    ));
    expect(created).toMatchObject({
      startsAt: `${SUN}T10:00:00.000Z`,
      endsAt: `${SUN}T11:00:00.000Z`,
      timezone: 'Pacific/Kiritimati',
    });
  });

  it('allows a UTC-Sunday instant that is organization-local Monday', async () => {
    const o = await setupOrg(pool!, 'Pacific/Kiritimati');
    const created = await calendar(pool!).create(o.manager, createInput(
      o, `${SUN}T10:00:00.000Z`, `${SUN}T11:00:00.000Z`, 'UTC',
    ));
    expect(created.startsAt).toBe(`${SUN}T10:00:00.000Z`);
  });

  it('allows a startsAt-only patch that moves an event into Sunday', async () => {
    const o = await setupOrg(pool!);
    const created = await calendar(pool!).create(o.manager, createInput(
      o, `${MON}T10:00:00.000Z`, `${MON}T11:00:00.000Z`,
    ));
    const patched = await calendar(pool!).patch(o.manager, created.id, {
      clientActionId: randomUUID(),
      expectedVersion: created.version,
      startsAt: `${SUN}T10:00:00.000Z`,
    });
    expect(patched.startsAt).toBe(`${SUN}T10:00:00.000Z`);
    // Duration survives the human move: the end is delta-shifted, not re-dated.
    expect(patched.endsAt).toBe(`${SUN}T11:00:00.000Z`);
  });

  it('allows an endsAt-only patch that extends an event into Sunday', async () => {
    const o = await setupOrg(pool!);
    const created = await calendar(pool!).create(o.manager, createInput(
      o, `${SAT}T22:00:00.000Z`, `${SAT}T23:00:00.000Z`,
    ));
    const patched = await calendar(pool!).patch(o.manager, created.id, {
      clientActionId: randomUUID(),
      expectedVersion: created.version,
      endsAt: `${SUN}T01:00:00.000Z`,
    });
    expect(patched.startsAt).toBe(`${SAT}T22:00:00.000Z`);
    expect(patched.endsAt).toBe(`${SUN}T01:00:00.000Z`);
  });

  it('allows a both-field patch that moves an event onto Sunday', async () => {
    const o = await setupOrg(pool!);
    const created = await calendar(pool!).create(o.manager, createInput(
      o, `${MON}T10:00:00.000Z`, `${MON}T11:00:00.000Z`,
    ));
    const patched = await calendar(pool!).patch(o.manager, created.id, {
      clientActionId: randomUUID(),
      expectedVersion: created.version,
      startsAt: `${SUN}T09:00:00.000Z`,
      endsAt: `${SUN}T10:00:00.000Z`,
    });
    expect(patched.startsAt).toBe(`${SUN}T09:00:00.000Z`);
    expect(patched.endsAt).toBe(`${SUN}T10:00:00.000Z`);
  });

  it('allows a title-only edit on a legacy Sunday event', async () => {
    const o = await setupOrg(pool!);
    const eventId = await insertLegacySundayEvent(pool!, o);
    const patched = await calendar(pool!).patch(o.manager, eventId, {
      clientActionId: randomUUID(),
      expectedVersion: 1,
      title: 'Legacy Sunday event (renamed)',
    });
    expect(patched.title).toBe('Legacy Sunday event (renamed)');
    expect(patched.startsAt).toBe(`${SUN}T10:00:00.000Z`);
  });

  it('allows a timezone-only edit on a legacy Sunday event (§10)', async () => {
    const o = await setupOrg(pool!);
    const eventId = await insertLegacySundayEvent(pool!, o);
    const patched = await calendar(pool!).patch(o.manager, eventId, {
      clientActionId: randomUUID(),
      expectedVersion: 1,
      timezone: 'Pacific/Kiritimati',
    });
    expect(patched.timezone).toBe('Pacific/Kiritimati');
    expect(patched.startsAt).toBe(`${SUN}T10:00:00.000Z`);
  });

  it('hashes the caller patch, not the duration-derived end (§22)', async () => {
    const o = await setupOrg(pool!);
    const created = await calendar(pool!).create(o.manager, createInput(
      o, `${MON}T10:00:00.000Z`, `${MON}T11:00:00.000Z`,
    ));
    const callerPatch = {
      clientActionId: randomUUID(),
      expectedVersion: created.version,
      startsAt: `${MON}T12:00:00.000Z`,
    };
    const patched = await calendar(pool!).patch(o.manager, created.id, callerPatch);
    // Duration-preserving semantics must survive: a startsAt-only move
    // delta-shifts the persisted end.
    expect(patched.startsAt).toBe(`${MON}T12:00:00.000Z`);
    expect(patched.endsAt).toBe(`${MON}T13:00:00.000Z`);
    // The request identity binds the caller's ORIGINAL patch. Hashing the
    // derived endsAt would change this digest and break legitimate retries.
    const log = await pool!.query<{ request_hash: string }>(
      `SELECT request_hash FROM calendar_event_activity_logs
        WHERE organization_id = $1 AND calendar_event_id = $2 AND action = 'UPDATED'`,
      [o.organizationId, created.id],
    );
    expect(log.rows[0]!.request_hash)
      .toBe(manualEventPatchRequestHash(created.id, callerPatch));
    // A genuine retry of the identical caller patch replays instead of failing.
    const replayed = await calendar(pool!).patch(o.manager, created.id, callerPatch);
    expect(replayed.id).toBe(created.id);
    expect(replayed.version).toBe(patched.version);
  });

  it('reads a legacy Sunday event without rejection (§36 read regression)', async () => {
    const o = await setupOrg(pool!);
    const eventId = await insertLegacySundayEvent(pool!, o);
    const detail = await calendar(pool!).detail(o.manager, eventId);
    expect(detail).toMatchObject({
      id: eventId,
      source: 'MANUAL',
      startsAt: `${SUN}T10:00:00.000Z`,
      endsAt: `${SUN}T11:00:00.000Z`,
    });
    const listed = await calendar(pool!).list(o.manager, {
      from: `${SAT}T00:00:00.000Z`,
      to: `${MON}T00:00:00.000Z`,
      assignedTo: null,
    });
    expect(listed.items.map((item) => item.id)).toContain(eventId);
  });
});
