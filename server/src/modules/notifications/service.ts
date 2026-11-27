import type { Pool } from 'pg';

import { AppError } from '../../errors/index.js';
import {
  NOOP_REALTIME_EVENT_PUBLISHER,
  type RealtimeEventPublisher,
} from '../realtime/event-bus.js';
import { PostgresRealtimeEventTransaction } from '../realtime/repository.js';
import type { RealtimeEventRecord } from '../realtime/types.js';
import type {
  NotificationListQuery,
  NotificationRepository,
} from './repository.js';
import { PostgresNotificationRepository } from './repository.js';
import { presentNotification } from './presenter.js';
import type { NotificationEntityType, NotificationViewer } from './types.js';

function notificationStateInvalidation(
  viewer: NotificationViewer,
  occurredAt: Date,
) {
  return {
    organizationId: viewer.organizationId,
    type: 'notification.state_changed' as const,
    entityType: 'notification-center' as const,
    entityId: viewer.userId,
    actorUserId: viewer.userId,
    audience: { roles: [], userIds: [viewer.userId] },
    resourceKeys: ['notifications'],
    occurredAt,
  };
}

export class NotificationService {
  constructor(
    private readonly repository: NotificationRepository,
    private readonly realtimePublisher: RealtimeEventPublisher = NOOP_REALTIME_EVENT_PUBLISHER,
    private readonly now: () => Date = () => new Date(),
    private readonly pool?: Pick<Pool, 'connect'>,
    private readonly hiddenEntityTypes: () => Promise<readonly NotificationEntityType[]> = async () => [],
  ) {}

  private publishRealtime(events: readonly RealtimeEventRecord[]) {
    for (const event of events) {
      this.realtimePublisher.publish(event);
    }
  }

  /**
   * Mutation + viewer-scoped invalidation share one transaction: the realtime
   * row commits (or rolls back) atomically with the notification state, and the
   * in-memory bus is notified only after commit. Without a pool (test
   * composition with a standalone repository) the state change runs directly
   * and no invalidation is emitted.
   */
  private async mutateWithInvalidation<T>(
    viewer: NotificationViewer,
    run: (repository: NotificationRepository) => Promise<{ result: T; changed: boolean }>,
  ): Promise<T> {
    if (!this.pool) {
      return (await run(this.repository)).result;
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const transaction = new PostgresNotificationRepository(client);
      const { result, changed } = await run(transaction);
      let event: RealtimeEventRecord | null = null;
      if (changed) {
        event = await new PostgresRealtimeEventTransaction(client).append(
          notificationStateInvalidation(viewer, this.now()),
        );
      }
      await client.query('COMMIT');
      if (event) this.publishRealtime([event]);
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original failure; a failed rollback adds no information.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async unreadCount(viewer: NotificationViewer) {
    const excluded = await this.hiddenEntityTypes();
    return { unreadCount: await this.repository.unreadCount(viewer, excluded) };
  }

  async list(viewer: NotificationViewer, query: NotificationListQuery) {
    const excluded = await this.hiddenEntityTypes();
    const page = await this.repository.list(viewer, query, excluded);
    return {
      items: page.items.map(presentNotification),
      nextCursor: page.nextCursor,
    };
  }

  async markRead(viewer: NotificationViewer, notificationId: string) {
    const excluded = await this.hiddenEntityTypes();
    // A replayed read still emits one user-scoped invalidation: the repository
    // result cannot distinguish replay from change, and the extra invalidation
    // is harmless (receivers refresh canonical state).
    const notification = await this.mutateWithInvalidation(viewer, async (repository) => {
      const record = await repository.markRead(viewer, notificationId, excluded);
      return { result: record, changed: record !== null };
    });
    if (!notification) {
      throw new AppError('NOTIFICATION_NOT_FOUND', 404, 'Bildirim bulunamadı.');
    }
    return presentNotification(notification);
  }

  async markReadByEntity(
    viewer: NotificationViewer,
    entityType: NotificationEntityType,
    entityId: string,
  ) {
    const excluded = await this.hiddenEntityTypes();
    if (excluded.includes(entityType)) {
      throw new AppError('NOTIFICATION_NOT_FOUND', 404, 'Bildirim bulunamadı.');
    }
    return this.mutateWithInvalidation(viewer, async (repository) => {
      const markedCount = await repository.markReadByEntity(viewer, entityType, entityId);
      return { result: { markedCount }, changed: markedCount > 0 };
    });
  }

  async dismiss(viewer: NotificationViewer, notificationId: string) {
    const excluded = await this.hiddenEntityTypes();
    // Same replay policy as markRead: success emits, absence stays 404.
    const dismissed = await this.mutateWithInvalidation(viewer, async (repository) => {
      const result = await repository.dismiss(viewer, notificationId, excluded);
      return { result, changed: result };
    });
    if (!dismissed) {
      throw new AppError('NOTIFICATION_NOT_FOUND', 404, 'Bildirim bulunamadı.');
    }
  }

  async clearRead(viewer: NotificationViewer) {
    const excluded = await this.hiddenEntityTypes();
    await this.mutateWithInvalidation(viewer, async (repository) => {
      const clearedCount = await repository.clearRead(viewer, excluded);
      return { result: undefined, changed: clearedCount > 0 };
    });
  }

  async clearAll(viewer: NotificationViewer) {
    const excluded = await this.hiddenEntityTypes();
    await this.mutateWithInvalidation(viewer, async (repository) => {
      const clearedCount = await repository.clearAll(viewer, excluded);
      return { result: undefined, changed: clearedCount > 0 };
    });
  }
}
