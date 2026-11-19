/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../src/App';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function stubMatchMedia(matchesDesktop: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: matchesDesktop,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

function dispatchCapsLock(input: HTMLInputElement, pressed: boolean, type = 'keydown') {
  const event = new KeyboardEvent(type, { key: 'A', bubbles: true });
  Object.defineProperty(event, 'getModifierState', {
    value: (key: string) => key === 'CapsLock' && pressed,
  });
  input.dispatchEvent(event);
}

describe('login screen interactions', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs?.();
  });

  async function renderLogin() {
    await act(async () => root.render(
      <MemoryRouter initialEntries={['/login']}>
        <App initialUser={null} />
      </MemoryRouter>,
    ));
  }

  it('toggles password visibility by mouse and keyboard with pressed state', async () => {
    stubMatchMedia(false);
    await renderLogin();

    const input = container.querySelector('#password') as HTMLInputElement;
    const toggle = container.querySelector('.password-toggle') as HTMLButtonElement;

    expect(input.type).toBe('password');
    expect(input.autocomplete).toBe('current-password');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.getAttribute('aria-label')).toBe('Parolayı göster');
    expect(toggle.textContent).toBe('Göster');

    await act(async () => toggle.click());
    expect(input.type).toBe('text');
    expect(input.autocomplete).toBe('current-password');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toBe('Parolayı gizle');
    expect(toggle.textContent).toBe('Gizle');

    await act(async () => toggle.click());
    expect(input.type).toBe('password');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
  });

  it('announces caps lock politely while it is active on the password field', async () => {
    stubMatchMedia(false);
    await renderLogin();

    const input = container.querySelector('#password') as HTMLInputElement;
    const hint = container.querySelector('#password-caps-hint') as HTMLParagraphElement;
    expect(hint.getAttribute('role')).toBe('status');
    expect(hint.textContent).toBe('');

    await act(async () => dispatchCapsLock(input, true));
    expect(hint.textContent).toBe('Caps Lock açık.');

    await act(async () => dispatchCapsLock(input, false, 'keyup'));
    expect(hint.textContent).toBe('');
  });

  it('drops the caps lock hint when the field is left', async () => {
    stubMatchMedia(false);
    await renderLogin();

    const input = container.querySelector('#password') as HTMLInputElement;
    const hint = container.querySelector('#password-caps-hint') as HTMLParagraphElement;

    await act(async () => dispatchCapsLock(input, true));
    expect(hint.textContent).toBe('Caps Lock açık.');

    await act(async () => {
      input.focus();
      input.blur();
    });
    expect(hint.textContent).toBe('');
  });

  it('focuses e-mail on desktop only, so mobile does not open the keyboard', async () => {
    stubMatchMedia(true);
    await renderLogin();
    expect(document.activeElement?.id).toBe('email');

    await act(async () => root.unmount());
    stubMatchMedia(false);
    root = createRoot(container);
    await renderLogin();
    expect(document.activeElement?.id).not.toBe('email');
  });

  it('does not steal focus from the identity error when login opens with one', async () => {
    stubMatchMedia(true);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
      headers: { get: () => null },
    }));

    await act(async () => root.render(
      <MemoryRouter initialEntries={['/login']}>
        <App />
      </MemoryRouter>,
    ));
    await act(async () => { await Promise.resolve(); });

    const alert = container.querySelector('[role="alert"]') as HTMLDivElement;
    expect(alert).not.toBeNull();
    expect(document.activeElement).toBe(alert);
    expect(document.activeElement?.id).not.toBe('email');
  });
});
