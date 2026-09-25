/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ConfigProvider } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WeeklyReportCreateScreen } from '../src/WeeklyReportCreate';
import { WeeklyReportRecurrenceManager } from '../src/WeeklyReportRecurrences';
import { ApiError, type CurrentUser } from '../src/services/api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/**
 * Both ceilings are deliberately lowered for this suite so the over-cap path
 * needs two simulated selections instead of fifty-one. The real values (50) are
 * server-owned constants verified by the API parser suites.
 */
const weeklyApi = vi.hoisted(() => ({
  createWeeklyReport: vi.fn(),
  bulkRequestWeeklyReports: vi.fn(),
  getWeeklyReportReference: vi.fn(),
  bulkCreateWeeklyReportRecurrences: vi.fn(),
  listWeeklyReportRecurrences: vi.fn(),
  updateWeeklyReportRecurrenceTemplate: vi.fn(),
  pauseWeeklyReportRecurrence: vi.fn(),
  resumeWeeklyReportRecurrence: vi.fn(),
  MAX_BULK_TARGETS: 2,
  MAX_RECURRENCE_TARGETS: 2,
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

/** Canonical org-local current week; deliberately not the device's current week. */
const REFERENCE = {
  timezone: 'Europe/Istanbul',
  periodStart: '2026-08-03',
  periodEnd: '2026-08-09',
  dueDate: '2026-08-10',
};

const RULE = {
  id: 'rec-1', staffUserId: 'staff-1', staffName: 'Ayşe Personel',
  enabled: true, disabledReason: null as string | null,
  nextPeriodStart: '2026-10-05',
  questions: [{ key: 'q1', prompt: 'Bu hafta ne yaptın?' }],
  instructions: 'Lütfen doldurun.',
  version: 1,
  lastProcessedPeriodStart: '2026-09-28' as string | null,
  lastOutcome: 'created' as string | null,
  lastErrorCode: null as string | null,
  updatedAt: '2026-09-28T09:00:00.000Z',
};
const PAUSED_RULE = {
  ...RULE, id: 'rec-2', staffUserId: 'staff-2', staffName: 'Mehmet Personel',
  enabled: false, disabledReason: 'STAFF_INELIGIBLE',
  nextPeriodStart: '2026-10-12', version: 4,
  lastProcessedPeriodStart: '2026-09-28', lastOutcome: 'existing',
};

function change(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
  act(() => { element.dispatchEvent(new Event('input', { bubbles: true })); });
}

async function flush() {
  await act(async () => { await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe('Weekly report recurrence surface', () => {
  let root: Root;
  let host: HTMLDivElement;
  let onCreated: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // `clearAllMocks` keeps implementations, so a `mockReturnValue` from an
    // earlier test could leak into a later one. Reset, then declare every
    // default explicitly so each test starts from a known state.
    vi.resetAllMocks();
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
    weeklyApi.listWeeklyReportRecurrences.mockResolvedValue({ items: [] });
    weeklyApi.createWeeklyReport.mockResolvedValue({
      jobCardId: 'job-1', reportId: 'report-1', staffUserId: 'staff-1',
      periodStart: '2026-08-03', periodEnd: '2026-08-09', status: 'ACCEPTED', dueDate: '2026-08-10',
    });
    weeklyApi.bulkRequestWeeklyReports.mockResolvedValue({
      periodStart: '2026-08-03', periodEnd: '2026-08-09', dueDate: '2026-08-10',
      items: [{ staffUserId: 'staff-1', jobCardId: 'job-1', reportId: 'report-1', outcome: 'created' }],
    });
    weeklyApi.bulkCreateWeeklyReportRecurrences.mockResolvedValue({
      startPeriodStart: '2026-08-03',
      items: [{
        recurrenceId: 'rec-1', staffUserId: 'staff-1', outcome: 'created',
        enabled: true, nextPeriodStart: '2026-08-03', version: 1,
      }],
    });
    weeklyApi.updateWeeklyReportRecurrenceTemplate.mockResolvedValue({
      recurrenceId: 'rec-1', version: 2,
      questions: [{ key: 'q1', prompt: 'Bu hafta ne yaptın?' }],
      instructions: 'Lütfen doldurun.', nextPeriodStart: '2026-10-05',
    });
    weeklyApi.pauseWeeklyReportRecurrence.mockResolvedValue({
      recurrenceId: 'rec-1', enabled: false, disabledReason: 'MANUAL',
      nextPeriodStart: '2026-10-05', version: 2,
    });
    weeklyApi.resumeWeeklyReportRecurrence.mockResolvedValue({
      recurrenceId: 'rec-2', enabled: true, nextPeriodStart: '2026-10-26', version: 5,
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

  async function renderCreate(user: CurrentUser = manager) {
    await act(async () => root.render(
      <ConfigProvider>
        <WeeklyReportCreateScreen user={user} onCancel={() => {}} onCreated={onCreated} />
      </ConfigProvider>,
    ));
    await flush();
  }

  async function renderManager(user: CurrentUser = manager) {
    await act(async () => root.render(
      <ConfigProvider>
        <WeeklyReportRecurrenceManager user={user} />
      </ConfigProvider>,
    ));
    await flush();
  }

  function submit() {
    const form = host.querySelector('form');
    expect(form).not.toBeNull();
    act(() => { form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  }

  function buttonByText(text: string) {
    return Array.from(host.querySelectorAll('button')).find((button) => button.textContent === text);
  }

  async function click(element: HTMLElement | undefined) {
    expect(element, 'clickable element').toBeDefined();
    await act(async () => { element!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
  }

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

  async function enterRecurringMode() {
    await click(host.querySelector('#weekly-mode-recurring') as HTMLElement);
  }

  // ---------------------------------------------------------------------
  // 1-7. Mode switch, eligibility, caps, week field, validation, no due date
  // ---------------------------------------------------------------------

  it('1. shows STAFF no recurrence controls at all', async () => {
    await renderCreate(staffUser);
    expect(host.querySelector('#weekly-mode')).toBeNull();
    expect(host.querySelector('#weekly-mode-single')).toBeNull();
    expect(host.querySelector('#weekly-mode-recurring')).toBeNull();
    expect(host.querySelector('#recurrence-manager')).toBeNull();
    expect(weeklyApi.listWeeklyReportRecurrences).not.toHaveBeenCalled();
    expect(weeklyApi.bulkCreateWeeklyReportRecurrences).not.toHaveBeenCalled();
  });

  it('2. gives MANAGER a Tek seferlik / Her hafta otomatik switch and opens the recurring surface', async () => {
    await renderCreate(manager);
    expect(host.querySelector('#weekly-mode-single')?.getAttribute('aria-checked')).toBe('true');
    expect(host.querySelector('#weekly-mode-recurring')?.getAttribute('aria-checked')).toBe('false');
    expect(host.querySelector('#recurrence-manager')).toBeNull();

    await enterRecurringMode();
    expect(host.querySelector('#weekly-mode-recurring')?.getAttribute('aria-checked')).toBe('true');
    expect(host.querySelector('#recurrence-manager')).not.toBeNull();
    expect(weeklyApi.listWeeklyReportRecurrences).toHaveBeenCalledTimes(1);
  });

  it('3. offers the recurring mode a searchable multi-select of active STAFF only', async () => {
    await renderCreate(manager);
    await enterRecurringMode();
    expect(host.querySelector('.ant-select-multiple')).not.toBeNull();
    expect(host.querySelector('.ant-select-show-search')).not.toBeNull();
    expect(people.listStaff).toHaveBeenCalledWith('active');
    await act(async () => { openAssignees(); });
    await flush();
    expect(assigneeOptions().map((node) => node.textContent)).toEqual([
      'Ayşe Personel', 'Mehmet Personel', 'Zeynep Personel',
    ]);
  });

  it('4. caps the recurring selection at the server limit so no oversized command is sent', async () => {
    await renderCreate(manager);
    await enterRecurringMode();
    await chooseStaff(['Ayşe Personel', 'Mehmet Personel']);
    await pickOption('Zeynep Personel');
    expect(selectedCountText()).toBe('2 personel seçildi');
    expect(host.textContent).toContain('fazlası eklenmedi');
    await act(async () => { submit(); await flush(); });
    expect(weeklyApi.bulkCreateWeeklyReportRecurrences).toHaveBeenCalledTimes(1);
    expect(weeklyApi.bulkCreateWeeklyReportRecurrences.mock.calls[0]![0].staffUserIds).toHaveLength(2);
  });

  it('5. labels the week field as the start week in recurring mode', async () => {
    await renderCreate(manager);
    expect(host.querySelector('label[for="weekly-period"]')?.textContent)
      .toBe('Rapor haftası (Pazartesi)');
    await enterRecurringMode();
    expect(host.querySelector('label[for="weekly-period"]')?.textContent)
      .toBe('Başlangıç haftası (Pazartesi)');
  });

  it('6. rejects a start week that is in the past relative to the canonical current week', async () => {
    await renderCreate(manager);
    await enterRecurringMode();
    await chooseStaff(['Ayşe Personel']);
    change(host.querySelector('#weekly-period') as HTMLInputElement, '2026-07-06');
    await act(async () => { submit(); await flush(); });
    expect(weeklyApi.bulkCreateWeeklyReportRecurrences).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Başlangıç haftası geçmişte olamaz.');
  });

  it('7. never offers an arbitrary due date in recurring mode', async () => {
    await renderCreate(manager);
    await enterRecurringMode();
    expect(host.querySelector('#weekly-due')).toBeNull();
    expect(host.querySelector('#weekly-recurring-due')?.textContent?.trim())
      .toBe('Her hafta dönemi izleyen Pazartesi');
  });

  // ---------------------------------------------------------------------
  // 8-12. Exact payload, neutral existing result, current-week UX, ambiguity
  // ---------------------------------------------------------------------

  it('8. sends one recurring command with the exact payload and never the one-time endpoints', async () => {
    await renderCreate(manager);
    await enterRecurringMode();
    await chooseStaff(['Zeynep Personel', 'Ayşe Personel']);
    await click(buttonByText('Soru ekle'));
    change(host.querySelector('#weekly-question-0') as HTMLInputElement, 'Bu hafta ne öğrendin?');
    change(host.querySelector('#weekly-instructions') as HTMLTextAreaElement, 'Lütfen doldurun.');
    await act(async () => { submit(); await flush(); });

    expect(weeklyApi.createWeeklyReport).not.toHaveBeenCalled();
    expect(weeklyApi.bulkRequestWeeklyReports).not.toHaveBeenCalled();
    expect(weeklyApi.bulkCreateWeeklyReportRecurrences).toHaveBeenCalledTimes(1);
    expect(weeklyApi.bulkCreateWeeklyReportRecurrences.mock.calls[0]![0]).toEqual({
      clientActionId: 'action-1',
      staffUserIds: ['staff-3', 'staff-1'],
      startPeriodStart: '2026-08-03',
      questions: [{ key: 'q1', prompt: 'Bu hafta ne öğrendin?' }],
      instructions: 'Lütfen doldurun.',
    });
  });

  it('9. presents an already-existing rule neutrally, never as an error', async () => {
    await renderCreate(manager);
    await enterRecurringMode();
    await chooseStaff(['Ayşe Personel', 'Mehmet Personel']);
    weeklyApi.bulkCreateWeeklyReportRecurrences.mockResolvedValueOnce({
      startPeriodStart: '2026-08-03',
      items: [
        { recurrenceId: 'rec-1', staffUserId: 'staff-1', outcome: 'created', enabled: true, nextPeriodStart: '2026-08-03', version: 1 },
        { recurrenceId: 'rec-2', staffUserId: 'staff-2', outcome: 'existing', enabled: false, nextPeriodStart: '2026-08-10', version: 5 },
      ],
    });
    await act(async () => { submit(); await flush(); });

    expect(host.querySelector('#weekly-recurrence-result-title')?.textContent?.trim())
      .toBe('2 otomatik kural işlendi');
    expect(host.querySelector('#weekly-recurrence-created')?.textContent).toBe('1 oluşturuldu');
    expect(host.querySelector('#weekly-recurrence-existing')?.textContent).toBe('1 zaten mevcuttu');
    const rows = Array.from(host.querySelectorAll('#weekly-recurrence-result-items li'));
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('Ayşe Personel');
    expect(rows[0]!.textContent).toContain('Oluşturuldu');
    expect(rows[1]!.textContent).toContain('Mehmet Personel');
    expect(rows[1]!.textContent).toContain('Zaten mevcut');
    expect(rows[1]!.textContent).toContain('2026-08-10');
    expect(host.querySelector('.form-error')).toBeNull();
  });

  it('10. choosing the current week warns that the worker will create it and sends no one-time request', async () => {
    await renderCreate(manager);
    await enterRecurringMode();
    // The reference prefill is the canonical current week.
    expect((host.querySelector('#weekly-period') as HTMLInputElement).value).toBe('2026-08-03');
    expect(host.querySelector('#weekly-recurring-current-week')?.textContent)
      .toContain('otomatik olarak oluşturulacak');
    await chooseStaff(['Ayşe Personel']);
    await act(async () => { submit(); await flush(); });
    expect(weeklyApi.bulkCreateWeeklyReportRecurrences).toHaveBeenCalledTimes(1);
    expect(weeklyApi.bulkRequestWeeklyReports).not.toHaveBeenCalled();
    expect(weeklyApi.createWeeklyReport).not.toHaveBeenCalled();
  });

  it('11. freezes an ambiguous recurring attempt and retries it verbatim with the same action id', async () => {
    await renderCreate(manager);
    await enterRecurringMode();
    await chooseStaff(['Ayşe Personel']);
    weeklyApi.bulkCreateWeeklyReportRecurrences.mockRejectedValueOnce(new Error('transport lost'));
    await act(async () => { submit(); await flush(); });
    const firstInput = weeklyApi.bulkCreateWeeklyReportRecurrences.mock.calls[0]![0];
    expect(host.querySelector('#weekly-recurrence-result-title')).toBeNull();

    weeklyApi.bulkCreateWeeklyReportRecurrences.mockResolvedValueOnce({
      startPeriodStart: '2026-08-03',
      items: [{ recurrenceId: 'rec-1', staffUserId: 'staff-1', outcome: 'created', enabled: true, nextPeriodStart: '2026-08-03', version: 1 }],
    });
    await click(buttonByText('Özgün isteği tekrar dene'));
    expect(weeklyApi.bulkCreateWeeklyReportRecurrences).toHaveBeenCalledTimes(2);
    expect(weeklyApi.bulkCreateWeeklyReportRecurrences.mock.calls[1]![0]).toEqual(firstInput);
    expect(weeklyApi.bulkCreateWeeklyReportRecurrences.mock.calls[1]![0].clientActionId).toBe('action-1');
  });

  it('12. releases the frozen recurring attempt after a definitive failure', async () => {
    await renderCreate(manager);
    await enterRecurringMode();
    await chooseStaff(['Ayşe Personel']);
    weeklyApi.bulkCreateWeeklyReportRecurrences.mockRejectedValueOnce(
      new ApiError(400, 'VALIDATION_ERROR', 'Başlangıç haftası geçmişte olamaz.'),
    );
    await act(async () => { submit(); await flush(); });
    expect(buttonByText('Özgün isteği tekrar dene')).toBeUndefined();
    await act(async () => { submit(); await flush(); });
    expect(weeklyApi.bulkCreateWeeklyReportRecurrences.mock.calls[0]![0].clientActionId).toBe('action-1');
    expect(weeklyApi.bulkCreateWeeklyReportRecurrences.mock.calls[1]![0].clientActionId).toBe('action-2');
  });

  it('13. leaves the one-time manager path completely unchanged', async () => {
    await renderCreate(manager);
    await chooseStaff(['Ayşe Personel']);
    change(host.querySelector('#weekly-due') as HTMLInputElement, '2026-08-14');
    await act(async () => { submit(); await flush(); });
    expect(weeklyApi.bulkRequestWeeklyReports).toHaveBeenCalledTimes(1);
    expect(weeklyApi.bulkRequestWeeklyReports.mock.calls[0]![0]).toMatchObject({
      clientActionId: 'action-1', periodStart: '2026-08-03', dueDate: '2026-08-14', staffUserIds: ['staff-1'],
    });
    expect(weeklyApi.bulkCreateWeeklyReportRecurrences).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // 14-18. Management list rendering
  // ---------------------------------------------------------------------

  it('14. renders nothing for STAFF even when mounted directly', async () => {
    await renderManager(staffUser);
    expect(host.querySelector('#recurrence-manager')).toBeNull();
    expect(weeklyApi.listWeeklyReportRecurrences).not.toHaveBeenCalled();
  });

  it('15. lists every rule with its staff member', async () => {
    weeklyApi.listWeeklyReportRecurrences.mockResolvedValue({ items: [RULE, PAUSED_RULE] });
    await renderManager();
    const rows = Array.from(host.querySelectorAll('#recurrence-list li'));
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('Ayşe Personel');
    expect(rows[1]!.textContent).toContain('Mehmet Personel');
  });

  it('16. shows ACTIVE state and the next report week', async () => {
    weeklyApi.listWeeklyReportRecurrences.mockResolvedValue({ items: [RULE] });
    await renderManager();
    expect(host.querySelector('#recurrence-state-rec-1')?.textContent).toBe('Aktif');
    expect(host.querySelector('#recurrence-next-rec-1')?.textContent)
      .toContain('Sonraki rapor haftası: 2026-10-05');
  });

  it('17. shows PAUSED state with the auto-pause reason', async () => {
    weeklyApi.listWeeklyReportRecurrences.mockResolvedValue({ items: [PAUSED_RULE] });
    await renderManager();
    expect(host.querySelector('#recurrence-state-rec-2')?.textContent).toBe('Duraklatıldı');
    expect(host.querySelector('#recurrence-reason-rec-2')?.textContent)
      .toContain('Personel artık uygun değil');
  });

  it('18. shows the last processed week and its outcome, and never leaks lease internals', async () => {
    weeklyApi.listWeeklyReportRecurrences.mockResolvedValue({ items: [RULE] });
    await renderManager();
    expect(host.querySelector('#recurrence-last-rec-1')?.textContent)
      .toContain('Son işlenen hafta: 2026-09-28 (oluşturuldu)');
    expect(host.textContent).not.toMatch(/lease|token|nextAttemptAt|failureCount/i);
  });

  // ---------------------------------------------------------------------
  // 19-24. Management actions: edit template, pause, resume, ambiguity, locks
  // ---------------------------------------------------------------------

  it('19. edits only the future template as a full replacement', async () => {
    weeklyApi.listWeeklyReportRecurrences.mockResolvedValue({ items: [RULE] });
    weeklyApi.updateWeeklyReportRecurrenceTemplate.mockResolvedValue({
      recurrenceId: 'rec-1', version: 2, questions: [{ key: 'q1', prompt: 'Yeni soru?' }],
      instructions: null, nextPeriodStart: '2026-10-05',
    });
    await renderManager();
    await click(buttonByText('Şablonu düzenle'));
    change(host.querySelector('#recurrence-edit-question-rec-1-0') as HTMLInputElement, 'Yeni soru?');
    change(host.querySelector('#recurrence-edit-instructions-rec-1') as HTMLTextAreaElement, '');
    await click(buttonByText('Kaydet'));

    expect(weeklyApi.updateWeeklyReportRecurrenceTemplate).toHaveBeenCalledTimes(1);
    expect(weeklyApi.updateWeeklyReportRecurrenceTemplate.mock.calls[0]).toEqual([
      'rec-1',
      {
        clientActionId: 'action-1', expectedVersion: 1,
        questions: [{ key: 'q1', prompt: 'Yeni soru?' }],
        // Full replacement: a cleared note is sent explicitly as null.
        instructions: null,
      },
    ]);
    // The list is refreshed so the new version is visible.
    expect(weeklyApi.listWeeklyReportRecurrences).toHaveBeenCalledTimes(2);
  });

  it('20. pauses an active rule with its current version', async () => {
    weeklyApi.listWeeklyReportRecurrences.mockResolvedValue({ items: [RULE] });
    weeklyApi.pauseWeeklyReportRecurrence.mockResolvedValue({
      recurrenceId: 'rec-1', enabled: false, disabledReason: 'MANUAL',
      nextPeriodStart: '2026-10-05', version: 2,
    });
    await renderManager();
    await click(buttonByText('Duraklat'));
    expect(weeklyApi.pauseWeeklyReportRecurrence.mock.calls[0]).toEqual([
      'rec-1', { clientActionId: 'action-1', expectedVersion: 1 },
    ]);
  });

  it('21. resumes a paused rule with its current version and no period override', async () => {
    weeklyApi.listWeeklyReportRecurrences.mockResolvedValue({ items: [PAUSED_RULE] });
    weeklyApi.resumeWeeklyReportRecurrence.mockResolvedValue({
      recurrenceId: 'rec-2', enabled: true, nextPeriodStart: '2026-10-26', version: 5,
    });
    await renderManager();
    await click(buttonByText('Devam ettir'));
    expect(weeklyApi.resumeWeeklyReportRecurrence).toHaveBeenCalledTimes(1);
    const [id, input] = weeklyApi.resumeWeeklyReportRecurrence.mock.calls[0]!;
    expect(id).toBe('rec-2');
    expect(input).toEqual({ clientActionId: 'action-1', expectedVersion: 4 });
    // Default resume week is the server's current organization-local week.
    expect(input).not.toHaveProperty('periodStart');
  });

  it('22. retries an ambiguous template edit verbatim with the same action id', async () => {
    weeklyApi.listWeeklyReportRecurrences.mockResolvedValue({ items: [RULE] });
    await renderManager();
    await click(buttonByText('Şablonu düzenle'));
    change(host.querySelector('#recurrence-edit-question-rec-1-0') as HTMLInputElement, 'Yeni soru?');
    weeklyApi.updateWeeklyReportRecurrenceTemplate.mockRejectedValueOnce(new Error('transport lost'));
    await click(buttonByText('Kaydet'));
    const firstInput = weeklyApi.updateWeeklyReportRecurrenceTemplate.mock.calls[0]![1];

    weeklyApi.updateWeeklyReportRecurrenceTemplate.mockResolvedValueOnce({
      recurrenceId: 'rec-1', version: 2, questions: [{ key: 'q1', prompt: 'Yeni soru?' }],
      instructions: 'Lütfen doldurun.', nextPeriodStart: '2026-10-05',
    });
    await click(buttonByText('Özgün isteği tekrar dene'));
    expect(weeklyApi.updateWeeklyReportRecurrenceTemplate).toHaveBeenCalledTimes(2);
    expect(weeklyApi.updateWeeklyReportRecurrenceTemplate.mock.calls[1]![1]).toEqual(firstInput);
    expect(weeklyApi.updateWeeklyReportRecurrenceTemplate.mock.calls[1]![1].clientActionId).toBe('action-1');
  });

  it('23. retries an ambiguous pause verbatim with the same action id', async () => {
    weeklyApi.listWeeklyReportRecurrences.mockResolvedValue({ items: [RULE] });
    weeklyApi.pauseWeeklyReportRecurrence.mockRejectedValueOnce(new Error('transport lost'));
    await renderManager();
    await click(buttonByText('Duraklat'));
    const firstInput = weeklyApi.pauseWeeklyReportRecurrence.mock.calls[0]![1];

    weeklyApi.pauseWeeklyReportRecurrence.mockResolvedValueOnce({
      recurrenceId: 'rec-1', enabled: false, disabledReason: 'MANUAL',
      nextPeriodStart: '2026-10-05', version: 2,
    });
    await click(buttonByText('Özgün isteği tekrar dene'));
    expect(weeklyApi.pauseWeeklyReportRecurrence).toHaveBeenCalledTimes(2);
    expect(weeklyApi.pauseWeeklyReportRecurrence.mock.calls[1]![1]).toEqual(firstInput);
    expect(weeklyApi.pauseWeeklyReportRecurrence.mock.calls[1]![1].clientActionId).toBe('action-1');
  });

  it('24. retries an ambiguous resume verbatim with the same action id', async () => {
    weeklyApi.listWeeklyReportRecurrences.mockResolvedValue({ items: [PAUSED_RULE] });
    weeklyApi.resumeWeeklyReportRecurrence.mockRejectedValueOnce(new Error('transport lost'));
    await renderManager();
    await click(buttonByText('Devam ettir'));
    const firstInput = weeklyApi.resumeWeeklyReportRecurrence.mock.calls[0]![1];

    weeklyApi.resumeWeeklyReportRecurrence.mockResolvedValueOnce({
      recurrenceId: 'rec-2', enabled: true, nextPeriodStart: '2026-10-26', version: 5,
    });
    await click(buttonByText('Özgün isteği tekrar dene'));
    expect(weeklyApi.resumeWeeklyReportRecurrence).toHaveBeenCalledTimes(2);
    expect(weeklyApi.resumeWeeklyReportRecurrence.mock.calls[1]![1]).toEqual(firstInput);
    expect(weeklyApi.resumeWeeklyReportRecurrence.mock.calls[1]![1].clientActionId).toBe('action-1');
  });

  it('25. locks every rule action while a command is pending', async () => {
    weeklyApi.listWeeklyReportRecurrences.mockResolvedValue({ items: [RULE, PAUSED_RULE] });
    weeklyApi.pauseWeeklyReportRecurrence.mockReturnValue(new Promise(() => {}));
    await renderManager();
    await click(buttonByText('Duraklat'));
    expect((buttonByText('Duraklat') as HTMLButtonElement).disabled).toBe(true);
    expect((buttonByText('Şablonu düzenle') as HTMLButtonElement).disabled).toBe(true);
    expect((buttonByText('Devam ettir') as HTMLButtonElement).disabled).toBe(true);
  });

  it('26. locks every rule action while an outcome is ambiguous and offers only the frozen retry', async () => {
    weeklyApi.listWeeklyReportRecurrences.mockResolvedValue({ items: [RULE, PAUSED_RULE] });
    weeklyApi.pauseWeeklyReportRecurrence.mockRejectedValueOnce(new Error('transport lost'));
    await renderManager();
    await click(buttonByText('Duraklat'));
    expect((buttonByText('Duraklat') as HTMLButtonElement).disabled).toBe(true);
    expect((buttonByText('Şablonu düzenle') as HTMLButtonElement).disabled).toBe(true);
    expect(buttonByText('Özgün isteği tekrar dene')).toBeDefined();
  });
});
