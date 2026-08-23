import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const migrationUrl = new URL('../src/db/migrations/031_backup_engine_failure_taxonomy_and_dump_version.sql', import.meta.url);

describe('031 backup engine failure taxonomy and dump version migration', () => {
  let sql = '';

  beforeAll(async () => {
    sql = await readFile(fileURLToPath(migrationUrl), 'utf8');
  });

  it('widens dump_version to the archive format version string', () => {
    expect(sql).toMatch(/ALTER COLUMN dump_version TYPE VARCHAR\(30\)/);
    expect(sql).toMatch(/USING \(CASE WHEN dump_version IS NULL THEN NULL ELSE dump_version::text END\)/);
  });

  it('adds CHECKSUM_FAILED and PREFLIGHT_FILES_ARCHIVE_UNAVAILABLE additively', () => {
    const block = sql.match(/backup_runs_failure_code_check[\s\S]*?\)\);/)![0]!;
    for (const code of [
      'PREFLIGHT_DATABASE_UNAVAILABLE', 'PREFLIGHT_PG_DUMP_UNAVAILABLE',
      'PREFLIGHT_LOW_DISK', 'PREFLIGHT_STORAGE_UNAVAILABLE',
      'PREFLIGHT_FILES_ARCHIVE_UNAVAILABLE',
      'PG_DUMP_FAILED', 'FILES_ARCHIVE_FAILED', 'MANIFEST_FAILED',
      'CHECKSUM_FAILED', 'PACKAGE_FAILED', 'ENCRYPTION_FAILED',
      'R2_AUTH_FAILED', 'R2_UPLOAD_FAILED', 'R2_DOWNLOAD_FAILED',
      'REMOTE_CHECKSUM_MISMATCH', 'WORKER_LOST',
    ]) {
      expect(block).toContain(`'${code}'`);
    }
  });

  it('touches only the backup domain (no destructive operations)', () => {
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|SCHEMA|DATABASE|COLUMN)\b|\bDELETE\s+FROM|\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/ALTER TABLE (?!backup_runs)/);
  });
});
