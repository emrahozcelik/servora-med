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

  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);
  pass('REG-07 no page or console errors during the register acceptance flow');
} finally {
  await browser?.close();
  await server.close();
}

console.log(`\nREGISTER BROWSER ACCEPTANCE ${results.filter((entry) => entry.status === 'PASS').length}/${results.length} PASS`);
