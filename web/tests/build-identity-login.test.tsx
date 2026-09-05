/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../src/App';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('login build identity', () => {
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
  });

  it('renders build identity without requiring API success', async () => {
    await act(async () => root.render(
      <MemoryRouter initialEntries={['/login']}>
        <App initialUser={null} />
      </MemoryRouter>,
    ));

    const identity = container.querySelector('.build-identity');
    expect(identity).not.toBeNull();
    expect(identity?.textContent).toContain('Servora Med 0.1.0');
    expect(identity?.textContent).not.toContain('undefined');
    expect(identity?.getAttribute('data-build-sha')?.trim()).not.toBe('');

    // Login remains functional: primary action and help region are intact.
    expect(container.querySelector('#login-title')).not.toBeNull();
    expect(container.querySelector('button[type="submit"]')?.textContent).toContain('Giriş yap');
    expect(container.querySelector('#login-help')).not.toBeNull();

    // Secondary metadata sits below the form, not above the primary action.
    const form = container.querySelector('.login-form-wrap form');
    const loginHelp = container.querySelector('#login-help');
    expect(form).not.toBeNull();
    expect(loginHelp).not.toBeNull();
    expect(
      (identity as Element).compareDocumentPosition(form as Element)
        & Node.DOCUMENT_POSITION_PRECEDING,
    ).not.toBe(0);
  });
});
