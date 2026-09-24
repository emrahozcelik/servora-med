/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WeeklyReportDetail } from '../src/jobs/WeeklyReportDetail';
import { ApiError, type CurrentUser } from '../src/services/api';
import type { JobCard } from '../src/jobs/jobs-api';
import type {
  WeeklyReportDetail as WeeklyReportDetailDto,
  WeeklyReportSubmission,
} from '../src/jobs/weekly-report-api';
import { workflowContext as baseWorkflowContext } from './fixtures/job-workflow';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const jobsApi = vi.hoisted(() => ({
  getJobCard: vi.fn(),
  acceptJobCard: vi.fn(),
  startJobCard: vi.fn(),
  resumeJobCard: vi.fn(),
  withdrawJobCardFromApproval: vi.fn(),
  submitJobCardForApproval: vi.fn(),
  approveJobCard: vi.fn(),
  requestJobCardRevision: vi.fn(),
  cancelJobCard: vi.fn(),
}));
const weeklyApi = vi.hoisted(() => ({
  getWeeklyReport: vi.fn(),
  listWeeklyReportSubmissions: vi.fn(),
  patchWeeklyReportDraft: vi.fn(),
}));
const realtime = vi.hoisted(() => ({
  latest: null as { keys: string[]; callback: () => void } | null,
}));
const location = vi.hoisted(() => ({ captureStartLocation: vi.fn() }));

vi.mock('../src/jobs/jobs-api', async (original) => ({
  ...await original<typeof import('../src/jobs/jobs-api')>(), ...jobsApi,
}));
vi.mock('../src/jobs/weekly-report-api', async (original) => ({
  ...await original<typeof import('../src/jobs/weekly-report-api')>(), ...weeklyApi,
}));
vi.mock('../src/jobs/start-location-capture', async (original) => ({
  ...await original<typeof import('../src/jobs/start-location-capture')>(), ...location,
}));
vi.mock('../src/realtime/RealtimeProvider', () => ({
  useRealtimeInvalidation: (keys: string[], callback: () => void) => {
    realtime.latest = { keys, callback };
  },
}));

const staffUser: CurrentUser = {
  id: 'staff-1', organizationId: 'org-1', name: 'Ayşe Personel', email: 'a@test.local',
  role: 'STAFF', mustChangePassword: false, isActive: true, version: 1,
};
const managerUser: CurrentUser = {
  ...staffUser, id: 'manager-1', name: 'Murat Yönetici', role: 'MANAGER',
};

const WEEK = { periodStart: '2026-08-03', periodEnd: '2026-08-09' };

function makeJob(overrides: Partial<JobCard> = {}): JobCard {
  const { workflowContext: workflowOverrides, ...rest } = overrides;
  return {
    id: 'job-1', organizationId: 'org-1', type: 'WEEKLY_REPORT', status: 'IN_PROGRESS',
    version: 3, title: 'Haftalık Rapor (2026-08-03 – 2026-08-09)', description: null,
    customerId: null, contactId: null, assignedTo: 'staff-1', createdBy: 'manager-1',
    priority: 'normal', dueDate: '2026-08-10', scheduledAt: null, scheduledEndsAt: null,
    engagementKind: null,
    assignee: { id: 'staff-1', name: 'Ayşe Personel' },
    customer: null, contact: null,
    workflowContext: {
      ...baseWorkflowContext,
      allowedCommands: ['SUBMIT_FOR_APPROVAL', 'CANCEL'],
      allowedActions: ['EDIT_JOB_FIELDS', 'VIEW_NOTES', 'ADD_NOTE'],
      startLocationCaptureEnabled: false,
      lifecycle: { ...baseWorkflowContext.lifecycle, startedAt: '2026-08-03T09:00:00.000Z' },
      submissionReadiness: null,
      ...workflowOverrides,
    },
    followUpContext: null, followUpProposal: null,
    ...rest,
  };
}

function makeDetail(overrides: Partial<WeeklyReportDetailDto> = {}): WeeklyReportDetailDto {
  return {
    id: 'report-1', staffUserId: 'staff-1', jobCardId: 'job-1',
    periodStart: WEEK.periodStart, periodEnd: WEEK.periodEnd,
    draft: {
      summary: 'Özet.', blockers: null, nextWeekPlan: 'Plan.',
      highlights: null, fieldObservations: null, supportNeeded: null,
    },
    questions: [{ key: 'q1', prompt: 'Bu hafta ne öğrendin?' }],
    answers: [{ questionKey: 'q1', answer: 'Yanıt.' }],
    version: 2, jobStatus: 'IN_PROGRESS', jobVersion: 3,
    dueDate: '2026-08-10', assignedTo: 'staff-1', instructions: null,
    liveSourceWork: [], submissionSummaries: [],
    ...overrides,
  };
}

function makeSubmission(overrides: Partial<WeeklyReportSubmission> = {}): WeeklyReportSubmission {
  return {
    id: 'sub-1', weeklyReportId: 'report-1', jobCardId: 'job-1', seqNo: 1,
    submittedBy: 'staff-1', submittedAt: '2026-08-07T12:00:00.000Z',
    periodStart: WEEK.periodStart, periodEnd: WEEK.periodEnd,
    body: {
      summary: 'Gönderilen özet.', blockers: null, nextWeekPlan: 'Gönderilen plan.',
      highlights: null, fieldObservations: null, supportNeeded: null,
    },
    questions: [{ key: 'q1', prompt: 'Bu hafta ne öğrendin?' }],
    answers: [{ questionKey: 'q1', answer: 'Gönderilen yanıt.' }],
    sourceWork: [{
      jobCardId: 'job-9', type: 'GENERAL_TASK', title: 'Klinik ziyareti',
      customerName: 'Klinik', staffCompletedAt: '2026-08-05T09:00:00.000Z',
      statusAtSnapshot: 'COMPLETED',
    }],
    jobVersion: 4, sourceActivityId: 'act-1',
    ...overrides,
  };
}

async function flush() {
  await act(async () => { await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe('WeeklyReportDetail', () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
      matches: false, media: '', onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    }));
    let action = 0;
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      configurable: true, value: vi.fn(() => `action-${++action}`),
    });
    realtime.latest = null;
    jobsApi.getJobCard.mockResolvedValue(makeJob());
    weeklyApi.getWeeklyReport.mockResolvedValue(makeDetail());
    weeklyApi.listWeeklyReportSubmissions.mockResolvedValue([]);
    location.captureStartLocation.mockResolvedValue({ outcome: 'unavailable', reason: 'UNSUPPORTED' });
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });

  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

  async function render(user: CurrentUser = staffUser) {
    await act(async () => root.render(<WeeklyReportDetail jobCardId="job-1" user={user} />));
    await flush();
  }

  function buttonByText(text: string): HTMLButtonElement {
    const found = Array.from(host.querySelectorAll('button'))
      .find((button) => button.textContent === text);
    expect(found, `button "${text}"`).toBeDefined();
    return found as HTMLButtonElement;
  }

  function hasButton(text: string): boolean {
    return Array.from(host.querySelectorAll('button')).some((button) => button.textContent === text);
  }

  /**
   * Text of one labelled section only. Asserting on the whole `host.textContent`
   * is not enough for source work: a submission's rows are also echoed in the
   * history section, so a page-wide assertion passes even when the review
   * section renders the wrong list.
   */
  function sectionText(ariaLabelledBy: string): string {
    const section = host.querySelector(`[aria-labelledby="${ariaLabelledBy}"]`);
    expect(section, `section "${ariaLabelledBy}"`).not.toBeNull();
    return section!.textContent ?? '';
  }

  function click(element: HTMLElement) {
    act(() => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  }

  function submitForm() {
    const form = host.querySelector('form');
    expect(form).not.toBeNull();
    act(() => { form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  }

  function summaryField(): HTMLTextAreaElement {
    return host.querySelector('#weekly-summary') as HTMLTextAreaElement;
  }

  function answerField(): HTMLTextAreaElement {
    return host.querySelector('#weekly-answer-q1') as HTMLTextAreaElement;
  }

  function type(element: HTMLTextAreaElement, value: string) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    descriptor?.set?.call(element, value);
    act(() => { element.dispatchEvent(new Event('input', { bubbles: true })); });
  }

  async function fireRealtime() {
    expect(realtime.latest).not.toBeNull();
    await act(async () => {
      realtime.latest!.callback();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  // 1
  it('marks the form dirty when a draft section is edited', async () => {
    await render();
    expect(hasButton('Taslağı kaydet')).toBe(true);
    expect(buttonByText('Kontrole gönder').disabled).toBe(false);
    type(summaryField(), 'Değiştirilmiş özet.');
    expect(buttonByText('Kontrole gönder').disabled).toBe(true);
  });

  // 2
  it('blocks submission of a dirty draft and explains why', async () => {
    await render();
    type(summaryField(), 'Kaydedilmemiş özet.');
    const submit = buttonByText('Kontrole gönder');
    expect(submit.disabled).toBe(true);
    click(submit);
    await flush();
    expect(jobsApi.submitJobCardForApproval).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Raporu göndermeden önce değişiklikleri kaydedin.');
  });

  // 3
  it('clears the dirty state after a successful save', async () => {
    await render();
    type(summaryField(), 'Kaydedilmiş özet.');
    weeklyApi.patchWeeklyReportDraft.mockResolvedValueOnce(makeDetail({
      version: 3,
      draft: {
        summary: 'Kaydedilmiş özet.', blockers: null, nextWeekPlan: 'Plan.',
        highlights: null, fieldObservations: null, supportNeeded: null,
      },
    }));
    await act(async () => { submitForm(); await flush(); });
    expect(weeklyApi.patchWeeklyReportDraft).toHaveBeenCalledTimes(1);
    expect(weeklyApi.patchWeeklyReportDraft.mock.calls[0]![1]).toMatchObject({ expectedVersion: 2 });
    expect(host.textContent).not.toContain('Raporu göndermeden önce değişiklikleri kaydedin.');
  });

  // 4
  it('enables submission again once the save persisted the edits', async () => {
    await render();
    type(summaryField(), 'Kaydedilmiş özet.');
    expect(buttonByText('Kontrole gönder').disabled).toBe(true);
    weeklyApi.patchWeeklyReportDraft.mockResolvedValueOnce(makeDetail({
      version: 3,
      draft: {
        summary: 'Kaydedilmiş özet.', blockers: null, nextWeekPlan: 'Plan.',
        highlights: null, fieldObservations: null, supportNeeded: null,
      },
    }));
    await act(async () => { submitForm(); await flush(); });
    expect(buttonByText('Kontrole gönder').disabled).toBe(false);
  });

  // 5
  it('blocks submission when only a manager-question answer is dirty', async () => {
    await render();
    type(answerField(), 'Kaydedilmemiş yanıt.');
    expect(buttonByText('Kontrole gönder').disabled).toBe(true);
    expect(host.textContent).toContain('Raporu göndermeden önce değişiklikleri kaydedin.');
  });

  // 6
  it('returns to clean when an edit is reverted to the persisted value', async () => {
    await render();
    const summary = summaryField();
    type(summary, 'Geçici.');
    expect(buttonByText('Kontrole gönder').disabled).toBe(true);
    type(summary, 'Özet.');
    expect(buttonByText('Kontrole gönder').disabled).toBe(false);
  });

  // 7
  it('preserves unsaved text through a realtime invalidation while dirty', async () => {
    await render();
    type(summaryField(), 'Kaydedilmemiş metin.');
    weeklyApi.getWeeklyReport.mockResolvedValue(makeDetail({
      version: 7,
      draft: {
        summary: 'Sunucudaki yeni özet.', blockers: null, nextWeekPlan: 'Plan.',
        highlights: null, fieldObservations: null, supportNeeded: null,
      },
    }));
    await fireRealtime();
    expect(summaryField().value).toBe('Kaydedilmemiş metin.');
    expect(host.textContent).toContain('Kaydedilmemiş değişiklikleriniz korunuyor');
  });

  // 8
  it('hydrates server content on a realtime invalidation while clean', async () => {
    await render();
    expect(summaryField().value).toBe('Özet.');
    weeklyApi.getWeeklyReport.mockResolvedValue(makeDetail({
      version: 7,
      draft: {
        summary: 'Sunucudaki yeni özet.', blockers: null, nextWeekPlan: 'Plan.',
        highlights: null, fieldObservations: null, supportNeeded: null,
      },
    }));
    await fireRealtime();
    expect(summaryField().value).toBe('Sunucudaki yeni özet.');
    expect(host.textContent).not.toContain('Kaydedilmemiş değişiklikleriniz korunuyor');
  });

  // 9
  it('preserves local edits on VERSION_CONFLICT instead of discarding them', async () => {
    await render();
    type(summaryField(), 'Yerel metin.');
    weeklyApi.patchWeeklyReportDraft.mockRejectedValueOnce(
      new ApiError(409, 'VERSION_CONFLICT', 'Rapor başka bir işlem tarafından güncellendi.'),
    );
    weeklyApi.getWeeklyReport.mockResolvedValue(makeDetail({
      version: 9,
      draft: {
        summary: 'Sunucudaki sürüm.', blockers: null, nextWeekPlan: 'Plan.',
        highlights: null, fieldObservations: null, supportNeeded: null,
      },
    }));
    await act(async () => { submitForm(); await flush(); });
    expect(summaryField().value).toBe('Yerel metin.');
    expect(host.textContent).toContain('Kaydedilmemiş değişiklikleriniz korunuyor');
    expect(host.textContent).toContain('Sunucudaki sürümü yükle');
  });

  // 10
  it('replaces local content with the server version only on explicit user choice', async () => {
    await render();
    type(summaryField(), 'Yerel metin.');
    weeklyApi.patchWeeklyReportDraft.mockRejectedValueOnce(
      new ApiError(409, 'VERSION_CONFLICT', 'Rapor başka bir işlem tarafından güncellendi.'),
    );
    weeklyApi.getWeeklyReport.mockResolvedValue(makeDetail({
      version: 9,
      draft: {
        summary: 'Sunucudaki sürüm.', blockers: null, nextWeekPlan: 'Plan.',
        highlights: null, fieldObservations: null, supportNeeded: null,
      },
    }));
    await act(async () => { submitForm(); await flush(); });
    expect(summaryField().value).toBe('Yerel metin.');
    click(buttonByText('Sunucudaki sürümü yükle'));
    await flush();
    expect(summaryField().value).toBe('Sunucudaki sürüm.');
    expect(host.textContent).not.toContain('Kaydedilmemiş değişiklikleriniz korunuyor');
  });

  // 11
  it('applies the identical dirty contract to a revision (seq-2) resubmission', async () => {
    jobsApi.getJobCard.mockResolvedValue(makeJob({
      workflowContext: {
        ...baseWorkflowContext,
        allowedCommands: ['SUBMIT_FOR_APPROVAL', 'CANCEL'],
        allowedActions: ['EDIT_JOB_FIELDS', 'VIEW_NOTES', 'ADD_NOTE'],
        lifecycle: {
          ...baseWorkflowContext.lifecycle,
          startedAt: '2026-08-03T09:00:00.000Z',
          submittedAt: '2026-08-05T10:00:00.000Z',
          revisionRequestedAt: '2026-08-06T10:00:00.000Z',
        },
        submissionReadiness: null,
      },
    }));
    weeklyApi.listWeeklyReportSubmissions.mockResolvedValue([makeSubmission({ seqNo: 1 })]);
    await render();
    expect(hasButton('Yeniden kontrole gönder')).toBe(true);
    expect(buttonByText('Yeniden kontrole gönder').disabled).toBe(false);
    type(summaryField(), 'Revizyon sonrası kaydedilmemiş.');
    expect(buttonByText('Yeniden kontrole gönder').disabled).toBe(true);
    expect(host.textContent).toContain('Raporu göndermeden önce değişiklikleri kaydedin.');
  });

  // 12
  it('prevents submission while a draft save is in flight', async () => {
    await render();
    type(summaryField(), 'Kaydediliyor.');
    let resolveSave: (value: unknown) => void = () => {};
    weeklyApi.patchWeeklyReportDraft.mockImplementationOnce(
      () => new Promise((resolve) => { resolveSave = resolve; }),
    );
    act(() => { submitForm(); });
    expect(weeklyApi.patchWeeklyReportDraft).toHaveBeenCalledTimes(1);
    expect(buttonByText('Kontrole gönder').disabled).toBe(true);
    expect(host.textContent).toContain('Taslak kaydedilirken rapor gönderilemez.');
    click(buttonByText('Kontrole gönder'));
    expect(jobsApi.submitJobCardForApproval).not.toHaveBeenCalled();
    await act(async () => {
      resolveSave(makeDetail({ version: 3 }));
      await flush();
    });
    expect(buttonByText('Kontrole gönder').disabled).toBe(false);
  });

  // 13
  it('retains the exact original clientActionId across an ambiguous lifecycle retry', async () => {
    jobsApi.getJobCard.mockResolvedValue(makeJob({
      status: 'ACCEPTED',
      workflowContext: {
        ...baseWorkflowContext,
        allowedCommands: ['START', 'CANCEL'],
        allowedActions: ['EDIT_JOB_FIELDS', 'VIEW_NOTES', 'ADD_NOTE'],
        submissionReadiness: null,
      },
    }));
    await render();
    jobsApi.startJobCard.mockRejectedValueOnce(new Error('transport lost'));
    click(buttonByText('İşi başlat'));
    await flush();
    expect(jobsApi.startJobCard).toHaveBeenCalledTimes(1);
    const firstInput = jobsApi.startJobCard.mock.calls[0]![1];
    jobsApi.startJobCard.mockResolvedValueOnce(makeJob({ status: 'IN_PROGRESS' }));
    click(buttonByText('Özgün işlemi tekrar dene'));
    await flush();
    expect(jobsApi.startJobCard).toHaveBeenCalledTimes(2);
    expect(jobsApi.startJobCard.mock.calls[1]![1]).toEqual(firstInput);
    expect(firstInput.clientActionId).toBe('action-1');
  });

  // 14
  it('converges after an ambiguous retry when the server already committed', async () => {
    jobsApi.getJobCard.mockResolvedValue(makeJob({
      status: 'ACCEPTED',
      workflowContext: {
        ...baseWorkflowContext,
        allowedCommands: ['START', 'CANCEL'],
        allowedActions: ['EDIT_JOB_FIELDS', 'VIEW_NOTES', 'ADD_NOTE'],
        submissionReadiness: null,
      },
    }));
    await render();
    jobsApi.startJobCard.mockRejectedValueOnce(new Error('socket closed before response'));
    click(buttonByText('İşi başlat'));
    await flush();
    expect(host.textContent).toContain('Özgün işlemi tekrar dene');
    // The original attempt already committed; the replay converges on the
    // committed truth and the frozen attempt is released.
    jobsApi.startJobCard.mockResolvedValueOnce(makeJob({ status: 'IN_PROGRESS' }));
    jobsApi.getJobCard.mockResolvedValue(makeJob({ status: 'IN_PROGRESS', version: 4 }));
    click(buttonByText('Özgün işlemi tekrar dene'));
    await flush();
    expect(host.textContent).not.toContain('Özgün işlemi tekrar dene');
    expect(jobsApi.startJobCard.mock.calls[1]![1]).toEqual(jobsApi.startJobCard.mock.calls[0]![1]);
  });

  // 15
  it('disables unrelated lifecycle actions while the attempt outcome is uncertain', async () => {
    jobsApi.getJobCard.mockResolvedValue(makeJob({
      status: 'ACCEPTED',
      workflowContext: {
        ...baseWorkflowContext,
        allowedCommands: ['START', 'CANCEL'],
        allowedActions: ['EDIT_JOB_FIELDS', 'VIEW_NOTES', 'ADD_NOTE'],
        submissionReadiness: null,
      },
    }));
    await render();
    expect(buttonByText('İşi iptal et').disabled).toBe(false);
    jobsApi.startJobCard.mockRejectedValueOnce(new Error('transport lost'));
    click(buttonByText('İşi başlat'));
    await flush();
    expect(buttonByText('İşi iptal et').disabled).toBe(true);
    expect(buttonByText('İşi başlat').disabled).toBe(true);
    expect(buttonByText('Özgün işlemi tekrar dene').disabled).toBe(false);
  });

  // 16
  it('shows the manager the frozen submission and its frozen source work', async () => {
    jobsApi.getJobCard.mockResolvedValue(makeJob({
      status: 'WAITING_APPROVAL',
      workflowContext: {
        ...baseWorkflowContext,
        allowedCommands: ['APPROVE', 'REQUEST_REVISION', 'WITHDRAW_FROM_APPROVAL', 'CANCEL'],
        allowedActions: ['VIEW_NOTES', 'ADD_NOTE'],
        lifecycle: {
          ...baseWorkflowContext.lifecycle,
          startedAt: '2026-08-03T09:00:00.000Z',
          submittedAt: '2026-08-07T12:00:00.000Z',
        },
        submissionReadiness: null,
      },
    }));
    weeklyApi.getWeeklyReport.mockResolvedValue(makeDetail({
      jobStatus: 'WAITING_APPROVAL', version: 5,
      // The live list must never be the review document. A distinguishable live
      // row is what makes this assertion discriminate the frozen list.
      liveSourceWork: [{
        jobCardId: 'live-1', type: 'GENERAL_TASK', title: 'Canlı iş kaydı',
        customerName: null, staffCompletedAt: '2026-08-06T09:00:00.000Z',
        statusAtSnapshot: 'COMPLETED',
      }],
    }));
    weeklyApi.listWeeklyReportSubmissions.mockResolvedValue([makeSubmission({ seqNo: 2 })]);
    await render(managerUser);
    expect(host.textContent).toContain('Gönderilen rapor');
    expect(host.textContent).toContain('#2');
    expect(host.textContent).toContain('Gönderilen özet.');
    expect(host.textContent).toContain('Gönderilen yanıt.');
    expect(sectionText('weekly-activity-title')).toContain('Gönderimde dondurulan çalışma listesi');
    expect(sectionText('weekly-activity-title')).toContain('Klinik ziyareti');
    expect(sectionText('weekly-activity-title')).not.toContain('Canlı iş kaydı');
  });

  // 17
  it('never shows the false "no work" state when a frozen submission has rows', async () => {
    jobsApi.getJobCard.mockResolvedValue(makeJob({
      status: 'WAITING_APPROVAL',
      workflowContext: {
        ...baseWorkflowContext,
        allowedCommands: ['APPROVE', 'REQUEST_REVISION', 'WITHDRAW_FROM_APPROVAL', 'CANCEL'],
        allowedActions: ['VIEW_NOTES', 'ADD_NOTE'],
        lifecycle: {
          ...baseWorkflowContext.lifecycle,
          startedAt: '2026-08-03T09:00:00.000Z',
          submittedAt: '2026-08-07T12:00:00.000Z',
        },
        submissionReadiness: null,
      },
    }));
    // liveSourceWork is intentionally omitted by the server in WAITING_APPROVAL.
    weeklyApi.getWeeklyReport.mockResolvedValue(makeDetail({
      jobStatus: 'WAITING_APPROVAL', version: 5, liveSourceWork: [],
    }));
    weeklyApi.listWeeklyReportSubmissions.mockResolvedValue([makeSubmission({ seqNo: 1 })]);
    await render(managerUser);
    // Scoped to the review section: the frozen rows are echoed in the history
    // section too, so a page-wide assertion would pass without proving anything.
    const activity = sectionText('weekly-activity-title');
    expect(activity).toContain('Klinik ziyareti');
    expect(activity).not.toContain('Gönderimde dondurulan çalışma listesi boş.');
    expect(host.textContent).not.toContain('Bu hafta için uygun iş bulunamadı');
  });

  // 18
  it('presents the final frozen report for a COMPLETED job', async () => {
    jobsApi.getJobCard.mockResolvedValue(makeJob({
      status: 'COMPLETED',
      workflowContext: {
        ...baseWorkflowContext,
        allowedCommands: [],
        allowedActions: ['VIEW_NOTES'],
        submissionReadiness: null,
      },
    }));
    weeklyApi.getWeeklyReport.mockResolvedValue(makeDetail({ jobStatus: 'COMPLETED', version: 6 }));
    weeklyApi.listWeeklyReportSubmissions.mockResolvedValue([makeSubmission({
      seqNo: 3,
      body: {
        summary: 'Onaylanan özet.', blockers: null, nextWeekPlan: 'Onaylanan plan.',
        highlights: null, fieldObservations: null, supportNeeded: null,
      },
    })]);
    await render(managerUser);
    expect(host.textContent).toContain('Gönderilen rapor');
    expect(host.textContent).toContain('Onaylanan özet.');
    expect(host.textContent).toContain('#3');
    expect(host.textContent).toContain('Klinik ziyareti');
  });

  // 19
  it('shows manager request instructions read-only to both staff and manager', async () => {
    weeklyApi.getWeeklyReport.mockResolvedValue(makeDetail({
      instructions: 'Haftalık hedefleri ve müşteri geri bildirimlerini yazın.',
    }));
    await render();
    expect(host.textContent).toContain('Yönetici talimatı');
    expect(host.textContent).toContain('Haftalık hedefleri ve müşteri geri bildirimlerini yazın.');
    expect(host.querySelector('.weekly-instructions-text')).not.toBeNull();
    expect(host.querySelectorAll('textarea#weekly-instructions').length).toBe(0);
  });

  // 20a
  it('does not request geolocation on START when workflowContext disables it', async () => {
    jobsApi.getJobCard.mockResolvedValue(makeJob({
      status: 'ACCEPTED',
      workflowContext: {
        ...baseWorkflowContext,
        allowedCommands: ['START', 'CANCEL'],
        allowedActions: ['EDIT_JOB_FIELDS', 'VIEW_NOTES', 'ADD_NOTE'],
        startLocationCaptureEnabled: false,
        submissionReadiness: null,
      },
    }));
    jobsApi.startJobCard.mockResolvedValue(makeJob({ status: 'IN_PROGRESS' }));
    await render();
    click(buttonByText('İşi başlat'));
    await flush();
    expect(location.captureStartLocation).not.toHaveBeenCalled();
    expect(jobsApi.startJobCard).toHaveBeenCalledTimes(1);
    expect(jobsApi.startJobCard.mock.calls[0]![1]).not.toHaveProperty('locationCapture');
  });

  // 20b
  it('captures geolocation on START exactly when workflowContext enables it', async () => {
    jobsApi.getJobCard.mockResolvedValue(makeJob({
      status: 'ACCEPTED',
      workflowContext: {
        ...baseWorkflowContext,
        allowedCommands: ['START', 'CANCEL'],
        allowedActions: ['EDIT_JOB_FIELDS', 'VIEW_NOTES', 'ADD_NOTE'],
        startLocationCaptureEnabled: true,
        submissionReadiness: null,
      },
    }));
    jobsApi.startJobCard.mockResolvedValue(makeJob({ status: 'IN_PROGRESS' }));
    await render();
    expect(host.textContent).toContain('yaklaşık konum');
    click(buttonByText('İşi başlat'));
    await flush();
    expect(location.captureStartLocation).toHaveBeenCalledTimes(1);
    expect(jobsApi.startJobCard.mock.calls[0]![1]).toMatchObject({
      locationCapture: { outcome: 'unavailable', reason: 'UNSUPPORTED' },
    });
  });
});
