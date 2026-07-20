import { describe, expect, it, vi } from 'vitest';

import {
  PostgresNotificationRepository,
} from '../src/modules/notifications/repository.js';

describe('Postgres notification repository', () => {
  it('counts unread records only for the authenticated recipient in their organization', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ unread_count: 3 }] });
    const repository = new PostgresNotificationRepository({ query } as never);

    await expect(repository.unreadCount({
      organizationId: 'organization-1',
      userId: 'recipient-1',
    })).resolves.toBe(3);

    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toContain('organization_id = $1');
    expect(sql).toContain('recipient_user_id = $2');
    expect(sql).toContain('read_at IS NULL');
    expect(values).toEqual(['organization-1', 'recipient-1']);
  });

  it('lists the recipient’s records newest-first after a stable cursor', async () => {
    const createdAt = new Date('2026-07-21T09:30:00.000Z');
    const query = vi.fn().mockResolvedValue({
      rows: [{
        id: 'notification-1',
        organization_id: 'organization-1',
        recipient_user_id: 'recipient-1',
        source_realtime_event_id: '42',
        kind: 'job.approved',
        entity_type: 'job-card',
        entity_id: 'job-1',
        created_at: createdAt,
        read_at: null,
      }],
    });
    const repository = new PostgresNotificationRepository({ query } as never);

    const page = await repository.list({
      organizationId: 'organization-1',
      userId: 'recipient-1',
    }, {
      limit: 20,
      cursor: {
        createdAt: new Date('2026-07-20T09:30:00.000Z'),
        id: 'notification-cursor',
      },
    });

    expect(page.items).toEqual([expect.objectContaining({
      id: 'notification-1',
      sourceRealtimeEventId: 42n,
      kind: 'job.approved',
      createdAt,
      readAt: null,
    })]);
    expect(page.nextCursor).toBeNull();

    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toContain('organization_id = $1');
    expect(sql).toContain('recipient_user_id = $2');
    expect(sql).toContain('(created_at, id) < ($3, $4)');
    expect(sql).toContain('ORDER BY created_at DESC, id DESC');
    expect(values).toEqual([
      'organization-1',
      'recipient-1',
      new Date('2026-07-20T09:30:00.000Z'),
      'notification-cursor',
      21,
    ]);
  });

  it('marks only the recipient’s record read without replacing an existing read time', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{
        id: 'notification-1',
        organization_id: 'organization-1',
        recipient_user_id: 'recipient-1',
        source_realtime_event_id: '42',
        kind: 'job.approved',
        entity_type: 'job-card',
        entity_id: 'job-1',
        created_at: new Date('2026-07-21T09:30:00.000Z'),
        read_at: new Date('2026-07-21T10:00:00.000Z'),
      }],
    });
    const repository = new PostgresNotificationRepository({ query } as never);

    await expect(repository.markRead({
      organizationId: 'organization-1',
      userId: 'recipient-1',
    }, 'notification-1')).resolves.toMatchObject({
      id: 'notification-1',
      readAt: new Date('2026-07-21T10:00:00.000Z'),
    });

    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toContain('UPDATE in_app_notifications');
    expect(sql).toContain('read_at = COALESCE(read_at, NOW())');
    expect(sql).toContain('organization_id = $1');
    expect(sql).toContain('recipient_user_id = $2');
    expect(sql).toContain('id = $3');
    expect(values).toEqual(['organization-1', 'recipient-1', 'notification-1']);
  });
});
