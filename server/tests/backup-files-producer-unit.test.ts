import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { link, mkdtemp, symlink, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { validateFilesArchiveSource } from '../src/modules/backup/engine.js';

describe('BR2 FULL_DATA producer source boundary', () => {
  it('rejects a symlink before files archive production', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'br2-files-source-'));
    try {
      await writeFile(path.join(root, 'regular.txt'), 'safe');
      await symlink('/tmp/outside-not-read', path.join(root, 'link'));
      await expect(validateFilesArchiveSource(root)).rejects.toThrow(/symlink/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a hardlink before files archive production', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'br2-files-hardlink-'));
    try {
      const original = path.join(root, 'original.txt');
      await writeFile(original, 'same inode');
      await link(original, path.join(root, 'alias.txt'));
      await expect(validateFilesArchiveSource(root)).rejects.toThrow(/hardlink/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a FIFO before files archive production', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'br2-files-fifo-'));
    try {
      execFileSync('mkfifo', [path.join(root, 'pipe')]);
      await expect(validateFilesArchiveSource(root)).rejects.toThrow(/special entry/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
