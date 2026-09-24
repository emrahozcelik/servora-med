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
};
const staffUser: CurrentUser = { ...manager, id: 'staff-1', name: 'Ayşe Personel', role: 'STAFF' };

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
 * Canonical reference deliberately pinned to a week that is NOT the developer
 * machine's current week (2026-09-24 → device-local Monday 2026-09-21). Any
 * device-local default would therefore be detectable.
 */
const REFERENCE = {
  timezone: 'Europe/Istanbul',
  periodStart: '2026-08-03',
  periodEnd: '2026-08-09',
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

describe('Weekly report create screen', () => {
  let root: Root;
  let host: HTMLDivElement;
  let onCreated: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
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
      periodStart: '2026-08-03', periodEnd: '2026-08-09', status: 'ACCEPTED', dueDate: '2026-08-10',
    });
    weeklyApi.bulkRequestWeeklyReports.mockResolvedValue({
      periodStart: '2026-08-03', periodEnd: '2026-08-09', dueDate: '2026-08-10',
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

  async function render(user: CurrentUser = staffUser) {
    await act(async () => root.render(
      <ConfigProvider>
        <WeeklyReportCreateScreen user={user} onCancel={() => {}} onCreated={onCreated} />
      </ConfigProvider>,
    ));
    await flush();
  }

  function submit() {
    const form = host.querySelector('form');
    expect(form).not.toBeNull();
    act(() => { form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
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

  async function searchStaff(text: string) {
    const input = host.querySelector('input.ant-select-input') as HTMLInputElement;
    expect(input, 'assignee search input').not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();
  }

  function selectedCountText() {
    return host.querySelector('#weekly-assignee-count')?.textContent?.trim() ?? '';
  }

  function tagTitles(): string[] {
    return Array.from(host.querySelectorAll('.ant-select-selection-item'))
      .map((node) => node.getAttribute('title') ?? '');
  }

  async function removeTag(index = 0) {
    const remove = host.querySelectorAll('.ant-select-selection-item-remove')[index] as HTMLElement | undefined;
    expect(remove, `remove control #${index}`).toBeDefined();
    await act(async () => {
      remove!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      remove!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
  }

  function bulkInput() {
    expect(weeklyApi.bulkRequestWeeklyReports).toHaveBeenCalled();
    return weeklyApi.bulkRequestWeeklyReports.mock.calls[0]![0];
  }

  function buttonByText(text: string) {
    return Array.from(host.querySelectorAll('button')).find((button) => button.textContent === text);
  }

  // --- STAFF self-create (unchanged single-report workflow) ---

  it('defaults the report week from the organization calendar, not the device clock', async () => {
    await render(staffUser);
    const period = host.querySelector('#weekly-period') as HTMLInputElement;
    expect(period.value).toBe(REFERENCE.periodStart);
    expect(period.value).not.toBe('2026-09-21');
    expect(weeklyApi.getWeeklyReportReference).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('organizasyon takvimine göre');
  });

  it('creates a self report for STAFF without multi-select, questions or due date', async () => {
    await render(staffUser);
    expect(host.querySelector('#weekly-assignees')).toBeNull();
    expect(host.querySelector('#weekly-question-0')).toBeNull();
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

  it('shows STAFF the derived due date read-only instead of an editable field', async () => {
    await render(staffUser);
    expect(host.querySelector('#weekly-due')).toBeNull();
    const derived = host.querySelector('#weekly-due-derived');
    expect(derived?.textContent).toBe('2026-08-10');
  });

  it('derives the STAFF read-only due date from a manually chosen week', async () => {
    await render(staffUser);
    const period = host.querySelector('#weekly-period') as HTMLInputElement;
    change(period, '2026-08-17');
    await flush();
    expect(host.querySelector('#weekly-due-derived')?.textContent).toBe('2026-08-24');
  });

  it('links to the existing report on duplicate conflict', async () => {
    await render(staffUser);
    weeklyApi.createWeeklyReport.mockRejectedValueOnce(new ApiError(
      409, 'WEEKLY_REPORT_ALREADY_EXISTS', 'Bu personel için bu haftaya ait rapor zaten mevcut.',
      false, { reportId: 'report-9', jobCardId: 'job-9', periodStart: '2026-08-03' },
    ));
    await act(async () => { submit(); await flush(); });
    expect(onCreated).not.toHaveBeenCalled();
    const link = host.querySelector('a[href="/jobs/job-9"]');
    expect(link?.textContent).toContain('Mevcut rapora git');
  });

  it('freezes the original attempt for ambiguous STAFF failures and retries it verbatim', async () => {
    await render(staffUser);
    weeklyApi.createWeeklyReport.mockRejectedValueOnce(new Error('transport lost'));
    await act(async () => { submit(); await flush(); });
    expect(onCreated).not.toHaveBeenCalled();
    const firstInput = weeklyApi.createWeeklyReport.mock.calls[0]![0];
    weeklyApi.createWeeklyReport.mockResolvedValueOnce({
      jobCardId: 'job-2', reportId: 'report-2', staffUserId: 'staff-1',
      periodStart: '2026-08-03', periodEnd: '2026-08-09', status: 'ACCEPTED', dueDate: '2026-08-10',
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

  // --- MANAGER multi-select surface ---

  it('offers MANAGER a searchable multi-select of active STAFF only', async () => {
    await render(manager);
    expect(host.querySelector('#weekly-assignee')).toBeNull();
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

  it('shows the selected count and one tag per selected staff', async () => {
    await render(manager);
    expect(selectedCountText()).toBe('0 personel seçildi');
    await chooseStaff(['Ayşe Personel', 'Mehmet Personel']);
    expect(selectedCountText()).toBe('2 personel seçildi');
    expect(tagTitles()).toEqual(['Ayşe Personel', 'Mehmet Personel']);
  });

  it('removes an individual selection through its tag', async () => {
    await render(manager);
    await chooseStaff(['Ayşe Personel', 'Mehmet Personel']);
    expect(selectedCountText()).toBe('2 personel seçildi');
    await removeTag(0);
    expect(selectedCountText()).toBe('1 personel seçildi');
    expect(tagTitles()).toEqual(['Mehmet Personel']);
  });

  it('never selects the same staff twice', async () => {
    await render(manager);
    await chooseStaff(['Ayşe Personel']);
    // Selecting the same option again toggles it off instead of duplicating.
    await pickOption('Ayşe Personel');
    expect(selectedCountText()).toBe('0 personel seçildi');
    await pickOption('Ayşe Personel');
    expect(selectedCountText()).toBe('1 personel seçildi');
    await act(async () => { submit(); await flush(); });
    expect(bulkInput().staffUserIds).toEqual(['staff-1']);
  });

  it('filters the staff options by the search text', async () => {
    await render(manager);
    await act(async () => { openAssignees(); });
    await flush();
    await searchStaff('Mehmet');
    expect(assigneeOptions().map((node) => node.textContent)).toEqual(['Mehmet Personel']);
  });

  it('disables the selection while a request is pending', async () => {
    await render(manager);
    await chooseStaff(['Ayşe Personel']);
    weeklyApi.bulkRequestWeeklyReports.mockReturnValue(new Promise(() => {}));
    await act(async () => { submit(); await flush(); });
    expect(host.querySelector('.ant-select-disabled')).not.toBeNull();
    expect((host.querySelector('input.ant-select-input') as HTMLInputElement).disabled).toBe(true);
    expect(buttonByText('Rapor isteği gönderiliyor…')?.disabled).toBe(true);
  });

  it('disables the selection while the outcome is ambiguous', async () => {
    await render(manager);
    await chooseStaff(['Ayşe Personel']);
    weeklyApi.bulkRequestWeeklyReports.mockRejectedValueOnce(new Error('transport lost'));
    await act(async () => { submit(); await flush(); });
    expect(host.querySelector('.ant-select-disabled')).not.toBeNull();
    expect(buttonByText('Özgün isteği tekrar dene')).toBeDefined();
  });

  // --- bulk command payload ---

  it('sends one bulk command with every selected id and never loops the single endpoint', async () => {
    await render(manager);
    await chooseStaff(['Zeynep Personel', 'Ayşe Personel']);
    const addButton = buttonByText('Soru ekle');
    await act(async () => { addButton!.dispatchEvent(new Event('click', { bubbles: true })); });
    change(host.querySelector('#weekly-question-0') as HTMLInputElement, 'Bu hafta ne öğrendin?');
    change(host.querySelector('#weekly-instructions') as HTMLTextAreaElement, 'Lütfen doldurun.');
    await act(async () => { submit(); await flush(); });
    expect(weeklyApi.createWeeklyReport).not.toHaveBeenCalled();
    expect(weeklyApi.bulkRequestWeeklyReports).toHaveBeenCalledTimes(1);
    expect(bulkInput()).toMatchObject({
      clientActionId: 'action-1',
      periodStart: '2026-08-03',
      staffUserIds: ['staff-3', 'staff-1'],
      questions: [{ key: 'q1', prompt: 'Bu hafta ne öğrendin?' }],
      instructions: 'Lütfen doldurun.',
    });
  });

  it('sends the MANAGER due-date override when entered', async () => {
    await render(manager);
    await chooseStaff(['Ayşe Personel']);
    change(host.querySelector('#weekly-due') as HTMLInputElement, '2026-08-14');
    await act(async () => { submit(); await flush(); });
    expect(bulkInput()).toMatchObject({ dueDate: '2026-08-14' });
  });

  it('omits the MANAGER due-date override when left empty', async () => {
    await render(manager);
    await chooseStaff(['Ayşe Personel']);
    await act(async () => { submit(); await flush(); });
    expect(bulkInput()).not.toHaveProperty('dueDate');
  });

  it('blocks submit with an empty selection and surfaces the field error', async () => {
    await render(manager);
    await act(async () => { submit(); await flush(); });
    expect(weeklyApi.bulkRequestWeeklyReports).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Aktif bir sorumlu personel seçin.');
  });

  it('caps the selection at the server limit so no oversized command can be sent', async () => {
    await render(manager);
    await chooseStaff(['Ayşe Personel', 'Mehmet Personel']);
    await pickOption('Zeynep Personel');
    // The extra pick is not added, and the user is told so explicitly.
    expect(selectedCountText()).toBe('2 personel seçildi');
    expect(host.textContent).toContain('fazlası eklenmedi');
    await act(async () => { submit(); await flush(); });
    expect(weeklyApi.bulkRequestWeeklyReports).toHaveBeenCalledTimes(1);
    expect(bulkInput().staffUserIds).toHaveLength(2);
  });

  // --- success and duplicate UX ---

  it('navigates directly when exactly one target is requested', async () => {
    await render(manager);
    await chooseStaff(['Ayşe Personel']);
    await act(async () => { submit(); await flush(); });
    expect(onCreated).toHaveBeenCalledWith('job-1');
    expect(host.querySelector('#weekly-bulk-result-title')).toBeNull();
  });

  it('summarises the outcome for multiple targets with per-staff rows', async () => {
    await render(manager);
    weeklyApi.bulkRequestWeeklyReports.mockResolvedValueOnce({
      periodStart: '2026-08-03', periodEnd: '2026-08-09', dueDate: '2026-08-10',
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
    const rows = Array.from(host.querySelectorAll('#weekly-bulk-result-items li'));
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('Ayşe Personel');
    expect(rows[0]!.textContent).toContain('Oluşturuldu');
    expect(rows[0]!.querySelector('a')?.getAttribute('href')).toBe('/jobs/job-1');
    expect(rows[1]!.textContent).toContain('Mehmet Personel');
    expect(rows[1]!.textContent).toContain('Zaten mevcut');
    expect(rows[1]!.querySelector('a')?.getAttribute('href')).toBe('/jobs/job-9');
    // A duplicate is never presented as a red error state.
    expect(host.querySelector('.form-error')).toBeNull();
  });

  // --- ambiguous retry for the bulk command ---

  it('freezes the exact bulk attempt and retries it verbatim with the same action id', async () => {
    await render(manager);
    await chooseStaff(['Ayşe Personel', 'Mehmet Personel']);
    change(host.querySelector('#weekly-due') as HTMLInputElement, '2026-08-14');
    weeklyApi.bulkRequestWeeklyReports.mockRejectedValueOnce(new Error('transport lost'));
    await act(async () => { submit(); await flush(); });
    const firstInput = bulkInput();
    expect(host.querySelector('#weekly-bulk-result-title')).toBeNull();

    weeklyApi.bulkRequestWeeklyReports.mockResolvedValueOnce({
      periodStart: '2026-08-03', periodEnd: '2026-08-09', dueDate: '2026-08-14',
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
});
