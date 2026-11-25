/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JobDetailPanel } from '../src/JobDetail';
import { focusScheduleEditor } from '../src/jobs/AssignmentOffer';
import type { CurrentUser } from '../src/services/api';
import type { AvailableSlot, CustomerScheduleEvaluation, JobCard } from '../src/jobs/jobs-api';
import { isoInstantToLocalDateTime } from '../src/jobs/scheduling';
import { formatWheelDisplay } from '../src/ui/wheel-datetime';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const styles = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf8');

function resizeTo(width: number) {
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: width });
  window.dispatchEvent(new Event('resize'));
}

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

  async function openScheduleEditor(): Promise<void> {
    const change = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Değiştir');
    expect(change).toBeTruthy();
    await act(async () => change!.click());
  }

  async function setInputValue(selector: string, value: string): Promise<void> {
    const field = container.querySelector(selector) as HTMLInputElement;
    expect(field).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    resizeTo(1024);
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
    await openScheduleEditor();
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
    await openScheduleEditor();
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

    await openScheduleEditor();
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
        closedAt: '2026-08-15T09:30:00.000Z',
        closeReason: null,
        closeText: null,
        proposedScheduledAt: null,
        proposedScheduledEndsAt: null,
        proposalAcceptedAt: null,
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

    await openScheduleEditor();
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
    await openScheduleEditor();
    expect((container.querySelector('#job-scheduled-at') as HTMLInputElement).disabled).toBe(false);
    expect(container.textContent).not.toContain('Müşteri zamanı yalnızca yönetici tarafından değiştirilebilir.');
  });

  it('opens the collapsed editor from the new-time guidance and focuses the field', async () => {
    await act(async () => root.render(<JobDetailPanel
      job={job}
      items={[]}
      user={user}
      pending={false}
      message=""
      onCommand={() => {}}
      onSaveSchedule={vi.fn()}
    />));
    expect(container.querySelector('#job-scheduled-at')).toBeNull();

    await act(async () => { focusScheduleEditor(); });
    expect(container.querySelector('#job-scheduled-at')).not.toBeNull();
    expect(document.activeElement?.id).toBe('job-scheduled-at');
  });

  it.each([1024, 390])(
    'moves focus to the enabled change-request action when a locked editor opens at %ipx',
    async (width) => {
      resizeTo(width);
      const onRequestChange = vi.fn();
      const locked: JobCard = {
        ...job,
        hasOpenOverdueIncident: true,
        workflowContext: {
          ...job.workflowContext,
          allowedActions: ['EDIT_JOB_FIELDS', 'REQUEST_CHANGE'],
        },
      };
      await act(async () => root.render(<JobDetailPanel
        job={locked}
        items={[]}
        user={user}
        pending={false}
        message=""
        onCommand={() => {}}
        onSaveSchedule={vi.fn()}
        onRequestChange={onRequestChange}
      />));
      await openScheduleEditor();
      const request = container.querySelector<HTMLButtonElement>('#job-schedule-request-change')!;
      expect(request).not.toBeNull();
      expect(request.disabled).toBe(false);
      expect(document.activeElement).toBe(request);
    },
  );

  it.each([1024, 390])(
    'falls back to the editor heading when a locked editor has no change action at %ipx',
    async (width) => {
      resizeTo(width);
      const locked: JobCard = { ...job, hasOpenOverdueIncident: true };
      await act(async () => root.render(<JobDetailPanel
        job={locked}
        items={[]}
        user={user}
        pending={false}
        message=""
        onCommand={() => {}}
        onSaveSchedule={vi.fn()}
      />));
      await openScheduleEditor();
      expect(document.activeElement?.id).toBe('job-schedule-edit-title');
    },
  );

  it('renders the compact wheel schedule field and commits the chosen time', async () => {
    resizeTo(390);
    await act(async () => root.render(<JobDetailPanel
      job={job}
      items={[]}
      user={user}
      pending={false}
      message=""
      onCommand={() => {}}
      onSaveSchedule={vi.fn()}
    />));
    await openScheduleEditor();
    const trigger = container.querySelector<HTMLButtonElement>('#job-scheduled-at')!;
    expect(trigger.tagName).toBe('BUTTON');
    expect(document.activeElement).toBe(trigger);
    expect(trigger.hasAttribute('name')).toBe(false);
    const before = trigger.textContent;
    await act(async () => trigger.click());
    const hour = container.querySelector<HTMLElement>('[role="spinbutton"][aria-label="Saat"]')!;
    await act(async () => {
      hour.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    });
    const ok = [...container.querySelectorAll<HTMLButtonElement>('.wheel-sheet-actions button')]
      .find((button) => button.textContent === 'Tamam')!;
    await act(async () => ok.click());
    expect(trigger.textContent).not.toBe(before);
    expect(document.body.style.overflow).toBe('');

    const cancel = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Vazgeç')!;
    await act(async () => cancel.click());
    expect(document.activeElement?.textContent?.trim()).toBe('Değiştir');
  });

  it('summarises the planned interval in one compact row before editing', async () => {
    await act(async () => root.render(<JobDetailPanel
      job={job}
      items={[]}
      user={user}
      pending={false}
      message=""
      onCommand={() => {}}
      onSaveSchedule={vi.fn()}
    />));

    const summary = container.querySelector('[data-job-schedule-summary="true"]');
    expect(summary).not.toBeNull();
    expect(summary!.textContent).toContain('Planlanan görüşme zamanı');
    expect(summary!.textContent).toContain(
      formatWheelDisplay('datetime', isoInstantToLocalDateTime(job.scheduledAt!)),
    );
    expect(summary!.textContent).toContain('(60 dk)');
    expect(container.querySelector('#job-scheduled-at')).toBeNull();
    expect(container.querySelector('form')).toBeNull();
    const change = Array.from(summary!.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Değiştir');
    expect(change).toBeTruthy();
  });

  it('opens with Değiştir and Vazgeç restores the saved value and collapses', async () => {
    await act(async () => root.render(<JobDetailPanel
      job={job}
      items={[]}
      user={user}
      pending={false}
      message=""
      onCommand={() => {}}
      onSaveSchedule={vi.fn()}
    />));

    const savedValue = isoInstantToLocalDateTime(job.scheduledAt!);
    await openScheduleEditor();
    expect(document.activeElement?.id).toBe('job-scheduled-at');
    expect((container.querySelector('#job-scheduled-at') as HTMLInputElement).value).toBe(savedValue);
    await setInputValue('#job-scheduled-at', '2026-08-18T09:00');

    const cancel = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Vazgeç') as HTMLButtonElement;
    expect(cancel).toBeTruthy();
    await act(async () => cancel.click());

    expect(container.querySelector('#job-scheduled-at')).toBeNull();
    expect(container.querySelector('[data-job-schedule-summary="true"]')).not.toBeNull();
    expect(document.activeElement?.textContent?.trim()).toBe('Değiştir');
    await openScheduleEditor();
    expect((container.querySelector('#job-scheduled-at') as HTMLInputElement).value).toBe(savedValue);
  });

  it('processes a positive scheduleShiftSignal on the first render', async () => {
    await act(async () => root.render(<JobDetailPanel
      job={job}
      items={[]}
      user={user}
      pending={false}
      message=""
      onCommand={() => {}}
      onSaveSchedule={vi.fn()}
      scheduleShiftSignal={1}
    />));
    expect(container.querySelector('#job-scheduled-at')).not.toBeNull();
    expect(container.querySelector('[data-job-schedule-summary="true"]')).toBeNull();
  });

  it('groups available slots by day and commits a time chip', async () => {
    const slots: AvailableSlot[] = [
      { startsAt: '2026-08-17T07:00:00.000Z', endsAt: '2026-08-17T07:30:00.000Z' },
      { startsAt: '2026-08-17T08:30:00.000Z', endsAt: '2026-08-17T09:00:00.000Z' },
      { startsAt: '2026-08-18T10:30:00.000Z', endsAt: '2026-08-18T11:00:00.000Z' },
    ];
    const weekdayShort = new Intl.DateTimeFormat('tr-TR', { weekday: 'short' });
    const weekdayLong = new Intl.DateTimeFormat('tr-TR', { weekday: 'long' });
    const monthShort = new Intl.DateTimeFormat('tr-TR', { month: 'short' });
    const monthLong = new Intl.DateTimeFormat('tr-TR', { month: 'long' });
    const dayNumber = new Intl.DateTimeFormat('tr-TR', { day: 'numeric' });
    const clock = new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' });
    const dayKey = (iso: string) => isoInstantToLocalDateTime(iso).slice(0, 10);
    const shortDay = (iso: string) => {
      const date = new Date(iso);
      return `${weekdayShort.format(date)} ${dayNumber.format(date)} ${monthShort.format(date)}`;
    };
    const longDay = (iso: string) => {
      const date = new Date(iso);
      return `${dayNumber.format(date)} ${monthLong.format(date)} ${weekdayLong.format(date)}`;
    };
    const expectedDays = [...new Set(slots.map((slot) => dayKey(slot.startsAt)))]
      .map((key) => shortDay(slots.find((slot) => dayKey(slot.startsAt) === key)!.startsAt));
    const expectedChips = slots.map((slot) => clock.format(new Date(slot.startsAt)));

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ slots })));
    await act(async () => root.render(<JobDetailPanel
      job={job}
      items={[]}
      user={user}
      pending={false}
      message=""
      onCommand={() => {}}
      onSaveSchedule={vi.fn()}
    />));
    await openScheduleEditor();
    await act(async () => { vi.advanceTimersByTime(300); });
    await act(async () => { await Promise.resolve(); });

    const dayLabels = [...container.querySelectorAll('.available-slots-day-label')]
      .map((label) => label.textContent);
    expect(dayLabels).toEqual(expectedDays);
    const chips = [...container.querySelectorAll<HTMLButtonElement>('button[data-available-slot]')];
    expect(chips.map((chip) => chip.textContent)).toEqual(expectedChips);
    const firstTime = `${clock.format(new Date(slots[0]!.startsAt))}–${clock.format(new Date(slots[0]!.endsAt))}`;
    const secondTime = `${clock.format(new Date(slots[1]!.startsAt))}–${clock.format(new Date(slots[1]!.endsAt))}`;
    expect(chips[0]!.getAttribute('aria-label')).toContain(`${longDay(slots[0]!.startsAt)} ${firstTime}`);
    expect(chips[1]!.getAttribute('aria-label')).toContain(`${longDay(slots[1]!.startsAt)} ${secondTime}`);

    await act(async () => chips[1]!.click());
    expect((container.querySelector('#job-scheduled-at') as HTMLInputElement).value)
      .toBe(isoInstantToLocalDateTime(slots[1]!.startsAt));
    expect(chips[1]!.getAttribute('aria-pressed')).toBe('true');
  });

  it('shows the schedule reason only once a lateness-open deadline actually changes', async () => {
    const manager: CurrentUser = {
      ...user,
      role: 'MANAGER',
      capabilities: { overviewDashboard: true, calendar: true, messaging: true },
    };
    const latenessJob: JobCard = { ...job, hasOpenOverdueIncident: true };
    await act(async () => root.render(<JobDetailPanel
      job={latenessJob}
      items={[]}
      user={manager}
      pending={false}
      message=""
      onCommand={() => {}}
      onSaveSchedule={vi.fn()}
    />));
    await openScheduleEditor();
    expect(container.querySelector('#job-schedule-extension-reason')).toBeNull();

    await setInputValue('#job-scheduled-at', '2026-08-18T09:00');
    const reason = container.querySelector<HTMLTextAreaElement>('#job-schedule-extension-reason');
    expect(reason).not.toBeNull();
    expect(reason!.rows).toBe(2);
    expect(container.textContent).toContain('En fazla 500 karakter.');

    await act(async () => (container.querySelector('.job-schedule-edit form') as HTMLFormElement).requestSubmit());
    expect(container.textContent).toContain(
      'Gecikmeyi sonlandıran tarih değişikliği için gerekçe yazın.',
    );
    expect(document.activeElement).toBe(reason);
  });

  it('keeps the compact schedule structure in the stylesheet contract', () => {
    expect(styles).toMatch(/\.job-schedule-summary\s*\{[^}]*display:\s*flex/s);
    expect(styles).toMatch(/\.job-schedule-summary-change\s*\{[^}]*min-height:\s*var\(--control-height\)/s);
    expect(styles).toMatch(/@media\s*\(width < 64rem\)[\s\S]*\.schedule-quick-chips\s*\{[^}]*flex-wrap:\s*nowrap[\s\S]*scroll-snap-type:\s*x/s);
    expect(styles).toMatch(/\.available-slots-strip\s*\{[^}]*scroll-snap-type:\s*x/s);
    expect(styles).toMatch(/\.available-slot-chip\s*\{[^}]*min-height:\s*var\(--control-height\)/s);
    expect(styles).toMatch(/\.job-schedule-summary-change\s*\{[^}]*min-width:\s*0/s);
  });
});
