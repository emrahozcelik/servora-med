import { EventEmitter } from 'node:events';
import { createECDH, randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { type PushPayloadV1 } from '../src/modules/web-push/payload.js';
import {
  createWebPushSender,
  type HttpsRequestFunction,
} from '../src/modules/web-push/sender.js';

const subscriberEcdh = createECDH('prime256v1');
subscriberEcdh.generateKeys();

const vapidEcdh = createECDH('prime256v1');
vapidEcdh.generateKeys();

function encodeFixedWidthVapidPrivateKey(privateKey: Buffer): string {
  // Node ECDH can omit a leading zero byte; web-push requires a 32-byte P-256 VAPID scalar.
  if (privateKey.length < 1 || privateKey.length > 32) {
    throw new Error('Unexpected P-256 private key length');
  }
  return Buffer.concat([Buffer.alloc(32 - privateKey.length), privateKey]).toString('base64url');
}

const TEST_VAPID = {
  subject: 'mailto:test@example.com',
  publicKey: vapidEcdh.getPublicKey().toString('base64url'),
  privateKey: encodeFixedWidthVapidPrivateKey(vapidEcdh.getPrivateKey()),
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
  it('left-pads a 31-byte P-256 private scalar to a 32-byte VAPID key', () => {
    const shortenedPrivateKey = Buffer.alloc(31, 0x42);
    const encoded = encodeFixedWidthVapidPrivateKey(shortenedPrivateKey);
    const decoded = Buffer.from(encoded, 'base64url');

    expect(decoded).toHaveLength(32);
    expect(decoded[0]).toBe(0);
    expect(decoded.subarray(1)).toEqual(shortenedPrivateKey);
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
