import { describe, expect, it } from 'vitest';

import {
  TEST_DB_RUNNER_ROLE,
  TestDbProvisionError,
  assertLoopbackAdminUrl,
  buildTestDatabaseUrl,
  envFileTargetsOtherDatabase,
  parseTestDbArgs,
  planEnvFileUpdate,
  testDatabaseName,
} from '../scripts/test-db-plan.js';
import {
  parseTestDatabaseUrl,
  validateTestDatabaseCredentials,
  validateTestDatabaseHost,
  validateTestDatabaseIdentity,
} from '../scripts/test-env-contract.js';

const PASSWORD = 'a'.repeat(43);

function codeOf(work: () => unknown): string | undefined {
  try {
    work();
  } catch (error) {
    return (error as TestDbProvisionError).code;
  }
  return undefined;
}

describe('local test database provisioning plan', () => {
  it('parses provision, list and confirmed drop commands', () => {
    expect(parseTestDbArgs(['provision', '--suffix', 'wd1', '--write-env']))
      .toEqual({ command: 'provision', suffix: 'wd1', writeEnv: true, yes: false });
    expect(parseTestDbArgs(['list'])).toEqual({ command: 'list', suffix: null, writeEnv: false, yes: false });
    expect(parseTestDbArgs(['drop', '--suffix', 'wd1', '--yes']).command).toBe('drop');
  });

  it('rejects unknown commands, missing suffixes and unconfirmed drops', () => {
    expect(codeOf(() => parseTestDbArgs([]))).toBe('TEST_DB_USAGE');
    expect(codeOf(() => parseTestDbArgs(['reset', '--suffix', 'x']))).toBe('TEST_DB_USAGE');
    expect(codeOf(() => parseTestDbArgs(['provision']))).toBe('TEST_DB_USAGE');
    expect(codeOf(() => parseTestDbArgs(['provision', '--suffix']))).toBe('TEST_DB_USAGE');
    expect(codeOf(() => parseTestDbArgs(['provision', '--suffix', 'x', '--force']))).toBe('TEST_DB_USAGE');
    expect(codeOf(() => parseTestDbArgs(['drop', '--suffix', 'x']))).toBe('TEST_DB_DROP_CONFIRMATION_REQUIRED');
    expect(codeOf(() => parseTestDbArgs(['drop', '--suffix', 'x', '--yes', '--write-env']))).toBe('TEST_DB_USAGE');
  });

  it('only produces isolated servora_med_test_<suffix> names', () => {
    expect(testDatabaseName('job009_20261120')).toBe('servora_med_test_job009_20261120');
    for (const bad of ['', 'UPPER', '-lead', '_lead', 'has space', 'semi;colon', 'quote"', 'x'.repeat(41)]) {
      expect(codeOf(() => testDatabaseName(bad))).toBe('TEST_DB_SUFFIX_INVALID');
    }
  });

  it('builds a runner URL that the test preflight accepts locally', () => {
    const url = buildTestDatabaseUrl({ databaseName: 'servora_med_test_wd1', password: PASSWORD });
    const parsed = parseTestDatabaseUrl(url);
    expect(parsed.username).toBe(TEST_DB_RUNNER_ROLE);
    expect(parsed.host).toBe('127.0.0.1');
    expect(parsed.databaseName).toBe('servora_med_test_wd1');
    expect(() => {
      validateTestDatabaseCredentials(parsed);
      validateTestDatabaseIdentity(parsed, { ci: false });
      validateTestDatabaseHost(parsed, { ci: false });
    }).not.toThrow();
  });

  it('refuses protected, shared and non-loopback targets', () => {
    expect(codeOf(() => buildTestDatabaseUrl({ databaseName: 'servora_med', password: PASSWORD })))
      .toBe('TEST_ENV_PROTECTED_DATABASE_NAME');
    expect(codeOf(() => buildTestDatabaseUrl({ databaseName: 'servora_med_test', password: PASSWORD })))
      .toBe('TEST_ENV_SHARED_TEST_DATABASE_NAME');
    expect(codeOf(() => buildTestDatabaseUrl({ databaseName: 'servora_med_test_x', password: PASSWORD, host: 'db.example.com' })))
      .toBe('TEST_ENV_NON_LOOPBACK_HOST');
    expect(codeOf(() => assertLoopbackAdminUrl('postgresql://admin@db.example.com:5432/postgres')))
      .toBe('TEST_DB_ADMIN_URL_NOT_LOOPBACK');
    expect(() => assertLoopbackAdminUrl('postgresql://127.0.0.1:5432/postgres')).not.toThrow();
    expect(() => assertLoopbackAdminUrl('postgresql://[::1]:5432/postgres')).not.toThrow();
  });

  it('appends TEST_DATABASE_URL only when absent and never overwrites a different value', () => {
    const url = buildTestDatabaseUrl({ databaseName: 'servora_med_test_wd1', password: PASSWORD });
    expect(planEnvFileUpdate(null, url)).toEqual({ action: 'append', text: `TEST_DATABASE_URL=${url}\n` });
    expect(planEnvFileUpdate('PORT=3000', url)).toEqual({ action: 'append', text: `\nTEST_DATABASE_URL=${url}\n` });
    expect(planEnvFileUpdate(`PORT=3000\nTEST_DATABASE_URL=${url}\n`, url)).toEqual({ action: 'unchanged' });
    expect(planEnvFileUpdate(`TEST_DATABASE_URL="${url}"\n`, url)).toEqual({ action: 'unchanged' });

    const other = 'postgresql://someone:secret@127.0.0.1:5432/servora_med_test_other';
    const conflict = planEnvFileUpdate(`TEST_DATABASE_URL=${other}\n`, url);
    expect(conflict.action).toBe('conflict');
    expect(JSON.stringify(conflict)).not.toContain('secret');
    expect(planEnvFileUpdate(`TEST_DATABASE_URL=${url}\nTEST_DATABASE_URL=${url}\n`, url).action).toBe('conflict');
  });

  it('detects a conflicting TEST_DATABASE_URL before anything is created', () => {
    const url = buildTestDatabaseUrl({ databaseName: 'servora_med_test_wd1', password: PASSWORD });
    expect(envFileTargetsOtherDatabase(null, 'servora_med_test_wd1')).toBeNull();
    expect(envFileTargetsOtherDatabase('PORT=3000\n', 'servora_med_test_wd1')).toBeNull();
    expect(envFileTargetsOtherDatabase(`TEST_DATABASE_URL=${url}\n`, 'servora_med_test_wd1')).toBeNull();
    const other = envFileTargetsOtherDatabase(`TEST_DATABASE_URL=${url}\n`, 'servora_med_test_wd2');
    expect(other).toBe('postgresql://servora_med_test_runner@127.0.0.1:5432/servora_med_test_wd1');
  });
});
