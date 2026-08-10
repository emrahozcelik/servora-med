import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SafeUser } from '../auth/types.js';
import { AppError } from '../../errors/index.js';
import type { MessagingService } from './service.js';
import type { ConversationListCursor, MessageCursor } from './types.js';
import { isValidContextType } from './types.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    const message = `${field} geçersizdir.`;
    throw new AppError('VALIDATION_ERROR', 400, message, {
      fieldErrors: { [field]: message },
    });
  }
  return value;
}

function parsePagination(query: Record<string, string | undefined>) {
  const limit = Math.min(Math.max(1, parseInt(query.limit ?? '20', 10) || 20), 50);
  return { limit };
}

function parseCursor(query: Record<string, string | undefined>): ConversationListCursor | null {
  const cursor = query.cursor;
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8'));
    parseUuid(parsed.id, 'cursor');
    return { updatedAt: new Date(parsed.ua), id: parsed.id };
  } catch {
    throw new AppError('VALIDATION_ERROR', 400, 'Geçersiz imleç.');
  }
}

function parseMessageCursor(query: Record<string, string | undefined>): MessageCursor | null {
  const cursor = query.cursor;
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8'));
    parseUuid(parsed.id, 'cursor');
    return { createdAt: new Date(parsed.ca), id: parsed.id };
  } catch {
    throw new AppError('VALIDATION_ERROR', 400, 'Geçersiz imleç.');
  }
}

function encodeCursor(input: { id: string } & Record<string, unknown>): string | null {
  if (!input) return null;
  const { id, ...rest } = input;
  const keys = Object.keys(rest);
  if (keys[0] === 'updatedAt') {
    return Buffer.from(JSON.stringify({ ua: (rest.updatedAt as Date).toISOString(), id })).toString('base64url');
  }
  if (keys[0] === 'createdAt') {
    return Buffer.from(JSON.stringify({ ca: (rest.createdAt as Date).toISOString(), id })).toString('base64url');
  }
  return null;
}

function actor(req: FastifyRequest): SafeUser {
  return req.currentUser!;
}

export function createMessagingHandlers(service: MessagingService) {
  return {
    listConversations: async (req: FastifyRequest, reply: FastifyReply) => {
      const { limit } = parsePagination(req.query as Record<string, string>);
      const cursor = parseCursor(req.query as Record<string, string>);
      const page = await service.getConversations(actor(req), cursor, limit);
      return reply.send({
        items: page.items,
        nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
      });
    },

    getRecipients: async (req: FastifyRequest, reply: FastifyReply) => {
      const contextType = (req.query as Record<string, string>).contextType ?? 'GENERAL';
      if (!isValidContextType(contextType)) {
        throw new AppError('VALIDATION_ERROR', 400, 'Geçersiz konuşma tipi.');
      }
      const recipients = await service.getRecipients(actor(req), contextType);
      return reply.send({ items: recipients });
    },

    createOrGetConversation: async (req: FastifyRequest, reply: FastifyReply) => {
      const body = req.body as Record<string, unknown>;
      const recipientUserId = body.recipientUserId as string | undefined;
      const rawParticipantUserIds = body.participantUserIds as unknown;
      const contextType = body.contextType as string ?? 'GENERAL';
      const jobId = (body.jobId as string) || null;
      const customerId = (body.customerId as string) || null;
      const title = body.title as string | undefined;

      if (recipientUserId && rawParticipantUserIds !== undefined) {
        throw new AppError(
          'VALIDATION_ERROR', 400,
          'recipientUserId ve participantUserIds birlikte kullanılamaz.',
        );
      }
      let participantUserIds: readonly string[] | undefined;
      if (rawParticipantUserIds !== undefined) {
        if (
          !Array.isArray(rawParticipantUserIds)
          || rawParticipantUserIds.some((entry) => typeof entry !== 'string' || entry.length === 0)
        ) {
          throw new AppError('VALIDATION_ERROR', 400, 'participantUserIds geçersiz.');
        }
        for (const entry of rawParticipantUserIds as string[]) {
          parseUuid(entry, 'participantUserIds');
        }
        participantUserIds = rawParticipantUserIds as string[];
        if (participantUserIds.length === 0) {
          throw new AppError('VALIDATION_ERROR', 400, 'En az bir katılımcı seçin.');
        }
      } else if (!recipientUserId) {
        throw new AppError('VALIDATION_ERROR', 400, 'recipientUserId zorunludur.');
      } else {
        parseUuid(recipientUserId, 'recipientUserId');
      }
      if (jobId) parseUuid(jobId, 'jobId');
      if (customerId) parseUuid(customerId, 'customerId');
      if (!isValidContextType(contextType)) {
        throw new AppError('VALIDATION_ERROR', 400, 'Geçersiz konuşma tipi.');
      }

      const conversation = await service.createOrGetConversation(actor(req), {
        recipientUserId,
        participantUserIds,
        contextType,
        jobId,
        customerId,
        title,
      });
      return reply.code(201).send(conversation);
    },

    getJobConversationByJobId: async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { jobId: string };
      const conversation = await service.getJobConversation(actor(req), parseUuid(params.jobId, 'jobId'));
      return reply.send(conversation);
    },

    sendMessage: async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { conversationId: string };
      const body = req.body as Record<string, unknown>;
      const messageBody = body.body;
      const clientActionId = body.clientActionId as string;

      const message = await service.sendMessage(
        actor(req), parseUuid(params.conversationId, 'conversationId'), messageBody, clientActionId,
      );
      const code = message.isDuplicate ? 200 : 201;
      return reply.code(code).send(message);
    },

    listMessages: async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { conversationId: string };
      const { limit } = parsePagination(req.query as Record<string, string>);
      const cursor = parseMessageCursor(req.query as Record<string, string>);
      const page = await service.getMessages(
        actor(req), parseUuid(params.conversationId, 'conversationId'), cursor, limit,
      );
      return reply.send({
        items: page.items,
        nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
      });
    },

    markRead: async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { conversationId: string };
      const body = req.body as Record<string, unknown>;
      const messageId = body.messageId as string;

      if (!messageId) {
        throw new AppError('VALIDATION_ERROR', 400, 'messageId zorunludur.');
      }

      await service.markRead(
        actor(req), parseUuid(params.conversationId, 'conversationId'), parseUuid(messageId, 'messageId'),
      );
      return reply.code(204).send();
    },

    syncJobAssignee: async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { conversationId: string };
      const body = req.body as Record<string, unknown>;
      const clientActionId = body.clientActionId as string;
      const assignmentTransitionId = body.assignmentTransitionId as string;

      if (!clientActionId || typeof clientActionId !== 'string') {
        throw new AppError('VALIDATION_ERROR', 400, 'clientActionId zorunludur.');
      }

      const result = await service.syncJobAssignee(
        actor(req),
        parseUuid(params.conversationId, 'conversationId'),
        {
          clientActionId,
          assignmentTransitionId: parseUuid(assignmentTransitionId, 'assignmentTransitionId'),
        },
      );
      return reply.send(result);
    },

    unreadCount: async (req: FastifyRequest, reply: FastifyReply) => {
      const count = await service.getUnreadCount(actor(req));
      return reply.send({ unreadCount: count });
    },
  };
}
