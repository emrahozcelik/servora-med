/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JobDetailScreen } from '../src/JobDetail';
import { RealtimeProvider, type RealtimeEventSource } from '../src/realtime/RealtimeProvider';
import { ApiError, type CurrentUser, type DeliveryItem } from '../src/services/api';
import type {
  JobCard, JobLifecycleFacts, JobWorkflowContext, LifecycleCommand, MeetingDetails,
} from '../src/jobs/jobs-api';
import { withoutSaleCapability } from './fixtures/job-workflow';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const styles = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf8');

const staffUser: CurrentUser = {
  id: 's1', organizationId: 'org-1', name: 'Ayşe Personel', email: 'a@x',
  role: 'STAFF', mustChangePassword: false, isActive: true, version: 1,
};
const managerUser: CurrentUser = {
  ...staffUser, id: 'm1', name: 'Murat Yönetici', email: 'm@x', role: 'MANAGER',
};
const adminUser: CurrentUser = {
  ...staffUser, id: 'a1', name: 'Aylin Yönetici', email: 'admin@x', role: 'ADMIN',
};

const baseLifecycle: JobLifecycleFacts = {
  createdAt: '2026-11-12T06:00:00.000Z', acceptedAt: null, acceptedBy: null,
  startedAt: null, submittedAt: null, submittedBy: null, submissionNote: null,
  approvedAt: null, approvedBy: null, approvalNote: null,
  revisionRequestedAt: null, revisionRequestedBy: null, revisionReason: null,
  cancelledAt: null, cancelledBy: null, cancelReason: null, cancelledFromStatus: null,
};

const workflowContext: JobWorkflowContext = {
  allowedCommands: [],
  allowedActions: [],
  startLocationCaptureEnabled: false,
  submitLocationCaptureEnabled: false,
  lifecycle: baseLifecycle,
  submissionReadiness: null,
};

function staffContext(
  status: JobCard['status'],
  lifecycle: Partial<JobLifecycleFacts> = {},
  extras: Partial<JobWorkflowContext> = {},
): JobWorkflowContext {
  const commandsByStatus: Record<JobCard['status'], LifecycleCommand[]> = {
    NEW: ['ACCEPT_ASSIGNMENT', 'CANCEL'],
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
    IN_PROGRESS: [
      'EDIT_JOB_FIELDS', 'VIEW_MEETING_RESULT', 'EDIT_MEETING_RESULT', 'VIEW_NOTES', 'ADD_NOTE',
    ],
    REVISION_REQUESTED: [
      'EDIT_JOB_FIELDS', 'VIEW_MEETING_RESULT', 'EDIT_MEETING_RESULT', 'VIEW_NOTES', 'ADD_NOTE',
    ],
    WAITING_APPROVAL: [
      'WITHDRAW_AND_EDIT_JOB_FIELDS', 'VIEW_MEETING_RESULT', 'VIEW_NOTES',
    ],
    COMPLETED: ['VIEW_MEETING_RESULT', 'VIEW_NOTES'],
    CANCELLED: ['VIEW_MEETING_RESULT', 'VIEW_NOTES'],
  };
  return {
    ...workflowContext,
    ...extras,
    lifecycle: { ...baseLifecycle, ...lifecycle },
    submissionReadiness: extras.submissionReadiness === undefined
      ? (status === 'IN_PROGRESS'
        ? {
          evaluatedAt: '2026-11-12T12:00:00.000Z',
          ready: true,
          items: [
            { code: 'MEETING_TIME_VALID', state: 'met' },
            { code: 'MEETING_OUTCOME_VALID', state: 'met' },
            { code: 'MEETING_SUMMARY_PRESENT', state: 'met' },
          ],
        }
        : null)
      : extras.submissionReadiness,
    allowedCommands: extras.allowedCommands ?? commandsByStatus[status],
    allowedActions: extras.allowedActions ?? actionsByStatus[status],
  };
}

const item: DeliveryItem = {
  id: 'i1', organizationId: 'org-1', jobCardId: 'job-1', productId: 'p1',
  deliveryPurpose: 'SAMPLE', deliveredAt: '2026-11-11T10:00:00.000Z', quantity: 2, unit: 'adet',
  productNameSnapshot: 'İmplant Seti', productSkuSnapshot: 'S1', productModelSnapshot: null,
  lotNo: null, serialNo: null, expiryDate: null, deliveryNote: null,
};

function deliveryJob(): JobCard {
  return {
    id: 'job-1', organizationId: 'org-1', type: 'PRODUCT_DELIVERY', status: 'NEW', version: 2,
    engagementKind: null,
    title: 'ABC Klinik ürün teslimi', description: null, customerId: 'c1', contactId: null,
    assignedTo: 's1', createdBy: 's1', priority: 'normal', dueDate: null,
    scheduledAt: '2026-11-20T09:00:00.000Z',
    scheduledEndsAt: '2026-11-20T09:30:00.000Z',
    assignee: { id: 's1', name: 'Ayşe Personel' }, customer: { id: 'c1', name: 'ABC Klinik' },
    contact: null,
    followUpContext: null,
    hasOpenOverdueIncident: false,
    correctionDueAt: null,
    workflowContext: staffContext('NEW', {}, {
      allowedActions: ['EDIT_JOB_FIELDS', 'EDIT_DELIVERY_ACTUAL_TIME', 'VIEW_NOTES'],
    }),
  };
}

function meetingJob(): JobCard {
  return {
    ...deliveryJob(),
    type: 'SALES_MEETING',
    engagementKind: 'SALES_MEETING',
    status: 'IN_PROGRESS',
    version: 3,
    title: 'Satış görüşmesi detayı',
    dueDate: '2026-11-20',
    workflowContext: staffContext('IN_PROGRESS', {
      startedAt: '2026-11-12T09:00:00.000Z',
    }),
  };
}

function generalTask(): JobCard {
  return {
    ...deliveryJob(),
    type: 'GENERAL_TASK',
    engagementKind: null,
    status: 'NEW',
    version: 2,
    title: 'Teklif dönüşünü takip et',
    description: 'Doktorun kararını öğren ve sonucu karta yaz.',
    scheduledAt: null,
    scheduledEndsAt: null,
    workflowContext: staffContext('NEW', {}, {
      allowedActions: ['EDIT_JOB_FIELDS', 'VIEW_NOTES', 'ADD_NOTE'],
    }),
  };
}

const emptyPage = { items: [], total: 0, limit: 25, offset: 0 };
const customerPayload = {
  id: 'c1', organizationId: 'org-1', name: 'ABC Klinik', customerType: 'clinic',
  taxNumber: null, phone: null, email: null, city: null, district: null, address: null,
  assignedStaffUserId: null, status: 'active', version: 1, assignedStaffName: null,
  primaryContact: null, contacts: [], hasOperationHistory: false,
  openJobCount: 0, completedJobCount: 0,
};
const meetingDetails: MeetingDetails = {
  jobCardId: 'job-1', meetingAt: '2026-11-12T10:00:00.000Z', outcome: 'POSITIVE',
  meetingSummary: 'Olumlu görüşme', nextFollowUpAt: null, metContactId: null, metContact: null,
  jobCardVersion: 3,
};

function detailUrlMatches(url: string, id: string) {
  const path = url.split('?')[0] ?? url;
  return path.endsWith(`/api/job-cards/${id}`);
}

function buttonByName(host: ParentNode, name: string) {
  return Array.from(host.querySelectorAll('button'))
    .find((button) => button.textContent?.trim() === name) ?? null;
}

function committedNotice(host: ParentNode) {
  return host.querySelector<HTMLElement>('[data-job-detail-committed-refresh="true"]');
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

  emitJobUpdate(id: string) {
    const event = new MessageEvent('servora.change', {
      data: JSON.stringify({
        id,
        type: 'job.updated',
        entity: { type: 'job-card', id: 'job-1' },
        resourceKeys: ['job-detail:job-1'],
        occurredAt: '2026-11-12T10:00:00.000Z',
      }),
    });
    this.listeners.get('servora.change')?.forEach((listener) => listener(event));
  }
}

describe('JobDetail committed mutation with a failed canonical read', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('min-width'),
      media: query,
      onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })));
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function renderScreen(
    card: JobCard,
    source: FakeRealtimeEventSource,
    fetch: ReturnType<typeof vi.fn>,
    user: CurrentUser = staffUser,
  ) {
    vi.stubGlobal('fetch', fetch);
    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId={card.id} user={user} onBack={() => {}} onChanged={() => {}} />
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

  /**
   * Shared routing for the detail screens. `onDetailGet` receives the 1-based
   * detail GET ordinal, so each test can fail only its post-mutation read.
   */
  function detailFetch(
    card: JobCard,
    onDetailGet: (ordinal: number) => Promise<Response> | Response,
    patches: Array<{ url: string; body: Record<string, unknown> }> = [],
  ) {
    let detailGets = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = withoutSaleCapability(String(input));
      const method = init?.method ?? 'GET';
      if (url.endsWith('/api/notifications/read-by-entity')) return Response.json({});
      if (url.includes('/delivery-items')) return Response.json({ items: [item] });
      if (url.includes('/meeting-details') && method === 'PATCH') {
        return Response.json({ ...meetingDetails, jobCardVersion: card.version + 1 });
      }
      if (url.includes('/meeting-details')) {
        return Response.json({ ...meetingDetails, jobCardVersion: card.version });
      }
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.includes('/api/staff?')) return Response.json([]);
      if (url.endsWith(`/api/job-cards/${card.id}`) && method === 'PATCH') {
        patches.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return Response.json({ ...card, version: card.version + 1 });
      }
      if (detailUrlMatches(url, card.id)) {
        detailGets += 1;
        return onDetailGet(detailGets);
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    return { fetch, detailGets: () => detailGets, patches };
  }

  it('saveJobPatch (page): shows a committed notice and closes the editor', async () => {
    const card = meetingJob();
    const { fetch, patches, detailGets } = detailFetch(card, (ordinal) => {
      if (ordinal === 2) return Response.json({ error: 'Sunucu hatası.' }, { status: 500 });
      return Response.json(card);
    });
    await renderScreen(card, new FakeRealtimeEventSource(), fetch);

    await act(async () => {
      buttonByName(host, 'Görüşmeyi düzenle')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      (host.querySelector('form.task-form') as HTMLFormElement).requestSubmit();
      await settle();
    });

    expect(patches).toHaveLength(1);
    const notice = committedNotice(host);
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain('Görüşme bilgileri güncellendi.');
    expect(notice?.textContent).toContain('Güncel kayıt henüz yüklenemedi.');
    expect(notice?.textContent).toContain('Gösterilen bilgiler eski olabilir');
    expect(buttonByName(notice!, 'Güncel durumu yenile')).not.toBeNull();
    expect(host.querySelector('#meeting-edit-title')).toBeNull();
    expect(host.textContent).not.toContain('İş güncellenemedi.');
    expect(document.activeElement).toBe(notice);
    // A committed receipt never retries the mutation by itself.
    expect(patches).toHaveLength(1);
    expect(detailGets()).toBe(2);
  });

  it('saveJobPatch (errorOwner form): notice replaces the inline form error and owns focus', async () => {
    const card = generalTask();
    const { fetch, patches } = detailFetch(card, (ordinal) => {
      if (ordinal === 2) return Response.json({ error: 'Sunucu hatası.' }, { status: 500 });
      return Response.json(card);
    });
    await renderScreen(card, new FakeRealtimeEventSource(), fetch);

    await act(async () => {
      buttonByName(host, 'Görevi düzenle')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      (host.querySelector('form.task-form') as HTMLFormElement).requestSubmit();
      await settle();
    });

    expect(patches).toHaveLength(1);
    const notice = committedNotice(host);
    expect(notice?.textContent).toContain('Görev bilgileri güncellendi.');
    expect(notice?.textContent).toContain('Güncel kayıt henüz yüklenemedi.');
    expect(host.querySelector('form.task-form')).toBeNull();
    expect(host.querySelector('.detail-feedback-error')).toBeNull();
    expect(host.querySelector('.general-task-edit-form')).toBeNull();
    expect(host.textContent).not.toContain('Görev güncellenemedi.');
    expect(document.activeElement).toBe(notice);
  });

  it('schedule save: shows the action-specific committed notice without an inline failure', async () => {
    const card = deliveryJob();
    const { fetch, patches } = detailFetch(card, (ordinal) => {
      if (ordinal === 2) return Response.json({ error: 'Sunucu hatası.' }, { status: 500 });
      return Response.json(card);
    });
    await renderScreen(card, new FakeRealtimeEventSource(), fetch);

    await act(async () => {
      buttonByName(host, 'Değiştir')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      buttonByName(host, 'Planlanan zamanı kaydet')?.click();
      await settle();
    });

    expect(patches).toHaveLength(1);
    const notice = committedNotice(host);
    expect(notice?.textContent).toContain('Planlanan zaman güncellendi.');
    expect(notice?.textContent).toContain('Güncel kayıt henüz yüklenemedi.');
    expect(host.textContent).not.toContain('Planlanan zaman kaydedilemedi.');
    expect(document.activeElement).toBe(notice);
    // The success path keeps the schedule editor open; the stale path does too.
    expect(host.querySelector('form #job-scheduled-at')).not.toBeNull();
  });

  it('past-start acknowledgement retry clears the old form error and focuses the notice', async () => {
    const card = deliveryJob();
    const scheduled: JobCard = { ...card, version: card.version + 1 };
    let patches = 0;
    let detailGets = 0;
    const patchBodies: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = withoutSaleCapability(String(input));
      const method = init?.method ?? 'GET';
      if (url.endsWith('/api/notifications/read-by-entity')) return Response.json({});
      if (url.includes('/delivery-items')) return Response.json({ items: [item] });
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith(`/api/job-cards/${card.id}`) && method === 'PATCH') {
        patches += 1;
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        patchBodies.push(body);
        if (patches === 1) {
          return Response.json({
            error: 'Başlangıç saati geçti. Kaydetmek için müşteri onayı gerekiyor.',
            code: 'PAST_START_ACKNOWLEDGEMENT_REQUIRED',
          }, { status: 409 });
        }
        return Response.json(scheduled);
      }
      if (detailUrlMatches(url, card.id)) {
        detailGets += 1;
        if (detailGets === 2) return Response.json({ error: 'Sunucu hatası.' }, { status: 500 });
        return Response.json(card);
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    await renderScreen(card, new FakeRealtimeEventSource(), fetch, managerUser);

    await act(async () => {
      buttonByName(host, 'Değiştir')?.click();
      await Promise.resolve();
    });
    const saveButton = buttonByName(host, 'Planlanan zamanı kaydet') as HTMLButtonElement;
    await act(async () => {
      saveButton.focus();
      saveButton.click();
      await settle();
    });

    expect(patches).toBe(1);
    expect(host.textContent).toContain('Kaydetmek için müşteri onayı gerekiyor.');
    const drawer = host.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(drawer).not.toBeNull();
    const reasonCode = drawer.querySelector<HTMLSelectElement>('#past-start-ack-code')!;
    const reasonText = drawer.querySelector<HTMLTextAreaElement>('#past-start-ack-text')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')
        ?.set?.call(reasonCode, 'CUSTOMER_WAITING');
      reasonCode.dispatchEvent(new Event('change', { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
        ?.set?.call(reasonText, 'Müşteri güncel durumu onayladı.');
      reasonText.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      buttonByName(drawer, 'Onayla ve devam et')?.click();
      await settle();
    });

    expect(patches).toBe(2);
    expect(patchBodies[0]!.pastStartAcknowledgement).toBeUndefined();
    expect(patchBodies[1]!.pastStartAcknowledgement).toEqual({
      code: 'CUSTOMER_WAITING',
      text: 'Müşteri güncel durumu onayladı.',
    });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(host.textContent).not.toContain('Kaydetmek için müşteri onayı gerekiyor.');
    const notice = committedNotice(host);
    expect(notice?.textContent).toContain('Planlanan zaman güncellendi.');
    expect(notice?.textContent).toContain('Güncel kayıt henüz yüklenemedi.');
    expect(document.activeElement).toBe(notice);
  });

  it('a location-difference submit keeps the approval receipt in the stale heading', async () => {
    const base = deliveryJob();
    const card: JobCard = {
      ...base,
      status: 'IN_PROGRESS',
      version: 3,
      workflowContext: staffContext('IN_PROGRESS', {
        startedAt: '2026-11-12T09:00:00.000Z',
      }, {
        allowedCommands: ['SUBMIT_FOR_APPROVAL', 'CANCEL'],
        allowedActions: ['EDIT_JOB_FIELDS', 'EDIT_DELIVERY_ACTUAL_TIME', 'VIEW_NOTES'],
        submissionReadiness: null,
      }),
    };
    const submitted: JobCard = {
      ...card,
      status: 'WAITING_APPROVAL',
      version: card.version + 1,
      workflowContext: staffContext('WAITING_APPROVAL', {
        submittedAt: '2026-11-12T10:30:00.000Z',
        submittedBy: { id: staffUser.id, name: staffUser.name },
      }),
      submitLocationComparison: { outcome: 'DIFFERENT', distanceMeters: 1_250 },
    };
    let submits = 0;
    let detailGets = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = withoutSaleCapability(String(input));
      const method = init?.method ?? 'GET';
      if (url.endsWith('/api/notifications/read-by-entity')) return Response.json({});
      if (url.includes('/delivery-items')) return Response.json({ items: [item] });
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.split('?')[0]!.endsWith(`/api/job-cards/${card.id}/submit-for-approval`) && method === 'POST') {
        submits += 1;
        if (submits === 1) throw new TypeError('network');
        return Response.json(submitted);
      }
      if (detailUrlMatches(url, card.id)) {
        detailGets += 1;
        if (detailGets === 2) throw new TypeError('network');
        return Response.json(card);
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    await renderScreen(card, new FakeRealtimeEventSource(), fetch);

    await act(async () => {
      buttonByName(host, 'Kontrole gönder')?.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    const reason = Array.from(dialog.querySelectorAll<HTMLTextAreaElement>('textarea')).at(-1)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
        ?.set?.call(reason, 'Görüşme tamamlandı');
      reason.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await act(async () => {
      (dialog.querySelector('form') as HTMLFormElement).requestSubmit();
      await settle();
    });
    expect(submits).toBe(1);
    const retryDialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    await act(async () => {
      buttonByName(retryDialog, 'Özgün isteği tekrar dene')?.click();
      await settle();
    });

    expect(submits).toBe(2);
    const notice = committedNotice(host);
    expect(notice?.textContent).toContain('İş yönetici kontrolüne gönderildi.');
    expect(notice?.textContent).toContain('fark tespit edildi');
    expect(notice?.textContent).toContain('Güncel kayıt henüz yüklenemedi.');
    expect(notice?.textContent?.startsWith('İş yönetici kontrolüne gönderildi.')).toBe(true);
    expect(document.activeElement).toBe(notice);
  });

  it('lifecycle dialog command: retained retry commits, closes the dialog and shows the notice', async () => {
    const card = deliveryJob();
    const cancelled: JobCard = {
      ...card,
      status: 'CANCELLED',
      version: card.version + 1,
      workflowContext: staffContext('CANCELLED', {
        cancelledAt: '2026-11-12T12:00:00.000Z',
        cancelReason: 'Müşteri vazgeçti',
        cancelledFromStatus: 'NEW',
      }, { allowedActions: [] }),
    };
    const cancelBodies: Array<Record<string, unknown>> = [];
    let cancelCalls = 0;
    let detailGets = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = withoutSaleCapability(String(input));
      const method = init?.method ?? 'GET';
      if (url.endsWith('/api/notifications/read-by-entity')) return Response.json({});
      if (url.includes('/delivery-items')) return Response.json({ items: [item] });
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith(`/api/job-cards/${card.id}/cancel`) && method === 'POST') {
        cancelCalls += 1;
        cancelBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (cancelCalls === 1) throw new TypeError('network');
        return Response.json(cancelled);
      }
      if (detailUrlMatches(url, card.id)) {
        detailGets += 1;
        if (detailGets === 2) throw new TypeError('network');
        return Response.json(card);
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    await renderScreen(card, new FakeRealtimeEventSource(), fetch);

    await act(async () => {
      buttonByName(host, 'İşi iptal et')?.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    const reason = Array.from(dialog.querySelectorAll<HTMLTextAreaElement>('textarea')).at(-1)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
        ?.set?.call(reason, 'Müşteri vazgeçti');
      reason.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await act(async () => {
      buttonByName(dialog, 'İşi iptal et')?.click();
      await settle();
    });

    // The ambiguous transport loss keeps the frozen attempt for an identical retry.
    expect(cancelCalls).toBe(1);
    const retryDialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(buttonByName(retryDialog, 'Özgün isteği tekrar dene')).not.toBeNull();
    await act(async () => {
      buttonByName(retryDialog, 'Özgün isteği tekrar dene')?.click();
      await settle();
    });

    expect(cancelCalls).toBe(2);
    expect(cancelBodies[1]!.clientActionId).toBe(cancelBodies[0]!.clientActionId);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    const notice = committedNotice(host);
    expect(notice?.textContent).toContain('İş iptal edildi.');
    expect(notice?.textContent).toContain('Güncel kayıt henüz yüklenemedi.');
    expect(host.textContent).not.toContain('İşlem tamamlanamadı');
    expect(document.activeElement).toBe(notice);
    expect(detailGets).toBe(2);
  });

  it('saveMeeting: keeps the committed receipt out of the child error state and locks the form', async () => {
    const card = meetingJob();
    let meetingPatches = 0;
    let detailGets = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = withoutSaleCapability(String(input));
      const method = init?.method ?? 'GET';
      if (url.endsWith('/api/notifications/read-by-entity')) return Response.json({});
      if (url === '/api/customers/c1') return Response.json(customerPayload);
      if (url === '/api/customers/c1/enrichment') {
        return Response.json({ canEnrich: false, canCreateContact: false });
      }
      if (url.includes('/delivery-items')) return Response.json({ items: [item] });
      if (url.includes('/meeting-details') && method === 'PATCH') {
        meetingPatches += 1;
        return Response.json({ ...meetingDetails, jobCardVersion: card.version + 1 });
      }
      if (url.includes('/meeting-details')) {
        return Response.json({ ...meetingDetails, jobCardVersion: card.version });
      }
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (detailUrlMatches(url, card.id)) {
        detailGets += 1;
        if (detailGets === 2) return Response.json({ error: 'Sunucu hatası.' }, { status: 500 });
        return Response.json(card);
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    await renderScreen(card, new FakeRealtimeEventSource(), fetch);

    // The contact request is satisfied, so the section has no unrelated alert.
    expect(host.querySelectorAll('.meeting-details [role="alert"]')).toHaveLength(0);
    const summary = host.querySelector('#meeting-summary') as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
        ?.set?.call(summary, 'Güncel görüşme özeti');
      summary.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      buttonByName(host, 'Görüşme sonucunu kaydet')?.click();
      await settle();
    });

    expect(meetingPatches).toBe(1);
    const notice = committedNotice(host);
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain('Görüşme sonucu kaydedildi.');
    expect(notice?.textContent).toContain('Güncel kayıt henüz yüklenemedi.');
    expect(host.textContent).not.toContain('Görüşme sonucu kaydedilemedi.');
    expect(document.activeElement).toBe(notice);
    // The page notice owns this receipt, so the meeting section skips its own
    // success note: the result is announced in exactly one status region.
    expect(host.querySelector('.meeting-details > .detail-feedback')).toBeNull();
    expect(Array.from(host.querySelectorAll('[role="status"]'))
      .filter((region) => region.textContent?.includes('Görüşme sonucu kaydedildi.'))).toHaveLength(1);
    expect(styles).not.toMatch(/\.meeting-details > \.detail-feedback \{[^}]*display: none/);

    // The stale record locks the section: the save control is disabled and no
    // validation or contact alert appears while the notice is up.
    const staleSave = host.querySelector<HTMLButtonElement>('.meeting-result-form button[type="submit"]')!;
    expect(staleSave).not.toBeNull();
    expect(staleSave.textContent).toBe('Kaydediliyor…');
    expect(staleSave.disabled).toBe(true);
    expect(host.querySelectorAll('.meeting-details [role="alert"]')).toHaveLength(0);
    expect(host.textContent).not.toContain('İlgili kişiler yüklenemedi');

    await act(async () => {
      buttonByName(notice!, 'Güncel durumu yenile')?.click();
      await settle();
    });

    expect(committedNotice(host)).toBeNull();
    const enabledSave = buttonByName(host, 'Görüşme sonucunu kaydet') as HTMLButtonElement;
    expect(enabledSave).not.toBeNull();
    expect(enabledSave.disabled).toBe(false);

    // A later local validation error in the section stays visible and is the
    // only section alert: the exact summary bound owns the message.
    const reloadedSummary = host.querySelector('#meeting-summary') as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
        ?.set?.call(reloadedSummary, 'x'.repeat(4001));
      reloadedSummary.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      buttonByName(host, 'Görüşme sonucunu kaydet')?.click();
      await settle();
    });
    expect(meetingPatches).toBe(1);
    const alerts = host.querySelectorAll<HTMLElement>('.meeting-details [role="alert"]');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.textContent).toBe('Görüşme sonucunu kaydetmeden önce işaretli alanı düzeltin.');
    expect(host.querySelector('.meeting-details #meeting-summary-error')?.textContent)
      .toBe('Görüşme özeti en fazla 4.000 karakter olabilir.');
    expect(host.textContent).not.toContain('İlgili kişiler yüklenemedi');
    expect(host.querySelector('.meeting-details > .detail-feedback')?.textContent)
      .toContain('Görüşme sonucunu kaydetmeden önce işaretli alanı düzeltin.');
  });

  it('saveJobPatch (page): a 403 on the post-commit read ends in the access-lost state, not a mutation failure', async () => {
    const card = meetingJob();
    const { fetch, patches } = detailFetch(card, (ordinal) => {
      if (ordinal === 2) return Response.json({ error: 'Bu işe erişiminiz yok.', code: 'FORBIDDEN' }, { status: 403 });
      return Response.json(card);
    });
    await renderScreen(card, new FakeRealtimeEventSource(), fetch);

    await act(async () => {
      buttonByName(host, 'Görüşmeyi düzenle')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      (host.querySelector('form.task-form') as HTMLFormElement).requestSubmit();
      await settle();
    });

    expect(patches).toHaveLength(1);
    expect(committedNotice(host)).toBeNull();
    expect(host.textContent).toContain('İşlem kaydedildi. İşin güncel kaydına artık erişilemiyor.');
    expect(host.textContent).not.toContain('Görüşme bilgileri güncellendi.');
    expect(host.textContent).not.toContain('İş güncellenemedi.');
    expect(host.textContent).not.toContain('Güncel kayıt henüz yüklenemedi.');
    // The stale record must not stay on screen and the mutation is not retried.
    expect(host.querySelector('[data-job-detail="true"]')).toBeNull();
    expect(host.querySelector('[data-job-decision-panel="true"]')).toBeNull();
    expect(host.querySelector('#meeting-edit-title')).toBeNull();
    expect(buttonByName(host, 'Tekrar dene')).toBeNull();
    expect(patches).toHaveLength(1);
  });

  it('saveJobPatch (errorOwner form): a 404 on the post-commit read never reaches the form as a field error', async () => {
    const card = generalTask();
    const { fetch, patches } = detailFetch(card, (ordinal) => {
      if (ordinal === 2) return Response.json({ error: 'İş bulunamadı.', code: 'NOT_FOUND' }, { status: 404 });
      return Response.json(card);
    });
    await renderScreen(card, new FakeRealtimeEventSource(), fetch);

    await act(async () => {
      buttonByName(host, 'Görevi düzenle')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      (host.querySelector('form.task-form') as HTMLFormElement).requestSubmit();
      await settle();
    });

    expect(patches).toHaveLength(1);
    expect(committedNotice(host)).toBeNull();
    expect(host.textContent).toContain('İşlem kaydedildi. İşin güncel kaydına artık erişilemiyor.');
    expect(host.querySelector('.general-task-edit-form')).toBeNull();
    expect(host.querySelector('form.task-form')).toBeNull();
    expect(host.textContent).not.toContain('İş bulunamadı.');
    expect(host.textContent).not.toContain('İş güncellenemedi.');
  });

  it('lifecycle dialog command: a 403 on the post-commit read ends in the access-lost state', async () => {
    const card = deliveryJob();
    const cancelled: JobCard = {
      ...card,
      status: 'CANCELLED',
      version: card.version + 1,
      workflowContext: staffContext('CANCELLED', {
        cancelledAt: '2026-11-12T12:00:00.000Z',
        cancelReason: 'Müşteri vazgeçti',
        cancelledFromStatus: 'NEW',
      }, { allowedActions: [] }),
    };
    let cancelCalls = 0;
    let detailGets = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = withoutSaleCapability(String(input));
      const method = init?.method ?? 'GET';
      if (url.endsWith('/api/notifications/read-by-entity')) return Response.json({});
      if (url.includes('/delivery-items')) return Response.json({ items: [item] });
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith(`/api/job-cards/${card.id}/cancel`) && method === 'POST') {
        cancelCalls += 1;
        if (cancelCalls === 1) throw new TypeError('network');
        return Response.json(cancelled);
      }
      if (detailUrlMatches(url, card.id)) {
        detailGets += 1;
        if (detailGets === 2) return Response.json({ error: 'Bu işe erişiminiz yok.', code: 'FORBIDDEN' }, { status: 403 });
        return Response.json(card);
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    await renderScreen(card, new FakeRealtimeEventSource(), fetch);

    await act(async () => {
      buttonByName(host, 'İşi iptal et')?.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    const reason = Array.from(dialog.querySelectorAll<HTMLTextAreaElement>('textarea')).at(-1)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
        ?.set?.call(reason, 'Müşteri vazgeçti');
      reason.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await act(async () => {
      buttonByName(dialog, 'İşi iptal et')?.click();
      await settle();
    });
    const retryDialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    await act(async () => {
      buttonByName(retryDialog, 'Özgün isteği tekrar dene')?.click();
      await settle();
    });

    // The exact retained attempt was replayed once; the failed read never
    // re-sends it and never renders the old record as a live one.
    expect(cancelCalls).toBe(2);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(committedNotice(host)).toBeNull();
    expect(host.textContent).toContain('İşlem kaydedildi. İşin güncel kaydına artık erişilemiyor.');
    expect(host.textContent).not.toContain('İş iptal edildi.');
    expect(host.textContent).not.toContain('İşlem tamamlanamadı');
    expect(host.querySelector('[data-job-detail="true"]')).toBeNull();
  });

  it('saveMeeting: a 404 on the post-commit read ends in the access-lost state without a section error', async () => {
    const card = meetingJob();
    let meetingPatches = 0;
    let detailGets = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = withoutSaleCapability(String(input));
      const method = init?.method ?? 'GET';
      if (url.endsWith('/api/notifications/read-by-entity')) return Response.json({});
      if (url.includes('/delivery-items')) return Response.json({ items: [item] });
      if (url.includes('/meeting-details') && method === 'PATCH') {
        meetingPatches += 1;
        return Response.json({ ...meetingDetails, jobCardVersion: card.version + 1 });
      }
      if (url.includes('/meeting-details')) {
        return Response.json({ ...meetingDetails, jobCardVersion: card.version });
      }
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (detailUrlMatches(url, card.id)) {
        detailGets += 1;
        if (detailGets === 2) return Response.json({ error: 'İş bulunamadı.', code: 'NOT_FOUND' }, { status: 404 });
        return Response.json(card);
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    await renderScreen(card, new FakeRealtimeEventSource(), fetch);

    const summary = host.querySelector('#meeting-summary') as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
        ?.set?.call(summary, 'Güncel görüşme özeti');
      summary.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      buttonByName(host, 'Görüşme sonucunu kaydet')?.click();
      await settle();
    });

    expect(meetingPatches).toBe(1);
    expect(committedNotice(host)).toBeNull();
    expect(host.textContent).toContain('İşlem kaydedildi. İşin güncel kaydına artık erişilemiyor.');
    expect(host.textContent).not.toContain('Görüşme sonucu kaydedildi.');
    expect(host.textContent).not.toContain('Görüşme sonucu kaydedilemedi.');
    expect(host.querySelector('.meeting-details')).toBeNull();
  });

  it('a 403 on the post-commit realtime drain ends in the access-lost state', async () => {
    const card = generalTask();
    const source = new FakeRealtimeEventSource();
    const { fetch, patches, detailGets } = detailFetch(card, (ordinal) => {
      if (ordinal === 2) {
        // The invalidation arrives while the canonical read is in flight, so
        // the drain owns the next post-commit read.
        source.emitJobUpdate('1');
        return Response.json(card);
      }
      if (ordinal === 3) {
        return Response.json({ error: 'Bu işe erişiminiz yok.', code: 'FORBIDDEN' }, { status: 403 });
      }
      return Response.json(card);
    });
    await renderScreen(card, source, fetch);

    await act(async () => {
      buttonByName(host, 'Görevi düzenle')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      (host.querySelector('form.task-form') as HTMLFormElement).requestSubmit();
      await settle();
    });

    expect(patches).toHaveLength(1);
    expect(detailGets()).toBe(3);
    expect(committedNotice(host)).toBeNull();
    expect(host.textContent).toContain('İşlem kaydedildi. İşin güncel kaydına artık erişilemiyor.');
    expect(host.textContent).not.toContain('Görev bilgileri güncellendi.');
    expect(host.textContent).not.toContain('Güncel kayıt henüz yüklenemedi.');
    // The stale record is never left on screen and nothing is retried.
    expect(host.querySelector('[data-job-detail="true"]')).toBeNull();
    expect(buttonByName(host, 'Tekrar dene')).toBeNull();
    expect(patches).toHaveLength(1);
  });

  it('a 404 on the post-commit realtime drain keeps the committed access-lost message', async () => {
    const card = generalTask();
    const source = new FakeRealtimeEventSource();
    const { fetch, patches } = detailFetch(card, (ordinal) => {
      if (ordinal === 2) {
        source.emitJobUpdate('1');
        return Response.json(card);
      }
      if (ordinal === 3) {
        return Response.json({ error: 'İş bulunamadı.', code: 'NOT_FOUND' }, { status: 404 });
      }
      return Response.json(card);
    });
    await renderScreen(card, source, fetch);

    await act(async () => {
      buttonByName(host, 'Görevi düzenle')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      (host.querySelector('form.task-form') as HTMLFormElement).requestSubmit();
      await settle();
    });

    expect(patches).toHaveLength(1);
    expect(committedNotice(host)).toBeNull();
    expect(host.textContent).toContain('İşlem kaydedildi. İşin güncel kaydına artık erişilemiyor.');
    expect(host.textContent).not.toContain('İş bulunamadı.');
    expect(host.textContent).not.toContain('Güncel kayıt henüz yüklenemedi.');
  });

  it('an access-lost read after a committed lifecycle retry clears the retained attempt and dialog', async () => {
    const card = deliveryJob();
    const cancelled: JobCard = {
      ...card,
      status: 'CANCELLED',
      version: card.version + 1,
      workflowContext: staffContext('CANCELLED', {
        cancelledAt: '2026-11-12T12:00:00.000Z',
        cancelReason: 'Müşteri vazgeçti',
        cancelledFromStatus: 'NEW',
      }, { allowedActions: [] }),
    };
    const source = new FakeRealtimeEventSource();
    let cancelCalls = 0;
    let detailGets = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = withoutSaleCapability(String(input));
      const method = init?.method ?? 'GET';
      if (url.endsWith('/api/notifications/read-by-entity')) return Response.json({});
      if (url.includes('/delivery-items')) return Response.json({ items: [item] });
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith(`/api/job-cards/${card.id}/cancel`) && method === 'POST') {
        cancelCalls += 1;
        if (cancelCalls === 1) throw new TypeError('network');
        return Response.json(cancelled);
      }
      if (detailUrlMatches(url, card.id)) {
        detailGets += 1;
        if (detailGets === 2) {
          return Response.json({ error: 'Bu işe erişiminiz yok.', code: 'FORBIDDEN' }, { status: 403 });
        }
        return Response.json(detailGets === 1 ? card : cancelled);
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    await renderScreen(card, source, fetch);

    await act(async () => {
      buttonByName(host, 'İşi iptal et')?.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    const reason = Array.from(dialog.querySelectorAll<HTMLTextAreaElement>('textarea')).at(-1)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
        ?.set?.call(reason, 'Müşteri vazgeçti');
      reason.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await act(async () => {
      buttonByName(dialog, 'İşi iptal et')?.click();
      await settle();
    });
    const retryDialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    await act(async () => {
      buttonByName(retryDialog, 'Özgün isteği tekrar dene')?.click();
      await settle();
    });

    // The exact retained attempt was replayed once; the lost read closes it.
    expect(cancelCalls).toBe(2);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(buttonByName(host, 'Özgün isteği tekrar dene')).toBeNull();
    expect(host.querySelector('[data-original-retry]')).toBeNull();
    expect(host.textContent).toContain('İşlem kaydedildi. İşin güncel kaydına artık erişilemiyor.');

    // A later successful realtime read cannot resurrect the dialog or the
    // retained "retry the original request" control.
    await act(async () => {
      source.emitJobUpdate('2');
      await settle();
    });
    expect(cancelCalls).toBe(2);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(buttonByName(host, 'Özgün isteği tekrar dene')).toBeNull();
    expect(host.querySelector('[data-original-retry]')).toBeNull();
    expect(host.textContent).not.toContain('İşlem tamamlanamadı');
  });

  it('the committed-stale notice locks invalidation and early-start actions', async () => {
    const card: JobCard = {
      ...deliveryJob(),
      scheduledAt: '2999-01-01T09:00:00.000Z',
      scheduledEndsAt: '2999-01-01T09:30:00.000Z',
    };
    const newest: JobCard = { ...card, version: card.version + 1 };
    const { fetch, patches } = detailFetch(card, (ordinal) => {
      if (ordinal === 1) return Response.json(card);
      if (ordinal === 2) return Response.json({ error: 'Sunucu hatası.' }, { status: 500 });
      return Response.json(newest);
    });
    await renderScreen(card, new FakeRealtimeEventSource(), fetch, adminUser);

    // Open both surfaces before the save so their disabled state is visible.
    await act(async () => {
      buttonByName(host, 'Geçersiz olarak işaretle')?.click();
      await Promise.resolve();
    });
    const reasonSelect = host.querySelector<HTMLSelectElement>('#job-invalidation-reason')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')
        ?.set?.call(reasonSelect, 'DUPLICATE');
      reasonSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      buttonByName(host, 'Erken başlamaya izin ver')?.click();
      await Promise.resolve();
    });
    expect((buttonByName(host, 'Devam et') as HTMLButtonElement).disabled).toBe(false);
    expect((buttonByName(host, 'Erken başlama iznini kaydet') as HTMLButtonElement).disabled).toBe(false);

    // The confirmation's submit is the invalidation dialog's final action.
    await act(async () => {
      buttonByName(host, 'Devam et')?.click();
      await Promise.resolve();
    });
    const confirmation = host.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(confirmation).not.toBeNull();
    expect((buttonByName(confirmation, 'Geçersiz olarak işaretle') as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      buttonByName(host, 'Değiştir')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      buttonByName(host, 'Planlanan zamanı kaydet')?.click();
      await settle();
    });

    const notice = committedNotice(host);
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain('Planlanan zaman güncellendi.');
    expect(patches).toHaveLength(1);
    const invalidationTrigger = buttonByName(host, 'Formu kapat') as HTMLButtonElement;
    expect(invalidationTrigger).not.toBeNull();
    expect(invalidationTrigger.disabled).toBe(true);
    expect((buttonByName(host, 'Devam et') as HTMLButtonElement).disabled).toBe(true);
    const staleConfirm = buttonByName(
      host.querySelector<HTMLElement>('[role="dialog"]')!, 'Geçersiz olarak işaretle',
    ) as HTMLButtonElement;
    expect(staleConfirm).not.toBeNull();
    expect(staleConfirm.disabled).toBe(true);
    const reveal = buttonByName(host, 'Erken başlamaya izin ver') as HTMLButtonElement;
    expect(reveal).not.toBeNull();
    expect(reveal.disabled).toBe(true);
    expect((buttonByName(host, 'Erken başlama iznini kaydet') as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      buttonByName(notice!, 'Güncel durumu yenile')?.click();
      await settle();
    });

    expect(committedNotice(host)).toBeNull();
    expect(host.textContent).toContain('Planlanan zaman güncellendi.');
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect((buttonByName(host, 'Geçersiz olarak işaretle') as HTMLButtonElement).disabled).toBe(false);
    const unlockedReveal = buttonByName(host, 'Erken başlamaya izin ver') as HTMLButtonElement;
    expect(unlockedReveal).not.toBeNull();
    expect(unlockedReveal.disabled).toBe(false);
    expect(patches).toHaveLength(1);
  });

  it('mutation 400 and 403 still fail inline without a committed notice', async () => {
    for (const [status, code, message] of [
      [400, 'VALIDATION_ERROR', 'Görev başlığı geçersiz.'],
      [403, 'FORBIDDEN', 'Bu işlem için yetkiniz bulunmuyor.'],
    ] as const) {
      const card = generalTask();
      const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = withoutSaleCapability(String(input));
        const method = init?.method ?? 'GET';
        if (url.endsWith('/api/notifications/read-by-entity')) return Response.json({});
        if (url.includes('/notes?')) return Response.json(emptyPage);
        if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
        if (url.endsWith(`/api/job-cards/${card.id}`) && method === 'PATCH') {
          return Response.json({ error: message, code }, { status });
        }
        if (detailUrlMatches(url, card.id)) return Response.json(card);
        throw new Error(`Unexpected request: ${method} ${url}`);
      });
      const source = new FakeRealtimeEventSource();
      await renderScreen(card, source, fetch);
      await act(async () => {
        buttonByName(host, 'Görevi düzenle')?.click();
        await Promise.resolve();
      });
      await act(async () => {
        (host.querySelector('form.task-form') as HTMLFormElement).requestSubmit();
        await settle();
      });
      expect(committedNotice(host)).toBeNull();
      expect(host.querySelector('.general-task-edit-form')).not.toBeNull();
      expect(host.querySelector('.general-task-edit-form')?.textContent).toContain(message);
      await act(async () => root.unmount());
      root = createRoot(host);
      host.replaceChildren();
    }
  });

  it('mutation 409 keeps the existing conflict resolution path', async () => {
    const card = generalTask();
    const newer: JobCard = { ...card, version: 4, title: 'Başka işlemle güncellenen görev' };
    let patches = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = withoutSaleCapability(String(input));
      const method = init?.method ?? 'GET';
      if (url.endsWith('/api/notifications/read-by-entity')) return Response.json({});
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith(`/api/job-cards/${card.id}`) && method === 'PATCH') {
        patches += 1;
        return Response.json({ error: 'İş başka bir işlemle güncellendi.', code: 'VERSION_CONFLICT' }, { status: 409 });
      }
      if (detailUrlMatches(url, card.id)) return Response.json(newer);
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    await renderScreen(card, new FakeRealtimeEventSource(), fetch);
    await act(async () => {
      buttonByName(host, 'Görevi düzenle')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      (host.querySelector('form.task-form') as HTMLFormElement).requestSubmit();
      await settle();
    });

    expect(patches).toBe(1);
    expect(committedNotice(host)).toBeNull();
    expect(host.textContent).toContain('İş başka bir işlemle güncellendi. En güncel durum gösteriliyor.');
    expect(host.textContent).toContain('Başka işlemle güncellenen görev');
  });

  it('retry uses the serialized reload, performs no mutation and clears the notice', async () => {
    const card = generalTask();
    const newest: JobCard = { ...card, version: 5, title: 'Yenilemeden sonraki güncel görev' };
    const { fetch, patches, detailGets } = detailFetch(card, (ordinal) => {
      if (ordinal === 2) throw new TypeError('network');
      return Response.json(newest);
    });
    await renderScreen(card, new FakeRealtimeEventSource(), fetch);

    await act(async () => {
      buttonByName(host, 'Görevi düzenle')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      (host.querySelector('form.task-form') as HTMLFormElement).requestSubmit();
      await settle();
    });
    expect(committedNotice(host)).not.toBeNull();
    const patchesBeforeRetry = patches.length;

    await act(async () => {
      buttonByName(committedNotice(host)!, 'Güncel durumu yenile')?.click();
      await settle();
    });

    expect(committedNotice(host)).toBeNull();
    expect(host.textContent).toContain('Yenilemeden sonraki güncel görev');
    expect(patches).toHaveLength(patchesBeforeRetry);
    expect(detailGets()).toBe(3);
  });

  it('a failed retry keeps the committed notice as the only status region', async () => {
    const card = generalTask();
    const { fetch, patches, detailGets } = detailFetch(card, (ordinal) => {
      if (ordinal === 1) return Response.json(card);
      if (ordinal === 2) throw new TypeError('network');
      return Response.json({ error: 'Sunucu hatası.' }, { status: 500 });
    });
    await renderScreen(card, new FakeRealtimeEventSource(), fetch);

    await act(async () => {
      buttonByName(host, 'Görevi düzenle')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      (host.querySelector('form.task-form') as HTMLFormElement).requestSubmit();
      await settle();
    });
    expect(committedNotice(host)).not.toBeNull();

    await act(async () => {
      buttonByName(committedNotice(host)!, 'Güncel durumu yenile')?.click();
      await settle();
    });

    const notice = committedNotice(host);
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain('Güncel kayıt henüz yüklenemedi.');
    expect(host.textContent).not.toContain('Bu iş başka bir oturumda güncellendi');
    expect(host.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(patches).toHaveLength(1);
  });

  it('a realtime invalidation during the retry cannot roll the record back', async () => {
    const card = generalTask();
    const older: JobCard = { ...card, version: 4, title: 'Ara kayıt' };
    const newest: JobCard = { ...card, version: 5, title: 'En güncel kayıt' };
    const source = new FakeRealtimeEventSource();
    let retryGateOpened = false;
    let releaseRetryGet: (value: Response) => void = () => {};
    const retryGet = new Promise<Response>((resolve) => { releaseRetryGet = resolve; });
    let detailGets = 0;
    const { fetch, patches } = detailFetch(card, (ordinal) => {
      detailGets = ordinal;
      if (ordinal === 2) throw new TypeError('network');
      if (ordinal === 3) {
        retryGateOpened = true;
        return retryGet;
      }
      return Response.json(newest);
    });
    await renderScreen(card, source, fetch);

    await act(async () => {
      buttonByName(host, 'Görevi düzenle')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      (host.querySelector('form.task-form') as HTMLFormElement).requestSubmit();
      await settle();
    });
    expect(committedNotice(host)).not.toBeNull();

    await act(async () => {
      buttonByName(committedNotice(host)!, 'Güncel durumu yenile')?.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(retryGateOpened).toBe(true);
    await act(async () => {
      source.emitJobUpdate('1');
      await Promise.resolve();
    });
    await act(async () => {
      releaseRetryGet(Response.json(older));
      await settle();
    });

    expect(host.textContent).toContain('En güncel kayıt');
    expect(host.textContent).not.toContain('Ara kayıt');
    expect(committedNotice(host)).toBeNull();
    expect(patches).toHaveLength(1);
    expect(detailGets).toBe(4);
  });

  it('a late realtime invalidation resolves the committed notice into the normal success message', async () => {
    const card = generalTask();
    const newest: JobCard = { ...card, version: 6, title: 'Yenilenen güncel görev' };
    const source = new FakeRealtimeEventSource();
    const { fetch, patches, detailGets } = detailFetch(card, (ordinal) => {
      if (ordinal === 2) {
        source.emitJobUpdate('1');
        return Response.json(card);
      }
      if (ordinal === 3) return Response.json({ error: 'Sunucu hatası.' }, { status: 500 });
      return Response.json(newest);
    });
    await renderScreen(card, source, fetch);

    await act(async () => {
      buttonByName(host, 'Görevi düzenle')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      (host.querySelector('form.task-form') as HTMLFormElement).requestSubmit();
      await settle();
    });

    // The drain failed and, right after it, another invalidation arrived.
    expect(committedNotice(host)).not.toBeNull();
    await act(async () => {
      source.emitJobUpdate('2');
      await settle();
    });

    // The next serialized re-read reconciles both invalidations: the temporary
    // notice becomes the ordinary confirmation, once, with no stale heading.
    expect(committedNotice(host)).toBeNull();
    expect(host.textContent).toContain('Yenilenen güncel görev');
    expect(host.textContent).not.toContain('Güncel kayıt henüz yüklenemedi.');
    expect(Array.from(host.querySelectorAll('[role="status"]'))
      .filter((region) => region.textContent?.includes('Görev bilgileri güncellendi.'))).toHaveLength(1);
    expect(patches).toHaveLength(1);
    expect(detailGets()).toBe(4);
  });

  it('a committed-stale record cannot start new critical actions until the reload clears it', async () => {
    const card = generalTask();
    const newest: JobCard = { ...card, version: 6, title: 'Yenilemeden sonraki güncel görev' };
    const { fetch, patches } = detailFetch(card, (ordinal) => {
      if (ordinal === 2) throw new TypeError('network');
      return Response.json(newest);
    });
    await renderScreen(card, new FakeRealtimeEventSource(), fetch);

    await act(async () => {
      buttonByName(host, 'Görevi düzenle')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      (host.querySelector('form.task-form') as HTMLFormElement).requestSubmit();
      await settle();
    });

    const notice = committedNotice(host);
    expect(notice).not.toBeNull();
    expect(patches).toHaveLength(1);
    const lockedActions = Array.from(
      host.querySelectorAll<HTMLButtonElement>('[data-job-decision-panel="true"] button'),
    );
    expect(lockedActions.length).toBeGreaterThan(0);
    expect(lockedActions.every((button) => button.disabled)).toBe(true);
    const editButton = host.querySelector<HTMLButtonElement>('.detail-action-record-edit button');
    expect(editButton).not.toBeNull();
    expect(editButton!.disabled).toBe(true);
    const reload = buttonByName(notice!, 'Güncel durumu yenile') as HTMLButtonElement;
    expect(reload).not.toBeNull();
    expect(reload.disabled).toBe(false);

    await act(async () => {
      reload.click();
      await settle();
    });

    expect(committedNotice(host)).toBeNull();
    expect(host.textContent).toContain('Yenilemeden sonraki güncel görev');
    const unlockedEdit = host.querySelector<HTMLButtonElement>('.detail-action-record-edit button');
    expect(unlockedEdit).not.toBeNull();
    expect(unlockedEdit!.disabled).toBe(false);
    expect(unlockedEdit!.textContent).toContain('Görevi düzenle');
    expect(Array.from(host.querySelectorAll<HTMLButtonElement>('[data-job-decision-panel="true"] button'))
      .every((button) => !button.disabled)).toBe(true);
    expect(patches).toHaveLength(1);
  });

  it('saveJobPatch: a failed realtime drain after a fresh read keeps the committed receipt', async () => {
    const card = generalTask();
    const source = new FakeRealtimeEventSource();
    const { fetch, patches, detailGets } = detailFetch(card, (ordinal) => {
      if (ordinal === 2) {
        // The invalidation arrives while the canonical issued re-read is in
        // flight, so that read cannot reconcile it; the drain must.
        source.emitJobUpdate('1');
        return Response.json(card);
      }
      if (ordinal === 3) return Response.json({ error: 'Sunucu hatası.' }, { status: 500 });
      return Response.json(card);
    });
    await renderScreen(card, source, fetch);

    await act(async () => {
      buttonByName(host, 'Görevi düzenle')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      (host.querySelector('form.task-form') as HTMLFormElement).requestSubmit();
      await settle();
    });

    expect(patches).toHaveLength(1);
    const notice = committedNotice(host);
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain('Görev bilgileri güncellendi.');
    expect(notice?.textContent).toContain('Güncel kayıt henüz yüklenemedi.');
    expect(host.textContent).not.toContain('Bu iş başka bir oturumda güncellendi');
    expect(patches).toHaveLength(1);
    expect(detailGets()).toBe(3);
  });

  it('schedule save: a failed realtime drain after a fresh read keeps the committed receipt', async () => {
    const card = deliveryJob();
    const source = new FakeRealtimeEventSource();
    const { fetch, patches, detailGets } = detailFetch(card, (ordinal) => {
      if (ordinal === 2) {
        source.emitJobUpdate('1');
        return Response.json(card);
      }
      if (ordinal === 3) return Response.json({ error: 'Sunucu hatası.' }, { status: 500 });
      return Response.json(card);
    });
    await renderScreen(card, source, fetch);

    await act(async () => {
      buttonByName(host, 'Değiştir')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      buttonByName(host, 'Planlanan zamanı kaydet')?.click();
      await settle();
    });

    expect(patches).toHaveLength(1);
    const notice = committedNotice(host);
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain('Planlanan zaman güncellendi.');
    expect(notice?.textContent).toContain('Güncel kayıt henüz yüklenemedi.');
    expect(host.textContent).not.toContain('Planlanan zaman kaydedilemedi.');
    expect(host.textContent).not.toContain('Bu iş başka bir oturumda güncellendi');
    expect(patches).toHaveLength(1);
    expect(detailGets()).toBe(3);
  });

  it('single delivered-at save: committed with a failed read shows the action receipt', async () => {
    const card = deliveryJob();
    const pendingItem: DeliveryItem = {
      ...item, id: 'i1', productNameSnapshot: 'İmplant Seti', deliveredAt: null,
    };
    let itemPatches = 0;
    let detailGets = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = withoutSaleCapability(String(input));
      const method = init?.method ?? 'GET';
      if (url.endsWith('/api/notifications/read-by-entity')) return Response.json({});
      if (url.endsWith('/delivery-items/i1') && method === 'PATCH') {
        itemPatches += 1;
        return Response.json({
          item: { ...pendingItem, deliveredAt: '2026-11-20T12:00:00.000Z' },
          jobCardVersion: card.version + 1,
        });
      }
      if (url.endsWith('/delivery-items')) return Response.json({ items: [pendingItem] });
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (detailUrlMatches(url, card.id)) {
        detailGets += 1;
        if (detailGets === 2) return Response.json({ error: 'Sunucu hatası.' }, { status: 500 });
        return Response.json(card);
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    await renderScreen(card, new FakeRealtimeEventSource(), fetch);

    const input = host.querySelector('#delivery-actual-at-i1') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
        ?.set?.call(input, '2026-11-20T12:00');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      (host.querySelector('form.delivery-actual-time-form') as HTMLFormElement).requestSubmit();
      await settle();
    });

    expect(itemPatches).toBe(1);
    const notice = committedNotice(host);
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain('Gerçekleşen teslim zamanı kaydedildi.');
    expect(notice?.textContent).toContain('Güncel kayıt henüz yüklenemedi.');
    expect(host.textContent).not.toContain('Gerçekleşen teslim zamanı kaydedilemedi.');
    expect(document.activeElement).toBe(notice);
  });

  it('batch delivered-at save: all items saved with a failed read shows the batch receipt', async () => {
    const card = deliveryJob();
    const pendingItems: DeliveryItem[] = [
      { ...item, id: 'i1', productNameSnapshot: 'İmplant Seti', deliveredAt: null },
      { ...item, id: 'i2', productNameSnapshot: 'Abutment Seti', deliveredAt: null },
    ];
    let itemPatches = 0;
    let detailGets = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = withoutSaleCapability(String(input));
      const method = init?.method ?? 'GET';
      if (url.endsWith('/api/notifications/read-by-entity')) return Response.json({});
      if (url.includes('/delivery-items/i') && method === 'PATCH') {
        itemPatches += 1;
        const target = pendingItems[itemPatches - 1]!;
        return Response.json({
          item: { ...target, deliveredAt: '2026-11-20T12:00:00.000Z' },
          jobCardVersion: card.version + itemPatches,
        });
      }
      if (url.endsWith('/delivery-items')) return Response.json({ items: pendingItems });
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (detailUrlMatches(url, card.id)) {
        detailGets += 1;
        if (detailGets === 2) return Response.json({ error: 'Sunucu hatası.' }, { status: 500 });
        return Response.json({ ...card, version: card.version + 2 });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    await renderScreen(card, new FakeRealtimeEventSource(), fetch);

    await act(async () => {
      buttonByName(host, 'Boş kalemlere şimdiki saati uygula')?.click();
      await settle();
    });

    expect(itemPatches).toBe(2);
    const notice = committedNotice(host);
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain('2 kalem için gerçekleşen teslim zamanı kaydedildi.');
    expect(notice?.textContent).toContain('Güncel kayıt henüz yüklenemedi.');
    expect(host.textContent).not.toContain('kalem kaydedilemedi');
  });

  it('batch delivered-at save: a definitive per-item error keeps the partial count message', async () => {
    const card = deliveryJob();
    const pendingItems: DeliveryItem[] = [
      { ...item, id: 'i1', productNameSnapshot: 'İmplant Seti', deliveredAt: null },
      { ...item, id: 'i2', productNameSnapshot: 'Abutment Seti', deliveredAt: null },
    ];
    let itemPatches = 0;
    let detailGets = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = withoutSaleCapability(String(input));
      const method = init?.method ?? 'GET';
      if (url.endsWith('/api/notifications/read-by-entity')) return Response.json({});
      if (url.endsWith('/delivery-items/i1') && method === 'PATCH') {
        itemPatches += 1;
        return Response.json({
          item: { ...pendingItems[0], deliveredAt: '2026-11-20T12:00:00.000Z' },
          jobCardVersion: card.version + 1,
        });
      }
      if (url.endsWith('/delivery-items/i2') && method === 'PATCH') {
        itemPatches += 1;
        return Response.json({ error: 'İş başka bir işlemle güncellendi.', code: 'VERSION_CONFLICT' }, { status: 409 });
      }
      if (url.endsWith('/delivery-items')) return Response.json({ items: pendingItems });
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (detailUrlMatches(url, card.id)) {
        detailGets += 1;
        return Response.json(card);
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    await renderScreen(card, new FakeRealtimeEventSource(), fetch);

    await act(async () => {
      buttonByName(host, 'Boş kalemlere şimdiki saati uygula')?.click();
      await settle();
    });

    expect(itemPatches).toBe(2);
    expect(detailGets).toBe(2);
    expect(committedNotice(host)).toBeNull();
    expect(host.textContent).toContain('1/2 kalem kaydedildi; sonraki adımda hata oluştu:');
    expect(host.textContent).toContain('İş başka bir işlemle güncellendi.');
    expect(host.textContent).not.toContain('doğrulanamadı');
  });

  it('batch delivered-at save: an ambiguous per-item error reports an unknown outcome without a retry', async () => {
    const card = deliveryJob();
    const pendingItems: DeliveryItem[] = [
      { ...item, id: 'i1', productNameSnapshot: 'İmplant Seti', deliveredAt: null },
      { ...item, id: 'i2', productNameSnapshot: 'Abutment Seti', deliveredAt: null },
    ];
    let itemPatches = 0;
    let detailGets = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = withoutSaleCapability(String(input));
      const method = init?.method ?? 'GET';
      if (url.endsWith('/api/notifications/read-by-entity')) return Response.json({});
      if (url.endsWith('/delivery-items/i1') && method === 'PATCH') {
        itemPatches += 1;
        return Response.json({
          item: { ...pendingItems[0], deliveredAt: '2026-11-20T12:00:00.000Z' },
          jobCardVersion: card.version + 1,
        });
      }
      if (url.endsWith('/delivery-items/i2') && method === 'PATCH') {
        itemPatches += 1;
        throw new TypeError('network');
      }
      if (url.endsWith('/delivery-items')) return Response.json({ items: pendingItems });
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (detailUrlMatches(url, card.id)) {
        detailGets += 1;
        return Response.json(card);
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    await renderScreen(card, new FakeRealtimeEventSource(), fetch);

    await act(async () => {
      buttonByName(host, 'Boş kalemlere şimdiki saati uygula')?.click();
      await settle();
    });

    // The ambiguous attempt is never retried automatically, and the unknown
    // outcome locks the batch surface until a successful reload.
    expect(itemPatches).toBe(2);
    expect(detailGets).toBe(2);
    const notice = committedNotice(host);
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain(
      '1/2 kalem kaydedildi; sonraki kalemin sonucu doğrulanamadı. Güncel kayıt henüz yüklenemedi.',
    );
    expect(host.textContent).not.toContain('Gerçekleşen teslim zamanı kaydedilemedi.');
    const batchButton = host.querySelector<HTMLButtonElement>('.delivery-bulk-action');
    expect(batchButton).not.toBeNull();
    expect(batchButton!.disabled).toBe(true);

    await act(async () => {
      buttonByName(notice!, 'Güncel durumu yenile')?.click();
      await settle();
    });

    // An unknown outcome is not a success receipt: the reload clears it and
    // the canonical record is the only truth.
    expect(committedNotice(host)).toBeNull();
    expect(host.textContent).not.toContain('için gerçekleşen teslim zamanı kaydedildi.');
    expect(itemPatches).toBe(2);
    expect((host.querySelector('.delivery-bulk-action') as HTMLButtonElement).disabled).toBe(false);
  });

  it('styles the notice with warning tokens, rem type and a 44px-class action', () => {
    const match = /\.detail-feedback\.detail-feedback-stale \{([^}]*)\}/.exec(styles);
    expect(match).not.toBeNull();
    expect(match![1]).toContain('var(--border-warning)');
    expect(match![1]).toContain('var(--warning-wash)');
    expect(match![1]).toContain('max-width: 48rem');
    expect(match![1]).toContain('gap: 0.45rem');
    const paragraph = /\.detail-feedback-stale > p \{([^}]*)\}/.exec(styles);
    expect(paragraph?.[1]).toContain('margin: 0');
    expect(paragraph?.[1]).toContain('font-size: 0.95rem');
    const button = /\.detail-feedback-stale > button \{([^}]*)\}/.exec(styles);
    expect(button?.[1]).toContain('font-size: 0.95rem');
    expect(button?.[1]).toContain('min-height: var(--control-height)');
    const icon = /\.detail-feedback-stale \.detail-feedback-stale-icon \{([^}]*)\}/.exec(styles);
    expect(icon?.[1]).toContain('width: 1em');
    expect(icon?.[1]).toContain('height: 1em');
  });
});
