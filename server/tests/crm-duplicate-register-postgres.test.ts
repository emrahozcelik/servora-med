import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { AppError, toErrorResponse } from '../src/errors/index.js';
import { parseDuplicateKeyring } from '../src/modules/crm/duplicate-evidence.js';
import { PostgresDuplicateReadRepository } from '../src/modules/crm/duplicate-repository.js';
import { DuplicateRegisterService } from '../src/modules/crm/duplicate-register-service.js';
import { PostgresDuplicateReviewRepository } from '../src/modules/crm/duplicate-review-repository.js';
import { DuplicateReviewService } from '../src/modules/crm/duplicate-review-service.js';
import { duplicateRoutes } from '../src/modules/crm/duplicate-routes.js';
import { DuplicateComparisonService } from '../src/modules/crm/duplicate-service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const admin = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const schema = `dupreg_${randomUUID().replaceAll('-', '')}`;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` }) : null;
const keys = parseDuplicateKeyring(JSON.stringify({ activeKeyId: 'synthetic', keys: { synthetic: Buffer.alloc(32, 13).toString('base64') } }));
let app: FastifyInstance;
let org: string;
let actor: string;
let a: string;
let b: string;

type RegisterItem = {
  reviewId: string; sourceAvailability: string; comparisonStatus: string;
  customerA: { id: string } | null; customerB: { id: string } | null;
  matchingCodes: string[]; warnings: string[];
  review: { reviewStatus: string; effectiveStatus: string; freshness: string; freshnessReason: string | null; currentDecision: { status: string } | null };
};
type RegisterPage = { items: RegisterItem[]; page: { nextCursor: string | null; exhausted: boolean; evaluatedReviews: number; returnedItems: number } };

async function createActor(role = 'MANAGER', organizationId = org) {
  const id = randomUUID();
  await pool!.query(
    `INSERT INTO users(id,organization_id,name,email,password_hash,role)
     VALUES($1,$2,'Synthetic manager',$3,'unused',$4)`,
    [id, organizationId, `${id}@example.invalid`, role],
  );
  return id;
}

async function createCustomers(first: string, second: string) {
  await pool!.query(
    `INSERT INTO customers(id,organization_id,name,customer_type,status,data_class,phone,email,city,district,address)
     VALUES($1,$2,'Sentetik Klinik','clinic','active','BUSINESS','+905321234567','test@example.invalid','İstanbul','Merkez','Test adres'),
            ($3,$2,'SENTETİK KLİNİK','clinic','inactive','BUSINESS','(0532) 123 45 67','test@example.invalid','İstanbul','Merkez','Test adres')`,
    [first, org, second],
  );
}

async function register(actorId: string, query = 'view=ALL', role = 'MANAGER') {
  return app.inject({ url: `/api/customers/duplicate-reviews?${query}`, headers: { 'x-test-actor': actorId, 'x-test-role': role } });
}

async function comparison(actorId: string, first: string, second: string) {
  const response = await app.inject({
    url: `/api/customers/duplicate-review-pairs/${first}/${second}`,
    headers: { 'x-test-actor': actorId, 'x-test-role': 'MANAGER' },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as { evidence: { revision: string }; review: { version: number } };
}

async function decide(actorId: string, first: string, second: string, reasonCode = 'DISTINCT_CUSTOMER') {
  const current = await comparison(actorId, first, second);
  const response = await app.inject({
    method: 'POST', url: `/api/customers/duplicate-review-pairs/${first}/${second}/decisions`,
    headers: { 'x-test-actor': actorId, 'x-test-role': 'MANAGER', 'content-type': 'application/json' },
    payload: {
      clientActionId: randomUUID(), expectedReviewVersion: current.review.version,
      expectedEvidenceRevision: current.evidence.revision, matchingRuleVersion: 'crm-duplicate-v1',
      decision: 'DISMISSED', reasonCode,
    },
  });
  expect(response.statusCode, response.body).toBe(200);
}

beforeAll(async () => {
  if (!pool || !admin) return;
  await admin.query(`CREATE SCHEMA ${schema}`);
  await runMigrations({ migrationsDirectory: fileURLToPath(new URL('../src/db/migrations', import.meta.url)), store: new PostgresMigrationStore(pool) });
  app = Fastify();
  await app.register(rateLimit, { global: false });
  app.setErrorHandler((error, _request, reply) => {
    const result = toErrorResponse(error);
    reply.code(result.statusCode).send(result.body);
  });
  await app.register(duplicateRoutes, {
    prefix: '/api',
    service: new DuplicateComparisonService(new PostgresDuplicateReadRepository(pool), keys),
    reviewService: new DuplicateReviewService(new PostgresDuplicateReviewRepository(pool, keys)),
    registerService: new DuplicateRegisterService(new PostgresDuplicateReadRepository(pool), keys),
    authenticate: async (request) => {
      const id = request.headers['x-test-actor'];
      if (typeof id !== 'string') throw new AppError('UNAUTHENTICATED', 401, 'Oturum açın.');
      const owner = await pool!.query<{ organization_id: string }>('SELECT organization_id FROM users WHERE id=$1', [id]);
      request.currentUser = {
        id, organizationId: owner.rows[0]!.organization_id, name: 'Synthetic manager', email: 'test@example.invalid',
        role: request.headers['x-test-role'] as 'MANAGER', mustChangePassword: false, isActive: true, version: 1,
      };
    },
  });
});

beforeEach(async () => {
  if (!pool) return;
  org = randomUUID();
  await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Synthetic org')", [org]);
  a = randomUUID(); b = randomUUID();
  await createCustomers(a, b);
  actor = await createActor();
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
});

it.skipIf(!databaseUrl)('READ-03: a pair that stopped matching survives only in the register, and ATTENTION resurfaces it as stale', async () => {
  await decide(actor, a, b);
  const all = await register(actor, 'view=ALL');
  expect(all.statusCode, all.body).toBe(200);
  const current = all.json() as RegisterPage;
  expect(current.items).toHaveLength(1);
  expect(current.items[0]).toMatchObject({
    sourceAvailability: 'AVAILABLE', comparisonStatus: 'READY',
    review: { reviewStatus: 'DISMISSED', effectiveStatus: 'DISMISSED', freshness: 'CURRENT' },
  });
  expect(current.page).toMatchObject({ nextCursor: null, exhausted: true, returnedItems: 1 });

  const attention = await register(actor, 'view=ATTENTION');
  expect((attention.json() as RegisterPage).items).toHaveLength(0);

  await pool!.query("UPDATE customers SET name='Başka Klinik', phone='+905329999999' WHERE id=$1", [b]);

  const stale = await register(actor, 'view=ATTENTION');
  expect(stale.statusCode, stale.body).toBe(200);
  const stalePage = stale.json() as RegisterPage;
  expect(stalePage.items).toHaveLength(1);
  expect(stalePage.items[0]!.review).toMatchObject({
    reviewStatus: 'DISMISSED', effectiveStatus: 'REVIEW_REQUIRED', freshness: 'STALE', freshnessReason: 'SOURCE_CHANGED',
  });
  expect(stalePage.items[0]!.matchingCodes).toEqual([]);

  const candidates = await app.inject({ url: '/api/customers/duplicate-candidates?view=ALL', headers: { 'x-test-actor': actor, 'x-test-role': 'MANAGER' } });
  expect(candidates.statusCode, candidates.body).toBe(200);
  expect((candidates.json() as { items: unknown[] }).items).toHaveLength(0);
});

it.skipIf(!databaseUrl)('READ-05: a deleted source keeps the safe historical review row without headers', async () => {
  await decide(actor, a, b);
  await pool!.query('DELETE FROM customers WHERE id=$1', [b]);

  const response = await register(actor, 'view=ALL');
  expect(response.statusCode, response.body).toBe(200);
  const page = response.json() as RegisterPage;
  expect(page.items).toHaveLength(1);
  expect(page.items[0]).toMatchObject({
    sourceAvailability: 'UNAVAILABLE', comparisonStatus: 'UNAVAILABLE', customerA: null, customerB: null,
    matchingCodes: [], warnings: [],
    review: { reviewStatus: 'DISMISSED', effectiveStatus: 'UNAVAILABLE', freshness: 'STALE', freshnessReason: 'SOURCE_UNAVAILABLE' },
  });
  expect(page.items[0]!.review.currentDecision).toMatchObject({ status: 'DISMISSED' });
});

it.skipIf(!databaseUrl)('READ-03: register paginates by canonical pair without skipping consumed heads', async () => {
  const pairs: Array<[string, string]> = [];
  for (let index = 0; index < 3; index++) {
    const first = randomUUID(); const second = randomUUID();
    await createCustomers(first, second);
    pairs.push([first, second]);
    await decide(actor, first, second);
  }

  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  for (;;) {
    const query = cursor ? `view=ALL&limit=1&cursor=${encodeURIComponent(cursor)}` : 'view=ALL&limit=1';
    const response = await register(actor, query);
    expect(response.statusCode, response.body).toBe(200);
    const page: RegisterPage = response.json();
    expect(page.page.returnedItems).toBeLessThanOrEqual(1);
    expect(page.page.evaluatedReviews).toBeGreaterThanOrEqual(page.page.returnedItems);
    seen.push(...page.items.map((item) => item.reviewId));
    pages += 1;
    if (page.page.exhausted) { expect(page.page.nextCursor).toBeNull(); break; }
    expect(page.page.nextCursor).not.toBeNull();
    cursor = page.page.nextCursor;
    expect(pages).toBeLessThan(10);
  }
  expect(seen).toHaveLength(3);
  expect(new Set(seen).size).toBe(3);
});

it.skipIf(!databaseUrl)('READ-03/SEC: register is management-only, organization-scoped and rejects foreign cursors', async () => {
  await decide(actor, a, b);
  const staff = await createActor('STAFF');
  expect((await register(staff, 'view=ALL', 'STAFF')).statusCode).toBe(403);

  const foreignOrg = randomUUID();
  await pool!.query("INSERT INTO organizations(id,name) VALUES($1,'Foreign org')", [foreignOrg]);
  const foreignActor = await createActor('MANAGER', foreignOrg);
  const foreign = await register(foreignActor, 'view=ALL');
  expect(foreign.statusCode, foreign.body).toBe(200);
  expect((foreign.json() as RegisterPage).items).toHaveLength(0);

  const firstPage = await register(actor, 'view=ALL&limit=1');
  expect((firstPage.json() as RegisterPage).page.exhausted).toBe(true);

  // A genuine candidate cursor must never be replayable against the register.
  await createCustomers(randomUUID(), randomUUID());
  const candidatesPage = await app.inject({ url: '/api/customers/duplicate-candidates?view=ALL&limit=1', headers: { 'x-test-actor': actor, 'x-test-role': 'MANAGER' } });
  expect(candidatesPage.statusCode, candidatesPage.body).toBe(200);
  const candidateCursor = (candidatesPage.json() as { page: { nextCursor: string | null } }).page.nextCursor;
  expect(candidateCursor).not.toBeNull();
  const crossDomain = await register(actor, `cursor=${encodeURIComponent(candidateCursor!)}`);
  expect(crossDomain.statusCode, crossDomain.body).toBe(400);

  const candidates = await app.inject({ url: '/api/customers/duplicate-candidates?view=ALL&cursor=dr1.abc.def.ghi', headers: { 'x-test-actor': actor, 'x-test-role': 'MANAGER' } });
  expect(candidates.statusCode).toBe(400);
});