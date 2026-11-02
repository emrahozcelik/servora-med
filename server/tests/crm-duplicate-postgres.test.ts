import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { AppError, toErrorResponse } from '../src/errors/index.js';
import { duplicateRoutes } from '../src/modules/crm/duplicate-routes.js';
import { DuplicateComparisonService } from '../src/modules/crm/duplicate-service.js';
import { DUPLICATE_CONTACTS_SQL, PostgresDuplicateReadRepository } from '../src/modules/crm/duplicate-repository.js';
import { parseDuplicateKeyring } from '../src/modules/crm/duplicate-evidence.js';
import { createCandidateIndex } from '../src/modules/crm/duplicate-candidates.js';
import { foldCustomerSearchText, normalizeTaxNumber, normalizeTurkishPhone } from '../src/modules/crm/types.js';

const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const schema = `dup_${randomUUID().replaceAll('-', '')}`;
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public` });
const org = randomUUID(); const foreignOrg = randomUUID(); const actor = randomUUID();
const ids = [1, 2, 3, 4].map((n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const keys = parseDuplicateKeyring(JSON.stringify({ activeKeyId: 'synthetic', keys: { synthetic: Buffer.alloc(32, 9).toString('base64') } }));
let app: FastifyInstance;
let requestActor = actor;
beforeEach(() => { requestActor = randomUUID(); });
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await runMigrations({ migrationsDirectory: fileURLToPath(new URL('../src/db/migrations', import.meta.url)), store: new PostgresMigrationStore(pool) });
  await pool.query("INSERT INTO organizations(id,name) VALUES ($1,'Synthetic'),($2,'Foreign synthetic')", [org, foreignOrg]);
  await pool.query("INSERT INTO users(id,organization_id,name,email,password_hash,role) VALUES($1,$2,'Synthetic','test@example.invalid','unused','ADMIN')", [actor, org]);
  const dataset = randomUUID();
  await pool.query("INSERT INTO demo_datasets(id,organization_id,dataset_key,seed_version,created_by) VALUES($1,$2,'synthetic','v1',$3)", [dataset, org, actor]);
  for (let i = 0; i < 4; i++) await pool.query(`INSERT INTO customers(id,organization_id,name,customer_type,status,data_class,phone,demo_dataset_id)
    VALUES($1,$2,'İstanbul Klinik','clinic',$3,$4,'+905321234567',$5)`, [ids[i], i === 2 ? foreignOrg : org, i === 1 ? 'inactive' : 'prospect', i === 3 ? 'DEMO' : 'BUSINESS', i === 3 ? dataset : null]);
  app = Fastify();
  await app.register(rateLimit, { global: false });
  app.setErrorHandler((error, _request, reply) => { const result = toErrorResponse(error); reply.code(result.statusCode).send(result.body); });
  await app.register(duplicateRoutes, {
    prefix: '/api', service: new DuplicateComparisonService(new PostgresDuplicateReadRepository(pool), keys),
    authenticate: async (request) => {
      if (!request.headers['x-test-role']) throw new AppError('UNAUTHENTICATED', 401, 'Oturum açın.');
      request.currentUser = { id: requestActor, organizationId: org, name: 'Synthetic', email: 'test@example.invalid', role: request.headers['x-test-role'] as 'MANAGER', mustChangePassword: false, isActive: true, version: 1 };
    },
  });
});

it('PERF-03/04: installs the scoped read-side indexes and PR2 review tables', async () => {
  const indexes = (await pool.query('SELECT indexname,indexdef FROM pg_indexes WHERE schemaname=$1', [schema])).rows;
  expect(indexes).toEqual(expect.arrayContaining([
    expect.objectContaining({ indexname: 'customers_duplicate_source_idx', indexdef: expect.stringContaining('(organization_id, id)') }),
    expect.objectContaining({ indexname: 'contacts_duplicate_membership_idx', indexdef: expect.stringContaining('(organization_id, customer_id, id)') }),
  ]));
  expect((await pool.query("SELECT tablename FROM pg_tables WHERE schemaname=$1 AND tablename LIKE 'customer_duplicate%' ORDER BY tablename", [schema])).rows.map((row) => row.tablename)).toEqual(['customer_duplicate_review_events', 'customer_duplicate_reviews']);
});

it('RATE-01–05: guards run before one authenticated actor/org class limiter and path changes cannot reset quota', async () => {
  for (let n = 0; n < 8; n++) {
    expect((await app.inject({ url: '/api/customers/duplicate-candidates' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/customers/duplicate-candidates', headers: { 'x-test-role': 'STAFF' } })).statusCode).toBe(403);
  }
  for (let n = 0; n < 6; n++) expect((await app.inject({ url: `/api/customers/duplicate-candidates?view=${n % 2 ? 'ALL' : 'ATTENTION'}`, headers: { 'x-test-role': 'ADMIN' } })).statusCode).toBe(200);
  const limited = await app.inject({ url: `/api/customers/duplicate-candidates?anchorCustomerId=${ids[0]}`, headers: { 'x-test-role': 'MANAGER' } });
  expect(limited.statusCode).toBe(429); expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1); expect(limited.headers['cache-control']).toBe('no-store');
  for (let n = 0; n < 20; n++) expect((await app.inject({ url: `/api/customers/duplicate-review-pairs/${n % 2 ? ids[0] : ids[1]}/${n % 2 ? ids[1] : ids[0]}`, headers: { 'x-test-role': 'ADMIN' } })).statusCode).toBe(200);
  expect((await app.inject({ url: `/api/customers/duplicate-review-pairs/${ids[0]}/${randomUUID()}`, headers: { 'x-test-role': 'ADMIN' } })).statusCode).toBe(429);
  expect((await app.inject({ url: '/api/customers/duplicate-candidates', headers: { 'x-test-role': 'STAFF' } })).statusCode).toBe(403);
});

it('SEC-04: rejects overrides, duplicate scalar values, invalid bounds and self-pairs', async () => {
  for (const query of ['organizationId=x', 'view=ALL&view=ATTENTION', 'limit=21', 'cursor=', 'anchorCustomerId=invalid']) {
    requestActor = randomUUID();
    const response = await app.inject({ url: `/api/customers/duplicate-candidates?${query}`, headers: { 'x-test-role': 'ADMIN' } });
    expect(response.statusCode, response.body).toBe(400); expect(response.json().code).toBe('VALIDATION_ERROR');
  }
  expect((await app.inject({ url: `/api/customers/duplicate-review-pairs/${ids[0]}/${ids[0]}`, headers: { 'x-test-role': 'ADMIN' } })).statusCode).toBe(400);
});

it('READ-01, EVID-02/03: a real concurrent Customer/Contact commit cannot mix one repeatable read snapshot', async () => {
  const repository = new PostgresDuplicateReadRepository(pool);
  const contactId = randomUUID();
  try {
    await repository.snapshot(async (snapshot) => {
      const source = await snapshot.source(org, null);
      await pool.query("UPDATE customers SET phone='+902125550101' WHERE id=$1", [ids[0]]);
      await pool.query("INSERT INTO contacts(id,organization_id,customer_id,name,is_active) VALUES($1,$2,$3,'Synthetic contact',false)", [contactId, org, ids[0]]);
      const facts = await snapshot.facts(org, [ids[0]!]);
      expect(facts.get(ids[0]!)!.phone).toBe(source.find((c) => c.id === ids[0])!.phone);
      expect(facts.get(ids[0]!)!.contacts).toEqual([]);
    });
    await repository.snapshot(async (snapshot) => {
      const facts = await snapshot.facts(org, [ids[0]!]);
      expect(facts.get(ids[0]!)!.contacts).toHaveLength(1);
      expect(facts.get(ids[0]!)!.phone).toBe('+902125550101');
    });
  } finally { await pool.query('DELETE FROM contacts WHERE id=$1', [contactId]); await pool.query("UPDATE customers SET phone='+905321234567' WHERE id=$1", [ids[0]]); }
});

it('READ-02, SEC-02: 20,001 sources fail explicitly, invalid anchors conceal before cap, known pair remains available', async () => {
  const overflowOrg = randomUUID();
  await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Synthetic overflow')", [overflowOrg]);
  await pool.query("INSERT INTO customers(organization_id,name,customer_type) SELECT $1,'Common name','clinic' FROM generate_series(1,20001)", [overflowOrg]);
  const service = new DuplicateComparisonService(new PostgresDuplicateReadRepository(pool), keys);
  const context = { id: actor, organizationId: overflowOrg, role: 'ADMIN' as const };
  const input = { view: 'ALL' as const, anchorCustomerId: null, cursor: null, limit: 20 };
  await expect(service.candidates(context, input)).rejects.toMatchObject({ code: 'CANDIDATE_SCAN_LIMIT', statusCode: 422 });
  await expect(service.candidates(context, { ...input, anchorCustomerId: ids[0]! })).rejects.toMatchObject({ code: 'DUPLICATE_PAIR_NOT_FOUND', statusCode: 404 });
  const pair = (await pool.query('SELECT id FROM customers WHERE organization_id=$1 ORDER BY id LIMIT 2', [overflowOrg])).rows;
  await expect(service.comparison(context, pair[0].id, pair[1].id)).resolves.toMatchObject({ allowedActions: ['DECIDE'] });
});

async function withContactIndexFixture(count: number, run: (client: PoolClient, customerIds: string[]) => Promise<void>) {
  const client = await pool.connect(), customerId = randomUUID();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query("INSERT INTO customers(id,organization_id,name,customer_type) VALUES($1,$2,'Synthetic index fixture','clinic')", [customerId, org]);
    await client.query("INSERT INTO contacts(organization_id,customer_id,name,is_active) SELECT $1,$2,'Synthetic contact',true FROM generate_series(1,$3)", [org, customerId, count]);
    await run(client, [customerId, ids[1]!]);
  } finally {
    // A Vitest timeout does not cancel an async callback. This transaction's
    // rows remain invisible to later readers even while rollback is pending.
    try { await client.query('ROLLBACK'); } finally { client.release(); }
  }
}

it('PERF-05: contact membership probe uses the ordered composite index instead of scanning the group', async () => {
  await withContactIndexFixture(50_000, async (client, customerIds) => {
    await client.query('ANALYZE contacts');
    const plan = (await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${DUPLICATE_CONTACTS_SQL}`, [org, customerIds.slice(0, 2), 201])).rows[0]['QUERY PLAN'][0];
    expect(JSON.stringify(plan)).toContain('contacts_duplicate_membership_idx');
  });
}, 30_000);

it('PERF-05 isolation: unfinished oversized contact fixture cannot contaminate business reads', async () => {
  // This callback holds the bulk fixture before its cleanup, the exact window
  // that a timed-out test can leave running while the next test begins.
  await withContactIndexFixture(201, async () => {
    const detail = await app.inject({ url: `/api/customers/duplicate-review-pairs/${ids[0]}/${ids[1]}`, headers: { 'x-test-role': 'ADMIN' } });
    expect(detail.statusCode, detail.body).toBe(200);
  });
});

it('READ-02: Contact and address sentinels retain blocked list headers but never generate partial evidence', async () => {
  const contactIds = (await pool.query("INSERT INTO contacts(organization_id,customer_id,name,is_active) SELECT $1,$2,'Synthetic contact',false FROM generate_series(1,201) RETURNING id", [org, ids[0]])).rows.map((c) => c.id);
  const service = new DuplicateComparisonService(new PostgresDuplicateReadRepository(pool), keys);
  const context = { id: actor, organizationId: org, role: 'ADMIN' as const };
  const input = { view: 'ALL' as const, anchorCustomerId: null, cursor: null, limit: 20 };
  try {
    expect((await service.candidates(context, input)).items[0]!.comparisonStatus).toBe('OVER_BUDGET');
    await expect(service.comparison(context, ids[0]!, ids[1]!)).rejects.toMatchObject({ code: 'EVIDENCE_LIMIT_EXCEEDED' });
  } finally { await pool.query('DELETE FROM contacts WHERE id=ANY($1::uuid[])', [contactIds]); }
  try {
    await pool.query("UPDATE customers SET address=repeat('ş',9000) WHERE id=$1", [ids[0]]);
    await expect(service.comparison(context, ids[0]!, ids[1]!)).rejects.toMatchObject({ code: 'EVIDENCE_LIMIT_EXCEEDED' });
  } finally { await pool.query('UPDATE customers SET address=NULL WHERE id=$1', [ids[0]]); }
});

it('NORM-01–10: PG17 storage preserves exact JS normalization input without SQL reimplementation', async () => {
  const values = [null, '', '  ', '05321234567', '(0532) 123 45 67', '5321234567', '905321234567', '+905321234567', '02125550101', '08505550101', '+3572212345', '+9005321234567', '532123', '0532/1234567', '%_', '05321234567 ext 2', '０５３２１２３４５６７', '\u00a005321234567\u202f', '\ufeff05321234567\ufeff', '\u008505321234567', '\u180e05321234567', 'İSTANBUL', 'Istanbul', 'istanbul', 'Yılmaz', 'YILMAZ', 'yilmaz', 'Şube', 'Sube', 'é', 'e\u0301', 'ΟΣ', '𐐀', 'ab 12.3-4/', ' Test@Example.Invalid ', 'Adres  1', 'Adres 1'];
  await pool.query('CREATE TABLE duplicate_normalization_fixture(seq int,value text)');
  await pool.query('INSERT INTO duplicate_normalization_fixture SELECT ordinality,value FROM unnest($1::text[]) WITH ORDINALITY AS t(value,ordinality)', [values]);
  const stored = (await pool.query('SELECT value FROM duplicate_normalization_fixture ORDER BY seq')).rows.map((r) => r.value);
  expect(stored).toEqual(values);
  for (let i = 0; i < values.length; i++) {
    expect(normalizeTurkishPhone(stored[i])).toBe(normalizeTurkishPhone(values[i]));
    expect(normalizeTaxNumber(stored[i])).toBe(normalizeTaxNumber(values[i]));
    if (values[i] !== null) expect(foldCustomerSearchText(stored[i])).toBe(foldCustomerSearchText(values[i]!));
  }
  for (const value of values.slice(3, 8)) expect(normalizeTurkishPhone(value)).toBe('+905321234567');
  for (const value of values.slice(10, 17)) expect(normalizeTurkishPhone(value)).toBeNull();
});
afterAll(async () => { await app?.close(); await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); });

it('SEC-01/02/03, READ-01, PAIR-01: reads only same-org BUSINESS candidates and canonical comparison without writes', async () => {
  const before = (await pool.query('SELECT row_to_json(c) AS value FROM customers c ORDER BY id')).rows;
  const list = await app.inject({ url: '/api/customers/duplicate-candidates', headers: { 'x-test-role': 'MANAGER' } });
  expect(list.statusCode, list.body).toBe(200);
  expect(list.headers['cache-control']).toBe('no-store');
  expect(list.json()).toMatchObject({ coverage: 'COMPLETE_SOURCE', rawPairCount: '1', items: [{ pair: { customerAId: ids[0], customerBId: ids[1] }, matchingCodes: ['SAME_NAME_AND_PHONE'], review: { id: null, version: 0 } }], page: { exhausted: true, returnedItems: 1 } });
  const detail = await app.inject({ url: `/api/customers/duplicate-review-pairs/${ids[1]}/${ids[0]}`, headers: { 'x-test-role': 'ADMIN' } });
  expect(detail.statusCode, detail.body).toBe(200);
  expect(detail.json()).toMatchObject({ pair: { customerAId: ids[0], customerBId: ids[1] }, allowedActions: ['DECIDE'], customerB: { status: 'inactive', contacts: [] } });
  for (const role of [undefined, 'STAFF']) {
    const response = await app.inject({ url: '/api/customers/duplicate-candidates', headers: role ? { 'x-test-role': role } : {} });
    expect(response.statusCode).toBe(role ? 403 : 401);
  }
  for (const id of [ids[2], ids[3], randomUUID()]) {
    const response = await app.inject({ url: `/api/customers/duplicate-review-pairs/${ids[0]}/${id}`, headers: { 'x-test-role': 'ADMIN' } });
    expect(response.statusCode, response.body).toBe(404);
    expect(response.json().code).toBe('DUPLICATE_PAIR_NOT_FOUND');
  }
  expect((await pool.query('SELECT row_to_json(c) AS value FROM customers c ORDER BY id')).rows).toEqual(before);
});
