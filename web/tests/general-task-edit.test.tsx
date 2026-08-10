/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JobDetailScreen } from '../src/JobDetail';
import { RealtimeProvider, type RealtimeEventSource } from '../src/realtime/RealtimeProvider';
import type { CurrentUser } from '../src/services/api';
import type {
  JobCard, JobLifecycleFacts, JobWorkflowContext, LifecycleCommand,
} from '../src/jobs/jobs-api';
import { workflowContext } from './fixtures/job-workflow';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const staffUser: CurrentUser = {
  id: 's1', organizationId: 'org-1', name: 'Ayşe Personel', email: 'a@x',
  role: 'STAFF', mustChangePassword: false, isActive: true, version: 1,
};
const managerUser: CurrentUser = {
  ...staffUser, id: 'm1', name: 'Yönetici', role: 'MANAGER', email: 'm@x',
};
const adminUser: CurrentUser = {
  ...managerUser, id: 'a1', name: 'Admin', role: 'ADMIN',
};

const baseLifecycle: JobLifecycleFacts = {
  createdAt: '2026-07-17T08:00:00.000Z', acceptedAt: null, acceptedBy: null,
  startedAt: null, submittedAt: null, submittedBy: null, submissionNote: null,
  approvedAt: null, approvedBy: null, approvalNote: null,
  revisionRequestedAt: null, revisionRequestedBy: null, revisionReason: null,
  cancelledAt: null, cancelledBy: null, cancelReason: null, cancelledFromStatus: null,
};

function contextWith(partial: Partial<JobWorkflowContext> = {}): JobWorkflowContext {
  return {
    ...workflowContext,
    ...partial,
    lifecycle: partial.lifecycle
      ? { ...baseLifecycle, ...partial.lifecycle }
      : (partial.lifecycle === undefined ? { ...workflowContext.lifecycle } : partial.lifecycle),
    submissionReadiness: partial.submissionReadiness === undefined
      ? workflowContext.submissionReadiness
      : partial.submissionReadiness,
    allowedCommands: partial.allowedCommands ?? workflowContext.allowedCommands,
    allowedActions: partial.allowedActions ?? workflowContext.allowedActions,
  };
}

function generalTaskContext(
  status: JobCard['status'],
  opts: { staff?: boolean } = {},
): JobWorkflowContext {
  const commandsByStatus: Record<JobCard['status'], LifecycleCommand[]> = {
    NEW: opts.staff ? ['ACCEPT_ASSIGNMENT', 'CANCEL'] : ['CANCEL'],
    ACCEPTED: ['START', 'CANCEL'],
    IN_PROGRESS: ['SUBMIT_FOR_APPROVAL', 'CANCEL'],
    REVISION_REQUESTED: ['RESUME', 'CANCEL'],
    WAITING_APPROVAL: ['WITHDRAW_FROM_APPROVAL', 'CANCEL'],
    COMPLETED: [],
    CANCELLED: [],
  };
  const actionsByStatus: Record<JobCard['status'], JobWorkflowContext['allowedActions']> = {
    NEW: ['EDIT_JOB_FIELDS', 'VIEW_NOTES', 'ADD_NOTE'],
    ACCEPTED: ['EDIT_JOB_FIELDS', 'VIEW_NOTES', 'ADD_NOTE'],
    IN_PROGRESS: ['EDIT_JOB_FIELDS', 'VIEW_NOTES', 'ADD_NOTE'],
    REVISION_REQUESTED: ['EDIT_JOB_FIELDS', 'VIEW_NOTES', 'ADD_NOTE'],
    WAITING_APPROVAL: ['VIEW_NOTES'],
    COMPLETED: ['VIEW_NOTES'],
    CANCELLED: ['VIEW_NOTES'],
  };
  return contextWith({
    allowedCommands: commandsByStatus[status],
    allowedActions: actionsByStatus[status],
    submissionReadiness: null,
  });
}

function generalTaskJob(overrides: Partial<JobCard> = {}): JobCard {
  return {
    id: 'job-1', organizationId: 'org-1', type: 'GENERAL_TASK', status: 'NEW', version: 2,
    engagementKind: null, title: 'Görevlendirme', description: 'Mevcut açıklama',
    customerId: null, contactId: null, assignedTo: 's1', createdBy: 'm1', priority: 'normal',
    dueDate: null, scheduledAt: '2026-07-20T09:00:00.000Z',
    assignee: { id: 's1', name: 'Ayşe Personel' }, customer: null,
    contact: null, followUpContext: null,
    workflowContext: generalTaskContext('NEW'),
    ...overrides,
  };
}

const staffProfiles = [
  {
    id: 'staff-s1', user: {
      ...staffUser, email: 'ayse@example.test', mustChangePassword: false,
      lastLoginAt: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    },
    title: null, phone: null, region: null, managerUserId: null, managerName: null,
    version: 1, counters: { open: 0, waitingApproval: 0, revisionRequested: 0, completedThisMonth: 0, overdue: 0 },
  },
  {
    id: 'staff-s2', user: {
      id: 's2', organizationId: 'org-1', name: 'Burak Personel', email: 'burak@example.test',
      role: 'STAFF' as const, mustChangePassword: false, isActive: true, version: 1,
      lastLoginAt: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    },
    title: null, phone: null, region: null, managerUserId: null, managerName: null,
    version: 1, counters: { open: 0, waitingApproval: 0, revisionRequested: 0, completedThisMonth: 0, overdue: 0 },
  },
];

const conversation = {
  id: 'conv-1', directKey: 'context:JOB:job-1', contextType: 'JOB',
  jobId: 'job-1', jobTitle: 'Görevlendirme', customerId: null, customerName: null,
  title: null, participantName: 'Ayşe Personel', participantId: 's1',
  participantIsActive: true,
  participants: [
    { userId: 'm1', name: 'Yönetici', isActive: true },
    { userId: 's1', name: 'Ayşe Personel', isActive: true },
  ],
  unreadCount: 0, lastActivityAt: '2026-07-20T09:00:00.000Z',
  updatedAt: '2026-07-20T09:00:00.000Z',
};

const emptyPage = { items: [], total: 0, limit: 25, offset: 0 };

function buttonByName(host: ParentNode, name: string) {
  return Array.from(host.querySelectorAll('button'))
    .find((button) => button.textContent?.trim() === name) ?? null;
}

function inputByName(host: ParentNode, name: string) {
  return host.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[name="${name}"]`);
}

class FakeRealtimeEventSource implements RealtimeEventSource {
  private readonly listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener);
  }

  close() {}
}

function makeFetch(options: {
  card: JobCard;
  conversationLookup: 'none' | 'present';
  patchResult?: { body: Record<string, unknown>; respondWith: (current: JobCard) => Response };
  onSyncPost?: (body: Record<string, unknown>) => void;
}) {
  const patchBodies: Array<Record<string, unknown>> = [];
  const syncBodies: Array<Record<string, unknown>> = [];
  let currentCard = options.card;
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/delivery-items')) {
      return Response.json({ items: [] });
    }
    if (url.includes('/notes?')) return Response.json(emptyPage);
    if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
    if (url.includes('/api/staff?status=')) return Response.json(staffProfiles);
    if (url.endsWith('/api/messaging/conversations/job/job-1')) {
      if (options.conversationLookup === 'present') return Response.json(conversation);
      return new Response(null, { status: 404 });
    }
    if (url.includes('/job-assignee-sync')) {
      syncBodies.push(JSON.parse(String(init?.body)));
      options.onSyncPost?.(JSON.parse(String(init?.body)));
      return Response.json({ conversationId: 'conv-1', synced: true, changed: true });
    }
    if (url.endsWith('/api/job-cards/job-1') && method === 'PATCH') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      patchBodies.push(body);
      const updated: JobCard = {
        ...currentCard,
        ...body,
        version: currentCard.version + 1,
        assignee: body.assignedTo !== undefined
          ? { id: String(body.assignedTo), name: 'Burak Personel' }
          : currentCard.assignee,
      };
      currentCard = updated;
      if (options.patchResult) {
        const response = options.patchResult.respondWith(updated);
        return response;
      }
      return Response.json({ ...updated, assignmentTransitionId: null });
    }
    if (url.endsWith('/api/job-cards/job-1')) {
      return Response.json(currentCard);
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  return {
    fetch,
    patchBodies,
    syncBodies,
    setCard(card: JobCard) { currentCard = card; },
    getCard() { return currentCard; },
  };
}

describe('UXB-002: General Task edit + reassignment reachability', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
      matches: false, media: '', onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    }));
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function renderScreen(user: CurrentUser, harness: ReturnType<typeof makeFetch>) {
    vi.stubGlobal('fetch', harness.fetch);
    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => new FakeRealtimeEventSource()}>
        <JobDetailScreen jobId="job-1" user={user} onBack={() => {}} onChanged={() => {}} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  async function settle() {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  async function openEditForm() {
    await act(async () => {
      buttonByName(host, 'Görevi düzenle')?.click();
      await Promise.resolve();
    });
  }

  async function setField(name: string, value: string) {
    const field = inputByName(host, name);
    if (!field) throw new Error(`field ${name} not found`);
    await act(async () => {
      if (field.tagName === 'SELECT') {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')
          ?.set?.call(field, value);
      } else {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
          ?.set?.call(field, value);
      }
      field.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
  }

  it('Admin sees the edit action on an eligible NEW general task', async () => {
    const harness = makeFetch({ card: generalTaskJob(), conversationLookup: 'none' });
    await renderScreen(adminUser, harness);

    expect(buttonByName(host, 'Görevi düzenle')).not.toBeNull();
  });

  it('Manager sees the edit action on an eligible general task', async () => {
    const card = generalTaskJob({ status: 'IN_PROGRESS',
      workflowContext: generalTaskContext('IN_PROGRESS') });
    const harness = makeFetch({ card, conversationLookup: 'none' });
    await renderScreen(managerUser, harness);

    expect(buttonByName(host, 'Görevi düzenle')).not.toBeNull();
  });

  it('Staff sees the edit action on own eligible general task', async () => {
    const card = generalTaskJob({
      workflowContext: generalTaskContext('NEW', { staff: true }),
    });
    const harness = makeFetch({ card, conversationLookup: 'none' });
    await renderScreen(staffUser, harness);

    expect(buttonByName(host, 'Görevi düzenle')).not.toBeNull();
    expect(buttonByName(host, 'İşi kabul et')).not.toBeNull();
  });

  it('Staff form omits the assignee control and never submits assignedTo', async () => {
    const card = generalTaskJob({
      workflowContext: generalTaskContext('NEW', { staff: true }),
    });
    const harness = makeFetch({ card, conversationLookup: 'none' });
    await renderScreen(staffUser, harness);
    await openEditForm();

    expect(inputByName(host, 'assignedTo')).toBeNull();
    expect(inputByName(host, 'title')?.value).toBe('Görevlendirme');

    await setField('title', 'Kendi görevim');
    await act(async () => {
      buttonByName(host, 'Değişiklikleri kaydet')?.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(harness.patchBodies).toHaveLength(1);
    expect(Object.keys(harness.patchBodies[0]!).sort()).toEqual([
      'description', 'expectedVersion', 'priority', 'title',
    ]);
    expect(harness.syncBodies).toHaveLength(0);
  });

  it('no edit action without EDIT_JOB_FIELDS capability', async () => {
    const card = generalTaskJob({
      status: 'WAITING_APPROVAL',
      workflowContext: generalTaskContext('WAITING_APPROVAL'),
    });
    const harness = makeFetch({ card, conversationLookup: 'none' });
    await renderScreen(managerUser, harness);

    expect(buttonByName(host, 'Görevi düzenle')).toBeNull();
  });

  it('form initial values come from the authoritative job detail', async () => {
    const harness = makeFetch({ card: generalTaskJob(), conversationLookup: 'none' });
    await renderScreen(managerUser, harness);
    await openEditForm();

    expect(inputByName(host, 'title')?.value).toBe('Görevlendirme');
    expect(inputByName(host, 'description')?.value).toBe('Mevcut açıklama');
    expect(inputByName(host, 'priority')?.value).toBe('normal');
    expect(inputByName(host, 'assignedTo')?.value).toBe('s1');
  });

  it('form has no scheduling control and the dedicated schedule editor stays available', async () => {
    const harness = makeFetch({ card: generalTaskJob(), conversationLookup: 'none' });
    await renderScreen(managerUser, harness);
    await openEditForm();

    const editForm = host.querySelector('.general-task-edit-form');
    expect(editForm?.querySelector('[name="scheduledAt"]')).toBeNull();
    expect(inputByName(host, 'scheduledAt')).not.toBeNull();
    expect(host.textContent).toContain('Planlanan zamanı düzenle');
  });

  it('cancel closes the editor without any PATCH', async () => {
    const harness = makeFetch({ card: generalTaskJob(), conversationLookup: 'none' });
    await renderScreen(managerUser, harness);
    await openEditForm();

    await act(async () => {
      buttonByName(host, 'Vazgeç')?.click();
      await Promise.resolve();
    });

    expect(harness.patchBodies).toHaveLength(0);
    expect(buttonByName(host, 'Görevi düzenle')).not.toBeNull();
  });

  it('empty title is rejected by the form before any PATCH', async () => {
    const harness = makeFetch({ card: generalTaskJob(), conversationLookup: 'none' });
    await renderScreen(managerUser, harness);
    await openEditForm();

    await setField('title', '');
    await act(async () => {
      buttonByName(host, 'Değişiklikleri kaydet')?.click();
      await Promise.resolve();
    });

    expect(harness.patchBodies).toHaveLength(0);
    expect(host.textContent).toContain('Görev başlığı boş olamaz.');
  });

  it('save sends only title/description/priority/assignedTo with expectedVersion', async () => {
    const harness = makeFetch({ card: generalTaskJob(), conversationLookup: 'none' });
    await renderScreen(managerUser, harness);
    await openEditForm();

    await setField('title', 'Güncellenen görev');
    await setField('priority', 'high');
    await act(async () => {
      buttonByName(host, 'Değişiklikleri kaydet')?.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(harness.patchBodies).toHaveLength(1);
    expect(Object.keys(harness.patchBodies[0]!).sort()).toEqual([
      'assignedTo', 'description', 'expectedVersion', 'priority', 'title',
    ]);
    expect(harness.patchBodies[0]!.title).toBe('Güncellenen görev');
    expect(harness.patchBodies[0]!.priority).toBe('high');
    expect(harness.patchBodies[0]!.description).toBe('Mevcut açıklama');
    expect(harness.patchBodies[0]!.assignedTo).toBe('s1');
    expect(harness.patchBodies[0]!).not.toHaveProperty('scheduledAt');
    expect(host.textContent).toContain('Görev bilgileri güncellendi.');
  });

  it('field edit without reassignment never opens the M9 prompt', async () => {
    const harness = makeFetch({ card: generalTaskJob(), conversationLookup: 'present' });
    await renderScreen(managerUser, harness);
    await openEditForm();

    await setField('title', 'Sadece başlık değişti');
    await act(async () => {
      buttonByName(host, 'Değişiklikleri kaydet')?.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(harness.patchBodies).toHaveLength(1);
    expect(harness.syncBodies).toHaveLength(0);
    expect(host.textContent).not.toContain('Atanan personel değişti');
  });

  it('reassignment with a transition id offers the M9 sync exactly once', async () => {
    const card = generalTaskJob();
    const harness = makeFetch({
      card,
      conversationLookup: 'present',
      patchResult: {
        body: {},
        respondWith: (current) => Response.json({
          ...current,
          assignedTo: 's2',
          assignee: { id: 's2', name: 'Burak Personel' },
          version: current.version + 1,
          assignmentTransitionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        }),
      },
    });
    await renderScreen(managerUser, harness);
    await openEditForm();

    await setField('assignedTo', 's2');
    await act(async () => {
      buttonByName(host, 'Değişiklikleri kaydet')?.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.textContent).toContain('Atanan personel değişti');
    expect(host.textContent).toContain('Ayşe Personel yerine Burak Personel ekle');

    await act(async () => {
      buttonByName(host, 'Ayşe Personel yerine Burak Personel ekle')?.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(harness.syncBodies).toHaveLength(1);
    expect(harness.syncBodies[0]!.assignmentTransitionId)
      .toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  });

  it('reassignment without a transition id does not open the M9 prompt', async () => {
    const harness = makeFetch({ card: generalTaskJob(), conversationLookup: 'present' });
    await renderScreen(managerUser, harness);
    await openEditForm();

    await setField('assignedTo', 's2');
    await act(async () => {
      buttonByName(host, 'Değişiklikleri kaydet')?.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(harness.patchBodies).toHaveLength(1);
    expect(harness.syncBodies).toHaveLength(0);
    expect(host.textContent).not.toContain('Atanan personel değişti');
  });

  it('failed PATCH never invokes the sync and surfaces the server message', async () => {
    const card = generalTaskJob();
    const harness = makeFetch({
      card,
      conversationLookup: 'present',
      patchResult: {
        body: {},
        respondWith: () => new Response(JSON.stringify({
          error: 'JobCard başka bir işlem tarafından güncellendi.',
          code: 'VERSION_CONFLICT',
        }), { status: 409, headers: { 'Content-Type': 'application/json' } }),
      },
    });
    await renderScreen(managerUser, harness);
    await openEditForm();

    await setField('assignedTo', 's2');
    await act(async () => {
      buttonByName(host, 'Değişiklikleri kaydet')?.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(harness.syncBodies).toHaveLength(0);
    expect(host.textContent).toContain('En güncel durum gösteriliyor');
  });
});
