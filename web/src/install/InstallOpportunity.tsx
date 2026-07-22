import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';

type InstallChoice = Readonly<{
  outcome: 'accepted' | 'dismissed';
  platform: string;
}>;

type BeforeInstallPromptEvent = Event & Readonly<{
  prompt: () => Promise<void>;
  userChoice: Promise<InstallChoice>;
}>;

export type InstallOpportunitySnapshot = Readonly<{
  canPrompt: boolean;
  installed: boolean;
  outcome: InstallChoice['outcome'] | null;
}>;

export type InstallOpportunityController = Readonly<{
  start: () => void;
  stop: () => void;
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => InstallOpportunitySnapshot;
  prompt: () => Promise<void>;
}>;

const emptySnapshot: InstallOpportunitySnapshot = {
  canPrompt: false,
  installed: false,
  outcome: null,
};

export function createInstallOpportunityController(target: Window): InstallOpportunityController {
  const listeners = new Set<() => void>();
  let retainedEvent: BeforeInstallPromptEvent | null = null;
  let started = false;
  let snapshot = emptySnapshot;

  const publish = (next: InstallOpportunitySnapshot) => {
    snapshot = next;
    listeners.forEach((listener) => listener());
  };
  const standalone = () => target.matchMedia?.('(display-mode: standalone)').matches ?? false;
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
      snapshot = { ...emptySnapshot, installed: standalone() };
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
  };
}

const unsupportedController: InstallOpportunityController = {
  start: () => {},
  stop: () => {},
  subscribe: () => () => {},
  getSnapshot: () => emptySnapshot,
  prompt: async () => {},
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
  return { ...state, prompt: controller.prompt };
}
