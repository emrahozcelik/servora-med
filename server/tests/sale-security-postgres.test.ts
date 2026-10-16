import { describe, expect, it } from 'vitest';
import { withSaleFixture } from './support/sale-harness.js';
import { ProductService } from '../src/modules/products/service.js';
import { PostgresProductRepository } from '../src/modules/products/repository.js';
import { CrmService } from '../src/modules/crm/service.js';
import { PostgresCrmRepository } from '../src/modules/crm/repository.js';
import Fastify from 'fastify';
import { jobCardRoutes } from '../src/modules/job-cards/routes.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('Sale write boundaries', () => {
  it('requires Sale capability on dedicated writes and rejects generic HTTP SALE creation', async () => {
    await withSaleFixture(async (f) => {
      const app = Fastify();
      try {
        await app.register(jobCardRoutes, { prefix: '/job-cards', service: f.service,
          authenticate: async (request) => { Object.assign(request, { currentUser: f.staff }); } });
        for (const [method, path] of [['POST', `${f.visitId}/sales`], ['PATCH', `${f.visitId}/sale-details`],
          ['POST', `${f.visitId}/sale-items`], ['PATCH', `${f.visitId}/sale-items/${f.products[0]}`],
          ['DELETE', `${f.visitId}/sale-items/${f.products[0]}`]] as const) {
          expect((await app.inject({ method, url: `/job-cards/${path}`, payload: f.input })).statusCode).toBe(404);
        }
        expect((await app.inject({ method: 'POST', url: '/job-cards', payload: { ...f.input, type: 'SALE' } })).statusCode).toBe(400);
      } finally { await app.close(); }
    });
  });
  it('preserves staff catalog/CRM/contact write restrictions', async () => {
    await withSaleFixture(async (f) => {
      await f.service.createSaleFromVisit(f.staff, f.visitId, f.input);
      const products = new ProductService(new PostgresProductRepository(f.pool));
      const crm = new CrmService(new PostgresCrmRepository(f.pool));
      expect(() => products.deactivateProduct(f.staff, f.products[0]!, 1)).toThrowError(expect.objectContaining({ code: 'FORBIDDEN', statusCode: 403 }));
      expect(() => crm.deactivateContact(f.staff, f.customerId, f.metContactId, 1)).toThrowError(expect.objectContaining({ code: 'FORBIDDEN', statusCode: 403 }));
      await expect(crm.updateCustomer(f.staff, f.customerId, { expectedVersion: 1, name: 'Forged' })).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    });
  });
  it('conceals foreign staff/org sources and checks current actor role and activity', async () => {
    await withSaleFixture(async (f) => {
      await expect(f.service.createSaleFromVisit(f.otherStaff, f.visitId, f.input)).rejects.toMatchObject({ code: 'JOB_CARD_NOT_FOUND', statusCode: 404 });
      const org = (await f.pool.query("INSERT INTO organizations(name) VALUES ('Foreign organization') RETURNING id")).rows[0].id;
      const foreign = await f.user('MANAGER', org);
      await expect(f.service.createSaleFromVisit(foreign, f.visitId, f.input)).rejects.toMatchObject({ code: 'JOB_CARD_NOT_FOUND', statusCode: 404 });
      await expect(f.service.createSaleFromVisit({ ...f.staff, role: 'ADMIN' }, f.visitId, f.input)).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
      await f.pool.query('UPDATE users SET is_active=false WHERE id=$1', [f.staff.id]);
      await expect(f.service.createSaleFromVisit(f.staff, f.visitId, f.input)).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
      expect((await f.pool.query("SELECT count(*)::int AS n FROM job_cards WHERE type='SALE'")).rows[0].n).toBe(0);
    });
  });
  it('rejects cross-org product/contact and cross-customer sale contact references atomically', async () => {
    await withSaleFixture(async (f) => {
      const org = (await f.pool.query("INSERT INTO organizations(name) VALUES ('Foreign references') RETURNING id")).rows[0].id;
      const customer = (await f.pool.query("INSERT INTO customers(organization_id,name,customer_type) VALUES ($1,'Foreign clinic','clinic') RETURNING id", [org])).rows[0].id;
      const product = (await f.pool.query("INSERT INTO products(organization_id,name) VALUES ($1,'Foreign product') RETURNING id", [org])).rows[0].id;
      const contact = (await f.pool.query("INSERT INTO contacts(organization_id,customer_id,name) VALUES ($1,$2,'Foreign buyer') RETURNING id", [org, customer])).rows[0].id;
      await expect(f.service.createSaleFromVisit(f.staff, f.visitId, { ...f.input, items: [{ productId: product, quantity: 1 }] })).rejects.toMatchObject({ code: 'PRODUCT_NOT_FOUND' });
      await expect(f.service.createSaleFromVisit(f.staff, f.visitId, { ...f.input, saleContactId: contact })).rejects.toMatchObject({ code: 'CONTACT_NOT_FOUND' });
      const otherCustomer = (await f.pool.query("INSERT INTO customers(organization_id,name,customer_type) VALUES ($1,'Other clinic','clinic') RETURNING id", [f.organizationId])).rows[0].id;
      const otherContact = (await f.pool.query("INSERT INTO contacts(organization_id,customer_id,name) VALUES ($1,$2,'Other buyer') RETURNING id", [f.organizationId, otherCustomer])).rows[0].id;
      await expect(f.service.createSaleFromVisit(f.staff, f.visitId, { ...f.input, saleContactId: otherContact })).rejects.toMatchObject({ code: 'CONTACT_NOT_IN_CUSTOMER' });
      expect((await f.pool.query('SELECT count(*)::int AS n FROM job_card_sale_items')).rows[0].n).toBe(0);
    });
  });
  it('keeps SALE outside manual follow-up source and target creation', async () => {
    await withSaleFixture(async (f) => {
      const sale = await f.service.createSaleFromVisit(f.staff, f.visitId, f.input);
      await f.service.start(f.staff, sale.jobCardId, { clientActionId: 'start-follow-up-source', expectedVersion: 1 });
      await f.service.submitForApproval(f.staff, sale.jobCardId, { clientActionId: 'submit-follow-up-source', expectedVersion: 2, note: 'Agreement recorded' });
      await f.service.approve(f.manager, sale.jobCardId, { clientActionId: 'approve-follow-up-source', expectedVersion: 3 });
      const input = { clientActionId: 'sale-follow-up', type: 'GENERAL_TASK' as const, title: 'Follow-up',
        description: null, assignedTo: f.staff.id, contactId: null, priority: 'normal' as const,
        dueDate: null, scheduledAt: null, scheduledEndsAt: null, engagementKind: null, followUpInstructions: 'Instructions' };
      await expect(f.service.createFollowUp(f.manager, sale.jobCardId, input))
        .rejects.toMatchObject({ code: 'INVALID_JOB_TYPE', statusCode: 400 });
      await expect(f.service.createFollowUp(f.manager, f.visitId, { ...input,
        // @ts-expect-error Deliberately exercise runtime target allowlist.
        type: 'SALE', clientActionId: 'sale-follow-up-target',
      })).rejects.toMatchObject({ code: 'INVALID_JOB_TYPE', statusCode: 400 });
    });
  });
  it('rejects changing the server-owned sale customer through generic patch', async () => {
    await withSaleFixture(async (f) => {
      const sale = await f.service.createSaleFromVisit(f.staff, f.visitId, f.input);
      const customerId = (await f.pool.query("INSERT INTO customers (organization_id,name,customer_type) VALUES ($1,'Other clinic','clinic') RETURNING id", [f.organizationId])).rows[0].id;
      await expect(f.service.patch(f.manager, sale.jobCardId, { expectedVersion: 1, customerId }))
        .rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
      expect((await f.pool.query('SELECT customer_id,version FROM job_cards WHERE id=$1', [sale.jobCardId])).rows[0])
        .toEqual({ customer_id: f.customerId, version: 1 });
    });
  });
  it('rejects SALE through generic creation before attempting any write', async () => {
    await withSaleFixture(async (f) => {
      await expect(f.service.create(f.staff, {
        // @ts-expect-error Deliberately bypass the compile-time public create union.
        type: 'SALE', clientActionId: 'generic-sale', title: 'Forbidden generic sale',
        description: null, customerId: f.customerId, contactId: null, assignedTo: f.staff.id,
        priority: 'normal', dueDate: null, scheduledAt: null, scheduledEndsAt: null,
      })).rejects.toMatchObject({ code: 'INVALID_JOB_TYPE', statusCode: 400 });
      expect((await f.pool.query("SELECT count(*)::int AS count FROM job_cards WHERE type='SALE'")).rows[0].count).toBe(0);
    });
  });
});
