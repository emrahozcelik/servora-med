import { ApiError } from '../services/api';
import {
  createWebPushSubscription,
  disableWebPushSubscription,
  getWebPushStatus,
  type CreateWebPushSubscriptionRequest,
  type WebPushStatus,
} from '../services/web-push-api';
import {
  asCreateWebPushSubscription,
  isRecoverableSubscriptionReadError,
  type BrowserWebPushAdapter,
  type BrowserWebPushCapability,
  type BrowserWebPushPermission,
  type BrowserPushSubscription,
} from './BrowserWebPushAdapter';

export type WebPushGuidance = 'none' | 'disabled' | 'unsupported' | 'denied' | 'install-required' | 'renewal-required';
export type WebPushSnapshot = Readonly<{
  enabled: boolean | null;
  status: WebPushStatus | null;
  capability: BrowserWebPushCapability;
  permission: BrowserWebPushPermission;
  guidance: WebPushGuidance;
  pending: 'enable' | 'disable' | null;
  error: string;
}>;

export type WebPushApi = Readonly<{
  getStatus: () => Promise<WebPushStatus>;
  createSubscription: (input: CreateWebPushSubscriptionRequest) => Promise<unknown>;
  disableSubscription: (subscriptionId: string) => Promise<void>;
}>;

type RecoveryTarget = Pick<Window, 'addEventListener' | 'removeEventListener'> & {
  document?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
};

export type ServiceWorkerMessageTarget = Pick<
  ServiceWorkerContainer,
  'addEventListener' | 'removeEventListener'
>;

type PushSubscriptionChangedMessage = Readonly<{
  type: 'push-subscription-changed';
}>;

function isPushSubscriptionChangedMessage(
  value: unknown,
): value is PushSubscriptionChangedMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 1 && record.type === 'push-subscription-changed';
}

const inertTarget: RecoveryTarget = {
  addEventListener: () => {},
  removeEventListener: () => {},
};

export type WebPushController = Readonly<{
  start: (identityKey: string) => Promise<void>;
  stop: () => void;
  setIdentity: (identityKey: string | null) => Promise<void>;
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => WebPushSnapshot;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  recover: () => Promise<void>;
  clearLocalSubscription: () => Promise<void>;
}>;

const emptySnapshot: WebPushSnapshot = {
  enabled: null,
  status: null,
  capability: 'unsupported',
  permission: 'unsupported',
  guidance: 'none',
  pending: null,
  error: '',
};

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function guidanceFor(
  status: WebPushStatus | null,
  capability: BrowserWebPushCapability,
  permission: BrowserWebPushPermission,
  standalone: boolean,
): WebPushGuidance {
  if (status?.enabled === false) return 'disabled';
  if (status?.renewalRequired) return 'renewal-required';
  if (capability === 'unsupported') return standalone ? 'unsupported' : 'install-required';
  if (permission === 'denied') return 'denied';
  return 'none';
}

function currentBrowserState(browser: BrowserWebPushAdapter) {
  return {
    capability: browser.capability(),
    permission: browser.permission(),
    standalone: browser.isStandalone(),
  };
}

export function createWebPushController({
  api = {
    getStatus: getWebPushStatus,
    createSubscription: createWebPushSubscription,
    disableSubscription: disableWebPushSubscription,
  },
  browser,
  target = typeof window === 'undefined' ? inertTarget : window,
  serviceWorkerTarget = typeof navigator === 'undefined' ? undefined : navigator.serviceWorker,
}: Readonly<{
  api?: WebPushApi;
  browser: BrowserWebPushAdapter;
  target?: RecoveryTarget;
  serviceWorkerTarget?: ServiceWorkerMessageTarget;
}>): WebPushController {
  type RecoveryState = Readonly<{
    generation: number;
    promise: Promise<void>;
  }>;

  const listeners = new Set<() => void>();
  let snapshot = emptySnapshot;
  let identityKey: string | null = null;
  let generation = 0;
  let started = false;
  let operation: Promise<void> | null = null;
  let recovery: RecoveryState | null = null;

  const publish = (next: WebPushSnapshot) => {
    snapshot = next;
    listeners.forEach((listener) => listener());
  };
  const browserState = () => currentBrowserState(browser);
  const settle = (status: WebPushStatus | null, error = '', pending: WebPushSnapshot['pending'] = null) => {
    const state = browserState();
    publish({
      enabled: status?.enabled ?? null,
      status,
      capability: state.capability,
      permission: state.permission,
      guidance: guidanceFor(status, state.capability, state.permission, state.standalone),
      pending,
      error,
    });
  };

  const refreshStatus = async (expectedGeneration = generation): Promise<WebPushStatus | null> => {
    if (!identityKey) return null;
    try {
      const status = await api.getStatus();
      if (expectedGeneration !== generation || !identityKey) return null;
      settle(status);
      return status;
    } catch (error) {
      if (expectedGeneration === generation) settle(snapshot.status, errorMessage(error, 'Cihaz bildirimi durumu yüklenemedi.'));
      return null;
    }
  };

  const recover = async () => {
    const expectedGeneration = generation;
    if (recovery?.generation === expectedGeneration) {
      return recovery.promise;
    }

    const promise = (async () => {
      const status = await refreshStatus(expectedGeneration);
      if (!status || expectedGeneration !== generation || !status.enabled || !status.subscription || status.renewalRequired) return;
      const state = browserState();
      if (state.capability !== 'supported' || state.permission !== 'granted') return;
      const subscription = await browser.currentSubscription();
      if (expectedGeneration !== generation) return;
      if (!subscription) {
        await api.disableSubscription(status.subscription.id);
        await refreshStatus(expectedGeneration);
        return;
      }
      const fingerprint = await browser.fingerprint(subscription);
      if (expectedGeneration !== generation || fingerprint === status.subscription.fingerprint) return;
      await api.createSubscription(asCreateWebPushSubscription(subscription));
      await refreshStatus(expectedGeneration);
    })().catch((error) => {
      if (expectedGeneration === generation) {
        settle(snapshot.status, errorMessage(error, 'Cihaz bildirimi mutabakatı tamamlanamadı.'));
      }
    }).finally(() => {
      // Only clear if this promise is still the active generation-scoped recovery.
      if (recovery?.promise === promise) {
        recovery = null;
      }
    });

    recovery = { generation: expectedGeneration, promise };
    return promise;
  };

  const onRecoverySignal = () => { void recover(); };
  const onVisibility = () => {
    if (target.document?.visibilityState !== 'hidden') void recover();
  };
  const onServiceWorkerMessage = (event: Event) => {
    const messageEvent = event as MessageEvent<unknown>;
    if (!isPushSubscriptionChangedMessage(messageEvent.data)) return;
    void recover();
  };

  const enable = async () => {
    if (operation) return operation;
    const expectedGeneration = generation;
    operation = (async () => {
      const status = snapshot.status ?? await refreshStatus(expectedGeneration);
      if (!status || expectedGeneration !== generation || !status.enabled) return;
      const state = browserState();
      if (state.capability !== 'supported') {
        settle(status);
        return;
      }
      let permission = state.permission;
      if (permission === 'default') permission = await browser.requestPermission();
      if (expectedGeneration !== generation || permission !== 'granted') {
        settle(status);
        return;
      }
      settle(status, '', 'enable');
      // Explicit enable only: recoverable getSubscription failures may fall
      // through to one subscribe(). Recovery paths must not use this fallback.
      let subscription: BrowserPushSubscription | null;
      try {
        subscription = await browser.currentSubscription();
      } catch (error) {
        if (!isRecoverableSubscriptionReadError(error)) throw error;
        subscription = null;
      }
      if (status.renewalRequired && subscription) {
        await browser.unsubscribe(subscription);
        subscription = null;
      }
      if (!subscription) subscription = await browser.subscribe(status.vapidPublicKey!);
      if (expectedGeneration !== generation) return;
      try {
        await api.createSubscription(asCreateWebPushSubscription(subscription));
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 409 || error.code !== 'PUSH_SUBSCRIPTION_CONFLICT') throw error;
        await browser.unsubscribe(subscription);
        const rotated = await browser.subscribe(status.vapidPublicKey!);
        await api.createSubscription(asCreateWebPushSubscription(rotated));
      }
      await refreshStatus(expectedGeneration);
    })().catch((error) => {
      if (expectedGeneration === generation) settle(snapshot.status, errorMessage(error, 'Cihaz bildirimleri açılamadı.'));
    }).finally(() => { operation = null; });
    return operation;
  };

  const disable = async () => {
    if (operation) return operation;
    const expectedGeneration = generation;
    operation = (async () => {
      const status = snapshot.status ?? await refreshStatus(expectedGeneration);
      if (!status?.subscription || expectedGeneration !== generation) return;
      settle(status, '', 'disable');
      await api.disableSubscription(status.subscription.id);
      try {
        const subscription = await browser.currentSubscription();
        if (subscription) await browser.unsubscribe(subscription);
      } catch {
        // Server disablement is authoritative; browser cleanup is best effort.
      }
      await refreshStatus(expectedGeneration);
    })().catch((error) => {
      if (expectedGeneration === generation) settle(snapshot.status, errorMessage(error, 'Cihaz bildirimleri kapatılamadı.'));
    }).finally(() => { operation = null; });
    return operation;
  };

  const clearLocalSubscription = async () => {
    try {
      const subscription = await browser.currentSubscription();
      if (subscription) await browser.unsubscribe(subscription);
    } catch {
      // Server session revocation is authoritative; local cleanup is best effort.
    } finally {
      identityKey = null;
      generation += 1;
      operation = null;
      recovery = null;
      publish(emptySnapshot);
    }
  };

  return {
    async start(nextIdentityKey) {
      if (started && identityKey === nextIdentityKey) return;
      if (!started) {
        started = true;
        target.addEventListener('focus', onRecoverySignal);
        target.addEventListener('online', onRecoverySignal);
        (target.document ?? target).addEventListener('visibilitychange', onVisibility);
        serviceWorkerTarget?.addEventListener('message', onServiceWorkerMessage);
      }
      await this.setIdentity(nextIdentityKey);
      await recover();
    },
    stop() {
      if (!started) return;
      target.removeEventListener('focus', onRecoverySignal);
      target.removeEventListener('online', onRecoverySignal);
      (target.document ?? target).removeEventListener('visibilitychange', onVisibility);
      serviceWorkerTarget?.removeEventListener('message', onServiceWorkerMessage);
      started = false;
      identityKey = null;
      generation += 1;
      operation = null;
      recovery = null;
      publish(emptySnapshot);
    },
    async setIdentity(nextIdentityKey) {
      if (identityKey === nextIdentityKey) return;
      identityKey = nextIdentityKey;
      generation += 1;
      settle(null);
      if (!nextIdentityKey) return;
      await refreshStatus(generation);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    enable,
    disable,
    recover,
    clearLocalSubscription,
  };
}
