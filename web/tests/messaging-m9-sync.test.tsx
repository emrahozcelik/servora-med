/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CalendarPage } from '../src/calendar/CalendarPage';
import { ReassignmentSyncPrompt } from '../src/jobs/ReassignmentSyncPrompt';
import { useReassignmentConversationSync } from '../src/jobs/useReassignmentConversationSync';
import { ApiError, type CurrentUser } from '../src/services/api';

const messagingApi = vi.hoisted(() => ({
  getJobConversation: vi.fn(),
  jobAssigneeSync: vi.fn(),
}));
vi.mock('../src/services/messaging-api', () => messagingApi);
vi.mock('../src/services/calendar-api', () => ({
  listCalendar: vi.fn(),
  listCalendarAssignees: vi.fn(),
  getCalendarEvent: vi.fn(),
  createManualEvent: vi.fn(),
  patchManualEvent: vi.fn(),
  cancelManualEvent: vi.fn(),
}));
vi.mock('../src/jobs/jobs-api', () => ({ patchJobCard: vi.fn() }));
vi.mock('../src/realtime/RealtimeProvider', () => ({
  useRealtimeInvalidation: vi.fn(),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const TRANSITION_A_TO_B = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const manager: CurrentUser = {
  id: 'manager-1', organizationId: 'org-1', name: 'Murat Yönetici',
  email: 'manager@example.test', role: 'MANAGER', mustChangePassword: false,
  isActive: true, version: 1,
  capabilities: { overviewDashboard: true, calendar: true, messaging: true },
  support: { displayLabel: 'Destek', email: null, helpUrl: null },
};

const jobEvent = {
  id: 'job-event-1', source: 'JOB' as const, title: 'Ürün teslimi',
  description: null, startsAt: '2026-07-29T09:00:00.000Z',
  endsAt: '2026-07-29T10:00:00.000Z', timezone: 'Europe/Istanbul',
  assignedUser: { id: 'staff-a', name: 'Ayşe Personel' }, version: 1,
  jobCardId: 'job-1', jobType: 'PRODUCT_DELIVERY', jobStatus: 'ACCEPTED',
  priority: 'normal', customer: null, relatedJobPath: '/jobs/job-1',
  followUpContext: null, canEdit: true, canCancel: true,
};

const jobAssigneeList = [
  { id: 'staff-a', name: 'Ayşe Personel' },
  { id: 'staff-b', name: 'Burak Personel' },
];

const conversation = {
  id: 'conv-1', directKey: 'context:JOB:job-1', contextType: 'JOB' as const,
  jobId: 'job-1', jobTitle: 'Ürün teslimi', customerId: null, customerName: null,
  title: null, participantName: 'Burak Personel', participantId: 'staff-b',
  participantIsActive: true,
  participants: [
    { userId: 'manager-1', name: 'Murat Yönetici', isActive: true },
    { userId: 'staff-a', name: 'Ayşe Personel', isActive: true },
  ],
  unreadCount: 0, lastActivityAt: '2026-07-29T09:00:00.000Z',
  updatedAt: '2026-07-29T09:00:00.000Z',
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  root?.unmount();
  container.remove();
  vi.restoreAllMocks();
});

describe('M9: useReassignmentConversationSync', () => {
  function Harness({ jobId }: { jobId: string }) {
    const sync = useReassignmentConversationSync(jobId);
    return (
      <div>
        <div data-testid="state">{sync.state.kind}</div>
        <button
          data-testid="offer"
          onClick={() => {
            void sync.offerSync({
              transitionId: TRANSITION_A_TO_B,
              oldAssignee: { id: 'staff-a', name: 'Ayşe Personel' },
              newAssignee: { id: 'staff-b', name: 'Burak Personel' },
            });
          }}
        >
          offer
        </button>
        <button data-testid="confirm" onClick={() => { void sync.confirm(); }}>confirm</button>
        <button data-testid="dismiss" onClick={sync.dismiss}>dismiss</button>
        <ReassignmentSyncPrompt
          state={sync.state}
          onConfirm={() => { void sync.confirm(); }}
          onDismiss={sync.dismiss}
        />
      </div>
    );
  }

  async function renderHook() {
    root = createRoot(container);
    await act(async () => {
      root.render(<Harness jobId="job-1" />);
    });
  }

  it('no prompt when M5 lookup is opaque (404 -> null)', async () => {
    messagingApi.getJobConversation.mockResolvedValue(null);
    await renderHook();
    await act(async () => {
      container.querySelector('[data-testid="offer"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="state"]')!.textContent).toBe('idle');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('offers prompt when accessible canonical conversation exists', async () => {
    messagingApi.getJobConversation.mockResolvedValue(conversation);
    await renderHook();
    await act(async () => {
      container.querySelector('[data-testid="offer"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="state"]')!.textContent).toBe('offer');
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Atanan personel değişti');
    expect(dialog?.textContent).toContain('Ayşe Personel yerine Burak Personel ekle');
    expect(dialog?.textContent).toContain('Şimdi değil');
    expect(dialog?.textContent).toContain(
      'Önceki personel ileride bu işe tekrar atanırsa konuşmaya yeniden erişebilir.',
    );
  });

  it('confirm calls jobAssigneeSync with immutable transition id', async () => {
    messagingApi.getJobConversation.mockResolvedValue(conversation);
    messagingApi.jobAssigneeSync.mockResolvedValue({ conversationId: 'conv-1', synced: true, changed: true });
    await renderHook();
    await act(async () => {
      container.querySelector('[data-testid="offer"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      container.querySelector('[data-testid="confirm"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(messagingApi.jobAssigneeSync).toHaveBeenCalledTimes(1);
    expect(messagingApi.jobAssigneeSync).toHaveBeenCalledWith('conv-1', {
      clientActionId: expect.any(String),
      assignmentTransitionId: TRANSITION_A_TO_B,
    });
  });

  it('stale 409 resolves prompt without retrying the old transition', async () => {
    messagingApi.getJobConversation.mockResolvedValue(conversation);
    messagingApi.jobAssigneeSync.mockRejectedValue(
      new ApiError(409, 'STALE_REASSIGNMENT', 'stale'),
    );
    await renderHook();
    await act(async () => {
      container.querySelector('[data-testid="offer"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      container.querySelector('[data-testid="confirm"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Atama yeniden değişti. Konuşma katılımcıları güncellenmedi.');
  });

  it('failure keeps retry on the same clientActionId for the same transition', async () => {
    messagingApi.getJobConversation.mockResolvedValue(conversation);
    const transient = new ApiError(0, 'NETWORK', 'network');
    messagingApi.jobAssigneeSync
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce({ conversationId: 'conv-1', synced: true, changed: true });
    await renderHook();
    await act(async () => {
      container.querySelector('[data-testid="offer"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      container.querySelector('[data-testid="confirm"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.querySelector('[data-testid="state"]')!.textContent).toBe('failure');
    await act(async () => {
      container.querySelector('[data-testid="confirm"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(messagingApi.jobAssigneeSync).toHaveBeenCalledTimes(2);
    const firstCall = messagingApi.jobAssigneeSync.mock.calls[0]![1] as { clientActionId: string };
    const secondCall = messagingApi.jobAssigneeSync.mock.calls[1]![1] as { clientActionId: string };
    expect(secondCall.clientActionId).toBe(firstCall.clientActionId);
  });

  it('Şimdi değil dismisses without any sync call', async () => {
    messagingApi.getJobConversation.mockResolvedValue(conversation);
    await renderHook();
    await act(async () => {
      container.querySelector('[data-testid="offer"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      container.querySelector('[data-testid="dismiss"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(messagingApi.jobAssigneeSync).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="state"]')!.textContent).toBe('idle');
  });
});

describe('M9: prompt copy variants', () => {
  async function renderPrompt(state: Parameters<typeof ReassignmentSyncPrompt>[0]['state']) {
    root = createRoot(container);
    await act(async () => {
      root.render(
        <ReassignmentSyncPrompt
          state={state}
          onConfirm={() => {}}
          onDismiss={() => {}}
        />,
      );
    });
    return document.querySelector('[role="dialog"]');
  }

  it('A→null copy avoids nonsense assignee labels', async () => {
    const dialog = await renderPrompt({
      kind: 'offer',
      offer: {
        transitionId: TRANSITION_A_TO_B,
        conversationId: 'conv-1',
        oldAssignee: { id: 'staff-a', name: 'Ayşe Personel' },
        newAssignee: { id: null, name: null },
      },
    });
    expect(dialog?.textContent).toContain('İş artık atanmamış');
    expect(dialog?.textContent).toContain('Konuşmadan çıkar');
    expect(dialog?.textContent).not.toContain('null');
  });

  it('null→B copy avoids null labels', async () => {
    const dialog = await renderPrompt({
      kind: 'offer',
      offer: {
        transitionId: TRANSITION_A_TO_B,
        conversationId: 'conv-1',
        oldAssignee: { id: null, name: null },
        newAssignee: { id: 'staff-b', name: 'Burak Personel' },
      },
    });
    expect(dialog?.textContent).toContain('Burak Personel ekle');
    expect(dialog?.textContent).not.toContain('null');
  });
});

describe('M9: CalendarPage reassignment surface', () => {
  async function renderCalendar() {
    const calendarApi = await import('../src/services/calendar-api');
    (calendarApi.listCalendar as ReturnType<typeof vi.fn>).mockResolvedValue([jobEvent]);
    (calendarApi.listCalendarAssignees as ReturnType<typeof vi.fn>).mockResolvedValue(jobAssigneeList);
    (calendarApi.getCalendarEvent as ReturnType<typeof vi.fn>).mockResolvedValue(jobEvent);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/calendar?event=job-event-1']}>
          <CalendarPage user={manager} />
        </MemoryRouter>,
      );
    });
  }

  it('Job assignment change inside the event edit produces the reassignment prompt', async () => {
    const jobsApi = await import('../src/jobs/jobs-api');
    (jobsApi.patchJobCard as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'job-1', version: 2, assignedTo: 'staff-b', title: 'Ürün teslimi',
      assignee: { id: 'staff-b', name: 'Burak Personel' },
      assignmentTransitionId: TRANSITION_A_TO_B,
    });
    messagingApi.getJobConversation.mockResolvedValue(conversation);
    await renderCalendar();
    await act(async () => {});
    const editButton = Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Düzenle'))!;
    await act(async () => {
      editButton.click();
    });
    const form = document.querySelector('form.calendar-form');
    const assigneeSelect = form?.querySelector('select') as HTMLSelectElement;
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype, 'value',
    )!.set!;
    await act(async () => {
      valueSetter.call(assigneeSelect, 'staff-b');
      assigneeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const submitBtn = Array.from(form?.querySelectorAll('button') ?? [])
      .find((b) => b.type === 'submit')!;
    await act(async () => {
      submitBtn.click();
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Atanan personel değişti');
    expect(messagingApi.getJobConversation).toHaveBeenCalledWith('job-1');
  });
});
