import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { reclaimTerminalWorkspaces } from '../src/modules/backup/workspace.js';

const FAILED_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RUNNING_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SUCCESS_UNVERIFIED_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SYMLINK_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

describe('BR5 stale workspace reclamation', () => {
  it('removes only terminal verified-safe workspaces and refuses symlinks', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'servora-br5-workspaces-'));
    try {
      await Promise.all([
        mkdir(path.join(root, FAILED_ID), { recursive: true }),
        mkdir(path.join(root, RUNNING_ID), { recursive: true }),
        mkdir(path.join(root, SUCCESS_UNVERIFIED_ID), { recursive: true }),
        mkdir(path.join(root, SYMLINK_ID), { recursive: true }),
      ]);
      await writeFile(path.join(root, FAILED_ID, 'partial'), 'safe');
      await symlink('/tmp', path.join(root, SYMLINK_ID, 'escape'));
      const result = await reclaimTerminalWorkspaces(root, {
        findRunById: async (id) => {
          if (id === FAILED_ID) return { status: 'FAILED', verifiedAt: null };
          if (id === RUNNING_ID) return { status: 'RUNNING', verifiedAt: null };
          if (id === SUCCESS_UNVERIFIED_ID) return { status: 'SUCCESS', verifiedAt: null };
          if (id === SYMLINK_ID) return { status: 'FAILED', verifiedAt: null };
          return null;
        },
      });
      expect(result.removed).toEqual([FAILED_ID]);
      expect(result.skipped.sort()).toEqual([RUNNING_ID, SUCCESS_UNVERIFIED_ID, SYMLINK_ID].sort());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
