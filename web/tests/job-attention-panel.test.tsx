/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JobAttentionPanel } from '../src/jobs/JobAttentionPanel';
import type {
  AssignmentOfferNeedingActionItem,
  OpenChangeRequestItem,
  UnacceptedPastStartItem,
} from '../src/jobs/jobs-api';
import type { CurrentUser } from '../src/services/api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const manager: CurrentUser = {
  id: 'manager-1', organizationId: 'org-1', name: 'Murat Yönetici', email: 'm@test.local',
  role: 'MANAGER', mustChangePassword: false, isActive: true, version: 1,
};

const admin: CurrentUser = { ...manager, id: 'admin-1', name: 'Sistem yöneticisi', role: 'ADMIN' };

const staff: CurrentUser = {
  ...manager, id: 'staff-1', name: 'Ayşe Personel', email: 'a@test.local', role: 'STAFF',
};

const changeRequest: OpenChangeRequestItem = {
  changeRequestId: 'change-request-1',
  jobCardId: 'job-1',
  jobTitle: 'Ataşehir klinik ürün teslimi',
  jobType: 'PRODUCT_DELIVERY',
  jobStatus: 'ACCEPTED',
  reasonCode: 'CUSTOMER_POSTPONED',
  reasonText: 'Müşteri kliniği bugün kapalı.',
  requestedAt: '2026-11-23T09:15:00.000Z',
  requestedBy: { id: 'staff-1', name: 'Ayşe Personel' },
  customer: { id: 'customer-1', name: 'Özel Ağız ve Diş Sağlığı Merkezi' },
  jobPath: '/jobs/job-1',
};

const assignmentOffer: AssignmentOfferNeedingActionItem = {
  jobCardId: 'job-2',
  jobTitle: 'Kadıköy poliklinik numune teslimi',
  jobType: 'PRODUCT_DELIVERY',
  offerId: 'offer-1',
  state: 'DECLINED',
  closeReason: 'SCHEDULE_CONFLICT',
  closeText: 'Aynı saatte başka teslim var.',
  acceptanceDueAt: '2026-11-23T12:00:00.000Z',
  urgentReason: null,
  scheduledAt: '2026-11-23T13:00:00.000Z',
  proposedScheduledAt: null,
  assignee: { id: 'staff-2', name: 'Mehmet Personel' },
  customer: { id: 'customer-2', name: 'Kadıköy Ağız Sağlığı' },
  jobPath: '/jobs/job-2',
};

const unacceptedPastStart: UnacceptedPastStartItem = {
  jobCardId: 'job-3',
  title: 'Beşiktaş diş kliniği satış görüşmesi',
  type: 'SALES_MEETING',
  jobPath: '/jobs/job-3',
  assignee: { id: 'staff-3', name: 'Zeynep Personel', active: true },
  scheduledAt: '2026-11-22T08:30:00.000Z',
  elapsedSeconds: 5400,
  hasOpenChangeRequest: false,
};

function loaded<T>(items: T[], total = items.length) {
  return vi.fn().mockResolvedValue({ items, total, limit: 3, offset: 0 });
}

function stubMatchMedia(desktop: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: desktop,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

type Loaders = {
  loadChangeRequests?: ReturnType<typeof loaded>;
  loadAssignmentOffers?: ReturnType<typeof loaded>;
  loadUnacceptedPastStart?: ReturnType<typeof loaded>;
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderPanel(user: CurrentUser, loaders: Loaders = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter>
        <JobAttentionPanel
          user={user}
          loadChangeRequests={loaders.loadChangeRequests as never}
          loadAssignmentOffers={loaders.loadAssignmentOffers as never}
          loadUnacceptedPastStart={loaders.loadUnacceptedPastStart as never}
        />
      </MemoryRouter>,
    );
  });
  await act(async () => { await Promise.resolve(); });
  return container;
}

async function rerenderPanel(loaders: Loaders = {}) {
  await act(async () => {
    root!.render(
      <MemoryRouter>
        <JobAttentionPanel
          user={manager}
          loadChangeRequests={loaders.loadChangeRequests as never}
          loadAssignmentOffers={loaders.loadAssignmentOffers as never}
          loadUnacceptedPastStart={loaders.loadUnacceptedPastStart as never}
        />
      </MemoryRouter>,
    );
  });
  await act(async () => { await Promise.resolve(); });
  return container!;
}

beforeEach(() => {
  stubMatchMedia(true);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

describe('JobAttentionPanel', () => {
  it('lists the three server-owned groups with counts, reasons, people and job links', async () => {
    const loadChangeRequests = loaded([changeRequest]);
    const loadAssignmentOffers = loaded([assignmentOffer]);
    const loadUnacceptedPastStart = loaded([unacceptedPastStart]);
    const element = await renderPanel(manager, {
      loadChangeRequests, loadAssignmentOffers, loadUnacceptedPastStart,
    });

    expect(loadChangeRequests).toHaveBeenCalledWith({ limit: 3, offset: 0 });
    expect(loadAssignmentOffers).toHaveBeenCalledWith({ limit: 3, offset: 0 });
    expect(loadUnacceptedPastStart).toHaveBeenCalledWith({ limit: 3, offset: 0 });

    expect(element.querySelector('#job-attention-title')?.textContent)
      .toContain('Müdahale gerekenler');
    expect(element.querySelector('.job-attention-count')?.textContent).toBe('3 kayıt');
    expect(element.textContent).toContain('Personel önerileri');
    expect(element.textContent).toContain('Müdahale gereken atamalar');
    expect(element.textContent).toContain('Kabul bekleyen işler');

    expect(element.textContent).toContain('Müşteri erteledi');
    expect(element.textContent).toContain('Ayşe Personel');
    expect(element.textContent).toContain('Reddedildi');
    expect(element.textContent).toContain('Mehmet Personel');
    expect(element.textContent).toContain('Kabul bekliyor');
    expect(element.textContent).toContain('Zeynep Personel');

    const hrefs = Array.from(element.querySelectorAll<HTMLAnchorElement>('.job-attention-row-title'))
      .map((link) => link.getAttribute('href'));
    expect(hrefs).toEqual(['/jobs/job-1', '/jobs/job-2', '/jobs/job-3']);
  });

  it('renders nothing and never loads for Staff', async () => {
    const loadChangeRequests = loaded([changeRequest]);
    const loadAssignmentOffers = loaded([assignmentOffer]);
    const loadUnacceptedPastStart = loaded([unacceptedPastStart]);
    const element = await renderPanel(staff, {
      loadChangeRequests, loadAssignmentOffers, loadUnacceptedPastStart,
    });

    expect(element.innerHTML).toBe('');
    expect(loadChangeRequests).not.toHaveBeenCalled();
    expect(loadAssignmentOffers).not.toHaveBeenCalled();
    expect(loadUnacceptedPastStart).not.toHaveBeenCalled();
  });

  it('renders nothing while loading and when every list is empty', async () => {
    const element = await renderPanel(admin, {
      loadChangeRequests: loaded([]),
      loadAssignmentOffers: loaded([]),
      loadUnacceptedPastStart: loaded([]),
    });

    expect(element.innerHTML).toBe('');
  });

  it('keeps loaded groups visible, reports a partial failure and retries', async () => {
    const loadChangeRequests = loaded([changeRequest]);
    const loadAssignmentOffers = vi.fn().mockRejectedValue(new Error('Sunucuya ulaşılamadı.'));
    const element = await renderPanel(manager, {
      loadChangeRequests,
      loadAssignmentOffers,
      loadUnacceptedPastStart: loaded([]),
    });

    expect(element.textContent).toContain('Müdahale gerekenler yüklenemedi');
    expect(element.textContent).toContain('Tekrar dene');
    expect(element.textContent).toContain('Ataşehir klinik ürün teslimi');
    // A failed loader must not look like "nothing to do": the count only
    // reports groups that actually loaded.
    expect(element.querySelector('.job-attention-count')?.textContent).toBe('1 kayıt');

    loadAssignmentOffers.mockResolvedValue({ items: [assignmentOffer], total: 1, limit: 3, offset: 0 });
    const retry = Array.from(element.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Tekrar dene')!;
    await act(async () => {
      retry.click();
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); });

    expect(loadAssignmentOffers).toHaveBeenCalledTimes(2);
    expect(element.textContent).not.toContain('Müdahale gerekenler yüklenemedi');
    expect(element.textContent).toContain('Kadıköy poliklinik numune teslimi');
    expect(element.querySelector('.job-attention-count')?.textContent).toBe('2 kayıt');
  });

  it('points to the overview when a group holds more rows than the compact limit', async () => {
    const offers = [assignmentOffer, { ...assignmentOffer, jobCardId: 'job-4', offerId: 'offer-2' }, { ...assignmentOffer, jobCardId: 'job-5', offerId: 'offer-3' }];
    const element = await renderPanel(manager, {
      loadChangeRequests: loaded([]),
      loadAssignmentOffers: loaded(offers, 5),
      loadUnacceptedPastStart: loaded([]),
    });

    expect(element.querySelectorAll('[data-job-attention-row="true"]')).toHaveLength(3);
    expect(element.querySelector('.job-attention-count')?.textContent).toBe('5 kayıt');
    const overviewLink = element.querySelector<HTMLAnchorElement>('.job-attention-overview-link a');
    expect(overviewLink?.getAttribute('href')).toBe('/overview');
    expect(overviewLink?.textContent).toBe('Tümünü Genel bakışta gör');
  });

  it('uses a native open disclosure below the 64rem shell gate', async () => {
    stubMatchMedia(false);
    const element = await renderPanel(manager, {
      loadChangeRequests: loaded([changeRequest]),
      loadAssignmentOffers: loaded([]),
      loadUnacceptedPastStart: loaded([]),
    });

    const details = element.querySelector<HTMLDetailsElement>('details.job-attention-disclosure');
    expect(details).not.toBeNull();
    expect(details?.open).toBe(true);
    const summary = details?.querySelector('summary');
    expect(summary?.textContent).toContain('Müdahale gerekenler');
    expect(summary?.textContent).toContain('1 kayıt');

    await act(async () => { summary!.click(); });
    expect(details?.open).toBe(false);
  });

  it('keeps the server urgent reason on an open assignment offer', async () => {
    const urgentOffer: AssignmentOfferNeedingActionItem = {
      ...assignmentOffer,
      state: 'OPEN',
      closeReason: null,
      closeText: null,
      urgentReason: 'START_PASSED',
    };
    const element = await renderPanel(manager, {
      loadChangeRequests: loaded([]),
      loadAssignmentOffers: loaded([urgentOffer]),
      loadUnacceptedPastStart: loaded([]),
    });

    const reason = element.querySelector('.job-attention-reason')?.textContent ?? '';
    expect(reason).toContain('Yanıt bekliyor');
    expect(reason).toContain('Başlangıç geçti');
    expect(reason).toContain('müşteri zamanı risk altında');
  });

  it('keeps the failure and retry visible below a closed mobile disclosure', async () => {
    stubMatchMedia(false);
    const element = await renderPanel(manager, {
      loadChangeRequests: loaded([changeRequest]),
      loadAssignmentOffers: loaded([]),
      loadUnacceptedPastStart: loaded([]),
    });

    const details = element.querySelector<HTMLDetailsElement>('details.job-attention-disclosure')!;
    const summary = details.querySelector('summary')!;
    await act(async () => { summary.click(); });
    expect(details.open).toBe(false);

    await rerenderPanel({
      loadChangeRequests: loaded([changeRequest]),
      loadAssignmentOffers: vi.fn().mockRejectedValue(new Error('Servis kullanılamıyor.')),
      loadUnacceptedPastStart: loaded([]),
    });

    expect(details.open).toBe(false);
    const banner = element.querySelector<HTMLElement>('[data-job-attention-error="true"]');
    expect(banner).not.toBeNull();
    // A closed disclosure must not swallow the failure or its retry action.
    expect(details.contains(banner)).toBe(false);
    expect(banner?.textContent).toContain('Müdahale gerekenler yüklenemedi');
    expect(banner?.textContent).toContain('Tekrar dene');
  });

  it('keeps the desktop panel fully expanded without a disclosure', async () => {
    const element = await renderPanel(manager, {
      loadChangeRequests: loaded([changeRequest]),
      loadAssignmentOffers: loaded([]),
      loadUnacceptedPastStart: loaded([]),
    });

    expect(element.querySelector('details')).toBeNull();
    expect(element.querySelector('#job-attention-title')).not.toBeNull();
  });
});

describe('JobAttentionPanel touch targets', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/jobs/job-attention.css'), 'utf8');

  it('gives a short job-title link the full 44x44 CSS px target', () => {
    const rule = /\.job-attention-row-title\s*\{([^}]*)\}/s.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/min-width:\s*var\(--control-height\)/);
    expect(rule).toMatch(/min-height:\s*var\(--control-height\)/);
  });
});
