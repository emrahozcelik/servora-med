import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { PostgresAuthRepository } from '../src/modules/auth/repository.js';
import { fileURLToPath } from 'node:url';

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const adminPool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;

afterAll(async () => {
  await adminPool?.end();
});

async function withIsolatedDatabase(
  run: (pool: Pool) => Promise<void>,
) {
  if (!adminPool) throw new Error('TEST_DATABASE_URL is required');
  const schema = `auth_rehash_${randomUUID().replaceAll('-', '')}`;
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema},public`,
  });
  const store = new PostgresMigrationStore(pool);
  try {
    await runMigrations({ migrationsDirectory, store });
    await run(pool);
  } finally {
    await pool.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  }
}

describe.runIf(Boolean(databaseUrl))('upgradePasswordHashIfCurrent (PostgreSQL CAS)', () => {
  it('updates only password_hash on exact match; conflict otherwise; never touches version/updated_at/flags/sessions', async () => {
    await withIsolatedDatabase(async (pool) => {
      const repository = new PostgresAuthRepository(pool);
      const orgId = (await pool.query<{ id: string }>(
        'INSERT INTO organizations (name) VALUES ($1) RETURNING id', ['Rehash Org'],
      )).rows[0]!.id;
      const legacySalt = Buffer.alloc(16, 7).toString('base64url');
      const legacyKey = Buffer.alloc(64, 7).toString('base64url');
      const v2Salt = Buffer.alloc(16, 9).toString('base64url');
      const v2Key = Buffer.alloc(64, 9).toString('base64url');
      const legacy = `scrypt$16384$8$1$${legacySalt}$${legacyKey}`;
      const userRow = (await pool.query(
        `INSERT INTO users (organization_id, name, email, password_hash, role, must_change_password, version)
         VALUES ($1, 'Rehash User', 'rehash@example.test', $2, 'STAFF', TRUE, 7)
         RETURNING id, version, updated_at, must_change_password`,
        [orgId, legacy],
      )).rows[0]!;
      await pool.query(
        `INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, repeat('b', 64), '2099-01-01T00:00:00Z')`,
        [userRow.id],
      );

      const v2 = `scrypt$v2$32768$8$1$${v2Salt}$${v2Key}`;
      await expect(
        repository.upgradePasswordHashIfCurrent(userRow.id, legacy, v2),
      ).resolves.toBe('updated');

      const after = (await pool.query(
        `SELECT password_hash, version, updated_at, must_change_password,
                (SELECT revoked_at FROM sessions WHERE user_id = $1) AS revoked_at
         FROM users WHERE id = $1`,
        [userRow.id],
      )).rows[0]!;
      expect(after.password_hash).toBe(v2);
      expect(after.version).toBe(7);
      expect(new Date(after.updated_at).getTime()).toBe(new Date(userRow.updated_at).getTime());
      expect(after.must_change_password).toBe(true);
      expect(after.revoked_at).toBeNull();

      // Stale expected hash: conflict, stored value untouched.
      await expect(
        repository.upgradePasswordHashIfCurrent(userRow.id, legacy, v2),
      ).resolves.toBe('conflict');
      const still = (await pool.query('SELECT password_hash FROM users WHERE id = $1', [userRow.id])).rows[0]!;
      expect(still.password_hash).toBe(v2);

      // Unknown user: conflict.
      await expect(
        repository.upgradePasswordHashIfCurrent(randomUUID(), legacy, v2),
      ).resolves.toBe('conflict');
    });
  });
});
