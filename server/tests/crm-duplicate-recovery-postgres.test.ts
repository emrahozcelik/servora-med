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
import { PostgresDuplicateReviewRepository } from '../src/modules/crm/duplicate-review-repository.js';
import { DuplicateReviewService } from '../src/modules/crm/duplicate-review-service.js';
import { duplicateRoutes } from '../src/modules/crm/duplicate-routes.js';
import { DuplicateComparisonService } from '../src/modules/crm/duplicate-service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const admin = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const schema = `duprec_${randomUUID().replaceAll('-', '')}`;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` }) : null;
const keys = parseDuplicateKeyring(JSON.stringify({ activeKeyId: 'synthetic', keys: { synthetic: Buffer.alloc(32, 17).toString('base64') } }));
let app: FastifyInstance;
let org: string;
let actor: string;
let a: string;
let b: string;

async function createActor(role = 'MANAGER') {
  const id = randomUUID();
  await pool!.query(
    `INSERT INTO users(id,organization_id,name,email,password_hash,role)
     VALUES($1,$2,'Synthetic manager',$3,'unused',$4)`,
    [id, org, `${id}@example.invalid`, role],
  );
  return id;
}

async function createPair() {
  a = randomUUID(); b = randomUUID();
  await pool!.query(
    `INSERT INTO customers(id,organization_id,name,customer_type,status,data_class,phone,email,city,district,address)
     VALUES($1,$2,'Sentetik Klinik','clinic','active','BUSINESS','+905321234567','test@example.invalid','İstanbul','Merkez','Test adres'),
            ($3,$2,'SENTETİK KLİNİK','clinic','inactive','BUSINESS','(0532) 123 45 67','test@example.invalid','İstanbul','Merkez','Test adres')`,
    [a, org, b],
  );
  actor = await createActor();
}

async function comparison(actorId = actor) {
  const response = await app.inject({
    url: `/api/customers/duplicate-review-pairs/${a}/${b}`,
    headers: { 'x-test-actor': actorId, 'x-test-role': 'MANAGER' },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as { evidence: { revision: string }; review: { version: number } };
}

async function decide(actorId: string, actionId: string, revision: string, version: number) {
  return app.inject({
    method: 'POST', url: `/api/customers/duplicate-review-pairs/${a}/${b}/decisions`,
    headers: { 'x-test-actor': actorId, 'x-test-role': 'MANAGER', 'content-type': 'application/json' },
    payload: {
      clientActionId: actionId, expectedReviewVersion: version, expectedEvidenceRevision: revision,
      matchingRuleVersion: 'crm-duplicate-v1', decision: 'DISMISSED', reasonCode: 'DISTINCT_CUSTOMER',
    },
  });
}

async function counts() {
  const result = await pool!.query<{ reviews: string; events: string; audit: string }>(
    `SELECT
      (SELECT count(*) FROM customer_duplicate_reviews WHERE organization_id=$1)::text AS reviews,
      (SELECT count(*) FROM customer_duplicate_review_events WHERE organization_id=$1)::text AS events,
      (SELECT count(*) FROM audit_events WHERE organization_id=$1 AND subject_type='CUSTOMER_DUPLICATE_REVIEW')::text AS audit`,
    [org],
  );
  return result.rows[0]!;
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
  await createPair();
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
});

it.skipIf(!databaseUrl)('P3: a lost decision response still replays its immutable receipt after the source customer is deleted', async () => {
  const current = await comparison();
  const actionId = randomUUID();
  const first = await decide(actor, actionId, current.evidence.revision, current.review.version);
  expect(first.statusCode, first.body).toBe(200);
  const receipt = first.json() as { reviewId: string; eventId: string; reviewVersion: number; resultingStatus: string; occurredAt: string };
  const before = await counts();

  // The manager never saw the response and the source was deleted afterwards.
  await pool!.query('DELETE FROM customers WHERE id=$1', [b]);
  expect((await app.inject({ url: `/api/customers/duplicate-review-pairs/${a}/${b}`, headers: { 'x-test-actor': actor, 'x-test-role': 'MANAGER' } })).statusCode).toBe(404);

  const replay = await decide(actor, actionId, current.evidence.revision, current.review.version);
  expect(replay.statusCode, replay.body).toBe(200);
  expect(replay.headers['idempotency-replayed']).toBe('true');
  expect(replay.json()).toEqual(receipt);

  const after = await counts();
  expect(after).toEqual(before);
});

it.skipIf(!databaseUrl)('P3: a source-less pair accepts no new decision or reopen intent', async () => {
  const current = await comparison();
  await pool!.query('DELETE FROM customers WHERE id=$1', [b]);

  const fresh = await decide(actor, randomUUID(), current.evidence.revision, current.review.version);
  expect(fresh.statusCode, fresh.body).toBe(404);
  expect((fresh.json() as { code: string }).code).toBe('DUPLICATE_PAIR_NOT_FOUND');

  const reopen = await app.inject({
    method: 'POST', url: `/api/customers/duplicate-review-pairs/${a}/${b}/reopen`,
    headers: { 'x-test-actor': actor, 'x-test-role': 'MANAGER', 'content-type': 'application/json' },
    payload: { clientActionId: randomUUID(), expectedReviewVersion: current.review.version, expectedEvidenceRevision: current.evidence.revision, matchingRuleVersion: 'crm-duplicate-v1' },
  });
  expect(reopen.statusCode, reopen.body).toBe(404);
  expect(await counts()).toMatchObject({ reviews: '0', events: '0', audit: '0' });
});

it.skipIf(!databaseUrl)('P3: a lost reopen response replays the original receipt while a different actor gets only their own scope', async () => {
  const current = await comparison();
  const actionId = randomUUID();
  const decision = await decide(actor, randomUUID(), current.evidence.revision, current.review.version);
  expect(decision.statusCode, decision.body).toBe(200);
  const afterDecision = await comparison();

  const reopen = await app.inject({
    method: 'POST', url: `/api/customers/duplicate-review-pairs/${a}/${b}/reopen`,
    headers: { 'x-test-actor': actor, 'x-test-role': 'MANAGER', 'content-type': 'application/json' },
    payload: { clientActionId: actionId, expectedReviewVersion: afterDecision.review.version, expectedEvidenceRevision: afterDecision.evidence.revision, matchingRuleVersion: 'crm-duplicate-v1' },
  });
  expect(reopen.statusCode, reopen.body).toBe(200);
  const receipt = reopen.json() as { eventId: string; resultingStatus: string };

  await pool!.query('DELETE FROM customers WHERE id=$1', [b]);
  const replay = await app.inject({
    method: 'POST', url: `/api/customers/duplicate-review-pairs/${a}/${b}/reopen`,
    headers: { 'x-test-actor': actor, 'x-test-role': 'MANAGER', 'content-type': 'application/json' },
    payload: { clientActionId: actionId, expectedReviewVersion: afterDecision.review.version, expectedEvidenceRevision: afterDecision.evidence.revision, matchingRuleVersion: 'crm-duplicate-v1' },
  });
  expect(replay.statusCode, replay.body).toBe(200);
  expect(replay.headers['idempotency-replayed']).toBe('true');
  expect(replay.json()).toEqual(receipt);

  const stranger = await createActor('MANAGER');
  const foreignOrg = randomUUID();
  await pool!.query("INSERT INTO organizations(id,name) VALUES($1,'Foreign org')", [foreignOrg]);
  await pool!.query('UPDATE users SET organization_id=$2 WHERE id=$1', [stranger, foreignOrg]);
  const foreignReplay = await app.inject({
    method: 'POST', url: `/api/customers/duplicate-review-pairs/${a}/${b}/reopen`,
    headers: { 'x-test-actor': stranger, 'x-test-role': 'MANAGER', 'content-type': 'application/json' },
    payload: { clientActionId: actionId, expectedReviewVersion: afterDecision.review.version, expectedEvidenceRevision: afterDecision.evidence.revision, matchingRuleVersion: 'crm-duplicate-v1' },
  });
  expect(foreignReplay.statusCode, foreignReplay.body).toBe(404);
});
