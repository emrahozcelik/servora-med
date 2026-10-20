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
const schema = `dupcmd_${randomUUID().replaceAll('-', '')}`;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` }) : null;
const keys = parseDuplicateKeyring(JSON.stringify({ activeKeyId: 'synthetic', keys: { synthetic: Buffer.alloc(32, 11).toString('base64') } }));
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
  return response.json() as {
    evidence: { revision: string; matchingRuleVersion: string };
    review: { id: string | null; version: number; effectiveStatus: string };
  };
}

async function command(actorId: string, actionId: string, decision: 'CONFIRMED_DUPLICATE' | 'DISMISSED', revision: string, version: number, reasonCode: string) {
  return app.inject({
    method: 'POST',
    url: `/api/customers/duplicate-review-pairs/${a}/${b}/decisions`,
    headers: { 'x-test-actor': actorId, 'x-test-role': 'MANAGER', 'content-type': 'application/json' },
    payload: { clientActionId: actionId, expectedReviewVersion: version, expectedEvidenceRevision: revision,
      matchingRuleVersion: 'crm-duplicate-v1', decision, reasonCode },
  });
}

async function reopen(actorId: string, actionId: string, revision: string, version: number) {
  return app.inject({
    method: 'POST',
    url: `/api/customers/duplicate-review-pairs/${a}/${b}/reopen`,
    headers: { 'x-test-actor': actorId, 'x-test-role': 'MANAGER', 'content-type': 'application/json' },
    payload: { clientActionId: actionId, expectedReviewVersion: version, expectedEvidenceRevision: revision, matchingRuleVersion: 'crm-duplicate-v1' },
  });
}

async function counts() {
  const result = await pool!.query<{ reviews: string; events: string; audit: string; receipts: string }>(
    `SELECT
      (SELECT count(*) FROM customer_duplicate_reviews WHERE organization_id=$1)::text AS reviews,
      (SELECT count(*) FROM customer_duplicate_review_events WHERE organization_id=$1)::text AS events,
      (SELECT count(*) FROM audit_events WHERE organization_id=$1 AND subject_type='CUSTOMER_DUPLICATE_REVIEW')::text AS audit,
      (SELECT count(*) FROM processed_actions WHERE organization_id=$1 AND operation_key IN ('CRM_DUPLICATE_DECISION','CRM_DUPLICATE_REOPEN') AND status='completed')::text AS receipts`,
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
      request.currentUser = {
        id, organizationId: org, name: 'Synthetic manager', email: 'test@example.invalid',
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

it.skipIf(!databaseUrl)('CMD-01/CMD-02/CURRENT: first decision is atomic, replays immutably and updates the read projection', async () => {
  const before = (await pool!.query('SELECT row_to_json(c) AS value FROM customers c ORDER BY id')).rows;
  const read = await comparison();
  expect(read.review).toMatchObject({ id: null, version: 0, effectiveStatus: 'PENDING_REVIEW' });
  const action = randomUUID();
  const first = await command(actor, action, 'CONFIRMED_DUPLICATE', read.evidence.revision, 0, 'SAME_OPERATIONAL_CUSTOMER_VERIFIED');
  expect(first.statusCode, first.body).toBe(200);
  const receipt = first.json();
  expect(receipt).toMatchObject({ reviewVersion: 1, eventKind: 'DECISION_RECORDED', resultingStatus: 'CONFIRMED_DUPLICATE', reasonCode: 'SAME_OPERATIONAL_CUSTOMER_VERIFIED' });
  expect(await counts()).toEqual({ reviews: '1', events: '1', audit: '1', receipts: '1' });
  expect((await pool!.query('SELECT row_to_json(c) AS value FROM customers c ORDER BY id')).rows).toEqual(before);
  const audit = (await pool!.query('SELECT old_value,new_value,metadata FROM audit_events WHERE organization_id=$1 AND subject_type=$2', [org, 'CUSTOMER_DUPLICATE_REVIEW'])).rows[0]!;
  const canonical = [a, b].sort();
  expect(audit.metadata).toMatchObject({ reviewVersion: 1, customerAId: canonical[0], customerBId: canonical[1], matchingRuleVersion: 'crm-duplicate-v1' });
  expect(JSON.stringify(audit)).not.toContain('+905321234567');
  expect(JSON.stringify(audit)).not.toContain('Sentetik Klinik');

  const replay = await command(actor, action, 'CONFIRMED_DUPLICATE', read.evidence.revision, 0, 'SAME_OPERATIONAL_CUSTOMER_VERIFIED');
  expect(replay.statusCode, replay.body).toBe(200);
  expect(replay.headers['idempotency-replayed']).toBe('true');
  expect(replay.json()).toEqual(receipt);
  expect(await counts()).toEqual({ reviews: '1', events: '1', audit: '1', receipts: '1' });

  const changed = await command(actor, action, 'DISMISSED', read.evidence.revision, 0, 'DISTINCT_CUSTOMER');
  expect(changed.statusCode, changed.body).toBe(409);
  expect(changed.json().code).toBe('CLIENT_ACTION_REUSED');
  expect(await counts()).toEqual({ reviews: '1', events: '1', audit: '1', receipts: '1' });

  const current = await comparison();
  expect(current.review).toMatchObject({ id: receipt.reviewId, version: 1, reviewStatus: 'CONFIRMED_DUPLICATE', effectiveStatus: 'CONFIRMED_DUPLICATE', freshness: 'CURRENT' });
  const attention = await app.inject({ url: '/api/customers/duplicate-candidates?view=ATTENTION', headers: { 'x-test-actor': actor, 'x-test-role': 'MANAGER' } });
  expect(attention.statusCode, attention.body).toBe(200);
  expect(attention.json().items).toEqual([]);
});

it.skipIf(!databaseUrl)('CMD-04/CMD-11/READ-05: reopen appends history, keeps the previous decision and permits a new current decision', async () => {
  const read = await comparison();
  const decided = await command(actor, randomUUID(), 'DISMISSED', read.evidence.revision, 0, 'DISTINCT_BRANCH');
  expect(decided.statusCode, decided.body).toBe(200);
  const receipt = decided.json();
  const direct = await command(actor, randomUUID(), 'CONFIRMED_DUPLICATE', read.evidence.revision, receipt.reviewVersion, 'SAME_OPERATIONAL_CUSTOMER_VERIFIED');
  expect(direct.statusCode, direct.body).toBe(409);
  expect(direct.json().code).toBe('REVIEW_REOPEN_REQUIRED');

  const current = await comparison();
  const reopened = await reopen(actor, randomUUID(), current.evidence.revision, receipt.reviewVersion);
  expect(reopened.statusCode, reopened.body).toBe(200);
  expect(reopened.json()).toMatchObject({ reviewVersion: 2, eventKind: 'REVIEW_REOPENED', resultingStatus: 'PENDING_REVIEW', reasonCode: 'RECHECK_REQUESTED' });
  const reopenedRead = await comparison();
  expect(reopenedRead.review).toMatchObject({ version: 2, reviewStatus: 'PENDING_REVIEW', effectiveStatus: 'PENDING_REVIEW', currentDecision: null,
    lastDecision: { seq: 1, status: 'DISMISSED', reasonCode: 'DISTINCT_BRANCH' } });

  const history = await app.inject({ url: `/api/customers/duplicate-reviews/${receipt.reviewId}/history?limit=1`, headers: { 'x-test-actor': actor, 'x-test-role': 'MANAGER' } });
  expect(history.statusCode, history.body).toBe(200);
  expect(history.json()).toMatchObject({ reviewId: receipt.reviewId, upperSeq: 2, items: [{ seq: 2, eventKind: 'REVIEW_REOPENED', resultingStatus: 'PENDING_REVIEW' }] });
  const next = history.json().nextCursor;
  expect(next).toBeTruthy();
  const page2 = await app.inject({ url: `/api/customers/duplicate-reviews/${receipt.reviewId}/history?limit=1&cursor=${encodeURIComponent(next)}`, headers: { 'x-test-actor': actor, 'x-test-role': 'MANAGER' } });
  expect(page2.statusCode, page2.body).toBe(200);
  expect(page2.json()).toMatchObject({ upperSeq: 2, items: [{ seq: 1, eventKind: 'DECISION_RECORDED', resultingStatus: 'DISMISSED' }], nextCursor: null });

  const newDecision = await command(actor, randomUUID(), 'CONFIRMED_DUPLICATE', reopenedRead.evidence.revision, 2, 'SAME_OPERATIONAL_CUSTOMER_VERIFIED');
  expect(newDecision.statusCode, newDecision.body).toBe(200);
  expect(newDecision.json()).toMatchObject({ reviewVersion: 3, resultingStatus: 'CONFIRMED_DUPLICATE' });
  const finalRead = await comparison();
  expect(finalRead.review).toMatchObject({ version: 3, reviewStatus: 'CONFIRMED_DUPLICATE', currentDecision: { seq: 3 }, lastDecision: { seq: 3 } });
});

it.skipIf(!databaseUrl)('READ-03: a stale terminal decision resurfaces in ATTENTION instead of being suppressed', async () => {
  const read = await comparison();
  const decided = await command(actor, randomUUID(), 'DISMISSED', read.evidence.revision, 0, 'DISTINCT_CUSTOMER');
  expect(decided.statusCode, decided.body).toBe(200);
  await pool!.query("UPDATE customers SET name='Kaynak değişti' WHERE id=$1", [a]);
  const list = await app.inject({ url: '/api/customers/duplicate-candidates?view=ATTENTION', headers: { 'x-test-actor': actor, 'x-test-role': 'MANAGER' } });
  expect(list.statusCode, list.body).toBe(200);
  expect(list.json().items[0].review).toMatchObject({ version: 1, reviewStatus: 'DISMISSED', effectiveStatus: 'REVIEW_REQUIRED', freshness: 'STALE', freshnessReason: 'SOURCE_CHANGED' });
});

it.skipIf(!databaseUrl)('READ-05: missing/foreign review history is 404 and a tampered cursor is 409; a deleted source keeps history', async () => {
  const read = await comparison();
  const decided = await command(actor, randomUUID(), 'DISMISSED', read.evidence.revision, 0, 'DISTINCT_CUSTOMER');
  expect(decided.statusCode, decided.body).toBe(200);
  const receipt = decided.json();
  const missing = await app.inject({ url: `/api/customers/duplicate-reviews/${randomUUID()}/history`, headers: { 'x-test-actor': actor, 'x-test-role': 'MANAGER' } });
  expect(missing.statusCode, missing.body).toBe(404);
  expect(missing.json().code).toBe('DUPLICATE_REVIEW_NOT_FOUND');
  const cursor = (await app.inject({ url: `/api/customers/duplicate-reviews/${receipt.reviewId}/history?limit=1`, headers: { 'x-test-actor': actor, 'x-test-role': 'MANAGER' } })).json().nextCursor;
  expect(cursor).toBeNull();
  const malformed = await app.inject({ url: `/api/customers/duplicate-reviews/${receipt.reviewId}/history?cursor=dh1.synthetic.invalid.invalid`, headers: { 'x-test-actor': actor, 'x-test-role': 'MANAGER' } });
  expect(malformed.statusCode, malformed.body).toBe(409);
  expect(malformed.json().code).toBe('CURSOR_RESTART_REQUIRED');
  await pool!.query('DELETE FROM customers WHERE id=$1', [a]);
  const history = await app.inject({ url: `/api/customers/duplicate-reviews/${receipt.reviewId}/history`, headers: { 'x-test-actor': actor, 'x-test-role': 'MANAGER' } });
  expect(history.statusCode, history.body).toBe(200);
  expect(history.json().items[0]).toMatchObject({ eventKind: 'DECISION_RECORDED', resultingStatus: 'DISMISSED' });
  const gone = await app.inject({ url: `/api/customers/duplicate-review-pairs/${a}/${b}`, headers: { 'x-test-actor': actor, 'x-test-role': 'MANAGER' } });
  expect(gone.statusCode, gone.body).toBe(404);
});

it.skipIf(!databaseUrl)('TX-07: same-key concurrent commands replay or return ACTION_IN_PROGRESS with one event', async () => {
  const read = await comparison();
  const action = randomUUID();
  const [one, two] = await Promise.all([
    command(actor, action, 'CONFIRMED_DUPLICATE', read.evidence.revision, 0, 'SAME_OPERATIONAL_CUSTOMER_VERIFIED'),
    command(actor, action, 'CONFIRMED_DUPLICATE', read.evidence.revision, 0, 'SAME_OPERATIONAL_CUSTOMER_VERIFIED'),
  ]);
  expect(one.statusCode, one.body).toBe(200);
  expect([200, 409]).toContain(two.statusCode);
  if (two.statusCode === 409) expect(two.json().code).toBe('ACTION_IN_PROGRESS');
  expect(await counts()).toEqual({ reviews: '1', events: '1', audit: '1', receipts: '1' });
});

it.skipIf(!databaseUrl)('A12-S5/TX-02: a source change after GET is EVIDENCE_CHANGED with zero review writes', async () => {
  const read = await comparison();
  await pool!.query("UPDATE customers SET name='Değişen Klinik' WHERE id=$1", [a]);
  const response = await command(actor, randomUUID(), 'CONFIRMED_DUPLICATE', read.evidence.revision, 0, 'SAME_OPERATIONAL_CUSTOMER_VERIFIED');
  expect(response.statusCode, response.body).toBe(409);
  expect(response.json().code).toBe('EVIDENCE_CHANGED');
  expect(await counts()).toEqual({ reviews: '0', events: '0', audit: '0', receipts: '0' });
});

it.skipIf(!databaseUrl)('EVID-10/KEY-04: a missing expected key is a definitive no-commit 409 after receipt replay lookup', async () => {
  const read = await comparison();
  const revision = `ev1.retired.${read.evidence.revision.split('.')[2]}`;
  const response = await command(actor, randomUUID(), 'CONFIRMED_DUPLICATE', revision, 0, 'SAME_OPERATIONAL_CUSTOMER_VERIFIED');
  expect(response.statusCode, response.body).toBe(409);
  expect(response.json().code).toBe('EVIDENCE_KEY_UNAVAILABLE');
  expect(await counts()).toEqual({ reviews: '0', events: '0', audit: '0', receipts: '0' });
});

it.skipIf(!databaseUrl)('TX-01/TX-05: concurrent opposite decisions have one winner and no partial receipt; audit failure rolls back', async () => {
  const read = await comparison();
  const actor2 = await createActor();
  const [one, two] = await Promise.all([
    command(actor, randomUUID(), 'CONFIRMED_DUPLICATE', read.evidence.revision, 0, 'SAME_OPERATIONAL_CUSTOMER_VERIFIED'),
    command(actor2, randomUUID(), 'DISMISSED', read.evidence.revision, 0, 'DISTINCT_CUSTOMER'),
  ]);
  expect([one.statusCode, two.statusCode].sort()).toEqual([200, 409]);
  expect(await counts()).toEqual({ reviews: '1', events: '1', audit: '1', receipts: '1' });

  org = randomUUID();
  await pool!.query("INSERT INTO organizations(id,name) VALUES($1,'Synthetic rollback org')", [org]);
  await createPair();
  const rollbackRead = await comparison();
  await pool!.query(`CREATE OR REPLACE FUNCTION synthetic_audit_failure() RETURNS trigger AS $$
    BEGIN
      IF NEW.subject_type = 'CUSTOMER_DUPLICATE_REVIEW' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`);
  await pool!.query('CREATE TRIGGER synthetic_audit_failure_trigger BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION synthetic_audit_failure()');
  try {
    const failed = await command(actor, randomUUID(), 'CONFIRMED_DUPLICATE', rollbackRead.evidence.revision, 0, 'SAME_OPERATIONAL_CUSTOMER_VERIFIED');
    expect(failed.statusCode, failed.body).toBe(500);
    expect(await counts()).toEqual({ reviews: '0', events: '0', audit: '0', receipts: '0' });
  } finally {
    await pool!.query('DROP TRIGGER synthetic_audit_failure_trigger ON audit_events');
    await pool!.query('DROP FUNCTION synthetic_audit_failure()');
  }
});

it.skipIf(!databaseUrl)('RATE-03/05: the COMMAND class limiter is actor/org scoped and returns no-store 429', async () => {
  const manager = await createActor();
  for (let index = 0; index < 10; index++) {
    const response = await app.inject({
      method: 'POST', url: `/api/customers/duplicate-review-pairs/${a}/${b}/decisions`,
      headers: { 'x-test-actor': manager, 'x-test-role': 'MANAGER', 'content-type': 'application/json' },
      payload: {},
    });
    expect(response.statusCode, response.body).toBe(400);
  }
  const limited = await app.inject({
    method: 'POST', url: `/api/customers/duplicate-review-pairs/${a}/${b}/decisions`,
    headers: { 'x-test-actor': manager, 'x-test-role': 'MANAGER', 'content-type': 'application/json' },
    payload: {},
  });
  expect(limited.statusCode, limited.body).toBe(429);
  expect(limited.json().code).toBe('RATE_LIMIT_EXCEEDED');
  expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  expect(limited.headers['cache-control']).toBe('no-store');
  const other = await createActor();
  const fresh = await app.inject({
    method: 'POST', url: `/api/customers/duplicate-review-pairs/${a}/${b}/decisions`,
    headers: { 'x-test-actor': other, 'x-test-role': 'MANAGER', 'content-type': 'application/json' },
    payload: {},
  });
  expect(fresh.statusCode, fresh.body).toBe(400);
});

it.skipIf(!databaseUrl)('SEC-01/API-5: STAFF is rejected before the pair lookup and malformed bodies add no writes', async () => {
  const staff = await createActor('STAFF');
  const response = await app.inject({
    method: 'POST', url: `/api/customers/duplicate-review-pairs/${a}/${b}/decisions`,
    headers: { 'x-test-actor': staff, 'x-test-role': 'STAFF', 'content-type': 'application/json' },
    payload: { clientActionId: randomUUID(), expectedReviewVersion: 0, expectedEvidenceRevision: 'ev1.synthetic.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', matchingRuleVersion: 'crm-duplicate-v1', decision: 'CONFIRMED_DUPLICATE', reasonCode: 'SAME_OPERATIONAL_CUSTOMER_VERIFIED' },
  });
  expect(response.statusCode, response.body).toBe(403);
  expect(await counts()).toEqual({ reviews: '0', events: '0', audit: '0', receipts: '0' });
  const malformed = await command(actor, randomUUID(), 'DISMISSED', 'ev1.synthetic.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 0, 'DISTINCT_CUSTOMER');
  expect(malformed.statusCode, malformed.body).toBe(409);
  expect(malformed.json().code).toBe('EVIDENCE_CHANGED');
  expect(await counts()).toEqual({ reviews: '0', events: '0', audit: '0', receipts: '0' });
});
