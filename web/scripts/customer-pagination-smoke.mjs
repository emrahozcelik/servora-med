import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import * as fixture from './customer-pagination-fixture.ts';

// Run from web/. All responses and identities are synthetic; mutations fail.
const root = process.cwd();
const out = process.env.CUSTOMER_PAGING_CAPTURE_DIR;
assert.ok(out, 'Set CUSTOMER_PAGING_CAPTURE_DIR to a task-owned output directory.');
mkdirSync(out, { recursive: true });
const entry = `
import React from 'react'; import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom'; import { App } from '/src/App';
import { ServoraAntProvider } from '/src/ui/antd/ServoraAntProvider'; import '/src/styles.css';
const user = ${JSON.stringify(fixture.user)};
user.role = new URLSearchParams(location.search).get('reviewRole') || 'MANAGER';
if (user.role === 'STAFF') { user.id = '${fixture.staffId}'; user.name = ${JSON.stringify(fixture.profile.user.name)}; }
Object.defineProperty(window, 'EventSource', { configurable: true, value: undefined });
createRoot(document.getElementById('root')).render(<ServoraAntProvider><BrowserRouter><App initialUser={user}/></BrowserRouter></ServoraAntProvider>);`;
let vite;
const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (!path.includes('.') && !path.startsWith('/@')) {
    res.setHeader('Content-Type', 'text/html;charset=utf-8');
    res.end(await vite.transformIndexHtml(req.url, '<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__customer-paging.tsx"></script></body></html>'));
  } else vite.middlewares(req, res);
});
const virtual = resolve(root, '__customer-paging.tsx');
vite = await createViteServer({ root, configFile: false, appType: 'custom', logLevel: 'error',
  plugins: [{ name: 'customer-paging', enforce: 'pre', resolveId(id) { if (id === '/__customer-paging.tsx') return virtual; }, load(id) { if (id === virtual) return entry; } }],
  server: { host: '127.0.0.1', middlewareMode: true, hmr: false, ws: { server, host: '127.0.0.1' } } });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const checks = [], errors = [], unexpected = [], calls = [];

async function open(width, role = 'MANAGER') {
  const page = await browser.newPage({ viewport: { width, height: width < 768 ? 844 : 960 }, locale: 'tr-TR', timezoneId: 'Europe/Istanbul', reducedMotion: 'reduce', hasTouch: width < 768 });
  page.setDefaultTimeout(12000);
  await page.clock.setFixedTime(new Date('2026-11-06T10:00:00Z'));
  page.on('pageerror', e => errors.push(e.message));
  let releaseOld;
  const oldGate = new Promise(r => { releaseOld = r; });
  await page.route('**/api/**', async route => {
    const u = new URL(route.request().url()), path = u.pathname;
    if (route.request().method() !== 'GET') { unexpected.push(`mutation ${path}`); return route.fulfill({ status: 500, json: {} }); }
    if (path === '/api/customers') {
      const limit = Number(u.searchParams.get('limit')), offset = Number(u.searchParams.get('offset'));
      assert.equal(limit, 6); assert.ok(Number.isSafeInteger(offset) && offset >= 0);
      calls.push({ role, width, limit, offset, q: u.searchParams.get('q'), status: u.searchParams.get('status') });
      if (u.searchParams.get('q') === 'Eski') await oldGate;
      const count = Number(new URL(page.url()).searchParams.get('reviewCount') ?? 12);
      let rows = fixture.customers.slice(0, count);
      if (u.searchParams.get('status')) rows = rows.filter(c => c.status === u.searchParams.get('status'));
      if (u.searchParams.get('q')) rows = rows.filter(c => c.name.includes(u.searchParams.get('q')));
      return route.fulfill({ json: { items: rows.slice(offset, offset + limit), total: rows.length, limit, offset } });
    }
    const responses = {
      '/api/staff': [fixture.profile], '/api/reports/staff': fixture.staffPerformance,
      [`/api/reports/staff/${fixture.staffId}`]: fixture.report,
      '/api/reports/sales-follow-up': fixture.salesFollowUp,
      '/api/reports/dashboard': fixture.dashboard, '/api/reports/business-trend': fixture.business,
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/web-push/status': { enabled: false, vapidPublicKey: null, renewalRequired: false, subscription: null },
    };
    if (path in responses) return route.fulfill({ json: responses[path] });
    unexpected.push(path); return route.fulfill({ status: 500, json: {} });
  });
  return { page, releaseOld, goto: path => page.goto(`${origin}${path}${path.includes('?') ? '&' : '?'}reviewRole=${role}`) };
}
async function ready(page, count = 6) {
  await page.waitForFunction(n => document.querySelectorAll('.customer-list > li').length === n && !document.querySelector('.customer-loading'), count);
}
async function inspect(page, name) {
  await page.evaluate(() => document.fonts.ready);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  await page.screenshot({ path: resolve(out, `${name}.png`), fullPage: true });
  if (overflow) {
    const offenders = await page.locator('main *').evaluateAll(nodes => nodes.flatMap(node => {
      const r = node.getBoundingClientRect();
      return r.right > innerWidth + 1 ? [{ tag: node.tagName, class: node.className, text: node.textContent.slice(0, 100), left: r.left, right: r.right }] : [];
    }).slice(0, 20));
    writeFileSync(resolve(out, `${name}-overflow.json`), JSON.stringify(offenders, null, 2));
  }
  assert.equal(overflow, false, `${name}: overflow`);
  assert.equal(await page.locator('main [role="alert"]').count(), 0, `${name}: unexpected alert`);
  assert.doesNotMatch(await page.locator('main').innerText(), /meeting_at|Europe\/Istanbul|\b(?:NEW|ACCEPTED|IN_PROGRESS)\b/);
  checks.push(name);
}
try {
  for (const width of [320, 390, 1440]) {
    for (const role of ['MANAGER', 'STAFF']) {
      const { page, goto } = await open(width, role);
      const before = calls.length;
      await goto('/customers'); await ready(page);
      assert.equal(calls.length - before, 1, 'one initial customer request');
      assert.match(await page.locator('.customer-pagination').innerText(), /Sayfa 1 \/ 2.*Toplam 12/);
      assert.equal(await page.getByRole('link', { name: /müşterisini düzenle/ }).count(), role === 'STAFF' ? 0 : 6);
      await inspect(page, `customers-${role}-${width}`);
      await page.locator('.customer-pagination .servora-ant-pagination-next button').click();
      await page.getByRole('link', { name: fixture.customers[6].name, exact: true }).waitFor();
      assert.equal(new URL(page.url()).searchParams.get('offset'), '6');
      await page.locator('.customer-pagination .servora-ant-pagination-prev button').click();
      await page.getByRole('link', { name: fixture.customers[0].name, exact: true }).waitFor();
      await goto('/customers?offset=6'); await ready(page);
      await page.locator('#customer-search').fill('Klinik 07');
      await ready(page, 1);
      assert.equal(new URL(page.url()).searchParams.has('offset'), false);
      assert.match(await page.locator('.customer-list').innerText(), /Klinik 07/);
      await goto('/customers?offset=6'); await ready(page);
      const filteredResponse = page.waitForResponse(r => new URL(r.url()).pathname === '/api/customers' && new URL(r.url()).searchParams.get('status') === 'active');
      if (width < 1024) {
        await page.getByRole('button', { name: /^Filtreler/ }).click();
        await page.locator('#customer-sheet-status').selectOption('active');
        await page.getByRole('button', { name: 'Uygula', exact: true }).click();
      } else await page.locator('#customer-status').selectOption('active');
      await filteredResponse;
      await page.getByRole('link', { name: fixture.customers[2].name, exact: true }).waitFor();
      await ready(page);
      assert.equal(new URL(page.url()).searchParams.has('offset'), false);
      assert.equal(calls.at(-1).status, 'active');
      await inspect(page, `customers-filtered-${role}-${width}`);
      await page.close();
    }
    for (const [name, path, selector] of [
      ['business', '/reports', '.business-trend-plot'],
      ['team', '/reports/staff', '.staff-performance-comparison'],
      ['staff-period', `/staff/${fixture.staffId}/reports`, '.staff-operational-report'],
      ['sales-follow-up', '/reports/sales-follow-up', '[data-outcome-disclosure]'],
    ]) {
      const { page, goto } = await open(width);
      await goto(path); await page.locator(selector).waitFor();
      if (name === 'sales-follow-up') assert.match(await page.locator('main').innerText(), /dağılım geçmişteki durumu kesin olarak yansıtmaz/);
      await inspect(page, `${name}-${width}`); await page.close();
    }
  }
  const { page, goto, releaseOld } = await open(390);
  for (const [count, offset, expected] of [[0, 0, 0], [1, 0, 1], [5, 0, 5], [6, 0, 6], [7, 0, 6], [7, 6, 1], [12, 6, 6], [12, 12, 6], [12, 13, 6], [0, 12, 0]]) {
    const before = calls.length;
    await goto(`/customers?reviewCount=${count}&offset=${offset}`);
    if (expected) await ready(page, expected); else await page.locator('[data-servora-empty-state]').waitFor();
    if (offset >= count && offset > 0) assert.equal(calls.at(-1).offset, Math.max(0, Math.ceil(count / 6) - 1) * 6);
    assert.ok(calls.length - before <= 2, 'out-of-range recovery stays bounded');
    assert.equal(await page.locator('.customer-pagination').count(), count > 6 ? 1 : 0);
    const urlOffset = new URL(page.url()).searchParams.get('offset');
    assert.ok(urlOffset === null || urlOffset === String(calls.at(-1).offset), `canonical URL offset for ${count}/${offset}`);
    await inspect(page, `customers-count-${count}-offset-${offset}`);
  }
  for (const offset of ['invalid', '-5', '7.5', '1e100', '9007199254740992', '7', '9007199254740991']) {
    const before = calls.length;
    await goto(`/customers?offset=${offset}`); await ready(page, 6);
    assert.equal(calls.at(-1).offset, offset === '7' || offset === '9007199254740991' ? 6 : 0);
    assert.ok(calls.length - before <= 2, 'offset canonicalization stays bounded');
    const canonicalOffset = new URL(page.url()).searchParams.get('offset');
    assert.ok(
      canonicalOffset === null || canonicalOffset === String(calls.at(-1).offset),
      `${offset}: canonical URL`,
    );
    if (offset === '7') assert.equal(calls.length - before, 1, 'aligned legacy offset issues one request');
  }
  await goto('/customers'); await ready(page, 6);
  await page.locator('.customer-pagination .servora-ant-pagination-next').focus();
  await page.keyboard.press('Enter');
  await page.getByRole('link', { name: fixture.customers[6].name, exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('offset'), '6');
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('servora-list-pagination')), true);
  await inspect(page, 'customers-keyboard-next-390');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Space');
  await page.getByRole('link', { name: fixture.customers[0].name, exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.has('offset'), false);
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('servora-list-pagination')), true);
  await inspect(page, 'customers-keyboard-prev-390');
  await goto('/customers?q=Eski'); await page.locator('#customer-search').waitFor();
  await page.locator('#customer-search').fill('Klinik 07'); await ready(page, 1);
  const oldResponse = page.waitForResponse(r => new URL(r.url()).searchParams.get('q') === 'Eski');
  releaseOld(); await oldResponse;
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  assert.match(await page.locator('.customer-list').innerText(), /Klinik 07/);
  await page.close();
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  writeFileSync(resolve(out, 'checks.json'), JSON.stringify({ browser: browser.version(), fixedTime: '2026-11-06T10:00:00Z', synthetic: true, locale: 'tr-TR', timezone: 'Europe/Istanbul', checks, errors, unexpected, calls }, null, 2));
  console.log(`PASS: ${checks.length} captures; paging/search/filter/race interactions; no page errors, unexpected API requests or document overflow.`);
} catch (error) {
  writeFileSync(resolve(out, 'failure.json'), JSON.stringify({ error: String(error), errors, unexpected, calls }, null, 2));
  throw error;
} finally { await browser.close(); await vite.close(); await new Promise(r => server.close(r)); }
