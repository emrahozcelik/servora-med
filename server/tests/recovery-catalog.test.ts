import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadInstalledRecoveryCatalog } from '../src/db/recovery-catalog.js';

const sha = 'a'.repeat(40);
let root: string;
let release: string;
let directory: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'servora-catalog-trust-'));
  release = path.join(root, sha); directory = path.join(release, 'server/dist/db/migrations');
  await mkdir(directory, { recursive: true });
  const file = '001_initial.sql', sql = 'SELECT 1;\n';
  await writeFile(path.join(directory, file), sql);
  const hash = createHash('sha256').update(sql).digest('hex');
  await writeFile(path.join(release, '.servora-release-content.sha256'), `f ./server/dist/db/migrations/${file} ${hash}\n`, { mode: 0o600 });
  await writeFile(path.join(release, '.servora-release-artifact.sha256'), 'b'.repeat(64) + '\n', { mode: 0o600 });
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('TEST_DATABASE_URL', 'postgresql://synthetic:synthetic@127.0.0.1/servora_med_test_catalog_trust');
  vi.stubEnv('RECOVERY_RELEASES_ROOT', root);
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

describe('recovery catalog installed-artifact binding', () => {
  it('loads the canonical catalog only from protected installed markers and matching SQL bytes', async () => {
    const result = await loadInstalledRecoveryCatalog(sha);
    expect(result.releaseSha).toBe(sha); expect(result.artifactSha256).toBe('b'.repeat(64));
    expect(result.catalog.head?.version).toBe('001_initial');
  });
  it('does not treat a SHA-shaped value as artifact/catalog evidence', async () => {
    await rm(path.join(release, '.servora-release-artifact.sha256'));
    await expect(loadInstalledRecoveryCatalog(sha)).rejects.toThrow();
  });
  it('rejects modified SQL', async () => {
    await writeFile(path.join(directory, '001_initial.sql'), 'SELECT 2;');
    await expect(loadInstalledRecoveryCatalog(sha)).rejects.toThrow('RECOVERY_CATALOG_BINDING_INVALID');
  });
  it('rejects a removed SQL file and added catalog file', async () => {
    await rm(path.join(directory, '001_initial.sql'));
    await expect(loadInstalledRecoveryCatalog(sha)).rejects.toThrow('RECOVERY_CATALOG_BINDING_INVALID');
    await writeFile(path.join(directory, '002_branch.sql'), 'SELECT 2;');
    await expect(loadInstalledRecoveryCatalog(sha)).rejects.toThrow('RECOVERY_CATALOG_BINDING_INVALID');
  });
  it('rejects writable markers, writable SQL and writable catalog directories', async () => {
    const marker = path.join(release, '.servora-release-content.sha256');
    await chmod(marker, 0o620);
    await expect(loadInstalledRecoveryCatalog(sha)).rejects.toThrow('RECOVERY_RELEASE_UNTRUSTED');
    await chmod(marker, 0o600);
    const sql = path.join(directory, '001_initial.sql'); await chmod(sql, 0o666);
    await expect(loadInstalledRecoveryCatalog(sha)).rejects.toThrow('RECOVERY_RELEASE_UNTRUSTED');
    await chmod(sql, 0o644); await chmod(directory, 0o777);
    await expect(loadInstalledRecoveryCatalog(sha)).rejects.toThrow('RECOVERY_RELEASE_UNTRUSTED');
  });
  it('rejects symlinked SQL and symlinked release components', async () => {
    const sql = path.join(directory, '001_initial.sql'); const bytes = await readFile(sql);
    await rm(sql); const outside = path.join(root, 'outside.sql'); await writeFile(outside, bytes);
    await symlink(outside, sql);
    await expect(loadInstalledRecoveryCatalog(sha)).rejects.toThrow('RECOVERY_RELEASE_UNTRUSTED');
    await rm(release, { recursive: true }); await symlink(root, release);
    await expect(loadInstalledRecoveryCatalog(sha)).rejects.toThrow('RECOVERY_RELEASE_UNTRUSTED');
  });
  it('rejects test catalog overrides in a remote or protected DB context', async () => {
    vi.stubEnv('TEST_DATABASE_URL', 'postgresql://synthetic:synthetic@remote.invalid/servora_med_test_catalog_trust');
    await expect(loadInstalledRecoveryCatalog(sha)).rejects.toThrow('RECOVERY_TEST_CONTEXT_INVALID');
    vi.stubEnv('TEST_DATABASE_URL', 'postgresql://synthetic:synthetic@127.0.0.1/servora_med');
    await expect(loadInstalledRecoveryCatalog(sha)).rejects.toThrow('RECOVERY_TEST_CONTEXT_INVALID');
  });
  it('permits the established ephemeral local-CI service only in explicit CI context', async () => {
    vi.stubEnv('CI', 'false');
    vi.stubEnv('TEST_DATABASE_URL', 'postgresql://synthetic:synthetic@servora-localci-pg/servora_med_test');
    await expect(loadInstalledRecoveryCatalog(sha)).rejects.toThrow('RECOVERY_TEST_CONTEXT_INVALID');
    vi.stubEnv('CI', 'true');
    await expect(loadInstalledRecoveryCatalog(sha)).resolves.toMatchObject({ releaseSha: sha });
  });
});
