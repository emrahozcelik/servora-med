import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

import type { SafeUser } from '../src/modules/auth/types.js';
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
  describe('capability gate', () => {
    it('throws 404 when messaging is disabled', async () => {
      const pool = createMockPool();
      const service = new MessagingService(pool, false);
      const actor = staffActor(randomUUID());

      await expect(service.getConversations(actor, null, 20)).rejects.toMatchObject({
        statusCode: 404,
      });
      await expect(service.getUnreadCount(actor)).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    it('allows access when messaging is enabled', async () => {
      const pool = createMockPool();
      (pool.query as any).mockResolvedValue({ rows: [{ unread_count: '0' }], rowCount: 1 });
      const service = new MessagingService(pool, true);
      const actor = staffActor(randomUUID());

      await expect(service.getUnreadCount(actor)).resolves.toBe(0);
    });
  });

  describe('body validation', () => {
    it('rejects empty body', async () => {
      const pool = createPoolWithConnect();
      const service = new MessagingService(pool, true);
      const actor = staffActor(randomUUID());

      await expect(
        service.sendMessage(actor, randomUUID(), '', 'action-1'),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('rejects body over 4000 code points', async () => {
      const pool = createPoolWithConnect();
      const service = new MessagingService(pool, true);
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
      // findAllParticipants (only actor)
      client.query.mockResolvedValueOnce({ rows: [{ conversation_id: conversationId, user_id: actor.id, organization_id: organizationId, last_read_message_id: null, created_at: new Date() }], rowCount: 1 });
      // insertMessage
      client.query.mockResolvedValueOnce({ rows: [{ id: messageId, conversation_id: conversationId, organization_id: organizationId, sender_user_id: actor.id, client_action_id: 'action-html', body: '<b>bold</b>', created_at: new Date() }], rowCount: 1 });
      // updateConversationTimestamp
      client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // insertActivity
      client.query.mockResolvedValueOnce({ rows: [{ id: randomUUID(), organization_id: organizationId, conversation_id: conversationId, actor_user_id: actor.id, action: 'MESSAGE_SENT', client_action_id: 'action-html', created_at: new Date() }], rowCount: 1 });
      // appendRealtimeEvent (now returns ID)
      client.query.mockResolvedValueOnce({ rows: [{ id: '123' }], rowCount: 1 });
      // appendNotifications
      client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // COMMIT
      client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const service = new MessagingService(pool, true);
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
      // findAllParticipants (only actor)
      client.query.mockResolvedValueOnce({ rows: [{ conversation_id: conversationId, user_id: actor.id, organization_id: organizationId, last_read_message_id: null, created_at: new Date() }], rowCount: 1 });
      // insertMessage
      client.query.mockResolvedValueOnce({ rows: [{ id: messageId, conversation_id: conversationId, organization_id: organizationId, sender_user_id: actor.id, client_action_id: 'action-1', body: 'Hello', created_at: new Date() }], rowCount: 1 });
      // updateConversationTimestamp
      client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // insertActivity
      client.query.mockResolvedValueOnce({ rows: [{ id: randomUUID(), organization_id: organizationId, conversation_id: conversationId, actor_user_id: actor.id, action: 'MESSAGE_SENT', client_action_id: 'action-1', created_at: new Date() }], rowCount: 1 });
      // appendRealtimeEvent
      client.query.mockResolvedValueOnce({ rows: [{ id: '1' }], rowCount: 1 });
      // COMMIT
      client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const service = new MessagingService(pool, true);
      const result = await service.sendMessage(actor, conversationId, 'Hello', 'action-1');

      expect(result.body).toBe('Hello');
      expect(result.isDuplicate).toBe(false);
    });
  });

  describe('recipient authorization', () => {
    it('rejects self-conversation', async () => {
      const pool = createPoolWithConnect();
      const service = new MessagingService(pool, true);
      const actor = staffActor(randomUUID());

      await expect(
        service.createOrGetConversation(actor, actor.id, 'GENERAL', null),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('rejects manager creating conversation with non-team staff', async () => {
      const organizationId = randomUUID();
      const manager = managerActor(organizationId);
      const staffId = randomUUID();

      const pool = createPoolWithConnect();
      (pool.query as any).mockResolvedValue({ rows: [], rowCount: 0 });
      const service = new MessagingService(pool, true);

      await expect(
        service.createOrGetConversation(manager, staffId, 'GENERAL', null),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('unread count', () => {
    it('returns zero for user with no messages', async () => {
      const pool = createMockPool();
      (pool.query as any).mockResolvedValue({ rows: [{ unread_count: '0' }], rowCount: 1 });
      const service = new MessagingService(pool, true);
      const actor = staffActor(randomUUID());

      await expect(service.getUnreadCount(actor)).resolves.toBe(0);
    });
  });
});
