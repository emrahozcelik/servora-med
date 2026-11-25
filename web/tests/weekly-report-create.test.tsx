/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ConfigProvider } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WeeklyReportCreateScreen } from '../src/WeeklyReportCreate';
import { ApiError, type CurrentUser } from '../src/services/api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/**
 * `MAX_BULK_TARGETS` is deliberately lowered for this suite: the over-cap path
 * would otherwise need 51 simulated dropdown selections. The real ceiling (50)
 * is a server-owned constant verified by the server parser tests.
 */
const weeklyApi = vi.hoisted(() => ({
  createWeeklyReport: vi.fn(),
  bulkRequestWeeklyReports: vi.fn(),
  getWeeklyReportReference: vi.fn(),
  MAX_BULK_TARGETS: 2,
}));
const people = vi.hoisted(() => ({ listStaff: vi.fn() }));

vi.mock('../src/jobs/weekly-report-api', async (original) => ({
  ...await original<typeof import('../src/jobs/weekly-report-api')>(), ...weeklyApi,
}));
vi.mock('../src/services/people-api', async (original) => ({
  ...await original<typeof import('../src/services/people-api')>(), ...people,
}));

const manager: CurrentUser = {
  id: 'manager-1', organizationId: 'org-1', name: 'Murat Yönetici', email: 'm@test.local',
  role: 'MANAGER', mustChangePassword: false, isActive: true, version: 1,
  capabilities: {
    overviewDashboard: true, calendar: true, messaging: true,
  },
  support: { displayLabel: 'Sistem yöneticiniz', email: null, helpUrl: null },
};
const staffUser: CurrentUser = {
  ...manager, id: 'staff-1', name: 'Ayşe Personel', role: 'STAFF',
};

function staffProfile(id: string, name: string) {
  return {
    id: `profile-${id}`,
    user: {
      id, organizationId: 'org-1', name, email: `${id}@test.local`,
      role: 'STAFF' as const, mustChangePassword: false, isActive: true, version: 1,
    },
  };
}

const AYSE = staffProfile('staff-1', 'Ayşe Personel');
const MEHMET = staffProfile('staff-2', 'Mehmet Personel');
const ZEYNEP = staffProfile('staff-3', 'Zeynep Personel');

/**
 * Canonical workweek reference deliberately pinned to a week that is NOT the
 * developer machine's current week. Any device-local default would therefore be
 * detectable.
 */
const REFERENCE = {
  timezone: 'Europe/Istanbul',
  today: '2026-08-07',
  periodStart: '2026-08-03',
  periodEnd: '2026-08-08',
  dueDate: '2026-08-10',
};

function change(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLSelectElement
    ? HTMLSelectElement.prototype
    : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
  act(() => {
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}

async function flush() {
  await act(async () => { await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)); });
}

function resizeTo(width: number) {
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: width });
  window.dispatchEvent(new Event('resize'));
}

describe('Weekly report create screen', () => {
  let root: Root;
  let host: HTMLDivElement;
  let onCreated: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    resizeTo(1024);
    let action = 0;
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      configurable: true, value: vi.fn(() => `action-${++action}`),
    });
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
      matches: false, media: '', onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    }));
    people.listStaff.mockResolvedValue([AYSE, MEHMET, ZEYNEP]);
    weeklyApi.getWeeklyReportReference.mockResolvedValue(REFERENCE);
    weeklyApi.createWeeklyReport.mockResolvedValue({
      jobCardId: 'job-1', reportId: 'report-1', staffUserId: 'staff-1',
      periodStart: '2026-08-03', periodEnd: '2026-08-08', status: 'ACCEPTED', dueDate: '2026-08-10',
    });
    weeklyApi.bulkRequestWeeklyReports.mockResolvedValue({
      periodStart: '2026-08-03', periodEnd: '2026-08-08', dueDate: '2026-08-10',
      items: [{ staffUserId: 'staff-1', jobCardId: 'job-1', reportId: 'report-1', outcome: 'created' }],
    });
    onCreated = vi.fn();
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    document.querySelectorAll('.ant-select-dropdown').forEach((node) => node.remove());
    vi.unstubAllGlobals();
  });

  async function render(user: CurrentUser = staffUser, initial: { initialPeriodStart?: string; initialStaffUserId?: string } = {}) {
    await act(async () => root.render(
      <ConfigProvider>
        <WeeklyReportCreateScreen user={user} onCancel={() => {}} onCreated={onCreated} {...initial} />
      </ConfigProvider>,
    ));
    await flush();
  }

  it('renders and commits the compact wheel trigger for a custom report week', async () => {
    resizeTo(390);
    await render(staffUser, { initialPeriodStart: '2026-08-10' });
    const trigger = host.querySelector<HTMLButtonElement>('#weekly-period')!;
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.hasAttribute('name')).toBe(false);
    const before = trigger.textContent;
    await act(async () => trigger.click());
    const day = document.querySelector<HTMLElement>('[role="spinbutton"][aria-label="Gün"]')!;
    await act(async () => {
      day.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    });
    const ok = [...document.querySelectorAll<HTMLButtonElement>('.wheel-sheet-actions button')]
      .find((button) => button.textContent === 'Tamam')!;
    await act(async () => ok.click());
    expect(trigger.textContent).not.toBe(before);
    expect(document.body.style.overflow).toBe('');
  });

  function submit() {
    const form = host.querySelector('form');
    expect(form).not.toBeNull();
    act(() => { form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  }

  function weekRadio(mode: 'this_week' | 'last_week' | 'custom'): HTMLInputElement {
    const radio = host.querySelector<HTMLInputElement>(`input[name="weeklyPeriodChoice"][value="${mode}"]`);
    expect(radio, `week radio "${mode}"`).not.toBeNull();
    return radio!;
  }

  async function selectWeekChoice(mode: 'this_week' | 'last_week' | 'custom') {
    const radio = weekRadio(mode);
    await act(async () => { radio.click(); });
    await flush();
  }

  // --- multi-select driving helpers (AntD Select renders its popup on body) ---

  function openAssignees() {
    const content = host.querySelector('.ant-select-content') as HTMLElement | null;
    expect(content, 'assignee select content').not.toBeNull();
    content!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    content!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }

  function assigneeOptions(): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>('.ant-select-item-option'));
  }

  async function pickOption(label: string) {
    const option = assigneeOptions().find((node) => (node.textContent ?? '').includes(label));
    expect(option, `option "${label}"`).toBeDefined();
    await act(async () => {
      option!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      option!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
  }

  async function chooseStaff(labels: string[]) {
    await act(async () => { openAssignees(); });
    await flush();
    for (const label of labels) await pickOption(label);
  }

  function selectedCountText() {
    return host.querySelector('#weekly-assignee-count')?.textContent?.trim() ?? '';
  }

  function tagTitles(): string[] {
    return Array.from(host.querySelectorAll('.ant-select-selection-item'))
      .map((node) => node.getAttribute('title') ?? '');
  }

  function buttonByText(text: string) {
    return Array.from(host.querySelectorAll('button')).find((button) => button.textContent === text);
  }

  async function clickButton(label: string) {
    const button = buttonByText(label);
    expect(button, `button "${label}"`).toBeDefined();
    await act(async () => { button!.dispatchEvent(new Event('click', { bubbles: true })); });
    await flush();
  }

  function bulkInput(call = 0) {
    expect(weeklyApi.bulkRequestWeeklyReports).toHaveBeenCalled();
    return weeklyApi.bulkRequestWeeklyReports.mock.calls[call]![0];
  }

  // --- Week choice & D9 preview ---

  it('defaults to "Bu hafta" from the server reference and formats Turkish Monday-Saturday ranges', async () => {
    weeklyApi.getWeeklyReportReference.mockResolvedValueOnce({
      timezone: 'Europe/Istanbul',
      today: '2026-11-20',
      periodStart: '2026-11-16',
      periodEnd: '2026-11-21',
      dueDate: '2026-11-23',
    });
    await render(staffUser);
    expect(weekRadio('this_week').checked).toBe(true);
    expect(host.textContent).toContain('Bu hafta · 16–21 Kasım');
    expect(host.textContent).toContain('Geçen hafta · 9–14 Kasım');
    expect(host.textContent).toContain('Başka hafta');
    // Date input is hidden unless "Başka hafta" is selected.
    expect(host.querySelector('#weekly-period')).toBeNull();
    expect(host.querySelector('#weekly-period-preview')?.textContent)
      .toBe('Dönem 16–21 Kasım 2026 · Son teslim 23 Kasım Pazartesi');
    expect(host.textContent).toContain('organizasyon takvimine göre');
    expect(host.textContent).toContain('Pazartesi–Cumartesi çalışma haftasını kapsar');
  });

  it('computes D9 preview deadline via max(selectedMonday + 7, reference.today) across Friday, Monday, Tuesday (A18/A18b/A21)', async () => {
    // Tuesday 2026-11-24: reference week is 23-28 Nov, "Geçen hafta" (16-21 Nov) has Monday deadline 23 Nov < today 24 Nov => 24 Nov Salı (A21).
    weeklyApi.getWeeklyReportReference.mockResolvedValueOnce({
      timezone: 'Europe/Istanbul',
      today: '2026-11-24',
      periodStart: '2026-11-23',
      periodEnd: '2026-11-28',
      dueDate: '2026-11-30',
    });
    await render(staffUser);
    expect(host.querySelector('#weekly-period-preview')?.textContent)
      .toBe('Dönem 23–28 Kasım 2026 · Son teslim 30 Kasım Pazartesi');

    await selectWeekChoice('last_week');
    expect(host.querySelector('#weekly-period-preview')?.textContent)
      .toBe('Dönem 16–21 Kasım 2026 · Son teslim 24 Kasım Salı');

    // Future week via "Başka hafta": 2026-11-30 => Monday after period 2026-12-07.
    await selectWeekChoice('custom');
    const dateInput = host.querySelector('#weekly-period') as HTMLInputElement;
    expect(dateInput).not.toBeNull();
    change(dateInput, '2026-11-30');
    expect(host.querySelector('#weekly-period-preview')?.textContent)
      .toBe('Dönem 30 Kasım – 5 Aralık 2026 · Son teslim 7 Aralık Pazartesi');
  });

  it('keeps Monday after the period when choosing "Geçen hafta" on Monday (A18)', async () => {
    weeklyApi.getWeeklyReportReference.mockResolvedValueOnce({
      timezone: 'Europe/Istanbul',
      today: '2026-11-23',
      periodStart: '2026-11-23',
      periodEnd: '2026-11-28',
      dueDate: '2026-11-30',
    });
    await render(staffUser);
    await selectWeekChoice('last_week');
    expect(host.querySelector('#weekly-period-preview')?.textContent)
      .toBe('Dönem 16–21 Kasım 2026 · Son teslim 23 Kasım Pazartesi');
  });

  it('rejects a non-Monday date entered under "Başka hafta"', async () => {
    await render(staffUser);
    await selectWeekChoice('custom');
    change(host.querySelector('#weekly-period') as HTMLInputElement, '2026-08-04'); // Tuesday
    await act(async () => { submit(); await flush(); });
    expect(weeklyApi.createWeeklyReport).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Pazartesi günü başlamalıdır');
  });

  it('falls back to manual date input without guessing a deadline when the organization calendar fails to load', async () => {
    weeklyApi.getWeeklyReportReference.mockRejectedValueOnce(new Error('network error'));
    await render(staffUser);
    const input = host.querySelector('#weekly-period') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(host.textContent).toContain('Organizasyon takvimi yüklenemedi');
    change(input, '2026-11-02');
    expect(host.querySelector('#weekly-period-preview')?.textContent)
      .toBe('Dönem 2–7 Kasım 2026 · Son teslim tarihi sunucuda belirlenir');
  });

  it('hides the manual date input while loading reference and disables STAFF empty submit until ready', async () => {
    let resolveReference!: (value: typeof REFERENCE) => void;
    weeklyApi.getWeeklyReportReference.mockReturnValueOnce(
      new Promise((resolve) => { resolveReference = resolve; }),
    );
    await render(staffUser);
    expect(host.querySelector('#weekly-period')).toBeNull();
    const submitBtn = host.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);

    await act(async () => {
      resolveReference(REFERENCE);
      await flush();
    });
    expect(submitBtn.disabled).toBe(false);
    expect(host.querySelector('#weekly-period-preview')?.textContent)
      .toBe('Dönem 3–8 Ağustos 2026 · Son teslim 10 Ağustos Pazartesi');
  });

  it('prefills the removed report week and Staff without creating or copying content automatically', async () => {
    await render(manager, { initialPeriodStart: '2026-07-27', initialStaffUserId: 'staff-1' });
    // 2026-07-27 is last week relative to REFERENCE (2026-08-03)
    expect(weekRadio('last_week').checked).toBe(true);
    expect(weeklyApi.bulkRequestWeeklyReports).not.toHaveBeenCalled();
    expect(weeklyApi.createWeeklyReport).not.toHaveBeenCalled();
    await act(async () => { submit(); await flush(); });
    expect(bulkInput()).toMatchObject({ periodStart: '2026-07-27', staffUserIds: ['staff-1'] });
    expect(bulkInput()).not.toHaveProperty('instructions');
    expect(bulkInput()).not.toHaveProperty('questions');
  });

  it('shows custom date input prefilled when initialPeriodStart is an older week', async () => {
    await render(manager, { initialPeriodStart: '2026-07-13', initialStaffUserId: 'staff-1' });
    expect(weekRadio('custom').checked).toBe(true);
    expect((host.querySelector('#weekly-period') as HTMLInputElement).value).toBe('2026-07-13');
    await act(async () => { submit(); await flush(); });
    expect(bulkInput()).toMatchObject({ periodStart: '2026-07-13', staffUserIds: ['staff-1'] });
  });

  it('ignores another Staff preselection on the self-create path', async () => {
    await render(staffUser, { initialPeriodStart: '2026-07-27', initialStaffUserId: 'staff-2' });
    await act(async () => { submit(); await flush(); });
    expect(weeklyApi.createWeeklyReport.mock.calls[0]![0]).toMatchObject({ periodStart: '2026-07-27' });
    expect(weeklyApi.createWeeklyReport.mock.calls[0]![0]).not.toHaveProperty('assignedTo');
  });

  // --- STAFF self-create ---

  it('creates a self report for STAFF without multi-select, questions or due date', async () => {
    await render(staffUser);
    expect(host.querySelector('#weekly-assignees')).toBeNull();
    expect(host.querySelector('#weekly-preset-questions')).toBeNull();
    expect(host.textContent).toContain('Ayşe Personel');
    await act(async () => { submit(); await flush(); });
    expect(weeklyApi.createWeeklyReport).toHaveBeenCalledTimes(1);
    const input = weeklyApi.createWeeklyReport.mock.calls[0]![0];
    expect(input).toMatchObject({ periodStart: '2026-08-03' });
    expect(input).not.toHaveProperty('assignedTo');
    expect(input).not.toHaveProperty('questions');
    expect(input).not.toHaveProperty('dueDate');
    expect(onCreated).toHaveBeenCalledWith('job-1');
  });

  it('never uses the bulk endpoint for a STAFF self-create', async () => {
    await render(staffUser);
    await act(async () => { submit(); await flush(); });
    expect(weeklyApi.bulkRequestWeeklyReports).not.toHaveBeenCalled();
    expect(people.listStaff).not.toHaveBeenCalled();
  });

  it('links to the existing report on duplicate conflict with admin removal hint', async () => {
    await render(staffUser);
    weeklyApi.createWeeklyReport.mockRejectedValueOnce(new ApiError(
      409, 'WEEKLY_REPORT_ALREADY_EXISTS', 'Bu personel için bu haftaya ait rapor zaten mevcut.',
      false, { reportId: 'report-9', jobCardId: 'job-9', periodStart: '2026-08-03' },
    ));
    await act(async () => { submit(); await flush(); });
    expect(onCreated).not.toHaveBeenCalled();
    const link = host.querySelector('a[href="/jobs/job-9"]');
    expect(link?.textContent).toContain('Mevcut rapora git');
    expect(host.textContent).toContain('Admin');
  });

  it('freezes the original attempt for ambiguous STAFF failures and retries it verbatim', async () => {
    await render(staffUser);
    weeklyApi.createWeeklyReport.mockRejectedValueOnce(new Error('transport lost'));
    await act(async () => { submit(); await flush(); });
    expect(onCreated).not.toHaveBeenCalled();
    const firstInput = weeklyApi.createWeeklyReport.mock.calls[0]![0];
    weeklyApi.createWeeklyReport.mockResolvedValueOnce({
      jobCardId: 'job-2', reportId: 'report-2', staffUserId: 'staff-1',
      periodStart: '2026-08-03', periodEnd: '2026-08-08', status: 'ACCEPTED', dueDate: '2026-08-10',
    });
    const retry = buttonByText('Özgün isteği tekrar dene');
    expect(retry).toBeDefined();
    await act(async () => {
      retry!.dispatchEvent(new Event('click', { bubbles: true }));
      await flush();
    });
    expect(weeklyApi.createWeeklyReport).toHaveBeenCalledTimes(2);
    expect(weeklyApi.createWeeklyReport.mock.calls[1]![0]).toEqual(firstInput);
    expect(onCreated).toHaveBeenCalledWith('job-2');
  });

  // --- MANAGER multi-select surface: Tümünü seç / Seçimi temizle ---

  it('offers MANAGER a searchable multi-select of active STAFF only', async () => {
    await render(manager);
    expect(host.querySelector('#weekly-assignees')).not.toBeNull();
    expect(host.querySelector('.ant-select-multiple')).not.toBeNull();
    expect(host.querySelector('.ant-select-show-search')).not.toBeNull();
    await act(async () => { openAssignees(); });
    await flush();
    expect(assigneeOptions().map((node) => node.textContent)).toEqual([
      'Ayşe Personel', 'Mehmet Personel', 'Zeynep Personel',
    ]);
    expect(people.listStaff).toHaveBeenCalledWith('active');
  });

  it('Tümünü seç selects every active staff member and never duplicates ids', async () => {
    people.listStaff.mockResolvedValue([AYSE, MEHMET]);
    await render(manager);
    await clickButton('Tümünü seç');
    expect(selectedCountText()).toBe('2 personel seçildi');
    expect(tagTitles()).toEqual(['Ayşe Personel', 'Mehmet Personel']);
    await act(async () => { submit(); await flush(); });
    expect(bulkInput().staffUserIds).toEqual(['staff-1', 'staff-2']);
  });

  it('Seçimi temizle clears the selection', async () => {
    await render(manager);
    await chooseStaff(['Ayşe Personel', 'Mehmet Personel']);
    expect(selectedCountText()).toBe('2 personel seçildi');
    await clickButton('Seçimi temizle');
    expect(selectedCountText()).toBe('0 personel seçildi');
    expect(tagTitles()).toEqual([]);
    await clickButton('Seçimi temizle');
    await act(async () => { submit(); await flush(); });
    expect(weeklyApi.bulkRequestWeeklyReports).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Aktif bir sorumlu personel seçin.');
  });

  it('over-cap staff count fails visibly instead of pretending all were selected', async () => {
    await render(manager);
    await clickButton('Tümünü seç');
    expect(selectedCountText()).toBe('0 personel seçildi');
    expect(tagTitles()).toEqual([]);
    expect(host.textContent).toContain('Tek işlemde en fazla 2 personel seçilebilir');
    expect(host.textContent).toContain('sınırın üzerinde');
    await act(async () => { submit(); await flush(); });
    expect(weeklyApi.bulkRequestWeeklyReports).not.toHaveBeenCalled();
  });

  it('caps a manual over-cap selection so no oversized command can be sent', async () => {
    await render(manager);
    await chooseStaff(['Ayşe Personel', 'Mehmet Personel']);
    await pickOption('Zeynep Personel');
    expect(selectedCountText()).toBe('2 personel seçildi');
    expect(host.textContent).toContain('fazlası eklenmedi');
    await act(async () => { submit(); await flush(); });
    expect(weeklyApi.bulkRequestWeeklyReports).toHaveBeenCalledTimes(1);
    expect(bulkInput().staffUserIds).toHaveLength(2);
  });

  it('disables the selection actions while a request is pending or ambiguous', async () => {
    await render(manager);
    await chooseStaff(['Ayşe Personel']);
    weeklyApi.bulkRequestWeeklyReports.mockReturnValue(new Promise(() => {}));
    await act(async () => { submit(); await flush(); });
    expect((host.querySelector('#weekly-select-all-staff') as HTMLButtonElement).disabled).toBe(true);
    expect((host.querySelector('#weekly-clear-staff-selection') as HTMLButtonElement).disabled).toBe(true);
  });

  // --- Termin removal (single and bulk commands) ---

  it('one-time mode has no editable termin field anywhere', async () => {
    await render(manager);
    expect(host.querySelector('#weekly-due')).toBeNull();
    expect(host.querySelector('input[name="dueDate"]')).toBeNull();
    expect(host.textContent).not.toContain('isteğe bağlı, varsayılan');
  });

  it('offers no automatic/recurring mode control', async () => {
    await render(manager);
    expect(host.querySelector('#weekly-mode')).toBeNull();
    expect(host.querySelector('#weekly-mode-recurring')).toBeNull();
    expect(host.textContent).not.toContain('Her hafta otomatik');
    expect(host.querySelector('#weekly-due-derived')).toBeNull();
  });

  it('STAFF sees no editable termin field either', async () => {
    await render(staffUser);
    expect(host.querySelector('#weekly-due')).toBeNull();
    expect(host.querySelector('#weekly-due-derived')).toBeNull();
    expect(host.textContent).toContain('teslim son tarihi');
  });

  // --- canonical payload omits dueDate in every mode ---

  it('sends one bulk command with every selected id and never a due date', async () => {
    await render(manager);
    await chooseStaff(['Zeynep Personel', 'Ayşe Personel']);
    change(host.querySelector('#weekly-instructions') as HTMLTextAreaElement, 'Lütfen doldurun.');
    await act(async () => { submit(); await flush(); });
    expect(weeklyApi.createWeeklyReport).not.toHaveBeenCalled();
    expect(weeklyApi.bulkRequestWeeklyReports).toHaveBeenCalledTimes(1);
    expect(bulkInput()).toMatchObject({
      clientActionId: 'action-1',
      periodStart: '2026-08-03',
      staffUserIds: ['staff-3', 'staff-1'],
      instructions: 'Lütfen doldurun.',
    });
    expect(bulkInput()).not.toHaveProperty('dueDate');
  });

  it('blocks submit with an empty selection and surfaces the field error', async () => {
    await render(manager);
    await act(async () => { submit(); await flush(); });
    expect(weeklyApi.bulkRequestWeeklyReports).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Aktif bir sorumlu personel seçin.');
  });

  // --- D8: success and duplicate UX ---

  it('navigates directly when exactly one target has outcome "created"', async () => {
    await render(manager);
    await chooseStaff(['Ayşe Personel']);
    await act(async () => { submit(); await flush(); });
    expect(onCreated).toHaveBeenCalledWith('job-1');
    expect(host.querySelector('#weekly-bulk-result-title')).toBeNull();
  });

  it('does not navigate for a single "existing" outcome and shows link + admin removal hint (D8 / A12)', async () => {
    await render(manager);
    weeklyApi.bulkRequestWeeklyReports.mockResolvedValueOnce({
      periodStart: '2026-08-03', periodEnd: '2026-08-08', dueDate: '2026-08-10',
      items: [{ staffUserId: 'staff-1', jobCardId: 'job-9', reportId: 'report-9', outcome: 'existing' }],
    });
    await chooseStaff(['Ayşe Personel']);
    await act(async () => { submit(); await flush(); });
    expect(onCreated).not.toHaveBeenCalled();
    expect(host.querySelector('.form-error')).toBeNull();
    const notice = host.querySelector('#weekly-existing-notice');
    expect(notice).not.toBeNull();
    expect(notice!.textContent).toContain('Bu personelin bu hafta için raporu zaten var.');
    expect(notice!.textContent).toContain('Admin');
    const link = notice!.querySelector('a.weekly-existing-notice-link[href="/jobs/job-9"]');
    expect(link?.textContent).toBe('Mevcut rapora git');

    // Clearing staff selection and failing validation clears the prior existing notice.
    await clickButton('Seçimi temizle');
    await act(async () => { submit(); await flush(); });
    expect(host.querySelector('#weekly-existing-notice')).toBeNull();
    expect(host.querySelector('.form-error')).not.toBeNull();
  });

  it('summarises mixed created and existing outcomes accurately in Turkish without false claims (D8 / A13)', async () => {
    await render(manager);
    weeklyApi.bulkRequestWeeklyReports.mockResolvedValueOnce({
      periodStart: '2026-08-03', periodEnd: '2026-08-08', dueDate: '2026-08-10',
      items: [
        { staffUserId: 'staff-1', jobCardId: 'job-1', reportId: 'report-1', outcome: 'created' },
        { staffUserId: 'staff-2', jobCardId: 'job-9', reportId: 'report-9', outcome: 'existing' },
      ],
    });
    await chooseStaff(['Ayşe Personel', 'Mehmet Personel']);
    await act(async () => { submit(); await flush(); });
    expect(onCreated).not.toHaveBeenCalled();
    expect(host.querySelector('#weekly-bulk-result-title')?.textContent?.trim())
      .toBe('2 haftalık rapor isteği işlendi');
    expect(host.querySelector('#weekly-bulk-created')?.textContent).toBe('1 oluşturuldu');
    expect(host.querySelector('#weekly-bulk-existing')?.textContent).toBe('1 zaten mevcuttu');
    expect(host.textContent).toContain('3–8 Ağustos 2026');
    expect(host.textContent).not.toContain('Her personel için ayrı bir haftalık rapor oluşturuldu');
    expect(host.textContent).toContain('Admin');
    const rows = Array.from(host.querySelectorAll('#weekly-bulk-result-items.weekly-bulk-result-list li.weekly-bulk-result-row'));
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('Ayşe Personel');
    expect(rows[0]!.querySelector('.bulk-result-outcome--created')?.textContent).toBe('Oluşturuldu');
    expect(rows[0]!.querySelector('a.weekly-bulk-result-link')?.getAttribute('href')).toBe('/jobs/job-1');
    expect(rows[1]!.querySelector('.bulk-result-outcome--existing')?.textContent).toBe('Zaten mevcut');
    expect(host.querySelector('.form-error')).toBeNull();
  });

  // --- ambiguous retry for the bulk command ---

  it('freezes the exact bulk attempt and retries it verbatim with the same action id', async () => {
    await render(manager);
    await chooseStaff(['Ayşe Personel', 'Mehmet Personel']);
    weeklyApi.bulkRequestWeeklyReports.mockRejectedValueOnce(new Error('transport lost'));
    await act(async () => { submit(); await flush(); });
    const firstInput = bulkInput();
    expect(host.querySelector('#weekly-bulk-result-title')).toBeNull();

    weeklyApi.bulkRequestWeeklyReports.mockResolvedValueOnce({
      periodStart: '2026-08-03', periodEnd: '2026-08-08', dueDate: '2026-08-10',
      items: [
        { staffUserId: 'staff-1', jobCardId: 'job-1', reportId: 'report-1', outcome: 'created' },
        { staffUserId: 'staff-2', jobCardId: 'job-2', reportId: 'report-2', outcome: 'created' },
      ],
    });
    const retry = buttonByText('Özgün isteği tekrar dene');
    expect(retry).toBeDefined();
    await act(async () => {
      retry!.dispatchEvent(new Event('click', { bubbles: true }));
      await flush();
    });
    expect(weeklyApi.bulkRequestWeeklyReports).toHaveBeenCalledTimes(2);
    expect(weeklyApi.bulkRequestWeeklyReports.mock.calls[1]![0]).toEqual(firstInput);
    expect(weeklyApi.bulkRequestWeeklyReports.mock.calls[1]![0].clientActionId).toBe('action-1');
    expect(host.querySelector('#weekly-bulk-result-title')).not.toBeNull();
  });

  it('releases the frozen attempt after a definitive failure so the next submit is a new command', async () => {
    await render(manager);
    await chooseStaff(['Ayşe Personel']);
    weeklyApi.bulkRequestWeeklyReports.mockRejectedValueOnce(
      new ApiError(400, 'VALIDATION_ERROR', 'Haftalık rapor için sorumlu personel zorunludur.'),
    );
    await act(async () => { submit(); await flush(); });
    expect(buttonByText('Özgün isteği tekrar dene')).toBeUndefined();
    await act(async () => { submit(); await flush(); });
    expect(weeklyApi.bulkRequestWeeklyReports).toHaveBeenCalledTimes(2);
    expect(weeklyApi.bulkRequestWeeklyReports.mock.calls[0]![0].clientActionId).toBe('action-1');
    expect(weeklyApi.bulkRequestWeeklyReports.mock.calls[1]![0].clientActionId).toBe('action-2');
  });

  // ---------------------------------------------------------------------
  // Custom manager questions only (WR-WEEK D6)
  // ---------------------------------------------------------------------

  it('renders no preset checkboxes and exposes only custom question controls (D6 / A14)', async () => {
    await render(manager);
    expect(host.querySelector('#weekly-preset-questions')).toBeNull();
    expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(host.querySelector('#weekly-add-custom-question')).not.toBeNull();
  });

  it('adds custom questions, keeps their stable ids and removes them independently', async () => {
    await render(manager);
    await chooseStaff(['Ayşe Personel']);
    await clickButton('+ Özel soru ekle');
    await clickButton('+ Özel soru ekle');
    change(host.querySelector('#weekly-custom-question-custom_1') as HTMLInputElement, 'Özel birinci soru');
    change(host.querySelector('#weekly-custom-question-custom_2') as HTMLInputElement, 'Özel ikinci soru');
    await act(async () => { submit(); await flush(); });
    expect(bulkInput().questions).toEqual([
      { key: 'custom_1', prompt: 'Özel birinci soru' },
      { key: 'custom_2', prompt: 'Özel ikinci soru' },
    ]);
    const removeFirst = Array.from(host.querySelectorAll('#weekly-questions .inline-action'))
      .find((button) => button.textContent === 'Kaldır');
    await act(async () => { removeFirst!.dispatchEvent(new Event('click', { bubbles: true })); });
    await flush();
    await act(async () => { submit(); await flush(); });
    expect(bulkInput(1).questions).toEqual([{ key: 'custom_2', prompt: 'Özel ikinci soru' }]);
  });

  it('keeps custom question keys and prompts identical across an ambiguous retry', async () => {
    await render(manager);
    await chooseStaff(['Ayşe Personel']);
    await clickButton('+ Özel soru ekle');
    change(host.querySelector('#weekly-custom-question-custom_1') as HTMLInputElement, 'Özel soru');
    weeklyApi.bulkRequestWeeklyReports.mockRejectedValueOnce(new Error('transport lost'));
    await act(async () => { submit(); await flush(); });
    const firstInput = bulkInput();
    await clickButton('Özgün isteği tekrar dene');
    expect(weeklyApi.bulkRequestWeeklyReports).toHaveBeenCalledTimes(2);
    expect(weeklyApi.bulkRequestWeeklyReports.mock.calls[1]![0]).toEqual(firstInput);
    expect(weeklyApi.bulkRequestWeeklyReports.mock.calls[1]![0].questions).toEqual([
      { key: 'custom_1', prompt: 'Özel soru' },
    ]);
  });

  it('rejects a blank custom question instead of silently dropping it', async () => {
    await render(manager);
    await chooseStaff(['Ayşe Personel']);
    await clickButton('+ Özel soru ekle');
    await act(async () => { submit(); await flush(); });
    expect(weeklyApi.bulkRequestWeeklyReports).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Özel soru boş olamaz');
  });

  it('rejects a custom question over 500 code points', async () => {
    await render(manager);
    await chooseStaff(['Ayşe Personel']);
    await clickButton('+ Özel soru ekle');
    change(host.querySelector('#weekly-custom-question-custom_1') as HTMLInputElement, 'x'.repeat(501));
    await act(async () => { submit(); await flush(); });
    expect(weeklyApi.bulkRequestWeeklyReports).not.toHaveBeenCalled();
    expect(host.textContent).toContain('en fazla 500 karakter');
  });

  it('accepts many custom questions', async () => {
    await render(manager);
    await chooseStaff(['Ayşe Personel']);
    for (let index = 1; index <= 8; index += 1) {
      await clickButton('+ Özel soru ekle');
      change(host.querySelector(`#weekly-custom-question-custom_${index}`) as HTMLInputElement, `Soru ${index}`);
    }
    await act(async () => { submit(); await flush(); });
    const questions = bulkInput().questions;
    expect(questions).toHaveLength(8);
    expect(questions[0]).toEqual({ key: 'custom_1', prompt: 'Soru 1' });
  });

  // ---------------------------------------------------------------------
  // Integration proof: create → detail GET parses the REAL server shape
  // ---------------------------------------------------------------------

  it('manager one-target create navigates and the REAL server detail payload parses and renders', async () => {
    const { parseWeeklyReportDetail } = await import('../src/jobs/weekly-report-api');
    const serverDetail = {
      id: 'report-1', organizationId: 'org-1', jobCardId: 'job-1', staffUserId: 'staff-1',
      periodStart: '2026-08-03', periodEnd: '2026-08-08',
      draft: {
        summary: 'Özet.', blockers: null, nextWeekPlan: 'Plan.',
        highlights: null, fieldObservations: null, supportNeeded: null,
      },
      questions: [
        { key: 'custom_1', prompt: 'Özel soru' },
      ],
      answers: [], version: 1,
      createdAt: '2026-08-03T09:00:00.000Z', updatedAt: '2026-08-03T09:00:00.000Z',
      jobStatus: 'NEW', jobVersion: 1, dueDate: '2026-08-10', assignedTo: 'staff-1',
      instructions: 'Lütfen doldurun.', liveSourceWork: [], submissionSummaries: [],
      canRemove: false, removal: null,
    };
    const parsed = parseWeeklyReportDetail(serverDetail);
    expect(parsed.organizationId).toBe('org-1');
    expect(parsed.periodEnd).toBe('2026-08-08');
    expect(parsed.dueDate).toBe('2026-08-10');

    await render(manager);
    await chooseStaff(['Ayşe Personel']);
    await act(async () => { submit(); await flush(); });
    expect(onCreated).toHaveBeenCalledWith('job-1');
  });

  it('staff self-create succeeds and its server-shaped detail payload parses', async () => {
    const { parseWeeklyReportDetail } = await import('../src/jobs/weekly-report-api');
    const serverDetail = {
      id: 'report-2', organizationId: 'org-1', jobCardId: 'job-2', staffUserId: 'staff-1',
      periodStart: '2026-08-03', periodEnd: '2026-08-08',
      draft: {
        summary: null, blockers: null, nextWeekPlan: null,
        highlights: null, fieldObservations: null, supportNeeded: null,
      },
      questions: [], answers: [], version: 1,
      createdAt: '2026-08-03T09:00:00.000Z', updatedAt: '2026-08-03T09:00:00.000Z',
      jobStatus: 'ACCEPTED', jobVersion: 1, dueDate: '2026-08-10', assignedTo: 'staff-1',
      instructions: null, liveSourceWork: [], submissionSummaries: [],
      canRemove: false, removal: null,
    };
    const parsed = parseWeeklyReportDetail(serverDetail);
    expect(parsed.staffUserId).toBe('staff-1');
    expect(parsed.jobStatus).toBe('ACCEPTED');

    await render(staffUser);
    await act(async () => { submit(); await flush(); });
    expect(weeklyApi.createWeeklyReport).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledWith('job-1');
  });
});
