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
      '--mode', 'disaster-recovery', '--identity', '/secure/operator.age',
    ])).toMatchObject({
      command: 'restore',
      archiveOrId: '11111111-2222-4333-8444-555555555555',
      targetDatabase: 'dr_2026',
      mode: 'DISASTER_RECOVERY',
    });
  });
});
