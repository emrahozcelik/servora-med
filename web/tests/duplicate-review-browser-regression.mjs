import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { createServer } from 'vite';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(join(webRoot, 'package.json'));
const { chromium } = require('playwright');
const out = process.env.DUPLICATE_BROWSER_OUT ?? join(tmpdir(), 'servora-med-duplicate-review-browser');
mkdirSync(out, { recursive: true });

const customerA = { id: '10000000-0000-4000-8000-000000000001', name: 'Sentetik Eski Müşteri — İstanbul Ağız ve Diş Sağlığı Kliniği', status: 'active', city: 'İstanbul', district: 'Merkez' };
const customerB = { ...customerA, id: '10000000-0000-4000-8000-000000000002', status: 'inactive' };
const pair = { customerAId: customerA.id, customerBId: customerB.id };
const review = { id: null, version: 0, reviewStatus: 'PENDING_REVIEW', effectiveStatus: 'PENDING_REVIEW', freshness: 'NOT_APPLICABLE', currentDecision: null, lastDecision: null };
const pageFor = (comparisonStatus) => ({
  scope: { dataClass: 'BUSINESS', includesInactive: true, anchorCustomerId: null },
  asOf: '2026-10-19T10:00:00.000Z',
  matchingRuleVersion: 'crm-duplicate-v1',
  coverage: 'COMPLETE_SOURCE',
  rawPairCount: '1',
  largestNameGroupSize: 2,
  largestPhoneGroupSize: 2,
  items: [{ pair, customerA, customerB, matchingCodes: ['SAME_NAME_AND_PHONE'], warnings: [], comparisonStatus, review }],
  page: { nextCursor: null, exhausted: true, evaluatedPairs: 1, returnedItems: 1 },
});

const results = [];
function pass(name, detail = '') {
  results.push({ name, status: 'PASS', detail });
  console.log(`PASS ${name}${detail ? `: ${detail}` : ''}`);
}
async function fulfill(route, status, body, headers = {}) {
  await route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });
}

const server = await createServer({ configFile: false, root: webRoot, appType: 'custom', plugins: [react()], server: { host: '127.0.0.1', port: 0 } });
const html = '<!doctype html><html lang="tr"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>Duplicate review browser regression</title></head><body><div id="root"></div><script type="module" src="/tests/fixtures/duplicate-review-browser-entry.tsx"></script></body></html>';
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

  const quotaPage = await context.newPage(); watch(quotaPage);
  let quotaCalls = 0;
  await quotaPage.route('**/api/customers/**', async (route) => {
    quotaCalls += 1;
    if (quotaCalls === 1) return fulfill(route, 200, pageFor('READY'));
    if (quotaCalls === 2) return fulfill(route, 429, { error: 'Sentetik kota', code: 'RATE_LIMIT_EXCEEDED' }, { 'Retry-After': '5' });
    return fulfill(route, 200, pageFor('READY'));
  });
  await quotaPage.goto(`${origin}/duplicate-browser-test`, { waitUntil: 'domcontentloaded' });
  await quotaPage.getByText(customerA.name).first().waitFor({ timeout: 10000 });
  await quotaPage.getByRole('button', { name: 'Yenile', exact: true }).click();
  const quotaAlert = quotaPage.getByRole('alert').filter({ hasText: 'Sentetik kota' });
  await quotaAlert.waitFor({ timeout: 5000 });
  assert.equal(await quotaPage.getByText(/yaklaşık 5 saniye/).isVisible(), true);
  assert.equal(await quotaPage.getByRole('button', { name: 'Tekrar dene' }).isDisabled(), true);
  assert.equal(await quotaPage.getByRole('button', { name: 'Yenile', exact: true }).isDisabled(), true);
  assert.equal(quotaCalls, 2);
  await quotaAlert.waitFor({ state: 'detached', timeout: 12000 });
  assert.equal(quotaCalls, 3);
  assert.equal(await quotaPage.getByText(customerA.name).first().isVisible(), true);
  pass('F05 429 wait and bounded automatic retry', `requests=${quotaCalls}`);
  await quotaPage.screenshot({ path: join(out, 'f05-429.png'), fullPage: true });
  await quotaPage.close();

  const overPage = await context.newPage(); watch(overPage);
  await overPage.route('**/api/customers/**', (route) => fulfill(route, 200, pageFor('OVER_BUDGET')));
  await overPage.goto(`${origin}/duplicate-browser-test`, { waitUntil: 'domcontentloaded' });
  await overPage.getByText(customerA.name).first().waitFor({ timeout: 10000 });
  assert.equal(await overPage.getByRole('link', { name: /İki müşteriyi karşılaştır/ }).count(), 0);
  assert.equal(await overPage.locator('a[href*="duplicate-review-pairs"]').count(), 0);
  assert.equal(await overPage.getByText('Kanıt bütünü doğrulanamadığı için bu çiftte karşılaştırma açılamaz').isVisible(), true);
  assert.equal(await overPage.getByText('İsim ve telefon aynı').isVisible(), true);
  assert.equal(await overPage.getByRole('status').filter({ hasText: 'Kanıt bütünü doğrulanamadığı için' }).count(), 1);
  const anchorLink = overPage.getByRole('link', { name: 'Bu müşterinin adayları' }).first();
  await anchorLink.focus();
  assert.equal(await anchorLink.evaluate((element) => element === document.activeElement), true);
  pass('F06 OVER_BUDGET keeps reasons and explanation without an unusable link');
  await overPage.screenshot({ path: join(out, 'f06-over-budget.png'), fullPage: true });
  await overPage.close();

  const readyPage = await context.newPage(); watch(readyPage);
  await readyPage.route('**/api/customers/**', (route) => fulfill(route, 200, pageFor('READY')));
  await readyPage.goto(`${origin}/duplicate-browser-test`, { waitUntil: 'domcontentloaded' });
  await readyPage.getByText(customerA.name).first().waitFor({ timeout: 10000 });
  assert.equal(await readyPage.getByRole('link', { name: /İki müşteriyi karşılaştır/ }).count(), 1);
  pass('F06 READY still exposes the comparison link');
  await readyPage.screenshot({ path: join(out, 'f06-ready.png'), fullPage: true });
  await readyPage.close();

  for (const status of [401, 403, 404, 503]) {
    const accessPage = await context.newPage(); watch(accessPage);
    let calls = 0;
    await accessPage.route('**/api/customers/**', async (route) => {
      calls += 1;
      if (calls === 1) return fulfill(route, 200, pageFor('READY'));
      return fulfill(route, status, { error: `Sentetik ${status}`, code: status === 403 ? 'FORBIDDEN' : 'REVIEW_TEMPORARILY_UNAVAILABLE' });
    });
    await accessPage.goto(`${origin}/duplicate-browser-test`, { waitUntil: 'domcontentloaded' });
    await accessPage.getByText(customerA.name).first().waitFor({ timeout: 10000 });
    await accessPage.getByRole('button', { name: 'Yenile', exact: true }).click();
    await accessPage.getByRole('alert').filter({ hasText: `Sentetik ${status}` }).waitFor({ timeout: 5000 });
    const text = await accessPage.locator('body').innerText();
    if (status === 503) {
      assert.equal(text.includes(customerA.name), true);
      assert.match(text, /güncellikleri doğrulanamadı/);
    } else {
      assert.equal(text.includes(customerA.name), false);
      assert.equal(text.includes('İsim ve telefon aynı'), false);
    }
    assert.equal(calls, 2);
    pass(`F01 refresh ${status}`, status === 503 ? 'stale data retained' : 'protected data cleared');
    await accessPage.close();
  }

  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);
  pass('No browser page or console errors');
  writeFileSync(join(out, 'results.json'), JSON.stringify({ browser: await browser.version(), results }, null, 2));
  console.log(JSON.stringify({ out, results }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
