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
 * WORKING-DAY V1 acceptance on real PostgreSQL.
 *
 * Contract under test (§3, §4, §5, §9, §11, §12, §13, §21, §22, §24, §36):
 *   WORKING_DAY_INTERVAL_RULE = NO_SUNDAY_OVERLAP
 *   Sunday is determined EXCLUSIVELY in the organization timezone.
 *   ERROR_CODE = NON_WORKING_DAY / HTTP_STATUS = 400.
 *
 * Calendar fixtures (org timezone UTC unless stated):
 *   2026-09-12 = Saturday (working day)
 *   2026-09-13 = Sunday   (non-working day)
 *   2026-09-14 = Monday   (working day)
 */

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const fixedNow = new Date('2026-09-10T08:00:00.000Z');

const SAT = '2026-09-12';
const SUN = '2026-09-13';
const MON = '2026-09-14';

const NON_WORKING_DAY_ERROR = {
  code: 'NON_WORKING_DAY',
  statusCode: 400,
  message: 'Pazar günleri planlama yapılamaz. Lütfen Cumartesi veya Pazartesi seçin.',
} as const;

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

describe.skipIf(!databaseUrl)('WORKING-DAY V1 — JobCard create', () => {
  let pool: Pool | null = null;
  let cleanup: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    const fixture = await createSchemaPool();
    pool = fixture.pool;
    cleanup = fixture.cleanup;
  });
  afterAll(async () => { await cleanup?.(); });

  it('rejects a Sunday SALES_MEETING (2026-09-13)', async () => {
    const o = await setupOrg(pool!);
    await expect(jobCards(pool!).create(o.manager, meetingCreate(o, `${SUN}T10:00:00.000Z`)))
      .rejects.toMatchObject(NON_WORKING_DAY_ERROR);
  });

  it('rejects a Saturday SALES_MEETING whose canonical hour spills into Sunday', async () => {
    const o = await setupOrg(pool!);
    await expect(jobCards(pool!).create(o.manager, meetingCreate(o, `${SAT}T23:30:00.000Z`)))
      .rejects.toMatchObject(NON_WORKING_DAY_ERROR);
  });

  it('allows a Saturday SALES_MEETING ending exactly at Sunday 00:00', async () => {
    const o = await setupOrg(pool!);
    const created = await jobCards(pool!).create(o.manager, meetingCreate(o, `${SAT}T23:00:00.000Z`));
    expect(created).toMatchObject({ scheduledAt: `${SAT}T23:00:00.000Z` });
    expect(created.scheduledEndsAt).toBe(`${SUN}T00:00:00.000Z`);
  });

  it('rejects a Sunday GENERAL_TASK point and allows a Monday point', async () => {
    const o = await setupOrg(pool!);
    await expect(jobCards(pool!).create(o.manager, taskCreate(o, `${SUN}T00:00:00.000Z`)))
      .rejects.toMatchObject(NON_WORKING_DAY_ERROR);
    const monday = await jobCards(pool!).create(o.manager, taskCreate(o, `${MON}T00:00:00.000Z`));
    expect(monday.scheduledAt).toBe(`${MON}T00:00:00.000Z`);
    expect(monday.scheduledEndsAt).toBeNull();
  });

  it('allows an unscheduled GENERAL_TASK (no occupied point at all)', async () => {
    const o = await setupOrg(pool!);
    const created = await jobCards(pool!).create(o.manager, taskCreate(o, null));
    expect(created.scheduledAt).toBeNull();
  });

  it('decides Sunday in the ORGANIZATION timezone, not UTC', async () => {
    // 2026-09-12T21:30Z is Sunday 00:30 in Europe/Istanbul (UTC+3).
    const istanbul = await setupOrg(pool!, 'Europe/Istanbul');
    await expect(jobCards(pool!).create(istanbul.manager, meetingCreate(istanbul, `${SAT}T21:30:00.000Z`)))
      .rejects.toMatchObject(NON_WORKING_DAY_ERROR);
    // The same instant is still Saturday in UTC, where it must be allowed.
    const utc = await setupOrg(pool!, 'UTC');
    const allowed = await jobCards(pool!).create(utc.manager, meetingCreate(utc, `${SAT}T21:30:00.000Z`));
    expect(allowed.scheduledAt).toBe(`${SAT}T21:30:00.000Z`);
  });
});

describe.skipIf(!databaseUrl)('WORKING-DAY V1 — PRODUCT_DELIVERY create', () => {
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

  it('rejects a Sunday PRODUCT_DELIVERY', async () => {
    const o = await setupOrg(pool!);
    await expect(createDelivery(o, `${SUN}T10:00:00.000Z`))
      .rejects.toMatchObject(NON_WORKING_DAY_ERROR);
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

  it('rejects a Saturday PRODUCT_DELIVERY spilling 15 minutes into Sunday', async () => {
    const o = await setupOrg(pool!);
    await expect(createDelivery(o, `${SAT}T23:45:00.000Z`))
      .rejects.toMatchObject(NON_WORKING_DAY_ERROR);
  });
});

describe.skipIf(!databaseUrl)('WORKING-DAY V1 — JobCard patch / reschedule', () => {
  let pool: Pool | null = null;
  let cleanup: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    const fixture = await createSchemaPool();
    pool = fixture.pool;
    cleanup = fixture.cleanup;
  });
  afterAll(async () => { await cleanup?.(); });

  it('closes the startsAt-only reschedule bypass into Sunday', async () => {
    const o = await setupOrg(pool!);
    const created = await jobCards(pool!).create(o.manager, meetingCreate(o, `${MON}T10:00:00.000Z`));
    await expect(jobCards(pool!).patch(o.manager, created.id, {
      expectedVersion: await version(pool!, created.id),
      scheduledAt: `${SUN}T10:00:00.000Z`,
    })).rejects.toMatchObject(NON_WORKING_DAY_ERROR);
  });

  it('closes the endsAt-only bypass that extends a Saturday plan into Sunday', async () => {
    const o = await setupOrg(pool!);
    const created = await jobCards(pool!).create(o.manager, meetingCreate(o, `${SAT}T23:00:00.000Z`));
    await expect(jobCards(pool!).patch(o.manager, created.id, {
      expectedVersion: await version(pool!, created.id),
      scheduledAt: `${SAT}T23:30:00.000Z`,
      scheduledEndsAt: `${SUN}T00:30:00.000Z`,
    })).rejects.toMatchObject(NON_WORKING_DAY_ERROR);
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

  it('rejects a schedule-changing patch on a legacy Sunday row', async () => {
    const o = await setupOrg(pool!);
    const legacyId = await insertLegacySundayMeeting(pool!, o);
    await expect(jobCards(pool!).patch(o.manager, legacyId, {
      expectedVersion: await version(pool!, legacyId),
      scheduledAt: `${SUN}T12:00:00.000Z`,
    })).rejects.toMatchObject(NON_WORKING_DAY_ERROR);
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

describe.skipIf(!databaseUrl)('WORKING-DAY V1 — manual CalendarEvent', () => {
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

  it('rejects a Sunday manual event', async () => {
    const o = await setupOrg(pool!);
    await expect(calendar(pool!).create(o.manager, createInput(
      o, `${SUN}T10:00:00.000Z`, `${SUN}T11:00:00.000Z`,
    ))).rejects.toMatchObject(NON_WORKING_DAY_ERROR);
  });

  it('rejects a Saturday manual event spilling into Sunday', async () => {
    const o = await setupOrg(pool!);
    await expect(calendar(pool!).create(o.manager, createInput(
      o, `${SAT}T23:30:00.000Z`, `${SUN}T00:30:00.000Z`,
    ))).rejects.toMatchObject(NON_WORKING_DAY_ERROR);
  });

  it('allows a Saturday manual event ending exactly at Sunday 00:00', async () => {
    const o = await setupOrg(pool!);
    const created = await calendar(pool!).create(o.manager, createInput(
      o, `${SAT}T23:00:00.000Z`, `${SUN}T00:00:00.000Z`,
    ));
    expect(created).toMatchObject({ startsAt: `${SAT}T23:00:00.000Z`, endsAt: `${SUN}T00:00:00.000Z` });
  });

  it('cannot be bypassed by a client-supplied event timezone', async () => {
    const o = await setupOrg(pool!, 'UTC');
    // 2026-09-13T10:00Z is Monday 2026-09-14 00:00 in Pacific/Kiritimati
    // (UTC+14). A timezone-trusting implementation would allow it; the
    // authoritative organization timezone (UTC) makes it Sunday and rejects it.
    await expect(calendar(pool!).create(o.manager, createInput(
      o, `${SUN}T10:00:00.000Z`, `${SUN}T11:00:00.000Z`, 'Pacific/Kiritimati',
    ))).rejects.toMatchObject(NON_WORKING_DAY_ERROR);
  });

  it('allows a UTC-Sunday instant that is organization-local Monday', async () => {
    const o = await setupOrg(pool!, 'Pacific/Kiritimati');
    const created = await calendar(pool!).create(o.manager, createInput(
      o, `${SUN}T10:00:00.000Z`, `${SUN}T11:00:00.000Z`, 'UTC',
    ));
    expect(created.startsAt).toBe(`${SUN}T10:00:00.000Z`);
  });

  it('rejects a startsAt-only patch that moves an event into Sunday', async () => {
    const o = await setupOrg(pool!);
    const created = await calendar(pool!).create(o.manager, createInput(
      o, `${MON}T10:00:00.000Z`, `${MON}T11:00:00.000Z`,
    ));
    await expect(calendar(pool!).patch(o.manager, created.id, {
      clientActionId: randomUUID(),
      expectedVersion: created.version,
      startsAt: `${SUN}T10:00:00.000Z`,
    })).rejects.toMatchObject(NON_WORKING_DAY_ERROR);
  });

  it('rejects an endsAt-only patch that extends an event into Sunday', async () => {
    const o = await setupOrg(pool!);
    const created = await calendar(pool!).create(o.manager, createInput(
      o, `${SAT}T22:00:00.000Z`, `${SAT}T23:00:00.000Z`,
    ));
    await expect(calendar(pool!).patch(o.manager, created.id, {
      clientActionId: randomUUID(),
      expectedVersion: created.version,
      endsAt: `${SUN}T01:00:00.000Z`,
    })).rejects.toMatchObject(NON_WORKING_DAY_ERROR);
  });

  it('rejects a both-field patch that moves an event onto Sunday', async () => {
    const o = await setupOrg(pool!);
    const created = await calendar(pool!).create(o.manager, createInput(
      o, `${MON}T10:00:00.000Z`, `${MON}T11:00:00.000Z`,
    ));
    await expect(calendar(pool!).patch(o.manager, created.id, {
      clientActionId: randomUUID(),
      expectedVersion: created.version,
      startsAt: `${SUN}T09:00:00.000Z`,
      endsAt: `${SUN}T10:00:00.000Z`,
    })).rejects.toMatchObject(NON_WORKING_DAY_ERROR);
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
    // The guard must not disturb duration-preserving semantics: a startsAt-only
    // move delta-shifts the persisted end.
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
