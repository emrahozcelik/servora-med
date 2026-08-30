import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';

const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const databaseUrl = process.env.TEST_DATABASE_URL;
const adminPool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const temporaryDirectories: string[] = [];

const EXISTING_AUDIT_EVENT_TYPES = [
  'USER_CREATED', 'USER_ROLE_CHANGED', 'USER_ACTIVATED', 'USER_DEACTIVATED', 'USER_PASSWORD_RESET',
  'STAFF_PROFILE_UPDATED', 'STAFF_MANAGER_CHANGED',
  'CUSTOMER_CREATED', 'CUSTOMER_FIELDS_UPDATED', 'CUSTOMER_ASSIGNEE_CHANGED',
  'CUSTOMER_ACTIVATED', 'CUSTOMER_DEACTIVATED', 'CONTACT_CREATED', 'CONTACT_FIELDS_UPDATED',
  'CONTACT_MADE_PRIMARY', 'CONTACT_ACTIVATED', 'CONTACT_DEACTIVATED',
  'PRODUCT_CREATED', 'PRODUCT_FIELDS_UPDATED', 'PRODUCT_ACTIVATED', 'PRODUCT_DEACTIVATED',
  'CUSTOMER_DELETED', 'PRODUCT_DELETED', 'STAFF_CONFIDENTIAL_NOTE_CREATED',
  'BACKUP_REQUESTED', 'BACKUP_POLICY_UPDATED', 'BACKUP_STARTED', 'BACKUP_VERIFIED',
  'BACKUP_COMPLETED', 'BACKUP_FAILED', 'JOB_CARD_INVALIDATED',
] as const;

afterAll(async () => {
  await adminPool?.end();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function withIsolatedDatabase(run: (pool: Pool) => Promise<void>) {
  const schema = `r4a_audit_${randomUUID().replaceAll('-', '')}`;
  await adminPool!.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
  try {
    await run(pool);
  } finally {
    await pool.end();
    await adminPool!.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  }
}

async function createPre037Directory() {
  const directory = await mkdtemp(path.join(tmpdir(), 'servora-med-r4a-pre037-'));
  temporaryDirectories.push(directory);
  const names = (await (await import('node:fs/promises')).readdir(migrationsDirectory))
    .filter((name) => name.endsWith('.sql') && name < '037_');
  await Promise.all(names.map(async (name) => {
    await writeFile(path.join(directory, name), await readFile(path.join(migrationsDirectory, name), 'utf8'));
  }));
  return directory;
}

async function readEventTypes(pool: Pool) {
  const result = await pool.query<{ definition: string }>(
    `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
      WHERE conname = 'audit_events_event_type_check'
        AND connamespace = current_schema()::regnamespace`,
  );
  expect(result.rows).toHaveLength(1);
  return [...result.rows[0]!.definition.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

async function createAuditActor(pool: Pool) {
  const organizationId = (await pool.query<{ id: string }>(
    `INSERT INTO organizations (name) VALUES ('R4A audit migration') RETURNING id`,
  )).rows[0]!.id;
  const actorId = (await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role)
     VALUES ($1, 'R4A Admin', $2, 'test-hash', 'ADMIN') RETURNING id`,
    [organizationId, `${randomUUID()}@r4a.test`],
  )).rows[0]!.id;
  return { organizationId, actorId };
}

async function insertAuditEvent(pool: Pool, organizationId: string, actorId: string, eventType: string) {
  await pool.query(
    `INSERT INTO audit_events (organization_id, actor_user_id, subject_type, subject_id, event_type)
     VALUES ($1, $2, 'USER', $2, $3)`,
    [organizationId, actorId, eventType],
  );
}

describe.skipIf(!databaseUrl)('R4A audit vocabulary migration', () => {
  it('freshly applies the full chain, preserves the audit allowlist, and adds the D4 audit vocabulary', async () => {
    await withIsolatedDatabase(async (pool) => {
      const result = await runMigrations({ migrationsDirectory, store: new PostgresMigrationStore(pool) });
      expect(result.appliedVersions).toHaveLength(41);
      expect(result.appliedVersions.at(-1)).toBe('041_user_lifecycle_reconciliation');
      expect(new Set(await readEventTypes(pool))).toEqual(new Set([...EXISTING_AUDIT_EVENT_TYPES, 'USER_OFFBOARDED', 'DEMO_DATASET_CREATED', 'DEMO_DATASET_PURGED', 'CONTACT_DELETED', 'USER_DELETED']));

      const { organizationId, actorId } = await createAuditActor(pool);
      for (const eventType of [...EXISTING_AUDIT_EVENT_TYPES, 'USER_OFFBOARDED', 'CONTACT_DELETED', 'DEMO_DATASET_CREATED', 'DEMO_DATASET_PURGED', 'USER_DELETED']) {
        await insertAuditEvent(pool, organizationId, actorId, eventType);
      }
      await expect(insertAuditEvent(pool, organizationId, actorId, 'R4A_UNKNOWN_EVENT')).rejects.toMatchObject({ code: '23514' });
    });
  });

  it('upgrades a pre-037 database without rewriting existing audit rows', async () => {
    await withIsolatedDatabase(async (pool) => {
      const legacyDirectory = await createPre037Directory();
      const store = new PostgresMigrationStore(pool);
      await runMigrations({ migrationsDirectory: legacyDirectory, store });
      const { organizationId, actorId } = await createAuditActor(pool);
      await insertAuditEvent(pool, organizationId, actorId, 'USER_DEACTIVATED');

      const upgrade = await runMigrations({ migrationsDirectory, store });
      expect(upgrade).toEqual({ appliedVersions: ['037_staff_offboarding_audit', '038_demo_dataset_audit_types', '039_contact_deleted_audit', '040_demo_lifecycle_simplification', '041_user_lifecycle_reconciliation'] });
      expect((await pool.query(`SELECT event_type FROM audit_events WHERE event_type = 'USER_DEACTIVATED'`)).rows).toHaveLength(1);
      expect(new Set(await readEventTypes(pool))).toEqual(new Set([...EXISTING_AUDIT_EVENT_TYPES, 'USER_OFFBOARDED', 'DEMO_DATASET_CREATED', 'DEMO_DATASET_PURGED', 'CONTACT_DELETED', 'USER_DELETED']));
      await insertAuditEvent(pool, organizationId, actorId, 'USER_OFFBOARDED');
      await insertAuditEvent(pool, organizationId, actorId, 'DEMO_DATASET_PURGED');
      await expect(insertAuditEvent(pool, organizationId, actorId, 'R4A_UNKNOWN_EVENT')).rejects.toMatchObject({ code: '23514' });
    });
  });
});
