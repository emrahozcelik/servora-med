/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  fetchSubmissionDelay: vi.fn(),
  fetchOverdueIncidents: vi.fn(),
  sendSubmissionReminder: vi.fn(),
}));
vi.mock('../src/jobs/jobs-api', () => api);

import { SubmissionDelayPanel } from '../src/jobs/SubmissionDelayPanel';
import { ApiError, type CurrentUser } from '../src/services/api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const staff: CurrentUser = {
  id: '11111111-1111-4111-8111-111111111111', organizationId: 'org-1', name: 'Ayşe Personel',
  email: 'ayse@example.com', role: 'STAFF', mustChangePassword: false, isActive: true, version: 1,
};
const manager: CurrentUser = { ...staff, id: '22222222-2222-4222-8222-222222222222', name: 'Murat Yönetici', role: 'MANAGER' };

const breachedAt = '2026-07-13T07:30:00.000Z';
const openSignal = {
  delayType: 'LATE_SUBMISSION' as const,
  episodeNo: 1,
  deadlineAt: '2026-07-13T07:30:00.000Z',
  breachedAt,
  elapsedSeconds: 8_040,
  accountableStaff: { id: staff.id, name: staff.name },
};
const reminder = {
  sentAt: '2026-07-13T08:30:00.000Z',
  actor: { id: manager.id, name: manager.name },
  target: { id: staff.id, name: staff.name },
};
const submissionIncident = {
  id: 'incident-1',
  delayType: 'LATE_SUBMISSION' as const,
  episodeNo: 1,
  scheduleRevisionNo: 1,
  deadlineAt: '2026-07-13T07:30:00.000Z',
  breachedAt,
  accountableRole: 'STAFF' as const,
  accountableSource: 'ASSIGNMENT_AT_BREACH' as const,
  accountableUser: { id: staff.id, name: staff.name },
  source: 'SCANNER' as const,
  recordedAt: '2026-07-13T07:31:00.000Z',
  recoveredAt: '2026-07-13T09:30:00.000Z',
  recoveryActor: { id: staff.id, name: staff.name },
  totalDelaySeconds: 7_200,
  managerReminder: reminder,
  postReminderDelaySeconds: 3_600,
};
const startIncident = {
  ...submissionIncident, id: 'incident-start', delayType: 'LATE_START' as const, episodeNo: 4,
};

function page(items: unknown[], total = items.length) {
  return { items, total, limit: 25, offset: 0 };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('SubmissionDelayPanel', () => {
  let container: HTMLDivElement;
  let root: Root;
  let uuidCounter: number;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    uuidCounter = 0;
    vi.stubGlobal('crypto', { randomUUID: () => `client-action-${++uuidCounter}` });
    api.fetchSubmissionDelay.mockResolvedValue(openSignal);
    api.fetchOverdueIncidents.mockResolvedValue(page([submissionIncident]));
    api.sendSubmissionReminder.mockResolvedValue({
      jobCardId: 'job-1', incidentId: 'incident-1', reminderId: 'reminder-1',
      sentAt: '2026-07-13T08:30:00.000Z', targetUserId: staff.id,
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  async function render(user: CurrentUser = manager, jobId = 'job-1') {
    await act(async () => root.render(
      <MemoryRouter>
        <SubmissionDelayPanel
          jobId={jobId}
          user={user}
          organizationTimezone="Europe/Istanbul"
          jobTitle="Klinik kurulum"
          customerName="ABC Klinik"
        />
      </MemoryRouter>,
    ));
    await act(async () => {});
  }

  function reminderButton() {
    return container.querySelector<HTMLButtonElement>('[data-job-submission-reminder-action]');
  }

  it('shows the staff member the open delay with the server-measured duration and no action', async () => {
    await render(staff);
    expect(container.textContent).toContain('Onaya gönderme gecikti · 2 saat 14 dakika');
    expect(reminderButton()).toBeNull();
    // The breach history is management-only, so STAFF must not even ask for it.
    expect(api.fetchOverdueIncidents).not.toHaveBeenCalled();
  });

  it('renders nothing for a staff member with no open delay', async () => {
    api.fetchSubmissionDelay.mockResolvedValue(null);
    await render(staff);
    expect(container.querySelector('[data-job-submission-delay]')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('shows management the delay facts, the JobCard link and the reminder action', async () => {
    await render(manager);
    const panel = container.querySelector<HTMLElement>('[data-job-submission-delay="true"]')!;
    expect(panel.textContent).toContain('Onaya gönderme gecikmesi');
    expect(panel.textContent).toContain('Onaya gönderme gecikti · 2 saat 14 dakika');
    expect(panel.textContent).toContain('Ayşe Personel');
    expect(panel.textContent).toContain('Klinik kurulum');
    expect(panel.textContent).toContain('ABC Klinik');
    expect(panel.querySelector('a')?.getAttribute('href')).toBe('/jobs/job-1');
    expect(reminderButton()?.textContent).toBe('Onaya göndermesini hatırlat');
  });

  it('reports the recovered episode measurements without inventing a reminder', async () => {
    const legacyRecovered = {
      ...submissionIncident,
      id: 'incident-legacy',
      managerReminder: null,
      postReminderDelaySeconds: null,
    };
    api.fetchOverdueIncidents.mockResolvedValue(page([legacyRecovered, submissionIncident]));
    await render(manager);
    const items = Array.from(
      container.querySelectorAll<HTMLElement>('[data-job-submission-delay-episode]'),
    );
    expect(items).toHaveLength(2);
    // A pre-OVR-4 episode: measured total, but no reminder ever existed, so
    // the post-reminder figure is explicitly "not measured" — never 0.
    expect(items[0]!.textContent).toContain('Toplam gecikme');
    expect(items[0]!.textContent).toContain('2 saat');
    expect(items[0]!.textContent).toContain('Hatırlatma yapılmadı');
    expect(items[0]!.textContent).toContain('Ölçülemedi');
    // The modern episode: 1 saat elapsed between the reminder and the submit.
    expect(items[1]!.textContent).toContain('Hatırlatma zamanı');
    expect(items[1]!.textContent).toContain('1 saat');
  });

  it('omits incidents of other delay types from the submission panel', async () => {
    api.fetchOverdueIncidents.mockResolvedValue(page([startIncident]));
    await render(manager);
    expect(container.querySelector('[data-job-submission-delay-episode="4"]')).toBeNull();
    expect(container.textContent).toContain('Kayıtlı bir onaya gönderme gecikmesi yok.');
  });

  it('does not offer the reminder once the delay is recovered', async () => {
    api.fetchSubmissionDelay.mockResolvedValue(null);
    await render(manager);
    expect(reminderButton()).toBeNull();
    expect(container.querySelector('[data-job-submission-delay-episode="1"]')).not.toBeNull();
  });

  it('reuses one client action id when the action is clicked twice in the same frame', async () => {
    await render(manager);
    const button = reminderButton()!;
    await act(async () => {
      button.click();
      button.click();
    });
    expect(api.sendSubmissionReminder).toHaveBeenCalledTimes(2);
    const ids = api.sendSubmissionReminder.mock.calls.map((call) => call[1]);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBe('client-action-1');
  });

  it('disables the action while the reminder is in flight', async () => {
    const pending = deferred<{
      jobCardId: string; incidentId: string; reminderId: string; sentAt: string; targetUserId: string;
    }>();
    api.sendSubmissionReminder.mockReturnValue(pending.promise);
    await render(manager);
    await act(async () => { reminderButton()!.click(); });
    expect(reminderButton()!.disabled).toBe(true);
    expect(reminderButton()!.textContent).toBe('Gönderiliyor…');
    await act(async () => {
      pending.resolve({
        jobCardId: 'job-1', incidentId: 'incident-1', reminderId: 'reminder-1',
        sentAt: '2026-07-13T08:30:00.000Z', targetUserId: staff.id,
      });
      await pending.promise;
    });
    expect(container.textContent).toContain('Hatırlatma personelinize gönderildi');
    expect(api.fetchSubmissionDelay).toHaveBeenCalledTimes(2);
    expect(api.fetchOverdueIncidents).toHaveBeenCalledTimes(2);
  });

  it('uses a fresh client action id for a later, genuinely new reminder', async () => {
    await render(manager);
    await act(async () => { reminderButton()!.click(); });
    await act(async () => { reminderButton()!.click(); });
    const ids = api.sendSubmissionReminder.mock.calls.map((call) => call[1]);
    expect(ids).toEqual(['client-action-1', 'client-action-2']);
  });

  it('surfaces the fail-closed server refusal and shows no success note', async () => {
    api.sendSubmissionReminder.mockRejectedValue(
      new ApiError(409, 'NO_OPEN_SUBMISSION_DELAY', 'Bu iş için açık bir onaya gönderme gecikmesi bulunmuyor.'),
    );
    await render(manager);
    await act(async () => { reminderButton()!.click(); });
    expect(container.textContent).toContain('Bu iş için açık bir onaya gönderme gecikmesi bulunmuyor.');
    expect(container.textContent).not.toContain('Hatırlatma personelinize gönderildi');
    // A retry after an uncertain failure must reuse the same receipt.
    await act(async () => { reminderButton()!.click(); });
    expect(api.sendSubmissionReminder.mock.calls.map((call) => call[1]))
      .toEqual(['client-action-1', 'client-action-1']);
  });

  it('renders nothing at all when there is neither an open delay nor history', async () => {
    api.fetchSubmissionDelay.mockResolvedValue(null);
    api.fetchOverdueIncidents.mockResolvedValue(page([]));
    await render(manager);
    expect(container.querySelector('[data-job-submission-delay]')).toBeNull();
  });
});
