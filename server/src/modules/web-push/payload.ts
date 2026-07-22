import type { PublicNotification } from '../notifications/presenter.js';

export type PushPayloadV1 = Readonly<{
  version: 1;
  notificationId: string;
  title: string;
  body: string;
  url: string;
}>;

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class InvalidPushPayloadError extends Error {
  constructor(reason: string) {
    super(`Invalid push payload: ${reason}`);
    this.name = 'InvalidPushPayloadError';
  }
}

export function buildPushPayload(
  notification: PublicNotification,
): PushPayloadV1 {
  if (notification.entity.type !== 'job-card') {
    throw new InvalidPushPayloadError(
      `unsupported entity type: ${notification.entity.type}`,
    );
  }
  if (!CANONICAL_UUID.test(notification.entity.id)) {
    throw new InvalidPushPayloadError(
      `invalid entity id: ${notification.entity.id}`,
    );
  }

  return {
    version: 1,
    notificationId: notification.id,
    title: notification.title,
    body: notification.body,
    url: `/jobs/${notification.entity.id}`,
  };
}

export function buildPushTopic(notificationId: string): string {
  return notificationId.replaceAll('-', '');
}
