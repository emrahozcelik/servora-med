import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

// Run from the repository root. No production APIs or mutations are used.
const repo = process.cwd();
const root = resolve(repo, 'web');
const out = resolve(process.env.JOB_CREATE_CAPTURE_DIR || '/tmp/servora-job-create-ui');
mkdirSync(out, { recursive: true });
const require = createRequire(resolve(root, 'package.json'));
const { chromium } = require('playwright');
const { createServer: createViteServer } = await import(pathToFileURL(require.resolve('vite')));
const org = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const staffId = '11111111-1111-4111-8111-111111111111';
const managerId = '22222222-2222-4222-8222-222222222222';
const customerId = '33333333-3333-4333-8333-333333333333';
const stamp = '2026-11-04T09:00:00.000Z';
const now = '2026-11-05T06:00:00.000Z';
const member = { id: staffId, organizationId: org, name: 'Ayşe Örnek', email: 'ayse@example.test', role: 'STAFF', mustChangePassword: false, isActive: true, version: 1, lastLoginAt: stamp, createdAt: stamp, updatedAt: stamp };
const profile = { id: '44444444-4444-4444-8444-444444444444', user: member, title: 'Saha temsilcisi', phone: '+905551110000', region: 'İstanbul', managerUserId: managerId, managerName: 'Deniz Örnek', version: 1, counters: { open: 0, waitingApproval: 0, revisionRequested: 0, completedThisMonth: 0, overdue: 0 } };
const customer = { id: customerId, organizationId: org, name: 'Merkez Ağız ve Diş Sağlığı Kliniği', customerType: 'clinic', taxNumber: null, phone: '+905551110000', email: 'klinik@example.test', city: 'İstanbul', district: 'Ataşehir', address: 'Örnek Mahallesi, Klinik Sokak No: 10', assignedStaffUserId: staffId, assignedStaffName: member.name, status: 'active', version: 1, primaryContact: null, contacts: [], hasOperationHistory: false, openJobCount: 0, completedJobCount: 0 };
const products = [
  { id: '55555555-5555-4555-8555-555555555555', name: 'ProSeal Kollajen Membran 20 × 30 mm', sku: 'MED-1001', brand: 'ProSeal', unit: 'adet' },
  { id: '66666666-6666-4666-8666-666666666666', name: 'Steril Cerrahi Örtü Seti', sku: 'MED-1002', brand: 'DentalCare', unit: 'paket' },
].map(p => ({ ...p, organizationId: org, category: 'Cerrahi ürünler', model: null, referencePrice: null, isActive: true, version: 1, createdAt: stamp, updatedAt: stamp, hasOperationHistory: false }));
const clearEvaluation = { level: 'CLEAR', safeMessage: null, conflicts: [], recentVisit: null, suggestedAlternativeAt: null };
const fixtureData = { org, staffId, managerId, customerId, member, profile, customer, products, clearEvaluation, now };
writeFileSync(resolve(out, 'source.patch'), execFileSync('git', ['diff', '--', 'web/src', 'web/tests'], { cwd: repo }));
writeFileSync(resolve(out, 'fixture-data.json'), JSON.stringify(fixtureData, null, 2));
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from '/src/App';
import { ServoraAntProvider } from '/src/ui/antd/ServoraAntProvider';
import '/src/styles.css';
const role = new URLSearchParams(location.search).get('reviewRole') || 'MANAGER';
const staff = role === 'STAFF';
const user = { id: staff ? '${staffId}' : '${managerId}', organizationId: '${org}', name: staff ? 'Ayşe Örnek' : 'Deniz Örnek', email: 'ornek@example.test', role, mustChangePassword: false, isActive: true, version: 1, capabilities: { overviewDashboard: false, calendar: false, messaging: false }, support: { displayLabel: 'Örnek destek', email: null, helpUrl: null } };
Object.defineProperty(window, 'EventSource', { configurable: true, value: undefined });
createRoot(document.getElementById('root')).render(<ServoraAntProvider><BrowserRouter><App initialUser={user} /></BrowserRouter></ServoraAntProvider>);
`;
const virtual = resolve(root, '__job-create-review.tsx');
const vite = await createViteServer({ root, configFile: false, appType: 'custom', logLevel: 'error', plugins: [{ name: 'job-create-review', enforce: 'pre', resolveId(id) { if (id === '/__job-create-review.tsx') return virtual; }, load(id) { if (id === virtual) return entry; } }], server: { host: '127.0.0.1', middlewareMode: true, hmr: false, ws: { host: '127.0.0.1' } } });
const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path.startsWith('/api/')) { res.writeHead(404); res.end(); return; }
  if (!path.includes('.') && !path.startsWith('/@')) {
    res.setHeader('Content-Type', 'text/html;charset=utf-8');
    res.end(await vite.transformIndexHtml(req.url, '<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__job-create-review.tsx"></script></body></html>'));
  } else vite.middlewares(req, res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const captures = [];
const cases = [['meeting', '/jobs/new-meeting'], ['task', '/jobs/new-task'], ['delivery', '/jobs/new-delivery']];

async function openPage(path, role, width) {
  const page = await browser.newPage({ viewport: { width, height: width < 768 ? 844 : 960 }, locale: 'tr-TR', timezoneId: 'Europe/Istanbul', reducedMotion: 'reduce', hasTouch: width < 768 });
  page.setDefaultTimeout(10000);
  await page.clock.setFixedTime(new Date(now));
  const errors = [], unexpected = [], calls = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const u = new URL(request.url());
    const p = u.pathname, method = request.method();
    calls.push(`${method} ${p}`);
    const send = json => route.fulfill({ json });
    const pageOf = list => ({ items: list, total: list.length, limit: Number(u.searchParams.get('limit') ?? 20), offset: 0 });
    if (p === '/api/job-cards/customer-schedule/evaluate' && method === 'POST') return send(clearEvaluation);
    if (method === 'GET') {
      if (p === '/api/staff') return send([profile]);
      if (p === '/api/customers') return send(pageOf([customer]));
      if (p === `/api/customers/${customerId}`) return send(customer);
      if (p === `/api/customers/${customerId}/contacts`) return send(pageOf([]));
      if (p === '/api/products') {
        const q = (u.searchParams.get('q') ?? '').toLocaleLowerCase('tr-TR');
        return send(pageOf(products.filter(product => [product.name, product.sku, product.brand].join(' ').toLocaleLowerCase('tr-TR').includes(q))));
      }
      if (p === '/api/job-cards') return send(pageOf([]));
      if (p === '/api/notifications/unread-count') return send({ unreadCount: 0 });
      if (p === '/api/web-push/status') return send({ enabled: false, vapidPublicKey: null, renewalRequired: false, subscription: null });
    }
    unexpected.push(`${method} ${p}`);
    return route.fulfill({ status: 500, json: { error: { code: 'UNEXPECTED_FIXTURE_REQUEST', message: 'Unexpected fixture request' } } });
  });
  await page.goto(`${url}${path}?reviewRole=${role}`);
  await page.locator('.servora-ant-app').waitFor();
  if (path !== '/jobs') {
    await page.locator('main form .form-actions').waitFor();
    if (role !== 'STAFF') await page.waitForFunction(() => document.querySelector('select[id$="assignee"] option[value="11111111-1111-4111-8111-111111111111"]'));
  } else await page.getByRole('button', { name: 'Yeni iş', exact: true }).filter({ visible: true }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  return { page, errors, unexpected, calls, role, width };
}

async function capture(ctx, name, expectedAlerts = false) {
  const { page, errors, unexpected, calls, role, width } = ctx;
  await page.waitForFunction(() => ![...document.querySelectorAll('[aria-busy="true"]')].some(el => el.getClientRects().length));
  await page.evaluate(() => window.scrollTo(0, 0));
  const metrics = await page.evaluate(() => ({
    title: document.title,
    heading: document.querySelector('main h1')?.textContent,
    narrowProductNames: [...document.querySelectorAll('main .product-select-selected-list li > div:not(.product-select-quantity)')].filter(el => el.getBoundingClientRect().width < 100).map(el => el.textContent),
    selectedNames: [...document.querySelectorAll('main .customer-search-select .customer-option-label > span:first-child')].map(el => ({ text: el.textContent, clipped: el.scrollWidth > el.clientWidth + 1 })),
    smallTargets: [...document.querySelectorAll('main button, main select, main input:not([role=combobox]):not([type=checkbox]), main summary')].filter(el => el.getClientRects().length && el.getBoundingClientRect().height < 43).map(el => ({ tag: el.tagName, id: el.id, height: el.getBoundingClientRect().height })),
    height: document.documentElement.scrollHeight,
    overflow: document.documentElement.scrollWidth > innerWidth + 1,
    overflowing: [...document.querySelectorAll('main *')].filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > innerWidth + 1 || r.left < -1); }).slice(0, 12).map(el => ({ tag: el.tagName, cls: el.className, width: el.getBoundingClientRect().width })),
    labels: [...document.querySelectorAll('main label, main .field-label')].filter(el => el.getClientRects().length).map(el => ({ text: el.textContent, y: Math.round(el.getBoundingClientRect().top) })),
    alerts: [...document.querySelectorAll('[role="alert"]')].filter(el => el.getClientRects().length).map(el => el.textContent),
    submit: [...document.querySelectorAll('main button[type="submit"]')].map(el => ({ text: el.textContent, y: Math.round(el.getBoundingClientRect().top), disabled: el.disabled })),
  }));
  const file = `${name}-${role.toLowerCase()}-${width}`;
  await page.screenshot({ path: resolve(out, `${file}-viewport.png`) });
  await page.screenshot({ path: resolve(out, `${file}-full.png`), fullPage: true });
  assert.deepEqual(errors, [], `${file}: page errors`);
  assert.deepEqual(unexpected, [], `${file}: unexpected API requests`);
  if (!expectedAlerts) assert.deepEqual(metrics.alerts, [], `${file}: unexpected alerts`);
  assert.deepEqual(metrics.narrowProductNames, [], `${file}: unreadable product column`);
  assert.equal(metrics.overflow, false, `${file}: document overflow`);
  assert.deepEqual(metrics.selectedNames.filter(el => el.clipped), [], `${file}: clipped customer name`);
  assert.deepEqual(metrics.smallTargets, [], `${file}: short controls`);
  captures.push({ name, role, width, viewportHeight: width < 768 ? 844 : 960, files: [`${file}-viewport.png`, `${file}-full.png`], errors, unexpected, calls: [...calls], ...metrics });
  console.log(`${file}: height=${metrics.height}, overflow=${metrics.overflow}`);
}

async function selectCustomer(page, kind) {
  await page.locator(`#${kind}-customer`).click();
  await page.locator('.servora-ant-select-item-option-content').filter({ hasText: customer.name }).click();
  await page.waitForFunction(({ kind, name }) => document.querySelector(`#${kind}-customer`)?.closest('.field-group')?.textContent.includes(name), { kind, name: customer.name });
}

async function fill(ctx, name) {
          const { page } = ctx;
          if (name === 'meeting') {
            await page.locator('#meeting-title').fill('Merkez Klinik ihtiyaç görüşmesi');
            await page.locator('#meeting-engagement-kind').selectOption('CUSTOMER_VISIT');
            await selectCustomer(page, name);
            if (ctx.role !== 'STAFF') await page.locator('#meeting-assignee').selectOption(staffId);
            const previewResponse = page.waitForResponse(r => r.url().endsWith('/customer-schedule/evaluate'));
            await page.locator('#meeting-scheduled-at').fill('2026-11-06T10:00');
            await page.locator('#meeting-description').fill('Yeni ürün ihtiyaçlarını ve bir sonraki ziyaret planını görüş.');
            await previewResponse;
            await page.waitForFunction(() => !document.body.textContent.includes('Müşteri planı kontrol ediliyor'));
          } else if (name === 'task') {
            await page.locator('#task-title').fill('Klinik eğitim materyallerini hazırla');
            await page.locator('#task-description').fill('Cuma günkü ürün eğitimi için sunumu ve broşürleri hazırla.');
            if (ctx.role !== 'STAFF') await page.locator('#task-assignee').selectOption(staffId);
            await page.locator('details.task-optional summary').click();
            await selectCustomer(page, name);
            await page.locator('#task-scheduled-at').fill('2026-11-06T10:00');
            await page.waitForFunction(() => !document.body.textContent.includes('İlgili kişiler yükleniyor'));
          } else {
            await selectCustomer(page, name);
            if (ctx.role !== 'STAFF') await page.locator('#delivery-assignee').selectOption(staffId);
            for (const product of products) {
              await page.locator('.product-select-search input').fill(product.sku);
              await page.getByRole('button', { name: 'Ürün ara', exact: true }).click();
              await page.locator(`[data-product-id="${product.id}"]`).click();
              await page.locator(`#delivery-quantity-${product.id}`).fill(product === products[0] ? '3' : '2');
            }
            await page.locator('#delivery-scheduled-at').fill('2026-11-06T10:00');
            await page.locator('#delivery-note').fill('Teslimat öncesinde klinik sorumlusuna haber ver.');
          }

}

try {
  for (const role of ['MANAGER', 'STAFF']) {
    for (const width of [1440, 390]) {
      for (const [name, path] of cases) {
        const ctx = await openPage(path, role, width);
        await capture(ctx, `${name}-initial`);
        await fill(ctx, name);
        await capture(ctx, `${name}-filled`);
        await ctx.page.close();
      }
    }
  }
  for (const width of [320, 768, 1024]) {
    for (const [name, path] of cases) {
      const ctx = await openPage(path, 'MANAGER', width);
      await fill(ctx, name);
      await capture(ctx, `${name}-reflow`);
      await ctx.page.close();
    }
  }
  for (const [name, path] of cases) {
    const ctx = await openPage(path, 'ADMIN', 390);
    await fill(ctx, name);
    await capture(ctx, `${name}-filled`);
    await ctx.page.close();
    const textCtx = await openPage(path, 'MANAGER', 390);
    await textCtx.page.addStyleTag({ content: 'html { font-size: 200%; }' });
    await fill(textCtx, name);
    await capture(textCtx, `${name}-text-200`);
    await textCtx.page.close();
  }
  for (const width of [1440, 390]) {
    const ctx = await openPage('/jobs', 'STAFF', width);
    await ctx.page.getByRole('button', { name: 'Yeni iş', exact: true }).filter({ visible: true }).click();
    await ctx.page.getByRole('button', { name: 'Görüşme / ziyaret planla', exact: true }).waitFor();
    await capture(ctx, 'new-job-menu');
    await ctx.page.keyboard.press('Escape');
    assert.equal(await ctx.page.getByRole('button', { name: 'Yeni iş', exact: true }).filter({ visible: true }).evaluate(el => el === document.activeElement), true);

    await ctx.page.close();
  }
  const ctx = await openPage('/jobs/new-meeting', 'MANAGER', 390);
  await ctx.page.locator('main button[type="submit"]').click();
  await ctx.page.locator('[role="alert"]').waitFor();
  await capture(ctx, 'meeting-required-errors', true);
  assert.equal(await ctx.page.locator('main .form-error').evaluate(el => el === document.activeElement), true);

  await ctx.page.close();
  for (const [name, path] of cases) {
    const ctx = await openPage(path, 'MANAGER', 390);
    const trigger = ctx.page.getByRole('button', { name: 'Yeni müşteri ekle', exact: true });
    if (name === 'task') await ctx.page.locator('details summary').click();
    const title = ctx.page.locator(`#${name}-title`);
    if (name !== 'delivery') await title.fill('Korunan taslak');
    await trigger.focus();
    await ctx.page.keyboard.press('Enter');
    await ctx.page.getByRole('dialog').waitFor();
    await ctx.page.keyboard.press('Escape');
    await ctx.page.getByRole('dialog').waitFor({ state: 'hidden' });
    await ctx.page.waitForFunction(() => document.activeElement?.textContent === 'Yeni müşteri ekle');
    if (name !== 'delivery') assert.equal(await title.inputValue(), 'Korunan taslak');
    // Select via keyboard in the actual owned Ant component.
    const input = ctx.page.locator(`#${name}-customer`);
    await input.focus();
    await ctx.page.keyboard.press('ArrowDown');
    await ctx.page.locator('.servora-ant-select-item-option-content').first().waitFor();
    await ctx.page.keyboard.press('Enter');
    await ctx.page.waitForFunction(({ name, customerName }) => document.querySelector(`#${name}-customer`)?.closest('.field-group')?.textContent.includes(customerName), { name, customerName: customer.name });
    assert.deepEqual(ctx.errors, []);
    assert.deepEqual(ctx.unexpected, []);
    await ctx.page.close();
  }
  writeFileSync(resolve(out, 'results.json'), JSON.stringify({ keyboardChecks: 'New-job Escape focus; error-summary focus; customer side-flow open/dismiss/focus/draft; customer selection with ArrowDown/Enter', sourceDiff: 'source.patch', sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), browser: browser.version(), playwright: require('playwright/package.json').version, locale: 'tr-TR', timezone: 'Europe/Istanbul', fixedTime: now, syntheticData: true, notes: 'No create requests sent. Calendar capability off, EventSource disabled, API reads and advisory preview mocked. No real device, screen reader, complete accessibility or backend acceptance.', captures }, null, 2));
} finally {
  await browser.close();
  await vite.close();
  await new Promise(r => server.close(r));
}
