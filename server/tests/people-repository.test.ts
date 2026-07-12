import { describe, expect, it } from 'vitest';

import { PostgresPeopleRepository } from '../src/modules/people/repository.js';

type QueryCall = { text: string; values: unknown[] };

function recordingPool(rows: unknown[] = []) {
  const calls: QueryCall[] = [];
  const client = {
    query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      return { rows, rowCount: rows.length };
    },
    release: () => undefined,
  };
  return {
    calls,
    pool: { connect: async () => client, query: client.query } as never,
    credentials: {
      validatePassword: () => undefined,
      hashPassword: async () => 'hash',
      resetTemporaryPassword: async () => 2,
    },
    sessions: { revokeAllSessions: async () => undefined },
  };
}

describe('PostgresPeopleRepository transactions', () => {
  it('commits successful work and rolls back failed work', async () => {
    const success = recordingPool();
    const repository = new PostgresPeopleRepository(
      success.pool,
      success.credentials,
      success.sessions,
    );

    await expect(repository.execute(async () => 'done')).resolves.toBe('done');
    expect(success.calls.map((call) => call.text)).toEqual(['BEGIN', 'COMMIT']);

    const failure = recordingPool();
    const failingRepository = new PostgresPeopleRepository(
      failure.pool,
      failure.credentials,
      failure.sessions,
    );
    await expect(failingRepository.execute(async () => {
      throw new Error('stop');
    })).rejects.toThrow('stop');
    expect(failure.calls.map((call) => call.text)).toEqual(['BEGIN', 'ROLLBACK']);
  });

  it('uses integer versions for user and profile updates', async () => {
    const recorded = recordingPool();
    const repository = new PostgresPeopleRepository(
      recorded.pool,
      recorded.credentials,
      recorded.sessions,
    );

    await repository.execute(async (tx) => {
      await tx.updateUserName('user-1', 3, 'Yeni Ad');
      await tx.updateStaffProfile({
        organizationId: 'org-1', userId: 'staff-1', expectedVersion: 4,
        title: 'Saha Uzmanı', phone: null, region: 'Marmara', managerUserId: null,
      });
    });

    const sql = recorded.calls.map((call) => call.text).join('\n');
    expect(sql).toMatch(/UPDATE users[\s\S]*version = version \+ 1[\s\S]*WHERE id = \$1 AND version = \$2/);
    expect(sql).toMatch(/UPDATE staff_profiles[\s\S]*version = version \+ 1[\s\S]*WHERE organization_id = \$1 AND user_id = \$2 AND version = \$3/);
  });

  it('writes only the safe audit values supplied by the service', async () => {
    const recorded = recordingPool();
    const repository = new PostgresPeopleRepository(
      recorded.pool,
      recorded.credentials,
      recorded.sessions,
    );

    await repository.execute((tx) => tx.appendAudit({
      organizationId: 'org-1', actorUserId: 'admin-1', subjectType: 'USER',
      subjectId: 'staff-1', eventType: 'USER_DEACTIVATED',
      oldValue: { isActive: true }, newValue: { isActive: false }, metadata: {},
    }));

    const insert = recorded.calls.find((call) => call.text.includes('INSERT INTO audit_events'))!;
    expect(insert.values).toEqual([
      'org-1', 'admin-1', 'USER', 'staff-1', 'USER_DEACTIVATED',
      { isActive: true }, { isActive: false }, {},
    ]);
    expect(JSON.stringify(insert.values)).not.toMatch(/password|token|cookie|session/i);
  });

  it('locks active Admin rows without combining an aggregate and row lock', async () => {
    const recorded = recordingPool([{ id: 'admin-1' }, { id: 'admin-2' }]);
    const repository = new PostgresPeopleRepository(
      recorded.pool,
      recorded.credentials,
      recorded.sessions,
    );

    await expect(repository.execute((tx) => tx.countActiveAdmins('org-1'))).resolves.toBe(2);
    const select = recorded.calls.find((call) => call.text.includes("role = 'ADMIN'"))!;
    expect(select.text).toMatch(/SELECT id FROM users[\s\S]*FOR SHARE/);
    expect(select.text).not.toContain('COUNT(');
  });
});
