/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../src/App';
import { applyDocumentBuildIdentity, createBuildIdentity } from '../src/build-identity';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('login screen release identity', () => {
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

  it('keeps user-facing build metadata off the login screen', async () => {
    await act(async () => root.render(
      <MemoryRouter initialEntries={['/login']}>
        <App initialUser={null} />
      </MemoryRouter>,
    ));

    expect(container.querySelector('.build-identity')).toBeNull();
    expect(container.textContent).not.toContain('Servora Med');
    expect(container.textContent).not.toContain('Servora-Med');

    // Login itself remains complete: title, fields, help and toggle.
    expect(container.querySelector('#login-title')).not.toBeNull();
    expect(container.querySelector('#email')).not.toBeNull();
    expect(container.querySelector('#password')).not.toBeNull();
    expect(container.querySelector('button[type="submit"]')?.textContent).toContain('Giriş yap');
    expect(container.querySelector('#login-help')).not.toBeNull();
    expect(container.querySelector('.password-toggle')).not.toBeNull();
  });

  it('exposes the anonymous release marker on the document element for deploy parity', () => {
    const element = document.createElement('html');
    applyDocumentBuildIdentity(element, createBuildIdentity({
      appVersion: '0.1.0',
      rawBuildSha: 'a'.repeat(40),
      development: false,
    }));

    expect(element.dataset.buildSha).toBe('a'.repeat(40));
    expect(element.dataset.buildLabel).toBe(`Dünya Dental 0.1.0 · ${'a'.repeat(7)}`);
  });
});
