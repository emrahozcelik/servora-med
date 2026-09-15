import { describe, expect, it, vi } from 'vitest';

import { NotificationService } from '../src/modules/notifications/service.js';

const VIEWER = { organizationId: 'org-1', userId: 'viewer-1' };
const NOW = new Date('2026-07-21T12:00:00.000Z');

function stubRepository() {
  return {
    unreadCount: vi.fn(),
    list: vi.fn(),
    markRead: vi.fn(),
    markReadByEntity: vi.fn(),
    dismiss: vi.fn(),
    clearRead: vi.fn(),
    clearAll: vi.fn(),
  };
}

function eventRow() {
  return {
    id: '99',
    organization_id: 'org-1',
    source_activity_id: null,
    event_type: 'notification.state_changed',
    entity_type: 'notification-center',
    entity_id: 'viewer-1',
    actor_user_id: 'viewer-1',
    audience_roles: [],
    audience_user_ids: ['viewer-1'],
    resource_keys: ['notifications'],
    created_at: NOW,
  };
}

function fakePool(onQuery: (sql: string, values: unknown[]) => { rows: unknown[] }) {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const client = {
    query: vi.fn(async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      return onQuery(sql, values);
    }),
    release: vi.fn(),
  };
  return {
    pool: { connect: vi.fn(async () => client) },
    client,
    queries,
  };
}

function serviceWith(
  publisher: { publish: (...args: unknown[]) => void },
  pool: { connect: () => Promise<unknown> },
) {
  return new NotificationService(
    stubRepository() as never,
    publisher as never,
    () => NOW,
    pool as never,
  );
}

describe('notification state invalidation', () => {
  it('markReadByEntity persists a viewer-scoped notifications event and publishes post-commit', async () => {
    const publisher = { publish: vi.fn() };
    const { pool, client, queries } = fakePool((sql) => {
      if (sql.includes('UPDATE in_app_notifications')) return { rows: [{ marked_count: '2' }] };
      if (sql.includes('INSERT INTO realtime_events')) return { rows: [eventRow()] };
      throw new Error(`unexpected query: ${sql}`);
    });

    const result = await serviceWith(publisher, pool).markReadByEntity(VIEWER, 'job-card', 'job-1');

    expect(result).toEqual({ markedCount: 2 });
    const statements = queries.map((query) => query.sql);
    expect(statements[0]).toBe('BEGIN');
    expect(statements.at(-1)).toBe('COMMIT');
    expect(statements).not.toContain('ROLLBACK');
    const updateIndex = statements.findIndex((sql) => sql.includes('UPDATE in_app_notifications'));
    const lockIndex = statements.findIndex((sql) => sql.includes('pg_advisory_xact_lock'));
    const insertIndex = statements.findIndex((sql) => sql.includes('INSERT INTO realtime_events'));
    expect(updateIndex).toBeGreaterThanOrEqual(0);
    expect(lockIndex).toBeGreaterThan(updateIndex);
    expect(insertIndex).toBeGreaterThan(lockIndex);
    expect(client.release).toHaveBeenCalled();

    const append = queries.find((query) => query.sql.includes('INSERT INTO realtime_events'))!;
    expect(append.values).toContain('notification.state_changed');
    expect(append.values).toContain('notification-center');
    expect(append.values).toContain('viewer-1');
    expect(append.values).toContainEqual(['notifications']);
    expect(append.values).toContainEqual([]);

    expect(publisher.publish).toHaveBeenCalledTimes(1);
    expect(publisher.publish).toHaveBeenCalledWith(expect.objectContaining({
      type: 'notification.state_changed',
      resourceKeys: ['notifications'],
      audience: { roles: [], userIds: ['viewer-1'] },
    }));

    // No notification projection: the invalidation path never writes notifications.
    expect(queries.some((query) => query.sql.includes('INSERT INTO in_app_notifications'))).toBe(false);
  });

  it('markReadByEntity with zero matches emits no event', async () => {
    const publisher = { publish: vi.fn() };
    const { pool, queries } = fakePool((sql) => {
      if (sql.includes('UPDATE in_app_notifications')) return { rows: [{ marked_count: '0' }] };
      throw new Error(`unexpected query: ${sql}`);
    });

    await expect(serviceWith(publisher, pool).markReadByEntity(
      VIEWER, 'conversation', 'conv-9',
    )).resolves.toEqual({ markedCount: 0 });

    expect(queries.some((query) => query.sql.includes('INSERT INTO realtime_events'))).toBe(false);
    expect(publisher.publish).not.toHaveBeenCalled();
    expect(queries.map((query) => query.sql)).toContain('COMMIT');
  });

  it('markRead persists a viewer-scoped event for a matched notification', async () => {
    const publisher = { publish: vi.fn() };
    const { pool, queries } = fakePool((sql) => {
      if (sql.includes('UPDATE in_app_notifications')) {
        return {
          rows: [{
            id: 'notification-1', organization_id: 'org-1', recipient_user_id: 'viewer-1',
            source_realtime_event_id: '7', kind: 'job.assigned', entity_type: 'job-card',
            entity_id: 'job-1', created_at: NOW, read_at: NOW,
          }],
        };
      }
      if (sql.includes('INSERT INTO realtime_events')) return { rows: [eventRow()] };
      throw new Error(`unexpected query: ${sql}`);
    });

    const result = await serviceWith(publisher, pool).markRead(VIEWER, 'notification-1');

    expect(result).toMatchObject({ id: 'notification-1' });
    expect(queries.some((query) => query.sql.includes('INSERT INTO realtime_events'))).toBe(true);
    expect(publisher.publish).toHaveBeenCalledTimes(1);
  });

  it('dismiss and clearRead persist viewer-scoped events; empty clearRead emits nothing', async () => {
    const publisher = { publish: vi.fn() };
    const { pool, queries } = fakePool((sql) => {
      if (sql.includes('UPDATE in_app_notifications')) {
        return sql.includes('dismissed_at = COALESCE(dismissed_at, NOW())') && sql.includes('id = $3')
          ? { rows: [{ id: 'notification-1' }] }
          : { rows: [{ id: 'notification-1' }, { id: 'notification-2' }] };
      }
      if (sql.includes('INSERT INTO realtime_events')) return { rows: [eventRow()] };
      throw new Error(`unexpected query: ${sql}`);
    });
    const service = serviceWith(publisher, pool);

    await service.dismiss(VIEWER, 'notification-1');
    await service.clearRead(VIEWER);

    expect(queries.filter((query) => query.sql.includes('INSERT INTO realtime_events'))).toHaveLength(2);
    expect(publisher.publish).toHaveBeenCalledTimes(2);
  });

  it('rolls back the state mutation when realtime append fails and publishes nothing', async () => {    const publisher = { publish: vi.fn() };
    const { pool, client, queries } = fakePool((sql) => {
      if (sql.includes('UPDATE in_app_notifications')) return { rows: [{ marked_count: '1' }] };
      if (sql.includes('INSERT INTO realtime_events')) throw new Error('append failed');
      throw new Error(`unexpected query: ${sql}`);
    });

    await expect(serviceWith(publisher, pool).markReadByEntity(
      VIEWER, 'job-card', 'job-1',
    )).rejects.toThrow('append failed');

    expect(queries.map((query) => query.sql).at(-1)).toBe('ROLLBACK');
    expect(queries.map((query) => query.sql)).not.toContain('COMMIT');
    expect(publisher.publish).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalled();
  });

  it('clearAll with affected rows emits one viewer-scoped invalidation', async () => {
    const publisher = { publish: vi.fn() };
    const { pool, queries } = fakePool((sql) => {
      if (sql.includes('UPDATE in_app_notifications')) return { rows: [{ cleared_count: '2' }] };
      if (sql.includes('INSERT INTO realtime_events')) return { rows: [eventRow()] };
      throw new Error(`unexpected query: ${sql}`);
    });

    await serviceWith(publisher, pool).clearAll(VIEWER);

    const appends = queries.filter((query) => query.sql.includes('INSERT INTO realtime_events'));
    expect(appends).toHaveLength(1);
    expect(appends[0]!.values).toContain('notification.state_changed');
    expect(appends[0]!.values).toContain('notification-center');
    expect(appends[0]!.values).toContain('viewer-1');
    expect(publisher.publish).toHaveBeenCalledTimes(1);
    expect(publisher.publish).toHaveBeenCalledWith(expect.objectContaining({
      type: 'notification.state_changed',
      resourceKeys: ['notifications'],
      audience: { roles: [], userIds: ['viewer-1'] },
    }));
  });

  it('clearAll with zero matches emits no event', async () => {
    const publisher = { publish: vi.fn() };
    const { pool, queries } = fakePool((sql) => {
      if (sql.includes('UPDATE in_app_notifications')) return { rows: [{ cleared_count: '0' }] };
      throw new Error(`unexpected query: ${sql}`);
    });

    await serviceWith(publisher, pool).clearAll(VIEWER);

    expect(queries.some((query) => query.sql.includes('INSERT INTO realtime_events'))).toBe(false);
    expect(publisher.publish).not.toHaveBeenCalled();
    expect(queries.map((query) => query.sql)).toContain('COMMIT');
  });
});
