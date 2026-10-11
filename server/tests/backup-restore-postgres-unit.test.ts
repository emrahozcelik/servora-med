import { describe, expect, it } from 'vitest';

import { buildPgRestoreArgs, postgresConnectionEnv, validateTargetDatabaseName } from '../src/modules/backup/restore/postgres.js';

describe('BR7 PostgreSQL target guard', () => {
  it('preserves the IPv6 loopback endpoint when translating a URL to libpq environment', () => {
    const env = postgresConnectionEnv('postgresql://operator:synthetic-only@[::1]:55473/servora_med_test_ipv6');
    expect(env.PGHOST).toBe('::1');
    expect(env.PGPORT).toBe('55473');
    expect(env.PGDATABASE).toBe('servora_med_test_ipv6');
    expect(env.PGUSER).toBe('operator');
    expect(env.PGPASSWORD).toBe('synthetic-only');
  });

  it('accepts only a fresh non-production database identifier', () => {
    expect(validateTargetDatabaseName('dr_2026')).toBe(true);
    expect(validateTargetDatabaseName('servora_med')).toBe(false);
    expect(validateTargetDatabaseName('dr-2026')).toBe(false);
    expect(validateTargetDatabaseName('DROP DATABASE x;')).toBe(false);
  });

  it('builds argv-only fail-closed pg_restore flags without --clean or --create', () => {
    const args = buildPgRestoreArgs('dr_2026', '/tmp/restore/database.dump');
    expect(args).toEqual(expect.arrayContaining(['--exit-on-error', '--single-transaction', '--no-owner', '--no-acl']));
    expect(args).not.toContain('--clean');
    expect(args).not.toContain('--create');
  });
});
