/** @vitest-environment jsdom */
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JobDetailScreen } from '../src/JobDetail';
import type { CurrentUser, DeliveryItem } from '../src/services/api';
import type {
  JobCard, JobLifecycleFacts, JobWorkflowContext, LifecycleCommand,
} from '../src/jobs/jobs-api';
import { workflowContext } from './fixtures/job-workflow';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const messagingUser: CurrentUser = {
  id: 'm1', organizationId: 'org-1', name: 'Mehmet Yönetici', email: 'm@x',
  role: 'MANAGER', mustChangePassword: false, isActive: true, version: 1,
  capabilities: { overviewDashboard: true, calendar: true, messaging: true },
  support: { displayLabel: 'Sistem yöneticiniz', email: null, helpUrl: null },
};
const staffUser: CurrentUser = {
  ...messagingUser, id: 's1', name: 'Ayşe Personel', role: 'STAFF',
};
const adminUser: CurrentUser = {
  ...messagingUser, id: 'a1', name: 'Admin', role: 'ADMIN',
};
const noMessagingUser: CurrentUser = {
  ...adminUser, capabilities: { overviewDashboard: true, calendar: true, messaging: false },
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
      : { ...workflowContext.lifecycle },
    submissionReadiness: partial.submissionReadiness === undefined
      ? workflowContext.submissionReadiness
      : partial.submissionReadiness,
    allowedCommands: partial.allowedCommands ?? workflowContext.allowedCommands,
    allowedActions: partial.allowedActions ?? workflowContext.allowedActions,
  };
}

function jobWith(status: JobCard['status'], lifecycle: Partial<JobLifecycleFacts> = {}): JobCard {
  const commandsByStatus: Record<JobCard['status'], LifecycleCommand[]> = {
    NEW: ['ACCEPT_ASSIGNMENT', 'CANCEL'],
    ACCEPTED: ['START', 'CANCEL'],
    IN_PROGRESS: ['SUBMIT_FOR_APPROVAL', 'CANCEL'],
    REVISION_REQUESTED: ['RESUME', 'CANCEL'],
    WAITING_APPROVAL: ['WITHDRAW_FROM_APPROVAL', 'CANCEL'],
    COMPLETED: [],
    CANCELLED: [],
  };
  return {
    id: 'job-1', organizationId: 'org-1', type: 'GENERAL_TASK', status, version: 2,
    engagementKind: null,
    title: 'Teklif dönüşünü takip et', description: null, customerId: null,
    contactId: null, assignedTo: 's1', createdBy: 'a1', priority: 'normal',
    dueDate: null, scheduledAt: null,
    assignee: { id: 's1', name: 'Ayşe Personel' }, customer: null, contact: null,
    followUpContext: null,
    workflowContext: contextWith({
      allowedCommands: commandsByStatus[status],
      allowedActions: status === 'COMPLETED' || status === 'CANCELLED'
        ? ['VIEW_NOTES']
        : ['VIEW_NOTES', 'ADD_NOTE'],
      lifecycle: { ...baseLifecycle, ...lifecycle },
      submissionReadiness: null,
    }),
  };
}

const item: DeliveryItem = {
  id: 'i1', organizationId: 'org-1', jobCardId: 'job-1', productId: 'p1',
  deliveryPurpose: 'SAMPLE', deliveredAt: null, quantity: 2, unit: 'adet',
  productNameSnapshot: 'İmplant Seti', productSkuSnapshot: 'S1', productModelSnapshot: null,
  lotNo: null, serialNo: null, expiryDate: null, deliveryNote: null,
};

const conversation = {
  id: 'conv-1', directKey: 'context:JOB:job-1', contextType: 'JOB', jobId: 'job-1',
  jobTitle: 'Teklif dönüşünü takip et', customerId: null, customerName: null,
  title: null, participantName: 'Ayşe Personel', participantId: 's1',
  participantIsActive: true,
  participants: [
    { userId: 'm1', name: 'Mehmet Yönetici', isActive: true },
    { userId: 's1', name: 'Ayşe Personel', isActive: true },
  ],
  unreadCount: 0, lastActivityAt: '2026-07-20T10:00:00.000Z',
  updatedAt: '2026-07-20T10:00:00.000Z',
};

const emptyPage = { items: [], total: 0, limit: 25, offset: 0 };

function mockFetch(card: JobCard, lookup: () => Response | Error, options: {
  createResponse?: Response;
  createError?: Error;
  createGate?: Promise<void>;
} = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === `/api/messaging/conversations/job/${card.id}`) {
      const result = lookup();
      if (result instanceof Error) throw result;
      return result;
    }
    if (url === '/api/messaging/conversations') {
      if (options.createGate) await options.createGate;
      if (options.createError) throw options.createError;
      return options.createResponse ?? Response.json(conversation, { status: 201 });
    }
    if (url.endsWith('/delivery-items')) return Response.json({ items: card.type === 'PRODUCT_DELIVERY' ? [item] : [] });
    if (url.includes('/follow-ups')) return Response.json({ ...emptyPage, limit: 100 });
    if (url.includes('/notes?')) return Response.json(emptyPage);
    if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
    if (url.endsWith(`/api/job-cards/${card.id}`)) return Response.json(card);
    throw new Error(`Unexpected request: ${url}`);
  });
}

describe('M5 Job Detail Messaging action', () => {
  let host: HTMLDivElement;
  let root: Root;
  let openedConversations: string[];

  beforeEach(() => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
      matches: false, media: '', onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    }));
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    openedConversations = [];
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function renderScreen(card: JobCard, user: CurrentUser, fetch: ReturnType<typeof mockFetch>) {
    vi.stubGlobal('fetch', fetch);
    await act(async () => {
      root.render(<StrictMode><JobDetailScreen
        jobId={card.id}
        user={user}
        onBack={() => {}}
        onChanged={() => {}}
        onOpenMessaging={(conversationId) => openedConversations.push(conversationId)}
      /></StrictMode>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return fetch;
  }

  function button(host: ParentNode) {
    return Array.from(host.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Konuşmayı aç'
        || button.textContent?.trim() === 'Konuşma başlat') ?? null;
  }

  describe('ADMIN/MANAGER', () => {
    it('Case 1: authorized existing conversation → "Konuşmayı aç" → navigates to exact deep link', async () => {
      const fetch = mockFetch(jobWith('IN_PROGRESS'), () => Response.json(conversation));
      await renderScreen(jobWith('IN_PROGRESS'), messagingUser, fetch);

      const openButton = button(host);
      expect(openButton?.textContent?.trim()).toBe('Konuşmayı aç');
      await act(async () => { openButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(openedConversations).toEqual(['conv-1']);
    });

    it('Case 2: active Job + no conversation + eligible assigned Staff → "Konuşma başlat" → uses create API → navigates', async () => {
      const fetch = mockFetch(jobWith('ACCEPTED'), () => Response.json(
        { status: 404, ok: false }, { status: 404 },
      ));
      await renderScreen(jobWith('ACCEPTED'), messagingUser, fetch);

      const startButton = button(host);
      expect(startButton?.textContent?.trim()).toBe('Konuşma başlat');
      await act(async () => { startButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      await new Promise((resolve) => setTimeout(resolve, 0));

      const createCall = fetch.mock.calls.find(([input]) =>
        String(input) === '/api/messaging/conversations');
      expect(createCall).toBeTruthy();
      expect(JSON.parse(String(createCall![1]?.body))).toEqual({
        contextType: 'JOB', jobId: 'job-1', participantUserIds: ['s1'],
      });
      expect(openedConversations).toEqual(['conv-1']);
    });

    it('Case 3: create returns existing canonical for legitimate participant → opens same thread, no false created UX', async () => {
      const fetch = mockFetch(jobWith('ACCEPTED'), () => Response.json(
        { status: 404, ok: false }, { status: 404 },
      ));
      await renderScreen(jobWith('ACCEPTED'), adminUser, fetch);

      const startButton = button(host);
      await act(async () => { startButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(openedConversations).toEqual(['conv-1']);
      expect(host.querySelector('[data-job-detail-messaging="true"] [role="alert"]')).toBeNull();
    });

    it('Case 4: canonical exists but caller is non-participant → create returns canonical (org-wide Manager RBAC) → opens same thread, no join/add retry', async () => {
      const fetch = mockFetch(jobWith('IN_PROGRESS'), () => Response.json(
        { status: 404, ok: false }, { status: 404 },
      ));
      await renderScreen(jobWith('IN_PROGRESS'), adminUser, fetch);

      const startButton = button(host);
      expect(startButton?.textContent?.trim()).toBe('Konuşma başlat');
      await act(async () => { startButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      await new Promise((resolve) => setTimeout(resolve, 0));

      const createCall = fetch.mock.calls.find(([input]) =>
        String(input) === '/api/messaging/conversations');
      expect(createCall).toBeTruthy();
      expect(JSON.parse(String(createCall![1]?.body))).toEqual({
        contextType: 'JOB', jobId: 'job-1', participantUserIds: ['s1'],
      });
      expect(openedConversations).toEqual(['conv-1']);
      const alert = host.querySelector('[data-job-detail-messaging="true"] [role="alert"]');
      expect(alert).toBeNull();
    });

    it('Case 5: loading — duplicate click suppressed during create', async () => {
      let releaseCreate!: () => void;
      const gate = new Promise<void>((resolve) => { releaseCreate = resolve; });
      const fetch = mockFetch(jobWith('ACCEPTED'), () => Response.json(
        { status: 404, ok: false }, { status: 404 },
      ), { createGate: gate });
      await renderScreen(jobWith('ACCEPTED'), messagingUser, fetch);

      const startButton = button(host)!;
      await act(async () => { startButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      await act(async () => { startButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      await act(async () => { releaseCreate(); });
      await new Promise((resolve) => setTimeout(resolve, 0));

      const createCalls = fetch.mock.calls.filter(([input]) =>
        String(input) === '/api/messaging/conversations');
      expect(createCalls.length).toBe(1);
      expect(openedConversations).toEqual(['conv-1']);
    });
  });

  describe('STAFF', () => {
    it('assigned Staff with authorized persisted conversation → "Konuşmayı aç" → deep-link navigation', async () => {
      const fetch = mockFetch(jobWith('IN_PROGRESS'), () => Response.json(conversation));
      await renderScreen(jobWith('IN_PROGRESS'), staffUser, fetch);

      const openButton = button(host);
      expect(openButton?.textContent?.trim()).toBe('Konuşmayı aç');
      await act(async () => { openButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(openedConversations).toEqual(['conv-1']);
    });

    it('assigned Staff + NO conversation → no create action at all', async () => {
      const fetch = mockFetch(jobWith('IN_PROGRESS'), () => Response.json(
        { status: 404, ok: false }, { status: 404 },
      ));
      await renderScreen(jobWith('IN_PROGRESS'), staffUser, fetch);

      expect(button(host)).toBeNull();
      expect(host.textContent).not.toContain('Konuşma başlat');
      const createCalls = fetch.mock.calls.filter(([input]) =>
        String(input) === '/api/messaging/conversations');
      expect(createCalls.length).toBe(0);
    });

    it('newly assigned Staff + existing thread but not participant → no unauthorized open', async () => {
      const fetch = mockFetch(jobWith('IN_PROGRESS'), () => Response.json(
        { status: 404, ok: false }, { status: 404 },
      ));
      await renderScreen(jobWith('IN_PROGRESS'), staffUser, fetch);
      expect(button(host)).toBeNull();
      expect(host.textContent).not.toContain('conv-1');
    });

    it('stale Staff → no authorized conversation open (lookup denied → no action)', async () => {
      const fetch = mockFetch(jobWith('IN_PROGRESS'), () => Response.json(
        { status: 404, ok: false }, { status: 404 },
      ));
      await renderScreen(jobWith('IN_PROGRESS'), staffUser, fetch);
      expect(button(host)).toBeNull();
    });
  });

  describe('TERMINAL', () => {
    const completed = jobWith('COMPLETED', {
      startedAt: '2026-07-17T09:00:00.000Z',
      submittedAt: '2026-07-17T10:00:00.000Z',
      approvedAt: '2026-07-17T11:00:00.000Z',
    });
    const cancelled = jobWith('CANCELLED', {
      startedAt: '2026-07-17T09:00:00.000Z',
      cancelledAt: '2026-07-17T12:00:00.000Z',
      cancelReason: 'Müşteri vazgeçti',
      cancelledFromStatus: 'IN_PROGRESS',
    });

    it('COMPLETED with authorized existing conversation → "Konuşmayı aç"', async () => {
      const fetch = mockFetch(completed, () => Response.json(conversation));
      await renderScreen(completed, staffUser, fetch);
      expect(button(host)?.textContent?.trim()).toBe('Konuşmayı aç');
    });

    it('CANCELLED with authorized existing conversation → "Konuşmayı aç"', async () => {
      const fetch = mockFetch(cancelled, () => Response.json(conversation));
      await renderScreen(cancelled, staffUser, fetch);
      expect(button(host)?.textContent?.trim()).toBe('Konuşmayı aç');
    });

    it('COMPLETED with no conversation → no "Konuşma başlat"', async () => {
      const fetch = mockFetch(completed, () => Response.json(
        { status: 404, ok: false }, { status: 404 },
      ));
      await renderScreen(completed, adminUser, fetch);
      expect(button(host)).toBeNull();
      const createCalls = fetch.mock.calls.filter(([input]) =>
        String(input) === '/api/messaging/conversations');
      expect(createCalls.length).toBe(0);
    });

    it('CANCELLED with no conversation → no "Konuşma başlat"', async () => {
      const fetch = mockFetch(cancelled, () => Response.json(
        { status: 404, ok: false }, { status: 404 },
      ));
      await renderScreen(cancelled, adminUser, fetch);
      expect(button(host)).toBeNull();
      const createCalls = fetch.mock.calls.filter(([input]) =>
        String(input) === '/api/messaging/conversations');
      expect(createCalls.length).toBe(0);
    });
  });

  describe('EDGE', () => {
    it('messaging disabled → no Messaging action at all', async () => {
      const fetch = mockFetch(jobWith('IN_PROGRESS'), () => Response.json(conversation));
      await renderScreen(jobWith('IN_PROGRESS'), noMessagingUser, fetch);
      expect(button(host)).toBeNull();
      const lookupCalls = fetch.mock.calls.filter(([input]) =>
        String(input) === '/api/messaging/conversations/job/job-1');
      expect(lookupCalls.length).toBe(0);
    });

    it('lookup failure (network) → Job Detail stays usable, eligible Admin/Manager falls back to safe start', async () => {
      const fetch = mockFetch(jobWith('ACCEPTED'), () => new Error('network down'));
      await renderScreen(jobWith('ACCEPTED'), messagingUser, fetch);
      expect(host.textContent).toContain('Teklif dönüşünü takip et');
      expect(button(host)?.textContent?.trim()).toBe('Konuşma başlat');
    });

    it('lookup failure for Staff → no action, page remains usable', async () => {
      const fetch = mockFetch(jobWith('IN_PROGRESS'), () => new Error('network down'));
      await renderScreen(jobWith('IN_PROGRESS'), staffUser, fetch);
      expect(host.textContent).toContain('Teklif dönüşünü takip et');
      expect(button(host)).toBeNull();
    });

    it('creation failure → safe error, no false navigation', async () => {
      const fetch = mockFetch(jobWith('ACCEPTED'), () => Response.json(
        { status: 404, ok: false }, { status: 404 },
      ), { createError: new Error('network down') });
      await renderScreen(jobWith('ACCEPTED'), messagingUser, fetch);

      const startButton = button(host)!;
      await act(async () => { startButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(openedConversations).toEqual([]);
      expect(host.querySelector('[data-job-detail-messaging="true"] [role="alert"]')).toBeTruthy();
    });
  });
});
