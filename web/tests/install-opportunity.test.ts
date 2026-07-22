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
});
