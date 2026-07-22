import {
  ApiError,
  boolean,
  json,
  object,
  request,
  string,
} from './api';

export type WebPushPublicSubscription = Readonly<{
  id: string;
  createdAt: string;
  fingerprint: string;
}>;
export type WebPushStatus = Readonly<{
  enabled: boolean;
  vapidPublicKey: string | null;
  renewalRequired: boolean;
  subscription: WebPushPublicSubscription | null;
}>;
export type CreateWebPushSubscriptionRequest = Readonly<{
  endpoint: string;
  expirationTime: number | null;
  keys: Readonly<{ p256dh: string; auth: string }>;
}>;

function invalid(field: string, kind: 'REQUEST' | 'RESPONSE' = 'RESPONSE'): never {
  throw new ApiError(
    0,
    `INVALID_${kind}`,
    `${kind === 'REQUEST' ? 'İstekte' : 'Yanıtta'} ${field} alanı geçersiz.`,
  );
}

function exact(value: Record<string, unknown>, fields: readonly string[], kind: 'REQUEST' | 'RESPONSE' = 'RESPONSE') {
  if (Object.keys(value).length !== fields.length
    || Object.keys(value).some((key) => !fields.includes(key))) invalid('webPush', kind);
}

function instant(value: unknown, field: string): string {
  const parsed = string(value, field);
  const date = new Date(parsed);
  if (Number.isNaN(date.valueOf()) || date.toISOString() !== parsed) invalid(field);
  return parsed;
}

function parsePublicSubscription(value: unknown): WebPushPublicSubscription {
  const subscription = object(value);
  exact(subscription, ['id', 'createdAt', 'fingerprint']);
  const fingerprint = string(subscription.fingerprint, 'fingerprint');
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) invalid('fingerprint');
  return {
    id: string(subscription.id, 'id'),
    createdAt: instant(subscription.createdAt, 'createdAt'),
    fingerprint,
  };
}

export function parseWebPushStatus(value: unknown): WebPushStatus {
  const status = object(value);
  exact(status, ['enabled', 'vapidPublicKey', 'renewalRequired', 'subscription']);
  const enabled = boolean(status.enabled, 'enabled');
  const vapidPublicKey = status.vapidPublicKey === null
    ? null
    : string(status.vapidPublicKey, 'vapidPublicKey');
  if ((enabled && vapidPublicKey === null) || (!enabled && vapidPublicKey !== null)) {
    invalid('vapidPublicKey');
  }
  return {
    enabled,
    vapidPublicKey,
    renewalRequired: boolean(status.renewalRequired, 'renewalRequired'),
    subscription: status.subscription === null
      ? null
      : parsePublicSubscription(status.subscription),
  };
}

export function parseCreateWebPushSubscriptionRequest(
  value: unknown,
): CreateWebPushSubscriptionRequest {
  const input = object(value);
  exact(input, ['endpoint', 'expirationTime', 'keys'], 'REQUEST');
  const keys = object(input.keys);
  exact(keys, ['p256dh', 'auth'], 'REQUEST');
  const expirationTime = input.expirationTime;
  if (expirationTime !== null && (
    typeof expirationTime !== 'number'
    || !Number.isFinite(expirationTime)
    || expirationTime < 0
  )) invalid('expirationTime', 'REQUEST');
  return {
    endpoint: string(input.endpoint, 'endpoint'),
    expirationTime,
    keys: {
      p256dh: string(keys.p256dh, 'p256dh'),
      auth: string(keys.auth, 'auth'),
    },
  };
}

export async function getWebPushStatus(): Promise<WebPushStatus> {
  return parseWebPushStatus(await request('/api/web-push/status'));
}

export async function createWebPushSubscription(input: CreateWebPushSubscriptionRequest) {
  const parsed = parseCreateWebPushSubscriptionRequest(input);
  return parsePublicSubscription(await request(
    '/api/web-push/subscriptions',
    json('POST', parsed),
  ));
}

export async function disableWebPushSubscription(subscriptionId: string): Promise<void> {
  await request(`/api/web-push/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: 'DELETE',
  });
}
