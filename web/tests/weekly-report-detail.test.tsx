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
  listActivity: vi.fn(),
}));
const weeklyApi = vi.hoisted(() => ({
  getWeeklyReport: vi.fn(),
  listWeeklyReportSubmissions: vi.fn(),
  patchWeeklyReportDraft: vi.fn(),
  downloadWeeklyReportSubmissionPdf: vi.fn(),
}));
const realtime = vi.hoisted(() => ({
  latest: null as { keys: string[]; callback: () => void } | null,
}));
const location = vi.hoisted(() => ({ captureStartLocation: vi.fn(), captureActionLocation: vi.fn() }));
const downloads = vi.hoisted(() => ({ saveBlobAs: vi.fn() }));

vi.mock('../src/jobs/jobs-api', async (original) => ({
  ...await original<typeof import('../src/jobs/jobs-api')>(), ...jobsApi,
}));
vi.mock('../src/jobs/weekly-report-api', async (original) => ({
  ...await original<typeof import('../src/jobs/weekly-report-api')>(), ...weeklyApi,
}));
vi.mock('../src/jobs/start-location-capture', async (original) => ({
  ...await original<typeof import('../src/jobs/start-location-capture')>(), ...location,
}));
vi.mock('../src/services/file-download', () => ({ saveBlobAs: downloads.saveBlobAs }));
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
    id: 'report-1', organizationId: 'org-1', staffUserId: 'staff-1', jobCardId: 'job-1',
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
    createdAt: '2026-08-03T09:00:00.000Z', updatedAt: '2026-08-04T10:00:00.000Z',
    ...overrides,
  };
}

function makeSubmission(overrides: Partial<WeeklyReportSubmission> = {}): WeeklyReportSubmission {
  return {
    id: 'sub-1', organizationId: 'org-1', weeklyReportId: 'report-1', jobCardId: 'job-1', seqNo: 1,
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
    createdAt: '2026-08-07T12:00:00.000Z',
    ...overrides,
  };
}

async function flush() {
  await act(async () => { await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)); });
}

/** Intl may emit NBSP / narrow NBSP between date and time; compare normalized. */
const normalize = (value: string | null | undefined) =>
  (value ?? '').replace(/[\s\u00a0\u202f]+/gu, ' ').trim();

/**
 * The repository's canonical tr-TR instant presentation. Computed with the same
 * Intl options so the expectation is timezone-independent (both sides render in
 * the runner's zone) while still pinning the presentation contract.
 */
const trInstant = (value: string) => normalize(new Intl.DateTimeFormat('tr-TR', {
  dateStyle: 'medium', timeStyle: 'short',
}).format(new Date(value)));

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
    jobsApi.listActivity.mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 });
    location.captureStartLocation.mockResolvedValue({ outcome: 'unavailable', reason: 'UNSUPPORTED' });
    location.captureActionLocation.mockResolvedValue({ outcome: 'unavailable', reason: 'UNSUPPORTED' });
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
    // Scoped to the frozen panel: `#2`, the summary and the answer also render in
    // the history section, so a page-wide assertion would not prove the panel.
    const frozen = sectionText('weekly-frozen-title');
    expect(frozen).toContain('Gönderilen rapor');
    expect(frozen).toContain('#2');
    expect(frozen).toContain('Gönderilen özet.');
    expect(frozen).toContain('Gönderilen yanıt.');
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
    const frozen = sectionText('weekly-frozen-title');
    expect(frozen).toContain('Gönderilen rapor');
    expect(frozen).toContain('#3');
    expect(frozen).toContain('Onaylanan özet.');
    expect(sectionText('weekly-activity-title')).toContain('Klinik ziyareti');
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
    expect(location.captureActionLocation).not.toHaveBeenCalled();
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
    expect(location.captureActionLocation).toHaveBeenCalledTimes(1);
    expect(jobsApi.startJobCard.mock.calls[0]![1]).toMatchObject({
      locationCapture: { outcome: 'unavailable', reason: 'UNSUPPORTED' },
    });
  });

  // 20c
  function makeSubmitJob(): JobCard {
    return makeJob({
      workflowContext: {
        ...baseWorkflowContext,
        allowedCommands: ['SUBMIT_FOR_APPROVAL', 'CANCEL'],
        allowedActions: ['EDIT_JOB_FIELDS', 'VIEW_NOTES', 'ADD_NOTE'],
        startLocationCaptureEnabled: false,
        submitLocationCaptureEnabled: true,
        lifecycle: { ...baseWorkflowContext.lifecycle, startedAt: '2026-08-03T09:00:00.000Z' },
        submissionReadiness: null,
      },
    });
  }

  function confirmSubmitDialog(reason: string) {
    const dialog = host.querySelector('.reason-dialog');
    expect(dialog, 'submit dialog').not.toBeNull();
    const textarea = dialog!.querySelector('textarea') as HTMLTextAreaElement | null;
    expect(textarea, 'reason field').not.toBeNull();
    type(textarea!, reason);
    const form = textarea!.closest('form');
    expect(form, 'dialog form').not.toBeNull();
    act(() => { form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  }

  it('does not request geolocation on SUBMIT when workflowContext disables it', async () => {
    await render();
    click(buttonByText('Kontrole gönder'));
    await flush();
    confirmSubmitDialog('Hafta tamamlandı.');
    await flush();
    expect(location.captureActionLocation).not.toHaveBeenCalled();
    expect(jobsApi.submitJobCardForApproval).toHaveBeenCalledTimes(1);
    expect(jobsApi.submitJobCardForApproval.mock.calls[0]![1]).not.toHaveProperty('locationCapture');
    expect(jobsApi.submitJobCardForApproval.mock.calls[0]![1]).toMatchObject({ note: 'Hafta tamamlandı.' });
  });

  // 20d
  it('captures geolocation on SUBMIT exactly when workflowContext enables it', async () => {
    jobsApi.getJobCard.mockResolvedValue(makeSubmitJob());
    location.captureActionLocation.mockResolvedValue({
      outcome: 'captured', latitude: 39.92077, longitude: 32.85411,
      accuracyMeters: 18, capturedAt: '2026-08-07T11:37:00.000Z',
    });
    await render();
    click(buttonByText('Kontrole gönder'));
    await flush();
    confirmSubmitDialog('Hafta tamamlandı.');
    await flush();
    expect(location.captureActionLocation).toHaveBeenCalledTimes(1);
    expect(jobsApi.submitJobCardForApproval).toHaveBeenCalledTimes(1);
    expect(jobsApi.submitJobCardForApproval.mock.calls[0]![1]).toMatchObject({
      note: 'Hafta tamamlandı.',
      locationCapture: {
        outcome: 'captured', latitude: 39.92077, longitude: 32.85411,
        accuracyMeters: 18, capturedAt: '2026-08-07T11:37:00.000Z',
      },
    });
  });

  // 20e
  it('executes an unavailable SUBMIT capture without blocking', async () => {
    jobsApi.getJobCard.mockResolvedValue(makeSubmitJob());
    location.captureActionLocation.mockResolvedValue({ outcome: 'unavailable', reason: 'TIMEOUT' });
    await render();
    click(buttonByText('Kontrole gönder'));
    await flush();
    confirmSubmitDialog('Hafta tamamlandı.');
    await flush();
    expect(jobsApi.submitJobCardForApproval).toHaveBeenCalledTimes(1);
    expect(jobsApi.submitJobCardForApproval.mock.calls[0]![1]).toMatchObject({
      locationCapture: { outcome: 'unavailable', reason: 'TIMEOUT' },
    });
  });

  // 20f
  it('reuses the exact SUBMIT capture and clientActionId on ambiguous retry with one browser call', async () => {
    jobsApi.getJobCard.mockResolvedValue(makeSubmitJob());
    const captured = {
      outcome: 'captured', latitude: 39.92077, longitude: 32.85411,
      accuracyMeters: 18, capturedAt: '2026-08-07T11:37:00.000Z',
    };
    location.captureActionLocation.mockResolvedValue(captured);
    jobsApi.submitJobCardForApproval.mockRejectedValueOnce(new Error('transport lost'));
    await render();
    click(buttonByText('Kontrole gönder'));
    await flush();
    confirmSubmitDialog('Hafta tamamlandı.');
    await flush();
    expect(host.textContent).toContain('Özgün işlemi tekrar dene');
    click(buttonByText('Özgün işlemi tekrar dene'));
    await flush();
    expect(location.captureActionLocation).toHaveBeenCalledTimes(1);
    expect(jobsApi.submitJobCardForApproval).toHaveBeenCalledTimes(2);
    const first = jobsApi.submitJobCardForApproval.mock.calls[0]![1];
    const second = jobsApi.submitJobCardForApproval.mock.calls[1]![1];
    expect(second).toEqual(first);
    expect(first).toMatchObject({ clientActionId: 'action-1', locationCapture: captured });
  });

  // 20g
  it('takes the lifecycle lock synchronously so one confirm cannot mint two attempts', async () => {
    jobsApi.getJobCard.mockResolvedValue(makeSubmitJob());
    const captured = {
      outcome: 'captured', latitude: 39.92077, longitude: 32.85411,
      accuracyMeters: 18, capturedAt: '2026-08-07T11:37:00.000Z',
    };
    location.captureActionLocation.mockResolvedValue(captured);
    await render();
    click(buttonByText('Kontrole gönder'));
    await flush();
    // Confirm twice in the same tick: React has no chance to rerender between
    // the two submits, so a state-only `pending` guard would admit both and
    // mint action-1/action-2 with two browser acquisitions.
    const dialog = host.querySelector('.reason-dialog');
    expect(dialog, 'submit dialog').not.toBeNull();
    const textarea = dialog!.querySelector('textarea') as HTMLTextAreaElement | null;
    expect(textarea, 'reason field').not.toBeNull();
    type(textarea!, 'Hafta tamamlandı.');
    const form = textarea!.closest('form');
    expect(form, 'dialog form').not.toBeNull();
    act(() => {
      form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(location.captureActionLocation).toHaveBeenCalledTimes(1);
    expect(jobsApi.submitJobCardForApproval).toHaveBeenCalledTimes(1);
    expect(jobsApi.submitJobCardForApproval.mock.calls[0]![1])
      .toMatchObject({ clientActionId: 'action-1', locationCapture: captured });
  });

  // 20h
  it('abandons the SUBMIT when the screen unmounts while the capture is pending', async () => {
    jobsApi.getJobCard.mockResolvedValue(makeSubmitJob());
    const gate = deferred<{ outcome: 'unavailable'; reason: 'TIMEOUT' }>();
    location.captureActionLocation.mockReturnValue(gate.promise);
    await render();
    click(buttonByText('Kontrole gönder'));
    await flush();
    confirmSubmitDialog('Hafta tamamlandı.');
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    await act(async () => {
      gate.resolve({ outcome: 'unavailable', reason: 'TIMEOUT' });
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(jobsApi.submitJobCardForApproval).not.toHaveBeenCalled();
  });

  // 20i
  it('never submits the previous job after the screen moves to another job mid-capture', async () => {
    const secondJob = makeJob({
      id: 'job-2',
      workflowContext: {
        ...baseWorkflowContext,
        allowedCommands: ['SUBMIT_FOR_APPROVAL', 'CANCEL'],
        allowedActions: ['EDIT_JOB_FIELDS', 'VIEW_NOTES', 'ADD_NOTE'],
        startLocationCaptureEnabled: false,
        submitLocationCaptureEnabled: true,
        lifecycle: { ...baseWorkflowContext.lifecycle, startedAt: '2026-08-03T09:00:00.000Z' },
        submissionReadiness: null,
      },
    });
    jobsApi.getJobCard.mockImplementation(async (id: string) =>
      (id === 'job-2' ? secondJob : makeSubmitJob()));
    weeklyApi.getWeeklyReport.mockImplementation(async (id: string) =>
      (id === 'job-2' ? makeDetail({ jobCardId: 'job-2' }) : makeDetail()));
    const gate = deferred<{ outcome: 'unavailable'; reason: 'TIMEOUT' }>();
    location.captureActionLocation.mockReturnValue(gate.promise);
    await render();
    click(buttonByText('Kontrole gönder'));
    await flush();
    confirmSubmitDialog('Hafta tamamlandı.');
    // Navigate to another job while the first capture is still pending.
    await act(async () => {
      root.render(<WeeklyReportDetail jobCardId="job-2" user={staffUser} />);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      gate.resolve({ outcome: 'unavailable', reason: 'TIMEOUT' });
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(jobsApi.submitJobCardForApproval).not.toHaveBeenCalled();
    // The replacement screen is usable: its own SUBMIT dispatches for job-2.
    location.captureActionLocation.mockResolvedValue({ outcome: 'unavailable', reason: 'TIMEOUT' });
    click(buttonByText('Kontrole gönder'));
    await flush();
    confirmSubmitDialog('İkinci iş tamamlandı.');
    await flush();
    expect(jobsApi.submitJobCardForApproval).toHaveBeenCalledTimes(1);
    expect(jobsApi.submitJobCardForApproval.mock.calls[0]![0]).toBe('job-2');
  });

  // 20j
  it('explains the advisory SUBMIT capture before the submit action', async () => {
    jobsApi.getJobCard.mockResolvedValue(makeSubmitJob());
    await render();
    const notice = host.querySelector('.submit-location-notice');
    expect(notice, 'submit notice').not.toBeNull();
    expect(notice!.textContent).toContain('Onaya gönderdiğinizde');
    expect(notice!.textContent).toContain('bir kez yaklaşık konum');
    expect(notice!.textContent).toContain('iş geçmişinde');
    expect(notice!.textContent).toContain('engellenmez');
    expect(notice!.textContent).not.toMatch(/sürekli|takip|mesafe|eşleş|MATCH|DIFFERENT/i);
  });

  // 20k
  it('hides the SUBMIT notice when the capability is off', async () => {
    await render();
    expect(buttonByText('Kontrole gönder')).not.toBeNull();
    expect(host.querySelector('.submit-location-notice')).toBeNull();
  });

  // 20l
  it('exposes the captured SUBMIT location through the shared timeline without coordinates', async () => {
    jobsApi.listActivity.mockResolvedValue({
      items: [{
        id: 'act-submit', jobCardId: 'job-1', eventType: 'JOB_SUBMITTED_FOR_APPROVAL',
        actor: { id: 'staff-1', name: 'Ayşe Personel' },
        details: {
          kind: 'STATUS_TRANSITION', fromStatus: 'IN_PROGRESS', toStatus: 'WAITING_APPROVAL',
          reason: null,
          submitLocation: {
            outcome: 'CAPTURED', approximateLabel: 'Kızılay, Çankaya / Ankara',
            accuracyMeters: 18, capturedAt: '2026-08-07T11:37:00.000Z',
            geocodingProvider: 'GOOGLE',
          },
        },
        createdAt: '2026-08-07T11:37:02.000Z',
      }],
      total: 1, limit: 50, offset: 0,
    });
    await render();
    expect(host.textContent).toContain('İşlem geçmişi');
    expect(host.textContent).toContain('Onaya gönderme konumu: Kızılay, Çankaya / Ankara');
    expect(host.textContent).toContain('Doğruluk: yaklaşık');
    expect(host.textContent).toContain('Yakalama zamanı:');
    expect(host.textContent).not.toMatch(/39\.92|32\.85|latitude|longitude/);
    expect(host.textContent).not.toMatch(/farklı|eşleş|MATCH|DIFFERENT|distance/i);
  });

  // 20m
  it('exposes the unavailable SUBMIT reason through the shared timeline', async () => {
    jobsApi.listActivity.mockResolvedValue({
      items: [{
        id: 'act-submit', jobCardId: 'job-1', eventType: 'JOB_SUBMITTED_FOR_APPROVAL',
        actor: { id: 'staff-1', name: 'Ayşe Personel' },
        details: {
          kind: 'STATUS_TRANSITION', fromStatus: 'IN_PROGRESS', toStatus: 'WAITING_APPROVAL',
          reason: null,
          submitLocation: { outcome: 'UNAVAILABLE', reason: 'TIMEOUT' },
        },
        createdAt: '2026-08-07T11:37:02.000Z',
      }],
      total: 1, limit: 50, offset: 0,
    });
    await render();
    expect(host.textContent)
      .toContain('Onaya gönderme konumu alınamadı: Konum isteği zaman aşımına uğradı');
  });

  function submissionVersions(...seqs: number[]): WeeklyReportSubmission[] {
    return seqs.map((seqNo) => makeSubmission({ seqNo }));
  }

  /** A stand-in blob: only identity/type/size matter to the component. */
  function pdfBlob(): Blob {
    return { type: 'application/pdf', size: 8 } as unknown as Blob;
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((next) => { resolve = next; });
    return { promise, resolve };
  }

  /** Drive the version `<select>` the same way a real change event would. */
  function selectVersion(seq: number) {
    const select = host.querySelector('#weekly-history-select') as HTMLSelectElement | null;
    expect(select, '#weekly-history-select').not.toBeNull();
    const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    descriptor?.set?.call(select, String(seq));
    act(() => { select!.dispatchEvent(new Event('change', { bubbles: true })); });
  }

  function alertText(): string {
    return host.querySelector('[role="alert"]')?.textContent ?? '';
  }

  // 21
  it('offers the PDF action only for a report that has a submission', async () => {
    weeklyApi.listWeeklyReportSubmissions.mockResolvedValue([]);
    await render(managerUser);
    expect(sectionText('weekly-history-title')).toContain('Henüz gönderim yok.');
    expect(hasButton('PDF indir')).toBe(false);

    // Remount so the load effect runs again with submissions present.
    await act(async () => root.unmount());
    root = createRoot(host);
    weeklyApi.listWeeklyReportSubmissions.mockResolvedValue(submissionVersions(1));
    await render(managerUser);
    expect(sectionText('weekly-history-title')).toContain('PDF indir');
  });

  // 22
  it('downloads the newest version by default', async () => {
    weeklyApi.listWeeklyReportSubmissions.mockResolvedValue(submissionVersions(1, 2));
    weeklyApi.downloadWeeklyReportSubmissionPdf.mockResolvedValue({
      blob: pdfBlob(), fileName: 'haftalik-rapor-2026-08-03-seq-2.pdf',
    });
    await render(managerUser);

    click(buttonByText('PDF indir'));
    await flush();

    expect(weeklyApi.downloadWeeklyReportSubmissionPdf).toHaveBeenCalledWith('job-1', 2);
    expect(downloads.saveBlobAs).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'application/pdf' }), 'haftalik-rapor-2026-08-03-seq-2.pdf',
    );
  });

  // 23
  it('downloads exactly the immutable version chosen in the history', async () => {
    weeklyApi.listWeeklyReportSubmissions.mockResolvedValue(submissionVersions(1, 2, 3));
    weeklyApi.downloadWeeklyReportSubmissionPdf.mockResolvedValue({
      blob: pdfBlob(), fileName: 'haftalik-rapor-2026-08-03-seq-1.pdf',
    });
    await render(managerUser);

    selectVersion(1);
    click(buttonByText('PDF indir'));
    await flush();

    expect(weeklyApi.downloadWeeklyReportSubmissionPdf).toHaveBeenCalledWith('job-1', 1);
  });

  // 24
  it('locks and relabels the action while the PDF is being prepared', async () => {
    weeklyApi.listWeeklyReportSubmissions.mockResolvedValue(submissionVersions(1));
    const pending = deferred<{ blob: Blob; fileName: string }>();
    weeklyApi.downloadWeeklyReportSubmissionPdf.mockReturnValue(pending.promise);
    await render(managerUser);

    click(buttonByText('PDF indir'));
    await flush();
    expect(buttonByText('PDF hazırlanıyor…').disabled).toBe(true);

    await act(async () => { pending.resolve({ blob: pdfBlob(), fileName: 'x.pdf' }); await flush(); });
    expect(buttonByText('PDF indir').disabled).toBe(false);
  });

  // 25
  it('shows an alert and re-enables the action when the download fails', async () => {
    weeklyApi.listWeeklyReportSubmissions.mockResolvedValue(submissionVersions(1));
    weeklyApi.downloadWeeklyReportSubmissionPdf.mockRejectedValue(new Error('PDF üretilemedi.'));
    await render(managerUser);

    click(buttonByText('PDF indir'));
    await flush();

    expect(alertText()).toContain('PDF üretilemedi.');
    expect(downloads.saveBlobAs).not.toHaveBeenCalled();
    expect(buttonByText('PDF indir').disabled).toBe(false);
  });

  // 26
  it('never starts a second download while one is already running', async () => {
    weeklyApi.listWeeklyReportSubmissions.mockResolvedValue(submissionVersions(1));
    const pending = deferred<{ blob: Blob; fileName: string }>();
    weeklyApi.downloadWeeklyReportSubmissionPdf.mockReturnValue(pending.promise);
    await render(managerUser);

    click(buttonByText('PDF indir'));
    await flush();
    const busy = buttonByText('PDF hazırlanıyor…');
    expect(busy.disabled).toBe(true);

    act(() => { busy.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(weeklyApi.downloadWeeklyReportSubmissionPdf).toHaveBeenCalledTimes(1);

    await act(async () => { pending.resolve({ blob: pdfBlob(), fileName: 'x.pdf' }); await flush(); });
  });

  // 27
  it('forwards the server blob and filename verbatim to the download trigger', async () => {
    const payload = { blob: pdfBlob(), fileName: 'haftalik-rapor-2026-08-03-seq-1.pdf' };
    weeklyApi.listWeeklyReportSubmissions.mockResolvedValue(submissionVersions(1));
    weeklyApi.downloadWeeklyReportSubmissionPdf.mockResolvedValue(payload);
    await render(managerUser);

    click(buttonByText('PDF indir'));
    await flush();

    expect(downloads.saveBlobAs).toHaveBeenCalledTimes(1);
    expect(downloads.saveBlobAs).toHaveBeenCalledWith(payload.blob, payload.fileName);
  });

  // --- JobCard detail information architecture -------------------------------
  //
  // The weekly report is a JobCard content type, not a standalone form screen.
  // These tests pin the composition: the shared lifecycle shell, the two-column
  // main/work-rail split, the timeline slot, and the rule that the editable
  // form is never the page's primary content when the viewer cannot edit it.

  /** Direct children of <main>, in DOM order — the page skeleton. */
  function skeleton(): string[] {
    const main = host.querySelector('main.job-detail');
    expect(main, 'main.job-detail').not.toBeNull();
    return Array.from(main!.children).map((element) => element.getAttribute('data-job-detail-section')
      ?? (element.classList.contains('job-detail-content') ? 'content'
        : element.classList.contains('job-detail-timeline') ? 'timeline' : 'other'));
  }

  function rail(): HTMLElement {
    const found = host.querySelector('.job-detail-work-rail');
    expect(found, '.job-detail-work-rail').not.toBeNull();
    return found as HTMLElement;
  }

  function mainColumn(): HTMLElement {
    const found = host.querySelector('.job-detail-main');
    expect(found, '.job-detail-main').not.toBeNull();
    return found as HTMLElement;
  }

  // 28
  it('renders the shared JobCard lifecycle shell in the JobDetail order', async () => {
    await render();
    expect(skeleton()).toEqual(['heading', 'lifecycle', 'responsibility', 'content', 'timeline']);
    expect(host.querySelector('.job-detail-content')!.className).toContain('job-detail-content--rail');
    expect(host.querySelector('.detail-heading-meta')).not.toBeNull();
    // The dead identity markup is gone: the facts live in the shared
    // RecordDescriptions block inside the main column.
    expect(host.querySelector('.job-identity')).toBeNull();
    expect(host.querySelector('.identity-grid')).toBeNull();
    expect(mainColumn().querySelector('[data-job-detail-block="record-facts"]')).not.toBeNull();
  });

  // 29
  it('drives the phase strip from the shared workflow presentation model', async () => {
    jobsApi.getJobCard.mockResolvedValue(makeJob({
      workflowContext: {
        ...baseWorkflowContext,
        allowedCommands: ['SUBMIT_FOR_APPROVAL', 'CANCEL'],
        allowedActions: ['EDIT_JOB_FIELDS', 'VIEW_NOTES', 'ADD_NOTE'],
        startLocationCaptureEnabled: false,
        lifecycle: {
          ...baseWorkflowContext.lifecycle,
          acceptedAt: '2026-08-03T08:30:00.000Z',
          startedAt: '2026-08-03T09:00:00.000Z',
        },
        submissionReadiness: null,
      },
    }));
    await render();
    const lifecycle = host.querySelector('[data-job-detail-section="lifecycle"]');
    expect(lifecycle).not.toBeNull();
    expect(lifecycle!.querySelector('.servora-workflow-steps')).not.toBeNull();

    // The screen-reader list is the deterministic projection of phaseItems.
    const list = lifecycle!.querySelector('ol[aria-label="İş süreci"]');
    expect(list).not.toBeNull();
    const items = Array.from(list!.querySelectorAll('li'));
    expect(items.map((item) => item.textContent?.split(':')[0])).toEqual([
      'Atandı', 'Kabul edildi', 'Uygulanıyor', 'Yönetici kontrolü', 'Tamamlandı',
    ]);
    // IN_PROGRESS → EXECUTION is the current phase, and only that one.
    expect(items[2]!.getAttribute('aria-current')).toBe('step');
    expect(items.filter((item) => item.getAttribute('aria-current') === 'step')).toHaveLength(1);
    expect(items[0]!.textContent).toContain('Tamamlandı');
    expect(items[4]!.textContent).toContain('Sırada');

    // No weekly-report-specific lifecycle vocabulary is introduced.
    expect(lifecycle!.textContent).not.toContain('Hazırlanıyor');
  });

  // 29b
  it('lets the shared model — not the screen — decide a phase label', async () => {
    // makeJob()'s default lifecycle has startedAt set but acceptedAt null, so
    // the model reports the acceptance gap. A hardcoded weekly strip would
    // still say "Kabul edildi".
    await render();
    const items = Array.from(host.querySelectorAll(
      '[data-job-detail-section="lifecycle"] ol[aria-label="İş süreci"] li',
    ));
    expect(items[1]!.textContent).toContain('Kabul bilgisi kaydedilmemiş');
    expect(items[1]!.textContent).toContain('Atlandı');
  });

  // 30
  it('keeps the editable report in the main column and the actions in the rail', async () => {
    await render();
    const main = mainColumn();
    expect(main.querySelector('textarea#weekly-summary')).not.toBeNull();
    expect(main.querySelector('#weekly-content-heading')?.textContent).toBe('Rapor içeriği');
    expect(main.querySelector('#weekly-questions-heading')?.textContent).toBe('Yönetici soruları');
    expect(main.querySelector('[data-job-detail-block="weekly-activity"]')).not.toBeNull();
    expect(main.querySelector('[data-job-detail-block="weekly-report-editor"]')).not.toBeNull();
    // The editable form is never duplicated into the rail.
    expect(rail().querySelector('form')).toBeNull();

    const decision = rail().querySelector('[data-job-decision-panel]');
    expect(decision).not.toBeNull();
    expect(decision!.textContent).toContain('Kontrole gönder');
    expect(rail().querySelector('.job-detail-rail-heading')?.textContent).toBe('İşlemler');

    const timeline = host.querySelector('.job-detail-timeline');
    expect(timeline).not.toBeNull();
    expect(timeline!.querySelector('#weekly-history-title')).not.toBeNull();
  });

  // 31
  it('makes the NEW state about accepting the job, not about a disabled form', async () => {
    jobsApi.getJobCard.mockResolvedValue(makeJob({
      status: 'NEW',
      workflowContext: {
        ...baseWorkflowContext,
        allowedCommands: ['ACCEPT_ASSIGNMENT', 'CANCEL'],
        allowedActions: ['VIEW_NOTES'],
        startLocationCaptureEnabled: false,
        lifecycle: { ...baseWorkflowContext.lifecycle, startedAt: null },
        submissionReadiness: null,
      },
    }));
    weeklyApi.getWeeklyReport.mockResolvedValue(makeDetail({ jobStatus: 'NEW' }));
    await render();

    // Lifecycle + responsibility are present...
    expect(host.querySelector('[data-job-detail-section="lifecycle"] .servora-workflow-steps')).not.toBeNull();
    expect(host.querySelector('[data-job-workflow-panel="responsibility"]')).not.toBeNull();
    // ...and the primary action is in the rail, not below a wall of inputs.
    expect(rail().querySelector('button')?.textContent).toBe('İşi kabul et');

    // The six disabled textareas are gone.
    expect(host.querySelectorAll('textarea').length).toBe(0);
    expect(host.querySelectorAll('form').length).toBe(0);
    expect(mainColumn().querySelector('[data-job-detail-block="weekly-report-editor"]')).toBeNull();
    expect(mainColumn().querySelector('.weekly-report-locked-notice')?.textContent)
      .toContain('Raporu hazırlamaya başlamak için önce atanan işi kabul edin.');
  });

  // 32
  it('keeps the ACCEPTED contract: start action plus a usable owner editor', async () => {
    jobsApi.getJobCard.mockResolvedValue(makeJob({
      status: 'ACCEPTED',
      workflowContext: {
        ...baseWorkflowContext,
        allowedCommands: ['START', 'CANCEL'],
        allowedActions: ['EDIT_JOB_FIELDS', 'VIEW_NOTES', 'ADD_NOTE'],
        startLocationCaptureEnabled: false,
        lifecycle: {
          ...baseWorkflowContext.lifecycle,
          acceptedAt: '2026-08-03T08:00:00.000Z',
          startedAt: null,
        },
        submissionReadiness: null,
      },
    }));
    weeklyApi.getWeeklyReport.mockResolvedValue(makeDetail({ jobStatus: 'ACCEPTED' }));
    await render();

    expect(rail().querySelector('button')?.textContent).toBe('İşi başlat');
    expect(summaryField()).not.toBeNull();
    expect(summaryField().disabled).toBe(false);
    expect(hasButton('Taslağı kaydet')).toBe(true);
    expect(host.querySelector('.weekly-report-locked-notice')).toBeNull();
  });

  // 33
  it('shows the revision context and the resume action instead of the editor', async () => {
    jobsApi.getJobCard.mockResolvedValue(makeJob({
      status: 'REVISION_REQUESTED',
      workflowContext: {
        ...baseWorkflowContext,
        allowedCommands: ['RESUME', 'CANCEL'],
        allowedActions: ['VIEW_NOTES'],
        startLocationCaptureEnabled: false,
        lifecycle: {
          ...baseWorkflowContext.lifecycle,
          startedAt: '2026-08-03T09:00:00.000Z',
          submittedAt: '2026-08-05T10:00:00.000Z',
          revisionRequestedAt: '2026-08-06T10:00:00.000Z',
          revisionReason: 'Özet yetersiz.',
        },
        submissionReadiness: null,
      },
    }));
    weeklyApi.getWeeklyReport.mockResolvedValue(makeDetail({ jobStatus: 'REVISION_REQUESTED' }));
    await render();

    expect(host.querySelector('[data-job-detail-section="revision"]')).not.toBeNull();
    expect(host.textContent).toContain('Özet yetersiz.');
    expect(rail().querySelector('button')?.textContent).toBe('Düzeltmeye başla');
    expect(host.querySelectorAll('textarea#weekly-summary').length).toBe(0);
    expect(host.querySelector('.weekly-report-locked-notice')?.textContent)
      .toContain('Düzeltmeye başladıktan sonra raporu yeniden düzenleyebilirsiniz.');
  });

  // 34
  it('gives the manager the review panel and the frozen report in the JobCard slots', async () => {
    jobsApi.getJobCard.mockResolvedValue(makeJob({
      status: 'WAITING_APPROVAL',
      workflowContext: {
        ...baseWorkflowContext,
        allowedCommands: ['APPROVE', 'REQUEST_REVISION', 'WITHDRAW_FROM_APPROVAL', 'CANCEL'],
        allowedActions: ['VIEW_NOTES', 'ADD_NOTE'],
        startLocationCaptureEnabled: false,
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
    }));
    weeklyApi.listWeeklyReportSubmissions.mockResolvedValue([makeSubmission({ seqNo: 2 })]);
    await render(managerUser);

    expect(rail().querySelector('[data-job-detail-section="management-review"]')).not.toBeNull();
    expect(rail().textContent).toContain('Kontrolü tamamla ve işi kapat');
    expect(rail().textContent).toContain('Düzeltme için personele geri gönder');
    // Destructive stays a destructive control, never the primary button.
    expect(rail().querySelector('.primary-button')?.textContent).toBe('Kontrolü tamamla ve işi kapat');

    expect(mainColumn().querySelector('[data-job-detail-block="weekly-frozen-report"]')).not.toBeNull();
    expect(mainColumn().querySelector('[data-job-detail-block="weekly-report-editor"]')).toBeNull();
    expect(host.querySelectorAll('textarea').length).toBe(0);
  });

  // 35
  it('uses the terminal slot and never offers an editor for a COMPLETED job', async () => {
    jobsApi.getJobCard.mockResolvedValue(makeJob({
      status: 'COMPLETED',
      workflowContext: {
        ...baseWorkflowContext,
        allowedCommands: [],
        allowedActions: ['VIEW_NOTES'],
        startLocationCaptureEnabled: false,
        lifecycle: {
          ...baseWorkflowContext.lifecycle,
          startedAt: '2026-08-03T09:00:00.000Z',
          submittedAt: '2026-08-07T12:00:00.000Z',
          approvedAt: '2026-08-08T09:00:00.000Z',
        },
        submissionReadiness: null,
      },
    }));
    weeklyApi.getWeeklyReport.mockResolvedValue(makeDetail({ jobStatus: 'COMPLETED', version: 6 }));
    weeklyApi.listWeeklyReportSubmissions.mockResolvedValue([makeSubmission({ seqNo: 3 })]);
    await render(managerUser);

    expect(host.querySelector('[data-job-detail-section="terminal"]')).not.toBeNull();
    expect(host.querySelector('[data-terminal-state="COMPLETED"]')).not.toBeNull();
    expect(host.querySelector('[data-job-detail-section="responsibility"]')).toBeNull();
    expect(host.querySelectorAll('textarea').length).toBe(0);
    expect(host.querySelector('[data-job-detail-rail="true"]')).toBeNull();
    expect(mainColumn().querySelector('[data-job-detail-block="weekly-frozen-report"]')).not.toBeNull();
  });

  // 36
  it('shows only the terminal presentation for a CANCELLED job', async () => {
    jobsApi.getJobCard.mockResolvedValue(makeJob({
      status: 'CANCELLED',
      workflowContext: {
        ...baseWorkflowContext,
        allowedCommands: [],
        allowedActions: ['VIEW_NOTES'],
        startLocationCaptureEnabled: false,
        lifecycle: {
          ...baseWorkflowContext.lifecycle,
          cancelledAt: '2026-08-06T10:00:00.000Z',
          cancelledFromStatus: 'IN_PROGRESS',
          cancelReason: 'Müşteri iptal etti.',
        },
        submissionReadiness: null,
      },
    }));
    weeklyApi.getWeeklyReport.mockResolvedValue(makeDetail({ jobStatus: 'CANCELLED' }));
    await render();

    expect(host.querySelector('[data-terminal-state="CANCELLED"]')).not.toBeNull();
    expect(host.querySelector('[data-job-detail-section="responsibility"]')).toBeNull();
    expect(host.querySelector('[data-job-detail-rail="true"]')).toBeNull();
    expect(host.querySelectorAll('textarea').length).toBe(0);
    expect(host.querySelector('.weekly-report-locked-notice')?.textContent)
      .toContain('İş iptal edildi; rapor düzenlenemez.');
  });

  // 37
  it('renders the canonical job type label and a readable instant for live source work', async () => {
    const completedAt = '2026-08-05T09:00:00.000Z';
    weeklyApi.getWeeklyReport.mockResolvedValue(makeDetail({
      liveSourceWork: [{
        jobCardId: 'job-9', type: 'GENERAL_TASK', title: 'Klinik ziyareti',
        customerName: 'Dünya Dental', staffCompletedAt: completedAt,
        statusAtSnapshot: 'COMPLETED',
      }],
    }));
    await render();

    const row = host.querySelector('.weekly-activity-row') as HTMLElement;
    expect(row).not.toBeNull();

    // The shared SSOT label, never the raw enum; the customer suffix is kept.
    expect(normalize(row.querySelector('.weekly-activity-row-meta')?.textContent))
      .toBe('Genel görev · Dünya Dental');
    expect(row.textContent).not.toContain('GENERAL_TASK');

    // The instant is presented for humans while the element keeps the canonical
    // machine-readable server instant.
    const time = row.querySelector('time.weekly-activity-row-time') as HTMLTimeElement;
    expect(time.getAttribute('dateTime')).toBe(completedAt);
    expect(normalize(time.textContent)).toBe(trInstant(completedAt));
    expect(normalize(time.textContent)).toMatch(/^\d{1,2} \S+ \d{4} \d{2}:\d{2}$/u);
    expect(row.textContent).not.toContain(completedAt);
  });

  // 38
  it('presents frozen source work and submission instants without raw ISO anywhere', async () => {
    const completedAt = '2026-08-05T09:00:00.000Z';
    const submittedAt = '2026-08-07T12:00:00.000Z';
    jobsApi.getJobCard.mockResolvedValue(makeJob({
      status: 'COMPLETED',
      workflowContext: {
        ...baseWorkflowContext,
        allowedCommands: [],
        allowedActions: ['VIEW_NOTES'],
        startLocationCaptureEnabled: false,
        lifecycle: {
          ...baseWorkflowContext.lifecycle,
          startedAt: '2026-08-03T09:00:00.000Z',
          submittedAt,
          approvedAt: '2026-08-08T09:00:00.000Z',
        },
        submissionReadiness: null,
      },
    }));
    weeklyApi.getWeeklyReport.mockResolvedValue(makeDetail({ jobStatus: 'COMPLETED', version: 6 }));
    weeklyApi.listWeeklyReportSubmissions.mockResolvedValue([makeSubmission({ seqNo: 3 })]);
    await render(managerUser);

    const block = mainColumn()
      .querySelector('[data-job-detail-block="weekly-activity"]') as HTMLElement;
    expect(block.textContent).toContain('Gönderimde dondurulan çalışma listesi');
    expect(block.textContent).toContain('Genel görev');
    expect(block.textContent).not.toContain('GENERAL_TASK');
    expect(block.textContent).not.toContain(completedAt);

    // The frozen caption, the version selector and the history facts each show
    // the presented instant instead of the raw server string.
    expect(normalize(host.textContent)).toContain(trInstant(submittedAt));
    expect(host.textContent).not.toContain(submittedAt);
  });

  // 39
  it('degrades an unrecognised source work type to a neutral label without crashing', async () => {
    weeklyApi.getWeeklyReport.mockResolvedValue(makeDetail({
      liveSourceWork: [{
        jobCardId: 'job-9', type: 'LEGACY_TASK_TYPE', title: 'Eski kayıt',
        customerName: null, staffCompletedAt: '2026-08-05T09:00:00.000Z',
        statusAtSnapshot: 'COMPLETED',
      }],
    }));
    await render();

    const row = host.querySelector('.weekly-activity-row') as HTMLElement;
    expect(row).not.toBeNull();
    expect(normalize(row.querySelector('.weekly-activity-row-meta')?.textContent)).toBe('Diğer');
    expect(row.textContent).not.toContain('LEGACY_TASK_TYPE');
  });

  // 40
  it('resolves every known job type through the shared label map', async () => {
    weeklyApi.getWeeklyReport.mockResolvedValue(makeDetail({
      liveSourceWork: [
        {
          jobCardId: 'job-1', type: 'PRODUCT_DELIVERY', title: 'Membran teslimi',
          customerName: null, staffCompletedAt: '2026-08-05T09:00:00.000Z',
          statusAtSnapshot: 'COMPLETED',
        },
        {
          jobCardId: 'job-2', type: 'SALES_MEETING', title: 'Klinik görüşmesi',
          customerName: null, staffCompletedAt: '2026-08-06T09:00:00.000Z',
          statusAtSnapshot: 'COMPLETED',
        },
      ],
    }));
    await render();

    const labels = Array.from(host.querySelectorAll('.weekly-activity-row-meta'))
      .map((element) => normalize(element.textContent));
    expect(labels).toEqual(['Ürün teslimi', 'Satış görüşmesi']);
    expect(host.textContent).not.toContain('PRODUCT_DELIVERY');
    expect(host.textContent).not.toContain('SALES_MEETING');
  });
});
