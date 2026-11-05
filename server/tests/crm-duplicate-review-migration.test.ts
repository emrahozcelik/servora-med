import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

async function withSchema(run: (pool: Pool) => Promise<void>): Promise<void> {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `crm4a2m_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool | null = null;
  try {
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema},public`,
    });
    await runMigrations({ migrationsDirectory: MIGRATIONS_DIRECTORY, store: new PostgresMigrationStore(pool) });
    await run(pool);
  } finally {
    await pool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }
}

async function withEmptySchema(run: (pool: Pool) => Promise<void>): Promise<void> {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `crm4a2e_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool | null = null;
  try {
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
    await run(pool);
  } finally {
    await pool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }
}

async function probe(pool: Pool, sql: string, values: unknown[] = []): Promise<string | null> {
  try {
    await pool.query(sql, values);
    return null;
  } catch (error) {
    return (error as { constraint?: string; message: string }).constraint
      ?? (error as { message: string }).message;
  }
}

describe.skipIf(!databaseUrl)('CRM Slice 4A PR2 migration 060', () => {
  it('applies once, records head 060 and is a no-op on reapply', async () => {
    await withSchema(async (pool) => {
      const versions = (await pool.query<{ version: string }>(
        'SELECT version FROM schema_migrations ORDER BY version',
      )).rows.map((row) => row.version);
      expect(versions.at(-1)).toBe('061_backup_worker_trusted_time_evidence');
      const again = await runMigrations({ migrationsDirectory: MIGRATIONS_DIRECTORY, store: new PostgresMigrationStore(pool) });
      expect(again.appliedVersions).toEqual([]);
    });
  });

  it('upgrades a previous 059 head to 060 once without rewriting earlier migrations', async () => {
    await withEmptySchema(async (pool) => {
      const legacy = await mkdtemp(path.join(tmpdir(), 'crm4a2-upgrade-'));
      try {
        for (const name of (await readdir(MIGRATIONS_DIRECTORY)).filter((name) => name.endsWith('.sql') && name < '060_')) {
          await copyFile(path.join(MIGRATIONS_DIRECTORY, name), path.join(legacy, name));
        }
        await rm(path.join(legacy, '060_crm_duplicate_review_decisions.sql'), { force: true });
        const store = new PostgresMigrationStore(pool);
        const before = await runMigrations({ migrationsDirectory: legacy, store });
        expect(before.appliedVersions).toHaveLength(59);
        expect((await pool.query("SELECT to_regclass(current_schema() || '.customer_duplicate_reviews') AS table").then((result) => result.rows[0]?.table))).toBeNull();
        const upgrade = await runMigrations({ migrationsDirectory: MIGRATIONS_DIRECTORY, store });
        expect(upgrade.appliedVersions).toEqual(['060_crm_duplicate_review_decisions', '061_backup_worker_trusted_time_evidence']);
        expect((await pool.query("SELECT to_regclass(current_schema() || '.customer_duplicate_reviews') AS table").then((result) => result.rows[0]?.table))).not.toBeNull();
        expect((await runMigrations({ migrationsDirectory: MIGRATIONS_DIRECTORY, store })).appliedVersions).toEqual([]);
      } finally {
        await rm(legacy, { recursive: true, force: true });
      }
    });
  });

  it('creates the two append-only aggregate/event tables and canonical pair constraints', async () => {
    await withSchema(async (pool) => {
      const reviews = (await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'customer_duplicate_reviews'
          ORDER BY ordinal_position`,
      )).rows.map((row) => row.column_name);
      expect(reviews).toEqual(['id', 'organization_id', 'customer_a_id', 'customer_b_id', 'version', 'created_at']);
      const events = (await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'customer_duplicate_review_events'
          ORDER BY ordinal_position`,
      )).rows.map((row) => row.column_name);
      expect(events).toEqual([
        'id', 'organization_id', 'review_id', 'seq', 'event_kind', 'resulting_status',
        'reason_code', 'actor_user_id', 'occurred_at', 'evidence_schema_version',
        'matching_rule_version', 'evidence_key_id', 'evidence_digest',
        'matching_codes', 'conflicting_tax_numbers',
      ]);
      const constraints = (await pool.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint WHERE conrelid IN (
          'customer_duplicate_reviews'::regclass, 'customer_duplicate_review_events'::regclass
        ) ORDER BY conname`,
      )).rows.map((row) => row.conname);
      expect(constraints).toEqual(expect.arrayContaining([
        'customer_duplicate_reviews_canonical_pair_check',
        'customer_duplicate_reviews_org_id_unique',
        'customer_duplicate_reviews_pair_unique',
        'customer_duplicate_reviews_current_event_fk',
        'customer_duplicate_review_events_owner_fk',
        'customer_duplicate_review_events_sequence_unique',
        'customer_duplicate_review_events_codes_check',
        'customer_duplicate_review_events_state_reason_check',
      ]));
      const currentFk = (await pool.query<{ pg_get_constraintdef: string }>(
        `SELECT pg_get_constraintdef(oid) FROM pg_constraint
          WHERE conrelid = 'customer_duplicate_reviews'::regclass
            AND conname = 'customer_duplicate_reviews_current_event_fk'`,
      )).rows[0]!.pg_get_constraintdef;
      expect(currentFk).toContain('DEFERRABLE INITIALLY DEFERRED');
    });
  });

  it('enforces canonical pair, sequence, state/reason and deferred current-event invariants', async () => {
    await withSchema(async (pool) => {
      const org = (await pool.query<{ id: string }>("INSERT INTO organizations(name) VALUES ('Synthetic') RETURNING id")).rows[0]!.id;
      const actor = (await pool.query<{ id: string }>(
        `INSERT INTO users(organization_id,name,email,password_hash,role)
         VALUES($1,'Manager',$2,'unused','MANAGER') RETURNING id`,
        [org, `${randomUUID()}@t.local`],
      )).rows[0]!.id;
      const a = '10000000-0000-4000-8000-000000000001';
      const b = '10000000-0000-4000-8000-000000000002';
      const review = randomUUID();
      const event = randomUUID();
      expect(await probe(pool,
        `INSERT INTO customer_duplicate_reviews(id,organization_id,customer_a_id,customer_b_id,version)
         VALUES($1,$2,$3,$4,1)`, [review, org, b, a],
      )).toBe('customer_duplicate_reviews_canonical_pair_check');
      await pool.query('BEGIN');
      await pool.query(
        `INSERT INTO customer_duplicate_reviews(id,organization_id,customer_a_id,customer_b_id,version)
         VALUES($1,$2,$3,$4,1)`, [review, org, a, b],
      );
      await expect(pool.query('COMMIT')).rejects.toMatchObject({ constraint: 'customer_duplicate_reviews_current_event_fk' });
      await pool.query('ROLLBACK');
      await pool.query('BEGIN');
      await pool.query(
        `INSERT INTO customer_duplicate_reviews(id,organization_id,customer_a_id,customer_b_id,version)
         VALUES($1,$2,$3,$4,1)`, [review, org, a, b],
      );
      await pool.query(
        `INSERT INTO customer_duplicate_review_events
          (id,organization_id,review_id,seq,event_kind,resulting_status,reason_code,actor_user_id,
           evidence_schema_version,matching_rule_version,evidence_key_id,evidence_digest,
           matching_codes,conflicting_tax_numbers)
         VALUES($1,$2,$3,1,'DECISION_RECORDED','CONFIRMED_DUPLICATE',
           'SAME_OPERATIONAL_CUSTOMER_VERIFIED',$4,1,'crm-duplicate-v1','k1',decode(repeat('00',32),'hex'),
           ARRAY['SAME_NAME'],false)`, [event, org, review, actor],
      );
      await pool.query('COMMIT');
      expect((await pool.query<{ version: number }>('SELECT version FROM customer_duplicate_reviews WHERE id=$1', [review])).rows[0]!.version).toBe(1);
      expect(await probe(pool,
        `INSERT INTO customer_duplicate_reviews(organization_id,customer_a_id,customer_b_id,version)
         VALUES($1,$2,$3,1)`, [org, a, b],
      )).toBe('customer_duplicate_reviews_pair_unique');
      expect(await probe(pool,
        `INSERT INTO customer_duplicate_review_events
          (organization_id,review_id,seq,event_kind,resulting_status,reason_code,actor_user_id,
           evidence_schema_version,matching_rule_version,evidence_key_id,evidence_digest,
           matching_codes,conflicting_tax_numbers)
         VALUES($1,$2,2,'DECISION_RECORDED','DISMISSED','RECHECK_REQUESTED',$3,1,
           'crm-duplicate-v1','k1',decode(repeat('00',32),'hex'),ARRAY['SAME_NAME'],false)`,
        [org, review, actor],
      )).toBe('customer_duplicate_review_events_state_reason_check');
      expect(await probe(pool,
        `INSERT INTO customer_duplicate_review_events
          (organization_id,review_id,seq,event_kind,resulting_status,reason_code,actor_user_id,
           evidence_schema_version,matching_rule_version,evidence_key_id,evidence_digest,
           matching_codes,conflicting_tax_numbers)
         VALUES($1,$2,1,'REVIEW_REOPENED','PENDING_REVIEW','RECHECK_REQUESTED',$3,1,
           'crm-duplicate-v1','k1',decode(repeat('00',32),'hex'),ARRAY['SAME_NAME'],false)`,
        [org, review, actor],
      )).toBe('customer_duplicate_review_events_sequence_unique');
    });
  });

  it('extends audit vocabulary additively for the review subject and events', async () => {
    await withSchema(async (pool) => {
      const subject = (await pool.query<{ pg_get_constraintdef: string }>(
        `SELECT pg_get_constraintdef(oid) FROM pg_constraint
          WHERE conrelid='audit_events'::regclass AND conname='audit_events_subject_type_check'`,
      )).rows[0]!.pg_get_constraintdef;
      const event = (await pool.query<{ pg_get_constraintdef: string }>(
        `SELECT pg_get_constraintdef(oid) FROM pg_constraint
          WHERE conrelid='audit_events'::regclass AND conname='audit_events_event_type_check'`,
      )).rows[0]!.pg_get_constraintdef;
      expect(subject).toContain('CUSTOMER_DUPLICATE_REVIEW');
      expect(subject).toContain('DEMO_DATASET');
      expect(event).toContain('CUSTOMER_DUPLICATE_REVIEW_DECIDED');
      expect(event).toContain('CUSTOMER_DUPLICATE_REVIEW_REOPENED');
      expect(event).toContain('DEMO_DATASET_PURGED');
      expect(event).toContain('USER_OFFBOARDED');
    });
  });
});

