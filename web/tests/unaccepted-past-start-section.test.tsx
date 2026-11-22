/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import type { UnacceptedPastStartItem } from '../src/jobs/jobs-api';
import { UnacceptedPastStartSection } from '../src/jobs/UnacceptedPastStart';
import { RealtimeProvider } from '../src/realtime/RealtimeProvider';
import type { CurrentUser } from '../src/services/api';
import { ServoraAntProvider } from '../src/ui/antd/ServoraAntProvider';
import { DEFAULT_LIST_PAGE_SIZE } from '../src/ui/pagination';
import { stubDesktopMatchMedia } from './antd-match-media';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
stubDesktopMatchMedia();

const manager: CurrentUser = {
  id: 'manager-1', organizationId: 'org-1', name: 'Ahmet Yönetici',
  email: 'manager@example.com', role: 'MANAGER', mustChangePassword: false,
  isActive: true, version: 2,
  capabilities: { overviewDashboard: true, calendar: true, messaging: true },
  support: { displayLabel: 'Destek', email: null, helpUrl: null },
};

const staff: CurrentUser = { ...manager, id: 'staff-1', name: 'Ayşe Personel', role: 'STAFF' };

const item: UnacceptedPastStartItem = {
  jobCardId: 'job-1',
  title: 'Klinik sterilizasyon eğitimi',
  type: 'GENERAL_TASK',
  jobPath: '/jobs/job-1',
  assignee: { id: 'staff-1', name: 'Ayşe Personel', active: true },
  scheduledAt: '2026-11-21T11:00:00.000Z',
  elapsedSeconds: 5_400,
  hasOpenChangeRequest: false,
};

function wrapper(user: CurrentUser, load: ReturnType<typeof vi.fn>) {
  return (
    <ServoraAntProvider>
      <MemoryRouter>
        <RealtimeProvider>
          <UnacceptedPastStartSection user={user} load={load as never} />
        </RealtimeProvider>
      </MemoryRouter>
    </ServoraAntProvider>
  );
}

async function render(user: CurrentUser, load: ReturnType<typeof vi.fn>) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(wrapper(user, load)); });
  await act(async () => { await Promise.resolve(); });
  const section = container.querySelector('[data-unaccepted-past-start]');
  const html = container.innerHTML;
  await act(async () => root.unmount());
  container.remove();
  return { section, html };
}

const loaded = (items: UnacceptedPastStartItem[], total = items.length) =>
  vi.fn().mockResolvedValue({ items, total, limit: DEFAULT_LIST_PAGE_SIZE, offset: 0 });

describe('UnacceptedPastStartSection', () => {
  it('lists each unaccepted past-start job for management through the OperationalCard adapter', async () => {
    const load = loaded([item]);
    const { section, html } = await render(manager, load);

    expect(load).toHaveBeenCalledWith({ limit: DEFAULT_LIST_PAGE_SIZE, offset: 0 });
    expect(section?.getAttribute('data-unaccepted-past-start')).toBe('true');
    expect(html).toContain('Kabul bekleyen ve planlanan zamanı geçen işler');
    expect(section?.querySelector('.servora-operational-card')).not.toBeNull();
    expect(section?.querySelector('.servora-operational-card__title a')?.getAttribute('href'))
      .toBe('/jobs/job-1');
    expect(section?.querySelector('.servora-operational-card__title a')?.textContent)
      .toBe('Klinik sterilizasyon eğitimi');
    expect(section?.querySelector('time')?.getAttribute('datetime')).toBe('2026-11-21T11:00:00.000Z');
  });

  it('shows the assignee, the planned start and the elapsed time', async () => {
    const { section } = await render(manager, loaded([item]));
    const text = section?.textContent ?? '';
    expect(text).toContain('Ayşe Personel');
    expect(text).toContain('Planlanan başlangıç:');
    expect(text).toContain('1 saat 30 dakika geçti');
    expect(text).toContain('Kabul bekliyor');
    expect(text).not.toContain('(pasif)');
  });

  it('marks a deactivated assignee as passive', async () => {
    const { section } = await render(manager, loaded([
      { ...item, assignee: { id: 'staff-2', name: 'Mert Personel', active: false } },
    ]));
    expect(section?.textContent).toContain('Mert Personel (pasif)');
  });

  it('shows the open change-request badge', async () => {
    const { section } = await render(manager, loaded([{ ...item, hasOpenChangeRequest: true }]));
    const badge = section?.querySelector('[data-unaccepted-past-start-change-request]');
    expect(badge?.textContent).toContain('Değişiklik talebi açık');
  });

  it('keeps the change-request badge out when the job has no open request', async () => {
    const { section } = await render(manager, loaded([item]));
    expect(section?.querySelector('[data-unaccepted-past-start-change-request]')).toBeNull();
  });

  it('renders nothing for Staff and never requests the management list', async () => {
    const load = loaded([item]);
    const { section, html } = await render(staff, load);

    expect(load).not.toHaveBeenCalled();
    expect(section).toBeNull();
    expect(html).not.toContain('Kabul bekleyen ve planlanan zamanı geçen işler');
  });

  it('renders nothing when nothing is waiting for acceptance', async () => {
    const { section, html } = await render(manager, loaded([]));
    expect(section).toBeNull();
    expect(html).not.toContain('Kabul bekleyen ve planlanan zamanı geçen işler');
  });

  it('shows the paged total when more jobs exist than the page shows', async () => {
    const { section } = await render(manager, loaded([item], 9));
    expect(section?.textContent).toContain('Toplam 9 iş');
  });

  it('shows an error state with retry instead of hiding a failed load', async () => {
    const load = vi.fn().mockRejectedValue(new Error('Sunucuya ulaşılamadı.'));
    const { section, html } = await render(manager, load);

    expect(section?.getAttribute('data-unaccepted-past-start')).toBe('error');
    expect(html).toContain('Kabul bekleyen işler yüklenemedi');
    expect(html).toContain('Sunucuya ulaşılamadı.');
    expect(html).toContain('Tekrar dene');
  });

  it('renders the section at the documented 390x844 mobile viewport', async () => {
    // jsdom has no layout engine, so real pixel geometry and horizontal
    // overflow are owned by the Playwright geometry smokes; this pins the
    // mobile render path: at 390x844 the section, every row field and the
    // change-request badge still mount (nothing is width-gated away).
    Object.defineProperty(window, 'innerWidth', {
      writable: true, configurable: true, value: 390,
    });
    Object.defineProperty(window, 'innerHeight', {
      writable: true, configurable: true, value: 844,
    });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({
        matches: query.includes('max-width'),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    });
    try {
      const { section, html } = await render(manager, loaded([
        item,
        { ...item, jobCardId: 'job-2', title: 'İkinci iş', hasOpenChangeRequest: true },
      ], 9));

      expect(section?.getAttribute('data-unaccepted-past-start')).toBe('true');
      expect(section?.querySelectorAll('.servora-operational-card')).toHaveLength(2);
      expect(html).toContain('Kabul bekleyen ve planlanan zamanı geçen işler');
      expect(html).toContain('Ayşe Personel');
      expect(html).toContain('Planlanan başlangıç:');
      expect(html).toContain('1 saat 30 dakika geçti');
      expect(html).toContain('Değişiklik talebi açık');
      expect(html).toContain('Toplam 9 iş');
      expect(section?.querySelectorAll('.servora-operational-card__title a')[0]?.getAttribute('href'))
        .toBe('/jobs/job-1');
    } finally {
      Object.defineProperty(window, 'innerWidth', {
        writable: true, configurable: true, value: 1024,
      });
      Object.defineProperty(window, 'innerHeight', {
        writable: true, configurable: true, value: 768,
      });
      stubDesktopMatchMedia();
    }
  });

  it('reloads the list from the retry action', async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('Sunucuya ulaşılamadı.'))
      .mockResolvedValueOnce({ items: [item], total: 1, limit: DEFAULT_LIST_PAGE_SIZE, offset: 0 });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(wrapper(manager, load)); });
    await act(async () => { await Promise.resolve(); });

    const retry = container.querySelector('[data-unaccepted-past-start="error"] button');
    expect(retry).not.toBeNull();
    await act(async () => {
      (retry as HTMLButtonElement).click();
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); });

    const section = container.querySelector('[data-unaccepted-past-start]');
    expect(load).toHaveBeenCalledTimes(2);
    expect(section?.getAttribute('data-unaccepted-past-start')).toBe('true');
    expect(section?.textContent).toContain('Klinik sterilizasyon eğitimi');

    await act(async () => root.unmount());
    container.remove();
  });
});
