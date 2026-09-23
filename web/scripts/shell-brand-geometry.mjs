/**
 * Slice 4 shell-brand/mobile-topbar geometry contract.
 *
 * This is a local, static DOM fixture using the production shell classes and
 * styles only; it never calls the API or a deployed environment. It measures
 * the widths required by the acceptance contract at every shell breakpoint,
 * including large-text and the responsive login composition.
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
        <button class="shell-menu-button" type="button" aria-label="Menüyü aç">Menü</button>
      </div>
    </header>
    <div class="shell-content"><main class="workspace"><h1>Shell fixture</h1><p>Yerel geometri verisi.</p></main></div>
    <nav id="bottom-nav" class="mobile-bottom-nav" aria-label="Mobil ana navigasyon">
      <a class="mobile-bottom-nav-item" href="/jobs">İşler</a><button class="mobile-bottom-nav-item mobile-bottom-nav-menu" type="button">Menü</button>
    </nav>
  </div>
  <div id="login-fixture" style="display:none">
    <main class="login-layout">
      <section class="login-introduction"><span class="dunya-dental-brand dunya-dental-brand--login-hero" aria-label="Dünya Dental"><img src="/branding/dunya-dental-sidebar.png" alt="" /></span></section>
      <section class="login-panel"><div class="login-form-wrap"><h1>Giriş yap</h1><p class="form-intro">Yerel responsive fixture.</p></div></section>
    </main>
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
    const title = document.getElementById('shell-title');
    const modeIsLogin = textMode === 'login';
    if (modeIsLogin) {
      shell.style.display = 'none';
      login.style.display = 'block';
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
    const mobile = viewportWidth < 1024;
    shell.classList.toggle('authenticated-shell--mobile', mobile);
    shell.classList.toggle('authenticated-shell--desktop', !mobile);
    sidebar.style.display = mobile ? 'none' : 'flex';
    desktopTopbar.style.display = mobile ? 'none' : 'flex';
    mobileTopbar.style.display = mobile ? 'flex' : 'none';
    bottomNav.style.display = mobile ? 'flex' : 'none';
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
    const menuRect = rect(mobileTopbar.querySelector('.shell-menu-button'));
    const brands = [...document.querySelectorAll('.dunya-dental-brand--full')];
    const topbarStyle = getComputedStyle(topbar);
    const sidebarBrand = rect(sidebar.querySelector('.dunya-dental-brand--full'));
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
      menuWidth: menuRect?.width ?? 0,
      menuHeight: menuRect?.height ?? 0,
      actionsInViewport: Boolean(actionsRect && actionsRect.left >= -1 && actionsRect.right <= viewportWidth + 1),
      desktopNotificationRightGap: mobile || !topbarRect || !bellRect
        ? null
        : topbarRect.right - bellRect.right,
      fullBrandCount: brands.length,
      mobileHeaderBrandCount: mobileTopbar.querySelectorAll('.dunya-dental-brand').length,
      desktopTopbarBrandCount: desktopTopbar.querySelectorAll('.dunya-dental-brand').length,
      sidebarBrandInViewport: Boolean(sidebarBrand && sidebarBrand.left >= -1 && sidebarBrand.right <= viewportWidth + 1),
      sidebarBrandHref: sidebar.querySelector('.dunya-dental-brand--full')?.getAttribute('href') ?? null,
    };
  }, { viewportWidth: width, viewportHeight: height, textMode: mode });
}

function verifyShell(row) {
  invariant(row.overflow <= 1, `${row.width}px ${row.mode}: page overflow ${row.overflow}px`);
  if (row.mobile) {
    invariant(row.bellWidth >= 44 && row.bellHeight >= 44,
      `${row.width}px ${row.mode}: notification target below 44px (${row.bellWidth}x${row.bellHeight})`);
    invariant(row.menuWidth >= 44 && row.menuHeight >= 44,
      `${row.width}px ${row.mode}: Menu target below 44px (${row.menuWidth}x${row.menuHeight})`);
    invariant(row.topbarPosition === 'sticky' && row.topbarTop === '0px' && row.topbarZIndex < 30,
      `${row.width}px ${row.mode}: sticky mobile topbar contract failed`);
    invariant(row.mobileHeaderBrandCount === 0 && row.desktopTopbarBrandCount === 0,
      `${row.width}px ${row.mode}: brand leaked into mobile/topbar`);
    invariant(row.actionsInViewport && !row.titleActionsOverlap,
      `${row.width}px ${row.mode}: title/actions overlap or leave viewport`);
    invariant(row.titleWidth > 0, `${row.width}px ${row.mode}: title is not measurable`);
    if (row.width === 320 && row.mode === 'normal') {
      invariant(row.titleText === 'Genel Bakış' && row.titleClientWidth >= 80,
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
} finally {
  await browser.close();
  await vite.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}

console.log(JSON.stringify(rows, null, 2));
console.log('shell brand geometry OK');
