import { describe, expect, it, vi } from 'vitest';

import {
  PostgresNotificationRepository,
} from '../src/modules/notifications/repository.js';

const VIEWER = { organizationId: 'organization-1', userId: 'recipient-1' };

function repositoryWith(rows: unknown[] = [{ id: 'notification-1' }]) {
  const query = vi.fn().mockResolvedValue({ rows });
  return { repository: new PostgresNotificationRepository({ query } as never), query };
}

describe('N2 dismiss / clear contract', () => {
  it('unreadCount counts only non-dismissed unread rows for the viewer', async () => {
    const { repository, query } = repositoryWith([{ unread_count: 2 }]);

    await expect(repository.unreadCount(VIEWER)).resolves.toBe(2);

    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toContain('organization_id = $1');
    expect(sql).toContain('recipient_user_id = $2');
    expect(sql).toContain('read_at IS NULL');
    expect(sql).toContain('dismissed_at IS NULL');
    expect(values).toEqual(['organization-1', 'recipient-1']);
  });

  it('dismiss drops the read requirement and preserves read_at', async () => {
    const { repository, query } = repositoryWith();

    await expect(repository.dismiss(VIEWER, 'notification-1')).resolves.toBe(true);

    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toContain('SET dismissed_at = COALESCE(dismissed_at, NOW())');
    expect(sql).not.toContain('read_at IS NOT NULL');
    expect(sql).not.toMatch(/SET read_at/);
    expect(sql).toContain('id = $3');
    expect(values).toEqual(['organization-1', 'recipient-1', 'notification-1']);
  });

  it('dismiss abandons only PENDING deliveries with a DISMISSED reason', async () => {
    const { repository, query } = repositoryWith();

    await repository.dismiss(VIEWER, 'notification-1');

    const [sql] = query.mock.calls[0]!;
    expect(sql).toContain('UPDATE web_push_deliveries');
    expect(sql).toContain("SET state = 'ABANDONED'");
    expect(sql).toContain('lease_token = NULL');
    expect(sql).toContain('lease_until = NULL');
    expect(sql).toContain("last_error_code = 'DISMISSED'");
    expect(sql).toContain('abandoned_at = NOW()');
    expect(sql).toContain("web_push_deliveries.state = 'PENDING'");
    expect(sql).toContain('web_push_deliveries.notification_id = updated.id');
    expect(sql).not.toContain("'READ'");
  });

  it('dismiss reports absence when no row matches', async () => {
    const { repository } = repositoryWith([]);

    await expect(repository.dismiss(VIEWER, 'missing-notification')).resolves.toBe(false);
  });

  it('clearAll dismisses read and unread rows without touching read_at', async () => {
    const { repository, query } = repositoryWith([{ cleared_count: '3' }]);

    await expect(repository.clearAll(VIEWER)).resolves.toBe(3);

    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toContain('organization_id = $1');
    expect(sql).toContain('recipient_user_id = $2');
    expect(sql).toContain('dismissed_at IS NULL');
    expect(sql).not.toContain('read_at IS NOT NULL');
    expect(sql).not.toMatch(/SET read_at/);
    expect(values).toEqual(['organization-1', 'recipient-1']);
  });

  it('clearAll abandons PENDING deliveries of newly dismissed rows', async () => {
    const { repository, query } = repositoryWith([{ cleared_count: '1' }]);

    await repository.clearAll(VIEWER);

    const [sql] = query.mock.calls[0]!;
    expect(sql).toContain('UPDATE web_push_deliveries');
    expect(sql).toContain("last_error_code = 'DISMISSED'");
    expect(sql).toContain("web_push_deliveries.state = 'PENDING'");
  });

  it('clearAll reports zero when nothing matches', async () => {
    const { repository } = repositoryWith([{ cleared_count: '0' }]);

    await expect(repository.clearAll(VIEWER)).resolves.toBe(0);
  });

  it('clearRead still affects only read rows', async () => {
    const { repository, query } = repositoryWith([{ id: 'notification-9' }]);

    await expect(repository.clearRead(VIEWER)).resolves.toBe(1);

    const [sql] = query.mock.calls[0]!;
    expect(sql).toContain('read_at IS NOT NULL');
    expect(sql).toContain('dismissed_at IS NULL');
  });
});
