import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  buildPushPayload,
  buildPushTopic,
  InvalidPushPayloadError,
  type PushPayloadV1,
} from '../src/modules/web-push/payload.js';
import { presentNotification } from '../src/modules/notifications/presenter.js';
import type { NotificationRecord } from '../src/modules/notifications/types.js';

function makeRecord(overrides?: Partial<NotificationRecord>): NotificationRecord {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    organizationId: 'org-1',
    recipientUserId: 'user-1',
    sourceRealtimeEventId: BigInt(1),
    kind: 'job.assigned',
    entityType: 'job-card',
    entityId: '00000000-0000-4000-8000-000000000002',
    createdAt: new Date('2026-07-22T10:00:00.000Z'),
    readAt: null,
    ...overrides,
  };
}

describe('buildPushPayload', () => {
  it('produces exact five fields from a canonical notification record', () => {
    const record = makeRecord();
    const publicNotification = presentNotification(record);
    const payload = buildPushPayload(publicNotification);

    expect(Object.keys(payload).sort()).toEqual([
      'body', 'notificationId', 'title', 'url', 'version',
    ]);
    expect(payload.version).toBe(1);
    expect(payload.notificationId).toBe(record.id);
    expect(payload.title).toBe('Yeni iş atandı');
    expect(payload.body).toBe('Size yeni bir iş atandı.');
    expect(payload.url).toBe(`/jobs/${record.entityId}`);
  });

  it.each([
    'job.reassigned',
    'job.awaiting_approval',
    'job.approved',
    'job.revision_requested',
    'job.cancelled',
  ] as const)('maps notification kind %s through canonical presenter', (kind) => {
    const record = makeRecord({ kind });
    const publicNotification = presentNotification(record);
    const payload = buildPushPayload(publicNotification);

    expect(payload.title).toBeTruthy();
    expect(payload.body).toBeTruthy();
    expect(payload.title.length).toBeGreaterThan(0);
    expect(payload.body.length).toBeGreaterThan(0);
  });

  it('url is always /jobs/<entity UUID>', () => {
    const entityId = randomUUID();
    const record = makeRecord({ entityId });
    const publicNotification = presentNotification(record);

    const payload = buildPushPayload(publicNotification);
    expect(payload.url).toBe(`/jobs/${entityId}`);
  });

  it('topic is notificationId without hyphens', () => {
    const id = '11111111-2222-3333-4444-555555555555';
    const record = makeRecord({ id });
    const topic = buildPushTopic(record.id);

    expect(topic).toBe('11111111222233334444555555555555');
    expect(topic).toHaveLength(32);
  });

  it('topic uses the notification id not entity id', () => {
    const id = randomUUID();
    const entityId = randomUUID();
    const record = makeRecord({ id, entityId });

    const topic = buildPushTopic(record.id);
    expect(topic).toBe(id.replaceAll('-', ''));
    expect(topic).not.toBe(entityId.replaceAll('-', ''));
  });

  it('rejects non-job-card entity type', () => {
    const publicNotification = {
      ...presentNotification(makeRecord()),
      entity: { type: 'sales-meeting' as const, id: randomUUID() },
    };

    expect(() => buildPushPayload(publicNotification)).toThrow(InvalidPushPayloadError);
  });

  it('rejects invalid entity id (not a UUID)', () => {
    const publicNotification = {
      ...presentNotification(makeRecord()),
      entity: { type: 'job-card' as const, id: 'not-a-uuid' },
    };

    expect(() => buildPushPayload(publicNotification)).toThrow(InvalidPushPayloadError);
  });

  it('rejects empty entity id', () => {
    const publicNotification = {
      ...presentNotification(makeRecord()),
      entity: { type: 'job-card' as const, id: '' },
    };

    expect(() => buildPushPayload(publicNotification)).toThrow(InvalidPushPayloadError);
  });

  it('does not serialize sensitive business fields', () => {
    const record = makeRecord({
      organizationId: 'secret-org',
      recipientUserId: 'secret-user',
    });
    const publicNotification = presentNotification(record);
    const payload = buildPushPayload(publicNotification);

    const json = JSON.stringify(payload);
    expect(json).not.toContain('secret-org');
    expect(json).not.toContain('secret-user');
    expect(json).not.toContain('organizationId');
    expect(json).not.toContain('recipientUserId');
  });

  it('does not include the full notification record in JSON', () => {
    const record = makeRecord();
    const publicNotification = presentNotification(record);
    const payload = buildPushPayload(publicNotification);

    const json = JSON.stringify(payload);
    expect(json).not.toContain('entity');
    expect(json).not.toContain('kind');
    expect(json).not.toContain('createdAt');
    expect(json).not.toContain('readAt');
  });
});
