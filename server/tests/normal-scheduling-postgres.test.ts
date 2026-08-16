import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { PostgresCalendarRepository } from '../src/modules/calendar/repository.js';
import { CalendarService } from '../src/modules/calendar/service.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCardActor } from '../src/modules/job-cards/types.js';
import type { RealtimeEventPublisher } from '../src/modules/realtime/event-bus.js';
import type { RealtimeEventRecord } from '../src/modules/realtime/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

const CLOCK = new Date('2026-08-01T10:00:00.000Z');

async function insertUser(pool: Pool, organizationId: string, role: JobCardActor['role'], name: string) {
  return (await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role, is_active)
     VALUES ($1, $2, $3, 'test-hash', $4, TRUE) RETURNING id`,
    [organizationId, name, `${randomUUID()}@test.local`, role],
  )).rows[0]!.id;
}

function withQueryHold(pool: Pool, queryFragment: string): {
  pool: Pool;
  waitForQuery: () => Promise<void>;
  releaseQuery: () => void;
} {
  let arrived!: () => void;
  const insertArrived = new Promise<void>((resolve) => { arrived = resolve; });
  let release!: () => void;
  const insertReleased = new Promise<void>((resolve) => { release = resolve; });

  function wrapClient(client: any): any {
    const originalQuery = client.query.bind(client);
    client.query = (...qargs: unknown[]) => {
      const text = typeof qargs[0] === 'string'
        ? qargs[0]
        : (qargs[0] as { text?: string } | undefined)?.text;
      if (text?.includes(queryFragment)) {
        return Promise.resolve(originalQuery(...qargs)).then((result) => {
          arrived();
          return insertReleased.then(() => result);
        });
      }
      return originalQuery(...qargs);
    };
    return client;
  }

  const originalConnect = pool.connect.bind(pool);
  pool.connect = (...args: unknown[]) => {
    const last = args[args.length - 1];
    if (typeof last === 'function') {
      const callback = args.pop() as (
        err: Error | null,
        client?: unknown,
        releaseFn?: () => void,
      ) => void;
      originalConnect(...args, (err: Error | null, client?: unknown, releaseFn?: () => void) => {
        if (err) return callback(err);
        callback(null, client ? wrapClient(client) : client, releaseFn);
      });
      return;
    }
    return originalConnect(...args).then((client: unknown) => wrapClient(client));
  };

  return {
    pool,
    waitForQuery: () => insertArrived,
    releaseQuery: release,
  };
}

function withJobCardInsertHold(pool: Pool) {
  return withQueryHold(pool, 'INSERT INTO job_cards');
}

function withCalendarEventInsertHold(pool: Pool) {
  return withQueryHold(pool, 'INSERT INTO calendar_events');
}

function withCalendarEventUpdateHold(pool: Pool) {
  return withQueryHold(pool, 'UPDATE calendar_events SET');
}

function withFollowUpCustomerLockBarrier(pool: Pool): {
  waitForCustomerLock: () => Promise<void>;
  waitForPatchAssigneeLock: () => Promise<void>;
  releaseCustomerLock: () => void;
  followUpAssigneeLockCount: () => number;
} {
  let connectionCount = 0;
  let followUpAssigneeLocks = 0;
  let customerLockArrived!: () => void;
  const customerLockReady = new Promise<void>((resolve) => { customerLockArrived = resolve; });
  let releaseCustomerLock!: () => void;
  const customerLockReleased = new Promise<void>((resolve) => { releaseCustomerLock = resolve; });
  let patchAssigneeLockArrived!: () => void;
  const patchAssigneeLockReady = new Promise<void>((resolve) => { patchAssigneeLockArrived = resolve; });

  function wrapClient(client: any, connectionOrder: number): any {
    const originalQuery = client.query.bind(client);
    client.query = (...qargs: unknown[]) => {
      const text = typeof qargs[0] === 'string'
        ? qargs[0]
        : (qargs[0] as { text?: string } | undefined)?.text;
      if (text?.includes(
        'SELECT id, status FROM customers WHERE organization_id = $1 AND id = $2 FOR UPDATE',
      )) {
        return Promise.resolve(originalQuery(...qargs)).then((result) => {
          customerLockArrived();
          return customerLockReleased.then(() => result);
        });
      }
      if (text?.includes('SELECT id, organization_id, role, is_active FROM users')
        && text.includes('FOR UPDATE')) {
        if (connectionOrder === 1) followUpAssigneeLocks += 1;
        if (connectionOrder !== 2) return originalQuery(...qargs);
        return Promise.resolve(originalQuery(...qargs)).then((result) => {
          patchAssigneeLockArrived();
          return result;
        });
      }
      return originalQuery(...qargs);
    };
    return client;
  }

  const originalConnect = pool.connect.bind(pool);
  pool.connect = (...args: unknown[]) => {
    const last = args[args.length - 1];
    if (typeof last === 'function') {
      const callback = args.pop() as (
        err: Error | null,
        client?: unknown,
        releaseFn?: () => void,
      ) => void;
      originalConnect(...args, (err: Error | null, client?: unknown, releaseFn?: () => void) => {
        if (err) return callback(err);
        connectionCount += 1;
        callback(
          null,
          client ? wrapClient(client, connectionCount) : client,
          releaseFn,
        );
      });
      return;
    }
    connectionCount += 1;
    return originalConnect(...args).then((client: unknown) => wrapClient(client, connectionCount));
  };

  return {
    waitForCustomerLock: () => customerLockReady,
    waitForPatchAssigneeLock: () => patchAssigneeLockReady,
    releaseCustomerLock: () => releaseCustomerLock(),
    followUpAssigneeLockCount: () => followUpAssigneeLocks,
  };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe.skipIf(!databaseUrl)('normal customer scheduling PostgreSQL contract', () => {
  it('NJS-12: concurrent same-Customer/day create serializes; exactly one succeeds', async () => {
    const adminPool = new Pool({ connectionString: databaseUrl });
    const schema = `normal_sched_${randomUUID().replaceAll('-', '')}`;
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

      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone)
         VALUES ('Normal scheduling', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Manager');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Staff');
      const customerId = (await pool.query<{ id: string }>(
        `INSERT INTO customers (organization_id, name, customer_type, status)
         VALUES ($1, 'Dünya Klinik', 'clinic', 'active') RETURNING id`,
        [organizationId],
      )).rows[0]!.id;

      const published: RealtimeEventRecord[] = [];
      const publisher: RealtimeEventPublisher = { publish: (event) => published.push(event) };
      const service = new JobCardService(
        new PostgresJobCardRepository(pool),
        () => CLOCK,
        publisher,
      );
      const manager: JobCardActor = { id: managerId, organizationId, role: 'MANAGER' };
      const meetingInput = {
        clientActionId: randomUUID(),
        type: 'SALES_MEETING' as const,
        title: 'Görüşme',
        description: null,
        customerId,
        contactId: null,
        assignedTo: staffId,
        priority: 'normal' as const,
        dueDate: null,
        scheduledAt: '2026-08-21T10:00:00.000Z',
        scheduledEndsAt: '2026-08-21T11:00:00.000Z',
        engagementKind: 'SALES_MEETING' as const,
      };
      const deliveryInput = {
        clientActionId: randomUUID(),
        type: 'PRODUCT_DELIVERY' as const,
        title: 'Teslim',
        description: null,
        customerId,
        contactId: null,
        assignedTo: staffId,
        priority: 'normal' as const,
        dueDate: null,
        scheduledAt: '2026-08-21T11:00:00.000Z',
        scheduledEndsAt: '2026-08-21T12:00:00.000Z',
      };

      const results = await Promise.allSettled([
        service.create(manager, meetingInput),
        service.create(manager, deliveryInput),
      ]);

      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      const rejected = results.filter((result) => result.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        code: 'CUSTOMER_SCHEDULE_CONFLICT',
        statusCode: 409,
      });

      const count = await pool.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM job_cards
          WHERE organization_id = $1 AND customer_id = $2
            AND status NOT IN ('COMPLETED', 'CANCELLED')`,
        [organizationId, customerId],
      );
      expect(Number(count.rows[0]!.total)).toBe(1);
    } finally {
      await pool?.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });

  it('NJS-13: cross-org customer id does not contribute to evaluation', async () => {
    const adminPool = new Pool({ connectionString: databaseUrl });
    const schema = `normal_sched_xorg_${randomUUID().replaceAll('-', '')}`;
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

      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone)
         VALUES ('Normal scheduling A', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const otherOrganizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone)
         VALUES ('Normal scheduling B', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Manager');
      const otherManagerId = await insertUser(pool, otherOrganizationId, 'MANAGER', 'Other Manager');
      const staffId = await insertUser(pool, organizationId, 'STAFF', 'Staff');
      const otherStaffId = await insertUser(pool, otherOrganizationId, 'STAFF', 'Other Staff');
      const customerId = (await pool.query<{ id: string }>(
        `INSERT INTO customers (organization_id, name, customer_type, status)
         VALUES ($1, 'Dünya Klinik', 'clinic', 'active') RETURNING id`,
        [organizationId],
      )).rows[0]!.id;
      const otherCustomerId = (await pool.query<{ id: string }>(
        `INSERT INTO customers (organization_id, name, customer_type, status)
         VALUES ($1, 'Rakip Klinik', 'clinic', 'active') RETURNING id`,
        [otherOrganizationId],
      )).rows[0]!.id;

      const service = new JobCardService(new PostgresJobCardRepository(pool), () => CLOCK);
      const manager: JobCardActor = { id: managerId, organizationId, role: 'MANAGER' };
      const otherManager: JobCardActor = {
        id: otherManagerId, organizationId: otherOrganizationId, role: 'MANAGER',
      };

      // A same-org preview works; a cross-org customer id must fail closed.
      await expect(service.previewCustomerSchedule(manager, {
        type: 'SALES_MEETING',
        customerId,
        scheduledAt: '2026-08-21T10:00:00.000Z',
      })).resolves.toMatchObject({ level: 'CLEAR' });
      await expect(service.previewCustomerSchedule(manager, {
        type: 'SALES_MEETING',
        customerId: otherCustomerId,
        scheduledAt: '2026-08-21T10:00:00.000Z',
      })).rejects.toMatchObject({ code: 'CUSTOMER_NOT_FOUND', statusCode: 404 });
      void otherManager;
      void staffId;
      void otherStaffId;
    } finally {
      await pool?.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });
});

describe.skipIf(!databaseUrl)('create-time assignee availability parity PostgreSQL contract (AAP)', () => {
  async function setup() {
    const adminPool = new Pool({ connectionString: databaseUrl });
    const schema = `aap_${randomUUID().replaceAll('-', '')}`;
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema},public`,
    });
    await runMigrations({
      migrationsDirectory: MIGRATIONS_DIRECTORY,
      store: new PostgresMigrationStore(pool),
    });

    const organizationId = (await pool.query<{ id: string }>(
      `INSERT INTO organizations (name, timezone)
       VALUES ('AAP parity', 'Europe/Istanbul') RETURNING id`,
    )).rows[0]!.id;
    const managerId = await insertUser(pool, organizationId, 'MANAGER', 'Manager');
    const staffId = await insertUser(pool, organizationId, 'STAFF', 'Staff');
    const customerA = (await pool.query<{ id: string }>(
      `INSERT INTO customers (organization_id, name, customer_type, status)
       VALUES ($1, 'Dünya Klinik', 'clinic', 'active') RETURNING id`,
      [organizationId],
    )).rows[0]!.id;
    const customerB = (await pool.query<{ id: string }>(
      `INSERT INTO customers (organization_id, name, customer_type, status)
       VALUES ($1, 'Yıldız Klinik', 'clinic', 'active') RETURNING id`,
      [organizationId],
    )).rows[0]!.id;

    const published: RealtimeEventRecord[] = [];
    const publisher: RealtimeEventPublisher = { publish: (event) => published.push(event) };
    const jobService = new JobCardService(
      new PostgresJobCardRepository(pool),
      () => CLOCK,
      publisher,
      undefined,
      undefined,
      { enabled: true, reminderLeadMinutes: 30 },
    );
    const calendarService = new CalendarService(
      true,
      new PostgresCalendarRepository(pool, 30, false),
      () => CLOCK,
    );
    const manager: JobCardActor = { id: managerId, organizationId, role: 'MANAGER' };
    return { pool, adminPool, schema, organizationId, staffId, customerA, customerB, jobService, calendarService, manager };
  }

  function meetingInput(clientActionId: string, customerId: string, staffId: string) {
    return {
      clientActionId,
      type: 'SALES_MEETING' as const,
      title: 'Görüşme',
      description: null,
      customerId,
      contactId: null,
      assignedTo: staffId,
      priority: 'normal' as const,
      dueDate: null,
      scheduledAt: '2026-08-21T10:00:00.000Z',
      scheduledEndsAt: '2026-08-21T11:00:00.000Z',
      engagementKind: 'SALES_MEETING' as const,
    };
  }

  function deliveryInput(clientActionId: string, customerId: string, staffId: string) {
    return {
      clientActionId,
      type: 'PRODUCT_DELIVERY' as const,
      title: 'Teslim',
      description: null,
      customerId,
      contactId: null,
      assignedTo: staffId,
      priority: 'normal' as const,
      dueDate: null,
      scheduledAt: '2026-08-21T10:30:00.000Z',
      scheduledEndsAt: '2026-08-21T11:30:00.000Z',
    };
  }

  function manualInput(clientActionId: string, staffId: string, startsAt: string) {
    return {
      clientActionId,
      assignedUserId: staffId,
      title: 'Manuel plan',
      description: null,
      startsAt,
      endsAt: new Date(new Date(startsAt).getTime() + 60 * 60 * 1000).toISOString(),
      timezone: 'Europe/Istanbul',
    } as const;
  }

  it('AAP-12: concurrent same-assignee JobCard creates serialize; exactly one succeeds', async () => {
    const { pool, adminPool, schema, organizationId, staffId, customerA, customerB, jobService, manager } = await setup();
    try {
      const results = await Promise.allSettled([
        jobService.create(manager, meetingInput(randomUUID(), customerA, staffId)),
        jobService.create(manager, deliveryInput(randomUUID(), customerB, staffId)),
      ]);
      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      const rejected = results.filter((result) => result.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        code: 'CALENDAR_CONFLICT',
        statusCode: 409,
      });

      const count = await pool.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM job_cards
          WHERE organization_id = $1 AND assigned_to = $2
            AND status NOT IN ('COMPLETED', 'CANCELLED')`,
        [organizationId, staffId],
      );
      expect(Number(count.rows[0]!.total)).toBe(1);
    } finally {
      await pool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });

  it('AAP-13: concurrent JobCard create vs MANUAL create for same assignee; not both', async () => {
    const { pool, adminPool, schema, organizationId, staffId, customerA, jobService, calendarService, manager } = await setup();
    try {
      const results = await Promise.allSettled([
        jobService.create(manager, meetingInput(randomUUID(), customerA, staffId)),
        calendarService.create(manager, manualInput(randomUUID(), staffId, '2026-08-21T10:30:00.000Z')),
      ]);
      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      const rejected = results.filter((result) => result.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        code: 'CALENDAR_CONFLICT',
        statusCode: 409,
      });

      const jobs = await pool.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM job_cards WHERE organization_id = $1`,
        [organizationId],
      );
      const events = await pool.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM calendar_events WHERE organization_id = $1`,
        [organizationId],
      );
      expect(Number(jobs.rows[0]!.total) + Number(events.rows[0]!.total)).toBe(1);
    } finally {
      await pool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });

  it('AAP-14: concurrent JobCard create vs MANUAL update into the same interval; not both', async () => {
    const { pool, adminPool, schema, organizationId, staffId, customerA, jobService, calendarService, manager } = await setup();
    try {
      // Initial MANUAL event at 09:00-10:00: boundary-touching, no conflict with the 10:00-11:00 job.
      const created = await calendarService.create(manager, manualInput(randomUUID(), staffId, '2026-08-21T09:00:00.000Z'));
      const results = await Promise.allSettled([
        jobService.create(manager, meetingInput(randomUUID(), customerA, staffId)),
        calendarService.patch(manager, created.id, {
          clientActionId: randomUUID(),
          expectedVersion: created.version,
          startsAt: '2026-08-21T10:30:00.000Z',
          endsAt: '2026-08-21T11:30:00.000Z',
        }),
      ]);
      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      const rejected = results.filter((result) => result.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        code: 'CALENDAR_CONFLICT',
        statusCode: 409,
      });

      const jobs = await pool.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM job_cards WHERE organization_id = $1`,
        [organizationId],
      );
      const moved = await pool.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM calendar_events
          WHERE organization_id = $1 AND starts_at = '2026-08-21T10:30:00.000Z'`,
        [organizationId],
      );
      expect(Number(jobs.rows[0]!.total) + Number(moved.rows[0]!.total)).toBe(1);
    } finally {
      await pool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });

  it('P0-C1: schedule-only JobCard patch serializes with competing JobCard create', async () => {
    const { pool, adminPool, schema, organizationId, staffId, customerA, customerB, jobService, manager } = await setup();
    const existing = await jobService.create(manager, {
      ...meetingInput(randomUUID(), customerA, staffId),
      scheduledAt: '2026-08-21T09:00:00.000Z',
      scheduledEndsAt: '2026-08-21T10:00:00.000Z',
    });
    const barrier = withJobCardInsertHold(pool);
    try {
      const create = jobService.create(manager, meetingInput(randomUUID(), customerB, staffId));
      await barrier.waitForQuery();

      const patch = jobService.patch(manager, existing.id, {
        expectedVersion: existing.version,
        scheduledAt: '2026-08-21T10:00:00.000Z',
        scheduledEndsAt: '2026-08-21T11:00:00.000Z',
      });
      await Promise.race([patch.then(() => undefined, () => undefined), wait(500)]);
      barrier.releaseQuery();

      const results = await Promise.allSettled([create, patch]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.filter((result) => result.status === 'rejected');
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        code: 'CALENDAR_CONFLICT',
        statusCode: 409,
      });

      const overlapping = await pool.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM job_cards
          WHERE organization_id = $1 AND assigned_to = $2
            AND scheduled_at < '2026-08-21T11:00:00.000Z'
            AND scheduled_ends_at > '2026-08-21T10:00:00.000Z'
            AND status NOT IN ('COMPLETED', 'CANCELLED')`,
        [organizationId, staffId],
      );
      expect(Number(overlapping.rows[0]!.total)).toBe(1);
    } finally {
      barrier.releaseQuery();
      await pool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });

  it('P0-C2: schedule-only JobCard patch serializes with competing MANUAL create', async () => {
    const {
      pool, adminPool, schema, organizationId, staffId, customerA,
      jobService, calendarService, manager,
    } = await setup();
    const existing = await jobService.create(manager, {
      ...meetingInput(randomUUID(), customerA, staffId),
      scheduledAt: '2026-08-21T09:00:00.000Z',
      scheduledEndsAt: '2026-08-21T10:00:00.000Z',
    });
    const barrier = withCalendarEventInsertHold(pool);
    try {
      const create = calendarService.create(
        manager,
        manualInput(randomUUID(), staffId, '2026-08-21T10:00:00.000Z'),
      );
      await barrier.waitForQuery();

      const patch = jobService.patch(manager, existing.id, {
        expectedVersion: existing.version,
        scheduledAt: '2026-08-21T10:00:00.000Z',
        scheduledEndsAt: '2026-08-21T11:00:00.000Z',
      });
      await Promise.race([patch.then(() => undefined, () => undefined), wait(500)]);
      barrier.releaseQuery();

      const results = await Promise.allSettled([create, patch]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.filter((result) => result.status === 'rejected');
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        code: 'CALENDAR_CONFLICT',
        statusCode: 409,
      });

      const jobs = await pool.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM job_cards
          WHERE organization_id = $1 AND assigned_to = $2
            AND scheduled_at = '2026-08-21T10:00:00.000Z'`,
        [organizationId, staffId],
      );
      const events = await pool.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM calendar_events
          WHERE organization_id = $1 AND assigned_user_id = $2
            AND starts_at = '2026-08-21T10:00:00.000Z'`,
        [organizationId, staffId],
      );
      expect(Number(jobs.rows[0]!.total) + Number(events.rows[0]!.total)).toBe(1);
    } finally {
      barrier.releaseQuery();
      await pool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });

  it('P0-C3: schedule-only JobCard patch serializes with competing MANUAL update', async () => {
    const {
      pool, adminPool, schema, organizationId, staffId, customerA, jobService, calendarService, manager,
    } = await setup();
    const existing = await jobService.create(manager, {
      ...meetingInput(randomUUID(), customerA, staffId),
      scheduledAt: '2026-08-21T09:00:00.000Z',
      scheduledEndsAt: '2026-08-21T10:00:00.000Z',
    });
    const manual = await calendarService.create(
      manager,
      manualInput(randomUUID(), staffId, '2026-08-21T10:00:00.000Z'),
    );
    const barrier = withCalendarEventUpdateHold(pool);
    try {
      const manualUpdate = calendarService.patch(manager, manual.id, {
        clientActionId: randomUUID(),
        expectedVersion: manual.version,
        startsAt: '2026-08-21T11:00:00.000Z',
        endsAt: '2026-08-21T12:00:00.000Z',
      });
      await barrier.waitForQuery();

      const patch = jobService.patch(manager, existing.id, {
        expectedVersion: existing.version,
        scheduledAt: '2026-08-21T11:00:00.000Z',
        scheduledEndsAt: '2026-08-21T12:00:00.000Z',
      });
      await Promise.race([patch.then(() => undefined, () => undefined), wait(500)]);
      barrier.releaseQuery();

      const results = await Promise.allSettled([manualUpdate, patch]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.filter((result) => result.status === 'rejected');
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        code: 'CALENDAR_CONFLICT',
        statusCode: 409,
      });

      const jobs = await pool.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM job_cards
          WHERE organization_id = $1 AND assigned_to = $2
            AND scheduled_at = '2026-08-21T11:00:00.000Z'`,
        [organizationId, staffId],
      );
      const events = await pool.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM calendar_events
          WHERE organization_id = $1 AND assigned_user_id = $2
            AND starts_at = '2026-08-21T11:00:00.000Z'`,
        [organizationId, staffId],
      );
      expect(Number(jobs.rows[0]!.total) + Number(events.rows[0]!.total)).toBe(1);
    } finally {
      barrier.releaseQuery();
      await pool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });

  it('P0-C4: concurrent schedule patch and adjacent JobCard remain legal', async () => {
    const { pool, adminPool, schema, staffId, customerA, customerB, jobService, manager } = await setup();
    const existing = await jobService.create(manager, {
      ...meetingInput(randomUUID(), customerA, staffId),
      scheduledAt: '2026-08-21T09:00:00.000Z',
      scheduledEndsAt: '2026-08-21T10:00:00.000Z',
    });
    const barrier = withJobCardInsertHold(pool);
    try {
      const create = jobService.create(manager, {
        ...meetingInput(randomUUID(), customerB, staffId),
        scheduledAt: '2026-08-21T11:00:00.000Z',
        scheduledEndsAt: '2026-08-21T12:00:00.000Z',
      });
      await barrier.waitForQuery();

      const patch = jobService.patch(manager, existing.id, {
        expectedVersion: existing.version,
        scheduledAt: '2026-08-21T10:00:00.000Z',
        scheduledEndsAt: '2026-08-21T11:00:00.000Z',
      });
      await Promise.race([patch.then(() => undefined, () => undefined), wait(500)]);
      barrier.releaseQuery();

      const results = await Promise.allSettled([create, patch]);
      expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    } finally {
      barrier.releaseQuery();
      await pool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });

  it('R1-C1: schedule patch and post-hoc follow-up serialize without a User-Customer deadlock', async () => {
    const {
      pool, adminPool, schema, organizationId, staffId, customerA, jobService, manager,
    } = await setup();
    const source = (await pool.query<{ id: string }>(
      `INSERT INTO job_cards (
         organization_id, type, status, title, customer_id, assigned_to, created_by,
         started_at, staff_completed_at, staff_completed_by, manager_approved_at, manager_approved_by
       ) VALUES ($1, 'GENERAL_TASK', 'COMPLETED', 'Tamamlanan kaynak', $2, $3, $4,
         '2026-08-20T08:00:00.000Z', '2026-08-20T09:00:00.000Z', $3,
         '2026-08-20T10:00:00.000Z', $4)
       RETURNING id`,
      [organizationId, customerA, staffId, manager.id],
    )).rows[0]!.id;
    const existing = await jobService.create(manager, {
      ...meetingInput(randomUUID(), customerA, staffId),
      scheduledAt: '2026-08-20T11:00:00.000Z',
      scheduledEndsAt: '2026-08-20T12:00:00.000Z',
    });
    const barrier = withFollowUpCustomerLockBarrier(pool);
    try {
      const followUp = jobService.createFollowUp(manager, source, {
        clientActionId: randomUUID(),
        type: 'SALES_MEETING',
        title: 'Takip görüşmesi',
        followUpInstructions: 'Karar tarihini teyit edin.',
        scheduledAt: '2026-08-21T10:00:00.000Z',
        assignedTo: staffId,
        priority: 'normal',
        dueDate: null,
        contactId: null,
        engagementKind: 'FOLLOW_UP',
      });
      await barrier.waitForCustomerLock();

      const patch = jobService.patch(manager, existing.id, {
        expectedVersion: existing.version,
        scheduledAt: '2026-08-21T10:00:00.000Z',
        scheduledEndsAt: '2026-08-21T11:00:00.000Z',
      });

      // On the old Customer->User path, the patch acquires User while the
      // follow-up holds Customer. On the corrected User->Customer path, the
      // follow-up holds User and the patch waits here; both cases are then
      // released through the same deterministic barrier.
      await Promise.race([barrier.waitForPatchAssigneeLock(), wait(750)]);
      barrier.releaseCustomerLock();

      const results = await Promise.race([
        Promise.allSettled([followUp, patch]),
        wait(5000).then(() => {
          throw new Error('R1-C1 transactions did not serialize within 5 seconds.');
        }),
      ]);
      expect(results[0]).toMatchObject({ status: 'fulfilled' });
      expect(results[1]).toMatchObject({
        status: 'rejected',
        reason: { code: 'CUSTOMER_SCHEDULE_CONFLICT', statusCode: 409 },
      });
      expect(barrier.followUpAssigneeLockCount()).toBe(1);

      const targetDay = await pool.query<{ id: string; source_job_card_id: string | null }>(
        `SELECT id, source_job_card_id FROM job_cards
          WHERE organization_id = $1 AND assigned_to = $2
            AND scheduled_at = '2026-08-21T10:00:00.000Z'
            AND status NOT IN ('COMPLETED', 'CANCELLED')`,
        [organizationId, staffId],
      );
      expect(targetDay.rows).toHaveLength(1);
      expect(targetDay.rows[0]!.source_job_card_id).toBe(source);
    } finally {
      barrier.releaseCustomerLock();
      await pool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });

  it('P0-P4: cross-organization calendar conflicts do not affect Staff schedule patch', async () => {
    const { pool, adminPool, schema, organizationId, staffId, customerA, jobService, manager } = await setup();
    try {
      const otherOrganizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone)
         VALUES ('P0 other organization', 'Europe/Istanbul') RETURNING id`,
      )).rows[0]!.id;
      const otherManagerId = await insertUser(pool, otherOrganizationId, 'MANAGER', 'Other Manager');
      const otherStaffId = await insertUser(pool, otherOrganizationId, 'STAFF', 'Other Staff');
      const otherCustomerId = (await pool.query<{ id: string }>(
        `INSERT INTO customers (organization_id, name, customer_type, status)
         VALUES ($1, 'Other Clinic', 'clinic', 'active') RETURNING id`,
        [otherOrganizationId],
      )).rows[0]!.id;

      const ownJob = await jobService.create(manager, meetingInput(randomUUID(), customerA, staffId));
      await jobService.create(
        { id: otherManagerId, organizationId: otherOrganizationId, role: 'MANAGER' },
        {
          ...meetingInput(randomUUID(), otherCustomerId, otherStaffId),
          scheduledAt: '2026-08-21T08:00:00.000Z',
          scheduledEndsAt: '2026-08-21T09:00:00.000Z',
        },
      );
      const otherCalendarService = new CalendarService(
        true,
        new PostgresCalendarRepository(pool, 30, false),
        () => CLOCK,
      );
      await otherCalendarService.create(
        { id: otherManagerId, organizationId: otherOrganizationId, role: 'MANAGER' },
        manualInput(randomUUID(), otherStaffId, '2026-08-21T10:00:00.000Z'),
      );

      await expect(jobService.patch(
        { id: staffId, organizationId, role: 'STAFF' },
        ownJob.id,
        {
          expectedVersion: ownJob.version,
          scheduledAt: '2026-08-21T10:00:00.000Z',
          scheduledEndsAt: '2026-08-21T11:00:00.000Z',
        },
      )).resolves.toMatchObject({
        id: ownJob.id,
        scheduledAt: '2026-08-21T10:00:00.000Z',
        scheduledEndsAt: '2026-08-21T11:00:00.000Z',
      });
    } finally {
      await pool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });

  it('GT-A: legacy General Task intervals are visible as points and do not block SM or MANUAL', async () => {
    const { pool, adminPool, schema, organizationId, staffId, customerA, jobService, calendarService, manager } = await setup();
    try {
      const legacy = (await pool.query<{ id: string }>(
        `INSERT INTO job_cards
          (organization_id, type, status, title, assigned_to, created_by, scheduled_at, scheduled_ends_at)
         VALUES ($1, 'GENERAL_TASK', 'NEW', 'Legacy görev', $2, $3, $4, $5)
         RETURNING id`,
        [organizationId, staffId, manager.id, '2026-08-21T10:00:00.000Z', '2026-08-21T11:00:00.000Z'],
      )).rows[0]!;

      const meeting = await jobService.create(manager, meetingInput(randomUUID(), customerA, staffId));
      expect(meeting.type).toBe('SALES_MEETING');
      await jobService.cancel(manager, meeting.id, {
        clientActionId: randomUUID(),
        expectedVersion: meeting.version,
        cancelReason: 'GT-A availability test cleanup',
      });

      const manual = await calendarService.create(
        manager,
        manualInput(randomUUID(), staffId, '2026-08-21T10:00:00.000Z'),
      );
      expect(manual.source).toBe('MANUAL');

      const listed = await calendarService.list(manager, {
        from: '2026-08-21T00:00:00.000Z',
        to: '2026-08-22T00:00:00.000Z',
        assignedTo: null,
      });
      expect(listed.items.find((item) => item.id === legacy.id)).toMatchObject({
        source: 'JOB',
        jobType: 'GENERAL_TASK',
        endsAt: null,
      });
    } finally {
      await pool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });
});
