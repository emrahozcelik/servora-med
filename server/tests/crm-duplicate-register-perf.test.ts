import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { Client, Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { parseDuplicateKeyring } from '../src/modules/crm/duplicate-evidence.js';
import { DuplicateRegisterService } from '../src/modules/crm/duplicate-register-service.js';
import { PostgresDuplicateReadRepository, DUPLICATE_REGISTER_HEADS_SQL } from '../src/modules/crm/duplicate-repository.js';
import { DUPLICATE_LIMITS } from '../src/modules/crm/duplicate-types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = Boolean(databaseUrl) && process.env.CRM_DUPLICATE_PERF === '1';
const schema = `dupperf_${randomUUID().replaceAll('-', '')}`;
const admin = enabled ? new Pool({ connectionString: databaseUrl }) : null;
const pool = enabled ? new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public`, max: 4 }) : null;
const keys = parseDuplicateKeyring(JSON.stringify({ activeKeyId: 'synthetic', keys: { synthetic: Buffer.alloc(32, 23).toString('base64') } }));
const organizationId = randomUUID();
const actorUserId = randomUUID();
const report: Record<string, unknown> = {};

const customerId = (g: number) => `10000000-0000-4000-8000-${String(g).padStart(12, '0')}`;
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))]!;
};

/** Counts every query issued on a pooled client while the register reads run. */
function instrumentQueries() {
  const original = Client.prototype.query;
  const counter = { data: 0, control: 0 };
  const instrumented = function (this: Client, ...args: unknown[]) {
    const text = typeof args[0] === 'string' ? args[0] : '';
    if (/^\s*(BEGIN|COMMIT|SET|ROLLBACK)/i.test(text)) counter.control += 1;
    else counter.data += 1;
    return (original as unknown as (...params: unknown[]) => unknown).apply(this, args);
  };
  Client.prototype.query = instrumented as never;
  return { counter, restore: () => { Client.prototype.query = original; } };
}

beforeAll(async () => {
  if (!enabled) return;
  await admin!.query(`CREATE SCHEMA ${schema}`);
  await runMigrations({ migrationsDirectory: fileURLToPath(new URL('../src/db/migrations', import.meta.url)), store: new PostgresMigrationStore(pool!) });
  await pool!.query("INSERT INTO organizations(id,name) VALUES($1,'Perf org')", [organizationId]);
  await pool!.query(
    `INSERT INTO users(id,organization_id,name,email,password_hash,role)
     VALUES($1,$2,'Perf manager','perf@example.invalid','unused','MANAGER')`, [actorUserId, organizationId],
  );

  const startedAt = performance.now();
  await pool!.query(
    `INSERT INTO customers(id,organization_id,name,customer_type,status,data_class,phone)
     SELECT ('10000000-0000-4000-8000-' || lpad(g::text,12,'0'))::uuid, $1, 'Perf Klinik ' || (g/2), 'clinic','active','BUSINESS',
            '+90532' || lpad(g::text,7,'0')
     FROM generate_series(1,40000) g`, [organizationId],
  );
  // 1m DEMO rows must never surface in the register projection.
  const dataset = await pool!.query<{ id: string }>(
    `INSERT INTO demo_datasets(organization_id,dataset_key,seed_version,created_by)
     VALUES($1,'perf-dataset','v1',$2) RETURNING id`, [organizationId, actorUserId],
  );
  await pool!.query(
    `INSERT INTO customers(id,organization_id,name,customer_type,status,data_class,demo_dataset_id,phone)
     SELECT gen_random_uuid(), $1, 'Demo Klinik ' || g, 'clinic','active','DEMO',$2, '+90555' || lpad(g::text,7,'0')
     FROM generate_series(1,1000000) g`, [organizationId, dataset.rows[0]!.id],
  );
  // One customer holds 1m contacts: the bounded read must expose overflow, not transport them.
  await pool!.query(
    `INSERT INTO contacts(id,organization_id,customer_id,name,title,phone,email,is_primary,is_active,version)
     SELECT gen_random_uuid(), $1, $2, 'Kisi ' || g, 'Unvan', '+90533' || lpad(g::text,7,'0'), 'c' || g || '@example.invalid', false, true, 1
     FROM generate_series(1,1000000) g`, [organizationId, customerId(1)],
  );

  await pool!.query('BEGIN');
  await pool!.query(
    `INSERT INTO customer_duplicate_reviews(id,organization_id,customer_a_id,customer_b_id,version)
     SELECT gen_random_uuid(), $1,
            ('10000000-0000-4000-8000-' || lpad((2*k-1)::text,12,'0'))::uuid,
            ('10000000-0000-4000-8000-' || lpad((2*k)::text,12,'0'))::uuid, 1
     FROM generate_series(1,20000) k`, [organizationId],
  );
  await pool!.query(
    `INSERT INTO customer_duplicate_review_events(id,organization_id,review_id,seq,event_kind,resulting_status,
       reason_code,actor_user_id,evidence_schema_version,matching_rule_version,evidence_key_id,evidence_digest,
       matching_codes,conflicting_tax_numbers)
     SELECT gen_random_uuid(), $1, r.id, 1, 'DECISION_RECORDED','DISMISSED','DISTINCT_CUSTOMER',$2,1,
            'crm-duplicate-v1','synthetic',decode(repeat('00',32),'hex'), ARRAY['SAME_NAME'], false
     FROM customer_duplicate_reviews r WHERE r.organization_id=$1`, [organizationId, actorUserId],
  );
  await pool!.query('SET CONSTRAINTS ALL IMMEDIATE');
  await pool!.query('COMMIT');
  report.seed = { ms: Math.round(performance.now() - startedAt), businessCustomers: 40000, demoCustomers: 1000000, contacts: 1000000, reviews: 20000 };
}, 1_800_000);

afterAll(async () => {
  await pool?.end();
  if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  if (enabled) {
    const output = process.env.CRM_DUPLICATE_PERF_OUT;
    const payload = JSON.stringify({ environment: { platform: process.platform, arch: process.arch, node: process.version, cpus: os.cpus().length, totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024) }, ...report }, null, 2);
    if (output) writeFileSync(output, payload);
    console.log(`CRM_DUPLICATE_REGISTER_PERF ${payload}`);
  }
}, 1_800_000);

it.skipIf(!enabled)('PERF-07/READ-03: 20k review register pages stay bounded at 32 evaluated / 20 returned with a fixed query count', { timeout: 600_000 }, async () => {
  const service = new DuplicateRegisterService(new PostgresDuplicateReadRepository(pool!), keys);
  const actor = { id: actorUserId, organizationId, role: 'MANAGER' as const, name: 'Perf manager', email: 'perf@example.invalid', mustChangePassword: false, isActive: true, version: 1 };

  const firstDurations: number[] = [];
  const nextDurations: number[] = [];
  let cursor: string | null = null;
  let pages = 0;
  const reviewed = new Set<string>();
  const instrument = instrumentQueries();
  try {
    for (let pageIndex = 0; pageIndex < 6; pageIndex++) {
      const startedAt = performance.now();
      const page = await service.register(actor as never, { view: 'ALL', cursor, limit: DUPLICATE_LIMITS.page });
      (pageIndex === 0 ? firstDurations : nextDurations).push(performance.now() - startedAt);
      expect(page.items.length).toBeLessThanOrEqual(20);
      expect(page.page.evaluatedReviews).toBeLessThanOrEqual(32);
      expect(page.page.returnedItems).toBe(page.items.length);
      // The perf dataset is uniformly stale, so ALL returns every evaluated head.
      expect(page.page.evaluatedReviews).toBe(page.items.length);
      expect(page.page.nextCursor).not.toBeNull();
      for (const item of page.items) reviewed.add(item.reviewId);
      cursor = page.page.nextCursor;
      pages += 1;
    }
  } finally { instrument.restore(); }

  expect(pages).toBe(6);
  expect(reviewed.size).toBe(120);
  // One head SELECT plus the two bounded source SELECTs (facts and contacts).
  expect(instrument.counter.data).toBe(pages * 3);
  report.pagination = {
    pages, evaluatedTotal: pages * 32, returnedTotal: reviewed.size,
    dataQueries: instrument.counter.data, controlQueries: instrument.counter.control,
    firstPageMs: Math.round(percentile(firstDurations, 0.95)), continuationP95Ms: Math.round(percentile(nextDurations, 0.95)),
  };
});

it.skipIf(!enabled)('PERF-03/05: a 1m-contact source is read with the 201 sentinel and reported as over budget', { timeout: 600_000 }, async () => {
  const service = new DuplicateRegisterService(new PostgresDuplicateReadRepository(pool!), keys);
  const actor = { id: actorUserId, organizationId, role: 'MANAGER' as const };
  const startedAt = performance.now();
  let cursor: string | null = null;
  let overBudget: { reviewId: string; comparisonStatus: string } | null = null;
  for (let pageIndex = 0; pageIndex < 3 && !overBudget; pageIndex++) {
    const page = await service.register(actor as never, { view: 'ALL', cursor, limit: 20 });
    const hit = page.items.find((item) => item.pair.customerAId === customerId(1) || item.pair.customerBId === customerId(1));
    if (hit) overBudget = { reviewId: hit.reviewId, comparisonStatus: hit.comparisonStatus };
    cursor = page.page.nextCursor;
  }
  const elapsed = performance.now() - startedAt;
  expect(overBudget).not.toBeNull();
  expect(overBudget!.comparisonStatus).toBe('OVER_BUDGET');
  expect(elapsed).toBeLessThan(5_000);
  report.contactSentinel = { comparisonStatus: overBudget!.comparisonStatus, ms: Math.round(elapsed) };
});

it.skipIf(!enabled)('PERF-04: register heads use the canonical pair index and never touch DEMO customers', { timeout: 600_000 }, async () => {
  const client = (await pool!.connect()) as Client;
  try {
    await client.query(`SET LOCAL statement_timeout = 5000`).catch(() => undefined);
    const plan = await client.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${DUPLICATE_REGISTER_HEADS_SQL}`,
      [organizationId, null, null, DUPLICATE_LIMITS.pairs + 1],
    );
    const text = plan.rows.map((row) => row['QUERY PLAN']).join('\n');
    expect(text).not.toMatch(/Seq Scan on customers/);
    expect(text).toMatch(/customer_duplicate_reviews/);
    expect(text).not.toMatch(/demo/i);
    const demoProbe = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM customers WHERE organization_id=$1 AND data_class='DEMO'", [organizationId],
    );
    expect(demoProbe.rows[0]!.count).toBe('1000000');
    report.plan = text.split('\n').slice(0, 12);
  } finally { client.release(); }
});
