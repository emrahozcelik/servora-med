/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../src/App';
import type { CurrentUser } from '../src/services/api';
import { ServoraAntProvider } from '../src/ui/antd/ServoraAntProvider';
import { stubDesktopMatchMedia } from './antd-match-media';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const operator = {
  id: 'op-1', name: 'Kurulum Operatörü', email: 'operator@example.com', capabilities: ['MODULE_MANAGEMENT'],
};
const overviewModule = {
  key: 'OVERVIEW', label: 'Genel Bakış', enabled: true, version: 3,
  source: 'OPERATOR', updatedAt: '2026-11-26T09:30:00.000Z',
};
const customer: CurrentUser = {
  id: 'user-1', organizationId: 'org-1', name: 'Ayşe Personel', email: 'staff@example.com',
  role: 'STAFF', mustChangePassword: false, isActive: true, version: 1,
  capabilities: { overviewDashboard: false, calendar: false, messaging: false },
  support: { displayLabel: 'Destek', email: null, helpUrl: null },
};

type Call = { method: string; url: string; body: unknown };
type Handler = (call: Call) => Response | Promise<Response>;

function jsonResponse(status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
}

describe('operator area', () => {
  let container: HTMLDivElement;
  let root: Root;
  let calls: Call[];
  let handler: Handler;

  beforeEach(() => {
    stubDesktopMatchMedia();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    calls = [];
    handler = () => jsonResponse(404, { code: 'NOT_FOUND', error: 'unexpected' });
    vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit = {}) => {
      const call: Call = {
        method: init.method ?? 'GET',
        url: String(url),
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      return Promise.resolve(handler(call));
    }));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function renderAt(path: string, props: { initialUser?: CurrentUser | null } = {}) {
    await act(async () => {
      root.render(
        <ServoraAntProvider>
          <MemoryRouter initialEntries={[path]}><App {...props} /></MemoryRouter>
        </ServoraAntProvider>,
      );
    });
  }

  const text = () => container.textContent ?? '';
  const button = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    .find((entry) => entry.textContent?.trim() === label);
  const operatorSwitch = () => container.querySelector<HTMLButtonElement>('button[role="switch"]')!;

  async function click(element: HTMLElement | undefined) {
    expect(element).toBeTruthy();
    await act(async () => element!.click());
  }

  function modulesHandler(overrides: Partial<Record<string, Handler>> = {}): Handler {
    return (call) => {
      const key = `${call.method} ${call.url}`;
      if (overrides[key]) return overrides[key]!(call);
      if (key === 'GET /api/operator/me') return jsonResponse(200, { operator });
      if (key === 'GET /api/operator/modules') return jsonResponse(200, { modules: [overviewModule] });
      return jsonResponse(404, { code: 'NOT_FOUND', error: 'unexpected' });
    };
  }

  async function signInAndLoad() {
    handler = modulesHandler({
      'GET /api/operator/me': () => jsonResponse(401, { code: 'OPERATOR_UNAUTHENTICATED', error: 'x' }),
      'POST /api/operator/login': () => jsonResponse(200, { operator }),
    });
    await renderAt('/operator');
    await vi.waitFor(() => expect(container.querySelector('form')).not.toBeNull());
    container.querySelector<HTMLInputElement>('#operator-email')!.value = 'operator@example.com';
    container.querySelector<HTMLInputElement>('#operator-password')!.value = 'a-test-password';
    // After login the session cookie exists: /me would now succeed.
    handler = modulesHandler({ 'POST /api/operator/login': () => jsonResponse(200, { operator }) });
    await click(button('Giriş yap'));
    await vi.waitFor(() => expect(operatorSwitch()).toBeTruthy());
  }

  it('renders the operator login without touching the customer identity API', async () => {
    handler = modulesHandler({ 'GET /api/operator/me': () => jsonResponse(401, { code: 'OPERATOR_UNAUTHENTICATED', error: 'x' }) });
    await renderAt('/operator');
    await vi.waitFor(() => expect(container.querySelector('h1')?.textContent).toBe('Operatör girişi'));

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['GET /api/operator/me']);
    expect(container.querySelector('label[for="operator-email"]')?.textContent).toBe('E-posta');
    expect(container.querySelector('label[for="operator-password"]')?.textContent).toBe('Parola');
    expect(document.title).toBe('Operatör · Servora-Med');
  });

  it('does not call /api/auth/me even when a customer identity is supplied, and covers sub-paths', async () => {
    handler = modulesHandler();
    await renderAt('/operator/anything/else', { initialUser: customer });
    await vi.waitFor(() => expect(operatorSwitch()).toBeTruthy());

    expect(calls.every((call) => call.url.startsWith('/api/operator'))).toBe(true);
    expect(container.querySelector('[aria-label="Ana navigasyon"]')).toBeNull();
  });

  it('never calls /api/operator from customer routes', async () => {
    handler = (call) => call.url === '/api/auth/me'
      ? jsonResponse(401, { code: 'UNAUTHENTICATED', error: 'x' })
      : jsonResponse(404, { code: 'NOT_FOUND', error: 'x' });
    await renderAt('/jobs');
    await vi.waitFor(() => expect(container.querySelector('#login-title')).not.toBeNull());

    expect(calls.map((call) => call.url)).toEqual(['/api/auth/me']);
    expect(calls.some((call) => call.url.includes('/api/operator'))).toBe(false);
  });

  it('shows a server-mapped alert for wrong credentials and keeps the form usable', async () => {
    handler = modulesHandler({
      'GET /api/operator/me': () => jsonResponse(401, { code: 'OPERATOR_UNAUTHENTICATED', error: 'x' }),
      'POST /api/operator/login': () => jsonResponse(401, { code: 'INVALID_CREDENTIALS', error: 'Geçersiz bilgiler.' }),
    });
    await renderAt('/operator');
    await vi.waitFor(() => expect(container.querySelector('form')).not.toBeNull());
    container.querySelector<HTMLInputElement>('#operator-email')!.value = 'operator@example.com';
    container.querySelector<HTMLInputElement>('#operator-password')!.value = 'wrong';
    await click(button('Giriş yap'));

    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toBe('E-posta veya parola hatalı.'));
    expect(document.activeElement).toBe(container.querySelector('[role="alert"]'));
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
    expect(calls.find((call) => call.url === '/api/operator/login')?.body)
      .toEqual({ email: 'operator@example.com', password: 'wrong' });
  });

  it('signs in and renders the Overview row with state and last change', async () => {
    await signInAndLoad();

    expect(container.querySelector('h1')?.textContent).toBe('Modüller');
    expect(text()).toContain('Genel Bakış');
    expect(text()).toContain('Kurulum Operatörü');
    expect(text()).toContain('Son değişiklik:');
    expect(text()).toContain('operatör tarafından değiştirildi');
    const toggle = operatorSwitch();
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(toggle.textContent).toContain('Açık');
    expect(calls.some((call) => call.url.startsWith('/api/auth'))).toBe(false);
  });

  it('requires a confirmation before switching, and cancelling writes nothing', async () => {
    await signInAndLoad();
    const writesBefore = calls.filter((call) => call.method === 'PUT').length;

    await click(operatorSwitch());
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Genel Bakış modülü kapatılsın mı?');
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(writesBefore);

    await click(button('Vazgeç'));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(writesBefore);
    expect(operatorSwitch().getAttribute('aria-checked')).toBe('true');
  });

  it('applies a confirmed change with expectedVersion and announces the result', async () => {
    await signInAndLoad();
    handler = modulesHandler({
      'PUT /api/operator/modules/OVERVIEW': () => jsonResponse(200, {
        module: { ...overviewModule, enabled: false, version: 4, updatedAt: '2026-11-26T10:00:00.000Z' },
      }),
    });

    await click(operatorSwitch());
    await click(button('Modülü kapat'));
    await vi.waitFor(() => expect(operatorSwitch().getAttribute('aria-checked')).toBe('false'));

    expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({ enabled: false, expectedVersion: 3 });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Genel Bakış modülü kapatıldı.');
    expect(operatorSwitch().textContent).toContain('Kapalı');
  });

  it('shows refresh guidance on a version conflict and blocks switching until reloaded', async () => {
    await signInAndLoad();
    handler = modulesHandler({
      'PUT /api/operator/modules/OVERVIEW': () => jsonResponse(409, { code: 'MODULE_VERSION_CONFLICT', error: 'x' }),
    });

    await click(operatorSwitch());
    await click(button('Modülü kapat'));
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('başka bir oturumda değişti');
    expect(operatorSwitch().disabled).toBe(true);

    handler = modulesHandler({
      'GET /api/operator/modules': () => jsonResponse(200, { modules: [{ ...overviewModule, enabled: false, version: 4 }] }),
    });
    await click(button('Güncel durumu yükle'));
    await vi.waitFor(() => expect(operatorSwitch().getAttribute('aria-checked')).toBe('false'));
    expect(operatorSwitch().disabled).toBe(false);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('explains a 503 MODULE_STATE_UNAVAILABLE on load and offers a retry', async () => {
    handler = modulesHandler({
      'GET /api/operator/modules': () => jsonResponse(503, { code: 'MODULE_STATE_UNAVAILABLE', error: 'x' }),
    });
    await renderAt('/operator/modules');
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());

    expect(text()).toContain('Modüller yüklenemedi');
    expect(text()).toContain('Modül durumu şu anda okunamıyor');
    expect(container.querySelector('button[role="switch"]')).toBeNull();

    handler = modulesHandler();
    await click(button('Tekrar dene'));
    await vi.waitFor(() => expect(operatorSwitch()).toBeTruthy());
  });

  it('returns to the login with a notice when the operator session expires on a write', async () => {
    await signInAndLoad();
    handler = modulesHandler({
      'PUT /api/operator/modules/OVERVIEW': () => jsonResponse(401, { code: 'OPERATOR_UNAUTHENTICATED', error: 'x' }),
    });

    await click(operatorSwitch());
    await click(button('Modülü kapat'));
    await vi.waitFor(() => expect(container.querySelector('#operator-login-title')).not.toBeNull());

    expect(container.querySelector('[role="status"]')?.textContent).toContain('oturumunuz sona erdi');
  });

  it('logs out through POST /api/operator/logout and shows the login again', async () => {
    await signInAndLoad();
    handler = modulesHandler({ 'POST /api/operator/logout': () => jsonResponse(204) });

    await click(button('Çıkış yap'));
    await vi.waitFor(() => expect(container.querySelector('#operator-login-title')).not.toBeNull());

    expect(calls.some((call) => call.method === 'POST' && call.url === '/api/operator/logout')).toBe(true);
    expect(container.querySelector('button[role="switch"]')).toBeNull();
  });
});
