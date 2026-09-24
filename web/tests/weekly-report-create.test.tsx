/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WeeklyReportCreateScreen } from '../src/WeeklyReportCreate';
import { ApiError, type CurrentUser } from '../src/services/api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const weeklyApi = vi.hoisted(() => ({ createWeeklyReport: vi.fn() }));
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
const profile = {
  id: 'profile-1',
  user: { id: 'staff-1', organizationId: 'org-1', name: 'Ayşe Personel', email: 'a@test.local',
    role: 'STAFF', mustChangePassword: false, isActive: true, version: 1 },
};

function change(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLSelectElement
    ? HTMLSelectElement.prototype
    : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
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
    people.listStaff.mockResolvedValue([profile]);
    weeklyApi.createWeeklyReport.mockResolvedValue({
      jobCardId: 'job-1', reportId: 'report-1', staffUserId: 'staff-1',
      periodStart: '2026-08-03', periodEnd: '2026-08-09', status: 'ACCEPTED', dueDate: '2026-08-10',
    });
    onCreated = vi.fn();
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });

  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

  async function render(user: CurrentUser = staffUser) {
    await act(async () => root.render(<WeeklyReportCreateScreen user={user}
      onCancel={() => {}} onCreated={onCreated} />));
    await flush();
  }

  function submit() {
    const form = host.querySelector('form');
    expect(form).not.toBeNull();
    act(() => { form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  }

  it('creates a self report for STAFF without personnel selector or questions', async () => {
    await render(staffUser);
    expect(host.querySelector('#weekly-assignee')).toBeNull();
    expect(host.textContent).toContain('Ayşe Personel');
    const period = host.querySelector('#weekly-period') as HTMLInputElement;
    change(period, '2026-08-03');
    await act(async () => { submit(); await flush(); });
    expect(weeklyApi.createWeeklyReport).toHaveBeenCalledTimes(1);
    const input = weeklyApi.createWeeklyReport.mock.calls[0]![0];
    expect(input).toMatchObject({ periodStart: '2026-08-03' });
    expect(input).not.toHaveProperty('assignedTo');
    expect(input).not.toHaveProperty('questions');
    expect(onCreated).toHaveBeenCalledWith('job-1');
  });

  it('creates a single-target request for MANAGER with questions and instructions', async () => {
    await render(manager);
    const select = host.querySelector('#weekly-assignee') as HTMLSelectElement;
    change(select, 'staff-1');
    const period = host.querySelector('#weekly-period') as HTMLInputElement;
    change(period, '2026-08-03');
    const addButton = Array.from(host.querySelectorAll('button'))
      .find((button) => button.textContent === 'Soru ekle');
    expect(addButton).toBeDefined();
    await act(async () => { addButton!.dispatchEvent(new Event('click', { bubbles: true })); });
    const question = host.querySelector('#weekly-question-0') as HTMLInputElement;
    change(question, 'Bu hafta ne öğrendin?');
    const instructions = host.querySelector('#weekly-instructions') as HTMLTextAreaElement;
    change(instructions, 'Lütfen doldurun.');
    await act(async () => { submit(); await flush(); });
    expect(weeklyApi.createWeeklyReport).toHaveBeenCalledTimes(1);
    expect(weeklyApi.createWeeklyReport.mock.calls[0]![0]).toMatchObject({
      periodStart: '2026-08-03',
      assignedTo: 'staff-1',
      questions: [{ key: 'q1', prompt: 'Bu hafta ne öğrendin?' }],
      instructions: 'Lütfen doldurun.',
    });
  });

  it('blocks MANAGER submit without assignee and surfaces field errors', async () => {
    await render(manager);
    await act(async () => { submit(); await flush(); });
    expect(weeklyApi.createWeeklyReport).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Aktif bir sorumlu personel seçin.');
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

  it('freezes the original attempt for ambiguous failures and retries it verbatim', async () => {
    await render(staffUser);
    weeklyApi.createWeeklyReport.mockRejectedValueOnce(new Error('transport lost'));
    await act(async () => { submit(); await flush(); });
    expect(onCreated).not.toHaveBeenCalled();
    const firstInput = weeklyApi.createWeeklyReport.mock.calls[0]![0];
    weeklyApi.createWeeklyReport.mockResolvedValueOnce({
      jobCardId: 'job-2', reportId: 'report-2', staffUserId: 'staff-1',
      periodStart: '2026-08-03', periodEnd: '2026-08-09', status: 'ACCEPTED', dueDate: '2026-08-10',
    });
    const retry = Array.from(host.querySelectorAll('button'))
      .find((button) => button.textContent === 'Özgün isteği tekrar dene');
    expect(retry).toBeDefined();
    await act(async () => {
      retry!.dispatchEvent(new Event('click', { bubbles: true }));
      await flush();
    });
    expect(weeklyApi.createWeeklyReport).toHaveBeenCalledTimes(2);
    expect(weeklyApi.createWeeklyReport.mock.calls[1]![0]).toEqual(firstInput);
    expect(onCreated).toHaveBeenCalledWith('job-2');
  });
});
