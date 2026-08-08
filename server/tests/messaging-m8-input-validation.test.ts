import Fastify, { type preHandlerHookHandler } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError, toErrorResponse } from '../src/errors/index.js';
import type { SafeUser } from '../src/modules/auth/types.js';
import { messagingRoutes } from '../src/modules/messaging/routes.js';
import type { MessagingService } from '../src/modules/messaging/service.js';

const ACTOR: SafeUser = {
  id: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
  name: 'Test Admin',
  email: 'm8-test@test.local',
  role: 'ADMIN',
  mustChangePassword: false,
  isActive: true,
  version: 1,
};

const VALID_UUID_LOWER = 'af03ccf2-4b10-412f-cc35-f2a555e44ff1';
const VALID_UUID_UPPER = 'AF03CCF2-4B10-412F-CC35-F2A555E44FF1';
const VALID_UUID_OTHER = '33333333-3333-4333-8333-333333333333';
const VALID_UUID_OTHER2 = '44444444-4444-4444-8444-444444444444';

function dbError() {
  throw new Error('22P02 invalid_text_representation');
}

function mockService(): MessagingService {
  return {
    getConversations: vi.fn(dbError),
    getRecipients: vi.fn(dbError),
    createOrGetConversation: vi.fn(dbError),
    getJobConversation: vi.fn(dbError),
    getMessages: vi.fn(dbError),
    sendMessage: vi.fn(dbError),
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

describe('M8: Messaging UUID input validation boundary', () => {
  let service: ServiceStub;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    service = mockService() as ServiceStub;
    app = await buildApp(service);
  });

  it('malformed jobId route param returns 400 without service call', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/messaging/conversations/job/not-a-uuid',
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(service.getJobConversation).not.toHaveBeenCalled();
  });

  it('malformed create body jobId returns 400 without service call', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/messaging/conversations',
      payload: {
        contextType: 'JOB', jobId: 'not-a-uuid', participantUserIds: [VALID_UUID_OTHER],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(service.createOrGetConversation).not.toHaveBeenCalled();
  });

  it('malformed create body customerId returns 400 without service call', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/messaging/conversations',
      payload: {
        contextType: 'CUSTOMER', customerId: 'not-a-uuid', participantUserIds: [VALID_UUID_OTHER],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(service.createOrGetConversation).not.toHaveBeenCalled();
  });

  it('malformed legacy recipientUserId returns 400 without service call', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/messaging/conversations',
      payload: { contextType: 'GENERAL', recipientUserId: 'not-a-uuid', title: 'Konu' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(service.createOrGetConversation).not.toHaveBeenCalled();
  });

  it('one malformed participantUserIds item returns 400 without service call', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/messaging/conversations',
      payload: {
        contextType: 'GENERAL', participantUserIds: ['not-a-uuid'], title: 'Konu',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(service.createOrGetConversation).not.toHaveBeenCalled();
  });

  it('mixed valid and malformed participantUserIds returns 400 without service call', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/messaging/conversations',
      payload: {
        contextType: 'GENERAL',
        participantUserIds: [VALID_UUID_OTHER, 'not-a-uuid'],
        title: 'Konu',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(service.createOrGetConversation).not.toHaveBeenCalled();
  });

  it('malformed conversationId route param returns 400 without service call', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/messaging/conversations/not-a-uuid/messages',
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(service.getMessages).not.toHaveBeenCalled();
  });

  it('malformed conversationId on POST messages returns 400 without service call', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/messaging/conversations/not-a-uuid/messages',
      payload: { body: 'mesaj', clientActionId: 'm8-test-1' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(service.sendMessage).not.toHaveBeenCalled();
  });

  it('malformed conversationId on PATCH read returns 400 without service call', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/messaging/conversations/not-a-uuid/read',
      payload: { messageId: VALID_UUID_OTHER },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(service.markRead).not.toHaveBeenCalled();
  });

  it('malformed messageId body returns 400 without service call', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/messaging/conversations/${VALID_UUID_OTHER}/read`,
      payload: { messageId: 'not-a-uuid' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(service.markRead).not.toHaveBeenCalled();
  });

  it('malformed conversations cursor.id returns 400 without service call', async () => {
    const cursor = Buffer.from(JSON.stringify({ ua: new Date().toISOString(), id: 'not-a-uuid' })).toString('base64url');
    const res = await app.inject({
      method: 'GET',
      url: `/api/messaging/conversations?cursor=${cursor}`,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(service.getConversations).not.toHaveBeenCalled();
  });

  it('malformed messages cursor.id returns 400 without service call', async () => {
    const cursor = Buffer.from(JSON.stringify({ ca: new Date().toISOString(), id: 'not-a-uuid' })).toString('base64url');
    const res = await app.inject({
      method: 'GET',
      url: `/api/messaging/conversations/${VALID_UUID_OTHER}/messages?cursor=${cursor}`,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(service.getMessages).not.toHaveBeenCalled();
  });

  it('unauthenticated malformed request still returns 401 before validation', async () => {
    const app401 = Fastify({ logger: false });
    app401.setErrorHandler((error, _request, reply) => {
      const response = toErrorResponse(error);
      reply.code(response.statusCode).send(response.body);
    });
    const authenticate: preHandlerHookHandler = async () => {
      throw new AppError('UNAUTHORIZED', 401, 'Kimlik doğrulaması gerekli.');
    };
    await app401.register(messagingRoutes, {
      prefix: '/api/messaging',
      service,
      authenticate,
    });
    const res = await app401.inject({
      method: 'GET',
      url: '/api/messaging/conversations/job/not-a-uuid',
    });
    expect(res.statusCode).toBe(401);
    expect(service.getJobConversation).not.toHaveBeenCalled();
  });

  it('valid lowercase UUID job lookup reaches service (404 from service preserved)', async () => {
    service.getJobConversation.mockRejectedValue(
      new AppError('NOT_FOUND', 404, 'Bulunamadı.'),
    );
    const res = await app.inject({
      method: 'GET',
      url: `/api/messaging/conversations/job/${VALID_UUID_LOWER}`,
    });
    expect(res.statusCode).toBe(404);
    expect(service.getJobConversation).toHaveBeenCalledTimes(1);
  });

  it('uppercase hex UUID is accepted as generic UUID syntax', async () => {
    service.getJobConversation.mockRejectedValue(
      new AppError('NOT_FOUND', 404, 'Bulunamadı.'),
    );
    const res = await app.inject({
      method: 'GET',
      url: `/api/messaging/conversations/job/${VALID_UUID_UPPER}`,
    });
    expect(res.statusCode).toBe(404);
    expect(service.getJobConversation).toHaveBeenCalledTimes(1);
  });

  it('valid participant list reaches createOrGetConversation', async () => {
    service.createOrGetConversation.mockResolvedValue({} as never);
    const res = await app.inject({
      method: 'POST',
      url: '/api/messaging/conversations',
      payload: {
        contextType: 'GENERAL',
        participantUserIds: [VALID_UUID_OTHER, VALID_UUID_OTHER2],
        title: 'Konu',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(service.createOrGetConversation).toHaveBeenCalledTimes(1);
  });

  it('structural invalid participant items keep existing 400 behavior', async () => {
    const payloads = [
      { contextType: 'GENERAL', participantUserIds: [null], title: 'Konu' },
      { contextType: 'GENERAL', participantUserIds: [42], title: 'Konu' },
      { contextType: 'GENERAL', participantUserIds: [{}], title: 'Konu' },
      { contextType: 'GENERAL', participantUserIds: [], title: 'Konu' },
      { contextType: 'GENERAL', recipientUserId: VALID_UUID_OTHER, participantUserIds: [VALID_UUID_OTHER2], title: 'Konu' },
    ];
    for (const payload of payloads) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/messaging/conversations',
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toMatchObject({ code: 'VALIDATION_ERROR' });
    }
    expect(service.createOrGetConversation).not.toHaveBeenCalled();
  });

  it('malformed cursor encoding/JSON keeps existing 400 behavior', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/messaging/conversations?cursor=%%%not-base64url',
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(service.getConversations).not.toHaveBeenCalled();
  });
});
