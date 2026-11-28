import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { compareMigrationState } from '../src/db/migration-catalog.js';
import { loadMigrationCatalog } from '../src/db/migration-catalog.js';
import { createPostgresReadiness } from '../src/modules/health/postgres-readiness.js';

const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

function fakePool(versions: string[]) {
  return {
    query: async (sql: string) => {
      if (sql === 'SELECT 1') return { rows: [{ '?column?': 1 }] };
      if (sql.includes('FROM schema_migrations')) return { rows: versions.map((version) => ({ version })) };
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
}

describe('BR5-TT-1 catalog and readiness matrix', () => {
  it('classifies 076 as BEHIND with only 077 pending and 077 as compatible', async () => {
    const catalog = await loadMigrationCatalog(migrationsDirectory);
    const versions = catalog.entries.map((entry) => entry.version);
    expect(catalog.head?.version).toBe('077_backup_worker_trusted_time_evidence');

    const behind = compareMigrationState(catalog, versions.slice(0, -1));
    expect(behind.status).toBe('BEHIND');
    if (behind.status === 'BEHIND') {
      expect(behind.appliedHead).toBe('076_assignment_offer_suggested_solution');
      expect(behind.expectedHead).toBe('077_backup_worker_trusted_time_evidence');
      expect(behind.pendingVersions).toEqual(['077_backup_worker_trusted_time_evidence']);
    }
    expect(compareMigrationState(catalog, versions).status).toBe('COMPATIBLE');
    expect(compareMigrationState(catalog, [...versions, '078_future_feature']).status).toBe('AHEAD');
  });

  it('maps the readiness check to 077 compatible, 076 behind, and 078 ahead', async () => {
    const catalog = await loadMigrationCatalog(migrationsDirectory);
    const versions = catalog.entries.map((entry) => entry.version);
    await expect(createPostgresReadiness(fakePool(versions) as never, catalog).check()).resolves.toBe('ok');
    await expect(createPostgresReadiness(fakePool(versions.slice(0, -1)) as never, catalog).check())
      .resolves.toBe('unavailable');
    await expect(createPostgresReadiness(fakePool([...versions, '078_future_feature']) as never, catalog).check())
      .resolves.toBe('unavailable');
  });
});
