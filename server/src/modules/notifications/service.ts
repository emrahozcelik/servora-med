import { AppError } from '../../errors/index.js';
import type { NotificationListQuery, NotificationRepository } from './repository.js';
import { presentNotification } from './presenter.js';
import type { NotificationViewer } from './types.js';

export class NotificationService {
  constructor(private readonly repository: NotificationRepository) {}

  async unreadCount(viewer: NotificationViewer) {
    return { unreadCount: await this.repository.unreadCount(viewer) };
  }

  async list(viewer: NotificationViewer, query: NotificationListQuery) {
    const page = await this.repository.list(viewer, query);
    return {
      items: page.items.map(presentNotification),
      nextCursor: page.nextCursor,
    };
  }

  async markRead(viewer: NotificationViewer, notificationId: string) {
    const notification = await this.repository.markRead(viewer, notificationId);
    if (!notification) {
      throw new AppError('NOTIFICATION_NOT_FOUND', 404, 'Bildirim bulunamadı.');
    }
    return presentNotification(notification);
  }
}
