import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const migrationUrl = new URL('../src/db/migrations/032_backup_r2_failure_taxonomy.sql', import.meta.url);

describe('032 backup R2 failure taxonomy migration', () => {
  let sql = '';

  beforeAll(async () => {
    sql = await readFile(fileURLToPath(migrationUrl), 'utf8');
  });

  it('adds the BR4 R2 failure codes additively to the vocabulary', () => {
    const block = sql.match(/backup_runs_failure_code_check[\s\S]*?\)\);/)![0]!;
    for (const code of [
      'PREFLIGHT_DATABASE_UNAVAILABLE', 'PREFLIGHT_PG_DUMP_UNAVAILABLE',
      'PREFLIGHT_LOW_DISK', 'PREFLIGHT_STORAGE_UNAVAILABLE',
      'PREFLIGHT_FILES_ARCHIVE_UNAVAILABLE',
      'PREFLIGHT_WORKSPACE_CONFLICT',
      'PG_DUMP_FAILED', 'FILES_ARCHIVE_FAILED', 'MANIFEST_FAILED',
      'CHECKSUM_FAILED', 'PACKAGE_FAILED', 'ENCRYPTION_FAILED',
      'R2_AUTH_FAILED', 'R2_UPLOAD_FAILED', 'R2_DOWNLOAD_FAILED',
      'R2_OBJECT_TOO_LARGE', 'R2_OBJECT_CONFLICT', 'R2_VERIFY_FAILED',
      'REMOTE_CHECKSUM_MISMATCH', 'WORKER_LOST',
    ]) {
      expect(block).toContain(`'${code}'`);
    }
  });

  it('touches only the backup domain (no destructive operations)', () => {
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|SCHEMA|DATABASE|COLUMN)\b|\bDELETE\s+FROM|\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/ALTER TABLE (?!backup_runs)/);
    expect(sql).not.toMatch(/ALTER COLUMN/);
  });
});
