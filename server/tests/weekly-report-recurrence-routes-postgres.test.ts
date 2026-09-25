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
import { JobCardService } from '../src/modules/job-cards/service.js';
import { PostgresWeeklyReportRecurrenceRepository } from '../src/modules/weekly-reports/recurrence-repository.js';
import { WeeklyReportRecurrenceService } from '../src/modules/weekly-reports/recurrence-service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const NOW = '2026-10-05T09:00:00.000Z';
const MONDAY = '2026-10-05';

const config = {
  nodeEnv: 'test' as const,
  host: '127.0.0.1',
  port: 0,
  databaseUrl: databaseUrl ?? 'postgresql://unused-r5a',
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
}

async function withSchema(run: (pool: Pool) => Promise<void>): Promise<void> {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `wr5a_${randomUUID().replaceAll('-', '')}`;
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

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

async function createApp(pool: Pool, organizationId: string, role: UserRole, userId: string) {
  const authRepository = new MemoryAuthRepository({
    id: userId, organizationId, name: role, email: `${userId}@example.com`,
    passwordHash: await hashPassword('correct-password'), role,
    mustChangePassword: false, isActive: true, version: 1,
  });
  const jobCardRepository = new PostgresJobCardRepository(pool);
  const jobCardService = new JobCardService(
    jobCardRepository,
    () => new Date(NOW),
    { publish: () => {} },
    { enabled: false },
    { enabled: false },
    { enabled: false, reminderLeadMinutes: 30 },
  );
  const app = await buildApp(config, {
    authRepository,
    jobCardRepository,
    weeklyReportRecurrenceService: new WeeklyReportRecurrenceService(
      new PostgresWeeklyReportRecurrenceRepository(pool),
      pool,
      jobCardService,
      () => new Date(NOW),
    ),
  });
  apps.push(app);
  const login = await app.inject({
    method: 'POST', url: '/api/auth/login',
    payload: { email: authRepository.user.email, password: 'correct-password' },
  });
  return { app, cookie: login.headers['set-cookie'] as string };
}

async function seedOrg(pool: Pool): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO organizations (name, timezone) VALUES ($1, 'Europe/Istanbul') RETURNING id`,
    [`WR5A ${randomUUID()}`],
  )).rows[0]!.id;
}

async function seedUser(pool: Pool, organizationId: string, role: UserRole): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role)
     VALUES ($1, $2, $3, 'h', $4) RETURNING id`,
    [organizationId, `${role} ${randomUUID()}`, `${randomUUID()}@t.local`, role],
  )).rows[0]!.id;
}

describe.skipIf(!databaseUrl)('weekly report recurrence HTTP routes', () => {
  it('registers the exact recurrence route surface', async () => {
    await withSchema(async (pool) => {
      const organizationId = await seedOrg(pool);
      const managerId = await seedUser(pool, organizationId, 'MANAGER');
      const staffId = await seedUser(pool, organizationId, 'STAFF');
      const { app, cookie } = await createApp(pool, organizationId, 'MANAGER', managerId);
      const created = await app.inject({
        method: 'POST', url: '/api/job-cards/weekly-reports/recurrences/bulk',
        headers: { cookie },
        payload: { clientActionId: randomUUID(), staffUserIds: [staffId], startPeriodStart: MONDAY },
      });
      expect(created.statusCode).toBe(201);
      const id = created.json().items[0].recurrenceId as string;
      const surface = [
        ['GET', '/api/job-cards/weekly-reports/recurrences', undefined],
        ['PUT', `/api/job-cards/weekly-reports/recurrences/${id}/template`, {
          clientActionId: randomUUID(), expectedVersion: 1, questions: [], instructions: null,
        }],
        ['POST', `/api/job-cards/weekly-reports/recurrences/${id}/pause`, {
          clientActionId: randomUUID(), expectedVersion: 1,
        }],
      ] as const;
      for (const [method, url, payload] of surface) {
        const response = await app.inject({ method, url, payload, headers: { cookie } });
        expect(response.statusCode, `${method} ${url}`).not.toBe(404);
      }
      // Resume must be exercised after the pause above (version is now 2).
      const resume = await app.inject({
        method: 'POST', url: `/api/job-cards/weekly-reports/recurrences/${id}/resume`,
        headers: { cookie }, payload: { clientActionId: randomUUID(), expectedVersion: 2 },
      });
      expect(resume.statusCode).toBe(200);
    });
  });

  it('requires authentication', async () => {
    await withSchema(async (pool) => {
      const organizationId = await seedOrg(pool);
      const managerId = await seedUser(pool, organizationId, 'MANAGER');
      const { app } = await createApp(pool, organizationId, 'MANAGER', managerId);
      const response = await app.inject({
        method: 'GET', url: '/api/job-cards/weekly-reports/recurrences',
      });
      expect(response.statusCode).toBe(401);
    });
  });

  it('forbids STAFF on every recurrence endpoint', async () => {
    await withSchema(async (pool) => {
      const organizationId = await seedOrg(pool);
      const staffId = await seedUser(pool, organizationId, 'STAFF');
      const { app, cookie } = await createApp(pool, organizationId, 'STAFF', staffId);
      const id = randomUUID();
      const attempts = [
        ['POST', '/api/job-cards/weekly-reports/recurrences/bulk', {
          clientActionId: randomUUID(), staffUserIds: [staffId], startPeriodStart: MONDAY,
        }],
        ['GET', '/api/job-cards/weekly-reports/recurrences', undefined],
        ['PUT', `/api/job-cards/weekly-reports/recurrences/${id}/template`, {
          clientActionId: randomUUID(), expectedVersion: 1, questions: [], instructions: null,
        }],
        ['POST', `/api/job-cards/weekly-reports/recurrences/${id}/pause`, {
          clientActionId: randomUUID(), expectedVersion: 1,
        }],
        ['POST', `/api/job-cards/weekly-reports/recurrences/${id}/resume`, {
          clientActionId: randomUUID(), expectedVersion: 1,
        }],
      ] as const;
      for (const [method, url, payload] of attempts) {
        const response = await app.inject({ method, url, payload, headers: { cookie } });
        expect(response.statusCode, `${method} ${url}`).toBe(403);
        expect(response.json()).toMatchObject({ code: 'FORBIDDEN' });
      }
      const rules = await pool.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM weekly_report_recurrences`,
      );
      expect(rules.rows[0]!.n).toBe(0);
    });
  });

  it('lets a MANAGER run the full create, list, template, pause and resume flow', async () => {
    await withSchema(async (pool) => {
      const organizationId = await seedOrg(pool);
      const managerId = await seedUser(pool, organizationId, 'MANAGER');
      const staffId = await seedUser(pool, organizationId, 'STAFF');
      const { app, cookie } = await createApp(pool, organizationId, 'MANAGER', managerId);

      const created = await app.inject({
        method: 'POST', url: '/api/job-cards/weekly-reports/recurrences/bulk',
        headers: { cookie },
        payload: {
          clientActionId: randomUUID(), staffUserIds: [staffId], startPeriodStart: MONDAY,
          questions: [{ key: 'q1', prompt: 'Bu hafta ne yaptın?' }], instructions: 'Detay ver',
        },
      });
      expect(created.statusCode).toBe(201);
      const recurrenceId = created.json().items[0].recurrenceId as string;
      expect(created.json().items[0]).toMatchObject({
        outcome: 'created', enabled: true, nextPeriodStart: MONDAY, version: 1,
      });

      const list = await app.inject({
        method: 'GET', url: '/api/job-cards/weekly-reports/recurrences', headers: { cookie },
      });
      expect(list.statusCode).toBe(200);
      expect(list.json().items).toHaveLength(1);
      expect(list.json().items[0]).toMatchObject({
        id: recurrenceId, staffUserId: staffId, enabled: true, disabledReason: null,
        nextPeriodStart: MONDAY, version: 1, lastOutcome: null,
      });
      // Lease/retry internals are never exposed.
      expect(list.json().items[0]).not.toHaveProperty('leaseToken');
      expect(list.json().items[0]).not.toHaveProperty('nextAttemptAt');
      expect(list.json().items[0]).not.toHaveProperty('failureCount');

      const template = await app.inject({
        method: 'PUT', url: `/api/job-cards/weekly-reports/recurrences/${recurrenceId}/template`,
        headers: { cookie },
        payload: {
          clientActionId: randomUUID(), expectedVersion: 1,
          questions: [], instructions: 'Yeni talimat',
        },
      });
      expect(template.statusCode).toBe(200);
      expect(template.json()).toMatchObject({ version: 2, instructions: 'Yeni talimat', questions: [] });

      const paused = await app.inject({
        method: 'POST', url: `/api/job-cards/weekly-reports/recurrences/${recurrenceId}/pause`,
        headers: { cookie }, payload: { clientActionId: randomUUID(), expectedVersion: 2 },
      });
      expect(paused.statusCode).toBe(200);
      expect(paused.json()).toMatchObject({ enabled: false, disabledReason: 'MANUAL', version: 3 });

      const resumed = await app.inject({
        method: 'POST', url: `/api/job-cards/weekly-reports/recurrences/${recurrenceId}/resume`,
        headers: { cookie }, payload: { clientActionId: randomUUID(), expectedVersion: 3 },
      });
      expect(resumed.statusCode).toBe(200);
      expect(resumed.json()).toMatchObject({ enabled: true, nextPeriodStart: MONDAY, version: 4 });
    });
  });

  it('rejects unknown fields and a non-Monday start week with 400', async () => {
    await withSchema(async (pool) => {
      const organizationId = await seedOrg(pool);
      const managerId = await seedUser(pool, organizationId, 'MANAGER');
      const staffId = await seedUser(pool, organizationId, 'STAFF');
      const { app, cookie } = await createApp(pool, organizationId, 'MANAGER', managerId);

      const unknownField = await app.inject({
        method: 'POST', url: '/api/job-cards/weekly-reports/recurrences/bulk',
        headers: { cookie },
        payload: {
          clientActionId: randomUUID(), staffUserIds: [staffId], startPeriodStart: MONDAY,
          dueDate: MONDAY,
        },
      });
      expect(unknownField.statusCode).toBe(400);

      const nonMonday = await app.inject({
        method: 'POST', url: '/api/job-cards/weekly-reports/recurrences/bulk',
        headers: { cookie },
        payload: {
          clientActionId: randomUUID(), staffUserIds: [staffId], startPeriodStart: '2026-10-06',
        },
      });
      expect(nonMonday.statusCode).toBe(400);

      const rules = await pool.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM weekly_report_recurrences`,
      );
      expect(rules.rows[0]!.n).toBe(0);
    });
  });

  it('conceals a cross-tenant recurrence id as 404', async () => {
    await withSchema(async (pool) => {
      const organizationA = await seedOrg(pool);
      const organizationB = await seedOrg(pool);
      const managerA = await seedUser(pool, organizationA, 'MANAGER');
      const managerB = await seedUser(pool, organizationB, 'MANAGER');
      const staffB = await seedUser(pool, organizationB, 'STAFF');
      const appB = await createApp(pool, organizationB, 'MANAGER', managerB);
      const created = await appB.app.inject({
        method: 'POST', url: '/api/job-cards/weekly-reports/recurrences/bulk',
        headers: { cookie: appB.cookie },
        payload: { clientActionId: randomUUID(), staffUserIds: [staffB], startPeriodStart: MONDAY },
      });
      const foreignId = created.json().items[0].recurrenceId as string;

      const appA = await createApp(pool, organizationA, 'MANAGER', managerA);
      const response = await appA.app.inject({
        method: 'POST', url: `/api/job-cards/weekly-reports/recurrences/${foreignId}/pause`,
        headers: { cookie: appA.cookie },
        payload: { clientActionId: randomUUID(), expectedVersion: 1 },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: 'WEEKLY_REPORT_RECURRENCE_NOT_FOUND' });
    });
  });
});
