/**
 * UI-003 / Connected Workflows acceptance for RESCUE-004/A Calendar
 * staffReservationReleased presentation, using the real app entry, AppShell,
 * production CSS, and deterministic mock API boundary.
 *
 * Run from web/:
 *   FLEET_EVIDENCE_DIR=/absolute/output RESCUE_004A_SOURCE=<sha> \
 *   node scripts/rescue-004a-calendar-acceptance.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

import { collectSubMinimumText } from './min-text-size.mjs';

const evidenceDir = resolve(
  process.env.FLEET_EVIDENCE_DIR ?? '.ui-evidence/rescue-004a',
);
mkdirSync(evidenceDir, { recursive: true });

const fixedClock = '2026-11-26T09:00:00.000Z';
const timezone = 'Europe/Istanbul';

const staff = { id: '33333333-3333-4333-8333-333333333333', name: 'Ayşe Personel' };
const successor = { id: '66666666-6666-4666-8666-666666666666', name: 'Deniz Personel' };
const customerId = '55555555-5555-4555-8555-555555555555';

function makeUser(calendarEnabled = true) {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    name: 'Murat Yönetici',
    email: 'murat@example.invalid',
    role: 'MANAGER',
    mustChangePassword: false,
    isActive: true,
    version: 1,
    capabilities: {
      overviewDashboard: true,
      calendar: calendarEnabled,
      messaging: false,
    },
    support: { displayLabel: 'Destek', email: null, helpUrl: null },
  };
}

const releasedJobId = '11111111-1111-4111-8111-111111111111';
const reservedJobId = '22222222-2222-4222-8222-222222222222';
const legacyJobId = '77777777-7777-4777-8777-777777777777';
const manualEventId = '88888888-8888-4888-8888-888888888888';

function createInitialEvents() {
  return [
    {
      id: releasedJobId,
      source: 'JOB',
      title: 'Anadolu Dental ürün teslimi',
      startsAt: '2026-11-26T09:30:00.000Z',
      endsAt: '2026-11-26T10:30:00.000Z',
      timezone,
      assignedUser: staff,
      version: 4,
      canEdit: true,
      canCancel: false,
      jobCardId: releasedJobId,
      jobType: 'PRODUCT_DELIVERY',
      jobStatus: 'NEW',
      priority: 'normal',
      customer: { id: customerId, name: 'Anadolu Dental Polikliniği' },
      relatedJobPath: `/jobs/${releasedJobId}`,
      followUpContext: null,
      staffReservationReleased: true,
      offerState: 'DECLINED',
    },
    {
      id: reservedJobId,
      source: 'JOB',
      title: 'Ege Dental cihaz sunumu',
      startsAt: '2026-11-26T11:30:00.000Z',
      endsAt: '2026-11-26T12:30:00.000Z',
      timezone,
      assignedUser: successor,
      version: 2,
      canEdit: true,
      canCancel: false,
      jobCardId: reservedJobId,
      jobType: 'SALES_MEETING',
      jobStatus: 'ACCEPTED',
      priority: 'normal',
      customer: { id: customerId, name: 'Ege Dental Merkezi' },
      relatedJobPath: `/jobs/${reservedJobId}`,
      followUpContext: null,
      staffReservationReleased: false,
    },
    {
      // Intentionally omits staffReservationReleased to prove legacy server compatibility
      id: legacyJobId,
      source: 'JOB',
      title: 'Marmara Dental eski sunucu planı',
      startsAt: '2026-11-26T06:00:00.000Z',
      endsAt: '2026-11-26T07:00:00.000Z',
      timezone,
      assignedUser: staff,
      version: 1,
      canEdit: true,
      canCancel: false,
      jobCardId: legacyJobId,
      jobType: 'SALES_MEETING',
      jobStatus: 'NEW',
      priority: 'normal',
      customer: { id: customerId, name: 'Marmara Dental' },
      relatedJobPath: `/jobs/${legacyJobId}`,
      followUpContext: null,
    },
    {
      id: manualEventId,
      source: 'MANUAL',
      title: 'Klinik stok sayımı',
      description: 'Depo kontrolü',
      startsAt: '2026-11-27T08:00:00.000Z',
      endsAt: '2026-11-27T09:00:00.000Z',
      timezone,
      assignedUser: staff,
      version: 1,
      canEdit: true,
      canCancel: true,
      status: 'ACTIVE',
      createdBy: staff,
      updatedBy: staff,
    },
  ];
}

function makeJobDetail(event, { assignmentWindowEnabled = true } = {}) {
  let assignmentOffer = null;
  if (assignmentWindowEnabled) {
    if (event.offerState === 'DECLINED') {
      assignmentOffer = {
        id: '99999999-9999-4999-8999-999999999999',
        state: 'DECLINED',
        openedAt: '2026-11-25T12:00:00.000Z',
        acceptanceDueAt: '2026-11-26T08:00:00.000Z',
        urgentReason: null,
        assignee: event.assignedUser,
        closedAt: '2026-11-26T07:30:00.000Z',
        closeReason: 'OUT_OF_TOWN',
        closeText: 'Şehir dışındayım.',
        suggestedSolution: 'REASSIGN',
        proposedScheduledAt: null,
        proposedScheduledEndsAt: null,
        proposalAcceptedAt: null,
      };
    } else if (event.offerState === 'OPEN') {
      assignmentOffer = {
        id: '99999999-9999-4999-8999-999999999998',
        state: 'OPEN',
        openedAt: fixedClock,
        acceptanceDueAt: '2026-11-27T14:00:00.000Z',
        urgentReason: null,
        assignee: event.assignedUser,
        closedAt: null,
        closeReason: null,
        closeText: null,
        suggestedSolution: null,
        proposedScheduledAt: null,
        proposedScheduledEndsAt: null,
        proposalAcceptedAt: null,
      };
    }
  }
  return {
    id: event.jobCardId,
    organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    organizationTimezone: timezone,
    type: event.jobType,
    status: event.jobStatus,
    version: event.version,
    engagementKind: event.jobType === 'SALES_MEETING' ? 'CUSTOMER_VISIT' : null,
    title: event.title,
    description: null,
    customerId,
    contactId: null,
    customer: event.customer,
    contact: null,
    assignedTo: event.assignedUser.id,
    assignee: event.assignedUser,
    createdBy: '44444444-4444-4444-8444-444444444444',
    priority: event.priority,
    dueDate: null,
    scheduledAt: event.startsAt,
    scheduledEndsAt: event.endsAt,
    followUpContext: null,
    hasOpenOverdueIncident: false,
    correctionDueAt: null,
    assignmentOffer,
    changeRequest: null,
    workflowContext: {
      allowedCommands: ['CANCEL'],
      allowedActions: ['EDIT_JOB_FIELDS', 'VIEW_NOTES'],
      lifecycle: {
        createdAt: '2026-11-25T12:00:00.000Z',
        acceptedAt: event.jobStatus === 'ACCEPTED' ? '2026-11-25T13:00:00.000Z' : null,
        acceptedBy: event.jobStatus === 'ACCEPTED' ? event.assignedUser : null,
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
      },
      submissionReadiness: null,
    },
  };
}

function makeJobListItem(event) {
  return {
    id: event.jobCardId,
    type: event.jobType,
    status: event.jobStatus,
    version: event.version,
    title: event.title,
    priority: event.priority,
    dueDate: null,
    scheduledAt: event.startsAt,
    scheduledEndsAt: event.endsAt,
    engagementKind: event.jobType === 'SALES_MEETING' ? 'CUSTOMER_VISIT' : null,
    createdAt: '2026-11-25T12:00:00.000Z',
    updatedAt: '2026-11-26T07:30:00.000Z',
    staffCompletedAt: null,
    customer: event.customer,
    contact: null,
    assignee: event.assignedUser,
    deliveryItemCount: 0,
    allowedCommands: ['CANCEL'],
  };
}

const emptyList = { items: [], total: 0, limit: 25, offset: 0, nextCursor: null };

const viewportModes = [
  { name: '320', width: 320, height: 800, compact: true, screenshot: 'calendar-320.png' },
  { name: '390', width: 390, height: 844, compact: true, screenshot: 'calendar-390.png' },
  { name: '768', width: 768, height: 1024, compact: false, screenshot: 'calendar-768.png' },
  { name: '1440', width: 1440, height: 900, compact: false, screenshot: 'calendar-1440.png' },
  { name: '200pct', width: 390, height: 844, compact: true, textScale: 200, screenshot: 'calendar-200pct-390.png' },
  { name: '400pct-reflow', width: 320, height: 225, dpr: 4, compact: true, screenshot: 'calendar-400pct-reflow-320.png' },
  { name: 'reduced-motion', width: 390, height: 844, compact: true, motion: 'reduce', screenshot: 'calendar-reduced-motion-390.png' },
];

const report = {
  slice: 'RESCUE-004/A',
  source: process.env.RESCUE_004A_SOURCE ?? 'working tree',
  fixedClock,
  timezone,
  locale: 'tr-TR',
  mockedServices: [
    'All /api/* endpoints via Playwright route interception',
    'EventSource disabled (realtime offline)',
    'Service worker blocked',
  ],
  screenshots: [],
  viewports: [],
  interactions: {},
  windowOffScenario: {},
  moduleOff: {},
  issues: [],
};

function requireCheck(condition, message) {
  if (!condition) report.issues.push(message);
}

async function captureScreenshot(page, filename, { fullPage = true } = {}) {
  await page.screenshot({ path: resolve(evidenceDir, filename), fullPage });
  if (!report.screenshots.includes(filename)) {
    report.screenshots.push(filename);
  }
}

async function measureOverlayTargets(container, selector) {
  return container.locator(selector).evaluateAll((elements) => elements.map((element) => {
    const rect = element.getBoundingClientRect();
    return {
      label: element.getAttribute('aria-label') || element.textContent?.trim() || element.id || element.tagName,
      width: Math.round(rect.width * 100) / 100,
      height: Math.round(rect.height * 100) / 100,
    };
  }));
}

async function setupCalendarPage(browser, url, options = {}) {
  const calendarEnabled = options.calendarEnabled ?? true;
  const assignmentWindowEnabled = options.assignmentWindowEnabled ?? true;
  const user = makeUser(calendarEnabled);
  const events = createInitialEvents();
  const context = await browser.newContext({
    viewport: { width: options.width ?? 1440, height: options.height ?? 900 },
    deviceScaleFactor: options.dpr ?? 1,
    locale: 'tr-TR',
    timezoneId: timezone,
    reducedMotion: options.motion ?? 'no-preference',
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  const errors = [];
  const unexpectedRequests = [];
  const apiCalls = [];
  const patches = [];
  let conflictRemaining = options.conflictCount ?? 0;
  let releasePendingPatch;
  const pendingPatchGate = new Promise((resolveGate) => {
    releasePendingPatch = resolveGate;
  });

  page.on('pageerror', (err) => errors.push(err.message));
  await page.addInitScript(() => {
    Object.defineProperty(window, 'EventSource', { configurable: true, value: undefined });
  });
  await page.clock.setFixedTime(new Date(fixedClock));

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const method = request.method();
    const pathname = new URL(request.url()).pathname;
    apiCalls.push(`${method} ${pathname}`);
    const send = (json, status = 200) => route.fulfill({ json, status });

    if (method === 'GET' && pathname === '/api/auth/me') return send({ user });
    if (method === 'GET' && pathname === '/api/notifications/unread-count') return send({ unreadCount: 0 });
    if (method === 'GET' && pathname === '/api/notifications') return send(emptyList);
    if (method === 'GET' && pathname === '/api/web-push/status') {
      return send({ enabled: false, subscribed: false, vapidPublicKey: null });
    }
    if (method === 'POST' && pathname === '/api/notifications/read-by-entity') return send({ markedCount: 0 });

    const toCalendarDto = ({ offerState: _offerState, ...event }) => event;

    if (method === 'GET' && pathname === '/api/calendar') {
      if (!calendarEnabled) {
        return send({ code: 'MODULE_DISABLED', error: 'Takvim modülü kapalı.' }, 403);
      }
      return send({ items: events.map(toCalendarDto) });
    }
    if (method === 'GET' && pathname === '/api/calendar/assignees') {
      return send({ items: [staff, successor] });
    }
    if (method === 'GET' && pathname.startsWith('/api/calendar/events/')) {
      const id = pathname.split('/').pop();
      const found = events.find((e) => e.id === id);
      return found ? send(toCalendarDto(found)) : send({ code: 'NOT_FOUND', error: 'Bulunamadı.' }, 404);
    }
    if (method === 'POST' && pathname === '/api/job-cards/available-slots') {
      return send({
        slots: [{ startsAt: '2026-11-26T14:00:00.000Z', endsAt: '2026-11-26T15:00:00.000Z' }],
      });
    }
    if (method === 'POST' && pathname === '/api/job-cards/customer-schedule/evaluate') {
      return send({ level: 'CLEAR', safeMessage: null, conflicts: [], recentVisit: null, suggestedAlternativeAt: null });
    }
    if (method === 'GET' && pathname === '/api/staff') {
      return send(
        [staff, successor].map((person) => ({
          id: person.id,
          version: 1,
          user: {
            ...user,
            ...person,
            email: `${person.id}@example.invalid`,
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
          counters: { open: 0, waitingApproval: 0, revisionRequested: 0, completedThisMonth: 0, overdue: 0 },
        })),
      );
    }
    if (method === 'GET' && pathname === '/api/customers') {
      return send({
        items: [{
          id: customerId,
          organizationId: user.organizationId,
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
          openJobCount: 1,
          completedJobCount: 0,
        }],
        total: 1,
        limit: 20,
        offset: 0,
        nextCursor: null,
      });
    }
    if (method === 'GET' && pathname === `/api/customers/${customerId}`) {
      return send({
        id: customerId,
        organizationId: user.organizationId,
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
        openJobCount: 1,
        completedJobCount: 0,
      });
    }
    if (method === 'GET' && pathname === '/api/job-cards') {
      const jobItems = events.filter((e) => e.source === 'JOB').map(makeJobListItem);
      return send({
        items: jobItems,
        total: jobItems.length,
        limit: 25,
        offset: 0,
        nextCursor: null,
      });
    }
    if (method === 'GET' && pathname.startsWith('/api/job-cards/')) {
      const parts = pathname.split('/');
      const id = parts[3];
      if (parts.length === 4) {
        const found = events.find((e) => e.jobCardId === id);
        return found
          ? send(makeJobDetail(found, { assignmentWindowEnabled }))
          : send({ code: 'NOT_FOUND', error: 'Bulunamadı.' }, 404);
      }
      if (pathname.endsWith('/submission-lateness')) return send({ open: null });
      if (pathname.endsWith('/sale-create-context')) {
        return send({
          sourceVisitId: id,
          sourceVersion: 1,
          eligible: false,
          blockedReason: 'SOURCE_NOT_ELIGIBLE',
          customer: { id: customerId, name: 'Anadolu Dental Polikliniği' },
          assignee: staff,
          plannedContact: null,
          metContact: null,
          activeSale: null,
        });
      }
      return send(emptyList);
    }
    if (method === 'PATCH' && pathname.startsWith('/api/job-cards/')) {
      const id = pathname.split('/')[3];
      const body = request.postDataJSON();
      patches.push({ id, body });
      if (conflictRemaining > 0) {
        conflictRemaining -= 1;
        return send({
          code: 'CALENDAR_CONFLICT',
          error: 'Bu zaman aralığı başka bir planla çakışıyor.',
          details: {
            conflicts: [{
              id: 'conflict-1',
              title: 'Klinik Cihaz Eğitimi',
              startsAt: '2026-11-26T10:30:00.000Z',
            }],
          },
        }, 409);
      }
      if (options.holdPatch) {
        await pendingPatchGate;
      }
      const idx = events.findIndex((e) => e.jobCardId === id);
      if (idx >= 0) {
        const prev = events[idx];
        const nextStartsAt = body.scheduledAt ?? prev.startsAt;
        const nextEndsAt = body.scheduledAt
          ? new Date(new Date(body.scheduledAt).getTime() + 60 * 60_000).toISOString()
          : prev.endsAt;
        const nextAssigneeId = body.assignedTo ?? prev.assignedUser.id;
        const nextAssignee = [staff, successor].find((person) => person.id === nextAssigneeId) ?? prev.assignedUser;
        const scheduleChanged = nextStartsAt !== prev.startsAt;
        const assigneeChanged = nextAssignee.id !== prev.assignedUser.id;
        const reacquiredOnWindowOn = assignmentWindowEnabled && (scheduleChanged || assigneeChanged);
        events[idx] = {
          ...prev,
          version: prev.version + 1,
          assignedUser: nextAssignee,
          startsAt: nextStartsAt,
          endsAt: nextEndsAt,
          offerState: reacquiredOnWindowOn ? 'OPEN' : prev.offerState,
          staffReservationReleased: reacquiredOnWindowOn ? false : prev.staffReservationReleased,
        };
        return send(makeJobDetail(events[idx], { assignmentWindowEnabled }));
      }
      return send({ code: 'NOT_FOUND', error: 'Bulunamadı.' }, 404);
    }
    if (
      method === 'GET'
      && (pathname === '/api/job-cards/change-requests/open'
        || pathname.endsWith('/assignment-offers/needs-action')
        || pathname === '/api/job-cards/pending-acceptance/past-start'
        || pathname.endsWith('/overview')
        || pathname === '/api/overview')
    ) {
      return send(emptyList);
    }

    unexpectedRequests.push(`${method} ${pathname}`);
    return send({ code: 'UNMOCKED', error: `Unexpected ${method} ${pathname}` }, 500);
  });

  await page.goto(`${url}${options.path ?? '/calendar'}`, { waitUntil: 'networkidle' });
  if (calendarEnabled && (options.path ?? '/calendar').startsWith('/calendar')) {
    await page.locator('.servora-calendar-root').waitFor();
    await page.locator('.calendar-event-card').first().waitFor();
  }
  return {
    context,
    page,
    errors,
    unexpectedRequests,
    apiCalls,
    patches,
    releasePatch: () => releasePendingPatch?.(),
  };
}

async function measureCalendar(page, mode) {
  return page.evaluate((currentMode) => {
    const docOverflow = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
    const targets = [];
    const targetSelectors = [
      '.servora-calendar-header button',
      '#calendar-personnel-filter',
      '.calendar-event-actions button',
      '.calendar-event-actions a',
      '.page-create-action',
      '.desktop-shell-topbar button',
      '.mobile-bottom-nav a',
      '.mobile-bottom-nav button',
      '.mobile-top-bar button',
      '.mobile-top-bar a',
    ];
    if (!currentMode.compact) {
      targetSelectors.push('.servora-calendar-event-summary');
    }
    for (const selector of targetSelectors) {
      for (const el of document.querySelectorAll(selector)) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        targets.push({
          selector,
          label: el.getAttribute('aria-label') || el.textContent?.trim() || selector,
          width: Math.round(rect.width * 100) / 100,
          height: Math.round(rect.height * 100) / 100,
        });
      }
    }

    const dayGridDateButtons = [...document.querySelectorAll('.servora-calendar-date')]
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          label: el.textContent?.trim() ?? '',
          width: Math.round(rect.width * 100) / 100,
          height: Math.round(rect.height * 100) / 100,
          minHeightCss: getComputedStyle(el).minHeight,
        };
      })
      .filter((entry) => entry.width > 0 && entry.height > 0);
    const compactNativeDateCells = [...document.querySelectorAll('.servora-calendar--compact [class*="picker-calendar-date"]')]
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          label: el.querySelector('[class*="picker-calendar-date-value"]')?.textContent?.trim() ?? '',
          width: Math.round(rect.width * 100) / 100,
          height: Math.round(rect.height * 100) / 100,
        };
      })
      .filter((entry) => entry.width > 0 && entry.height > 0);
    const renderedChipDimensions = [...document.querySelectorAll('.servora-calendar-event-summary')]
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          eventId: el.getAttribute('data-event-id'),
          width: Math.round(rect.width * 100) / 100,
          height: Math.round(rect.height * 100) / 100,
          minHeightCss: getComputedStyle(el).minHeight,
        };
      });

    const samplePageCreate = document.querySelector('.page-create-action');
    const sampleActionButton = document.querySelector('.calendar-event-actions button');
    const sampleActionLink = document.querySelector('.calendar-event-actions a');
    const sampleHeading = document.querySelector('.calendar-agenda-heading');
    const sampleTransitionEl = document.querySelector('.calendar-help a, .servora-calendar-item');
    const rootFontPx = Math.round(Number.parseFloat(getComputedStyle(document.documentElement).fontSize) * 100) / 100;
    const pageCreateFontPx = samplePageCreate && getComputedStyle(samplePageCreate).display !== 'none'
      ? Math.round(Number.parseFloat(getComputedStyle(samplePageCreate).fontSize) * 100) / 100
      : null;
    const calendarActionButtonFontPx = sampleActionButton
      ? Math.round(Number.parseFloat(getComputedStyle(sampleActionButton).fontSize) * 100) / 100
      : null;
    const calendarActionLinkFontPx = sampleActionLink
      ? Math.round(Number.parseFloat(getComputedStyle(sampleActionLink).fontSize) * 100) / 100
      : null;
    const agendaHeadingFontPx = sampleHeading
      ? Math.round(Number.parseFloat(getComputedStyle(sampleHeading).fontSize) * 100) / 100
      : null;
    const reducedMotionMatches = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const computedTransitionDuration = sampleTransitionEl ? getComputedStyle(sampleTransitionEl).transitionDuration : null;

    const colorCanvas = document.createElement('canvas');
    colorCanvas.width = 1;
    colorCanvas.height = 1;
    const colorCtx = colorCanvas.getContext('2d');
    const resolveRgba = (cssColor) => {
      if (!colorCtx || !cssColor) return null;
      colorCtx.clearRect(0, 0, 1, 1);
      colorCtx.fillStyle = 'rgba(0, 0, 0, 0)';
      colorCtx.fillStyle = cssColor;
      colorCtx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = colorCtx.getImageData(0, 0, 1, 1).data;
      return { r, g, b, a: a / 255 };
    };
    const compositeOver = (fg, bg) => {
      const alpha = fg.a;
      return {
        r: Math.round(fg.r * alpha + bg.r * (1 - alpha)),
        g: Math.round(fg.g * alpha + bg.g * (1 - alpha)),
        b: Math.round(fg.b * alpha + bg.b * (1 - alpha)),
        a: 1,
      };
    };
    const effectiveBg = (el) => {
      const chain = [];
      for (let node = el; node; node = node.parentElement) {
        const parsed = resolveRgba(getComputedStyle(node).backgroundColor);
        if (parsed && parsed.a > 0) chain.push(parsed);
        if (parsed && parsed.a >= 0.999) break;
      }
      let current = { r: 255, g: 255, b: 255, a: 1 };
      for (let i = chain.length - 1; i >= 0; i -= 1) {
        current = compositeOver(chain[i], current);
      }
      return current;
    };
    const luminance = ({ r, g, b }) => {
      const lin = (v) => {
        const s = v / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    };
    const contrastRatio = (fg, bg) => {
      const l1 = luminance(fg);
      const l2 = luminance(bg);
      return Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100;
    };

    const jobLinks = [...document.querySelectorAll('.calendar-event-actions a[href^="/jobs/"]')].map((link) => {
      const style = getComputedStyle(link);
      const rect = link.getBoundingClientRect();
      const parentRect = link.parentElement?.getBoundingClientRect();
      const rawFg = resolveRgba(style.color);
      const bgRgb = effectiveBg(link);
      const fgRgb = rawFg && rawFg.a < 1 ? compositeOver(rawFg, bgRgb) : rawFg;
      return {
        label: link.textContent?.trim() ?? '',
        href: link.getAttribute('href') ?? '',
        display: style.display,
        fgCss: style.color,
        bgCss: style.backgroundColor,
        fgRgb: fgRgb ? [fgRgb.r, fgRgb.g, fgRgb.b] : null,
        bgRgb: [bgRgb.r, bgRgb.g, bgRgb.b],
        contrastRatio: fgRgb ? contrastRatio(fgRgb, bgRgb) : 0,
        width: Math.round(rect.width * 100) / 100,
        height: Math.round(rect.height * 100) / 100,
        actionBarWidth: parentRect ? Math.round(parentRect.width * 100) / 100 : null,
      };
    });

    const cards = [...document.querySelectorAll('.calendar-event-card')].map((card) => ({
      title: card.querySelector('h3')?.textContent?.trim() ?? '',
      releasedClass: card.classList.contains('calendar-event-card--released'),
      hasBadge: Boolean(card.querySelector('.calendar-released-badge')),
      badgeText: card.querySelector('.calendar-released-badge')?.textContent?.trim() ?? null,
      hasBadgeIcon: Boolean(card.querySelector('.calendar-released-badge svg[aria-hidden="true"]')),
      hasReleasedNote: Boolean(card.querySelector('.calendar-event-released-note')),
      noteText: card.querySelector('.calendar-event-released-note')?.textContent?.trim() ?? null,
      hasOpenLink: Boolean(card.querySelector('a[href^="/jobs/"]')),
      hasEditButton: [...card.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Düzenle'),
    }));

    const desktopChips = [...document.querySelectorAll('.servora-calendar-event-summary')].map((chip) => ({
      eventId: chip.getAttribute('data-event-id'),
      released: chip.getAttribute('data-reservation-released') === 'true',
      releasedClass: chip.classList.contains('servora-calendar-event-summary--released'),
      statusText: chip.querySelector('.servora-calendar-event-status')?.textContent?.trim() ?? null,
      hasStatusIcon: Boolean(chip.querySelector('.servora-calendar-event-status svg[aria-hidden="true"]')),
      ariaLabel: chip.getAttribute('aria-label'),
    }));

    const compactAttentionCount = document.querySelector('.servora-calendar-count--attention');
    const compactDateValue = compactAttentionCount
      ?.closest('[class*="picker-calendar-date"]')
      ?.querySelector('[class*="picker-calendar-date-value"]');
    let compactCountOverlap = false;
    if (compactAttentionCount && compactDateValue) {
      const a = compactAttentionCount.getBoundingClientRect();
      const b = compactDateValue.getBoundingClientRect();
      compactCountOverlap = a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
    }

    return {
      mode: currentMode.name,
      viewport: [currentMode.width, currentMode.height],
      dpr: window.devicePixelRatio,
      rootFontPx,
      pageCreateFontPx,
      calendarActionButtonFontPx,
      calendarActionLinkFontPx,
      agendaHeadingFontPx,
      reducedMotionMatches,
      computedTransitionDuration,
      documentScrollWidth: document.documentElement.scrollWidth,
      documentClientWidth: document.documentElement.clientWidth,
      overflowX: docOverflow,
      targets,
      minTargetPx: targets.length ? Math.min(...targets.map((t) => Math.min(t.width, t.height))) : 0,
      dayGridConstraints: {
        note: 'Untouched C1 day-number buttons (.servora-calendar-date, min-height: 0) and compact mobile native cells are tracked separately from touched --control-height (>=44px) .servora-calendar-event-summary event chips.',
        dateButtonsCount: dayGridDateButtons.length,
        dateButtonMinHeightPx: dayGridDateButtons.length ? Math.min(...dayGridDateButtons.map((d) => d.height)) : null,
        dateButtonSample: dayGridDateButtons.slice(0, 3),
        compactNativeDateCellsCount: compactNativeDateCells.length,
        compactNativeDateCellMinHeightPx: compactNativeDateCells.length
          ? Math.min(...compactNativeDateCells.map((d) => d.height))
          : null,
        compactNativeDateCellSample: compactNativeDateCells.slice(0, 3),
        renderedChipDimensions,
      },
      cards,
      jobLinks,
      desktopChips,
      compactAttention: compactAttentionCount
        ? {
            text: compactAttentionCount.textContent?.trim() ?? '',
            ariaLabel: compactAttentionCount.getAttribute('aria-label'),
            overlapWithDate: compactCountOverlap,
          }
        : null,
    };
  }, mode);
}

const vite = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
let browser;

try {
  await vite.listen();
  const url = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  report.browser = browser.version();

  // 1. All 7 viewport/accessibility modes
  for (const mode of viewportModes) {
    const session = await setupCalendarPage(browser, url, mode);
    const { page, context, errors, unexpectedRequests } = session;

    if (mode.textScale) {
      await page.addStyleTag({ content: `html { font-size: ${mode.textScale}% !important; }` });
    }

    const metrics = await measureCalendar(page, mode);
    const subMinText = await page.evaluate(collectSubMinimumText, { min: 12 });
    metrics.subMinimumText = subMinText;
    report.viewports.push(metrics);

    await captureScreenshot(page, mode.screenshot);

    requireCheck(!metrics.overflowX, `${mode.name}: horizontal overflow (${metrics.documentScrollWidth} > ${metrics.documentClientWidth})`);
    requireCheck(subMinText.length === 0, `${mode.name}: text below 12px (${JSON.stringify(subMinText)})`);
    for (const target of metrics.targets) {
      requireCheck(
        target.width >= 44 && target.height >= 44,
        `${mode.name}: target "${target.label}" below 44 CSS px (${target.width}x${target.height})`,
      );
    }

    if (mode.name === '200pct') {
      const baseline390 = report.viewports.find((v) => v.mode === '390');
      const expectedRootPx = (baseline390?.rootFontPx ?? 16) * 2;
      requireCheck(
        metrics.rootFontPx >= expectedRootPx - 0.1,
        `200pct: computed root font-size ${metrics.rootFontPx}px below 200% of ${baseline390?.rootFontPx ?? 16}px`,
      );
      requireCheck(
        (metrics.pageCreateFontPx ?? 0) >= (baseline390?.pageCreateFontPx ?? 16) * 2 - 0.1,
        `200pct: computed .page-create-action font-size ${metrics.pageCreateFontPx}px did not scale from ${baseline390?.pageCreateFontPx ?? 16}px to 200%`,
      );
      requireCheck(
        (metrics.calendarActionButtonFontPx ?? 0) >= (baseline390?.calendarActionButtonFontPx ?? 16) * 2 - 0.1,
        `200pct: computed .calendar-event-actions button font-size ${metrics.calendarActionButtonFontPx}px did not scale from ${baseline390?.calendarActionButtonFontPx ?? 16}px to 200%`,
      );
      requireCheck(
        (metrics.calendarActionLinkFontPx ?? 0) >= (baseline390?.calendarActionLinkFontPx ?? 16) * 2 - 0.1,
        `200pct: computed .calendar-event-actions a font-size ${metrics.calendarActionLinkFontPx}px did not scale from ${baseline390?.calendarActionLinkFontPx ?? 16}px to 200%`,
      );
      requireCheck(
        (metrics.agendaHeadingFontPx ?? 0) >= (baseline390?.agendaHeadingFontPx ?? 16) * 2 - 0.1,
        `200pct: computed .calendar-agenda-heading font-size ${metrics.agendaHeadingFontPx}px did not scale to 200%`,
      );
    }
    if (mode.name === '400pct-reflow') {
      requireCheck(metrics.dpr === 4, `400pct-reflow: expected dpr 4, got ${metrics.dpr}`);
    }
    if (mode.name === 'reduced-motion') {
      requireCheck(metrics.reducedMotionMatches === true, 'reduced-motion: prefers-reduced-motion media query did not match');
      requireCheck(metrics.computedTransitionDuration === '0s', `reduced-motion: expected 0s transitionDuration, got ${metrics.computedTransitionDuration}`);
    }

    const releasedCard = metrics.cards.find((c) => c.title === 'Anadolu Dental ürün teslimi');
    const reservedCard = metrics.cards.find((c) => c.title === 'Ege Dental cihaz sunumu');
    const legacyCard = metrics.cards.find((c) => c.title === 'Marmara Dental eski sunucu planı');
    requireCheck(Boolean(releasedCard?.releasedClass && releasedCard.hasBadge && releasedCard.hasBadgeIcon && releasedCard.hasReleasedNote && releasedCard.hasOpenLink && releasedCard.hasEditButton), `${mode.name}: released agenda card missing required semantics or actions`);
    requireCheck(Boolean(reservedCard && !reservedCard.releasedClass && !reservedCard.hasBadge && !reservedCard.hasReleasedNote), `${mode.name}: reserved card incorrectly marked released`);
    requireCheck(Boolean(legacyCard && !legacyCard.releasedClass && !legacyCard.hasBadge && !legacyCard.hasReleasedNote), `${mode.name}: legacy card incorrectly marked released`);

    if (mode.name === '390' || mode.name === '1440') {
      requireCheck(metrics.jobLinks.length >= 3, `${mode.name}: expected >= 3 calendar job links, got ${metrics.jobLinks.length}`);
      for (const link of metrics.jobLinks) {
        requireCheck(
          link.contrastRatio >= 4.5,
          `${mode.name}: job link "${link.label}" contrast ${link.contrastRatio} < 4.5 (fg=${JSON.stringify(link.fgRgb)}, bg=${JSON.stringify(link.bgRgb)})`,
        );
        requireCheck(
          link.display === 'flex' || link.display === 'inline-flex',
          `${mode.name}: job link "${link.label}" display=${link.display}, expected flex/inline-flex`,
        );
        if (mode.name === '1440') {
          requireCheck(
            link.actionBarWidth !== null && link.width < link.actionBarWidth - 20,
            `${mode.name}: job link "${link.label}" width ${link.width} should remain content-sized inside ${link.actionBarWidth}`,
          );
        } else {
          requireCheck(
            link.actionBarWidth !== null && Math.abs(link.width - link.actionBarWidth) <= 1,
            `${mode.name}: job link "${link.label}" width ${link.width} should fill stacked mobile action bar (${link.actionBarWidth})`,
          );
        }
      }
    }

    if (mode.compact) {
      requireCheck(Boolean(metrics.compactAttention && metrics.compactAttention.text === '3' && /müdahale gerekiyor/i.test(metrics.compactAttention.ariaLabel ?? '')), `${mode.name}: compact attention cell missing`);
      requireCheck(!metrics.compactAttention?.overlapWithDate, `${mode.name}: compact attention badge overlaps date value`);
    } else {
      const releasedChip = metrics.desktopChips.find((c) => c.eventId === releasedJobId);
      const reservedChip = metrics.desktopChips.find((c) => c.eventId === reservedJobId);
      const legacyChip = metrics.desktopChips.find((c) => c.eventId === legacyJobId);
      requireCheck(Boolean(releasedChip?.released && releasedChip.releasedClass && releasedChip.statusText === 'Müdahale' && releasedChip.hasStatusIcon), `${mode.name}: desktop released chip missing icon/status`);
      requireCheck(Boolean(reservedChip && !reservedChip.released && !reservedChip.releasedClass && !reservedChip.statusText), `${mode.name}: desktop reserved chip changed`);
      requireCheck(Boolean(legacyChip && !legacyChip.released && !legacyChip.releasedClass && !legacyChip.statusText), `${mode.name}: desktop legacy chip changed`);
    }

    requireCheck(errors.length === 0, `${mode.name}: page errors (${errors.join(', ')})`);
    requireCheck(unexpectedRequests.length === 0, `${mode.name}: unexpected requests (${unexpectedRequests.join(', ')})`);
    await context.close();
  }

  // 2. Interactive detail, wheel, conflict error, held PATCH pending, settled success & reopen (390 & 1440)
  for (const width of [390, 1440]) {
    const session = await setupCalendarPage(browser, url, {
      width,
      height: width === 390 ? 844 : 900,
      conflictCount: 1,
      holdPatch: true,
    });
    const { page, context, errors, unexpectedRequests, patches, releasePatch } = session;
    try {
      let chipSelection;
      let compactDayRoutingOk = null;
      if (width === 1440) {
        await page.locator(`button.servora-calendar-event-summary[data-event-id="${releasedJobId}"]`).click();
        await page.waitForURL(/\?event=/);
        await page.locator('article[aria-current="true"] .servora-operational-card--selected').waitFor();
        await page.locator('article[aria-current="true"] .calendar-released-badge').waitFor();
        await captureScreenshot(page, 'calendar-selected-1440.png');
        chipSelection = { status: 'passed', preservesReleasedBadge: true };
      } else {
        await page.locator('.servora-calendar--compact').waitFor();
        await page.locator('[class*="picker-cell-in-view"]:has([class*="picker-calendar-date-value"]:text-is("27"))').first().click();
        await page.locator('.calendar-event-card h3', { hasText: 'Klinik stok sayımı' }).waitFor();
        await page.locator('[class*="picker-cell-in-view"]:has([class*="picker-calendar-date-value"]:text-is("26"))').first().click();
        await page.locator('.calendar-event-card--released').waitFor();
        compactDayRoutingOk = true;
        chipSelection = {
          status: 'skipped',
          reason: 'Compact calendar (< 640px) routes agenda by day cell without inline month-cell event chips; inline chip selection (?event=) is verified at 1440px and in calendar-page.test.tsx.',
        };
      }

      const releasedCard = page.locator('.calendar-event-card--released');
      await releasedCard.getByRole('button', { name: 'Düzenle' }).click();
      const drawer = page.locator('[data-servora-form-drawer] [role="dialog"]');
      await drawer.locator('.calendar-form-released-notice').waitFor();
      await drawer.locator('.available-slot-chip').first().waitFor();

      const drawerTargets = await measureOverlayTargets(
        drawer,
        'button:visible, select:visible, input:visible:not(.wheel-field-proxy)',
      );
      for (const target of drawerTargets) {
        requireCheck(
          target.width >= 44 && target.height >= 44,
          `interactive-${width}: drawer target "${target.label}" below 44 CSS px (${target.width}x${target.height})`,
        );
      }
      await captureScreenshot(page, `calendar-detail-drawer-${width}.png`);

      let wheelResult = { status: 'skipped', reason: 'Desktop (>= 1024px) renders native datetime-local input.' };
      if (width === 390) {
        const trigger = drawer.locator('#calendar-event-starts-at');
        await trigger.click();
        const wheel = page.locator('[data-servora-wheel-sheet="true"]');
        await wheel.waitFor();

        const wheelTargets = await measureOverlayTargets(
          wheel,
          'button:visible:not(.wheel-sheet-backdrop), [role="spinbutton"]:visible, .wheel-column-item[data-wheel-selected="true"]:visible',
        );
        for (const target of wheelTargets) {
          requireCheck(
            target.width >= 44 && target.height >= 44,
            `interactive-390: wheel target "${target.label}" below 44 CSS px (${target.width}x${target.height})`,
          );
        }
        await captureScreenshot(page, 'calendar-wheel-open-390.png');

        await page.keyboard.press('Escape');
        await wheel.waitFor({ state: 'hidden' });
        assert.equal(await drawer.isVisible(), true);
        assert.equal(await trigger.evaluate((el) => el === document.activeElement), true);

        await trigger.click();
        await wheel.waitFor();
        const hourColumn = wheel.locator('[role="spinbutton"][aria-label="Saat"]');
        await hourColumn.focus();
        await page.keyboard.press('ArrowUp');
        await wheel.getByRole('button', { name: 'Tamam', exact: true }).click();
        await wheel.waitFor({ state: 'hidden' });
        assert.equal(await trigger.evaluate((el) => el === document.activeElement), true);
        const updatedTriggerLabel = await trigger.textContent();
        assert.match(updatedTriggerLabel ?? '', /13:30/);
        wheelResult = {
          status: 'passed',
          escapeRestoredFocus: true,
          tamamUpdatedValueAndRestoredFocus: true,
          updatedTriggerLabel: updatedTriggerLabel?.trim() ?? '',
          minWheelTargetPx: Math.min(...wheelTargets.map((t) => Math.min(t.width, t.height))),
          wheelTargets,
        };
      } else {
        await drawer.locator('#calendar-event-starts-at').fill('2026-11-26T13:30');
      }

      // Real visible API conflict error (409 CALENDAR_CONFLICT) preserving draft
      await drawer.getByRole('button', { name: 'Kaydet' }).click();
      const errorBox = drawer.locator('.form-error[role="alert"]');
      await errorBox.waitFor();
      await drawer.locator('.available-slot-chip').first().waitFor();
      const errorText = await errorBox.textContent();
      assert.match(errorText ?? '', /Bu zaman aralığı başka bir planla çakışıyor\. Taslağınız korundu\./);
      assert.match(errorText ?? '', /Klinik Cihaz Eğitimi/);
      assert.equal(patches.length, 1);
      await captureScreenshot(page, `calendar-form-error-${width}.png`);

      // Resolve via AvailableSlotsNotice & test controlled held PATCH pending disabled/loading state
      await drawer.locator('.available-slot-chip').first().click();
      await drawer.getByRole('button', { name: 'Kaydet' }).click();
      const pendingSubmit = drawer.getByRole('button', { name: 'Kaydediliyor…' });
      await pendingSubmit.waitFor();
      assert.equal(await pendingSubmit.isDisabled(), true);
      assert.equal(await drawer.locator('fieldset').evaluate((el) => el.disabled), true);
      assert.equal(await drawer.locator('#calendar-event-starts-at').isDisabled(), true);
      assert.equal(await drawer.locator('select').isDisabled(), true);
      assert.equal(await drawer.locator('.available-slot-chip').first().isDisabled(), true);
      await captureScreenshot(page, `calendar-form-pending-${width}.png`);

      // Release PATCH -> window-on same-assignee schedule save opens fresh OPEN offer,
      // flips staffReservationReleased to false, and clears the Calendar warning.
      releasePatch();
      await drawer.waitFor({ state: 'hidden' });
      const updatedCard = page.locator('.calendar-event-card', { hasText: 'Anadolu Dental ürün teslimi' });
      await updatedCard.locator('.calendar-event-time', { hasText: '17:00 – 18:00' }).waitFor();
      await updatedCard.locator('.calendar-released-badge').waitFor({ state: 'detached' });
      assert.equal(await updatedCard.evaluate((el) => el.classList.contains('calendar-event-card--released')), false);
      assert.equal(await updatedCard.locator('.calendar-released-badge').count(), 0);
      assert.equal(await updatedCard.locator('.calendar-event-released-note').count(), 0);
      if (width === 1440) {
        const updatedChip = page.locator(`button.servora-calendar-event-summary[data-event-id="${releasedJobId}"]`);
        await updatedChip.locator('.servora-calendar-event-time', { hasText: '17:00' }).waitFor();
        assert.equal(await updatedChip.evaluate((el) => el.classList.contains('servora-calendar-event-summary--released')), false);
        assert.equal(await updatedChip.getAttribute('data-reservation-released'), null);
        assert.equal(await updatedChip.locator('.servora-calendar-event-status').count(), 0);
        await captureScreenshot(page, `calendar-form-success-${width}.png`);
      } else {
        await updatedCard.scrollIntoViewIfNeeded();
        await captureScreenshot(page, `calendar-form-success-${width}.png`, { fullPage: false });
      }
      const successMeasurements = await measureCalendar(page, {
        name: String(width),
        width,
        height: width === 390 ? 844 : 900,
        compact: width < 640,
      });
      const successJobLink = successMeasurements.jobLinks.find((l) => l.href === `/jobs/${releasedJobId}`);
      requireCheck(Boolean(successJobLink), `interactive-${width}: settled success card missing job link`);
      requireCheck(
        (successJobLink?.contrastRatio ?? 0) >= 4.5,
        `interactive-${width}: settled job link contrast ${successJobLink?.contrastRatio} < 4.5 (fg=${JSON.stringify(successJobLink?.fgRgb)}, bg=${JSON.stringify(successJobLink?.bgRgb)})`,
      );
      requireCheck(
        (successJobLink?.display === 'flex' || successJobLink?.display === 'inline-flex')
        && (successJobLink?.width ?? 0) >= 44
        && (successJobLink?.height ?? 0) >= 44,
        `interactive-${width}: settled job link geometry invalid (${JSON.stringify(successJobLink)})`,
      );
      if (width === 1440) {
        requireCheck(
          successJobLink.actionBarWidth !== null && successJobLink.width < successJobLink.actionBarWidth - 20,
          `interactive-1440: settled job link width ${successJobLink.width} should remain content-sized inside ${successJobLink.actionBarWidth}`,
        );
      } else {
        requireCheck(
          successJobLink.actionBarWidth !== null && Math.abs(successJobLink.width - successJobLink.actionBarWidth) <= 1,
          `interactive-390: settled job link width ${successJobLink.width} should fill stacked mobile action bar (${successJobLink.actionBarWidth})`,
        );
      }
      assert.equal(patches.length, 2);
      assert.equal(patches[1].id, releasedJobId);
      assert.equal(patches[1].body.scheduledAt, '2026-11-26T14:00:00.000Z');
      assert.equal(patches[1].body.assignedTo, staff.id);

      // Reopen editing drawer -> confirms saved server time and cleared released notice
      await updatedCard.getByRole('button', { name: 'Düzenle' }).click();
      await drawer.locator('.available-slot-chip').first().waitFor();
      assert.equal(await drawer.locator('.calendar-form-released-notice').count(), 0);
      if (width === 390) {
        assert.match((await drawer.locator('#calendar-event-starts-at').textContent()) ?? '', /17:00/);
      } else {
        assert.equal(await drawer.locator('#calendar-event-starts-at').inputValue(), '2026-11-26T17:00');
      }
      await captureScreenshot(page, `calendar-form-reopened-${width}.png`);
      await drawer.getByRole('button', { name: 'Vazgeç' }).click();
      await drawer.waitFor({ state: 'hidden' });

      // Route navigation: keyboard focus-visible on job link -> Enter -> JobDetail (confirms fresh OPEN offer) -> back to Calendar
      const jobLinkLocator = updatedCard.getByRole('link', { name: 'İşi aç' });
      await updatedCard.getByRole('button', { name: 'Düzenle' }).focus();
      await page.keyboard.press('Shift+Tab');
      const focusState = await jobLinkLocator.evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          isFocused: el === document.activeElement,
          matchesFocusVisible: el.matches(':focus-visible'),
          outlineStyle: style.outlineStyle,
          outlineWidthPx: Number.parseFloat(style.outlineWidth),
        };
      });
      requireCheck(
        focusState.isFocused && focusState.matchesFocusVisible && focusState.outlineStyle !== 'none' && focusState.outlineWidthPx >= 3,
        `interactive-${width}: keyboard focus-visible missing on job link (${JSON.stringify(focusState)})`,
      );
      const jobDetailResponsePromise = page.waitForResponse(
        (res) => res.url().includes(`/api/job-cards/${releasedJobId}`) && res.request().method() === 'GET' && !res.url().includes('/submission-lateness') && !res.url().includes('/sale-create-context'),
      );
      await page.keyboard.press('Enter');
      await page.waitForURL(new RegExp(`/jobs/${releasedJobId}$`));
      const jobDetailJson = await (await jobDetailResponsePromise).json();
      assert.equal(jobDetailJson.scheduledAt, '2026-11-26T14:00:00.000Z');
      assert.equal(jobDetailJson.assignmentOffer?.state, 'OPEN');
      await page.locator('h1', { hasText: 'Anadolu Dental ürün teslimi' }).waitFor();

      const backControl = width < 1024
        ? page.getByRole('link', { name: 'Takvim', exact: false }).first()
        : page.getByRole('link', { name: 'Takvime dön' });
      await backControl.click();
      await page.waitForURL(/\/calendar/);
      await page.locator('.calendar-event-card', { hasText: 'Anadolu Dental ürün teslimi' }).waitFor();
      assert.equal(await page.locator('.calendar-event-card', { hasText: 'Anadolu Dental ürün teslimi' }).locator('.calendar-released-badge').count(), 0);

      requireCheck(errors.length === 0, `interactive-${width}: page errors (${errors.join(', ')})`);
      requireCheck(unexpectedRequests.length === 0, `interactive-${width}: unexpected requests (${unexpectedRequests.join(', ')})`);
      report.interactions[`width_${width}`] = {
        chipSelection,
        compactDayRoutingOk,
        drawerOpenedAndNoticeVisible: true,
        minDrawerTargetPx: Math.min(...drawerTargets.map((t) => Math.min(t.width, t.height))),
        drawerTargets,
        wheel: wheelResult,
        conflictErrorShownAndDraftPreserved: true,
        pendingDisabledAndLoadingVerified: true,
        windowOnSameAssigneeReacquired: true,
        staffReservationReleasedFlippedFalse: true,
        warningClearedAfterSave: true,
        freshOpenOfferOnJobDetail: jobDetailJson.assignmentOffer?.state === 'OPEN',
        successPersistedAndReopenedVerified: true,
        settledJobLink: successJobLink,
        settledJobLinkKeyboardFocus: focusState,
        patchNotBlockedByClient: patches.length === 2,
        roundTripNavigationOk: true,
      };
    } finally {
      releasePatch();
      await context.close();
    }
  }

  // 2b. Separately named window-off scenario (DECISIONS.md RESCUE-004/A §7):
  // assignment-window off does not open a fresh offer on reschedule, so staffReservationReleased stays true.
  {
    const session = await setupCalendarPage(browser, url, {
      width: 1440,
      height: 900,
      assignmentWindowEnabled: false,
    });
    const { page, context, errors, unexpectedRequests, patches } = session;
    try {
      const releasedCard = page.locator('.calendar-event-card--released');
      await releasedCard.getByRole('button', { name: 'Düzenle' }).click();
      const drawer = page.locator('[data-servora-form-drawer] [role="dialog"]');
      await drawer.locator('.calendar-form-released-notice').waitFor();
      await drawer.locator('#calendar-event-starts-at').fill('2026-11-26T17:00');
      await drawer.getByRole('button', { name: 'Kaydet' }).click();
      await drawer.waitFor({ state: 'hidden' });

      const updatedWindowOffCard = page.locator('.calendar-event-card--released');
      await updatedWindowOffCard.locator('.calendar-event-time', { hasText: '17:00 – 18:00' }).waitFor();
      await updatedWindowOffCard.locator('.calendar-released-badge').waitFor();
      assert.equal(patches.length, 1);

      await updatedWindowOffCard.getByRole('button', { name: 'Düzenle' }).click();
      await drawer.locator('.calendar-form-released-notice').waitFor();
      assert.equal(await drawer.locator('#calendar-event-starts-at').inputValue(), '2026-11-26T17:00');
      await drawer.getByRole('button', { name: 'Vazgeç' }).click();
      await drawer.waitFor({ state: 'hidden' });

      requireCheck(errors.length === 0, `window-off: page errors (${errors.join(', ')})`);
      requireCheck(unexpectedRequests.length === 0, `window-off: unexpected requests (${unexpectedRequests.join(', ')})`);
      report.windowOffScenario = {
        status: 'passed',
        assignmentWindowEnabled: false,
        savedTime: '17:00 – 18:00',
        staffReservationReleasedPreservedTrue: true,
      };
    } finally {
      await context.close();
    }
  }

  // 3. Safe module-off behavior (capabilities.calendar = false)
  {
    const session = await setupCalendarPage(browser, url, {
      width: 1440,
      height: 900,
      calendarEnabled: false,
      path: '/calendar',
    });
    const { page, context, errors, unexpectedRequests, apiCalls } = session;
    await page.waitForURL(/\/jobs$/);
    await page.getByText('Anadolu Dental ürün teslimi').first().waitFor();
    const hasCalendarNav = await page.locator('nav a[href="/calendar"]').count();
    const calledCalendarApi = apiCalls.some((call) => call.includes('/api/calendar'));
    await captureScreenshot(page, 'calendar-module-off-1440.png');

    requireCheck(hasCalendarNav === 0, 'module-off: Takvim navigation link still visible');
    requireCheck(!calledCalendarApi, 'module-off: /api/calendar was called when module is disabled');
    requireCheck(errors.length === 0, `module-off: page errors (${errors.join(', ')})`);
    requireCheck(unexpectedRequests.length === 0, `module-off: unexpected requests (${unexpectedRequests.join(', ')})`);
    report.moduleOff = {
      redirectedTo: new URL(page.url()).pathname,
      calendarNavCount: hasCalendarNav,
      calledCalendarApi,
    };
    await context.close();
  }

  report.completed = true;
} finally {
  writeFileSync(resolve(evidenceDir, 'measurements.json'), JSON.stringify(report, null, 2) + '\n');
  await browser?.close();
  await vite.close();
}

assert.deepEqual(report.issues, []);
console.log('rescue-004a calendar acceptance OK');
