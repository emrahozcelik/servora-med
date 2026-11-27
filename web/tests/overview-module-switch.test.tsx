/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mounts = vi.hoisted(() => ({ jobs: 0 }));

vi.mock('../src/jobs/JobWorkspace', async () => {
  const { useEffect } = await import('react');
  return {
    JobWorkspace: () => {
      useEffect(() => { mounts.jobs += 1; }, []);
      return <div data-page="jobs" />;
    },
  };
});

vi.mock('../src/overview/OverviewPage', () => ({
  OverviewPage: () => <div data-page="overview" />,
}));

import { AppRouter } from '../src/AppRouter';
import { buildNavigationModel, resolveHomePath } from '../src/shell/navigation-model';
import { ApiError, type CurrentUser } from '../src/services/api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const manager = (overviewDashboard: boolean): CurrentUser => ({
  id: 'manager-1', organizationId: 'org-1', name: 'Murat Yönetici', email: 'manager@example.com',
  role: 'MANAGER', mustChangePassword: false, isActive: true, version: 1,
  capabilities: { overviewDashboard, calendar: false, messaging: false },
  support: { displayLabel: 'Destek', email: null, helpUrl: null },
});

function LocationProbe() {
  const { pathname } = useLocation();
  return <output data-location>{pathname}</output>;
}

describe('Overview module switching in the customer router (MOD-002 §8)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mounts.jobs = 0;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function renderRouter(path: string, user: CurrentUser) {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={[path]}>
          <LocationProbe />
          <AppRouter user={user} notice="" onDeliveryCreated={() => {}} onSessionEnded={() => {}} />
        </MemoryRouter>,
      );
    });
    await act(async () => { await vi.dynamicImportSettled(); });
  }

  const location = () => container.querySelector('[data-location]')?.textContent;

  it('moves an open Overview page to /jobs when the capability turns off', async () => {
    await renderRouter('/overview', manager(true));
    expect(container.querySelector('[data-page="overview"]')).not.toBeNull();

    await renderRouter('/overview', manager(false));
    await vi.waitFor(() => expect(location()).toBe('/jobs'));
    expect(container.querySelector('[data-page="jobs"]')).not.toBeNull();
    expect(container.querySelector('[data-page="overview"]')).toBeNull();
  });

  it('does not interrupt the current page when the capability turns on', async () => {
    await renderRouter('/jobs', manager(false));
    expect(mounts.jobs).toBe(1);

    await renderRouter('/jobs', manager(true));
    expect(location()).toBe('/jobs');
    expect(mounts.jobs).toBe(1);
  });

  it('updates navigation and the landing route from the new capability', () => {
    const off = manager(false);
    const on = manager(true);
    expect(buildNavigationModel(off).destinations.some((item) => item.id === 'overview')).toBe(false);
    expect(buildNavigationModel(on).destinations.some((item) => item.id === 'overview')).toBe(true);
    expect(resolveHomePath(off)).toBe('/jobs');
    expect(resolveHomePath(on)).toBe('/overview');
  });
});

describe('OverviewPage 404 handling', () => {
  async function mountOverview(load: () => Promise<never>, onUnavailable: () => void) {
    const { OverviewPage } = await vi.importActual<typeof import('../src/overview/OverviewPage')>('../src/overview/OverviewPage');
    const { RealtimeProvider } = await vi.importActual<typeof import('../src/realtime/RealtimeProvider')>('../src/realtime/RealtimeProvider');
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <MemoryRouter>
          <RealtimeProvider>
            <OverviewPage user={manager(true)} load={load} onUnavailable={onUnavailable} />
          </RealtimeProvider>
        </MemoryRouter>,
      );
    });
    await act(async () => { await Promise.resolve(); });
    return { container, unmount: () => act(async () => root.unmount()) };
  }

  it('asks for exactly one revalidation when Overview answers 404', async () => {
    const onUnavailable = vi.fn();
    const view = await mountOverview(
      () => Promise.reject(new ApiError(404, 'NOT_FOUND', 'Sayfa bulunamadı.')),
      onUnavailable,
    );
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(view.container.textContent).toContain('Sayfa bulunamadı.');
    await view.unmount();
  });

  it.each([
    ['a 503 MODULE_STATE_UNAVAILABLE', new ApiError(503, 'MODULE_STATE_UNAVAILABLE', 'Okunamıyor.', true)],
    ['a network failure', new ApiError(0, 'NETWORK_ERROR', 'Sunucuya ulaşılamadı.', true)],
  ])('does not revalidate on %s', async (_name, failure) => {
    const onUnavailable = vi.fn();
    const view = await mountOverview(() => Promise.reject(failure), onUnavailable);
    expect(onUnavailable).not.toHaveBeenCalled();
    await view.unmount();
  });
});
