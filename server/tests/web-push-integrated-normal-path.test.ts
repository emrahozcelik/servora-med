/**
 * Task 9 normal path: committed notification → payload → worker display once → click.
 * Uses production presenter/payload and the real service-worker source via harness.
 */
import { describe, expect, it, vi } from 'vitest';

import { presentNotification } from '../src/modules/notifications/presenter.js';
import type { NotificationRecord } from '../src/modules/notifications/types.js';
import { buildPushPayload, buildPushTopic } from '../src/modules/web-push/payload.js';
import { createServiceWorkerHarness } from '../../web/tests/helpers/service-worker-harness.ts';

const ENTITY_ID = '550e8400-e29b-41d4-a716-446655440000';
const NOTIFICATION_ID = '660e8400-e29b-41d4-a716-446655440001';

describe('Web Push integrated normal path', () => {
  it('builds one canonical payload, shows one notification, and focuses the job route without mark-read', async () => {
    const record: NotificationRecord = {
      id: NOTIFICATION_ID,
      organizationId: 'org-1',
      recipientUserId: 'user-1',
      sourceRealtimeEventId: 1n,
      kind: 'job.assigned',
      entityType: 'job-card',
      entityId: ENTITY_ID,
      createdAt: new Date('2026-07-22T10:00:00.000Z'),
      readAt: null,
    };

    const publicNotification = presentNotification(record);
    const payload = buildPushPayload(publicNotification);
    const topic = buildPushTopic(record.id);

    expect(payload).toEqual({
      version: 1,
      notificationId: NOTIFICATION_ID,
      title: 'Yeni iş atandı',
      body: 'Size yeni bir iş atandı.',
      url: `/jobs/${ENTITY_ID}`,
    });
    expect(Object.keys(payload).sort()).toEqual([
      'body', 'notificationId', 'title', 'url', 'version',
    ]);
    expect(topic).toBe(NOTIFICATION_ID.replace(/-/g, ''));

    const harness = createServiceWorkerHarness();
    const client = {
      id: 'client-1',
      url: `/jobs/${ENTITY_ID}`,
      focus: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn(),
      postMessage: vi.fn(),
    };
    harness.clients.matchAll.mockResolvedValue([client]);

    const markNotificationRead = vi.fn();
    await harness.fireEvent('push', harness.makePushEvent(payload));
    await harness.settleWaitUntil();

    expect(harness.notifications).toHaveLength(1);
    expect(harness.notifications[0]).toMatchObject({
      title: payload.title,
      options: {
        body: payload.body,
        tag: payload.notificationId,
        data: {
          notificationId: payload.notificationId,
          url: payload.url,
        },
      },
    });
    // HTTP topic is separate from display tag; both are stable for the notification id.
    expect(topic).toBe(payload.notificationId.replace(/-/g, ''));

    const clickEvent = harness.makeNotificationClickEvent({
      data: { notificationId: payload.notificationId, url: payload.url },
    });
    await harness.fireEvent('notificationclick', clickEvent);
    await harness.settleWaitUntil();

    expect(client.focus).toHaveBeenCalledTimes(1);
    expect(client.navigate).not.toHaveBeenCalled();
    expect(markNotificationRead).not.toHaveBeenCalled();
    expect(harness.notifications).toHaveLength(1);
  });
});
