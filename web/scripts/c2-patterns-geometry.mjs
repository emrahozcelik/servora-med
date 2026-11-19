/**
 * Phase 2 C2 — legacy pattern and leakage contract (UI audit F-09 / F-12 /
 * F-13 / F-14 / F-15).
 *
 * Real production components through the actual App/AppShell/router, the owned
 * Ant provider, production CSS and deterministic synthetic data. Every request
 * is mocked at the API boundary; no production API and no mutation is used.
 *
 * C2_PHASE=after (default) asserts the C2 acceptance. C2_PHASE=before only
 * records measurements and screenshots so the same surfaces can be compared
 * before and after the change.
 *
 * Screenshots go to C2_CAPTURE_DIR (never committed).
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

// Runs from the repository root or from web/.
const webRoot = existsSync(resolve(process.cwd(), 'src/App.tsx')) ? process.cwd() : resolve(process.cwd(), 'web');
const repo = resolve(webRoot, '..');
const root = webRoot;
const phase = process.env.C2_PHASE === 'before' ? 'before' : 'after';
const out = resolve(root, process.env.C2_CAPTURE_DIR || `.ui-evidence/phase-2-c2/${phase}`);
mkdirSync(out, { recursive: true });

const require = createRequire(resolve(root, 'package.json'));
const { chromium } = require('playwright');
const { createServer: createViteServer } = await import(pathToFileURL(require.resolve('vite')));

const org = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const staffId = '11111111-1111-4111-8111-111111111111';
const managerId = '22222222-2222-4222-8222-222222222222';
const otherManagerId = '77777777-7777-4777-8777-777777777777';
const customerId = '33333333-3333-4333-8333-333333333333';
const productId = '55555555-5555-4555-8555-555555555555';
const stamp = '2026-11-04T09:00:00.000Z';
const now = '2026-11-05T06:00:00.000Z';

const staffMember = {
  id: staffId, organizationId: org, name: 'Ayşe Örnek', email: 'ayse@example.test', role: 'STAFF',
  mustChangePassword: false, isActive: true, version: 1, lastLoginAt: stamp, createdAt: stamp, updatedAt: stamp,
};
const profile = {
  id: '44444444-4444-4444-8444-444444444444', user: staffMember, title: 'Saha temsilcisi',
  phone: '+905551110000', region: 'İstanbul', managerUserId: managerId, managerName: 'Deniz Örnek',
  version: 1,
  counters: { open: 2, waitingApproval: 1, revisionRequested: 1, completedThisMonth: 1, overdue: 1 },
};
const managedManager = {
  id: otherManagerId, organizationId: org, name: 'Murat Örnek', email: 'murat@example.test',
  role: 'MANAGER', mustChangePassword: false, isActive: true, version: 6, lastLoginAt: stamp,
  createdAt: stamp, updatedAt: stamp,
  canPermanentlyDelete: true, permanentDeleteBlockers: [],
};
const customer = {
  id: customerId, organizationId: org, name: 'Merkez Ağız ve Diş Sağlığı Kliniği',
  customerType: 'clinic', taxNumber: null, phone: '+905551110000', email: 'klinik@example.test',
  city: 'İstanbul', district: 'Ataşehir', address: 'Örnek Mahallesi, Klinik Sokak No: 10',
  assignedStaffUserId: staffId, assignedStaffName: staffMember.name, status: 'active', version: 1,
  hasOperationHistory: true, openJobCount: 2, completedJobCount: 1,
  primaryContact: { id: 'contact-1', name: 'Dr. Ece Örnek', title: 'Klinik sorumlusu' },
  contacts: [{
    id: 'contact-1', organizationId: org, customerId, name: 'Dr. Ece Örnek', title: 'Klinik sorumlusu',
    phone: '+905551110000', email: 'ece@example.test', isPrimary: true, isActive: true, version: 1,
    hasOperationHistory: true,
  }],
};
const products = [
  {
    id: productId, organizationId: org, name: 'ProSeal Kollajen Membran 20 × 30 mm', sku: 'MED-1001',
    brand: 'ProSeal', category: 'Cerrahi ürünler', model: 'Standart', unit: 'adet',
    referencePrice: null, isActive: true, version: 3, createdAt: stamp, updatedAt: stamp,
    hasOperationHistory: false,
  },
  {
    id: '66666666-6666-4666-8666-666666666666', organizationId: org, name: 'Steril Cerrahi Örtü Seti',
    sku: 'MED-1002', brand: 'DentalCare', category: 'Sarf malzemesi', model: null, unit: 'paket',
    referencePrice: null, isActive: true, version: 1, createdAt: stamp, updatedAt: stamp,
    hasOperationHistory: true,
  },
];
const job = {
  id: 'job-1', title: 'Klinik eğitim materyallerini hazırla', type: 'GENERAL_TASK',
  status: 'IN_PROGRESS', engagementKind: null, version: 3, priority: 'normal', dueDate: null,
  scheduledAt: '2026-11-06T09:00:00.000Z', scheduledEndsAt: '2026-11-06T10:00:00.000Z',
  createdAt: stamp, updatedAt: stamp, staffCompletedAt: null,
  customer: { id: customerId, name: customer.name },
  contact: { id: 'contact-1', name: 'Dr. Ece Örnek' },
  assignee: { id: staffId, name: staffMember.name }, deliveryItemCount: 0,
  allowedCommands: ['SUBMIT_FOR_APPROVAL'],
};
const clearEvaluation = {
  level: 'CLEAR', safeMessage: null, conflicts: [], recentVisit: null, suggestedAlternativeAt: null,
};
const deliveryReport = (groupBy) => ({
  groupBy,
  range: { from: '2026-11-01', to: '2026-11-30', timezone: 'Europe/Istanbul' },
  items: groupBy === 'staff'
    ? [{ staff: { userId: staffId, name: staffMember.name, isActive: true }, unit: 'adet', quantity: '12.000' }]
    : groupBy === 'product'
      ? [{ productId, productNameSnapshot: products[0].name, productSkuSnapshot: 'MED-1001', productModelSnapshot: 'Standart', unit: 'adet', quantity: '12.000' }]
      : groupBy === 'purpose'
        ? [{ purpose: 'SALE', unit: 'adet', quantity: '12.000' }]
        : [{ date: '2026-11-04', unit: 'adet', quantity: '12.000' }],
  total: 1, limit: 20, offset: 0,
});

const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from '/src/App';
import { ServoraAntProvider } from '/src/ui/antd/ServoraAntProvider';
import '/src/styles.css';
const role = new URLSearchParams(location.search).get('reviewRole') || 'MANAGER';
const user = {
  id: role === 'STAFF' ? '${staffId}' : '${managerId}', organizationId: '${org}',
  name: role === 'STAFF' ? '${staffMember.name}' : 'Deniz Örnek', email: 'ornek@example.test',
  role, mustChangePassword: false, isActive: true, version: 1,
  capabilities: { overviewDashboard: false, calendar: true, messaging: false, duplicateCustomerComparison: true },
  support: { displayLabel: 'Örnek destek', email: null, helpUrl: null },
};
Object.defineProperty(window, 'EventSource', { configurable: true, value: undefined });
// Native blocking dialogs are not part of the Servora interaction system.
window.__c2NativeDialogs = 0;
window.confirm = () => { window.__c2NativeDialogs += 1; return false; };
window.prompt = () => { window.__c2NativeDialogs += 1; return null; };
createRoot(document.getElementById('root')).render(
  <ServoraAntProvider><BrowserRouter><App initialUser={user} /></BrowserRouter></ServoraAntProvider>,
);
`;

const virtual = resolve(root, '__c2-patterns-review.tsx');
const vite = await createViteServer({
  root, configFile: false, appType: 'custom', logLevel: 'error',
  plugins: [{
    name: 'c2-patterns-review', enforce: 'pre',
    resolveId(id) { if (id === '/__c2-patterns-review.tsx') return virtual; },
    load(id) { if (id === virtual) return entry; },
  }],
  server: { host: '127.0.0.1', middlewareMode: true, hmr: false, ws: { host: '127.0.0.1' } },
});
const server = createServer(async (request, response) => {
  const path = (request.url ?? '/').split('?')[0];
  if (path.startsWith('/api/')) { response.writeHead(404); response.end(); return; }
  if (!path.includes('.') && !path.startsWith('/@')) {
    response.setHeader('Content-Type', 'text/html;charset=utf-8');
    response.end(await vite.transformIndexHtml(request.url, '<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__c2-patterns-review.tsx"></script></body></html>'));
    return;
  }
  vite.middlewares(request, response);
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const checks = [];
const failures = [];
const captures = [];

function check(label, condition, detail = '') {
  checks.push({ label, passed: Boolean(condition), detail });
  if (!condition) failures.push(detail ? `${label}: ${detail}` : label);
}

function pageOf(items, requestUrl) {
  const params = new URL(requestUrl).searchParams;
  return {
    items, total: items.length,
    limit: Number(params.get('limit') ?? 20), offset: Number(params.get('offset') ?? 0),
  };
}

async function openSurface(path, role, viewport, scenario = 'baseline') {
  const page = await browser.newPage({
    viewport: { width: viewport.width, height: viewport.height },
    locale: 'tr-TR', timezoneId: 'Europe/Istanbul', reducedMotion: 'reduce',
    hasTouch: viewport.width < 768,
  });
  page.setDefaultTimeout(15000);
  await page.clock.setFixedTime(new Date(now));
  const errors = [];
  const unexpected = [];
  page.on('pageerror', (error) => {
    if (error.message.endsWith('WebSocket closed without opened.')) return;
    errors.push(error.message);
  });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const requestUrl = new URL(request.url());
    const pathname = requestUrl.pathname;
    const method = request.method();
    const send = (json) => route.fulfill({ json });
    if (method === 'GET') {
      if (pathname === '/api/notifications/unread-count') return send({ unreadCount: 0 });
      if (pathname === '/api/web-push/status') return send({ enabled: false, vapidPublicKey: null, renewalRequired: false, subscription: null });
      if (pathname === '/api/job-cards/customer-schedule/evaluate') return send(clearEvaluation);
      if (pathname === '/api/staff') return send([profile]);
      if (pathname === '/api/staff/me' || pathname === `/api/staff/${staffId}`) return send(profile);
      if (/^\/api\/staff\/[^/]+\/(jobs|weekly-reports|notes|confidential-notes)$/.test(pathname)) return send(pageOf([], requestUrl));
      if (pathname === '/api/customers') {
        if (scenario === 'error') {
          return route.fulfill({ status: 503, json: { code: 'SERVICE_UNAVAILABLE', error: 'Müşteriler geçici olarak yüklenemedi.' } });
        }
        return send(pageOf([customer], requestUrl));
      }
      if (pathname === `/api/customers/${customerId}`) return send(customer);
      if (pathname === `/api/customers/${customerId}/operational-summary`) {
        return send({
          latestInteraction: null, nextPlannedWork: null,
          pendingReview: { waitingApprovalCount: 0, revisionRequestedCount: 0 },
          latestMeetingOutcome: null, followUp: null,
        });
      }
      if (pathname.endsWith('/enrichment-scope')) return send({ canEnrich: false, canCreateContact: false });
      if (pathname === `/api/customers/${customerId}/jobs`) return send(pageOf([], requestUrl));
      if (pathname === `/api/customers/${customerId}/contacts`) return send(pageOf([], requestUrl));
      if (pathname === '/api/products') return send(pageOf(products, requestUrl));
      if (pathname === `/api/products/${productId}`) return send(products[0]);
      if (pathname === `/api/users/${otherManagerId}`) return send(managedManager);
      if (pathname === '/api/users') return send([managedManager]);
      if (pathname === '/api/job-cards') return send(pageOf([job], requestUrl));
      if (pathname === '/api/calendar/assignees') {
        return send({ items: [{ id: staffId, name: staffMember.name }, { id: managerId, name: 'Deniz Örnek' }] });
      }
      if (pathname === '/api/calendar') return send({ items: [] });
      if (pathname === '/api/reports/deliveries') {
        return send(deliveryReport(requestUrl.searchParams.get('groupBy') ?? 'day'));
      }
    }
    if (pathname === '/api/job-cards/customer-schedule/evaluate') return send(clearEvaluation);
    unexpected.push(`${method} ${pathname}`);
    return route.fulfill({ status: 500, json: { error: { code: 'UNEXPECTED_FIXTURE_REQUEST', message: 'Unexpected fixture request' } } });
  });
  const target = new URL(path, url);
  target.searchParams.set('reviewRole', role);
  await page.goto(target.href);
  await page.locator('.servora-ant-app').waitFor();
  return { page, errors, unexpected, role, viewport, path, scenario };
}

async function settle(page) {
  await page.waitForLoadState('load');
  await page.waitForFunction(() => ![...document.querySelectorAll('[aria-busy="true"]')].some((element) => element.getClientRects().length));
  await page.evaluate(() => document.fonts.ready);
}

async function capture(context, name, readySelector) {
  const { page, errors, unexpected, role, viewport, scenario = 'baseline' } = context;
  if (readySelector) {
    try {
      await page.locator(readySelector).first().waitFor();
    } catch (error) {
      const file = `${name}-${role.toLowerCase()}-${viewport.width}x${viewport.height}`;
      await page.screenshot({ path: resolve(out, `${file}-failure.png`), fullPage: true });
      const text = await page.locator('main').innerText().catch(() => '');
      throw new Error(`${file}: ready selector ${readySelector} missing. main text: ${text.slice(0, 400)}`, { cause: error });
    }
  }
  await settle(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  const file = `${name}-${scenario === 'baseline' ? '' : `${scenario}-`}${role.toLowerCase()}-${viewport.width}x${viewport.height}`.replace('--', '-');
  await page.screenshot({ path: resolve(out, `${file}-viewport.png`) });
  await page.screenshot({ path: resolve(out, `${file}-full.png`), fullPage: true });
  assert.deepEqual(errors, [], `${file}: page errors`);
  assert.deepEqual(unexpected, [], `${file}: unexpected API requests`);
  captures.push({ file, name, role, viewport: `${viewport.width}x${viewport.height}`, errors: [...errors], unexpected: [...unexpected], path: context.path });
  return file;
}

/** Shared control geometry: native selects must match the owned Ant select. */
async function selectGeometry(page) {
  return page.evaluate(() => {
    const describe = (element) => {
      if (!element) return null;
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return {
        height: Math.round(bounds.height * 100) / 100,
        radius: style.borderTopLeftRadius,
        borderColor: style.borderTopColor,
        borderWidth: style.borderTopWidth,
        fontSize: style.fontSize,
        color: style.color,
        backgroundColor: style.backgroundColor,
        paddingInlineStart: parseFloat(style.paddingInlineStart),
        paddingInlineEnd: parseFloat(style.paddingInlineEnd),
      };
    };
    const antSelect = document.querySelector('main .servora-select .servora-ant-select-selector')
      ?? document.querySelector('main .servora-select');
    return {
      antSelect: describe(antSelect),
      nativeSelects: [...document.querySelectorAll('main select')].map((element) => ({
        id: element.id || null,
        ...describe(element),
      })),
      shortControls: [...document.querySelectorAll('main select, main .servora-select')]
        .filter((element) => element.getClientRects().length && element.getBoundingClientRect().height < 44)
        .map((element) => ({ tag: element.tagName, id: element.id || null, height: element.getBoundingClientRect().height })),
    };
  });
}

const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

try {
  // ---------------------------------------------------------------- F-09
  for (const [name, path] of [
    ['meeting-create', '/jobs/new-meeting'],
    ['task-create', '/jobs/new-task'],
    ['delivery-create', '/jobs/new-delivery'],
  ]) {
    for (const viewport of viewports) {
      const context = await openSurface(path, 'MANAGER', viewport);
      const file = await capture(context, name, 'main form .form-actions');
      if (context.role !== 'STAFF') {
        await context.page.waitForFunction((assignee) => document.querySelector(`select[id$="assignee"] option[value="${assignee}"]`), staffId);
      }
      await settle(context.page);
      const geometry = await selectGeometry(context.page);
      writeFileSync(resolve(out, `${file}-selects.json`), JSON.stringify(geometry, null, 2));
      const ant = geometry.antSelect;
      const mismatch = geometry.nativeSelects.filter((native) => !ant
        || Math.abs(native.height - ant.height) > 1
        || native.radius !== ant.radius
        || native.borderColor !== ant.borderColor);
      if (phase === 'after') {
        check(`${file} native selects match the owned Ant select`, mismatch.length === 0,
          JSON.stringify({ ant, mismatch }));
        check(`${file} every select control is at least 44px tall`, geometry.shortControls.length === 0,
          JSON.stringify(geometry.shortControls));
        const tightInset = geometry.nativeSelects.filter((native) => native.paddingInlineStart < 8
          || native.paddingInlineEnd < 8);
        check(`${file} selected text keeps an inline inset`, tightInset.length === 0,
          JSON.stringify(tightInset));
      }
      await context.page.close();
    }
  }

  for (const viewport of viewports) {
    for (const [name, path, selector] of [
      ['calendar', '/calendar', '#calendar-personnel-filter'],
      ['delivery-report', '/reports/deliveries', 'select[name="staffUserId"]'],
    ]) {
      const context = await openSurface(path, 'MANAGER', viewport);
      const file = await capture(context, name, selector);
      const geometry = await context.page.evaluate((query) => {
        const element = document.querySelector(query);
        if (!element) return null;
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        const label = document.querySelector(`label[for="${element.id}"]`)
          ?? element.closest('label');
        return {
          id: element.id || null,
          height: bounds.height,
          radius: style.borderTopLeftRadius,
          borderColor: style.borderTopColor,
          fontSize: style.fontSize,
          paddingInlineStart: parseFloat(style.paddingInlineStart),
          paddingInlineEnd: parseFloat(style.paddingInlineEnd),
          labelText: label?.textContent?.trim() ?? null,
        };
      }, selector);
      writeFileSync(resolve(out, `${file}-filter.json`), JSON.stringify(geometry, null, 2));
      if (phase === 'after') {
        check(`${file} personnel filter present`, geometry !== null, selector);
        if (geometry) {
          check(`${file} personnel filter is at least 44px tall`, geometry.height >= 43.5, `${geometry.height}px`);
          check(`${file} personnel filter keeps a visible label`, Boolean(geometry.labelText), String(geometry.labelText));
          check(`${file} personnel filter text keeps an inline inset`,
            geometry.paddingInlineStart >= 8 && geometry.paddingInlineEnd >= 8,
            `${geometry.paddingInlineStart}/${geometry.paddingInlineEnd}`);
        }
      }
      await context.page.close();
    }
  }

  // ---------------------------------------------------------------- F-15
  for (const viewport of viewports) {
    const customers = await openSurface('/customers', 'MANAGER', viewport);
    const customersFile = await capture(customers, 'customers-list', '.customer-list-card');
    const customerRow = await customers.page.evaluate(() => {
      const row = document.querySelector('.customer-list-card');
      const links = [...(row?.querySelectorAll('a') ?? [])].map((link) => link.getAttribute('href'));
      return {
        rowCommands: row?.querySelectorAll('.customer-row-commands').length ?? 0,
        rowButtons: [...(row?.querySelectorAll('button') ?? [])].map((button) => button.textContent),
        links,
        detailLinks: links.filter((href) => href === `/customers/${'33333333-3333-4333-8333-333333333333'}`),
        titleLink: Boolean(row?.querySelector('.customer-title-link')),
        titleDecoration: row?.querySelector('.customer-title-link')
          ? getComputedStyle(row.querySelector('.customer-title-link')).textDecorationLine : null,
        rowCursor: row ? getComputedStyle(row).cursor : null,
        rowTabIndex: row?.getAttribute('tabindex') ?? null,
        rowRole: row?.getAttribute('role') ?? null,
      };
    });
    writeFileSync(resolve(out, `${customersFile}-row.json`), JSON.stringify(customerRow, null, 2));
    if (phase === 'after') {
      check(`${customersFile} no row-level edit command`, customerRow.rowCommands === 0, JSON.stringify(customerRow));
      check(`${customersFile} single detail link per row`, customerRow.detailLinks.length === 1
        && customerRow.titleLink, JSON.stringify(customerRow.links));
      check(`${customersFile} no row-level buttons`, customerRow.rowButtons.length === 0, JSON.stringify(customerRow.rowButtons));
      check(`${customersFile} title reads as a link`, customerRow.titleDecoration === 'underline',
        String(customerRow.titleDecoration));
    }
    await customers.page.locator('.customer-title-link').first().click();
    await customers.page.waitForURL(`**/customers/${customerId}`);
    check(`${customersFile} title link opens the customer detail`, true);
    await customers.page.close();

    const productsContext = await openSurface('/products', 'ADMIN', viewport);
    const productsFile = await capture(productsContext, 'products-list', '.product-list-card');
    const productRow = await productsContext.page.evaluate(() => {
      const row = document.querySelector('.product-list-card');
      return {
        rowCommands: row?.querySelectorAll('.product-row-commands').length ?? 0,
        rowButtons: [...(row?.querySelectorAll('button') ?? [])].map((button) => button.textContent?.trim()),
        deleteText: [...(row?.querySelectorAll('button, a') ?? [])]
          .filter((element) => element.textContent?.trim() === 'Sil').length,
        detailLinks: [...(row?.querySelectorAll('a') ?? [])]
          .filter((link) => (link.getAttribute('href') ?? '').startsWith('/products/')).length,
        titleLink: Boolean(row?.querySelector('.product-title-link')),
        titleDecoration: row?.querySelector('.product-title-link')
          ? getComputedStyle(row.querySelector('.product-title-link')).textDecorationLine : null,
        rowCursor: row ? getComputedStyle(row).cursor : null,
      };
    });
    writeFileSync(resolve(out, `${productsFile}-row.json`), JSON.stringify(productRow, null, 2));
    if (phase === 'after') {
      check(`${productsFile} no row-level record commands`, productRow.rowCommands === 0, JSON.stringify(productRow));
      check(`${productsFile} no row-level destructive control`, productRow.deleteText === 0, JSON.stringify(productRow));
      check(`${productsFile} single detail link per row`, productRow.detailLinks === 1 && productRow.titleLink, JSON.stringify(productRow));
      check(`${productsFile} title reads as a link`, productRow.titleDecoration === 'underline',
        String(productRow.titleDecoration));
    }
    await productsContext.page.close();
  }

  // ---------------------------------------------------------------- F-12
  for (const viewport of viewports) {
    for (const [name, path, role, ready] of [
      ['customer-detail', `/customers/${customerId}`, 'MANAGER', '#general-title'],
      ['product-detail', `/products/${productId}`, 'ADMIN', '.product-detail-facts'],
    ]) {
      const context = await openSurface(path, role, viewport);
      const file = await capture(context, name, ready);
      const text = await context.page.locator('main').innerText();
      if (phase === 'after') {
        check(`${file} hides the optimistic-lock version`, !/Sürüm/.test(text), text.match(/.{0,40}Sürüm.{0,40}/)?.[0] ?? '');
        if (name === 'product-detail') {
          check(`${file} keeps the last-update date`, text.includes('Son güncelleme'), '');
        }
      }
      await context.page.close();
    }
  }

  for (const viewport of viewports) {
    for (const [name, path, role, expectedStatus, expectedTitle] of [
      ['not-found', '/bilinmeyen-sayfa', 'MANAGER', '404', 'Sayfa bulunamadı'],
      ['forbidden', '/reports', 'STAFF', '403', 'Erişim yetkiniz yok'],
    ]) {
      const context = await openSurface(path, role, viewport);
      const file = await capture(context, name, `[data-result-status="${expectedStatus}"]`);
      const state = await context.page.evaluate((status) => {
        const result = document.querySelector(`[data-result-status="${status}"]`);
        return {
          found: Boolean(result),
          headings: [...document.querySelectorAll('main h1')].map((heading) => heading.textContent),
          artwork: result ? result.querySelectorAll('svg, img').length : -1,
          textAlign: result?.querySelector('.servora-ant-result-title')
            ? getComputedStyle(result.querySelector('.servora-ant-result-title')).textAlign : null,
          action: [...(result?.querySelectorAll('a') ?? [])].map((link) => link.textContent),
          role: result?.getAttribute('role') ?? null,
        };
      }, expectedStatus);
      writeFileSync(resolve(out, `${file}-state.json`), JSON.stringify(state, null, 2));
      if (phase === 'after') {
        check(`${file} renders the ${expectedStatus} state`, state.found, JSON.stringify(state));
        check(`${file} carries one Turkish h1`, state.headings.length === 1 && state.headings[0] === expectedTitle,
          JSON.stringify(state.headings));
        check(`${file} shows no stock illustration`, state.artwork === 0, `artwork=${state.artwork}`);
        check(`${file} keeps the İşlere dön action`, state.action.some((text) => text === 'İşlere dön'),
          JSON.stringify(state.action));
        check(`${file} remains an alert region`, state.role === 'alert', String(state.role));
        check(`${file} uses the calm left-aligned treatment`, state.textAlign === 'left', String(state.textAlign));
      }
      await context.page.close();
    }
  }

  // ---------------------------------------------- calm error result state
  for (const viewport of viewports) {
    const context = await openSurface('/customers', 'MANAGER', viewport, 'error');
    const file = await capture(context, 'customers', '[data-result-status="error"]');
    const state = await context.page.evaluate(() => {
      const result = document.querySelector('[data-result-status="error"]');
      const slot = result?.querySelector('.servora-result-state__icon');
      const glyph = slot?.querySelector('svg, span');
      const title = result?.querySelector('.servora-ant-result-title');
      const box = (element) => {
        const rect = element?.getBoundingClientRect();
        return rect ? { left: Math.round(rect.left), top: Math.round(rect.top) } : null;
      };
      return {
        titleAlign: title ? getComputedStyle(title).textAlign : null,
        iconAlign: slot ? getComputedStyle(slot).textAlign : null,
        iconMarginInlineStart: slot ? getComputedStyle(slot).marginInlineStart : null,
        glyph: box(glyph),
        title: box(title),
        retry: [...(result?.querySelectorAll('button') ?? [])].map((button) => button.textContent),
      };
    });
    writeFileSync(resolve(out, `${file}-alignment.json`), JSON.stringify(state, null, 2));
    if (phase === 'after') {
      check(`${file} shows the retry command`, state.retry.includes('Tekrar dene'), JSON.stringify(state.retry));
      check(`${file} copies the left alignment on the artwork`, state.iconAlign === state.titleAlign
        && state.titleAlign === 'left', `${state.iconAlign}/${state.titleAlign}`);
      check(`${file} artwork shares the title edge`,
        Boolean(state.glyph && state.title) && Math.abs(state.glyph.left - state.title.left) <= 1,
        JSON.stringify({ glyph: state.glyph, title: state.title }));
    }
    await context.page.close();
  }

  // ---------------------------------------------------------------- F-13
  for (const viewport of viewports) {
    const context = await openSurface(`/users/${otherManagerId}`, 'ADMIN', viewport);
    const file = await capture(context, 'user-detail', '#detail-name');
    const text = await context.page.locator('main').innerText();
    if (phase === 'after') {
      check(`${file} has no legacy hierarchy return label`, !text.includes('Listeye dön'), '');
      check(`${file} offers the permanent-delete command`, text.includes('Kalıcı olarak sil'), '');
      const trigger = context.page.getByRole('button', { name: 'Kalıcı olarak sil', exact: true });
      await trigger.focus();
      await trigger.click();
      const dialog = context.page.locator('[role="dialog"]');
      await dialog.waitFor();
      check(`${file} permanent delete opens the owned dialog`,
        (await dialog.getAttribute('aria-modal')) === 'true', await dialog.getAttribute('aria-modal'));
      const focusInside = await context.page.evaluate(() => Boolean(document.querySelector('[role="dialog"]')?.contains(document.activeElement)));
      check(`${file} dialog contains focus`, focusInside, String(focusInside));
      await context.page.screenshot({ path: resolve(out, `${file}-delete-dialog.png`) });
      await context.page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      const restored = await context.page.evaluate(() => document.activeElement?.textContent?.trim());
      check(`${file} Escape restores focus to the trigger`, restored === 'Kalıcı olarak sil', String(restored));
      const nativeDialogs = await context.page.evaluate(() => window.__c2NativeDialogs ?? 0);
      check(`${file} never falls back to a native dialog`, nativeDialogs === 0, String(nativeDialogs));
    }
    await context.page.close();
  }

  for (const viewport of viewports) {
    const context = await openSurface(`/staff/${staffId}`, 'MANAGER', viewport);
    const file = await capture(context, 'staff-profile', 'form input[name="title"]');
    const text = await context.page.locator('main').innerText();
    if (phase === 'after') {
      check(`${file} has no legacy hierarchy return label`, !text.includes('Listeye dön'), '');
      check(`${file} keeps the save command`, text.includes('Profili kaydet'), '');
    }
    await context.page.close();
  }

  // ---------------------------------------------------------------- F-14
  for (const viewport of viewports) {
    for (const [name, path, role, ready] of [
      ['jobs', '/jobs', 'MANAGER', '[data-job-list-card="true"]'],
      ['calendar', '/calendar', 'MANAGER', '#calendar-personnel-filter'],
      ['customers', '/customers', 'MANAGER', '.customer-list-card'],
      ['products', '/products', 'ADMIN', '.product-list-card'],
      ['users', '/users', 'ADMIN', '.people-list-card'],
      ['staff', '/staff', 'ADMIN', '.people-list-card'],
    ]) {
      const context = await openSurface(path, role, viewport);
      const file = await capture(context, `${name}-eyebrow`, ready);
      const eyebrow = await context.page.evaluate(() => [...document.querySelectorAll('.page-header-eyebrow')]
        .map((element) => element.textContent));
      writeFileSync(resolve(out, `${file}.json`), JSON.stringify(eyebrow, null, 2));
      if (phase === 'after') {
        check(`${file} repeats no navigation section`, eyebrow.length === 0, JSON.stringify(eyebrow));
      }
      await context.page.close();
    }
  }
} finally {
  writeFileSync(resolve(out, 'results.json'), JSON.stringify({
    phase,
    sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    sourceDiff: execFileSync('git', ['diff', '--', 'web/src', 'web/tests'], { cwd: repo, encoding: 'utf8' }),
    browser: browser.version(),
    locale: 'tr-TR',
    timezone: 'Europe/Istanbul',
    fixedTime: now,
    syntheticData: true,
    checks,
    failures,
    captures,
    notes: 'API reads mocked at the boundary; EventSource disabled; no mutation, no real backend, no screen reader or real device.',
  }, null, 2));
  await browser.close();
  await vite.close();
  await new Promise((done) => server.close(done));
}

console.log(JSON.stringify({ phase, checks: checks.length, failures, captures: captures.length, out }, null, 2));
if (phase === 'after' && failures.length > 0) {
  console.error(`C2 pattern contract failed (${failures.length}):\n- ${failures.join('\n- ')}`);
  process.exitCode = 1;
} else {
  console.log(`C2 ${phase} capture complete: ${captures.length} surfaces, ${failures.length} failures`);
}
