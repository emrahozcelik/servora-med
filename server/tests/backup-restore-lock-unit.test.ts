import { describe, expect, it } from 'vitest';

import { withTargetRestoreAdvisoryLock } from '../src/modules/backup/restore/locking.js';

describe('BR7 disaster-recovery locking', () => {
  it('keeps the shared advisory lock on one dedicated session', async () => {
    const calls: string[] = [];
    const client = {
      query: async (sql: string) => {
        calls.push(sql);
        return { rows: [{ locked: true }] };
      },
      release: () => calls.push('release'),
    };
    const pool = { connect: async () => client };
    await expect(withTargetRestoreAdvisoryLock(pool, async () => 'ok')).resolves.toEqual({ acquired: true, value: 'ok' });
    expect(calls).toEqual([
      'SELECT pg_try_advisory_lock($1) AS locked',
      'SELECT pg_advisory_unlock($1)',
      'release',
    ]);
  });
});
