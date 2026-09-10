import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { hashPassword, hashSessionToken } from '../src/modules/auth/crypto.js';
import { PostgresAuthRepository } from '../src/modules/auth/repository.js';
import { AuthService } from '../src/modules/auth/service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrations = [
  '001_auth_foundation.sql',
  '002_delivery_tracer.sql',
  '003_people.sql',
] as const;

async function withMigratedDatabase(run: (pool: Pool) => Promise<void>) {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `b1_auth_issuance_${randomUUID().replaceAll('-', '')}`;
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

type Fixture = {
  organizationId: string;
  userId: string;
  email: string;
};

async function createActiveUser(
  pool: Pool,
  organizationId: string,
  isActive: boolean,
): Promise<Fixture> {
  const email = `${randomUUID()}@test.local`;
  const passwordHash = await hashPassword('correct-password');
  const userId = (await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role, is_active)
     VALUES ($1, 'B1 User', $2, $3, 'ADMIN', $4) RETURNING id`,
    [organizationId, email, passwordHash, isActive],
  )).rows[0]!.id;
  return { organizationId, userId, email };
}

async function createFixture(pool: Pool): Promise<Fixture> {
  const organizationId = (await pool.query<{ id: string }>(
    `INSERT INTO organizations (name) VALUES ('B1 auth race org') RETURNING id`,
  )).rows[0]!.id;
  return createActiveUser(pool, organizationId, true);
}

/**
 * Deterministic barrier: pauses every query matching `statement` on clients
 * handed out by this pool until the test releases it. Proves the exact
 * interleaving without sleeps:
 *
 * - barrier on the issuance `FOR UPDATE` statement: the login has verified the
 *   old credential and is paused before acquiring the user row lock;
 * - barrier on the issuance `INSERT INTO sessions` statement: the login holds
 *   the user row lock and is paused before inserting the session.
 */
function attachStatementBarrier(pool: Pool, statement: string): {
  release: () => void;
  waitForArrival: () => Promise<void>;
} {
  let fireArrival!: () => void;
  const arrival = new Promise<void>((resolve) => {
    fireArrival = resolve;
  });
  let releaseBarrier!: () => void;
  const released = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });

  function wrapClient(client: unknown): unknown {
    const originalQuery = (client as { query: (...args: unknown[]) => unknown }).query
      .bind(client);
    (client as { query: (...args: unknown[]) => unknown }).query = (...queryArgs: unknown[]) => {
      const text = typeof queryArgs[0] === 'string'
        ? queryArgs[0]
        : (queryArgs[0] as { text?: string } | undefined)?.text;
      if (text?.includes(statement)) {
        fireArrival();
        return Promise.resolve(released).then(() => originalQuery(...queryArgs));
      }
      return originalQuery(...queryArgs);
    };
    return client;
  }

  const originalConnect = pool.connect.bind(pool);
  pool.connect = (...args: unknown[]) => {
    const last = args[args.length - 1];
    if (typeof last === 'function') {
      const callback = args.pop() as (
        err: Error | null,
        client?: unknown,
        releaseFn?: () => void,
      ) => void;
      originalConnect(...args, (err, client, releaseFn) => {
        if (err || !client) return callback(err, client, releaseFn);
        callback(null, wrapClient(client), releaseFn);
      });
      return;
    }
    return originalConnect(...args).then((client) => wrapClient(client));
  };

  return { release: releaseBarrier, waitForArrival: () => arrival };
}

const OFFBOARDING_DEACTIVATE_SQL = `
  UPDATE users
  SET is_active = FALSE, version = version + 1, updated_at = NOW()
  WHERE organization_id = $1 AND id = $2 AND is_active = TRUE`;

const REVOKE_ALL_SESSIONS_SQL = `
  UPDATE sessions SET revoked_at = COALESCE(revoked_at, NOW()) WHERE user_id = $1`;

function itSlow(name: string, fn: () => Promise<void>): void {
  it(name, fn, 30_000);
}

describe.runIf(Boolean(databaseUrl))('B1 session-issuance race on real PostgreSQL', () => {
  itSlow(
    'password change committing before issuance blocks the stale-credential login from creating a session',
    async () => {
      await withMigratedDatabase(async (pool) => {
        const { userId, email } = await createFixture(pool);
        const { release, waitForArrival } = attachStatementBarrier(pool, 'FOR UPDATE');
        const service = new AuthService(new PostgresAuthRepository(pool), 28_800);

        const pendingLogin = service.login(email, 'correct-password');
        await waitForArrival();

        await service.changePassword(userId, 'correct-password', 'new-secure-password');

        release();
        await expect(pendingLogin).rejects.toMatchObject({
          code: 'INVALID_CREDENTIALS',
          statusCode: 401,
        });

        const sessions = await pool.query(
          'SELECT * FROM sessions WHERE user_id = $1',
          [userId],
        );
        expect(sessions.rows).toHaveLength(0);
      });
    },
  );

  itSlow(
    'issuance winning the user row lock first still loses its session to the subsequent password-change revocation',
    async () => {
      await withMigratedDatabase(async (pool) => {
        const { userId, email } = await createFixture(pool);
        const { release, waitForArrival } = attachStatementBarrier(pool, 'INSERT INTO sessions');
        const service = new AuthService(new PostgresAuthRepository(pool), 28_800);

        const pendingLogin = service.login(email, 'correct-password');
        await waitForArrival();

        const pendingChange = service.changePassword(
          userId,
          'correct-password',
          'new-secure-password',
        );

        release();
        const login = await pendingLogin;
        await expect(pendingChange).resolves.toBeUndefined();

        await expect(service.authenticateSession(login.rawToken))
          .rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
        await expect(service.login(email, 'correct-password'))
          .rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
        await expect(service.login(email, 'new-secure-password')).resolves.toBeDefined();

        const sessions = await pool.query(
          'SELECT revoked_at FROM sessions WHERE user_id = $1',
          [userId],
        );
        expect(sessions.rows).toHaveLength(2);
        expect(sessions.rows.filter((row) => row.revoked_at !== null)).toHaveLength(1);
      });
    },
  );

  itSlow(
    'deactivation committing before issuance blocks session creation for the already-verified login',
    async () => {
      await withMigratedDatabase(async (pool) => {
        const { organizationId, userId, email } = await createFixture(pool);
        const { release, waitForArrival } = attachStatementBarrier(pool, 'FOR UPDATE');
        const service = new AuthService(new PostgresAuthRepository(pool), 28_800);

        const pendingLogin = service.login(email, 'correct-password');
        await waitForArrival();

        await pool.query(OFFBOARDING_DEACTIVATE_SQL, [organizationId, userId]);

        release();
        await expect(pendingLogin).rejects.toMatchObject({
          code: 'INVALID_CREDENTIALS',
          statusCode: 401,
        });

        const sessions = await pool.query(
          'SELECT * FROM sessions WHERE user_id = $1',
          [userId],
        );
        expect(sessions.rows).toHaveLength(0);
      });
    },
  );

  itSlow(
    'a session issued before deactivation is revoked by the subsequent offboarding revocation',
    async () => {
      await withMigratedDatabase(async (pool) => {
        const { organizationId, userId, email } = await createFixture(pool);
        const { release, waitForArrival } = attachStatementBarrier(pool, 'INSERT INTO sessions');
        const service = new AuthService(new PostgresAuthRepository(pool), 28_800);

        const pendingLogin = service.login(email, 'correct-password');
        await waitForArrival();
        release();
        const login = await pendingLogin;
        await expect(service.authenticateSession(login.rawToken)).resolves.toBeDefined();

        await pool.query(OFFBOARDING_DEACTIVATE_SQL, [organizationId, userId]);
        await pool.query(REVOKE_ALL_SESSIONS_SQL, [userId]);

        await expect(service.authenticateSession(login.rawToken))
          .rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
      });
    },
  );

  itSlow(
    'concurrent logins with the same unchanged credential both issue valid sessions',
    async () => {
      await withMigratedDatabase(async (pool) => {
        const { email } = await createFixture(pool);
        const service = new AuthService(new PostgresAuthRepository(pool), 28_800);

        const [first, second] = await Promise.all([
          service.login(email, 'correct-password'),
          service.login(email, 'correct-password'),
        ]);

        await expect(service.authenticateSession(first.rawToken)).resolves.toBeDefined();
        await expect(service.authenticateSession(second.rawToken)).resolves.toBeDefined();

        const sessions = await pool.query<{ c: number }>(
          'SELECT COUNT(*)::int AS c FROM sessions',
        );
        expect(sessions.rows[0]!.c).toBe(2);
      });
    },
  );

  itSlow(
    'auth regression matrix on real PostgreSQL: wrong password, logout, expiry, inactive user, password-change conflicts',
    async () => {
      await withMigratedDatabase(async (pool) => {
        const fixture = await createFixture(pool);
        const service = new AuthService(new PostgresAuthRepository(pool), 28_800);
        const repository = new PostgresAuthRepository(pool);

        await expect(service.login(fixture.email, 'wrong-password'))
          .rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', statusCode: 401 });

        const login = await service.login(fixture.email, 'correct-password');
        await service.logout(login.rawToken);
        await expect(service.authenticateSession(login.rawToken))
          .rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

        const secondLogin = await service.login(fixture.email, 'correct-password');
        await expect(service.authenticateSession(secondLogin.rawToken)).resolves.toBeDefined();
        await pool.query(
          `INSERT INTO sessions (user_id, token_hash, expires_at, created_at)
           VALUES ($1, $2, NOW() - INTERVAL '1 second', NOW() - INTERVAL '1 hour')`,
          [fixture.userId, hashSessionToken('expired-raw-token')],
        );
        await expect(service.authenticateSession('expired-raw-token'))
          .rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

        const inactiveUser = await createActiveUser(pool, fixture.organizationId, false);
        await expect(service.login(inactiveUser.email, 'correct-password'))
          .rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', statusCode: 401 });

        await expect(service.changePassword(fixture.userId, 'wrong-password', 'new-secure-password'))
          .rejects.toMatchObject({ code: 'INVALID_CURRENT_PASSWORD', statusCode: 400 });

        await expect(service.changePassword(randomUUID(), 'correct-password', 'new-secure-password'))
          .rejects.toMatchObject({ code: 'INVALID_CURRENT_PASSWORD', statusCode: 400 });

        await expect(service.changePassword(fixture.userId, 'correct-password', 'new-secure-password'))
          .resolves.toBeUndefined();

        await expect(service.login(fixture.email, 'correct-password'))
          .rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
        const renewed = await service.login(fixture.email, 'new-secure-password');
        await expect(service.authenticateSession(renewed.rawToken)).resolves.toBeDefined();

        await expect(repository.createSessionIfCredentialCurrent({
          userId: fixture.userId,
          expectedPasswordHash: 'stale-credential-hash',
          tokenHash: hashSessionToken('stale-attempt'),
          expiresAt: new Date(Date.now() + 60_000),
        })).resolves.toBeNull();
      });
    },
  );
});
