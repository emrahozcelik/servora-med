/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JobDetailPanel } from '../src/JobDetail';
import type { CurrentUser } from '../src/services/api';
import type { CustomerScheduleEvaluation, JobCard } from '../src/jobs/jobs-api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const preview = vi.hoisted(() => ({
  evaluation: null as CustomerScheduleEvaluation | null,
}));

vi.mock('../src/jobs/useCustomerSchedulePreview', () => ({
  useCustomerSchedulePreview: () => ({ evaluation: preview.evaluation, previewing: false }),
}));

const user: CurrentUser = {
  id: 'staff-1', organizationId: 'org-1', name: 'Ayşe', email: 'a@test.local',
  role: 'STAFF', mustChangePassword: false, isActive: true, version: 1,
  capabilities: { overviewDashboard: true, calendar: true, messaging: true },
  support: { displayLabel: 'Destek', email: null, helpUrl: null },
};
const job: JobCard = {
  id: 'job-1', organizationId: 'org-1', type: 'SALES_MEETING', status: 'NEW', version: 1,
  engagementKind: 'SALES_MEETING', title: 'Klinik görüşmesi', description: null,
  customerId: 'customer-1', contactId: null, assignedTo: user.id, createdBy: user.id,
  priority: 'normal', dueDate: null,
  scheduledAt: '2026-08-16T10:00:00.000Z', scheduledEndsAt: '2026-08-16T11:00:00.000Z',
  assignee: { id: user.id, name: user.name }, customer: { id: 'customer-1', name: 'Klinik' },
  contact: null, followUpContext: null, followUpProposal: null,
  workflowContext: {
    allowedCommands: [],
    allowedActions: ['EDIT_JOB_FIELDS'],
    startLocationCaptureEnabled: false,
    lifecycle: {
      createdAt: '2026-08-15T08:00:00.000Z', acceptedAt: null, acceptedBy: null,
      startedAt: null, submittedAt: null, submittedBy: null, submissionNote: null,
      approvedAt: null, approvedBy: null, approvalNote: null,
      revisionRequestedAt: null, revisionRequestedBy: null, revisionReason: null,
      cancelledAt: null, cancelledBy: null, cancelReason: null, cancelledFromStatus: null,
    },
    submissionReadiness: null,
  },
};

describe('JobDetail joint slot edit', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    preview.evaluation = null;
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
      matches: false, media: '', onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
      slots: [{ startsAt: '2026-08-17T10:00:00.000Z', endsAt: '2026-08-17T11:00:00.000Z' }],
    })));
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shows interval end and moves start/end together for a selected joint slot', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    await act(async () => root.render(<JobDetailPanel
      job={job}
      items={[]}
      user={user}
      pending={false}
      message=""
      onBack={() => {}}
      onCommand={() => {}}
      onSaveSchedule={onSave}
    />));
    expect(container.querySelector('#job-scheduled-ends-at')).not.toBeNull();
    await act(async () => { vi.advanceTimersByTime(300); });
    await act(async () => { await Promise.resolve(); });
    const button = container.querySelector('button[data-available-slot]') as HTMLButtonElement;
    expect(button).toBeTruthy();
    await act(async () => button.click());
    expect((container.querySelector('#job-scheduled-at') as HTMLInputElement).value).toBe('2026-08-17T13:00');
    expect((container.querySelector('#job-scheduled-ends-at') as HTMLInputElement).value).toBe('2026-08-17T14:00');
    await act(async () => (container.querySelector('.job-schedule-edit form') as HTMLFormElement).requestSubmit());
    expect(onSave).toHaveBeenCalledWith(
      '2026-08-17T10:00:00.000Z',
      '2026-08-17T11:00:00.000Z',
      null,
    );
  });

  it('moves the interval end with the existing customer alternative CTA', async () => {
    preview.evaluation = {
      level: 'CONFLICT',
      safeMessage: 'Aynı müşteriye aynı gün başka bir iş planlandı.',
      conflicts: [],
      recentVisit: null,
      suggestedAlternativeAt: '2026-08-17T10:00:00.000Z',
      frequencyCount: 0,
    };
    await act(async () => root.render(<JobDetailPanel
      job={job}
      items={[]}
      user={user}
      pending={false}
      message=""
      onBack={() => {}}
      onCommand={() => {}}
      onSaveSchedule={() => {}}
    />));

    const button = Array.from(container.querySelectorAll('button'))
      .find((candidate) => candidate.textContent?.includes('Müşteri için önerilen alternatif zamanı kullan'));
    expect(button).toBeTruthy();
    await act(async () => (button as HTMLButtonElement).click());
    expect((container.querySelector('#job-scheduled-at') as HTMLInputElement).value).toBe('2026-08-17T13:00');
    expect((container.querySelector('#job-scheduled-ends-at') as HTMLInputElement).value).toBe('2026-08-17T14:00');
  });
});
