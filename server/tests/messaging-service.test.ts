import { randomUUID } from 'node:crypto';
import Fastify, { type preHandlerHookHandler } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

import { AppError, toErrorResponse } from '../src/errors/index.js';
import type { SafeUser } from '../src/modules/auth/types.js';
import { assertModuleEnabled, moduleGate } from '../src/modules/installation-modules/gate.js';
import { staticModuleStateReader, type ModuleStateReader } from '../src/modules/installation-modules/state.js';
import { messagingRoutes } from '../src/modules/messaging/routes.js';
import { MessagingService } from '../src/modules/messaging/service.js';

function staffActor(organizationId: string): SafeUser {
  return {
    id: randomUUID(),
    organizationId,
    name: 'Staff User',
    email: 'staff@test.test',
    role: 'STAFF',
    mustChangePassword: false,
    isActive: true,
    version: 1,
  };
}

function managerActor(organizationId: string): SafeUser {
  return {
    id: randomUUID(),
    organizationId,
    name: 'Manager User',
    email: 'manager@test.test',
    role: 'MANAGER',
    mustChangePassword: false,
    isActive: true,
    version: 1,
  };
}

function adminActor(organizationId: string): SafeUser {
  return {
    id: randomUUID(),
    organizationId,
    name: 'Admin User',
    email: 'admin@test.test',
    role: 'ADMIN',
    mustChangePassword: false,
    isActive: true,
    version: 1,
  };
}

function createMockPool(): Pick<Pool, 'query'> {
  return {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  };
}

function createPoolWithConnect(): Pool {
  const mockClient = {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: vi.fn(),
  };
  return {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    connect: vi.fn().mockResolvedValue(mockClient),
  } as unknown as Pool;
}

describe('MessagingService', () => {
  describe('runtime module gate (assertModuleEnabled / moduleGate)', () => {
    it('assertModuleEnabled passes when enabled, throws 404 when disabled, and throws 503 + logs when missing or unreadable', async () => {
      const logger = { error: vi.fn() };
      await expect(
        assertModuleEnabled(staticModuleStateReader({ MESSAGING: true }), 'MESSAGING', logger),
      ).resolves.toBeUndefined();
      expect(logger.error).not.toHaveBeenCalled();

      await expect(
        assertModuleEnabled(staticModuleStateReader({ MESSAGING: false }), 'MESSAGING', logger),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });

      await expect(
        assertModuleEnabled(staticModuleStateReader({}), 'MESSAGING', logger),
      ).rejects.toMatchObject({ code: 'MODULE_STATE_UNAVAILABLE', statusCode: 503 });

      const failingReader: ModuleStateReader = {
        read: async () => { throw new Error('db unavailable'); },
      };
      await expect(
        assertModuleEnabled(failingReader, 'MESSAGING', logger),
      ).rejects.toMatchObject({ code: 'MODULE_STATE_UNAVAILABLE', statusCode: 503 });
      expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it('messagingRoutes enforces authenticate before moduleGate (401 -> 404/503 -> 200)', async () => {
      const pool = createMockPool();
      (pool.query as any).mockResolvedValue({ rows: [{ unread_count: '0' }], rowCount: 1 });
      const service = new MessagingService(pool);
      const actor = staffActor(randomUUID());

      const buildTestApp = async (reader: ModuleStateReader, authenticated: boolean) => {
        const app = Fastify({ logger: false });
        app.setErrorHandler((error, _request, reply) => {
          const response = toErrorResponse(error);
          reply.code(response.statusCode).send(response.body);
        });
        const authenticate: preHandlerHookHandler = async (request) => {
          if (!authenticated) throw new AppError('UNAUTHENTICATED', 401, 'Oturum açmanız gerekiyor.');
          request.currentUser = actor;
        };
        await app.register(messagingRoutes, {
          prefix: '/api/messaging',
          service,
          authenticate,
          gate: moduleGate(reader, 'MESSAGING'),
        });
        return app;
      };

      const unauthenticatedDisabled = await buildTestApp(staticModuleStateReader({ MESSAGING: false }), false);
      expect((await unauthenticatedDisabled.inject({ method: 'GET', url: '/api/messaging/unread-count' })).statusCode).toBe(401);
      await unauthenticatedDisabled.close();

      const disabled = await buildTestApp(staticModuleStateReader({ MESSAGING: false }), true);
      const disabledRes = await disabled.inject({ method: 'GET', url: '/api/messaging/unread-count' });
      expect(disabledRes.statusCode).toBe(404);
      expect(disabledRes.json()).toMatchObject({ code: 'NOT_FOUND' });
      await disabled.close();

      const unreadable = await buildTestApp({
        read: async () => { throw new Error('read failed'); },
      }, true);
      const unreadableRes = await unreadable.inject({ method: 'GET', url: '/api/messaging/unread-count' });
      expect(unreadableRes.statusCode).toBe(503);
      expect(unreadableRes.json()).toMatchObject({ code: 'MODULE_STATE_UNAVAILABLE' });
      await unreadable.close();

      const enabled = await buildTestApp(staticModuleStateReader({ MESSAGING: true }), true);
      const enabledRes = await enabled.inject({ method: 'GET', url: '/api/messaging/unread-count' });
      expect(enabledRes.statusCode).toBe(200);
      expect(enabledRes.json()).toEqual({ unreadCount: 0 });
      await enabled.close();
    });
  });

  describe('body validation', () => {
    it('rejects empty body', async () => {
      const pool = createPoolWithConnect();
      const service = new MessagingService(pool);
      const actor = staffActor(randomUUID());

      await expect(
        service.sendMessage(actor, randomUUID(), '', 'action-1'),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('rejects body over 4000 code points', async () => {
      const pool = createPoolWithConnect();
      const service = new MessagingService(pool);
      const actor = staffActor(randomUUID());

      await expect(
        service.sendMessage(actor, randomUUID(), 'a'.repeat(4001), 'action-1'),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('accepts literal HTML-like plain text', async () => {
      const conversationId = randomUUID();
      const organizationId = randomUUID();
      const actor = staffActor(organizationId);
      const messageId = randomUUID();

      const client = {
        query: vi.fn(),
        release: vi.fn(),
      };
      const pool = {
        query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        connect: vi.fn().mockResolvedValue(client),
      } as unknown as Pool;

      // poolTransaction: BEGIN
      client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // findConversationById
      client.query.mockResolvedValueOnce({ rows: [{ id: conversationId, organization_id: organizationId, direct_key: 'k', context_type: 'GENERAL', job_id: null, created_at: new Date(), updated_at: new Date() }], rowCount: 1 });
      // findAllParticipants (actor + other user)
      const otherUserId = randomUUID();
      client.query.mockResolvedValueOnce({ rows: [
        { conversation_id: conversationId, user_id: actor.id, organization_id: organizationId, last_read_message_id: null, created_at: new Date() },
        { conversation_id: conversationId, user_id: otherUserId, organization_id: organizationId, last_read_message_id: null, created_at: new Date() },
      ], rowCount: 2 });
      // reauthorizeSend: check other user active/role (ADMIN for STAFF actor)
      // This uses this.pool.query, not client.query — need to set up pool mock
      (pool.query as any).mockImplementationOnce(() =>
        Promise.resolve({ rows: [{ is_active: true, role: 'ADMIN' }], rowCount: 1 }),
      );
      // insertMessage
      client.query.mockResolvedValueOnce({ rows: [{ id: messageId, conversation_id: conversationId, organization_id: organizationId, sender_user_id: actor.id, client_action_id: 'action-html', body: '<b>bold</b>', created_at: new Date() }], rowCount: 1 });
      // clear archive state for authorized recipients
      client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // updateConversationTimestamp
      client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // insertActivity
      client.query.mockResolvedValueOnce({ rows: [{ id: randomUUID(), organization_id: organizationId, conversation_id: conversationId, actor_user_id: actor.id, action: 'MESSAGE_SENT', client_action_id: 'action-html', created_at: new Date() }], rowCount: 1 });
      // appendRealtimeEvent (now returns ID)
      // B3: organization ordering lock is acquired before the realtime INSERT.
      client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      client.query.mockResolvedValueOnce({ rows: [{ id: '123' }], rowCount: 1 });
      // appendNotifications
      client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // COMMIT
      client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const service = new MessagingService(pool);
      const result = await service.sendMessage(actor, conversationId, '<b>bold</b>', 'action-html');

      expect(result.body).toBe('<b>bold</b>');
      expect(result.isDuplicate).toBe(false);
    });

    it('accepts valid plain text', async () => {
      const conversationId = randomUUID();
      const organizationId = randomUUID();
      const actor = staffActor(organizationId);
      const messageId = randomUUID();

      const client = {
        query: vi.fn(),
        release: vi.fn(),
      };
      const pool = {
        query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        connect: vi.fn().mockResolvedValue(client),
      } as unknown as Pool;

      // poolTransaction: BEGIN
      client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // findConversationById
      client.query.mockResolvedValueOnce({ rows: [{ id: conversationId, organization_id: organizationId, direct_key: 'k', context_type: 'GENERAL', job_id: null, created_at: new Date(), updated_at: new Date() }], rowCount: 1 });
      // findAllParticipants (actor + other user)
      const otherUserId2 = randomUUID();
      client.query.mockResolvedValueOnce({ rows: [
        { conversation_id: conversationId, user_id: actor.id, organization_id: organizationId, last_read_message_id: null, created_at: new Date() },
        { conversation_id: conversationId, user_id: otherUserId2, organization_id: organizationId, last_read_message_id: null, created_at: new Date() },
      ], rowCount: 2 });
      // reauthorizeSend: check other user active/role (ADMIN for STAFF actor)
      // This uses this.pool.query, not client.query — need to set up pool mock
      (pool.query as any).mockImplementationOnce(() =>
        Promise.resolve({ rows: [{ is_active: true, role: 'ADMIN' }], rowCount: 1 }),
      );
      // insertMessage
      client.query.mockResolvedValueOnce({ rows: [{ id: messageId, conversation_id: conversationId, organization_id: organizationId, sender_user_id: actor.id, client_action_id: 'action-1', body: 'Hello', created_at: new Date() }], rowCount: 1 });
      // clear archive state for authorized recipients
      client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // updateConversationTimestamp
      client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // insertActivity
      client.query.mockResolvedValueOnce({ rows: [{ id: randomUUID(), organization_id: organizationId, conversation_id: conversationId, actor_user_id: actor.id, action: 'MESSAGE_SENT', client_action_id: 'action-1', created_at: new Date() }], rowCount: 1 });
      // appendRealtimeEvent
      // B3: organization ordering lock is acquired before the realtime INSERT.
      client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      client.query.mockResolvedValueOnce({ rows: [{ id: '1' }], rowCount: 1 });
      // COMMIT
      client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const service = new MessagingService(pool);
      const result = await service.sendMessage(actor, conversationId, 'Hello', 'action-1');

      expect(result.body).toBe('Hello');
      expect(result.isDuplicate).toBe(false);
    });
  });

  describe('recipient authorization', () => {
    it('rejects self-conversation', async () => {
      const pool = createPoolWithConnect();
      const service = new MessagingService(pool);
      const actor = staffActor(randomUUID());

      await expect(
        service.createOrGetConversation(actor, { recipientUserId: actor.id, contextType: 'GENERAL' }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('rejects manager creating conversation with an unknown (non-resolvable) recipient', async () => {
      const organizationId = randomUUID();
      const manager = managerActor(organizationId);
      const staffId = randomUUID();

      const pool = createPoolWithConnect();
      (pool.query as any).mockResolvedValue({ rows: [], rowCount: 0 });
      const service = new MessagingService(pool);

      await expect(
        service.createOrGetConversation(manager, { recipientUserId: staffId, contextType: 'GENERAL' }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('context model validation', () => {
    it('rejects GENERAL with a jobId', async () => {
      const pool = createPoolWithConnect();
      const service = new MessagingService(pool);
      const actor = adminActor(randomUUID());

      await expect(
        service.createOrGetConversation(actor, {
          recipientUserId: randomUUID(), contextType: 'GENERAL', jobId: randomUUID(),
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('rejects GENERAL with a customerId', async () => {
      const pool = createPoolWithConnect();
      const service = new MessagingService(pool);
      const actor = adminActor(randomUUID());

      await expect(
        service.createOrGetConversation(actor, {
          recipientUserId: randomUUID(), contextType: 'GENERAL', customerId: randomUUID(),
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('rejects GENERAL with a blank provided title', async () => {
      const pool = createPoolWithConnect();
      const service = new MessagingService(pool);
      const actor = adminActor(randomUUID());

      await expect(
        service.createOrGetConversation(actor, {
          recipientUserId: randomUUID(), contextType: 'GENERAL', title: '   ',
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('rejects JOB without a jobId', async () => {
      const pool = createPoolWithConnect();
      const service = new MessagingService(pool);
      const actor = adminActor(randomUUID());

      await expect(
        service.createOrGetConversation(actor, {
          recipientUserId: randomUUID(), contextType: 'JOB',
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('rejects JOB with a customerId', async () => {
      const pool = createPoolWithConnect();
      const service = new MessagingService(pool);
      const actor = adminActor(randomUUID());

      await expect(
        service.createOrGetConversation(actor, {
          recipientUserId: randomUUID(), contextType: 'JOB',
          jobId: randomUUID(), customerId: randomUUID(),
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('rejects CUSTOMER without a customerId', async () => {
      const pool = createPoolWithConnect();
      const service = new MessagingService(pool);
      const actor = adminActor(randomUUID());

      await expect(
        service.createOrGetConversation(actor, {
          recipientUserId: randomUUID(), contextType: 'CUSTOMER', title: 'Konu',
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('rejects CUSTOMER with a jobId', async () => {
      const pool = createPoolWithConnect();
      const service = new MessagingService(pool);
      const actor = adminActor(randomUUID());

      await expect(
        service.createOrGetConversation(actor, {
          recipientUserId: randomUUID(), contextType: 'CUSTOMER',
          customerId: randomUUID(), jobId: randomUUID(), title: 'Konu',
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('rejects CUSTOMER without a title and with a blank title', async () => {
      const pool = createPoolWithConnect();
      const service = new MessagingService(pool);
      const actor = adminActor(randomUUID());
      const customerId = randomUUID();

      await expect(
        service.createOrGetConversation(actor, {
          recipientUserId: randomUUID(), contextType: 'CUSTOMER', customerId,
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(
        service.createOrGetConversation(actor, {
          recipientUserId: randomUUID(), contextType: 'CUSTOMER', customerId, title: ' ',
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('rejects titles longer than 255 characters', async () => {
      const pool = createPoolWithConnect();
      const service = new MessagingService(pool);
      const actor = adminActor(randomUUID());

      await expect(
        service.createOrGetConversation(actor, {
          recipientUserId: randomUUID(), contextType: 'GENERAL', title: 'a'.repeat(256),
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('forbids STAFF from creating a CUSTOMER thread', async () => {
      const pool = createPoolWithConnect();
      const service = new MessagingService(pool);
      const actor = staffActor(randomUUID());

      await expect(
        service.createOrGetConversation(actor, {
          recipientUserId: randomUUID(), contextType: 'CUSTOMER',
          customerId: randomUUID(), title: 'Konu',
        }),
      ).rejects.toMatchObject({ statusCode: 403 });
    });
  });

  describe('unread count', () => {
    it('returns zero for user with no messages', async () => {
      const pool = createMockPool();
      (pool.query as any).mockResolvedValue({ rows: [{ unread_count: '0' }], rowCount: 1 });
      const service = new MessagingService(pool);
      const actor = staffActor(randomUUID());

      await expect(service.getUnreadCount(actor)).resolves.toBe(0);
    });
  });
});
