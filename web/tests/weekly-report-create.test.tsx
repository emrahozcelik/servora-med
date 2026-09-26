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

/** React wires checkbox onChange to the native click-activated state toggle. */
async function toggleCheckbox(element: HTMLInputElement, checked = true) {
  if (element.checked === checked) return;
  await act(async () => { element.click(); });
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

  // --- STAFF self-create ---

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
    // Two active staff fit inside this suite's lowered cap (2).
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
    await clickButton('Seçimi temizle'); // no-op when already empty
    await act(async () => { submit(); await flush(); });
    expect(weeklyApi.bulkRequestWeeklyReports).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Aktif bir sorumlu personel seçin.');
  });

  it('over-cap staff count fails visibly instead of pretending all were selected', async () => {
    // MAX_BULK_TARGETS is 2 in this suite; three active staff exist.
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
    // The extra pick is not added, and the user is told so explicitly.
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

  // --- Termin removal (both modes) ---

  it('one-time mode has no editable termin field anywhere', async () => {
    await render(manager);
    expect(host.querySelector('#weekly-due')).toBeNull();
    expect(host.querySelector('input[name="dueDate"]')).toBeNull();
    expect(host.textContent).not.toContain('isteğe bağlı, varsayılan');
  });

  it('recurring mode has no editable termin field anywhere', async () => {
    await render(manager);
    await act(async () => {
      (host.querySelector('#weekly-mode-recurring') as HTMLButtonElement)
        .dispatchEvent(new Event('click', { bubbles: true }));
    });
    await flush();
    expect(host.querySelector('#weekly-due')).toBeNull();
    expect(host.querySelector('input[name="dueDate"]')).toBeNull();
    // Even the old fixed display block is gone: the canonical deadline lives in
    // the intro text, not an actionable-looking field.
    expect(host.querySelector('#weekly-recurring-due')).toBeNull();
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
    expect(rows[0]!.querySelector('a')?.getAttribute('href')).toBe('/jobs/job-1');
    expect(rows[1]!.textContent).toContain('Zaten mevcut');
    // A duplicate is never presented as a red error state.
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
      periodStart: '2026-08-03', periodEnd: '2026-08-09', dueDate: '2026-08-10',
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
  // Preset + custom manager questions
  // ---------------------------------------------------------------------

  it('renders exactly the five canonical presets and none is selected by default', async () => {
    await render(manager);
    const presets = Array.from(
      host.querySelectorAll('#weekly-preset-questions input[type="checkbox"]'),
    ) as HTMLInputElement[];
    expect(presets).toHaveLength(5);
    expect(presets.every((box) => !box.checked)).toBe(true);
    expect(host.querySelector('#weekly-preset-preset_week_highlights')).not.toBeNull();
    expect(host.querySelector('#weekly-preset-preset_management_support')).not.toBeNull();
    expect(host.textContent).toContain('Bu hafta öne çıkan çalışmaların ve sonuçların nelerdi?');
    expect(host.textContent).toContain('Planlanıp tamamlanamayan işler oldu mu? Neden?');
    expect(host.textContent).toContain('Müşterilerden veya sahadan önemli bir geri bildirim var mı?');
    expect(host.textContent).toContain('Gelecek hafta öncelikli çalışmaların neler?');
    expect(host.textContent).toContain('Yönetimden ihtiyaç duyduğun destek veya karar var mı?');
    expect(host.querySelector('#weekly-add-custom-question')).not.toBeNull();
  });

  it('sends selected presets with their stable semantic keys and excludes unselected ones', async () => {
    await render(manager);
    await chooseStaff(['Ayşe Personel']);
    const highlights = host.querySelector('#weekly-preset-preset_week_highlights') as HTMLInputElement;
    const support = host.querySelector('#weekly-preset-preset_management_support') as HTMLInputElement;
    await toggleCheckbox(highlights);
    await toggleCheckbox(support);
    await flush();
    await flush();
    await act(async () => { submit(); await flush(); });
    const input = bulkInput();
    expect(input.questions).toEqual([
      { key: 'preset_week_highlights', prompt: 'Bu hafta öne çıkan çalışmaların ve sonuçların nelerdi?' },
      { key: 'preset_management_support', prompt: 'Yönetimden ihtiyaç duyduğun destek veya karar var mı?' },
    ]);
  });

  it('adds custom questions, keeps their stable ids and removes them independently', async () => {
    await render(manager);
    await chooseStaff(['Ayşe Personel']);
    await clickButton('+ Özel soru ekle');
    await clickButton('+ Özel soru ekle');
    change(host.querySelector('#weekly-custom-question-1') as HTMLInputElement, 'Özel birinci soru');
    change(host.querySelector('#weekly-custom-question-2') as HTMLInputElement, 'Özel ikinci soru');
    await act(async () => { submit(); await flush(); });
    expect(bulkInput().questions).toEqual([
      { key: 'custom_1', prompt: 'Özel birinci soru' },
      { key: 'custom_2', prompt: 'Özel ikinci soru' },
    ]);
    // Remove the first custom row; the second keeps its id and prompt.
    const removeFirst = Array.from(host.querySelectorAll('#weekly-questions .inline-action'))
      .find((button) => button.textContent === 'Kaldır');
    await act(async () => { removeFirst!.dispatchEvent(new Event('click', { bubbles: true })); });
    await flush();
    await act(async () => { submit(); await flush(); });
    expect(bulkInput(1).questions).toEqual([{ key: 'custom_2', prompt: 'Özel ikinci soru' }]);
  });

  it('orders the payload as presets in canonical order then custom questions in UI order', async () => {
    await render(manager);
    await chooseStaff(['Ayşe Personel']);
    await clickButton('+ Özel soru ekle');
    change(host.querySelector('#weekly-custom-question-1') as HTMLInputElement, 'Özel soru');
    const priorities = host.querySelector('#weekly-preset-preset_next_week_priorities') as HTMLInputElement;
    const highlights = host.querySelector('#weekly-preset-preset_week_highlights') as HTMLInputElement;
    // Toggling priorities first proves canonical preset order wins over click order.
    await toggleCheckbox(priorities);
    await toggleCheckbox(highlights);
    await flush();
    await act(async () => { submit(); await flush(); });
    expect(bulkInput().questions.map((question: { key: string }) => question.key)).toEqual([
      'preset_week_highlights',
      'preset_next_week_priorities',
      'custom_1',
    ]);
  });

  it('keeps question keys and prompts identical across an ambiguous retry', async () => {
    await render(manager);
    await chooseStaff(['Ayşe Personel']);
    const highlights = host.querySelector('#weekly-preset-preset_week_highlights') as HTMLInputElement;
    await toggleCheckbox(highlights);
    await clickButton('+ Özel soru ekle');
    change(host.querySelector('#weekly-custom-question-1') as HTMLInputElement, 'Özel soru');
    weeklyApi.bulkRequestWeeklyReports.mockRejectedValueOnce(new Error('transport lost'));
    await act(async () => { submit(); await flush(); });
    const firstInput = bulkInput();
    await clickButton('Özgün isteği tekrar dene');
    expect(weeklyApi.bulkRequestWeeklyReports).toHaveBeenCalledTimes(2);
    expect(weeklyApi.bulkRequestWeeklyReports.mock.calls[1]![0]).toEqual(firstInput);
    expect(weeklyApi.bulkRequestWeeklyReports.mock.calls[1]![0].questions).toEqual([
      { key: 'preset_week_highlights', prompt: 'Bu hafta öne çıkan çalışmaların ve sonuçların nelerdi?' },
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
    change(host.querySelector('#weekly-custom-question-1') as HTMLInputElement, 'x'.repeat(501));
    await act(async () => { submit(); await flush(); });
    expect(weeklyApi.bulkRequestWeeklyReports).not.toHaveBeenCalled();
    expect(host.textContent).toContain('en fazla 500 karakter');
  });

  it('accepts far more than five questions (presets plus many customs)', async () => {
    await render(manager);
    await chooseStaff(['Ayşe Personel']);
    for (const box of Array.from(
      host.querySelectorAll('#weekly-preset-questions input[type="checkbox"]'),
    ) as HTMLInputElement[]) {
      await toggleCheckbox(box);
    }
    await flush();
    for (let index = 1; index <= 8; index += 1) {
      await clickButton('+ Özel soru ekle');
      change(host.querySelector(`#weekly-custom-question-${index}`) as HTMLInputElement, `Soru ${index}`);
    }
    await act(async () => { submit(); await flush(); });
    const questions = bulkInput().questions;
    expect(questions).toHaveLength(13); // 5 presets + 8 custom, all accepted
    expect(questions[5]).toEqual({ key: 'custom_1', prompt: 'Soru 1' });
  });

  // ---------------------------------------------------------------------
  // Integration proof: create → detail GET parses the REAL server shape
  // ---------------------------------------------------------------------

  it('manager one-target create navigates and the REAL server detail payload parses and renders', async () => {
    // Parse the raw server-shaped detail through the REAL parser (the mocked
    // create response above is only the create receipt).
    const { parseWeeklyReportDetail } = await import('../src/jobs/weekly-report-api');
    const serverDetail = {
      id: 'report-1', organizationId: 'org-1', jobCardId: 'job-1', staffUserId: 'staff-1',
      periodStart: '2026-08-03', periodEnd: '2026-08-09',
      draft: {
        summary: 'Özet.', blockers: null, nextWeekPlan: 'Plan.',
        highlights: null, fieldObservations: null, supportNeeded: null,
      },
      questions: [
        { key: 'preset_week_highlights', prompt: 'Bu hafta öne çıkan çalışmaların ve sonuçların nelerdi?' },
        { key: 'custom_1', prompt: 'Özel soru' },
      ],
      answers: [], version: 1,
      createdAt: '2026-08-03T09:00:00.000Z', updatedAt: '2026-08-03T09:00:00.000Z',
      jobStatus: 'NEW', jobVersion: 1, dueDate: '2026-08-10', assignedTo: 'staff-1',
      instructions: 'Lütfen doldurun.', liveSourceWork: [], submissionSummaries: [],
    };
    const parsed = parseWeeklyReportDetail(serverDetail);
    expect(parsed.organizationId).toBe('org-1');
    expect(parsed.createdAt).toBe('2026-08-03T09:00:00.000Z');
    expect(parsed.updatedAt).toBe('2026-08-03T09:00:00.000Z');

    await render(manager);
    await chooseStaff(['Ayşe Personel']);
    await act(async () => { submit(); await flush(); });
    expect(onCreated).toHaveBeenCalledWith('job-1');
  });

  it('staff self-create succeeds and its server-shaped detail payload parses', async () => {
    const { parseWeeklyReportDetail } = await import('../src/jobs/weekly-report-api');
    const serverDetail = {
      id: 'report-2', organizationId: 'org-1', jobCardId: 'job-2', staffUserId: 'staff-1',
      periodStart: '2026-08-03', periodEnd: '2026-08-09',
      draft: {
        summary: null, blockers: null, nextWeekPlan: null,
        highlights: null, fieldObservations: null, supportNeeded: null,
      },
      questions: [], answers: [], version: 1,
      createdAt: '2026-08-03T09:00:00.000Z', updatedAt: '2026-08-03T09:00:00.000Z',
      jobStatus: 'ACCEPTED', jobVersion: 1, dueDate: '2026-08-10', assignedTo: 'staff-1',
      instructions: null, liveSourceWork: [], submissionSummaries: [],
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
