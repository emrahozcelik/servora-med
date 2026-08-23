import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRestoreWorkspace, removeRestoreWorkspace } from '../src/modules/backup/restore/workspace.js';
import { restoreFullDataArchive, validateFilesArchiveMemberName } from '../src/modules/backup/restore/files.js';

describe('BR7 restore workspace boundary', () => {
  it('creates a private dedicated workspace and removes only that exact path', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'br7-root-'));
    const workspace = await createRestoreWorkspace({ root, forbiddenRoots: [process.cwd()] });
    try {
      expect((await stat(workspace.root)).mode & 0o077).toBe(0);
      expect(workspace.plaintextPath).toContain(workspace.root);
      await expect(readlink(workspace.root)).rejects.toThrow();
    } finally {
      await removeRestoreWorkspace(workspace.root);
    }
    await expect(stat(workspace.root)).rejects.toThrow();
  });

  it('rejects traversal and absolute paths in FULL_DATA members', () => {
    expect(() => validateFilesArchiveMemberName('../outside')).toThrow(/traversal/);
    expect(() => validateFilesArchiveMemberName('/etc/passwd')).toThrow(/absolute/);
    expect(validateFilesArchiveMemberName('./safe/file.txt').normalized).toBe('safe/file.txt');
  });

  it('rejects a crafted historical files archive containing a symlink', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'br7-files-archive-'));
    try {
      const source = path.join(root, 'source');
      const workspace = path.join(root, 'workspace');
      await mkdir(source, { recursive: true });
      await mkdir(workspace, { recursive: true });
      await writeFile(path.join(source, 'regular.txt'), 'safe');
      await symlink('/etc/passwd', path.join(source, 'link'));
      const tarPath = path.join(workspace, 'files.tar');
      const compressedPath = path.join(root, 'files.tar.zst');
      execFileSync('tar', ['-cf', tarPath, '-C', source, '.']);
      execFileSync('zstd', ['-q', '-f', '-o', compressedPath, tarPath]);

      await expect(restoreFullDataArchive(compressedPath, path.join(root, 'target'), workspace))
        .rejects.toThrow(/link|unsafe/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
