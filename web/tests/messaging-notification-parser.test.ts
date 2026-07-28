import { describe, expect, it } from 'vitest';
import { NOTIFICATION_KINDS, parseNotificationPage } from '../src/services/notifications-api';

describe('Messaging notification parser', () => {
  it('accepts message.received kind', () => {
    expect(NOTIFICATION_KINDS).toContain('message.received');
  });

  it('parses notification with message.received and conversation entity', () => {
    const raw = {
      items: [{
        id: 'notif-1', kind: 'message.received',
        title: 'Yeni operasyon mesajı', body: 'Yeni bir operasyon mesajı aldınız.',
        entity: { type: 'conversation', id: 'conv-1' },
        createdAt: '2026-07-28T12:00:00.000Z', readAt: null,
      }],
      nextCursor: null,
    };
    const page = parseNotificationPage(raw);
    expect(page.items[0].kind).toBe('message.received');
    expect(page.items[0].entity.type).toBe('conversation');
  });

  it('parses read notification correctly', () => {
    const raw = {
      items: [{
        id: 'notif-2', kind: 'message.received',
        title: 'Yeni operasyon mesajı', body: 'Yeni bir operasyon mesajı aldınız.',
        entity: { type: 'conversation', id: 'conv-2' },
        createdAt: '2026-07-28T12:00:00.000Z', readAt: '2026-07-28T13:00:00.000Z',
      }],
      nextCursor: null,
    };
    const page = parseNotificationPage(raw);
    expect(page.items[0].readAt).toBe('2026-07-28T13:00:00.000Z');
  });
});
