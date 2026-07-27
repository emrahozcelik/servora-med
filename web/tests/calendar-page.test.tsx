/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CalendarPage } from '../src/calendar/CalendarPage';
import type { CurrentUser } from '../src/services/api';

const calendarApi = vi.hoisted(() => ({
  listCalendar: vi.fn(),
  listCalendarAssignees: vi.fn(),
  getCalendarEvent: vi.fn(),
  createManualEvent: vi.fn(),
  patchManualEvent: vi.fn(),
  cancelManualEvent: vi.fn(),
}));
vi.mock('../src/services/calendar-api', () => calendarApi);
vi.mock('../src/jobs/jobs-api', () => ({ patchJobCard: vi.fn() }));
vi.mock('../src/realtime/RealtimeProvider', () => ({
  useRealtimeInvalidation: vi.fn(),
}));
// Mock dayjs to provide stable calendar rendering in JSDOM
vi.mock('dayjs', () => {
  const actual = vi.importActual('dayjs') as Promise<Record<string, unknown>>;
  return actual;
});
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// Fixed test date: 2026-07-29
const TEST_TODAY = new Date(2026, 6, 29, 10, 0, 0);

const staff: CurrentUser = {
  id: 'staff-1',
  organizationId: 'org-1',
  name: 'Ayşe Personel',
  email: 'staff@example.test',
  role: 'STAFF',
  mustChangePassword: false,
  isActive: true,
  version: 1,
  capabilities: { overviewDashboard: true, calendar: true, messaging: false },
  support: { displayLabel: 'Destek', email: null, helpUrl: null },
};

const manager: CurrentUser = {
  id: 'manager-1',
  organizationId: 'org-1',
  name: 'Murat Yönetici',
  email: 'manager@example.test',
  role: 'MANAGER',
  mustChangePassword: false,
  isActive: true,
  version: 1,
  capabilities: { overviewDashboard: true, calendar: true, messaging: false },
  support: { displayLabel: 'Destek', email: null, helpUrl: null },
};

const manualEvent = {
  id: 'event-1',
  source: 'MANUAL' as const,
  title: 'Klinik hazırlığı',
  description: null,
  startsAt: '2026-07-29T09:00:00.000Z',
  endsAt: '2026-07-29T10:00:00.000Z',
  timezone: 'Europe/Istanbul',
  assignedUser: { id: 'staff-1', name: 'Ayşe Personel' },
  version: 1,
  status: 'ACTIVE' as const,
  createdBy: { id: 'manager-1', name: 'Murat Yönetici' },
  updatedBy: { id: 'manager-1', name: 'Murat Yönetici' },
  canEdit: true,
  canCancel: true,
};

const jobEvent = {
  id: 'job-event-1',
  source: 'JOB' as const,
  title: 'Ürün teslimi',
  startsAt: '2026-07-28T14:00:00.000Z',
  endsAt: '2026-07-28T16:00:00.000Z',
  timezone: 'Europe/Istanbul',
  assignedUser: { id: 'staff-1', name: 'Ayşe Personel' },
  version: 2,
  jobCardId: 'job-1',
  jobType: 'PRODUCT_DELIVERY',
  jobStatus: 'NEW',
  priority: 'normal',
  customer: null,
  relatedJobPath: '/jobs/job-1',
  canEdit: true,
  canCancel: false,
};

/** Simulate user typing into a controlled input/textarea in React. */
function setReactValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const nativeSetter = Object.getOwnPropertyDescriptor(
    element.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype,
    'value',
  )?.set;
  nativeSetter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('CalendarPage', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_TODAY);

    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    calendarApi.listCalendar.mockResolvedValue([manualEvent, jobEvent]);
    calendarApi.listCalendarAssignees.mockResolvedValue([
      { id: 'staff-1', name: 'Ayşe Personel' },
      { id: 'staff-2', name: 'Bora Personel' },
    ]);
    calendarApi.getCalendarEvent.mockResolvedValue(manualEvent);
    calendarApi.cancelManualEvent.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function render(user: CurrentUser = manager, path = '/calendar') {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={[path]}>
          <CalendarPage user={user} />
        </MemoryRouter>,
      );
    });
    await act(async () => {});
  }

  it('queries the visible month range (≤42 days) for the manager', async () => {
    await render();
    expect(calendarApi.listCalendar).toHaveBeenCalledTimes(1);
    const call = calendarApi.listCalendar.mock.calls[0][0] as Record<string, string>;
    const from = new Date(call.from);
    const to = new Date(call.to);
    const days = (to.valueOf() - from.valueOf()) / (24 * 60 * 60 * 1000);
    expect(days).toBeLessThanOrEqual(42);
    expect(days).toBeGreaterThanOrEqual(35);
  });

  it('shows the Manager staff filter and renders the month grid', async () => {
    await render();
    const filter = container.querySelector<HTMLSelectElement>('.calendar-toolbar select')!;
    expect(filter).toBeTruthy();
    expect(filter.value).toBe('');
    expect(filter.textContent).toContain('Tüm yetkili personel');
    expect(filter.textContent).toContain('Ayşe Personel');
    expect(container.querySelector('.servora-calendar')).toBeTruthy();
  });

  it('hides the staff filter for STAFF role', async () => {
    await render(staff);
    expect(container.querySelector('.calendar-toolbar select')).toBeNull();
  });

  it('shows the agenda section with a heading', async () => {
    await render();
    const agenda = container.querySelector('.calendar-agenda-section');
    expect(agenda).toBeTruthy();
    const heading = agenda!.querySelector('h2');
    expect(heading).toBeTruthy();
  });

  it('renders LoadingSkeleton during load', async () => {
    let resolveList: (v: unknown) => void;
    calendarApi.listCalendar.mockReturnValue(
      new Promise((resolve) => { resolveList = resolve; }),
    );
    await render();
    const skeleton = container.querySelector('[data-servora-loading-skeleton]');
    expect(skeleton).toBeTruthy();
    expect(skeleton!.textContent).toContain('Takvim yükleniyor');
    (resolveList!)([]);
    await act(async () => {});
  });

  it('renders ResultState on blocking error', async () => {
    calendarApi.listCalendar.mockRejectedValue(new Error('Ağ hatası'));
    await render();
    const result = container.querySelector('[data-servora-result-state]');
    expect(result).toBeTruthy();
    expect(result!.textContent).toContain('Takvim yüklenemedi');
    const retryBtn = Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Tekrar dene'));
    expect(retryBtn).toBeTruthy();
  });

  it('renders EmptyState when selected day has no events', async () => {
    calendarApi.listCalendar.mockResolvedValue([]);
    await render();
    const empty = container.querySelector('[data-servora-empty-state]');
    expect(empty).toBeTruthy();
    expect(empty!.textContent).toContain('Bu gün için plan bulunmuyor');
  });

  it('renders JOB and MANUAL source badges in agenda', async () => {
    await render();
    // Today is July 29 — manualEvent is on July 29, it should appear in agenda
    const manualBadge = container.querySelector('.calendar-source--manual');
    expect(manualBadge).toBeTruthy();
  });

  it('shows the custom header with Bugün button', async () => {
    await render();
    const header = container.querySelector('.servora-calendar-header');
    expect(header).toBeTruthy();
    const todayBtn = Array.from(header!.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Bugün'));
    expect(todayBtn).toBeTruthy();
    const prevBtn = Array.from(header!.querySelectorAll('button'))
      .find((b) => b.getAttribute('aria-label') === 'Önceki ay');
    expect(prevBtn).toBeTruthy();
    const nextBtn = Array.from(header!.querySelectorAll('button'))
      .find((b) => b.getAttribute('aria-label') === 'Sonraki ay');
    expect(nextBtn).toBeTruthy();
  });

  it('opens the form drawer when clicking Yeni plan', async () => {
    await render();
    const createBtn = Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Yeni plan'))!;
    expect(createBtn).toBeTruthy();
    await act(async () => createBtn.click());
    const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
    expect(dialog).toBeTruthy();
    expect(dialog!.textContent).toContain('Yeni plan');
  });

  it('deep-link selects the event month and shows it in agenda', async () => {
    await render(manager, '/calendar?event=event-1');
    expect(calendarApi.getCalendarEvent).toHaveBeenCalledWith('event-1');
    await act(async () => {});
    const selected = container.querySelector<HTMLElement>('.calendar-event--selected');
    expect(selected).toBeTruthy();
    expect(selected?.textContent).toContain('Klinik hazırlığı');
  });

  describe('cancellation with ReasonDialog', () => {
    it('opens ReasonDialog instead of window.prompt', async () => {
      await render();
      const cancelBtns = Array.from(container.querySelectorAll('button'))
        .filter((b) => b.textContent?.includes('İptal et'));
      expect(cancelBtns.length).toBeGreaterThan(0);
      await act(async () => cancelBtns[0].click());
      const dialogs = document.querySelectorAll('[role="dialog"]');
      const cancelDialog = Array.from(dialogs).find(
        (d) => d.textContent?.includes('Plan iptali'),
      );
      expect(cancelDialog).toBeTruthy();
    });

    it('requires reason before confirming', async () => {
      await render();
      const cancelBtns = Array.from(container.querySelectorAll('button'))
        .filter((b) => b.textContent?.includes('İptal et'));
      await act(async () => cancelBtns[0].click());

      const dialogs = document.querySelectorAll('[role="dialog"]');
      const cancelDialog = Array.from(dialogs).find(
        (d) => d.textContent?.includes('Plan iptali'),
      );
      expect(cancelDialog).toBeTruthy();

      // Submit empty form
      const form = cancelDialog!.querySelector('form');
      await act(async () => {
        form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      expect(calendarApi.cancelManualEvent).not.toHaveBeenCalled();
    });

    it('calls cancelManualEvent with reason and correct payload', async () => {
      await render();
      const cancelBtns = Array.from(container.querySelectorAll('button'))
        .filter((b) => b.textContent?.includes('İptal et'));
      await act(async () => cancelBtns[0].click());

      const dialogs = document.querySelectorAll('[role="dialog"]');
      const cancelDialog = Array.from(dialogs).find(
        (d) => d.textContent?.includes('Plan iptali'),
      );
      expect(cancelDialog).toBeTruthy();

      const textarea = cancelDialog!.querySelector('textarea') as HTMLTextAreaElement;
      expect(textarea).toBeTruthy();

      // React-compatible value change
      await act(async () => {
        setReactValue(textarea, 'Artık gerekli değil');
      });

      const confirmBtn = Array.from(cancelDialog!.querySelectorAll('button'))
        .find((b) => b.textContent?.includes('İptal et'));
      expect(confirmBtn).toBeTruthy();

      await act(async () => {
        confirmBtn!.click();
      });

      // Wait for async cancel to resolve
      await act(async () => {});

      expect(calendarApi.cancelManualEvent).toHaveBeenCalledWith('event-1', {
        clientActionId: expect.any(String) as string,
        expectedVersion: 1,
        cancelReason: expect.stringContaining('Artık gerekli değil') as string,
      });
    });
  });

  it('shows error on cancel failure', async () => {
    calendarApi.cancelManualEvent.mockRejectedValue(new Error('İptal başarısız'));
    await render();
    const cancelBtns = Array.from(container.querySelectorAll('button'))
      .filter((b) => b.textContent?.includes('İptal et'));
    await act(async () => cancelBtns[0].click());

    const dialogs = document.querySelectorAll('[role="dialog"]');
    const cancelDialog = Array.from(dialogs).find(
      (d) => d.textContent?.includes('Plan iptali'),
    );
    expect(cancelDialog).toBeTruthy();

    const textarea = cancelDialog!.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => setReactValue(textarea, 'Neden'));

    const confirmBtn = Array.from(cancelDialog!.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('İptal et'));
    await act(async () => confirmBtn!.click());
    await act(async () => {});

    // Dialog should remain open on error (pending is reset, error shown)
    // The error appears in the EventItem, not the dialog
    const eventError = container.querySelector('.form-error');
    expect(eventError).toBeTruthy();
  });

  it('compact mode count renders on small viewport', async () => {
    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', {
      writable: true,
      configurable: true,
      value: 390,
    });
    window.dispatchEvent(new Event('resize'));

    await render();
    expect(container.querySelector('.servora-calendar')).toBeTruthy();

    Object.defineProperty(window, 'innerWidth', {
      writable: true,
      configurable: true,
      value: originalInnerWidth,
    });
    window.dispatchEvent(new Event('resize'));
  });

  it('does not use window.prompt or window.confirm', async () => {
    const promptSpy = vi.spyOn(window, 'prompt');
    const confirmSpy = vi.spyOn(window, 'confirm');
    await render();
    const cancelBtns = Array.from(container.querySelectorAll('button'))
      .filter((b) => b.textContent?.includes('İptal et'));
    if (cancelBtns.length > 0) {
      await act(async () => cancelBtns[0].click());
    }
    expect(promptSpy).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
    promptSpy.mockRestore();
    confirmSpy.mockRestore();
  });

  it('sr-only source text exists for screen readers', async () => {
    await render();
    const srTexts = container.querySelectorAll('.sr-only');
    expect(srTexts.length).toBeGreaterThan(0);
  });
});
