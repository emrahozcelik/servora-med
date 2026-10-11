import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import Fastify, { type FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { toErrorResponse } from '../src/errors/index.js';
import { crmRoutes } from '../src/modules/crm/routes.js';
import { PostgresCrmRepository } from '../src/modules/crm/repository.js';
import { CrmService } from '../src/modules/crm/service.js';
import type { CrmActor, MissingInfoCode } from '../src/modules/crm/types.js';

const url = process.env.TEST_DATABASE_URL;
const schema = `crm_completeness_${randomUUID().replaceAll('-', '')}`;
const adminPool = url ? new Pool({ connectionString: url }) : null;
const pool = url
  ? new Pool({ connectionString: url, options: `-c search_path=${schema},public` })
  : null;

beforeAll(async () => {
  if (!pool || !adminPool) return;
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  await runMigrations({
    migrationsDirectory: fileURLToPath(new URL('../src/db/migrations', import.meta.url)),
    store: new PostgresMigrationStore(pool),
  });
});

afterAll(async () => {
  await pool?.end();
  if (adminPool) {
    await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);
    await adminPool.end();
  }
});

const repository = pool ? new PostgresCrmRepository(pool) : null;
const service = repository ? new CrmService(repository) : null;

async function isolatedCustomer(phone: string | null) {
  const organizationId = randomUUID();
  await pool!.query(
    `INSERT INTO organizations (id, name, timezone) VALUES ($1, 'Completeness org', 'Europe/Istanbul')`,
    [organizationId],
  );
  const customerId = (await pool!.query<{ id: string }>(
    `INSERT INTO customers (organization_id, name, customer_type, status, phone)
     VALUES ($1, 'Klinik', 'clinic', 'active', $2) RETURNING id`,
    [organizationId, phone],
  )).rows[0]!.id;
  return { organizationId, customerId };
}

async function addContact(
  organizationId: string,
  customerId: string,
  input: { phone: string | null; isActive: boolean; isPrimary: boolean },
) {
  await pool!.query(
    `INSERT INTO contacts (organization_id, customer_id, name, phone, is_active, is_primary)
     VALUES ($1, $2, 'İlgili kişi', $3, $4, $5)`,
    [organizationId, customerId, input.phone, input.isActive, input.isPrimary],
  );
}

function actor(organizationId: string): CrmActor {
  return { id: randomUUID(), organizationId, role: 'STAFF' };
}

async function missing(organizationId: string, customerId: string): Promise<MissingInfoCode[]> {
  return (await service!.getCustomerCompleteness(actor(organizationId), customerId)).missingInfo;
}

describe.skipIf(!url)('Slice 3 customer completeness projection', () => {
  it('returns no codes when the customer phone and at least one active contact phone are usable', async () => {
    const { organizationId, customerId } = await isolatedCustomer('+905321112233');
    await addContact(organizationId, customerId, { phone: '(0212) 444 55 66', isActive: true, isPrimary: true });
    expect(await missing(organizationId, customerId)).toEqual([]);
  });

  it('flags CUSTOMER_PHONE_MISSING for null, blank and unusable historical text', async () => {
    const nullPhone = await isolatedCustomer(null);
    await addContact(nullPhone.organizationId, nullPhone.customerId, {
      phone: '+905321112233', isActive: true, isPrimary: true,
    });
    expect(await missing(nullPhone.organizationId, nullPhone.customerId))
      .toEqual(['CUSTOMER_PHONE_MISSING']);

    const blankPhone = await isolatedCustomer('   ');
    await addContact(blankPhone.organizationId, blankPhone.customerId, {
      phone: '+905321112233', isActive: true, isPrimary: true,
    });
    expect(await missing(blankPhone.organizationId, blankPhone.customerId))
      .toEqual(['CUSTOMER_PHONE_MISSING']);

    const textPhone = await isolatedCustomer('santral bilinmiyor');
    await addContact(textPhone.organizationId, textPhone.customerId, {
      phone: '+905321112233', isActive: true, isPrimary: true,
    });
    expect(await missing(textPhone.organizationId, textPhone.customerId))
      .toEqual(['CUSTOMER_PHONE_MISSING']);
  });

  it('treats canonical and legacy Turkish formats as present', async () => {
    for (const phone of ['0532 111 22 33', '0232-444-55-66', '+90 532 111 22 33']) {
      const fixture = await isolatedCustomer(phone);
      await addContact(fixture.organizationId, fixture.customerId, {
        phone: '+905321112233', isActive: true, isPrimary: true,
      });
      expect(await missing(fixture.organizationId, fixture.customerId)).toEqual([]);
    }
  });

  it('flags CONTACT_PHONE_MISSING only when active contacts exist but none has a usable phone', async () => {
    const fixture = await isolatedCustomer('+905321112233');
    await addContact(fixture.organizationId, fixture.customerId, {
      phone: null, isActive: true, isPrimary: true,
    });
    await addContact(fixture.organizationId, fixture.customerId, {
      phone: 'dahili 123', isActive: true, isPrimary: false,
    });
    expect(await missing(fixture.organizationId, fixture.customerId))
      .toEqual(['CONTACT_PHONE_MISSING']);

    await addContact(fixture.organizationId, fixture.customerId, {
      phone: '0212 999 88 77', isActive: true, isPrimary: false,
    });
    expect(await missing(fixture.organizationId, fixture.customerId)).toEqual([]);
  });

  it('excludes inactive contacts: inactive-only yields only ACTIVE_CONTACT_MISSING', async () => {
    const fixture = await isolatedCustomer('+905321112233');
    await addContact(fixture.organizationId, fixture.customerId, {
      phone: '+905321112233', isActive: false, isPrimary: false,
    });
    expect(await missing(fixture.organizationId, fixture.customerId))
      .toEqual(['ACTIVE_CONTACT_MISSING']);
  });

  it('returns both codes canonically when nothing is reachable, never the contact-phone code', async () => {
    const fixture = await isolatedCustomer(null);
    expect(await missing(fixture.organizationId, fixture.customerId))
      .toEqual(['CUSTOMER_PHONE_MISSING', 'ACTIVE_CONTACT_MISSING']);
  });

  it('does not treat primary-contact absence as a missing item', async () => {
    const fixture = await isolatedCustomer('+905321112233');
    await addContact(fixture.organizationId, fixture.customerId, {
      phone: '0212 999 88 77', isActive: true, isPrimary: false,
    });
    expect(await missing(fixture.organizationId, fixture.customerId)).toEqual([]);
  });

  it('conceals unknown and cross-organization customers as not found', async () => {
    const fixture = await isolatedCustomer('+905321112233');
    await expect(service!.getCustomerCompleteness(actor(fixture.organizationId), randomUUID()))
      .rejects.toMatchObject({ code: 'CUSTOMER_NOT_FOUND', statusCode: 404 });
    await expect(service!.getCustomerCompleteness(actor(randomUUID()), fixture.customerId))
      .rejects.toMatchObject({ code: 'CUSTOMER_NOT_FOUND', statusCode: 404 });
  });

  it('serves the projection over HTTP and rejects unknown query parameters', async () => {
    const fixture = await isolatedCustomer(null);
    const actorUser = actor(fixture.organizationId);
    const app: FastifyInstance = Fastify({ logger: false });
    app.setErrorHandler((error, _request, reply) => {
      const response = toErrorResponse(error);
      reply.code(response.statusCode).send(response.body);
    });
    await app.register(crmRoutes, {
      prefix: '/api',
      service: service!,
      authenticate: async (request) => {
        request.currentUser = {
          ...actorUser, name: 'Staff', email: 'staff@test.local',
          mustChangePassword: false, isActive: true, version: 1,
        };
      },
    });
    try {
      const ok = await app.inject({
        method: 'GET', url: `/api/customers/${fixture.customerId}/completeness`,
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ missingInfo: ['CUSTOMER_PHONE_MISSING', 'ACTIVE_CONTACT_MISSING'] });
      const unknown = await app.inject({
        method: 'GET', url: `/api/customers/${randomUUID()}/completeness`,
      });
      expect(unknown.statusCode).toBe(404);
      const badQuery = await app.inject({
        method: 'GET', url: `/api/customers/${fixture.customerId}/completeness?x=1`,
      });
      expect(badQuery.statusCode).toBe(400);
      expect(badQuery.json().code).toBe('VALIDATION_ERROR');
    } finally {
      await app.close();
    }
  });
});
