import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { JobCardService } from '../../src/modules/job-cards/service.js';
import { PostgresJobCardRepository } from '../../src/modules/job-cards/repository.js';
import type { JobCardActor } from '../../src/modules/job-cards/types.js';
import { withIntentSchema } from './lifecycle-intent-harness.js';

export const saleTime = new Date('2026-10-14T08:00:00.000Z');

export async function saleFixture(pool: Pool) {
  const organizationId = (await pool.query<{ id: string }>(
    `INSERT INTO organizations (name,timezone) VALUES ('Dental sale fixture','Europe/Istanbul') RETURNING id`,
  )).rows[0]!.id;
  async function user(role: 'STAFF' | 'MANAGER' | 'ADMIN', orgId = organizationId): Promise<JobCardActor> {
    const id = (await pool.query<{ id: string }>(
      `INSERT INTO users (organization_id,name,email,password_hash,role)
       VALUES ($1,$2,$3,'test-hash',$4) RETURNING id`,
      [orgId, `Sale ${role}`, `${randomUUID()}@test.local`, role],
    )).rows[0]!.id;
    return { id, organizationId: orgId, role };
  }
  const staff = await user('STAFF');
  const manager = await user('MANAGER');
  const admin = await user('ADMIN');
  const otherStaff = await user('STAFF');
  await pool.query(`INSERT INTO staff_profiles (organization_id,user_id,manager_user_id)
    VALUES ($1,$2,$3),($1,$4,$3)`, [organizationId, staff.id, manager.id, otherStaff.id]);
  const customerId = (await pool.query<{ id: string }>(
    `INSERT INTO customers (organization_id,name,customer_type,status)
     VALUES ($1,'Dental Klinik','clinic','active') RETURNING id`, [organizationId],
  )).rows[0]!.id;
  async function contact(name: string) {
    return (await pool.query<{ id: string }>(
      `INSERT INTO contacts (organization_id,customer_id,name,title) VALUES ($1,$2,$3,'Dr.') RETURNING id`,
      [organizationId, customerId, name],
    )).rows[0]!.id;
  }
  const plannedContactId = await contact('Planned doctor');
  const metContactId = await contact('Actual doctor');
  const products: string[] = [];
  for (const [name, sku, brand, model, unit] of [
    ['Matrix set', 'SKU-A', 'Brand A', 'Model A', null],
    ['Bonding liquid', 'SKU-B', null, 'Model B', 'ml'],
  ]) {
    products.push((await pool.query<{ id: string }>(
      `INSERT INTO products (organization_id,name,sku,brand,model,unit)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [organizationId, name, sku, brand, model, unit],
    )).rows[0]!.id);
  }
  const repository = new PostgresJobCardRepository(pool);
  const service = new JobCardService(repository, () => saleTime);
  const created = await service.create(staff, {
    clientActionId: 'fixture-visit-create', type: 'SALES_MEETING', title: 'Clinic visit',
    description: null, customerId, contactId: plannedContactId, assignedTo: staff.id,
    priority: 'normal', dueDate: null, scheduledAt: '2026-10-14T07:00:00.000Z',
    scheduledEndsAt: '2026-10-14T08:00:00.000Z', engagementKind: 'CUSTOMER_VISIT',
  });
  const started = await service.start(staff, created.id, {
    clientActionId: 'fixture-visit-start', expectedVersion: 1,
  });
  const met = await service.patchMeetingDetails(staff, created.id, {
    clientActionId: 'fixture-met-contact', expectedVersion: started.version, metContactId,
  });
  const input = {
    clientActionId: 'fixture-sale-create', expectedSourceVersion: met.jobCardVersion,
    title: 'Product agreement', soldAt: saleTime.toISOString(), saleContactId: metContactId,
    items: [{ productId: products[0]!, quantity: 1 }, { productId: products[1]!, quantity: 15 }],
  };
  return { pool, repository, service, staff, manager, admin, otherStaff, organizationId,
    customerId, plannedContactId, metContactId, products, visitId: created.id, input, user };
}

export async function withSaleFixture(run: (fixture: Awaited<ReturnType<typeof saleFixture>>) => Promise<void>) {
  await withIntentSchema(process.env.TEST_DATABASE_URL, async (pool) => run(await saleFixture(pool)));
}
