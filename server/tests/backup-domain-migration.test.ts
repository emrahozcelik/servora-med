import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const migrationUrl = new URL('../src/db/migrations/030_backup_domain_foundation.sql', import.meta.url);

describe('030 backup domain foundation migration', () => {
  let sql = '';

  beforeAll(async () => {
    sql = await readFile(fileURLToPath(migrationUrl), 'utf8');
  });

  it('creates the four installation-scoped backup domain tables', () => {
    expect(sql).toContain('CREATE TABLE backup_runs');
    expect(sql).toContain('CREATE TABLE backup_policy');
    expect(sql).toContain('CREATE TABLE backup_storage');
    expect(sql).toContain('CREATE TABLE restore_runs');
  });

  it('keeps backup domain tables installation-scoped (no organization_id)', () => {
    for (const table of ['backup_runs', 'backup_policy', 'backup_storage', 'restore_runs']) {
      expect(sql).not.toMatch(new RegExp(`CREATE TABLE ${table}[\\s\\S]*?organization_id`));
    }
  });

  it('stores no secret-bearing columns', () => {
    expect(sql).not.toMatch(/\b(access_key|secret_key|api_key|private_key|password|credential)[a-z_]*\s+(VARCHAR|TEXT|UUID|BYTEA|JSONB)/i);
  });

  it('durable single-active-backup and single-running-restore guards', () => {
    expect(sql).toContain('CREATE UNIQUE INDEX backup_runs_single_active_unique');
    expect(sql).toMatch(/ON backup_runs \(\(1\)\)\s*\n\s*WHERE status IN \('QUEUED', 'RUNNING'\)/);
    expect(sql).toContain('CREATE UNIQUE INDEX restore_runs_single_running_unique');
    expect(sql).toMatch(/ON restore_runs \(\(1\)\)\s*\n\s*WHERE status = 'RUNNING'/);
  });

  it('enforces the SUCCESS/failure and FAILED/failure invariant split', () => {
    expect(sql).toContain('CONSTRAINT backup_runs_status_failure_check');
    expect(sql).toMatch(/status <> 'SUCCESS' OR failure_code IS NULL/);
    expect(sql).toMatch(/status <> 'FAILED' OR failure_code IS NOT NULL/);
    expect(sql).toContain('CONSTRAINT backup_runs_warning_status_check');
    expect(sql).toMatch(/warning_code IS NULL OR status = 'SUCCESS'/);
  });

  it('carries the canonical status/phase/origin/scope/retention vocabularies', () => {
    expect(sql).toMatch(/CONSTRAINT backup_runs_status_check CHECK \(status IN \(\s*'QUEUED', 'RUNNING', 'SUCCESS', 'FAILED', 'CANCELLED'/);
    expect(sql).toContain("'PREFLIGHT', 'DATABASE_DUMP', 'FILES_ARCHIVE', 'MANIFEST', 'CHECKSUM'");
    expect(sql).toContain("'PACKAGE', 'ENCRYPT', 'UPLOAD', 'REMOTE_VERIFY', 'CLEANUP'");
    expect(sql).toContain("'MANUAL', 'SCHEDULED', 'PRE_RESTORE'");
    expect(sql).toContain("'DATABASE', 'FULL_DATA'");
    expect(sql).toContain("'DAILY', 'WEEKLY', 'MONTHLY', 'MANUAL', 'PRE_RESTORE'");
  });

  it('failure codes exclude CLEANUP_FAILED (warning-only) and warnings start with it', () => {
    expect(sql).toMatch(/CONSTRAINT backup_runs_failure_code_check[\s\S]*?'WORKER_LOST'/);
    const failureCodeBlock = sql.match(/backup_runs_failure_code_check[\s\S]*?\)\)/)![0]!;
    expect(failureCodeBlock).not.toContain('CLEANUP_FAILED');
    expect(sql).toMatch(/CONSTRAINT backup_runs_warning_code_check CHECK \(warning_code IS NULL OR warning_code IN \(\s*'CLEANUP_FAILED'/);
  });

  it('terminal-state coherence and verification invariants', () => {
    expect(sql).toContain('backup_runs_running_started_check');
    expect(sql).toContain('backup_runs_running_phase_check');
    expect(sql).toContain('backup_runs_terminal_completed_check');
    expect(sql).toContain('backup_runs_manual_creator_check');
    expect(sql).toContain('backup_runs_verified_check');
    expect(sql).toMatch(/sha256 ~ '\^\[0-9a-f\]\{64\}\$'/);
    expect(sql).toMatch(/size_bytes IS NULL OR size_bytes >= 0/);
  });

  it('singleton policy/storage with BR0-approved seeded defaults', () => {
    expect(sql).toContain('backup_policy_singleton_unique');
    expect(sql).toContain('backup_storage_singleton_unique');
    expect(sql).toMatch(/INSERT INTO backup_policy[\s\S]*?'02:30', 'UTC', 7, 4, 6, 'DATABASE'/);
    expect(sql).toMatch(/INSERT INTO backup_storage \(id, singleton, provider, prefix, enabled\)\s*\nVALUES \(gen_random_uuid\(\), TRUE, 'CLOUDFLARE_R2', 'production\/', FALSE\)/);
  });

  it('restore runs keep database names only and nullable DR backup ids', () => {
    expect(sql).toMatch(/target_database ~ '\^\[A-Za-z_\]\[A-Za-z0-9_\]\*\$'/);
    expect(sql).toMatch(/backup_id UUID REFERENCES backup_runs\(id\)/);
    expect(sql).toContain('restore_runs_failure_status_check');
  });

  it('extends the canonical audit vocabulary through the shared CHECK pattern', () => {
    expect(sql).toMatch(/ALTER TABLE audit_events\s*\n\s*DROP CONSTRAINT audit_events_subject_type_check,\s*\n\s*DROP CONSTRAINT audit_events_event_type_check/);
    expect(sql).toMatch(/'STAFF_CONFIDENTIAL_NOTE', 'BACKUP_RUN', 'BACKUP_POLICY'/);
    expect(sql).toMatch(/'STAFF_CONFIDENTIAL_NOTE_CREATED',\s*\n\s*'BACKUP_REQUESTED', 'BACKUP_POLICY_UPDATED'/);
  });

  it('is additive and forward-safe (no destructive operations)', () => {
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|SCHEMA|DATABASE|COLUMN)\b|\bDELETE\s+FROM|\bTRUNCATE\b|\bALTER\s+TABLE\s+\w+\s+DROP\s+COLUMN/i);
  });
});
