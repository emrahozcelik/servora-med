import type { CreateWebPushSubscriptionRequest } from '../services/web-push-api';

export type BrowserWebPushPermission = NotificationPermission | 'unsupported';
export type BrowserWebPushCapability = 'supported' | 'unsupported';

export type BrowserPushSubscription = Readonly<{
  endpoint: string;
  expirationTime: number | null;
  keys: Readonly<{ p256dh: string; auth: string }>;
  unsubscribe: () => Promise<boolean>;
}>;

type BrowserPushManager = Readonly<{
  getSubscription: () => Promise<PushSubscription | null>;
  subscribe: (options: PushSubscriptionOptionsInit) => Promise<PushSubscription>;
}>;

type BrowserRegistration = Readonly<{ pushManager: BrowserPushManager }>;

type BrowserServiceWorkerContainer = Readonly<{
  register: (scriptURL: string, options: RegistrationOptions) => Promise<BrowserRegistration>;
  ready: Promise<BrowserRegistration>;
}>;

export type BrowserWebPushEnvironment = Readonly<{
  Notification?: typeof Notification;
  PushManager?: unknown;
  navigator: Readonly<{
    standalone?: boolean;
    serviceWorker?: BrowserServiceWorkerContainer;
  }>;
  matchMedia?: (query: string) => Pick<MediaQueryList, 'matches'>;
}>;

export type BrowserWebPushAdapterOptions = Readonly<{
  readyTimeoutMs?: number;
}>;

export type BrowserWebPushAdapter = Readonly<{
  capability: () => BrowserWebPushCapability;
  permission: () => BrowserWebPushPermission;
  isStandalone: () => boolean;
  requestPermission: () => Promise<NotificationPermission>;
  currentSubscription: () => Promise<BrowserPushSubscription | null>;
  subscribe: (vapidPublicKey: string) => Promise<BrowserPushSubscription>;
  unsubscribe: (subscription: BrowserPushSubscription) => Promise<boolean>;
  fingerprint: (subscription: BrowserPushSubscription) => Promise<string>;
}>;

/** `navigator.serviceWorker.ready` never rejects; bound waits so enable cannot hang forever. */
export const SERVICE_WORKER_READY_TIMEOUT_MS = 10_000;
export const SERVICE_WORKER_READY_TIMEOUT_CODE = 'SERVICE_WORKER_READY_TIMEOUT';

export const SERVICE_WORKER_READY_TIMEOUT_MESSAGE =
  'Cihaz bildirimi servisi hazırlanamadı. Sayfayı yenileyip yeniden deneyin.';
export const SUBSCRIPTION_READ_ERROR_MESSAGE =
  'Cihaz bildirimi aboneliği alınamadı. Sayfayı yenileyip yeniden deneyin.';
export const SUBSCRIPTION_CREATE_ERROR_MESSAGE =
  'Cihaz bildirimi aboneliği oluşturulamadı. Sayfayı yenileyip yeniden deneyin.';

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

function subscriptionFrom(browser: PushSubscription): BrowserPushSubscription {
  const value = browser.toJSON();
  const endpoint = value.endpoint;
  const p256dh = value.keys?.p256dh;
  const auth = value.keys?.auth;
  if (!endpoint || !p256dh || !auth) {
    throw new Error('Tarayıcı cihaz bildirimi aboneliği geçersiz.');
  }
  return {
    endpoint,
    expirationTime: value.expirationTime ?? null,
    keys: { p256dh, auth },
    unsubscribe: () => browser.unsubscribe(),
  };
}

export function decodeWebPushVapidKey(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** Clean ArrayBuffer-backed key for PushManager.subscribe (Firefox/Chrome). */
export function applicationServerKeyFromVapid(value: string): Uint8Array<ArrayBuffer> {
  const decoded = decodeWebPushVapidKey(value);
  return Uint8Array.from(decoded) as Uint8Array<ArrayBuffer>;
}

/**
 * Transient worker readiness failures only — explicit enable may fall through to subscribe().
 * Ready timeout, permission, and validation errors are not recoverable here.
 */
export function isRecoverableSubscriptionReadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'AbortError' || error.name === 'InvalidStateError';
}

function isReadyTimeoutError(error: unknown): boolean {
  return error instanceof Error && (
    error.message === SERVICE_WORKER_READY_TIMEOUT_CODE
    || error.message === SERVICE_WORKER_READY_TIMEOUT_MESSAGE
  );
}

function withPreservedName(message: string, error: unknown): Error {
  const next = new Error(message);
  if (error instanceof Error && error.name) next.name = error.name;
  return next;
}

function normalizeReadyOrReadError(error: unknown): Error {
  if (isReadyTimeoutError(error)) {
    return new Error(SERVICE_WORKER_READY_TIMEOUT_MESSAGE);
  }
  if (error instanceof Error && error.message === SUBSCRIPTION_READ_ERROR_MESSAGE) return error;
  if (error instanceof Error && error.message === SUBSCRIPTION_CREATE_ERROR_MESSAGE) return error;
  if (error instanceof Error && error.message === SERVICE_WORKER_READY_TIMEOUT_MESSAGE) return error;
  return withPreservedName(SUBSCRIPTION_READ_ERROR_MESSAGE, error);
}

function normalizeReadyOrCreateError(error: unknown): Error {
  if (isReadyTimeoutError(error)) {
    return new Error(SERVICE_WORKER_READY_TIMEOUT_MESSAGE);
  }
  if (error instanceof Error && error.message === SUBSCRIPTION_CREATE_ERROR_MESSAGE) return error;
  if (error instanceof Error && error.message === SERVICE_WORKER_READY_TIMEOUT_MESSAGE) return error;
  return withPreservedName(SUBSCRIPTION_CREATE_ERROR_MESSAGE, error);
}

/**
 * Register fixed SW, then wait (bounded) for an active registration via ready.
 * Late ready resolution after timeout does not drive push mutations — callers
 * only observe the race winner.
 */
export async function waitForReadyRegistration(
  serviceWorker: BrowserServiceWorkerContainer,
  timeoutMs: number = SERVICE_WORKER_READY_TIMEOUT_MS,
): Promise<BrowserRegistration> {
  await serviceWorker.register('/service-worker.js', {
    scope: '/',
    updateViaCache: 'none',
  });

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  try {
    return await new Promise<BrowserRegistration>((resolve, reject) => {
      timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(SERVICE_WORKER_READY_TIMEOUT_CODE));
      }, timeoutMs);

      void serviceWorker.ready.then(
        (registration) => {
          if (settled) return;
          settled = true;
          resolve(registration);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

export function asCreateWebPushSubscription(
  subscription: BrowserPushSubscription,
): CreateWebPushSubscriptionRequest {
  return {
    endpoint: subscription.endpoint,
    expirationTime: subscription.expirationTime,
    keys: subscription.keys,
  };
}

export async function fingerprintBrowserWebPushSubscription(subscription: BrowserPushSubscription): Promise<string> {
  const source = `${subscription.endpoint}\n${subscription.keys.p256dh}\n${subscription.keys.auth}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function createBrowserWebPushAdapter(
  environment: BrowserWebPushEnvironment | undefined = typeof window === 'undefined' ? undefined : window,
  options: BrowserWebPushAdapterOptions = {},
): BrowserWebPushAdapter {
  const resolvedEnvironment = environment ?? { navigator: {} };
  const readyTimeoutMs = options.readyTimeoutMs ?? SERVICE_WORKER_READY_TIMEOUT_MS;
  const supported = () => Boolean(
    resolvedEnvironment.Notification
    && resolvedEnvironment.PushManager
    && resolvedEnvironment.navigator.serviceWorker,
  );

  const activeRegistration = async (): Promise<BrowserRegistration> => {
    const serviceWorker = required(
      resolvedEnvironment.navigator.serviceWorker,
      'Service worker desteklenmiyor.',
    );
    return waitForReadyRegistration(serviceWorker, readyTimeoutMs);
  };

  return {
    capability: () => supported() ? 'supported' : 'unsupported',
    permission: () => resolvedEnvironment.Notification?.permission ?? 'unsupported',
    isStandalone: () => Boolean(
      resolvedEnvironment.navigator.standalone
      || resolvedEnvironment.matchMedia?.('(display-mode: standalone)').matches,
    ),
    requestPermission: async () => required(resolvedEnvironment.Notification, 'Bildirim API’si desteklenmiyor.')
      .requestPermission(),
    async currentSubscription() {
      if (!supported()) return null;
      try {
        const current = await (await activeRegistration()).pushManager.getSubscription();
        return current ? subscriptionFrom(current) : null;
      } catch (error) {
        // Never map failures to null — recovery would wrongly disable a server record.
        throw normalizeReadyOrReadError(error);
      }
    },
    async subscribe(vapidPublicKey) {
      if (!supported()) throw new Error('Cihaz bildirimleri bu tarayıcıda desteklenmiyor.');
      try {
        const applicationServerKey = applicationServerKeyFromVapid(vapidPublicKey);
        const created = await (await activeRegistration()).pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey,
        });
        return subscriptionFrom(created);
      } catch (error) {
        throw normalizeReadyOrCreateError(error);
      }
    },
    unsubscribe: (subscription) => subscription.unsubscribe(),
    fingerprint: fingerprintBrowserWebPushSubscription,
  };
}
