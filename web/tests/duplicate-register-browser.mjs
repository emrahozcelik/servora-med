import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { createServer } from 'vite';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(join(webRoot, 'package.json'));
const { chromium } = require('playwright');
const out = process.env.DUPLICATE_BROWSER_OUT ?? join(tmpdir(), 'servora-med-duplicate-register-browser');
mkdirSync(out, { recursive: true });

const customerA = { id: '10000000-0000-4000-8000-000000000001', name: 'Sentetik Eski Müşteri — İstanbul Ağız ve Diş Sağlığı Kliniği', status: 'active', city: 'İstanbul', district: 'Merkez' };
const customerB = { ...customerA, id: '10000000-0000-4000-8000-000000000002', status: 'inactive', city: null, district: null };
const pair = { customerAId: customerA.id, customerBId: customerB.id };
const reviewId = '20000000-0000-4000-8000-000000000001';
const decision = {
  eventId: '30000000-0000-4000-8000-000000000001', seq: 2, status: 'DISMISSED',
  reasonCode: 'DISTINCT_CUSTOMER', actorUserId: '10000000-0000-4000-8000-0000000000aa',
  decidedAt: '2026-10-20T10:00:00.000Z',
};
const review = {
  id: reviewId, version: 2, reviewStatus: 'DISMISSED', effectiveStatus: 'DISMISSED',
  freshness: 'CURRENT', freshnessReason: null, currentDecision: decision, lastDecision: null,
};
const item = (overrides = {}) => ({
  reviewId, pair, sourceAvailability: 'AVAILABLE', customerA, customerB,
  matchingCodes: ['SAME_NAME_AND_PHONE'], warnings: [], comparisonStatus: 'READY', review,
  ...overrides,
});
const page = (items, pageOverrides = {}) => ({
  asOf: '2026-10-20T10:00:00.000Z', matchingRuleVersion: 'crm-duplicate-v1', items,
  page: { nextCursor: null, exhausted: true, evaluatedReviews: items.length, returnedItems: items.length, ...pageOverrides },
});
const unavailable = item({
  sourceAvailability: 'UNAVAILABLE', customerA: null, customerB: null, matchingCodes: [], comparisonStatus: 'UNAVAILABLE',
  review: { ...review, effectiveStatus: 'UNAVAILABLE', freshness: 'STALE', freshnessReason: 'SOURCE_UNAVAILABLE' },
});

const orgId = '10000000-0000-4000-8000-0000000000bb';
const actorId = '10000000-0000-4000-8000-0000000000aa';
const attemptKey = `CRM_DUPLICATE_COMMAND_ATTEMPT:v1:${orgId}:${actorId}:${pair.customerAId}:${pair.customerBId}`;
const frozenAttempt = {
  version: 1, kind: 'DECIDE', clientActionId: '6f1f0d1e-0000-4000-8000-00000000000c',
  expectedReviewVersion: 2, expectedEvidenceRevision: 'ev1.synthetic.digest',
  matchingRuleVersion: 'crm-duplicate-v1', decision: 'DISMISSED', reasonCode: 'DISTINCT_CUSTOMER',
  createdAt: 1_760_000_000_000,
};

const results = [];
function pass(name, detail = '') {
  results.push({ name, status: 'PASS', detail });
  console.log(`PASS ${name}${detail ? `: ${detail}` : ''}`);
}
async function fulfill(route, status, body, headers = {}) {
  await route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });
}

const server = await createServer({ configFile: false, root: webRoot, appType: 'custom', plugins: [react()], server: { host: '127.0.0.1', port: 0 } });
const html = '<!doctype html><html lang="tr"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>Duplicate register browser acceptance</title></head><body><div id="root"></div><script type="module" src="/tests/fixtures/duplicate-review-browser-entry.tsx"></script></body></html>';
server.middlewares.use(async (req, res, next) => {
  if (req.url?.startsWith('/duplicate-browser-test')) {
    res.setHeader('Content-Type', 'text/html');
    res.end(await server.transformIndexHtml('/duplicate-browser-test', html));
  } else next();
});

let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Vite server did not expose a TCP port.');
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  const consoleErrors = [];
  const watch = (page) => {
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().includes('Failed to load resource')) consoleErrors.push(message.text());
    });
  };

  // 1. Register ALL view: bounded headers, safe decision fields and a comparison link.
  const allPage = await context.newPage(); watch(allPage);
  await allPage.route('**/api/customers/**', (route) => fulfill(route, 200, page([item()])));
  await allPage.goto(`${origin}/duplicate-browser-test?register&view=ALL`, { waitUntil: 'domcontentloaded' });
  await allPage.getByRole('heading', { name: 'İnceleme kaydı' }).waitFor({ timeout: 10000 });
  assert.equal(await allPage.getByRole('heading', { name: `Müşteri A: ${customerA.name}` }).isVisible(), true);
  assert.equal(await allPage.getByRole('heading', { name: `Müşteri B: ${customerB.name}` }).isVisible(), true);
  assert.equal(await allPage.getByText('Ayrı müşteri').isVisible(), true);
  assert.equal(await allPage.getByRole('link', { name: /İncelemeyi aç/ }).count(), 1);
  assert.equal(await allPage.getByRole('link', { name: 'Olası mükerrerlere dön' }).isVisible(), true);
  pass('REG-01 register ALL keeps A/B identity, reason, time and comparison link');
  await allPage.screenshot({ path: join(out, 'reg-01-all.png'), fullPage: true });
  await allPage.close();

  // 2. ATTENTION unavailable source: warning, no link, no leaked raw data.
  const unavailablePage = await context.newPage(); watch(unavailablePage);
  await unavailablePage.route('**/api/customers/**', (route) => fulfill(route, 200, page([unavailable])));
  await unavailablePage.goto(`${origin}/duplicate-browser-test?register`, { waitUntil: 'domcontentloaded' });
  await unavailablePage.getByText('Kaynak müşteriler artık kullanılamıyor').waitFor({ timeout: 10000 });
  assert.equal(await unavailablePage.getByRole('link', { name: /İncelemeyi aç/ }).count(), 0);
  assert.equal(await unavailablePage.getByText('Kaynak kullanılamıyor').first().isVisible(), true);
  pass('REG-02 unavailable source keeps the historical row without a comparison link');
  await unavailablePage.screenshot({ path: join(out, 'reg-02-unavailable.png'), fullPage: true });
  await unavailablePage.close();

  // 3. Cursor pagination keeps the register reachable without skipping pages.
  const pagedPage = await context.newPage(); watch(pagedPage);
  let registerCalls = 0;
  await pagedPage.route('**/api/customers/**', async (route) => {
    registerCalls += 1;
    return fulfill(route, 200, registerCalls === 1
      ? page([item()], { nextCursor: 'register-cursor-1', exhausted: false, evaluatedReviews: 2 })
      : page([{ ...item(), reviewId: '20000000-0000-4000-8000-000000000002' }]));
  });
  await pagedPage.goto(`${origin}/duplicate-browser-test?register&view=ALL`, { waitUntil: 'domcontentloaded' });
  await pagedPage.getByRole('button', { name: 'Sonraki sayfa' }).waitFor({ timeout: 10000 });
  await pagedPage.getByRole('button', { name: 'Sonraki sayfa' }).click();
  await pagedPage.getByText('20000000-0000-4000-8000-000000000002').first().waitFor({ timeout: 10000 });
  await pagedPage.getByRole('button', { name: 'İlk sayfa', exact: true }).waitFor({ timeout: 10000 });
  assert.equal(registerCalls >= 2, true);
  assert.equal(await pagedPage.getByRole('status').filter({ hasText: 'Bu sayfada 1 kayıt' }).count(), 1);
  pass('REG-03 register cursor pagination exposes continuation and first-page return');
  await pagedPage.close();

  // 4. Lost response + deleted source: narrow replay keeps the frozen request exactly.
  const recoveryContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await recoveryContext.addInitScript(([key, attempt]) => {
    window.sessionStorage.setItem(key, JSON.stringify(attempt));
  }, [attemptKey, frozenAttempt]);
  const recoveryPage = await recoveryContext.newPage(); watch(recoveryPage);
  let replayedBody = null;
  await recoveryPage.route('**/api/customers/**', async (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      replayedBody = request.postDataJSON();
      return fulfill(route, 200, {
        reviewId, pair, reviewVersion: 2, eventId: decision.eventId, eventKind: 'DECISION_RECORDED',
        resultingStatus: 'DISMISSED', reasonCode: 'DISTINCT_CUSTOMER', actorUserId: actorId,
        occurredAt: decision.decidedAt,
      }, { 'Idempotency-Replayed': 'true' });
    }
    return fulfill(route, 404, { error: { code: 'DUPLICATE_PAIR_NOT_FOUND', message: 'Karşılaştırılabilir müşteri çifti bulunamadı.' } });
  });
  await recoveryPage.goto(`${origin}/duplicate-browser-test?comparison`, { waitUntil: 'domcontentloaded' });
  await recoveryPage.getByRole('heading', { name: 'Yanıtı alınamamış inceleme isteği' }).waitFor({ timeout: 10000 });
  await recoveryPage.getByRole('button', { name: 'Özgün isteği tekrar dene' }).click();
  try {
    await recoveryPage.getByText('İstek daha önce kaydedilmiş: makbuz doğrulandı.').waitFor({ timeout: 10000 });
  } catch (error) {
    console.log('RECOVERY PANEL TEXT:', await recoveryPage.locator('section[aria-labelledby="duplicate-recovery-heading"]').innerText());
    throw error;
  }
  assert.deepEqual(replayedBody, {
    clientActionId: frozenAttempt.clientActionId, expectedReviewVersion: 2,
    expectedEvidenceRevision: 'ev1.synthetic.digest', matchingRuleVersion: 'crm-duplicate-v1',
    decision: 'DISMISSED', reasonCode: 'DISTINCT_CUSTOMER',
  });
  assert.equal(await recoveryPage.getByText('Bu makbuz güncel inceleme durumu değildir').isVisible(), true);
  const remaining = await recoveryPage.evaluate((key) => window.sessionStorage.getItem(key), attemptKey);
  assert.equal(remaining, null);
  pass('REG-04 lost-response replay uses the frozen payload, shows an immutable receipt and clears the attempt');
  await recoveryPage.screenshot({ path: join(out, 'reg-04-recovery.png'), fullPage: true });
  await recoveryPage.close();
  await recoveryContext.close();

  // 5. Mobile 390px plus keyboard focus and reduced motion.
  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', isMobile: true, hasTouch: true });
  const mobilePage = await mobileContext.newPage(); watch(mobilePage);
  await mobilePage.route('**/api/customers/**', (route) => fulfill(route, 200, page([item()])));
  await mobilePage.goto(`${origin}/duplicate-browser-test?register&view=ALL`, { waitUntil: 'domcontentloaded' });
  await mobilePage.getByRole('heading', { name: 'İnceleme kaydı' }).waitFor({ timeout: 10000 });
  const overflow = await mobilePage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.equal(overflow <= 1, true, `horizontal overflow ${overflow}px`);
  const link = mobilePage.getByRole('link', { name: /İncelemeyi aç/ });
  await link.focus();
  assert.equal(await link.evaluate((element) => element === document.activeElement), true);
  pass('REG-05 390px layout has no horizontal overflow, keyboard focus works and reduced motion loads');
  await mobilePage.screenshot({ path: join(out, 'reg-05-mobile.png'), fullPage: true });
  await mobilePage.close();
  await mobileContext.close();

  // 6. Error states stay explanatory and never render a comparison command.
  for (const status of [403, 404, 503]) {
    const errorPage = await context.newPage(); watch(errorPage);
    await errorPage.route('**/api/customers/**', (route) => fulfill(route, status, { error: `Sentetik ${status}`, code: status === 403 ? 'FORBIDDEN' : status === 404 ? 'DUPLICATE_REVIEW_NOT_FOUND' : 'REVIEW_TEMPORARILY_UNAVAILABLE' }));
    await errorPage.goto(`${origin}/duplicate-browser-test?register&view=ALL`, { waitUntil: 'domcontentloaded' });
    await errorPage.getByText(status === 404 ? 'Bu kayıt kullanılamıyor veya erişim kapsamınızda değil.' : `Sentetik ${status}`).waitFor({ timeout: 10000 });
    assert.equal(await errorPage.getByRole('button', { name: 'Mükerrer olarak doğrula' }).count(), 0);
    if (status === 403 || status === 404) assert.equal(await errorPage.getByRole('button', { name: 'Tekrar dene' }).count(), 0);
    else assert.equal(await errorPage.getByRole('button', { name: 'Tekrar dene' }).count(), 1);
    pass(`REG-06 ${status} keeps an explanatory state without commands`);
    await errorPage.close();
  }


  // 8. F22: unavailable source still opens the full safe history, incl. pagination.
  const historyPage = await context.newPage(); watch(historyPage);
  const historyItem = (seq) => ({
    eventId: `30000000-0000-4000-8000-${String(seq).padStart(12, '0')}`, seq,
    eventKind: 'DECISION_RECORDED', resultingStatus: 'DISMISSED', reasonCode: 'DISTINCT_CUSTOMER',
    actorUserId: actorId, occurredAt: '2026-10-20T10:00:00.000Z', matchingRuleVersion: 'crm-duplicate-v1',
    matchingCodes: [], warnings: [],
  });
  let historyCalls = 0;
  await historyPage.route('**/api/customers/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/history')) {
      historyCalls += 1;
      const first = Array.from({ length: 20 }, (_, index) => historyItem(21 - index));
      return fulfill(route, 200, historyCalls === 1
        ? { reviewId, upperSeq: 21, items: first, nextCursor: 'history-cursor-2' }
        : { reviewId, upperSeq: 21, items: [historyItem(1)], nextCursor: null });
    }
    return fulfill(route, 200, page([unavailable]));
  });
  await historyPage.goto(`${origin}/duplicate-browser-test?register`, { waitUntil: 'domcontentloaded' });
  await historyPage.getByRole('button', { name: 'Karar geçmişini aç' }).click();
  await historyPage.getByRole('heading', { name: 'Karar geçmişi' }).waitFor({ timeout: 10000 });
  await historyPage.locator('.duplicate-history-list > li').first().waitFor({ timeout: 10000 });
  assert.equal(await historyPage.locator('.duplicate-history-list > li').count(), 20);
  await historyPage.getByRole('button', { name: 'Daha eski kararlar' }).click();
  await historyPage.locator('.duplicate-history-list > li').nth(20).waitFor({ timeout: 10000 });
  assert.equal(await historyPage.locator('.duplicate-history-list > li').count(), 21);
  assert.equal(await historyPage.getByRole('button', { name: 'Mükerrer olarak doğrula' }).count(), 0);
  assert.equal(await historyPage.getByRole('button', { name: 'Yeniden incele' }).count(), 0);
  pass('F22 unavailable source opens the full safe history with pagination and no commands', `historyCalls=${historyCalls}`);
  await historyPage.screenshot({ path: join(out, 'f22-history.png'), fullPage: true });
  await historyPage.close();

  const foreignHistory = await context.newPage(); watch(foreignHistory);
  await foreignHistory.route('**/api/customers/**', (route) => route.request().url().includes('/history')
    ? fulfill(route, 404, { error: 'İnceleme kaydı bulunamadı.', code: 'DUPLICATE_REVIEW_NOT_FOUND' })
    : fulfill(route, 200, page([unavailable])));
  await foreignHistory.goto(`${origin}/duplicate-browser-test?register`, { waitUntil: 'domcontentloaded' });
  await foreignHistory.getByRole('button', { name: 'Karar geçmişini aç' }).click();
  await foreignHistory.getByRole('alert').filter({ hasText: 'İnceleme kaydı bulunamadı.' }).waitFor({ timeout: 10000 });
  assert.equal(await foreignHistory.getByRole('button', { name: 'Geçmişi tekrar dene' }).count(), 0);
  pass('F22 foreign/unknown review history stays concealed with no retry affordance');
  await foreignHistory.close();

  // 9. F23: a rate-limited replay honours the shared COMMAND cooldown.
  const cooldownContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await cooldownContext.addInitScript(([key, attempt]) => {
    window.sessionStorage.setItem(key, JSON.stringify(attempt));
  }, [attemptKey, frozenAttempt]);
  const cooldownPage = await cooldownContext.newPage(); watch(cooldownPage);
  let cooldownPosts = 0;
  await cooldownPage.route('**/api/customers/**', async (route) => {
    if (route.request().method() === 'POST') {
      cooldownPosts += 1;
      return fulfill(route, 429, { error: 'Kota aşıldı.', code: 'RATE_LIMIT_EXCEEDED' }, { 'Retry-After': '5' });
    }
    return fulfill(route, 404, { error: 'Karşılaştırılabilir müşteri çifti bulunamadı.', code: 'DUPLICATE_PAIR_NOT_FOUND' });
  });
  await cooldownPage.goto(`${origin}/duplicate-browser-test?comparison`, { waitUntil: 'domcontentloaded' });
  await cooldownPage.getByRole('button', { name: 'Özgün isteği tekrar dene' }).click();
  await cooldownPage.getByText(/yaklaşık 5 saniye bekleyin/).waitFor({ timeout: 10000 });
  assert.equal(await cooldownPage.getByRole('button', { name: 'Özgün isteği tekrar dene' }).isDisabled(), true);
  const storedCooldown = await cooldownPage.evaluate(([org, actor]) => window.sessionStorage.getItem(`CRM_DUPLICATE_COMMAND_COOLDOWN:v1:${org}:${actor}`), [orgId, actorId]);
  assert.equal(Number(storedCooldown) > Date.now(), true);
  await cooldownPage.getByRole('button', { name: 'Özgün isteği tekrar dene' }).click({ force: true }).catch(() => undefined);
  await cooldownPage.waitForTimeout(500);
  assert.equal(cooldownPosts, 1);
  pass('F23 recovery respects the shared COMMAND cooldown before the next replay', `posts=${cooldownPosts}`);
  await cooldownPage.screenshot({ path: join(out, 'f23-cooldown.png'), fullPage: true });
  await cooldownPage.close();
  await cooldownContext.close();

  // 10. F24: an expired register cursor restarts from a clean first page.
  const cursorPage = await context.newPage(); watch(cursorPage);
  const registerRequests = [];
  await cursorPage.route('**/api/customers/**', async (route) => {
    const url = new URL(route.request().url());
    registerRequests.push(url.search);
    if (url.searchParams.get('cursor') === 'expired-cursor') {
      return fulfill(route, 409, { error: 'Kayıt listesi değişti. İlk sayfadan yeniden başlayın.', code: 'CURSOR_RESTART_REQUIRED' });
    }
    return fulfill(route, 200, url.searchParams.has('cursor')
      ? page([{ ...item(), reviewId: '20000000-0000-4000-8000-000000000002' }])
      : page([item()], { nextCursor: 'expired-cursor', exhausted: false, evaluatedReviews: 2 }));
  });
  await cursorPage.goto(`${origin}/duplicate-browser-test?register&view=ALL`, { waitUntil: 'domcontentloaded' });
  await cursorPage.getByRole('button', { name: 'Sonraki sayfa' }).click();
  await cursorPage.getByRole('button', { name: 'İlk sayfadan başlat' }).waitFor({ timeout: 10000 });
  await cursorPage.getByRole('button', { name: 'İlk sayfadan başlat' }).click();
  await cursorPage.getByRole('button', { name: 'Sonraki sayfa' }).waitFor({ timeout: 10000 });
  const lastSearch = registerRequests.at(-1);
  assert.equal(lastSearch.includes('cursor='), false);
  assert.equal(lastSearch.includes('view=ALL'), true);
  pass('F24 expired register cursor restarts without cursor and keeps the view', `requests=${registerRequests.length}`);
  await cursorPage.screenshot({ path: join(out, 'f24-cursor-restart.png'), fullPage: true });
  await cursorPage.close();


  // 11. F25: an unknown 404 code is unresolved; the frozen attempt survives untouched.
  const unknownContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await unknownContext.addInitScript(([key, attempt]) => {
    window.sessionStorage.setItem(key, JSON.stringify(attempt));
  }, [attemptKey, frozenAttempt]);
  const unknownPage = await unknownContext.newPage(); watch(unknownPage);
  const unknownBodies = [];
  await unknownPage.route('**/api/customers/**', async (route) => {
    if (route.request().method() === 'POST') {
      unknownBodies.push(route.request().postDataJSON());
      return fulfill(route, 404, { error: 'Beklenmeyen bir kayıt hatası.', code: 'UNKNOWN_REVIEW_LOOKUP' });
    }
    return fulfill(route, 404, { error: 'Karşılaştırılabilir müşteri çifti bulunamadı.', code: 'DUPLICATE_PAIR_NOT_FOUND' });
  });
  await unknownPage.goto(`${origin}/duplicate-browser-test?comparison`, { waitUntil: 'domcontentloaded' });
  await unknownPage.getByRole('button', { name: 'Özgün isteği tekrar dene' }).click();
  await unknownPage.getByText('Beklenmeyen bir kayıt hatası.').waitFor({ timeout: 10000 });
  const retained = await unknownPage.evaluate((key) => window.sessionStorage.getItem(key), attemptKey);
  assert.notEqual(retained, null);
  assert.equal(JSON.parse(retained).clientActionId, frozenAttempt.clientActionId);
  assert.equal(await unknownPage.getByRole('button', { name: 'Özgün isteği tekrar dene' }).isEnabled(), true);
  await unknownPage.getByRole('button', { name: 'Özgün isteği tekrar dene' }).click();
  await unknownPage.waitForTimeout(500);
  assert.equal(unknownBodies.length, 2);
  assert.equal(unknownBodies[1].clientActionId, frozenAttempt.clientActionId);
  assert.equal(unknownBodies[1].expectedEvidenceRevision, frozenAttempt.expectedEvidenceRevision);
  pass('F25 unknown 404 keeps the frozen attempt and replays the exact clientActionId', `posts=${unknownBodies.length}`);
  await unknownPage.screenshot({ path: join(out, 'f25-unknown-404.png'), fullPage: true });
  await unknownPage.close();
  await unknownContext.close();

  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);
  pass('REG-07 no page or console errors during the register acceptance flow');
} finally {
  await browser?.close();
  await server.close();
}

console.log(`\nREGISTER BROWSER ACCEPTANCE ${results.filter((entry) => entry.status === 'PASS').length}/${results.length} PASS`);
