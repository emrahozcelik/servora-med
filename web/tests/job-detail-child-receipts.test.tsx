/** @vitest-environment jsdom */
/**
 * UI-FEEDBACK/B: manager decisions made inside JobDetail child sections own the
 * same committed-receipt boundary as in-page commands. Each decision is checked
 * against the four read outcomes: fresh, failed canonical read, access loss and
 * a rejected mutation that must stay local and only refresh.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JobDetailScreen } from '../src/JobDetail';
import { RealtimeProvider, type RealtimeEventSource } from '../src/realtime/RealtimeProvider';
import type { CurrentUser } from '../src/services/api';
import type {
  AssignmentOffer,
  JobCard,
  JobChangeRequest,
  JobLifecycleFacts,
  JobWorkflowContext,
} from '../src/jobs/jobs-api';
import type { SaleDetails } from '../src/jobs/sale-api';
import { withoutSaleCapability } from './fixtures/job-workflow';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const manager: CurrentUser = {
  id: 'manager-1', organizationId: 'org-1', name: 'Mehmet Yönetici', email: 'm@x',
  role: 'MANAGER', mustChangePassword: false, isActive: true, version: 1,
};

const lifecycle: JobLifecycleFacts = {
  createdAt: '2026-11-12T06:00:00.000Z', acceptedAt: '2026-11-12T06:20:00.000Z',
  acceptedBy: { id: 'manager-1', name: 'Mehmet Yönetici' },
  startedAt: null, submittedAt: null, submittedBy: null, submissionNote: null,
  approvedAt: null, approvedBy: null, approvalNote: null,
  revisionRequestedAt: null, revisionRequestedBy: null, revisionReason: null,
  cancelledAt: null, cancelledBy: null, cancelReason: null, cancelledFromStatus: null,
};

const baseWorkflow: JobWorkflowContext = {
  allowedCommands: [], allowedActions: [], startLocationCaptureEnabled: false,
  submitLocationCaptureEnabled: false, lifecycle, submissionReadiness: null,
};

function context(actions: JobWorkflowContext['allowedActions'], commands: JobWorkflowContext['allowedCommands'] = []): JobWorkflowContext {
  return { ...baseWorkflow, allowedActions: actions, allowedCommands: commands };
}

const emptyPage = { items: [], total: 0, limit: 25, offset: 0 };
const proposedStart = '2026-12-15T09:00:00.000Z';
const proposedEnd = '2026-12-15T09:30:00.000Z';

function openOffer(overrides: Partial<AssignmentOffer> = {}): AssignmentOffer {
  return {
    id: 'offer-1', state: 'DECLINED',
    openedAt: '2026-11-24T09:00:00.000Z',
    acceptanceDueAt: '2026-11-24T12:00:00.000Z',
    urgentReason: null,
    assignee: { id: 'staff-1', name: 'Ayşe Personel' },
    closedAt: '2026-11-24T11:00:00.000Z',
    closeReason: 'SCHEDULE_CONFLICT',
    closeText: null,
    proposedScheduledAt: proposedStart,
    proposedScheduledEndsAt: proposedEnd,
    proposalAcceptedAt: null,
    ...overrides,
  };
}

function offerJob(overrides: Partial<JobCard> = {}): JobCard {
  return {
    id: 'job-1', organizationId: 'org-1', type: 'PRODUCT_DELIVERY', status: 'NEW', version: 3,
    title: 'ABC Klinik ürün teslimi', description: null, customerId: 'c1', contactId: null,
    assignedTo: 'staff-1', createdBy: 'manager-1', priority: 'normal', dueDate: null,
    scheduledAt: '2026-11-24T09:00:00.000Z', scheduledEndsAt: '2026-11-24T09:30:00.000Z',
    engagementKind: null,
    assignee: { id: 'staff-1', name: 'Ayşe Personel' },
    customer: { id: 'c1', name: 'ABC Klinik' }, contact: null,
    workflowContext: context(['EDIT_JOB_FIELDS', 'VIEW_NOTES'], ['CANCEL']),
    followUpContext: null, followUpProposal: null,
    earlyStartAuthorization: null, submitLocationComparison: null,
    changeRequest: null,
    assignmentOffer: openOffer(),
    hasOpenOverdueIncident: false, correctionDueAt: null,
    ...overrides,
  };
}

const changeRequest: JobChangeRequest = {
  id: 'request-1', reasonCode: 'CUSTOMER_POSTPONED',
  reasonText: 'Müşteri kliniği bugün kapalı, teslim yapılamadı.',
  requestedAt: '2026-11-24T09:15:00.000Z',
  requestedBy: { id: 'staff-1', name: 'Ayşe Personel' },
};

function changeRequestJob(overrides: Partial<JobCard> = {}): JobCard {
  return {
    id: 'job-1', organizationId: 'org-1', type: 'GENERAL_TASK', status: 'ACCEPTED', version: 4,
    title: 'Klinik ziyaretini yeniden planla', description: null, customerId: 'c1', contactId: null,
    assignedTo: 'staff-1', createdBy: 'manager-1', priority: 'normal', dueDate: null,
    scheduledAt: null, scheduledEndsAt: null,
    engagementKind: null,
    assignee: { id: 'staff-1', name: 'Ayşe Personel' },
    customer: { id: 'c1', name: 'ABC Klinik' }, contact: null,
    workflowContext: context(['RESOLVE_CHANGE_REQUEST', 'EDIT_JOB_FIELDS', 'VIEW_NOTES'], ['CANCEL']),
    followUpContext: null, followUpProposal: null,
    earlyStartAuthorization: null, submitLocationComparison: null,
    changeRequest,
    assignmentOffer: null,
    hasOpenOverdueIncident: false, correctionDueAt: null,
    ...overrides,
  };
}

function earlyStartJob(overrides: Partial<JobCard> = {}): JobCard {
  return {
    id: 'job-1', organizationId: 'org-1', type: 'PRODUCT_DELIVERY', status: 'ACCEPTED', version: 4,
    title: 'ABC Klinik ürün teslimi', description: null, customerId: 'c1', contactId: null,
    assignedTo: 'staff-1', createdBy: 'manager-1', priority: 'normal', dueDate: null,
    scheduledAt: '2030-06-10T09:00:00.000Z', scheduledEndsAt: '2030-06-10T09:30:00.000Z',
    engagementKind: null,
    assignee: { id: 'staff-1', name: 'Ayşe Personel' },
    customer: { id: 'c1', name: 'ABC Klinik' }, contact: null,
    workflowContext: context(['EDIT_JOB_FIELDS', 'VIEW_NOTES'], ['CANCEL']),
    followUpContext: null, followUpProposal: null,
    earlyStartAuthorization: null, submitLocationComparison: null,
    changeRequest: null,
    assignmentOffer: null,
    hasOpenOverdueIncident: false, correctionDueAt: null,
    ...overrides,
  };
}

const saleDetailsBefore: SaleDetails = {
  jobCardId: 'job-1', jobCardVersion: 4, soldAt: '2026-11-10T08:00:00.000Z', saleContact: null,
  sourceVisit: { access: 'RESTRICTED', kind: 'SALE_FROM_VISIT' },
  items: [{
    id: 'line-1', productId: 'product-1', name: 'İmplant Seti', sku: 'SKU-1',
    brand: 'Servora', model: null, unit: 'adet', quantity: '5',
  }],
};

const saleDetailsAfter: SaleDetails = {
  ...saleDetailsBefore,
  jobCardVersion: 5,
  items: [{ ...saleDetailsBefore.items[0]!, quantity: '15' }],
};

function saleJob(overrides: Partial<JobCard> = {}): JobCard {
  return {
    id: 'job-1', organizationId: 'org-1', type: 'SALE', status: 'ACCEPTED', version: 4,
    title: 'ABC Klinik satış anlaşması', description: null, customerId: 'c1', contactId: null,
    assignedTo: 'staff-1', createdBy: 'manager-1', priority: 'normal', dueDate: null,
    scheduledAt: null, scheduledEndsAt: null,
    engagementKind: null,
    assignee: { id: 'staff-1', name: 'Ayşe Personel' },
    customer: { id: 'c1', name: 'ABC Klinik' }, contact: null,
    workflowContext: context(['EDIT_JOB_FIELDS', 'VIEW_NOTES']),
    followUpContext: null, followUpProposal: null,
    earlyStartAuthorization: null, submitLocationComparison: null,
    changeRequest: null, assignmentOffer: null,
    hasOpenOverdueIncident: false, correctionDueAt: null,
    ...overrides,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
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

  emitJobUpdate(jobCardId: string, id: string) {
    const event = new MessageEvent('servora.change', {
      data: JSON.stringify({
        id,
        type: 'job.updated',
        entity: { type: 'job-card', id: jobCardId },
        resourceKeys: [`job-detail:${jobCardId}`],
        occurredAt: '2026-11-24T10:00:00.000Z',
      }),
    });
    this.listeners.get('servora.change')?.forEach((listener) => listener(event));
  }
}

function detailUrlMatches(url: string, id: string) {
  const path = url.split('?')[0] ?? url;
  return path.endsWith(`/api/job-cards/${id}`);
}

function buttonByText(host: ParentNode, name: string) {
  return Array.from(host.querySelectorAll('button'))
    .find((button) => button.textContent?.trim() === name) ?? null;
}

async function settle() {
  await act(async () => {
    for (let index = 0; index < 4; index += 1) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

type ReadFailure = 403 | 500;

type Harness = {
  fetch: ReturnType<typeof vi.fn>;
  detailGets: () => number;
  mutationCalls: () => number;
  activityGets: () => number;
};

function makeHarness(options: {
  before: JobCard;
  after: () => JobCard;
  mutationPath: string;
  success: () => Response;
  failure: () => Response;
  succeed: boolean;
  readFailure?: ReadFailure;
  /** The first canonical read after a rejected decision (new truth). */
  failureRead?: () => JobCard;
  /** The first canonical read after a rejected decision fails (sale recheck). */
  failFirstReadAfterAttempt?: ReadFailure;
  sale?: { before: SaleDetails; after: () => SaleDetails };
}): Harness {
  let committed = false;
  let attempted = false;
  let failureServed = false;
  let failureReadServed = false;
  let detailGets = 0;
  let mutationCalls = 0;
  let activityGets = 0;
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = withoutSaleCapability(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.split('?')[0] ?? url;
    if (url.endsWith('/api/notifications/read-by-entity')) return json({});
    if (url.includes('/delivery-items')) return json({ items: [] });
    if (url.includes('/notes?')) return json(emptyPage);
    if (url.includes('/activity?')) {
      activityGets += 1;
      return json({ ...emptyPage, limit: 50 });
    }
    if (url.includes('/submission-lateness')) return json({ open: null });
    if (url.includes('/overdue-incidents')) return json(emptyPage);
    if (url.includes('/follow-ups')) return json(emptyPage);
    if (url.includes('/api/staff?')) return json([]);
    if (url.includes('/api/customers/') && url.includes('/contacts')) return json(emptyPage);
    if (options.sale !== undefined && path.endsWith(`/api/job-cards/${options.before.id}/sale-details`)) {
      return json(committed ? options.sale.after() : options.sale.before);
    }
    if (method !== 'GET' && path.endsWith(options.mutationPath)) {
      mutationCalls += 1;
      attempted = true;
      const response = options.succeed ? options.success() : options.failure();
      if (response.ok) committed = true;
      return response;
    }
    if (detailUrlMatches(url, options.before.id)) {
      detailGets += 1;
      if (committed && options.readFailure !== undefined && !failureServed) {
        failureServed = true;
        return json({ error: 'Sunucu hatası.' }, options.readFailure);
      }
      if (attempted && !committed && options.failFirstReadAfterAttempt !== undefined
        && !failureReadServed) {
        failureReadServed = true;
        return json({ error: 'Sunucu hatası.' }, options.failFirstReadAfterAttempt);
      }
      if (attempted && !committed && options.failureRead !== undefined && !failureReadServed) {
        failureReadServed = true;
        return json(options.failureRead());
      }
      return json(committed ? options.after() : options.before);
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  return {
    fetch, detailGets: () => detailGets, mutationCalls: () => mutationCalls,
    activityGets: () => activityGets,
  };
}

async function click(host: ParentNode, name: string) {
  const button = buttonByText(host, name);
  if (button === null) throw new Error(`Button not found: ${name}`);
  await act(async () => { button.click(); });
}

type Decision = {
  name: string;
  receipt: string;
  mutationPath: string;
  before: () => JobCard;
  after: () => JobCard;
  success: () => Response;
  failure: () => Response;
  /** Performs the manager decision in the mounted JobDetail screen. */
  decide: (host: HTMLElement) => Promise<void>;
  /** The child-local success line that must disappear when the page owns it. */
  localReceipt: string;
  /** The local failure/conflict text that must stay in the child. */
  localError: string;
  /** When set, the local error element must keep this text after the refresh. */
  localErrorText?: string;
  /** A rejected decision's canonical read may still advance the job version. */
  failureRead?: () => JobCard;
  /** A control disabled by the committed-stale lock. */
  lockedControl: string;
  /** The child section that either unmounts or stays outside the page receipt. */
  sectionGone?: string;
  /** The child section that remains but must not own the page receipt. */
  section?: string;
  /** Sale correction needs its explicit canonical-reload action. */
  retryAfterFailure?: (host: HTMLElement) => Promise<void>;
  sale?: { before: SaleDetails; after: () => SaleDetails };
};

const decisions: Decision[] = [
  {
    name: 'assignment proposal acceptance',
    receipt: 'Önerilen zaman onaylandı; iş Ayşe Personel için kabul edildi.',
    mutationPath: '/api/job-cards/job-1/assignment-offers/accept-proposal',
    before: () => offerJob(),
    after: () => ({
      ...offerJob(),
      version: 4,
      assignmentOffer: null,
    }),
    success: () => json({
      jobCardId: 'job-1', offerId: 'offer-1', scheduledAt: proposedStart, scheduledEndsAt: proposedEnd,
    }),
    failure: () => json({
      error: 'Öneri artık geçerli değil.', code: 'ASSIGNMENT_PROPOSAL_NOT_AVAILABLE',
    }, 409),
    decide: async (host) => {
      await click(host, 'Önerilen zamanı onayla');
      const dialog = host.querySelector('[role="dialog"]');
      const confirm = dialog?.querySelector<HTMLButtonElement>('.product-dialog-actions .primary-button');
      if (!confirm) throw new Error('Proposal confirmation is missing');
      await act(async () => { confirm.click(); });
      await settle();
    },
    localReceipt: '[data-assignment-offer-proposal-accepted="true"]',
    localError: '[data-assignment-offer-proposal-error="true"]',
    localErrorText: 'Personelin önerdiği zaman artık onaylanamıyor',
    lockedControl: '[data-assignment-offer-action="accept-proposal"]',
    sectionGone: '[data-assignment-offer]',
    section: '[data-assignment-offer]',
  },
  {
    name: 'assignment re-offer',
    receipt: 'Yeni atama teklifi açıldı; personelin yanıtı bekleniyor.',
    mutationPath: '/api/job-cards/job-1/assignment-offers/reoffer',
    before: () => offerJob({
      assignmentOffer: openOffer({
        closeReason: 'ON_LEAVE', proposedScheduledAt: null, proposedScheduledEndsAt: null,
      }),
    }),
    after: () => ({
      ...offerJob({
        assignmentOffer: openOffer({
          closeReason: 'ON_LEAVE', proposedScheduledAt: null, proposedScheduledEndsAt: null,
        }),
      }),
      version: 4,
      assignmentOffer: null,
    }),
    success: () => json({
      jobCardId: 'job-1', offerId: 'offer-2',
      acceptanceDueAt: '2026-12-01T12:00:00.000Z', urgentReason: 'START_PASSED',
    }, 201),
    failure: () => json({
      error: 'Aralık çok kısa.', code: 'ASSIGNMENT_WINDOW_TOO_SHORT',
    }, 409),
    decide: async (host) => {
      await click(host, 'Aynı zamanla yeniden teklif et');
      await settle();
    },
    localReceipt: '[data-assignment-offer-reoffered="true"]',
    localError: '[data-assignment-offer] .field-error',
    localErrorText: 'Planlanan zaman aralığı atama için çok kısa.',
    failureRead: () => ({
      ...offerJob({
        assignmentOffer: openOffer({
          closeReason: 'ON_LEAVE', proposedScheduledAt: null, proposedScheduledEndsAt: null,
        }),
      }),
      version: 4,
    }),
    lockedControl: '[data-assignment-offer-action="reoffer"]',
    sectionGone: '[data-assignment-offer]',
    section: '[data-assignment-offer]',
  },
  {
    name: 'change request record-only closure',
    receipt: 'Öneri kapatıldı: Düzeltildi. İş bilgileri değişmedi.',
    mutationPath: '/api/job-cards/job-1/change-requests/request-1/resolve',
    before: () => changeRequestJob(),
    after: () => ({ ...changeRequestJob(), version: 5, changeRequest: null }),
    success: () => json({
      jobCardId: 'job-1', changeRequestId: 'request-1', resolution: 'CORRECTED',
      resolvedAt: '2026-11-24T10:00:00.000Z',
    }),
    failure: () => json({
      error: 'Bu öneri zaten sonuçlandırılmış.', code: 'CHANGE_REQUEST_NOT_OPEN',
    }, 409),
    decide: async (host) => {
      await click(host, 'Gerekli düzeltmeyi yaptım');
      const form = host.querySelector('form.change-request-form') as HTMLFormElement | null;
      if (!form) throw new Error('Change request closure drawer is missing');
      await act(async () => { form.requestSubmit(); });
      await settle();
    },
    localReceipt: '[data-change-request-resolved]',
    localError: '[data-change-request-not-open="true"]',
    localErrorText: 'Öneri zaten kapatılmış.',
    lockedControl: '[data-change-request-resolve="CORRECTED"]',
    sectionGone: '[data-change-request="management"]',
    section: '[data-change-request="management"]',
  },
  {
    name: 'early start authorization',
    receipt: 'Erken başlama izni kaydedildi.',
    mutationPath: '/api/job-cards/job-1/early-start-authorization',
    before: () => earlyStartJob(),
    after: () => ({
      ...earlyStartJob(),
      version: 5,
      earlyStartAuthorization: {
        grantedAt: '2026-11-24T10:00:00.000Z',
        grantedBy: { id: 'manager-1', name: 'Mehmet Yönetici' },
      },
    }),
    success: () => json({
      jobCardId: 'job-1', authorizationId: 'auth-1', grantedAt: '2026-11-24T10:00:00.000Z',
    }),
    failure: () => json({
      error: 'Bu iş için geçerli bir erken başlama izni zaten var.',
      code: 'EARLY_START_ALREADY_AUTHORIZED',
    }, 409),
    decide: async (host) => {
      await click(host, 'Erken başlamaya izin ver');
      await click(host, 'Erken başlama iznini kaydet');
      await settle();
    },
    localReceipt: '[data-early-start-authorization-status="granted"]',
    localError: '[data-early-start-authorization] [role="alert"]',
    localErrorText: 'Bu iş için geçerli bir erken başlama izni zaten var.',
    failureRead: () => ({ ...earlyStartJob(), version: 5 }),
    lockedControl: '[data-early-start-authorization-reveal="true"]',
    section: '[data-early-start-authorization]',
  },
  {
    name: 'sale correction',
    receipt: 'Satış kaydı güncellendi.',
    mutationPath: '/api/job-cards/job-1/sale-items/line-1',
    before: () => saleJob(),
    after: () => ({ ...saleJob(), version: 5 }),
    success: () => json({ jobCardId: 'job-1', version: 5 }),
    failure: () => json({ error: 'Kayıt başka bir işlemle güncellendi.', code: 'VERSION_CONFLICT' }, 409),
    decide: async (host) => {
      const input = host.querySelector<HTMLInputElement>('input[aria-label="İmplant Seti satış adedi"]');
      if (!input) throw new Error('Sale correction quantity is missing');
      await act(async () => { setNativeValue(input, '15'); });
      await click(host, 'Adedi kaydet');
      await settle();
    },
    localReceipt: '.sale-correction > .detail-feedback',
    localError: '.sale-correction > .detail-feedback',
    localErrorText: 'Kayıt başka bir işlemle güncellendi.',
    lockedControl: '.sale-correction fieldset',
    section: '.sale-correction',
    sale: { before: saleDetailsBefore, after: () => saleDetailsAfter },
    retryAfterFailure: async (host) => {
      await click(host, 'Güncel kaydı yükle ve düzeltmeye devam et');
      await settle();
    },
  },
];

describe('JobDetail child decision receipts', () => {
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
    fetch: ReturnType<typeof vi.fn>,
    source = new FakeRealtimeEventSource(),
  ) {
    vi.stubGlobal('fetch', fetch);
    await act(async () => {
      root.render(<RealtimeProvider eventSourceFactory={() => source}>
        <JobDetailScreen jobId={card.id} user={manager} onBack={() => {}} onChanged={() => {}} />
      </RealtimeProvider>);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await settle();
    return source;
  }

  function receiptRegions(receipt: string) {
    return Array.from(host.querySelectorAll('[role="status"]'))
      .filter((element) => element.textContent?.includes(receipt));
  }

  for (const decision of decisions) {
    describe(decision.name, () => {
      it('shows one page receipt and keeps it after the child section closes', async () => {
        const before = decision.before();
        const harness = makeHarness({
          before, after: decision.after, mutationPath: decision.mutationPath,
          success: decision.success, failure: decision.failure, succeed: true, sale: decision.sale,
        });
        await renderScreen(before, harness.fetch);
        await decision.decide(host);

        const regions = receiptRegions(decision.receipt);
        expect(regions).toHaveLength(1);
        const feedback = host.querySelector<HTMLElement>('[data-job-detail-section="feedback"]');
        expect(feedback).not.toBeNull();
        expect(feedback).toBe(regions[0]);
        expect(feedback?.textContent).toContain(decision.receipt);
        expect(document.activeElement).toBe(feedback);
        expect(host.querySelector(decision.localReceipt)).toBeNull();
        if (decision.sectionGone !== undefined) {
          expect(host.querySelector(decision.sectionGone)).toBeNull();
        }
        if (decision.section !== undefined) {
          const section = host.querySelector(decision.section);
          if (section !== null) expect(section.contains(feedback)).toBe(false);
        }
        expect(harness.mutationCalls()).toBe(1);
        expect(harness.detailGets()).toBe(2);
      });

      it('keeps the receipt in the committed notice when the canonical read fails', async () => {
        const before = decision.before();
        const harness = makeHarness({
          before, after: decision.after, mutationPath: decision.mutationPath,
          success: decision.success, failure: decision.failure, succeed: true,
          readFailure: 500, sale: decision.sale,
        });
        await renderScreen(before, harness.fetch);
        await decision.decide(host);

        const notice = host.querySelector<HTMLElement>('[data-job-detail-committed-refresh="true"]');
        expect(notice).not.toBeNull();
        expect(notice?.textContent).toContain(decision.receipt);
        expect(notice?.textContent).toContain('Güncel kayıt henüz yüklenemedi.');
        expect(host.querySelector('main[data-job-detail-committed-stale="true"]')).not.toBeNull();
        expect(host.querySelector(decision.localReceipt)).toBeNull();
        const locked = host.querySelector<HTMLButtonElement & HTMLFieldSetElement>(decision.lockedControl);
        expect(locked).not.toBeNull();
        expect(locked?.disabled).toBe(true);
        expect(receiptRegions(decision.receipt)).toHaveLength(1);
        expect(document.activeElement).toBe(notice);
        expect(harness.mutationCalls()).toBe(1);

        // The existing serialized reload settles the notice into the receipt.
        await click(host, 'Güncel durumu yenile');
        await settle();
        expect(host.querySelector('[data-job-detail-committed-refresh="true"]')).toBeNull();
        const feedback = host.querySelector<HTMLElement>('[data-job-detail-section="feedback"]');
        expect(feedback?.textContent).toContain(decision.receipt);
        expect(harness.mutationCalls()).toBe(1);
        expect(harness.detailGets()).toBe(3);
      });

      it('becomes the terminal access-lost state when the canonical read is forbidden', async () => {
        const before = decision.before();
        const harness = makeHarness({
          before, after: decision.after, mutationPath: decision.mutationPath,
          success: decision.success, failure: decision.failure, succeed: true,
          readFailure: 403, sale: decision.sale,
        });
        await renderScreen(before, harness.fetch);
        await decision.decide(host);

        expect(host.textContent).toContain('İşlem kaydedildi. İşin güncel kaydına artık erişilemiyor.');
        expect(host.querySelector('[data-job-detail-committed-refresh="true"]')).toBeNull();
        expect(host.querySelector(decision.localReceipt)).toBeNull();
        expect(receiptRegions(decision.receipt)).toHaveLength(0);
        expect(harness.mutationCalls()).toBe(1);
        expect(harness.detailGets()).toBe(2);
      });

      it('keeps a rejected decision local and only reloads the canonical card', async () => {
        const before = decision.before();
        const harness = makeHarness({
          before, after: decision.after, mutationPath: decision.mutationPath,
          success: decision.success, failure: decision.failure, succeed: false,
          failureRead: decision.failureRead, sale: decision.sale,
        });
        await renderScreen(before, harness.fetch);
        await decision.decide(host);

        expect(harness.mutationCalls()).toBe(1);
        expect(receiptRegions(decision.receipt)).toHaveLength(0);
        expect(host.querySelector('[data-job-detail-committed-refresh="true"]')).toBeNull();
        if (decision.localError.startsWith('[') || decision.localError.startsWith('.')) {
          expect(host.querySelector(decision.localError)).not.toBeNull();
        } else {
          expect(host.textContent).toContain(decision.localError);
        }
        if (decision.localErrorText !== undefined) {
          expect(host.querySelector(decision.localError)?.textContent).toContain(decision.localErrorText);
        }

        await decision.retryAfterFailure?.(host);
        await settle();
        expect(harness.detailGets()).toBe(2);
        expect(harness.mutationCalls()).toBe(1);
        expect(receiptRegions(decision.receipt)).toHaveLength(0);
        if (decision.localError.startsWith('[') || decision.localError.startsWith('.')) {
          expect(host.querySelector(decision.localError)).not.toBeNull();
        } else {
          expect(host.textContent).toContain(decision.localError);
        }
        if (decision.localErrorText !== undefined) {
          expect(host.querySelector(decision.localError)?.textContent).toContain(decision.localErrorText);
        }
      });
    });
  }

  it('keeps the change-request receipt when a realtime refresh closes the request in flight', async () => {
    const before = changeRequestJob();
    const source = new FakeRealtimeEventSource();
    let closed = false;
    let mutationCalls = 0;
    let resolveMutation!: (response: Response) => void;
    const heldMutation = new Promise<Response>((resolve) => { resolveMutation = resolve; });
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = withoutSaleCapability(String(input));
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/api/notifications/read-by-entity')) return json({});
      if (url.includes('/notes?')) return json(emptyPage);
      if (url.includes('/activity?')) return json({ ...emptyPage, limit: 50 });
      if (url.includes('/submission-lateness')) return json({ open: null });
      if (url.includes('/overdue-incidents')) return json(emptyPage);
      if (url.includes('/follow-ups')) return json(emptyPage);
      if (method === 'POST' && (url.split('?')[0] ?? url).endsWith(
        '/api/job-cards/job-1/change-requests/request-1/resolve',
      )) {
        mutationCalls += 1;
        return heldMutation;
      }
      if (detailUrlMatches(url, before.id)) {
        return json(closed ? { ...before, version: 5, changeRequest: null } : before);
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    await renderScreen(before, fetch, source);
    await click(host, 'Gerekli düzeltmeyi yaptım');
    const form = host.querySelector('form.change-request-form') as HTMLFormElement | null;
    if (!form) throw new Error('Change request closure drawer is missing');
    await act(async () => { form.requestSubmit(); });

    // The resolve request is still in flight when the realtime truth closes it.
    closed = true;
    await act(async () => {
      source.emitJobUpdate('job-1', '1');
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await settle();
    expect(host.querySelector('[data-change-request="management"]')).toBeNull();

    await act(async () => {
      resolveMutation(json({
        jobCardId: 'job-1', changeRequestId: 'request-1', resolution: 'CORRECTED',
        resolvedAt: '2026-11-24T10:00:00.000Z',
      }));
    });
    await settle();

    expect(mutationCalls).toBe(1);
    const receipt = 'Öneri kapatıldı: Düzeltildi. İş bilgileri değişmedi.';
    expect(receiptRegions(receipt)).toHaveLength(1);
    expect(host.querySelector('[data-job-detail-section="feedback"]')?.textContent).toContain(receipt);
    expect(host.querySelector('[data-change-request-resolved]')).toBeNull();
  });

  it('keeps the early-start rejection visible with the refreshed version', async () => {
    const before = earlyStartJob();
    const harness = makeHarness({
      before, after: () => before, mutationPath: '/api/job-cards/job-1/early-start-authorization',
      success: () => json({ jobCardId: 'job-1', authorizationId: 'auth-1', grantedAt: '2026-11-24T10:00:00.000Z' }),
      failure: () => json({
        error: 'Bu iş için geçerli bir erken başlama izni zaten var.',
        code: 'EARLY_START_ALREADY_AUTHORIZED',
      }, 409),
      succeed: false,
      failureRead: () => ({ ...earlyStartJob(), version: 5 }),
    });
    await renderScreen(before, harness.fetch);
    await click(host, 'Erken başlamaya izin ver');
    await click(host, 'Erken başlama iznini kaydet');
    await settle();

    const reveal = host.querySelector<HTMLButtonElement>('[data-early-start-authorization-reveal="true"]');
    expect(reveal?.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('[data-early-start-authorization] [role="alert"]')?.textContent)
      .toContain('Bu iş için geçerli bir erken başlama izni zaten var.');
    expect(receiptRegions('Erken başlama izni kaydedildi.')).toHaveLength(0);
    expect(harness.detailGets()).toBe(2);
    expect(harness.mutationCalls()).toBe(1);
  });

  it('a safe reload of the committed receipt refreshes the activity timeline', async () => {
    const before = offerJob();
    const harness = makeHarness({
      before,
      after: () => ({ ...offerJob(), version: 4, assignmentOffer: null }),
      mutationPath: '/api/job-cards/job-1/assignment-offers/accept-proposal',
      success: () => json({
        jobCardId: 'job-1', offerId: 'offer-1', scheduledAt: proposedStart, scheduledEndsAt: proposedEnd,
      }),
      failure: () => json({ error: 'Yarış.', code: 'VERSION_CONFLICT' }, 409),
      succeed: true,
      readFailure: 500,
    });
    await renderScreen(before, harness.fetch);
    await click(host, 'Önerilen zamanı onayla');
    const confirm = host.querySelector<HTMLButtonElement>(
      '[role="dialog"] .product-dialog-actions .primary-button',
    );
    await act(async () => { confirm!.click(); });
    await settle();
    expect(host.querySelector('[data-job-detail-committed-refresh="true"]')).not.toBeNull();

    const activityBefore = harness.activityGets();
    await click(host, 'Güncel durumu yenile');
    await settle();
    expect(host.querySelector('[data-job-detail-committed-refresh="true"]')).toBeNull();
    expect(host.querySelector('[data-job-detail-section="feedback"]')?.textContent)
      .toContain('Önerilen zaman onaylandı; iş Ayşe Personel için kabul edildi.');
    expect(harness.activityGets()).toBeGreaterThan(activityBefore);
  });

  it('a second decision retires the previous receipt and announces the new one', async () => {
    const before = offerJob({
      assignmentOffer: openOffer({
        closeReason: 'ON_LEAVE', proposedScheduledAt: null, proposedScheduledEndsAt: null,
      }),
    });
    let version = 3;
    let postCalls = 0;
    let resolveSecond!: (response: Response) => void;
    const second = new Promise<Response>((resolve) => { resolveSecond = resolve; });
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = withoutSaleCapability(String(input));
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/api/notifications/read-by-entity')) return json({});
      if (url.includes('/delivery-items')) return json({ items: [] });
      if (url.includes('/notes?')) return json(emptyPage);
      if (url.includes('/activity?')) return json({ ...emptyPage, limit: 50 });
      if (url.includes('/submission-lateness')) return json({ open: null });
      if (url.includes('/overdue-incidents')) return json(emptyPage);
      if (url.includes('/follow-ups')) return json(emptyPage);
      if (method === 'POST' && (url.split('?')[0] ?? url).endsWith(
        '/api/job-cards/job-1/assignment-offers/reoffer',
      )) {
        postCalls += 1;
        if (postCalls === 1) {
          version = 4;
          return json({
            jobCardId: 'job-1', offerId: 'offer-2',
            acceptanceDueAt: '2026-12-01T12:00:00.000Z', urgentReason: 'START_PASSED',
          }, 201);
        }
        return second;
      }
      if (detailUrlMatches(url, before.id)) return json({ ...before, version });
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    await renderScreen(before, fetch);

    await click(host, 'Aynı zamanla yeniden teklif et');
    await settle();
    const firstReceipt = host.querySelector<HTMLElement>('[data-job-detail-section="feedback"]');
    expect(firstReceipt?.textContent).toContain('Yeni atama teklifi açıldı; personelin yanıtı bekleniyor.');

    await click(host, 'Aynı zamanla yeniden teklif et');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    // The previous confirmation is retired as soon as the new action starts.
    expect(host.querySelector('[data-job-detail-section="feedback"]')).toBeNull();

    version = 5;
    await act(async () => {
      resolveSecond(json({
        jobCardId: 'job-1', offerId: 'offer-3',
        acceptanceDueAt: '2026-12-02T12:00:00.000Z', urgentReason: 'START_PASSED',
      }, 201));
    });
    await settle();
    const secondReceipt = host.querySelector<HTMLElement>('[data-job-detail-section="feedback"]');
    expect(secondReceipt?.textContent).toContain('Yeni atama teklifi açıldı; personelin yanıtı bekleniyor.');
    expect(secondReceipt).not.toBe(firstReceipt);
    expect(postCalls).toBe(2);
  });

  it('an older realtime read cannot overwrite the committed child decision', async () => {
    const before = offerJob({
      assignmentOffer: openOffer({
        closeReason: 'ON_LEAVE', proposedScheduledAt: null, proposedScheduledEndsAt: null,
      }),
    });
    const after = { ...before, version: 4, assignmentOffer: null };
    const source = new FakeRealtimeEventSource();
    let holdNextRead = false;
    let releaseHeld!: (response: Response) => void;
    let committed = false;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = withoutSaleCapability(String(input));
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/api/notifications/read-by-entity')) return json({});
      if (url.includes('/delivery-items')) return json({ items: [] });
      if (url.includes('/notes?')) return json(emptyPage);
      if (url.includes('/activity?')) return json({ ...emptyPage, limit: 50 });
      if (url.includes('/submission-lateness')) return json({ open: null });
      if (url.includes('/overdue-incidents')) return json(emptyPage);
      if (url.includes('/follow-ups')) return json(emptyPage);
      if (method === 'POST' && (url.split('?')[0] ?? url).endsWith(
        '/api/job-cards/job-1/assignment-offers/reoffer',
      )) {
        committed = true;
        return json({
          jobCardId: 'job-1', offerId: 'offer-2',
          acceptanceDueAt: '2026-12-01T12:00:00.000Z', urgentReason: 'START_PASSED',
        }, 201);
      }
      if (detailUrlMatches(url, before.id)) {
        if (!committed && holdNextRead) {
          holdNextRead = false;
          return new Promise<Response>((resolve) => { releaseHeld = resolve; });
        }
        return json(committed ? after : before);
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    await renderScreen(before, fetch, source);

    holdNextRead = true;
    await act(async () => {
      source.emitJobUpdate('job-1', '1');
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await click(host, 'Aynı zamanla yeniden teklif et');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

    // The pre-decision realtime read finishes last with the old version.
    await act(async () => { releaseHeld(json(before)); });
    await settle();
    await settle();

    expect(host.querySelector('[data-assignment-offer]')).toBeNull();
    expect(host.querySelector('[data-job-detail-committed-refresh="true"]')).toBeNull();
    expect(receiptRegions('Yeni atama teklifi açıldı; personelin yanıtı bekleniyor.')).toHaveLength(1);
  });

  it('keeps a re-offer version-conflict explanation after the refreshed version', async () => {
    const before = offerJob({
      assignmentOffer: openOffer({
        closeReason: 'ON_LEAVE', proposedScheduledAt: null, proposedScheduledEndsAt: null,
      }),
    });
    const harness = makeHarness({
      before, after: () => before,
      mutationPath: '/api/job-cards/job-1/assignment-offers/reoffer',
      success: () => json({ jobCardId: 'job-1', offerId: 'offer-2' }, 201),
      failure: () => json({
        error: 'İş başka bir işlemle güncellendi.', code: 'VERSION_CONFLICT',
      }, 409),
      succeed: false,
      failureRead: () => ({
        ...offerJob({
          assignmentOffer: openOffer({
            closeReason: 'ON_LEAVE', proposedScheduledAt: null, proposedScheduledEndsAt: null,
          }),
        }),
        version: 4,
      }),
    });
    await renderScreen(before, harness.fetch);
    await click(host, 'Aynı zamanla yeniden teklif et');
    await settle();

    expect(host.querySelector('[data-assignment-offer] .field-error')?.textContent)
      .toContain('İş başka bir işlemle güncellendi.');
    expect(receiptRegions('Yeni atama teklifi açıldı; personelin yanıtı bekleniyor.')).toHaveLength(0);
    expect(harness.mutationCalls()).toBe(1);
  });

  it('keeps an early-start version-conflict explanation after the refreshed version', async () => {
    const before = earlyStartJob();
    const harness = makeHarness({
      before, after: () => before, mutationPath: '/api/job-cards/job-1/early-start-authorization',
      success: () => json({ jobCardId: 'job-1', authorizationId: 'auth-1', grantedAt: '2026-11-24T10:00:00.000Z' }),
      failure: () => json({
        error: 'İş başka bir işlemle güncellendi.', code: 'VERSION_CONFLICT',
      }, 409),
      succeed: false,
      failureRead: () => ({ ...earlyStartJob(), version: 5 }),
    });
    await renderScreen(before, harness.fetch);
    await click(host, 'Erken başlamaya izin ver');
    await click(host, 'Erken başlama iznini kaydet');
    await settle();

    expect(host.querySelector('[data-early-start-authorization-reveal="true"]')
      ?.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('[data-early-start-authorization] [role="alert"]')?.textContent)
      .toContain('İş başka bir işlemle güncellendi.');
    expect(receiptRegions('Erken başlama izni kaydedildi.')).toHaveLength(0);
    expect(harness.mutationCalls()).toBe(1);
  });

  it('a second sale correction attempt retires the previous receipt', async () => {
    const before = saleJob();
    let canonicalVersion = 4;
    let patches = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = withoutSaleCapability(String(input));
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/api/notifications/read-by-entity')) return json({});
      if (url.includes('/notes?')) return json(emptyPage);
      if (url.includes('/activity?')) return json({ ...emptyPage, limit: 50 });
      if (url.includes('/submission-lateness')) return json({ open: null });
      if (url.includes('/overdue-incidents')) return json(emptyPage);
      if (url.includes('/follow-ups')) return json(emptyPage);
      if (url.includes('/api/customers/') && url.includes('/contacts')) return json(emptyPage);
      if (method === 'PATCH' && (url.split('?')[0] ?? url).endsWith(
        '/api/job-cards/job-1/sale-items/line-1',
      )) {
        patches += 1;
        if (patches === 1) {
          canonicalVersion = 5;
          return json({ jobCardId: 'job-1', version: 5 });
        }
        return json({ error: 'Kayıt başka bir işlemle güncellendi.', code: 'VERSION_CONFLICT' }, 409);
      }
      if ((url.split('?')[0] ?? url).endsWith('/api/job-cards/job-1/sale-details')) {
        return json({
          ...saleDetailsBefore,
          jobCardVersion: canonicalVersion,
          items: [{
            ...saleDetailsBefore.items[0]!,
            quantity: canonicalVersion === 4 ? '5' : '15',
          }],
        });
      }
      if (detailUrlMatches(url, before.id)) return json({ ...before, version: canonicalVersion });
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    await renderScreen(before, fetch);

    const quantityInput = () => host.querySelector<HTMLInputElement>(
      'input[aria-label="İmplant Seti satış adedi"]',
    );
    await act(async () => { setNativeValue(quantityInput()!, '15'); });
    await click(host, 'Adedi kaydet');
    await settle();
    expect(host.querySelector('[data-job-detail-section="feedback"]')?.textContent)
      .toContain('Satış kaydı güncellendi.');

    await act(async () => { setNativeValue(quantityInput()!, '20'); });
    await click(host, 'Adedi kaydet');
    await settle();

    expect(patches).toBe(2);
    expect(host.querySelector('[data-job-detail-section="feedback"]')).toBeNull();
    expect(host.querySelector('.sale-correction > .detail-feedback')?.textContent)
      .toContain('Kayıt başka bir işlemle güncellendi.');
  });

  it('uses the rejection-specific receipt for a rejected change request', async () => {
    const before = changeRequestJob();
    const harness = makeHarness({
      before,
      after: () => ({ ...changeRequestJob(), version: 5, changeRequest: null }),
      mutationPath: '/api/job-cards/job-1/change-requests/request-1/resolve',
      success: () => json({
        jobCardId: 'job-1', changeRequestId: 'request-1', resolution: 'REJECTED',
        resolvedAt: '2026-11-24T10:00:00.000Z',
      }),
      failure: () => json({ error: 'Yarış.', code: 'VERSION_CONFLICT' }, 409),
      succeed: true,
    });
    await renderScreen(before, harness.fetch);
    await click(host, 'Öneriyi reddet');
    const note = host.querySelector<HTMLTextAreaElement>('#change-request-reject-note');
    if (!note) throw new Error('Rejection note is missing');
    await act(async () => { setNativeValue(note, 'Teslim yeniden planlandı.'); });
    const form = host.querySelector('form.change-request-form') as HTMLFormElement | null;
    if (!form) throw new Error('Rejection drawer is missing');
    await act(async () => { form.requestSubmit(); });
    await settle();

    const receipt = 'Öneri reddedildi. İş bilgileri değişmedi.';
    const regions = receiptRegions(receipt);
    expect(regions).toHaveLength(1);
    expect(host.querySelector('[data-job-detail-section="feedback"]')).toBe(regions[0]);
    expect(host.querySelector('[data-change-request="management"]')).toBeNull();
    expect(host.querySelector('[data-change-request-resolved]')).toBeNull();
  });

  it('sale correction keeps the rejected draft when the conflict reload cannot read', async () => {
    const before = saleJob();
    const harness = makeHarness({
      before,
      after: () => ({ ...saleJob(), version: 5 }),
      mutationPath: '/api/job-cards/job-1/sale-items/line-1',
      success: () => json({ jobCardId: 'job-1', version: 5 }),
      failure: () => json({ error: 'Kayıt başka bir işlemle güncellendi.', code: 'VERSION_CONFLICT' }, 409),
      succeed: false,
      failFirstReadAfterAttempt: 500,
      sale: { before: saleDetailsBefore, after: () => saleDetailsAfter },
    });
    await renderScreen(before, harness.fetch);
    const input = host.querySelector<HTMLInputElement>('input[aria-label="İmplant Seti satış adedi"]')!;
    await act(async () => { setNativeValue(input, '15'); });
    await click(host, 'Adedi kaydet');
    await settle();

    // The reload read fails after the definitive conflict: the lock and the
    // typed draft survive until a strictly newer canonical version arrives.
    await click(host, 'Güncel kaydı yükle ve düzeltmeye devam et');
    await settle();

    expect(harness.detailGets()).toBe(2);
    expect(harness.mutationCalls()).toBe(1);
    expect(host.querySelector<HTMLInputElement>('.sale-correction fieldset')?.disabled).toBe(true);
    expect(buttonByText(host, 'Güncel kaydı yükle ve düzeltmeye devam et')).not.toBeNull();
    expect(host.querySelector<HTMLInputElement>('input[aria-label="İmplant Seti satış adedi"]')?.value)
      .toBe('15');
    expect(receiptRegions('Satış kaydı güncellendi.')).toHaveLength(0);
  });
});
