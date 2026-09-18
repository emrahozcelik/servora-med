import { fileURLToPath } from 'node:url';
import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgresJobCardRepository,
  type CriticalActionClaim,
  type CriticalActionWorkResult,
  type JobCardTransaction,
} from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCardActor, JobCardEngagementKind } from '../src/modules/job-cards/types.js';

// Both distinct action claims reach the transaction callback before either
// attempts the existing User -> Customer locks. No sleep-based race evidence.
class ConcurrentRepository extends PostgresJobCardRepository {
  private arrivals = 0;
  private release!: () => void;
  private readonly barrier = new Promise<void>((resolve) => { this.release = resolve; });
  override executeCriticalAction<T>(claim: CriticalActionClaim,
    work: (tx: JobCardTransaction) => Promise<CriticalActionWorkResult<T>>) {
    return super.executeCriticalAction(claim, async (tx) => {
      this.arrivals += 1;
      if (this.arrivals === 2) this.release();
      await this.barrier;
      return work(tx);
    });
  }
}

describe('customer visit policy PostgreSQL (calendar disabled)', () => {
  const schema = `visit_policy_${randomUUID().replaceAll('-', '')}`;
  const adminPool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL,
    options: `-c search_path=${schema},public` });
  let organizationId: string;
  let staff: JobCardActor;
  let manager: JobCardActor;
  let admin: JobCardActor;
  let otherStaffId: string;
  const service = new JobCardService(new PostgresJobCardRepository(pool),
    () => new Date('2026-09-01T07:00:00Z'), undefined, undefined, undefined, { enabled: false, reminderLeadMinutes: 30 });

  beforeAll(async () => {
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    await runMigrations({ migrationsDirectory: fileURLToPath(new URL('../src/db/migrations', import.meta.url)),
      store: new PostgresMigrationStore(pool) });
    organizationId = (await pool.query<{ id: string }>(
      "INSERT INTO organizations(name) VALUES ('Visit policy disposable') RETURNING id")).rows[0]!.id;
    const user = async (role: JobCardActor['role']) => (await pool.query<{ id: string }>(
      `INSERT INTO users(organization_id,name,email,password_hash,role)
       VALUES($1,'Policy test',$2,'test-hash',$3) RETURNING id`,
      [organizationId, `${randomUUID()}@test.local`, role])).rows[0]!.id;
    staff = { id: await user('STAFF'), organizationId, role: 'STAFF' };
    manager = { id: await user('MANAGER'), organizationId, role: 'MANAGER' };
    otherStaffId = await user('STAFF');
    admin = { id: await user('ADMIN'), organizationId, role: 'ADMIN' };
  });
  afterAll(async () => {
    await pool.end();
    await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);
    await adminPool.end();
  });
  const customer = async () => (await pool.query<{ id: string }>(
    "INSERT INTO customers(organization_id,name,customer_type,status) VALUES($1,'Atlas','clinic','active') RETURNING id",
    [organizationId])).rows[0]!.id;
  const meeting = (customerId: string, scheduledAt = '2026-09-18T07:00:00.000Z',
    engagementKind: JobCardEngagementKind = 'CUSTOMER_VISIT', assignedTo = staff.id) => ({
    clientActionId: randomUUID(), type: 'SALES_MEETING' as const, title: 'Customer visit',
    description: null, customerId, contactId: null, assignedTo, priority: 'normal' as const,
    dueDate: null, scheduledAt, engagementKind,
  });
  const frequent = async (customerId: string) => {
    for (const day of [14, 15, 16]) {
      const job = await service.create(staff, meeting(customerId, `2026-09-${day}T07:00:00.000Z`));
      await pool.query("UPDATE job_cards SET status='COMPLETED', started_at=scheduled_at, staff_completed_at=scheduled_at, staff_completed_by=assigned_to, manager_approved_at=scheduled_at, manager_approved_by=$2 WHERE id=$1", [job.id, manager.id]);
    }
  };

  it('RED-1 allows same customer and staff on the same day at non-overlapping times', async () => {
    const id = await customer();
    await service.create(staff, meeting(id));
    await expect(service.create(staff, meeting(id, '2026-09-18T12:00:00.000Z'))).resolves.toMatchObject({ customerId: id });
  });
  it('RED-2 allows STAFF fourth contact within 14 days', async () => {
    const id = await customer(); await frequent(id);
    await expect(service.create(staff, meeting(id))).resolves.toMatchObject({ customerId: id });
  });
  it.each(['MANAGER', 'ADMIN'] as const)('RED-3 allows %s frequency without overrideReason', async (role) => {
    const id = await customer(); await frequent(id);
    await expect(service.create(role === 'ADMIN' ? admin : manager, meeting(id))).resolves.toMatchObject({ customerId: id });
  });
  it('RED-4 exempts delivery after frequent meetings including same day', async () => {
    const id = await customer(); await frequent(id);
    await expect(service.create(staff, {
      ...meeting(id), type: 'PRODUCT_DELIVERY',
    })).resolves.toMatchObject({ type: 'PRODUCT_DELIVERY' });
  });
  it('RED-5 serializes distinct action IDs and returns domain duplicate, durable count one', async () => {
    const id = await customer();
    const concurrent = new JobCardService(new ConcurrentRepository(pool), () => new Date('2026-09-01T07:00:00Z'));
    const results = await Promise.allSettled([
      concurrent.create(staff, meeting(id)), concurrent.create(staff, meeting(id)),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'CUSTOMER_VISIT_DUPLICATE', statusCode: 409, details: { conflicts: [] } },
    });
    expect((await pool.query('SELECT count(*)::int AS count FROM job_cards WHERE customer_id=$1', [id])).rows[0].count).toBe(1);
  });
  it.each([
    ['adjacent', '2026-09-18T08:00:00.000Z', 'CUSTOMER_VISIT'],
    ['different purpose', '2026-09-18T07:00:00.000Z', 'PRODUCT_DEMO'],
  ] as const)('allows %s intervals', async (_label, at, kind) => {
    const id = await customer(); await service.create(staff, meeting(id));
    await expect(service.create(staff, meeting(id, at, kind))).resolves.toMatchObject({ customerId: id });
  });
  it('allows another Staff at the same time and the same Staff at another Customer', async () => {
    const id = await customer(); await service.create(staff, meeting(id));
    await expect(service.create(manager, meeting(id, undefined, undefined, otherStaffId))).resolves.toMatchObject({ assignedTo: otherStaffId });
    await expect(service.create(staff, meeting(await customer()))).resolves.toMatchObject({ assignedTo: staff.id });
  });
  it('blocks overlapping equivalent intervals and gives management a scoped reference', async () => {
    const id = await customer(); const first = await service.create(staff, meeting(id));
    await expect(service.create(manager, meeting(id, '2026-09-18T07:30:00.000Z'))).rejects.toMatchObject({
      code: 'CUSTOMER_VISIT_DUPLICATE', details: { conflicts: [{ jobCardId: first.id, jobPath: `/jobs/${first.id}` }] },
    });
  });
  it.each(['schedule', 'customer', 'staff', 'purpose'] as const)('rejects a %s edit into a duplicate', async (dimension) => {
    const id = await customer(); const secondCustomer = await customer();
    await service.create(manager, meeting(id));
    const second = await service.create(manager, meeting(
      dimension === 'customer' ? secondCustomer : id,
      dimension === 'schedule' ? '2026-09-18T10:00:00.000Z' : undefined,
      dimension === 'purpose' ? 'PRODUCT_DEMO' : 'CUSTOMER_VISIT',
      dimension === 'staff' ? otherStaffId : staff.id,
    ));
    const edit = dimension === 'schedule' ? { scheduledAt: '2026-09-18T07:30:00.000Z' }
      : dimension === 'customer' ? { customerId: id }
      : dimension === 'staff' ? { assignedTo: staff.id }
      : { engagementKind: 'CUSTOMER_VISIT' as const };
    await expect(service.patch(manager, second.id, { expectedVersion: second.version, ...edit }))
      .rejects.toMatchObject({ code: 'CUSTOMER_VISIT_DUPLICATE' });
    expect((await service.detail(manager, second.id)).version).toBe(second.version);
  });
  it('excludes itself and preserves custom historical interval duration', async () => {
    const id = await customer(); const first = await service.create(manager, meeting(id));
    await expect(service.patch(manager, first.id, { expectedVersion: first.version, scheduledAt: '2026-09-18T07:30:00.000Z' }))
      .resolves.toMatchObject({ scheduledEndsAt: '2026-09-18T08:30:00.000Z' });
    await pool.query("UPDATE job_cards SET scheduled_at='2026-09-17T07:00Z',scheduled_ends_at='2026-09-18T09:00Z' WHERE id=$1", [first.id]);
    await expect(service.create(staff, meeting(id, '2026-09-18T08:30:00.000Z'))).rejects.toMatchObject({ code: 'CUSTOMER_VISIT_DUPLICATE' });
  });
  it.each(['CANCELLED', 'INVALIDATED'] as const)('ignores %s candidates', async (status) => {
    const id = await customer(); const first = await service.create(manager, meeting(id));
    if (status === 'CANCELLED') {
      await pool.query("UPDATE job_cards SET status='CANCELLED',cancelled_at=now(),cancelled_by=$2,cancel_reason='test' WHERE id=$1", [first.id, manager.id]);
    } else {
      await service.invalidate(admin, first.id, { clientActionId: randomUUID(), expectedVersion: first.version,
        reasonCode: 'DUPLICATE', reasonNote: 'Test duplicate invalidation' });
    }
    await expect(service.create(staff, meeting(id))).resolves.toMatchObject({ customerId: id });
  });
  it('completed contact blocks only its own occupied interval', async () => {
    const id = await customer(); await frequent(id);
    await expect(service.create(staff, meeting(id, '2026-09-16T07:00:00.000Z'))).rejects.toMatchObject({ code: 'CUSTOMER_VISIT_DUPLICATE' });
    await expect(service.create(staff, meeting(id, '2026-09-16T08:00:00.000Z'))).resolves.toMatchObject({ customerId: id });
  });
  it.each([
    ['CUSTOMER_VISIT', true], ['PRODUCT_DEMO', true], ['SALES_MEETING', true],
    ['FOLLOW_UP', true], ['TRAINING', false], ['OTHER', false],
  ] as const)('observes %s frequency = %s', async (kind, observed) => {
    const id = await customer();
    for (const hour of ['07', '09', '11']) await service.create(staff, meeting(id, `2026-09-18T${hour}:00:00.000Z`, kind));
    const preview = await service.previewCustomerSchedule(manager, { type: 'SALES_MEETING',
      customerId: id, scheduledAt: '2026-09-18T14:00:00.000Z', engagementKind: 'CUSTOMER_VISIT' });
    expect(preview.level).toBe(observed ? 'WARNING' : 'CLEAR');
    const ownKind = await service.previewCustomerSchedule(manager, { type: 'SALES_MEETING',
      customerId: id, scheduledAt: '2026-09-18T14:00:00.000Z', engagementKind: kind });
    expect(ownKind.level).toBe(observed ? 'WARNING' : 'CLEAR');
  });
  it('exempts delivery in both directions and persists replay-safe system insight', async () => {
    const id = await customer();
    for (const hour of ['07', '09', '11']) await service.create(staff, { ...meeting(id, `2026-09-18T${hour}:00:00.000Z`), type: 'PRODUCT_DELIVERY' });
    const input = meeting(id); const first = await service.create(staff, input);
    await expect(service.create(staff, input)).resolves.toMatchObject({ id: first.id });
    const preview = await service.previewCustomerSchedule(manager, { type: 'SALES_MEETING', customerId: id, scheduledAt: '2026-09-18T14:00:00.000Z' });
    expect(preview.level).toBe('CLEAR');
    const notableId = await customer(); await frequent(notableId);
    const notableInput = meeting(notableId); const notable = await service.create(staff, notableInput);
    await service.create(staff, notableInput);
    const activity = await pool.query("SELECT metadata,actor_id FROM job_card_activity_logs WHERE job_card_id=$1 AND event_type='JOB_CREATED'", [notable.id]);
    expect(activity.rows).toHaveLength(1);
    expect(activity.rows[0].actor_id).toBe(staff.id);
    expect(activity.rows[0].metadata).toEqual({ customerFrequencyAdvisory: { source: 'SYSTEM', windowDays: 14, countIncludingCandidate: 4 } });
    expect((await pool.query('SELECT count(*)::int AS count FROM job_card_notes WHERE job_card_id=$1', [notable.id])).rows[0].count).toBe(0);
    expect(await service.previewCustomerSchedule(staff, { type: 'SALES_MEETING', customerId: notableId, scheduledAt: '2026-09-18T10:00:00.000Z' }))
      .toEqual({ level: 'CLEAR', safeMessage: null, conflicts: [], recentVisit: null, suggestedAlternativeAt: null });
  });
  it.each(['different time', 'delivery and meeting'] as const)('concurrent %s both commit', async (scenario) => {
    const id = await customer(); const concurrent = new JobCardService(new ConcurrentRepository(pool));
    const second = scenario === 'different time' ? meeting(id, '2026-09-18T10:00:00.000Z')
      : { ...meeting(id), type: 'PRODUCT_DELIVERY' as const };
    const results = await Promise.allSettled([concurrent.create(staff, meeting(id)), concurrent.create(staff, second)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect((await pool.query('SELECT count(*)::int AS count FROM job_cards WHERE customer_id=$1', [id])).rows[0].count).toBe(2);
  });
  it('calendar still rejects another Customer for the same Staff when enabled', async () => {
    const enabled = new JobCardService(new PostgresJobCardRepository(pool), () => new Date('2026-09-01'),
      undefined, undefined, undefined, { enabled: true, reminderLeadMinutes: 30 });
    const newStaff = (await pool.query<{ id: string }>("INSERT INTO users(organization_id,name,email,password_hash,role) VALUES($1,'Calendar',$2,'hash','STAFF') RETURNING id", [organizationId, `${randomUUID()}@test.local`])).rows[0]!.id;
    await enabled.create(manager, meeting(await customer(), undefined, undefined, newStaff));
    await expect(enabled.create(manager, meeting(await customer(), undefined, 'PRODUCT_DEMO', newStaff)))
      .rejects.toMatchObject({ code: 'CALENDAR_CONFLICT' });
  });

  describe('legacy NULL-end duplicate enforcement', () => {
    const seedLegacyNullEnd = async (customerId: string, scheduledAt = '2026-09-18T10:00:00.000Z') => {
      const job = await service.create(staff, meeting(customerId, scheduledAt));
      await pool.query(`UPDATE job_cards SET scheduled_ends_at = NULL WHERE id = $1`, [job.id]);
      return job;
    };

    it('blocks an equivalent create against a legacy NULL-end meeting', async () => {
      const id = await customer();
      await seedLegacyNullEnd(id);
      await expect(service.create(staff, meeting(id, '2026-09-18T10:00:00.000Z')))
        .rejects.toMatchObject({ code: 'CUSTOMER_VISIT_DUPLICATE' });
      expect((await pool.query('SELECT count(*)::int AS count FROM job_cards WHERE customer_id=$1', [id])).rows[0].count).toBe(1);
    });

    it('blocks a patch into a legacy NULL-end interval', async () => {
      const id = await customer();
      await seedLegacyNullEnd(id);
      const second = await service.create(manager, meeting(id, '2026-09-18T14:00:00.000Z'));
      await expect(service.patch(manager, second.id, { expectedVersion: second.version, scheduledAt: '2026-09-18T10:00:00.000Z' }))
        .rejects.toMatchObject({ code: 'CUSTOMER_VISIT_DUPLICATE' });
      expect((await service.detail(manager, second.id)).version).toBe(second.version);
    });

    it('still excludes itself when its own end is NULL', async () => {
      const id = await customer();
      const legacy = await seedLegacyNullEnd(id);
      await expect(service.patch(manager, legacy.id, { expectedVersion: legacy.version, scheduledAt: '2026-09-18T10:30:00.000Z' }))
        .resolves.toMatchObject({ id: legacy.id });
    });

    it.each(['CANCELLED', 'INVALIDATED'] as const)('legacy NULL-end %s still does not block', async (status) => {
      const id = await customer();
      const legacy = await seedLegacyNullEnd(id);
      if (status === 'CANCELLED') {
        await pool.query(`UPDATE job_cards SET status='CANCELLED',cancelled_at=now(),cancelled_by=$2,cancel_reason='test' WHERE id=$1`, [legacy.id, manager.id]);
      } else {
        await service.invalidate(admin, legacy.id, { clientActionId: randomUUID(), expectedVersion: legacy.version,
          reasonCode: 'DUPLICATE', reasonNote: 'test' });
      }
      await expect(service.create(staff, meeting(id, '2026-09-18T10:00:00.000Z'))).resolves.toMatchObject({ customerId: id });
    });

    it('allows an adjacent interval next to a legacy NULL-end meeting', async () => {
      const id = await customer();
      await seedLegacyNullEnd(id); // effective 10:00-11:00 via the canonical meeting duration
      await expect(service.create(staff, meeting(id, '2026-09-18T11:00:00.000Z'))).resolves.toMatchObject({ customerId: id });
    });
  });

});
