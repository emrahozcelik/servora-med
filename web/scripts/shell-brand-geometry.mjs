/**
 * Slice 4 shell-brand/mobile-topbar geometry contract.
 *
 * This is a local, static DOM fixture using the production shell classes and
 * styles only; it never calls the API or a deployed environment. It measures
 * the widths required by the acceptance contract at every shell breakpoint,
 * including large-text and the responsive login composition.
 *
 * DECISIONS.md UI-004: the mobile top bar has no menu trigger and the single
 * menu panel opens from the right edge with the account row before the
 * destinations.
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(resolve(root, 'src/styles.css'), 'utf8');
const html = `<!doctype html><html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/><style>${css}</style></head>
<body>
  <div id="shell" class="authenticated-shell authenticated-shell--mobile">
    <aside id="sidebar" class="shell-sidebar" style="display:none">
      <div class="shell-sidebar-brand brand-lockup">
        <a class="dunya-dental-brand dunya-dental-brand--full" href="/jobs" aria-label="Dünya Dental ana sayfa">
          <img src="/branding/dunya-dental-sidebar.png" alt="" />
        </a>
      </div>
      <nav class="shell-nav" aria-label="Ana navigasyon"><a href="/jobs" aria-current="page">İşler</a></nav>
    </aside>
    <header id="desktop-topbar" class="desktop-shell-topbar" style="display:none">
      <div class="notification-center"><button class="shell-notification-trigger" type="button" aria-label="Bildirimler"><span class="shell-notification-icon" aria-hidden="true">◌</span></button></div>
    </header>
    <header id="mobile-topbar" class="compact-shell-header mobile-top-bar">
      <div class="mobile-top-bar-start"><p id="shell-title" class="mobile-shell-title">Genel Bakış</p></div>
      <div class="mobile-top-bar-actions">
        <div class="notification-center"><button class="shell-notification-trigger" type="button" aria-label="Bildirimler"><span class="shell-notification-icon" aria-hidden="true">◌</span></button></div>
      </div>
    </header>
    <div class="shell-content"><main class="workspace"><h1>Shell fixture</h1><p>Yerel geometri verisi.</p></main></div>
    <nav id="bottom-nav" class="mobile-bottom-nav" aria-label="Mobil ana navigasyon">
      <a class="mobile-bottom-nav-item" href="/jobs"><svg class="mobile-nav-icon" viewBox="0 0 24 24" aria-hidden="true"></svg><span class="mobile-bottom-nav-label">İşler</span></a>
      <button class="mobile-bottom-nav-item mobile-bottom-nav-menu" type="button" aria-controls="drawer" aria-expanded="false"><svg class="mobile-nav-icon" viewBox="0 0 24 24" aria-hidden="true"></svg><span class="mobile-bottom-nav-label">Menü</span></button>
    </nav>
  </div>
  <div id="login-fixture" style="display:none">
    <main class="login-panel">
      <section class="login-form-wrap">
        <div class="login-brand"><span class="dunya-dental-brand dunya-dental-brand--login-hero" aria-label="Dünya Dental"><img src="/branding/dunya-dental-sidebar.png" alt="" /></span></div>
        <p class="eyebrow">İş ve operasyon yönetimi</p>
        <h1>Hesabınıza giriş yapın</h1>
        <p class="form-help">Yerel responsive fixture.</p>
      </section>
    </main>
  </div>
  <div id="drawer-backdrop" class="shell-drawer-backdrop" style="display:none">
    <aside id="drawer" class="shell-drawer" role="dialog" aria-label="Menü">
      <div class="drawer-heading"><h2>Menü</h2><button class="drawer-close" type="button">Kapat</button></div>
      <div class="shell-account">
        <div class="shell-identity"><span class="servora-user-avatar" aria-hidden="true">AY</span><div><strong>Ayşe Personel</strong><span>Personel</span></div></div>
        <button class="shell-signout" type="button">Oturumu kapat</button>
      </div>
      <nav class="shell-nav" aria-label="Tüm destinasyonlar">
        <section class="shell-nav-section"><h2>Çalışma</h2><div class="shell-nav-links"><a href="/jobs" aria-current="page">İşler</a></div></section>
        <section class="shell-nav-section"><h2>Hesap ve destek</h2><div class="shell-nav-links"><a href="/settings">Ayarlar</a></div></section>
      </nav>
    </aside>
  </div>
</body></html>`;

const viewports = [
  { width: 320, height: 568 },
  { width: 360, height: 740 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 768, height: 1024 },
  { width: 1023, height: 768 },
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function startServer() {
  const vite = await createViteServer({
    root,
    configFile: false,
    appType: 'custom',
    logLevel: 'error',
    server: { middlewareMode: true },
  });
  return new Promise((resolveServer) => {
    const server = createServer((request, response) => {
      if ((request.url ?? '/').split('?')[0] === '/') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(html);
        return;
      }
      vite.middlewares(request, response, () => {
        response.writeHead(404);
        response.end();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolveServer({ server, vite, url: `http://127.0.0.1:${address.port}/` });
    });
  });
}

async function measure(page, viewport, mode = 'normal') {
  const { width, height } = viewport;
  await page.setViewportSize({ width, height });
  await page.goto(`${url}?mode=${mode}`, { waitUntil: 'networkidle' });
  return page.evaluate(({ viewportWidth, viewportHeight, textMode }) => {
    const shell = document.getElementById('shell');
    const sidebar = document.getElementById('sidebar');
    const desktopTopbar = document.getElementById('desktop-topbar');
    const mobileTopbar = document.getElementById('mobile-topbar');
    const bottomNav = document.getElementById('bottom-nav');
    const login = document.getElementById('login-fixture');
    const drawerBackdrop = document.getElementById('drawer-backdrop');
    const drawer = document.getElementById('drawer');
    const title = document.getElementById('shell-title');
    const modeIsLogin = textMode === 'login';
    if (modeIsLogin) {
      shell.style.display = 'none';
      login.style.display = 'block';
      drawerBackdrop.style.display = 'none';
      const brand = login.querySelector('.dunya-dental-brand--login-hero');
      const bounds = brand?.getBoundingClientRect() ?? null;
      return {
        mode: textMode,
        width: viewportWidth,
        height: viewportHeight,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        brandWidth: bounds?.width ?? 0,
        brandInViewport: Boolean(bounds && bounds.left >= -1 && bounds.right <= viewportWidth + 1),
      };
    }

    login.style.display = 'none';
    shell.style.display = '';
    drawerBackdrop.style.display = textMode === 'drawer' ? 'flex' : 'none';
    const mobile = viewportWidth < 1024;
    shell.classList.toggle('authenticated-shell--mobile', mobile);
    shell.classList.toggle('authenticated-shell--desktop', !mobile);
    sidebar.style.display = mobile ? 'none' : 'flex';
    desktopTopbar.style.display = mobile ? 'none' : 'flex';
    mobileTopbar.style.display = mobile ? 'flex' : 'none';
    bottomNav.style.display = mobile ? 'grid' : 'none';
    title.textContent = textMode === 'long'
      ? 'Müşteri ve operasyon detayları için çok uzun dinamik rota başlığı'
      : 'Genel Bakış';
    if (textMode === 'large-text') document.documentElement.style.fontSize = '200%';

    const rect = (element) => element?.getBoundingClientRect() ?? null;
    const topbar = mobile ? mobileTopbar : desktopTopbar;
    const topbarRect = rect(topbar);
    const titleRect = rect(title);
    const actionsRect = rect(mobileTopbar.querySelector('.mobile-top-bar-actions'));
    const bellRect = rect(topbar.querySelector('[aria-label="Bildirimler"]'));
    const menuInTopbar = mobileTopbar.querySelector('.shell-menu-button');
    const bottomMenuRect = rect(bottomNav.querySelector('.mobile-bottom-nav-menu'));
    const bottomNavRect = rect(bottomNav);
    const bottomLabel = bottomNav.querySelector('.mobile-bottom-nav-label');
    const bottomIconRect = rect(bottomNav.querySelector('.mobile-nav-icon'));
    const brands = [...document.querySelectorAll('.dunya-dental-brand--full')];
    const visibleBrands = brands.filter((brand) => {
      const brandRect = brand.getBoundingClientRect();
      const style = getComputedStyle(brand);
      return brandRect.width > 0 && brandRect.height > 0 && style.visibility !== 'hidden';
    });
    const topbarStyle = getComputedStyle(topbar);
    const sidebarBrand = rect(sidebar.querySelector('.dunya-dental-brand--full'));
    const drawerRect = drawer.getBoundingClientRect();
    const accountRect = rect(drawer.querySelector('.shell-account'));
    const signOutRect = rect(drawer.querySelector('.shell-signout'));
    const drawerHeadingRect = rect(drawer.querySelector('.drawer-heading'));
    const drawerNavRect = rect(drawer.querySelector('.shell-nav'));
    const drawerStyle = getComputedStyle(drawer);
    const drawerBackdropStyle = getComputedStyle(drawerBackdrop);
    const titleText = title.textContent ?? '';
    return {
      mode: textMode,
      width: viewportWidth,
      height: viewportHeight,
      mobile,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      topbarWidth: topbarRect?.width ?? 0,
      topbarHeight: topbarRect?.height ?? 0,
      topbarPosition: topbarStyle.position,
      topbarTop: topbarStyle.top,
      topbarZIndex: Number.parseInt(topbarStyle.zIndex || '0', 10),
      topbarInViewport: Boolean(topbarRect && topbarRect.left >= -1 && topbarRect.right <= viewportWidth + 1),
      titleWidth: titleRect?.width ?? 0,
      titleClientWidth: title.clientWidth,
      titleScrollWidth: title.scrollWidth,
      titleText,
      titleActionsOverlap: Boolean(titleRect && actionsRect
        && titleRect.right > actionsRect.left - 1
        && titleRect.left < actionsRect.right + 1),
      bellWidth: bellRect?.width ?? 0,
      bellHeight: bellRect?.height ?? 0,
      topbarMenuButtonPresent: Boolean(menuInTopbar),
      bottomMenuWidth: bottomMenuRect?.width ?? 0,
      bottomMenuHeight: bottomMenuRect?.height ?? 0,
      bottomNavInViewport: Boolean(bottomNavRect && bottomNavRect.left >= -1
        && bottomNavRect.right <= viewportWidth + 1 && bottomNavRect.bottom <= viewportHeight + 1),
      bottomLabelFontSize: bottomLabel ? Number.parseFloat(getComputedStyle(bottomLabel).fontSize) : 0,
      bottomIconVisible: Boolean(bottomIconRect && bottomIconRect.width > 0 && bottomIconRect.height > 0),
      actionsInViewport: Boolean(actionsRect && actionsRect.left >= -1 && actionsRect.right <= viewportWidth + 1),
      desktopNotificationRightGap: mobile || !topbarRect || !bellRect
        ? null
        : topbarRect.right - bellRect.right,
      fullBrandCount: visibleBrands.length,
      mobileHeaderBrandCount: mobileTopbar.querySelectorAll('.dunya-dental-brand').length,
      desktopTopbarBrandCount: desktopTopbar.querySelectorAll('.dunya-dental-brand').length,
      sidebarBrandInViewport: Boolean(sidebarBrand && sidebarBrand.left >= -1 && sidebarBrand.right <= viewportWidth + 1),
      sidebarBrandHref: sidebar.querySelector('.dunya-dental-brand--full')?.getAttribute('href') ?? null,
      drawerWidth: drawerRect.width,
      drawerRight: drawerRect.right,
      drawerRightAligned: Math.abs(drawerRect.right - viewportWidth) <= 1,
      drawerBrandCount: drawer.querySelectorAll('.dunya-dental-brand').length,
      drawerAccountBeforeNav: Boolean(accountRect && drawerNavRect && accountRect.bottom <= drawerNavRect.top + 1),
      drawerAccountBelowHeading: Boolean(accountRect && drawerHeadingRect && accountRect.top >= drawerHeadingRect.bottom - 1),
      drawerAccountVisible: Boolean(accountRect
        && accountRect.top >= -1
        && accountRect.bottom <= viewportHeight + 1
        && getComputedStyle(drawer).display !== 'none'),
      drawerSignOutVisible: Boolean(signOutRect
        && signOutRect.top >= -1
        && signOutRect.bottom <= viewportHeight + 1),
      drawerOverflow: drawer.scrollWidth - drawer.clientWidth,
      drawerZIndex: Number.parseInt(getComputedStyle(drawerBackdrop).zIndex || '0', 10),
      drawerJustify: drawerBackdropStyle.justifyContent,
      drawerStyleOverflowX: drawerStyle.overflowX,
      drawerBorderLeft: drawerStyle.borderLeftWidth,
      drawerBorderRight: drawerStyle.borderRightWidth,
    };
  }, { viewportWidth: width, viewportHeight: height, textMode: mode });
}

function verifyShell(row) {
  invariant(row.overflow <= 1, `${row.width}px ${row.mode}: page overflow ${row.overflow}px`);
  if (row.mobile) {
    invariant(row.bellWidth >= 44 && row.bellHeight >= 44,
      `${row.width}px ${row.mode}: notification target below 44px (${row.bellWidth}x${row.bellHeight})`);
    invariant(row.topbarMenuButtonPresent === false,
      `${row.width}px ${row.mode}: the mobile top bar must not carry a menu trigger (UI-004)`);
    invariant(row.bottomMenuWidth >= 44 && row.bottomMenuHeight >= 44,
      `${row.width}px ${row.mode}: bottom Menü target below 44px (${row.bottomMenuWidth}x${row.bottomMenuHeight})`);
    invariant(row.bottomNavInViewport, `${row.width}px ${row.mode}: bottom navigation is not in the viewport`);
    invariant(row.topbarPosition === 'sticky' && row.topbarTop === '0px' && row.topbarZIndex < 30,
      `${row.width}px ${row.mode}: sticky mobile topbar contract failed`);
    invariant(row.mobileHeaderBrandCount === 0 && row.desktopTopbarBrandCount === 0,
      `${row.width}px ${row.mode}: brand leaked into mobile/topbar`);
    invariant(row.actionsInViewport && !row.titleActionsOverlap,
      `${row.width}px ${row.mode}: title/actions overlap or leave viewport`);
    invariant(row.titleWidth > 0, `${row.width}px ${row.mode}: title is not measurable`);
    invariant(row.bottomLabelFontSize >= 12,
      `${row.width}px ${row.mode}: bottom label below the 12px floor (${row.bottomLabelFontSize}px)`);
    invariant(row.bottomIconVisible, `${row.width}px ${row.mode}: bottom-nav icon is not rendered`);
    if (row.width === 320 && row.mode === 'normal') {
      invariant(row.titleText === 'Genel Bakış' && row.titleClientWidth >= 120,
        `320px: Genel Bakış title is not readable (${row.titleClientWidth}px)`);
    }
    if (row.width === 320 && row.mode === 'large-text') {
      invariant(row.titleClientWidth >= 44,
        `320px large text: title column is not usable (${row.titleClientWidth}px)`);
    }
  } else {
    invariant(row.fullBrandCount === 1 && row.sidebarBrandInViewport && row.sidebarBrandHref === '/jobs',
      `${row.width}px: desktop sidebar brand contract failed`);
    invariant(row.desktopTopbarBrandCount === 0,
      `${row.width}px: desktop topbar must not render a brand`);
    invariant(row.desktopNotificationRightGap !== null && row.desktopNotificationRightGap <= 60,
      `${row.width}px: desktop notification is not right-aligned (${row.desktopNotificationRightGap}px gap)`);
  }
  if (row.mode === 'long') invariant(row.titleScrollWidth >= row.titleClientWidth, `${row.width}px: long title did not expose ellipsis space`);
}

function verifyDrawer(row) {
  invariant(row.mobile && row.mode === 'drawer', `${row.width}px drawer: fixture is not mobile/open`);
  invariant(row.drawerRightAligned && row.drawerJustify === 'flex-end',
    `${row.width}px drawer: the panel must open from the right edge (right=${row.drawerRight},`
      + ` viewport=${row.width}, justify=${row.drawerJustify})`);
  invariant(row.drawerBorderLeft !== '0px' && row.drawerBorderRight === '0px',
    `${row.width}px drawer: expected a left border only (left=${row.drawerBorderLeft} right=${row.drawerBorderRight})`);
  invariant(row.drawerBrandCount === 0, `${row.width}px drawer: the menu must not carry a brand block (UI-004)`);
  invariant(row.drawerAccountBelowHeading && row.drawerAccountBeforeNav,
    `${row.width}px drawer: the account row must come before the destinations (UI-004)`);
  invariant(row.drawerAccountVisible && row.drawerSignOutVisible,
    `${row.width}px drawer: account/sign-out is below the fold (account=${row.drawerAccountVisible}`
      + ` signOut=${row.drawerSignOutVisible})`);
  invariant(row.drawerOverflow <= 1 && row.overflow <= 1,
    `${row.width}px drawer: drawer/page containment failed`
      + ` (drawerOverflow=${row.drawerOverflow} pageOverflow=${row.overflow})`);
  invariant(row.drawerZIndex === 30 && row.drawerStyleOverflowX === 'hidden',
    `${row.width}px drawer: shell layering/overflow contract failed`);
  invariant(row.mobileHeaderBrandCount === 0 && row.desktopTopbarBrandCount === 0,
    `${row.width}px drawer: topbar brand leaked while drawer open`);
}

const { server, vite, url } = await startServer();
const browser = await chromium.launch({ headless: true });
const rows = [];
try {
  const page = await browser.newPage();
  for (const viewport of viewports) {
    const row = await measure(page, viewport);
    verifyShell(row);
    rows.push(row);
    if (viewport.width <= 430 || viewport.width === 1023 || viewport.width === 1024) {
      const long = await measure(page, viewport, 'long');
      verifyShell(long);
      rows.push(long);
    }
  }
  for (const width of [320, 390, 430, 768]) {
    const viewport = viewports.find((candidate) => candidate.width === width);
    invariant(viewport, `missing viewport fixture for ${width}px`);
    const large = await measure(page, viewport, 'large-text');
    verifyShell(large);
    rows.push(large);
  }
  for (const width of [320, 390, 430, 768, 1024, 1440]) {
    const viewport = viewports.find((candidate) => candidate.width === width);
    invariant(viewport, `missing viewport fixture for ${width}px`);
    const login = await measure(page, viewport, 'login');
    invariant(login.overflow <= 1 && login.brandWidth > 0 && login.brandInViewport,
      `${width}px login: responsive brand contract failed`);
    rows.push(login);
  }
  for (const width of [320, 390, 768]) {
    const viewport = viewports.find((candidate) => candidate.width === width);
    invariant(viewport, `missing viewport fixture for ${width}px`);
    const drawer = await measure(page, viewport, 'drawer');
    verifyShell(drawer);
    verifyDrawer(drawer);
    rows.push(drawer);
  }
} finally {
  await browser.close();
  await vite.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}

console.log(JSON.stringify(rows, null, 2));
console.log('shell brand geometry OK');
