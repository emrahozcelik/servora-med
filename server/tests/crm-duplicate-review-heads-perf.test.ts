import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { Client, Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import {
  DUPLICATE_REVIEW_HEADS_SQL,
  PostgresDuplicateReadRepository,
} from '../src/modules/crm/duplicate-repository.js';

/**
 * Opt-in PostgreSQL 17 evidence harness for the batch review-head read.
 *
 * Run:
 *   CRM_DUPLICATE_PERF=1 TEST_DATABASE_URL=... \
 *     npx vitest run tests/crm-duplicate-review-heads-perf.test.ts
 *
 * It creates isolated schemas (it never uses the public schema), seeds three
 * review populations (0 / 1k / 20k) with the production distribution, and
 * compares the pre-optimization SQL (kept here as the baseline fixture) with the
 * shipped query on the exact same rows, plans and semantic output.
 */

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = Boolean(databaseUrl) && process.env.CRM_DUPLICATE_PERF === '1';
const admin = enabled ? new Pool({ connectionString: databaseUrl }) : null;
const sizes = [0, 1_000, 20_000] as const;
const schemas = new Map<number, string>();
const pools = new Map<number, Pool>();
const organizationId = randomUUID();
const foreignOrganizationId = randomUUID();
const actorUserId = randomUUID();
const report: Record<string, unknown> = {};

/** Exact pre-optimization text; do not edit while comparing a candidate query. */
const LEGACY_REVIEW_HEADS_SQL = `SELECT wanted.customer_a_id, wanted.customer_b_id,
  r.id, r.version, e.id AS event_id, e.seq, e.event_kind, e.resulting_status, e.reason_code,
  e.actor_user_id, e.occurred_at, e.evidence_schema_version, e.matching_rule_version,
  e.evidence_key_id, e.evidence_digest, e.matching_codes, e.conflicting_tax_numbers,
  previous_decision.id AS previous_decision_id, previous_decision.seq AS previous_decision_seq,
  previous_decision.resulting_status AS previous_decision_status,
  previous_decision.reason_code AS previous_decision_reason,
  previous_decision.actor_user_id AS previous_decision_actor_id,
  previous_decision.occurred_at AS previous_decision_at
FROM unnest($2::uuid[], $3::uuid[]) AS wanted(customer_a_id, customer_b_id)
LEFT JOIN customer_duplicate_reviews r
  ON r.organization_id=$1 AND r.customer_a_id=wanted.customer_a_id AND r.customer_b_id=wanted.customer_b_id
LEFT JOIN customer_duplicate_review_events e
  ON e.organization_id=r.organization_id AND e.review_id=r.id AND e.seq=r.version
LEFT JOIN customer_duplicate_review_events previous_decision
  ON previous_decision.organization_id=r.organization_id AND previous_decision.review_id=r.id
 AND previous_decision.seq=r.version-1 AND previous_decision.event_kind='DECISION_RECORDED'
 AND e.event_kind='REVIEW_REOPENED'
ORDER BY wanted.customer_a_id, wanted.customer_b_id`;

const customerId = (g: number) => `10000000-0000-4000-8000-${String(g).padStart(12, '0')}`;
const reviewId = (k: number) => `20000000-0000-4000-8000-${String(k).padStart(12, '0')}`;
const foreignReviewId = (k: number) => `30000000-0000-4000-8000-${String(k).padStart(12, '0')}`;
const pair = (k: number) => ({ customerAId: customerId(2 * k - 1), customerBId: customerId(2 * k) });

/** 8 pairs from each state band: terminal v1, pending v2, terminal-after-reopen v3, reopened v4. */
function scenarioPairIndexes(size: 1 | 20 | 32): number[] {
  const perBand = size === 1 ? 1 : size === 20 ? 5 : 8;
  const bands = [1, 401, 801, 901];
  return bands.flatMap((start) => Array.from({ length: perBand }, (_, index) => start + index)).slice(0, size);
}

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))]!;
};
const round = (value: number) => Math.round(value * 1000) / 1000;

type PlanNode = {
  'Node Type'?: string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  'Shared Dirtied Blocks'?: number;
  'Shared Written Blocks'?: number;
  'Sort Space Used'?: number;
  Memory?: number;
  Plans?: PlanNode[];
};

function inspectPlan(node: PlanNode, state: {
  rows: number; loopRows: number; hit: number; read: number; memory: number;
  seqScans: string[]; indexes: Set<string>; nodes: string[];
  relationRows: Record<string, number>; relationLoopRows: Record<string, number>;
}) {
  const loops = node['Actual Loops'] ?? 1;
  const rows = node['Actual Rows'] ?? 0;
  state.rows += rows;
  state.loopRows += rows * loops;
  if (node['Relation Name']) {
    state.relationRows[node['Relation Name']] = (state.relationRows[node['Relation Name']] ?? 0) + rows;
    state.relationLoopRows[node['Relation Name']] = (state.relationLoopRows[node['Relation Name']] ?? 0) + rows * loops;
  }
  state.hit += node['Shared Hit Blocks'] ?? 0;
  state.read += node['Shared Read Blocks'] ?? 0;
  state.memory = Math.max(state.memory, node.Memory ?? 0, node['Sort Space Used'] ?? 0);
  if (node['Node Type'] === 'Seq Scan' && node['Relation Name']) state.seqScans.push(node['Relation Name']);
  if (node['Index Name']) state.indexes.add(node['Index Name']);
  state.nodes.push(node['Node Type'] ?? 'unknown');
  for (const child of node.Plans ?? []) inspectPlan(child, state);
}

async function explain(client: Client, sql: string, params: unknown[]) {
  const result = await client.query<{ 'QUERY PLAN': Array<{ Plan: PlanNode; 'Planning Time': number; 'Execution Time': number }> }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params,
  );
  const document = result.rows[0]!['QUERY PLAN'][0]!;
  const state = {
    rows: 0, loopRows: 0, hit: 0, read: 0, memory: 0,
    seqScans: [] as string[], indexes: new Set<string>(), nodes: [] as string[],
    relationRows: {} as Record<string, number>, relationLoopRows: {} as Record<string, number>,
  };
  inspectPlan(document.Plan, state);
  const text = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, params);
  return {
    planningMs: round(document['Planning Time']),
    executionMs: round(document['Execution Time']),
    actualRows: document.Plan['Actual Rows'] ?? 0,
    planRowsSum: state.rows,
    planLoopRowsSum: state.loopRows,
    sharedHitBlocks: state.hit,
    sharedReadBlocks: state.read,
    peakMemoryKb: state.memory,
    seqScans: state.seqScans,
    indexes: [...state.indexes].sort(),
    relationRows: state.relationRows,
    relationLoopRows: state.relationLoopRows,
    nodeTypes: state.nodes,
    text: text.rows.map((row) => row['QUERY PLAN']),
  };
}

async function timeQuery(client: Client, sql: string, params: unknown[], iterations = 100) {
  for (let index = 0; index < 5; index++) await client.query(sql, params);
  const samples: number[] = [];
  for (let index = 0; index < iterations; index++) {
    const startedAt = performance.now();
    await client.query(sql, params);
    samples.push(performance.now() - startedAt);
  }
  return {
    iterations,
    p50Ms: round(percentile(samples, 0.5)),
    p95Ms: round(percentile(samples, 0.95)),
    p99Ms: round(percentile(samples, 0.99)),
    maxMs: round(Math.max(...samples)),
    meanMs: round(samples.reduce((sum, value) => sum + value, 0) / samples.length),
  };
}

/** Counts every query issued on a pooled client while one repository read runs. */
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

function normalize(rows: Array<Record<string, unknown>>) {
  return rows.map((row) => JSON.stringify(row, (_key, value) => {
    if (value instanceof Date) return value.toISOString();
    if (Buffer.isBuffer(value)) return value.toString('hex');
    return value;
  }));
}

async function insertEvents(client: Client, reviewIds: number[], fromSeq: number, toSeq: number, reopenedSeq: number | null) {
  for (let seq = fromSeq; seq <= toSeq; seq++) {
    const reopened = seq === reopenedSeq;
    await client.query(
      `INSERT INTO customer_duplicate_review_events(id,organization_id,review_id,seq,event_kind,resulting_status,
         reason_code,actor_user_id,evidence_schema_version,matching_rule_version,evidence_key_id,evidence_digest,
         matching_codes,conflicting_tax_numbers)
       SELECT gen_random_uuid(),$1,('20000000-0000-4000-8000-'||lpad(k::text,12,'0'))::uuid,$2,$3,$4,$5,$6,1,
              'crm-duplicate-v1','synthetic',decode(repeat('0a',32),'hex'),ARRAY['SAME_NAME'],false
       FROM unnest($7::int[]) AS k`, [
        organizationId, seq,
        reopened ? 'REVIEW_REOPENED' : 'DECISION_RECORDED',
        reopened ? 'PENDING_REVIEW' : 'DISMISSED',
        reopened ? 'RECHECK_REQUESTED' : 'DISTINCT_CUSTOMER',
        actorUserId, reviewIds,
      ],
    );
  }
}

async function seedSchema(size: number) {
  const schema = `duphe_${size}_${randomUUID().replaceAll('-', '')}`;
  schemas.set(size, schema);
  await admin!.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public`, max: 4 });
  pools.set(size, pool);
  await runMigrations({
    migrationsDirectory: fileURLToPath(new URL('../src/db/migrations', import.meta.url)),
    store: new PostgresMigrationStore(pool),
  });
  await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Review head perf org'),($2,'Foreign org')", [organizationId, foreignOrganizationId]);
  await pool.query(
    `INSERT INTO users(id,organization_id,name,email,password_hash,role)
     VALUES($1,$2,'Perf manager','heads-perf@example.invalid','unused','MANAGER')`, [actorUserId, organizationId],
  );
  await pool.query(
    `INSERT INTO customers(id,organization_id,name,customer_type,status,data_class,phone)
     SELECT ('10000000-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid,$1,'Perf Klinik '||(g/2),'clinic','active','BUSINESS',
            '+90532'||lpad(g::text,7,'0')
     FROM generate_series(1,40100) g`, [organizationId],
  );
  const terminal = Math.floor(size * 0.4);
  const pending = Math.floor(size * 0.3);
  const terminalAfterReopen = Math.floor(size * 0.2);
  const reopened = size - terminal - pending - terminalAfterReopen;
  const bands = [
    { from: 1, to: terminal, version: 1 },
    { from: terminal + 1, to: terminal + pending, version: 2 },
    { from: terminal + pending + 1, to: terminal + pending + terminalAfterReopen, version: 3 },
    { from: terminal + pending + terminalAfterReopen + 1, to: size, version: 4 },
  ];

  const startedAt = performance.now();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const band of bands) {
      if (band.to < band.from) continue;
      await client.query(
        `INSERT INTO customer_duplicate_reviews(id,organization_id,customer_a_id,customer_b_id,version)
         SELECT ('20000000-0000-4000-8000-'||lpad(k::text,12,'0'))::uuid,$1,
                ('10000000-0000-4000-8000-'||lpad((2*k-1)::text,12,'0'))::uuid,
                ('10000000-0000-4000-8000-'||lpad((2*k)::text,12,'0'))::uuid,$2
         FROM generate_series($3::int,$4::int) k`, [organizationId, band.version, band.from, band.to],
      );
      const ids = Array.from({ length: band.to - band.from + 1 }, (_, index) => band.from + index);
      if (band.version === 1) await insertEvents(client, ids, 1, 1, null);
      if (band.version === 2) await insertEvents(client, ids, 1, 2, 2);
      if (band.version === 3) await insertEvents(client, ids, 1, 3, 2);
      if (band.version === 4) await insertEvents(client, ids, 1, 4, 4);
    }
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  // Same pair UUIDs in another organization must never leak into org A's read.
  const foreignClient = await pool.connect();
  try {
    await foreignClient.query('BEGIN');
    await foreignClient.query(
      `INSERT INTO customer_duplicate_reviews(id,organization_id,customer_a_id,customer_b_id,version)
       SELECT ('30000000-0000-4000-8000-'||lpad(k::text,12,'0'))::uuid,$1,
              ('10000000-0000-4000-8000-'||lpad((2*k-1)::text,12,'0'))::uuid,
              ('10000000-0000-4000-8000-'||lpad((2*k)::text,12,'0'))::uuid,1
       FROM generate_series(1,32) k`, [foreignOrganizationId],
    );
    await foreignClient.query(
      `INSERT INTO customer_duplicate_review_events(id,organization_id,review_id,seq,event_kind,resulting_status,
         reason_code,actor_user_id,evidence_schema_version,matching_rule_version,evidence_key_id,evidence_digest,
         matching_codes,conflicting_tax_numbers)
       SELECT gen_random_uuid(),$1,('30000000-0000-4000-8000-'||lpad(k::text,12,'0'))::uuid,1,
              'DECISION_RECORDED','CONFIRMED_DUPLICATE','SAME_OPERATIONAL_CUSTOMER_VERIFIED',$2,1,
              'crm-duplicate-v1','synthetic',decode(repeat('0b',32),'hex'),ARRAY['SAME_NAME'],false
       FROM generate_series(1,32) k`, [foreignOrganizationId, actorUserId],
    );
    await foreignClient.query('SET CONSTRAINTS ALL IMMEDIATE');
    await foreignClient.query('COMMIT');
  } catch (error) {
    await foreignClient.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    foreignClient.release();
  }
  report[`seed_${size}`] = {
    ms: Math.round(performance.now() - startedAt),
    reviews: size,
    events: terminal + pending * 2 + terminalAfterReopen * 3 + reopened * 4,
    bands: { terminal, pending, terminalAfterReopen, reopened },
  };
}

async function parity(pool: Pool, pairs: Array<{ customerAId: string; customerBId: string }>) {
  const params = [organizationId, pairs.map((item) => item.customerAId), pairs.map((item) => item.customerBId)];
  const legacy = await pool.query(LEGACY_REVIEW_HEADS_SQL, params);
  const optimized = await pool.query(DUPLICATE_REVIEW_HEADS_SQL, params);
  const legacyRows = normalize(legacy.rows);
  const optimizedRows = normalize(optimized.rows);
  expect(optimizedRows).toEqual(legacyRows);
  expect(optimized.rows).toHaveLength(pairs.length);
  return optimized.rows as Array<Record<string, unknown>>;
}

beforeAll(async () => {
  if (!enabled) return;
  for (const size of sizes) await seedSchema(size);
}, 1_800_000);

afterAll(async () => {
  for (const pool of pools.values()) await pool.end();
  for (const schema of schemas.values()) await admin!.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  if (admin) await admin.end();
  if (enabled) {
    const payload = JSON.stringify({
      environment: {
        platform: process.platform, arch: process.arch, node: process.version,
        cpus: os.cpus().length, totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024),
        postgres: 'postgres:17-alpine (SCRAM)',
      },
      ...report,
    }, null, 2);
    const output = process.env.CRM_DUPLICATE_PERF_OUT;
    if (output) writeFileSync(output, payload);
    console.log(`CRM_DUPLICATE_REVIEW_HEADS_PERF ${payload}`);
  }
}, 1_800_000);

it.skipIf(!enabled)('PERF-HEADS: 0/1k/20k populations, 1/20/32 batches, legacy vs shipped plans and semantics', { timeout: 900_000 }, async () => {
  const scenarios: Record<string, unknown> = {};
  const parityChecks: Record<string, unknown> = {};
  let queryCountEvidence: { shippedRepository: number } | null = null;

  for (const size of sizes) {
    const pool = pools.get(size)!;
    const client = await pool.connect();
    try {
      await client.query('SET statement_timeout = 30000');
      for (const batch of [1, 20, 32] as const) {
        const pairs = scenarioPairIndexes(batch).map(pair);
        const params = [organizationId, pairs.map((item) => item.customerAId), pairs.map((item) => item.customerBId)];
        const key = `${size}_${batch}`;

        const legacyRows = await parity(pool, pairs);
        const legacyPlan = await explain(client, LEGACY_REVIEW_HEADS_SQL, params);
        const optimizedPlan = await explain(client, DUPLICATE_REVIEW_HEADS_SQL, params);
        const legacyTiming = await timeQuery(client, LEGACY_REVIEW_HEADS_SQL, params);
        const optimizedTiming = await timeQuery(client, DUPLICATE_REVIEW_HEADS_SQL, params);

        scenarios[key] = {
          reviews: size, batch, resultRows: legacyRows.length,
          legacy: { timing: legacyTiming, plan: legacyPlan },
          optimized: { timing: optimizedTiming, plan: optimizedPlan },
        };

        // Semantic expectations are state-band driven and must hold for both queries.
        const byPair = new Map(legacyRows.map((row) => [`${row.customer_a_id}:${row.customer_b_id}`, row]));
        for (const wanted of pairs) {
          const row = byPair.get(`${wanted.customerAId}:${wanted.customerBId}`)!;
          expect(row).toBeTruthy();
          expect(row.customer_a_id as string).toBe(wanted.customerAId);
          expect(row.customer_a_id as string < (row.customer_b_id as string)).toBe(true);
          if (size === 0) {
            expect(row.id).toBeNull();
            expect(row.event_id).toBeNull();
            continue;
          }
          expect(row.id).toBeTruthy();
          expect(row.event_id).toBeTruthy();
          expect(row.seq).toBe(row.version);
          if (row.event_kind === 'REVIEW_REOPENED') expect(row.previous_decision_id).toBeTruthy();
          else expect(row.previous_decision_id).toBeNull();
        }
      }

      // Unreviewed pairs must keep the null-head contract, and ordering stays canonical.
      const unreviewed = [20_001, 20_005, 20_010, 20_020, 20_032].map(pair);
      const nullHeads = await parity(pool, unreviewed);
      expect(nullHeads.every((row) => row.id === null && row.event_id === null)).toBe(true);
      const ordered = nullHeads.map((row) => `${row.customer_a_id}:${row.customer_b_id}`);
      expect(ordered).toEqual([...ordered].sort());

      // Organization isolation: identical pair UUIDs in the foreign org return only its rows.
      const foreign = await pool.query(DUPLICATE_REVIEW_HEADS_SQL, [
        foreignOrganizationId,
        [customerId(1), customerId(3)], [customerId(2), customerId(4)],
      ]);
      expect(foreign.rows).toHaveLength(2);
      expect(foreign.rows.every((row) => row.id === foreignReviewId(1) || row.id === foreignReviewId(2))).toBe(true);
      expect(foreign.rows.every((row) => row.resulting_status === 'CONFIRMED_DUPLICATE')).toBe(true);

      // One data query per repository batch read, never an N+1.
      const repository = new PostgresDuplicateReadRepository(pool);
      const pair32 = scenarioPairIndexes(32).map(pair);
      const instrument = instrumentQueries();
      try {
        const heads = await repository.snapshot((snapshot) => snapshot.reviewHeads(organizationId, pair32));
        expect(heads.size).toBe(size === 0 ? 0 : 32);
      } finally { instrument.restore(); }
      parityChecks[size] = {
        reviewedPairs: new Set([1, 20, 32].flatMap((batch) => scenarioPairIndexes(batch as 1 | 20 | 32))).size,
        nullHeads: nullHeads.length,
        foreignOrgRows: foreign.rows.length,
        repositoryDataQueries: instrument.counter.data,
        repositoryControlQueries: instrument.counter.control,
      };
      if (size === 20_000) {
        queryCountEvidence = { shippedRepository: instrument.counter.data };
      }

      if (size > 0) {
        // The shipped plan must probe the canonical pair index per wanted pair,
        // not scan/sort every review in the organization.
        const plan = (scenarios[`${size}_32`] as {
          optimized: { plan: { seqScans: string[]; indexes: string[]; relationLoopRows: Record<string, number> } };
        }).optimized.plan;
        expect(plan.seqScans).not.toContain('customer_duplicate_reviews');
        expect(plan.seqScans).not.toContain('customer_duplicate_review_events');
        expect(plan.indexes).toContain('customer_duplicate_reviews_pair_unique');
        expect(plan.indexes).toContain('customer_duplicate_review_events_sequence_unique');
        expect(plan.relationLoopRows.customer_duplicate_reviews ?? 0).toBeLessThanOrEqual(32);
        expect(plan.relationLoopRows.customer_duplicate_review_events ?? 0).toBeLessThanOrEqual(96);
      }
    } finally {
      client.release();
    }
  }

  // Broken event chains stay fail-closed: the batch SQL yields the review with a
  // missing event, and the service-level read refuses the whole snapshot.
  const brokenPool = pools.get(1_000)!;
  await brokenPool.query('ALTER TABLE customer_duplicate_reviews DISABLE TRIGGER ALL');
  await brokenPool.query('ALTER TABLE customer_duplicate_review_events DISABLE TRIGGER ALL');
  await brokenPool.query(
    'DELETE FROM customer_duplicate_review_events WHERE organization_id=$1 AND review_id=$2 AND seq=4',
    [organizationId, reviewId(999)],
  );
  await brokenPool.query('ALTER TABLE customer_duplicate_reviews ENABLE TRIGGER ALL');
  await brokenPool.query('ALTER TABLE customer_duplicate_review_events ENABLE TRIGGER ALL');
  const broken = await brokenPool.query(DUPLICATE_REVIEW_HEADS_SQL, [organizationId, [customerId(1997)], [customerId(1998)]]);
  expect(broken.rows).toHaveLength(1);
  expect(broken.rows[0]!.id).toBe(reviewId(999));
  expect(broken.rows[0]!.event_id).toBeNull();
  const legacyBroken = await brokenPool.query(LEGACY_REVIEW_HEADS_SQL, [organizationId, [customerId(1997)], [customerId(1998)]]);
  expect(normalize(broken.rows)).toEqual(normalize(legacyBroken.rows));
  const repository = new PostgresDuplicateReadRepository(brokenPool);
  await expect(repository.snapshot((snapshot) => snapshot.reviewHeads(organizationId, [pair(999)])))
    .rejects.toMatchObject({ code: 'REVIEW_TEMPORARILY_UNAVAILABLE' });
  parityChecks.brokenChain = 'FAIL_CLOSED';

  report.scenarios = scenarios;
  report.parity = parityChecks;
  report.queryCountPerBatchRead = queryCountEvidence;
  console.log(`CRM_DUPLICATE_REVIEW_HEADS_SUMMARY ${JSON.stringify({
    queryCountPerBatchRead: queryCountEvidence,
    parity: parityChecks,
  })}`);
});
