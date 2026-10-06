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
import { PostgresCrmRepository } from '../src/modules/crm/repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

const config = {
  nodeEnv: 'test' as const,
  host: '127.0.0.1',
  port: 0,
  databaseUrl: databaseUrl ?? 'postgresql://unused-cpc',
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
  const schema = `cpc_${randomUUID().replaceAll('-', '')}`;
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
  const app = await buildApp(config, {
    authRepository,
    crmRepository: new PostgresCrmRepository(pool),
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
    [`CPC ${randomUUID()}`],
  )).rows[0]!.id;
}

async function seedUser(pool: Pool, organizationId: string, role: UserRole): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role)
     VALUES ($1, $2, $3, 'h', $4) RETURNING id`,
    [organizationId, `${role} ${randomUUID()}`, `${randomUUID()}@t.local`, role],
  )).rows[0]!.id;
}

async function seedLegacyCustomer(
  pool: Pool, organizationId: string, phone: string | null,
): Promise<{ id: string; version: number }> {
  const row = await pool.query<{ id: string; version: number }>(
    `INSERT INTO customers (organization_id, name, customer_type, phone, status)
     VALUES ($1, $2, 'clinic', $3, 'active') RETURNING id, version`,
    [organizationId, `Eski Klinik ${randomUUID()}`, phone],
  );
  return row.rows[0]!;
}

async function customerCount(pool: Pool, organizationId: string): Promise<number> {
  const row = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM customers WHERE organization_id = $1`, [organizationId]);
  return row.rows[0]!.count;
}

describe.skipIf(!databaseUrl)('customer phone create contract over HTTP + PostgreSQL', () => {
  it('stores one canonical +90 value for every accepted Turkish shape', async () => {
    await withSchema(async (pool) => {
      const organizationId = await seedOrg(pool);
      const managerId = await seedUser(pool, organizationId, 'MANAGER');
      const { app, cookie } = await createApp(pool, organizationId, 'MANAGER', managerId);
      const cases: [string, string][] = [
        ['05321234567', '+905321234567'],
        ['(0532) 123 45 67', '+905321234567'],
        ['0532 123 45 67', '+905321234567'],
        ['+905321234567', '+905321234567'],
        ['905321234567', '+905321234567'],
        ['5321234567', '+905321234567'],
        ['03121234567', '+903121234567'],
        ['(0312) 123 45 67', '+903121234567'],
        ['+903121234567', '+903121234567'],
        ['08501234567', '+908501234567'],
      ];
      for (const [phone, canonical] of cases) {
        const response = await app.inject({
          method: 'POST', url: '/api/customers', headers: { cookie },
          payload: { name: `Klinik ${randomUUID()}`, customerType: 'clinic', phone },
        });
        expect(response.statusCode, phone).toBe(201);
        const created = response.json() as { id: string; phone: string | null };
        expect(created.phone, phone).toBe(canonical);
        const stored = await pool.query<{ phone: string | null }>(
          `SELECT phone FROM customers WHERE id = $1`, [created.id]);
        expect(stored.rows[0]!.phone, phone).toBe(canonical);
      }
    });
  }, 15_000);

  it('rejects a missing or malformed phone with fieldErrors and writes nothing', async () => {
    await withSchema(async (pool) => {
      const organizationId = await seedOrg(pool);
      const managerId = await seedUser(pool, organizationId, 'MANAGER');
      const { app, cookie } = await createApp(pool, organizationId, 'MANAGER', managerId);
      const before = await customerCount(pool, organizationId);
      const rejected: (string | undefined)[] = [
        undefined, '', '   ', '0', '0532', '0532123456', '053212345678', 'abc',
        '0532x1234567', '90+5321234567', '---',
        '+1 202 555 0147', '+49 151 12345678', '+9005321234567', '+9003121234567',
        '+3572212345', '+15551234567', '+495551234567',
        '+900532123456', '900532123456', '+900312123456', '900312123456', '+900850123456',
      ];
      for (const phone of rejected) {
        const payload: Record<string, unknown> = {
          name: `Ret ${randomUUID()}`, customerType: 'clinic',
        };
        if (phone !== undefined) payload.phone = phone;
        const response = await app.inject({
          method: 'POST', url: '/api/customers', headers: { cookie }, payload,
        });
        expect(response.statusCode, String(phone)).toBe(400);
        const body = response.json() as {
          code: string; details?: { fieldErrors?: Record<string, string> };
        };
        expect(body.code, String(phone)).toBe('VALIDATION_ERROR');
        expect(body.details?.fieldErrors?.phone, String(phone))
          .toBe('Geçerli bir telefon numarası girin.');
      }
      expect(await customerCount(pool, organizationId)).toBe(before);
    });
  }, 15_000);

  it('keeps the column nullable so a phone-less historical customer still edits', async () => {
    await withSchema(async (pool) => {
      const organizationId = await seedOrg(pool);
      const managerId = await seedUser(pool, organizationId, 'MANAGER');
      const { app, cookie } = await createApp(pool, organizationId, 'MANAGER', managerId);
      const legacy = await seedLegacyCustomer(pool, organizationId, null);

      const patched = await app.inject({
        method: 'PATCH', url: `/api/customers/${legacy.id}`, headers: { cookie },
        payload: {
          expectedVersion: legacy.version, name: 'Yeniden Adlandırılmış Klinik',
          customerType: 'clinic', taxNumber: null, phone: null, email: null,
          city: null, district: null, address: null, assignedStaffUserId: null,
        },
      });
      expect(patched.statusCode).toBe(200);
      expect((patched.json() as { phone: string | null }).phone).toBeNull();
      const stored = await pool.query<{ phone: string | null }>(
        `SELECT phone FROM customers WHERE id = $1`, [legacy.id]);
      expect(stored.rows[0]!.phone).toBeNull();
    });
  });

  it('normalizes a supplied edit phone but preserves unresolvable historical text', async () => {
    await withSchema(async (pool) => {
      const organizationId = await seedOrg(pool);
      const managerId = await seedUser(pool, organizationId, 'MANAGER');
      const { app, cookie } = await createApp(pool, organizationId, 'MANAGER', managerId);

      const normalized = await seedLegacyCustomer(pool, organizationId, '555');
      const first = await app.inject({
        method: 'PATCH', url: `/api/customers/${normalized.id}`, headers: { cookie },
        payload: {
          expectedVersion: normalized.version, name: 'Güncel Klinik', customerType: 'clinic',
          taxNumber: null, phone: '0532 123 45 67', email: null, city: null, district: null,
          address: null, assignedStaffUserId: null,
        },
      });
      expect(first.statusCode).toBe(200);
      expect((first.json() as { phone: string | null }).phone).toBe('+905321234567');

      const legacy = await seedLegacyCustomer(pool, organizationId, '555');
      const second = await app.inject({
        method: 'PATCH', url: `/api/customers/${legacy.id}`, headers: { cookie },
        payload: {
          expectedVersion: legacy.version, name: 'Eski Klinik', customerType: 'clinic',
          taxNumber: null, phone: '555', email: null, city: null, district: null,
          address: null, assignedStaffUserId: null,
        },
      });
      expect(second.statusCode).toBe(200);
      expect((second.json() as { phone: string | null }).phone).toBe('555');
    });
  });

  it('still finds a canonical customer through the phone search variants', async () => {
    await withSchema(async (pool) => {
      const organizationId = await seedOrg(pool);
      const managerId = await seedUser(pool, organizationId, 'MANAGER');
      const { app, cookie } = await createApp(pool, organizationId, 'MANAGER', managerId);
      const name = `Aranabilir Klinik ${randomUUID()}`;
      const created = await app.inject({
        method: 'POST', url: '/api/customers', headers: { cookie },
        payload: { name, customerType: 'clinic', phone: '0532 123 45 67' },
      });
      expect(created.statusCode).toBe(201);

      for (const q of ['0532 123 45 67', '05321234567', '+905321234567', '532 123 45 67']) {
        const search = await app.inject({
          method: 'GET', url: `/api/customers?q=${encodeURIComponent(q)}`, headers: { cookie },
        });
        expect(search.statusCode, q).toBe(200);
        const items = (search.json() as { items: { id: string }[] }).items;
        expect(items.map((item) => item.id), q).toContain((created.json() as { id: string }).id);
      }
    });
  });
});
