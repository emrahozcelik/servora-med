// Synthetic PR2 command acceptance. Run only in an owned Linux Node22/PG17
// environment with two shared CPU cores and a combined 4 GiB memory budget.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { availableParallelism, platform } from 'node:os';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { PostgresMigrationStore } from '../dist/db/index.js';
import { runMigrations } from '../dist/db/migrate-runner.js';
import { toErrorResponse, AppError } from '../dist/errors/index.js';
import { duplicateRoutes } from '../dist/modules/crm/duplicate-routes.js';
import { DuplicateComparisonService } from '../dist/modules/crm/duplicate-service.js';
import { DuplicateReviewService } from '../dist/modules/crm/duplicate-review-service.js';
import { PostgresDuplicateReadRepository } from '../dist/modules/crm/duplicate-repository.js';
import { PostgresDuplicateReviewRepository } from '../dist/modules/crm/duplicate-review-repository.js';
import { parseDuplicateKeyring } from '../dist/modules/crm/duplicate-evidence.js';

assert.equal(platform(), 'linux'); assert.equal(process.versions.node.split('.')[0], '22'); assert.equal(availableParallelism(), 2);
const url = new URL(process.env.T5_DATABASE_URL);
assert.equal(url.pathname, '/servora_med_test_pr380_t5');
const out = process.env.T5_OUT;
assert.ok(out); mkdirSync(out, { recursive: true });
const schema = `pr380_t5_${randomUUID().replaceAll('-', '')}`;
const applicationName = schema;
const bootstrap = new Pool({ connectionString: url.toString(), max: 1 });
const pool = new Pool({ connectionString: url.toString(), max: 10, connectionTimeoutMillis: 1_000, application_name: applicationName, options: `-c search_path=${schema},public` });
const app = Fastify({ logger: false });
const initialRss = process.memoryUsage().rss;
let peakRss = initialRss; let maxConnections = 0; let maxWaiting = 0;
const sample = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); maxConnections = Math.max(maxConnections, pool.totalCount); maxWaiting = Math.max(maxWaiting, pool.waitingCount); }, 20);
const results = [];
const keys = parseDuplicateKeyring(JSON.stringify({ activeKeyId: 'synthetic', keys: { synthetic: Buffer.alloc(32, 81).toString('base64') } }));
let origin; let sourceCount = 0; let pairIndex = 0; let commandCount = 0;
let lastCommandAt = Date.now(); let quotaUsed = 0;
const customers = [];
const managers = [];
const bodies = [];
const quantile = (values, q) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1];
async function budget(count) {
  if (quotaUsed + count > 100) {
    const wait = Math.max(0, lastCommandAt + 61_000 - Date.now());
    console.log(JSON.stringify({ stage: 'shared-command-quota-wait', milliseconds: wait }));
    await new Promise((resolve) => setTimeout(resolve, wait)); quotaUsed = 0;
  }
  quotaUsed += count;
}
async function post(manager, pair, body) {
  const start = performance.now();
  const response = await fetch(`${origin}/api/customers/duplicate-review-pairs/${pair[0]}/${pair[1]}/decisions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-synthetic-manager': manager.id }, body: JSON.stringify(body), signal: AbortSignal.timeout(5_000),
  });
  const receipt = await response.json();
  lastCommandAt = Date.now();
  return { status: response.status, receipt, ms: performance.now() - start, replayed: response.headers.get('Idempotency-Replayed') };
}
async function decision(manager) {
  const pair = customers.slice(pairIndex * 2, pairIndex++ * 2 + 2);
  const read = await fetch(`${origin}/api/customers/duplicate-review-pairs/${pair[0]}/${pair[1]}`, { headers: { 'x-synthetic-manager': manager.id }, signal: AbortSignal.timeout(5_000) });
  assert.equal(read.status, 200); const comparison = await read.json();
  const body = { clientActionId: randomUUID(), expectedReviewVersion: 0, expectedEvidenceRevision: comparison.evidence.revision,
    matchingRuleVersion: comparison.evidence.matchingRuleVersion, decision: 'DISMISSED', reasonCode: 'DISTINCT_BRANCH' };
  const result = await post(manager, pair, body); assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(result.receipt.reviewVersion, 1); commandCount++;
  bodies.push({ manager, pair, body, receipt: result.receipt });
  return result.ms;
}
try {
  const version = (await bootstrap.query('SHOW server_version_num')).rows[0].server_version_num;
  assert.equal(Math.trunc(Number(version) / 10_000), 17);
  await bootstrap.query(`CREATE SCHEMA ${schema}`);
  await runMigrations({ migrationsDirectory: fileURLToPath(new URL('../dist/db/migrations', import.meta.url)), store: new PostgresMigrationStore(pool) });
  const org = (await pool.query("INSERT INTO organizations(name) VALUES('Synthetic PR380 T5') RETURNING id")).rows[0].id;
  for (let n = 0; n < 10; n++) {
    const id = randomUUID(); await pool.query("INSERT INTO users(id,organization_id,name,email,password_hash,role) VALUES($1,$2,'Synthetic manager',$3,'unused','MANAGER')", [id, org, `${id}@benchmark.invalid`]);
    managers.push({ id, organizationId: org, role: 'MANAGER' });
  }
  await app.register(rateLimit, { global: false });
  app.setErrorHandler((error, _request, reply) => { const result = toErrorResponse(error); reply.code(result.statusCode).send(result.body); });
  await app.register(duplicateRoutes, { prefix: '/api', service: new DuplicateComparisonService(new PostgresDuplicateReadRepository(pool), keys), reviewService: new DuplicateReviewService(new PostgresDuplicateReviewRepository(pool, keys)),
    authenticate: async (request) => { const actor = managers.find((manager) => manager.id === request.headers['x-synthetic-manager']); if (!actor) throw new AppError('FORBIDDEN', 403, 'Synthetic actor required'); request.currentUser = actor; } });
  origin = await app.listen({ host: '127.0.0.1', port: 0 });
  for (const count of [5_000, 20_000]) {
    const added = await pool.query("INSERT INTO customers(organization_id,name,customer_type,status) SELECT $1,'Synthetic clinic','clinic','active' FROM generate_series(1,$2::int) RETURNING id", [org, count - sourceCount]);
    customers.push(...added.rows.map((row) => row.id)); sourceCount = count;
    const coldStart = performance.now();
    const plan = (await pool.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT id FROM customers WHERE organization_id=$1 AND id=ANY($2::uuid[]) ORDER BY id', [org, customers.slice(0, 2)])).rows[0]['QUERY PLAN'];
    const coldPlanWallMs = performance.now() - coldStart;
    writeFileSync(`${out}/command-source-plan-${count}.json`, JSON.stringify(plan, null, 2));
    const latencies = []; let coldCommandMs;
    for (let batch = 0; batch < 22; batch++) {
      await budget(10);
      const values = await Promise.all(managers.map(decision));
      coldCommandMs ??= values[0];
      if (batch >= 2) latencies.push(...values);
      assert.equal(pool.waitingCount, 0);
    }
    const result = { sourceCustomers: count, kind: 'real HTTP DECIDE writes', concurrency: 10, warmupCommands: 20, measuredCommands: latencies.length,
      coldCommandMs, coldPlanWallMs, p95Ms: quantile(latencies, .95), p99Ms: quantile(latencies, .99), maxMs: Math.max(...latencies), samplesMs: latencies };
    assert.equal(latencies.length, 200); assert.ok(result.maxMs < 5_000);
    assert.ok(result.p95Ms <= (count === 5_000 ? 750 : 1_500)); assert.ok(result.p99Ms <= 3_000);
    results.push(result); console.log(JSON.stringify({ ...result, samplesMs: undefined }));
  }
  await budget(10);
  const pair = customers.slice(pairIndex * 2, pairIndex * 2 + 2);
  const read = await new DuplicateComparisonService(new PostgresDuplicateReadRepository(pool), keys).comparison(managers[0], pair[0], pair[1]);
  const contention = await Promise.all(managers.map((manager, index) => post(manager, pair, { clientActionId: randomUUID(), expectedReviewVersion: 0,
    expectedEvidenceRevision: read.evidence.revision, matchingRuleVersion: read.evidence.matchingRuleVersion,
    decision: index % 2 ? 'CONFIRMED_DUPLICATE' : 'DISMISSED', reasonCode: index % 2 ? 'SAME_OPERATIONAL_CUSTOMER_VERIFIED' : 'DISTINCT_BRANCH' })));
  assert.equal(contention.filter((result) => result.status === 200).length, 1); commandCount++;
  for (const result of contention.filter((item) => item.status !== 200)) { assert.equal(result.status, 409); assert.ok(['REVIEW_BUSY', 'VERSION_CONFLICT'].includes(result.receipt.code)); assert.ok(result.ms < 1_000); }
  const counts = (await pool.query(`SELECT (SELECT count(*) FROM customer_duplicate_reviews)::int AS reviews,(SELECT count(*) FROM customer_duplicate_review_events)::int AS events,
    (SELECT count(*) FROM audit_events WHERE subject_type='CUSTOMER_DUPLICATE_REVIEW')::int AS audits,(SELECT count(*) FROM processed_actions WHERE operation_key='CRM_DUPLICATE_DECISION')::int AS receipts`)).rows[0];
  assert.deepEqual(counts, { reviews: commandCount, events: commandCount, audits: commandCount, receipts: commandCount });
  assert.equal(pool.waitingCount, 0); assert.ok(maxConnections <= 10); assert.ok(peakRss - initialRss <= 256 * 1024 * 1024);
  await app.close(); await pool.end();
  assert.equal((await bootstrap.query('SELECT 1 FROM pg_stat_activity WHERE application_name=$1', [applicationName])).rowCount, 0);
  writeFileSync(`${out}/report.json`, JSON.stringify({ status: 'PASS', synthetic: true, sourceSha: process.env.T5_SOURCE_SHA, node: process.version, postgresVersion: version,
    platform: platform(), availableCpuCores: availableParallelism(), sharedCpuSet: '0,1', combinedMemoryBudgetBytes: 4 * 1024 ** 3, nodeMemoryBudgetBytes: 3 * 1024 ** 3, postgresMemoryBudgetBytes: 1024 ** 3,
    measuredPath: 'real HTTP POST /decisions including rate limiter, receipt claim, source locks, event, audit, receipt completion and commit; comparison GET excluded from POST latency',
    commandLimiter: 'unchanged 10/min/actor, 10 actors; shared window waits excluded from latency', results,
    initialRss, peakRss, maxRssIncreaseBytes: peakRss - initialRss, maxConnections, maxWaiting, leakedConnections: 0,
    contention: contention.map(({ status, ms, receipt }) => ({ status, ms, code: receipt.code ?? 'COMPLETED' })), atomicCounts: counts,
    harnessSha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex') }, null, 2));
  console.log('PR380_COMMAND_T5_PASS');
} finally {
  clearInterval(sample); await app.close(); await pool.end().catch(() => {});
  await bootstrap.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await bootstrap.end();
}
