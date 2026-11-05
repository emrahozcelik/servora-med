import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

describe.skipIf(!databaseUrl)('BR5-TT-1 migration 061', () => {
  const adminPool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
  let pool: Pool;
  const schema = `br5tt1_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    if (!adminPool) return;
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
    await runMigrations({
      migrationsDirectory,
      store: new PostgresMigrationStore(pool),
    });
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool?.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM backup_runs');
  });

  it('adds nullable evidence columns with no defaults and no backfill', async () => {
    const columns = await pool.query<{
      table_name: string;
      column_name: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT table_name, column_name, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = $1
          AND ((table_name = 'backup_worker_state'
                AND column_name IN ('worker_heartbeat_time_evidence', 'scheduler_last_tick_time_evidence'))
            OR (table_name = 'backup_runs'
                AND column_name IN ('artifact_generation_id', 'artifact_generation_time_evidence',
                                    'verification_time_evidence')))
        ORDER BY table_name, column_name`,
      [schema],
    );
    expect(columns.rows).toHaveLength(5);
    for (const column of columns.rows) {
      expect(column.is_nullable).toBe('YES');
      expect(column.column_default).toBeNull();
    }

    const source = await readFile(
      fileURLToPath(new URL('../src/db/migrations/061_backup_worker_trusted_time_evidence.sql', import.meta.url)),
      'utf8',
    );
    expect(source).not.toMatch(/\bUPDATE\s+backup_(runs|worker_state)\b/i);
    expect(source).not.toMatch(/\bINSERT\s+INTO\s+backup_(runs|worker_state)\b/i);
  });

  it('enforces heartbeat timestamp/evidence atomicity and object shape', async () => {
    await expect(pool.query(
      `UPDATE backup_worker_state
          SET worker_heartbeat_time_evidence = '{}'::jsonb
        WHERE singleton`,
    )).rejects.toThrow(/backup_worker_state_worker_evidence_check/);
    await expect(pool.query(
      `UPDATE backup_worker_state
          SET worker_heartbeat_at = NOW(), worker_heartbeat_time_evidence = '[]'::jsonb
        WHERE singleton`,
    )).rejects.toThrow(/backup_worker_state_worker_evidence_check/);
    await expect(pool.query(
      `UPDATE backup_worker_state
          SET scheduler_last_tick_time_evidence = '{"formatVersion":2}'::jsonb
        WHERE singleton`,
    )).rejects.toThrow(/backup_worker_state_scheduler_evidence_check/);

    await pool.query(
      `UPDATE backup_worker_state
          SET worker_heartbeat_at = NOW(),
              worker_heartbeat_time_evidence = '{"formatVersion":2}'::jsonb,
              scheduler_last_tick_at = NOW(),
              scheduler_last_tick_time_evidence = '{"formatVersion":2}'::jsonb
        WHERE singleton`,
    );
  });

  it('rejects generation evidence without a generation ID and enforces one generation per run', async () => {
    const id = randomUUID();
    await expect(pool.query(
      `INSERT INTO backup_runs (id, status, origin, scope, retention_class,
                                artifact_generation_time_evidence)
       VALUES ($1, 'QUEUED', 'SCHEDULED', 'DATABASE', 'DAILY', '{"formatVersion":2}'::jsonb)`,
      [id],
    )).rejects.toThrow(/backup_runs_artifact_generation_evidence_check/);

    const generation = randomUUID();
    await pool.query(
      `INSERT INTO backup_runs (id, status, origin, scope, retention_class,
                                artifact_generation_id, artifact_generation_time_evidence)
       VALUES ($1, 'QUEUED', 'SCHEDULED', 'DATABASE', 'DAILY', $2, '{"formatVersion":2}'::jsonb)`,
      [id, generation],
    );
    await pool.query(
      `UPDATE backup_runs
          SET status = 'FAILED', failure_code = 'WORKER_LOST', failure_summary = 'test',
              completed_at = NOW()
        WHERE id = $1`,
      [id],
    );
    await expect(pool.query(
      `UPDATE backup_runs SET artifact_generation_time_evidence = '{"formatVersion":2,"x":1}'::jsonb
        WHERE id = $1`,
      [id],
    )).rejects.toThrow(/immutable/);

    const other = randomUUID();
    await expect(pool.query(
      `INSERT INTO backup_runs (id, status, origin, scope, retention_class,
                                artifact_generation_id, artifact_generation_time_evidence)
       VALUES ($1, 'QUEUED', 'SCHEDULED', 'DATABASE', 'DAILY', $2, '{"formatVersion":2}'::jsonb)`,
      [other, generation],
    )).rejects.toThrow(/backup_runs_artifact_generation_unique/);
  });

  it('rejects a proof without integrity fields and enforces proof binding', async () => {
    const id = randomUUID();
    const generation = randomUUID();
    const sha = 'a'.repeat(64);
    const proof = JSON.stringify({
      proofVersion: 2,
      runId: id,
      artifactGenerationId: generation,
      artifactSha256: sha,
      sizeBytes: 1024,
      remoteAttemptId: randomUUID(),
      origin: 'SCHEDULED',
      remoteKey: `key/${id}.sbk.age`,
      verifiedAt: '2026-11-04T10:00:00.000Z',
      before: {},
      after: {},
    });

    await expect(pool.query(
      `INSERT INTO backup_runs (id, status, phase, origin, scope, retention_class,
                                started_at, artifact_generation_id,
                                artifact_generation_time_evidence, verification_time_evidence)
       VALUES ($1, 'RUNNING', 'REMOTE_VERIFY', 'SCHEDULED', 'DATABASE', 'DAILY', NOW(), $2,
               '{"formatVersion":2}'::jsonb, $3::jsonb)`,
      [id, generation, proof],
    )).rejects.toThrow(/backup_runs_verification_evidence_check/);

    await pool.query(
      `INSERT INTO backup_runs (id, status, phase, origin, scope, retention_class,
                                started_at, artifact_generation_id,
                                artifact_generation_time_evidence, remote_key, size_bytes, sha256,
                                verification_time_evidence)
       VALUES ($1, 'RUNNING', 'REMOTE_VERIFY', 'SCHEDULED', 'DATABASE', 'DAILY', NOW(), $2,
               '{"formatVersion":2}'::jsonb, $3, 1024, $4, $5::jsonb)`,
      [id, generation, `key/${id}.sbk.age`, sha, proof],
    );

    const nullFieldId = randomUUID();
    const nullFieldGeneration = randomUUID();
    const nullFieldProof = JSON.stringify({
      ...JSON.parse(proof),
      runId: null,
      artifactGenerationId: nullFieldGeneration,
      remoteKey: `key/${nullFieldId}.sbk.age`,
    });
    await expect(pool.query(
      `INSERT INTO backup_runs (id, status, phase, origin, scope, retention_class,
                                started_at, artifact_generation_id,
                                artifact_generation_time_evidence, remote_key, size_bytes, sha256,
                                verification_time_evidence)
       VALUES ($1, 'RUNNING', 'REMOTE_VERIFY', 'SCHEDULED', 'DATABASE', 'DAILY', NOW(), $2,
               '{"formatVersion":2}'::jsonb, $3, 1024, $4, $5::jsonb)`,
      [nullFieldId, nullFieldGeneration, `key/${nullFieldId}.sbk.age`, sha, nullFieldProof],
    )).rejects.toThrow(/backup_runs_verification_evidence_check/);

    await expect(pool.query(
      `UPDATE backup_runs
          SET status = 'SUCCESS', verified_at = '2026-11-04T10:00:01.000Z', completed_at = NOW()
        WHERE id = $1`,
      [id],
    )).rejects.toThrow(/backup_runs_verification_evidence_check/);

    await pool.query(
      `UPDATE backup_runs
          SET status = 'SUCCESS', verified_at = '2026-11-04T10:00:00.000Z', completed_at = NOW()
        WHERE id = $1`,
      [id],
    );

    await expect(pool.query(
      `UPDATE backup_runs SET verification_time_evidence = jsonb_set(
         verification_time_evidence, '{verifiedAt}', '"2026-11-04T11:00:00.000Z"')
       WHERE id = $1`,
      [id],
    )).rejects.toThrow(/immutable/);
  });

  it('keeps legacy rows nullable and readable without synthetic evidence', async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO backup_runs (id, status, origin, scope, retention_class,
                                created_at, started_at, completed_at, remote_key, size_bytes,
                                sha256, verified_at)
       VALUES ($1, 'SUCCESS', 'SCHEDULED', 'DATABASE', 'DAILY', NOW(), NOW(), NOW(),
               $2, 1024, $3, NOW())`,
      [id, `legacy/${id}.sbk.age`, 'b'.repeat(64)],
    );
    const row = await pool.query<{
      artifact_generation_id: string | null;
      artifact_generation_time_evidence: unknown;
      verification_time_evidence: unknown;
    }>(
      `SELECT artifact_generation_id, artifact_generation_time_evidence, verification_time_evidence
         FROM backup_runs WHERE id = $1`,
      [id],
    );
    expect(row.rows[0]).toEqual({
      artifact_generation_id: null,
      artifact_generation_time_evidence: null,
      verification_time_evidence: null,
    });
  });

  it('migrates a real 060 database to 061 once without data loss or backfill', async () => {
    const legacyDirectory = await mkdtemp(path.join(tmpdir(), 'br5tt1-060-'));
    const legacySchema = `br5tt1_mig_${randomUUID().replaceAll('-', '')}`;
    let legacyPool: Pool | null = null;
    try {
      for (const entry of await readdir(migrationsDirectory)) {
        if (!/^\d{3}_.+\.sql$/.test(entry)) continue;
        if (Number(entry.slice(0, 3)) > 60) continue;
        await copyFile(path.join(migrationsDirectory, entry), path.join(legacyDirectory, entry));
      }
      await adminPool!.query(`CREATE SCHEMA ${legacySchema}`);
      legacyPool = new Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${legacySchema},public`,
      });
      const store = new PostgresMigrationStore(legacyPool);
      const before = await runMigrations({ migrationsDirectory: legacyDirectory, store });
      expect(before.appliedVersions.at(-1)).toBe('060_crm_duplicate_review_decisions');

      const id = randomUUID();
      await legacyPool.query(
        `INSERT INTO backup_runs
          (id, status, origin, scope, retention_class, created_at, started_at, completed_at,
           remote_key, size_bytes, sha256, verified_at, warning_code, warning_summary)
         VALUES ($1, 'SUCCESS', 'SCHEDULED', 'DATABASE', 'DAILY', NOW(), NOW(), NOW(),
                 $2, 1024, $3, NOW(), 'CLEANUP_FAILED', 'legacy warning')`,
        [id, `legacy/${id}.sbk.age`, 'c'.repeat(64)],
      );
      const beforeRow = await legacyPool.query(
        `SELECT status, remote_key, size_bytes, sha256, verified_at, warning_code, warning_summary
           FROM backup_runs WHERE id = $1`,
        [id],
      );

      const after = await runMigrations({ migrationsDirectory, store });
      expect(after.appliedVersions).toEqual(['061_backup_worker_trusted_time_evidence']);
      const head = await legacyPool.query<{ version: string }>(
        'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1',
      );
      expect(head.rows[0]?.version).toBe('061_backup_worker_trusted_time_evidence');

      const afterRow = await legacyPool.query(
        `SELECT status, remote_key, size_bytes, sha256, verified_at, warning_code, warning_summary,
                artifact_generation_id, artifact_generation_time_evidence, verification_time_evidence
           FROM backup_runs WHERE id = $1`,
        [id],
      );
      expect(afterRow.rows[0]).toMatchObject(beforeRow.rows[0]);
      expect(afterRow.rows[0]?.artifact_generation_id).toBeNull();
      expect(afterRow.rows[0]?.artifact_generation_time_evidence).toBeNull();
      expect(afterRow.rows[0]?.verification_time_evidence).toBeNull();

      const rerun = await runMigrations({ migrationsDirectory, store });
      expect(rerun.appliedVersions).toEqual([]);
      const count = await legacyPool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM backup_runs',
      );
      expect(count.rows[0]?.count).toBe('1');
    } finally {
      await legacyPool?.end();
      await adminPool?.query(`DROP SCHEMA IF EXISTS ${legacySchema} CASCADE`);
      await rm(legacyDirectory, { recursive: true, force: true });
    }
  });
});
