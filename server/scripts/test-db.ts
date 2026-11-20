/**
 * Local test database provisioning — I/O adapter.
 *
 *   npm run test:db -- provision --suffix <suffix> [--write-env]
 *   npm run test:db -- list
 *   npm run test:db -- drop --suffix <suffix> --yes
 *
 * Scope (fail-closed):
 * - Only a loopback PostgreSQL 17 is touched, through a local admin connection
 *   (`TEST_DB_ADMIN_URL`, default: the OS user at 127.0.0.1:5432/postgres).
 * - Only databases named `servora_med_test_<suffix>` are created or dropped.
 *   The shared CI name and the protected development/staging names cannot be
 *   produced by construction and are re-checked by the preflight contract.
 * - Every database is owned by one documented login role,
 *   `servora_med_test_runner`. Its password is generated once and kept outside
 *   the repository in `$XDG_CONFIG_HOME/servora-med/test-db-runner.secret`
 *   (default `~/.config/...`, mode 0600). It is never printed.
 * - `provision` migrates the database to the repository head with the built
 *   migration CLI. It never drops, truncates or resets an existing database.
 * - `--write-env` appends TEST_DATABASE_URL to the gitignored `server/.env`
 *   only when absent; an existing different value is reported, not replaced.
 *
 * The test preflight (`./test-env-preflight.ts`) stays read-only and unchanged.
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import {
  TEST_DB_RUNNER_ROLE,
  TestDbProvisionError,
  assertLoopbackAdminUrl,
  buildTestDatabaseUrl,
  envFileTargetsOtherDatabase,
  parseTestDbArgs,
  planEnvFileUpdate,
  quoteIdentifier,
  testDatabaseName,
} from './test-db-plan.js';
import { REQUIRED_POSTGRES_MAJOR, redactTestDatabaseUrl } from './test-env-contract.js';

const serverRoot = fileURLToPath(new URL('..', import.meta.url));
const migrateCli = path.join(serverRoot, 'dist/db/migrate.js');
const envFile = path.join(serverRoot, '.env');
const secretFile = path.join(
  process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'),
  'servora-med',
  'test-db-runner.secret',
);
const PASSWORD_PATTERN = /^[A-Za-z0-9_-]{32,}$/;
const ADVISORY_LOCK_KEY = 'servora_med_test_db_provision';

function adminUrl(): string {
  const raw = process.env.TEST_DB_ADMIN_URL?.trim() || 'postgresql://127.0.0.1:5432/postgres';
  assertLoopbackAdminUrl(raw);
  return raw;
}

function readSecret(): string | null {
  if (!existsSync(secretFile)) return null;
  const mode = statSync(secretFile).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new TestDbProvisionError(
      'TEST_DB_SECRET_PERMISSIONS',
      `${secretFile} must be readable by its owner only (chmod 600).`,
    );
  }
  const value = readFileSync(secretFile, 'utf8').trim();
  if (!PASSWORD_PATTERN.test(value)) {
    throw new TestDbProvisionError('TEST_DB_SECRET_MALFORMED', `${secretFile} does not contain a valid generated password.`);
  }
  return value;
}

function createSecret(): string {
  mkdirSync(path.dirname(secretFile), { recursive: true, mode: 0o700 });
  const value = randomBytes(32).toString('base64url');
  writeFileSync(secretFile, `${value}\n`, { mode: 0o600, flag: 'wx' });
  return value;
}

async function withAdmin<T>(work: (pool: Pool) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: adminUrl(), max: 1 });
  try {
    let versionNum: string;
    try {
      const version = await pool.query<{ server_version_num: string }>('SHOW server_version_num');
      versionNum = version.rows[0]?.server_version_num ?? '0';
    } catch (error) {
      const code = (error as { code?: string }).code;
      throw new TestDbProvisionError(
        'TEST_DB_ADMIN_UNAVAILABLE',
        `Admin connection failed (${redactTestDatabaseUrl(adminUrl())}${code ? `, ${code}` : ''}): ${(error as Error).message}. ` +
          'Start the local PostgreSQL 17 server or set TEST_DB_ADMIN_URL to a loopback superuser connection.',
      );
    }
    const major = Math.floor(Number(versionNum) / 10000);
    if (major !== REQUIRED_POSTGRES_MAJOR) {
      throw new TestDbProvisionError(
        'TEST_DB_POSTGRES_MAJOR_MISMATCH',
        `PostgreSQL ${REQUIRED_POSTGRES_MAJOR} is required; the admin connection reached major ${major}.`,
      );
    }
    return await work(pool);
  } finally {
    await pool.end();
  }
}

async function ensureRunnerRole(pool: Pool): Promise<string> {
  const existing = await pool.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [TEST_DB_RUNNER_ROLE]);
  let password = readSecret();
  if (existing.rowCount === 0) {
    password ??= createSecret();
    if (!PASSWORD_PATTERN.test(password)) throw new TestDbProvisionError('TEST_DB_SECRET_MALFORMED', 'Generated password is invalid.');
    // CI runs the suite as the service superuser; the local runner mirrors
    // that privilege level on the loopback-only development cluster.
    await pool.query(`CREATE ROLE ${quoteIdentifier(TEST_DB_RUNNER_ROLE)} LOGIN SUPERUSER PASSWORD '${password}'`);
    console.log(`Created login role ${TEST_DB_RUNNER_ROLE}; password stored in ${secretFile}.`);
    return password;
  }
  if (password === null) {
    throw new TestDbProvisionError(
      'TEST_DB_RUNNER_SECRET_MISSING',
      `Role ${TEST_DB_RUNNER_ROLE} exists but ${secretFile} is missing. Restore the file, or as the local admin run ` +
        `ALTER ROLE ${TEST_DB_RUNNER_ROLE} PASSWORD '<new generated value>' and store that value in the file (mode 600).`,
    );
  }
  return password;
}

async function assertRunnerLogin(url: string): Promise<void> {
  const probe = new URL(url);
  probe.pathname = '/postgres';
  const pool = new Pool({ connectionString: probe.toString(), max: 1 });
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    throw new TestDbProvisionError(
      'TEST_DB_RUNNER_AUTH_FAILED',
      `Role ${TEST_DB_RUNNER_ROLE} could not log in with the password in ${secretFile} ` +
        `(${(error as { code?: string }).code ?? (error as Error).message}). Align the role password with the file; nothing was created.`,
    );
  } finally {
    await pool.end();
  }
}

async function provision(suffix: string, writeEnv: boolean): Promise<void> {
  const databaseName = testDatabaseName(suffix);
  if (!existsSync(migrateCli)) {
    throw new TestDbProvisionError('TEST_DB_BUILD_MISSING', 'dist/db/migrate.js is missing; run `npm run build` first.');
  }
  if (writeEnv) {
    const other = envFileTargetsOtherDatabase(existsSync(envFile) ? readFileSync(envFile, 'utf8') : null, databaseName);
    if (other !== null) {
      throw new TestDbProvisionError(
        'TEST_DB_ENV_CONFLICT',
        `server/.env already sets TEST_DATABASE_URL (${other}); nothing was created. ` +
          'Remove or edit that line yourself if this worktree should use a different database.',
      );
    }
  }
  const url = await withAdmin(async (pool) => {
    await pool.query('SELECT pg_advisory_lock(hashtext($1))', [ADVISORY_LOCK_KEY]);
    try {
      const password = await ensureRunnerRole(pool);
      const runnerUrl = buildTestDatabaseUrl({ databaseName, password });
      await assertRunnerLogin(runnerUrl);
      const exists = await pool.query('SELECT 1 FROM pg_database WHERE datname = $1', [databaseName]);
      if (exists.rowCount === 0) {
        await pool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)} OWNER ${quoteIdentifier(TEST_DB_RUNNER_ROLE)}`);
        console.log(`Created database ${databaseName}.`);
      } else {
        console.log(`Database ${databaseName} already exists; keeping it and applying pending migrations only.`);
      }
      return runnerUrl;
    } finally {
      await pool.query('SELECT pg_advisory_unlock(hashtext($1))', [ADVISORY_LOCK_KEY]);
    }
  });

  const migrate = spawnSync(process.execPath, [migrateCli], {
    cwd: serverRoot,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: url },
  });
  if (migrate.error) throw migrate.error;
  if ((migrate.status ?? 1) !== 0) {
    throw new TestDbProvisionError('TEST_DB_MIGRATION_FAILED', `Migration of ${databaseName} failed; see output above.`);
  }

  console.log(`TEST_DATABASE_URL=${redactTestDatabaseUrl(url)} (password from ${secretFile})`);
  if (!writeEnv) {
    console.log('Re-run with --write-env to append it to server/.env, or export it in your shell.');
    return;
  }
  const plan = planEnvFileUpdate(existsSync(envFile) ? readFileSync(envFile, 'utf8') : null, url);
  if (plan.action === 'conflict') {
    throw new TestDbProvisionError(
      'TEST_DB_ENV_CONFLICT',
      `server/.env already sets TEST_DATABASE_URL (${plan.existing}); it was left unchanged. ` +
        'Remove or edit that line yourself if this worktree should use the new database.',
    );
  }
  if (plan.action === 'append') {
    appendFileSync(envFile, plan.text, { mode: 0o600 });
    console.log('Appended TEST_DATABASE_URL to server/.env (gitignored).');
  } else {
    console.log('server/.env already points at this database.');
  }
  console.log('Next: npm test -- --run');
}

async function drop(suffix: string): Promise<void> {
  const databaseName = testDatabaseName(suffix);
  await withAdmin(async (pool) => {
    const exists = await pool.query('SELECT 1 FROM pg_database WHERE datname = $1', [databaseName]);
    if (exists.rowCount === 0) {
      console.log(`Database ${databaseName} does not exist; nothing dropped.`);
      return;
    }
    // No FORCE: an open connection makes the drop fail instead of killing a run.
    await pool.query(`DROP DATABASE ${quoteIdentifier(databaseName)}`);
    console.log(`Dropped database ${databaseName}.`);
  });
}

async function list(): Promise<void> {
  await withAdmin(async (pool) => {
    const result = await pool.query<{ datname: string; owner: string; size: string }>(
      `SELECT d.datname, r.rolname AS owner, pg_size_pretty(pg_database_size(d.datname)) AS size
         FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba
        WHERE d.datname LIKE 'servora\\_med\\_test\\_%'
        ORDER BY d.datname`,
    );
    if (result.rows.length === 0) console.log('No isolated test databases found.');
    for (const row of result.rows) console.log(`${row.datname}\t${row.owner}\t${row.size}`);
  });
}

try {
  const args = parseTestDbArgs(process.argv.slice(2));
  if (args.command === 'provision') await provision(args.suffix!, args.writeEnv);
  else if (args.command === 'drop') await drop(args.suffix!);
  else await list();
} catch (error) {
  if (error instanceof TestDbProvisionError) {
    console.error(`${error.code}: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
