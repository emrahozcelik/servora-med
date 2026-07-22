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

export type BrowserWebPushEnvironment = Readonly<{
  Notification?: typeof Notification;
  PushManager?: unknown;
  navigator: Readonly<{
    standalone?: boolean;
    serviceWorker?: Readonly<{
      register: (scriptURL: string, options: RegistrationOptions) => Promise<BrowserRegistration>;
    }>;
  }>;
  matchMedia?: (query: string) => Pick<MediaQueryList, 'matches'>;
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
): BrowserWebPushAdapter {
  const resolvedEnvironment = environment ?? { navigator: {} };
  const supported = () => Boolean(
    resolvedEnvironment.Notification
    && resolvedEnvironment.PushManager
    && resolvedEnvironment.navigator.serviceWorker,
  );
  const registration = async () => required(resolvedEnvironment.navigator.serviceWorker, 'Service worker desteklenmiyor.')
    .register('/service-worker.js', { scope: '/', updateViaCache: 'none' });

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
      const current = await (await registration()).pushManager.getSubscription();
      return current ? subscriptionFrom(current) : null;
    },
    async subscribe(vapidPublicKey) {
      if (!supported()) throw new Error('Cihaz bildirimleri bu tarayıcıda desteklenmiyor.');
      const applicationServerKey = new Uint8Array(decodeWebPushVapidKey(vapidPublicKey)) as Uint8Array<ArrayBuffer>;
      const created = await (await registration()).pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });
      return subscriptionFrom(created);
    },
    unsubscribe: (subscription) => subscription.unsubscribe(),
    fingerprint: fingerprintBrowserWebPushSubscription,
  };
}
