/**
 * Local test database provisioning — pure planning rules.
 *
 * `./test-db.ts` performs the I/O. Everything that decides *what* may be
 * created, dropped or written lives here so it can be unit-tested and so the
 * database identity rules are the same ones the test preflight enforces
 * (`./test-env-contract.ts`).
 */

import {
  ISOLATED_LOCAL_TEST_DATABASE_NAME_PREFIX,
  TestEnvContractError,
  parseTestDatabaseUrl,
  redactTestDatabaseUrl,
  validateTestDatabaseCredentials,
  validateTestDatabaseHost,
  validateTestDatabaseIdentity,
} from './test-env-contract.js';

/** One shared, documented local login role for every isolated test database. */
export const TEST_DB_RUNNER_ROLE = 'servora_med_test_runner';

export const DEFAULT_TEST_DB_HOST = '127.0.0.1';
export const DEFAULT_TEST_DB_PORT = '5432';

/** Lowercase identifier tail; keeps the full name well under 63 bytes. */
const SUFFIX_PATTERN = /^[a-z0-9][a-z0-9_]{0,39}$/;

export class TestDbProvisionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'TestDbProvisionError';
  }
}

export type TestDbCommand = 'provision' | 'drop' | 'list';

export type TestDbArgs = {
  command: TestDbCommand;
  suffix: string | null;
  writeEnv: boolean;
  yes: boolean;
};

export function parseTestDbArgs(argv: readonly string[]): TestDbArgs {
  const [command, ...rest] = argv;
  if (command !== 'provision' && command !== 'drop' && command !== 'list') {
    throw new TestDbProvisionError(
      'TEST_DB_USAGE',
      'Usage: test-db <provision|drop|list> [--suffix <suffix>] [--write-env] [--yes]',
    );
  }
  let suffix: string | null = null;
  let writeEnv = false;
  let yes = false;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--suffix') {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new TestDbProvisionError('TEST_DB_USAGE', '--suffix requires a value.');
      }
      suffix = value;
      index += 1;
    } else if (arg === '--write-env') {
      writeEnv = true;
    } else if (arg === '--yes') {
      yes = true;
    } else {
      throw new TestDbProvisionError('TEST_DB_USAGE', `Unknown argument: ${arg}`);
    }
  }
  if (command !== 'list' && suffix === null) {
    throw new TestDbProvisionError('TEST_DB_USAGE', `${command} requires --suffix <suffix>.`);
  }
  if (command === 'drop' && !yes) {
    throw new TestDbProvisionError(
      'TEST_DB_DROP_CONFIRMATION_REQUIRED',
      'drop permanently deletes the isolated test database; repeat with --yes.',
    );
  }
  if (command !== 'provision' && writeEnv) {
    throw new TestDbProvisionError('TEST_DB_USAGE', '--write-env is only valid with provision.');
  }
  return { command, suffix, writeEnv, yes };
}

export function testDatabaseName(suffix: string): string {
  if (!SUFFIX_PATTERN.test(suffix)) {
    throw new TestDbProvisionError(
      'TEST_DB_SUFFIX_INVALID',
      'Suffix must be 1-40 characters: lowercase letters, digits and underscores, starting with a letter or digit.',
    );
  }
  return `${ISOLATED_LOCAL_TEST_DATABASE_NAME_PREFIX}${suffix}`;
}

/**
 * Build the runner URL and prove it satisfies the same contract the test
 * preflight enforces locally (isolated name, loopback, user and password).
 */
export function buildTestDatabaseUrl(input: {
  databaseName: string;
  password: string;
  host?: string;
  port?: string;
}): string {
  const url = new URL('postgresql://placeholder');
  url.username = TEST_DB_RUNNER_ROLE;
  url.password = input.password;
  url.hostname = input.host ?? DEFAULT_TEST_DB_HOST;
  url.port = input.port ?? DEFAULT_TEST_DB_PORT;
  url.pathname = `/${input.databaseName}`;
  const raw = url.toString();
  try {
    const parsed = parseTestDatabaseUrl(raw);
    validateTestDatabaseCredentials(parsed);
    validateTestDatabaseIdentity(parsed, { ci: false });
    validateTestDatabaseHost(parsed, { ci: false });
  } catch (error) {
    if (error instanceof TestEnvContractError) {
      throw new TestDbProvisionError(error.code, error.message);
    }
    throw error;
  }
  return raw;
}

/** The admin connection may only reach a loopback PostgreSQL. */
export function assertLoopbackAdminUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TestDbProvisionError('TEST_DB_ADMIN_URL_MALFORMED', 'TEST_DB_ADMIN_URL could not be parsed.');
  }
  const host = url.hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new TestDbProvisionError(
      'TEST_DB_ADMIN_URL_NOT_LOOPBACK',
      `The admin connection must target a loopback host; received "${host}" (${redactTestDatabaseUrl(raw)}).`,
    );
  }
}

export type EnvFilePlan =
  | { action: 'append'; text: string }
  | { action: 'unchanged' }
  | { action: 'conflict'; existing: string };

/**
 * Decide how `server/.env` changes. An existing different TEST_DATABASE_URL is
 * never overwritten: the operator resolves the conflict explicitly.
 */
export function planEnvFileUpdate(existingText: string | null, testDatabaseUrl: string): EnvFilePlan {
  const lines = existingText === null ? [] : existingText.split(/\r?\n/);
  const assignments = lines.filter((line) => /^\s*TEST_DATABASE_URL\s*=/.test(line));
  if (assignments.length > 1) {
    return { action: 'conflict', existing: 'multiple TEST_DATABASE_URL lines' };
  }
  if (assignments.length === 1) {
    const value = assignments[0]!.replace(/^\s*TEST_DATABASE_URL\s*=\s*/, '').trim().replace(/^(['"])(.*)\1$/, '$2');
    return value === testDatabaseUrl
      ? { action: 'unchanged' }
      : { action: 'conflict', existing: redactTestDatabaseUrl(value) };
  }
  const prefix = existingText === null || existingText === '' || existingText.endsWith('\n') ? '' : '\n';
  return { action: 'append', text: `${prefix}TEST_DATABASE_URL=${testDatabaseUrl}\n` };
}

/**
 * Pre-check for `--write-env`, before anything is created: an existing
 * TEST_DATABASE_URL that names another database is a conflict.
 */
export function envFileTargetsOtherDatabase(existingText: string | null, databaseName: string): string | null {
  if (existingText === null) return null;
  const line = existingText.split(/\r?\n/).find((entry) => /^\s*TEST_DATABASE_URL\s*=/.test(entry));
  if (line === undefined) return null;
  const value = line.replace(/^\s*TEST_DATABASE_URL\s*=\s*/, '').trim().replace(/^(['"])(.*)\1$/, '$2');
  let name = '';
  try {
    name = decodeURIComponent(new URL(value).pathname.replace(/^\//, ''));
  } catch {
    return redactTestDatabaseUrl(value);
  }
  return name === databaseName ? null : redactTestDatabaseUrl(value);
}

/** PostgreSQL identifier quoting for names already validated above. */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
