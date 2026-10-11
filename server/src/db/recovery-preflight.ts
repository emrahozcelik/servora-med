import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { Pool } from 'pg';
import { assertExactRecoveryHistory, assertRecoveryTestContext, loadInstalledRecoveryCatalog } from './recovery-catalog.js';
import { dropRestoreTargetIfCreated, restoreDumpIntoNewDatabase, validateDumpMigrationHistory } from '../modules/backup/restore/postgres.js';

/** Invoked by the guarded legacy shell helper. URLs stay in the environment,
 * never argv/output. The scratch DB is new and owned by this invocation.
 */
async function main() {
  const [phase, releaseSha, head, backup] = process.argv.slice(2);
  if (!['preflight', 'verify'].includes(phase ?? '') || !releaseSha || !head) throw new Error('RECOVERY_PREFLIGHT_ARGUMENTS');
  if (process.env.TEST_DATABASE_URL) {
    assertRecoveryTestContext(process.env.TEST_DATABASE_URL);
  }
  const release = await loadInstalledRecoveryCatalog(releaseSha);
  const pool = process.env.TEST_DATABASE_URL
    ? new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 })
    : new Pool({ host: process.env.PGHOST ?? '127.0.0.1', database: 'servora_med', max: 1 });
  let scratch: string | null = null;
  let adminUrl: string | null = null;
  async function checkTarget(database: Pool) {
    await assertExactRecoveryHistory(database, release.catalog, head!);
    const relations = (await database.query<{ users: string | null; jobs: string | null }>(
      "SELECT to_regclass('users')::text AS users, to_regclass('job_cards')::text AS jobs")).rows[0]!;
    if (!relations.users || !relations.jobs) throw new Error('RECOVERY_RELATION_MISSING');
  }
  try {
    await checkTarget(pool);
    if (phase === 'preflight') {
      if (!backup) throw new Error('RECOVERY_BACKUP_REQUIRED');
      const info = (await pool.query<{ database: string; version: string }>(
        "SELECT current_database() AS database, current_setting('server_version') AS version")).rows[0]!;
      if (!/^17\./.test(info.version)) throw new Error('RECOVERY_POSTGRES_17_REQUIRED');
      const value = new URL(process.env.TEST_DATABASE_URL ?? 'postgresql://127.0.0.1/postgres');
      value.pathname = '/postgres';
      if (!process.env.TEST_DATABASE_URL) {
        value.hostname = process.env.PGHOST === '::1' ? '[::1]' : process.env.PGHOST ?? '127.0.0.1';
        value.port = process.env.PGPORT ?? '5432';
        value.username = process.env.PGUSER ?? userInfo().username;
        if (process.env.PGPASSWORD) value.password = process.env.PGPASSWORD;
      }
      adminUrl = value.toString();
      await validateDumpMigrationHistory({ dumpPath: backup, databaseUrlForEnv: adminUrl,
        catalog: release.catalog, expectedHead: head });
      const name = `servora_med_restore_check_${randomUUID().replaceAll('-', '')}`;
      const target = await restoreDumpIntoNewDatabase({
        adminDatabaseUrl: adminUrl, targetDatabase: name, dumpPath: backup,
        sourceServerVersion: info.version, productionDatabaseUrl: process.env.TEST_DATABASE_URL ?? undefined,
      });
      scratch = name;
      const restored = new Pool({ connectionString: target.targetDatabaseUrl, max: 1 });
      try { await checkTarget(restored); }
      finally { await restored.end(); }
      // Recheck the target after validating the backup, before the shell restore.
      await checkTarget(pool);
    }
    console.log(`RECOVERY_${phase.toUpperCase()}_PASS release=${releaseSha} schema=${head} artifact=${release.artifactSha256}`);
  } finally {
    await pool.end();
    if (scratch && adminUrl) await dropRestoreTargetIfCreated(adminUrl, scratch);
  }
}

main().catch((error: unknown) => {
  // Errors from drivers/tools can include connection values or restored SQL.
  const reason = error instanceof Error && /^RECOVERY_[A-Z_]+$/.test(error.message) ? error.message : 'VALIDATION_FAILED';
  console.error(`RECOVERY_PREFLIGHT_FAILED reason=${reason}`);
  process.exitCode = 1;
});
