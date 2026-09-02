import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import {
  MigrationCatalogError,
  compareMigrationState,
  loadMigrationCatalog,
  parseMigrationFilename,
  parseMigrationVersion,
} from '../src/db/migration-catalog.js';
import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function createCatalogDirectory(files: Record<string, string>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'servora-catalog-'));
  tempDirs.push(dir);
  await Promise.all(
    Object.entries(files).map(([name, content]) => writeFile(path.join(dir, name), content, 'utf8')),
  );
  return dir;
}

// ---------------------------------------------------------------------------
// Catalog loader
// ---------------------------------------------------------------------------

describe('loadMigrationCatalog', () => {
  it('loads valid contiguous catalog deterministically regardless of creation order', async () => {
    const dir = await createCatalogDirectory({
      '002_second.sql': 'SELECT 2;',
      '003_third.sql': 'SELECT 3;',
      '001_first.sql': 'SELECT 1;',
    });
    const catalog = await loadMigrationCatalog(dir);
    expect(catalog.count).toBe(3);
    expect(catalog.entries.map((e) => e.version)).toEqual(['001_first', '002_second', '003_third']);
    expect(catalog.entries.map((e) => e.number)).toEqual([1, 2, 3]);
    expect(catalog.head?.version).toBe('003_third');
    // path correctness
    expect(catalog.entries[0]!.path).toBe(path.join(dir, '001_first.sql'));
  });

  it('ignores non-sql files (README, dotfiles, editor backups)', async () => {
    const dir = await createCatalogDirectory({
      '001_first.sql': 'SELECT 1;',
      'README.md': '# not a migration',
      '.DS_Store': 'binary',
      '002_second.sql': 'SELECT 2;',
      'backup~': 'temp',
      '.hidden.sql.bak': 'ignored because not .sql suffix exact',
    });
    const catalog = await loadMigrationCatalog(dir);
    expect(catalog.count).toBe(2);
    expect(catalog.entries.map((e) => e.filename)).toEqual(['001_first.sql', '002_second.sql']);
  });

  it('rejects malformed migration filename that ends with .sql but violates NNN_description pattern', async () => {
    const dir = await createCatalogDirectory({
      '001_valid.sql': 'SELECT 1;',
      'invalid.sql': 'SELECT 2;',
    });
    await expect(loadMigrationCatalog(dir)).rejects.toBeInstanceOf(MigrationCatalogError);
    await expect(loadMigrationCatalog(dir)).rejects.toMatchObject({ reason: 'INVALID_MIGRATION_FILENAME' });
  });

  it('rejects unpadded number (1_first.sql)', async () => {
    const dir = await createCatalogDirectory({
      '1_first.sql': 'SELECT 1;',
    });
    await expect(loadMigrationCatalog(dir)).rejects.toMatchObject({ reason: 'INVALID_MIGRATION_FILENAME' });
  });

  it('rejects duplicate numeric prefix', async () => {
    const dir = await createCatalogDirectory({
      '001_first.sql': 'SELECT 1;',
      '001_duplicate.sql': 'SELECT 1b;',
      '002_second.sql': 'SELECT 2;',
    });
    await expect(loadMigrationCatalog(dir)).rejects.toMatchObject({
      reason: 'DUPLICATE_MIGRATION_NUMBER',
    });
    await expect(loadMigrationCatalog(dir)).rejects.toBeInstanceOf(MigrationCatalogError);
  });

  it('rejects migration number gap', async () => {
    const dir = await createCatalogDirectory({
      '001_first.sql': 'SELECT 1;',
      '002_second.sql': 'SELECT 2;',
      '004_fourth.sql': 'SELECT 4;',
    });
    await expect(loadMigrationCatalog(dir)).rejects.toMatchObject({ reason: 'MIGRATION_NUMBER_GAP' });
  });

  it('accepts empty directory (no migrations)', async () => {
    const dir = await createCatalogDirectory({});
    const catalog = await loadMigrationCatalog(dir);
    expect(catalog.count).toBe(0);
    expect(catalog.head).toBeNull();
    expect(catalog.entries).toEqual([]);
  });

  it('derives expected head from catalog without hardcoding production value', async () => {
    const dir = await createCatalogDirectory({
      '001_a.sql': 'SELECT 1;',
      '002_b.sql': 'SELECT 2;',
      '003_c.sql': 'SELECT 3;',
    });
    const catalog = await loadMigrationCatalog(dir);
    expect(catalog.head?.version).toBe('003_c');
  });

  it('proves real repository catalog: count 42, first 001_auth_foundation, last 042_unsuccessful_visit_reason', async () => {
    const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
    const catalog = await loadMigrationCatalog(migrationsDirectory);
    expect(catalog.count).toBe(42);
    expect(catalog.entries[0]?.version).toBe('001_auth_foundation');
    expect(catalog.entries[0]?.number).toBe(1);
    expect(catalog.head?.version).toBe('042_unsuccessful_visit_reason');
    expect(catalog.head?.number).toBe(42);
    // No throw means validation PASS, contiguity enforced from 001
    expect(catalog.entries.map((e) => e.number)).toEqual(
      Array.from({ length: 42 }, (_, i) => i + 1),
    );
  });

  it('produces private-safe error details (no DATABASE_URL)', async () => {
    const dir = await createCatalogDirectory({
      '001_first.sql': 'SELECT 1;',
      '001_dup.sql': 'SELECT 1;',
    });
    try {
      await loadMigrationCatalog(dir);
      expect.fail('should have thrown');
    } catch (error) {
      const err = error as MigrationCatalogError;
      expect(err.details).not.toHaveProperty('databaseUrl');
      const msg = err.message;
      expect(msg).not.toMatch(/postgres/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Comparator
// ---------------------------------------------------------------------------

describe('compareMigrationState', () => {
  async function fixtureCatalog() {
    const dir = await createCatalogDirectory({
      '001_first.sql': 'SELECT 1;',
      '002_second.sql': 'SELECT 2;',
      '003_third.sql': 'SELECT 3;',
      '004_fourth.sql': 'SELECT 4;',
    });
    return loadMigrationCatalog(dir);
  }

  it('A: COMPATIBLE when applied equals catalog (001..004)', async () => {
    const catalog = await fixtureCatalog();
    const result = compareMigrationState(catalog, [
      '001_first',
      '002_second',
      '003_third',
      '004_fourth',
    ]);
    expect(result.status).toBe('COMPATIBLE');
  });

  it('B: BEHIND when applied is prefix (001..002) pending 003,004', async () => {
    const catalog = await fixtureCatalog();
    const result = compareMigrationState(catalog, ['001_first', '002_second']);
    expect(result.status).toBe('BEHIND');
    if (result.status === 'BEHIND') {
      expect(result.pendingVersions).toEqual(['003_third', '004_fourth']);
      expect(result.pendingEntries.map((e) => e.version)).toEqual(['003_third', '004_fourth']);
      expect(result.expectedHead).toBe('004_fourth');
      expect(result.appliedHead).toBe('002_second');
    }
  });

  it('C: AHEAD when DB has 001..005_unknown beyond catalog', async () => {
    const catalog = await fixtureCatalog();
    const result = compareMigrationState(catalog, [
      '001_first',
      '002_second',
      '003_third',
      '004_fourth',
      '005_unknown',
    ]);
    expect(result.status).toBe('AHEAD');
    if (result.status === 'AHEAD') {
      expect(result.unexpectedVersions).toEqual(['005_unknown']);
      expect(result.expectedHead).toBe('004_fourth');
    }
  });

  it('D: DIVERGED when DB has 001,002,004 missing 003 (non-prefix)', async () => {
    const catalog = await fixtureCatalog();
    const result = compareMigrationState(catalog, ['001_first', '002_second', '004_fourth']);
    expect(result.status).toBe('DIVERGED');
    if (result.status === 'DIVERGED') {
      expect(result.missingVersions).toContain('003_third');
    }
  });

  it('E: DIVERGED when DB has 001,002,999_unknown while 003/004 missing', async () => {
    const catalog = await fixtureCatalog();
    const result = compareMigrationState(catalog, ['001_first', '002_second', '999_unknown']);
    expect(result.status).toBe('DIVERGED');
    if (result.status === 'DIVERGED') {
      expect(result.unexpectedVersions).toEqual(['999_unknown']);
      expect(result.missingVersions).toEqual(['003_third', '004_fourth']);
    }
  });

  it('F: EMPTY when applied [] pending all', async () => {
    const catalog = await fixtureCatalog();
    const result = compareMigrationState(catalog, []);
    expect(result.status).toBe('EMPTY');
    if (result.status === 'EMPTY') {
      expect(result.pendingVersions).toEqual(['001_first', '002_second', '003_third', '004_fourth']);
      expect(result.expectedHead).toBe('004_fourth');
    }
  });

  it('G: shuffled applied history is DIVERGED', async () => {
    const catalog = await fixtureCatalog();
    const result = compareMigrationState(catalog, [
      '004_fourth',
      '002_second',
      '001_first',
      '003_third',
    ]);
    expect(result.status).toBe('DIVERGED');
    if (result.status === 'DIVERGED') expect(result.reason).toBe('NON_PREFIX_HISTORY');
  });

  it('duplicate applied version is DIVERGED fail-closed', async () => {
    const catalog = await fixtureCatalog();
    const result = compareMigrationState(catalog, [
      '001_first',
      '002_second',
      '002_second',
      '003_third',
      '004_fourth',
    ]);
    expect(result.status).toBe('DIVERGED');
    if (result.status === 'DIVERGED') {
      expect(result.duplicateVersions).toEqual(['002_second']);
    }
  });

  it('BEHIND models real incident: catalog 001..042 vs DB 001..029', async () => {
    const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
    const catalog = await loadMigrationCatalog(migrationsDirectory);
    const applied = catalog.entries.filter((e) => e.number <= 29).map((e) => e.version);
    const result = compareMigrationState(catalog, applied);
    expect(result.status).toBe('BEHIND');
    if (result.status === 'BEHIND') {
      expect(result.appliedHead).toBe('029_messaging_conversation_archive');
      expect(result.expectedHead).toBe('042_unsuccessful_visit_reason');
      expect(result.pendingVersions).toEqual([
        '030_backup_domain_foundation',
        '031_backup_engine_failure_taxonomy_and_dump_version',
        '032_backup_r2_failure_taxonomy',
        '033_backup_worker_runtime',
        '034_demo_data_foundation',
        '035_demo_data_purge_foundation',
        '036_job_card_invalidated',
        '037_staff_offboarding_audit',
        '038_demo_dataset_audit_types',
        '039_contact_deleted_audit',
        '040_demo_lifecycle_simplification',
        '041_user_lifecycle_reconciliation',
        '042_unsuccessful_visit_reason',
      ]);
    }
  });

  it('does not expose DATABASE_URL in results', async () => {
    const catalog = await fixtureCatalog();
    const result = compareMigrationState(catalog, ['001_first']);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/postgres/i);
  });
});

describe('parseMigrationVersion / parseMigrationFilename', () => {
  it('parses valid version 037_staff_offboarding_audit', () => {
    expect(parseMigrationVersion('037_staff_offboarding_audit')).toEqual({
      number: 37,
      version: '037_staff_offboarding_audit',
    });
  });
  it('parses 038_future', () => {
    expect(parseMigrationVersion('038_future')).toEqual({ number: 38, version: '038_future' });
  });
  it('000_unknown is syntactically valid version number 0 but not future', () => {
    const parsed = parseMigrationVersion('000_unknown');
    expect(parsed).not.toBeNull();
    expect(parsed?.number).toBe(0);
  });
  it('rejects garbage', () => {
    expect(parseMigrationVersion('garbage')).toBeNull();
  });
  it('rejects 037-other hyphen', () => {
    expect(parseMigrationVersion('037-other')).toBeNull();
  });
  it('rejects unpadded 37_other', () => {
    expect(parseMigrationVersion('37_other')).toBeNull();
  });
  it('rejects 038_ empty description', () => {
    expect(parseMigrationVersion('038_')).toBeNull();
  });
  it('parseMigrationFilename delegates to version parser', () => {
    expect(parseMigrationFilename('037_staff_offboarding_audit.sql')).toEqual({
      number: 37,
      version: '037_staff_offboarding_audit',
    });
    expect(parseMigrationFilename('037_staff_offboarding_audit')).toBeNull(); // no .sql
    expect(parseMigrationFilename('garbage.sql')).toBeNull();
  });
});

describe('compareMigrationState strict AHEAD (SD1 repair)', () => {
  it('full catalog + 043_future → AHEAD', async () => {
    const catalog = await loadMigrationCatalog(fileURLToPath(new URL('../src/db/migrations', import.meta.url)));
    const applied = [...catalog.entries.map((e) => e.version), '043_future'];
    const result = compareMigrationState(catalog, applied);
    expect(result.status).toBe('AHEAD');
  });
  it('full catalog + 999_future → AHEAD', async () => {
    const catalog = await loadMigrationCatalog(fileURLToPath(new URL('../src/db/migrations', import.meta.url)));
    const applied = [...catalog.entries.map((e) => e.version), '999_future'];
    const result = compareMigrationState(catalog, applied);
    expect(result.status).toBe('AHEAD');
  });
  it('full catalog + 000_unknown → DIVERGED (non-future)', async () => {
    const catalog = await loadMigrationCatalog(fileURLToPath(new URL('../src/db/migrations', import.meta.url)));
    const applied = [...catalog.entries.map((e) => e.version), '000_unknown'];
    const result = compareMigrationState(catalog, applied);
    expect(result.status).toBe('DIVERGED');
  });
  it('full catalog + same-number current branch alternative 037_other_branch → DIVERGED', async () => {
    const catalog = await loadMigrationCatalog(fileURLToPath(new URL('../src/db/migrations', import.meta.url)));
    const applied = [...catalog.entries.map((e) => e.version), '037_other_branch'];
    const result = compareMigrationState(catalog, applied);
    expect(result.status).toBe('DIVERGED');
    if (result.status === 'DIVERGED') expect(result.reason).toBe('NON_FUTURE_UNEXPECTED_VERSION');
  });
  it('full catalog + malformed garbage → DIVERGED', async () => {
    const catalog = await loadMigrationCatalog(fileURLToPath(new URL('../src/db/migrations', import.meta.url)));
    const applied = [...catalog.entries.map((e) => e.version), 'garbage'];
    const result = compareMigrationState(catalog, applied);
    expect(result.status).toBe('DIVERGED');
    if (result.status === 'DIVERGED') expect(result.reason).toBe('INVALID_APPLIED_VERSION');
  });
  it('full catalog + malformed canonical-looking 038-future → DIVERGED', async () => {
    const catalog = await loadMigrationCatalog(fileURLToPath(new URL('../src/db/migrations', import.meta.url)));
    const applied = [...catalog.entries.map((e) => e.version), '038-future'];
    const result = compareMigrationState(catalog, applied);
    expect(result.status).toBe('DIVERGED');
  });
  it('full catalog + malformed 38_future (unpadded) → DIVERGED', async () => {
    const catalog = await loadMigrationCatalog(fileURLToPath(new URL('../src/db/migrations', import.meta.url)));
    const applied = [...catalog.entries.map((e) => e.version), '38_future'];
    const result = compareMigrationState(catalog, applied);
    expect(result.status).toBe('DIVERGED');
  });
  it('full catalog + malformed 038_ (empty desc) → DIVERGED', async () => {
    const catalog = await loadMigrationCatalog(fileURLToPath(new URL('../src/db/migrations', import.meta.url)));
    const applied = [...catalog.entries.map((e) => e.version), '038_'];
    const result = compareMigrationState(catalog, applied);
    expect(result.status).toBe('DIVERGED');
  });
  it('full catalog + 043_alpha + 043_beta (duplicate number) → DIVERGED', async () => {
    const catalog = await loadMigrationCatalog(fileURLToPath(new URL('../src/db/migrations', import.meta.url)));
    const applied = [...catalog.entries.map((e) => e.version), '043_alpha', '043_beta'];
    const result = compareMigrationState(catalog, applied);
    expect(result.status).toBe('DIVERGED');
    if (result.status === 'DIVERGED') expect(result.reason).toBe('DUPLICATE_APPLIED_MIGRATION_NUMBER');
  });
  it('full catalog + 041_future + garbage → DIVERGED', async () => {
    const catalog = await loadMigrationCatalog(fileURLToPath(new URL('../src/db/migrations', import.meta.url)));
    const applied = [...catalog.entries.map((e) => e.version), '041_future', 'garbage'];
    const result = compareMigrationState(catalog, applied);
    expect(result.status).toBe('DIVERGED');
  });
  it('full catalog + 043_future + 044_future → AHEAD', async () => {
    const catalog = await loadMigrationCatalog(fileURLToPath(new URL('../src/db/migrations', import.meta.url)));
    const applied = [...catalog.entries.map((e) => e.version), '043_future_a', '044_future_b'];
    const result = compareMigrationState(catalog, applied);
    expect(result.status).toBe('AHEAD');
    if (result.status === 'AHEAD') expect(result.unexpectedVersions).toEqual(['043_future_a', '044_future_b']);
  });
  it('full catalog + 036_other_branch (lower than head) → DIVERGED', async () => {
    const catalog = await loadMigrationCatalog(fileURLToPath(new URL('../src/db/migrations', import.meta.url)));
    const applied = [...catalog.entries.map((e) => e.version), '036_other_branch'];
    const result = compareMigrationState(catalog, applied);
    expect(result.status).toBe('DIVERGED');
  });
  it('full catalog + 041_future + 037_other_branch → DIVERGED', async () => {
    const catalog = await loadMigrationCatalog(fileURLToPath(new URL('../src/db/migrations', import.meta.url)));
    const applied = [...catalog.entries.map((e) => e.version), '041_future', '037_other_branch'];
    const result = compareMigrationState(catalog, applied);
    expect(result.status).toBe('DIVERGED');
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('migration catalog postgres acceptance', () => {
  const databaseUrl = process.env.TEST_DATABASE_URL as string;

  it('fresh database: migrations → COMPATIBLE', async () => {
    const schema = `sd1_catalog_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
    const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
    try {
      const catalog = await loadMigrationCatalog(migrationsDirectory);
      const store = new PostgresMigrationStore(pool);
      const result = await runMigrations({ migrationsDirectory, store });
      expect(result.appliedVersions).toHaveLength(catalog.count);
      const applied = await store.getAppliedVersions();
      expect(applied).toEqual(catalog.entries.map((e) => e.version));
      const compat = compareMigrationState(catalog, applied);
      expect(compat.status).toBe('COMPATIBLE');
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  it('one migration behind: BEHIND with pending last', async () => {
    const schema = `sd1_behind_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
    const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
    try {
      const catalog = await loadMigrationCatalog(migrationsDirectory);
      expect(catalog.head).not.toBeNull();
      const preHeadDir = await mkdtemp(path.join(tmpdir(), 'servora-prehead-'));
      tempDirs.push(preHeadDir);
      // copy all except last migration
      const { readFile } = await import('node:fs/promises');
      for (const entry of catalog.entries.slice(0, -1)) {
        const sql = await readFile(path.join(migrationsDirectory, entry.filename), 'utf8');
        await writeFile(path.join(preHeadDir, entry.filename), sql, 'utf8');
      }
      const store = new PostgresMigrationStore(pool);
      await runMigrations({ migrationsDirectory: preHeadDir, store });
      const applied = await store.getAppliedVersions();
      const compat = compareMigrationState(catalog, applied);
      expect(compat.status).toBe('BEHIND');
      if (compat.status === 'BEHIND') {
        expect(compat.pendingVersions).toEqual([catalog.head!.version]);
        expect(compat.expectedHead).toBe(catalog.head!.version);
      }
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });
});
