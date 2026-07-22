import { AppError } from '../../errors/index.js';

export type CreateWebPushSubscription = Readonly<{
  endpoint: string;
  expirationTime: number | null;
  keys: Readonly<{
    p256dh: string;
    auth: string;
  }>;
}>;

function invalid(message: string): never {
  throw new AppError('INVALID_WEB_PUSH_SUBSCRIPTION', 400, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === [...expected].sort()[index]);
}

function readKey(value: unknown, name: 'p256dh' | 'auth'): string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 512
    || !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    invalid(`Web Push ${name} must be bounded URL-safe Base64`);
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length === 0 || decoded.toString('base64url') !== value) {
    invalid(`Web Push ${name} must be bounded URL-safe Base64`);
  }
  return value;
}

export function parseApprovedPushEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    const authority = endpoint.match(/^https:\/\/([^/?#]+)/)?.[1] ?? '';
    const explicitPort = /:\d+$/.test(authority);
    const hostname = url.hostname.toLowerCase();
    const approved = hostname === 'fcm.googleapis.com'
      || hostname === 'updates.push.services.mozilla.com'
      || hostname === 'push.apple.com'
      || hostname.endsWith('.push.apple.com');
    if (
      url.protocol !== 'https:'
      || url.username !== ''
      || url.password !== ''
      || explicitPort
      || url.search !== ''
      || url.hash !== ''
      || endpoint.includes('\\')
      || !approved
    ) {
      invalid('Web Push endpoint must be an approved canonical HTTPS URL');
    }
    return endpoint;
  } catch (error) {
    if (error instanceof AppError) throw error;
    invalid('Web Push endpoint must be an approved canonical HTTPS URL');
  }
}

export function parseCreateWebPushSubscription(body: unknown): CreateWebPushSubscription {
  if (!isRecord(body) || !hasExactKeys(body, ['endpoint', 'expirationTime', 'keys'])) {
    invalid('Web Push subscription body has unknown fields');
  }
  if (!isRecord(body.keys) || !hasExactKeys(body.keys, ['auth', 'p256dh'])) {
    invalid('Web Push subscription keys have unknown fields');
  }
  if (
    typeof body.endpoint !== 'string'
    || body.endpoint.length < 1
    || body.endpoint.length > 2048
  ) {
    invalid('Web Push endpoint must be a non-empty string up to 2048 characters');
  }
  if (
    body.expirationTime !== null
    && (
      typeof body.expirationTime !== 'number'
      || !Number.isFinite(body.expirationTime)
      || body.expirationTime < 0
    )
  ) {
    invalid('Web Push expirationTime must be null or a finite non-negative number');
  }

  return {
    endpoint: parseApprovedPushEndpoint(body.endpoint),
    expirationTime: body.expirationTime,
    keys: {
      p256dh: readKey(body.keys.p256dh, 'p256dh'),
      auth: readKey(body.keys.auth, 'auth'),
    },
  };
}
