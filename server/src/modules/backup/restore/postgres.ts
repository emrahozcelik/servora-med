import { Pool } from 'pg';

import { parseToolVersion, resolveBinary, runBinary, type ParsedToolVersion } from '../process.js';
import type { RestoreManifestV1 } from './manifest.js';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CLI_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const RESERVED_PRODUCTION_NAMES = new Set(['servora_med', 'servora', 'production']);
const CORE_RELATIONS = [
  'schema_migrations',
  'organizations',
  'users',
  'customers',
  'contacts',
  'products',
  'job_cards',
  'backup_runs',
  'restore_runs',
  'audit_events',
] as const;

export class RestorePostgresError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'RESTORE_DATABASE_CREATE_FAILED'
      | 'RESTORE_PG_RESTORE_FAILED'
      | 'RESTORE_INTEGRITY_FAILED' = 'RESTORE_DATABASE_CREATE_FAILED',
  ) {
    super(message);
    this.name = 'RestorePostgresError';
  }
}

export function validateTargetDatabaseName(value: string): boolean {
  return CLI_IDENTIFIER.test(value) && !RESERVED_PRODUCTION_NAMES.has(value.toLowerCase());
}

function quoteIdentifier(value: string): string {
  if (!IDENTIFIER.test(value)) throw new RestorePostgresError('target database identifier is unsafe');
  return `"${value.replaceAll('"', '""')}"`;
}

export function databaseNameFromUrl(databaseUrl: string): string {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new RestorePostgresError('target database URL is invalid');
  }
  const name = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!name || !IDENTIFIER.test(name)) throw new RestorePostgresError('target database URL has no safe database name');
  return name;
}

export function maintenanceDatabaseUrl(databaseUrl: string): string {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new RestorePostgresError('target database URL is invalid');
  }
  url.pathname = '/postgres';
  return url.toString();
}

export function targetDatabaseUrl(adminDatabaseUrl: string, targetDatabase: string): string {
  if (!validateTargetDatabaseName(targetDatabase)) throw new RestorePostgresError('target database identifier is unsafe');
  const url = new URL(adminDatabaseUrl);
  url.pathname = `/${targetDatabase}`;
  return url.toString();
}

function endpointKey(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  return `${url.hostname.toLowerCase()}:${url.port || '5432'}`;
}

export function assertNotProductionTarget(
  targetDatabase: string,
  adminDatabaseUrl: string,
  productionDatabaseUrl?: string | null,
): void {
  if (!validateTargetDatabaseName(targetDatabase)) {
    throw new RestorePostgresError('target database name is reserved or unsafe');
  }
  if (productionDatabaseUrl) {
    const productionName = databaseNameFromUrl(productionDatabaseUrl);
    if (productionName === targetDatabase && endpointKey(adminDatabaseUrl) === endpointKey(productionDatabaseUrl)) {
      throw new RestorePostgresError('refusing to restore over the production database');
    }
  }
}

export function postgresConnectionEnv(databaseUrl: string, databaseOverride?: string): NodeJS.ProcessEnv {
  const url = new URL(databaseUrl);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    LANG: process.env.LANG ?? 'C.UTF-8',
    PGHOST: url.hostname || '127.0.0.1',
    PGDATABASE: databaseOverride ?? databaseNameFromUrl(databaseUrl),
  };
  if (url.port) env.PGPORT = url.port;
  if (url.username) env.PGUSER = decodeURIComponent(url.username);
  if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
  const sslmode = url.searchParams.get('sslmode');
  if (sslmode) env.PGSSLMODE = sslmode;
  return env;
}

export type NewTargetRestoreResult = {
  targetDatabase: string;
  targetDatabaseUrl: string;
  createdByInvocation: true;
  pgRestoreVersion: ParsedToolVersion;
};

export function buildPgRestoreArgs(targetDatabase: string, dumpPath: string): string[] {
  return [
    '--exit-on-error',
    '--single-transaction',
    '--no-owner',
    '--no-acl',
    '--dbname', targetDatabase,
    dumpPath,
  ];
}

export async function inspectPgDumpArchive(input: {
  dumpPath: string;
  sourceServerVersion: string;
  pgRestoreBin?: string;
  databaseUrlForEnv?: string;
  signal?: AbortSignal;
}): Promise<ParsedToolVersion> {
  const pgRestoreBin = resolveBinary(input.pgRestoreBin ?? process.env.PG_RESTORE_BIN, 'pg_restore');
  try {
    const versionOutput = await runBinary(pgRestoreBin, ['--version'], { timeoutMs: 10_000, signal: input.signal });
    const restoreVersion = parseToolVersion(versionOutput.stdout, 'pg_restore');
    const sourceMajor = Number(/^\s*(\d+)/.exec(input.sourceServerVersion)?.[1]);
    if (Number.isFinite(sourceMajor) && restoreVersion.major < sourceMajor) {
      throw new RestorePostgresError('pg_restore is older than the source PostgreSQL server', 'RESTORE_PG_RESTORE_FAILED');
    }
    await runBinary(pgRestoreBin, ['-l', input.dumpPath], {
      timeoutMs: 60_000,
      signal: input.signal,
      env: postgresConnectionEnv(input.databaseUrlForEnv ?? 'postgresql://127.0.0.1/postgres', 'postgres'),
    });
    return restoreVersion;
  } catch (error) {
    if (error instanceof RestorePostgresError) throw error;
    throw new RestorePostgresError('pg_restore archive inspection failed', 'RESTORE_PG_RESTORE_FAILED');
  }
}

async function databaseExists(pool: Pool, database: string): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists',
    [database],
  );
  return result.rows[0]?.exists === true;
}

async function dropCreatedDatabase(pool: Pool, database: string): Promise<void> {
  await pool.query(`DROP DATABASE ${quoteIdentifier(database)}`);
}

/**
 * Inspect pg_restore's archive and create a target only after every
 * pre-mutation check has succeeded. The target is never dropped unless this
 * invocation created it and the caller explicitly allows failure cleanup.
 */
export async function restoreDumpIntoNewDatabase(input: {
  adminDatabaseUrl: string;
  targetDatabase: string;
  dumpPath: string;
  manifest: RestoreManifestV1;
  productionDatabaseUrl?: string | null;
  pgRestoreBin?: string;
  keepFailedTarget?: boolean;
  signal?: AbortSignal;
}): Promise<NewTargetRestoreResult> {
  assertNotProductionTarget(input.targetDatabase, input.adminDatabaseUrl, input.productionDatabaseUrl);
  const adminUrl = maintenanceDatabaseUrl(input.adminDatabaseUrl);
  const targetUrl = targetDatabaseUrl(input.adminDatabaseUrl, input.targetDatabase);
  const pool = new Pool({ connectionString: adminUrl, max: 1, connectionTimeoutMillis: 5_000 });
  const pgRestoreBin = resolveBinary(input.pgRestoreBin ?? process.env.PG_RESTORE_BIN, 'pg_restore');
  let created = false;
  try {
    if (await databaseExists(pool, input.targetDatabase)) {
      throw new RestorePostgresError('target database already exists; overwrite is forbidden');
    }
    const restoreVersion = await inspectPgDumpArchive({
      dumpPath: input.dumpPath,
      sourceServerVersion: input.manifest.database.serverVersion,
      pgRestoreBin,
      databaseUrlForEnv: input.adminDatabaseUrl,
      signal: input.signal,
    });
    await pool.query(`CREATE DATABASE ${quoteIdentifier(input.targetDatabase)}`);
    created = true;
    try {
      await runBinary(pgRestoreBin, buildPgRestoreArgs(input.targetDatabase, input.dumpPath), {
        timeoutMs: 6 * 60 * 60 * 1_000,
        signal: input.signal,
        env: postgresConnectionEnv(input.adminDatabaseUrl, input.targetDatabase),
      });
    } catch {
      throw new RestorePostgresError('pg_restore failed before target validation', 'RESTORE_PG_RESTORE_FAILED');
    }
    return {
      targetDatabase: input.targetDatabase,
      targetDatabaseUrl: targetUrl,
      createdByInvocation: true,
      pgRestoreVersion: restoreVersion,
    };
  } catch (error) {
    if (created && !input.keepFailedTarget) await dropCreatedDatabase(pool, input.targetDatabase).catch(() => undefined);
    throw error;
  } finally {
    await pool.end();
  }
}

export type RestoredDatabaseEvidence = {
  schemaVersion: string;
  relations: string[];
  users: number;
  jobCards: number;
  orphanJobCards: number;
  nonTerminalBackupRuns: number;
  activeRestoreRuns: number;
  workerStateRows: number;
};

/** Validate schema and a small set of domain invariants without emitting rows. */
export async function validateRestoredDatabase(
  databaseUrl: string,
  manifest: RestoreManifestV1,
): Promise<RestoredDatabaseEvidence> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5_000 });
  try {
    const relations: string[] = [];
    for (const relation of CORE_RELATIONS) {
      const result = await pool.query<{ relation: string | null }>('SELECT to_regclass($1) AS relation', [relation]);
      if (!result.rows[0]?.relation) throw new RestorePostgresError(`required relation is missing: ${relation}`, 'RESTORE_INTEGRITY_FAILED');
      relations.push(relation);
    }
    const schema = await pool.query<{ version: string }>(
      'SELECT version FROM schema_migrations ORDER BY applied_at DESC, version DESC LIMIT 1',
    );
    const schemaVersion = schema.rows[0]?.version;
    if (!schemaVersion || schemaVersion !== manifest.database.schemaVersion) {
      throw new RestorePostgresError('restored schema version does not match the manifest', 'RESTORE_INTEGRITY_FAILED');
    }
    const counts = await pool.query<{
      users: string;
      job_cards: string;
      orphan_job_cards: string;
      non_terminal_backup_runs: string;
      active_restore_runs: string;
      worker_state_rows: string;
    }>(
      `SELECT
         (SELECT COUNT(*)::text FROM users) AS users,
         (SELECT COUNT(*)::text FROM job_cards) AS job_cards,
         (SELECT COUNT(*)::text FROM job_cards j LEFT JOIN users u ON u.id = j.assigned_to
            WHERE j.assigned_to IS NOT NULL AND u.id IS NULL) AS orphan_job_cards,
         (SELECT COUNT(*)::text FROM backup_runs WHERE status IN ('QUEUED', 'RUNNING')) AS non_terminal_backup_runs,
         (SELECT COUNT(*)::text FROM restore_runs WHERE status = 'RUNNING') AS active_restore_runs,
         (SELECT COUNT(*)::text FROM backup_worker_state) AS worker_state_rows`,
    );
    const row = counts.rows[0]!;
    const orphanJobCards = Number(row.orphan_job_cards);
    if (!Number.isSafeInteger(orphanJobCards) || orphanJobCards !== 0) {
      throw new RestorePostgresError('restored job card references are inconsistent', 'RESTORE_INTEGRITY_FAILED');
    }
    return {
      schemaVersion,
      relations,
      users: Number(row.users),
      jobCards: Number(row.job_cards),
      orphanJobCards,
      nonTerminalBackupRuns: Number(row.non_terminal_backup_runs),
      activeRestoreRuns: Number(row.active_restore_runs),
      workerStateRows: Number(row.worker_state_rows),
    };
  } catch (error) {
    if (error instanceof RestorePostgresError) throw error;
    throw new RestorePostgresError('restored database validation failed', 'RESTORE_INTEGRITY_FAILED');
  } finally {
    await pool.end();
  }
}

export async function dropRestoreTargetIfCreated(
  adminDatabaseUrl: string,
  targetDatabase: string,
): Promise<void> {
  const pool = new Pool({ connectionString: maintenanceDatabaseUrl(adminDatabaseUrl), max: 1 });
  try {
    if (await databaseExists(pool, targetDatabase)) await dropCreatedDatabase(pool, targetDatabase);
  } finally {
    await pool.end();
  }
}
