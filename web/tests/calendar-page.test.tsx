/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CalendarPage } from '../src/calendar/CalendarPage';
import { isoInstantToLocalDateTime } from '../src/jobs/scheduling';
import type { CurrentUser } from '../src/services/api';

const calendarApi = vi.hoisted(() => ({
  listCalendar: vi.fn(),
  listCalendarAssignees: vi.fn(),
  getCalendarEvent: vi.fn(),
  createManualEvent: vi.fn(),
  patchManualEvent: vi.fn(),
  cancelManualEvent: vi.fn(),
}));
const jobsApi = vi.hoisted(() => ({ patchJobCard: vi.fn(), findAvailableSlots: vi.fn() }));
vi.mock('../src/services/calendar-api', () => calendarApi);
vi.mock('../src/jobs/jobs-api', () => jobsApi);
vi.mock('../src/realtime/RealtimeProvider', () => ({
  useRealtimeInvalidation: vi.fn(),
}));
vi.mock('dayjs', () => {
  const actual = vi.importActual('dayjs') as Promise<Record<string, unknown>>;
  return actual;
});
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// Fixed test date: 2026-07-29
const TEST_TODAY = new Date(2026, 6, 29, 10, 0, 0);

const staff: CurrentUser = {
  id: 'staff-1', organizationId: 'org-1', name: 'Ayşe Personel',
  email: 'staff@example.test', role: 'STAFF', mustChangePassword: false,
  isActive: true, version: 1,
  capabilities: { overviewDashboard: true, calendar: true, messaging: false },
  support: { displayLabel: 'Destek', email: null, helpUrl: null },
};

const manager: CurrentUser = {
  id: 'manager-1', organizationId: 'org-1', name: 'Murat Yönetici',
  email: 'manager@example.test', role: 'MANAGER', mustChangePassword: false,
  isActive: true, version: 1,
  capabilities: { overviewDashboard: true, calendar: true, messaging: false },
  support: { displayLabel: 'Destek', email: null, helpUrl: null },
};

const manualEvent = {
  id: 'event-1', source: 'MANUAL' as const, title: 'Klinik hazırlığı',
  description: null, startsAt: '2026-07-29T09:00:00.000Z',
  endsAt: '2026-07-29T10:00:00.000Z', timezone: 'Europe/Istanbul',
  assignedUser: { id: 'staff-1', name: 'Ayşe Personel' }, version: 1,
  status: 'ACTIVE' as const,
  createdBy: { id: 'manager-1', name: 'Murat Yönetici' },
  updatedBy: { id: 'manager-1', name: 'Murat Yönetici' },
  canEdit: true, canCancel: true,
};

const jobEvent = {
  id: 'job-event-1', source: 'JOB' as const, title: 'Ürün teslimi',
  startsAt: '2026-07-28T14:00:00.000Z', endsAt: '2026-07-28T16:00:00.000Z',
  timezone: 'Europe/Istanbul',
  assignedUser: { id: 'staff-1', name: 'Ayşe Personel' }, version: 2,
  jobCardId: 'job-1', jobType: 'PRODUCT_DELIVERY', jobStatus: 'NEW',
  priority: 'normal', customer: null, relatedJobPath: '/jobs/job-1',
  canEdit: true, canCancel: false,
};

const generalTaskEvent = {
  id: 'general-task-event-1', source: 'JOB' as const, title: 'Doktoru ara',
  startsAt: '2026-07-28T14:00:00.000Z', endsAt: null,
  timezone: 'Europe/Istanbul',
  assignedUser: { id: 'staff-1', name: 'Ayşe Personel' }, version: 2,
  jobCardId: 'general-task-1', jobType: 'GENERAL_TASK', jobStatus: 'NEW',
  priority: 'normal', customer: null, relatedJobPath: '/jobs/general-task-1',
  canEdit: true, canCancel: false,
};

/** Simulate user typing into a controlled input/textarea in React. */
function setReactValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const nativeSetter = Object.getOwnPropertyDescriptor(
    element.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype, 'value',
  )?.set;
  nativeSetter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Set viewport width and trigger resize. */
function resizeTo(width: number) {
  Object.defineProperty(window, 'innerWidth', {
    writable: true, configurable: true, value: width,
  });
  window.dispatchEvent(new Event('resize'));
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
    calendarApi.getCalendarEvent.mockImplementation(async (id: string) =>
      id === 'job-event-1' ? jobEvent : manualEvent);
    calendarApi.cancelManualEvent.mockResolvedValue(undefined);
    jobsApi.findAvailableSlots.mockResolvedValue({ slots: [] });
    // Reset viewport to desktop
    resizeTo(1024);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function render(user: CurrentUser = manager, path = '/calendar') {
    await act(async () => {
      root.render(<MemoryRouter initialEntries={[path]}><CalendarPage user={user} /></MemoryRouter>);
    });
    await act(async () => {});
  }

  it('queries the visible month range (≤42 days)', async () => {
    await render();
    expect(calendarApi.listCalendar).toHaveBeenCalledTimes(1);
    const call = calendarApi.listCalendar.mock.calls[0][0] as Record<string, string>;
    const from = new Date(call.from);
    const to = new Date(call.to);
    const days = (to.valueOf() - from.valueOf()) / (24 * 60 * 60 * 1000);
    expect(days).toBeLessThanOrEqual(42);
    expect(days).toBeGreaterThanOrEqual(35);
  });

  it('shows the Manager staff filter', async () => {
    await render();
    const filter = container.querySelector<HTMLSelectElement>('.calendar-toolbar select')!;
    expect(filter).toBeTruthy();
    expect(filter.textContent).toContain('Tüm yetkili personel');
  });

  it('gives the staff filter a stable id and name with an explicit label association', async () => {
    await render();
    const filter = container.querySelector<HTMLSelectElement>('.calendar-toolbar select')!;
    expect(filter.id).toBe('calendar-personnel-filter');
    expect(filter.name).toBe('personnel');
    const label = container.querySelector<HTMLLabelElement>('label[for="calendar-personnel-filter"]');
    expect(label).toBeTruthy();
    expect(label?.textContent).toContain('Personel');
  });

  it('keeps Personnel filtering working with the identified select', async () => {
    await render();
    const filter = container.querySelector<HTMLSelectElement>('.calendar-toolbar select')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(filter, 'staff-1');
      filter.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    const latestCall = calendarApi.listCalendar.mock.calls.at(-1)?.[0] as Record<string, string>;
    expect(latestCall.assignedTo).toBe('staff-1');
  });

  it('hides the staff filter for STAFF role', async () => {
    await render(staff);
    expect(container.querySelector('.calendar-toolbar select')).toBeNull();
  });

  it('renders LoadingSkeleton during load', async () => {
    let resolveList: (v: unknown) => void;
    calendarApi.listCalendar.mockReturnValue(new Promise((r) => { resolveList = r; }));
    await render();
    const skeleton = container.querySelector('[data-servora-loading-skeleton]');
    expect(skeleton).toBeTruthy();
    expect(skeleton!.textContent).toContain('Takvim yükleniyor');
    (resolveList!)([]);
    await act(async () => {});
  });

  it('renders ResultState on error with retry', async () => {
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
  });

  it('renders agenda cards with OperationalCard', async () => {
    await render();
    const card = container.querySelector('.servora-operational-card');
    expect(card).toBeTruthy();
    const source = container.querySelector('.calendar-source--manual');
    expect(source).toBeTruthy();
    expect(source!.textContent).toContain('KİŞİSEL PLAN');
  });

  it('selected card gets selected tone', async () => {
    await render(manager, '/calendar?event=event-1');
    await act(async () => {});
    const selectedCard = container.querySelector('.servora-operational-card--selected');
    expect(selectedCard).toBeTruthy();
    const article = container.querySelector('article[aria-current="true"]');
    expect(article).toBeTruthy();
  });

  describe('custom header behavior', () => {
    it('renders header with prev/today/next', async () => {
      await render();
      const header = container.querySelector('.servora-calendar-header');
      expect(header).toBeTruthy();
      expect(header!.querySelector('[aria-label="Önceki ay"]')).toBeTruthy();
      expect(header!.querySelector('[aria-label="Sonraki ay"]')).toBeTruthy();
      const todayBtn = Array.from(header!.querySelectorAll('button'))
        .find((b) => b.textContent?.includes('Bugün'));
      expect(todayBtn).toBeTruthy();
    });

    it('prev month refreshes calendar with new range', async () => {
      await render();
      const prevBtn = container.querySelector<HTMLButtonElement>('[aria-label="Önceki ay"]')!;
      // listCalendar was called once during initial render
      expect(calendarApi.listCalendar).toHaveBeenCalledTimes(1);
      await act(async () => prevBtn.click());
      // After prev click, listCalendar is called again
      expect(calendarApi.listCalendar).toHaveBeenCalledTimes(2);
      // The second call should have a different range (previous month)
      const firstFrom = (calendarApi.listCalendar.mock.calls[0][0] as Record<string, string>).from;
      const secondFrom = (calendarApi.listCalendar.mock.calls[1][0] as Record<string, string>).from;
      const firstDate = new Date(firstFrom);
      const secondDate = new Date(secondFrom);
      expect(secondDate.valueOf()).toBeLessThan(firstDate.valueOf());
    });

    it('next month refreshes calendar with new range', async () => {
      await render();
      const nextBtn = container.querySelector<HTMLButtonElement>('[aria-label="Sonraki ay"]')!;
      const firstFrom = (calendarApi.listCalendar.mock.calls[0][0] as Record<string, string>).from;
      await act(async () => nextBtn.click());
      const secondFrom = (calendarApi.listCalendar.mock.calls[1][0] as Record<string, string>).from;
      expect(new Date(secondFrom).valueOf()).toBeGreaterThan(new Date(firstFrom).valueOf());
    });

    it('today button returns to current month and selects today', async () => {
      await render();
      const nextBtn = container.querySelector<HTMLButtonElement>('[aria-label="Sonraki ay"]')!;
      // Navigate to next month first
      await act(async () => nextBtn.click());
      await act(async () => {});
      const todayBtn = Array.from(container.querySelectorAll('button'))
        .find((b) => b.textContent?.includes('Bugün'))!;
      await act(async () => todayBtn.click());
      await act(async () => {});
      // After going to today, calendar calls listCalendar again
      // The range should now contain today (July 29, 2026)
      const lastCall = calendarApi.listCalendar.mock.calls[
        calendarApi.listCalendar.mock.calls.length - 1
      ][0] as Record<string, string>;
      const from = new Date(lastCall.from);
      const to = new Date(lastCall.to);
      const today = new Date(2026, 6, 29);
      expect(from.valueOf()).toBeLessThanOrEqual(today.valueOf());
      expect(to.valueOf()).toBeGreaterThan(today.valueOf());
    });
  });

  describe('reactive responsive behavior', () => {
    it('desktop shows event summaries, not compact count', async () => {
      resizeTo(1024);
      await render();
      expect(container.querySelector('.servora-calendar--compact')).toBeNull();
      // Event summaries should exist (manualEvent is today)
      expect(container.querySelector('.servora-calendar-event-summary')).toBeTruthy();
    });

    it('resize to 390 activates compact mode', async () => {
      resizeTo(1024);
      await render();
      expect(container.querySelector('.servora-calendar--compact')).toBeNull();
      // Resize to mobile
      resizeTo(390);
      await act(async () => {});
      expect(container.querySelector('.servora-calendar--compact')).toBeTruthy();
    });

    it('compact mode shows count instead of event summaries', async () => {
      resizeTo(390);
      await render();
      // Count badge should be visible
      expect(container.querySelector('.servora-calendar-count')).toBeTruthy();
      // Desktop event summaries should be hidden
      expect(container.querySelector('.servora-calendar-event-summary')).toBeNull();
    });

    it('keeps AntD native compact cell geometry while adding count decoration', async () => {
      resizeTo(390);
      await render();

      const calendar = container.querySelector('.servora-calendar--compact')!;
      expect(calendar.querySelector('.servora-calendar-root')).toBeTruthy();
      expect(calendar.querySelector('.servora-calendar-item')).toBeTruthy();
      expect(calendar.querySelector('.ant-picker-calendar-date')).toBeTruthy();
      expect(calendar.querySelector('.servora-calendar-cell')).toBeNull();
      expect(calendar.querySelector('.servora-calendar-count')).toBeTruthy();
    });

    it('leaves selected and today styling to AntD in compact mode', async () => {
      resizeTo(390);
      await render();

      const calendar = container.querySelector('.servora-calendar--compact')!;
      expect(calendar.querySelector('.ant-picker-cell-selected')).toBeTruthy();
      expect(calendar.querySelector('.ant-picker-calendar-date-today')).toBeTruthy();
      expect(calendar.querySelector('.servora-calendar-cell--selected')).toBeNull();
      expect(calendar.querySelector('.servora-calendar-cell--today')).toBeNull();
      expect(calendar.querySelector('.servora-calendar-date--selected')).toBeNull();
    });

    it('native compact date-cell selection updates the agenda', async () => {
      resizeTo(390);
      await render();

      const dateCell = Array.from(
        container.querySelectorAll<HTMLTableCellElement>('.ant-picker-cell-in-view'),
      ).find((cell) => cell.querySelector('.ant-picker-calendar-date-value')?.textContent?.trim() === '28');
      expect(dateCell).toBeTruthy();

      const agendaBefore = container.querySelector('.calendar-agenda-section')?.textContent ?? '';
      await act(async () => dateCell!.click());
      await act(async () => {});
      const agenda = container.querySelector('.calendar-agenda-section')?.textContent ?? '';
      expect(agenda).not.toBe(agendaBefore);
      expect(agenda).toContain('28 Temmuz');
      expect(agenda).toContain('Ürün teslimi');
    });

    it('renders a two-digit event count without replacing native compact content', async () => {
      calendarApi.listCalendar.mockResolvedValue(
        Array.from({ length: 12 }, (_, index) => ({ ...manualEvent, id: `manual-${index}` })),
      );
      resizeTo(390);
      await render();

      const count = container.querySelector('.servora-calendar-count');
      expect(count?.textContent).toBe('12');
      expect(count?.closest('.ant-picker-calendar-date-content')).toBeTruthy();
      expect(count?.closest('.ant-picker-calendar-date')?.querySelector('.ant-picker-calendar-date-value')).toBeTruthy();
    });

    it('does not render a count badge for an empty compact day set', async () => {
      calendarApi.listCalendar.mockResolvedValue([]);
      resizeTo(390);
      await render();

      const calendar = container.querySelector('.servora-calendar--compact')!;
      expect(calendar.querySelector('.ant-picker-calendar-date')).toBeTruthy();
      expect(calendar.querySelector('.servora-calendar-count')).toBeNull();
    });

    it('resize back to 1024 restores desktop mode', async () => {
      resizeTo(390);
      await render();
      expect(container.querySelector('.servora-calendar--compact')).toBeTruthy();
      // Resize back to desktop
      resizeTo(1024);
      await act(async () => {});
      expect(container.querySelector('.servora-calendar--compact')).toBeNull();
      expect(container.querySelector('.servora-calendar-event-summary')).toBeTruthy();
    });
  });

  it('opens the form drawer when clicking Yeni plan', async () => {
    await render();
    const createBtn = Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Yeni plan'))!;
    await act(async () => createBtn.click());
    const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
    expect(dialog).toBeTruthy();
  });

  it('edits a General Task as a point without an end field or implicit duration', async () => {
    calendarApi.listCalendar.mockResolvedValue([generalTaskEvent]);
    calendarApi.getCalendarEvent.mockResolvedValue(generalTaskEvent);
    jobsApi.patchJobCard.mockResolvedValue({});
    await render(manager, '/calendar?event=general-task-event-1');

    const editButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Düzenle'));
    expect(editButton).toBeTruthy();
    await act(async () => editButton!.click());

    const dialog = document.querySelector('[role="dialog"][aria-modal="true"]')!;
    expect(dialog.textContent).not.toContain('Bitiş');
    expect(dialog.querySelectorAll('input[type="datetime-local"]')).toHaveLength(1);

    await act(async () => {
      dialog.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await act(async () => {});

    expect(jobsApi.patchJobCard).toHaveBeenCalledWith('general-task-1', expect.objectContaining({
      expectedVersion: 2,
      scheduledAt: expect.any(String) as string,
    }));
    expect(jobsApi.patchJobCard.mock.calls[0]?.[1]).not.toHaveProperty('scheduledEndsAt');
  });

  it('keeps Product Delivery edits start-only so persisted duration remains authoritative', async () => {
    jobsApi.patchJobCard.mockResolvedValue({});
    await render(manager, '/calendar?event=job-event-1');

    const editButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Düzenle'));
    await act(async () => editButton!.click());

    const dialog = document.querySelector('[role="dialog"][aria-modal="true"]')!;
    expect(dialog.querySelectorAll('input[type="datetime-local"]')).toHaveLength(1);
    await act(async () => {
      dialog.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await act(async () => {});

    expect(jobsApi.patchJobCard.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      scheduledAt: expect.any(String),
    }));
    expect(jobsApi.patchJobCard.mock.calls[0]?.[1]).not.toHaveProperty('scheduledEndsAt');
  });

  it('offers a joint slot for a customer-bound Product Delivery calendar edit', async () => {
    const customerEvent = {
      ...jobEvent,
      customer: { id: 'customer-1', name: 'Klinik' },
    };
    calendarApi.listCalendar.mockResolvedValue([customerEvent]);
    calendarApi.getCalendarEvent.mockResolvedValue(customerEvent);
    jobsApi.findAvailableSlots.mockResolvedValue({ slots: [{
      startsAt: '2026-07-29T10:00:00.000Z',
      endsAt: '2026-07-29T12:00:00.000Z',
    }] });
    await render(manager, '/calendar?event=job-event-1');
    const editButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Düzenle'))!;
    await act(async () => editButton.click());
    await act(async () => { vi.advanceTimersByTime(300); });
    await act(async () => { await Promise.resolve(); });

    const dialog = document.querySelector('[role="dialog"][aria-modal="true"]')!;
    const slotButton = dialog.querySelector('button[data-available-slot]') as HTMLButtonElement;
    expect(slotButton).toBeTruthy();
    await act(async () => slotButton.click());
    expect(dialog.querySelectorAll('input[type="datetime-local"]')[0]).toHaveProperty(
      'value', isoInstantToLocalDateTime('2026-07-29T10:00:00.000Z'),
    );
  });

  it('deep-link selects the event', async () => {
    await render(manager, '/calendar?event=event-1');
    await act(async () => {});
    const selected = container.querySelector('.servora-operational-card--selected');
    expect(selected).toBeTruthy();
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
        (d) => d.textContent?.includes('Plan iptali'));
      expect(cancelDialog).toBeTruthy();
    });

    it('requires reason before confirming', async () => {
      await render();
      const cancelBtns = Array.from(container.querySelectorAll('button'))
        .filter((b) => b.textContent?.includes('İptal et'));
      await act(async () => cancelBtns[0].click());
      const dialogs = document.querySelectorAll('[role="dialog"]');
      const cancelDialog = Array.from(dialogs).find(
        (d) => d.textContent?.includes('Plan iptali'));
      const form = cancelDialog!.querySelector('form');
      await act(async () => {
        form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      expect(calendarApi.cancelManualEvent).not.toHaveBeenCalled();
    });

    it('calls cancelManualEvent with correct payload', async () => {
      await render();
      const cancelBtns = Array.from(container.querySelectorAll('button'))
        .filter((b) => b.textContent?.includes('İptal et'));
      await act(async () => cancelBtns[0].click());
      const dialogs = document.querySelectorAll('[role="dialog"]');
      const cancelDialog = Array.from(dialogs).find(
        (d) => d.textContent?.includes('Plan iptali'));
      const textarea = cancelDialog!.querySelector('textarea') as HTMLTextAreaElement;
      await act(async () => setReactValue(textarea, 'Artık gerekli değil'));
      const confirmBtn = Array.from(cancelDialog!.querySelectorAll('button'))
        .find((b) => b.textContent?.includes('İptal et'));
      await act(async () => confirmBtn!.click());
      await act(async () => {});
      expect(calendarApi.cancelManualEvent).toHaveBeenCalledWith('event-1', {
        clientActionId: expect.any(String) as string,
        expectedVersion: 1,
        cancelReason: expect.stringContaining('Artık gerekli değil') as string,
      });
    });
  });

  it('on cancel failure, dialog closes and error appears in card', async () => {
    calendarApi.cancelManualEvent.mockRejectedValue(new Error('İptal başarısız'));
    await render();
    const cancelBtns = Array.from(container.querySelectorAll('button'))
      .filter((b) => b.textContent?.includes('İptal et'));
    await act(async () => cancelBtns[0].click());
    const dialogs = document.querySelectorAll('[role="dialog"]');
    const cancelDialog = Array.from(dialogs).find(
      (d) => d.textContent?.includes('Plan iptali'));
    const textarea = cancelDialog!.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => setReactValue(textarea, 'Neden'));
    const confirmBtn = Array.from(cancelDialog!.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('İptal et'));
    await act(async () => confirmBtn!.click());
    await act(async () => {});
    // Dialog should be gone
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    // Error should appear in the card (EventItem)
    const eventError = container.querySelector('.form-error');
    expect(eventError).toBeTruthy();
    expect(eventError!.textContent).toContain('İptal başarısız');
  });

  it('does not use window.prompt or window.confirm', async () => {
    const promptSpy = vi.spyOn(window, 'prompt');
    const confirmSpy = vi.spyOn(window, 'confirm');
    await render();
    const cancelBtns = Array.from(container.querySelectorAll('button'))
      .filter((b) => b.textContent?.includes('İptal et'));
    if (cancelBtns.length > 0) await act(async () => cancelBtns[0].click());
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

  describe('calendar keyboard accessibility', () => {
    it('renders each date cell as a focusable button with the date aria-label', async () => {
      await render();
      const dateButton = container.querySelector<HTMLButtonElement>('button[aria-label="2026-07-29"]');
      expect(dateButton).toBeTruthy();
      expect(dateButton!.type).toBe('button');
      await act(async () => dateButton!.focus());
      expect(document.activeElement).toBe(dateButton);
      expect(dateButton!.getAttribute('aria-pressed')).toBe('true');
    });

    it('date button activation selects the day and updates the agenda', async () => {
      await render();
      const dateButton = container.querySelector<HTMLButtonElement>('button[aria-label="2026-07-28"]')!;
      const agendaBefore = container.querySelector('.calendar-agenda-section')?.textContent ?? '';
      await act(async () => dateButton.click());
      await act(async () => {});
      const agenda = container.querySelector('.calendar-agenda-section')?.textContent ?? '';
      expect(agenda).not.toBe(agendaBefore);
      expect(agenda).toContain('28 Temmuz');
      expect(agenda).toContain('Ürün teslimi');
      expect(agenda).not.toContain('Klinik hazırlığı');
    });

    it('event summary is a button and Enter activation selects the event', async () => {
      await render();
      const eventButtons = Array.from(container.querySelectorAll<HTMLButtonElement>('button.servora-calendar-event-summary'));
      expect(eventButtons.length).toBeGreaterThan(0);
      const first = eventButtons[0]!;
      expect(first.type).toBe('button');
      await act(async () => first.focus());
      expect(document.activeElement).toBe(first);
      calendarApi.getCalendarEvent.mockClear();
      await act(async () => first.click());
      await act(async () => { await Promise.resolve(); });
      await act(async () => { await Promise.resolve(); });
      expect(calendarApi.getCalendarEvent).toHaveBeenCalledWith(first.getAttribute('data-event-id'));
      const selected = container.querySelector('.servora-operational-card--selected');
      expect(selected).toBeTruthy();
    });

    it('keeps native date cells and event counts available in compact/mobile mode', async () => {
      resizeTo(390);
      await render();
      expect(container.querySelector('.servora-calendar--compact')).toBeTruthy();
      expect(container.querySelector('.ant-picker-calendar-date')).toBeTruthy();
      expect(container.querySelector('.ant-picker-cell-selected')).toBeTruthy();
      expect(container.querySelector('.servora-calendar-count')).toBeTruthy();
    });
  });
});
