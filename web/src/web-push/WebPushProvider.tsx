import { createContext, useContext, useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';

import { createBrowserWebPushAdapter } from './BrowserWebPushAdapter';
import { createWebPushController, type WebPushController, type WebPushSnapshot } from './WebPushController';

const unsupportedSnapshot: WebPushSnapshot = {
  enabled: false,
  status: null,
  capability: 'unsupported',
  permission: 'unsupported',
  guidance: 'disabled',
  pending: null,
  error: '',
};

const unsupportedController: WebPushController = {
  start: async () => {},
  stop: () => {},
  setIdentity: async () => {},
  subscribe: () => () => {},
  getSnapshot: () => unsupportedSnapshot,
  enable: async () => {},
  disable: async () => {},
  recover: async () => {},
  clearLocalSubscription: async () => {},
};

const WebPushContext = createContext<WebPushController>(unsupportedController);

export function WebPushProvider({
  identityKey,
  controller,
  children,
}: Readonly<{ identityKey: string; controller?: WebPushController; children: ReactNode }>) {
  const ownedController = useRef<WebPushController | null>(null);
  if (!ownedController.current) {
    ownedController.current = controller ?? createWebPushController({
      browser: createBrowserWebPushAdapter(),
    });
  }
  const resolvedController = ownedController.current;

  useEffect(() => {
    void resolvedController.start(identityKey);
    return () => resolvedController.stop();
  }, [identityKey, resolvedController]);

  return <WebPushContext.Provider value={resolvedController}>{children}</WebPushContext.Provider>;
}

export function useWebPush() {
  const controller = useContext(WebPushContext);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  return {
    ...snapshot,
    enable: controller.enable,
    disable: controller.disable,
    clearLocalSubscription: controller.clearLocalSubscription,
  };
}
