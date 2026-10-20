import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import react from '@vitejs/plugin-react';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const { chromium } = createRequire(join(root, 'package.json'))('playwright');
const out = process.env.DUPLICATE_HISTORY_OUT ?? join(process.env.TMPDIR ?? '/tmp', 'servora-duplicate-history-browser');
mkdirSync(out, { recursive: true });
const pair = { customerAId: '10000000-0000-4000-8000-000000000001', customerBId: '10000000-0000-4000-8000-000000000002' };
const reviewId = '20000000-0000-4000-8000-000000000001';
const actorUserId = '10000000-0000-4000-8000-0000000000aa';
const customer = { id: pair.customerAId, name: 'Sentetik Klinik', status: 'active', city: 'İstanbul', district: null, customerType: 'clinic', taxNumber: null, phone: '+905321234567', email: null, address: null, version: 1, assignedStaffUserId: null, contacts: [] };
const evidence = { revision: 'ev1.synthetic.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', schemaVersion: 1, matchingRuleVersion: 'crm-duplicate-v1', matchingCodes: ['SAME_NAME_AND_PHONE'], warnings: [] };
const seqs = (n, count = 20) => Array.from({ length: Math.min(n, count) }, (_, i) => n - i);
const event = seq => ({ eventId: `event-${seq}`, seq, eventKind: 'DECISION_RECORDED', resultingStatus: 'DISMISSED', reasonCode: 'DISTINCT_CUSTOMER', actorUserId, occurredAt: '2026-10-20T10:00:00Z', matchingRuleVersion: 'crm-duplicate-v1', matchingCodes: ['SAME_NAME_AND_PHONE'], warnings: [] });
const history = (upper, items, nextCursor = null) => ({ reviewId, upperSeq: upper, items: items.map(event), nextCursor });
function comparison(state) {
  const decision = { ...event(state.version), status: 'DISMISSED', decidedAt: '2026-10-20T10:00:00Z' };
  return { pair, asOf: '2026-10-20T10:00:00Z', customerA: customer, customerB: { ...customer, id: pair.customerBId }, evidence,
    review: { id: reviewId, version: state.version, reviewStatus: state.pending ? 'PENDING_REVIEW' : 'DISMISSED', effectiveStatus: state.pending ? 'PENDING_REVIEW' : 'DISMISSED', freshness: 'CURRENT', freshnessReason: null, currentDecision: state.pending ? null : decision, lastDecision: decision }, allowedActions: [state.pending ? 'DECIDE' : 'REOPEN'] };
}
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const results = [];
const server = await createServer({ configFile: false, root, appType: 'custom', plugins: [react()], server: { host: '127.0.0.1', port: 0 } });
server.middlewares.use(async (req, res, next) => {
  if (!req.url?.startsWith('/duplicate-browser-test')) return next();
  res.setHeader('Content-Type', 'text/html');
  res.end(await server.transformIndexHtml('/duplicate-browser-test', '<!doctype html><html lang="tr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/fixtures/duplicate-review-browser-entry.tsx"></script></body></html>'));
});
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  async function setup(extra = {}) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const state = { version: 21, pending: false, requests: [], errors: [], ...extra };
    page.on('pageerror', error => state.errors.push(error.message));
    await page.clock.install({ time: new Date('2026-10-20T12:00:00Z') });
    // Deliberately emulate a transport that ignores abort: generation guards must still win.
    await page.addInitScript(() => { const fetch = window.fetch; window.fetch = (input, init) => fetch(input, String(input).includes('/history?') ? { ...init, signal: undefined } : init); });
    await page.route('**/api/customers/**', async route => {
      const url = new URL(route.request().url());
      state.requests.push({ method: route.request().method(), path: url.pathname, cursor: url.searchParams.get('cursor') });
      const send = (body, status = 200, headers = {}) => route.fulfill({ status, headers, contentType: 'application/json', body: JSON.stringify(body) });
      if (route.request().method() === 'POST') {
        const reopen = url.pathname.endsWith('/reopen'); state.version++; state.pending = reopen;
        return send({ reviewId, pair, reviewVersion: state.version, eventId: `event-${state.version}`, eventKind: reopen ? 'REVIEW_REOPENED' : 'DECISION_RECORDED', resultingStatus: reopen ? 'PENDING_REVIEW' : 'DISMISSED', reasonCode: reopen ? 'RECHECK_REQUESTED' : 'DISTINCT_CUSTOMER', actorUserId, occurredAt: '2026-10-20T12:00:00Z' });
      }
      if (url.pathname.endsWith('/history')) {
        const cursor = url.searchParams.get('cursor');
        if (cursor && state.hold) { const gate = state.hold; state.hold = null; state.held = true; const status = await gate.promise; return status === 200 ? send(history(21, [1])) : send({ code: status === 429 ? 'RATE_LIMIT_EXCEEDED' : 'REVIEW_TEMPORARILY_UNAVAILABLE', error: 'Synthetic old page error' }, status, { 'Retry-After': '65' }); }
        if (cursor && state.pageFailure) { const status = state.pageFailure; state.pageFailure = null; return send({ code: status === 429 ? 'RATE_LIMIT_EXCEEDED' : 'REVIEW_TEMPORARILY_UNAVAILABLE', error: 'Synthetic current page error' }, status, { 'Retry-After': '65' }); }
        if (!cursor && state.initialQuota) { state.initialQuota = false; return send({ code: 'RATE_LIMIT_EXCEEDED', error: 'Synthetic initial quota' }, 429, { 'Retry-After': '65' }); }
        return send(cursor ? history(state.version, seqs(state.version - 20)) : history(state.version, seqs(state.version), `upper${state.version}.before${state.version - 19}`));
      }
      return send(comparison(state));
    });
    await page.goto(`${origin}/duplicate-browser-test?comparison`, { waitUntil: 'domcontentloaded' });
    await page.getByText('Karar geçmişi', { exact: true }).waitFor();
    return { page, context, state };
  }
  const readSeqs = page => page.locator('.duplicate-history-list li > p:first-of-type').evaluateAll(els => els.map(el => Number(el.textContent.match(/Sıra (\d+)$/)?.[1])));
  const until = async (page, predicate) => { for (let i = 0; i < 100; i++) { if (await predicate()) return; await page.waitForTimeout(20); } throw new Error('Browser assertion did not settle'); };
  for (const [command, status] of [['reopen', 200], ['reopen', 429], ['reopen', 503], ['decide', 200]]) {
    const gate = deferred(); const { page, context, state } = await setup({ hold: gate, pending: command === 'decide' });
    await until(page, async () => (await readSeqs(page)).length === 20);
    await page.getByRole('button', { name: 'Daha eski kararlar' }).click();
    await until(page, () => state.held);
    if (command === 'reopen') {
      await page.getByRole('button', { name: 'Yeniden incele', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Yeniden incelemeye aç' }).click();
    } else {
      await page.getByRole('radio', { name: 'Eşleşmeyi reddet' }).check();
      await page.locator('.duplicate-reason select').selectOption('DISTINCT_CUSTOMER');
      await page.getByRole('button', { name: 'Eşleşmeyi reddet', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Kararı kaydet' }).click();
    }
    await until(page, async () => (await readSeqs(page))[0] === 22);
    gate.resolve(status); await page.waitForTimeout(150);
    assert.deepEqual(await readSeqs(page), seqs(22));
    assert.equal(await page.getByText('Synthetic old page error').count(), 0);
    await page.getByRole('button', { name: 'Daha eski kararlar' }).click();
    await until(page, async () => (await readSeqs(page)).length === 22);
    assert.deepEqual(await readSeqs(page), seqs(22, 22));
    assert.equal(state.requests.at(-1).cursor, 'upper22.before3');
    assert.deepEqual(state.errors, []);
    results.push({ name: `F20 ${command} while old pagination pending; late HTTP ${status}`, status: 'PASS', requests: state.requests });
    await context.close();
  }
  for (const status of [429, 503, 403]) {
    const { page, context, state } = await setup({ pageFailure: status });
    await until(page, async () => (await readSeqs(page)).length === 20);
    await page.getByRole('button', { name: 'Daha eski kararlar' }).click();
    if (status === 403) {
      await until(page, async () => (await readSeqs(page)).length === 0);
      assert.equal(await page.getByRole('button', { name: 'Daha eski kararlar' }).count(), 0);
    } else {
      await page.getByText(/güncelliği doğrulanamadı/).waitFor();
      assert.deepEqual(await readSeqs(page), seqs(21));
      if (status === 429) {
        await page.getByText(/65 saniye/, { exact: false }).first().waitFor();
        const count = state.requests.length;
        assert.equal(await page.getByRole('button', { name: 'Geçmişi tekrar dene' }).isDisabled(), true);
        await page.clock.runFor(60000);
        await page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online')); });
        assert.equal(state.requests.length, count);
        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.screenshot({ path: join(out, 'history-429-mobile.png'), fullPage: true });
        await page.clock.runFor(5000);
      } else await page.getByRole('button', { name: 'Geçmişi tekrar dene' }).click();
      await until(page, async () => (await readSeqs(page)).length === 21);
      assert.deepEqual(await readSeqs(page), seqs(21, 21));
      const pages = state.requests.filter(r => r.cursor);
      assert.equal(pages.length, 2); assert.equal(pages[0].cursor, pages[1].cursor);
    }
    assert.deepEqual(state.errors, []);
    results.push({ name: `F21 pagination HTTP ${status}: retained freshness or definitive clearance`, status: 'PASS', requests: state.requests });
    await context.close();
  }
  const { page, context, state } = await setup({ initialQuota: true });
  await page.getByText(/65 saniye/).first().waitFor();
  const count = state.requests.length;
  await page.clock.runFor(60000);
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online')); });
  assert.equal(state.requests.length, count);
  await page.clock.runFor(5000);
  await until(page, async () => (await readSeqs(page)).length === 20);
  results.push({ name: 'F21 initial history quota shares comparison polling/focus cooldown; bounded expiry retry', status: 'PASS', requests: state.requests });
  await context.close();
  writeFileSync(join(out, 'results.json'), JSON.stringify({ status: 'PASS', browser: browser.version(), node: process.version, transport: 'controlled synthetic HTTP; abort ignored for F20 pagination', results }, null, 2));
  console.log(`PASS ${results.length}/${results.length} history Chromium acceptance`);
} finally { await browser?.close(); await server.close(); }
