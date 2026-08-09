/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JobDetailScreen } from '../src/JobDetail';
import { RealtimeProvider, type RealtimeEventSource } from '../src/realtime/RealtimeProvider';
import type { CurrentUser, DeliveryItem } from '../src/services/api';
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

function deliveryContext(
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
    IN_PROGRESS: ['EDIT_JOB_FIELDS', 'VIEW_NOTES', 'ADD_NOTE', 'EDIT_DELIVERY_ACTUAL_TIME'],
    REVISION_REQUESTED: ['EDIT_JOB_FIELDS', 'VIEW_NOTES', 'ADD_NOTE', 'EDIT_DELIVERY_ACTUAL_TIME'],
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

function deliveryJob(overrides: Partial<JobCard> = {}): JobCard {
  return {
    id: 'job-1', organizationId: 'org-1', type: 'PRODUCT_DELIVERY', status: 'NEW', version: 2,
    engagementKind: null, title: 'ABC Klinik ürün teslimi', description: null,
    customerId: 'c1', contactId: null, assignedTo: 's1', createdBy: 'm1', priority: 'normal',
    dueDate: null, scheduledAt: '2026-07-20T09:00:00.000Z',
    assignee: { id: 's1', name: 'Ayşe Personel' }, customer: { id: 'c1', name: 'ABC Klinik' },
    contact: null, followUpContext: null,
    workflowContext: deliveryContext('NEW'),
    ...overrides,
  };
}

const item: DeliveryItem = {
  id: 'i1', organizationId: 'org-1', jobCardId: 'job-1', productId: 'p1',
  deliveryPurpose: 'SAMPLE', deliveredAt: null, quantity: 2, unit: 'adet',
  productNameSnapshot: 'İmplant Seti', productSkuSnapshot: 'S1', productModelSnapshot: null,
  lotNo: null, serialNo: null, expiryDate: null, deliveryNote: null,
};

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
  jobId: 'job-1', jobTitle: 'ABC Klinik ürün teslimi', customerId: null, customerName: null,
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
      return Response.json({ items: currentCard.type === 'PRODUCT_DELIVERY' ? [item] : [] });
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

describe('UXA-001: Product Delivery reassignment reachability', () => {
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

  it('Admin sees the reassignment action on an eligible NEW delivery job', async () => {
    const harness = makeFetch({ card: deliveryJob(), conversationLookup: 'none' });
    await renderScreen(adminUser, harness);

    expect(buttonByName(host, 'Sorumlu personeli değiştir')).not.toBeNull();
  });

  it('Manager sees the reassignment action on an eligible NEW delivery job', async () => {
    const harness = makeFetch({ card: deliveryJob(), conversationLookup: 'none' });
    await renderScreen(managerUser, harness);

    expect(buttonByName(host, 'Sorumlu personeli değiştir')).not.toBeNull();
  });

  it('Staff does not see the reassignment action', async () => {
    const card = deliveryJob({ workflowContext: deliveryContext('NEW', { staff: true }) });
    const harness = makeFetch({ card, conversationLookup: 'none' });
    await renderScreen(staffUser, harness);

    expect(buttonByName(host, 'Sorumlu personeli değiştir')).toBeNull();
    expect(buttonByName(host, 'İşi kabul et')).not.toBeNull();
  });

  it('no reassignment action once work has started (lifecycle boundary)', async () => {
    const card = deliveryJob({
      status: 'IN_PROGRESS',
      workflowContext: deliveryContext('IN_PROGRESS', {
        lifecycle: {
          acceptedAt: '2026-07-17T08:30:00.000Z',
          startedAt: '2026-07-17T09:00:00.000Z',
        },
      } as Partial<JobWorkflowContext>),
    } as Partial<JobCard>);
    const harness = makeFetch({ card, conversationLookup: 'none' });
    await renderScreen(managerUser, harness);

    expect(buttonByName(host, 'Sorumlu personeli değiştir')).toBeNull();
    expect(buttonByName(host, 'Kontrole gönder')).not.toBeNull();
  });

  it('assignee save PATCHes only legitimate Job assignment fields', async () => {
    const card = deliveryJob();
    const harness = makeFetch({
      card,
      conversationLookup: 'none',
      patchResult: {
        body: {},
        respondWith: (current) => Response.json({
          ...current,
          assignedTo: 's2',
          assignee: { id: 's2', name: 'Burak Personel' },
          version: current.version + 1,
          assignmentTransitionId: null,
        }),
      },
    });
    await renderScreen(managerUser, harness);

    await act(async () => {
      buttonByName(host, 'Sorumlu personeli değiştir')?.click();
      await Promise.resolve();
    });
    const select = host.querySelector('#delivery-edit-assignee') as HTMLSelectElement;
    expect(select).not.toBeNull();

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')
        ?.set?.call(select, 's2');
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      buttonByName(host, 'Değişiklikleri kaydet')?.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(harness.patchBodies).toHaveLength(1);
    expect(Object.keys(harness.patchBodies[0]!).sort()).toEqual(['assignedTo', 'expectedVersion']);
    expect(harness.patchBodies[0]!.assignedTo).toBe('s2');
    expect(harness.getCard().assignedTo).toBe('s2');
    expect(host.textContent).toContain('Sorumlu personel güncellendi.');
  });

  it('reaching the M9 reassignment prompt when a transition id is returned', async () => {
    const card = deliveryJob();
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

    await act(async () => {
      buttonByName(host, 'Sorumlu personeli değiştir')?.click();
      await Promise.resolve();
    });
    const select = host.querySelector('#delivery-edit-assignee') as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')
        ?.set?.call(select, 's2');
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      buttonByName(host, 'Değişiklikleri kaydet')?.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.textContent).toContain('Atanan personel değişti');
    expect(host.textContent).toContain('Ayşe Personel yerine Burak Personel ekle');
  });

  it('Şimdi değil dismisses the prompt without any sync POST', async () => {
    const card = deliveryJob();
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

    await act(async () => {
      buttonByName(host, 'Sorumlu personeli değiştir')?.click();
      await Promise.resolve();
    });
    const select = host.querySelector('#delivery-edit-assignee') as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')
        ?.set?.call(select, 's2');
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      buttonByName(host, 'Değişiklikleri kaydet')?.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain('Atanan personel değişti');

    await act(async () => {
      buttonByName(host, 'Şimdi değil')?.click();
      await Promise.resolve();
    });

    expect(harness.syncBodies).toHaveLength(0);
    expect(host.textContent).not.toContain('Atanan personel değişti');
  });

  it('does not open the M9 prompt when no assignment transition occurred', async () => {
    const card = deliveryJob();
    const harness = makeFetch({ card, conversationLookup: 'present' });
    await renderScreen(managerUser, harness);

    await act(async () => {
      buttonByName(host, 'Sorumlu personeli değiştir')?.click();
      await Promise.resolve();
    });
    const select = host.querySelector('#delivery-edit-assignee') as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')
        ?.set?.call(select, 's2');
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      buttonByName(host, 'Değişiklikleri kaydet')?.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(harness.patchBodies).toHaveLength(1);
    expect(host.textContent).toContain('Sorumlu personel güncellendi.');
    expect(host.textContent).not.toContain('Atanan personel değişti');
  });
});
