/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JobDetailPanel } from '../src/JobDetail';
import type { CurrentUser } from '../src/services/api';
import type { CustomerScheduleEvaluation, JobCard } from '../src/jobs/jobs-api';
import { isoInstantToLocalDateTime } from '../src/jobs/scheduling';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const preview = vi.hoisted(() => ({
  evaluation: null as CustomerScheduleEvaluation | null,
  lastEnabled: undefined as boolean | undefined,
}));

vi.mock('../src/jobs/useCustomerSchedulePreview', () => ({
  useCustomerSchedulePreview: (inputs: { enabled: boolean }) => {
    preview.lastEnabled = inputs.enabled;
    return { evaluation: preview.evaluation, previewing: false };
  },
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
  hasOpenOverdueIncident: false, correctionDueAt: null,
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

  it('keeps the existing interval duration server-owned when a joint slot is selected', async () => {
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
    expect(container.querySelector('#job-scheduled-ends-at')).toBeNull();
    await act(async () => { vi.advanceTimersByTime(300); });
    await act(async () => { await Promise.resolve(); });
    const button = container.querySelector('button[data-available-slot]') as HTMLButtonElement;
    expect(button).toBeTruthy();
    await act(async () => button.click());
    expect((container.querySelector('#job-scheduled-at') as HTMLInputElement).value)
      .toBe(isoInstantToLocalDateTime('2026-08-17T10:00:00.000Z'));
    expect(container.querySelector('#job-scheduled-ends-at')).toBeNull();
    await act(async () => (container.querySelector('.job-schedule-edit form') as HTMLFormElement).requestSubmit());
    expect(onSave).toHaveBeenCalledWith(
      '2026-08-17T10:00:00.000Z',
      undefined,
      undefined,
    );
  });

  it('never blocks the Staff edit on an advisory evaluation', async () => {
    // Frequency insight is management-only: even a WARNING advisory renders
    // no blocking notice for Staff and the save still reaches onSave.
    preview.evaluation = {
      level: 'WARNING',
      safeMessage: 'Bu plan dahil, müşteriyle 14 günlük yakın dönem içinde 4 saha teması planlandı veya gerçekleştirildi.',
      conflicts: [],
      recentVisit: null,
      suggestedAlternativeAt: null,
      frequencyCount: 4,
    };
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

    expect(container.querySelector('.customer-schedule-notice')).toBeNull();
    expect(container.querySelector('.customer-schedule-notice button')).toBeNull();
    await act(async () => (container.querySelector('.job-schedule-edit form') as HTMLFormElement).requestSubmit());
    expect(onSave).toHaveBeenCalledWith(
      '2026-08-16T10:00:00.000Z',
      undefined,
      undefined,
    );
  });

  it('locks slot selection and the save button for Staff on a lateness-open job', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const locked = { ...job, hasOpenOverdueIncident: true };
    await act(async () => root.render(<JobDetailPanel
      job={locked}
      items={[]}
      user={user}
      pending={false}
      message=""
      onBack={() => {}}
      onCommand={() => {}}
      onSaveSchedule={onSave}
    />));

    const input = container.querySelector('#job-scheduled-at') as HTMLInputElement;
    expect(input.disabled).toBe(true);
    const before = input.value;

    await act(async () => { vi.advanceTimersByTime(300); });
    await act(async () => { await Promise.resolve(); });
    const slot = container.querySelector('button[data-available-slot]') as HTMLButtonElement;
    expect(slot).toBeTruthy();
    expect(slot.disabled).toBe(true);
    await act(async () => slot.click());
    expect((container.querySelector('#job-scheduled-at') as HTMLInputElement).value).toBe(before);

    const save = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Planlanan zamanı kaydet') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('previews the customer schedule for Staff and Manager, but not for a locked Staff time', async () => {
    // Staff get the server's role-projected evaluation while they may edit.
    await act(async () => root.render(<JobDetailPanel
      job={job}
      items={[]}
      user={user}
      pending={false}
      message=""
      onCommand={() => {}}
      onSaveSchedule={vi.fn()}
    />));
    expect(preview.lastEnabled).toBe(true);

    // JOB-010: a Staff-locked customer time has nothing to preview.
    await act(async () => root.render(<JobDetailPanel
      job={{ ...job, status: 'ACCEPTED', assignmentOffer: { state: 'ACCEPTED' } as unknown as JobCard['assignmentOffer'] }}
      items={[]}
      user={user}
      pending={false}
      message=""
      onCommand={() => {}}
      onSaveSchedule={vi.fn()}
    />));
    expect(preview.lastEnabled).toBe(false);

    await act(async () => root.render(<JobDetailPanel
      job={job}
      items={[]}
      user={{ ...user, role: 'MANAGER' }}
      pending={false}
      message=""
      onCommand={() => {}}
      onSaveSchedule={vi.fn()}
    />));
    expect(preview.lastEnabled).toBe(true);
  });

  it('locks Staff schedule edit when assignmentOffer is present in NEW/ACCEPTED and offers change request shortcut', async () => {
    const onRequestChange = vi.fn();
    const offeredJob: JobCard = {
      ...job,
      status: 'ACCEPTED',
      hasOpenOverdueIncident: true,
      workflowContext: {
        ...job.workflowContext,
        allowedActions: ['EDIT_JOB_FIELDS', 'REQUEST_CHANGE'],
      },
      assignmentOffer: {
        id: 'offer-1',
        state: 'ACCEPTED',
        openedAt: '2026-08-15T09:00:00.000Z',
        acceptanceDueAt: '2026-08-15T10:00:00.000Z',
        urgentReason: null,
        assignee: { id: user.id, name: user.name },
      },
    };
    await act(async () => root.render(<JobDetailPanel
      job={offeredJob}
      items={[]}
      user={user}
      pending={false}
      message=""
      onCommand={() => {}}
      onSaveSchedule={vi.fn()}
      onRequestChange={onRequestChange}
    />));
    await act(async () => { vi.advanceTimersByTime(300); });
    await act(async () => { await Promise.resolve(); });

    const input = container.querySelector('#job-scheduled-at') as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(container.textContent).toContain(
      'Müşteri zamanı yalnızca yönetici tarafından değiştirilebilir. Plan değişikliği için yöneticiye öneri gönderin.',
    );
    expect(container.textContent).not.toContain('Gecikmesi açık işin tarihini yalnızca yönetim değiştirebilir.');
    const slot = container.querySelector('button[data-available-slot]') as HTMLButtonElement;
    expect(slot.disabled).toBe(true);
    const save = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Planlanan zamanı kaydet') as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    const requestBtn = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Değişiklik önerisi gönder') as HTMLButtonElement;
    expect(requestBtn).toBeTruthy();
    await act(async () => requestBtn.click());
    expect(onRequestChange).toHaveBeenCalledTimes(1);
  });

  it('keeps Staff self-created job (assignmentOffer == null) editable', async () => {
    const selfCreated: JobCard = {
      ...job,
      status: 'ACCEPTED',
      assignmentOffer: null,
    };
    await act(async () => root.render(<JobDetailPanel
      job={selfCreated}
      items={[]}
      user={user}
      pending={false}
      message=""
      onCommand={() => {}}
      onSaveSchedule={vi.fn()}
    />));
    expect((container.querySelector('#job-scheduled-at') as HTMLInputElement).disabled).toBe(false);
    expect(container.textContent).not.toContain('Müşteri zamanı yalnızca yönetici tarafından değiştirilebilir.');
  });
});
