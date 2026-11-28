/** @vitest-environment jsdom */
/**
 * UI-FEEDBACK/B: manager decisions made inside JobDetail child sections own the
 * same committed-receipt boundary as in-page commands. Each decision is checked
 * against the four read outcomes: fresh, failed canonical read, access loss and
 * a rejected mutation that must stay local and only refresh.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

/** Format a Date the way a `datetime-local` input reports its value. */
function localInputValue(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
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
  /**
   * The first canonical read after the mutation attempt fails. It applies to a
   * committed mutation and to a rejected one, because a rejected decision still
   * performs a canonical read that can fail.
   */
  readFailure?: ReadFailure;
  /** The first canonical read after a rejected decision (new truth). */
  failureRead?: () => JobCard;
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
    if (method === 'GET' && path === '/api/job-cards' && url.includes('customerId=')) {
      return json({
        items: [{
          id: 'job-2', type: 'GENERAL_TASK', status: 'NEW', version: 1,
          title: 'Yeni takip işi', priority: 'normal', dueDate: null,
          scheduledAt: null, scheduledEndsAt: null, engagementKind: null,
          createdAt: '2026-11-24T08:00:00.000Z', updatedAt: '2026-11-24T08:00:00.000Z',
          staffCompletedAt: null, customer: { id: 'c1', name: 'ABC Klinik' }, contact: null,
          assignee: { id: 'staff-1', name: 'Ayşe Personel' }, deliveryItemCount: 0, allowedCommands: [],
        }],
        total: 1, limit: 50, offset: 0,
      });
    }
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
      // A committed decision reads the new truth; a rejected one still reads the
      // canonical card. Either first read can fail, so the knob is not gated on
      // a successful mutation (a rejected decision must be able to test a 500).
      if (attempted && options.readFailure !== undefined && !failureServed) {
        failureServed = true;
        return json({ error: 'Sunucu hatası.' }, options.readFailure);
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

/**
 * A sold-time correction always answers `400 SALE_TIME_INVALID` (a definitive
 * rejection that writes nothing, so the canonical version does not move) and
 * serves the same unchanged sale details. The explicit reload is the only read
 * that can fail, which is what the two regression cases below vary.
 */
function saleTimeHarness(options: { readFailure?: ReadFailure } = {}) {
  const before = saleJob();
  const patchBodies: Array<Record<string, unknown>> = [];
  let detailGets = 0;
  let readFailureServed = false;
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = withoutSaleCapability(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.split('?')[0] ?? url;
    if (url.endsWith('/api/notifications/read-by-entity')) return json({});
    if (url.includes('/delivery-items')) return json({ items: [] });
    if (url.includes('/notes?')) return json(emptyPage);
    if (url.includes('/activity?')) return json({ ...emptyPage, limit: 50 });
    if (url.includes('/submission-lateness')) return json({ open: null });
    if (url.includes('/overdue-incidents')) return json(emptyPage);
    if (url.includes('/follow-ups')) return json(emptyPage);
    if (url.includes('/api/staff?')) return json([]);
    if (url.includes('/api/customers/') && url.includes('/contacts')) return json(emptyPage);
    if (method === 'GET' && path === '/api/job-cards' && url.includes('customerId=')) {
      return json({
        items: [{
          id: 'job-2', type: 'GENERAL_TASK', status: 'NEW', version: 1,
          title: 'Yeni takip işi', priority: 'normal', dueDate: null,
          scheduledAt: null, scheduledEndsAt: null, engagementKind: null,
          createdAt: '2026-11-24T08:00:00.000Z', updatedAt: '2026-11-24T08:00:00.000Z',
          staffCompletedAt: null, customer: { id: 'c1', name: 'ABC Klinik' }, contact: null,
          assignee: { id: 'staff-1', name: 'Ayşe Personel' }, deliveryItemCount: 0, allowedCommands: [],
        }],
        total: 1, limit: 50, offset: 0,
      });
    }
    if (method === 'PATCH' && path.endsWith(`/api/job-cards/${before.id}/sale-details`)) {
      patchBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return json({ error: 'Satış zamanı geçersiz.', code: 'SALE_TIME_INVALID' }, 400);
    }
    if (method === 'GET' && path.endsWith(`/api/job-cards/${before.id}/sale-details`)) {
      return json(saleDetailsBefore);
    }
    if (detailUrlMatches(url, before.id)) {
      detailGets += 1;
      if (patchBodies.length > 0 && options.readFailure !== undefined && !readFailureServed) {
        readFailureServed = true;
        return json({ error: 'Sunucu hatası.' }, options.readFailure);
      }
      return json(before);
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  return { before, fetch, patchBodies, detailGets: () => detailGets };
}

async function click(host: ParentNode, name: string) {
  const button = buttonByText(host, name);
  if (button === null) throw new Error(`Button not found: ${name}`);
  await act(async () => { button.click(); });
}

async function openRecoveryAndSelect(host: ParentNode, decisionId: string) {
  await click(host, 'Görevi çözüme ulaştır');
  await settle();
  const radio = host.querySelector<HTMLInputElement>(
    `input[name="manager-recovery-decision"][value="${decisionId}"]`,
  );
  if (radio === null) throw new Error(`Decision radio not found: ${decisionId}`);
  await act(async () => { radio.click(); });
  await settle();
}

type Decision = {
  name: string;
  receipt: string;
  feedbackTone?: 'confirmed' | 'info';
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
  /** Expected GET count on a rejected decision (defaults to 2 for auto-reload sections). */
  detailGetsAfterFailure?: number;
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
      await openRecoveryAndSelect(host, 'ACCEPT_PROPOSED_TIME');
      const form = host.querySelector<HTMLFormElement>('[data-manager-recovery-form="true"]');
      if (!form) throw new Error('Manager recovery drawer is missing');
      await act(async () => { form.requestSubmit(); });
      await settle();
    },
    localReceipt: '[data-assignment-offer-proposal-accepted="true"]',
    localError: '[data-recovery-submit-error="true"]',
    localErrorText: 'Personelin önerdiği zaman artık onaylanamıyor',
    lockedControl: '[data-manager-recovery-trigger="true"]',
    sectionGone: '[data-manager-recovery="true"]',
    section: '[data-manager-recovery="true"]',
    detailGetsAfterFailure: 1,
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
      await openRecoveryAndSelect(host, 'REOFFER');
      const form = host.querySelector<HTMLFormElement>('[data-manager-recovery-form="true"]');
      if (!form) throw new Error('Manager recovery drawer is missing');
      await act(async () => { form.requestSubmit(); });
      await settle();
    },
    localReceipt: '[data-assignment-offer-reoffered="true"]',
    localError: '[data-recovery-submit-error="true"]',
    localErrorText: 'Planlanan zaman aralığı atama için çok kısa.',
    failureRead: () => ({
      ...offerJob({
        assignmentOffer: openOffer({
          closeReason: 'ON_LEAVE', proposedScheduledAt: null, proposedScheduledEndsAt: null,
        }),
      }),
      version: 4,
    }),
    lockedControl: '[data-manager-recovery-trigger="true"]',
    sectionGone: '[data-manager-recovery="true"]',
    section: '[data-manager-recovery="true"]',
    detailGetsAfterFailure: 1,
  },
  {
    name: 'change request record-only closure',
    receipt: 'Öneri kayda alındı ve kapatıldı. İş bilgileri, planlanan zaman ve gecikme kaydı değişmedi.',
    feedbackTone: 'info',
    mutationPath: '/api/job-cards/job-1/change-requests/request-1/resolve',
    before: () => changeRequestJob(),
    after: () => ({ ...changeRequestJob(), version: 5, changeRequest: null }),
    success: () => json({
      jobCardId: 'job-1', changeRequestId: 'request-1', resolution: 'ACKNOWLEDGED_ONLY',
      resolvedAt: '2026-11-24T10:00:00.000Z',
    }),
    failure: () => json({
      error: 'Bu öneri zaten sonuçlandırılmış.', code: 'CHANGE_REQUEST_NOT_OPEN',
    }, 409),
    decide: async (host) => {
      await openRecoveryAndSelect(host, 'ACKNOWLEDGED_ONLY');
      const textarea = host.querySelector<HTMLTextAreaElement>('textarea[name="acknowledgeNote"]');
      if (!textarea) throw new Error('Acknowledge note textarea is missing');
      await act(async () => {
        setNativeValue(textarea, 'Personelin talebi incelendi, mevcut akış korunuyor.');
      });
      const form = host.querySelector<HTMLFormElement>('[data-manager-recovery-form="true"]');
      if (!form) throw new Error('Manager recovery drawer is missing');
      await act(async () => { form.requestSubmit(); });
      await settle();
    },
    localReceipt: '[data-change-request-resolved]',
    localError: '[data-recovery-submit-error="true"]',
    localErrorText: 'Bu öneri zaten sonuçlandırılmış.',
    lockedControl: '[data-manager-recovery-trigger="true"]',
    sectionGone: '[data-manager-recovery="true"]',
    section: '[data-manager-recovery="true"]',
    detailGetsAfterFailure: 1,
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

  it('groups a declined assignment under the unified manager recovery surface', async () => {
    const decision = decisions.find(({ name }) => name === 'assignment re-offer')!;
    const before = decision.before();
    const harness = makeHarness({ ...decision, before, succeed: true });
    await renderScreen(before, harness.fetch);

    const recovery = host.querySelector<HTMLElement>('section.job-recovery[data-manager-recovery="true"]');
    expect(recovery).not.toBeNull();
    const trigger = recovery?.querySelector<HTMLButtonElement>('[data-manager-recovery-trigger="true"]');
    expect(trigger?.textContent?.trim()).toBe('Görevi çözüme ulaştır');
    expect(recovery?.querySelectorAll('button')).toHaveLength(1);

    await act(async () => trigger?.click());
    await settle();
    expect(host.querySelector('[data-manager-recovery-form="true"]')).not.toBeNull();
    await click(host, 'Vazgeç');
    await settle();
    expect(host.querySelector('[data-manager-recovery-form="true"]')).toBeNull();
    expect(harness.mutationCalls()).toBe(0);
  });

  it('groups an open change request and keeps its completed decision on the page', async () => {
    const decision = decisions.find(({ name }) => name === 'change request record-only closure')!;
    const before = decision.before();
    const harness = makeHarness({ ...decision, before, succeed: true });
    await renderScreen(before, harness.fetch);

    const recovery = host.querySelector<HTMLElement>('section.job-recovery[data-manager-recovery="true"]');
    expect(recovery?.querySelector('[data-change-request="management"]')).not.toBeNull();
    await decision.decide(host);

    expect(host.querySelector('section.job-recovery')).toBeNull();
    expect(receiptRegions(decision.receipt)).toHaveLength(1);
    const [receipt] = receiptRegions(decision.receipt);
    const expectedClass = decision.feedbackTone === 'info' ? 'detail-feedback-info' : 'detail-feedback-confirmed';
    expect(receipt.classList.contains(expectedClass)).toBe(true);
    expect(receipt.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(harness.mutationCalls()).toBe(1);
  });

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
        expect(harness.detailGets()).toBe(decision.detailGetsAfterFailure ?? 2);
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
      const path = url.split('?')[0] ?? url;
      if (url.endsWith('/api/notifications/read-by-entity')) return json({});
      if (url.includes('/notes?')) return json(emptyPage);
      if (url.includes('/activity?')) return json({ ...emptyPage, limit: 50 });
      if (url.includes('/submission-lateness')) return json({ open: null });
      if (url.includes('/overdue-incidents')) return json(emptyPage);
      if (url.includes('/follow-ups')) return json(emptyPage);
      if (method === 'GET' && path === '/api/job-cards' && url.includes('customerId=')) {
        return json({
          items: [{
            id: 'job-2', type: 'GENERAL_TASK', status: 'NEW', version: 1,
            title: 'Yeni takip işi', priority: 'normal', dueDate: null,
            scheduledAt: null, scheduledEndsAt: null, engagementKind: null,
            createdAt: '2026-11-24T08:00:00.000Z', updatedAt: '2026-11-24T08:00:00.000Z',
            staffCompletedAt: null, customer: { id: 'c1', name: 'ABC Klinik' }, contact: null,
            assignee: { id: 'staff-1', name: 'Ayşe Personel' }, deliveryItemCount: 0, allowedCommands: [],
          }],
          total: 1, limit: 50, offset: 0,
        });
      }
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
    await openRecoveryAndSelect(host, 'ACKNOWLEDGED_ONLY');
    const textarea = host.querySelector<HTMLTextAreaElement>('textarea[name="acknowledgeNote"]')!;
    await act(async () => {
      setNativeValue(textarea, 'Talep incelendi, mevcut plan korunuyor.');
    });
    const form = host.querySelector('[data-manager-recovery-form="true"]') as HTMLFormElement | null;
    if (!form) throw new Error('Manager recovery drawer is missing');
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
        jobCardId: 'job-1', changeRequestId: 'request-1', resolution: 'ACKNOWLEDGED_ONLY',
        resolvedAt: '2026-11-24T10:00:00.000Z',
      }));
    });
    await settle();

    expect(mutationCalls).toBe(1);
    const receipt = 'Öneri kayda alındı ve kapatıldı. İş bilgileri, planlanan zaman ve gecikme kaydı değişmedi.';
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
    await openRecoveryAndSelect(host, 'ACCEPT_PROPOSED_TIME');
    const form = host.querySelector<HTMLFormElement>('[data-manager-recovery-form="true"]');
    await act(async () => { form!.requestSubmit(); });
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

    await openRecoveryAndSelect(host, 'REOFFER');
    await act(async () => {
      host.querySelector<HTMLFormElement>('[data-manager-recovery-form="true"]')!.requestSubmit();
    });
    await settle();
    const firstReceipt = host.querySelector<HTMLElement>('[data-job-detail-section="feedback"]');
    expect(firstReceipt?.textContent).toContain('Yeni atama teklifi açıldı; personelin yanıtı bekleniyor.');

    await openRecoveryAndSelect(host, 'REOFFER');
    await act(async () => {
      host.querySelector<HTMLFormElement>('[data-manager-recovery-form="true"]')!.requestSubmit();
    });
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
    await openRecoveryAndSelect(host, 'REOFFER');
    await act(async () => {
      host.querySelector<HTMLFormElement>('[data-manager-recovery-form="true"]')!.requestSubmit();
    });
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
    await openRecoveryAndSelect(host, 'REOFFER');
    await act(async () => {
      host.querySelector<HTMLFormElement>('[data-manager-recovery-form="true"]')!.requestSubmit();
    });
    await settle();

    expect(host.querySelector('[data-recovery-submit-error="true"]')?.textContent)
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
    await openRecoveryAndSelect(host, 'REJECT_CHANGE_REQUEST');
    const note = host.querySelector<HTMLTextAreaElement>('textarea[name="rejectNote"]');
    if (!note) throw new Error('Rejection note is missing');
    await act(async () => { setNativeValue(note, 'Teslim yeniden planlandı.'); });
    const form = host.querySelector('[data-manager-recovery-form="true"]') as HTMLFormElement | null;
    if (!form) throw new Error('Manager recovery drawer is missing');
    await act(async () => { form.requestSubmit(); });
    await settle();

    const receipt = 'Öneri reddedildi. İş bilgileri değişmedi.';
    const regions = receiptRegions(receipt);
    expect(regions).toHaveLength(1);
    const feedback = host.querySelector('[data-job-detail-section="feedback"]');
    expect(feedback).toBe(regions[0]);
    expect(feedback?.classList.contains('detail-feedback-info')).toBe(true);
    expect(feedback?.classList.contains('detail-feedback-confirmed')).toBe(false);
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
      readFailure: 500,
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

  /**
   * UI-FEEDBACK/B regression: a definitive `400 SALE_TIME_INVALID` rejected the
   * write, so the canonical version does not move. The explicit reload is still
   * a real reconciled read; only that read (not the version) may release the
   * lock, and it must keep the sold-time draft the manager typed.
   */
  async function startSaleTimeCorrection(
    before: JobCard,
    fetch: ReturnType<typeof vi.fn>,
    source?: FakeRealtimeEventSource,
  ) {
    await renderScreen(before, fetch, source);
    const soldInput = () => host.querySelector<HTMLInputElement>(
      '.sale-correction input[type="datetime-local"]',
    );
    if (soldInput() === null) throw new Error('Sale sold-time field is missing');
    const original = soldInput()!.value;
    const typed = new Date(original);
    typed.setMinutes(typed.getMinutes() + 30);
    const draft = localInputValue(typed);
    expect(draft).not.toBe(original);
    await act(async () => { setNativeValue(soldInput()!, draft); });
    await click(host, 'Satış bilgilerini kaydet');
    await settle();
    return { soldInput, draft };
  }

  it('unlocks the sale correction after a reconciled reload at the same version', async () => {
    const harness = saleTimeHarness();
    const { soldInput, draft } = await startSaleTimeCorrection(harness.before, harness.fetch);

    // The server rejected the change without writing, so the form is locked and
    // offers the canonical reload.
    expect(harness.patchBodies).toHaveLength(1);
    expect(harness.patchBodies[0]?.soldAt).toBe(new Date(draft).toISOString());
    expect(host.querySelector<HTMLFieldSetElement>('.sale-correction fieldset')?.disabled).toBe(true);
    expect(buttonByText(host, 'Güncel kaydı yükle ve düzeltmeye devam et')).not.toBeNull();

    await click(host, 'Güncel kaydı yükle ve düzeltmeye devam et');
    await settle();

    // A 200 at the same version is reconciled truth: unlock, keep the draft.
    expect(harness.detailGets()).toBe(2);
    expect(host.querySelector<HTMLFieldSetElement>('.sale-correction fieldset')?.disabled).toBe(false);
    expect(buttonByText(host, 'Güncel kaydı yükle ve düzeltmeye devam et')).toBeNull();
    expect(soldInput()?.value).toBe(draft);
    expect(receiptRegions('Satış kaydı güncellendi.')).toHaveLength(0);
  });

  it('keeps the sale correction locked with its draft when the reload read fails', async () => {
    const harness = saleTimeHarness({ readFailure: 500 });
    const { soldInput, draft } = await startSaleTimeCorrection(harness.before, harness.fetch);

    await click(host, 'Güncel kaydı yükle ve düzeltmeye devam et');
    await settle();

    // A failed read is not canonical truth: the lock and the draft stay.
    expect(harness.detailGets()).toBe(2);
    expect(host.querySelector<HTMLFieldSetElement>('.sale-correction fieldset')?.disabled).toBe(true);
    expect(buttonByText(host, 'Güncel kaydı yükle ve düzeltmeye devam et')).not.toBeNull();
    expect(soldInput()?.value).toBe(draft);
    expect(receiptRegions('Satış kaydı güncellendi.')).toHaveLength(0);
  });

  /**
   * UI-FEEDBACK/B regression: two managers grant early start at once. The second
   * one loses the version race, and the refreshed record already carries the
   * winner's authorization. Both facts belong on screen, with no page receipt.
   */
  it('shows the winning authorization and the losing manager rejection together', async () => {
    const before = earlyStartJob();
    const harness = makeHarness({
      before, after: () => before, mutationPath: '/api/job-cards/job-1/early-start-authorization',
      success: () => json({
        jobCardId: 'job-1', authorizationId: 'auth-1', grantedAt: '2026-11-24T10:00:00.000Z',
      }),
      failure: () => json({
        error: 'İş başka bir işlemle güncellendi.', code: 'VERSION_CONFLICT',
      }, 409),
      succeed: false,
      failureRead: () => ({
        ...earlyStartJob(),
        version: 5,
        earlyStartAuthorization: {
          grantedAt: '2026-11-24T10:05:00.000Z',
          grantedBy: { id: 'manager-2', name: 'Zeynep Yönetici' },
        },
      }),
    });
    await renderScreen(before, harness.fetch);
    await click(host, 'Erken başlamaya izin ver');
    await click(host, 'Erken başlama iznini kaydet');
    await settle();

    const section = host.querySelector('[data-early-start-authorization="authorized"]');
    expect(section).not.toBeNull();
    // The winner's authorization is shown...
    expect(section?.querySelector('[role="status"]')?.textContent).toContain('Erken başlama izni:');
    expect(section?.querySelector('[role="status"]')?.textContent).toContain('Zeynep Yönetici');
    // ...next to this manager's own rejection explanation.
    expect(section?.querySelector('[role="alert"]')?.textContent)
      .toContain('İş başka bir işlemle güncellendi.');
    expect(receiptRegions('Erken başlama izni kaydedildi.')).toHaveLength(0);
    expect(host.querySelector('[data-job-detail-section="feedback"]')).toBeNull();
    expect(harness.mutationCalls()).toBe(1);
    expect(harness.detailGets()).toBe(2);
  });

  /**
   * UI-FEEDBACK/B regression: a realtime read that started before a child
   * decision must not decide the screen even when it ends in 403. The decision
   * already committed and a newer 200 read replaced it; the late access loss is
   * stale and cannot tear the newer record (or its receipt) down.
   */
  it('an older realtime read that loses access cannot end the newer committed screen', async () => {
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
    let detailGets = 0;
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
        detailGets += 1;
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
    await openRecoveryAndSelect(host, 'REOFFER');
    await act(async () => {
      host.querySelector<HTMLFormElement>('[data-manager-recovery-form="true"]')!.requestSubmit();
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

    // The pre-decision realtime read finishes last without access.
    await act(async () => {
      releaseHeld(json({ error: 'Bu işe erişim yetkiniz yok.', code: 'FORBIDDEN' }, 403));
    });
    await settle();
    await settle();

    // The newer record and its single receipt survive; no access-lost screen.
    expect(detailGets).toBeGreaterThanOrEqual(3);
    expect(host.querySelector('[data-assignment-offer]')).toBeNull();
    expect(host.querySelector('[data-job-detail-committed-refresh="true"]')).toBeNull();
    expect(host.textContent).not.toContain('artık erişilemiyor');
    expect(host.textContent).not.toContain('Bu işe erişim yetkiniz yok.');
    expect(receiptRegions('Yeni atama teklifi açıldı; personelin yanıtı bekleniyor.')).toHaveLength(1);
  });

  /**
   * UI-FEEDBACK/B regression (deferred access loss after a committed child
   * decision): a rejected early-start grant holds its page reload. A successful
   * re-offer then commits, its own post-commit read fails with 500, and the
   * held read finally answers 403. `settleChildCommit` / the deferred-drain
   * timer must issue exactly one recheck GET and settle the access answer.
   */
  type ChildAccessOrder = 'held-first' | 'held-last';

  function deferredChildDecisionAccessHarness(order: ChildAccessOrder, recheck: () => Response) {
    const before = offerJob({
      scheduledAt: '2030-06-10T09:00:00.000Z',
      scheduledEndsAt: '2030-06-10T09:30:00.000Z',
      assignmentOffer: openOffer({
        closeReason: 'ON_LEAVE', proposedScheduledAt: null, proposedScheduledEndsAt: null,
      }),
    });
    let detailGets = 0;
    let grantPosts = 0;
    let reofferPosts = 0;
    let releaseReload: ((response: Response) => void) | null = null;
    let releasePostCommit: ((response: Response) => void) | null = null;
    let releaseRecheck: ((response: Response) => void) | null = null;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = withoutSaleCapability(String(input));
      const method = (init?.method ?? 'GET').toUpperCase();
      const path = url.split('?')[0] ?? url;
      if (url.endsWith('/api/notifications/read-by-entity')) return json({});
      if (url.includes('/delivery-items')) return json({ items: [] });
      if (url.includes('/notes?')) return json(emptyPage);
      if (url.includes('/activity?')) return json({ ...emptyPage, limit: 50 });
      if (url.includes('/submission-lateness')) return json({ open: null });
      if (url.includes('/overdue-incidents')) return json(emptyPage);
      if (url.includes('/follow-ups')) return json(emptyPage);
      if (method === 'POST' && path.endsWith('/api/job-cards/job-1/early-start-authorization')) {
        grantPosts += 1;
        return json({
          error: 'Bu iş için geçerli bir erken başlama izni zaten var.',
          code: 'EARLY_START_ALREADY_AUTHORIZED',
        }, 409);
      }
      if (method === 'POST' && path.endsWith('/api/job-cards/job-1/assignment-offers/reoffer')) {
        reofferPosts += 1;
        return json({
          jobCardId: 'job-1', offerId: 'offer-2',
          acceptanceDueAt: '2030-06-09T12:00:00.000Z', urgentReason: 'START_PASSED',
        }, 201);
      }
      if (method === 'GET' && detailUrlMatches(url, before.id)) {
        detailGets += 1;
        if (detailGets === 1) return json(before);
        if (detailGets === 2) {
          // The rejected grant's serialized reload.
          return new Promise<Response>((resolve) => { releaseReload = resolve; });
        }
        if (detailGets === 3) {
          // The re-offer's post-commit read. In the "held-first" order it is
          // held so the older 403 can land before it; otherwise it fails 500.
          if (order === 'held-first') {
            return new Promise<Response>((resolve) => { releasePostCommit = resolve; });
          }
          return json({ error: 'Sunucu hatası.' }, 500);
        }
        if (detailGets === 4) {
          return new Promise<Response>((resolve) => { releaseRecheck = resolve; });
        }
        return json(before);
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    return {
      before, fetch,
      detailGets: () => detailGets,
      grantPosts: () => grantPosts,
      reofferPosts: () => reofferPosts,
      reloadHeld: () => releaseReload !== null,
      postCommitHeld: () => releasePostCommit !== null,
      recheckHeld: () => releaseRecheck !== null,
      releaseReload: (response: Response) => {
        if (releaseReload === null) throw new Error('Deferred reload is not held');
        releaseReload(response);
      },
      releasePostCommit: (response: Response) => {
        if (releasePostCommit === null) throw new Error('Post-commit read is not held');
        releasePostCommit(response);
      },
      releaseRecheck: (response: Response) => {
        if (releaseRecheck === null) throw new Error('Access recheck is not held');
        releaseRecheck(response);
      },
    };
  }

  async function startChildDecisionAccessCase(
    order: ChildAccessOrder,
    recheck: () => Response,
  ) {
    const harness = deferredChildDecisionAccessHarness(order, recheck);
    await renderScreen(harness.before, harness.fetch);

    await click(host, 'Erken başlamaya izin ver');
    await click(host, 'Erken başlama iznini kaydet');
    await settle();
    expect(harness.grantPosts()).toBe(1);
    expect(harness.reloadHeld()).toBe(true);
    expect(harness.detailGets()).toBe(2);

    await openRecoveryAndSelect(host, 'REOFFER');
    await act(async () => {
      host.querySelector<HTMLFormElement>('[data-manager-recovery-form="true"]')!.requestSubmit();
    });
    await settle();
    expect(harness.reofferPosts()).toBe(1);

    if (order === 'held-last') {
      // The post-commit read 500 already owns the committed notice.
      expect(harness.postCommitHeld()).toBe(false);
      expect(host.querySelector('[data-job-detail-committed-refresh="true"]')?.textContent)
        .toContain('Yeni atama teklifi açıldı; personelin yanıtı bekleniyor.');
      await act(async () => {
        harness.releaseReload(json({
          error: 'Bu işe erişim yetkiniz yok.', code: 'FORBIDDEN',
        }, 403));
      });
      await settle();
    } else {
      // The post-commit read is still open when the older 403 lands.
      expect(harness.postCommitHeld()).toBe(true);
      await act(async () => {
        harness.releaseReload(json({
          error: 'Bu işe erişim yetkiniz yok.', code: 'FORBIDDEN',
        }, 403));
      });
      await settle();
      expect(harness.recheckHeld()).toBe(true);
      await act(async () => {
        harness.releasePostCommit(json({ error: 'Sunucu hatası.' }, 500));
      });
      await settle();
    }

    expect(harness.recheckHeld()).toBe(true);
    await act(async () => { harness.releaseRecheck(recheck()); });
    await settle();
    expect(harness.detailGets()).toBe(4);
    return harness;
  }

  it('settles a deferred child access loss held before the post-commit read and becomes terminal on 403', async () => {
    await startChildDecisionAccessCase('held-first', () => json({
      error: 'Bu işe erişim yetkiniz yok.', code: 'FORBIDDEN',
    }, 403));

    expect(host.textContent).toContain('İşlem kaydedildi. İşin güncel kaydına artık erişilemiyor.');
    expect(host.querySelector('[data-job-detail-committed-refresh="true"]')).toBeNull();
    expect(host.querySelector('main[data-job-detail="true"]')).toBeNull();
  });

  it('settles a deferred child access loss held before the post-commit read and stays ready on 200', async () => {
    await startChildDecisionAccessCase('held-first', () => json(offerJob({
      scheduledAt: '2030-06-10T09:00:00.000Z',
      scheduledEndsAt: '2030-06-10T09:30:00.000Z',
      assignmentOffer: openOffer({
        closeReason: 'ON_LEAVE', proposedScheduledAt: null, proposedScheduledEndsAt: null,
      }),
    })));

    expect(host.querySelector('main[data-job-detail="true"]')).not.toBeNull();
    expect(host.querySelector('[data-job-detail-committed-refresh="true"]')).toBeNull();
    expect(host.querySelector('[data-job-detail-section="feedback"]')?.textContent)
      .toContain('Yeni atama teklifi açıldı; personelin yanıtı bekleniyor.');
  });

  it('settles a deferred child access loss held after the post-commit read and becomes terminal on 403', async () => {
    await startChildDecisionAccessCase('held-last', () => json({
      error: 'Bu işe erişim yetkiniz yok.', code: 'FORBIDDEN',
    }, 403));

    expect(host.textContent).toContain('İşlem kaydedildi. İşin güncel kaydına artık erişilemiyor.');
    expect(host.querySelector('[data-job-detail-committed-refresh="true"]')).toBeNull();
    expect(host.querySelector('main[data-job-detail="true"]')).toBeNull();
  });

  it('settles a deferred child access loss held after the post-commit read and stays ready on 200', async () => {
    await startChildDecisionAccessCase('held-last', () => json(offerJob({
      scheduledAt: '2030-06-10T09:00:00.000Z',
      scheduledEndsAt: '2030-06-10T09:30:00.000Z',
      assignmentOffer: openOffer({
        closeReason: 'ON_LEAVE', proposedScheduledAt: null, proposedScheduledEndsAt: null,
      }),
    })));

    expect(host.querySelector('main[data-job-detail="true"]')).not.toBeNull();
    expect(host.querySelector('[data-job-detail-committed-refresh="true"]')).toBeNull();
    expect(host.querySelector('[data-job-detail-section="feedback"]')?.textContent)
      .toContain('Yeni atama teklifi açıldı; personelin yanıtı bekleniyor.');
  });

  /**
   * UI-FEEDBACK/B regression (terminal access loss vs older reads): a child
   * decision's post-commit read is still in flight when an older 403/404
   * eventually produces a terminal access-lost screen through the recheck.
   * The late post-commit 200 must not reopen the record or resurrect a receipt.
   */
  function terminalAfterRecheckHarness(status: 403 | 404) {
    const before = offerJob({
      scheduledAt: '2030-06-10T09:00:00.000Z',
      scheduledEndsAt: '2030-06-10T09:30:00.000Z',
      assignmentOffer: openOffer({
        closeReason: 'ON_LEAVE', proposedScheduledAt: null, proposedScheduledEndsAt: null,
      }),
    });
    const error = status === 403
      ? { error: 'Bu işe erişim yetkiniz yok.', code: 'FORBIDDEN' }
      : { error: 'İş bulunamadı.', code: 'JOB_CARD_NOT_FOUND' };
    let detailGets = 0;
    let grantPosts = 0;
    let reofferPosts = 0;
    let releaseOld: ((response: Response) => void) | null = null;
    let releasePostCommit: ((response: Response) => void) | null = null;
    let releaseRecheck: ((response: Response) => void) | null = null;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = withoutSaleCapability(String(input));
      const method = (init?.method ?? 'GET').toUpperCase();
      const path = url.split('?')[0] ?? url;
      if (url.endsWith('/api/notifications/read-by-entity')) return json({});
      if (url.includes('/delivery-items')) return json({ items: [] });
      if (url.includes('/notes?')) return json(emptyPage);
      if (url.includes('/activity?')) return json({ ...emptyPage, limit: 50 });
      if (url.includes('/submission-lateness')) return json({ open: null });
      if (url.includes('/overdue-incidents')) return json(emptyPage);
      if (url.includes('/follow-ups')) return json(emptyPage);
      if (method === 'POST' && path.endsWith('/api/job-cards/job-1/early-start-authorization')) {
        grantPosts += 1;
        return json({
          error: 'Bu iş için geçerli bir erken başlama izni zaten var.',
          code: 'EARLY_START_ALREADY_AUTHORIZED',
        }, 409);
      }
      if (method === 'POST' && path.endsWith('/api/job-cards/job-1/assignment-offers/reoffer')) {
        reofferPosts += 1;
        return json({
          jobCardId: 'job-1', offerId: 'offer-2',
          acceptanceDueAt: '2030-06-09T12:00:00.000Z', urgentReason: 'START_PASSED',
        }, 201);
      }
      if (method === 'GET' && detailUrlMatches(url, before.id)) {
        detailGets += 1;
        if (detailGets === 1) return json(before);
        if (detailGets === 2) {
          // The older early-start reload.
          return new Promise<Response>((resolve) => { releaseOld = resolve; });
        }
        if (detailGets === 3) {
          // The re-offer's post-commit read, held until after the terminal.
          return new Promise<Response>((resolve) => { releasePostCommit = resolve; });
        }
        if (detailGets === 4) {
          return new Promise<Response>((resolve) => { releaseRecheck = resolve; });
        }
        return json(before);
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    return {
      before, fetch, error,
      detailGets: () => detailGets,
      grantPosts: () => grantPosts,
      reofferPosts: () => reofferPosts,
      oldHeld: () => releaseOld !== null,
      postCommitHeld: () => releasePostCommit !== null,
      recheckHeld: () => releaseRecheck !== null,
      releaseOld: (response: Response) => {
        if (releaseOld === null) throw new Error('Older read is not held');
        releaseOld(response);
      },
      releasePostCommit: (response: Response) => {
        if (releasePostCommit === null) throw new Error('Post-commit read is not held');
        releasePostCommit(response);
      },
      releaseRecheck: (response: Response) => {
        if (releaseRecheck === null) throw new Error('Access recheck is not held');
        releaseRecheck(response);
      },
    };
  }

  it.each([403, 404] as const)(
    'keeps the access-lost state when an older 200 arrives after a terminal %s recheck',
    async (status) => {
      const harness = terminalAfterRecheckHarness(status);
      await renderScreen(harness.before, harness.fetch);
      await click(host, 'Erken başlamaya izin ver');
      await click(host, 'Erken başlama iznini kaydet');
      await settle();
      expect(harness.oldHeld()).toBe(true);

      await openRecoveryAndSelect(host, 'REOFFER');
      await act(async () => {
        host.querySelector<HTMLFormElement>('[data-manager-recovery-form="true"]')!.requestSubmit();
      });
      await settle();
      expect(harness.postCommitHeld()).toBe(true);

      // The older read lands first and schedules the serialized recheck.
      await act(async () => {
        harness.releaseOld(json({
          error: 'Bu işe erişim yetkiniz yok.', code: 'FORBIDDEN',
        }, 403));
      });
      await settle();
      expect(harness.recheckHeld()).toBe(true);

      // The recheck is terminal; only then does the held post-commit read 200.
      await act(async () => { harness.releaseRecheck(json(harness.error, status)); });
      await settle();
      expect(host.textContent).toContain(harness.error.error);
      expect(host.querySelector('main[data-job-detail="true"]')).toBeNull();

      await act(async () => {
        harness.releasePostCommit(json({ ...harness.before, version: 4 }));
      });
      await settle();

      expect(harness.detailGets()).toBe(4);
      expect(host.textContent).toContain(harness.error.error);
      expect(host.querySelector('main[data-job-detail="true"]')).toBeNull();
      expect(receiptRegions('Yeni atama teklifi açıldı; personelin yanıtı bekleniyor.')).toHaveLength(0);
    },
  );

  /**
   * UI-FEEDBACK/B regression (older 403 after a reconciled read): completion
   * order cannot prove which read is newer, so a late deferred 403 schedules
   * exactly one recheck GET. When that read proves access, no stale/terminal
   * state appears and the receipt is announced exactly once.
   */
  it('rechecks a superseded older 403 once and keeps the record and receipt when access is proven', async () => {
    const before = offerJob({
      scheduledAt: '2030-06-10T09:00:00.000Z',
      scheduledEndsAt: '2030-06-10T09:30:00.000Z',
      assignmentOffer: openOffer({
        closeReason: 'ON_LEAVE', proposedScheduledAt: null, proposedScheduledEndsAt: null,
      }),
    });
    let detailGets = 0;
    let releaseOld: ((response: Response) => void) | null = null;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = withoutSaleCapability(String(input));
      const method = (init?.method ?? 'GET').toUpperCase();
      const path = url.split('?')[0] ?? url;
      if (url.endsWith('/api/notifications/read-by-entity')) return json({});
      if (url.includes('/delivery-items')) return json({ items: [] });
      if (url.includes('/notes?')) return json(emptyPage);
      if (url.includes('/activity?')) return json({ ...emptyPage, limit: 50 });
      if (url.includes('/submission-lateness')) return json({ open: null });
      if (url.includes('/overdue-incidents')) return json(emptyPage);
      if (url.includes('/follow-ups')) return json(emptyPage);
      if (method === 'POST' && path.endsWith('/api/job-cards/job-1/early-start-authorization')) {
        return json({
          error: 'Bu iş için geçerli bir erken başlama izni zaten var.',
          code: 'EARLY_START_ALREADY_AUTHORIZED',
        }, 409);
      }
      if (method === 'POST' && path.endsWith('/api/job-cards/job-1/assignment-offers/reoffer')) {
        return json({
          jobCardId: 'job-1', offerId: 'offer-2',
          acceptanceDueAt: '2030-06-09T12:00:00.000Z', urgentReason: 'START_PASSED',
        }, 201);
      }
      if (method === 'GET' && detailUrlMatches(url, before.id)) {
        detailGets += 1;
        if (detailGets === 1) return json(before);
        if (detailGets === 2) {
          return new Promise<Response>((resolve) => { releaseOld = resolve; });
        }
        if (detailGets === 3) return json({ ...before, version: 4 });
        // Completion order cannot prove which read is newer, so the deferred
        // 403 is rechecked once; access is still valid here.
        return json({ ...before, version: 4 });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    await renderScreen(before, fetch);
    await click(host, 'Erken başlamaya izin ver');
    await click(host, 'Erken başlama iznini kaydet');
    await settle();
    expect(releaseOld).not.toBeNull();

    await openRecoveryAndSelect(host, 'REOFFER');
    await act(async () => {
      host.querySelector<HTMLFormElement>('[data-manager-recovery-form="true"]')!.requestSubmit();
    });
    await settle();

    // The post-commit 200 already reconciled; the older 403 still gets one safe recheck.
    await act(async () => {
      releaseOld!(json({
        error: 'Bu işe erişim yetkiniz yok.', code: 'FORBIDDEN',
      }, 403));
    });
    await settle();
    await settle();

    expect(detailGets).toBe(4);
    expect(host.querySelector('main[data-job-detail="true"]')).not.toBeNull();
    expect(host.textContent).not.toContain('Bu iş başka bir oturumda güncellendi.');
    expect(host.textContent).not.toContain('İş yüklenemedi');
    expect(receiptRegions('Yeni atama teklifi açıldı; personelin yanıtı bekleniyor.')).toHaveLength(1);
    expect(host.querySelector('[data-job-detail-section="feedback"]')?.textContent)
      .toContain('Yeni atama teklifi açıldı; personelin yanıtı bekleniyor.');
  });

  /**
   * UI-FEEDBACK/B regression (deferred access loss): an early-start grant is
   * rejected, so its page-owned reload is in flight. A record edit then starts
   * and defers that read's 403 behind the mutation epoch. When the edit ends
   * (a definitive 400, no canonical read), the deferred access answer must be
   * rechecked through the serialized drain.
   */
  function deferredEarlyStartAccessHarness(recheck: () => Response) {
    const before = earlyStartJob();
    const staffProfiles = [{
      id: 'profile-staff-1',
      user: {
        id: 'staff-1', organizationId: 'org-1', name: 'Ayşe Personel', email: 'a@x',
        role: 'STAFF', mustChangePassword: false, isActive: true, version: 1,
        lastLoginAt: null, createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      title: null, phone: null, region: null, managerUserId: null, managerName: null,
      version: 1,
      counters: {
        open: 0, waitingApproval: 0, revisionRequested: 0,
        completedThisMonth: 0, overdue: 0,
      },
    }];
    let detailGets = 0;
    let grantPosts = 0;
    let patchCalls = 0;
    let releaseReload: ((response: Response) => void) | null = null;
    let releasePatch: ((response: Response) => void) | null = null;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = withoutSaleCapability(String(input));
      const method = (init?.method ?? 'GET').toUpperCase();
      const path = url.split('?')[0] ?? url;
      if (url.endsWith('/api/notifications/read-by-entity')) return json({});
      if (url.includes('/delivery-items')) return json({ items: [] });
      if (url.includes('/notes?')) return json(emptyPage);
      if (url.includes('/activity?')) return json({ ...emptyPage, limit: 50 });
      if (url.includes('/submission-lateness')) return json({ open: null });
      if (url.includes('/overdue-incidents')) return json(emptyPage);
      if (url.includes('/follow-ups')) return json(emptyPage);
      if (url.includes('/api/staff?')) return json(staffProfiles);
      if (method === 'POST' && path.endsWith('/api/job-cards/job-1/early-start-authorization')) {
        grantPosts += 1;
        return json({
          error: 'Bu iş için geçerli bir erken başlama izni zaten var.',
          code: 'EARLY_START_ALREADY_AUTHORIZED',
        }, 409);
      }
      if (method === 'PATCH' && path.endsWith('/api/job-cards/job-1')) {
        patchCalls += 1;
        return new Promise<Response>((resolve) => { releasePatch = resolve; });
      }
      if (method === 'GET' && detailUrlMatches(url, before.id)) {
        detailGets += 1;
        if (grantPosts > 0 && detailGets === 2) {
          // The rejected grant's serialized reload: held until the edit starts.
          return new Promise<Response>((resolve) => { releaseReload = resolve; });
        }
        if (grantPosts > 0 && detailGets >= 3) return recheck();
        return json(before);
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    return {
      before, fetch,
      detailGets: () => detailGets,
      grantPosts: () => grantPosts,
      patchCalls: () => patchCalls,
      reloadHeld: () => releaseReload !== null,
      patchHeld: () => releasePatch !== null,
      releaseReload: (response: Response) => {
        if (releaseReload === null) throw new Error('Deferred reload is not held');
        releaseReload(response);
      },
      releasePatch: (response: Response) => {
        if (releasePatch === null) throw new Error('Record edit is not held');
        releasePatch(response);
      },
    };
  }

  async function startDeferredAccessCase(recheck: () => Response) {
    const harness = deferredEarlyStartAccessHarness(recheck);
    await renderScreen(harness.before, harness.fetch);
    await click(host, 'Erken başlamaya izin ver');
    await click(host, 'Erken başlama iznini kaydet');
    await settle();
    expect(harness.grantPosts()).toBe(1);
    expect(harness.reloadHeld()).toBe(true);
    expect(harness.detailGets()).toBe(2);

    // A record edit starts while the grant reload is still held.
    await click(host, 'Sorumlu personeli değiştir');
    await settle();
    const select = host.querySelector<HTMLSelectElement>('#delivery-edit-assignee');
    expect(select).not.toBeNull();
    expect(select?.disabled).toBe(false);
    await click(host, 'Değişiklikleri kaydet');
    expect(harness.patchHeld()).toBe(true);
    expect(harness.patchCalls()).toBe(1);

    // The held read answers 403 but is deferred by the edit's newer epoch.
    await act(async () => {
      harness.releaseReload(json({
        error: 'Bu işe erişim yetkiniz yok.', code: 'FORBIDDEN',
      }, 403));
    });
    await settle();
    expect(harness.detailGets()).toBe(2);
    expect(host.textContent).not.toContain('İş yüklenemedi');

    // The definitive 400 ends the edit without a canonical read; the deferred
    // access answer is rechecked now.
    await act(async () => {
      harness.releasePatch(json({
        error: 'Geçersiz atama.', code: 'VALIDATION_ERROR',
      }, 400));
    });
    await settle();
    expect(harness.detailGets()).toBe(3);
    expect(harness.patchCalls()).toBe(1);
    return harness;
  }

  it('rechecks deferred early-start access loss after the record edit and becomes terminal on 403', async () => {
    await startDeferredAccessCase(() => json({
      error: 'Bu işe erişim yetkiniz yok.', code: 'FORBIDDEN',
    }, 403));

    expect(host.textContent).toContain('İş yüklenemedi');
    expect(host.textContent).toContain('Bu işe erişim yetkiniz yok.');
    expect(host.querySelector('main[data-job-detail="true"]')).toBeNull();
  });

  it('rechecks deferred early-start access loss after the record edit and stays ready on 200', async () => {
    const harness = await startDeferredAccessCase(() => json(earlyStartJob()));

    expect(host.querySelector('main[data-job-detail="true"]')).not.toBeNull();
    expect(host.textContent).not.toContain('İş yüklenemedi');
    expect(host.textContent).toContain('Geçersiz atama.');
    expect(harness.patchCalls()).toBe(1);
  });

  it('rechecks a deferred early-start access loss when the edit ended before the old read returned', async () => {
    const harness = deferredEarlyStartAccessHarness(() => json({
      error: 'Bu işe erişim yetkiniz yok.', code: 'FORBIDDEN',
    }, 403));
    await renderScreen(harness.before, harness.fetch);
    await click(host, 'Erken başlamaya izin ver');
    await click(host, 'Erken başlama iznini kaydet');
    await settle();
    expect(harness.reloadHeld()).toBe(true);

    // The record edit starts and ends with a definitive 400 while the old
    // reload is still held. Nobody owns the mutation when the 403 arrives.
    await click(host, 'Sorumlu personeli değiştir');
    await settle();
    await click(host, 'Değişiklikleri kaydet');
    expect(harness.patchHeld()).toBe(true);
    await act(async () => {
      harness.releasePatch(json({
        error: 'Geçersiz atama.', code: 'VALIDATION_ERROR',
      }, 400));
    });
    await settle();
    expect(harness.detailGets()).toBe(2);

    // The late 403 must still trigger the immediate serialized recheck.
    await act(async () => {
      harness.releaseReload(json({
        error: 'Bu işe erişim yetkiniz yok.', code: 'FORBIDDEN',
      }, 403));
    });
    await settle();

    expect(harness.detailGets()).toBe(3);
    expect(harness.patchCalls()).toBe(1);
    expect(host.textContent).toContain('İş yüklenemedi');
    expect(host.textContent).toContain('Bu işe erişim yetkiniz yok.');
    expect(host.querySelector('main[data-job-detail="true"]')).toBeNull();
  });

  /**
   * UI-FEEDBACK/B regression (reconciled sale unlock): the first reload round
   * may already carry a newer version while a realtime invalidation forces a
   * second round. Only the fully reconciled chain may unlock; an intermediate
   * newer version followed by a failed read must keep the lock and the draft.
   */
  function saleIntermediateReloadHarness(secondRead: 200 | 500) {
    const before = saleJob();
    const source = new FakeRealtimeEventSource();
    let detailGets = 0;
    let canonicalVersion = 4;
    let releaseFirstReload: ((response: Response) => void) | null = null;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = withoutSaleCapability(String(input));
      const method = (init?.method ?? 'GET').toUpperCase();
      const path = url.split('?')[0] ?? url;
      if (url.endsWith('/api/notifications/read-by-entity')) return json({});
      if (url.includes('/notes?')) return json(emptyPage);
      if (url.includes('/activity?')) return json({ ...emptyPage, limit: 50 });
      if (url.includes('/submission-lateness')) return json({ open: null });
      if (url.includes('/overdue-incidents')) return json(emptyPage);
      if (url.includes('/follow-ups')) return json(emptyPage);
      if (url.includes('/api/customers/') && url.includes('/contacts')) return json(emptyPage);
      if (method === 'PATCH' && path.endsWith('/api/job-cards/job-1/sale-details')) {
        return json({ error: 'Satış zamanı geçersiz.', code: 'SALE_TIME_INVALID' }, 400);
      }
      if (method === 'GET' && path.endsWith('/api/job-cards/job-1/sale-details')) {
        return json({ ...saleDetailsBefore, jobCardVersion: canonicalVersion });
      }
      if (method === 'GET' && detailUrlMatches(url, before.id)) {
        detailGets += 1;
        if (detailGets === 1) return json(before);
        if (detailGets === 2) {
          return new Promise<Response>((resolve) => { releaseFirstReload = resolve; });
        }
        if (secondRead === 500) return json({ error: 'Sunucu hatası.' }, 500);
        return json({ ...before, version: canonicalVersion });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    return {
      before, fetch, source,
      detailGets: () => detailGets,
      firstReloadHeld: () => releaseFirstReload !== null,
      releaseFirstReload: (response: Response) => {
        if (releaseFirstReload === null) throw new Error('First reload is not held');
        releaseFirstReload(response);
      },
      advanceCanonicalVersion: () => { canonicalVersion = 5; },
    };
  }

  it('keeps the sale correction locked and drafted when an intermediate newer round is followed by a failed read', async () => {
    const harness = saleIntermediateReloadHarness(500);
    const { soldInput, draft } = await startSaleTimeCorrection(harness.before, harness.fetch, harness.source);
    await click(host, 'Güncel kaydı yükle ve düzeltmeye devam et');
    expect(harness.firstReloadHeld()).toBe(true);

    await act(async () => {
      harness.source.emitJobUpdate('job-1', '1');
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await act(async () => {
      harness.advanceCanonicalVersion();
      harness.releaseFirstReload(json({ ...harness.before, version: 5 }));
    });
    await settle();

    expect(harness.detailGets()).toBe(3);
    expect(host.querySelector<HTMLFieldSetElement>('.sale-correction fieldset')?.disabled).toBe(true);
    expect(buttonByText(host, 'Güncel kaydı yükle ve düzeltmeye devam et')).not.toBeNull();
    expect(soldInput()?.value).toBe(draft);
    expect(receiptRegions('Satış kaydı güncellendi.')).toHaveLength(0);
  });

  it('unlocks the sale correction with its draft when both reload rounds reconcile', async () => {
    const harness = saleIntermediateReloadHarness(200);
    const { soldInput, draft } = await startSaleTimeCorrection(harness.before, harness.fetch, harness.source);
    await click(host, 'Güncel kaydı yükle ve düzeltmeye devam et');
    expect(harness.firstReloadHeld()).toBe(true);

    await act(async () => {
      harness.source.emitJobUpdate('job-1', '1');
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await act(async () => {
      harness.advanceCanonicalVersion();
      harness.releaseFirstReload(json({ ...harness.before, version: 5 }));
    });
    await settle();

    expect(harness.detailGets()).toBe(3);
    expect(host.querySelector<HTMLFieldSetElement>('.sale-correction fieldset')?.disabled).toBe(false);
    expect(buttonByText(host, 'Güncel kaydı yükle ve düzeltmeye devam et')).toBeNull();
    expect(soldInput()?.value).toBe(draft);
    expect(receiptRegions('Satış kaydı güncellendi.')).toHaveLength(0);
  });

  /**
   * UI-FEEDBACK/B regression (sale background reads): a definitive conflict
   * leaves the form locked. Background realtime reads, even one that applies a
   * newer canonical version, must never unlock it; only the explicit reload
   * with a reconciled read unlocks, and then applies the base canonical reset.
   */
  function saleQuantityConflictHarness(options: { backgroundReads: boolean }) {
    const before = saleJob();
    const source = new FakeRealtimeEventSource();
    let detailGets = 0;
    let canonicalVersion = 4;
    let patchCalls = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = withoutSaleCapability(String(input));
      const method = (init?.method ?? 'GET').toUpperCase();
      const path = url.split('?')[0] ?? url;
      if (url.endsWith('/api/notifications/read-by-entity')) return json({});
      if (url.includes('/notes?')) return json(emptyPage);
      if (url.includes('/activity?')) return json({ ...emptyPage, limit: 50 });
      if (url.includes('/submission-lateness')) return json({ open: null });
      if (url.includes('/overdue-incidents')) return json(emptyPage);
      if (url.includes('/follow-ups')) return json(emptyPage);
      if (url.includes('/api/customers/') && url.includes('/contacts')) return json(emptyPage);
      if (method === 'PATCH' && path.endsWith('/api/job-cards/job-1/sale-items/line-1')) {
        patchCalls += 1;
        return json({
          error: 'Kayıt başka bir işlemle güncellendi.', code: 'VERSION_CONFLICT',
        }, 409);
      }
      if (method === 'GET' && path.endsWith('/api/job-cards/job-1/sale-details')) {
        return json({
          ...saleDetailsBefore,
          jobCardVersion: canonicalVersion,
          items: [{ ...saleDetailsBefore.items[0]!, quantity: '5' }],
        });
      }
      if (method === 'GET' && detailUrlMatches(url, before.id)) {
        detailGets += 1;
        if (detailGets === 1) return json(before);
        if (options.backgroundReads && detailGets === 2) {
          // First background realtime read: newer canonical version.
          canonicalVersion = 5;
          return json({ ...before, version: 5 });
        }
        if (options.backgroundReads && detailGets === 3) {
          // Second background read fails; no reconcile.
          return json({ error: 'Sunucu hatası.' }, 500);
        }
        // Explicit reload. Without background reads it stays at the same
        // version: only the base handler reset can replace the draft.
        if (!options.backgroundReads) return json(before);
        canonicalVersion = 5;
        return json({ ...before, version: 5 });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    return {
      before, fetch, source,
      detailGets: () => detailGets,
      patchCalls: () => patchCalls,
    };
  }

  async function startQuantityConflict(
    harness: ReturnType<typeof saleQuantityConflictHarness>,
  ) {
    await renderScreen(harness.before, harness.fetch, harness.source);
    const quantityInput = () => host.querySelector<HTMLInputElement>(
      'input[aria-label="İmplant Seti satış adedi"]',
    );
    await act(async () => { setNativeValue(quantityInput()!, '17'); });
    await click(host, 'Adedi kaydet');
    await settle();
    expect(harness.patchCalls()).toBe(1);
    expect(host.querySelector<HTMLFieldSetElement>('.sale-correction fieldset')?.disabled).toBe(true);
    expect(buttonByText(host, 'Güncel kaydı yükle ve düzeltmeye devam et')).not.toBeNull();
    return { quantityInput };
  }

  it('keeps the sale correction locked through two background realtime reads and unlocks only on the explicit reconciled reload', async () => {
    const harness = saleQuantityConflictHarness({ backgroundReads: true });
    const { quantityInput } = await startQuantityConflict(harness);

    // First background read applies a newer version 200; the form stays locked.
    await act(async () => {
      harness.source.emitJobUpdate('job-1', '1');
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await settle();
    expect(harness.detailGets()).toBe(2);
    expect(host.querySelector<HTMLFieldSetElement>('.sale-correction fieldset')?.disabled).toBe(true);
    expect(buttonByText(host, 'Güncel kaydı yükle ve düzeltmeye devam et')).not.toBeNull();

    // Second background read fails 500; still locked.
    await act(async () => {
      harness.source.emitJobUpdate('job-1', '2');
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await settle();
    expect(harness.detailGets()).toBe(3);
    expect(host.querySelector<HTMLFieldSetElement>('.sale-correction fieldset')?.disabled).toBe(true);
    expect(buttonByText(host, 'Güncel kaydı yükle ve düzeltmeye devam et')).not.toBeNull();

    // The explicit reload is reconciled: unlock and apply the base reset.
    await click(host, 'Güncel kaydı yükle ve düzeltmeye devam et');
    await settle();
    expect(harness.detailGets()).toBe(4);
    expect(host.querySelector<HTMLFieldSetElement>('.sale-correction fieldset')?.disabled).toBe(false);
    expect(buttonByText(host, 'Güncel kaydı yükle ve düzeltmeye devam et')).toBeNull();
    expect(quantityInput()?.value).toBe('5');
    expect(receiptRegions('Satış kaydı güncellendi.')).toHaveLength(0);
  });

  it('resets the conflicted quantity to server truth after a successful explicit reload', async () => {
    const harness = saleQuantityConflictHarness({ backgroundReads: false });
    const { quantityInput } = await startQuantityConflict(harness);

    await click(host, 'Güncel kaydı yükle ve düzeltmeye devam et');
    await settle();

    expect(harness.detailGets()).toBe(2);
    expect(host.querySelector<HTMLFieldSetElement>('.sale-correction fieldset')?.disabled).toBe(false);
    expect(buttonByText(host, 'Güncel kaydı yükle ve düzeltmeye devam et')).toBeNull();
    // Base behaviour: canonical server truth replaces the conflicted draft.
    expect(quantityInput()?.value).toBe('5');
    expect(receiptRegions('Satış kaydı güncellendi.')).toHaveLength(0);
  });

  /**
   * UI-FEEDBACK/B: the page receipt keeps its rem size through styles.css. An
   * inline style would bypass the design tokens and the documented stylesheet.
   */
  it('keeps the page receipt rem size in styles.css instead of an inline style', () => {
    const styles = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const jobDetail = readFileSync(resolve(process.cwd(), 'src/JobDetail.tsx'), 'utf8');
    const selector = '.job-detail > .detail-feedback[data-job-detail-section="feedback"]';
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rule = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(styles);
    expect(rule).not.toBeNull();
    expect(rule?.[1]).toMatch(/font-size:\s*1rem\s*;/);
    expect(jobDetail).not.toMatch(/fontSize\s*:/);
  });
});
