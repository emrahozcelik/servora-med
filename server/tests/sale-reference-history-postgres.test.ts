import { describe, expect, it } from 'vitest';
import { PostgresProductRepository } from '../src/modules/products/repository.js';
import { PostgresCrmRepository } from '../src/modules/crm/repository.js';
import { withSaleFixture } from './support/sale-harness.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('Sale reference history', () => {
  it('projects sale-only product and contact usage as operation history', async () => {
    await withSaleFixture(async (f) => {
      const contactId = (await f.pool.query("INSERT INTO contacts (organization_id,customer_id,name) VALUES ($1,$2,'Sale-only buyer') RETURNING id", [f.organizationId, f.customerId])).rows[0].id;
      await f.service.createSaleFromVisit(f.staff, f.visitId, { ...f.input, saleContactId: contactId });
      expect(await new PostgresProductRepository(f.pool).productHasDeliveryItems(f.organizationId, f.products[0]!)).toBe(true);
      const crm = new PostgresCrmRepository(f.pool);
      expect(await crm.getContact(f.organizationId, f.customerId, contactId)).toMatchObject({ hasOperationHistory: true });
      expect(await crm.execute((tx) => tx.contactHasAnyJobs(f.organizationId, contactId))).toBe(true);
    });
  });
});
