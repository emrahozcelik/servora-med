/**
 * UI-003 / MF-11 / MF-12 acceptance for RESCUE-003/B unified manager recovery form,
 * using the real entry, AppShell, production CSS, and deterministic mock API boundary.
 *
 * Run from web/:
 *   FLEET_EVIDENCE_DIR=/absolute/output CONNECTED_VISUAL_SOURCE=<sha> \
 *   node scripts/connected-workflows-recovery-acceptance.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '../..');
const baselineEvidenceMeasurements = resolve(
  repoRoot,
  'docs/evidence/rescue-003-connected-workflows/measurements.json',
);

const evidence = resolve(process.env.FLEET_EVIDENCE_DIR ?? '.ui-evidence/connected-workflows-recovery');
const screenshotsDir = resolve(evidence, 'screenshots');
mkdirSync(screenshotsDir, { recursive: true });

const jobId = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';
const offerId = '77777777-7777-4777-8777-777777777777';
const customerId = '55555555-5555-4555-8555-555555555555';
const jobPath = '/api/job-cards/' + jobId;
const staff = { id: '33333333-3333-4333-8333-333333333333', name: 'Ayşe Personel' };
const successor = { id: '66666666-6666-4666-8666-666666666666', name: 'Deniz Personel' };
const manager = {
  id: '44444444-4444-4444-8444-444444444444',
  organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  name: 'Murat Yönetici',
  email: 'murat@example.invalid',
  role: 'MANAGER',
  mustChangePassword: false,
  isActive: true,
  version: 1,
  capabilities: { overviewDashboard: false, calendar: false, messaging: false },
};

const fixedClock = '2026-11-26T11:00:00.000Z';
const customerRecord = {
  id: customerId,
  organizationId: manager.organizationId,
  name: 'Anadolu Dental Polikliniği',
  customerType: 'clinic',
  taxNumber: null,
  phone: '+905551112233',
  email: null,
  city: 'İstanbul',
  district: 'Kadıköy',
  address: null,
  assignedStaffUserId: staff.id,
  status: 'active',
  version: 1,
  assignedStaffName: staff.name,
  primaryContact: null,
  contacts: [],
  hasOperationHistory: false,
  openJobCount: 2,
  completedJobCount: 0,
};

const baseLifecycle = {
  createdAt: '2026-11-25T08:00:00.000Z',
  acceptedAt: '2026-11-26T09:15:00.000Z',
  acceptedBy: staff,
  startedAt: null,
  submittedAt: null,
  submittedBy: null,
  submissionNote: null,
  approvedAt: null,
  approvedBy: null,
  approvalNote: null,
  revisionRequestedAt: null,
  revisionRequestedBy: null,
  revisionReason: null,
  cancelledAt: null,
  cancelledBy: null,
  cancelReason: null,
  cancelledFromStatus: null,
};

const changeRequestFixture = {
  id: requestId,
  reasonCode: 'CUSTOMER_POSTPONED',
  reasonText: 'Klinik teslimatı daha geç bir saate almak istiyor.',
  requestedAt: '2026-11-26T10:30:00.000Z',
  requestedBy: staff,
};

const baseJob = {
  id: jobId,
  organizationId: manager.organizationId,
  organizationTimezone: 'Europe/Istanbul',
  type: 'PRODUCT_DELIVERY',
  status: 'ACCEPTED',
  version: 4,
  engagementKind: null,
  title: 'Anadolu Dental Polikliniği ürün teslimi',
  description: null,
  customerId,
  contactId: null,
  customer: { id: customerId, name: 'Anadolu Dental Polikliniği' },
  contact: null,
  assignedTo: staff.id,
  assignee: staff,
  createdBy: manager.id,
  priority: 'normal',
  dueDate: null,
  scheduledAt: '2026-11-27T13:30:00.000Z',
  scheduledEndsAt: '2026-11-27T14:30:00.000Z',
  followUpContext: null,
  hasOpenOverdueIncident: false,
  correctionDueAt: null,
  assignmentOffer: null,
  changeRequest: changeRequestFixture,
  workflowContext: {
    allowedCommands: ['CANCEL'],
    allowedActions: ['EDIT_JOB_FIELDS', 'VIEW_NOTES', 'RESOLVE_CHANGE_REQUEST'],
    lifecycle: baseLifecycle,
    submissionReadiness: null,
  },
};

function makeOffer(overrides = {}) {
  return {
    id: offerId,
    state: 'DECLINED',
    openedAt: '2026-11-26T09:00:00.000Z',
    acceptanceDueAt: '2026-11-26T12:00:00.000Z',
    urgentReason: null,
    assignee: staff,
    closedAt: '2026-11-26T10:30:00.000Z',
    closeReason: 'OUT_OF_TOWN',
    closeText: 'Şehir dışındayım.',
    suggestedSolution: 'REASSIGN',
    proposedScheduledAt: null,
    proposedScheduledEndsAt: null,
    proposalAcceptedAt: null,
    ...overrides,
  };
}

function buildScenarioJob(scenario = 'change-request') {
  switch (scenario) {
    case 'change-request':
      return baseJob;
    case 'assignment':
    case 'assignment-reassign':
      return {
        ...baseJob,
        status: 'NEW',
        changeRequest: null,
        workflowContext: {
          ...baseJob.workflowContext,
          allowedActions: ['EDIT_JOB_FIELDS', 'VIEW_NOTES'],
          lifecycle: { ...baseLifecycle, acceptedAt: null, acceptedBy: null },
        },
        assignmentOffer: makeOffer({ suggestedSolution: 'REASSIGN' }),
      };
    case 'assignment-proposal-valid':
      return {
        ...baseJob,
        status: 'NEW',
        changeRequest: null,
        workflowContext: {
          ...baseJob.workflowContext,
          allowedActions: ['EDIT_JOB_FIELDS', 'VIEW_NOTES'],
          lifecycle: { ...baseLifecycle, acceptedAt: null, acceptedBy: null },
        },
        assignmentOffer: makeOffer({
          closeReason: 'SCHEDULE_CONFLICT',
          closeText: 'Aynı saatte başka klinik ziyaretim var.',
          suggestedSolution: 'RESCHEDULE_SELF',
          proposedScheduledAt: '2026-11-27T11:00:00.000Z',
          proposedScheduledEndsAt: '2026-11-27T12:00:00.000Z',
        }),
      };
    case 'assignment-proposal-expired':
      return {
        ...baseJob,
        status: 'NEW',
        changeRequest: null,
        workflowContext: {
          ...baseJob.workflowContext,
          allowedActions: ['EDIT_JOB_FIELDS', 'VIEW_NOTES'],
          lifecycle: { ...baseLifecycle, acceptedAt: null, acceptedBy: null },
        },
        assignmentOffer: makeOffer({
          closeReason: 'SCHEDULE_CONFLICT',
          closeText: 'Sabah saatinde uygun olabilirim.',
          suggestedSolution: 'RESCHEDULE_SELF',
          proposedScheduledAt: '2026-11-26T09:00:00.000Z',
          proposedScheduledEndsAt: '2026-11-26T10:00:00.000Z',
        }),
      };
    case 'assignment-cancel-request':
      return {
        ...baseJob,
        status: 'NEW',
        changeRequest: null,
        workflowContext: {
          ...baseJob.workflowContext,
          allowedActions: ['EDIT_JOB_FIELDS', 'VIEW_NOTES'],
          lifecycle: { ...baseLifecycle, acceptedAt: null, acceptedBy: null },
        },
        assignmentOffer: makeOffer({
          closeReason: 'OTHER',
          closeText: 'Klinik bu siparişi tamamen iptal etmek istediğini iletti.',
          suggestedSolution: 'CANCEL_REQUEST',
        }),
      };
    case 'coexisting':
      return {
        ...baseJob,
        status: 'NEW',
        workflowContext: {
          ...baseJob.workflowContext,
          allowedActions: ['EDIT_JOB_FIELDS', 'VIEW_NOTES', 'RESOLVE_CHANGE_REQUEST'],
          lifecycle: { ...baseLifecycle, acceptedAt: null, acceptedBy: null },
        },
        assignmentOffer: makeOffer({
          closeReason: 'SCHEDULE_CONFLICT',
          closeText: 'Öğleden sonra başka teslimatım var; ertesi gün sabah yapabilirim.',
          suggestedSolution: 'RESCHEDULE_SELF',
          proposedScheduledAt: '2026-11-27T11:00:00.000Z',
          proposedScheduledEndsAt: '2026-11-27T12:00:00.000Z',
        }),
        changeRequest: changeRequestFixture,
      };
    case 'started-change-request':
      return {
        ...baseJob,
        type: 'SALES_MEETING',
        engagementKind: 'CUSTOMER_VISIT',
        title: 'Anadolu Dental Polikliniği ürün sunumu',
        status: 'IN_PROGRESS',
        workflowContext: {
          allowedCommands: ['SUBMIT_FOR_APPROVAL', 'CANCEL'],
          allowedActions: ['EDIT_JOB_FIELDS', 'VIEW_NOTES', 'RESOLVE_CHANGE_REQUEST'],
          lifecycle: { ...baseLifecycle, startedAt: '2026-11-26T10:00:00.000Z' },
          submissionReadiness: null,
        },
      };
    case 'sales-meeting-change-request':
      return {
        ...baseJob,
        type: 'SALES_MEETING',
        engagementKind: 'CUSTOMER_VISIT',
        title: 'Anadolu Dental Polikliniği cihaz görüşmesi',
        description: 'Demo ünitesi görüşmesi.',
        status: 'ACCEPTED',
        changeRequest: {
          ...changeRequestFixture,
          reasonCode: 'WRONG_PRODUCT',
          reasonText: 'Görüşme başlığı ve ürün kapsamı güncellenmeli.',
        },
      };
    case 'sales-meeting-other-change-request':
      return {
        ...baseJob,
        type: 'SALES_MEETING',
        engagementKind: 'CUSTOMER_VISIT',
        title: 'Anadolu Dental Polikliniği cihaz görüşmesi',
        description: 'Demo ünitesi görüşmesi.',
        status: 'ACCEPTED',
        changeRequest: {
          ...changeRequestFixture,
          reasonCode: 'OTHER',
          reasonText: 'Klinik ek cihaz kapsamının açıklamasını istedi.',
        },
      };
    default:
      throw new Error(`Unknown scenario: ${scenario}`);
  }
}

const empty = { items: [], total: 0, limit: 25, offset: 0, nextCursor: null };

const matrixSamples = [
  { name: 'small-mobile', width: 320, height: 800 },
  { name: 'phone', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'text-200', width: 390, height: 844, textScale: 200 },
  { name: 'reflow-400-equivalent', width: 320, height: 225, dpr: 4 },
  { name: 'reduced-motion', width: 390, height: 844, motion: 'reduce' },
];

const entrySamples = [
  { name: 'declined-assignment-phone', width: 390, height: 844, scenario: 'assignment-reassign' },
  { name: 'declined-assignment-desktop', width: 1440, height: 900, scenario: 'assignment-reassign' },
  { name: 'coexisting-sources-phone', width: 390, height: 844, scenario: 'coexisting' },
  { name: 'coexisting-sources-desktop', width: 1440, height: 900, scenario: 'coexisting' },
  { name: 'started-job-phone', width: 390, height: 844, scenario: 'started-change-request' },
  { name: 'started-job-desktop', width: 1440, height: 900, scenario: 'started-change-request' },
];

const baseline = process.env.CONNECTED_VISUAL_BASELINE === '1';
const report = {
  fixedClock,
  timezone: 'Europe/Istanbul',
  source: process.env.CONNECTED_VISUAL_SOURCE ?? 'working tree',
  baseline,
  samples: [],
  entryCases: [],
  interactions: {},
};
const issues = [];

function requireMetric(condition, message) {
  if (!condition) issues.push(message);
}

async function openCase(browser, url, options) {
  const currentJob = buildScenarioJob(options.scenario ?? 'change-request');
  const context = await browser.newContext({
    viewport: { width: options.width, height: options.height },
    deviceScaleFactor: options.dpr ?? 1,
    locale: 'tr-TR',
    timezoneId: report.timezone,
    reducedMotion: options.motion ?? 'no-preference',
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  const errors = [];
  const unexpected = [];
  const mutations = [];
  let releasePending;
  const pendingGate = () => new Promise((complete) => {
    releasePending = complete;
  });
  let currentGate = pendingGate();
  let serverJob = structuredClone(currentJob);

  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(window, 'EventSource', { configurable: true, value: undefined });
  });
  await page.clock.setFixedTime(new Date(fixedClock));

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const method = request.method();
    const parsedUrl = new URL(request.url());
    const path = parsedUrl.pathname;
    const send = (json, status = 200) => route.fulfill({ json, status });

    if (method === 'GET' && path === '/api/auth/me') return send({ user: manager });
    if (method === 'GET' && path === jobPath) return send(serverJob);
    if (method === 'GET' && path === '/api/notifications/unread-count') return send({ unreadCount: 0 });
    if (method === 'GET' && path === '/api/web-push/status') {
      return send({ enabled: false, subscribed: false, vapidPublicKey: null });
    }
    if (method === 'POST' && path === '/api/notifications/read-by-entity') return send({ markedCount: 0 });
    if (method === 'POST' && path === '/api/job-cards/available-slots') {
      return send({
        slots: [{ startsAt: '2026-11-27T14:00:00.000Z', endsAt: '2026-11-27T15:00:00.000Z' }],
      });
    }
    if (method === 'POST' && path === '/api/job-cards/customer-schedule/evaluate') {
      return send({
        level: 'CLEAR',
        safeMessage: null,
        conflicts: [],
        recentVisit: null,
        suggestedAlternativeAt: null,
      });
    }
    if (method === 'GET' && path === '/api/staff') {
      return send(
        [staff, successor].map((person) => ({
          id: person.id,
          version: 1,
          user: {
            ...manager,
            ...person,
            email: person.id + '@example.invalid',
            role: 'STAFF',
            lastLoginAt: null,
            createdAt: fixedClock,
            updatedAt: fixedClock,
          },
          title: null,
          phone: null,
          region: null,
          managerUserId: null,
          managerName: null,
          counters: {
            open: 0,
            waitingApproval: 0,
            revisionRequested: 0,
            completedThisMonth: 0,
            overdue: 0,
          },
        })),
      );
    }
    if (method === 'GET' && path === '/api/customers') {
      return send({ items: [customerRecord], total: 1, limit: 20, offset: 0, nextCursor: null });
    }
    if (method === 'GET' && path === `/api/customers/${customerId}`) {
      return send(customerRecord);
    }
    if (method === 'GET' && path === jobPath + '/submission-lateness') return send({ open: null });
    if (method === 'GET' && path === jobPath + '/sales') {
      return send({ items: [], total: 0, limit: 20, offset: 0 });
    }
    if (method === 'GET' && path === jobPath + '/sale-create-context') {
      return send({
        sourceVisitId: jobId,
        sourceVersion: serverJob.version,
        eligible: false,
        blockedReason: 'SOURCE_NOT_ELIGIBLE',
        customer: serverJob.customer,
        assignee: serverJob.assignee,
        plannedContact: null,
        metContact: null,
        activeSale: null,
      });
    }
    if (
      method === 'GET'
      && ['/delivery-items', '/notes', '/activity', '/follow-ups', '/overdue-incidents'].some(
        (endpoint) => path === jobPath + endpoint,
      )
    ) {
      return send(empty);
    }
    if (
      method === 'GET'
      && (path === '/api/notifications'
        || path === '/api/job-cards/change-requests/open'
        || path.endsWith('/assignment-offers/needs-action')
        || path === '/api/job-cards/pending-acceptance/past-start'
        || path.endsWith('/unaccepted-past-start'))
    ) {
      return send(empty);
    }

    if (method === 'POST' && path === jobPath + '/assignment-offers/accept-proposal') {
      const body = request.postDataJSON();
      mutations.push({ type: 'ACCEPT_PROPOSAL', body });
      if (options.holdPending) {
        await currentGate;
        currentGate = pendingGate();
      }
      const proposedAt = serverJob.assignmentOffer?.proposedScheduledAt ?? '2026-11-27T11:00:00.000Z';
      const proposedEnd = serverJob.assignmentOffer?.proposedScheduledEndsAt ?? '2026-11-27T12:00:00.000Z';
      serverJob = {
        ...serverJob,
        status: 'ACCEPTED',
        version: serverJob.version + 1,
        scheduledAt: proposedAt,
        scheduledEndsAt: proposedEnd,
        assignmentOffer: {
          ...serverJob.assignmentOffer,
          state: 'ACCEPTED',
          proposalAcceptedAt: fixedClock,
        },
        workflowContext: {
          ...serverJob.workflowContext,
          allowedCommands: ['START', 'CANCEL'],
          lifecycle: {
            ...serverJob.workflowContext.lifecycle,
            acceptedAt: fixedClock,
            acceptedBy: serverJob.assignee,
          },
        },
      };
      return send({
        jobCardId: jobId,
        offerId: body.offerId,
        scheduledAt: proposedAt,
        scheduledEndsAt: proposedEnd,
      });
    }

    if (method === 'POST' && path === jobPath + '/assignment-offers/reoffer') {
      const body = request.postDataJSON();
      mutations.push({ type: 'REOFFER', body });
      if (options.holdPending) {
        await currentGate;
        currentGate = pendingGate();
      }
      const newOfferId = '99999999-9999-4999-8999-999999999999';
      serverJob = {
        ...serverJob,
        version: serverJob.version + 1,
        assignmentOffer: {
          ...makeOffer(),
          id: newOfferId,
          state: 'OPEN',
          openedAt: fixedClock,
          acceptanceDueAt: '2026-11-27T12:00:00.000Z',
          closedAt: null,
          closeReason: null,
          closeText: null,
          suggestedSolution: null,
        },
      };
      return send({
        jobCardId: jobId,
        offerId: newOfferId,
        acceptanceDueAt: '2026-11-27T12:00:00.000Z',
        urgentReason: null,
      });
    }

    if (method === 'POST' && path === jobPath + '/change-requests/' + requestId + '/resolve') {
      const body = request.postDataJSON();
      mutations.push({ type: 'RESOLVE_CHANGE_REQUEST', body });
      if (options.holdPending) {
        await currentGate;
        currentGate = pendingGate();
      }
      serverJob = {
        ...serverJob,
        version: serverJob.version + 1,
        changeRequest: null,
      };
      return send({
        jobCardId: jobId,
        changeRequestId: requestId,
        resolution: body.resolution,
        resolvedAt: fixedClock,
      });
    }

    if (method === 'POST' && path === jobPath + '/cancel') {
      const body = request.postDataJSON();
      mutations.push({ type: 'CANCEL', body });
      if (options.holdPending) {
        await currentGate;
        currentGate = pendingGate();
      }
      serverJob = {
        ...serverJob,
        status: 'CANCELLED',
        version: serverJob.version + 1,
        changeRequest: null,
        assignmentOffer: null,
        workflowContext: {
          ...serverJob.workflowContext,
          allowedCommands: [],
          allowedActions: ['VIEW_NOTES'],
          lifecycle: {
            ...serverJob.workflowContext.lifecycle,
            cancelledAt: fixedClock,
            cancelledBy: manager,
            cancelReason: body.cancelReason,
            cancelledFromStatus: serverJob.status,
          },
        },
      };
      return send(serverJob);
    }

    if (method === 'PATCH' && path === jobPath) {
      const mutation = request.postDataJSON();
      mutations.push({ type: 'PATCH', body: mutation });
      if (options.transferConflict && mutations.filter((m) => m.type === 'PATCH').length === 1) {
        return send(
          { code: 'OCCUPANCY_LIMIT_REACHED', error: 'Bu saat için personel takvimi dolu.' },
          409,
        );
      }
      if (options.holdPending) {
        await currentGate;
        currentGate = pendingGate();
      }
      const nextAssignee =
        mutation.assignedTo === successor.id
          ? successor
          : mutation.assignedTo === staff.id
            ? staff
            : serverJob.assignee;
      const duration =
        serverJob.scheduledEndsAt && serverJob.scheduledAt
          ? Date.parse(serverJob.scheduledEndsAt) - Date.parse(serverJob.scheduledAt)
          : 3_600_000;
      const nextScheduledAt = mutation.scheduledAt !== undefined ? mutation.scheduledAt : serverJob.scheduledAt;
      const nextEndsAt = nextScheduledAt
        ? new Date(Date.parse(nextScheduledAt) + duration).toISOString()
        : serverJob.scheduledEndsAt;
      const offerChanged = Boolean(mutation.assignedTo || mutation.scheduledAt);
      serverJob = {
        ...serverJob,
        status: offerChanged ? 'NEW' : serverJob.status,
        version: serverJob.version + 1,
        title: mutation.title ?? serverJob.title,
        description: mutation.description !== undefined ? mutation.description : serverJob.description,
        priority: mutation.priority ?? serverJob.priority,
        engagementKind: mutation.engagementKind ?? serverJob.engagementKind,
        customerId: mutation.customerId ?? serverJob.customerId,
        assignedTo: nextAssignee.id,
        assignee: nextAssignee,
        scheduledAt: nextScheduledAt,
        scheduledEndsAt: nextEndsAt,
        changeRequest: mutation.changeRequestResolution ? null : serverJob.changeRequest,
        workflowContext: {
          ...serverJob.workflowContext,
          lifecycle: offerChanged
            ? { ...serverJob.workflowContext.lifecycle, acceptedAt: null, acceptedBy: null }
            : serverJob.workflowContext.lifecycle,
        },
        assignmentOffer: offerChanged
          ? {
              ...makeOffer(),
              id: '77777777-7777-4777-8777-777777777778',
              state: 'OPEN',
              assignee: nextAssignee,
              openedAt: fixedClock,
              acceptanceDueAt: '2026-11-27T12:00:00.000Z',
              closedAt: null,
              closeReason: null,
              closeText: null,
              suggestedSolution: null,
            }
          : serverJob.assignmentOffer,
      };
      if (options.transferLostResponse) return route.abort('connectionreset');
      return send(serverJob);
    }

    unexpected.push(method + ' ' + path);
    return send({ error: 'Unexpected test request' }, 404);
  });

  await page.goto(url + '/jobs/' + jobId);
  if (options.textScale) {
    await page.addStyleTag({ content: `html { font-size: ${options.textScale}%; }` });
  }
  await page.locator('[data-manager-recovery="true"]').waitFor();
  await page.evaluate(() => document.fonts.ready);
  return {
    page,
    context,
    errors,
    unexpected,
    mutations,
    release: () => releasePending?.(),
  };
}

async function capture(page, name) {
  await page.screenshot({ path: resolve(screenshotsDir, name + '.png'), animations: 'disabled' });
}

async function pageGeometry(page) {
  return page.evaluate(() => {
    const box = (element) => {
      const rect = element.getBoundingClientRect();
      return { width: rect.width, height: rect.height, top: rect.top, bottom: rect.bottom };
    };
    const detail = document.querySelector('[data-job-detail="true"]');
    const recovery = detail.querySelector('[data-manager-recovery="true"]');
    const triggerButtons = [...detail.querySelectorAll('[data-manager-recovery-trigger]')];
    const siblingRecoveryTriggers = [
      ...detail.querySelectorAll('button'),
    ].filter((btn) => btn.textContent.trim() === 'Görevi çözüme ulaştır');
    const targets = [...recovery.querySelectorAll('button')]
      .filter((element) => element.getClientRects().length)
      .map((element) => ({ label: element.textContent.trim(), ...box(element) }));
    const sections = [...detail.querySelectorAll('[data-job-detail-section]')]
      .filter((element) => element.getClientRects().length)
      .map((element) => element.dataset.jobDetailSection);
    const responsibility = detail.querySelector('[data-job-detail-section="responsibility"]');
    const fixedNav = document.querySelector('.mobile-bottom-nav, .bottom-nav');

    const header = recovery.querySelector('.job-recovery-header');
    const sources = recovery.querySelector('.job-recovery-sources');
    const actions = recovery.querySelector('.review-buttons');
    const gapBetween = (a, b) =>
      a && b ? Math.round((b.getBoundingClientRect().top - a.getBoundingClientRect().bottom) * 100) / 100 : null;

    return {
      viewport: [innerWidth, innerHeight],
      dpr: devicePixelRatio,
      documentWidth: document.documentElement.scrollWidth,
      rootFont: getComputedStyle(document.documentElement).fontSize,
      motion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      triggerCount: triggerButtons.length,
      duplicateTriggerCount: siblingRecoveryTriggers.length,
      hasOfferSource: Boolean(recovery.querySelector('[data-assignment-offer-recovery]')),
      hasChangeRequestSource: Boolean(recovery.querySelector('[data-change-request="management"]')),
      targets,
      sections,
      responsibilityNested: recovery.contains(responsibility),
      navigationLinks: [...document.querySelectorAll('nav a')].map((anchor) => anchor.getAttribute('href')),
      bottomNavigation: fixedNav ? box(fixedNav) : null,
      summaryGaps: {
        headerToSources: gapBetween(header, sources),
        sourcesToButton: gapBetween(sources, actions),
      },
    };
  });
}

async function overlayTargets(overlay) {
  const controls = await overlay
    .locator(
      'button:visible, select:visible, textarea:visible, [role="spinbutton"]:visible, input[type="datetime-local"]:not(.wheel-field-proxy):visible, input[type="date"]:not(.wheel-field-proxy):visible, input[type="text"]:visible',
    )
    .evaluateAll((elements) =>
      elements.map((element) => {
        const { width, height } = element.getBoundingClientRect();
        return {
          label: element.getAttribute('aria-label') ?? element.textContent.trim() ?? element.name ?? element.tagName,
          width,
          height,
        };
      }),
    );
  const checkboxLabels = await overlay
    .locator('.form-checkbox-row label:visible')
    .evaluateAll((labels) =>
      labels.map((label) => {
        const { width, height } = label.getBoundingClientRect();
        return { label: label.textContent.trim(), width, height };
      }),
    );
  return [...controls, ...checkboxLabels];
}

async function drawerGeometry(page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-servora-form-drawer]');
    const dialog = root.querySelector('[role="dialog"]');
    const header = dialog.querySelector('.form-drawer-header');
    const title = header.querySelector('h2').getBoundingClientRect();
    const close = header.querySelector('.drawer-close').getBoundingClientRect();
    const form = dialog.querySelector('[data-manager-recovery-form]');
    const grid = form.querySelector('.manager-recovery-grid');
    const contextEl = form.querySelector('.manager-recovery-context');
    const mainEl = form.querySelector('.manager-recovery-main');
    const decisions = form.querySelector('.manager-recovery-decisions');
    const unavailable = form.querySelector('.manager-recovery-unavailable');
    const fields = form.querySelector('.manager-recovery-fields');
    const preview = form.querySelector('.manager-recovery-preview');
    const footer = form.querySelector('.manager-recovery-footer');
    const primaryBtn = footer.querySelector('button[type="submit"], button.primary-button');

    const radioRows = [...form.querySelectorAll('.manager-recovery-decision-row')].map((row) => {
      const r = row.getBoundingClientRect();
      return {
        decision: row.dataset.recoveryDecision,
        label: row.querySelector('.manager-recovery-decision-title')?.textContent?.trim() ?? '',
        width: r.width,
        height: r.height,
      };
    });
    const footerButtons = [...footer.querySelectorAll('button')].map((btn) => {
      const r = btn.getBoundingClientRect();
      return { label: btn.textContent.trim(), width: r.width, height: r.height };
    });
    const nestedPermanentCards = form.querySelectorAll('.surface-flat, .detail-summary').length;

    const gridStyle = getComputedStyle(grid);
    const gridColCount = gridStyle.gridTemplateColumns.trim().split(/\s+/).length;
    const contextRect = contextEl.getBoundingClientRect();
    const mainRect = mainEl.getBoundingClientRect();
    const vGap = (a, b) =>
      a && b ? Math.round((b.getBoundingClientRect().top - a.getBoundingClientRect().bottom) * 100) / 100 : null;
    const hGap = (a, b) =>
      a && b ? Math.round((b.getBoundingClientRect().left - a.getBoundingClientRect().right) * 100) / 100 : null;

    const afterDecisions = unavailable ?? fields ?? preview;
    const afterFields = fields ? preview : null;

    return {
      drawerWidth: dialog.getBoundingClientRect().width,
      header: {
        width: header.clientWidth,
        titleWidth: title.width,
        titleHeight: title.height,
        closeWidth: close.width,
        closeHeight: close.height,
      },
      scroller: {
        clientWidth: dialog.clientWidth,
        scrollWidth: dialog.scrollWidth,
      },
      formOverflow: {
        clientWidth: form.clientWidth,
        scrollWidth: form.scrollWidth,
      },
      gridColumns: gridColCount,
      twoColumnSideBySide:
        gridColCount === 2 && contextRect.right <= mainRect.left + 1 && Math.abs(contextRect.top - mainRect.top) < 4,
      nestedPermanentCards,
      primaryFont: primaryBtn ? parseFloat(getComputedStyle(primaryBtn).fontSize) : null,
      radioRows,
      footerButtons,
      sectionGaps: {
        contextToMainHorizontal: gridColCount === 2 ? hGap(contextEl, mainEl) : null,
        contextToMainVertical: gridColCount === 1 ? vGap(contextEl, mainEl) : null,
        decisionsToNext: vGap(decisions, afterDecisions),
        unavailableToNext: unavailable ? vGap(unavailable, fields ?? preview) : null,
        fieldsToPreview: afterFields ? vGap(fields, preview) : null,
        previewToFooter: vGap(preview, footer),
      },
    };
  });
}

async function verifyFooterReachable(page) {
  const footer = page.locator('.manager-recovery-footer');
  const submit = footer.locator('button[type="submit"], button.primary-button').last();
  await submit.scrollIntoViewIfNeeded();
  return submit.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const cx = bounds.left + bounds.width / 2;
    const cy = bounds.top + bounds.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    const nav = document.querySelector('.mobile-bottom-nav, .bottom-nav');
    const navRect = nav ? nav.getBoundingClientRect() : null;
    const inViewport = bounds.top >= 0 && bounds.bottom <= innerHeight && bounds.left >= 0 && bounds.right <= innerWidth;
    // Drawer sits above mobile nav in z-order (101 vs 20), and hit-test proves elementFromPoint hits the button itself.
    return {
      hitTargetOk: Boolean(hit && (element === hit || element.contains(hit))),
      inViewport,
      navTop: navRect ? navRect.top : null,
      buttonBottom: bounds.bottom,
    };
  });
}

async function openDrawer(page) {
  const trigger = page.locator('[data-manager-recovery-trigger="true"]');
  assert.equal(await trigger.count(), 1);
  await trigger.click();
  const drawer = page.locator('[data-servora-form-drawer] [role="dialog"]');
  await drawer.locator('[data-manager-recovery-form="true"]').waitFor();
  assert.equal(await drawer.locator('button[type="submit"]').count(), 1);
  return drawer;
}

async function runDecisionInteractions(browser, url) {
  const results = {};

  // 1. Standard phone (390x844): Change request -> Keyboard radio navigation + RESCHEDULE wheel Escape/Confirm + slots + REASSIGN_KEEP_TIME preview
  {
    const test = await openCase(browser, url, { width: 390, height: 844, scenario: 'change-request' });
    const { page, context, mutations, errors, unexpected } = test;
    const drawer = await openDrawer(page);

    // Keyboard radio navigation: RESCHEDULE is default, ArrowDown moves to REASSIGN_AND_RESCHEDULE, ArrowUp returns to RESCHEDULE
    const firstRadio = drawer.locator('input[type="radio"][name="manager-recovery-decision"]').first();
    await firstRadio.focus();
    const initialDecision = await drawer.locator('[data-recovery-fields]').getAttribute('data-recovery-fields');
    assert.equal(initialDecision, 'RESCHEDULE');

    await page.keyboard.press('ArrowDown');
    const secondDecision = await drawer.locator('[data-recovery-fields]').getAttribute('data-recovery-fields');
    assert.notEqual(secondDecision, initialDecision);
    assert.equal(await drawer.locator('[data-recovery-fields]').count(), 1);

    await page.keyboard.press('ArrowUp');
    assert.equal(await drawer.locator('[data-recovery-fields]').getAttribute('data-recovery-fields'), 'RESCHEDULE');

    // Quick preset rail + fade gradient + AvailableSlotsNotice
    await drawer.locator('.schedule-quick-chips-shell[data-overflow="true"]').waitFor();
    const presetCheck = await drawer.locator('.schedule-quick-chips').evaluate((element) => {
      const last = element.lastElementChild;
      last.scrollIntoView({ block: 'nearest', inline: 'end', behavior: 'instant' });
      const visibleEnd = last.getBoundingClientRect().right <= element.getBoundingClientRect().right + 2;
      const fade = getComputedStyle(element.parentElement, '::after').backgroundImage;
      const canScroll = element.scrollWidth > element.clientWidth && element.scrollLeft > 0;
      element.scrollTo({ left: 0, behavior: 'instant' });
      return { canScroll, visibleEnd, fade };
    });
    assert.equal(presetCheck.canScroll && presetCheck.visibleEnd, true);
    assert.match(presetCheck.fade, /linear-gradient/);

    const slots = drawer.locator('.available-slots-notice');
    const slotBtn = slots.getByRole('button', { name: /17:00–18:00/ });
    await slotBtn.scrollIntoViewIfNeeded();
    const slotTargets = await overlayTargets(slots);
    await slotBtn.click();
    await capture(page, 'decision-reschedule-slots');

    // WheelDateTimeField open -> capture -> Escape restores focus to trigger -> reopen -> Tamam confirms & restores focus
    const wheelTrigger = drawer.locator('.wheel-field-trigger').first();
    await wheelTrigger.click();
    const wheel = page.locator('[data-servora-wheel-sheet]');
    await wheel.waitFor();
    const wheelTargets = await overlayTargets(wheel);
    await capture(page, 'decision-reschedule-wheel-open');
    await page.keyboard.press('Escape');
    await wheel.waitFor({ state: 'hidden' });
    assert.equal(await drawer.isVisible(), true);
    assert.equal(await wheelTrigger.evaluate((el) => el === document.activeElement), true);

    await wheelTrigger.click();
    await wheel.getByRole('button', { name: 'Tamam', exact: true }).click();
    await wheel.waitFor({ state: 'hidden' });
    assert.equal(await wheelTrigger.evaluate((el) => el === document.activeElement), true);

    for (const t of [...wheelTargets, ...slotTargets]) {
      requireMetric(t.width >= 44 && t.height >= 44, 'reschedule wheel/slot target below 44 CSS px: ' + t.label);
    }

    // REASSIGN_KEEP_TIME preview + submit
    await drawer.locator('[data-recovery-decision="REASSIGN_KEEP_TIME"]').click();
    await drawer.locator('[data-recovery-fields="REASSIGN_KEEP_TIME"]').waitFor();
    const keepSelect = drawer.getByRole('combobox', { name: 'Yeni sorumlu personel' });
    await keepSelect.selectOption(successor.id);
    await capture(page, 'decision-reassign-keep-time-drawer');
    await drawer.locator('[data-recovery-submit="true"]').click();
    const feedback = page.locator('[data-job-detail-section="feedback"]');
    await feedback.getByText(/Sorumlu personel güncellendi\./).waitFor();
    assert.equal(mutations.length, 1);
    assert.equal(mutations[0].type, 'PATCH');
    assert.equal(mutations[0].body.assignedTo, successor.id);
    assert.equal('scheduledAt' in mutations[0].body, false);

    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    results.keyboardAndRescheduleAndKeepTime = {
      keyboardRadioSwitch: true,
      wheelEscapeRestoredFocus: true,
      wheelTamamRestoredFocus: true,
      presetCheck,
      wheelTargets,
      slotTargets,
    };
    await context.close();
  }

  // 2. Desktop (1440x900) RESCHEDULE native datetime-local view
  {
    const test = await openCase(browser, url, { width: 1440, height: 900, scenario: 'change-request' });
    const { page, context, errors, unexpected } = test;
    const drawer = await openDrawer(page);
    await drawer.locator('input[type="datetime-local"]').waitFor();
    await capture(page, 'decision-reschedule-desktop-drawer');
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    await context.close();
  }

  // 3. REASSIGN_AND_RESCHEDULE full flow: validation, 409 conflict preserving draft, pending, committed receipt
  {
    const test = await openCase(browser, url, {
      width: 390,
      height: 844,
      scenario: 'change-request',
      transferConflict: true,
      holdPending: true,
    });
    const { page, context, mutations, release, errors, unexpected } = test;
    const drawer = await openDrawer(page);
    await drawer.locator('[data-recovery-decision="REASSIGN_AND_RESCHEDULE"]').click();
    const fields = drawer.locator('[data-recovery-fields="REASSIGN_AND_RESCHEDULE"]');
    const person = fields.getByRole('combobox', { name: 'Yeni sorumlu personel' });
    const submit = drawer.locator('[data-recovery-submit="true"]');

    await submit.click();
    await fields.getByText('Yeni sorumlu personel seçin.').waitFor();
    assert.equal(mutations.length, 0);
    assert.equal(await person.getAttribute('aria-invalid'), 'true');
    assert.equal(await person.evaluate((el) => el === document.activeElement), true);
    await capture(page, 'decision-transfer-validation');

    await person.selectOption(successor.id);
    await fields.getByRole('button', { name: /17:00–18:00/ }).click();
    const closeCrCheckbox = fields.getByRole('checkbox', { name: /Yeniden planlandı/i });
    await closeCrCheckbox.check();
    await submit.click();

    await drawer.locator('[data-recovery-submit-error="true"]').getByText('Bu saat için personel takvimi dolu.').waitFor();
    assert.equal(await person.inputValue(), successor.id);
    assert.equal(await closeCrCheckbox.isChecked(), true);
    await capture(page, 'decision-transfer-calendar-conflict');

    await submit.click();
    const pendingBtn = drawer.getByRole('button', { name: 'Kaydediliyor…' });
    await pendingBtn.waitFor();
    assert.equal(await pendingBtn.isDisabled(), true);
    assert.equal(await pendingBtn.locator('svg[aria-hidden="true"]').count(), 1);
    await capture(page, 'decision-transfer-pending');

    release();
    const receipt = page.locator('[data-job-detail-section="feedback"]');
    await receipt.getByText(/Personel ve plan güncellendi/).waitFor();
    const outcome = await receipt.evaluate((element) => ({
      role: element.getAttribute('role'),
      icon: Boolean(element.querySelector('svg')),
      confirmed: element.classList.contains('detail-feedback-confirmed'),
      color: getComputedStyle(element).color,
      background: getComputedStyle(element).backgroundColor,
    }));
    assert.equal(outcome.icon && outcome.confirmed, true);
    await capture(page, 'decision-transfer-success');
    assert.equal(mutations.length, 2);
    assert.deepEqual(mutations[1].body, {
      expectedVersion: 4,
      assignedTo: successor.id,
      scheduledAt: '2026-11-27T14:00:00.000Z',
      changeRequestResolution: { changeRequestId: requestId, resolution: 'RESCHEDULED' },
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    results.transferFlow = {
      validation: true,
      conflictPreservedDraft: true,
      pending: true,
      outcome,
      patch: mutations[1].body,
    };
    await context.close();
  }

  // 4. Lost response unknown lock + refresh recovery
  {
    const test = await openCase(browser, url, {
      width: 390,
      height: 844,
      scenario: 'change-request',
      transferLostResponse: true,
    });
    const { page, context, mutations, errors, unexpected } = test;
    const drawer = await openDrawer(page);
    await drawer.locator('[data-recovery-decision="REASSIGN_AND_RESCHEDULE"]').click();
    const fields = drawer.locator('[data-recovery-fields="REASSIGN_AND_RESCHEDULE"]');
    await fields.getByRole('combobox', { name: 'Yeni sorumlu personel' }).selectOption(successor.id);
    await fields.getByRole('button', { name: /17:00–18:00/ }).click();
    await drawer.locator('[data-recovery-submit="true"]').click();

    const notice = page.locator('[data-job-detail-committed-refresh]');
    await notice.getByText(/sonucu doğrulanamadı/).waitFor();
    const recoveryTrigger = page.locator('[data-manager-recovery-trigger="true"]');
    assert.equal(await recoveryTrigger.isDisabled(), true);
    await capture(page, 'decision-transfer-outcome-unknown');

    await notice.getByRole('button', { name: 'Güncel durumu yenile' }).click();
    await notice.waitFor({ state: 'hidden' });
    assert.equal(mutations.length, 1);
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    results.uncertainTransfer = { lockedUntilRefresh: true, refreshed: true };
    await context.close();
  }

  // 5. ACCEPT_PROPOSED_TIME (valid proposal), plus expired proposal & CANCEL_REQUEST non-preselect checks
  {
    const test = await openCase(browser, url, {
      width: 390,
      height: 844,
      scenario: 'assignment-proposal-valid',
    });
    const { page, context, mutations, errors, unexpected } = test;
    const drawer = await openDrawer(page);
    assert.equal(await drawer.locator('input[type="radio"]:checked').inputValue(), 'ACCEPT_PROPOSED_TIME');
    await drawer.locator('[data-recovery-fields="ACCEPT_PROPOSED_TIME"]').waitFor();
    await capture(page, 'decision-accept-proposed-time-drawer');
    await drawer.locator('[data-recovery-submit="true"]').click();
    const receipt = page.locator('[data-job-detail-section="feedback"]');
    await receipt.getByText('Önerilen zaman onaylandı; iş Ayşe Personel için kabul edildi.').waitFor();
    assert.equal(await receipt.evaluate((el) => el.classList.contains('detail-feedback-confirmed')), true);
    await capture(page, 'decision-accept-proposed-time-success');
    assert.equal(mutations.length, 1);
    assert.equal(mutations[0].type, 'ACCEPT_PROPOSAL');
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    results.acceptProposedTime = { defaultSelected: true, committed: true };
    await context.close();
  }

  {
    const test = await openCase(browser, url, {
      width: 390,
      height: 844,
      scenario: 'assignment-proposal-expired',
    });
    const { page, context, errors, unexpected } = test;
    const drawer = await openDrawer(page);
    assert.equal(await drawer.locator('[data-recovery-decision="ACCEPT_PROPOSED_TIME"]').count(), 0);
    await drawer.locator('[data-recovery-unavailable="true"]').getByText(/geçmişte kaldığı için/).waitFor();
    await capture(page, 'entry-expired-proposal-drawer');
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    results.expiredProposal = { acceptOptionHidden: true, explained: true };
    await context.close();
  }

  {
    const test = await openCase(browser, url, {
      width: 390,
      height: 844,
      scenario: 'assignment-cancel-request',
    });
    const { page, context, mutations, errors, unexpected } = test;
    const drawer = await openDrawer(page);
    assert.equal(await drawer.locator('input[type="radio"]:checked').count(), 0);
    assert.equal(await drawer.locator('[data-recovery-submit="true"]').textContent(), 'Kararı uygula');
    await drawer.locator('[data-recovery-submit="true"]').click();
    await drawer.locator('[data-recovery-submit-error="true"]').getByText('Devam etmek için bir karar seçin.').waitFor();
    assert.equal(mutations.length, 0);
    await capture(page, 'entry-cancel-request-no-preselect');
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    results.cancelRequestNoPreselect = { checkedCount: 0, validationBlockedSubmit: true };
    await context.close();
  }

  // 6. REOFFER
  {
    const test = await openCase(browser, url, {
      width: 390,
      height: 844,
      scenario: 'assignment-reassign',
    });
    const { page, context, mutations, errors, unexpected } = test;
    const drawer = await openDrawer(page);
    await drawer.locator('[data-recovery-decision="REOFFER"]').click();
    await drawer.locator('[data-recovery-fields="REOFFER"]').waitFor();
    await capture(page, 'decision-reoffer-drawer');
    await drawer.locator('[data-recovery-submit="true"]').click();
    await page.locator('[data-job-detail-section="feedback"]')
      .getByText('Yeni atama teklifi açıldı; personelin yanıtı bekleniyor.').waitFor();
    assert.equal(mutations.length, 1);
    assert.equal(mutations[0].type, 'REOFFER');
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    results.reoffer = { committed: true };
    await context.close();
  }

  // 7. CORRECT (WRONG_PRODUCT independent save & OTHER opt-in ReasonDialog closure), ACKNOWLEDGED_ONLY, REJECT_CHANGE_REQUEST, CANCEL
  {
    // P1 + P2 unsupported reason (WRONG_PRODUCT): no LINKED_JOB_CREATED, no opt-in closure, record edit saves independently
    const test = await openCase(browser, url, {
      width: 390,
      height: 844,
      scenario: 'sales-meeting-change-request',
    });
    const { page, context, mutations, errors, unexpected } = test;
    const drawer = await openDrawer(page);
    assert.equal(await drawer.locator('[data-recovery-decision="LINKED_JOB_CREATED"]').count(), 0);
    await drawer.locator('[data-recovery-advisory-note="true"]').waitFor();
    assert.equal(await drawer.locator('input[type="radio"]:checked').inputValue(), 'CORRECT');
    const fields = drawer.locator('[data-recovery-fields="CORRECT"]');
    await fields.getByLabel('Açıklama').fill('Güncellenen ürün kapsamı açıklaması.');
    assert.equal(await fields.locator('input[name="resolveChangeRequest"]').count(), 0);
    await fields.locator('[data-correct-closure-ineligible="unsupported-reason"]').waitFor();
    await capture(page, 'decision-correct-wrong-product-drawer');
    await drawer.locator('[data-recovery-submit="true"]').click();
    await page.locator('[data-job-detail-section="feedback"]')
      .getByText(/Görüşme bilgileri güncellendi\./).waitFor();
    assert.equal(mutations.length, 1);
    assert.equal('changeRequestResolution' in mutations[0].body, false);
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    results.correctWrongProduct = { linkedOptionAbsent: true, closureHidden: true, recordSavedIndependently: true };
    await context.close();
  }

  {
    // P2 eligible opt-in closure (OTHER): title alone blocked, description qualifies, stale opt-in cleared on revert, ReasonDialog note required
    const test = await openCase(browser, url, {
      width: 390,
      height: 844,
      scenario: 'sales-meeting-other-change-request',
    });
    const { page, context, mutations, errors, unexpected } = test;
    const drawer = await openDrawer(page);
    assert.equal(await drawer.locator('[data-recovery-decision="LINKED_JOB_CREATED"]').count(), 0);
    await drawer.locator('[data-recovery-decision="CORRECT"]').click();
    const fields = drawer.locator('[data-recovery-fields="CORRECT"]');

    // Title alone does not qualify
    await fields.getByLabel('Başlık').fill('Anadolu Dental Polikliniği güncellenen başlık');
    assert.equal(await fields.locator('input[name="resolveChangeRequest"]').count(), 0);

    // Normalized description change qualifies and shows attestation opt-in
    const descField = fields.getByLabel('Açıklama');
    await descField.fill('Ek cihaz kapsamı ve teknik demo adımları eklendi.');
    const optIn = fields.locator('input[name="resolveChangeRequest"]');
    await optIn.waitFor();
    await optIn.check();

    // Reverting description clears stale opt-in
    await descField.fill('  Demo ünitesi görüşmesi.  ');
    assert.equal(await fields.locator('input[name="resolveChangeRequest"]').count(), 0);

    // Re-editing description keeps opt-in cleared until re-checked
    await descField.fill('Ek cihaz kapsamı ve teknik demo adımları eklendi.');
    await optIn.waitFor();
    assert.equal(await optIn.isChecked(), false);
    await optIn.check();
    assert.equal(await drawer.locator('[data-recovery-submit="true"]').textContent(), 'Not ekleyip kaydet');
    await capture(page, 'decision-correct-drawer');

    // Submit opens ReasonDialog without stacking
    await drawer.locator('[data-recovery-submit="true"]').click();
    const dialog = page.locator('.reason-dialog[role="dialog"]');
    await dialog.waitFor();
    assert.equal(await page.locator('[data-servora-form-drawer]').count(), 0);

    // Empty note validation inside ReasonDialog
    await dialog.getByRole('button', { name: 'Kaydet ve talebi kapat' }).click();
    await dialog.getByText('Talebi “Düzeltildi” olarak kapatmak için açıklama notu zorunludur.').waitFor();
    const dialogTextarea = dialog.getByLabel('Düzeltme açıklaması');
    assert.equal(await dialogTextarea.getAttribute('aria-invalid'), 'true');
    await page.waitForFunction(() => document.activeElement?.tagName === 'TEXTAREA');
    assert.equal(await dialogTextarea.evaluate((el) => el === document.activeElement), true);
    assert.equal(mutations.length, 0);

    await dialogTextarea.fill('Ek cihaz kapsamı açıklamaya eklendi, personelin talebi karşılandı.');
    const dialogTargets = await overlayTargets(dialog);
    for (const t of dialogTargets) {
      requireMetric(t.width >= 44 && t.height >= 44, 'correct-resolve ReasonDialog target below 44 CSS px: ' + t.label);
    }
    await capture(page, 'decision-correct-reason-dialog');

    await dialog.getByRole('button', { name: 'Kaydet ve talebi kapat' }).click();
    const feedback = page.locator('[data-job-detail-section="feedback"]');
    await feedback.getByText(/Personel önerisi “Düzeltildi” olarak kapatıldı\./).waitFor();
    assert.equal(await feedback.evaluate((el) => el.classList.contains('detail-feedback-confirmed')), true);
    assert.equal(mutations.length, 1);
    assert.deepEqual(mutations[0].body.changeRequestResolution, {
      changeRequestId: requestId,
      resolution: 'CORRECTED',
      note: 'Ek cihaz kapsamı açıklamaya eklendi, personelin talebi karşılandı.',
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    results.correct = {
      titleAloneIneligible: true,
      staleOptInClearedOnRevert: true,
      reasonDialogValidationAndFocus: true,
      committedWithAttestedNote: true,
    };
    await context.close();
  }

  {
    // ACKNOWLEDGED_ONLY (neutral non-green preview and receipt!)
    const test = await openCase(browser, url, {
      width: 390,
      height: 844,
      scenario: 'change-request',
    });
    const { page, context, mutations, errors, unexpected } = test;
    const drawer = await openDrawer(page);
    await drawer.locator('[data-recovery-decision="ACKNOWLEDGED_ONLY"]').click();
    const fields = drawer.locator('[data-recovery-fields="ACKNOWLEDGED_ONLY"]');
    const previewEl = drawer.locator('[data-recovery-preview="ACKNOWLEDGED_ONLY"]');
    const previewHasInfo = await previewEl.evaluate((el) => el.classList.contains('manager-recovery-preview--info'));
    assert.equal(previewHasInfo, true);

    await drawer.locator('[data-recovery-submit="true"]').click();
    await fields.getByText('Kayda almak için not yazmanız zorunludur.').waitFor();
    assert.equal(mutations.length, 0);
    await capture(page, 'decision-acknowledged-validation');

    await fields.getByLabel('Kapanış notu').fill('Klinik bilgisi not alındı, mevcut teslim saati ve sorumlusu korunuyor.');
    await capture(page, 'decision-acknowledged-filled-drawer');
    await drawer.locator('[data-recovery-submit="true"]').click();

    const receipt = page.locator('[data-job-detail-section="feedback"]');
    await receipt.getByText(/Öneri kayda alındı ve kapatıldı\./).waitFor();
    const receiptTone = await receipt.evaluate((el) => ({
      isInfo: el.classList.contains('detail-feedback-info'),
      isConfirmed: el.classList.contains('detail-feedback-confirmed'),
      icon: Boolean(el.querySelector('svg')),
      color: getComputedStyle(el).color,
      background: getComputedStyle(el).backgroundColor,
    }));
    assert.equal(receiptTone.isInfo && !receiptTone.isConfirmed && receiptTone.icon, true);
    await capture(page, 'decision-acknowledged-receipt');
    assert.equal(mutations.length, 1);
    assert.equal(mutations[0].body.resolution, 'ACKNOWLEDGED_ONLY');
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    results.acknowledgedOnly = {
      validationOnEmpty: true,
      nonGreenPreview: true,
      receiptTone,
    };
    await context.close();
  }

  {
    // REJECT_CHANGE_REQUEST
    const test = await openCase(browser, url, {
      width: 390,
      height: 844,
      scenario: 'change-request',
      holdPending: true,
    });
    const { page, context, mutations, release, errors, unexpected } = test;
    const drawer = await openDrawer(page);
    await drawer.locator('[data-recovery-decision="REJECT_CHANGE_REQUEST"]').click();
    const fields = drawer.locator('[data-recovery-fields="REJECT_CHANGE_REQUEST"]');
    await drawer.locator('[data-recovery-submit="true"]').click();
    await fields.getByText('Reddetmek için açıklama zorunludur.').waitFor();
    assert.equal(mutations.length, 0);
    await fields.getByLabel('Reddetme açıklaması').fill('Müşteri mevcut teslimat saatini onayladı.');
    await capture(page, 'decision-reject-drawer');
    await drawer.locator('[data-recovery-submit="true"]').click();
    await drawer.getByRole('button', { name: 'Kaydediliyor…' }).waitFor();
    release();
    const receipt = page.locator('[data-job-detail-section="feedback"]');
    await receipt.getByText('Öneri reddedildi. İş bilgileri değişmedi.').waitFor();
    await capture(page, 'decision-reject-success');
    assert.equal(mutations.length, 1);
    assert.equal(mutations[0].body.resolution, 'REJECTED');
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    results.rejectChangeRequest = { validationOnEmpty: true, committed: true };
    await context.close();
  }

  {
    // CANCEL destructive ReasonDialog replacing drawer without stacking + Vazgeç restoring draft
    const test = await openCase(browser, url, {
      width: 390,
      height: 844,
      scenario: 'change-request',
    });
    const { page, context, mutations, errors, unexpected } = test;
    const drawer = await openDrawer(page);
    await drawer.locator('[data-recovery-decision="CANCEL"]').click();
    await drawer.locator('[data-recovery-cancel-note="true"]').waitFor();
    await capture(page, 'decision-cancel-selected-drawer');

    await drawer.locator('[data-recovery-submit="true"]').click();
    const dialog = page.locator('.reason-dialog[role="dialog"]');
    await dialog.waitFor();
    // Drawer must be hidden/replaced (no stacked form drawers!)
    assert.equal(await page.locator('[data-servora-form-drawer]').count(), 0);
    await capture(page, 'decision-cancel-confirm-dialog');

    await dialog.getByRole('button', { name: 'Vazgeç' }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.locator('[data-servora-form-drawer] [role="dialog"]').waitFor();
    assert.equal(
      await page.locator('[data-servora-form-drawer] input[type="radio"]:checked').inputValue(),
      'CANCEL',
    );

    await page.locator('[data-recovery-submit="true"]').click();
    await dialog.waitFor();
    await dialog.getByLabel('İptal nedeni').fill('Müşteri siparişi telefonla iptal etti.');
    await dialog.getByRole('button', { name: 'İşi iptal et' }).click();
    await page.locator('[data-job-detail-section="feedback"]').getByText('İş iptal edildi.').waitFor();
    assert.equal(mutations.length, 1);
    assert.equal(mutations[0].type, 'CANCEL');
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    results.cancelFlow = { replacedWithoutStacking: true, draftRestoredOnCancel: true, committed: true };
    await context.close();
  }

  // 8. Mobile bottom nav /jobs link works
  {
    const test = await openCase(browser, url, { width: 390, height: 844, scenario: 'change-request' });
    const { page, context, errors, unexpected } = test;
    await page.locator('nav.mobile-bottom-nav a[href="/jobs"]').click();
    await page.waitForURL(url + '/jobs');
    await page.locator('nav.mobile-bottom-nav a[aria-current="page"][href="/jobs"]').waitFor();
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    results.navigation = true;
    await context.close();
  }

  return results;
}

function buildComparisonVsA(bReport) {
  if (!existsSync(baselineEvidenceMeasurements)) return null;
  const aReport = JSON.parse(readFileSync(baselineEvidenceMeasurements, 'utf8'));
  const comparisons = [];
  for (const sampleName of matrixSamples.map((s) => s.name)) {
    const a = aReport.samples?.find((s) => s.name === sampleName);
    const b = bReport.samples?.find((s) => s.name === sampleName);
    if (!a || !b) continue;
    const aMinTarget = Math.min(...a.targets.map((t) => Math.min(t.width, t.height)));
    const bAllTargets = [
      ...b.targets,
      ...(b.drawerTargets ?? []),
      ...(b.drawer?.radioRows ?? []),
      ...(b.drawer?.footerButtons ?? []),
    ];
    const bMinTarget = Math.min(...bAllTargets.map((t) => Math.min(t.width, t.height)));
    comparisons.push({
      name: sampleName,
      viewport: b.viewport,
      baselineA: {
        source: aReport.source,
        documentWidth: a.documentWidth,
        pageActionCount: a.targets.length,
        minTargetPx: aMinTarget,
        transferScrollOverflow: a.transferForm ? a.transferForm.scrollWidth > a.transferForm.clientWidth + 1 : null,
      },
      candidateB: {
        source: bReport.source,
        documentWidth: b.documentWidth,
        pageActionCount: b.targets.length,
        drawerDecisionCount: b.drawer?.radioRows?.length ?? 0,
        minTargetPx: bMinTarget,
        drawerScrollOverflow: b.drawer ? b.drawer.scroller.scrollWidth > b.drawer.scroller.clientWidth + 1 : null,
        gridColumns: b.drawer?.gridColumns ?? null,
      },
      delta: {
        pageActionButtonsReducedFrom: a.targets.length,
        pageActionButtonsTo: b.targets.length,
        overflowMaintainedZero: b.documentWidth <= b.viewport[0] + 1,
        allTargetsAtLeast44Px: bMinTarget >= 44,
        lifecycleOrderPreserved:
          JSON.stringify(a.sections.filter((s) => ['heading', 'lifecycle', 'facts'].includes(s)))
          === JSON.stringify(b.sections.filter((s) => ['heading', 'lifecycle', 'facts'].includes(s))),
      },
    });
  }
  return {
    baselineSource: aReport.source,
    candidateSource: bReport.source,
    comparedAt: new Date().toISOString(),
    comparisons,
  };
}

const vite = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
let browser;
try {
  await vite.listen();
  const url = 'http://127.0.0.1:' + vite.httpServer.address().port;
  browser = await chromium.launch();
  report.browser = browser.version();

  // 1. All 7 MF-11 matrix settings
  for (const sample of matrixSamples) {
    const test = await openCase(browser, url, sample);
    const { page, context } = test;
    await capture(page, sample.name);
    const metrics = await pageGeometry(page);
    const sampleReport = { ...sample, ...metrics };
    report.samples.push(sampleReport);

    requireMetric(metrics.documentWidth <= sample.width + 1, sample.name + ': page horizontal overflow');
    requireMetric(
      metrics.sections.indexOf('heading') < metrics.sections.indexOf('lifecycle')
        && metrics.sections.indexOf('lifecycle') < metrics.sections.indexOf('facts'),
      sample.name + ': lifecycle order',
    );
    requireMetric(metrics.navigationLinks.includes('/jobs'), sample.name + ': missing Jobs navigation');
    requireMetric(!metrics.responsibilityNested, sample.name + ': responsibility is nested inside recovery');
    requireMetric(metrics.triggerCount === 1 && metrics.duplicateTriggerCount === 1, sample.name + ': expected single recovery trigger');
    requireMetric(metrics.summaryGaps.headerToSources >= 8 && metrics.summaryGaps.sourcesToButton >= 8, sample.name + ': recovery summary section gaps below 8px');
    for (const target of metrics.targets) {
      requireMetric(target.width >= 44 && target.height >= 44, sample.name + ': page target below 44 CSS px: ' + target.label);
    }

    if (!baseline) {
      const drawer = await openDrawer(page);
      const dGeom = await drawerGeometry(page);
      const dTargets = await overlayTargets(drawer);
      sampleReport.drawer = dGeom;
      sampleReport.drawerTargets = dTargets;

      requireMetric(
        dGeom.header.titleWidth >= 120 && dGeom.header.closeWidth <= dGeom.header.width / 2,
        sample.name + ': drawer close control crowds the title',
      );
      requireMetric(
        dGeom.scroller.scrollWidth <= dGeom.scroller.clientWidth + 1
          && dGeom.formOverflow.scrollWidth <= dGeom.formOverflow.clientWidth + 1,
        sample.name + ': drawer horizontal overflow',
      );
      requireMetric(dGeom.nestedPermanentCards === 0, sample.name + ': repeated nested permanent cards inside drawer');

      if (sample.name === 'desktop') {
        requireMetric(dGeom.drawerWidth > 600, 'desktop: wider drawer expected, got ' + dGeom.drawerWidth);
        requireMetric(dGeom.twoColumnSideBySide, 'desktop: 2-column .manager-recovery-grid not side-by-side');
        requireMetric(
          dGeom.sectionGaps.contextToMainHorizontal !== null && dGeom.sectionGaps.contextToMainHorizontal >= 16,
          'desktop: column gap below 16px',
        );
      } else {
        requireMetric(
          dGeom.sectionGaps.contextToMainVertical !== null && dGeom.sectionGaps.contextToMainVertical >= 12,
          sample.name + ': context-to-main vertical gap below 12px',
        );
      }
      requireMetric(
        dGeom.sectionGaps.decisionsToNext !== null && dGeom.sectionGaps.decisionsToNext >= 12,
        sample.name + ': decisions gap below 12px',
      );
      requireMetric(
        dGeom.sectionGaps.fieldsToPreview !== null && dGeom.sectionGaps.fieldsToPreview >= 12,
        sample.name + ': fields-to-preview gap below 12px',
      );
      requireMetric(
        dGeom.sectionGaps.previewToFooter !== null && dGeom.sectionGaps.previewToFooter >= 12,
        sample.name + ': preview-to-footer gap below 12px',
      );

      if (sample.textScale) {
        const phonePrimaryFont = report.samples.find(({ name }) => name === 'phone')?.drawer?.primaryFont ?? 14;
        requireMetric(
          dGeom.primaryFont >= phonePrimaryFont * 2,
          sample.name + ': primary button text did not scale to 200%',
        );
      }

      for (const t of [...dTargets, ...dGeom.radioRows, ...dGeom.footerButtons]) {
        requireMetric(t.width >= 44 && t.height >= 44, sample.name + ': drawer target below 44 CSS px: ' + t.label);
      }

      await capture(page, sample.name + '-drawer');

      const footerReach = await verifyFooterReachable(page);
      sampleReport.footerReachable = footerReach;
      requireMetric(
        footerReach.hitTargetOk && footerReach.inViewport,
        sample.name + ': drawer footer submit not reachable or obscured',
      );
      if (sample.textScale || sample.dpr) {
        await capture(page, sample.name + '-drawer-footer');
      }

      await drawer.getByRole('button', { name: 'Vazgeç' }).click();
    }

    requireMetric(test.errors.length === 0, sample.name + ': ' + test.errors.join(', '));
    requireMetric(test.unexpected.length === 0, sample.name + ': ' + test.unexpected.join(', '));
    await context.close();
  }

  // 2. Entry cases on phone & desktop (declined offer, coexisting sources, started job)
  if (!baseline) {
    for (const entry of entrySamples) {
      const test = await openCase(browser, url, entry);
      const { page, context } = test;
      await capture(page, entry.name);
      const metrics = await pageGeometry(page);
      const entryReport = { ...entry, ...metrics };
      report.entryCases.push(entryReport);

      requireMetric(metrics.documentWidth <= entry.width + 1, entry.name + ': page overflow');
      requireMetric(metrics.triggerCount === 1 && metrics.duplicateTriggerCount === 1, entry.name + ': duplicate recovery CTA');
      if (entry.scenario === 'coexisting') {
        requireMetric(
          metrics.hasOfferSource && metrics.hasChangeRequestSource,
          entry.name + ': missing coexisting offer/change-request source block',
        );
      }

      const drawer = await openDrawer(page);
      if (entry.scenario === 'coexisting') {
        assert.equal(await drawer.locator('[data-recovery-source="offer"]').count(), 1);
        assert.equal(await drawer.locator('[data-recovery-source="change-request"]').count(), 1);
      }
      if (entry.scenario === 'started-change-request') {
        assert.equal(await drawer.locator('[data-recovery-decision="ACCEPT_PROPOSED_TIME"]').count(), 0);
        assert.equal(await drawer.locator('[data-recovery-decision="REASSIGN_KEEP_TIME"]').count(), 0);
        assert.equal(await drawer.locator('[data-recovery-decision="REOFFER"]').count(), 0);
        await drawer.locator('[data-recovery-unavailable="true"]').getByText(/İş başlatıldığı için/).waitFor();
      }
      const dGeom = await drawerGeometry(page);
      entryReport.drawer = dGeom;
      requireMetric(
        dGeom.scroller.scrollWidth <= dGeom.scroller.clientWidth + 1,
        entry.name + ': drawer overflow',
      );
      await capture(page, entry.name + '-drawer');
      requireMetric(test.errors.length === 0, entry.name + ': ' + test.errors.join(', '));
      requireMetric(test.unexpected.length === 0, entry.name + ': ' + test.unexpected.join(', '));
      await context.close();
    }

    // 3. Conditional fields & full interactive flows
    report.interactions = await runDecisionInteractions(browser, url);
  }

  report.completed = true;
} finally {
  report.issues = issues;
  writeFileSync(resolve(evidence, 'measurements.json'), JSON.stringify(report, null, 2) + '\n');
  if (!baseline) {
    const comparison = buildComparisonVsA(report);
    if (comparison) {
      writeFileSync(resolve(evidence, 'comparison-vs-a.json'), JSON.stringify(comparison, null, 2) + '\n');
    }
  }
  await browser?.close();
  await vite.close();
}

assert.deepEqual(issues, []);
