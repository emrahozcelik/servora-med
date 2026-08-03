import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/modules/auth/crypto.js';
import type { AuthRepository } from '../src/modules/auth/repository.js';
import type { AuthUserRecord, SessionRecord } from '../src/modules/auth/types.js';
import type { NotificationRepository } from '../src/modules/notifications/repository.js';
import type { NotificationCursor, NotificationRecord } from '../src/modules/notifications/types.js';

const config = {
  nodeEnv: 'test' as const, host: '127.0.0.1', port: 3000,
  databaseUrl: 'postgresql://unused', logLevel: 'silent',
  corsOrigin: 'https://app.example.com', sessionTtlSeconds: 28_800,
  loginRateLimitMax: 100, rateLimitWindowMs: 60_000,
  trustedProxy: 'loopback' as const, healthSchemaVersion: null,
};

class MemoryAuthRepository implements AuthRepository {
  sessions: SessionRecord[] = [];

  constructor(readonly user: AuthUserRecord) {}

  async findUserByEmail(email: string) { return this.user.email === email ? this.user : null; }
  async findUserById(id: string) { return this.user.id === id ? this.user : null; }
  async createSession(input: Omit<SessionRecord, 'id' | 'revokedAt'>) {
    const session = { ...input, id: `session-${this.sessions.length + 1}`, revokedAt: null };
    this.sessions.push(session);
    return session;
  }
  async findSessionWithUser(hash: string) {
    const session = this.sessions.find((item) => item.tokenHash === hash);
    return session ? { session, user: this.user } : null;
  }
  async revokeSession(hash: string, at: Date) {
    const session = this.sessions.find((item) => item.tokenHash === hash);
    if (session) session.revokedAt = at;
  }
  async updatePasswordAndRevokeSessions() { return false; }
}

class MemoryNotificationRepository implements NotificationRepository {
  viewer: { organizationId: string; userId: string } | null = null;
  listQuery: { limit: number; cursor: NotificationCursor | null } | null = null;
  marked: string[] = [];
  records: NotificationRecord[] = [
    notification({ id: '11111111-1111-4111-8111-111111111111' }),
    notification({
      id: '22222222-2222-4222-8222-222222222222',
      kind: 'job.approved',
      createdAt: new Date('2026-07-21T09:00:00.000Z'),
      readAt: new Date('2026-07-21T10:00:00.000Z'),
    }),
  ];
  nextCursor: NotificationCursor | null = null;

  async unreadCount(viewer: { organizationId: string; userId: string }) {
    this.viewer = viewer;
    return 3;
  }
  async list(
    viewer: { organizationId: string; userId: string },
    query: { limit: number; cursor: NotificationCursor | null },
  ) {
    this.viewer = viewer;
    this.listQuery = query;
    return { items: this.records.slice(0, query.limit), nextCursor: this.nextCursor };
  }
  async markRead(viewer: { organizationId: string; userId: string }, notificationId: string) {
    this.viewer = viewer;
    this.marked.push(notificationId);
    const record = this.records.find((item) => item.id === notificationId);
    if (!record || record.organizationId !== viewer.organizationId
      || record.recipientUserId !== viewer.userId) return null;
    if (record.readAt) return record;
    const read = { ...record, readAt: new Date('2026-07-21T11:00:00.000Z') };
    this.records = this.records.map((item) => item.id === notificationId ? read : item);
    return read;
  }
}

function notification(overrides: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111', organizationId: 'org-1',
    recipientUserId: 'staff-1', sourceRealtimeEventId: 1n, kind: 'job.assigned',
    entityType: 'job-card', entityId: '33333333-3333-4333-8333-333333333333',
    createdAt: new Date('2026-07-21T10:00:00.000Z'), readAt: null, ...overrides,
  };
}

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

async function createApp({
  mustChangePassword = false,
  userId = 'staff-1',
  organizationId = 'org-1',
}: Readonly<{ mustChangePassword?: boolean; userId?: string; organizationId?: string }> = {}) {
  const authRepository = new MemoryAuthRepository({
    id: userId, organizationId, name: 'Staff', email: `${userId}@example.com`,
    passwordHash: await hashPassword('correct-password'), role: 'STAFF',
    mustChangePassword, isActive: true, version: 1,
  });
  const notificationRepository = new MemoryNotificationRepository();
  const app = await buildApp(config, { authRepository, notificationRepository });
  apps.push(app);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login',
    payload: { email: authRepository.user.email, password: 'correct-password' } });
  return { app, notificationRepository, cookie: login.headers['set-cookie'] as string };
}

afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe('Notification HTTP routes', () => {
  it('requires authentication and a completed forced-password change', async () => {
    const { app } = await createApp();
    expect((await app.inject({ method: 'GET', url: '/api/notifications/unread-count' })).statusCode).toBe(401);

    const forced = await createApp({ mustChangePassword: true });
    const response = await forced.app.inject({
      method: 'GET', url: '/api/notifications/unread-count', headers: { cookie: forced.cookie },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'PASSWORD_CHANGE_REQUIRED' });
  });

  it('returns the authenticated recipient unread count', async () => {
    const { app, cookie, notificationRepository } = await createApp();

    const response = await app.inject({
      method: 'GET', url: '/api/notifications/unread-count', headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ unreadCount: 3 });
    expect(notificationRepository.viewer).toEqual({ organizationId: 'org-1', userId: 'staff-1' });
  });

  it('lists public Turkish notifications with a validated opaque cursor', async () => {
    const { app, cookie, notificationRepository } = await createApp();
    const cursor = Buffer.from(JSON.stringify({
      createdAt: '2026-07-21T12:00:00.000Z', id: '44444444-4444-4444-8444-444444444444',
    })).toString('base64url');

    const response = await app.inject({
      method: 'GET', url: `/api/notifications?limit=2&cursor=${cursor}`, headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [
        {
          id: '11111111-1111-4111-8111-111111111111', kind: 'job.assigned',
          title: 'Yeni iş atandı', body: 'Size yeni bir iş atandı.',
          entity: { type: 'job-card', id: '33333333-3333-4333-8333-333333333333' },
          createdAt: '2026-07-21T10:00:00.000Z', readAt: null,
        },
        {
          id: '22222222-2222-4222-8222-222222222222', kind: 'job.approved',
          title: 'İş onaylandı', body: 'İşiniz onaylandı.',
          entity: { type: 'job-card', id: '33333333-3333-4333-8333-333333333333' },
          createdAt: '2026-07-21T09:00:00.000Z', readAt: '2026-07-21T10:00:00.000Z',
        },
      ],
      nextCursor: null,
    });
    expect(notificationRepository.listQuery).toEqual({
      limit: 2,
      cursor: {
        createdAt: new Date('2026-07-21T12:00:00.000Z'),
        id: '44444444-4444-4444-8444-444444444444',
      },
    });
  });

  it('returns an opaque next cursor without exposing stored recipient data', async () => {
    const { app, cookie, notificationRepository } = await createApp();
    notificationRepository.nextCursor = {
      createdAt: new Date('2026-07-21T09:00:00.000Z'),
      id: '22222222-2222-4222-8222-222222222222',
    };

    const response = await app.inject({
      method: 'GET', url: '/api/notifications?limit=1', headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      items: [expect.not.objectContaining({ organizationId: expect.anything(), recipientUserId: expect.anything(), sourceRealtimeEventId: expect.anything() })],
      nextCursor: expect.any(String),
    });
    expect(JSON.parse(Buffer.from(response.json().nextCursor, 'base64url').toString('utf8'))).toEqual({
      createdAt: '2026-07-21T09:00:00.000Z', id: '22222222-2222-4222-8222-222222222222',
    });
  });

  it.each([
    '/api/notifications?limit=0', '/api/notifications?limit=51',
    '/api/notifications?limit=two', '/api/notifications?cursor=not-a-cursor',
    '/api/notifications?unknown=value', '/api/notifications?limit=1&limit=2',
  ])('rejects invalid list query values: %s', async (url) => {
    const { app, cookie } = await createApp();
    const response = await app.inject({ method: 'GET', url, headers: { cookie } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('marks a notification read idempotently and returns 404 outside the recipient scope', async () => {
    const { app, cookie, notificationRepository } = await createApp();
    const notificationId = '11111111-1111-4111-8111-111111111111';

    const first = await app.inject({
      method: 'PATCH', url: `/api/notifications/${notificationId}/read`, headers: { cookie },
    });
    const second = await app.inject({
      method: 'PATCH', url: `/api/notifications/${notificationId}/read`, headers: { cookie },
    });
    const missing = await app.inject({
      method: 'PATCH', url: '/api/notifications/55555555-5555-4555-8555-555555555555/read',
      headers: { cookie },
    });
    const anotherRecipient = await createApp({ userId: 'manager-1' });
    const recipientDenied = await anotherRecipient.app.inject({
      method: 'PATCH', url: `/api/notifications/${notificationId}/read`,
      headers: { cookie: anotherRecipient.cookie },
    });
    const anotherOrganization = await createApp({ userId: 'staff-2', organizationId: 'org-2' });
    const organizationDenied = await anotherOrganization.app.inject({
      method: 'PATCH', url: `/api/notifications/${notificationId}/read`,
      headers: { cookie: anotherOrganization.cookie },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json().readAt).toBe(second.json().readAt);
    expect(notificationRepository.marked).toEqual([notificationId, notificationId, '55555555-5555-4555-8555-555555555555']);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'NOTIFICATION_NOT_FOUND' });
    expect(recipientDenied.statusCode).toBe(404);
    expect(organizationDenied.statusCode).toBe(404);
  });
});
