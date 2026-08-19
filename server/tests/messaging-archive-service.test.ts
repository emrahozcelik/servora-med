import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import type { SafeUser } from '../src/modules/auth/types.js';
import { MessagingService } from '../src/modules/messaging/service.js';

function staffActor(organizationId: string): SafeUser {
  return {
    id: randomUUID(),
    organizationId,
    name: 'Staff User',
    email: 'staff@example.test',
    role: 'STAFF',
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
    email: 'admin@example.test',
    role: 'ADMIN',
    mustChangePassword: false,
    isActive: true,
    version: 1,
  };
}

describe('MessagingService conversation archive', () => {
  it('archives an authorized conversation only after confirming it has no unread messages', async () => {
    const organizationId = randomUUID();
    const conversationId = randomUUID();
    const actor = staffActor(organizationId);
    const otherParticipantId = randomUUID();
    const now = new Date('2026-08-19T10:00:00.000Z');
    const client = {
      query: vi.fn(),
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      connect: vi.fn().mockResolvedValue(client),
    } as unknown as Pool;

    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // BEGIN
    client.query.mockResolvedValueOnce({
      rows: [{
        id: conversationId,
        organization_id: organizationId,
        direct_key: 'general-direct',
        context_type: 'GENERAL',
        job_id: null,
        customer_id: null,
        title: null,
        created_at: now,
        updated_at: now,
      }],
      rowCount: 1,
    });
    client.query.mockResolvedValueOnce({
      rows: [
        {
          conversation_id: conversationId,
          user_id: actor.id,
          organization_id: organizationId,
          last_read_message_id: null,
          created_at: now,
        },
        {
          conversation_id: conversationId,
          user_id: otherParticipantId,
          organization_id: organizationId,
          last_read_message_id: null,
          created_at: now,
        },
      ],
      rowCount: 2,
    });
    client.query.mockResolvedValueOnce({ rows: [{ unread_count: '0' }], rowCount: 1 });
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // COMMIT

    const service = new MessagingService(pool, true);

    await expect(service.archiveConversation(actor, conversationId)).resolves.toBeUndefined();

    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('conversation_user_states'),
      [organizationId, conversationId, actor.id, expect.any(Date)],
    );
    expect(client.query).not.toHaveBeenCalledWith(
      expect.stringContaining('DROP '),
      expect.anything(),
    );
  });

  it('rejects archiving an unread conversation without changing its archive state', async () => {
    const organizationId = randomUUID();
    const conversationId = randomUUID();
    const actor = staffActor(organizationId);
    const now = new Date('2026-08-19T10:00:00.000Z');
    const client = {
      query: vi.fn(),
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      connect: vi.fn().mockResolvedValue(client),
    } as unknown as Pool;

    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // BEGIN
    client.query.mockResolvedValueOnce({
      rows: [{
        id: conversationId,
        organization_id: organizationId,
        direct_key: 'unread-direct',
        context_type: 'GENERAL',
        job_id: null,
        customer_id: null,
        title: null,
        created_at: now,
        updated_at: now,
      }],
      rowCount: 1,
    });
    client.query.mockResolvedValueOnce({
      rows: [{
        conversation_id: conversationId,
        user_id: actor.id,
        organization_id: organizationId,
        last_read_message_id: null,
        created_at: now,
      }],
      rowCount: 1,
    });
    client.query.mockResolvedValueOnce({ rows: [{ unread_count: '1' }], rowCount: 1 });
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // ROLLBACK

    const service = new MessagingService(pool, true);

    await expect(service.archiveConversation(actor, conversationId)).rejects.toMatchObject({
      code: 'CONVERSATION_UNREAD',
      statusCode: 409,
    });
    expect(client.query).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO conversation_user_states'),
      expect.anything(),
    );
  });

  it('unarchives an authorized conversation idempotently without changing read state', async () => {
    const organizationId = randomUUID();
    const conversationId = randomUUID();
    const actor = adminActor(organizationId);
    const now = new Date('2026-08-19T10:00:00.000Z');
    const client = {
      query: vi.fn(),
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      connect: vi.fn().mockResolvedValue(client),
    } as unknown as Pool;

    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // BEGIN
    client.query.mockResolvedValueOnce({
      rows: [{
        id: conversationId,
        organization_id: organizationId,
        direct_key: 'archived-direct',
        context_type: 'GENERAL',
        job_id: null,
        customer_id: null,
        title: 'Archived topic',
        created_at: now,
        updated_at: now,
      }],
      rowCount: 1,
    });
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // participants
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // clear archive state
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // COMMIT

    const service = new MessagingService(pool, true);

    await expect(service.unarchiveConversation(actor, conversationId)).resolves.toBeUndefined();

    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('SET archived_at = NULL'),
      [organizationId, conversationId, actor.id],
    );
  });

  it('clears archive state for the authorized audience when a new message is created', async () => {
    const organizationId = randomUUID();
    const conversationId = randomUUID();
    const actor = adminActor(organizationId);
    const participantId = randomUUID();
    const now = new Date('2026-08-19T10:00:00.000Z');
    const messageId = randomUUID();
    const activityId = randomUUID();
    const client = {
      query: vi.fn(),
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      connect: vi.fn().mockResolvedValue(client),
    } as unknown as Pool;

    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // BEGIN
    client.query.mockResolvedValueOnce({
      rows: [{
        id: conversationId,
        organization_id: organizationId,
        direct_key: 'general-topic',
        context_type: 'GENERAL',
        job_id: null,
        customer_id: null,
        title: 'Topic',
        created_at: now,
        updated_at: now,
      }],
      rowCount: 1,
    });
    client.query.mockResolvedValueOnce({
      rows: [{
        conversation_id: conversationId,
        user_id: participantId,
        organization_id: organizationId,
        last_read_message_id: null,
        created_at: now,
      }],
      rowCount: 1,
    });
    client.query.mockResolvedValueOnce({
      rows: [{
        id: messageId,
        conversation_id: conversationId,
        organization_id: organizationId,
        sender_user_id: actor.id,
        sender_name: actor.name,
        client_action_id: 'message-1',
        body: 'Yeni mesaj',
        created_at: now,
      }],
      rowCount: 1,
    });
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // clear archive state
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // timestamp
    client.query.mockResolvedValueOnce({
      rows: [{
        id: activityId,
        organization_id: organizationId,
        conversation_id: conversationId,
        actor_user_id: actor.id,
        action: 'MESSAGE_SENT',
        client_action_id: 'message-1',
        created_at: now,
      }],
      rowCount: 1,
    });
    client.query.mockResolvedValueOnce({ rows: [{ id: '1' }], rowCount: 1 }); // realtime event
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // notifications
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // COMMIT

    const service = new MessagingService(pool, true);

    await service.sendMessage(actor, conversationId, 'Yeni mesaj', 'message-1');

    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('conversation_user_states'),
      [organizationId, conversationId, expect.arrayContaining([actor.id, participantId])],
    );
  });
});
