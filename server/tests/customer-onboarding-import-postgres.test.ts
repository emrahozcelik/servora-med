import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { runMigrations } from '../src/db/migrate-runner.js';
import { PostgresMigrationStore } from '../src/db/index.js';
import { getMigrationsDirectory } from '../src/db/schema-compatibility.js';
import {
  formatCustomerImportError,
  importCustomers,
  parseCustomerOnboardingManifest,
  parseStaffMappings,
} from '../src/modules/crm/customer-onboarding-import.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

async function withDatabase(run: (pool: Pool, organizationId: string, sourceOrganizationId: string, adminId: string, staffId: string) => Promise<void>) {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `customer_import_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool | null = null;
  try {
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
    await runMigrations({ migrationsDirectory: getMigrationsDirectory(), store: new PostgresMigrationStore(pool) });
    const sourceOrganizationId = (await pool.query<{ id: string }>(
      `INSERT INTO organizations (name) VALUES ('Source only') RETURNING id`,
    )).rows[0]!.id;
    const organizationId = (await pool.query<{ id: string }>(
      `INSERT INTO organizations (name) VALUES ('Production target') RETURNING id`,
    )).rows[0]!.id;
    const adminId = (await pool.query<{ id: string }>(
      `INSERT INTO users (organization_id,name,email,password_hash,role) VALUES ($1,'Admin','admin@example.test','unused','ADMIN') RETURNING id`,
      [organizationId],
    )).rows[0]!.id;
    const staffId = (await pool.query<{ id: string }>(
      `INSERT INTO users (organization_id,name,email,password_hash,role) VALUES ($1,'Staff','staff@example.test','unused','STAFF') RETURNING id`,
      [organizationId],
    )).rows[0]!.id;
    await runPool(pool, organizationId, sourceOrganizationId, adminId, staffId);
  } finally {
    await pool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }
}

async function runPool(
  pool: Pool,
  organizationId: string,
  sourceOrganizationId: string,
  adminId: string,
  staffId: string,
) {
  const sourceStaffId = randomUUID();
  const contactId = randomUUID();
  const manifest = parseCustomerOnboardingManifest({
    version: 1,
    customers: [
      {
        sourceId: randomUUID(), name: 'Dental A', customerType: 'clinic', status: 'active',
        taxNumber: '12 34', phone: '555', email: 'A@Example.test', city: 'İstanbul', district: null,
        address: null, assignedSourceStaffUserId: sourceStaffId,
        contacts: [{ sourceId: contactId, name: 'Dr. A', title: 'Satın Alma', phone: null,
          email: 'contact@example.test', isPrimary: true, isActive: true }],
      },
      {
        sourceId: randomUUID(), name: 'Dental B', customerType: 'hospital', status: 'prospect',
        taxNumber: null, phone: null, email: null, city: null, district: null, address: null,
        assignedSourceStaffUserId: null, contacts: [],
      },
      {
        sourceId: randomUUID(), name: 'Dental C', customerType: 'clinic', status: 'inactive',
        taxNumber: '56 78', phone: null, email: null, city: null, district: null, address: null,
        assignedSourceStaffUserId: null,
        contacts: [{ sourceId: randomUUID(), name: 'Dr. C', title: null, phone: null,
          email: null, isPrimary: true, isActive: true }],
      },
    ],
  });
  const mappings = parseStaffMappings([{ sourceUserId: sourceStaffId, productionUserId: staffId }]);

  const dryRun = await importCustomers(pool, {
    organizationId, actorUserId: adminId, manifest, mappings, apply: false,
  });
  expect(dryRun).toMatchObject({ inputCustomers: 3, inputContacts: 2, createCount: 3,
    existingCount: 0, createContactCount: 2, staffMappingsResolved: 1,
    staffMappingsUnresolved: 0, conflictCount: 0, taxConflicts: 0, dryRun: true });
  expect((await pool.query(`SELECT count(*)::int AS count FROM customers`)).rows[0].count).toBe(0);
  expect((await pool.query(`SELECT count(*)::int AS count FROM contacts`)).rows[0].count).toBe(0);

  const applied = await importCustomers(pool, {
    organizationId, actorUserId: adminId, manifest, mappings, apply: true,
  });
  expect(applied).toMatchObject({ createCount: 3, existingCount: 0, createContactCount: 2, dryRun: false });
  expect((await pool.query(`SELECT count(*)::int AS count FROM customers WHERE organization_id=$1`, [organizationId])).rows[0].count).toBe(3);
  expect((await pool.query(`SELECT count(*)::int AS count FROM customers WHERE organization_id=$1`, [sourceOrganizationId])).rows[0].count).toBe(0);
  expect((await pool.query(`SELECT count(*)::int AS count FROM contacts WHERE organization_id=$1`, [organizationId])).rows[0].count).toBe(2);
  expect((await pool.query(`SELECT count(*)::int AS count FROM contacts WHERE is_primary AND is_active`)).rows[0].count).toBe(2);
  expect((await pool.query(`SELECT count(*)::int AS count FROM audit_events WHERE event_type IN ('CUSTOMER_CREATED','CONTACT_CREATED')`)).rows[0].count).toBe(5);
  expect((await pool.query(`SELECT status,version FROM customers WHERE name='Dental C'`)).rows[0]).toMatchObject({ status: 'inactive', version: 2 });
  expect((await pool.query(`SELECT count(*)::int AS count FROM audit_events WHERE event_type='CUSTOMER_DEACTIVATED'`)).rows[0].count).toBe(1);
  expect((await pool.query(`SELECT count(*)::int AS count FROM customers WHERE assigned_staff_user_id=$1`, [staffId])).rows[0].count).toBe(1);

  const repeated = await importCustomers(pool, {
    organizationId, actorUserId: adminId, manifest, mappings, apply: false,
  });
  expect(repeated).toMatchObject({ createCount: 0, existingCount: 3, createContactCount: 0,
    existingContactCount: 2, conflictCount: 0, dryRun: true });
}

describe.skipIf(!databaseUrl)('customer onboarding importer PostgreSQL contract', () => {
  it('dry-runs without writes, remaps the organization, audits, and repeats idempotently', async () => {
    await withDatabase(async (pool, organizationId, sourceOrganizationId, adminId, staffId) => {
      await runPool(pool, organizationId, sourceOrganizationId, adminId, staffId);
    });
  });

  it('blocks unresolved staff mappings before any apply', async () => {
    await withDatabase(async (pool, organizationId, _sourceOrganizationId, adminId, _staffId) => {
      const manifest = parseCustomerOnboardingManifest({ version: 1, customers: [{
        sourceId: randomUUID(), name: 'Needs staff', customerType: 'clinic', status: 'active',
        taxNumber: null, phone: null, email: null, city: null, district: null, address: null,
        assignedSourceStaffUserId: randomUUID(), contacts: [],
      }] });
      const result = await importCustomers(pool, { organizationId, actorUserId: adminId,
        manifest, mappings: [], apply: false });
      expect(result.staffMappingsUnresolved).toBe(1);
      await expect(importCustomers(pool, { organizationId, actorUserId: adminId,
        manifest, mappings: [], apply: true })).rejects.toMatchObject({ code: 'CUSTOMER_IMPORT_BLOCKED' });
      expect((await pool.query(`SELECT count(*)::int AS count FROM customers`)).rows[0].count).toBe(0);
    });
  });

  it('rolls back a customer when a contact insert fails', async () => {
    await withDatabase(async (pool, organizationId, _sourceOrganizationId, adminId, _staffId) => {
      await pool.query(`
        CREATE FUNCTION reject_onboarding_contact() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'injected contact failure'; END $$;
        CREATE TRIGGER reject_onboarding_contact_trigger BEFORE INSERT ON contacts
        FOR EACH ROW EXECUTE FUNCTION reject_onboarding_contact();
      `);
      const manifest = parseCustomerOnboardingManifest({ version: 1, customers: [{
        sourceId: randomUUID(), name: 'Atomic customer', customerType: 'clinic', status: 'active',
        taxNumber: '999', phone: null, email: null, city: null, district: null, address: null,
        assignedSourceStaffUserId: null,
        contacts: [{ sourceId: randomUUID(), name: 'Atomic contact', title: null, phone: null,
          email: null, isPrimary: true, isActive: true }],
      }] });
      await expect(importCustomers(pool, { organizationId, actorUserId: adminId,
        manifest, mappings: [], apply: true })).rejects.toThrow('injected contact failure');
      expect((await pool.query(`SELECT count(*)::int AS count FROM customers`)).rows[0].count).toBe(0);
      expect((await pool.query(`SELECT count(*)::int AS count FROM contacts`)).rows[0].count).toBe(0);
      expect((await pool.query(`SELECT count(*)::int AS count FROM audit_events`)).rows[0].count).toBe(0);
    });
  });

  it('reports duplicate source tax identities and blocks apply', async () => {
    await withDatabase(async (pool, organizationId, _sourceOrganizationId, adminId, _staffId) => {
      const manifest = parseCustomerOnboardingManifest({ version: 1, customers: [
        { sourceId: randomUUID(), name: 'Tax duplicate A', customerType: 'clinic', status: 'active',
          taxNumber: 'DUP-1', phone: null, email: null, city: null, district: null, address: null,
          assignedSourceStaffUserId: null, contacts: [] },
        { sourceId: randomUUID(), name: 'Tax duplicate B', customerType: 'clinic', status: 'active',
          taxNumber: 'DUP 1', phone: null, email: null, city: null, district: null, address: null,
          assignedSourceStaffUserId: null, contacts: [] },
      ] });
      const dryRun = await importCustomers(pool, { organizationId, actorUserId: adminId,
        manifest, mappings: [], apply: false });
      expect(dryRun).toMatchObject({ taxConflicts: 1, conflictCount: 1, createCount: 2 });
      await expect(importCustomers(pool, { organizationId, actorUserId: adminId,
        manifest, mappings: [], apply: true })).rejects.toMatchObject({ code: 'CUSTOMER_IMPORT_BLOCKED' });
      expect((await pool.query(`SELECT count(*)::int AS count FROM customers`)).rows[0].count).toBe(0);
    });
  });

  it('blocks adding a missing contact to an existing inactive customer', async () => {
    await withDatabase(async (pool, organizationId, _sourceOrganizationId, adminId, _staffId) => {
      const customerId = (await pool.query<{ id: string }>(
        `INSERT INTO customers (organization_id,name,customer_type,status,tax_number)
         VALUES ($1,'Inactive target','clinic','inactive','INACTIVE-1') RETURNING id`, [organizationId],
      )).rows[0]!.id;
      const manifest = parseCustomerOnboardingManifest({ version: 1, customers: [{
        sourceId: randomUUID(), name: 'Inactive target', customerType: 'clinic', status: 'inactive',
        taxNumber: 'INACTIVE 1', phone: null, email: null, city: null, district: null, address: null,
        assignedSourceStaffUserId: null,
        contacts: [{ sourceId: randomUUID(), name: 'New contact', title: null, phone: null,
          email: null, isPrimary: true, isActive: true }],
      }] });
      const dryRun = await importCustomers(pool, { organizationId, actorUserId: adminId,
        manifest, mappings: [], apply: false });
      expect(dryRun).toMatchObject({ existingCount: 1, createContactCount: 1, conflictCount: 1 });
      await expect(importCustomers(pool, { organizationId, actorUserId: adminId,
        manifest, mappings: [], apply: true })).rejects.toMatchObject({ code: 'CUSTOMER_IMPORT_BLOCKED' });
      expect((await pool.query(`SELECT count(*)::int AS count FROM contacts WHERE customer_id=$1`, [customerId])).rows[0].count).toBe(0);
    });
  });
});

describe('customer onboarding importer error boundary', () => {
  it('sanitizes PostgreSQL constraint details before operator output', () => {
    const raw = {
      code: '23505',
      constraint: 'customers_organization_tax_number_unique',
      detail: 'Key (organization_id, tax_number)=(target, TAX-SECRET-123) already exists. phone=555 email=secret@example.test address=Sensitive',
    };
    const safe = formatCustomerImportError(raw);
    const output = JSON.stringify(safe);
    expect(safe).toMatchObject({ category: 'TAX_NUMBER_CONFLICT', code: '23505' });
    expect(output).not.toContain('TAX-SECRET-123');
    expect(output).not.toContain('secret@example.test');
    expect(output).not.toContain('Sensitive');
    expect(output).not.toContain('Key (organization_id');
  });

  it('classifies invalid JSON without exposing parser details', () => {
    const safe = formatCustomerImportError(new SyntaxError('secret value at position 42'));
    expect(safe).toEqual({ category: 'INPUT_ERROR', code: 'INVALID_JSON', message: 'An input file is not valid JSON.' });
  });
});

describe('customer onboarding manifest validation', () => {
  it('rejects duplicate source identities and multiple active primaries', () => {
    const sourceId = randomUUID();
    const base = { sourceId, name: 'Customer', customerType: 'clinic', status: 'active',
      taxNumber: null, phone: null, email: null, city: null, district: null, address: null,
      assignedSourceStaffUserId: null, contacts: [] };
    expect(() => parseCustomerOnboardingManifest({ version: 1, customers: [base, base] }))
      .toThrowError(expect.objectContaining({ code: 'CUSTOMER_IMPORT_INVALID' }));
    expect(() => parseCustomerOnboardingManifest({ version: 1, customers: [{ ...base,
      contacts: [
        { sourceId: randomUUID(), name: 'A', title: null, phone: null, email: null, isPrimary: true, isActive: true },
        { sourceId: randomUUID(), name: 'B', title: null, phone: null, email: null, isPrimary: true, isActive: true },
      ] }] })).toThrowError(expect.objectContaining({ code: 'CUSTOMER_IMPORT_INVALID' }));
  });
});
