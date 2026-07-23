/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { act } from 'react';
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
    const event = new MessageEvent('servora.change', {
      data: JSON.stringify({
        id,
        type: 'job.updated',
        entity: { type: 'job-card', id: 'job-1' },
        resourceKeys: ['job-detail:job-1'],
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
    expect(revision.compareDocumentPosition(lifecycle) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
    expect(lifecycle.compareDocumentPosition(responsibility) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
  });

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
    expect(requirements.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
    expect(action.compareDocumentPosition(notes) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
    expect(notes.compareDocumentPosition(timeline) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
    expect(host.textContent).toContain('Eksik maddeleri tamamladığınızda');
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
          total: 1, limit: 25, offset: 0,
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
    await renderScreen(card, staffUser, mockDetailFetch(card, { notes: emptyPage }));
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
    });
    expect(start).toHaveBeenCalledWith('job-1', { clientActionId: 'action-1', expectedVersion: 2 });
    expect(submit).toHaveBeenCalledWith('job-1', { clientActionId: 'action-2', expectedVersion: 3 });
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
          needsDialog: false as const,
        };
      },
    },
    {
      command: 'APPROVE' as const,
      expected: 'İş tamamlandı ve aktif işlerden çıkarıldı.',
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
          confirm: 'İşi tamamla',
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
  ])('uses presentation success copy for $command', async ({ expected, setup }) => {
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
      if ('reason' in scenario && scenario.reason) {
        const textarea = dialog.querySelector<HTMLTextAreaElement>('textarea')!;
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

    const feedback = host.querySelector<HTMLElement>('[role="status"]');
    expect(feedback?.textContent).toBe(expected);
  });
});
