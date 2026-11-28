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

function makeJobDetail(event) {
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
    assignmentOffer: event.staffReservationReleased
      ? {
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
        }
      : null,
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
  viewports: [],
  interactions: {},
  moduleOff: {},
  issues: [],
};

function requireCheck(condition, message) {
  if (!condition) report.issues.push(message);
}

async function setupCalendarPage(browser, url, options = {}) {
  const calendarEnabled = options.calendarEnabled ?? true;
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

    if (method === 'GET' && pathname === '/api/calendar') {
      if (!calendarEnabled) {
        return send({ code: 'MODULE_DISABLED', error: 'Takvim modülü kapalı.' }, 403);
      }
      return send({ items: events });
    }
    if (method === 'GET' && pathname === '/api/calendar/assignees') {
      return send({ items: [staff, successor] });
    }
    if (method === 'GET' && pathname.startsWith('/api/calendar/events/')) {
      const id = pathname.split('/').pop();
      const found = events.find((e) => e.id === id);
      return found ? send(found) : send({ code: 'NOT_FOUND', error: 'Bulunamadı.' }, 404);
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
      return send({
        items: events.filter((e) => e.source === 'JOB').map(makeJobDetail),
        total: 3,
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
        return found ? send(makeJobDetail(found)) : send({ code: 'NOT_FOUND', error: 'Bulunamadı.' }, 404);
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
      const idx = events.findIndex((e) => e.jobCardId === id);
      if (idx >= 0) {
        events[idx] = {
          ...events[idx],
          version: events[idx].version + 1,
          startsAt: body.scheduledAt ?? events[idx].startsAt,
          endsAt: body.scheduledAt
            ? new Date(new Date(body.scheduledAt).getTime() + 60 * 60_000).toISOString()
            : events[idx].endsAt,
        };
        return send(makeJobDetail(events[idx]));
      }
      return send({ code: 'NOT_FOUND', error: 'Bulunamadı.' }, 404);
    }
    if (
      method === 'GET'
      && (pathname === '/api/job-cards/change-requests/open'
        || pathname.endsWith('/assignment-offers/needs-action')
        || pathname === '/api/job-cards/pending-acceptance/past-start'
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
  return { context, page, errors, unexpectedRequests, apiCalls, patches };
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
      '.mobile-bottom-nav a',
      '.mobile-bottom-nav button',
      '.mobile-top-bar button',
      '.mobile-top-bar a',
    ];
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
      documentScrollWidth: document.documentElement.scrollWidth,
      documentClientWidth: document.documentElement.clientWidth,
      overflowX: docOverflow,
      targets,
      minTargetPx: targets.length ? Math.min(...targets.map((t) => Math.min(t.width, t.height))) : 0,
      cards,
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

    await page.screenshot({ path: resolve(evidenceDir, mode.screenshot), fullPage: true });

    requireCheck(!metrics.overflowX, `${mode.name}: horizontal overflow (${metrics.documentScrollWidth} > ${metrics.documentClientWidth})`);
    requireCheck(subMinText.length === 0, `${mode.name}: text below 12px (${JSON.stringify(subMinText)})`);
    for (const target of metrics.targets) {
      requireCheck(
        target.width >= 43.5 && target.height >= 43.5,
        `${mode.name}: target "${target.label}" below 44 CSS px (${target.width}x${target.height})`,
      );
    }

    const releasedCard = metrics.cards.find((c) => c.title === 'Anadolu Dental ürün teslimi');
    const reservedCard = metrics.cards.find((c) => c.title === 'Ege Dental cihaz sunumu');
    const legacyCard = metrics.cards.find((c) => c.title === 'Marmara Dental eski sunucu planı');
    requireCheck(Boolean(releasedCard?.releasedClass && releasedCard.hasBadge && releasedCard.hasBadgeIcon && releasedCard.hasReleasedNote && releasedCard.hasOpenLink && releasedCard.hasEditButton), `${mode.name}: released agenda card missing required semantics or actions`);
    requireCheck(Boolean(reservedCard && !reservedCard.releasedClass && !reservedCard.hasBadge && !reservedCard.hasReleasedNote), `${mode.name}: reserved card incorrectly marked released`);
    requireCheck(Boolean(legacyCard && !legacyCard.releasedClass && !legacyCard.hasBadge && !legacyCard.hasReleasedNote), `${mode.name}: legacy card incorrectly marked released`);

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

  // 2. Interactive detail & selection & save without client overlap blocking (390 & 1440)
  for (const width of [390, 1440]) {
    const session = await setupCalendarPage(browser, url, { width, height: width === 390 ? 844 : 900 });
    const { page, context, errors, unexpectedRequests, patches } = session;

    if (width === 1440) {
      await page.locator(`button.servora-calendar-event-summary[data-event-id="${releasedJobId}"]`).click();
      await page.waitForURL(/\?event=/);
      await page.locator('article[aria-current="true"] .servora-operational-card--selected').waitFor();
      await page.locator('article[aria-current="true"] .calendar-released-badge').waitFor();
      await page.screenshot({ path: resolve(evidenceDir, 'calendar-selected-1440.png'), fullPage: true });
    }

    const releasedCard = page.locator('.calendar-event-card--released');
    await releasedCard.getByRole('button', { name: 'Düzenle' }).click();
    const drawer = page.locator('[data-servora-form-drawer] [role="dialog"]');
    await drawer.locator('.calendar-form-released-notice').waitFor();
    await page.screenshot({ path: resolve(evidenceDir, `calendar-detail-drawer-${width}.png`), fullPage: true });

    await drawer.getByRole('button', { name: 'Kaydet' }).click();
    await drawer.waitFor({ state: 'hidden' });
    assert.equal(patches.length, 1);
    assert.equal(patches[0].id, releasedJobId);

    // Route navigation: Calendar -> JobDetail -> back to Calendar
    await releasedCard.getByRole('link', { name: 'İşi aç' }).click();
    await page.waitForURL(new RegExp(`/jobs/${releasedJobId}$`));
    await page.locator('h1', { hasText: 'Anadolu Dental ürün teslimi' }).waitFor();

    const backControl = width < 1024
      ? page.getByRole('link', { name: 'Takvim', exact: false }).first()
      : page.getByRole('link', { name: 'Takvime dön' });
    await backControl.click();
    await page.waitForURL(/\/calendar/);
    await page.locator('.calendar-event-card--released').waitFor();

    requireCheck(errors.length === 0, `interactive-${width}: page errors (${errors.join(', ')})`);
    requireCheck(unexpectedRequests.length === 0, `interactive-${width}: unexpected requests (${unexpectedRequests.join(', ')})`);
    report.interactions[`width_${width}`] = {
      selectedPreservesReleasedBadge: width === 1440,
      drawerOpenedAndNoticeVisible: true,
      patchNotBlockedByClient: patches.length === 1,
      roundTripNavigationOk: true,
    };
    await context.close();
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
    const hasCalendarNav = await page.locator('nav a[href="/calendar"]').count();
    const calledCalendarApi = apiCalls.some((call) => call.includes('/api/calendar'));
    await page.screenshot({ path: resolve(evidenceDir, 'calendar-module-off-1440.png'), fullPage: true });

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
