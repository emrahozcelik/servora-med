/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WeeklyReportDetail } from '../src/jobs/WeeklyReportDetail';
import type { CurrentUser } from '../src/services/api';
import type { JobCard } from '../src/jobs/jobs-api';
import type { WeeklyReportDetail as WeeklyReportDetailDto } from '../src/jobs/weekly-report-api';
import { defaultCorrectionDueLocalValue, localDateTimeToIso } from '../src/jobs/scheduling';
import { workflowContext as baseWorkflowContext } from './fixtures/job-workflow';
import { stubMatchMedia } from './helpers/match-media';

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
  getWeeklyReportRemovalPreview: vi.fn(),
  removeWeeklyReport: vi.fn(),
}));

vi.mock('../src/jobs/jobs-api', async (original) => ({
  ...await original<typeof import('../src/jobs/jobs-api')>(), ...jobsApi,
}));
vi.mock('../src/jobs/weekly-report-api', async (original) => ({
  ...await original<typeof import('../src/jobs/weekly-report-api')>(), ...weeklyApi,
}));
vi.mock('../src/realtime/RealtimeProvider', () => ({
  useRealtimeInvalidation: () => {},
}));

const manager: CurrentUser = {
  id: 'manager-1', organizationId: 'org-1', name: 'Murat Yönetici', email: 'm@test.local',
  role: 'MANAGER', mustChangePassword: false, isActive: true, version: 1,
};

const WEEK = { periodStart: '2026-11-16', periodEnd: '2026-11-21' };

function makeJob(overrides: Partial<JobCard> = {}): JobCard {
  return {
    id: 'job-1', organizationId: 'org-1', organizationTimezone: 'Europe/Istanbul',
    type: 'WEEKLY_REPORT', status: 'WAITING_APPROVAL', version: 3,
    title: 'Haftalık Rapor (2026-11-16 – 2026-11-21)', description: null,
    customerId: null, contactId: null, assignedTo: 'staff-1', createdBy: 'manager-1',
    priority: 'normal', dueDate: '2026-11-23', scheduledAt: null, scheduledEndsAt: null,
    engagementKind: null,
    assignee: { id: 'staff-1', name: 'Ayşe Personel' },
    customer: null, contact: null,
    workflowContext: {
      ...baseWorkflowContext,
      allowedCommands: ['APPROVE', 'REQUEST_REVISION', 'CANCEL'],
      allowedActions: ['VIEW_NOTES'],
      lifecycle: {
        ...baseWorkflowContext.lifecycle,
        submittedAt: '2026-11-20T09:00:00.000Z',
        submittedBy: { id: 'staff-1', name: 'Ayşe Personel' },
      },
      submissionReadiness: null,
    },
    followUpContext: null, followUpProposal: null,
    earlyStartAuthorization: null, submitLocationComparison: null,
    changeRequest: null, assignmentOffer: null,
    hasOpenOverdueIncident: false, correctionDueAt: null,
    ...overrides,
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
    questions: [], answers: [],
    version: 2, jobStatus: 'WAITING_APPROVAL', jobVersion: 3,
    dueDate: '2026-11-23', assignedTo: 'staff-1', instructions: null,
    liveSourceWork: [], submissionSummaries: [],
    canRemove: false, removal: null,
    createdAt: '2026-11-16T09:00:00.000Z', updatedAt: '2026-11-16T10:00:00.000Z',
    ...overrides,
  };
}

function buttonByName(host: ParentNode, name: string) {
  return Array.from(host.querySelectorAll('button'))
    .find((button) => button.textContent?.trim() === name) ?? null;
}

describe('OVR-5 weekly report revision correction deadline', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    stubMatchMedia();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    jobsApi.getJobCard.mockResolvedValue(makeJob());
    weeklyApi.getWeeklyReport.mockResolvedValue(makeDetail());
    weeklyApi.listWeeklyReportSubmissions.mockResolvedValue([]);
    jobsApi.listActivity.mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function render() {
    await act(async () => {
      root.render(<WeeklyReportDetail jobCardId="job-1" user={manager} />);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  async function settle() {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  async function openRevisionDialog() {
    const trigger = buttonByName(host, 'Düzeltme için personele geri gönder');
    expect(trigger).not.toBeNull();
    await act(async () => { trigger!.click(); await Promise.resolve(); });
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    return dialog!;
  }

  function typeReason(dialog: HTMLElement, value: string) {
    const textarea = dialog.querySelector<HTMLTextAreaElement>('textarea');
    expect(textarea).not.toBeNull();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
      ?.set?.call(textarea!, value);
    textarea!.dispatchEvent(new Event('input', { bubbles: true }));
  }

  it('prefills the picker, sends correctionDueAt and keeps the 1 h–14 d hint', async () => {
    await render();
    const dialog = await openRevisionDialog();

    const picker = dialog.querySelector<HTMLInputElement>('#revision-correction-due-at');
    expect(picker).not.toBeNull();
    expect(picker!.value).toBe(defaultCorrectionDueLocalValue());
    expect(dialog.textContent).toContain('Düzeltme son tarihi');
    expect(dialog.textContent).toContain('En az 1 saat, en fazla 14 gün sonrası');

    typeReason(dialog, 'Kaynak iş listesini tamamlayın.');
    jobsApi.requestJobCardRevision.mockResolvedValue(makeJob({
      status: 'REVISION_REQUESTED',
      version: 4,
      correctionDueAt: localDateTimeToIso(picker!.value),
    }));
    await act(async () => {
      buttonByName(dialog, 'Düzeltme için geri gönder')!.click();
      await settle();
    });

    expect(jobsApi.requestJobCardRevision).toHaveBeenCalledTimes(1);
    expect(jobsApi.requestJobCardRevision.mock.calls[0]![0]).toBe('job-1');
    expect(jobsApi.requestJobCardRevision.mock.calls[0]![1]).toMatchObject({
      revisionReason: 'Kaynak iş listesini tamamlayın.',
      correctionDueAt: localDateTimeToIso(picker!.value),
      expectedVersion: 3,
    });
  });

  it('shows the effective correction deadline on the weekly report detail', async () => {
    jobsApi.getJobCard.mockResolvedValue(makeJob({
      status: 'REVISION_REQUESTED',
      version: 4,
      correctionDueAt: '2026-11-24T10:00:00.000Z',
    }));
    weeklyApi.getWeeklyReport.mockResolvedValue(makeDetail({
      jobStatus: 'REVISION_REQUESTED', jobVersion: 4,
    }));
    await render();

    expect(host.textContent).toContain('Düzeltme son tarihi');
    expect(host.querySelector('time[datetime="2026-11-24T10:00:00.000Z"]')).not.toBeNull();
  });
});
