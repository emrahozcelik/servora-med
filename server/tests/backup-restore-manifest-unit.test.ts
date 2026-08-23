import { describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseRestoreManifest } from '../src/modules/backup/restore/manifest.js';
import { inspectPackageArchive, parseChecksumSidecar, validateArchiveMemberName } from '../src/modules/backup/restore/archive.js';

const backupId = '11111111-2222-4333-8444-555555555555';

const validManifest = () => ({
  format: 'servora-backup',
  formatVersion: 1,
  backupId,
  createdAt: '2026-08-23T10:00:00.000Z',
  application: { applicationVersion: '0.1.0', gitCommit: null },
  backupScope: 'DATABASE',
  origin: 'SCHEDULED',
  retentionClass: 'DAILY',
  database: {
    engine: 'postgresql',
    serverVersion: '16.13',
    dumpVersion: '1.15',
    dumpToolVersion: '16.13',
    schemaVersion: '033_backup_worker_runtime',
  },
  contents: {
    database: { file: 'database.dump', bytes: 12, sha256: 'a'.repeat(64) },
    files: null,
  },
  checksums: { file: 'checksums.sha256' },
});

describe('BR7 restore manifest contract', () => {
  it('parses a strict V1 manifest and retains only typed fields', () => {
    const result = parseRestoreManifest({ ...validManifest(), unexpected: 'ignored' });

    expect(result.backupId).toBe(backupId);
    expect(result.database.schemaVersion).toBe('033_backup_worker_runtime');
    expect(result.contents.database.file).toBe('database.dump');
    expect(result).not.toHaveProperty('unexpected');
  });

  it('fails closed for a future manifest format before restore work', () => {
    expect(() => parseRestoreManifest({ ...validManifest(), formatVersion: 2 }))
      .toThrow(/newer than this restore tool/);
  });

  it('accepts only the flat package members in the checksum sidecar', () => {
    expect(parseChecksumSidecar(
      `${'a'.repeat(64)}  database.dump\n`,
      false,
    )).toEqual({
      'database.dump': 'a'.repeat(64),
    });
  });

  it('rejects traversal, links and unexpected archive paths before extraction', () => {
    expect(() => validateArchiveMemberName('../database.dump')).toThrow(/traversal/);
    expect(() => validateArchiveMemberName('/tmp/database.dump')).toThrow(/absolute/);
    expect(() => validateArchiveMemberName('nested/database.dump')).toThrow(/unexpected/);
    expect(() => validateArchiveMemberName('database.dump')).not.toThrow();
  });

  it('rejects a symlink entry from the tar verbose listing before extraction', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'br7-archive-'));
    const archive = path.join(root, 'package.tar');
    const fakeTar = path.join(root, 'tar');
    await writeFile(archive, 'placeholder');
    await writeFile(fakeTar, `#!/bin/sh
if [ "$1" = "-tf" ]; then
  printf '%s\\n' manifest.json database.dump checksums.sha256
else
  printf '%s\\n' 'lrwxrwxrwx user group 0 2026-01-01 manifest.json -> /etc/passwd'
fi
`, { mode: 0o700 });
    await chmod(fakeTar, 0o700);
    try {
      await expect(inspectPackageArchive(archive, fakeTar)).rejects.toThrow(/non-regular/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
