import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { createServer } from 'vite';
import { createRequire } from 'node:module';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(join(webRoot, 'package.json'));
const { chromium } = require('playwright');
const out = process.env.DUPLICATE_REVIEW_OUT ?? join(process.env.TMPDIR ?? '/tmp', 'servora-med-duplicate-review-decision-browser');
mkdirSync(out, { recursive: true });

const pair = { customerAId: '10000000-0000-4000-8000-000000000001', customerBId: '10000000-0000-4000-8000-000000000002' };
const customer = { id: pair.customerAId, name: 'Sentetik Eski Müşteri — İstanbul Ağız ve Diş Sağlığı Kliniği', status: 'active', city: 'İstanbul', district: 'Merkez', customerType: 'clinic', taxNumber: null, phone: '+905321234567', email: null, address: 'Sentetik adres', version: 1, assignedStaffUserId: null, contacts: [{ id: '10000000-0000-4000-8000-0000000000c1', name: 'Sentetik İlgili Kişi', title: 'Yönetici', phone: '+905321234567', email: null, isPrimary: true, isActive: true, version: 1 }] };
const other = { ...customer, id: pair.customerBId, name: 'SENTETİK ESKİ MÜŞTERİ', status: 'inactive' };
const evidence = { revision: 'ev1.synthetic.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', schemaVersion: 1, matchingRuleVersion: 'crm-duplicate-v1', matchingCodes: ['SAME_NAME_AND_PHONE'], warnings: [] };
const pendingReview = { id: null, version: 0, reviewStatus: 'PENDING_REVIEW', effectiveStatus: 'PENDING_REVIEW', freshness: 'NOT_APPLICABLE', freshnessReason: null, currentDecision: null, lastDecision: null };
const decision = { eventId: '30000000-0000-4000-8000-000000000001', seq: 1, status: 'CONFIRMED_DUPLICATE', reasonCode: 'SAME_OPERATIONAL_CUSTOMER_VERIFIED', actorUserId: '10000000-0000-4000-8000-0000000000aa', decidedAt: '2026-10-20T10:00:00.000Z' };
const terminalReview = { id: '20000000-0000-4000-8000-000000000001', version: 1, reviewStatus: 'CONFIRMED_DUPLICATE', effectiveStatus: 'CONFIRMED_DUPLICATE', freshness: 'CURRENT', freshnessReason: null, currentDecision: decision, lastDecision: decision };
const reopenedReview = { id: terminalReview.id, version: 2, reviewStatus: 'PENDING_REVIEW', effectiveStatus: 'PENDING_REVIEW', freshness: 'CURRENT', freshnessReason: null, currentDecision: null, lastDecision: { ...decision, status: 'DISMISSED', reasonCode: 'DISTINCT_CUSTOMER' } };
const history = { reviewId: terminalReview.id, upperSeq: 1, items: [{ eventId: decision.eventId, seq: 1, eventKind: 'DECISION_RECORDED', resultingStatus: 'CONFIRMED_DUPLICATE', reasonCode: 'SAME_OPERATIONAL_CUSTOMER_VERIFIED', actorUserId: decision.actorUserId, occurredAt: decision.decidedAt, matchingRuleVersion: 'crm-duplicate-v1', matchingCodes: ['SAME_NAME_AND_PHONE'], warnings: [] }], nextCursor: null };
const comparison = (review, allowedActions) => ({ pair, asOf: '2026-10-20T10:00:00.000Z', customerA: customer, customerB: other, evidence, review, allowedActions });
const receipt = (kind = 'DECISION_RECORDED', resultingStatus = 'CONFIRMED_DUPLICATE', reasonCode = 'SAME_OPERATIONAL_CUSTOMER_VERIFIED', version = 1) => ({ reviewId: terminalReview.id, pair, reviewVersion: version, eventId: `30000000-0000-4000-8000-00000000000${version}`, eventKind: kind, resultingStatus, reasonCode, actorUserId: decision.actorUserId, occurredAt: decision.decidedAt });

const results = [];
function pass(name, detail = '') { results.push({ name, status: 'PASS', detail }); console.log(`PASS ${name}${detail ? `: ${detail}` : ''}`); }
const server = await createServer({ configFile: false, root: webRoot, appType: 'custom', plugins: [react()], server: { host: '127.0.0.1', port: 0 } });
const html = '<!doctype html><html lang="tr"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>Duplicate review decision browser acceptance</title></head><body><div id="root"></div><script type="module" src="/tests/fixtures/duplicate-review-browser-entry.tsx"></script></body></html>';
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
  const pageErrors = []; const consoleErrors = [];
  const watch = (page) => {
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error' && !message.text().includes('Failed to load resource')) consoleErrors.push(message.text()); });
  };

  async function setupPage(state) {
    const page = await context.newPage(); watch(page);
    if (state.clock) await page.clock.install({ time: new Date('2026-10-20T12:00:00Z') });
    await page.route('**/api/customers/**', async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() === 'GET' && url.pathname.endsWith('/history')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(history) });
      if (route.request().method() === 'GET') {
        state.gets += 1;
        if (url.pathname.endsWith('/duplicate-candidates')) {
          (state.lists ??= []).push(url.searchParams.toString());
          const items = url.searchParams.get('view') === 'ALL' ? [{ pair, customerA: customer, customerB: other, matchingCodes: evidence.matchingCodes, warnings: [], comparisonStatus: 'READY', review: terminalReview }] : [];
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ scope: { dataClass: 'BUSINESS', includesInactive: true, anchorCustomerId: url.searchParams.get('anchorCustomerId') }, asOf: '2026-10-20T10:00:00Z', matchingRuleVersion: 'crm-duplicate-v1', coverage: 'COMPLETE_SOURCE', rawPairCount: '1', largestNameGroupSize: 2, largestPhoneGroupSize: 2, items, page: { nextCursor: null, exhausted: true, evaluatedPairs: 1, returnedItems: items.length } }) });
        }
        if (state.afterDecision && state.getFailure) {
          if (state.getFailure === 'network') return route.abort('failed');
          return route.fulfill({ status: state.getFailure, headers: { 'Retry-After': '30' }, contentType: 'application/json', body: JSON.stringify({ code: state.getFailure === 429 ? 'RATE_LIMIT_EXCEEDED' : 'REVIEW_TEMPORARILY_UNAVAILABLE', error: 'Synthetic reconciliation failure' }) });
        }
        const review = state.afterReopen ? reopenedReview : state.afterDecision ? terminalReview : state.initialReview;
        const actions = review.reviewStatus === 'PENDING_REVIEW' ? ['DECIDE'] : ['REOPEN'];
        const data = comparison(review, actions);
        if (state.evidence) data.evidence = state.evidence;
        if (state.customer) data.customerA = state.customer;
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
      }
      const body = route.request().postDataJSON();
      state.posts.push({ url: url.pathname, body });
      if (state.command429) { state.command429 = false; return route.fulfill({ status: 429, headers: { 'Retry-After': '30' }, contentType: 'application/json', body: JSON.stringify({ code: 'RATE_LIMIT_EXCEEDED', error: 'Synthetic command quota' }) }); }
      if (state.dropFirst) { state.dropFirst = false; await route.abort('failed'); return; }
      if (url.pathname.endsWith('/reopen')) { state.afterReopen = true; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(receipt('REVIEW_REOPENED', 'PENDING_REVIEW', 'RECHECK_REQUESTED', 2)) }); }
      state.afterDecision = true;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(receipt()) });
    });
    await page.goto(`${origin}/duplicate-browser-test?${state.list ? `view=ALL&anchor=${pair.customerAId}` : 'comparison'}`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { level: 1, name: state.list ? 'Olası mükerrerler' : 'Müşteri karşılaştırması' }).waitFor({ timeout: 10000 });
    return page;
  }
  const fresh = (extra = {}) => ({ initialReview: pendingReview, gets: 0, posts: [], dropFirst: false, afterDecision: false, afterReopen: false, ...extra });
  async function prepare(page) {
    await page.getByRole('radio', { name: 'Mükerrer olarak doğrula' }).check();
    await page.locator('.duplicate-reason select').selectOption('SAME_OPERATIONAL_CUSTOMER_VERIFIED');
    await page.getByRole('button', { name: 'Mükerrer olarak doğrula', exact: true }).click();
  }

  // 1. decision flow, explicit reason/confirmation, GET reconciliation and history
  const decisionState = { initialReview: pendingReview, gets: 0, posts: [], dropFirst: false, afterDecision: false, afterReopen: false };
  const decisionPage = await setupPage(decisionState);
  assert.equal(await decisionPage.getByRole('radio', { name: 'Mükerrer olarak doğrula' }).count(), 1);
  assert.equal(await decisionPage.getByRole('button', { name: 'Mükerrer olarak doğrula' }).isDisabled(), true);
  await decisionPage.getByRole('radio', { name: 'Mükerrer olarak doğrula' }).check();
  await decisionPage.locator('.duplicate-reason select').selectOption('SAME_OPERATIONAL_CUSTOMER_VERIFIED');
  await decisionPage.getByRole('button', { name: 'Mükerrer olarak doğrula' }).click();
  await decisionPage.getByRole('dialog').getByText(/Müşteri kayıtları birleştirilmez/).waitFor({ timeout: 5000 });
  await decisionPage.getByRole('dialog').getByRole('button', { name: 'Kararı kaydet' }).click();
  await decisionPage.getByText('İnceleme kararı kaydedildi').waitFor({ timeout: 10000 });
  assert.equal(decisionState.posts.length, 1);
  assert.equal(decisionState.posts[0].body.decision, 'CONFIRMED_DUPLICATE');
  assert.equal(decisionState.posts[0].body.reasonCode, 'SAME_OPERATIONAL_CUSTOMER_VERIFIED');
  await decisionPage.getByText('Karar geçmişi').waitFor({ timeout: 5000 });
  await decisionPage.getByText('Aynı operasyonel müşteri olduğu doğrulandı').first().waitFor({ timeout: 5000 });
  assert.equal(await decisionPage.getByText(/Müşteriler birleştirilmez/).count() > 0, true);
  pass('UI-03/UI-06 decision, explicit confirmation, GET reconciliation and inline history');
  await decisionPage.screenshot({ path: join(out, 'decision.png'), fullPage: true });

  // 2. lost response, frozen attempt, reload restoration and exact retry
  const lostState = { initialReview: pendingReview, gets: 0, posts: [], dropFirst: true, afterDecision: false, afterReopen: false };
  const lostPage = await setupPage(lostState);
  await lostPage.getByRole('radio', { name: 'Mükerrer olarak doğrula' }).check();
  await lostPage.locator('.duplicate-reason select').selectOption('SAME_OPERATIONAL_CUSTOMER_VERIFIED');
  await lostPage.getByRole('button', { name: 'Mükerrer olarak doğrula' }).click();
  await lostPage.getByRole('dialog').getByRole('button', { name: 'Kararı kaydet' }).click();
  await lostPage.getByText('Aynı istek korunuyor').waitFor({ timeout: 5000 });
  const firstAction = lostState.posts[0].body.clientActionId;
  await lostPage.reload({ waitUntil: 'domcontentloaded' });
  await lostPage.getByText('Bekleyen bir inceleme isteği geri yüklendi').waitFor({ timeout: 10000 });
  await lostPage.getByRole('button', { name: 'Özgün isteği tekrar dene' }).click();
  await lostPage.getByText('İnceleme kararı kaydedildi').waitFor({ timeout: 10000 });
  assert.equal(lostState.posts[1].body.clientActionId, firstAction);
  pass('UI-04/UI-06 lost response preserves the actor-bound attempt and exact action id', `action=${firstAction}`);
  await lostPage.screenshot({ path: join(out, 'lost-response.png'), fullPage: true });

  // 3. explicit reopen of a terminal decision
  const reopenState = { initialReview: terminalReview, gets: 0, posts: [], dropFirst: false, afterDecision: false, afterReopen: false };
  const reopenPage = await setupPage(reopenState);
  await reopenPage.getByText('Karar geçmişi').waitFor({ timeout: 5000 });
  await reopenPage.getByRole('button', { name: 'Yeniden incele' }).click();
  await reopenPage.getByRole('dialog').getByText('Eski karar silinmez').waitFor({ timeout: 5000 });
  await reopenPage.getByRole('dialog').getByRole('button', { name: 'Yeniden incelemeye aç' }).click();
  await reopenPage.getByText('İnceleme yeniden açıldı').waitFor({ timeout: 10000 });
  assert.equal(reopenState.posts.length, 1);
  assert.equal(reopenState.posts[0].body.expectedReviewVersion, 1);
  pass('CMD-04/UI-03 explicit reopen appends a new cycle without deleting history');
  await reopenPage.screenshot({ path: join(out, 'reopen.png'), fullPage: true });

  // 4. mobile, text zoom, reflow, reduced motion, keyboard reachability
  const a11yState = { initialReview: pendingReview, gets: 0, posts: [], dropFirst: false, afterDecision: false, afterReopen: false };
  const a11yPage = await setupPage(a11yState);
  await a11yPage.setViewportSize({ width: 390, height: 844 });
  assert.equal(await a11yPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  const radio = a11yPage.getByRole('radio', { name: 'Mükerrer olarak doğrula' });
  const box = await a11yPage.locator('.duplicate-radio').first().boundingBox();
  assert.ok(box && box.height >= 44);
  await radio.focus();
  assert.equal(await radio.evaluate((element) => element === document.activeElement), true);
  await a11yPage.keyboard.press('Space');
  assert.equal(await radio.isChecked(), true);
  await a11yPage.setViewportSize({ width: 320, height: 844 });
  await a11yPage.waitForTimeout(150);
  assert.equal(await a11yPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await a11yPage.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await a11yPage.waitForTimeout(150);
  assert.equal(await a11yPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await a11yPage.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await a11yPage.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches), true);
  pass('UI-09 390px, 320px reflow, 200% text, keyboard and reduced-motion acceptance');
  await a11yPage.screenshot({ path: join(out, 'mobile-a11y.png'), fullPage: true });

  const unconfirmed = fresh(); const confirmationPage = await setupPage(unconfirmed);
  await prepare(confirmationPage);
  assert.equal(await confirmationPage.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith('CRM_DUPLICATE_COMMAND_ATTEMPT:')).length), 0);
  await confirmationPage.reload({ waitUntil: 'domcontentloaded' });
  await confirmationPage.getByRole('radio', { name: 'Mükerrer olarak doğrula' }).waitFor();
  assert.equal(await confirmationPage.getByRole('button', { name: 'Özgün isteği tekrar dene' }).count(), 0);
  assert.equal(unconfirmed.posts.length, 0);
  pass('F17 reload before explicit confirmation never restores an unapproved POST retry');

  const uncertain = fresh({ dropFirst: true }); const uncertainPage = await setupPage(uncertain);
  await prepare(uncertainPage); await uncertainPage.getByRole('dialog').getByRole('button', { name: 'Kararı kaydet' }).click();
  await uncertainPage.getByRole('button', { name: 'Özgün isteği tekrar dene' }).waitFor();
  assert.equal(await uncertainPage.getByRole('radio', { name: 'Mükerrer olarak doğrula' }).isDisabled(), true);
  uncertain.afterReopen = true;
  await uncertainPage.reload({ waitUntil: 'domcontentloaded' });
  await uncertainPage.getByRole('button', { name: 'Özgün isteği tekrar dene' }).waitFor();
  assert.equal(await uncertainPage.getByRole('radio', { name: 'Mükerrer olarak doğrula' }).isDisabled(), true);
  assert.equal(await uncertainPage.getByRole('button', { name: 'Güncel kanıtı inceledim; yeni istek oluştur', exact: true }).count(), 0);
  await uncertainPage.getByRole('button', { name: 'Özgün isteği tekrar dene' }).click();
  await uncertainPage.getByText('Güncel durum yüklendi.', { exact: true }).waitFor();
  assert.deepEqual(uncertain.posts[1].body, uncertain.posts[0].body);
  assert.equal(await uncertainPage.getByRole('radio', { name: 'Mükerrer olarak doğrula' }).count(), 1);
  pass('F11/F15 stale unresolved attempt replays the immutable receipt after later reopen and reconciles current pending state');

  const draft = fresh({ clock: true }); const draftPage = await setupPage(draft);
  await draftPage.getByRole('radio', { name: 'Mükerrer olarak doğrula' }).check();
  await draftPage.locator('.duplicate-reason select').selectOption('SAME_OPERATIONAL_CUSTOMER_VERIFIED');
  await draftPage.locator('.duplicate-reason select').focus();
  draft.customer = { ...customer, version: 2, contacts: customer.contacts.map((contact) => ({ ...contact, version: 2 })) };
  const witnessRefresh = draftPage.waitForResponse((response) => response.url().includes('/duplicate-review-pairs/'));
  await draftPage.clock.fastForward(60_000);
  await witnessRefresh;
  await draftPage.locator('main[aria-busy="false"]').waitFor();
  await draftPage.waitForFunction(() => document.querySelector('.duplicate-reason select') === document.activeElement);
  assert.equal(await draftPage.getByRole('button', { name: 'Mükerrer olarak doğrula', exact: true }).isDisabled(), false);
  draft.evidence = { ...evidence, revision: 'ev1.synthetic.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' };
  draft.customer = { ...draft.customer, contacts: [...draft.customer.contacts, { ...customer.contacts[0], id: '10000000-0000-4000-8000-0000000000c2' }] };
  await draftPage.clock.fastForward(1_001);
  const contactRefresh = draftPage.waitForResponse((response) => response.url().includes('/duplicate-review-pairs/'));
  await draftPage.evaluate(() => window.dispatchEvent(new Event('focus'))); await contactRefresh;
  await draftPage.getByRole('button', { name: 'Güncel kanıtı inceledim', exact: true }).waitFor();
  assert.equal(await draftPage.getByRole('button', { name: 'Mükerrer olarak doğrula', exact: true }).isDisabled(), true);
  assert.equal(await draftPage.locator('.duplicate-reason select').inputValue(), 'SAME_OPERATIONAL_CUSTOMER_VERIFIED');
  assert.equal(draft.posts.length, 0);
  await draftPage.getByRole('button', { name: 'Güncel kanıtı inceledim', exact: true }).click();
  await draftPage.getByRole('button', { name: 'Mükerrer olarak doğrula', exact: true }).click();
  await draftPage.getByRole('dialog').getByRole('button', { name: 'Kararı kaydet' }).click();
  await draftPage.getByText('İnceleme kararı kaydedildi').waitFor();
  assert.equal(draft.posts[0].body.expectedEvidenceRevision, draft.evidence.revision);
  pass('F12 60s witness-only poll preserves draft/focus; Contact membership focus refresh requires explicit reviewed evidence');

  const limited = fresh({ clock: true, command429: true }); const limitedPage = await setupPage(limited);
  await prepare(limitedPage); await limitedPage.getByRole('dialog').getByRole('button', { name: 'Kararı kaydet' }).click();
  await limitedPage.getByRole('button', { name: 'Özgün isteği tekrar dene' }).waitFor();
  assert.equal(await limitedPage.getByRole('dialog').count(), 0);
  assert.equal(await limitedPage.getByRole('button', { name: 'Özgün isteği tekrar dene' }).isDisabled(), true);
  await limitedPage.clock.fastForward(29_999); assert.equal(limited.posts.length, 1);
  await limitedPage.clock.fastForward(1);
  await limitedPage.getByRole('button', { name: 'Özgün isteği tekrar dene' }).click();
  await limitedPage.getByText('İnceleme kararı kaydedildi').waitFor();
  assert.deepEqual(limited.posts[0].body, limited.posts[1].body);
  pass('F19 real Chromium Retry-After closes dialog, blocks command controls and retries the same attempt at expiry');

  for (const failure of [429, 503, 'network']) {
    const failedGet = fresh({ getFailure: failure, clock: true }); const failedPage = await setupPage(failedGet);
    await prepare(failedPage); await failedPage.getByRole('dialog').getByRole('button', { name: 'Kararı kaydet' }).click();
    await failedPage.getByText('Güncel durum doğrulanamadı.', { exact: false }).waitFor();
    assert.equal(await failedPage.getByText('Güncel durum yüklendi.', { exact: true }).count(), 0);
    assert.equal(failedGet.posts.length, 1);
    failedGet.getFailure = null;
    if (failure === 429) await failedPage.clock.fastForward(30_000);
    await failedPage.getByRole('button', { name: 'Güncel durumu doğrula' }).click();
    await failedPage.getByText('Güncel durum yüklendi.', { exact: true }).waitFor();
    assert.equal(failedGet.posts.length, 1);
    pass(`F15 receipt remains successful while GET ${failure} reconciliation fails and is retried independently`);
  }

  const allState = fresh({ list: true, initialReview: terminalReview }); const allPage = await setupPage(allState);
  await allPage.getByRole('link', { name: /İki müşteriyi karşılaştır/ }).click();
  await allPage.getByText('Karar geçmişi').waitFor();
  await allPage.getByRole('link', { name: /Olası mükerrerler'e dön/ }).click();
  await allPage.getByLabel('İnceleme görünümü').waitFor();
  assert.equal(await allPage.getByLabel('İnceleme görünümü').inputValue(), 'ALL');
  assert.ok(allState.lists.every((query) => new URLSearchParams(query).get('view') === 'ALL'));
  assert.ok(allState.lists.every((query) => new URLSearchParams(query).get('anchorCustomerId') === pair.customerAId));
  await allPage.getByLabel('İnceleme görünümü').selectOption('ATTENTION');
  await allPage.getByText('Bu kapsamda aday bulunamadı').waitFor();
  assert.equal(new URLSearchParams(allState.lists.at(-1)).get('view'), 'ATTENTION');
  pass('F13 ALL deep link, anchor and comparison return retain terminal pair/history access; view switch resets cursor');

  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);
  pass('No browser page or console errors');
  writeFileSync(join(out, 'results.json'), JSON.stringify({ browser: await browser.version(), results }, null, 2));
  console.log(JSON.stringify({ out, results }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
