import { describe, expect, it } from 'vitest';

import { parseRestoreCliArgs } from '../src/cli/servora-backup.js';

describe('BR7 operator CLI contract', () => {
  it('requires explicit destructive acknowledgement and target database for restore', () => {
    expect(() => parseRestoreCliArgs([
      'restore', '11111111-2222-4333-8444-555555555555', '--target-db', 'dr_2026',
    ])).toThrow(/acknowledgement/);

    expect(parseRestoreCliArgs([
      'restore', '11111111-2222-4333-8444-555555555555',
      '--target-db', 'dr_2026', '--i-accept-destructive-restore',
      '--release', 'a'.repeat(40),
      '--mode', 'disaster-recovery', '--identity', '/secure/operator.age',
    ])).toMatchObject({
      command: 'restore',
      archiveOrId: '11111111-2222-4333-8444-555555555555',
      targetDatabase: 'dr_2026',
      mode: 'DISASTER_RECOVERY',
    });
  });
  it('requires a verified installed release selector, not only a manifest head', () => {
    expect(() => parseRestoreCliArgs(['restore', 'backup.sbk.tar', '--target-db', 'isolated_restore',
      '--i-accept-destructive-restore'])).toThrow(/--release/);
    expect(() => parseRestoreCliArgs(['restore', 'backup.sbk.tar', '--target-db', 'isolated_restore',
      '--i-accept-destructive-restore', '--release', 'not-a-sha'])).toThrow(/full commit SHA/);
  });
  it('does not enable restore selectors on read-only inspect/verify commands', () => {
    for (const command of ['inspect', 'verify']) {
      expect(() => parseRestoreCliArgs([command, 'backup.sbk.tar', '--release', 'a'.repeat(40)]))
        .toThrow(/restore-only/);
    }
  });
});
