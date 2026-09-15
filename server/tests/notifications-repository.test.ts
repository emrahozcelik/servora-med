import { describe, expect, it, vi } from 'vitest';

import {
  PostgresNotificationRepository,
  PostgresNotificationTransaction,
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
    expect(sql).toContain('dismissed_at IS NULL');
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
    expect(sql).toContain('dismissed_at IS NULL');
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

  it('dismisses a read or unread notification in the authenticated recipient scope', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 'notification-1' }] });
    const repository = new PostgresNotificationRepository({ query } as never);

    await expect(repository.dismiss({
      organizationId: 'organization-1',
      userId: 'recipient-1',
    }, 'notification-1')).resolves.toBe(true);

    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toContain('UPDATE in_app_notifications');
    expect(sql).toContain('dismissed_at = COALESCE(dismissed_at, NOW())');
    expect(sql).not.toContain('read_at IS NOT NULL');
    expect(sql).toContain('organization_id = $1');
    expect(sql).toContain('recipient_user_id = $2');
    expect(sql).toContain('id = $3');
    expect(values).toEqual(['organization-1', 'recipient-1', 'notification-1']);
  });

  it('clears every visible read notification for the authenticated recipient', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ id: 'notification-1' }, { id: 'notification-2' }, { id: 'notification-3' }],
    });
    const repository = new PostgresNotificationRepository({ query } as never);

    await expect(repository.clearRead({
      organizationId: 'organization-1',
      userId: 'recipient-1',
    })).resolves.toBe(3);

    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toContain('UPDATE in_app_notifications');
    expect(sql).toContain('dismissed_at = COALESCE(dismissed_at, NOW())');
    expect(sql).toContain('read_at IS NOT NULL');
    expect(sql).toContain('dismissed_at IS NULL');
    expect(sql).toContain('organization_id = $1');
    expect(sql).toContain('recipient_user_id = $2');
    expect(sql).not.toContain('id = $3');
    expect(values).toEqual(['organization-1', 'recipient-1']);
  });

  it('marks every visible unread notification for the viewer entity read', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ marked_count: '2' }] });
    const repository = new PostgresNotificationRepository({ query } as never);

    await expect(repository.markReadByEntity({
      organizationId: 'organization-1',
      userId: 'recipient-1',
    }, 'job-card', 'job-1')).resolves.toBe(2);

    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toContain('UPDATE in_app_notifications');
    expect(sql).toContain('organization_id = $1');
    expect(sql).toContain('recipient_user_id = $2');
    expect(sql).toContain('entity_type = $3');
    expect(sql).toContain('entity_id = $4');
    expect(sql).toContain('dismissed_at IS NULL');
    expect(sql).toContain('read_at IS NULL');
    expect(sql).toContain("state = 'ABANDONED'");
    expect(sql).toContain("last_error_code = 'READ'");
    expect(values).toEqual(['organization-1', 'recipient-1', 'job-card', 'job-1']);
  });

  it('marks by entity independent of kind and only abandons newly-read deliveries', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ marked_count: '3' }] });
    const repository = new PostgresNotificationRepository({ query } as never);

    await expect(repository.markReadByEntity({
      organizationId: 'organization-1',
      userId: 'recipient-1',
    }, 'job-card', 'job-1')).resolves.toBe(3);

    const [sql] = query.mock.calls[0]!;
    expect(sql).not.toContain('kind =');
    expect(sql).toContain('SET read_at = NOW()');
    expect(sql).toContain('FROM updated');
    expect(sql).toContain("AND web_push_deliveries.state = 'PENDING'");
  });

  it('repeats entity reads idempotently with the same scope', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ marked_count: '1' }] });
    const repository = new PostgresNotificationRepository({ query } as never);
    const viewer = { organizationId: 'organization-1', userId: 'recipient-1' };

    await expect(repository.markReadByEntity(viewer, 'calendar-event', 'event-1')).resolves.toBe(1);
    await expect(repository.markReadByEntity(viewer, 'calendar-event', 'event-1')).resolves.toBe(1);

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]![1]).toEqual(['organization-1', 'recipient-1', 'calendar-event', 'event-1']);
    expect(query.mock.calls[1]![1]).toEqual(['organization-1', 'recipient-1', 'calendar-event', 'event-1']);
  });

  it('reports zero entity matches as success', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ marked_count: '0' }] });
    const repository = new PostgresNotificationRepository({ query } as never);

    await expect(repository.markReadByEntity({
      organizationId: 'organization-1',
      userId: 'recipient-1',
    }, 'conversation', 'conversation-9')).resolves.toBe(0);

    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toContain('entity_type = $3');
    expect(values).toEqual(['organization-1', 'recipient-1', 'conversation', 'conversation-9']);
  });
});

describe('Postgres notification transaction', () => {
  it('appends recipient drafts against one persisted realtime event idempotently', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const transaction = new PostgresNotificationTransaction({ query } as never);

    await expect(transaction.append({
      organizationId: 'organization-1',
      sourceRealtimeEventId: 42n,
      createdAt: new Date('2026-07-21T09:30:00.000Z'),
      drafts: [{
        recipientUserId: 'recipient-1',
        kind: 'job.approved',
        entityType: 'job-card',
        entityId: 'job-1',
      }],
    })).resolves.toEqual([]);

    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toContain('INSERT INTO in_app_notifications');
    expect(sql).toContain('ON CONFLICT (recipient_user_id, source_realtime_event_id) DO NOTHING');
    expect(values).toEqual([
      'organization-1',
      'recipient-1',
      '42',
      'job.approved',
      'job-card',
      'job-1',
      new Date('2026-07-21T09:30:00.000Z'),
    ]);
  });
});
