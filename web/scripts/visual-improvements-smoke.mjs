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
const out = resolve(process.env.VISUAL_CAPTURE_DIR || '/tmp/servora-visual-improvements');
mkdirSync(out, { recursive: true });
const require = createRequire(resolve(root, 'package.json'));
const { chromium } = require('playwright');
const { createServer: createViteServer } = await import(pathToFileURL(require.resolve('vite')));
const fixture = await import(pathToFileURL(resolve(root, 'scripts/visual-improvements-fixture.ts')));
const { user, profile, customer, products, jobs, history, summary, report, weekly, now, staffId, customerId } = fixture;
writeFileSync(resolve(out, 'fixture-data.json'), JSON.stringify(fixture, null, 2));
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from '/src/App';
import { ServoraAntProvider } from '/src/ui/antd/ServoraAntProvider';
import '/src/styles.css';
const role = new URLSearchParams(location.search).get('reviewRole') || 'MANAGER';
const user = ${JSON.stringify(user)};
user.role = role;
if (role === 'STAFF') { user.id = '${staffId}'; user.name = '${profile.user.name}'; }
Object.defineProperty(window, 'EventSource', { configurable: true, value: undefined });
createRoot(document.getElementById('root')).render(<ServoraAntProvider><BrowserRouter><App initialUser={user} /></BrowserRouter></ServoraAntProvider>);
`;
const virtual = resolve(root, '__visual-improvements.tsx');
let vite;
const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path.startsWith('/api/')) { res.writeHead(404); res.end(); return; }
  if (!path.includes('.') && !path.startsWith('/@')) {
    res.setHeader('Content-Type', 'text/html;charset=utf-8');
    res.end(await vite.transformIndexHtml(req.url, '<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__visual-improvements.tsx"></script></body></html>'));
  } else vite.middlewares(req, res);
});
vite = await createViteServer({ root, configFile: false, appType: 'custom', logLevel: 'error', plugins: [{ name: 'visual-improvements', enforce: 'pre', resolveId(id) { if (id === '/__visual-improvements.tsx') return virtual; }, load(id) { if (id === virtual) return entry; } }], server: { host: '127.0.0.1', middlewareMode: true, hmr: false, ws: { server, host: '127.0.0.1' } } });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const captures = [];
const after = process.env.VISUAL_PHASE === 'after';
const onlyOverdue = process.env.VISUAL_ONLY === 'overdue';
const cases = onlyOverdue ? [['jobs', '/jobs?overdue=true', 'STAFF']] : [
  ['staff-profile', '/staff', 'STAFF'],
  ['customer-detail', `/customers/${customerId}`, 'ADMIN'],
  ['customer-detail', `/customers/${customerId}`, 'MANAGER'],
  ['customer-detail', `/customers/${customerId}`, 'STAFF'],
  ['customers', '/customers', 'MANAGER'],
  ['products', '/products', 'ADMIN'],
  ['customer-create', '/customers/new', 'ADMIN'],
  ['product-create', '/products/new', 'ADMIN'],
  ['staff-edit', `/staff/${staffId}`, 'MANAGER'],
  ['jobs', '/jobs', 'STAFF'],
  ['jobs', '/jobs', 'MANAGER'],
];
function paginated(list, u) {
  const offset = Number(u.searchParams.get('offset') || 0), limit = Number(u.searchParams.get('limit') || 20);
  return { items: list.slice(offset, offset + limit), total: list.length, limit, offset };
}
function scopedHistory(u, empty) {
  const status = u.searchParams.get('status') || 'all';
  return empty ? [] : history.filter(j => status === 'all' || (status === 'completed' ? j.status === 'COMPLETED' : !['COMPLETED', 'CANCELLED'].includes(j.status)));
}
async function openPage(name, path, role, width, scenario = 'baseline') {
  const page = await browser.newPage({ viewport: { width, height: width < 768 ? 844 : 960 }, locale: 'tr-TR', timezoneId: 'Europe/Istanbul', reducedMotion: 'reduce', hasTouch: width < 768 });
  page.setDefaultTimeout(12000);
  await page.clock.setFixedTime(new Date(now));
  const errors = [], unexpected = [], calls = [];
  let releaseLoading;
  const loadingGate = new Promise(resolve => { releaseLoading = resolve; });
  let reportAttempts = 0;
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/api/**', async route => {
    const req = route.request(), u = new URL(req.url()), p = u.pathname, method = req.method();
    calls.push(`${method} ${p}`);
    const send = json => route.fulfill({ json });
    const empty = scenario === 'empty';
    if (scenario === 'conflict' && p === `/api/customers/${customerId}` && method === 'PATCH') return route.fulfill({ status: 409, json: { code: 'VERSION_CONFLICT', error: 'Kayıt güncellendi.' } });
    if (method === 'GET') {
      if (p === '/api/staff') return send([profile]);
      if (p === '/api/staff/me' || p === `/api/staff/${staffId}`) return send(empty ? { ...profile, counters: { open: 0, overdue: 0, waitingApproval: 0, revisionRequested: 0, completedThisMonth: 0 } } : profile);
      if (/^\/api\/staff\/[^/]+\/weekly-reports$/.test(p)) return send(paginated(empty ? [] : weekly, u));
      if (/^\/api\/staff\/[^/]+\/jobs$/.test(p)) return send(paginated(scopedHistory(u, empty), u));
      if (/^\/api\/staff\/[^/]+\/(notes|confidential-notes)$/.test(p)) return send(paginated([], u));
      if (p.startsWith('/api/reports/staff/')) {
        if (scenario === 'loading') await loadingGate;
        reportAttempts++;
        if (scenario === 'retry' && reportAttempts === 1) return route.fulfill({ status: 503, json: { code: 'SERVICE_UNAVAILABLE', error: 'Örnek rapor geçici olarak kullanılamıyor.' } });
        if (empty) return send({ ...report, performance: { completedJobs: 0, completionDays: 0, jobsPerCompletionDay: 0, correctionRequestEvents: 0, authoredOperationalNotes: 0 }, staffExecution: { staffCompletedJobs: 0, staffCompletionDays: 0, jobsPerStaffCompletionDay: 0, missingStaffCompletionTimestamp: 0 }, staffSubmissionAttribution: { recordedSubmissionCount: 0, recordedSubmissionDays: 0 }, onTime: { eligibleScheduledCompletedJobs: 0, onTimeCompletedJobs: 0, lateCompletedJobs: 0, ineligibleOrNoDeadlineCompletedJobs: 0, onTimeRate: null }, currentWorkload: { openJobCards: 0, overdueJobCards: 0, waitingApproval: 0, revisionRequested: 0 }, completionWorkTypes: report.completionWorkTypes.map(i => ({ ...i, count: 0 })), currentWorkloadByType: report.currentWorkloadByType.map(i => ({ ...i, count: 0 })), completedTrend: report.completedTrend.map(i => ({ ...i, count: 0 })), meetingsByOutcome: report.meetingsByOutcome.map(i => ({ ...i, count: 0 })) });
        return send(report);
      }
      if (p === '/api/customers') return send(paginated(empty ? [] : [customer], u));
      if (p === `/api/customers/${customerId}`) return send(customer);
      if (p.endsWith('/operational-summary')) return send(empty ? { latestInteraction: null, nextPlannedWork: null, pendingReview: { waitingApprovalCount: 0, revisionRequestedCount: 0 }, latestMeetingOutcome: null, followUp: null } : summary);
      if (p.endsWith('/enrichment-scope') || p.endsWith('/enrichment')) return send({ canEnrich: true, canCreateContact: true });
      if (p === `/api/customers/${customerId}/jobs`) return send(paginated(scopedHistory(u, false), u));
      if (p === '/api/products') return send(paginated(empty ? [] : scenario === 'long' ? products.map(p => ({ ...p, name: p.name + ' — Klinik uygulamalar için uzun ürün tanımı', sku: 'MED-REFERANS-UZUN-KOD-2026-1001234567890' })) : products, u));
      if (p === '/api/job-cards') {
        const active = empty ? [] : jobs.filter(j => j.status !== 'COMPLETED').map(j => ({ ...j, allowedCommands: role === 'STAFF' ? j.status === 'ACCEPTED' ? ['START'] : j.status === 'IN_PROGRESS' ? ['SUBMIT_FOR_APPROVAL'] : j.status === 'REVISION_REQUESTED' ? ['RESUME'] : [] : j.status === 'WAITING_APPROVAL' ? ['APPROVE', 'REQUEST_REVISION'] : [] }));
        const visible = u.searchParams.get('overdue') === 'true' ? active.filter(j => j.id === 'task').map(j => ({ ...j, overdueSince: '2026-11-03T10:00:00.000Z', latenessSeconds: 158400 })) : active;
        return send(paginated(visible, u));
      }
      if (/\/weekly-report\/submissions\/1\/pdf$/.test(p)) return route.fulfill({ body: '%PDF-1.4\n% Synthetic UI download probe\n', contentType: 'application/pdf', headers: { 'Content-Disposition': 'attachment; filename="ornek-haftalik-rapor.pdf"' } });
      if (p === '/api/notifications/unread-count') return send({ unreadCount: 0 });
      if (p === '/api/web-push/status') return send({ enabled: false, vapidPublicKey: null, renewalRequired: false, subscription: null });
    }
    unexpected.push(`${method} ${p}`);
    return route.fulfill({ status: 500, json: { error: { code: 'UNEXPECTED_FIXTURE_REQUEST', message: 'Unexpected fixture request' } } });
  });
  const target = new URL(path, url);
  target.searchParams.set('reviewRole', role);
  await page.goto(target.href);
  await page.locator('.servora-ant-app').waitFor();
  const ready = {
    'staff-profile': '.staff-weekly-reports', 'customer-detail': '.customer-history',
    customers: '.customer-list, .servora-empty-state', products: '.product-list, .servora-empty-state',
    'customer-create': '#customer-name', 'product-create': '#product-name',
    'staff-edit': 'form input[name="title"]', jobs: '[data-job-list-card="true"]',
  }[name];
  await page.locator(ready).first().waitFor();
  if (scenario !== 'loading') await page.waitForFunction(() => ![...document.querySelectorAll('main [aria-busy="true"]')].some(el => el.getClientRects().length));
  if (name === 'staff-profile' && !['retry', 'loading'].includes(scenario)) await page.locator('.staff-operational-report').waitFor();
  if (name === 'customer-detail') await page.getByText('Son etkileşim', { exact: true }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  return { page, name, role, width, scenario, errors, unexpected, calls, releaseLoading };
}
async function capture(ctx, suffix = '') {
  const { page, name, role, width, scenario, errors, unexpected, calls } = ctx;
  await page.evaluate(() => window.scrollTo(0, 0));
  const metrics = await page.evaluate(() => ({
    title: document.title, height: document.documentElement.scrollHeight,
    overflow: document.documentElement.scrollWidth > innerWidth + 1,
    headings: [...document.querySelectorAll('main h1,main h2,main h3')].map(el => ({ text: el.textContent, y: Math.round(el.getBoundingClientRect().top) })),
    alerts: [...document.querySelectorAll('[role="alert"]')].filter(el => el.getClientRects().length).map(el => el.textContent),
    commands: [...document.querySelectorAll('[data-job-command]')].filter(el => el.getClientRects().length).map(el => ({ text: el.textContent, height: el.getBoundingClientRect().height })),
    rowActions: [...document.querySelectorAll('.customer-row-commands a, .product-row-commands a, .product-row-commands button')].filter(el => el.getClientRects().length).map(el => ({ text: el.textContent, width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height })),
  }));
  const file = `${name}-${role.toLowerCase()}-${width}-${scenario}${suffix}`;
  await page.screenshot({ path: resolve(out, `${file}-viewport.png`) });
  await page.screenshot({ path: resolve(out, `${file}-full.png`), fullPage: true });
  assert.deepEqual(errors, [], `${file}: page errors`);
  assert.deepEqual(unexpected, [], `${file}: unexpected requests`);
  if (!['retry', 'conflict'].includes(scenario)) assert.deepEqual(metrics.alerts, [], `${file}: alerts`);
  if (after) {
    assert.equal(metrics.overflow, false, `${file}: overflow`);
    assert.ok([...metrics.rowActions, ...metrics.commands].every(action => action.height >= 43), `${file}: action target height`);
    if (name === 'staff-profile' && !['retry', 'loading'].includes(scenario)) {
      assert.equal(await page.locator('.staff-current-workload-grid').count(), 0);
      const order = await page.evaluate(() => document.querySelector('.staff-job-history').compareDocumentPosition(document.querySelector('.embedded-staff-report')) & Node.DOCUMENT_POSITION_FOLLOWING);
      assert.ok(order, 'Work access must precede analytics');
    }
    if (name === 'customer-detail') {
      assert.ok(await page.evaluate(() => document.querySelector('.operational-summary').compareDocumentPosition(document.querySelector('#general-title')) & Node.DOCUMENT_POSITION_FOLLOWING));
    }
  }
  captures.push({ file, name, role, width, scenario, ...metrics, errors: [...errors], unexpected: [...unexpected], calls: [...calls] });
  console.log(`${file}: height=${metrics.height}, overflow=${metrics.overflow}`);
}
try {
  for (const [name, path, role] of cases) {
    for (const width of [1440, 390]) {
      const ctx = await openPage(name, path, role, width);
      if (onlyOverdue) await ctx.page.locator('[data-job-overdue-signal]').waitFor();
      await capture(ctx); await ctx.page.close();
    }
  }
  if (after && !onlyOverdue) {
    const probes = cases.filter(([name, , role]) => ['staff-profile', 'customers', 'products', 'customer-create', 'product-create', 'staff-edit'].includes(name) || name === 'customer-detail' && role === 'MANAGER' || name === 'jobs' && role === 'STAFF');
    for (const [name, path, role] of probes) {
      for (const width of [320, 768, 1024]) {
        const ctx = await openPage(name, path, role, width);
        await capture(ctx, '-reflow'); await ctx.page.close();
      }
      const ctx = await openPage(name, path, role, 390);
      await ctx.page.addStyleTag({ content: 'html { font-size: 200%; }' });
      await capture(ctx, '-text-200'); await ctx.page.close();
    }
    for (const scenario of ['empty', 'retry', 'loading']) {
      const ctx = await openPage('staff-profile', '/staff', 'STAFF', 390, scenario);
      await capture(ctx);
      if (scenario === 'retry') {
        await ctx.page.getByRole('button', { name: 'Tekrar dene', exact: true }).click();
        await ctx.page.locator('.staff-operational-report').waitFor();
        await capture(ctx, '-recovered');
      }
      ctx.releaseLoading(); await ctx.page.close();
    }
    for (const [name, path] of [['customers', '/customers'], ['products', '/products']]) {
      const staff = await openPage(name, path, 'STAFF', 390);
      await capture(staff); await staff.page.close();
    }
    const longProduct = await openPage('products', '/products', 'ADMIN', 390, 'long');
    await capture(longProduct); await longProduct.page.close();
    const edit = await openPage('customers', '/customers', 'MANAGER', 390);
    await edit.page.getByRole('link', { name: `${customer.name} müşterisini düzenle`, exact: true }).click();
    await edit.page.locator('#detail-customer-name').waitFor();
    assert.equal(await edit.page.locator('.customer-edit-disclosure').evaluate(el => el.open), true);
    await edit.page.close();
    const conflict = await openPage('customer-detail', `/customers/${customerId}`, 'MANAGER', 390, 'conflict');
    const disclosure = conflict.page.locator('.customer-edit-disclosure');
    await disclosure.locator('summary').focus(); await conflict.page.keyboard.press('Enter');
    await conflict.page.locator('#detail-customer-name').fill('Korunan müşteri taslağı');
    await disclosure.locator('summary').click();
    assert.equal(await disclosure.evaluate(el => el.open), false);
    assert.equal(await conflict.page.locator('#detail-customer-name').count(), 0);
    await disclosure.locator('summary').click();
    assert.notEqual(await conflict.page.locator('#detail-customer-name').inputValue(), 'Korunan müşteri taslağı');
    await conflict.page.locator('#detail-customer-name').fill('Korunan müşteri taslağı');
    await conflict.page.getByRole('button', { name: 'Bilgileri kaydet', exact: true }).click();
    await conflict.page.locator('.conflict-actions').waitFor();
    assert.equal(await conflict.page.locator('#detail-customer-name').inputValue(), 'Korunan müşteri taslağı');
    assert.equal(await conflict.page.locator('main .form-error').evaluate(el => el === document.activeElement), true);
    await capture(conflict);
    await conflict.page.getByRole('button', { name: 'Vazgeç', exact: true }).click();
    await conflict.page.locator('.customer-edit-disclosure > summary').waitFor();
    assert.equal(await conflict.page.locator('#detail-customer-name').count(), 0);
    assert.equal(await conflict.page.locator('.conflict-actions').count(), 0);
    assert.equal(new URL(conflict.page.url()).pathname, `/customers/${customerId}`);
    assert.equal(new URL(conflict.page.url()).searchParams.has('edit'), false);
    await conflict.page.close();
    const staff = await openPage('customer-detail', `/customers/${customerId}`, 'STAFF', 390);
    const enrich = staff.page.getByRole('button', { name: 'Bilgileri tamamla', exact: true });
    await enrich.click(); await staff.page.locator('#enrichment-phone').waitFor();
    await staff.page.locator('form').getByRole('button', { name: 'Vazgeç', exact: true }).click();
    assert.equal(await enrich.evaluate(el => el === document.activeElement), true);
    assert.equal(await staff.page.locator('#detail-customer-name').count(), 0);
    await staff.page.close();
    const product = await openPage('products', '/products', 'ADMIN', 390);
    const remove = product.page.getByRole('button', { name: `${products[0].name} ürününü sil`, exact: true });
    await remove.focus(); await product.page.keyboard.press('Enter');
    await product.page.getByRole('dialog').waitFor(); await capture(product, '-confirmation');
    await product.page.keyboard.press('Escape'); await product.page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(await remove.evaluate(el => el === document.activeElement), true);
    await product.page.close();
    const own = await openPage('staff-profile', '/staff', 'STAFF', 390);
    const download = own.page.waitForEvent('download');
    await own.page.getByRole('button', { name: 'PDF indir', exact: true }).click();
    assert.equal((await download).suggestedFilename(), 'ornek-haftalik-rapor.pdf');
    await own.page.getByRole('tab', { name: 'Tamamlanan', exact: true }).click();
    await own.page.waitForFunction(() => document.querySelectorAll('.staff-job-history .job-history-row').length === 1);
    assert.equal(await own.page.locator('.staff-job-history .job-history-row').count(), 1);
    assert.deepEqual(own.unexpected, []);
    await own.page.close();
  }
  writeFileSync(resolve(out, 'results.json'), JSON.stringify({ phase: after ? 'after' : 'before', browser: browser.version(), playwright: require('playwright/package.json').version, fixedTime: now, locale: 'tr-TR', timezone: 'Europe/Istanbul', captures }, null, 2));
} finally {
  await browser.close(); await vite.close(); await new Promise(r => server.close(r));
}
