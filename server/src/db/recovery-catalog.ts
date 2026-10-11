import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';
import { compareMigrationState, loadMigrationCatalog, type MigrationCatalog } from './migration-catalog.js';

export function assertRecoveryTestContext(databaseUrl: string): void {
  const url = new URL(databaseUrl);
  const ci = process.env.CI === 'true';
  // The existing local-CI service lives on its isolated Docker network.
  const hostAllowed = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || (ci && url.hostname === 'servora-localci-pg');
  const databaseAllowed = /^\/servora_med_(?:test_|recovery_)[A-Za-z0-9_]+$/.test(url.pathname)
    || (ci && url.pathname === '/servora_med_test');
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.password || !hostAllowed || !databaseAllowed) {
    throw new Error('RECOVERY_TEST_CONTEXT_INVALID');
  }
}

/** Recovery uses the existing root-installed release/content markers, never a
 * manifest head, a SHA-shaped string, or a guessed prefix of today's catalog.
 * This is an operator/host trust boundary, not proof of migration execution order.
 */
export async function loadInstalledRecoveryCatalog(releaseSha: string): Promise<{
  releaseSha: string; artifactSha256: string; catalog: MigrationCatalog;
}> {
  if (!/^[0-9a-f]{40}$/.test(releaseSha)) throw new Error('RECOVERY_RELEASE_INVALID');
  let releasesRoot = '/opt/servora-med/releases';
  let owner = 0;
  // A fixture root is available only in the canonical, isolated test context.
  if (process.env.NODE_ENV === 'test' && process.env.TEST_DATABASE_URL && process.env.RECOVERY_RELEASES_ROOT) {
    assertRecoveryTestContext(process.env.TEST_DATABASE_URL);
    releasesRoot = process.env.RECOVERY_RELEASES_ROOT;
    owner = process.getuid!();
  }
  if (!path.isAbsolute(releasesRoot)) throw new Error('RECOVERY_RELEASE_ROOT_INVALID');
  const release = path.join(releasesRoot, releaseSha);
  async function protectedEntry(file: string, directory: boolean, marker = false) {
    const info = await lstat(file);
    if (info.isSymbolicLink() || info.uid !== owner || (info.mode & 0o022) !== 0
      || (directory ? !info.isDirectory() : !info.isFile())
      || (marker && (info.mode & 0o777) !== 0o600)) throw new Error('RECOVERY_RELEASE_UNTRUSTED');
  }
  if (releasesRoot === '/opt/servora-med/releases') {
    for (const directory of ['/opt', '/opt/servora-med']) await protectedEntry(directory, true);
  }
  // No symlink or writable component below the fixed release root.
  for (const directory of [releasesRoot, release, path.join(release, 'server'),
    path.join(release, 'server/dist'), path.join(release, 'server/dist/db'),
    path.join(release, 'server/dist/db/migrations')]) await protectedEntry(directory, true);
  const artifactMarker = path.join(release, '.servora-release-artifact.sha256');
  const contentMarker = path.join(release, '.servora-release-content.sha256');
  await protectedEntry(artifactMarker, false, true);
  await protectedEntry(contentMarker, false, true);
  const artifactSha256 = await readFile(artifactMarker, 'utf8');
  if (!/^[0-9a-f]{64}\n$/.test(artifactSha256)) throw new Error('RECOVERY_ARTIFACT_BINDING_INVALID');
  const directory = path.join(release, 'server/dist/db/migrations');
  const hashes = new Map<string, string>();
  for (const line of (await readFile(contentMarker, 'utf8')).split('\n')) {
    if (!line.includes('./server/dist/db/migrations/')) continue;
    const match = /^f \.\/server\/dist\/db\/migrations\/([^/\s]+\.sql) ([0-9a-f]{64})$/.exec(line);
    if (!match || hashes.has(match[1]!)) throw new Error('RECOVERY_CATALOG_BINDING_INVALID');
    hashes.set(match[1]!, match[2]!);
  }
  const filenames = await readdir(directory);
  if (filenames.length !== hashes.size) throw new Error('RECOVERY_CATALOG_BINDING_INVALID');
  for (const filename of filenames) {
    const file = path.join(directory, filename);
    await protectedEntry(file, false);
    const digest = createHash('sha256').update(await readFile(file)).digest('hex');
    if (hashes.get(filename) !== digest) throw new Error('RECOVERY_CATALOG_BINDING_INVALID');
  }
  const catalog = await loadMigrationCatalog(directory);
  if (!catalog.head) throw new Error('RECOVERY_CATALOG_EMPTY');
  return { releaseSha, artifactSha256: artifactSha256.trim(), catalog };
}

export function assertExactRecoveryVersions(versions: readonly string[], catalog: MigrationCatalog, expectedHead: string): string {
  if (!catalog.head || catalog.head.version !== expectedHead) throw new Error('RECOVERY_CATALOG_HEAD_MISMATCH');
  const state = compareMigrationState(catalog, versions);
  if (state.status !== 'COMPATIBLE') throw new Error(`RECOVERY_HISTORY_${state.status}`);
  return catalog.head.version;
}

export async function assertExactRecoveryHistory(pool: Pool, catalog: MigrationCatalog, expectedHead: string): Promise<string> {
  const history = await pool.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version ASC');
  return assertExactRecoveryVersions(history.rows.map((row) => row.version), catalog, expectedHead);
}
