/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  JobDetailPanel, JobDetailScreen, prepareMeetingEdit, runStaffJobCommand,
} from '../src/JobDetail';
import { RealtimeProvider, type RealtimeEventSource } from '../src/realtime/RealtimeProvider';
import { ApiError, type CurrentUser, type DeliveryItem } from '../src/services/api';
import type {
  JobCard, JobLifecycleFacts, JobWorkflowContext, LifecycleCommand, MeetingDetails,
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
  ...staffUser, id: 'a1', name: 'Sistem yöneticisi', role: 'ADMIN', email: 'admin@x',
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
      : (partial.lifecycle === undefined
        ? { ...workflowContext.lifecycle }
        : partial.lifecycle),
    submissionReadiness: partial.submissionReadiness === undefined
      ? workflowContext.submissionReadiness
      : partial.submissionReadiness,
    allowedCommands: partial.allowedCommands ?? workflowContext.allowedCommands,
    allowedActions: partial.allowedActions ?? workflowContext.allowedActions,
  };
}

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
  return contextWith({
    allowedCommands: extras.allowedCommands ?? commandsByStatus[status],
    allowedActions: extras.allowedActions ?? actionsByStatus[status],
    startLocationCaptureEnabled: extras.startLocationCaptureEnabled ?? false,
    lifecycle: { ...baseLifecycle, ...lifecycle },
    submissionReadiness: extras.submissionReadiness === undefined
      ? (status === 'IN_PROGRESS'
        ? {
          evaluatedAt: '2026-07-17T12:00:00.000Z',
          ready: true,
          items: [
            { code: 'MEETING_TIME_VALID', state: 'met' },
            { code: 'MEETING_OUTCOME_VALID', state: 'met' },
            { code: 'MEETING_SUMMARY_PRESENT', state: 'met' },
          ],
        }
        : null)
      : extras.submissionReadiness,
  });
}

const job: JobCard = {
  id: 'job-1', organizationId: 'org-1', type: 'PRODUCT_DELIVERY', status: 'NEW', version: 2,
  engagementKind: null,
  title: 'ABC Klinik ürün teslimi', description: null, customerId: 'c1', contactId: null,
  assignedTo: 's1', createdBy: 's1', priority: 'normal', dueDate: null,
  scheduledAt: '2026-07-20T09:00:00.000Z',
  assignee: { id: 's1', name: 'Ayşe Personel' }, customer: { id: 'c1', name: 'ABC Klinik' },
  contact: null,
  followUpContext: null,
  workflowContext: staffContext('NEW', { createdAt: '2026-07-17T08:00:00.000Z' }, {
    allowedActions: [],
    submissionReadiness: null,
  }),
};
const item: DeliveryItem = {
  id: 'i1', organizationId: 'org-1', jobCardId: 'job-1', productId: 'p1',
  deliveryPurpose: 'SAMPLE', deliveredAt: '2026-07-11T10:00:00.000Z', quantity: 2, unit: 'adet',
  productNameSnapshot: 'İmplant Seti', productSkuSnapshot: 'S1', productModelSnapshot: null,
  lotNo: null, serialNo: null, expiryDate: null, deliveryNote: null,
};
const generalTask: JobCard = {
  ...job, type: 'GENERAL_TASK', title: 'Teklif dönüşünü takip et',
  engagementKind: null,
  description: 'Doktorun kararını öğren ve sonucu karta yaz.', priority: 'high',
  dueDate: '2026-07-20', customerId: 'c1', contactId: 'contact-1',
  assignee: { id: 's1', name: 'Ayşe Personel' },
  customer: { id: 'c1', name: 'Demo Dental Klinik' },
  contact: { id: 'contact-1', name: 'Dr. Deniz' },
};

function inProgressMeeting(lifecycle: Partial<JobLifecycleFacts> = {}): JobCard {
  return {
    ...job,
    type: 'SALES_MEETING',
    engagementKind: 'SALES_MEETING',
    status: 'IN_PROGRESS',
    version: 3,
    title: 'Satış görüşmesi detayı',
    dueDate: '2026-07-20',
    workflowContext: staffContext('IN_PROGRESS', {
      startedAt: '2026-07-17T09:00:00.000Z',
      acceptedAt: null,
      acceptedBy: null,
      ...lifecycle,
    }),
  };
}

function revisionRequestedJob(opts: { revisionReason: string }): JobCard {
  return {
    ...job,
    type: 'SALES_MEETING',
    engagementKind: 'SALES_MEETING',
    status: 'REVISION_REQUESTED',
    version: 4,
    title: 'Düzeltme bekleyen görüşme',
    dueDate: '2026-07-20',
    workflowContext: staffContext('REVISION_REQUESTED', {
      startedAt: '2026-07-17T09:00:00.000Z',
      acceptedAt: '2026-07-17T08:30:00.000Z',
      acceptedBy: { id: 's1', name: 'Ayşe Personel' },
      submittedAt: '2026-07-17T10:00:00.000Z',
      revisionRequestedAt: '2026-07-17T11:00:00.000Z',
      revisionRequestedBy: { id: 'm1', name: 'Mehmet Yönetici' },
      revisionReason: opts.revisionReason,
    }),
  };
}

function cancelledJob(lifecycle: Partial<JobLifecycleFacts>): JobCard {
  return {
    ...job,
    status: 'CANCELLED',
    title: 'İptal edilen teslim',
    workflowContext: staffContext('CANCELLED', {
      startedAt: '2026-07-17T09:00:00.000Z',
      cancelledAt: '2026-07-17T12:00:00.000Z',
      cancelReason: 'Müşteri vazgeçti',
      cancelledFromStatus: 'IN_PROGRESS',
      ...lifecycle,
    }, { allowedActions: [] }),
  };
}

function invalidatedJob(): JobCard {
  return {
    ...job,
    status: 'INVALIDATED',
    invalidatedAt: '2026-07-17T12:00:00.000Z',
    invalidatedBy: 'a1',
    invalidationReasonCode: 'WRONG_CUSTOMER',
    workflowContext: contextWith({
      allowedCommands: [],
      allowedActions: ['VIEW_NOTES'],
      lifecycle: {
        ...baseLifecycle,
        invalidatedAt: '2026-07-17T12:00:00.000Z',
        invalidatedBy: { id: 'a1', name: 'Sistem yöneticisi' },
        invalidationReasonCode: 'WRONG_CUSTOMER',
        invalidatedFromStatus: 'NEW',
      },
    }),
  };
}

function waitingApprovalJob(): JobCard {
  return {
    ...job,
    status: 'WAITING_APPROVAL',
    title: 'Onay bekleyen teslim',
    workflowContext: staffContext('WAITING_APPROVAL', {
      acceptedAt: '2026-07-17T08:30:00.000Z',
      acceptedBy: { id: 's1', name: 'Ayşe Personel' },
      startedAt: '2026-07-17T09:00:00.000Z',
      submittedAt: '2026-07-17T10:00:00.000Z',
      submittedBy: { id: 's1', name: 'Ayşe Personel' },
    }),
  };
}

const emptyPage = { items: [], total: 0, limit: 25, offset: 0 };
const meetingDetails: MeetingDetails = {
  jobCardId: 'job-1', meetingAt: '2026-07-16T10:00:00.000Z', outcome: 'POSITIVE',
  meetingSummary: 'Olumlu görüşme', nextFollowUpAt: null, jobCardVersion: 3,
};

function buttonByName(host: ParentNode, name: string) {
  return Array.from(host.querySelectorAll('button'))
    .find((button) => button.textContent?.trim() === name) ?? null;
}

function mockDetailFetch(card: JobCard, options: {
  meeting?: MeetingDetails | null;
  notes?: typeof emptyPage;
} = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/delivery-items')) return Response.json({ items: card.type === 'PRODUCT_DELIVERY' ? [item] : [] });
    if (url.endsWith('/meeting-details')) {
      if (options.meeting === null) throw new Error('unexpected meeting-details');
      return Response.json(options.meeting ?? { ...meetingDetails, jobCardVersion: card.version });
    }
    if (url.includes('/notes?')) {
      if (options.notes === undefined && !card.workflowContext.allowedActions.includes('VIEW_NOTES')) {
        throw new Error('unexpected notes');
      }
      return Response.json(options.notes ?? emptyPage);
    }
    if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
    if (url.endsWith(`/api/job-cards/${card.id}`) || url.endsWith('/api/job-cards/job-1')) {
      return Response.json(card);
    }
    throw new Error(`Unexpected request: ${url}`);
  });
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
    this.emitJobUpdateFor(id, 'job-1');
  }

  emitJobUpdateFor(id: string, jobCardId: string, resourceKey = `job-detail:${jobCardId}`) {
    const event = new MessageEvent('servora.change', {
      data: JSON.stringify({
        id,
        type: 'job.updated',
        entity: { type: 'job-card', id: jobCardId },
        resourceKeys: [resourceKey],
        occurredAt: '2026-07-20T10:00:00.000Z',
      }),
    });
    this.listeners.get('servora.change')?.forEach((listener) => listener(event));
  }
}

describe('Staff JobCard detail', () => {
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

  async function renderDetail(card: JobCard, user: CurrentUser = staffUser) {
    await act(async () => {
      root.render(<JobDetailPanel
        job={card}
        items={card.type === 'PRODUCT_DELIVERY' ? [item] : []}
        user={user}
        pending={false}
        message=""
        onBack={() => {}}
        onCommand={() => {}}
      />);
    });
  }

  async function renderScreen(card: JobCard, user: CurrentUser = staffUser, fetch = mockDetailFetch(card)) {
    vi.stubGlobal('fetch', fetch);
    await act(async () => {
      root.render(<JobDetailScreen jobId={card.id} user={user} onBack={() => {}} onChanged={() => {}} />);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return fetch;
  }

  it('loads authorized JobCard detail via canonical REST and does not use push payload as job data', async () => {
    const fetch = await renderScreen(job);
    expect(host.textContent).toContain(job.title);
    expect(fetch.mock.calls.some(([input]) => String(input).endsWith(`/api/job-cards/${job.id}`))).toBe(true);
    expect(host.textContent).not.toContain('Size yeni bir iş atandı.');
  });

  it('shows the invalidation action only to Admin on an operational JobCard', async () => {
    const baseFetch = mockDetailFetch(job);
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/follow-ups')) {
        return Response.json({ items: [], total: 0, limit: 100, offset: 0 });
      }
      return baseFetch(input);
    });
    await renderScreen(job, adminUser, fetch);
    expect(host.querySelector('[data-job-invalidation="true"]')).not.toBeNull();
    expect(host.textContent).toContain('Geçersiz olarak işaretle');
  });

  it('does not render the Admin invalidation action for Manager or Staff', async () => {
    await renderScreen(job, managerUser);
    expect(host.querySelector('[data-job-invalidation="true"]')).toBeNull();
  });

  it('shows canonical not-found error without rendering push title/body as job content', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/job-cards/')) {
        return new Response(JSON.stringify({
          code: 'JOB_CARD_NOT_FOUND',
          error: 'JobCard bulunamadı.',
        }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`Unexpected request: ${input}`);
    });
    vi.stubGlobal('fetch', fetch);
    await act(async () => {
      root.render(
        <JobDetailScreen
          jobId="22222222-2222-4222-8222-222222222222"
          user={staffUser}
          onBack={() => {}}
          onChanged={() => {}}
        />,
      );
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain('İş yüklenemedi');
    expect(host.textContent).toContain('JobCard bulunamadı.');
    expect(host.textContent).not.toContain('Yeni iş atandı');
    expect(host.textContent).not.toContain('Size yeni bir iş atandı.');
    expect(host.querySelector('.job-detail-content')).toBeNull();
  });

  it('treats unauthorized/cross-tenant JobCard responses as opaque not-found without job data', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/job-cards/')) {
        // Backend uses opaque not-found for unauthorized/cross-tenant access.
        return new Response(JSON.stringify({
          code: 'JOB_CARD_NOT_FOUND',
          error: 'JobCard bulunamadı.',
        }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`Unexpected request: ${input}`);
    });
    vi.stubGlobal('fetch', fetch);
    await act(async () => {
      root.render(
        <JobDetailScreen
          jobId="33333333-3333-4333-8333-333333333333"
          user={staffUser}
          onBack={() => {}}
          onChanged={() => {}}
        />,
      );
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain('İş yüklenemedi');
    expect(host.textContent).not.toContain('ABC Klinik ürün teslimi');
    expect(host.querySelector('.job-detail-content')).toBeNull();
  });

  async function renderRealtimeScreen(card: JobCard, source: FakeRealtimeEventSource, fetch = mockDetailFetch(card)) {
    vi.stubGlobal('fetch', fetch);
    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId={card.id} user={staffUser} onBack={() => {}} onChanged={() => {}} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return fetch;
  }

  it('renders missing acceptance and staff responsibility before structured records', async () => {
    const card = inProgressMeeting({ acceptedAt: null, startedAt: '2026-07-17T09:00:00.000Z' });
    await renderDetail(card);
    expect(host.querySelector('h1')?.textContent).toBe(card.title);
    const steps = host.querySelector('.servora-workflow-steps');
    expect(steps).not.toBeNull();
    const list = steps?.querySelector(
      'ol[aria-label="İş süreci"], [role="list"][aria-label="İş süreci"]',
    );
    expect(list).not.toBeNull();
    const listItems = list?.querySelectorAll('li, [role="listitem"]');
    expect((listItems?.length ?? 0) >= 1).toBe(true);
    expect(
      Array.from(listItems ?? []).filter(
        (item) => item.getAttribute('aria-current') === 'step',
      ),
    ).toHaveLength(1);
    expect(steps?.textContent).toContain('Kabul bilgisi kaydedilmemiş');
    expect(steps?.textContent).not.toContain('Planlama atlandı');
    const current = list?.querySelector('[aria-current="step"]');
    expect(current?.textContent).toContain('Uygulanıyor');
    expect(host.querySelector('h2')?.textContent === 'Şimdi sizden beklenen'
      || Array.from(host.querySelectorAll('h2')).some((el) => el.textContent === 'Şimdi sizden beklenen')).toBe(true);
    expect(host.textContent).toContain(
      'İş yönetici kontrolüne geçecek ve kontrol sona erene kadar kayıtlar düzenlenemeyecektir.',
    );
    expect(buttonByName(host, 'Kontrole gönder')).not.toBeNull();
    expect(host.querySelector('.servora-record-descriptions[aria-label="İş kayıt bilgileri"]'))
      .not.toBeNull();
    const stepsEl = host.querySelector('.servora-workflow-steps');
    const responsibilityEl = Array.from(host.querySelectorAll('h2'))
      .find((el) => el.textContent === 'Şimdi sizden beklenen');
    const deliveryOrMeeting = Array.from(host.querySelectorAll('h2'))
      .find((el) => el.textContent === 'Teslim bilgileri' || el.textContent === 'Görüşme sonucu');
    expect(stepsEl).not.toBeNull();
    expect(responsibilityEl).not.toBeNull();
    expect(
      (stepsEl?.compareDocumentPosition(responsibilityEl!) ?? 0)
        & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    if (deliveryOrMeeting) {
      expect(
        (responsibilityEl!.compareDocumentPosition(deliveryOrMeeting)
          & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      ).toBe(true);
    }
  });

  it('keeps record description labels, order, and fallbacks across job types in a narrow host', async () => {
    const longCustomer = 'Çok Uzun İsimli Demo Diş Hastanesi ve Polikliniği';
    const longStaff = 'Ayşe Çok Uzun Soyadlı Personel';

    const delivery: JobCard = {
      ...job,
      title: 'Ürün teslimi kayıt özeti',
      description: 'Teslim notu: iki kutu örnek ürün',
      priority: 'high',
      customer: { id: 'c1', name: longCustomer },
      assignee: { id: 's1', name: longStaff },
      contact: null,
    };
    const task: JobCard = {
      ...generalTask,
      description: 'Doktorun kararını öğren ve sonucu karta yaz.',
      customer: { id: 'c1', name: longCustomer },
      assignee: { id: 's1', name: longStaff },
      contact: { id: 'contact-1', name: 'Dr. Deniz Yılmaz Unvan Test' },
    };
    const meeting: JobCard = {
      ...inProgressMeeting(),
      engagementKind: 'CUSTOMER_VISIT',
      description: null,
      customer: { id: 'c1', name: longCustomer },
      assignee: { id: 's1', name: longStaff },
      contact: null,
      scheduledAt: '2026-07-20T09:00:00.000Z',
    };

    for (const card of [delivery, task, meeting]) {
      await renderDetail(card);
      const hostEl = host.querySelector('.servora-record-descriptions-host');
      const records = host.querySelector('.servora-record-descriptions[aria-label="İş kayıt bilgileri"]');
      expect(hostEl).not.toBeNull();
      expect(hostEl?.getAttribute('data-column-count')).toBe('1');
      expect(records).not.toBeNull();

      const text = records?.textContent ?? '';
      expect(text).toContain('Durum');
      expect(text).toContain('Sorumlu personel');
      expect(text).toContain(longStaff);
      expect(text).toContain('Öncelik');
      expect(text).toContain('Müşteri');
      expect(text).toContain(longCustomer);
      expect(text).toContain('Açıklama');

      expect(text.indexOf('Durum')).toBeLessThan(text.indexOf('Sorumlu personel'));
      expect(text.indexOf('Sorumlu personel')).toBeLessThan(text.indexOf('Öncelik'));
      expect(text.indexOf('Müşteri')).toBeLessThan(text.indexOf('Açıklama'));
    }

    await renderDetail(delivery);
    const deliveryRecords = host.querySelector('.servora-record-descriptions')?.textContent ?? '';
    expect(deliveryRecords).toContain('Teslim notu: iki kutu örnek ürün');
    expect(deliveryRecords).toContain('Yüksek');

    await renderDetail(task);
    const taskRecords = host.querySelector('.servora-record-descriptions')?.textContent ?? '';
    expect(taskRecords).toContain('Doktorun kararını öğren');
    expect(taskRecords).toContain('Dr. Deniz Yılmaz Unvan Test');
    expect(taskRecords).toContain('İlgili kişi');

    await renderDetail(meeting);
    const meetingRecords = host.querySelector('.servora-record-descriptions')?.textContent ?? '';
    expect(meetingRecords).toContain('Görüşme türü');
    expect(meetingRecords).toContain('Görüşülecek kişi');
    expect(meetingRecords).toContain('Belirtilmedi');
    expect(meetingRecords).toContain('Müşteri / kurum ziyareti');
  });

  it('refreshes an idle matching detail from canonical REST truth', async () => {
    const source = new FakeRealtimeEventSource();
    const fetch = await renderRealtimeScreen(job, source);
    const jobRequests = () => fetch.mock.calls.filter(([input]) => String(input).endsWith('/api/job-cards/job-1'));
    expect(jobRequests()).toHaveLength(1);

    await act(async () => {
      source.emitJobUpdate('1');
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(jobRequests()).toHaveLength(2);
    expect(host.textContent).not.toContain('Bu iş başka bir oturumda güncellendi');
  });

  it('preserves an open meeting editor and offers an explicit realtime reload', async () => {
    const source = new FakeRealtimeEventSource();
    const meeting = inProgressMeeting();
    const fetch = await renderRealtimeScreen(meeting, source, mockDetailFetch(meeting, { meeting: meetingDetails }));
    const edit = buttonByName(host, 'Görüşmeyi düzenle');
    expect(edit).not.toBeNull();
    await act(async () => { edit?.click(); await Promise.resolve(); });
    expect(host.textContent).toContain('Görüşmeyi düzenle');
    const jobRequestsBeforeEvent = fetch.mock.calls.filter(([input]) => String(input).endsWith('/api/job-cards/job-1')).length;

    await act(async () => { source.emitJobUpdate('1'); await Promise.resolve(); });

    expect(host.textContent).toContain('Bu iş başka bir oturumda güncellendi. Açık düzenlemeniz korunuyor.');
    expect(host.textContent).toContain('En güncel bilgileri yükle');
    expect(fetch.mock.calls.filter(([input]) => String(input).endsWith('/api/job-cards/job-1'))).toHaveLength(jobRequestsBeforeEvent);

    await act(async () => {
      buttonByName(host, 'En güncel bilgileri yükle')?.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(fetch.mock.calls.filter(([input]) => String(input).endsWith('/api/job-cards/job-1')))
      .toHaveLength(jobRequestsBeforeEvent + 1);
    expect(host.textContent).not.toContain('Bu iş başka bir oturumda güncellendi.');
  });

  it('does not show a remote-conflict banner when the originating lifecycle invalidation arrives before the accept response', async () => {
    const source = new FakeRealtimeEventSource();
    const acceptBodies: Array<Record<string, unknown>> = [];
    let resolveAccept: (value: Response) => void = () => {};
    const acceptGate = new Promise<Response>((resolve) => { resolveAccept = resolve; });
    const accepted: JobCard = {
      ...job,
      status: 'ACCEPTED',
      version: job.version + 1,
      workflowContext: staffContext('ACCEPTED', {
        acceptedAt: '2026-07-17T08:30:00.000Z',
        acceptedBy: { id: 's1', name: 'Ayşe Personel' },
      }, { allowedActions: [] }),
    };
    let jobCardRequests = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/delivery-items')) return Response.json({ items: [item] });
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/accept') && init?.method === 'POST') {
        acceptBodies.push(JSON.parse(String(init.body)));
        return acceptGate;
      }
      if (url.endsWith('/api/job-cards/job-1')) {
        jobCardRequests += 1;
        return Response.json(jobCardRequests === 1 ? job : accepted);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    await renderRealtimeScreen(job, source, fetch);
    const jobRequests = () => fetch.mock.calls.filter(([input]) => String(input).endsWith('/api/job-cards/job-1'));
    expect(jobRequests()).toHaveLength(1);
    expect(buttonByName(host, 'İşi kabul et')).not.toBeNull();

    await act(async () => {
      buttonByName(host, 'İşi kabul et')?.click();
      await Promise.resolve();
    });
    expect(acceptBodies).toHaveLength(1);

    await act(async () => {
      source.emitJobUpdate('1');
      await Promise.resolve();
    });

    await act(async () => {
      resolveAccept(Response.json(accepted));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.textContent).toContain('İş kabul edildi.');
    expect(host.textContent).toContain('Kabul edildi');
    expect(host.textContent).not.toContain('Bu iş başka bir oturumda güncellendi');
    expect(host.textContent).not.toContain('Açık düzenlemeniz korunuyor');
    expect(host.textContent).not.toContain('En güncel bilgileri yükle');
    expect(acceptBodies).toHaveLength(1);
    expect(jobRequests().length).toBeLessThanOrEqual(2);
  });

  it('does not refetch detail or show a banner after a successful accept without invalidation', async () => {
    const source = new FakeRealtimeEventSource();
    const accepted: JobCard = {
      ...job,
      status: 'ACCEPTED',
      version: job.version + 1,
      workflowContext: staffContext('ACCEPTED', {
        acceptedAt: '2026-07-17T08:30:00.000Z',
        acceptedBy: { id: 's1', name: 'Ayşe Personel' },
      }, { allowedActions: [] }),
    };
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/delivery-items')) return Response.json({ items: [item] });
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/accept') && init?.method === 'POST') return Response.json(accepted);
      if (url.endsWith('/api/job-cards/job-1')) return Response.json(job);
      throw new Error(`Unexpected request: ${url}`);
    });
    await renderRealtimeScreen(job, source, fetch);
    const jobRequests = () => fetch.mock.calls.filter(([input]) => String(input).endsWith('/api/job-cards/job-1'));
    expect(jobRequests()).toHaveLength(1);

    await act(async () => {
      buttonByName(host, 'İşi kabul et')?.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.textContent).toContain('İş kabul edildi.');
    expect(host.textContent).toContain('Kabul edildi');
    expect(host.textContent).not.toContain('Bu iş başka bir oturumda güncellendi');
    expect(jobRequests()).toHaveLength(1);
  });

  it('coalesces multiple invalidations during one mutation into a single reconciliation fetch', async () => {
    const source = new FakeRealtimeEventSource();
    const acceptBodies: Array<Record<string, unknown>> = [];
    let resolveAccept: (value: Response) => void = () => {};
    const acceptGate = new Promise<Response>((resolve) => { resolveAccept = resolve; });
    const accepted: JobCard = {
      ...job,
      status: 'ACCEPTED',
      version: job.version + 1,
      workflowContext: staffContext('ACCEPTED', {
        acceptedAt: '2026-07-17T08:30:00.000Z',
        acceptedBy: { id: 's1', name: 'Ayşe Personel' },
      }, { allowedActions: [] }),
    };
    let jobCardRequests = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/delivery-items')) return Response.json({ items: [item] });
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/accept') && init?.method === 'POST') {
        acceptBodies.push(JSON.parse(String(init.body)));
        return acceptGate;
      }
      if (url.endsWith('/api/job-cards/job-1')) {
        jobCardRequests += 1;
        return Response.json(jobCardRequests === 1 ? job : accepted);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    await renderRealtimeScreen(job, source, fetch);
    const jobRequests = () => fetch.mock.calls.filter(([input]) => String(input).endsWith('/api/job-cards/job-1'));
    expect(jobRequests()).toHaveLength(1);

    await act(async () => {
      buttonByName(host, 'İşi kabul et')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      source.emitJobUpdate('1');
      source.emitJobUpdate('2');
      source.emitJobUpdate('3');
      await Promise.resolve();
    });
    await act(async () => {
      resolveAccept(Response.json(accepted));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.textContent).toContain('İş kabul edildi.');
    expect(host.textContent).not.toContain('Bu iş başka bir oturumda güncellendi');
    expect(acceptBodies).toHaveLength(1);
    expect(jobRequests().length).toBeLessThanOrEqual(2);
  });

  it('applies newer canonical truth returned by the post-mutation reconciliation refresh', async () => {
    const source = new FakeRealtimeEventSource();
    const acceptBodies: Array<Record<string, unknown>> = [];
    let resolveAccept: (value: Response) => void = () => {};
    const acceptGate = new Promise<Response>((resolve) => { resolveAccept = resolve; });
    const accepted: JobCard = {
      ...job,
      status: 'ACCEPTED',
      version: job.version + 1,
      workflowContext: staffContext('ACCEPTED', {
        acceptedAt: '2026-07-17T08:30:00.000Z',
        acceptedBy: { id: 's1', name: 'Ayşe Personel' },
      }, { allowedActions: [] }),
    };
    const newer: JobCard = {
      ...accepted,
      version: accepted.version + 1,
      title: 'Başka oturumda güncellenen teslim',
    };
    let jobCardRequests = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/delivery-items')) return Response.json({ items: [item] });
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/accept') && init?.method === 'POST') {
        acceptBodies.push(JSON.parse(String(init.body)));
        return acceptGate;
      }
      if (url.endsWith('/api/job-cards/job-1')) {
        jobCardRequests += 1;
        return Response.json(jobCardRequests === 1 ? job : newer);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    await renderRealtimeScreen(job, source, fetch);

    await act(async () => {
      buttonByName(host, 'İşi kabul et')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      source.emitJobUpdate('1');
      await Promise.resolve();
    });
    await act(async () => {
      resolveAccept(Response.json(accepted));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.textContent).toContain('İş kabul edildi.');
    expect(host.textContent).toContain('Başka oturumda güncellenen teslim');
    expect(host.textContent).not.toContain('Bu iş başka bir oturumda güncellendi');
  });

  it('shows an unresolved banner when the post-mutation reconciliation refresh fails', async () => {
    const source = new FakeRealtimeEventSource();
    const acceptBodies: Array<Record<string, unknown>> = [];
    let resolveAccept: (value: Response) => void = () => {};
    const acceptGate = new Promise<Response>((resolve) => { resolveAccept = resolve; });
    const accepted: JobCard = {
      ...job,
      status: 'ACCEPTED',
      version: job.version + 1,
      workflowContext: staffContext('ACCEPTED', {
        acceptedAt: '2026-07-17T08:30:00.000Z',
        acceptedBy: { id: 's1', name: 'Ayşe Personel' },
      }, { allowedActions: [] }),
    };
    let jobCardRequests = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/delivery-items')) return Response.json({ items: [item] });
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/accept') && init?.method === 'POST') {
        acceptBodies.push(JSON.parse(String(init.body)));
        return acceptGate;
      }
      if (url.endsWith('/api/job-cards/job-1')) {
        jobCardRequests += 1;
        if (jobCardRequests > 1) throw new TypeError('network');
        return Response.json(job);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    await renderRealtimeScreen(job, source, fetch);

    await act(async () => {
      buttonByName(host, 'İşi kabul et')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      source.emitJobUpdate('1');
      await Promise.resolve();
    });
    await act(async () => {
      resolveAccept(Response.json(accepted));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.textContent).toContain('İş kabul edildi.');
    expect(host.textContent).toContain('Bu iş başka bir oturumda güncellendi');
    expect(host.textContent).toContain('En güncel bilgileri yükle');
  });

  it('clears stale state after a mutation conflict with a deferred invalidation', async () => {
    const source = new FakeRealtimeEventSource();
    const acceptBodies: Array<Record<string, unknown>> = [];
    const newer: JobCard = {
      ...job,
      status: 'ACCEPTED',
      version: job.version + 1,
      title: 'Çakışma sonrası güncel teslim',
      workflowContext: staffContext('ACCEPTED', {
        acceptedAt: '2026-07-17T08:30:00.000Z',
        acceptedBy: { id: 's1', name: 'Ayşe Personel' },
      }, { allowedActions: [] }),
    };
    let jobCardRequests = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/delivery-items')) return Response.json({ items: [item] });
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/accept') && init?.method === 'POST') {
        acceptBodies.push(JSON.parse(String(init.body)));
        return Response.json({
          code: 'VERSION_CONFLICT',
          error: 'İş başka bir işlemle güncellendi.',
        }, { status: 409, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/api/job-cards/job-1')) {
        jobCardRequests += 1;
        return Response.json(jobCardRequests === 1 ? job : newer);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    await renderRealtimeScreen(job, source, fetch);

    await act(async () => {
      buttonByName(host, 'İşi kabul et')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      source.emitJobUpdate('1');
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.textContent).toContain('Çakışma sonrası güncel teslim');
    expect(host.textContent).toContain('İş başka bir işlemle güncellendi. En güncel durum gösteriliyor.');
    expect(host.textContent).not.toContain('İş kabul edildi.');
    expect(host.textContent).not.toContain('Bu iş başka bir oturumda güncellendi');
  });

  it('keeps the retryable action id when a matching event arrives while the accept request is pending and the request fails', async () => {
    const source = new FakeRealtimeEventSource();
    const acceptBodies: Array<Record<string, unknown>> = [];
    let rejectAccept: (reason?: unknown) => void = () => {};
    const acceptGate = new Promise<Response>((_, reject) => { rejectAccept = reject; });
    const accepted: JobCard = {
      ...job,
      status: 'ACCEPTED',
      version: job.version + 1,
      workflowContext: staffContext('ACCEPTED', {
        acceptedAt: '2026-07-17T08:30:00.000Z',
        acceptedBy: { id: 's1', name: 'Ayşe Personel' },
      }, { allowedActions: [] }),
    };
    let jobCardRequests = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/delivery-items')) return Response.json({ items: [item] });
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/accept') && init?.method === 'POST') {
        acceptBodies.push(JSON.parse(String(init.body)));
        if (acceptBodies.length === 1) return acceptGate;
        return Response.json(accepted);
      }
      if (url.endsWith('/api/job-cards/job-1')) {
        jobCardRequests += 1;
        return Response.json(jobCardRequests === 1 ? job : accepted);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    await renderRealtimeScreen(job, source, fetch);

    await act(async () => {
      buttonByName(host, 'İşi kabul et')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      source.emitJobUpdate('1');
      await Promise.resolve();
    });
    await act(async () => {
      rejectAccept(new TypeError('offline'));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.textContent).toContain('Sunucuya ulaşılamadı');
    expect(host.textContent).toContain('Bu iş başka bir oturumda güncellendi');

    await act(async () => {
      buttonByName(host, 'İşi kabul et')?.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(acceptBodies).toHaveLength(2);
    expect(acceptBodies[1]).toEqual(acceptBodies[0]);
    expect(host.textContent).toContain('İş kabul edildi.');
    expect(host.textContent).not.toContain('Bu iş başka bir oturumda güncellendi');
  });

  it('follows up with a second canonical fetch when a new invalidation arrives while reconciliation is in flight', async () => {
    const source = new FakeRealtimeEventSource();
    const acceptBodies: Array<Record<string, unknown>> = [];
    let resolveAccept: (value: Response) => void = () => {};
    const acceptGate = new Promise<Response>((resolve) => { resolveAccept = resolve; });
    const accepted: JobCard = {
      ...job,
      status: 'ACCEPTED',
      version: job.version + 1,
      workflowContext: staffContext('ACCEPTED', {
        acceptedAt: '2026-07-17T08:30:00.000Z',
        acceptedBy: { id: 's1', name: 'Ayşe Personel' },
      }, { allowedActions: [] }),
    };
    const newer: JobCard = {
      ...accepted,
      version: accepted.version + 1,
      title: 'Drain sırasında gelen güncelleme',
    };
    let resolveDrainGet: (value: Response) => void = () => {};
    const drainGetGate = new Promise<Response>((resolve) => { resolveDrainGet = resolve; });
    let jobCardRequests = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/delivery-items')) return Response.json({ items: [item] });
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/accept') && init?.method === 'POST') {
        acceptBodies.push(JSON.parse(String(init.body)));
        return acceptGate;
      }
      if (url.endsWith('/api/job-cards/job-1')) {
        jobCardRequests += 1;
        if (jobCardRequests === 1) return Response.json(job);
        if (jobCardRequests === 2) return drainGetGate;
        return Response.json(newer);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    await renderRealtimeScreen(job, source, fetch);
    const jobRequests = () => fetch.mock.calls.filter(([input]) => String(input).endsWith('/api/job-cards/job-1'));
    expect(jobRequests()).toHaveLength(1);

    await act(async () => {
      buttonByName(host, 'İşi kabul et')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      source.emitJobUpdate('1');
      await Promise.resolve();
    });
    await act(async () => {
      resolveAccept(Response.json(accepted));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(jobRequests()).toHaveLength(2);

    await act(async () => {
      source.emitJobUpdate('2');
      await Promise.resolve();
    });
    await act(async () => {
      resolveDrainGet(Response.json(accepted));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.textContent).toContain('İş kabul edildi.');
    expect(host.textContent).toContain('Drain sırasında gelen güncelleme');
    expect(host.textContent).not.toContain('Bu iş başka bir oturumda güncellendi');
    expect(jobRequests().length).toBe(3);
    expect(acceptBodies).toHaveLength(1);
  });

  it('does not let a stale idle refresh overwrite a completed mutation response and still reconciles pending generation', async () => {
    const source = new FakeRealtimeEventSource();
    const acceptBodies: Array<Record<string, unknown>> = [];
    let resolveAccept: (value: Response) => void = () => {};
    const acceptGate = new Promise<Response>((resolve) => { resolveAccept = resolve; });
    let resolveIdleGet: (value: Response) => void = () => {};
    const idleGetGate = new Promise<Response>((resolve) => { resolveIdleGet = resolve; });
    const accepted: JobCard = {
      ...job,
      status: 'ACCEPTED',
      version: job.version + 1,
      workflowContext: staffContext('ACCEPTED', {
        acceptedAt: '2026-07-17T08:30:00.000Z',
        acceptedBy: { id: 's1', name: 'Ayşe Personel' },
      }, { allowedActions: [] }),
    };
    let jobCardRequests = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/delivery-items')) return Response.json({ items: [item] });
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/accept') && init?.method === 'POST') {
        acceptBodies.push(JSON.parse(String(init.body)));
        return acceptGate;
      }
      if (url.endsWith('/api/job-cards/job-1')) {
        jobCardRequests += 1;
        if (jobCardRequests === 1) return Response.json(job);
        if (jobCardRequests === 2) return idleGetGate;
        return Response.json(accepted);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    await renderRealtimeScreen(job, source, fetch);
    const jobRequests = () => fetch.mock.calls.filter(([input]) => String(input).endsWith('/api/job-cards/job-1'));

    await act(async () => {
      source.emitJobUpdate('1');
      await Promise.resolve();
    });
    expect(jobRequests()).toHaveLength(2);

    await act(async () => {
      buttonByName(host, 'İşi kabul et')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      resolveAccept(Response.json(accepted));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(jobRequests()).toHaveLength(2);
    await act(async () => {
      resolveIdleGet(Response.json(job));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.textContent).toContain('İş kabul edildi.');
    expect(host.textContent).toContain('Kabul edildi');
    expect(host.textContent).not.toContain('Bu iş başka bir oturumda güncellendi');
    expect(acceptBodies).toHaveLength(1);
    expect(jobRequests()).toHaveLength(3);
  });

  it('follows up when an invalidation arrives during the delivered-at post-mutation refresh', async () => {
    const source = new FakeRealtimeEventSource();
    const deliveredAt = '2026-07-18T10:30';
    const accepted: JobCard = {
      ...job,
      status: 'ACCEPTED',
      version: job.version + 1,
      workflowContext: staffContext('ACCEPTED', {
        acceptedAt: '2026-07-17T08:30:00.000Z',
        acceptedBy: { id: 's1', name: 'Ayşe Personel' },
      }, {
        allowedActions: ['EDIT_JOB_FIELDS', 'EDIT_DELIVERY_ACTUAL_TIME', 'VIEW_NOTES', 'ADD_NOTE'],
      }),
    };
    const newer: JobCard = {
      ...accepted,
      version: accepted.version + 1,
      title: 'Teslim kaydı sonrası güncel teslim',
    };
    let resolvePatch: (value: Response) => void = () => {};
    const patchGate = new Promise<Response>((resolve) => { resolvePatch = resolve; });
    let resolveRefreshGet: (value: Response) => void = () => {};
    const refreshGetGate = new Promise<Response>((resolve) => { resolveRefreshGet = resolve; });
    const patchBodies: Array<Record<string, unknown>> = [];
    let jobCardRequests = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/delivery-items/i1') && init?.method === 'PATCH') {
        patchBodies.push(JSON.parse(String(init.body)));
        return patchGate;
      }
      if (url.endsWith('/delivery-items')) return Response.json({ items: [{ ...item, deliveredAt: null }] });
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/api/job-cards/job-1')) {
        jobCardRequests += 1;
        if (jobCardRequests === 1) return Response.json(accepted);
        if (jobCardRequests === 2) return refreshGetGate;
        return Response.json(newer);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    await renderRealtimeScreen(accepted, source, fetch);
    const jobRequests = () => fetch.mock.calls.filter(([input]) => String(input).endsWith('/api/job-cards/job-1'));
    expect(jobRequests()).toHaveLength(1);

    await act(async () => {
      const input = host.querySelector('#delivery-actual-at-i1') as HTMLInputElement;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
        ?.set?.call(input, deliveredAt);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      (host.querySelector('form.delivery-actual-time-form') as HTMLFormElement).requestSubmit();
      await Promise.resolve();
    });
    expect(patchBodies).toHaveLength(1);
    await act(async () => {
      source.emitJobUpdate('1');
      await Promise.resolve();
    });
    await act(async () => {
      resolvePatch(Response.json({ item: { ...item, deliveredAt: '2026-07-18T10:30:00.000Z' }, jobCardVersion: accepted.version + 1 }));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(jobRequests()).toHaveLength(2);

    await act(async () => {
      source.emitJobUpdate('2');
      await Promise.resolve();
    });
    await act(async () => {
      resolveRefreshGet(Response.json(accepted));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.textContent).toContain('Gerçekleşen teslim zamanı kaydedildi.');
    expect(host.textContent).toContain('Teslim kaydı sonrası güncel teslim');
    expect(host.textContent).not.toContain('Bu iş başka bir oturumda güncellendi');
    expect(jobRequests()).toHaveLength(3);
  });

  it('follows up when an invalidation arrives during the meeting-save refresh', async () => {
    const source = new FakeRealtimeEventSource();
    const meeting = inProgressMeeting();
    const newer: JobCard = {
      ...meeting,
      version: meeting.version + 1,
      title: 'Görüşme kaydı sonrası güncel görüşme',
    };
    let resolvePatch: (value: Response) => void = () => {};
    const patchGate = new Promise<Response>((resolve) => { resolvePatch = resolve; });
    let resolveRefreshGet: (value: Response) => void = () => {};
    const refreshGetGate = new Promise<Response>((resolve) => { resolveRefreshGet = resolve; });
    const patchBodies: Array<Record<string, unknown>> = [];
    let jobCardRequests = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/meeting-details') && init?.method === 'PATCH') {
        patchBodies.push(JSON.parse(String(init.body)));
        return patchGate;
      }
      if (url.endsWith('/meeting-details')) {
        return Response.json({ ...meetingDetails, jobCardVersion: jobCardRequests >= 3 ? newer.version : meeting.version });
      }
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/api/job-cards/job-1')) {
        jobCardRequests += 1;
        if (jobCardRequests === 1) return Response.json(meeting);
        if (jobCardRequests === 2) return refreshGetGate;
        return Response.json(newer);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    await renderRealtimeScreen(meeting, source, fetch);
    const jobRequests = () => fetch.mock.calls.filter(([input]) => String(input).endsWith('/api/job-cards/job-1'));

    await act(async () => {
      const summary = host.querySelector('#meeting-summary') as HTMLTextAreaElement;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
        ?.set?.call(summary, 'Güncel görüşme özeti');
      summary.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      buttonByName(host, 'Görüşme sonucunu kaydet')?.click();
      await Promise.resolve();
    });
    expect(patchBodies).toHaveLength(1);
    await act(async () => {
      source.emitJobUpdate('1');
      await Promise.resolve();
    });
    await act(async () => {
      resolvePatch(Response.json({
        jobCardId: 'job-1', meetingAt: '2026-07-16T10:00:00.000Z', outcome: 'POSITIVE',
        meetingSummary: 'Güncel görüşme özeti', nextFollowUpAt: null, jobCardVersion: meeting.version,
      }));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(jobRequests()).toHaveLength(2);

    await act(async () => {
      source.emitJobUpdate('2');
      await Promise.resolve();
    });
    await act(async () => {
      resolveRefreshGet(Response.json(meeting));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.textContent).toContain('Görüşme sonucu kaydedildi.');
    expect(host.textContent).toContain('Görüşme kaydı sonrası güncel görüşme');
    expect(host.textContent).not.toContain('Bu iş başka bir oturumda güncellendi');
    expect(jobRequests()).toHaveLength(3);
  });

  it('settles a matching invalidation after saving the delivered-at time without a phantom later refresh', async () => {
    const source = new FakeRealtimeEventSource();
    const deliveredAt = '2026-07-18T10:30';
    const accepted: JobCard = {
      ...job,
      status: 'ACCEPTED',
      version: job.version + 1,
      workflowContext: staffContext('ACCEPTED', {
        acceptedAt: '2026-07-17T08:30:00.000Z',
        acceptedBy: { id: 's1', name: 'Ayşe Personel' },
      }, {
        allowedActions: ['EDIT_JOB_FIELDS', 'EDIT_DELIVERY_ACTUAL_TIME', 'VIEW_NOTES', 'ADD_NOTE'],
      }),
    };
    let resolvePatch: (value: Response) => void = () => {};
    const patchGate = new Promise<Response>((resolve) => { resolvePatch = resolve; });
    const patchBodies: Array<Record<string, unknown>> = [];
    let jobCardRequests = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/delivery-items/i1') && init?.method === 'PATCH') {
        patchBodies.push(JSON.parse(String(init.body)));
        return patchGate;
      }
      if (url.endsWith('/delivery-items')) return Response.json({ items: [{ ...item, deliveredAt: null }] });
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/api/job-cards/job-1')) {
        jobCardRequests += 1;
        return Response.json(jobCardRequests === 1 ? accepted : accepted);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    await renderRealtimeScreen(accepted, source, fetch);
    const jobRequests = () => fetch.mock.calls.filter(([input]) => String(input).endsWith('/api/job-cards/job-1'));
    expect(jobRequests()).toHaveLength(1);

    await act(async () => {
      const input = host.querySelector('#delivery-actual-at-i1') as HTMLInputElement;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
        ?.set?.call(input, deliveredAt);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      (host.querySelector('form.delivery-actual-time-form') as HTMLFormElement).requestSubmit();
      await Promise.resolve();
    });
    expect(patchBodies).toHaveLength(1);
    await act(async () => {
      source.emitJobUpdate('1');
      await Promise.resolve();
    });
    await act(async () => {
      resolvePatch(Response.json({ item: { ...item, deliveredAt: '2026-07-18T10:30:00.000Z' }, jobCardVersion: accepted.version + 1 }));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.textContent).toContain('Gerçekleşen teslim zamanı kaydedildi.');
    expect(host.textContent).not.toContain('Bu iş başka bir oturumda güncellendi');
    expect(jobRequests()).toHaveLength(2);
  });

  it('preserves an unresolved invalidation after a generic delivered-at save failure', async () => {
    const source = new FakeRealtimeEventSource();
    const deliveredAt = '2026-07-18T10:30';
    const accepted: JobCard = {
      ...job,
      status: 'ACCEPTED',
      version: job.version + 1,
      workflowContext: staffContext('ACCEPTED', {
        acceptedAt: '2026-07-17T08:30:00.000Z',
        acceptedBy: { id: 's1', name: 'Ayşe Personel' },
      }, {
        allowedActions: ['EDIT_JOB_FIELDS', 'EDIT_DELIVERY_ACTUAL_TIME', 'VIEW_NOTES', 'ADD_NOTE'],
      }),
    };
    let rejectPatch: (reason?: unknown) => void = () => {};
    const patchGate = new Promise<Response>((_, reject) => { rejectPatch = reject; });
    const patchBodies: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/delivery-items/i1') && init?.method === 'PATCH') {
        patchBodies.push(JSON.parse(String(init.body)));
        return patchGate;
      }
      if (url.endsWith('/delivery-items')) return Response.json({ items: [{ ...item, deliveredAt: null }] });
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/api/job-cards/job-1')) return Response.json(accepted);
      throw new Error(`Unexpected request: ${url}`);
    });
    await renderRealtimeScreen(accepted, source, fetch);

    await act(async () => {
      const input = host.querySelector('#delivery-actual-at-i1') as HTMLInputElement;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
        ?.set?.call(input, deliveredAt);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      (host.querySelector('form.delivery-actual-time-form') as HTMLFormElement).requestSubmit();
      await Promise.resolve();
    });
    expect(patchBodies).toHaveLength(1);
    await act(async () => {
      source.emitJobUpdate('1');
      await Promise.resolve();
    });
    await act(async () => {
      rejectPatch(new TypeError('offline'));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.textContent).toContain('Sunucuya ulaşılamadı');
    expect(host.textContent).toContain('Bu iş başka bir oturumda güncellendi');
  });

  it('preserves an unresolved invalidation after a generic meeting-save failure', async () => {
    const source = new FakeRealtimeEventSource();
    const meeting = inProgressMeeting();
    let rejectPatch: (reason?: unknown) => void = () => {};
    const patchGate = new Promise<Response>((_, reject) => { rejectPatch = reject; });
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/meeting-details') && init?.method === 'PATCH') return patchGate;
      if (url.endsWith('/meeting-details')) return Response.json(meetingDetails);
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/api/job-cards/job-1')) return Response.json(meeting);
      throw new Error(`Unexpected request: ${url}`);
    });
    await renderRealtimeScreen(meeting, source, fetch);
    await act(async () => {
      const summary = host.querySelector('#meeting-summary') as HTMLTextAreaElement;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
        ?.set?.call(summary, 'Güncel görüşme özeti');
      summary.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      buttonByName(host, 'Görüşme sonucunu kaydet')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      source.emitJobUpdate('1');
      await Promise.resolve();
    });
    await act(async () => {
      rejectPatch(new TypeError('offline'));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.textContent).toContain('Sunucuya ulaşılamadı');
    expect(host.textContent).toContain('Bu iş başka bir oturumda güncellendi');
  });

  it('applies newer canonical truth after withdraw-and-edit with a concurrent event', async () => {
    const source = new FakeRealtimeEventSource();
    const waiting = waitingApprovalJob();
    const meeting = {
      ...waiting,
      type: 'SALES_MEETING' as const,
      engagementKind: 'SALES_MEETING' as const,
      workflowContext: contextWith({
        allowedCommands: ['WITHDRAW_FROM_APPROVAL', 'CANCEL'],
        allowedActions: ['WITHDRAW_AND_EDIT_JOB_FIELDS', 'VIEW_MEETING_RESULT', 'VIEW_NOTES'],
        lifecycle: {
          ...baseLifecycle,
          acceptedAt: '2026-07-17T08:30:00.000Z',
          acceptedBy: { id: 's1', name: 'Ayşe Personel' },
          startedAt: '2026-07-17T09:00:00.000Z',
          submittedAt: '2026-07-17T10:00:00.000Z',
          submittedBy: { id: 's1', name: 'Ayşe Personel' },
        },
        submissionReadiness: null,
      }),
    };
    let resolveWithdraw: (value: Response) => void = () => {};
    const withdrawGate = new Promise<Response>((resolve) => { resolveWithdraw = resolve; });
    const withdrawBodies: Array<Record<string, unknown>> = [];
    const withdrawn: JobCard = {
      ...meeting,
      status: 'IN_PROGRESS',
      version: meeting.version + 1,
      workflowContext: staffContext('IN_PROGRESS', {
        acceptedAt: '2026-07-17T08:30:00.000Z',
        acceptedBy: { id: 's1', name: 'Ayşe Personel' },
        startedAt: '2026-07-17T09:00:00.000Z',
        submittedAt: null,
        submittedBy: null,
      }),
    };
    const newer: JobCard = {
      ...withdrawn,
      version: withdrawn.version + 1,
      title: 'Geri çekme sonrası güncel görüşme',
    };
    let jobCardRequests = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/meeting-details')) {
        return Response.json({
          ...meetingDetails,
          jobCardVersion: jobCardRequests >= 2 ? newer.version : meeting.version,
        });
      }
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.includes('/withdraw-from-approval') && init?.method === 'POST') {
        withdrawBodies.push(JSON.parse(String(init.body)));
        return withdrawGate;
      }
      if (url.endsWith('/api/job-cards/job-1')) {
        jobCardRequests += 1;
        return Response.json(jobCardRequests === 1 ? meeting : newer);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    await renderRealtimeScreen(meeting, source, fetch);

    await act(async () => {
      buttonByName(host, 'Kontrolden geri çek ve düzenle')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      buttonByName(host, 'Geri çek ve düzenle')?.click();
      await Promise.resolve();
    });
    expect(withdrawBodies).toHaveLength(1);
    await act(async () => {
      source.emitJobUpdate('1');
      await Promise.resolve();
    });
    await act(async () => {
      resolveWithdraw(Response.json(withdrawn));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.textContent).toContain('Geri çekme sonrası güncel görüşme');
    expect(host.textContent).not.toContain('Bu iş başka bir oturumda güncellendi');
  });

  it('follows up when an invalidation arrives during the lifecycle START refresh', async () => {
    const source = new FakeRealtimeEventSource();
    const acceptedMeeting: JobCard = {
      ...inProgressMeeting(),
      status: 'ACCEPTED',
      version: 3,
      title: 'Başlatılacak görüşme',
      workflowContext: staffContext('ACCEPTED', {
        acceptedAt: '2026-07-17T08:30:00.000Z',
        acceptedBy: { id: 's1', name: 'Ayşe Personel' },
      }, { allowedActions: [], startLocationCaptureEnabled: false }),
    };
    const started: JobCard = {
      ...acceptedMeeting,
      status: 'IN_PROGRESS',
      version: acceptedMeeting.version + 1,
      workflowContext: staffContext('IN_PROGRESS', {
        acceptedAt: '2026-07-17T08:30:00.000Z',
        acceptedBy: { id: 's1', name: 'Ayşe Personel' },
        startedAt: '2026-07-17T09:00:00.000Z',
      }),
    };
    const newer: JobCard = {
      ...started,
      version: started.version + 1,
      title: 'Başlatma sonrası güncel görüşme',
    };
    let resolveStart: (value: Response) => void = () => {};
    const startGate = new Promise<Response>((resolve) => { resolveStart = resolve; });
    let resolveRefreshGet: (value: Response) => void = () => {};
    const refreshGetGate = new Promise<Response>((resolve) => { resolveRefreshGet = resolve; });
    const startBodies: Array<Record<string, unknown>> = [];
    let jobCardRequests = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/meeting-details')) {
        return Response.json({ ...meetingDetails, jobCardVersion: jobCardRequests === 2 ? started.version : newer.version });
      }
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/start') && init?.method === 'POST') {
        startBodies.push(JSON.parse(String(init.body)));
        return startGate;
      }
      if (url.endsWith('/api/job-cards/job-1')) {
        jobCardRequests += 1;
        if (jobCardRequests === 1) return Response.json(acceptedMeeting);
        if (jobCardRequests === 2) return refreshGetGate;
        return Response.json(newer);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    await renderRealtimeScreen(acceptedMeeting, source, fetch);
    const jobRequests = () => fetch.mock.calls.filter(([input]) => String(input).endsWith('/api/job-cards/job-1'));
    expect(jobRequests()).toHaveLength(1);

    await act(async () => {
      buttonByName(host, 'İşi başlat')?.click();
      await Promise.resolve();
    });
    expect(startBodies).toHaveLength(1);
    await act(async () => {
      resolveStart(Response.json(started));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(jobRequests()).toHaveLength(2);

    await act(async () => {
      source.emitJobUpdate('1');
      await Promise.resolve();
    });
    await act(async () => {
      resolveRefreshGet(Response.json(started));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.textContent).toContain('İş uygulanmaya başladı');
    expect(host.textContent).toContain('Başlatma sonrası güncel görüşme');
    expect(host.textContent).not.toContain('Bu iş başka bir oturumda güncellendi');
    expect(jobRequests()).toHaveLength(3);
  });

  it('reconciles an invalidation that arrives during an explicit stale reload', async () => {
    const source = new FakeRealtimeEventSource();
    const meeting = inProgressMeeting();
    const newer: JobCard = {
      ...meeting,
      version: meeting.version + 1,
      title: 'Yeniden yükleme sonrası güncel görüşme',
    };
    let resolveReloadGet: (value: Response) => void = () => {};
    const reloadGetGate = new Promise<Response>((resolve) => { resolveReloadGet = resolve; });
    let jobCardRequests = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/meeting-details')) {
        return Response.json({ ...meetingDetails, jobCardVersion: jobCardRequests >= 3 ? newer.version : meeting.version });
      }
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/api/job-cards/job-1')) {
        jobCardRequests += 1;
        if (jobCardRequests === 1) return Response.json(meeting);
        if (jobCardRequests === 2) return reloadGetGate;
        return Response.json(newer);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    await renderRealtimeScreen(meeting, source, fetch);
    const jobRequests = () => fetch.mock.calls.filter(([input]) => String(input).endsWith('/api/job-cards/job-1'));

    await act(async () => {
      buttonByName(host, 'Görüşmeyi düzenle')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      source.emitJobUpdate('1');
      await Promise.resolve();
    });
    expect(host.textContent).toContain('Bu iş başka bir oturumda güncellendi');
    expect(host.textContent).toContain('En güncel bilgileri yükle');
    expect(jobRequests()).toHaveLength(1);

    await act(async () => {
      buttonByName(host, 'En güncel bilgileri yükle')?.click();
      await Promise.resolve();
    });
    expect(jobRequests()).toHaveLength(2);

    await act(async () => {
      source.emitJobUpdate('2');
      await Promise.resolve();
    });
    await act(async () => {
      resolveReloadGet(Response.json(meeting));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.textContent).toContain('Yeniden yükleme sonrası güncel görüşme');
    expect(host.textContent).not.toContain('Bu iş başka bir oturumda güncellendi');
    expect(jobRequests()).toHaveLength(3);
  });

  it('waits for the active drain follow-up before completing the mutation success path', async () => {
    const source = new FakeRealtimeEventSource();
    const acceptBodies: Array<Record<string, unknown>> = [];
    let resolveAccept: (value: Response) => void = () => {};
    const acceptGate = new Promise<Response>((resolve) => { resolveAccept = resolve; });
    let resolveIdleGet: (value: Response) => void = () => {};
    const idleGetGate = new Promise<Response>((resolve) => { resolveIdleGet = resolve; });
    let resolveFollowUpGet: (value: Response) => void = () => {};
    const followUpGetGate = new Promise<Response>((resolve) => { resolveFollowUpGet = resolve; });
    const accepted: JobCard = {
      ...job,
      status: 'ACCEPTED',
      version: job.version + 1,
      workflowContext: staffContext('ACCEPTED', {
        acceptedAt: '2026-07-17T08:30:00.000Z',
        acceptedBy: { id: 's1', name: 'Ayşe Personel' },
      }, { allowedActions: [] }),
    };
    let jobCardRequests = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/delivery-items')) return Response.json({ items: [item] });
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/accept') && init?.method === 'POST') {
        acceptBodies.push(JSON.parse(String(init.body)));
        return acceptGate;
      }
      if (url.endsWith('/api/job-cards/job-1')) {
        jobCardRequests += 1;
        if (jobCardRequests === 1) return Response.json(job);
        if (jobCardRequests === 2) return idleGetGate;
        return followUpGetGate;
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    await renderRealtimeScreen(job, source, fetch);
    const jobRequests = () => fetch.mock.calls.filter(([input]) => String(input).endsWith('/api/job-cards/job-1'));

    await act(async () => {
      source.emitJobUpdate('1');
      await Promise.resolve();
    });
    expect(jobRequests()).toHaveLength(2);

    await act(async () => {
      buttonByName(host, 'İşi kabul et')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      resolveAccept(Response.json(accepted));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await act(async () => {
      resolveIdleGet(Response.json(job));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(jobRequests()).toHaveLength(3);
    expect(host.textContent).not.toContain('İş kabul edildi.');

    await act(async () => {
      resolveFollowUpGet(Response.json(accepted));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.textContent).toContain('İş kabul edildi.');
    expect(host.textContent).toContain('Kabul edildi');
    expect(host.textContent).not.toContain('Bu iş başka bir oturumda güncellendi');
    expect(acceptBodies).toHaveLength(1);
  });

  it('bounds a continuous invalidation storm without losing the unresolved banner', async () => {
    const source = new FakeRealtimeEventSource();
    const accepted: JobCard = {
      ...job,
      status: 'ACCEPTED',
      version: job.version + 1,
      workflowContext: staffContext('ACCEPTED', {
        acceptedAt: '2026-07-17T08:30:00.000Z',
        acceptedBy: { id: 's1', name: 'Ayşe Personel' },
      }, { allowedActions: [] }),
    };
    const gates: Array<{ resolve: (value: Response) => void }> = [];
    let jobCardRequests = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/delivery-items')) return Response.json({ items: [item] });
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/api/job-cards/job-1')) {
        jobCardRequests += 1;
        if (jobCardRequests === 1) return Response.json(job);
        const gate: { resolve: (value: Response) => void } = { resolve: () => {} };
        gates.push(gate);
        return new Promise<Response>((resolve) => { gate.resolve = resolve; });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    await renderRealtimeScreen(job, source, fetch);
    const jobRequests = () => fetch.mock.calls.filter(([input]) => String(input).endsWith('/api/job-cards/job-1'));
    expect(jobRequests()).toHaveLength(1);

    await act(async () => {
      source.emitJobUpdate('1');
      await Promise.resolve();
    });
    expect(gates).toHaveLength(1);

    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        source.emitJobUpdate(String(i + 2));
        await Promise.resolve();
      });
      await act(async () => {
        gates[i]?.resolve(Response.json(accepted));
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    expect(gates.length).toBeLessThanOrEqual(4);
    expect(host.textContent).toContain('Bu iş başka bir oturumda güncellendi');
    expect(host.textContent).toContain('En güncel bilgileri yükle');
    const settledCount = jobRequests().length;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(jobRequests()).toHaveLength(settledCount);
  });

  it('preserves an unresolved invalidation after a generic schedule-save failure', async () => {
    const source = new FakeRealtimeEventSource();
    const accepted: JobCard = {
      ...job,
      status: 'ACCEPTED',
      version: job.version + 1,
      workflowContext: staffContext('ACCEPTED', {
        acceptedAt: '2026-07-17T08:30:00.000Z',
        acceptedBy: { id: 's1', name: 'Ayşe Personel' },
      }, {
        allowedActions: ['EDIT_JOB_FIELDS', 'VIEW_NOTES', 'ADD_NOTE'],
      }),
    };
    let rejectPatch: (reason?: unknown) => void = () => {};
    const patchGate = new Promise<Response>((_, reject) => { rejectPatch = reject; });
    const patchBodies: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/delivery-items')) return Response.json({ items: [item] });
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith(`/api/job-cards/${accepted.id}`) && init?.method === 'PATCH') {
        patchBodies.push(JSON.parse(String(init.body)));
        return patchGate;
      }
      if (url.endsWith('/api/job-cards/job-1')) return Response.json(accepted);
      throw new Error(`Unexpected request: ${url}`);
    });
    await renderRealtimeScreen(accepted, source, fetch);

    await act(async () => {
      buttonByName(host, 'Planlanan zamanı kaydet')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      source.emitJobUpdate('1');
      await Promise.resolve();
    });
    await act(async () => {
      rejectPatch(new TypeError('offline'));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.textContent).toContain('Sunucuya ulaşılamadı');
    expect(host.textContent).toContain('Bu iş başka bir oturumda güncellendi');
  });

  it('ignores invalidation events for unrelated JobCards', async () => {
    const source = new FakeRealtimeEventSource();
    const fetch = await renderRealtimeScreen(job, source);
    const jobRequests = () => fetch.mock.calls.filter(([input]) => String(input).endsWith('/api/job-cards/job-1'));
    expect(jobRequests()).toHaveLength(1);

    await act(async () => {
      source.emitJobUpdateFor('1', 'other-job');
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(jobRequests()).toHaveLength(1);
    expect(host.textContent).not.toContain('Bu iş başka bir oturumda güncellendi');
  });

  it('renders revision lifecycle context and expected owner in the panel structure', async () => {
    await renderDetail(revisionRequestedJob({ revisionReason: 'İkinci miktarı düzeltin' }));
    const revision = host.querySelector('.revision-loop')!;
    expect(revision).not.toBeNull();
    // Lifecycle context hook: shows the revision flow path
    const lifecycleHook = revision.querySelector('[data-revision-context="lifecycle"]');
    expect(lifecycleHook).not.toBeNull();
    expect(lifecycleHook?.textContent).toMatch(/Yönetici kontrolünden|Uygulama/);
    // Expected owner/role hook
    const roleHook = revision.querySelector('[data-revision-context="expected-role"]');
    expect(roleHook).not.toBeNull();
    // Next-action context hook
    const actionHook = revision.querySelector('[data-revision-context="next-action"]');
    expect(actionHook).not.toBeNull();
    // Long unwrappable reason is fully rendered and carries the CSS wrap hook.
    // This test verifies the value is present and the hook exists; actual wrapping
    // is a CSS contract verified in shared-visual-language-contract.test.ts.
    const longReason = 'REVISION_REASON_' + 'X'.repeat(200);
    await act(async () => root.unmount());
    host.remove();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root.render(<JobDetailPanel
        job={revisionRequestedJob({ revisionReason: longReason })}
        items={[]} user={staffUser}
        pending={false} message=""
        onBack={() => {}} onCommand={() => {}}
      />);
    });
    const valueEl = host.querySelector('.revision-loop-reason-value');
    expect(valueEl).not.toBeNull();
    expect(valueEl!.textContent).toBe(longReason);
  });

  it('shows revision reason and separates resuming from resubmitting', async () => {
    await renderDetail(revisionRequestedJob({ revisionReason: 'Miktarı düzeltin' }));
    expect(Array.from(host.querySelectorAll('h2'))
      .some((el) => el.textContent === 'Düzeltme gerekiyor')).toBe(true);
    expect(host.textContent).toContain('Miktarı düzeltin');
    expect(host.textContent).toContain('Mehmet Yönetici');
    expect(host.querySelector('time[datetime="2026-07-17T11:00:00.000Z"]')).not.toBeNull();
    expect(buttonByName(host, 'Düzeltmeye başla')).not.toBeNull();
    expect(buttonByName(host, 'Yeniden kontrole gönder')).toBeNull();
    expect(buttonByName(host, 'Kontrole gönder')).toBeNull();
    const revision = host.querySelector('.revision-loop')!;
    const lifecycle = host.querySelector('.servora-workflow-steps')!;
    const responsibility = host.querySelector('.workflow-responsibility')!;
    // Lifecycle first; revision context follows steps, then responsibility.
    expect(lifecycle.compareDocumentPosition(revision) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
    expect(revision.compareDocumentPosition(responsibility) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
  });

  function section(name: string) {
    return host.querySelector(`[data-job-detail-section="${name}"]`);
  }

  function block(name: string) {
    return host.querySelector(`[data-job-detail-block="${name}"]`);
  }

  function precedes(earlier: Element, later: Element) {
    return Boolean(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  it('keeps requirements, decision, notes, then timeline in mobile-first DOM order', async () => {
    await act(async () => {
      root.render(<JobDetailPanel
        job={inProgressMeeting()}
        items={[]}
        user={staffUser}
        pending={false}
        message=""
        onBack={() => {}}
        onCommand={() => {}}
        notes={<section className="job-notes" data-test-notes>Notlar</section>}
        timeline={<section className="job-timeline" data-test-timeline>Timeline</section>}
      />);
    });
    const requirements = host.querySelector('.workflow-requirements')!;
    const action = host.querySelector('[data-job-decision-panel="true"]')!;
    const notes = host.querySelector('[data-test-notes]')!;
    const timeline = host.querySelector('[data-test-timeline]')!;
    expect(host.querySelector('.job-detail-workflow-layout')).not.toBeNull();
    expect(precedes(requirements, action)).toBe(true);
    expect(precedes(action, notes)).toBe(true);
    expect(precedes(notes, timeline)).toBe(true);
    expect(host.textContent).toContain('Eksik maddeleri tamamladığınızda');

    // Staff normal path: heading → lifecycle → responsibility → facts → actions → timeline
    const heading = section('heading')!;
    const lifecycle = section('lifecycle')!;
    const responsibility = section('responsibility')!;
    const facts = section('facts')!;
    const actions = section('actions')!;
    const timelineSection = section('timeline')!;
    expect(precedes(heading, lifecycle)).toBe(true);
    expect(precedes(lifecycle, responsibility)).toBe(true);
    expect(precedes(responsibility, facts)).toBe(true);
    expect(precedes(facts, actions)).toBe(true);
    expect(precedes(actions, timelineSection)).toBe(true);
    expect(heading.querySelector('.detail-heading-meta')?.textContent).toContain('Normal öncelik');
    expect(heading.querySelector('.detail-back-button')?.textContent).toBe('Listeye dön');
    expect(host.querySelector('.detail-summary.surface-flat')).not.toBeNull();
  });

  it('places actions and notes in the desktop work rail beside the main record area', async () => {
    await act(async () => {
      root.render(<JobDetailPanel
        job={inProgressMeeting()}
        items={[]}
        user={staffUser}
        pending={false}
        message=""
        onBack={() => {}}
        onCommand={() => {}}
        notes={<section className="job-notes" data-test-notes>Notlar</section>}
        timeline={<section className="job-timeline" data-test-timeline>Timeline</section>}
      />);
    });
    const content = host.querySelector('.job-detail-content')!;
    expect(content.classList.contains('job-detail-content--rail')).toBe(true);
    const main = host.querySelector('.job-detail-main')!;
    const rail = host.querySelector('.job-detail-work-rail')!;
    expect(rail.getAttribute('data-job-detail-rail')).toBe('true');
    expect(main.contains(section('facts'))).toBe(true);
    const actions = section('actions')!;
    const notes = host.querySelector('[data-test-notes]')!;
    expect(rail.contains(actions)).toBe(true);
    expect(rail.contains(notes)).toBe(true);
    const heading = actions.querySelector('.job-detail-rail-heading');
    expect(heading?.textContent).toBe('İşlemler');
    expect(host.querySelector('.job-detail-management-review')).toBeNull();
  });

  it('expands the record area to full width when no rail content exists', async () => {
    await act(async () => {
      root.render(<JobDetailPanel
        job={cancelledJob({})}
        items={[]}
        user={staffUser}
        pending={false}
        message=""
        onBack={() => {}}
        onCommand={() => {}}
      />);
    });
    expect(host.querySelector('.job-detail-work-rail')).toBeNull();
    expect(host.querySelector('.job-detail-content--rail')).toBeNull();
    expect(host.querySelector('.job-detail-content')?.classList.contains('job-detail-content--rail'))
      .toBe(false);
  });

  it('keeps notes in the rail without an actions heading for terminal jobs', async () => {
    await act(async () => {
      root.render(<JobDetailPanel
        job={cancelledJob({})}
        items={[]}
        user={staffUser}
        pending={false}
        message=""
        onBack={() => {}}
        onCommand={() => {}}
        notes={<section className="job-notes" data-test-notes>Notlar</section>}
        timeline={<section className="job-timeline" data-test-timeline>Timeline</section>}
      />);
    });
    const rail = host.querySelector('.job-detail-work-rail')!;
    expect(rail).not.toBeNull();
    expect(section('actions')).toBeNull();
    expect(host.querySelector('.job-detail-rail-heading')).toBeNull();
    expect(rail.contains(host.querySelector('[data-test-notes]'))).toBe(true);
  });

  it('places management review actions in the same rail as notes', async () => {
    await act(async () => {
      root.render(<JobDetailPanel
        job={waitingApprovalJob()}
        items={[]}
        user={managerUser}
        pending={false}
        message=""
        onBack={() => {}}
        onCommand={() => {}}
        notes={<section className="job-notes" data-test-notes>Notlar</section>}
      />);
    });
    const rail = host.querySelector('.job-detail-work-rail')!;
    expect(rail).not.toBeNull();
    const review = section('management-review')!;
    expect(rail.contains(review)).toBe(true);
    expect(review.textContent).toContain('Yönetici kontrolü');
    const actions = section('actions')!;
    expect(rail.contains(actions)).toBe(true);
    expect(rail.contains(host.querySelector('[data-test-notes]'))).toBe(true);
    expect(host.querySelector('.job-detail-main')!.contains(section('facts'))).toBe(true);
  });

  it('places revision after lifecycle and before responsibility', async () => {
    await act(async () => {
      root.render(<JobDetailPanel
        job={revisionRequestedJob({ revisionReason: 'Miktarı düzeltin' })}
        items={[]}
        user={staffUser}
        pending={false}
        message=""
        onBack={() => {}}
        onCommand={() => {}}
      />);
    });
    const lifecycle = section('lifecycle')!;
    const revision = section('revision')!;
    const responsibility = section('responsibility')!;
    const facts = section('facts')!;
    expect(section('terminal')).toBeNull();
    expect(precedes(lifecycle, revision)).toBe(true);
    expect(precedes(revision, responsibility)).toBe(true);
    expect(precedes(responsibility, facts)).toBe(true);
  });

  it('places terminal banner after lifecycle without a responsibility panel', async () => {
    const completed: JobCard = {
      ...job,
      status: 'COMPLETED',
      workflowContext: staffContext('COMPLETED', {
        submittedAt: '2026-07-17T10:00:00.000Z',
        approvedAt: '2026-07-17T11:00:00.000Z',
        approvedBy: { id: 'm1', name: 'Mehmet Yönetici' },
      }, { allowedCommands: [], allowedActions: ['VIEW_NOTES'], submissionReadiness: null }),
    };
    await act(async () => {
      root.render(<JobDetailPanel
        job={completed}
        items={[item]}
        user={staffUser}
        pending={false}
        message=""
        onBack={() => {}}
        onCommand={() => {}}
      />);
    });
    const lifecycle = section('lifecycle')!;
    const terminal = section('terminal')!;
    const facts = section('facts')!;
    expect(section('responsibility')).toBeNull();
    expect(section('revision')).toBeNull();
    expect(precedes(lifecycle, terminal)).toBe(true);
    expect(precedes(terminal, facts)).toBe(true);
  });

  it('orders manager waiting-approval: facts → type content → management review → actions → timeline', async () => {
    const waiting: JobCard = {
      ...job,
      status: 'WAITING_APPROVAL',
      type: 'PRODUCT_DELIVERY',
      workflowContext: contextWith({
        allowedCommands: ['APPROVE', 'REQUEST_REVISION', 'CANCEL'],
        allowedActions: ['VIEW_NOTES'],
        lifecycle: {
          ...baseLifecycle,
          startedAt: '2026-07-17T09:00:00.000Z',
          submittedAt: '2026-07-17T10:00:00.000Z',
          submittedBy: { id: 's1', name: 'Ayşe Personel' },
        },
        submissionReadiness: null,
      }),
    };
    await act(async () => {
      root.render(<JobDetailPanel
        job={waiting}
        items={[item]}
        user={managerUser}
        pending={false}
        message=""
        onBack={() => {}}
        onCommand={() => {}}
        notes={<section className="job-notes" data-test-notes>Notlar</section>}
        timeline={<section className="job-timeline" data-test-timeline>Timeline</section>}
      />);
    });
    const facts = section('facts')!;
    const delivery = block('delivery')!;
    const review = section('management-review')!;
    const actions = section('actions')!;
    const timelineSection = section('timeline')!;
    expect(host.querySelector('.approval-review')).not.toBeNull();
    expect(precedes(facts, delivery)).toBe(true);
    expect(precedes(delivery, review)).toBe(true);
    expect(precedes(review, actions)).toBe(true);
    expect(precedes(actions, timelineSection)).toBe(true);
    expect(section('responsibility')).not.toBeNull();
  });

  it('orders product delivery record-facts before delivery and optional records blocks', async () => {
    await act(async () => {
      root.render(<JobDetailPanel
        job={{ ...job, status: 'IN_PROGRESS', workflowContext: staffContext('IN_PROGRESS', {
          startedAt: '2026-07-17T09:00:00.000Z',
        }, {
          allowedCommands: ['SUBMIT_FOR_APPROVAL', 'CANCEL'],
          allowedActions: ['VIEW_NOTES'],
          submissionReadiness: null,
        }) }}
        items={[item]}
        user={staffUser}
        pending={false}
        message=""
        onBack={() => {}}
        onCommand={() => {}}
        records={<section data-test-records>Kayıtlar</section>}
        notes={<section className="job-notes" data-test-notes>Notlar</section>}
        timeline={<section className="job-timeline" data-test-timeline>Timeline</section>}
      />);
    });
    const recordFacts = block('record-facts')!;
    const delivery = block('delivery')!;
    const records = block('records')!;
    const actions = section('actions')!;
    const timelineSection = section('timeline')!;
    expect(precedes(recordFacts, delivery)).toBe(true);
    expect(precedes(delivery, records)).toBe(true);
    expect(precedes(records, actions)).toBe(true);
    expect(precedes(actions, timelineSection)).toBe(true);
  });

  it('keeps standalone notes before timeline when there is no decision panel', async () => {
    await act(async () => {
      root.render(<JobDetailPanel
        job={{
          ...job,
          status: 'COMPLETED',
          workflowContext: staffContext('COMPLETED', {
            approvedAt: '2026-07-17T11:00:00.000Z',
            approvedBy: { id: 'm1', name: 'Mehmet Yönetici' },
          }, { allowedCommands: [], allowedActions: ['VIEW_NOTES'], submissionReadiness: null }),
        }}
        items={[item]}
        user={staffUser}
        pending={false}
        message=""
        onBack={() => {}}
        onCommand={() => {}}
        notes={<section className="job-notes" data-test-notes>Notlar</section>}
        timeline={<section className="job-timeline" data-test-timeline>Timeline</section>}
      />);
    });
    const notesOnly = section('notes')!;
    const timelineSection = section('timeline')!;
    expect(section('actions')).toBeNull();
    expect(block('notes')).not.toBeNull();
    expect(precedes(notesOnly, timelineSection)).toBe(true);
  });

  it('does not mount meeting result resources in new and accepted states', async () => {
    for (const status of ['NEW', 'ACCEPTED'] as const) {
      await act(async () => root.unmount());
      host.remove();
      host = document.createElement('div');
      document.body.append(host);
      root = createRoot(host);

      const newMeetingJob: JobCard = {
        ...job,
        type: 'SALES_MEETING',
        engagementKind: 'SALES_MEETING',
        status,
        title: `Planlanan görüşme ${status}`,
        dueDate: '2026-07-20',
        workflowContext: staffContext(status, status === 'ACCEPTED'
          ? {
            acceptedAt: '2026-07-17T08:30:00.000Z',
            acceptedBy: { id: 's1', name: 'Ayşe Personel' },
          }
          : {}),
      };
      const fetch = await renderScreen(newMeetingJob);
      expect(host.textContent).toContain(newMeetingJob.title);
      expect(fetch.mock.calls.some(([url]) => String(url).includes('/meeting-details'))).toBe(false);
      expect(host.textContent).not.toContain('Görüşme sonucu');
    }
  });

  it('shows assignment-stage notes and schedule edit for assigned Staff in NEW and ACCEPTED', async () => {
    for (const status of ['NEW', 'ACCEPTED'] as const) {
      await act(async () => root.unmount());
      host.remove();
      host = document.createElement('div');
      document.body.append(host);
      root = createRoot(host);

      const card: JobCard = {
        ...job,
        type: 'SALES_MEETING',
        engagementKind: 'SALES_MEETING',
        status,
        title: `Atama aşaması ${status}`,
        dueDate: '2026-07-20',
        scheduledAt: '2026-07-20T09:00:00.000Z',
        assignedTo: staffUser.id,
        workflowContext: staffContext(status, status === 'ACCEPTED'
          ? {
            acceptedAt: '2026-07-17T08:30:00.000Z',
            acceptedBy: { id: 's1', name: 'Ayşe Personel' },
          }
          : {}),
      };
      await renderScreen(card);
      expect(Array.from(host.querySelectorAll('h2')).some((el) => el.textContent === 'Notlar')).toBe(true);
      expect(host.querySelector('.job-notes form')).not.toBeNull();
      expect(host.querySelector('#job-scheduled-at')).not.toBeNull();
      expect(host.querySelector('label[for="job-scheduled-at"]')?.textContent)
        .toContain('Planlanan görüşme zamanı');
    }
  });

  it('hides schedule edit after START even when EDIT_JOB_FIELDS remains allowed', async () => {
    const card: JobCard = {
      ...job,
      type: 'PRODUCT_DELIVERY',
      engagementKind: null,
      status: 'IN_PROGRESS',
      assignedTo: staffUser.id,
      workflowContext: staffContext('IN_PROGRESS', {
        startedAt: '2026-07-17T09:00:00.000Z',
      }, {
        allowedActions: ['EDIT_JOB_FIELDS', 'VIEW_NOTES', 'ADD_NOTE'],
        submissionReadiness: null,
      }),
    };
    await renderScreen(card);
    expect(host.querySelector('#job-scheduled-at')).toBeNull();
    expect(host.textContent).not.toContain('Planlanan zamanı düzenle');
  });

  it('hides notes and schedule edit when backend allowedActions omit them', async () => {
    const card: JobCard = {
      ...job,
      type: 'SALES_MEETING',
      engagementKind: 'SALES_MEETING',
      status: 'NEW',
      title: 'Başka personele kapalı iş',
      dueDate: '2026-07-20',
      assignedTo: 'other-staff',
      workflowContext: staffContext('NEW', {}, { allowedActions: [], allowedCommands: [] }),
    };
    const fetch = await renderScreen(card, { ...staffUser, id: 'other-staff-viewer' });
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/notes'))).toBe(false);
    expect(host.querySelector('.job-notes')).toBeNull();
    expect(host.querySelector('#job-scheduled-at')).toBeNull();
  });

  it('shows read-only notes affordance for waiting and completed review states', async () => {
    for (const status of ['WAITING_APPROVAL', 'COMPLETED'] as const) {
      await act(async () => root.unmount());
      host.remove();
      host = document.createElement('div');
      document.body.append(host);
      root = createRoot(host);

      const card: JobCard = {
        ...inProgressMeeting(),
        status,
        version: 5,
        workflowContext: staffContext(status, {
          startedAt: '2026-07-17T09:00:00.000Z',
          submittedAt: '2026-07-17T10:00:00.000Z',
          ...(status === 'COMPLETED'
            ? { approvedAt: '2026-07-17T11:00:00.000Z' }
            : {}),
        }),
      };
      await renderScreen(card, staffUser, mockDetailFetch(card, {
        notes: {
          items: [{
            id: 'note-1', jobCardId: 'job-1', note: 'Kayıtlı not',
            author: { id: 's1', name: 'Ayşe' }, createdAt: '2026-07-17T09:30:00.000Z',
          }],
          limit: 25, nextCursor: null,
        },
      }));
      expect(host.textContent).toContain('Kayıtlı not');
      expect(host.querySelector('.job-notes form')).toBeNull();
    }
  });

  it('suppresses the empty notes section for cancelled jobs', async () => {
    const card: JobCard = {
      ...inProgressMeeting(),
      status: 'CANCELLED',
      workflowContext: staffContext('CANCELLED', {
        startedAt: '2026-07-17T09:00:00.000Z',
        cancelledAt: '2026-07-17T12:00:00.000Z',
        cancelReason: 'İptal',
        cancelledFromStatus: 'IN_PROGRESS',
      }),
    };
    await renderScreen(card, staffUser, mockDetailFetch(card, {
      notes: { items: [], limit: 25, nextCursor: null },
    }));
    expect(host.querySelector('.job-notes')).toBeNull();
    expect(host.textContent).not.toContain('Henüz iş notu yok');
  });

  it('renders terminal cancellation facts without inventing missing history', async () => {
    await renderDetail(cancelledJob({
      submittedAt: '2026-07-17T10:00:00.000Z',
      revisionRequestedAt: '2026-07-17T11:00:00.000Z',
      revisionRequestedBy: { id: 'm1', name: 'Mehmet Yönetici' },
      revisionReason: 'Miktarı düzeltin',
      cancelledFromStatus: 'REVISION_REQUESTED',
      cancelledAt: '2026-07-17T12:00:00.000Z',
      cancelledBy: { id: 'm1', name: 'Mehmet Yönetici' },
      cancelReason: 'Müşteri vazgeçti',
    }));
    expect(host.textContent).toContain('İptal edildi');
    expect(host.textContent).toContain('Müşteri vazgeçti');
    expect(host.textContent).toContain('Mehmet Yönetici');
    expect(host.textContent).toContain('Düzeltme istendi');
    expect(host.querySelector('.revision-loop')).toBeNull();
    expect(host.querySelector('.workflow-requirements')).toBeNull();
    expect(host.querySelector('[data-job-decision-panel="true"]')).toBeNull();

    await act(async () => {
      root.render(<JobDetailPanel
        job={cancelledJob({
          cancelledFromStatus: null, cancelledAt: null, cancelledBy: null, cancelReason: null,
        })}
        items={[item]}
        user={staffUser}
        pending={false}
        message=""
        onBack={() => {}}
        onCommand={() => {}}
      />);
    });
    // source, actor, time, reason — all missing → no invented history
    expect(host.textContent?.match(/Bilgi kaydedilmemiş/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it('renders completed approval facts without active requirements or actions', async () => {
    const completed: JobCard = {
      ...job,
      status: 'COMPLETED',
      workflowContext: staffContext('COMPLETED', {
        submittedAt: '2026-07-17T10:00:00.000Z',
        approvedAt: '2026-07-17T11:00:00.000Z',
        approvedBy: { id: 'm1', name: 'Mehmet Yönetici' },
      }, { allowedCommands: [], allowedActions: ['VIEW_NOTES'], submissionReadiness: null }),
    };
    await renderDetail(completed);
    expect(host.querySelector('[data-terminal-state="COMPLETED"]')).not.toBeNull();
    expect(host.textContent).toContain('Mehmet Yönetici');
    expect(host.querySelector('time[datetime="2026-07-17T11:00:00.000Z"]')).not.toBeNull();
    expect(host.querySelector('.workflow-requirements')).toBeNull();
    expect(host.querySelector('.detail-action')).toBeNull();
  });

  it('renders terminal panel with final-state structure and metadata', async () => {
    const completed: JobCard = {
      ...job,
      status: 'COMPLETED',
      workflowContext: staffContext('COMPLETED', {
        submittedAt: '2026-07-17T10:00:00.000Z',
        approvedAt: '2026-07-17T11:00:00.000Z',
        approvedBy: { id: 'm1', name: 'Mehmet Yönetici' },
      }, { allowedCommands: [], allowedActions: ['VIEW_NOTES'], submissionReadiness: null }),
    };
    await renderDetail(completed);
    const terminal = section('terminal')!;
    expect(terminal).not.toBeNull();
    // Terminal has final-state label
    expect(terminal.textContent).toContain('Tamamlandı');
    // Terminal has result/explanation text
    expect(terminal.textContent).toContain('İş yönetici kontrolünden geçerek tamamlandı');
    // Terminal has metadata when available
    expect(terminal.textContent).toContain('Mehmet Yönetici');
    expect(terminal.querySelector('time')).not.toBeNull();
    // No responsibility or revision when terminal
    expect(section('responsibility')).toBeNull();
    expect(section('revision')).toBeNull();
    // Terminal before facts
    const facts = section('facts')!;
    expect(terminal.compareDocumentPosition(facts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders cancelled panel without error-like presentation', async () => {
    await renderDetail(cancelledJob({
      cancelledAt: '2026-07-17T12:00:00.000Z',
      cancelledBy: { id: 'm1', name: 'Mehmet Yönetici' },
      cancelReason: 'Müşteri vazgeçti',
      cancelledFromStatus: 'IN_PROGRESS',
    }));
    const terminal = section('terminal')!;
    expect(terminal).not.toBeNull();
    // Terminal has final-state label
    expect(terminal.textContent).toContain('İptal edildi');
    // Terminal has result/explanation
    expect(terminal.textContent).toContain('İş iptal edildi ve yeniden açılamaz');
    // Terminal has metadata
    expect(terminal.textContent).toContain('Mehmet Yönetici');
    expect(terminal.textContent).toContain('Müşteri vazgeçti');
    // No responsibility or revision
    expect(section('responsibility')).toBeNull();
    expect(section('revision')).toBeNull();
    // Terminal before facts
    const facts = section('facts')!;
    expect(terminal.compareDocumentPosition(facts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders labeled invalidation facts without exposing the raw reason enum', async () => {
    await renderDetail(invalidatedJob(), adminUser);
    const terminal = section('terminal')!;
    expect(terminal).not.toBeNull();
    expect(terminal.textContent).toContain('Geçersiz');
    expect(terminal.textContent).toContain('Yanlış müşteriye bağlı');
    expect(terminal.textContent).not.toContain('WRONG_CUSTOMER');
    expect(terminal.textContent).toContain('Sistem yöneticisi');
    expect(host.querySelector('[data-job-invalidation="true"]')).toBeNull();
  });

  it('hides Staff primary lifecycle actions when the viewer is not the assignee', async () => {
    const card = {
      ...inProgressMeeting(),
      // Backend omits staff lifecycle commands for non-assignees; presentation never invents them.
      workflowContext: staffContext('IN_PROGRESS', {
        startedAt: '2026-07-17T09:00:00.000Z',
        acceptedAt: null,
      }, {
        allowedCommands: [],
        allowedActions: ['VIEW_MEETING_RESULT', 'VIEW_NOTES'],
      }),
    };
    await renderDetail(card, { ...staffUser, id: 'other-staff' });
    expect(buttonByName(host, 'Kontrole gönder')).toBeNull();
    expect(buttonByName(host, 'İşi başlat')).toBeNull();
    expect(buttonByName(host, 'İşi kabul et')).toBeNull();
    expect(buttonByName(host, 'İşi iptal et')).toBeNull();
  });

  it('shows staff waiting submission actor and time without inventing missing facts', async () => {
    const waitingCtx = staffContext('WAITING_APPROVAL', {
      startedAt: '2026-07-17T09:00:00.000Z',
      submittedAt: '2026-07-17T10:00:00.000Z',
      submittedBy: { id: 's1', name: 'Ayşe Personel' },
    });
    await renderDetail({
      ...job,
      type: 'SALES_MEETING',
      engagementKind: 'SALES_MEETING',
      status: 'WAITING_APPROVAL',
      workflowContext: waitingCtx,
    });
    expect(host.textContent).toContain('Yönetici kontrolünde');
    expect(host.textContent).toContain('Kontrole gönderen');
    expect(host.textContent).toContain('Ayşe Personel');
    expect(host.textContent).toContain('Gönderim zamanı');

    const missingCtx = staffContext('WAITING_APPROVAL', {
      startedAt: '2026-07-17T09:00:00.000Z',
      submittedAt: null,
      submittedBy: null,
    });
    await renderDetail({
      ...job,
      type: 'SALES_MEETING',
      engagementKind: 'SALES_MEETING',
      status: 'WAITING_APPROVAL',
      workflowContext: missingCtx,
    });
    expect(host.textContent).toContain('Kontrole gönderen');
    expect(host.textContent).toContain('Bilgi kaydedilmemiş');
  });

  it('labels direct and waiting Sales Meeting editing explicitly', () => {
    const directCtx = staffContext('IN_PROGRESS', {
      startedAt: '2026-07-17T09:00:00.000Z',
    });
    const waitingCtx = staffContext('WAITING_APPROVAL', {
      startedAt: '2026-07-17T09:00:00.000Z',
      submittedAt: '2026-07-17T10:00:00.000Z',
    });
    const direct = renderToStaticMarkup(<JobDetailPanel
      job={{ ...job, type: 'SALES_MEETING', status: 'IN_PROGRESS', workflowContext: directCtx }}
      items={[]} user={staffUser} pending={false} message="" onBack={() => {}} onCommand={() => {}} />);
    const waiting = renderToStaticMarkup(<JobDetailPanel
      job={{ ...job, type: 'SALES_MEETING', status: 'WAITING_APPROVAL', workflowContext: waitingCtx }}
      items={[]} user={staffUser} pending={false} message="" onBack={() => {}} onCommand={() => {}} />);
    expect(direct).toContain('Görüşmeyi düzenle');
    expect(direct).toContain('İşi iptal et');
    expect(waiting).toContain('Kontrolden geri çek ve düzenle');
    expect(waiting).toContain('İşi iptal et');
  });

  it('withdraws a waiting Sales Meeting before edit mode opens', async () => {
    const waiting = {
      ...job, type: 'SALES_MEETING' as const, status: 'WAITING_APPROVAL' as const, version: 5,
      engagementKind: 'SALES_MEETING',
    };
    const withdraw = vi.fn().mockResolvedValue({ ...waiting, status: 'IN_PROGRESS', version: 6 });
    await expect(prepareMeetingEdit(waiting, 'edit-action-1', withdraw)).resolves.toMatchObject({
      status: 'IN_PROGRESS', version: 6,
    });
    expect(withdraw).toHaveBeenCalledWith(waiting.id, {
      clientActionId: 'edit-action-1', expectedVersion: 5,
    });
  });

  it('renders immutable delivery facts and the next valid command', () => {
    const html = renderToStaticMarkup(<JobDetailPanel
      job={job} items={[item]} user={staffUser} pending={false} message=""
      onBack={() => {}} onCommand={() => {}} />);
    expect(html).toContain('ABC Klinik ürün teslimi');
    expect(html).not.toContain('Sürüm 2');
    expect(html).toContain('İmplant Seti');
    expect(html).toContain('Numune');
    expect(html).toContain('2 adet');
    expect(html).toContain('İşi kabul et');
    expect(html).toContain('Planlanan teslim zamanı');
    expect(html).toContain('Gerçekleşen teslim zamanı');
    expect(html).not.toMatch(/>Planla</);
    expect(html.match(/primary-button/g)?.length ?? 0).toBe(1);
  });

  it('exposes actual delivery time editor when EDIT_DELIVERY_ACTUAL_TIME is allowed', () => {
    const inProgress: JobCard = {
      ...job,
      status: 'IN_PROGRESS',
      version: 3,
      workflowContext: staffContext('IN_PROGRESS', {
        startedAt: '2026-07-17T09:00:00.000Z',
      }, {
        allowedActions: ['EDIT_JOB_FIELDS', 'EDIT_DELIVERY_ACTUAL_TIME', 'VIEW_NOTES', 'ADD_NOTE'],
        submissionReadiness: null,
      }),
    };
    const plannedItem = { ...item, deliveredAt: null };
    const html = renderToStaticMarkup(<JobDetailPanel
      job={inProgress}
      items={[plannedItem]}
      user={staffUser}
      pending={false}
      message=""
      onBack={() => {}}
      onCommand={() => {}}
      onSaveDeliveredAt={async () => {}}
    />);
    expect(html).toContain('Planlanan teslim zamanı');
    expect(html).toContain('Gerçekleşen teslim zamanı');
    expect(html).toContain(`id="delivery-actual-at-${plannedItem.id}"`);
    expect(html).toContain('Gerçekleşen teslim zamanını kaydet');
    expect(html).not.toContain('Henüz kaydedilmedi');
  });

  it('prefills a null deliveredAt with the current local value without changing existing values', () => {
    vi.useFakeTimers();
    const now = new Date('2026-08-17T15:06:30.000Z');
    vi.setSystemTime(now);
    try {
      const inProgress: JobCard = {
        ...job,
        status: 'IN_PROGRESS',
        version: 3,
        workflowContext: staffContext('IN_PROGRESS', {
          startedAt: '2026-08-17T14:00:00.000Z',
        }, {
          allowedActions: ['EDIT_JOB_FIELDS', 'EDIT_DELIVERY_ACTUAL_TIME', 'VIEW_NOTES', 'ADD_NOTE'],
          submissionReadiness: null,
        }),
      };
      const plannedItem = { ...item, deliveredAt: null };
      const existingItem = { ...item, deliveredAt: '2026-08-17T11:04:00.000Z' };
      const localParts = (value: Date) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
        + `T${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`;
      const expectedNow = localParts(now);
      const expectedExisting = localParts(new Date(existingItem.deliveredAt));
      const html = renderToStaticMarkup(<JobDetailPanel
        job={inProgress}
        items={[plannedItem, existingItem]}
        user={staffUser}
        pending={false}
        message=""
        onBack={() => {}}
        onCommand={() => {}}
        onSaveDeliveredAt={async () => {}}
      />);

      expect(html).toContain(`id="delivery-actual-at-${plannedItem.id}"`);
      expect(html).toContain(`value="${expectedNow}"`);
      expect(html).toContain(`id="delivery-actual-at-${existingItem.id}"`);
      expect(html).toContain(`value="${expectedExisting}"`);
      expect(html).not.toContain('value=""');
    } finally {
      vi.useRealTimers();
    }
  });

  it('hides actual delivery editor without EDIT_DELIVERY_ACTUAL_TIME even with EDIT_JOB_FIELDS', () => {
    const accepted: JobCard = {
      ...job,
      status: 'ACCEPTED',
      version: 2,
      workflowContext: staffContext('ACCEPTED', {
        acceptedAt: '2026-07-17T08:30:00.000Z',
        acceptedBy: { id: 's1', name: 'Ayşe Personel' },
      }, {
        allowedActions: ['EDIT_JOB_FIELDS', 'VIEW_NOTES', 'ADD_NOTE'],
        submissionReadiness: null,
      }),
    };
    const plannedItem = { ...item, deliveredAt: null };
    const html = renderToStaticMarkup(<JobDetailPanel
      job={accepted}
      items={[plannedItem]}
      user={staffUser}
      pending={false}
      message=""
      onBack={() => {}}
      onCommand={() => {}}
      onSaveDeliveredAt={async () => {}}
    />);
    expect(html).toContain('Henüz kaydedilmedi');
    expect(html).not.toContain(`id="delivery-actual-at-${plannedItem.id}"`);
  });

  it('shows start as primary after assignment acceptance', () => {
    const accepted: JobCard = {
      ...job,
      status: 'ACCEPTED',
      workflowContext: staffContext('ACCEPTED', {
        acceptedAt: '2026-07-17T08:30:00.000Z',
        acceptedBy: { id: 's1', name: 'Ayşe Personel' },
      }, { allowedActions: [] }),
    };
    const html = renderToStaticMarkup(<JobDetailPanel
      job={accepted} items={[item]} user={staffUser} pending={false} message=""
      onBack={() => {}} onCommand={() => {}} />);
    expect(html).toContain('İşi başlat');
    expect(html).not.toContain('İşi kabul et');
    expect(html.match(/primary-button/g)?.length ?? 0).toBe(1);
  });

  it('keeps disabled capability on the legacy start payload without browser geolocation', async () => {
    const accepted: JobCard = {
      ...job,
      status: 'ACCEPTED',
      workflowContext: staffContext('ACCEPTED', {
        acceptedAt: '2026-07-17T08:30:00.000Z',
        acceptedBy: { id: 's1', name: 'Ayşe Personel' },
      }, { allowedActions: [], startLocationCaptureEnabled: false }),
    };
    const updated: JobCard = {
      ...accepted,
      status: 'IN_PROGRESS',
      version: accepted.version + 1,
      workflowContext: staffContext('IN_PROGRESS', {
        startedAt: '2026-07-17T09:00:00.000Z',
      }),
    };
    const getCurrentPosition = vi.fn();
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition } });
    const startBodies: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/delivery-items')) return Response.json({ items: [item] });
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/start') && init?.method === 'POST') {
        startBodies.push(JSON.parse(String(init.body)));
        return Response.json(updated);
      }
      if (url.endsWith(`/api/job-cards/${accepted.id}`)) return Response.json(accepted);
      throw new Error(`Unexpected request: ${url}`);
    });
    await renderScreen(accepted, staffUser, fetch);

    expect(host.textContent).not.toContain('cihazınızdan bir kez yaklaşık konum');
    await act(async () => {
      buttonByName(host, 'İşi başlat')?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(getCurrentPosition).not.toHaveBeenCalled();
    expect(startBodies).toHaveLength(1);
    expect(startBodies[0]).toEqual(expect.objectContaining({ expectedVersion: accepted.version }));
    expect(startBodies[0]).not.toHaveProperty('locationCapture');
  });

  it('captures once and reuses the same envelope and action id on transport retry', async () => {
    const accepted: JobCard = {
      ...job,
      status: 'ACCEPTED',
      workflowContext: staffContext('ACCEPTED', {
        acceptedAt: '2026-07-17T08:30:00.000Z',
        acceptedBy: { id: 's1', name: 'Ayşe Personel' },
      }, { allowedActions: [], startLocationCaptureEnabled: true }),
    };
    const updated: JobCard = {
      ...accepted,
      status: 'IN_PROGRESS',
      version: accepted.version + 1,
      workflowContext: staffContext('IN_PROGRESS', {
        startedAt: '2026-07-17T09:00:00.000Z',
      }),
    };
    const getCurrentPosition = vi.fn((success: PositionCallback) => success({
      coords: { latitude: 39.92077, longitude: 32.85411, accuracy: 24.5 },
    } as GeolocationPosition));
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition } });
    const startBodies: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/delivery-items')) return Response.json({ items: [item] });
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/start') && init?.method === 'POST') {
        startBodies.push(JSON.parse(String(init.body)));
        if (startBodies.length === 1) throw new TypeError('offline');
        return Response.json(updated);
      }
      if (url.endsWith(`/api/job-cards/${accepted.id}`)) return Response.json(accepted);
      throw new Error(`Unexpected request: ${url}`);
    });
    await renderScreen(accepted, staffUser, fetch);

    expect(host.textContent).toContain('cihazınızdan bir kez yaklaşık konum');
    await act(async () => {
      const start = buttonByName(host, 'İşi başlat');
      start?.click();
      start?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain('Sunucuya ulaşılamadı');
    await act(async () => {
      buttonByName(host, 'İşi başlat')?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(getCurrentPosition).toHaveBeenCalledOnce();
    expect(startBodies).toHaveLength(2);
    expect(startBodies[1]).toEqual(startBodies[0]);
    expect(startBodies[0]).toMatchObject({
      expectedVersion: accepted.version,
      locationCapture: {
        outcome: 'captured', latitude: 39.92077, longitude: 32.85411,
        accuracyMeters: 24.5,
      },
    });
  });

  it('locks the start action synchronously and announces the capture phase', async () => {
    const accepted: JobCard = {
      ...job,
      status: 'ACCEPTED',
      workflowContext: staffContext('ACCEPTED', {
        acceptedAt: '2026-07-17T08:30:00.000Z',
        acceptedBy: { id: 's1', name: 'Ayşe Personel' },
      }, { allowedActions: [], startLocationCaptureEnabled: true }),
    };
    let succeed: PositionCallback | undefined;
    const getCurrentPosition = vi.fn((success: PositionCallback) => { succeed = success; });
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition } });
    await renderScreen(accepted);

    act(() => {
      const start = buttonByName(host, 'İşi başlat');
      start?.click();
      start?.click();
    });

    const pendingButton = buttonByName(host, 'Konum alınıyor…') as HTMLButtonElement;
    expect(pendingButton?.disabled).toBe(true);
    expect(getCurrentPosition).toHaveBeenCalledOnce();

    await act(async () => {
      succeed?.({ coords: { latitude: 39, longitude: 32, accuracy: 50 } } as GeolocationPosition);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });

  it('does not show acceptance action for manager on NEW', () => {
    const managerNew: JobCard = {
      ...job,
      workflowContext: staffContext('NEW', {}, {
        allowedCommands: ['CANCEL'],
        allowedActions: [],
      }),
    };
    const html = renderToStaticMarkup(<JobDetailPanel
      job={managerNew} items={[item]} user={managerUser} pending={false} message=""
      onBack={() => {}} onCommand={() => {}} />);
    expect(html).not.toContain('İşi kabul et');
    expect(html).toContain('İşi iptal et');
  });

  it('renders quantity without a fabricated unit when the Product unit is null', () => {
    const html = renderToStaticMarkup(<JobDetailPanel
      job={job} items={[{ ...item, quantity: 3, unit: null }]} user={staffUser}
      pending={false} message="" onBack={() => {}} onCommand={() => {}} />);
    expect(html).toContain('<dd>3</dd>');
    expect(html).not.toContain('3 adet');
    expect(html).not.toContain('3 null');
  });

  it('renders shared General Task facts and no Product Delivery section', () => {
    const html = renderToStaticMarkup(<JobDetailPanel job={generalTask} items={[]} user={staffUser}
      pending={false} message="" onBack={() => {}} onCommand={() => {}}>
      <section>Notlar ve zaman çizelgesi</section>
    </JobDetailPanel>);

    expect(html).toContain('Genel görev');
    expect(html).toContain('Teklif dönüşünü takip et');
    expect(html).toContain('Doktorun kararını öğren ve sonucu karta yaz.');
    expect(html).toContain('Ayşe Personel');
    expect(html).toContain('Demo Dental Klinik');
    expect(html).toContain('Dr. Deniz');
    expect(html).toContain('Yüksek');
    expect(html).toContain('2026-07-20');
    expect(html).toContain('Notlar ve zaman çizelgesi');
    expect(html).not.toContain('Teslim bilgileri');
    expect(html).not.toContain('Ürün teslimi');
  });

  it('patches deliveredAt and refreshes submission readiness for Product Delivery', async () => {
    const missingReadiness = {
      evaluatedAt: '2026-07-17T12:00:00.000Z',
      ready: false,
      items: [
        { code: 'DELIVERY_ITEM_PRESENT' as const, state: 'met' as const },
        { code: 'DELIVERY_ITEMS_VALID' as const, state: 'invalid' as const },
        { code: 'CUSTOMER_ELIGIBLE' as const, state: 'met' as const },
      ],
    };
    const metReadiness = {
      evaluatedAt: '2026-07-17T12:05:00.000Z',
      ready: true,
      items: [
        { code: 'DELIVERY_ITEM_PRESENT' as const, state: 'met' as const },
        { code: 'DELIVERY_ITEMS_VALID' as const, state: 'met' as const },
        { code: 'CUSTOMER_ELIGIBLE' as const, state: 'met' as const },
      ],
    };
    const plannedItem = { ...item, deliveredAt: null };
    const savedItem = { ...item, deliveredAt: '2026-07-17T14:00:00.000Z' };
    const initialCard: JobCard = {
      ...job,
      status: 'IN_PROGRESS',
      version: 3,
      assignedTo: staffUser.id,
      workflowContext: staffContext('IN_PROGRESS', {
        startedAt: '2026-07-17T09:00:00.000Z',
      }, {
        allowedActions: ['EDIT_JOB_FIELDS', 'EDIT_DELIVERY_ACTUAL_TIME', 'VIEW_NOTES', 'ADD_NOTE'],
        submissionReadiness: missingReadiness,
      }),
    };
    const refreshedCard: JobCard = {
      ...initialCard,
      version: 4,
      workflowContext: staffContext('IN_PROGRESS', {
        startedAt: '2026-07-17T09:00:00.000Z',
      }, {
        allowedActions: ['EDIT_JOB_FIELDS', 'EDIT_DELIVERY_ACTUAL_TIME', 'VIEW_NOTES', 'ADD_NOTE'],
        submissionReadiness: metReadiness,
      }),
    };
    let currentCard = initialCard;
    let currentItems = [plannedItem];
    const patchBodies: unknown[] = [];
    const flush = async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    const change = (element: HTMLInputElement, value: string) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
        ?.set?.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/delivery-items/') && init?.method === 'PATCH') {
        patchBodies.push(JSON.parse(String(init.body)));
        currentItems = [savedItem];
        currentCard = refreshedCard;
        return Response.json({ item: savedItem, jobCardVersion: 4 });
      }
      if (url.endsWith('/delivery-items')) return Response.json({ items: currentItems });
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/api/job-cards/job-1')) return Response.json(currentCard);
      throw new Error(`Unexpected request: ${url}`);
    }));

    await act(async () => {
      root.render(<JobDetailScreen
        jobId={initialCard.id}
        user={staffUser}
        onBack={() => {}}
        onChanged={() => {}}
      />);
      await flush();
    });

    const actualInput = host.querySelector(`#delivery-actual-at-${plannedItem.id}`) as HTMLInputElement;
    expect(actualInput).not.toBeNull();
    expect(host.textContent).toContain('Gerçekleşen teslim zamanı');
    const requirementLabel = 'Ürün, amaç, miktar ve teslim zamanı';
    const invalidItem = Array.from(host.querySelectorAll('.workflow-requirement'))
      .find((el) => el.querySelector('.workflow-requirement-label')?.textContent
        === requirementLabel);
    expect(invalidItem?.querySelector('.workflow-requirement-state')?.textContent)
      .toMatch(/Geçersiz|Eksik/);

    await act(async () => {
      change(actualInput, '2026-07-17T17:00');
    });
    await act(async () => {
      (host.querySelector('form.delivery-actual-time-form') as HTMLFormElement).requestSubmit();
      await flush();
      await flush();
    });

    expect(patchBodies).toHaveLength(1);
    expect(patchBodies[0]).toMatchObject({
      expectedVersion: 3,
      deliveredAt: expect.stringMatching(/Z$|[+-]\d{2}:\d{2}$/),
    });
    expect(host.textContent).toContain('Gerçekleşen teslim zamanı kaydedildi.');
    const metItem = Array.from(host.querySelectorAll('.workflow-requirement'))
      .find((el) => el.querySelector('.workflow-requirement-label')?.textContent
        === requirementLabel);
    expect(metItem?.querySelector('.workflow-requirement-state')?.textContent).toBe('Tamam');
  });

  it('refreshes backend submission readiness after meeting result save', async () => {
    const missingReadiness = {
      evaluatedAt: '2026-07-17T12:00:00.000Z',
      ready: false,
      items: [
        { code: 'MEETING_TIME_VALID' as const, state: 'missing' as const },
        { code: 'MEETING_OUTCOME_VALID' as const, state: 'missing' as const },
        { code: 'MEETING_SUMMARY_PRESENT' as const, state: 'missing' as const },
      ],
    };
    const metReadiness = {
      evaluatedAt: '2026-07-17T12:05:00.000Z',
      ready: true,
      items: [
        { code: 'MEETING_TIME_VALID' as const, state: 'met' as const },
        { code: 'MEETING_OUTCOME_VALID' as const, state: 'met' as const },
        { code: 'MEETING_SUMMARY_PRESENT' as const, state: 'met' as const },
      ],
    };
    const emptyMeeting: MeetingDetails = {
      jobCardId: 'job-1', meetingAt: null, outcome: null, meetingSummary: null,
      nextFollowUpAt: null, jobCardVersion: 3,
    };
    const savedMeeting: MeetingDetails = {
      jobCardId: 'job-1', meetingAt: '2026-07-16T10:00:00.000Z', outcome: 'POSITIVE',
      meetingSummary: 'Olumlu görüşme', nextFollowUpAt: null, jobCardVersion: 4,
    };
    const initialCard: JobCard = {
      ...inProgressMeeting(),
      version: 3,
      assignedTo: staffUser.id,
      workflowContext: staffContext('IN_PROGRESS', {
        startedAt: '2026-07-17T09:00:00.000Z',
      }, { submissionReadiness: missingReadiness }),
    };
    const refreshedCard: JobCard = {
      ...initialCard,
      version: 4,
      workflowContext: staffContext('IN_PROGRESS', {
        startedAt: '2026-07-17T09:00:00.000Z',
      }, { submissionReadiness: metReadiness }),
    };
    let currentCard = initialCard;
    let currentMeeting = emptyMeeting;
    const flush = async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    const change = (
      element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
      value: string,
    ) => {
      const prototype = element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
      element.dispatchEvent(new Event(
        element instanceof HTMLSelectElement ? 'change' : 'input',
        { bubbles: true },
      ));
    };
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      configurable: true,
      value: vi.fn(() => 'meeting-save-1'),
    });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/meeting-details') && init?.method === 'PATCH') {
        currentMeeting = savedMeeting;
        currentCard = refreshedCard;
        return Response.json(savedMeeting);
      }
      if (url.endsWith('/meeting-details')) return Response.json(currentMeeting);
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/api/job-cards/job-1')) return Response.json(currentCard);
      throw new Error(`Unexpected request: ${url}`);
    }));

    await act(async () => {
      root.render(<JobDetailScreen
        jobId={initialCard.id}
        user={staffUser}
        onBack={() => {}}
        onChanged={() => {}}
      />);
      await flush();
    });

    for (const label of [
      'Gerçekleşen görüşme zamanı',
      'Görüşme sonucu',
      'Görüşme özeti',
    ]) {
      const item = Array.from(host.querySelectorAll('.workflow-requirement'))
        .find((el) => el.querySelector('.workflow-requirement-label')?.textContent === label);
      expect(item?.querySelector('.workflow-requirement-state')?.textContent).toBe('Eksik');
    }
    expect(buttonByName(host, 'Kontrole gönder')).not.toBeNull();

    await act(async () => {
      change(host.querySelector('#meeting-actual-at') as HTMLInputElement, '2026-07-16T13:00');
      change(host.querySelector('#meeting-outcome') as HTMLSelectElement, 'POSITIVE');
      change(host.querySelector('#meeting-summary') as HTMLTextAreaElement, 'Olumlu görüşme');
    });
    await act(async () => {
      (host.querySelector('form.meeting-result-form') as HTMLFormElement).requestSubmit();
      await flush();
      await flush();
    });

    expect(host.textContent).toContain('Görüşme sonucu kaydedildi.');
    for (const label of [
      'Gerçekleşen görüşme zamanı',
      'Görüşme sonucu',
      'Görüşme özeti',
    ]) {
      const item = Array.from(host.querySelectorAll('.workflow-requirement'))
        .find((el) => el.querySelector('.workflow-requirement-label')?.textContent === label);
      expect(item?.querySelector('.workflow-requirement-state')?.textContent).toBe('Tamam');
    }
    expect(buttonByName(host, 'Kontrole gönder')).not.toBeNull();
  });

  it('uses exactly one structured subresource for each canonical type', () => {
    const source = readFileSync(`${process.cwd()}/src/JobDetail.tsx`, 'utf8');

    expect(source).toContain("if (job.type === 'PRODUCT_DELIVERY')");
    expect(source).toContain("if (job.type === 'GENERAL_TASK')");
    expect(source).toContain('VIEW_MEETING_RESULT');
    expect(source).toContain('listDeliveryItems');
    expect(source).toContain('getMeetingDetails');
    expect(source).toContain('className="delivery-lines"');
  });

  it('shows submit only after the backend status is IN_PROGRESS', () => {
    const inProgress = {
      ...job,
      status: 'IN_PROGRESS' as const,
      version: 3,
      workflowContext: staffContext('IN_PROGRESS', {
        startedAt: '2026-07-17T09:00:00.000Z',
      }, {
        allowedActions: [],
        submissionReadiness: {
          evaluatedAt: '2026-07-17T12:00:00.000Z', ready: true,
          items: [{ code: 'DELIVERY_ITEM_PRESENT', state: 'met' }],
        },
      }),
    };
    const html = renderToStaticMarkup(<JobDetailPanel job={inProgress} items={[item]}
      user={staffUser} pending={false} message="" onBack={() => {}} onCommand={() => {}} />);
    expect(html).toContain('Kontrole gönder');
    expect(html).not.toContain('İşi başlat');
  });

  it('uses the current backend version for start and submit', async () => {
    const start = vi.fn().mockResolvedValue({ ...job, status: 'IN_PROGRESS', version: 3 });
    const submit = vi.fn().mockResolvedValue({ ...job, status: 'WAITING_APPROVAL', version: 4 });
    const refresh = vi.fn();
    await runStaffJobCommand(job, 'start', { start, submit, refresh, createActionId: () => 'action-1' });
    await runStaffJobCommand({ ...job, status: 'IN_PROGRESS', version: 3 }, 'submit', {
      start, submit, refresh, createActionId: () => 'action-2',
    }, 'Teslim tamamlandı');
    expect(start).toHaveBeenCalledWith('job-1', { clientActionId: 'action-1', expectedVersion: 2 });
    expect(submit).toHaveBeenCalledWith('job-1', {
      clientActionId: 'action-2', expectedVersion: 3, note: 'Teslim tamamlandı',
    });

    submit.mockClear();
    await runStaffJobCommand({
      ...job,
      type: 'SALES_MEETING',
      engagementKind: 'CUSTOMER_VISIT',
      status: 'IN_PROGRESS',
      version: 3,
    }, 'submit', {
      start, submit, refresh, createActionId: () => 'action-3',
    }, 'Ziyaret tamamlandı', {
      scheduledAt: '2026-07-24T10:00:00.000Z',
      type: 'SALES_MEETING',
      assignedTo: 's1',
      followUpInstructions: 'Takip: Ziyaret',
    });
    expect(submit).toHaveBeenCalledWith('job-1', {
      clientActionId: 'action-3', expectedVersion: 3, note: 'Ziyaret tamamlandı',
      followUpProposal: expect.objectContaining({
        type: 'SALES_MEETING',
        assignedTo: 's1',
        followUpInstructions: expect.any(String),
      }),
    });
  });

  it('refetches and explains a stale-version conflict', async () => {
    const refreshed = { ...job, status: 'IN_PROGRESS' as const, version: 3 };
    const refresh = vi.fn().mockResolvedValue(refreshed);
    const result = await runStaffJobCommand(job, 'start', {
      start: vi.fn().mockRejectedValue(new ApiError(409, 'VERSION_CONFLICT', 'Kart güncellendi.')),
      submit: vi.fn(), refresh, createActionId: () => 'action-1',
    });
    expect(result).toEqual({ kind: 'conflict', job: refreshed });
    expect(refresh).toHaveBeenCalledWith('job-1');
  });

  it('does not re-derive permissions from local capability helpers', () => {
    const source = readFileSync(`${process.cwd()}/src/JobDetail.tsx`, 'utf8');
    expect(source).not.toContain('jobCapabilities');
    expect(source).not.toContain('availableLifecycleCommands');
    expect(source).not.toContain('primaryLifecycleCommand');
    expect(source).toContain('deriveJobWorkflowPresentation');
  });

  it('uses presentation successMessage only — no generic command label concatenation', () => {
    const source = readFileSync(`${process.cwd()}/src/JobDetail.tsx`, 'utf8');
    expect(source).toContain('transition.successMessage');
    expect(source).not.toContain('işlemi tamamlandı');
    expect(source).not.toMatch(/\$\{transition\?\.label/);
  });

  it.each([
    {
      command: 'SUBMIT_FOR_APPROVAL' as const,
      expected: 'İş yönetici kontrolüne gönderildi. Kontrol tamamlanana veya iş geri çekilene kadar kayıtlar düzenlenemez.',
      setup: () => {
        const card = {
          ...job,
          status: 'IN_PROGRESS' as const,
          version: 3,
          workflowContext: staffContext('IN_PROGRESS', {
            startedAt: '2026-07-17T09:00:00.000Z',
          }, {
            allowedActions: [],
            submissionReadiness: {
              evaluatedAt: '2026-07-17T12:00:00.000Z', ready: true,
              items: [{ code: 'DELIVERY_ITEM_PRESENT' as const, state: 'met' as const }],
            },
          }),
        };
        return {
          card,
          user: staffUser,
          trigger: 'Kontrole gönder',
          endpoint: '/submit-for-approval',
          next: {
            ...card,
            status: 'WAITING_APPROVAL' as const,
            version: 4,
            workflowContext: staffContext('WAITING_APPROVAL', {
              startedAt: '2026-07-17T09:00:00.000Z',
              submittedAt: '2026-07-17T12:00:00.000Z',
            }, { allowedActions: [] }),
          },
          confirm: 'Tamamla ve yönetici onayına gönder',
          reason: 'Teslim tamamlandı',
          needsDialog: true as const,
        };
      },
    },
    {
      command: 'APPROVE' as const,
      expected: 'İş tamamlandı.',
      setup: () => {
        const card = {
          ...job,
          status: 'WAITING_APPROVAL' as const,
          version: 4,
          workflowContext: contextWith({
            allowedCommands: ['APPROVE', 'REQUEST_REVISION', 'CANCEL'],
            allowedActions: ['VIEW_NOTES'],
            lifecycle: {
              ...baseLifecycle,
              startedAt: '2026-07-17T09:00:00.000Z',
              submittedAt: '2026-07-17T10:00:00.000Z',
              submittedBy: { id: 's1', name: 'Ayşe Personel' },
            },
            submissionReadiness: null,
          }),
        };
        return {
          card,
          user: managerUser,
          trigger: 'Kontrolü tamamla ve işi kapat',
          confirm: 'İşi onayla',
          endpoint: '/approve',
          next: {
            ...card,
            status: 'COMPLETED' as const,
            version: 5,
            workflowContext: contextWith({
              allowedCommands: [],
              allowedActions: ['VIEW_NOTES'],
              lifecycle: {
                ...baseLifecycle,
                startedAt: '2026-07-17T09:00:00.000Z',
                submittedAt: '2026-07-17T10:00:00.000Z',
                approvedAt: '2026-07-17T11:00:00.000Z',
              },
              submissionReadiness: null,
            }),
          },
          needsDialog: true as const,
        };
      },
    },
    {
      command: 'REQUEST_REVISION' as const,
      expected: 'İş düzeltme için personele geri gönderildi.',
      setup: () => {
        const card = {
          ...job,
          status: 'WAITING_APPROVAL' as const,
          version: 4,
          workflowContext: contextWith({
            allowedCommands: ['APPROVE', 'REQUEST_REVISION', 'CANCEL'],
            allowedActions: ['VIEW_NOTES'],
            lifecycle: {
              ...baseLifecycle,
              startedAt: '2026-07-17T09:00:00.000Z',
              submittedAt: '2026-07-17T10:00:00.000Z',
              submittedBy: { id: 's1', name: 'Ayşe Personel' },
            },
            submissionReadiness: null,
          }),
        };
        return {
          card,
          user: managerUser,
          trigger: 'Düzeltme için personele geri gönder',
          confirm: 'Düzeltme için geri gönder',
          reason: 'Miktarı düzeltin',
          endpoint: '/request-revision',
          next: {
            ...card,
            status: 'REVISION_REQUESTED' as const,
            version: 5,
            workflowContext: contextWith({
              allowedCommands: [],
              allowedActions: ['VIEW_NOTES'],
              lifecycle: {
                ...baseLifecycle,
                startedAt: '2026-07-17T09:00:00.000Z',
                submittedAt: '2026-07-17T10:00:00.000Z',
                revisionRequestedAt: '2026-07-17T11:00:00.000Z',
                revisionReason: 'Miktarı düzeltin',
              },
              submissionReadiness: null,
            }),
          },
          needsDialog: true as const,
        };
      },
    },
    {
      command: 'RESUME' as const,
      expected: 'İş yeniden düzenlemeye açıldı. Tamamladığınızda tekrar kontrole gönderin.',
      setup: () => {
        const card = revisionRequestedJob({ revisionReason: 'Miktarı düzeltin' });
        return {
          card,
          user: staffUser,
          trigger: 'Düzeltmeye başla',
          endpoint: '/resume',
          next: {
            ...card,
            status: 'IN_PROGRESS' as const,
            version: card.version + 1,
            workflowContext: staffContext('IN_PROGRESS', {
              startedAt: '2026-07-17T09:00:00.000Z',
              acceptedAt: '2026-07-17T08:30:00.000Z',
              acceptedBy: { id: 's1', name: 'Ayşe Personel' },
              submittedAt: '2026-07-17T10:00:00.000Z',
              revisionRequestedAt: '2026-07-17T11:00:00.000Z',
              revisionReason: 'Miktarı düzeltin',
            }),
          },
          needsDialog: false as const,
        };
      },
    },
  ])('uses presentation success copy for $command', async ({ command, expected, setup }) => {
    const scenario = setup();
    const flush = async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/delivery-items')) {
        return Response.json({ items: scenario.card.type === 'PRODUCT_DELIVERY' ? [item] : [] });
      }
      if (url.endsWith('/meeting-details')) {
        return Response.json({ ...meetingDetails, jobCardVersion: scenario.card.version });
      }
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith(scenario.endpoint) && init?.method === 'POST') {
        return Response.json(scenario.next);
      }
      if (url.endsWith(`/api/job-cards/${scenario.card.id}`)) {
        return Response.json(scenario.card);
      }
      if (url.includes('/follow-up-suggestion')) {
        return Response.json({
          scheduledAt: '2026-07-24T10:00:00.000Z',
          type: scenario.card.type === 'GENERAL_TASK' ? 'GENERAL_TASK' : 'SALES_MEETING',
          assignedTo: scenario.card.assignedTo,
          followUpInstructions: 'Takip: Test takibi',
          evaluation: {
            level: 'CLEAR', safeMessage: null, conflicts: [], recentVisit: null,
            suggestedAlternativeAt: null,
          },
        });
      }
      if (url.endsWith('/api/calendar/assignees')) {
        return Response.json({ items: [{ id: 's1', name: 'Ayşe Personel' }] });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    await act(async () => {
      root.render(<JobDetailScreen
        jobId={scenario.card.id}
        user={scenario.user}
        onBack={() => {}}
        onChanged={() => {}}
      />);
      await flush();
    });

    const trigger = buttonByName(host, scenario.trigger)!;
    expect(trigger).not.toBeNull();
    await act(async () => { trigger.click(); await flush(); });

    if (scenario.needsDialog) {
      const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
      expect(dialog).not.toBeNull();
      if (command === 'SUBMIT_FOR_APPROVAL') {
        expect(dialog.textContent).toContain('Tamamlanma sonucu');
        expect(dialog.textContent).toContain(
          'Bu açıklama, yönetici kontrolüne gönderilen iş kaydında saklanır.',
        );
        await act(async () => {
          buttonByName(dialog, scenario.confirm!)!.click();
          await flush();
        });
        expect(dialog.querySelector('[role="alert"]')?.textContent)
          .toContain('Tamamlanma sonucu zorunludur.');
        expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith(scenario.endpoint)))
          .toBe(false);
      }
      if (command === 'APPROVE') expect(dialog.textContent).toContain('Onay notu');
      if ('reason' in scenario && scenario.reason) {
        const textarea = dialog.querySelector<HTMLTextAreaElement>('form textarea')!;
        await act(async () => {
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
            ?.set?.call(textarea, scenario.reason);
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
        });
      }
      await act(async () => {
        buttonByName(dialog, scenario.confirm!)!.click();
        await flush();
      });
    }

    const transitionCall = vi.mocked(fetch).mock.calls.find(([url, init]) =>
      String(url).endsWith(scenario.endpoint) && (init as RequestInit | undefined)?.method === 'POST');
    const transitionBody = transitionCall
      ? JSON.parse(String((transitionCall[1] as RequestInit).body))
      : null;
    if (command === 'SUBMIT_FOR_APPROVAL') {
      expect(transitionBody).toMatchObject({ note: 'Teslim tamamlandı' });
      expect(Object.keys(transitionBody).filter((key) => key === 'note')).toHaveLength(1);
    }
    if (command === 'APPROVE') expect(transitionBody).not.toHaveProperty('note');

    const feedback = host.querySelector<HTMLElement>('[role="status"]');
    expect(feedback?.textContent).toBe(expected);
  });

  it('discards a pending Job A accept response after navigation to Job B', async () => {
    const source = new FakeRealtimeEventSource();
    const jobB: JobCard = {
      ...job,
      id: 'job-2',
      title: 'B İşi — Klinik kontrolü',
      workflowContext: staffContext('NEW', { createdAt: '2026-07-17T08:00:00.000Z' }, {
        allowedActions: [],
        submissionReadiness: null,
      }),
    };
    const acceptedA: JobCard = {
      ...job,
      status: 'ACCEPTED',
      version: job.version + 1,
      workflowContext: staffContext('ACCEPTED', {
        acceptedAt: '2026-07-17T08:30:00.000Z',
        acceptedBy: { id: 's1', name: 'Ayşe Personel' },
      }, { allowedActions: [] }),
    };
    let resolveAccept: (value: Response) => void = () => {};
    const acceptGate = new Promise<Response>((resolve) => { resolveAccept = resolve; });
    const onChanged = vi.fn();
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/delivery-items')) return Response.json({ items: [item] });
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/accept') && init?.method === 'POST') return acceptGate;
      if (url.endsWith('/api/job-cards/job-1')) return Response.json(job);
      if (url.endsWith('/api/job-cards/job-2')) return Response.json(jobB);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-1" user={staffUser} onBack={() => {}} onChanged={onChanged} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      buttonByName(host, 'İşi kabul et')?.click();
      await Promise.resolve();
    });

    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-2" user={staffUser} onBack={() => {}} onChanged={onChanged} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain('B İşi — Klinik kontrolü');

    await act(async () => {
      resolveAccept(Response.json(acceptedA));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.textContent).toContain('B İşi — Klinik kontrolü');
    expect(host.textContent).not.toContain('ABC Klinik ürün teslimi');
    expect(host.textContent).not.toContain('İş kabul edildi.');
    expect(host.textContent).not.toContain('DurumKabul edildi');
    const acceptB = buttonByName(host, 'İşi kabul et');
    expect(acceptB).not.toBeNull();
    expect((acceptB as HTMLButtonElement).disabled).toBe(false);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('discards an old Job A START refresh continuation after navigation to Job B', async () => {
    const source = new FakeRealtimeEventSource();
    const meetingA: JobCard = {
      ...inProgressMeeting(),
      status: 'ACCEPTED',
      version: 3,
      title: 'A Görüşmesi — Başlatılacak',
      workflowContext: staffContext('ACCEPTED', {
        acceptedAt: '2026-07-17T08:30:00.000Z',
        acceptedBy: { id: 's1', name: 'Ayşe Personel' },
      }, { allowedActions: [], startLocationCaptureEnabled: false }),
    };
    const startedA: JobCard = {
      ...meetingA,
      status: 'IN_PROGRESS',
      version: meetingA.version + 1,
      workflowContext: staffContext('IN_PROGRESS', {
        acceptedAt: '2026-07-17T08:30:00.000Z',
        acceptedBy: { id: 's1', name: 'Ayşe Personel' },
        startedAt: '2026-07-17T09:00:00.000Z',
      }),
    };
    const jobB: JobCard = {
      ...job,
      id: 'job-2',
      title: 'B İşi — Klinik kontrolü',
      workflowContext: staffContext('NEW', { createdAt: '2026-07-17T08:00:00.000Z' }, {
        allowedActions: [],
        submissionReadiness: null,
      }),
    };
    let resolveStart: (value: Response) => void = () => {};
    const startGate = new Promise<Response>((resolve) => { resolveStart = resolve; });
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/meeting-details')) return Response.json({ ...meetingDetails, jobCardVersion: 3 });
      if (url.endsWith('/delivery-items')) return Response.json({ items: [item] });
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/start') && init?.method === 'POST') return startGate;
      if (url.endsWith('/api/job-cards/job-1')) return Response.json(meetingA);
      if (url.endsWith('/api/job-cards/job-2')) return Response.json(jobB);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-1" user={staffUser} onBack={() => {}} onChanged={() => {}} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      buttonByName(host, 'İşi başlat')?.click();
      await Promise.resolve();
    });

    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-2" user={staffUser} onBack={() => {}} onChanged={() => {}} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await act(async () => {
      resolveStart(Response.json(startedA));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.textContent).toContain('B İşi — Klinik kontrolü');
    expect(host.textContent).not.toContain('A Görüşmesi');
    expect(host.textContent).not.toContain('İş uygulanmaya başladı');
    expect(host.textContent).not.toContain('DurumUygulanıyor');
  });

  it('does not let an old Job A drain finally clear the new Job B drain owner', async () => {
    const source = new FakeRealtimeEventSource();
    const jobB: JobCard = {
      ...job,
      id: 'job-2',
      title: 'B İşi — Klinik kontrolü',
      workflowContext: staffContext('NEW', { createdAt: '2026-07-17T08:00:00.000Z' }, {
        allowedActions: [],
        submissionReadiness: null,
      }),
    };
    const newerB: JobCard = {
      ...jobB,
      version: jobB.version + 1,
      title: 'B İşi — Güncel durum',
    };
    const gates: Record<string, { resolve: (value: Response) => void }> = {};
    const jobGetCounts: Record<string, number> = { 'job-1': 0, 'job-2': 0 };
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/delivery-items')) return Response.json({ items: [item] });
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/api/job-cards/job-1')) {
        jobGetCounts['job-1'] += 1;
        if (jobGetCounts['job-1'] === 1) return Response.json(job);
        const gate: { resolve: (value: Response) => void } = { resolve: () => {} };
        gates['job-1-drain'] = gate;
        return new Promise<Response>((resolve) => { gate.resolve = resolve; });
      }
      if (url.endsWith('/api/job-cards/job-2')) {
        jobGetCounts['job-2'] += 1;
        if (jobGetCounts['job-2'] === 1) return Response.json(jobB);
        if (jobGetCounts['job-2'] === 2) {
          const gate: { resolve: (value: Response) => void } = { resolve: () => {} };
          gates['job-2-drain'] = gate;
          return new Promise<Response>((resolve) => { gate.resolve = resolve; });
        }
        return Response.json(newerB);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-1" user={staffUser} onBack={() => {}} onChanged={() => {}} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await act(async () => {
      source.emitJobUpdate('1');
      await Promise.resolve();
    });
    expect(gates['job-1-drain']).toBeDefined();

    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-2" user={staffUser} onBack={() => {}} onChanged={() => {}} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      source.emitJobUpdateFor('2', 'job-2');
      await Promise.resolve();
    });
    expect(gates['job-2-drain']).toBeDefined();

    await act(async () => {
      gates['job-1-drain'].resolve(Response.json(job));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await act(async () => {
      source.emitJobUpdateFor('3', 'job-2');
      await Promise.resolve();
    });
    expect(jobGetCounts['job-2']).toBe(2);

    await act(async () => {
      gates['job-2-drain'].resolve(Response.json(newerB));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.textContent).toContain('B İşi — Güncel durum');
    expect(host.textContent).not.toContain('Bu iş başka bir oturumda güncellendi');
  });

  it('does not let an old Job A mutation finally clear the new Job B mutation', async () => {
    const source = new FakeRealtimeEventSource();
    const jobB: JobCard = {
      ...job,
      id: 'job-2',
      title: 'B İşi — Klinik kontrolü',
      workflowContext: staffContext('NEW', { createdAt: '2026-07-17T08:00:00.000Z' }, {
        allowedActions: [],
        submissionReadiness: null,
      }),
    };
    const acceptedB: JobCard = {
      ...jobB,
      status: 'ACCEPTED',
      version: jobB.version + 1,
      workflowContext: staffContext('ACCEPTED', {
        acceptedAt: '2026-07-17T08:30:00.000Z',
        acceptedBy: { id: 's1', name: 'Ayşe Personel' },
      }, { allowedActions: [] }),
    };
    let resolveAcceptA: (value: Response) => void = () => {};
    const acceptAGate = new Promise<Response>((resolve) => { resolveAcceptA = resolve; });
    let resolveAcceptB: (value: Response) => void = () => {};
    const acceptBGate = new Promise<Response>((resolve) => { resolveAcceptB = resolve; });
    const acceptBodies: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/delivery-items')) return Response.json({ items: [item] });
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/accept') && init?.method === 'POST') {
        acceptBodies.push(JSON.parse(String(init.body)));
        if (acceptBodies.length === 1) return acceptAGate;
        return acceptBGate;
      }
      if (url.endsWith('/api/job-cards/job-1')) return Response.json(job);
      if (url.endsWith('/api/job-cards/job-2')) return Response.json(jobB);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-1" user={staffUser} onBack={() => {}} onChanged={() => {}} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      buttonByName(host, 'İşi kabul et')?.click();
      await Promise.resolve();
    });

    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-2" user={staffUser} onBack={() => {}} onChanged={() => {}} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      buttonByName(host, 'İşi kabul et')?.click();
      await Promise.resolve();
    });
    expect(acceptBodies).toHaveLength(2);

    await act(async () => {
      resolveAcceptA(Response.json(acceptedB));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const pendingButton = buttonByName(host, 'İşleniyor…') as HTMLButtonElement | null;
    expect(pendingButton?.disabled).toBe(true);

    await act(async () => {
      resolveAcceptB(Response.json(acceptedB));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.textContent).toContain('İş kabul edildi.');
    expect(host.textContent).not.toContain('Bu iş başka bir oturumda güncellendi');
  });

  it('clears dialog and editor state from Job A after navigation to Job B', async () => {
    const source = new FakeRealtimeEventSource();
    const waitingA: JobCard = {
      ...inProgressMeeting(),
      status: 'WAITING_APPROVAL',
      version: 4,
      title: 'A — Onay bekleyen görüşme',
      workflowContext: staffContext('WAITING_APPROVAL', {
        acceptedAt: '2026-07-17T08:30:00.000Z',
        acceptedBy: { id: 's1', name: 'Ayşe Personel' },
        startedAt: '2026-07-17T09:00:00.000Z',
        submittedAt: '2026-07-17T10:00:00.000Z',
        submittedBy: { id: 's1', name: 'Ayşe Personel' },
      }),
    };
    const jobB: JobCard = {
      ...job,
      id: 'job-2',
      title: 'B İşi — Klinik kontrolü',
      workflowContext: staffContext('NEW', { createdAt: '2026-07-17T08:00:00.000Z' }, {
        allowedActions: [],
        submissionReadiness: null,
      }),
    };
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/meeting-details')) return Response.json({ ...meetingDetails, jobCardVersion: 4 });
      if (url.endsWith('/delivery-items')) return Response.json({ items: [item] });
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/api/job-cards/job-1')) return Response.json(waitingA);
      if (url.endsWith('/api/job-cards/job-2')) return Response.json(jobB);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-1" user={managerUser} onBack={() => {}} onChanged={() => {}} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      buttonByName(host, 'Kontrolden çıkar ve kayıtları düzenle')?.click();
      await Promise.resolve();
    });
    expect(host.textContent).toContain('Kontrolden çıkar ve düzenle');

    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-2" user={staffUser} onBack={() => {}} onChanged={() => {}} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.textContent).toContain('B İşi — Klinik kontrolü');
    expect(host.textContent).not.toContain('Kontrolden çıkar ve düzenle');
    expect(host.textContent).not.toContain('A — Onay bekleyen görüşme');
  });

  it('does not carry Job A start capture or action id into Job B', async () => {
    const source = new FakeRealtimeEventSource();
    const acceptedA: JobCard = {
      ...job,
      status: 'ACCEPTED',
      version: job.version + 1,
      workflowContext: staffContext('ACCEPTED', {
        acceptedAt: '2026-07-17T08:30:00.000Z',
        acceptedBy: { id: 's1', name: 'Ayşe Personel' },
      }, { allowedActions: [], startLocationCaptureEnabled: true }),
    };
    const jobB: JobCard = {
      ...acceptedA,
      id: 'job-2',
      title: 'B İşi — Klinik kontrolü',
      workflowContext: staffContext('ACCEPTED', {
        acceptedAt: '2026-07-17T08:30:00.000Z',
        acceptedBy: { id: 's1', name: 'Ayşe Personel' },
      }, { allowedActions: [], startLocationCaptureEnabled: true }),
    };
    const startedB: JobCard = {
      ...jobB,
      status: 'IN_PROGRESS',
      version: jobB.version + 1,
      workflowContext: staffContext('IN_PROGRESS', {
        acceptedAt: '2026-07-17T08:30:00.000Z',
        acceptedBy: { id: 's1', name: 'Ayşe Personel' },
        startedAt: '2026-07-17T09:00:00.000Z',
      }),
    };
    const getCurrentPosition = vi.fn((success: PositionCallback) => success({
      coords: { latitude: 39.92077, longitude: 32.85411, accuracy: 24.5 },
    } as GeolocationPosition));
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition } });
    const startBodies: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/delivery-items')) return Response.json({ items: [item] });
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/start') && init?.method === 'POST') {
        startBodies.push(JSON.parse(String(init.body)));
        return Response.json(startedB);
      }
      if (url.endsWith('/api/job-cards/job-1')) return Response.json(acceptedA);
      if (url.endsWith('/api/job-cards/job-2')) return Response.json(jobB);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-1" user={staffUser} onBack={() => {}} onChanged={() => {}} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      buttonByName(host, 'İşi başlat')?.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(startBodies).toHaveLength(1);
    const captureA = startBodies[0].locationCapture;

    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-2" user={staffUser} onBack={() => {}} onChanged={() => {}} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      buttonByName(host, 'İşi başlat')?.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(startBodies).toHaveLength(2);
    expect(startBodies[1]).not.toEqual(startBodies[0]);
    expect(startBodies[1]).toMatchObject({ expectedVersion: jobB.version });
    expect(startBodies[1].locationCapture).not.toEqual(captureA);
    expect(startBodies[1].locationCapture).toMatchObject({
      outcome: 'captured',
      latitude: 39.92077,
      longitude: 32.85411,
      accuracyMeters: 24.5,
    });
  });

  it('coalesces a double-click on explicit reload into one canonical GET', async () => {
    const source = new FakeRealtimeEventSource();
    const meeting = inProgressMeeting();
    const newer: JobCard = {
      ...meeting,
      version: meeting.version + 1,
      title: 'Yeniden yükleme sonrası güncel görüşme',
    };
    let resolveReloadGet: (value: Response) => void = () => {};
    const reloadGetGate = new Promise<Response>((resolve) => { resolveReloadGet = resolve; });
    let jobCardRequests = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/meeting-details')) {
        return Response.json({ ...meetingDetails, jobCardVersion: jobCardRequests >= 3 ? newer.version : meeting.version });
      }
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/api/job-cards/job-1')) {
        jobCardRequests += 1;
        if (jobCardRequests === 1) return Response.json(meeting);
        if (jobCardRequests === 2) return reloadGetGate;
        return Response.json(newer);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-1" user={staffUser} onBack={() => {}} onChanged={() => {}} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      buttonByName(host, 'Görüşmeyi düzenle')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      source.emitJobUpdate('1');
      await Promise.resolve();
    });
    expect(host.textContent).toContain('Bu iş başka bir oturumda güncellendi');

    await act(async () => {
      const reload = buttonByName(host, 'En güncel bilgileri yükle');
      reload?.click();
      reload?.click();
      await Promise.resolve();
    });
    expect(jobCardRequests).toBe(2);

    await act(async () => {
      resolveReloadGet(Response.json(newer));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain('Yeniden yükleme sonrası güncel görüşme');
    expect(host.textContent).not.toContain('Bu iş başka bir oturumda güncellendi');
  });

  it('lets three concurrent reload callers share one canonical drain', async () => {
    const source = new FakeRealtimeEventSource();
    const meeting = inProgressMeeting();
    const newer: JobCard = {
      ...meeting,
      version: meeting.version + 1,
      title: 'Paylaşılan yeniden yükleme sonrası güncel görüşme',
    };
    let resolveReloadGet: (value: Response) => void = () => {};
    const reloadGetGate = new Promise<Response>((resolve) => { resolveReloadGet = resolve; });
    let jobCardRequests = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/meeting-details')) {
        return Response.json({ ...meetingDetails, jobCardVersion: jobCardRequests >= 3 ? newer.version : meeting.version });
      }
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/api/job-cards/job-1')) {
        jobCardRequests += 1;
        if (jobCardRequests === 1) return Response.json(meeting);
        if (jobCardRequests === 2) return reloadGetGate;
        return Response.json(newer);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-1" user={staffUser} onBack={() => {}} onChanged={() => {}} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      buttonByName(host, 'Görüşmeyi düzenle')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      source.emitJobUpdate('1');
      await Promise.resolve();
    });
    const reload = buttonByName(host, 'En güncel bilgileri yükle') as HTMLButtonElement;

    await act(async () => {
      reload.click();
      reload.click();
      reload.click();
      await Promise.resolve();
    });
    expect(jobCardRequests).toBe(2);

    await act(async () => {
      resolveReloadGet(Response.json(newer));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain('Paylaşılan yeniden yükleme sonrası güncel görüşme');
    expect(host.textContent).not.toContain('Bu iş başka bir oturumda güncellendi');
  });

  it('only adds a generation-required follow-up when an event arrives during a reload fetch', async () => {
    const source = new FakeRealtimeEventSource();
    const meeting = inProgressMeeting();
    const newer: JobCard = {
      ...meeting,
      version: meeting.version + 1,
      title: 'Etkinlik sonrası güncel görüşme',
    };
    let resolveReloadGet: (value: Response) => void = () => {};
    const reloadGetGate = new Promise<Response>((resolve) => { resolveReloadGet = resolve; });
    let jobCardRequests = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/meeting-details')) {
        return Response.json({ ...meetingDetails, jobCardVersion: jobCardRequests >= 3 ? newer.version : meeting.version });
      }
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/api/job-cards/job-1')) {
        jobCardRequests += 1;
        if (jobCardRequests === 1) return Response.json(meeting);
        if (jobCardRequests === 2) return reloadGetGate;
        return Response.json(newer);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-1" user={staffUser} onBack={() => {}} onChanged={() => {}} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      buttonByName(host, 'Görüşmeyi düzenle')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      source.emitJobUpdate('1');
      await Promise.resolve();
    });

    await act(async () => {
      const reload = buttonByName(host, 'En güncel bilgileri yükle');
      reload?.click();
      reload?.click();
      await Promise.resolve();
    });
    expect(jobCardRequests).toBe(2);

    await act(async () => {
      source.emitJobUpdate('2');
      await Promise.resolve();
    });
    await act(async () => {
      resolveReloadGet(Response.json(meeting));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.textContent).toContain('Etkinlik sonrası güncel görüşme');
    expect(host.textContent).not.toContain('Bu iş başka bir oturumda güncellendi');
    expect(jobCardRequests).toBe(3);
  });

  it('keeps the unresolved banner after a reload failure and allows a later retry', async () => {
    const source = new FakeRealtimeEventSource();
    const meeting = inProgressMeeting();
    const newer: JobCard = {
      ...meeting,
      version: meeting.version + 1,
      title: 'Yeniden deneme sonrası güncel görüşme',
    };
    let jobCardRequests = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/meeting-details')) {
        return Response.json({ ...meetingDetails, jobCardVersion: jobCardRequests >= 3 ? newer.version : meeting.version });
      }
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/api/job-cards/job-1')) {
        jobCardRequests += 1;
        if (jobCardRequests === 1) return Response.json(meeting);
        if (jobCardRequests === 2) throw new TypeError('network');
        return Response.json(newer);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-1" user={staffUser} onBack={() => {}} onChanged={() => {}} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      buttonByName(host, 'Görüşmeyi düzenle')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      source.emitJobUpdate('1');
      await Promise.resolve();
    });

    await act(async () => {
      const reload = buttonByName(host, 'En güncel bilgileri yükle');
      reload?.click();
      reload?.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain('Bu iş başka bir oturumda güncellendi');
    expect(jobCardRequests).toBe(2);

    await act(async () => {
      buttonByName(host, 'En güncel bilgileri yükle')?.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(jobCardRequests).toBe(3);
    expect(host.textContent).toContain('Yeniden deneme sonrası güncel görüşme');
    expect(host.textContent).not.toContain('Bu iş başka bir oturumda güncellendi');
  });

  it('discards a Job A response that resolves between Job B commit and passive reset', async () => {
    const source = new FakeRealtimeEventSource();
    const acceptedA: JobCard = {
      ...job,
      status: 'ACCEPTED',
      version: job.version + 1,
      workflowContext: staffContext('ACCEPTED', {
        acceptedAt: '2026-07-17T08:30:00.000Z',
        acceptedBy: { id: 's1', name: 'Ayşe Personel' },
      }),
    };
    const jobB: JobCard = {
      ...job,
      id: 'job-2',
      title: 'B İşi — Klinik kontrolü',
    };
    let resolveAccept: (value: Response) => void = () => {};
    const acceptGate = new Promise<Response>((resolve) => { resolveAccept = resolve; });
    const onChanged = vi.fn();
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/delivery-items')) return Response.json({ items: [item] });
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/accept') && init?.method === 'POST') return acceptGate;
      if (url.endsWith('/api/job-cards/job-1')) return Response.json(job);
      if (url.endsWith('/api/job-cards/job-2')) return Response.json(jobB);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-1" user={staffUser} onBack={() => {}} onChanged={onChanged} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      buttonByName(host, 'İşi kabul et')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-2" user={staffUser} onBack={() => {}} onChanged={onChanged} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain('B İşi — Klinik kontrolü');
    await act(async () => {
      resolveAccept(Response.json(acceptedA));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain('B İşi — Klinik kontrolü');
    expect(host.textContent).not.toContain('ABC Klinik ürün teslimi');
    expect(host.textContent).not.toContain('İş kabul edildi.');
    expect(onChanged).not.toHaveBeenCalled();
    const acceptB = buttonByName(host, 'İşi kabul et');
    expect(acceptB).not.toBeNull();
    expect((acceptB as HTMLButtonElement).disabled).toBe(false);
  });

  it('discards an old Job A generic lifecycle failure after navigation', async () => {
    const source = new FakeRealtimeEventSource();
    const jobB: JobCard = {
      ...job,
      id: 'job-2',
      title: 'B İşi — Klinik kontrolü',
    };
    let rejectAccept: (reason: unknown) => void = () => {};
    const acceptGate = new Promise<Response>((resolve, reject) => { rejectAccept = reject; });
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/delivery-items')) return Response.json({ items: [item] });
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/accept') && init?.method === 'POST') return acceptGate;
      if (url.endsWith('/api/job-cards/job-1')) return Response.json(job);
      if (url.endsWith('/api/job-cards/job-2')) return Response.json(jobB);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-1" user={staffUser} onBack={() => {}} onChanged={() => {}} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      buttonByName(host, 'İşi kabul et')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-2" user={staffUser} onBack={() => {}} onChanged={() => {}} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      rejectAccept(new ApiError(502, 'GATEWAY', 'Sunucu hatası. Tekrar deneyin.', true));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain('B İşi — Klinik kontrolü');
    expect(host.textContent).not.toContain('Sunucu hatası');
    expect(host.textContent).not.toContain('Bu iş başka bir oturumda güncellendi');
    const acceptB = buttonByName(host, 'İşi kabul et');
    expect(acceptB).not.toBeNull();
    expect((acceptB as HTMLButtonElement).disabled).toBe(false);
  });

  it('discards an old Job A conflict after navigation without a canonical refresh', async () => {
    const source = new FakeRealtimeEventSource();
    const jobB: JobCard = {
      ...job,
      id: 'job-2',
      title: 'B İşi — Klinik kontrolü',
    };
    let rejectAccept: (reason: unknown) => void = () => {};
    const acceptGate = new Promise<Response>((resolve, reject) => { rejectAccept = reject; });
    let job1Requests = 0;
    let job2Requests = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/delivery-items')) return Response.json({ items: [item] });
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/accept') && init?.method === 'POST') return acceptGate;
      if (url.endsWith('/api/job-cards/job-1')) {
        job1Requests += 1;
        return Response.json(job);
      }
      if (url.endsWith('/api/job-cards/job-2')) {
        job2Requests += 1;
        return Response.json(jobB);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-1" user={staffUser} onBack={() => {}} onChanged={() => {}} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      buttonByName(host, 'İşi kabul et')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-2" user={staffUser} onBack={() => {}} onChanged={() => {}} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(job2Requests).toBe(1);
    await act(async () => {
      rejectAccept(new ApiError(409, 'VERSION_CONFLICT', 'Kart güncellendi.', false));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain('B İşi — Klinik kontrolü');
    expect(host.textContent).not.toContain('İş başka bir işlemle güncellendi');
    expect(job1Requests).toBe(1);
    expect(job2Requests).toBe(1);
    const acceptB = buttonByName(host, 'İşi kabul et');
    expect(acceptB).not.toBeNull();
    expect((acceptB as HTMLButtonElement).disabled).toBe(false);
  });

  it('discards an old Job A save-operation failure after navigation', async () => {
    const source = new FakeRealtimeEventSource();
    const meeting = inProgressMeeting();
    const meetingB: JobCard = {
      ...meeting,
      id: 'job-2',
      title: 'B Görüşmesi',
    };
    let rejectSave: (reason: unknown) => void = () => {};
    const saveGate = new Promise<Response>((resolve, reject) => { rejectSave = reject; });
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/customers?')) {
        return Response.json({
          items: [{
            id: 'c1', organizationId: 'org-1', name: 'ABC Klinik', customerType: 'clinic',
            taxNumber: null, phone: null, email: null, city: null, district: null, address: null,
            assignedStaffUserId: null, assignedStaffName: null, primaryContact: null,
            status: 'active', version: 1,
          }], total: 1, limit: 200, offset: 0,
        });
      }
      if (url.includes('/contacts?')) {
        return Response.json({ items: [], total: 0, limit: 200, offset: 0 });
      }
      if (url.endsWith('/meeting-details')) return Response.json(meetingDetails);
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/api/job-cards/job-1') && init?.method === 'PATCH') return saveGate;
      if (url.endsWith('/api/job-cards/job-1')) return Response.json(meeting);
      if (url.endsWith('/api/job-cards/job-2')) return Response.json(meetingB);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-1" user={staffUser} onBack={() => {}} onChanged={() => {}} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      buttonByName(host, 'Görüşmeyi düzenle')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      const titleInput = document.getElementById('meeting-edit-title') as HTMLInputElement;
      titleInput.value = 'Güncel başlık';
      titleInput.dispatchEvent(new Event('input', { bubbles: true }));
      const kindSelect = document.getElementById('meeting-edit-engagement-kind') as HTMLSelectElement;
      kindSelect.value = 'SALES_MEETING';
      kindSelect.dispatchEvent(new Event('change', { bubbles: true }));
      const customerSelect = document.getElementById('meeting-edit-customer') as HTMLSelectElement;
      customerSelect.value = 'c1';
      customerSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      buttonByName(host, 'Değişiklikleri kaydet')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-2" user={staffUser} onBack={() => {}} onChanged={() => {}} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      rejectSave(new ApiError(502, 'GATEWAY', 'Kayıt sunucusu hatası.', true));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain('B Görüşmesi');
    expect(host.textContent).not.toContain('Kayıt sunucusu hatası');
    expect(host.textContent).not.toContain('Görüşme güncellenemedi');
    expect(host.textContent).not.toContain('Bu iş başka bir oturumda güncellendi');
  });

  it('does not show a remote-conflict banner on Job B after an old Job A drain failure', async () => {
    const source = new FakeRealtimeEventSource();
    const meeting = inProgressMeeting();
    const jobB: JobCard = {
      ...job,
      id: 'job-2',
      title: 'B İşi — Klinik kontrolü',
    };
    let rejectDrainGet: (reason: unknown) => void = () => {};
    const drainGetGate = new Promise<Response>((resolve, reject) => { rejectDrainGet = reject; });
    let jobCardRequests = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/delivery-items')) return Response.json({ items: [item] });
      if (url.endsWith('/meeting-details')) return Response.json(meetingDetails);
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/api/job-cards/job-1')) {
        jobCardRequests += 1;
        if (jobCardRequests === 1) return Response.json(meeting);
        return drainGetGate;
      }
      if (url.endsWith('/api/job-cards/job-2')) return Response.json(jobB);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-1" user={staffUser} onBack={() => {}} onChanged={() => {}} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      source.emitJobUpdate('1');
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(jobCardRequests).toBe(2);
    await act(async () => {
      root.render(      <RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-2" user={staffUser} onBack={() => {}} onChanged={() => {}} />
      </RealtimeProvider>);
      for (let i = 0; i < 5; i += 1) {
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
    expect(host.textContent).toContain('B İşi — Klinik kontrolü');
    await act(async () => {
      rejectDrainGet(new TypeError('network'));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain('B İşi — Klinik kontrolü');
    expect(host.textContent).not.toContain('Bu iş başka bir oturumda güncellendi');
  });

  it('does not submit an old Job A START command when the capture resolves after navigation', async () => {
    const source = new FakeRealtimeEventSource();
    const acceptedA: JobCard = {
      ...job,
      status: 'ACCEPTED',
      version: job.version + 1,
      workflowContext: staffContext('ACCEPTED', {
        acceptedAt: '2026-07-17T08:30:00.000Z',
        acceptedBy: { id: 's1', name: 'Ayşe Personel' },
      }, { allowedActions: [], startLocationCaptureEnabled: true }),
    };
    const acceptedB: JobCard = {
      ...acceptedA,
      id: 'job-2',
      title: 'B İşi — Klinik kontrolü',
    };
    const startedB: JobCard = {
      ...acceptedB,
      status: 'IN_PROGRESS',
      version: acceptedB.version + 1,
      workflowContext: staffContext('IN_PROGRESS', {
        acceptedAt: '2026-07-17T08:30:00.000Z',
        acceptedBy: { id: 's1', name: 'Ayşe Personel' },
        startedAt: '2026-07-17T09:00:00.000Z',
      }),
    };
    let resolveCapture: (position: GeolocationPosition) => void = () => {};
    const getCurrentPosition = vi.fn((success: PositionCallback) => {
      resolveCapture = (position) => success(position as GeolocationPosition);
    });
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition } });
    const startBodies: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/delivery-items')) return Response.json({ items: [item] });
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/start') && init?.method === 'POST') {
        startBodies.push(JSON.parse(String(init.body)));
        return Response.json(startedB);
      }
      if (url.endsWith('/api/job-cards/job-1')) return Response.json(acceptedA);
      if (url.endsWith('/api/job-cards/job-2')) return Response.json(acceptedB);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-1" user={staffUser} onBack={() => {}} onChanged={() => {}} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      buttonByName(host, 'İşi başlat')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-2" user={staffUser} onBack={() => {}} onChanged={() => {}} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      resolveCapture({ coords: { latitude: 39.92077, longitude: 32.85411, accuracy: 24.5 } } as GeolocationPosition);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(startBodies).toHaveLength(0);
    expect(host.textContent).toContain('B İşi — Klinik kontrolü');
    expect(host.textContent).not.toContain('Yükleniyor');
    await act(async () => {
      buttonByName(host, 'İşi başlat')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      resolveCapture({ coords: { latitude: 39.92077, longitude: 32.85411, accuracy: 24.5 } } as GeolocationPosition);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(startBodies).toHaveLength(1);
    expect(startBodies[0]).toMatchObject({ expectedVersion: acceptedB.version });
  });

  it('does not submit an old Job A START command when the capture becomes unavailable after navigation', async () => {
    const source = new FakeRealtimeEventSource();
    const acceptedA: JobCard = {
      ...job,
      status: 'ACCEPTED',
      version: job.version + 1,
      workflowContext: staffContext('ACCEPTED', {
        acceptedAt: '2026-07-17T08:30:00.000Z',
        acceptedBy: { id: 's1', name: 'Ayşe Personel' },
      }, { allowedActions: [], startLocationCaptureEnabled: true }),
    };
    const acceptedB: JobCard = {
      ...acceptedA,
      id: 'job-2',
      title: 'B İşi — Klinik kontrolü',
    };
    let resolveCaptureError: (error: GeolocationPositionError) => void = () => {};
    const getCurrentPosition = vi.fn((success: PositionCallback, error: PositionErrorCallback) => {
      resolveCaptureError = (err) => error(err as GeolocationPositionError);
    });
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition } });
    const startBodies: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/delivery-items')) return Response.json({ items: [item] });
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/start') && init?.method === 'POST') {
        startBodies.push(JSON.parse(String(init.body)));
        return Response.json({ ...acceptedB, status: 'IN_PROGRESS', version: acceptedB.version + 1 });
      }
      if (url.endsWith('/api/job-cards/job-1')) return Response.json(acceptedA);
      if (url.endsWith('/api/job-cards/job-2')) return Response.json(acceptedB);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-1" user={staffUser} onBack={() => {}} onChanged={() => {}} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      buttonByName(host, 'İşi başlat')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-2" user={staffUser} onBack={() => {}} onChanged={() => {}} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      resolveCaptureError({ code: 1 } as GeolocationPositionError);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(startBodies).toHaveLength(0);
    expect(host.textContent).toContain('B İşi — Klinik kontrolü');
    expect(host.textContent).not.toContain('Yükleniyor');
  });

  it('keeps a Job B reload pending state when an old Job A reload finishes', async () => {
    const source = new FakeRealtimeEventSource();
    const meeting = inProgressMeeting();
    const meetingB: JobCard = {
      ...meeting,
      id: 'job-2',
      title: 'B Görüşmesi',
    };
    const newerA: JobCard = {
      ...meeting,
      version: meeting.version + 1,
      title: 'A yeniden yükleme sonrası güncel görüşme',
    };
    const newerB: JobCard = {
      ...meetingB,
      version: meetingB.version + 1,
      title: 'B yeniden yükleme sonrası güncel görüşme',
    };
    let resolveGetA: (value: Response) => void = () => {};
    const gateA = new Promise<Response>((resolve) => { resolveGetA = resolve; });
    let resolveGetB: (value: Response) => void = () => {};
    const gateB = new Promise<Response>((resolve) => { resolveGetB = resolve; });
    let requestsA = 0;
    let requestsB = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/meeting-details')) {
        if (url.includes('/job-1')) {
          return Response.json({ ...meetingDetails, jobCardVersion: requestsA >= 3 ? newerA.version : meeting.version });
        }
        return Response.json({ ...meetingDetails, jobCardVersion: requestsB >= 3 ? newerB.version : meetingB.version });
      }
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/api/job-cards/job-1')) {
        requestsA += 1;
        if (requestsA === 1) return Response.json(meeting);
        if (requestsA === 2) return gateA;
        return Response.json(newerA);
      }
      if (url.endsWith('/api/job-cards/job-2')) {
        requestsB += 1;
        if (requestsB === 1) return Response.json(meetingB);
        if (requestsB === 2) return gateB;
        return Response.json(newerB);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-1" user={staffUser} onBack={() => {}} onChanged={() => {}} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      buttonByName(host, 'Görüşmeyi düzenle')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      source.emitJobUpdate('1');
      await Promise.resolve();
    });
    await act(async () => {
      buttonByName(host, 'En güncel bilgileri yükle')?.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(requestsA).toBe(2);
    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-2" user={staffUser} onBack={() => {}} onChanged={() => {}} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      buttonByName(host, 'Görüşmeyi düzenle')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      source.emitJobUpdateFor('2', 'job-2');
      await Promise.resolve();
    });
    await act(async () => {
      buttonByName(host, 'En güncel bilgileri yükle')?.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(requestsB).toBe(2);
    await act(async () => {
      resolveGetA(Response.json(newerA));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const reloadButtonB = buttonByName(host, 'Yükleniyor…');
    expect(reloadButtonB).not.toBeNull();
    expect((reloadButtonB as HTMLButtonElement).disabled).toBe(true);
    expect(host.textContent).toContain('Yükleniyor…');
    await act(async () => {
      resolveGetB(Response.json(newerB));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain('B yeniden yükleme sonrası güncel görüşme');
    expect(host.textContent).not.toContain('Bu iş başka bir oturumda güncellendi');
  });

  it('does not open a banner on Job B when an old Job A reload fails', async () => {
    const source = new FakeRealtimeEventSource();
    const meeting = inProgressMeeting();
    const jobB: JobCard = {
      ...job,
      id: 'job-2',
      title: 'B İşi — Klinik kontrolü',
    };
    let rejectReloadGet: (reason: unknown) => void = () => {};
    const reloadGetGate = new Promise<Response>((resolve, reject) => { rejectReloadGet = reject; });
    let jobCardRequests = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/delivery-items')) return Response.json({ items: [item] });
      if (url.endsWith('/meeting-details')) return Response.json(meetingDetails);
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/api/job-cards/job-1')) {
        jobCardRequests += 1;
        if (jobCardRequests === 1) return Response.json(meeting);
        return reloadGetGate;
      }
      if (url.endsWith('/api/job-cards/job-2')) return Response.json(jobB);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-1" user={staffUser} onBack={() => {}} onChanged={() => {}} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      buttonByName(host, 'Görüşmeyi düzenle')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      source.emitJobUpdate('1');
      await Promise.resolve();
    });
    await act(async () => {
      buttonByName(host, 'En güncel bilgileri yükle')?.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(jobCardRequests).toBe(2);
    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-2" user={staffUser} onBack={() => {}} onChanged={() => {}} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      rejectReloadGet(new TypeError('network'));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain('B İşi — Klinik kontrolü');
    expect(host.textContent).not.toContain('Bu iş başka bir oturumda güncellendi');
  });

  it('proves old-session results are no-ops for Job B across the error matrix', async () => {
    const source = new FakeRealtimeEventSource();
    const jobB: JobCard = {
      ...job,
      id: 'job-2',
      title: 'B İşi — Klinik kontrolü',
    };
    let rejectAccept: (reason: unknown) => void = () => {};
    const acceptGate = new Promise<Response>((resolve, reject) => { rejectAccept = reject; });
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/delivery-items')) return Response.json({ items: [item] });
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/accept') && init?.method === 'POST') return acceptGate;
      if (url.endsWith('/api/job-cards/job-1')) return Response.json(job);
      if (url.endsWith('/api/job-cards/job-2')) return Response.json(jobB);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-1" user={staffUser} onBack={() => {}} onChanged={() => {}} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      buttonByName(host, 'İşi kabul et')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-2" user={staffUser} onBack={() => {}} onChanged={() => {}} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    for (const failure of [
      new ApiError(502, 'GATEWAY', 'Sunucu hatası. Tekrar deneyin.', true),
      new ApiError(409, 'VERSION_CONFLICT', 'Kart güncellendi.', false),
      new TypeError('network'),
    ]) {
      rejectAccept(failure);
      await act(async () => {
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(host.textContent).toContain('B İşi — Klinik kontrolü');
      expect(host.textContent).not.toContain('Sunucu hatası');
      expect(host.textContent).not.toContain('İş başka bir işlemle güncellendi');
      expect(host.textContent).not.toContain('Bu iş başka bir oturumda güncellendi');
      const acceptB = buttonByName(host, 'İşi kabul et');
      expect(acceptB).not.toBeNull();
      expect((acceptB as HTMLButtonElement).disabled).toBe(false);
    }
  });

  it('stops an old Job A success tail after navigation during the post-success drain', async () => {
    const source = new FakeRealtimeEventSource();
    const acceptedA: JobCard = {
      ...job,
      status: 'ACCEPTED',
      version: job.version + 1,
      workflowContext: staffContext('ACCEPTED', {
        acceptedAt: '2026-07-17T08:30:00.000Z',
        acceptedBy: { id: 's1', name: 'Ayşe Personel' },
      }),
    };
    const jobB: JobCard = {
      ...job,
      id: 'job-2',
      title: 'B İşi — Klinik kontrolü',
    };
    let resolveAccept: (value: Response) => void = () => {};
    const acceptGate = new Promise<Response>((resolve) => { resolveAccept = resolve; });
    let resolveDrainGet: (value: Response) => void = () => {};
    const drainGetGate = new Promise<Response>((resolve) => { resolveDrainGet = resolve; });
    let job1Requests = 0;
    const onChanged = vi.fn();
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/delivery-items')) return Response.json({ items: [item] });
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/accept') && init?.method === 'POST') return acceptGate;
      if (url.endsWith('/api/job-cards/job-1')) {
        job1Requests += 1;
        if (job1Requests === 1) return Response.json(job);
        if (job1Requests === 2) return drainGetGate;
        return Response.json(acceptedA);
      }
      if (url.endsWith('/api/job-cards/job-2')) return Response.json(jobB);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-1" user={staffUser} onBack={() => {}} onChanged={onChanged} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      buttonByName(host, 'İşi kabul et')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      source.emitJobUpdate('1');
      await Promise.resolve();
    });
    await act(async () => {
      resolveAccept(Response.json(acceptedA));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(job1Requests).toBe(2);
    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-2" user={staffUser} onBack={() => {}} onChanged={onChanged} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      resolveDrainGet(Response.json(acceptedA));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain('B İşi — Klinik kontrolü');
    expect(host.textContent).not.toContain('ABC Klinik ürün teslimi');
    expect(host.textContent).not.toContain('İş kabul edildi.');
    expect(onChanged).not.toHaveBeenCalled();
    const acceptB = buttonByName(host, 'İşi kabul et');
    expect(acceptB).not.toBeNull();
    expect((acceptB as HTMLButtonElement).disabled).toBe(false);
  });

  it('stops an old Job A START success tail after navigation during the mandatory refresh', async () => {
    const source = new FakeRealtimeEventSource();
    const acceptedMeetingA: JobCard = {
      ...job,
      type: 'SALES_MEETING',
      engagementKind: 'SALES_MEETING',
      status: 'ACCEPTED',
      version: 3,
      title: 'A Görüşmesi',
      workflowContext: staffContext('ACCEPTED', {
        acceptedAt: '2026-07-17T08:30:00.000Z',
        acceptedBy: { id: 's1', name: 'Ayşe Personel' },
      }, { allowedActions: [], startLocationCaptureEnabled: true }),
    };
    const startedA: JobCard = {
      ...acceptedMeetingA,
      status: 'IN_PROGRESS',
      version: acceptedMeetingA.version + 1,
      workflowContext: staffContext('IN_PROGRESS', {
        acceptedAt: '2026-07-17T08:30:00.000Z',
        acceptedBy: { id: 's1', name: 'Ayşe Personel' },
        startedAt: '2026-07-17T09:00:00.000Z',
      }),
    };
    const meetingB: JobCard = {
      ...acceptedMeetingA,
      id: 'job-2',
      title: 'B Görüşmesi',
    };
    const getCurrentPosition = vi.fn((success: PositionCallback) => success({
      coords: { latitude: 39.92077, longitude: 32.85411, accuracy: 24.5 },
    } as GeolocationPosition));
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition } });
    let resolveStart: (value: Response) => void = () => {};
    const startGate = new Promise<Response>((resolve) => { resolveStart = resolve; });
    let resolveRefreshGet: (value: Response) => void = () => {};
    const refreshGetGate = new Promise<Response>((resolve) => { resolveRefreshGet = resolve; });
    let job1Requests = 0;
    const onChanged = vi.fn();
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/meeting-details')) {
        return Response.json({
          ...meetingDetails,
          jobCardVersion: job1Requests >= 3 ? startedA.version : acceptedMeetingA.version,
        });
      }
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/start') && init?.method === 'POST') return startGate;
      if (url.endsWith('/api/job-cards/job-1')) {
        job1Requests += 1;
        if (job1Requests === 1) return Response.json(acceptedMeetingA);
        if (job1Requests === 2) return refreshGetGate;
        return Response.json(startedA);
      }
      if (url.endsWith('/api/job-cards/job-2')) return Response.json(meetingB);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-1" user={staffUser} onBack={() => {}} onChanged={onChanged} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      buttonByName(host, 'İşi başlat')?.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      resolveStart(Response.json(startedA));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(job1Requests).toBe(2);
    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-2" user={staffUser} onBack={() => {}} onChanged={onChanged} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      resolveRefreshGet(Response.json(startedA));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain('B Görüşmesi');
    expect(host.textContent).not.toContain('A Görüşmesi');
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('stops an old Job A meeting-save tail after navigation during the refresh', async () => {
    const source = new FakeRealtimeEventSource();
    const meeting = inProgressMeeting();
    const updatedMeeting: JobCard = {
      ...meeting,
      version: meeting.version + 1,
      title: 'Güncel başlık',
    };
    const meetingB: JobCard = {
      ...meeting,
      id: 'job-2',
      title: 'B Görüşmesi',
    };
    let resolveSave: (value: Response) => void = () => {};
    const saveGate = new Promise<Response>((resolve) => { resolveSave = resolve; });
    let resolveRefreshGet: (value: Response) => void = () => {};
    const refreshGetGate = new Promise<Response>((resolve) => { resolveRefreshGet = resolve; });
    let job1Requests = 0;
    const onChanged = vi.fn();
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/customers?')) {
        return Response.json({
          items: [{
            id: 'c1', organizationId: 'org-1', name: 'ABC Klinik', customerType: 'clinic',
            taxNumber: null, phone: null, email: null, city: null, district: null, address: null,
            assignedStaffUserId: null, assignedStaffName: null, primaryContact: null,
            status: 'active', version: 1,
          }], total: 1, limit: 200, offset: 0,
        });
      }
      if (url.includes('/contacts?')) {
        return Response.json({ items: [], total: 0, limit: 200, offset: 0 });
      }
      if (url.endsWith('/meeting-details')) {
        if (url.includes('/job-1')) {
          return Response.json({
            ...meetingDetails,
            jobCardVersion: job1Requests >= 2 ? updatedMeeting.version : meeting.version,
          });
        }
        return Response.json({ ...meetingDetails, jobCardVersion: meetingB.version });
      }
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/api/job-cards/job-1') && init?.method === 'PATCH') return saveGate;
      if (url.endsWith('/api/job-cards/job-1')) {
        job1Requests += 1;
        if (job1Requests === 1) return Response.json(meeting);
        if (job1Requests === 2) return refreshGetGate;
        return Response.json(updatedMeeting);
      }
      if (url.endsWith('/api/job-cards/job-2')) return Response.json(meetingB);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-1" user={staffUser} onBack={() => {}} onChanged={onChanged} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      buttonByName(host, 'Görüşmeyi düzenle')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      const titleInput = document.getElementById('meeting-edit-title') as HTMLInputElement;
      titleInput.value = 'Güncel başlık';
      titleInput.dispatchEvent(new Event('input', { bubbles: true }));
      const kindSelect = document.getElementById('meeting-edit-engagement-kind') as HTMLSelectElement;
      kindSelect.value = 'SALES_MEETING';
      kindSelect.dispatchEvent(new Event('change', { bubbles: true }));
      const customerSelect = document.getElementById('meeting-edit-customer') as HTMLSelectElement;
      customerSelect.value = 'c1';
      customerSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      buttonByName(host, 'Değişiklikleri kaydet')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      resolveSave(Response.json(updatedMeeting));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(job1Requests).toBe(2);
    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-2" user={staffUser} onBack={() => {}} onChanged={onChanged} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      resolveRefreshGet(Response.json(updatedMeeting));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain('B Görüşmesi');
    expect(host.textContent).not.toContain('Görüşme bilgileri güncellendi');
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('stops an old Job A schedule-save tail after navigation during the reconciliation', async () => {
    const source = new FakeRealtimeEventSource();
    const scheduleA: JobCard = {
      ...job,
      type: 'SALES_MEETING',
      engagementKind: 'SALES_MEETING',
      version: job.version + 1,
      scheduledAt: '2026-07-21T10:00:00.000Z',
      workflowContext: staffContext('NEW', {
        createdAt: '2026-07-17T08:00:00.000Z',
      }),
    };
    const meetingDetailsB: MeetingDetails = {
      ...meetingDetails,
      jobCardId: 'job-2',
      jobCardVersion: 3,
    };
    const jobB: JobCard = {
      ...job,
      type: 'SALES_MEETING',
      engagementKind: 'SALES_MEETING',
      id: 'job-2',
      title: 'B İşi — Klinik kontrolü',
      workflowContext: staffContext('NEW', {
        createdAt: '2026-07-17T08:00:00.000Z',
      }),
    };
    let resolveSave: (value: Response) => void = () => {};
    const saveGate = new Promise<Response>((resolve) => { resolveSave = resolve; });
    let resolveDrainGet: (value: Response) => void = () => {};
    const drainGetGate = new Promise<Response>((resolve) => { resolveDrainGet = resolve; });
    let job1Requests = 0;
    const onChanged = vi.fn();
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/meeting-details')) {
        if (url.includes('/job-1')) {
          return Response.json({
            ...meetingDetails,
            jobCardVersion: job1Requests >= 2 ? scheduleA.version : scheduleA.version - 1,
          });
        }
        return Response.json(meetingDetailsB);
      }
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/api/job-cards/job-1') && init?.method === 'PATCH') return saveGate;
      if (url.endsWith('/api/job-cards/job-1')) {
        job1Requests += 1;
        if (job1Requests === 1) return Response.json(scheduleA);
        if (job1Requests === 2) return drainGetGate;
        return Response.json(scheduleA);
      }
      if (url.endsWith('/api/job-cards/job-2')) return Response.json(jobB);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-1" user={staffUser} onBack={() => {}} onChanged={onChanged} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      const input = document.getElementById('job-scheduled-at') as HTMLInputElement;
      expect(input).not.toBeNull();
      input.value = '2026-07-21T13:00';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      buttonByName(host, 'Planlanan zamanı kaydet')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      resolveSave(Response.json(scheduleA));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(job1Requests).toBe(2);
    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-2" user={staffUser} onBack={() => {}} onChanged={onChanged} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      resolveDrainGet(Response.json(scheduleA));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain('B İşi — Klinik kontrolü');
    expect(host.textContent).not.toContain('Planlanan zaman güncellendi');
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('keeps Job B clean when an old delivered-at conflict resolves during navigation', async () => {
    const source = new FakeRealtimeEventSource();
    const editableJob: JobCard = {
      ...job,
      workflowContext: staffContext('NEW', {
        createdAt: '2026-07-17T08:00:00.000Z',
      }, { allowedActions: ['EDIT_DELIVERY_ACTUAL_TIME', 'VIEW_NOTES'], submissionReadiness: null }),
    };
    const jobB: JobCard = {
      ...job,
      id: 'job-2',
      title: 'B İşi — Klinik kontrolü',
    };
    let resolveSave: (value: Response) => void = () => {};
    const saveGate = new Promise<Response>((resolve) => { resolveSave = resolve; });
    let resolveRefreshGet: (value: Response) => void = () => {};
    const refreshGetGate = new Promise<Response>((resolve) => { resolveRefreshGet = resolve; });
    let job1Requests = 0;
    const onChanged = vi.fn();
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/delivery-items')) return Response.json({ items: [item] });
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.includes('/delivery-items/i1') && init?.method === 'PATCH') return saveGate;
      if (url.endsWith('/api/job-cards/job-1')) {
        job1Requests += 1;
        if (job1Requests === 1) return Response.json(editableJob);
        if (job1Requests === 2) return refreshGetGate;
        return Response.json(editableJob);
      }
      if (url.endsWith('/api/job-cards/job-2')) return Response.json(jobB);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-1" user={staffUser} onBack={() => {}} onChanged={onChanged} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      const input = document.getElementById('delivery-actual-at-i1') as HTMLInputElement;
      expect(input).not.toBeNull();
      input.value = '2026-07-21T13:00';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      buttonByName(host, 'Gerçekleşen teslim zamanını kaydet')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      resolveSave(new Response(JSON.stringify({ error: 'Kart güncellendi.', code: 'VERSION_CONFLICT' }), { status: 409 }));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(job1Requests).toBe(2);
    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-2" user={staffUser} onBack={() => {}} onChanged={onChanged} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      resolveRefreshGet(Response.json(editableJob));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain('B İşi — Klinik kontrolü');
    expect(host.textContent).not.toContain('İş başka bir işlemle güncellendi');
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('keeps Job B clean when an old lifecycle conflict refresh rejects after navigation', async () => {
    const source = new FakeRealtimeEventSource();
    const jobB: JobCard = {
      ...job,
      id: 'job-2',
      title: 'B İşi — Klinik kontrolü',
    };
    let resolveAccept: (value: Response) => void = () => {};
    const acceptGate = new Promise<Response>((resolve) => { resolveAccept = resolve; });
    let rejectRefreshGet: (reason: unknown) => void = () => {};
    const refreshGetGate = new Promise<Response>((resolve, reject) => { rejectRefreshGet = reject; });
    let job1Requests = 0;
    const onChanged = vi.fn();
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/delivery-items')) return Response.json({ items: [item] });
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/accept') && init?.method === 'POST') return acceptGate;
      if (url.endsWith('/api/job-cards/job-1')) {
        job1Requests += 1;
        if (job1Requests === 1) return Response.json(job);
        if (job1Requests === 2) return refreshGetGate;
        return Response.json(job);
      }
      if (url.endsWith('/api/job-cards/job-2')) return Response.json(jobB);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-1" user={staffUser} onBack={() => {}} onChanged={onChanged} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      buttonByName(host, 'İşi kabul et')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      resolveAccept(new Response(JSON.stringify({ error: 'Kart güncellendi.', code: 'VERSION_CONFLICT' }), { status: 409 }));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(job1Requests).toBe(2);
    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-2" user={staffUser} onBack={() => {}} onChanged={onChanged} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      rejectRefreshGet(new TypeError('network'));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain('B İşi — Klinik kontrolü');
    expect(host.textContent).not.toContain('Bu iş başka bir oturumda güncellendi');
    expect(host.textContent).not.toContain('Güncel iş bilgileri alınamadı');
    expect(onChanged).not.toHaveBeenCalled();
    const acceptB = buttonByName(host, 'İşi kabul et');
    expect(acceptB).not.toBeNull();
    expect((acceptB as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps Job B clean across a withdraw conflict refresh navigation race', async () => {
    const source = new FakeRealtimeEventSource();
    const waitingMeeting: JobCard = {
      ...job,
      type: 'SALES_MEETING',
      engagementKind: 'SALES_MEETING',
      status: 'WAITING_APPROVAL',
      version: 3,
      title: 'Onay bekleyen görüşme',
      workflowContext: staffContext('WAITING_APPROVAL', {
        submittedAt: '2026-07-17T13:00:00.000Z',
        submittedBy: { id: 's1', name: 'Ayşe Personel' },
      }),
    };
    const meetingB: JobCard = {
      ...waitingMeeting,
      id: 'job-2',
      title: 'B Görüşmesi',
    };
    let resolveWithdraw: (value: Response) => void = () => {};
    const withdrawGate = new Promise<Response>((resolve) => { resolveWithdraw = resolve; });
    let rejectRefreshGet: (reason: unknown) => void = () => {};
    const refreshGetGate = new Promise<Response>((resolve, reject) => { rejectRefreshGet = reject; });
    let job1Requests = 0;
    const onChanged = vi.fn();
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/meeting-details')) {
        return Response.json({ ...meetingDetails, jobCardVersion: waitingMeeting.version });
      }
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/withdraw-from-approval') && init?.method === 'POST') return withdrawGate;
      if (url.endsWith('/api/job-cards/job-1')) {
        job1Requests += 1;
        if (job1Requests === 1) return Response.json(waitingMeeting);
        if (job1Requests === 2) return refreshGetGate;
        return Response.json(waitingMeeting);
      }
      if (url.endsWith('/api/job-cards/job-2')) return Response.json(meetingB);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-1" user={managerUser} onBack={() => {}} onChanged={onChanged} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      buttonByName(host, 'Kontrolden çıkar ve kayıtları düzenle')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      buttonByName(host, 'Kontrolden çıkar ve düzenle')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      resolveWithdraw(new Response(JSON.stringify({ error: 'Kart güncellendi.', code: 'VERSION_CONFLICT' }), { status: 409 }));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(job1Requests).toBe(2);
    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-2" user={managerUser} onBack={() => {}} onChanged={onChanged} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      rejectRefreshGet(new TypeError('network'));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain('B Görüşmesi');
    expect(host.textContent).not.toContain('Bu iş başka bir oturumda güncellendi');
    expect(host.textContent).not.toContain('Güncel iş bilgileri alınamadı');
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('keeps the current job session active across StrictMode effect replay on ACCEPT', async () => {
    const source = new FakeRealtimeEventSource();
    const acceptedA: JobCard = {
      ...job,
      status: 'ACCEPTED',
      version: job.version + 1,
      workflowContext: staffContext('ACCEPTED', {
        acceptedAt: '2026-07-17T08:30:00.000Z',
        acceptedBy: { id: 's1', name: 'Ayşe Personel' },
      }),
    };
    let resolveAccept: (value: Response) => void = () => {};
    const acceptGate = new Promise<Response>((resolve) => { resolveAccept = resolve; });
    let acceptPosts = 0;
    const onChanged = vi.fn();
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/delivery-items')) return Response.json({ items: [item] });
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/accept') && init?.method === 'POST') {
        acceptPosts += 1;
        return acceptGate;
      }
      if (url.endsWith('/api/job-cards/job-1')) return Response.json(job);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    await act(async () => {
      root.render(<StrictMode><RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-1" user={staffUser} onBack={() => {}} onChanged={onChanged} />
      </RealtimeProvider></StrictMode>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      source.emitJobUpdate('1');
      await Promise.resolve();
    });
    await act(async () => {
      const acceptButton = buttonByName(host, 'İşi kabul et');
      expect(acceptButton).not.toBeNull();
      acceptButton?.click();
      await Promise.resolve();
    });
    expect(acceptPosts).toBe(1);
    await act(async () => {
      resolveAccept(Response.json(acceptedA));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain('Kabul edildi');
    expect(host.textContent).toContain('İş kabul edildi.');
    expect(host.textContent).not.toContain('Bu iş başka bir oturumda güncellendi');
    expect(host.textContent).not.toContain('Başka bir işlem devam ediyor');
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('reconciles an idle realtime event as the current session under StrictMode', async () => {
    const source = new FakeRealtimeEventSource();
    const meeting = inProgressMeeting();
    const newer: JobCard = {
      ...meeting,
      version: meeting.version + 1,
      title: 'StrictMode sonrası güncel görüşme',
    };
    let jobCardRequests = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/meeting-details')) {
        return Response.json({
          ...meetingDetails,
          jobCardVersion: jobCardRequests >= 3 ? newer.version : meeting.version,
        });
      }
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/api/job-cards/job-1')) {
        jobCardRequests += 1;
        return Response.json(jobCardRequests >= 3 ? newer : meeting);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    await act(async () => {
      root.render(<StrictMode><RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-1" user={staffUser} onBack={() => {}} onChanged={() => {}} />
      </RealtimeProvider></StrictMode>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const before = jobCardRequests;
    await act(async () => {
      source.emitJobUpdate('1');
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(jobCardRequests - before).toBe(1);
    expect(host.textContent).toContain('StrictMode sonrası güncel görüşme');
    expect(host.textContent).not.toContain('Bu iş başka bir oturumda güncellendi');
  });

  it('discards an old Job A result after keyed navigation under StrictMode', async () => {
    const source = new FakeRealtimeEventSource();
    const acceptedA: JobCard = {
      ...job,
      status: 'ACCEPTED',
      version: job.version + 1,
      workflowContext: staffContext('ACCEPTED', {
        acceptedAt: '2026-07-17T08:30:00.000Z',
        acceptedBy: { id: 's1', name: 'Ayşe Personel' },
      }),
    };
    const jobB: JobCard = {
      ...job,
      id: 'job-2',
      title: 'B İşi — Klinik kontrolü',
    };
    let resolveAccept: (value: Response) => void = () => {};
    const acceptGate = new Promise<Response>((resolve) => { resolveAccept = resolve; });
    let acceptPosts = 0;
    const onChanged = vi.fn();
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/delivery-items')) return Response.json({ items: [item] });
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/accept') && init?.method === 'POST') {
        acceptPosts += 1;
        return acceptGate;
      }
      if (url.endsWith('/api/job-cards/job-1')) return Response.json(job);
      if (url.endsWith('/api/job-cards/job-2')) return Response.json(jobB);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    await act(async () => {
      root.render(<StrictMode><RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-1" user={staffUser} onBack={() => {}} onChanged={onChanged} />
      </RealtimeProvider></StrictMode>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      buttonByName(host, 'İşi kabul et')?.click();
      await Promise.resolve();
    });
    expect(acceptPosts).toBe(1);
    await act(async () => {
      root.render(<StrictMode><RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-2" user={staffUser} onBack={() => {}} onChanged={onChanged} />
      </RealtimeProvider></StrictMode>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      resolveAccept(Response.json(acceptedA));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain('B İşi — Klinik kontrolü');
    expect(host.textContent).not.toContain('İş kabul edildi.');
    expect(onChanged).not.toHaveBeenCalled();
    const acceptB = buttonByName(host, 'İşi kabul et');
    expect(acceptB).not.toBeNull();
    expect((acceptB as HTMLButtonElement).disabled).toBe(false);
  });

  it('starts a StrictMode child save without a false ACTION_IN_PROGRESS', async () => {
    const source = new FakeRealtimeEventSource();
    const meeting = inProgressMeeting();
    const updatedMeeting: JobCard = {
      ...meeting,
      version: meeting.version + 1,
      title: 'Güncel başlık',
    };
    let resolveSave: (value: Response) => void = () => {};
    const saveGate = new Promise<Response>((resolve) => { resolveSave = resolve; });
    let job1Requests = 0;
    const onChanged = vi.fn();
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/customers?')) {
        return Response.json({
          items: [{
            id: 'c1', organizationId: 'org-1', name: 'ABC Klinik', customerType: 'clinic',
            taxNumber: null, phone: null, email: null, city: null, district: null, address: null,
            assignedStaffUserId: null, assignedStaffName: null, primaryContact: null,
            status: 'active', version: 1,
          }], total: 1, limit: 200, offset: 0,
        });
      }
      if (url.includes('/contacts?')) {
        return Response.json({ items: [], total: 0, limit: 200, offset: 0 });
      }
      if (url.endsWith('/meeting-details')) {
        return Response.json({
          ...meetingDetails,
          jobCardVersion: job1Requests >= 2 ? updatedMeeting.version : meeting.version,
        });
      }
      if (url.includes('/notes?')) return Response.json(emptyPage);
      if (url.includes('/activity?')) return Response.json({ ...emptyPage, limit: 50 });
      if (url.endsWith('/api/job-cards/job-1') && init?.method === 'PATCH') return saveGate;
      if (url.endsWith('/api/job-cards/job-1')) {
        job1Requests += 1;
        return Response.json(job1Requests >= 2 ? updatedMeeting : meeting);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    await act(async () => {
      root.render(<StrictMode><RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId="job-1" user={staffUser} onBack={() => {}} onChanged={onChanged} />
      </RealtimeProvider></StrictMode>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      buttonByName(host, 'Görüşmeyi düzenle')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      const titleInput = document.getElementById('meeting-edit-title') as HTMLInputElement;
      titleInput.value = 'Güncel başlık';
      titleInput.dispatchEvent(new Event('input', { bubbles: true }));
      const kindSelect = document.getElementById('meeting-edit-engagement-kind') as HTMLSelectElement;
      kindSelect.value = 'SALES_MEETING';
      kindSelect.dispatchEvent(new Event('change', { bubbles: true }));
      const customerSelect = document.getElementById('meeting-edit-customer') as HTMLSelectElement;
      customerSelect.value = 'c1';
      customerSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      buttonByName(host, 'Değişiklikleri kaydet')?.click();
      await Promise.resolve();
    });
    expect(fetch.mock.calls.some((call) => String(call[0]).endsWith('/api/job-cards/job-1')
      && call[1]?.method === 'PATCH')).toBe(true);
    await act(async () => {
      resolveSave(Response.json(updatedMeeting));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain('Görüşme bilgileri güncellendi');
    expect(host.textContent).not.toContain('Başka bir işlem devam ediyor');
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('does not narrate lifecycle actions inline while keeping the action row intact', async () => {
    await renderDetail(job);
    const panel = host.querySelector('[data-job-decision-panel="true"]');
    expect(panel).not.toBeNull();
    expect(panel!.querySelector('.detail-action-consequence')).toBeNull();
    expect(panel!.textContent).not.toContain('aşamasına alınacaktır');
    expect(panel!.textContent).not.toContain('düzenlenecektir');
    const actionRow = panel!.querySelector('.review-buttons');
    expect(actionRow).not.toBeNull();
    expect(panel!.textContent).toContain('İşi kabul et');
    expect(panel!.textContent).toContain('İşi iptal et');
  });
});
