import Fastify, { type preHandlerHookHandler } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { toErrorResponse } from '../src/errors/index.js';
import type { SafeUser } from '../src/modules/auth/types.js';
import { messagingRoutes } from '../src/modules/messaging/routes.js';
import type { MessagingService } from '../src/modules/messaging/service.js';

const ACTOR: SafeUser = {
  id: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
  name: 'Test Admin',
  email: 'cursor-validation@test.local',
  role: 'ADMIN',
  mustChangePassword: false,
  isActive: true,
  version: 1,
};

const VALID_UUID = '33333333-3333-4333-8333-333333333333';
const INVALID_TIMESTAMP = 'not-a-valid-timestamp';
const EXACT_MICROSECOND = '2026-01-15T10:20:30.123900Z';

function dbError() {
  throw new Error('cursor-validation must not reach the service');
}

function mockService(): MessagingService {
  return {
    getConversations: vi.fn(dbError),
    getRecipients: vi.fn(dbError),
    createOrGetConversation: vi.fn(dbError),
    getJobConversation: vi.fn(dbError),
    getMessages: vi.fn(dbError),
    sendMessage: vi.fn(dbError),
    archiveConversation: vi.fn(dbError),
    unarchiveConversation: vi.fn(dbError),
    markRead: vi.fn(dbError),
    getUnreadCount: vi.fn(dbError),
  } as unknown as MessagingService;
}

type ServiceStub = MessagingService & Record<string, ReturnType<typeof vi.fn>>;

async function buildApp(service: MessagingService) {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    const response = toErrorResponse(error);
    reply.code(response.statusCode).send(response.body);
  });
  const authenticate: preHandlerHookHandler = async (request) => {
    (request as { currentUser?: SafeUser }).currentUser = ACTOR;
  };
  await app.register(messagingRoutes, {
    prefix: '/api/messaging',
    service,
    authenticate,
  });
  return app;
}

function encodeCursor(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

describe('MSG-CURSOR-VALIDATION: cursor timestamp boundary', () => {
  let service: ServiceStub;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    service = mockService() as ServiceStub;
    app = await buildApp(service);
  });

  it('CURSOR-VAL-1: conversation cursor with invalid ua is rejected before the service call', async () => {
    const cursor = encodeCursor({ ua: INVALID_TIMESTAMP, id: VALID_UUID });
    const res = await app.inject({
      method: 'GET',
      url: `/api/messaging/conversations?cursor=${cursor}`,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({
      code: 'VALIDATION_ERROR',
      error: 'Geçersiz imleç.',
    });
    expect(service.getConversations).not.toHaveBeenCalled();
  });

  it('CURSOR-VAL-2: message cursor with invalid ca is rejected before the service call', async () => {
    const cursor = encodeCursor({ ca: INVALID_TIMESTAMP, id: VALID_UUID });
    const res = await app.inject({
      method: 'GET',
      url: `/api/messaging/conversations/${VALID_UUID}/messages?cursor=${cursor}`,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({
      code: 'VALIDATION_ERROR',
      error: 'Geçersiz imleç.',
    });
    expect(service.getMessages).not.toHaveBeenCalled();
  });

  it('CURSOR-VAL-3: valid conversation cursor still parses and reaches the service', async () => {
    service.getConversations.mockResolvedValue({ items: [], nextCursor: null });
    const cursor = encodeCursor({ ua: '2026-01-15T10:20:30.123Z', id: VALID_UUID });
    const res = await app.inject({
      method: 'GET',
      url: `/api/messaging/conversations?cursor=${cursor}`,
    });
    expect(res.statusCode).toBe(200);
    expect(service.getConversations).toHaveBeenCalledTimes(1);
    const parsed = service.getConversations.mock.calls[0]![1] as {
      updatedAt: Date;
      id: string;
    };
    expect(parsed.id).toBe(VALID_UUID);
    expect(parsed.updatedAt).toBeInstanceOf(Date);
    expect(Number.isNaN(parsed.updatedAt.getTime())).toBe(false);
  });

  it('CURSOR-VAL-4: high-precision message cursor keeps the exact raw timestamp', async () => {
    service.getMessages.mockResolvedValue({ items: [], nextCursor: null });
    const cursor = encodeCursor({ ca: EXACT_MICROSECOND, id: VALID_UUID });
    const res = await app.inject({
      method: 'GET',
      url: `/api/messaging/conversations/${VALID_UUID}/messages?cursor=${cursor}`,
    });
    expect(res.statusCode).toBe(200);
    expect(service.getMessages).toHaveBeenCalledTimes(1);
    const parsed = service.getMessages.mock.calls[0]![2] as {
      createdAt: Date;
      createdAtExact?: string;
      id: string;
    };
    expect(parsed.id).toBe(VALID_UUID);
    expect(parsed.createdAt).toBeInstanceOf(Date);
    expect(Number.isNaN(parsed.createdAt.getTime())).toBe(false);
    expect(parsed.createdAtExact).toBe(EXACT_MICROSECOND);
  });
});
