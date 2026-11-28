/**
 * UI-003 acceptance for Connected Workflows, using the real entry and mock API.
 * Run from web/: FLEET_EVIDENCE_DIR=/absolute/output node scripts/connected-workflows-recovery-acceptance.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const evidence = resolve(process.env.FLEET_EVIDENCE_DIR ?? '.ui-evidence/connected-workflows-recovery');
mkdirSync(evidence, { recursive: true });
const jobId = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';
const jobPath = '/api/job-cards/' + jobId;
const staff = { id: '33333333-3333-4333-8333-333333333333', name: 'Ayşe Personel' };
const successor = { id: '66666666-6666-4666-8666-666666666666', name: 'Deniz Personel' };
const manager = {
  id: '44444444-4444-4444-8444-444444444444', organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  name: 'Murat Yönetici', email: 'murat@example.invalid', role: 'MANAGER',
  mustChangePassword: false, isActive: true, version: 1,
  capabilities: { overviewDashboard: false, calendar: false, messaging: false },
};
const job = {
  id: jobId, organizationId: manager.organizationId, organizationTimezone: 'Europe/Istanbul',
  type: 'PRODUCT_DELIVERY', status: 'ACCEPTED', version: 4, engagementKind: null,
  title: 'Anadolu Dental Polikliniği ürün teslimi', description: null,
  customerId: '55555555-5555-4555-8555-555555555555', contactId: null,
  customer: { id: '55555555-5555-4555-8555-555555555555', name: 'Anadolu Dental Polikliniği' },
  contact: null, assignedTo: staff.id, assignee: staff, createdBy: manager.id, priority: 'normal',
  dueDate: null, scheduledAt: '2026-11-27T13:30:00.000Z', scheduledEndsAt: '2026-11-27T14:30:00.000Z',
  followUpContext: null, hasOpenOverdueIncident: false, correctionDueAt: null, assignmentOffer: null,
  changeRequest: {
    id: requestId, reasonCode: 'CUSTOMER_POSTPONED',
    reasonText: 'Klinik teslimatı daha geç bir saate almak istiyor.',
    requestedAt: '2026-11-26T10:30:00.000Z', requestedBy: staff,
  },
  workflowContext: {
    allowedCommands: ['CANCEL'], allowedActions: ['EDIT_JOB_FIELDS', 'VIEW_NOTES', 'RESOLVE_CHANGE_REQUEST'],
    lifecycle: {
      createdAt: '2026-11-25T08:00:00.000Z', acceptedAt: '2026-11-26T09:15:00.000Z', acceptedBy: staff,
      startedAt: null, submittedAt: null, submittedBy: null, submissionNote: null, approvedAt: null,
      approvedBy: null, approvalNote: null, revisionRequestedAt: null, revisionRequestedBy: null,
      revisionReason: null, cancelledAt: null, cancelledBy: null, cancelReason: null, cancelledFromStatus: null,
    },
    submissionReadiness: null,
  },
};
const empty = { items: [], total: 0, limit: 25, offset: 0, nextCursor: null };
const fixedClock = '2026-11-26T11:00:00.000Z';
const declinedJob = {
  ...job, status: 'NEW', changeRequest: null,
  workflowContext: {
    ...job.workflowContext, allowedActions: ['EDIT_JOB_FIELDS', 'VIEW_NOTES'],
    lifecycle: { ...job.workflowContext.lifecycle, acceptedAt: null, acceptedBy: null },
  },
  assignmentOffer: {
    id: requestId, state: 'DECLINED', openedAt: '2026-11-26T09:00:00.000Z',
    acceptanceDueAt: '2026-11-26T12:00:00.000Z', urgentReason: null,
    assignee: staff, closedAt: '2026-11-26T10:30:00.000Z', closeReason: 'OUT_OF_TOWN',
    closeText: 'Şehir dışındayım.', suggestedSolution: 'REASSIGN',
    proposedScheduledAt: null, proposedScheduledEndsAt: null, proposalAcceptedAt: null,
  },
};
const baseline = process.env.CONNECTED_VISUAL_BASELINE === '1';
const samples = [
  { name: 'small-mobile', width: 320, height: 800 },
  { name: 'phone', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'text-200', width: 390, height: 844, textScale: 200 },
  { name: 'reflow-400-equivalent', width: 320, height: 225, dpr: 4 },
  { name: 'reduced-motion', width: 390, height: 844, motion: 'reduce' },
  { name: 'declined-assignment-phone', width: 390, height: 844, scenario: 'assignment' },
  { name: 'declined-assignment-desktop', width: 1440, height: 900, scenario: 'assignment' },
];
const report = { fixedClock, timezone: 'Europe/Istanbul', source: process.env.CONNECTED_VISUAL_SOURCE ?? 'working tree', baseline, samples: [], interactions: {} };
const issues = [];

function requireMetric(condition, message) {
  if (!condition) issues.push(message);
}

async function openCase(browser, url, sample) {
  const currentJob = sample.scenario === 'assignment' ? declinedJob : job;
  const context = await browser.newContext({
    viewport: { width: sample.width, height: sample.height }, deviceScaleFactor: sample.dpr ?? 1,
    locale: 'tr-TR', timezoneId: report.timezone, reducedMotion: sample.motion ?? 'no-preference',
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  const errors = [];
  const unexpected = [];
  const mutations = [];
  let released;
  const pendingResponse = new Promise((complete) => { released = complete; });
  let resolved = false;
  let transferred = null;
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(window, 'EventSource', { configurable: true, value: undefined });
  });
  await page.clock.setFixedTime(new Date(fixedClock));
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname;
    const send = (json, status = 200) => route.fulfill({ json, status });
    if (method === 'GET' && path === '/api/auth/me') return send({ user: manager });
    if (method === 'GET' && path === jobPath) {
      return send(transferred ?? (resolved ? { ...currentJob, version: 5, changeRequest: null } : currentJob));
    }
    if (method === 'GET' && path === '/api/notifications/unread-count') return send({ unreadCount: 0 });
    if (method === 'GET' && path === '/api/web-push/status') return send({ enabled: false, subscribed: false, vapidPublicKey: null });
    if (method === 'POST' && path === '/api/notifications/read-by-entity') return send({ markedCount: 0 });
    if (method === 'POST' && path === '/api/job-cards/available-slots') {
      return send({ slots: [{ startsAt: '2026-11-27T14:00:00.000Z', endsAt: '2026-11-27T15:00:00.000Z' }] });
    }
    if (method === 'GET' && path === '/api/staff') {
      return send([staff, successor].map((person) => ({
        id: person.id, version: 1,
        user: { ...manager, ...person, email: person.id + '@example.invalid', role: 'STAFF',
          lastLoginAt: null, createdAt: fixedClock, updatedAt: fixedClock },
        title: null, phone: null, region: null, managerUserId: null, managerName: null,
        counters: { open: 0, waitingApproval: 0, revisionRequested: 0, completedThisMonth: 0, overdue: 0 },
      })));
    }
    if (method === 'GET' && path === jobPath + '/submission-lateness') return send({ open: null });
    if (method === 'GET' && ['/delivery-items', '/notes', '/activity', '/follow-ups', '/overdue-incidents']
      .some((endpoint) => path === jobPath + endpoint)) return send(empty);
    if (method === 'GET' && (path === '/api/notifications' || path === '/api/job-cards'
      || path === '/api/job-cards/change-requests/open' || path.endsWith('/assignment-offers/needs-action')
      || path === '/api/job-cards/pending-acceptance/past-start'
      || path.endsWith('/unaccepted-past-start'))) return send(empty);
    if (method === 'POST' && path === jobPath + '/change-requests/' + requestId + '/resolve') {
      mutations.push(request.postDataJSON());
      await pendingResponse;
      resolved = true;
      return send({ jobCardId: jobId, changeRequestId: requestId, resolution: 'REJECTED', resolvedAt: fixedClock });
    }
    if (method === 'PATCH' && path === jobPath) {
      const mutation = request.postDataJSON();
      mutations.push(mutation);
      if (sample.transferConflict && mutations.length === 1) {
        return send({ code: 'OCCUPANCY_LIMIT_REACHED', error: 'Bu saat için personel takvimi dolu.' }, 409);
      }
      await pendingResponse;
      const duration = Date.parse(currentJob.scheduledEndsAt) - Date.parse(currentJob.scheduledAt);
      transferred = {
        ...currentJob,
        status: 'NEW',
        version: currentJob.version + 1,
        assignedTo: successor.id,
        assignee: successor,
        scheduledAt: mutation.scheduledAt,
        scheduledEndsAt: new Date(Date.parse(mutation.scheduledAt) + duration).toISOString(),
        changeRequest: mutation.changeRequestResolution ? null : currentJob.changeRequest,
        workflowContext: {
          ...currentJob.workflowContext, lifecycle: { ...currentJob.workflowContext.lifecycle, acceptedAt: null, acceptedBy: null },
        },
        assignmentOffer: {
          ...declinedJob.assignmentOffer, id: '77777777-7777-4777-8777-777777777777',
          state: 'OPEN', assignee: successor,
          openedAt: fixedClock, acceptanceDueAt: '2026-11-27T12:00:00.000Z',
          closedAt: null, closeReason: null, closeText: null, suggestedSolution: null,
        },
      };
      if (sample.transferLostResponse) return route.abort('connectionreset');
      return send(transferred);
    }
    unexpected.push(method + ' ' + path);
    return send({ error: 'Unexpected test request' }, 404);
  });
  await page.goto(url + '/jobs/' + jobId);
  if (sample.textScale) await page.addStyleTag({ content: 'html { font-size: 200%; }' });
  await page.locator(sample.scenario === 'assignment'
    ? '[data-assignment-offer-recovery]'
    : '[data-change-request="management"]').waitFor();
  await page.evaluate(() => document.fonts.ready);
  return { page, context, errors, unexpected, mutations, released };
}

async function capture(page, name) {
  await page.screenshot({ path: resolve(evidence, name + '.png'), animations: 'disabled' });
}

async function geometry(page) {
  return page.evaluate(() => {
    const box = (element) => {
      const rect = element.getBoundingClientRect();
      return { width: rect.width, height: rect.height, top: rect.top, bottom: rect.bottom };
    };
    const detail = document.querySelector('[data-job-detail="true"]');
    const scope = detail.querySelector('.job-recovery')
      ?? detail.querySelector('[data-change-request="management"], [data-assignment-offer-recovery]');
    const targets = [...scope.querySelectorAll('summary,button')].filter((element) => element.getClientRects().length)
      .map((element) => ({ label: element.textContent.trim(), ...box(element) }));
    const sections = [...detail.querySelectorAll('[data-job-detail-section]')]
      .filter((element) => element.getClientRects().length)
      .map((element) => element.dataset.jobDetailSection);
    const responsibility = detail.querySelector('[data-job-detail-section="responsibility"]');
    const fixedNav = document.querySelector('.mobile-bottom-nav, .bottom-nav');
    return {
      viewport: [innerWidth, innerHeight], dpr: devicePixelRatio, documentWidth: document.documentElement.scrollWidth,
      rootFont: getComputedStyle(document.documentElement).fontSize, motion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      summaryFont: scope.querySelector('summary') ? getComputedStyle(scope.querySelector('summary')).fontSize : null,
      targets, sections, responsibilityNested: scope.contains(responsibility),
      assignmentUsesOneSurface: detail.querySelector('[data-assignment-offer-recovery]')
        ?.matches('section[data-assignment-offer]') ?? null,
      navigationLinks: [...document.querySelectorAll('nav a')].map((anchor) => anchor.getAttribute('href')),
      bottomNavigation: fixedNav ? box(fixedNav) : null,
    };
  });
}

async function overlayTargets(overlay) {
  return overlay.locator('button:visible, select:visible, textarea:visible, [role="spinbutton"]:visible').evaluateAll((elements) =>
    elements.map((element) => {
      const { width, height } = element.getBoundingClientRect();
      return { label: element.getAttribute('aria-label') ?? element.textContent.trim(), width, height };
    }));
}

async function captureWheel(page) {
  await page.getByRole('button', { name: 'Yeni zaman belirle' }).click();
  await page.locator('.schedule-quick-chips-shell[data-overflow="true"]').waitFor();
  const rail = page.locator('.schedule-quick-chips');
  const preset = await rail.evaluate((element) => {
    const last = element.lastElementChild;
    last.scrollIntoView({ block: 'nearest', inline: 'end', behavior: 'instant' });
    const visibleEnd = last.getBoundingClientRect().right <= element.getBoundingClientRect().right + 2;
    const fade = getComputedStyle(element.parentElement, '::after').backgroundImage;
    const canScroll = element.scrollWidth > element.clientWidth && element.scrollLeft > 0;
    element.scrollTo({ left: 0, behavior: 'instant' });
    return { canScroll, visibleEnd, fade };
  });
  assert.equal(preset.canScroll && preset.visibleEnd, true);
  assert.match(preset.fade, /linear-gradient/);
  const slots = page.locator('.available-slots-notice');
  const slot = slots.getByRole('button', { name: /17:00–18:00/ });
  await slot.scrollIntoViewIfNeeded();
  const slotTargets = await overlayTargets(slots);
  await capture(page, 'available-slots');
  await page.locator('.wheel-field-trigger:visible').first().click();
  const wheel = page.locator('[data-servora-wheel-sheet]');
  await wheel.waitFor();
  const targets = await overlayTargets(wheel);
  await capture(page, 'wheel-picker');
  await page.getByRole('button', { name: 'Tamam', exact: true }).click();
  return { targets, preset, slotTargets };
}

const transferLabel = 'Personeli ve zamanı birlikte değiştir';

async function openTransfer(page) {
  const trigger = page.getByRole('button', { name: transferLabel, exact: true });
  assert.equal(await trigger.count(), 1);
  await trigger.click();
  const form = page.locator('[data-assignment-transfer-form]');
  await form.getByRole('combobox', { name: 'Yeni sorumlu personel' }).waitFor();
  assert.equal(await form.locator('button[type="submit"].primary-button').count(), 1);
  return form;
}

async function captureTransferFlow(browser, url) {
  const test = await openCase(browser, url, { ...samples[1], transferConflict: true });
  const { page, context, mutations, released } = test;
  const form = await openTransfer(page);
  const submit = form.getByRole('button', { name: 'Devret ve planla' });
  const person = form.getByRole('combobox', { name: 'Yeni sorumlu personel' });
  await submit.click();
  await form.getByText('Yeni sorumlu personel seçin.').waitFor();
  assert.equal(mutations.length, 0);
  assert.equal(await person.getAttribute('aria-invalid'), 'true');
  assert.equal(await person.evaluate((element) => element === document.activeElement), true);
  await capture(page, 'transfer-validation');
  await person.selectOption(successor.id);
  const wheelTrigger = form.locator('.wheel-field-trigger');
  await wheelTrigger.click();
  const wheel = page.locator('[data-servora-wheel-sheet]');
  await wheel.waitFor();
  const wheelTargets = await overlayTargets(wheel);
  await capture(page, 'transfer-wheel-picker');
  await page.keyboard.press('Escape');
  await wheel.waitFor({ state: 'hidden' });
  assert.equal(await form.isVisible(), true);
  assert.equal(await wheelTrigger.evaluate((element) => element === document.activeElement), true);
  await wheelTrigger.click();
  await wheel.getByRole('button', { name: 'Tamam', exact: true }).click();
  assert.equal(await wheelTrigger.evaluate((element) => element === document.activeElement), true);
  await form.getByRole('button', { name: /17:00–18:00/ }).click();
  await form.getByRole('checkbox', { name: /yeniden planlandı/i }).check();
  await submit.click();
  await form.getByRole('alert').getByText('Bu saat için personel takvimi dolu.').waitFor();
  assert.equal(await person.inputValue(), successor.id);
  assert.equal(await form.getByRole('checkbox', { name: /yeniden planlandı/i }).isChecked(), true);
  await capture(page, 'transfer-calendar-conflict');
  await submit.click();
  const pending = form.getByRole('button', { name: 'Kaydediliyor…' });
  await pending.waitFor();
  assert.equal(await pending.isDisabled(), true);
  assert.equal(await pending.locator('svg[aria-hidden="true"]').count(), 1);
  await capture(page, 'transfer-pending');
  released();
  const receipt = page.locator('[data-job-detail-section="feedback"]');
  await receipt.getByText(/Personel ve plan güncellendi/).waitFor();
  assert.equal(await form.count(), 0);
  assert.equal(mutations.length, 2); // One rejected attempt and one successful compound PATCH.
  assert.deepEqual(mutations[1], {
    expectedVersion: 4, assignedTo: successor.id, scheduledAt: '2026-11-27T14:00:00.000Z',
    changeRequestResolution: { changeRequestId: requestId, resolution: 'RESCHEDULED' },
  });
  const outcome = await receipt.evaluate((element) => ({
    status: element.getAttribute('role'), icon: Boolean(element.querySelector('svg')),
    confirmed: element.classList.contains('detail-feedback-confirmed'),
    color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor,
  }));
  assert.equal(outcome.icon && outcome.confirmed, true);
  await capture(page, 'transfer-success');
  for (const target of wheelTargets) {
    requireMetric(target.width >= 44 && target.height >= 44, 'transfer wheel target below 44 CSS px: ' + target.label);
  }
  assert.deepEqual(test.errors, []);
  assert.deepEqual(test.unexpected, []);
  await context.close();
  return { wheelTargets, wheelKeyboardEscape: true, invalid: true, conflict: true, pending: true, outcome, patch: mutations[1] };
}

async function captureUncertainTransfer(browser, url) {
  const test = await openCase(browser, url, { ...samples[1], transferLostResponse: true });
  const { page, context, mutations, released } = test;
  const form = await openTransfer(page);
  await form.getByRole('combobox', { name: 'Yeni sorumlu personel' }).selectOption(successor.id);
  await form.getByRole('button', { name: /17:00–18:00/ }).click();
  await form.getByRole('button', { name: 'Devret ve planla', exact: true }).click();
  released();
  const notice = page.locator('[data-job-detail-committed-refresh]');
  await notice.getByText('Personel ve plan değişikliğinin sonucu doğrulanamadı.').waitFor();
  const closeRequest = page.getByRole('button', { name: 'Öneriyi reddet', exact: true });
  assert.equal(await closeRequest.isDisabled(), true);
  assert.equal(await form.count(), 0);
  await capture(page, 'transfer-outcome-unknown');
  await notice.getByRole('button', { name: 'Güncel durumu yenile' }).click();
  await notice.waitFor({ state: 'hidden' });
  assert.equal(await closeRequest.isEnabled(), true);
  assert.equal(mutations.length, 1);
  assert.deepEqual(test.errors, []);
  assert.deepEqual(test.unexpected, []);
  await context.close();
}

const vite = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
let browser;
try {
  await vite.listen();
  const url = 'http://127.0.0.1:' + vite.httpServer.address().port;
  browser = await chromium.launch();
  report.browser = browser.version();
  for (const sample of samples) {
    const test = await openCase(browser, url, sample);
    const { page, context } = test;
    await capture(page, sample.name);
    await page.getByRole('button', { name: 'Yeni zaman belirle' }).scrollIntoViewIfNeeded();
    await capture(page, sample.name + '-actions');
    const metrics = await geometry(page);
    const sampleReport = { ...sample, ...metrics };
    report.samples.push(sampleReport);
    requireMetric(metrics.documentWidth <= sample.width + 1, sample.name + ': page horizontal overflow');
    requireMetric(metrics.sections.indexOf('heading') < metrics.sections.indexOf('lifecycle')
      && metrics.sections.indexOf('lifecycle') < metrics.sections.indexOf('facts'), sample.name + ': lifecycle order');
    requireMetric(metrics.navigationLinks.includes('/jobs'), sample.name + ': missing Jobs navigation');
    requireMetric(!metrics.responsibilityNested, sample.name + ': responsibility is nested inside recovery');
    if (!baseline && sample.scenario === 'assignment') {
      requireMetric(metrics.assignmentUsesOneSurface, sample.name + ': assignment recovery has nested surfaces');
    }
    if (sample.dpr) {
      const button = page.getByRole('button', { name: 'Sorumlu personeli değiştir' }).first();
      const reachable = await button.evaluate((element) => {
        element.scrollIntoView({ block: 'center', behavior: 'instant' });
        const bounds = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2));
      });
      requireMetric(reachable, sample.name + ': secondary action stays behind fixed navigation after scrolling');
      await capture(page, sample.name + '-secondary-action');
    }
    for (const target of metrics.targets) {
      requireMetric(target.width >= 44 && target.height >= 44, sample.name + ': target below 44 CSS px: ' + target.label);
    }
    if (!baseline) {
      const form = await openTransfer(page);
      const header = await page.locator('.form-drawer-header').evaluate((element) => {
        const title = element.querySelector('h2').getBoundingClientRect();
        const close = element.querySelector('.drawer-close').getBoundingClientRect();
        return { width: element.clientWidth, titleWidth: title.width, titleHeight: title.height, closeWidth: close.width, closeHeight: close.height };
      });
      sampleReport.transferHeader = header;
      requireMetric(header.titleWidth >= 120 && header.closeWidth <= header.width / 2,
        sample.name + ': transfer close control crowds the title');
      const transferTargets = await overlayTargets(page.locator('[data-servora-form-drawer] [role="dialog"]'));
      const checkboxTarget = await form.locator('.form-checkbox-row label').evaluateAll((labels) =>
        labels.map((label) => {
          const { width, height } = label.getBoundingClientRect();
          return { label: label.textContent.trim(), width, height };
        }));
      sampleReport.transferTargets = [...transferTargets, ...checkboxTarget];
      const formGeometry = await form.evaluate((element) => {
        const scroller = element.closest('[role="dialog"]');
        return { clientWidth: scroller.clientWidth, scrollWidth: scroller.scrollWidth };
      });
      sampleReport.transferForm = formGeometry;
      requireMetric(formGeometry.scrollWidth <= formGeometry.clientWidth + 1, sample.name + ': transfer form horizontal overflow');
      for (const target of sampleReport.transferTargets) {
        requireMetric(target.width >= 44 && target.height >= 44, sample.name + ': transfer target below 44 CSS px: ' + target.label);
      }
      await capture(page, sample.name + '-transfer');
      if (sample.textScale || sample.dpr) {
        const submit = form.getByRole('button', { name: 'Devret ve planla', exact: true });
        await submit.scrollIntoViewIfNeeded();
        sampleReport.transferPrimaryReachable = await submit.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          return element.contains(document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2));
        });
        requireMetric(sampleReport.transferPrimaryReachable, sample.name + ': transfer primary action is obscured after scrolling');
        await capture(page, sample.name + '-transfer-actions');
      }
      await form.getByRole('button', { name: 'Vazgeç' }).click();
    }
    requireMetric(test.errors.length === 0, sample.name + ': ' + test.errors.join(', '));
    requireMetric(test.unexpected.length === 0, sample.name + ': ' + test.unexpected.join(', '));
    await context.close();
  }

  if (baseline) {
    const { page, context } = await openCase(browser, url, samples[1]);
    const wheel = await captureWheel(page);
    report.interactions.preset = wheel.preset;
    report.interactions.slotTargets = wheel.slotTargets;
    await context.close();
  } else {
    report.interactions.transfer = await captureTransferFlow(browser, url);
    await captureUncertainTransfer(browser, url);
    report.interactions.transfer.uncertainOutcomeReload = true;
    const test = await openCase(browser, url, samples[1]);
    const { page, context, mutations, released } = test;
    const scope = page.locator('details.job-recovery');
    const summary = scope.locator('summary');
    await summary.focus();
    await page.keyboard.press('Enter');
    assert.equal(await scope.evaluate((element) => element.open), false);
    await page.keyboard.press('Space');
    assert.equal(await scope.evaluate((element) => element.open), true);
    assert.equal(await summary.evaluate((element) => element === document.activeElement), true);
    const wheel = await captureWheel(page);
    report.interactions.wheelTargets = wheel.targets;
    report.interactions.preset = wheel.preset;
    report.interactions.slotTargets = wheel.slotTargets;
    await scope.getByRole('button', { name: 'Yerine yeni iş açtım', exact: true }).click();
    const linkedForm = page.locator('.change-request-form:visible');
    await linkedForm.locator('#change-request-linked-job').waitFor();
    assert.equal(await linkedForm.getByRole('textbox', { name: 'Açıklama' }).count(), 0);
    assert.equal(await linkedForm.locator('button.primary-button').count(), 1);
    report.interactions.linkedFormTargets = await overlayTargets(linkedForm);
    await capture(page, 'form-linked-job');
    await linkedForm.getByRole('button', { name: 'Vazgeç' }).click();
    await scope.getByRole('button', { name: 'Öneriyi reddet', exact: true }).click();
    const form = page.locator('.change-request-form:visible');
    await form.waitFor();
    const submit = form.getByRole('button', { name: 'Öneriyi kapat', exact: true });
    assert.equal(await form.locator('button.primary-button').count(), 1);
    assert.equal(await form.locator('#change-request-linked-job').count(), 0);
    await submit.click();
    const error = form.getByRole('alert');
    await error.getByText('Reddetmek için açıklama zorunludur.').waitFor();
    assert.equal(mutations.length, 0);
    const note = form.getByRole('textbox', { name: 'Açıklama' });
    assert.equal(await note.getAttribute('aria-invalid'), 'true');
    assert.equal(await note.evaluate((element) => element === document.activeElement), true);
    assert.equal(await error.locator('svg[aria-hidden="true"]').count(), 1);
    report.interactions.invalid = true;
    report.interactions.formTargets = await overlayTargets(form);
    await capture(page, 'form-validation');
    await form.getByRole('textbox', { name: 'Açıklama' }).fill('Müşteri mevcut teslimat saatini onayladı.');
    await submit.click();
    const pending = form.getByRole('button', { name: 'Kaydediliyor…' });
    await pending.waitFor();
    assert.equal(await pending.isDisabled(), true);
    assert.equal(await pending.locator('svg[aria-hidden="true"]').count(), 1);
    await capture(page, 'form-pending');
    released();
    const receipt = page.locator('[data-job-detail-section="feedback"]').getByText('Öneri reddedildi. İş bilgileri değişmedi.');
    await receipt.waitFor();
    assert.equal(mutations.length, 1);
    assert.equal(mutations[0].resolution, 'REJECTED');
    const outcome = await page.locator('[data-job-detail-section="feedback"]').evaluate((element) => ({
      status: element.getAttribute('role'), icon: Boolean(element.querySelector('svg')),
      confirmed: element.classList.contains('detail-feedback-confirmed'),
      color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor,
    }));
    report.interactions = { ...report.interactions, keyboard: true, wheel: true, pending: true, outcome };
    requireMetric(outcome.icon, 'committed recovery outcome has no icon');
    requireMetric(outcome.confirmed, 'committed recovery outcome has no confirmed color treatment');
    await capture(page, 'form-success');
    for (const target of [
      ...report.interactions.wheelTargets, ...report.interactions.slotTargets,
      ...report.interactions.linkedFormTargets, ...report.interactions.formTargets,
    ]) {
      requireMetric(target.width >= 44 && target.height >= 44, 'overlay target below 44 CSS px: ' + target.label);
    }
    await page.locator('nav.mobile-bottom-nav a[href="/jobs"]').click();
    await page.waitForURL(url + '/jobs');
    await page.locator('nav.mobile-bottom-nav a[aria-current="page"][href="/jobs"]').waitFor();
    report.interactions.navigation = true;
    assert.deepEqual(test.errors, []);
    assert.deepEqual(test.unexpected, []);
    await context.close();
  }
  report.completed = true;
} finally {
  report.issues = issues;
  writeFileSync(resolve(evidence, 'measurements.json'), JSON.stringify(report, null, 2) + '\n');
  await browser?.close();
  await vite.close();
}
assert.deepEqual(issues, []);
