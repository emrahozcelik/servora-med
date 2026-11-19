/**
 * Mobile shell navigation geometry (DECISIONS.md UI-004, audit F-03 + F-14 part 1).
 *
 * Real `AppShell` + `PageHeader` with production CSS and the owned Ant provider,
 * deterministic synthetic users, and no backend: every `/api/` call is stubbed.
 * It measures the single Menü entry, the right-anchored grouped menu panel, the
 * bottom-navigation targets, the create sheet, and the page-header top gap.
 *
 * Usage (from web/):
 *   node scripts/mobile-shell-nav-geometry.mjs
 *   MOBILE_SHELL_CAPTURE_DIR=<dir> node scripts/mobile-shell-nav-geometry.mjs
 */
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';

const root = process.cwd();
const captureDir = process.env.MOBILE_SHELL_CAPTURE_DIR;
if (captureDir) mkdirSync(captureDir, { recursive: true });
const phase = process.env.MOBILE_SHELL_CAPTURE_PHASE ?? 'current';

const users = {
  STAFF: {
    id: '11111111-1111-4111-8111-111111111111', organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    name: 'Ayşe Personel', email: 'ayse@example.invalid', role: 'STAFF', mustChangePassword: false,
    isActive: true, version: 1,
    capabilities: { overviewDashboard: false, calendar: false, messaging: false },
    support: { displayLabel: 'Destek', email: null, helpUrl: null },
  },
  MANAGER: {
    id: '22222222-2222-4222-8222-222222222222', organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    name: 'Murat Yönetici', email: 'murat@example.invalid', role: 'MANAGER', mustChangePassword: false,
    isActive: true, version: 1,
    capabilities: { overviewDashboard: true, calendar: true, messaging: false },
    support: { displayLabel: 'Destek', email: null, helpUrl: null },
  },
  ADMIN: {
    id: '33333333-3333-4333-8333-333333333333', organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    name: 'Deniz Sistem Yöneticisi', email: 'deniz@example.invalid', role: 'ADMIN', mustChangePassword: false,
    isActive: true, version: 1,
    capabilities: { overviewDashboard: true, calendar: true, messaging: true, backup: true },
    support: { displayLabel: 'Destek', email: null, helpUrl: null },
  },
};

const virtual = resolve(root, '__mobile-shell-fixture.tsx');
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { AppShell } from '/src/AppShell';
import { PageHeader } from '/src/ui/PageHeader';
import { ServoraAntProvider } from '/src/ui/antd/ServoraAntProvider';
import '/src/styles.css';

const users = ${JSON.stringify(users)};
const params = new URLSearchParams(location.search);
const role = params.get('role') || 'MANAGER';
const path = params.get('path') || '/jobs';
const banner = params.get('banner') === '1';
Object.defineProperty(window, 'EventSource', { configurable: true, value: undefined });
createRoot(document.getElementById('root')).render(
  <ServoraAntProvider>
    <MemoryRouter initialEntries={[path]}>
      <AppShell user={users[role]} pendingSignOut={false} onSignOut={() => {}}>
        {banner ? (
          <nav className="offboarding-return-nav" aria-label="Personel ayrılma akışına dönüş">
            <a className="secondary-button" href="#personel">Personel ayrılma ekranına dön ve planı yenile</a>
          </nav>
        ) : null}
        <main className="workspace" data-fixture-main>
          <PageHeader description="Yerel geometri fixture'ı; gerçek bileşenler ve üretim CSS'i." />
          <section className="surface" style={{ minHeight: '140vh', padding: '1rem' }}>
            <h2>Operasyon içeriği</h2>
            <p>Yerel sentetik veri.</p>
          </section>
        </main>
      </AppShell>
    </MemoryRouter>
  </ServoraAntProvider>,
);
`;

const server = createServer(async (request, response) => {
  const path = (request.url ?? '/').split('?')[0];
  if (path.startsWith('/api/')) {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ items: [], total: 0, limit: 20, offset: 0, unreadCount: 0 }));
    return;
  }
  if (!path.includes('.') && !path.startsWith('/@')) {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html lang="tr"><head><meta charset="utf-8">'
      + '<meta name="viewport" content="width=device-width,initial-scale=1"></head>'
      + '<body><div id="root"></div><script type="module" src="/__mobile-shell-fixture.tsx"></script></body></html>');
    return;
  }
  vite.middlewares(request, response, () => {
    response.writeHead(404);
    response.end();
  });
});

const vite = await createViteServer({
  root,
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  plugins: [{
    name: 'mobile-shell-fixture',
    enforce: 'pre',
    resolveId(id) { if (id === '/__mobile-shell-fixture.tsx') return virtual; },
    load(id) { if (id === virtual) return entry; },
  }],
  server: { host: '127.0.0.1', middlewareMode: true, hmr: false },
});
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const url = `http://127.0.0.1:${server.address().port}/`;

const failures = [];
const checks = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

async function measure(page) {
  return page.evaluate(() => {
    const rect = (element) => {
      if (!element) return null;
      const bounds = element.getBoundingClientRect();
      return {
        top: Math.round(bounds.top * 100) / 100,
        bottom: Math.round(bounds.bottom * 100) / 100,
        left: Math.round(bounds.left * 100) / 100,
        right: Math.round(bounds.right * 100) / 100,
        width: Math.round(bounds.width * 100) / 100,
        height: Math.round(bounds.height * 100) / 100,
      };
    };
    const topbar = document.querySelector('.mobile-top-bar');
    const bottomNav = document.querySelector('.mobile-bottom-nav');
    const drawer = document.querySelector('.shell-drawer');
    const account = drawer?.querySelector('.shell-account');
    const signOut = drawer?.querySelector('.shell-signout');
    const nav = drawer?.querySelector('.shell-nav');
    const returnLink = document.querySelector('.route-return-link');
    const title = document.querySelector('.page-header-title');
    const triggers = [...document.querySelectorAll('[aria-controls="app-navigation-drawer"]')];
    const bottomItems = bottomNav
      ? [...bottomNav.querySelectorAll('.mobile-bottom-nav-item, .new-job-menu-trigger')]
      : [];
    const labels = [...document.querySelectorAll('.mobile-bottom-nav-label, .new-job-menu-trigger-label')];
    return {
      topbar: rect(topbar),
      topbarMenuButton: Boolean(topbar?.querySelector('.shell-menu-button')),
      bottomNav: rect(bottomNav),
      drawer: rect(drawer),
      drawerGroups: drawer
        ? [...drawer.querySelectorAll('[data-nav-section]')].map((group) => group.getAttribute('data-nav-section'))
        : [],
      account: rect(account),
      signOut: rect(signOut),
      signOutText: signOut?.textContent ?? null,
      nav: rect(nav),
      drawerIsLast: drawer ? drawer === drawer.parentElement?.lastElementChild : false,
      drawerBrandCount: drawer ? drawer.querySelectorAll('.dunya-dental-brand').length : 0,
      returnLink: rect(returnLink),
      title: rect(title),
      triggerCount: triggers.length,
      triggerInBottomNav: triggers.length === 1 ? Boolean(triggers[0].closest('.mobile-bottom-nav')) : false,
      triggerExpanded: triggers.length === 1 ? triggers[0].getAttribute('aria-expanded') : null,
      menuTriggerLabel: triggers.length === 1 ? triggers[0].textContent : null,
      bottomItemCount: bottomItems.length,
      bottomIcons: bottomNav?.querySelectorAll('.mobile-nav-icon').length ?? 0,
      bottomTargets: bottomItems.map((item) => {
        const bounds = item.getBoundingClientRect();
        return { width: Math.round(bounds.width), height: Math.round(bounds.height) };
      }),
      bottomLabelSizes: labels.map((label) => Number.parseFloat(getComputedStyle(label).fontSize)),
      currentDestination: bottomNav?.querySelector('[aria-current="page"]')?.textContent ?? null,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      activeElement: document.activeElement?.className ?? document.activeElement?.tagName ?? null,
      activeText: document.activeElement?.textContent ?? null,
      sheet: rect(document.querySelector('.new-job-menu-panel--sheet')),
      sheetInsideBottomNav: Boolean(document.querySelector('.mobile-bottom-nav [role="dialog"]')),
      sheetParentIsBody: document.querySelector('.new-job-menu-panel--sheet')?.parentElement === document.body,
      sheetOptions: [...document.querySelectorAll('.new-job-menu-panel--sheet .new-job-menu-item')]
        .map((item) => item.textContent),
      drawerTopmost: (() => {
        if (!drawer) return null;
        const bounds = drawer.getBoundingClientRect();
        const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
        return Boolean(hit && drawer.contains(hit));
      })(),
      mainTop: rect(document.querySelector('[data-fixture-main]'))?.top ?? null,
      bannerBottom: rect(document.querySelector('.offboarding-return-nav'))?.bottom ?? null,
      sheetTopmost: (() => {
        const node = document.querySelector('.new-job-menu-panel--sheet');
        if (!node) return null;
        const bounds = node.getBoundingClientRect();
        const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
        return Boolean(hit && node.contains(hit));
      })(),
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
    };
  });
}

const browser = await chromium.launch({ headless: true });
const rows = [];

async function open({ role, path, width, height, banner = false }) {
  const page = await browser.newPage({
    viewport: { width, height },
    locale: 'tr-TR',
    timezoneId: 'Europe/Istanbul',
    reducedMotion: 'reduce',
    hasTouch: width < 768,
  });
  page.setDefaultTimeout(12000);
  await page.route('**/api/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ items: [], total: 0, limit: 20, offset: 0, unreadCount: 0 }),
  }));
  await page.goto(`${url}?role=${role}&path=${encodeURIComponent(path)}${banner ? '&banner=1' : ''}`, { waitUntil: 'load' });
  await page.locator('.authenticated-shell').waitFor();
  await page.evaluate(() => document.fonts.ready);
  return page;
}

async function capture(page, name) {
  if (!captureDir) return;
  await page.screenshot({ path: resolve(captureDir, `${phase}-${name}.png`) });
}

try {
  // 1. Single Menü entry per role, bottom-nav geometry, and no horizontal overflow.
  for (const role of ['STAFF', 'MANAGER', 'ADMIN']) {
    for (const [width, height] of [[320, 568], [390, 844], [768, 1024]]) {
      const page = await open({ role, path: '/jobs', width, height });
      const m = await measure(page);
      const tag = `${role} ${width}x${height}`;
      check(m.overflow <= 1, `${tag}: horizontal overflow ${m.overflow}px`);
      check(m.triggerCount === 1, `${tag}: expected exactly one Menü trigger, found ${m.triggerCount}`);
      check(m.triggerInBottomNav, `${tag}: the single Menü trigger must live in the bottom navigation`);
      check(m.topbarMenuButton === false, `${tag}: the top bar must not carry a menu trigger`);
      check(m.bottomItemCount <= 5, `${tag}: ${m.bottomItemCount} bottom slots (max 5)`);
      check(m.bottomIcons === m.bottomItemCount, `${tag}: every bottom slot needs an icon`);
      check(
        m.bottomTargets.every((target) => target.width >= 44 && target.height >= 44),
        `${tag}: bottom target below 44x44 (${JSON.stringify(m.bottomTargets)})`,
      );
      check(m.bottomLabelSizes.every((size) => size >= 12), `${tag}: bottom label below 12px (${m.bottomLabelSizes})`);
      check(Boolean(m.currentDestination), `${tag}: no aria-current destination in the bottom navigation`);
      check(m.returnLink === null, `${tag}: the root jobs route must not render a ReturnLink`);
      checks.push({ tag, bottomItemCount: m.bottomItemCount, bottomTargets: m.bottomTargets });
      if (width === 390) await capture(page, `${role}-closed`);
      await page.close();
    }
  }

  // 2. Menu panel: right-anchored, account first, two groups, focus contract.
  for (const role of ['STAFF', 'MANAGER', 'ADMIN']) {
    for (const [width, height] of [[320, 568], [390, 844], [768, 1024]]) {
      const page = await open({ role, path: '/jobs', width, height });
      const trigger = page.locator('.mobile-bottom-nav [aria-controls="app-navigation-drawer"]');
      await trigger.click();
      const m = await measure(page);
      const tag = `${role} ${width}x${height} menu`;
      check(m.triggerExpanded === 'true', `${tag}: aria-expanded did not switch to true`);
      check(m.drawer !== null, `${tag}: menu panel did not open`);
      check(
        Boolean(m.drawer) && Math.abs(m.drawer.right - m.innerWidth) <= 1,
        `${tag}: the panel must open from the right edge (right=${m.drawer?.right}, viewport=${m.innerWidth})`,
      );
      check(Boolean(m.drawer) && m.drawer.left > 0, `${tag}: the panel must not cover the full width`);
      check(m.drawerBrandCount === 0, `${tag}: the panel must not carry a brand block`);
      check(
        JSON.stringify(m.drawerGroups) === JSON.stringify(['Çalışma', 'Hesap ve destek']),
        `${tag}: unexpected group order ${JSON.stringify(m.drawerGroups)}`,
      );
      check(
        Boolean(m.account && m.nav) && m.account.bottom <= m.nav.top + 1,
        `${tag}: the account row must come before the destinations`,
      );
      check(m.signOutText === 'Oturumu kapat', `${tag}: sign-out label missing (${m.signOutText})`);
      check(
        Boolean(m.account && m.signOut)
          && m.account.top >= -1 && m.account.bottom <= m.innerHeight + 1
          && m.signOut.top >= -1 && m.signOut.bottom <= m.innerHeight + 1,
        `${tag}: account/sign-out is not visible without scrolling (account=${JSON.stringify(m.account)}`
          + ` signOut=${JSON.stringify(m.signOut)}, viewport=${m.innerHeight})`,
      );
      check(m.overflow <= 1, `${tag}: horizontal overflow ${m.overflow}px`);
      check(m.drawerTopmost === true, `${tag}: the menu panel is not the topmost layer at its centre`);
      checks.push({ tag, drawer: m.drawer, accountBottom: m.account?.bottom, groups: m.drawerGroups });
      if (width === 390) await capture(page, `${role}-menu`);
      // Escape closes and restores focus to the trigger.
      await page.keyboard.press('Escape');
      const closed = await measure(page);
      check(closed.drawer === null, `${tag}: Escape did not close the panel`);
      check(
        String(closed.activeElement).includes('mobile-bottom-nav-menu'),
        `${tag}: focus was not restored to the Menü trigger (${closed.activeElement})`,
      );
      await page.close();
    }
  }

  // 3. Create sheet from the bottom navigation, on a non-jobs route.
  {
    const page = await open({ role: 'STAFF', path: '/customers', width: 390, height: 844 });
    const trigger = page.locator('.mobile-bottom-nav-create .new-job-menu-trigger');
    await trigger.click();
    const m = await measure(page);
    check(m.overflow <= 1, 'create sheet 390x844: horizontal overflow');
    check(m.sheet !== null, 'create sheet 390x844: the sheet did not open');
    check(
      m.sheetOptions.includes('Görüşme / ziyaret planla')
        && m.sheetOptions.includes('Yeni görev')
        && m.sheetOptions.includes('Yeni teslim'),
      `create sheet 390x844: create options missing (${JSON.stringify(m.sheetOptions)})`,
    );
    check(
      Boolean(m.sheet) && m.sheet.left >= -1 && m.sheet.right <= m.innerWidth + 1
        && m.sheet.bottom <= m.innerHeight + 1,
      `create sheet 390x844: sheet is outside the viewport (${JSON.stringify(m.sheet)})`,
    );
    check(m.sheetInsideBottomNav === false,
      'create sheet 390x844: the sheet must not be a descendant of the bottom navigation');
    check(m.sheetParentIsBody === true,
      'create sheet 390x844: the sheet must render as a global document-body layer');
    check(m.sheetTopmost === true,
      'create sheet 390x844: the sheet is not the topmost layer at its centre point');
    checks.push({ tag: 'create sheet 390x844', sheet: m.sheet, topmost: m.sheetTopmost });
    await capture(page, 'STAFF-390x844-create-sheet');
    await page.keyboard.press('Escape');
    const closed = await measure(page);
    check(closed.sheet === null, 'create sheet 390x844: Escape did not close the sheet');
    check(
      String(closed.activeElement).includes('new-job-menu-trigger'),
      `create sheet 390x844: focus was not restored to the create trigger (${closed.activeElement})`,
    );
    await page.close();
  }

  // 4. F-14 part 1: the hidden H1 must not leave a blank band above the ReturnLink.
  for (const [width, height] of [[320, 568], [390, 844], [768, 1024]]) {
    const page = await open({ role: 'MANAGER', path: '/jobs/abc', width, height });
    const m = await measure(page);
    const tag = `nested ${width}x${height}`;
    check(m.overflow <= 1, `${tag}: horizontal overflow ${m.overflow}px`);
    check(m.returnLink !== null, `${tag}: nested mobile route must render one ReturnLink`);
    check(m.title !== null && m.title.width <= 1, `${tag}: the H1 must stay visually hidden`);
    const gap = m.returnLink && m.topbar ? m.returnLink.top - m.topbar.bottom : null;
    check(
      gap !== null && gap <= 12,
      `${tag}: blank band above the ReturnLink is ${gap}px (max 12px)`,
    );
    checks.push({ tag, topbarBottom: m.topbar?.bottom, returnLinkTop: m.returnLink?.top, gap });
    if (width === 390) await capture(page, 'MANAGER-nested');
    await page.close();
  }

  // 4b. F-14: a leading banner (offboarding return nav) must not re-introduce
  //     the page top margin below it.
  for (const [width, height] of [[390, 844], [768, 1024]]) {
    const page = await open({ role: 'ADMIN', path: '/jobs/abc', width, height, banner: true });
    const m = await measure(page);
    const tag = `banner ${width}x${height}`;
    check(m.overflow <= 1, `${tag}: horizontal overflow ${m.overflow}px`);
    check(m.bannerBottom !== null, `${tag}: the leading banner did not render`);
    const gap = m.bannerBottom !== null && m.mainTop !== null ? m.mainTop - m.bannerBottom : null;
    check(gap !== null && gap <= 1, `${tag}: page main keeps ${gap}px of top margin below the banner`);
    checks.push({ tag, bannerBottom: m.bannerBottom, mainTop: m.mainTop, gap });
    await page.close();
  }

  // 5. Desktop keeps the sidebar shell and has no mobile chrome.
  for (const [width, height] of [[1024, 768], [1440, 900]]) {
    const page = await open({ role: 'ADMIN', path: '/jobs', width, height });
    const desktop = await page.evaluate(() => ({
      sidebar: Boolean(document.querySelector('.shell-sidebar')),
      sidebarGroups: [...document.querySelectorAll('.shell-sidebar [data-nav-section]')]
        .map((group) => group.getAttribute('data-nav-section')),
      bottomNav: Boolean(document.querySelector('.mobile-bottom-nav')),
      topbar: Boolean(document.querySelector('.mobile-top-bar')),
      triggers: document.querySelectorAll('[aria-controls="app-navigation-drawer"]').length,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }));
    const tag = `desktop ${width}x${height}`;
    check(desktop.sidebar, `${tag}: sidebar is missing`);
    check(
      JSON.stringify(desktop.sidebarGroups) === JSON.stringify(['Operasyon', 'Analiz', 'Ekip', 'Destek', 'Hesap']),
      `${tag}: sidebar sections changed ${JSON.stringify(desktop.sidebarGroups)}`,
    );
    check(!desktop.bottomNav && !desktop.topbar && desktop.triggers === 0,
      `${tag}: mobile chrome leaked into the desktop shell`);
    check(desktop.overflow <= 1, `${tag}: horizontal overflow ${desktop.overflow}px`);
    if (width === 1440) await capture(page, 'ADMIN-desktop');
    await page.close();
  }
} finally {
  await browser.close();
  await vite.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}

if (failures.length > 0) {
  console.error(JSON.stringify(checks, null, 2));
  console.error(`mobile shell navigation geometry FAILED (${failures.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(JSON.stringify(checks, null, 2));
  console.log(`mobile shell navigation geometry OK${captureDir ? ` (captures: ${captureDir})` : ''}`);
}
