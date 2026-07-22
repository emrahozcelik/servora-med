import { describe, expect, it } from 'vitest';

import {
  parseApprovedPushEndpoint,
  parseCreateWebPushSubscription,
} from '../src/modules/web-push/validation.js';

const validBody = {
  endpoint: 'https://fcm.googleapis.com/push/example',
  expirationTime: null,
  keys: {
    p256dh: Buffer.alloc(65, 4).toString('base64url'),
    auth: Buffer.alloc(16, 7).toString('base64url'),
  },
};

describe('parseCreateWebPushSubscription', () => {
  it('accepts only the exact canonical subscription body fields', () => {
    expect(parseCreateWebPushSubscription(validBody)).toEqual(validBody);
    expect(() => parseCreateWebPushSubscription({
      ...validBody,
      unexpected: true,
    })).toThrow('Web Push subscription body has unknown fields');
    expect(() => parseCreateWebPushSubscription({
      ...validBody,
      keys: { ...validBody.keys, unexpected: true },
    })).toThrow('Web Push subscription keys have unknown fields');
  });

  it.each([undefined, null, 42, '', 'x'.repeat(2049)])(
    'rejects invalid or unbounded endpoint %s',
    (endpoint) => {
      expect(() => parseCreateWebPushSubscription({
        ...validBody,
        endpoint,
      })).toThrow('Web Push endpoint must be a non-empty string up to 2048 characters');
    },
  );

  it.each([undefined, '1', Number.NaN, Number.POSITIVE_INFINITY, -1])(
    'rejects invalid expiration time %s',
    (expirationTime) => {
      expect(() => parseCreateWebPushSubscription({
        ...validBody,
        expirationTime,
      })).toThrow('Web Push expirationTime must be null or a finite non-negative number');
    },
  );

  it.each([
    ['p256dh', undefined],
    ['p256dh', ''],
    ['p256dh', 'not+url/safe='],
    ['p256dh', 'a'.repeat(513)],
    ['auth', undefined],
    ['auth', ''],
    ['auth', 'not+url/safe='],
    ['auth', 'a'.repeat(513)],
  ] as const)('rejects invalid or unbounded %s key', (key, value) => {
    expect(() => parseCreateWebPushSubscription({
      ...validBody,
      keys: { ...validBody.keys, [key]: value },
    })).toThrow(`Web Push ${key} must be bounded URL-safe Base64`);
  });
});

describe('parseApprovedPushEndpoint', () => {
  it.each([
    'https://fcm.googleapis.com/push/example',
    'https://updates.push.services.mozilla.com/wpush/v2/example',
    'https://push.apple.com/3/device/example',
    'https://web.push.apple.com/3/device/example',
  ])('accepts approved canonical push endpoint %s', (endpoint) => {
    expect(parseApprovedPushEndpoint(endpoint)).toBe(endpoint);
  });

  it.each([
    'http://fcm.googleapis.com/push/example',
    'https://user:password@fcm.googleapis.com/push/example',
    'https://fcm.googleapis.com:443/push/example',
    'https://fcm.googleapis.com:8443/push/example',
    'https://fcm.googleapis.com/push/example?redirect=evil',
    'https://fcm.googleapis.com/push/example#fragment',
    'https://127.0.0.1/push/example',
    'https://[::1]/push/example',
    'https://2130706433/push/example',
    'https://0x7f000001/push/example',
    'https://0177.0.0.1/push/example',
    'https://%31%32%37.0.0.1/push/example',
    'https://fcm.googleapis.com\\@attacker.example/push/example',
    'https://push.apple.com.attacker.example/push/example',
    'https://evilpush.apple.com/push/example',
  ])('rejects non-canonical or unapproved endpoint %s', (endpoint) => {
    expect(() => parseApprovedPushEndpoint(endpoint)).toThrow(
      'Web Push endpoint must be an approved canonical HTTPS URL',
    );
  });
});
