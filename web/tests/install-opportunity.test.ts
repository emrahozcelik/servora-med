/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createInstallOpportunityController } from '../src/install/InstallOpportunity';

describe('install opportunity controller', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('retains an early install event and prompts only after the explicit command', async () => {
    const controller = createInstallOpportunityController(window);
    const prompt = vi.fn().mockResolvedValue(undefined);
    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(event, {
      prompt,
      userChoice: Promise.resolve({ outcome: 'accepted', platform: '' }),
    });

    controller.start();
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ canPrompt: true, installed: false });
    expect(prompt).not.toHaveBeenCalled();

    await controller.prompt();

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toMatchObject({ canPrompt: false, outcome: 'accepted' });
    controller.stop();
  });

  it('consumes a dismissed install event once without prompting again', async () => {
    const controller = createInstallOpportunityController(window);
    const prompt = vi.fn().mockResolvedValue(undefined);
    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(event, {
      prompt,
      userChoice: Promise.resolve({ outcome: 'dismissed', platform: '' }),
    });
    controller.start();
    window.dispatchEvent(event);

    await controller.prompt();
    await controller.prompt();

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toMatchObject({
      canPrompt: false,
      installed: false,
      outcome: 'dismissed',
    });
    controller.stop();
  });

  it('keeps installation prompting hidden in standalone display mode', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
    const controller = createInstallOpportunityController(window);
    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(event, {
      prompt: vi.fn(),
      userChoice: Promise.resolve({ outcome: 'accepted', platform: '' }),
    });

    controller.start();
    window.dispatchEvent(event);

    expect(controller.getSnapshot()).toMatchObject({ canPrompt: false, installed: true });
    controller.stop();
  });

  it('clears a retained opportunity when the browser reports installation', () => {
    const controller = createInstallOpportunityController(window);
    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(event, {
      prompt: vi.fn(),
      userChoice: Promise.resolve({ outcome: 'accepted', platform: '' }),
    });
    controller.start();
    window.dispatchEvent(event);

    window.dispatchEvent(new Event('appinstalled'));

    expect(controller.getSnapshot()).toMatchObject({ canPrompt: false, installed: true });
    controller.stop();
  });

  it('does not expose a consumed install event again when the prompt fails', async () => {
    const controller = createInstallOpportunityController(window);
    const prompt = vi.fn().mockRejectedValue(new Error('Prompt failed'));
    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(event, {
      prompt,
      userChoice: Promise.resolve({ outcome: 'dismissed', platform: '' }),
    });
    controller.start();
    window.dispatchEvent(event);

    await expect(controller.prompt()).rejects.toThrow('Prompt failed');
    await controller.prompt();

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toMatchObject({ canPrompt: false, installed: false });
    controller.stop();
  });

  function stubNavigator(overrides: Partial<Navigator>) {
    for (const key of Object.getOwnPropertyNames(window.navigator)) {
      if (!(key in overrides)) {
        try { delete (window.navigator as Record<string, unknown>)[key]; } catch { /* keep */ }
      }
    }
    for (const [key, value] of Object.entries(overrides)) {
      Object.defineProperty(window.navigator, key, {
        configurable: true,
        value,
      });
    }
  }

  it('recognizes an iPhone Safari candidate for Apple guidance', () => {
    stubNavigator({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1', platform: 'iPhone', maxTouchPoints: 5 });
    const controller = createInstallOpportunityController(window);
    controller.start();
    expect(controller.getSnapshot().appleCandidate).toBe(true);
    expect(controller.getSnapshot().shouldOfferAppleGuidance).toBe(true);
    controller.stop();
  });

  it('recognizes an iPad Safari candidate for Apple guidance', () => {
    stubNavigator({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1', platform: 'iPad', maxTouchPoints: 5 });
    const controller = createInstallOpportunityController(window);
    controller.start();
    expect(controller.getSnapshot().appleCandidate).toBe(true);
    controller.stop();
  });

  it('recognizes an iPad desktop-class candidate via Mac platform plus touch points', () => {
    stubNavigator({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 5 });
    const controller = createInstallOpportunityController(window);
    controller.start();
    expect(controller.getSnapshot().appleCandidate).toBe(true);
    controller.stop();
  });

  it('does not offer Apple guidance on a normal desktop browser', () => {
    stubNavigator({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36', platform: 'Win32', maxTouchPoints: 0 });
    const controller = createInstallOpportunityController(window);
    controller.start();
    expect(controller.getSnapshot().appleCandidate).toBe(false);
    expect(controller.getSnapshot().shouldOfferAppleGuidance).toBe(false);
    controller.stop();
  });

  it('detects standalone mode through iOS navigator.standalone', () => {
    stubNavigator({ standalone: true as unknown as boolean });
    const controller = createInstallOpportunityController(window);
    controller.start();
    expect(controller.getSnapshot().installed).toBe(true);
    expect(controller.getSnapshot().shouldOfferAppleGuidance).toBe(false);
    controller.stop();
  });

  it('persists guidance dismissal and suppresses the offer, then resets it', () => {
    stubNavigator({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1', platform: 'iPhone', maxTouchPoints: 5 });
    const store = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => { store.set(key, value); },
        removeItem: (key: string) => { store.delete(key); },
      },
    });
    const controller = createInstallOpportunityController(window);
    controller.start();
    expect(controller.getSnapshot().shouldOfferAppleGuidance).toBe(true);

    controller.dismissGuidance();
    expect(controller.getSnapshot().guidanceDismissed).toBe(true);
    expect(controller.getSnapshot().shouldOfferAppleGuidance).toBe(false);
    expect(store.has('servora.install-guidance.dismissed.v1')).toBe(true);

    const second = createInstallOpportunityController(window);
    second.start();
    expect(second.getSnapshot().guidanceDismissed).toBe(true);
    expect(second.getSnapshot().shouldOfferAppleGuidance).toBe(false);

    second.resetGuidance();
    expect(second.getSnapshot().guidanceDismissed).toBe(false);
    expect(second.getSnapshot().shouldOfferAppleGuidance).toBe(true);
    expect(store.has('servora.install-guidance.dismissed.v1')).toBe(false);
    second.stop();
    controller.stop();
  });

  it('keeps guidance available for the session when storage access fails', () => {
    stubNavigator({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1', platform: 'iPhone', maxTouchPoints: 5 });
    const getItem = vi.fn().mockImplementation(() => { throw new Error('storage blocked'); });
    const setItem = vi.fn().mockImplementation(() => { throw new Error('storage blocked'); });
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: { getItem, setItem, removeItem: vi.fn() },
    });
    const controller = createInstallOpportunityController(window);
    controller.start();
    expect(controller.getSnapshot().shouldOfferAppleGuidance).toBe(true);
    controller.dismissGuidance();
    expect(controller.getSnapshot().guidanceDismissed).toBe(true);
    expect(controller.getSnapshot().shouldOfferAppleGuidance).toBe(false);
    controller.stop();
  });
});
