import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { hashPassword } from '../src/modules/auth/crypto.js';
import type { AuthRepository } from '../src/modules/auth/repository.js';
import type { AuthUserRecord, SessionRecord, UserRole } from '../src/modules/auth/types.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const WEEK_A = '2026-10-05';
const NOW = '2026-10-05T09:00:00.000Z';

const config = {
  nodeEnv: 'test' as const,
  host: '127.0.0.1',
  port: 0,
  databaseUrl: databaseUrl ?? 'postgresql://unused-wrret1',
  logLevel: 'silent',
  corsOrigin: 'http://127.0.0.1:5173',
  sessionTtlSeconds: 28_800,
  loginRateLimitMax: 100,
  rateLimitWindowMs: 60_000,
  trustedProxy: 'loopback' as const,
  healthSchemaVersion: null,
  releaseSha: 'dev',
  actionScopedGeolocationEnabled: false,
  reverseGeocoderProvider: null,
  googleGeocodingApiKey: null,
  reverseGeocoderTimeoutMs: 2_000,
  geocodingUserDailyLimit: 15,
  geocodingOrganizationDailyLimit: 250,
  geocodingGlobalMonthlyLimit: 8_000,
  webPush: { enabled: false, vapidSubject: null, vapidPublicKey: null, vapidPrivateKey: null },
};

class MemoryAuthRepository implements AuthRepository {
  sessions: SessionRecord[] = [];

  constructor(readonly user: AuthUserRecord) {}

  async findUserByEmail(email: string) { return this.user.email === email ? this.user : null; }
  async findUserById(id: string) { return this.user.id === id ? this.user : null; }
  async createSessionIfCredentialCurrent(
    input: Omit<SessionRecord, 'id' | 'revokedAt'> & { expectedPasswordHash: string },
  ) {
    if (input.userId !== this.user.id || !this.user.isActive
      || input.expectedPasswordHash !== this.user.passwordHash) return null;
    const session: SessionRecord = {
      id: `session-${this.sessions.length + 1}`, userId: input.userId,
      tokenHash: input.tokenHash, expiresAt: input.expiresAt, revokedAt: null,
    };
    this.sessions.push(session);
    return session;
  }
  async findSessionWithUser(hash: string) {
    const session = this.sessions.find((item) => item.tokenHash === hash);
    return session ? { session, user: this.user } : null;
  }
  async revokeSession(hash: string, at: Date) {
    const session = this.sessions.find((item) => item.tokenHash === hash);
    if (session) session.revokedAt = at;
  }
  async updatePasswordAndRevokeSessions() { return false; }
  async upgradePasswordHashIfCurrent(): Promise<'updated' | 'conflict'> {
    return 'conflict';
  }
}

async function withSchema(run: (pool: Pool) => Promise<void>): Promise<void> {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `wrret1_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool | null = null;
  try {
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema},public`,
    });
    await runMigrations({
      migrationsDirectory: MIGRATIONS_DIRECTORY,
      store: new PostgresMigrationStore(pool),
    });
    await run(pool);
  } finally {
    await pool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }
}

async function insertOrg(pool: Pool): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO organizations (name, timezone) VALUES ($1, 'Europe/Istanbul') RETURNING id`,
    [`WR-RET1 ${randomUUID()}`],
  )).rows[0]!.id;
}

async function insertUser(
  pool: Pool,
  organizationId: string,
  role: UserRole,
): Promise<{ id: string }> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO users (
       organization_id, name, email, password_hash, role, is_active, data_class
     ) VALUES ($1, $2, $3, 'test-hash', $4, TRUE, 'BUSINESS') RETURNING id`,
    [organizationId, `WR-RET1 ${role} ${randomUUID()}`, `${randomUUID()}@test.local`, role],
  )).rows[0]!;
}

async function insertRule(
  pool: Pool,
  input: { organizationId: string; staffUserId: string; requestedByUserId: string },
): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO weekly_report_recurrences
       (organization_id, staff_user_id, requested_by_user_id, next_period_start,
        manager_questions, instructions, next_attempt_at)
     VALUES ($1, $2, $3, $4, '[]', NULL, NOW() - INTERVAL '1 second')
     RETURNING id`,
    [input.organizationId, input.staffUserId, input.requestedByUserId, WEEK_A],
  )).rows[0]!.id;
}

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe.skipIf(!databaseUrl)('WeeklyReport recurrence retirement (PostgreSQL)', () => {
  it('starts without a recurrence writer, exposes no recurrence route and leaves legacy rows untouched', async () => {
    await withSchema(async (pool) => {
      const organizationId = await insertOrg(pool);
      const manager = await insertUser(pool, organizationId, 'MANAGER');
      const staff = await insertUser(pool, organizationId, 'STAFF');
      const ruleId = await insertRule(pool, {
        organizationId, staffUserId: staff.id, requestedByUserId: manager.id,
      });
      const before = (await pool.query(
        `SELECT enabled, disabled_reason, next_period_start::text AS next_period_start,
                version, last_outcome, last_processed_period_start
           FROM weekly_report_recurrences WHERE id = $1`,
        [ruleId],
      )).rows[0];

      // Production-shaped wiring only: the successful retirement injects no
      // recurrence service, route plugin or worker.
      const app = await buildApp(config, {
        authRepository: new MemoryAuthRepository({
          id: manager.id, organizationId, name: 'manager', email: 'ret1@example.com',
          passwordHash: await hashPassword('correct-password'), role: 'MANAGER',
          mustChangePassword: false, isActive: true, version: 1,
        }),
        jobCardRepository: new PostgresJobCardRepository(pool),
      });
      apps.push(app);
      await app.ready();

      // The canonical prefix is registered and guarded; the recurrence paths
      // are absent rather than merely unauthorized.
      const guarded = await app.inject({ method: 'POST', url: '/api/job-cards/weekly-reports' });
      expect(guarded.statusCode).toBe(401);
      for (const request of [
        { method: 'GET' as const, url: '/api/job-cards/weekly-reports/recurrences' },
        { method: 'POST' as const, url: '/api/job-cards/weekly-reports/recurrences/bulk' },
        { method: 'PUT' as const, url: `/api/job-cards/weekly-reports/recurrences/${ruleId}/template` },
        { method: 'POST' as const, url: `/api/job-cards/weekly-reports/recurrences/${ruleId}/pause` },
        { method: 'POST' as const, url: `/api/job-cards/weekly-reports/recurrences/${ruleId}/resume` },
      ]) {
        const response = await app.inject(request);
        expect(response.statusCode).toBe(404);
      }

      // The old worker's first tick was immediate. Give a reintroduced worker
      // well past that window before proving nothing was produced.
      await new Promise((resolve) => setTimeout(resolve, 1_500));

      await expect(pool.query(`SELECT id FROM weekly_reports WHERE organization_id = $1`, [organizationId]))
        .resolves.toMatchObject({ rows: [] });
      await expect(pool.query(`SELECT id FROM job_cards WHERE organization_id = $1`, [organizationId]))
        .resolves.toMatchObject({ rows: [] });
      await expect(pool.query(
        `SELECT enabled, disabled_reason, next_period_start::text AS next_period_start,
                version, last_outcome, last_processed_period_start
           FROM weekly_report_recurrences WHERE id = $1`,
        [ruleId],
      )).resolves.toMatchObject({ rows: [before] });

      await expect(app.close()).resolves.toBeUndefined();
      apps.splice(apps.indexOf(app), 1);
    });
  });
});
