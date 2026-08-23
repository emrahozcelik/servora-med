import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { RestoreService } from '../src/modules/backup/restore/service.js';

describe('BR7 restore service package verification', () => {
  it('inspects a flat local package without consulting the source database', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'br7-service-'));
    try {
      const dump = Buffer.from('dump');
      const digest = createHash('sha256').update(dump).digest('hex');
      const manifest = {
        format: 'servora-backup', formatVersion: 1,
        backupId: '11111111-2222-4333-8444-555555555555',
        createdAt: '2026-08-23T10:00:00.000Z',
        application: { applicationVersion: '0.1.0', gitCommit: null },
        backupScope: 'DATABASE', origin: 'MANUAL', retentionClass: 'MANUAL',
        database: { engine: 'postgresql', serverVersion: '16.13', dumpVersion: '1.15', dumpToolVersion: '16.13', schemaVersion: '033_backup_worker_runtime' },
        contents: { database: { file: 'database.dump', bytes: dump.length, sha256: digest }, files: null },
        checksums: { file: 'checksums.sha256' },
      };
      await writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest));
      await writeFile(path.join(root, 'database.dump'), dump);
      await writeFile(path.join(root, 'checksums.sha256'), `${digest}  database.dump\n`);
      const packagePath = path.join(root, 'package.sbk.tar');
      execFileSync('tar', ['-cf', packagePath, '-C', root, 'manifest.json', 'database.dump', 'checksums.sha256']);

      const result = await new RestoreService({ workspaceRoot: path.join(root, 'work') }).inspect({ archiveOrId: packagePath });
      expect(result).toMatchObject({ outcome: 'INSPECTED', backupId: manifest.backupId, databaseBytes: dump.length });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not hardcode the current migration in the restore package gate', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'br7-schema-'));
    try {
      const dump = Buffer.from('dump');
      const digest = createHash('sha256').update(dump).digest('hex');
      const manifest = {
        format: 'servora-backup', formatVersion: 1,
        backupId: '11111111-2222-4333-8444-555555555555',
        createdAt: '2026-08-23T10:00:00.000Z',
        application: { applicationVersion: '0.1.0', gitCommit: null },
        backupScope: 'DATABASE', origin: 'MANUAL', retentionClass: 'MANUAL',
        database: { engine: 'postgresql', serverVersion: '16.13', dumpVersion: '1.15', dumpToolVersion: '16.13', schemaVersion: '032_backup_r2_failure_taxonomy' },
        contents: { database: { file: 'database.dump', bytes: dump.length, sha256: digest }, files: null },
        checksums: { file: 'checksums.sha256' },
      };
      await writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest));
      await writeFile(path.join(root, 'database.dump'), dump);
      await writeFile(path.join(root, 'checksums.sha256'), `${digest}  database.dump\n`);
      const packagePath = path.join(root, 'package.sbk.tar');
      execFileSync('tar', ['-cf', packagePath, '-C', root, 'manifest.json', 'database.dump', 'checksums.sha256']);

      await expect(new RestoreService({ workspaceRoot: path.join(root, 'work') }).inspect({ archiveOrId: packagePath }))
        .resolves.toMatchObject({ outcome: 'INSPECTED', schemaVersion: '032_backup_r2_failure_taxonomy' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
