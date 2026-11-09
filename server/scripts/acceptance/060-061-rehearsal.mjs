/**
 * 060 -> 061 migration rehearsal on a disposable PostgreSQL 17 database.
 * Uses the real forward-only runner; never touches production.
 *
 * Phase 1 (060 DB): apply 001..060 only via the real runner.
 * Phase 2: seed representative 060-era business data + capture baseline.
 * Phase 3: apply 061 via the real runner and verify every gate invariant.
 */
import { readdir, mkdtemp, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL required');

const SOURCE = process.env.MIGRATIONS_DIR;
if (!SOURCE) throw new Error('MIGRATIONS_DIR required');

// Defense in depth: the script runs forward migrations and inserts fixtures.
// Never trust DATABASE_URL alone, even when invoked from a rehearsal shell.
// The names are intentionally limited to the two disposable databases used
// by the 060→061 acceptance and restore rehearsal.
const permittedDatabases = new Set([
  'servora_med_rehearsal_060_061',
  'servora_med_rehearsal_060_061_restored',
]);
const targetDatabase = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
if (process.env.SERVORA_REHEARSAL_ACK !== 'DISPOSABLE_ONLY'
  || !permittedDatabases.has(targetDatabase)) {
  throw new Error('Rehearsal refused: explicit disposable acknowledgement and approved database name required');
}

const phase = process.argv[2]; // 'baseline' | 'upgrade'
if (phase !== 'baseline' && phase !== 'upgrade') {
  throw new Error('phase must be baseline or upgrade');
}
const report = (label, value) => console.log(`${label}=${JSON.stringify(value)}`);

const pool = new Pool({ connectionString: databaseUrl });
const actualDatabase = await pool.query('SELECT current_database() AS name');
if (actualDatabase.rows[0]?.name !== targetDatabase) {
  await pool.end();
  throw new Error('Rehearsal refused: connected database does not match the disposable target');
}

async function runMigrationsLike(directory) {
  const { runMigrations } = await import('../../dist/db/migrate-runner.js');
  const { PostgresMigrationStore } = await import('../../dist/db/index.js');
  return runMigrations({ migrationsDirectory: directory, store: new PostgresMigrationStore(pool) });
}

const DIGEST_TABLES = [
  'weekly_reports', 'weekly_report_submissions', 'job_cards',
  'job_card_activity_logs', 'audit_events', 'processed_actions',
  'job_card_lifecycle_intents',
];

async function tableDigest(table) {
  const exists = await pool.query('SELECT to_regclass(current_schema() || $1) AS t', [`.${table}`]);
  if (!exists.rows[0]?.t) return { present: false, count: 0, digest: null };
  // Strip 061's new columns so the 060 and 061 digests are directly
  // comparable: migration 061 must not alter any pre-existing value.
  const stripped = `(to_jsonb(x) - 'removed_at' - 'removed_by' - 'removal_reason')`;
  const result = await pool.query(
    `SELECT count(*)::int AS count,
            md5(coalesce(string_agg(${stripped}::text, '|' ORDER BY ${stripped}::text), '')) AS digest
       FROM ${table} x`,
  );
  return { present: true, ...result.rows[0] };
}

async function captureBaseline() {
  const baseline = {};
  for (const table of DIGEST_TABLES) baseline[table] = await tableDigest(table);
  const indexes = await pool.query(
    `SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename = 'weekly_reports'
      ORDER BY indexname`,
  );
  const constraints = await pool.query(
    `SELECT conname FROM pg_constraint
      WHERE conrelid = to_regclass(current_schema() || '.weekly_reports')
      ORDER BY conname`,
  );
  return {
    tables: baseline,
    indexes: indexes.rows,
    constraints: constraints.rows.map((r) => r.conname),
  };
}

if (phase === 'baseline') {
  // 1. Apply the 060 catalog only, through the real runner.
  const all = (await readdir(SOURCE)).filter((f) => f.endsWith('.sql')).sort();
  const upTo060 = all.filter((f) => f < '061_');
  const staging = await mkdtemp(path.join(tmpdir(), 'wr061-060-'));
  try {
    for (const name of upTo060) await copyFile(path.join(SOURCE, name), path.join(staging, name));
    const applied = await runMigrationsLike(staging);
    report('applied_to_060', { count: applied.appliedVersions.length, head: applied.appliedVersions.at(-1) });
    if (applied.appliedVersions.at(-1) !== '060_crm_duplicate_review_decisions') {
      throw new Error('did not stop at 060');
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }

  // 2. Seed representative 060-era data: a completed report with a frozen
  //    submission, a source JobCard, activity, audit and an idempotency receipt.
  const org = (await pool.query(
    `INSERT INTO organizations (name, timezone) VALUES ('WR061 rehearsal','Europe/Istanbul') RETURNING id`,
  )).rows[0].id;
  const user = async (role, name) => (await pool.query(
    `INSERT INTO users (organization_id,name,email,password_hash,role)
     VALUES ($1,$2,$3,'rehearsal-hash',$4) RETURNING id`,
    [org, name, `${role.toLowerCase()}-${name.replace(/\s+/g, '')}@rehearsal.test`, role],
  )).rows[0].id;
  const admin = await user('ADMIN', 'Rehearsal Admin');
  const staff = await user('STAFF', 'Rehearsal Staff');

  const sourceJob = (await pool.query(
    `INSERT INTO job_cards (organization_id,type,status,title,assigned_to,created_by,
       staff_completed_at,staff_completed_by,manager_approved_at,manager_approved_by,started_at,version)
     VALUES ($1,'GENERAL_TASK','COMPLETED','Rehearsal clinical visit',$2,$2,
       '2026-08-03T08:00:00Z',$2,'2026-08-04T08:00:00Z',$3,'2026-08-03T07:00:00Z',4) RETURNING id`,
    [org, staff, admin],
  )).rows[0].id;

  const reportJob = (await pool.query(
    `INSERT INTO job_cards (organization_id,type,status,title,assigned_to,created_by,
       started_at,staff_completed_at,staff_completed_by,manager_approved_at,manager_approved_by,version)
     VALUES ($1,'WEEKLY_REPORT','COMPLETED','Weekly report 2026-W32',$2,$2,
       '2026-08-03T07:00:00Z','2026-08-05T12:00:00Z',$2,'2026-08-06T09:00:00Z',$3,4) RETURNING id`,
    [org, staff, admin],
  )).rows[0].id;

  const weekly = (await pool.query(
    `INSERT INTO weekly_reports (organization_id,job_card_id,staff_user_id,period_start,period_end,
       draft_summary,manager_questions,manager_answers,version)
     VALUES ($1,$2,$3,'2026-08-03','2026-08-09','Rehearsal week summary','[]','[]',3) RETURNING id`,
    [org, reportJob, staff],
  )).rows[0].id;

  await pool.query(
    `INSERT INTO weekly_report_submissions (organization_id,weekly_report_id,job_card_id,seq_no,
       submitted_by,submitted_at,period_start,period_end,frozen_body,frozen_questions,frozen_answers,
       frozen_source_work,job_version,source_activity_id)
     VALUES ($1,$2,$3,1,$4,'2026-08-05T12:00:00Z','2026-08-03','2026-08-09',
       '{"summary":"frozen"}'::jsonb,'[]'::jsonb,'[]'::jsonb,
       jsonb_build_array(jsonb_build_object('jobCardId',$5::text)),4,$6)`,
    [org, weekly, reportJob, staff, sourceJob,
      (await pool.query(
        `INSERT INTO job_card_activity_logs (organization_id,job_card_id,actor_id,event_type,
           old_value,new_value,metadata)
         VALUES ($1,$2,$3,'JOB_SUBMITTED_FOR_APPROVAL','{}'::jsonb,'{"status":"WAITING_APPROVAL"}'::jsonb,'{}'::jsonb)
         RETURNING id`,
        [org, reportJob, staff],
      )).rows[0].id],
  );

  await pool.query(
    `INSERT INTO job_card_activity_logs (organization_id,job_card_id,actor_id,event_type,
       old_value,new_value,metadata)
     VALUES ($1,$2,$3,'JOB_CREATED','{}'::jsonb,'{"status":"NEW"}'::jsonb,'{}'::jsonb)`,
    [org, reportJob, staff],
  );
  await pool.query(
    `INSERT INTO audit_events (organization_id,actor_user_id,subject_type,subject_id,event_type,
       old_value,new_value,metadata)
     VALUES ($1,$2,'JOB_CARD',$3,'JOB_CARD_INVALIDATED','{"s":1}'::jsonb,'{"s":2}'::jsonb,'{}'::jsonb)`,
    [org, admin, sourceJob],
  );
  await pool.query(
    `INSERT INTO processed_actions (organization_id,user_id,client_action_id,operation_key,
       request_hash,status,status_code,response_body,completed_at)
     VALUES ($1,$2,$3,'WEEKLY_REPORT_CREATE:rehearsal',repeat('ab',32),'completed',200,'{}'::jsonb,now())`,
    [org, staff, '00000000-0000-4000-8000-000000000001'],
  );
  const baseline = await captureBaseline();
  baseline.seed = { organizationId: org, adminId: admin, staffId: staff,
    sourceJobId: sourceJob, reportJobId: reportJob, weeklyReportId: weekly };
  report('baseline', baseline);
} else if (phase === 'upgrade') {
  const before = JSON.parse(process.env.BASELINE_JSON);
  const applied = await runMigrationsLike(SOURCE);
  report('applied_061', applied.appliedVersions);

  const head = await pool.query('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1');
  const count = await pool.query('SELECT count(*)::int AS n FROM schema_migrations');
  report('catalog_after', { head: head.rows[0].version, count: count.rows[0].n });

  const after = await captureBaseline();
  const changed = [];
  for (const table of DIGEST_TABLES) {
    if (JSON.stringify(after.tables[table]) !== JSON.stringify(before.tables[table])) {
      changed.push({ table, before: before.tables[table], after: after.tables[table] });
    }
  }
  report('digest_drift', changed);
  report('indexes_after', after.indexes);
  report('constraints_before', before.constraints.filter((c) => c.includes('staff_user_id_period_start')));
  report('constraints_after', after.constraints.filter((c) => c.includes('staff_user_id_period_start')));

  const partial = await pool.query(
    `SELECT indexdef FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename='weekly_reports'
        AND indexname='weekly_reports_current_staff_week_key'`,
  );
  report('partial_index', partial.rows[0]?.indexdef ?? null);

  const legacy = await pool.query(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE removed_at IS NOT NULL)::int AS removed
       FROM weekly_reports`,
  );
  report('legacy_removal_flags', legacy.rows[0]);

  const dupes = await pool.query(
    `SELECT count(*)::int AS n FROM (
       SELECT 1 FROM weekly_reports WHERE removed_at IS NULL
        GROUP BY organization_id, staff_user_id, period_start HAVING count(*) > 1) d`,
  );
  report('duplicate_active_staff_week', dupes.rows[0].n);

  // Re-apply must be a no-op.
  const again = await runMigrationsLike(SOURCE);
  report('reapply', again.appliedVersions);
} else {
  throw new Error('phase must be baseline or upgrade');
}

await pool.end();
