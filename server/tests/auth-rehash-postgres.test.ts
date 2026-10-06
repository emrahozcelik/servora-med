import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { hashPassword } from '../src/modules/auth/crypto.js';
import { PostgresAuthRepository } from '../src/modules/auth/repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrations = [
  '001_auth_foundation.sql',
  '002_delivery_tracer.sql',
  '003_people.sql',
] as const;

async function withMigratedDatabase(run: (pool: Pool) => Promise<void>) {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `r2_rehash_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool | null = null;

  try {
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema},public`,
    });
    for (const migration of migrations) {
      const path = fileURLToPath(
        new URL(`../src/db/migrations/${migration}`, import.meta.url),
      );
      await pool.query(await readFile(path, 'utf8'));
    }
    await run(pool);
  } finally {
    await pool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }
}

async function createFixture(pool: Pool, isActive = true) {
  const organizationId = (await pool.query<{ id: string }>(
    `INSERT INTO organizations (name) VALUES ('R2 rehash org') RETURNING id`,
  )).rows[0]!.id;
  const legacyHash = await hashPassword('rehash-fixture-password');
  const userId = (await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role, is_active,
                        must_change_password, version)
     VALUES ($1, 'R2 User', $2, $3, 'ADMIN', $4, TRUE, 3) RETURNING id`,
    [organizationId, `${randomUUID()}@test.local`, legacyHash, isActive],
  )).rows[0]!.id;
  const sessionId = (await pool.query<{ id: string }>(
    `INSERT INTO sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '1 hour') RETURNING id`,
    [userId, randomBytes(32).toString('hex')],
  )).rows[0]!.id;
  return { organizationId, userId, legacyHash, sessionId };
}

async function readUserRow(pool: Pool, userId: string) {
  return (await pool.query<{
    password_hash: string;
    must_change_password: boolean;
    is_active: boolean;
    version: number;
    updated_at: Date;
  }>(
    `SELECT password_hash, must_change_password, is_active, version, updated_at
     FROM users WHERE id = $1`,
    [userId],
  )).rows[0]!;
}

describe.runIf(Boolean(databaseUrl))('upgradePasswordHashIfCurrent (PostgreSQL CAS)', () => {
  it(
    'updates only password_hash on exact match; never touches version/updated_at/flags/sessions',
    async () => {
      await withMigratedDatabase(async (pool) => {
        const repository = new PostgresAuthRepository(pool);
        const { userId, legacyHash, sessionId } = await createFixture(pool);
        const before = await readUserRow(pool, userId);
        const replacement = await hashPassword('rehash-fixture-password');

        const result = await repository.upgradePasswordHashIfCurrent(
          userId,
          legacyHash,
          replacement,
        );

        expect(result).toBe('updated');
        const after = await readUserRow(pool, userId);
        expect(after.password_hash).toBe(replacement);
        // Exact-CAS maintenance touches ONLY password_hash.
        expect(after.version).toBe(before.version);
        expect(after.must_change_password).toBe(before.must_change_password);
        expect(after.is_active).toBe(before.is_active);
        expect(after.updated_at.getTime()).toBe(before.updated_at.getTime());
        const session = await pool.query<{ revoked_at: Date | null }>(
          `SELECT revoked_at FROM sessions WHERE id = $1`,
          [sessionId],
        );
        expect(session.rows[0]!.revoked_at).toBeNull();
      });
    },
    30_000,
  );

  it(
    'returns conflict without writing when the stored hash no longer matches',
    async () => {
      await withMigratedDatabase(async (pool) => {
        const repository = new PostgresAuthRepository(pool);
        const { userId, legacyHash } = await createFixture(pool);
        // Simulate a concurrent write that changed the credential first.
        const other = await hashPassword('someone-elses-password');
        await pool.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [userId, other]);

        const result = await repository.upgradePasswordHashIfCurrent(
          userId,
          legacyHash,
          await hashPassword('rehash-fixture-password'),
        );

        expect(result).toBe('conflict');
        const after = await readUserRow(pool, userId);
        expect(after.password_hash).toBe(other);
      });
    },
    30_000,
  );

  it(
    'skips the maintenance write for an inactive row',
    async () => {
      await withMigratedDatabase(async (pool) => {
        const repository = new PostgresAuthRepository(pool);
        const { userId, legacyHash } = await createFixture(pool, false);

        const result = await repository.upgradePasswordHashIfCurrent(
          userId,
          legacyHash,
          await hashPassword('rehash-fixture-password'),
        );

        expect(result).toBe('conflict');
        const after = await readUserRow(pool, userId);
        expect(after.password_hash).toBe(legacyHash);
      });
    },
    30_000,
  );

  it(
    'returns conflict for an unknown user id',
    async () => {
      await withMigratedDatabase(async (pool) => {
        const repository = new PostgresAuthRepository(pool);

        const result = await repository.upgradePasswordHashIfCurrent(
          randomUUID(),
          'scrypt$16384$8$1$c2FsdA$a2V5',
          await hashPassword('whatever-password'),
        );

        expect(result).toBe('conflict');
      });
    },
    30_000,
  );
});
