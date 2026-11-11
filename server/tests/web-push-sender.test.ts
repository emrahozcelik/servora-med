import { EventEmitter } from 'node:events';
import { createECDH, randomUUID } from 'node:crypto';

import webPush from 'web-push';

import { describe, expect, it, vi } from 'vitest';

import { type PushPayloadV1 } from '../src/modules/web-push/payload.js';
import {
  createWebPushSender,
  type HttpsRequestFunction,
} from '../src/modules/web-push/sender.js';

const subscriberEcdh = createECDH('prime256v1');
subscriberEcdh.generateKeys();

// web-push pads rare 31-byte ECDH private scalars to the required 32 bytes.
// Avoid a shared random short-key fixture that makes all sender tests fail with 400.
const TEST_VAPID = {
  subject: 'mailto:test@example.com',
  ...webPush.generateVAPIDKeys(),
};

const DEFAULT_PAYLOAD: PushPayloadV1 = {
  version: 1,
  notificationId: randomUUID(),
  title: 'Test title',
  body: 'Test body',
  url: `/jobs/${randomUUID()}`,
};

function mockResponseRequest(statusCode: number): HttpsRequestFunction {
  return ((_url, _options, callback) => {
    const req = new EventEmitter() as ReturnType<HttpsRequestFunction>;
    req.end = vi.fn();
    req.write = vi.fn();
    req.destroy = vi.fn();

    process.nextTick(() => {
      const res = new EventEmitter() as never as HttpsRequestFunction extends (...args: infer P) => unknown ? Parameters<P[2]>[0] : never;
      res.statusCode = statusCode;
      res.headers = {};
      (res as { resume: () => void }).resume = vi.fn();
      callback(res);
      res.emit('end');
    });

    return req;
  }) as unknown as HttpsRequestFunction;
}

function mockNetworkError(error: Error): HttpsRequestFunction {
  return ((_url, _options, _callback) => {
    const req = new EventEmitter() as ReturnType<HttpsRequestFunction>;
    req.end = vi.fn();
    req.write = vi.fn();
    req.destroy = vi.fn();

    process.nextTick(() => {
      req.emit('error', error);
    });

    return req;
  }) as unknown as HttpsRequestFunction;
}

function mockDelayedResponse(delayMs: number): HttpsRequestFunction {
  return ((_url, _options, callback) => {
    const req = new EventEmitter() as ReturnType<HttpsRequestFunction>;
    req.end = vi.fn();
    req.write = vi.fn();
    req.destroy = vi.fn();

    setTimeout(() => {
      const res = new EventEmitter() as never;
      res.statusCode = 200;
      res.headers = {};
      (res as { resume: () => void }).resume = vi.fn();
      callback(res as never);
      res.emit('end');
    }, delayMs);

    return req;
  }) as unknown as HttpsRequestFunction;
}

describe('WebPushSender', () => {
  it('generates full-length VAPID keys for the shared fixture', () => {
    expect(Buffer.from(TEST_VAPID.publicKey, 'base64url')).toHaveLength(65);
    expect(Buffer.from(TEST_VAPID.privateKey, 'base64url')).toHaveLength(32);
  });

  it('returns 2xx status as response result', async () => {
    const request = vi.fn(mockResponseRequest(201));
    const sender = createWebPushSender(TEST_VAPID, request);

    const result = await sender.send({
      subscription: {
        endpoint: 'https://fcm.googleapis.com/fcm/send/test',
        p256dh: subscriberEcdh.getPublicKey().toString('base64url'),
        auth: Buffer.from('0123456789abcdef0123456789abcdef', 'hex').toString('base64url'),
      },
      payload: DEFAULT_PAYLOAD,
      topic: DEFAULT_PAYLOAD.notificationId.replaceAll('-', ''),
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ type: 'response', statusCode: 201 });
  });

  it('normalizes 404 status code', async () => {
    const sender = createWebPushSender(TEST_VAPID, mockResponseRequest(404));

    const result = await sender.send({
      subscription: {
        endpoint: 'https://fcm.googleapis.com/fcm/send/test',
        p256dh: subscriberEcdh.getPublicKey().toString('base64url'),
        auth: Buffer.from('0123456789abcdef0123456789abcdef', 'hex').toString('base64url'),
      },
      payload: DEFAULT_PAYLOAD,
      topic: DEFAULT_PAYLOAD.notificationId.replaceAll('-', ''),
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ type: 'response', statusCode: 404 });
  });

  it('returns network-error on connection failure', async () => {
    const sender = createWebPushSender(TEST_VAPID, mockNetworkError(new Error('ECONNREFUSED')));

    const result = await sender.send({
      subscription: {
        endpoint: 'https://fcm.googleapis.com/fcm/send/test',
        p256dh: subscriberEcdh.getPublicKey().toString('base64url'),
        auth: Buffer.from('0123456789abcdef0123456789abcdef', 'hex').toString('base64url'),
      },
      payload: DEFAULT_PAYLOAD,
      topic: DEFAULT_PAYLOAD.notificationId.replaceAll('-', ''),
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ type: 'network-error' });
  });

  it('returns timeout when request exceeds given timeout', async () => {
    const sender = createWebPushSender(TEST_VAPID, mockDelayedResponse(100));

    const result = await sender.send({
      subscription: {
        endpoint: 'https://fcm.googleapis.com/fcm/send/test',
        p256dh: subscriberEcdh.getPublicKey().toString('base64url'),
        auth: Buffer.from('0123456789abcdef0123456789abcdef', 'hex').toString('base64url'),
      },
      payload: DEFAULT_PAYLOAD,
      topic: DEFAULT_PAYLOAD.notificationId.replaceAll('-', ''),
      signal: new AbortController().signal,
      timeoutMs: 10,
    });

    expect(result).toEqual({ type: 'timeout' });
  });

  it('returns aborted when external AbortSignal fires', async () => {
    const controller = new AbortController();
    const sender = createWebPushSender(TEST_VAPID, mockDelayedResponse(100));

    const resultPromise = sender.send({
      subscription: {
        endpoint: 'https://fcm.googleapis.com/fcm/send/test',
        p256dh: subscriberEcdh.getPublicKey().toString('base64url'),
        auth: Buffer.from('0123456789abcdef0123456789abcdef', 'hex').toString('base64url'),
      },
      payload: DEFAULT_PAYLOAD,
      topic: DEFAULT_PAYLOAD.notificationId.replaceAll('-', ''),
      signal: controller.signal,
    });

    controller.abort();
    const result = await resultPromise;
    expect(result).toEqual({ type: 'aborted' });
  });

  it('does not follow redirects', async () => {
    const sender = createWebPushSender(TEST_VAPID, mockResponseRequest(302));

    const result = await sender.send({
      subscription: {
        endpoint: 'https://fcm.googleapis.com/fcm/send/test',
        p256dh: subscriberEcdh.getPublicKey().toString('base64url'),
        auth: Buffer.from('0123456789abcdef0123456789abcdef', 'hex').toString('base64url'),
      },
      payload: DEFAULT_PAYLOAD,
      topic: DEFAULT_PAYLOAD.notificationId.replaceAll('-', ''),
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ type: 'response', statusCode: 302 });
  });

  it('rejects invalid stored endpoint without making request', async () => {
    const request = vi.fn();
    const sender = createWebPushSender(TEST_VAPID, request);

    const result = await sender.send({
      subscription: {
        endpoint: 'http://insecure.example.com/push',
        p256dh: subscriberEcdh.getPublicKey().toString('base64url'),
        auth: Buffer.from('0123456789abcdef0123456789abcdef', 'hex').toString('base64url'),
      },
      payload: DEFAULT_PAYLOAD,
      topic: DEFAULT_PAYLOAD.notificationId.replaceAll('-', ''),
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ type: 'response', statusCode: 400 });
    expect(request).not.toHaveBeenCalled();
  });
});
