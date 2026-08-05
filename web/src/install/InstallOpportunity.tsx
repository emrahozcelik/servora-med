import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';

type InstallChoice = Readonly<{
  outcome: 'accepted' | 'dismissed';
  platform: string;
}>;

type BeforeInstallPromptEvent = Event & Readonly<{
  prompt: () => Promise<void>;
  userChoice: Promise<InstallChoice>;
}>;

/** Versioned device-local dismissal key for the Apple install guidance card. */
export const INSTALL_GUIDANCE_DISMISS_KEY = 'servora.install-guidance.dismissed.v1';

export type InstallOpportunitySnapshot = Readonly<{
  canPrompt: boolean;
  installed: boolean;
  outcome: InstallChoice['outcome'] | null;
  appleCandidate: boolean;
  guidanceDismissed: boolean;
  shouldOfferAppleGuidance: boolean;
}>;

export type InstallOpportunityController = Readonly<{
  start: () => void;
  stop: () => void;
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => InstallOpportunitySnapshot;
  prompt: () => Promise<void>;
  dismissGuidance: () => void;
  resetGuidance: () => void;
}>;

const emptySnapshot: InstallOpportunitySnapshot = {
  canPrompt: false,
  installed: false,
  outcome: null,
  appleCandidate: false,
  guidanceDismissed: false,
  shouldOfferAppleGuidance: false,
};

export function createInstallOpportunityController(target: Window): InstallOpportunityController {
  const listeners = new Set<() => void>();
  let retainedEvent: BeforeInstallPromptEvent | null = null;
  let started = false;
  let snapshot = emptySnapshot;
  let dismissedInMemory = false;

  const publish = (next: Partial<InstallOpportunitySnapshot>) => {
    const merged = { ...emptySnapshot, ...next };
    const guidanceDismissed = readGuidanceDismissed();
    const isAppleCandidate = appleCandidate();
    snapshot = {
      ...merged,
      appleCandidate: isAppleCandidate,
      guidanceDismissed,
      shouldOfferAppleGuidance: !merged.installed && !merged.canPrompt
        && isAppleCandidate && !guidanceDismissed,
    };
    listeners.forEach((listener) => listener());
  };

  const standalone = () => {
    if (target.matchMedia?.('(display-mode: standalone)').matches) return true;
    const native = (target.navigator as (Navigator & { standalone?: boolean })).standalone;
    return native === true;
  };

  const appleCandidate = () => {
    const navigator = target.navigator;
    const ua = typeof navigator.userAgent === 'string' ? navigator.userAgent : '';
    const platform = typeof navigator.platform === 'string' ? navigator.platform.toLowerCase() : '';
    const touch = typeof navigator.maxTouchPoints === 'number' ? navigator.maxTouchPoints > 0 : false;
    const appleMobile = /iphone|ipod|ipad/i.test(ua) || /iphone|ipod|ipad/i.test(platform);
    const ipadDesktopClass = platform.includes('mac') && touch;
    return appleMobile || ipadDesktopClass;
  };

  function readGuidanceDismissed() {
    if (dismissedInMemory) return true;
    try {
      return target.localStorage?.getItem(INSTALL_GUIDANCE_DISMISS_KEY) === '1';
    } catch {
      return dismissedInMemory;
    }
  }

  function writeGuidanceDismissed(value: boolean) {
    dismissedInMemory = value;
    try {
      if (value) target.localStorage?.setItem(INSTALL_GUIDANCE_DISMISS_KEY, '1');
      else target.localStorage?.removeItem(INSTALL_GUIDANCE_DISMISS_KEY);
    } catch {
      // Storage unavailable: dismissal stays effective for the session.
    }
  }

  const beforeInstall = (rawEvent: Event) => {
    if (standalone()) return;
    const event = rawEvent as BeforeInstallPromptEvent;
    event.preventDefault();
    retainedEvent = event;
    publish({ canPrompt: true, installed: false, outcome: null });
  };
  const installed = () => {
    retainedEvent = null;
    publish({ canPrompt: false, installed: true, outcome: 'accepted' });
  };

  return {
    start() {
      if (started) return;
      started = true;
      publish({ canPrompt: false, installed: standalone(), outcome: null });
      target.addEventListener('beforeinstallprompt', beforeInstall);
      target.addEventListener('appinstalled', installed);
    },
    stop() {
      if (!started) return;
      target.removeEventListener('beforeinstallprompt', beforeInstall);
      target.removeEventListener('appinstalled', installed);
      retainedEvent = null;
      started = false;
      publish(emptySnapshot);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    async prompt() {
      const event = retainedEvent;
      if (!event) return;
      retainedEvent = null;
      publish({ canPrompt: false, installed: false, outcome: null });
      await event.prompt();
      const choice = await event.userChoice;
      publish({ canPrompt: false, installed: choice.outcome === 'accepted', outcome: choice.outcome });
    },
    dismissGuidance() {
      writeGuidanceDismissed(true);
      publish({ ...snapshot, canPrompt: false, installed: snapshot.installed, outcome: snapshot.outcome });
    },
    resetGuidance() {
      writeGuidanceDismissed(false);
      publish({ ...snapshot, canPrompt: false, installed: snapshot.installed, outcome: snapshot.outcome });
    },
  };
}

const unsupportedController: InstallOpportunityController = {
  start: () => {},
  stop: () => {},
  subscribe: () => () => {},
  getSnapshot: () => emptySnapshot,
  prompt: async () => {},
  dismissGuidance: () => {},
  resetGuidance: () => {},
};

const InstallOpportunityContext = createContext<InstallOpportunityController>(unsupportedController);

export function InstallOpportunityProvider({
  controller,
  children,
}: Readonly<{ controller: InstallOpportunityController; children: ReactNode }>) {
  return <InstallOpportunityContext.Provider value={controller}>{children}</InstallOpportunityContext.Provider>;
}

export function useInstallOpportunity() {
  const controller = useContext(InstallOpportunityContext);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  return { ...state, prompt: controller.prompt, dismissGuidance: controller.dismissGuidance, resetGuidance: controller.resetGuidance };
}
