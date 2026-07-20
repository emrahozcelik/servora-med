import type { Pool } from 'pg';

import type {
  NotificationCursor,
  NotificationKind,
  NotificationPage,
  NotificationRecord,
  NotificationViewer,
} from './types.js';

type NotificationRow = {
  id: string;
  organization_id: string;
  recipient_user_id: string;
  source_realtime_event_id: string;
  kind: NotificationKind;
  entity_type: 'job-card';
  entity_id: string;
  created_at: Date;
  read_at: Date | null;
};

type NotificationListQuery = Readonly<{
  limit: number;
  cursor: NotificationCursor | null;
}>;

function mapNotification(row: NotificationRow): NotificationRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    recipientUserId: row.recipient_user_id,
    sourceRealtimeEventId: BigInt(row.source_realtime_event_id),
    kind: row.kind,
    entityType: row.entity_type,
    entityId: row.entity_id,
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}

export class PostgresNotificationRepository {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async unreadCount(viewer: NotificationViewer): Promise<number> {
    const result = await this.pool.query<{ unread_count: number }>(
      `SELECT COUNT(*)::int AS unread_count
         FROM in_app_notifications
        WHERE organization_id = $1
          AND recipient_user_id = $2
          AND read_at IS NULL`,
      [viewer.organizationId, viewer.userId],
    );
    return result.rows[0]?.unread_count ?? 0;
  }

  async list(
    viewer: NotificationViewer,
    query: NotificationListQuery,
  ): Promise<NotificationPage> {
    const cursorClause = query.cursor
      ? 'AND (created_at, id) < ($3, $4)'
      : '';
    const values = query.cursor
      ? [
        viewer.organizationId,
        viewer.userId,
        query.cursor.createdAt,
        query.cursor.id,
        query.limit + 1,
      ]
      : [viewer.organizationId, viewer.userId, query.limit + 1];
    const limitParameter = query.cursor ? '$5' : '$3';
    const result = await this.pool.query<NotificationRow>(
      `SELECT id, organization_id, recipient_user_id, source_realtime_event_id,
              kind, entity_type, entity_id, created_at, read_at
         FROM in_app_notifications
        WHERE organization_id = $1
          AND recipient_user_id = $2
          ${cursorClause}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limitParameter}`,
      values,
    );
    const rows = result.rows.slice(0, query.limit);
    const last = rows.at(-1);
    return {
      items: rows.map(mapNotification),
      nextCursor: result.rows.length > query.limit && last
        ? { createdAt: last.created_at, id: last.id }
        : null,
    };
  }

  async markRead(
    viewer: NotificationViewer,
    notificationId: string,
  ): Promise<NotificationRecord | null> {
    const result = await this.pool.query<NotificationRow>(
      `UPDATE in_app_notifications
          SET read_at = COALESCE(read_at, NOW())
        WHERE organization_id = $1
          AND recipient_user_id = $2
          AND id = $3
      RETURNING id, organization_id, recipient_user_id, source_realtime_event_id,
                kind, entity_type, entity_id, created_at, read_at`,
      [viewer.organizationId, viewer.userId, notificationId],
    );
    const row = result.rows[0];
    return row ? mapNotification(row) : null;
  }
}
