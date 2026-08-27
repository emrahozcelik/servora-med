import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { getMigrationsDirectory } from '../src/db/schema-compatibility.js';
import {
  formatPersonnelImportError,
  importPersonnel,
  parsePersonnelCredentials,
  parsePersonnelManifest,
  readSecurePersonnelCredentials,
  writePersonnelMappingArtifact,
} from '../src/modules/people/personnel-onboarding-import.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

type Fixture = {
  pool: Pool;
  organizationId: string;
  sourceOrganizationId: string;
  adminId: string;
  manifest: ReturnType<typeof parsePersonnelManifest>;
  credentials: ReturnType<typeof parsePersonnelCredentials>;
};

async function withDatabase(run: (fixture: Fixture) => Promise<void>) {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `personnel_import_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool | null = null;
  try {
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
    await runMigrations({ migrationsDirectory: getMigrationsDirectory(), store: new PostgresMigrationStore(pool) });
    const sourceOrganizationId = (await pool.query<{ id: string }>(
      `INSERT INTO organizations (name) VALUES ('Source personnel') RETURNING id`,
    )).rows[0]!.id;
    const organizationId = (await pool.query<{ id: string }>(
      `INSERT INTO organizations (name) VALUES ('Production personnel') RETURNING id`,
    )).rows[0]!.id;
    const adminId = (await pool.query<{ id: string }>(
      `INSERT INTO users (organization_id,name,email,password_hash,role,must_change_password)
       VALUES ($1,'Production Admin','admin@example.test','synthetic-hash','ADMIN',FALSE) RETURNING id`,
      [organizationId],
    )).rows[0]!.id;
    const managers = Array.from({ length: 5 }, (_, index) => ({
      sourceUserId: randomUUID(), name: `Manager ${index + 1}`, email: `manager${index + 1}@example.test`,
      role: 'MANAGER' as const, staffProfile: null,
    }));
    const staff = Array.from({ length: 10 }, (_, index) => ({
      sourceUserId: randomUUID(), name: `Staff ${index + 1}`, email: `staff${index + 1}@example.test`,
      role: 'STAFF' as const,
      staffProfile: {
        title: index === 0 ? 'Teknik Sorumlu' : null, phone: index === 1 ? '5550000001' : null,
        region: index % 2 === 0 ? 'Marmara' : null, sourceManagerUserId: managers[index % managers.length]!.sourceUserId,
      },
    }));
    const manifest = parsePersonnelManifest({
      version: 1, sourceOrganizationId, sourceOrganizationName: 'Source personnel', personnel: [...managers, ...staff],
    });
    const credentials = parsePersonnelCredentials({
      version: 1,
      credentials: manifest.personnel.map((entry, index) => ({
        email: entry.email, temporaryPassword: `Synthetic-password-${index + 1}`,
      })),
    });
    await run({ pool, organizationId, sourceOrganizationId, adminId, manifest, credentials });
  } finally {
    await pool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }
}

describe.skipIf(!databaseUrl)('personnel onboarding importer PostgreSQL contract', () => {
  it('dry-runs without writes, remaps the organization, orders managers, audits, and repeats idempotently', async () => {
    await withDatabase(async ({ pool, organizationId, sourceOrganizationId, adminId, manifest, credentials }) => {
      const dryRun = await importPersonnel(pool, { organizationId, actorUserId: adminId, manifest, apply: false });
      expect(dryRun.result).toMatchObject({ input: 15, managers: 5, staff: 10, create: 15, existing: 0,
        conflict: 0, invalid: 0, managerMappingsResolved: 10, managerMappingsUnresolved: 0,
        credentialRequirements: 15, dryRun: true });
      expect((await pool.query(`SELECT COUNT(*)::int AS count FROM users WHERE organization_id=$1`, [organizationId])).rows[0].count).toBe(1);
      expect((await pool.query(`SELECT COUNT(*)::int AS count FROM staff_profiles WHERE organization_id=$1`, [organizationId])).rows[0].count).toBe(0);
      expect((await pool.query(`SELECT COUNT(*)::int AS count FROM audit_events WHERE organization_id=$1`, [organizationId])).rows[0].count).toBe(0);
      await expect(importPersonnel(pool, { organizationId, actorUserId: adminId, manifest, apply: true }))
        .rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' });
      expect((await pool.query(`SELECT COUNT(*)::int AS count FROM users WHERE organization_id=$1`, [organizationId])).rows[0].count).toBe(1);

      const applied = await importPersonnel(pool, { organizationId, actorUserId: adminId, manifest, credentials, apply: true });
      expect(applied.result).toMatchObject({ input: 15, create: 15, existing: 0, conflict: 0,
        managerMappingsResolved: 10, managerMappingsUnresolved: 0, dryRun: false });
      expect(applied.mappings).toHaveLength(15);
      expect(applied.mappings.every((mapping) => mapping.productionUserId && mapping.productionUserId !== mapping.sourceUserId)).toBe(true);
      expect((await pool.query(`SELECT COUNT(*)::int AS count FROM users WHERE organization_id=$1`, [organizationId])).rows[0].count).toBe(16);
      expect((await pool.query(`SELECT COUNT(*)::int AS count FROM users WHERE organization_id=$1`, [sourceOrganizationId])).rows[0].count).toBe(0);
      expect((await pool.query(`SELECT COUNT(*)::int AS count FROM staff_profiles WHERE organization_id=$1`, [organizationId])).rows[0].count).toBe(10);
      const managers = (await pool.query<{ id: string }>(`SELECT id FROM users WHERE organization_id=$1 AND role='MANAGER'`, [organizationId])).rows.map((row) => row.id);
      const assignedManagers = (await pool.query<{ manager_user_id: string }>(
        `SELECT manager_user_id FROM staff_profiles WHERE organization_id=$1`, [organizationId],
      )).rows.map((row) => row.manager_user_id);
      expect(assignedManagers.every((id) => managers.includes(id))).toBe(true);
      expect(assignedManagers.every((id) => !manifest.personnel.some((entry) => entry.sourceUserId === id))).toBe(true);
      expect((await pool.query(`SELECT COUNT(*)::int AS count FROM audit_events WHERE organization_id=$1 AND event_type='USER_CREATED'`, [organizationId])).rows[0].count).toBe(15);
      const auditJson = JSON.stringify((await pool.query(`SELECT new_value,metadata FROM audit_events WHERE organization_id=$1`, [organizationId])).rows);
      expect(auditJson).not.toContain('Synthetic-password');

      const repeated = await importPersonnel(pool, { organizationId, actorUserId: adminId, manifest, apply: false });
      expect(repeated.result).toMatchObject({ create: 0, existing: 15, conflict: 0, credentialRequirements: 0, dryRun: true });
      expect(repeated.mappings.every((mapping) => mapping.productionUserId)).toBe(true);
    });
  });

  it('blocks cross-organization email ownership before any mutation', async () => {
    await withDatabase(async ({ pool, organizationId, sourceOrganizationId, adminId, manifest, credentials }) => {
      await pool.query(
        `INSERT INTO users (organization_id,name,email,password_hash,role)
         VALUES ($1,'Other tenant','manager1@example.test','synthetic-hash','MANAGER')`,
        [sourceOrganizationId],
      );
      const result = await importPersonnel(pool, { organizationId, actorUserId: adminId, manifest, apply: false });
      expect(result.result).toMatchObject({ conflict: 3, crossOrganizationEmailConflicts: 1, create: 12, managerMappingsUnresolved: 2 });
      const usableCredentials = credentials.filter((credential) => !['manager1@example.test', 'staff1@example.test', 'staff6@example.test'].includes(credential.email));
      await expect(importPersonnel(pool, {
        organizationId, actorUserId: adminId, manifest, credentials: usableCredentials, apply: true,
      })).rejects.toMatchObject({ code: 'PERSONNEL_IMPORT_BLOCKED' });
      expect((await pool.query(`SELECT COUNT(*)::int AS count FROM users WHERE organization_id=$1`, [organizationId])).rows[0].count).toBe(1);
    });
  });

  it('rolls the entire batch back when a later profile insert fails', async () => {
    await withDatabase(async ({ pool, organizationId, adminId, manifest, credentials }) => {
      await pool.query(`
        CREATE FUNCTION reject_personnel_profile() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'synthetic profile failure'; END $$;
        CREATE TRIGGER reject_personnel_profile_trigger BEFORE INSERT ON staff_profiles
        FOR EACH ROW EXECUTE FUNCTION reject_personnel_profile();
      `);
      await expect(importPersonnel(pool, { organizationId, actorUserId: adminId, manifest, credentials, apply: true }))
        .rejects.toThrow('synthetic profile failure');
      expect((await pool.query(`SELECT COUNT(*)::int AS count FROM users WHERE organization_id=$1`, [organizationId])).rows[0].count).toBe(1);
      expect((await pool.query(`SELECT COUNT(*)::int AS count FROM staff_profiles WHERE organization_id=$1`, [organizationId])).rows[0].count).toBe(0);
      expect((await pool.query(`SELECT COUNT(*)::int AS count FROM audit_events WHERE organization_id=$1`, [organizationId])).rows[0].count).toBe(0);
    });
  });
});

describe('personnel onboarding parser and privacy contract', () => {
  const valid = {
    version: 1, sourceOrganizationId: randomUUID(), sourceOrganizationName: 'Synthetic source',
    personnel: [{ sourceUserId: randomUUID(), name: 'Synthetic Manager', email: 'manager@example.test', role: 'MANAGER', staffProfile: null }],
  };

  it('rejects ADMIN rows, password/hash fields, duplicate identities, and unknown managers', () => {
    expect(() => parsePersonnelManifest({ ...valid, personnel: [{ ...valid.personnel[0], role: 'ADMIN' }] }))
      .toThrowError(expect.objectContaining({ code: 'PERSONNEL_ADMIN_NOT_ALLOWED' }));
    expect(() => parsePersonnelManifest({ ...valid, personnel: [{ ...valid.personnel[0], passwordHash: 'not-accepted' }] }))
      .toThrowError(expect.objectContaining({ code: 'PERSONNEL_IMPORT_INVALID' }));
    const duplicate = { ...valid.personnel[0], sourceUserId: valid.personnel[0].sourceUserId };
    expect(() => parsePersonnelManifest({ ...valid, personnel: [duplicate, duplicate] }))
      .toThrowError(expect.objectContaining({ code: 'PERSONNEL_IMPORT_INVALID' }));
    expect(() => parsePersonnelManifest({ ...valid, personnel: [{ sourceUserId: randomUUID(), name: 'Staff', email: 'staff@example.test', role: 'STAFF',
      staffProfile: { title: null, phone: null, region: null, sourceManagerUserId: randomUUID() } }] }))
      .toThrowError(expect.objectContaining({ code: 'PERSONNEL_GRAPH_CONFLICT' }));
  });

  it('requires secure credentials, rejects hashes, and never exposes password values', () => {
    expect(() => parsePersonnelCredentials({ version: 1, credentials: [{ email: 'staff@example.test', passwordHash: 'secret-hash' }] }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_CREDENTIAL_FILE' }));
    expect(() => parsePersonnelCredentials({ version: 1, credentials: [{ email: 'staff@example.test', temporaryPassword: 'short' }] }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_CREDENTIAL_FILE' }));
    expect(() => parsePersonnelCredentials({ version: 1, credentials: [{ email: 'staff@example.test', temporaryPassword: 'scrypt$16384$8$1$hash' }] }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_CREDENTIAL_FILE' }));
    const safe = formatPersonnelImportError({ code: '23505', detail: 'temporaryPassword=DO-NOT-LEAK email=secret@example.test' });
    expect(JSON.stringify(safe)).not.toContain('DO-NOT-LEAK');
    expect(JSON.stringify(safe)).not.toContain('secret@example.test');
  });

  it('accepts 0600 or stricter credential files and writes password-free mapping output exclusively', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'servora-personnel-'));
    const credentialsPath = path.join(directory, 'credentials.json');
    const linkPath = path.join(directory, 'credentials-link.json');
    const mappingPath = path.join(directory, 'mapping.json');
    try {
      await writeFile(credentialsPath, JSON.stringify({ version: 1, credentials: [{ email: 'staff@example.test', temporaryPassword: 'Synthetic-password-1' }] }), { mode: 0o600 });
      expect(await readSecurePersonnelCredentials(credentialsPath)).toHaveLength(1);
      await chmod(credentialsPath, 0o640);
      await expect(readSecurePersonnelCredentials(credentialsPath)).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL_FILE' });
      await chmod(credentialsPath, 0o400);
      expect(await readSecurePersonnelCredentials(credentialsPath)).toHaveLength(1);
      await symlink(credentialsPath, linkPath);
      await expect(readSecurePersonnelCredentials(linkPath)).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL_FILE' });
      const artifact = await writePersonnelMappingArtifact(credentialsPath, randomUUID(), [{
        sourceUserId: randomUUID(), productionUserId: randomUUID(), role: 'STAFF',
      }]).catch(() => null);
      expect(artifact).toBeNull();
      const written = await writePersonnelMappingArtifact(mappingPath, randomUUID(), [{
        sourceUserId: randomUUID(), productionUserId: randomUUID(), role: 'STAFF',
      }]);
      expect(written.sha256).toMatch(/^[0-9a-f]{64}$/);
      const mappingRaw = await readFile(mappingPath, 'utf8');
      expect(mappingRaw).not.toContain('Synthetic-password');
      await expect(writePersonnelMappingArtifact(mappingPath, randomUUID(), [])).rejects.toMatchObject({ code: 'INVALID_MAPPING_OUTPUT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
