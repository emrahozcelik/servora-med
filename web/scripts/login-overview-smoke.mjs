/**
 * Login + Overview rendered geometry and content contract (UI audit F-16/F-17).
 *
 * Real production components (LoginScreen through App, OverviewPage), the owned
 * Ant provider, production CSS and deterministic synthetic data. Login checks
 * first-screen fit, the password toggle target/keyboard behaviour and the
 * absence of user-facing build metadata. Overview checks the manager approval
 * queue, KPI tone hierarchy, trend date context/zero baseline, one-card row
 * lists with dividers, second-free timestamps and the unread-message gate.
 *
 * Screenshots are written to LOGIN_OVERVIEW_CAPTURE_DIR (never committed).
 */
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, process.env.LOGIN_OVERVIEW_CAPTURE_DIR ?? '.ui-evidence/login-overview-package-d');
mkdirSync(out, { recursive: true });

const document = `<!doctype html><html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Servora-Med login/overview fixture</title></head>
<body><div id="root"></div>
<script type="module" src="/scripts/login-overview-fixture.tsx"></script>
</body></html>`;

const checks = [];
const failures = [];
const pageErrors = [];
// Vite's dev-server HMR transport can race a page navigation and surface as a
// page error ("WebSocket closed without opened."). It is runner noise, not
// product behavior, and is the only message filtered here.
const isRunnerNoise = (message) => message.endsWith('WebSocket closed without opened.');

function check(name, condition, detail = '') {
  checks.push({ name, passed: Boolean(condition), detail });
  if (!condition) failures.push(detail ? `${name}: ${detail}` : name);
}

async function startServer() {
  const vite = await createViteServer({
    root,
    configFile: false,
    appType: 'custom',
    logLevel: 'error',
    server: { middlewareMode: true, hmr: false },
  });
  return new Promise((resolveServer) => {
    const server = createServer((request, response) => {
      const path = (request.url ?? '/').split('?')[0];
      if (path === '/login' || path === '/overview') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(document);
        return;
      }
      vite.middlewares(request, response, () => {
        response.writeHead(404);
        response.end();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolveServer({ server, vite, url: `http://127.0.0.1:${port}` });
    });
  });
}

async function measureLogin(page) {
  return page.evaluate(() => {
    const rect = (element) => {
      const bounds = element?.getBoundingClientRect();
      return bounds ? { width: bounds.width, height: bounds.height } : null;
    };
    const toggle = document.querySelector('.password-toggle');
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      scrollHeight: document.documentElement.scrollHeight,
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollHeight: document.body.scrollHeight,
      titleText: document.querySelector('#login-title')?.textContent ?? null,
      eyebrowCount: document.querySelectorAll('.eyebrow').length,
      buildIdentityCount: document.querySelectorAll('.build-identity').length,
      brandWidth: document.querySelector('.login-brand .dunya-dental-brand')?.getBoundingClientRect().width ?? 0,
      formWidth: document.querySelector('.login-form-wrap')?.getBoundingClientRect().width ?? 0,
      toggleRect: rect(toggle),
      toggleName: toggle?.getAttribute('aria-label') ?? null,
      togglePressed: toggle?.getAttribute('aria-pressed') ?? null,
      passwordType: document.querySelector('#password')?.getAttribute('type') ?? null,
      passwordAutocomplete: document.querySelector('#password')?.getAttribute('autocomplete') ?? null,
      capsHintRole: document.querySelector('#password-caps-hint')?.getAttribute('role') ?? null,
      submitWidth: document.querySelector('button[type="submit"]')?.getBoundingClientRect().width ?? 0,
      activeElementId: document.activeElement?.id ?? null,
    };
  });
}

async function verifyLogin(page, viewport, captureName) {
  await page.goto(`${url}/login?surface=login`, { waitUntil: 'load' });
  await page.locator('#login-title').waitFor({ state: 'visible' });
  await page.evaluate(() => document.fonts.ready);
  const m = await measureLogin(page);
  const label = `${viewport.name} login`;

  check(`${label} title`, m.titleText === 'Hesabınıza giriş yapın', m.titleText ?? 'missing');
  check(`${label} single eyebrow`, m.eyebrowCount === 1, `eyebrows=${m.eyebrowCount}`);
  check(`${label} no user-facing build metadata`, m.buildIdentityCount === 0,
    `build-identity nodes=${m.buildIdentityCount}`);
  check(`${label} no vertical page scroll`, m.scrollHeight <= m.viewportHeight + 1,
    `scrollHeight=${m.scrollHeight} viewport=${m.viewportHeight}`);
  check(`${label} no horizontal overflow`, m.scrollWidth <= m.viewportWidth + 1,
    `scrollWidth=${m.scrollWidth} viewport=${m.viewportWidth}`);
  check(`${label} brand visible`, m.brandWidth > 0, `brandWidth=${m.brandWidth}`);
  check(`${label} form keeps its centred column width`,
    Math.abs(m.formWidth - Math.min(m.viewportWidth - 32, 400)) <= 1,
    `formWidth=${m.formWidth} viewport=${m.viewportWidth}`);
  check(`${label} password toggle target`, Boolean(m.toggleRect)
    && m.toggleRect.width >= 44 && m.toggleRect.height >= 44,
  m.toggleRect ? `${m.toggleRect.width}x${m.toggleRect.height}` : 'missing');
  check(`${label} password keeps autocomplete`, m.passwordAutocomplete === 'current-password',
    m.passwordAutocomplete ?? 'missing');
  check(`${label} caps hint is a polite status`, m.capsHintRole === 'status', m.capsHintRole ?? 'missing');
  if (viewport.width >= 1024) {
    check(`${label} desktop focus starts on e-mail`, m.activeElementId === 'email', m.activeElementId ?? 'none');
  } else {
    check(`${label} mobile focus does not open the keyboard`, m.activeElementId !== 'email',
      m.activeElementId ?? 'none');
  }

  // Default-state capture before any interaction adds focus styling.
  await page.screenshot({ path: resolve(out, `${captureName}.png`) });

  // 200% text enlargement must reflow without horizontal scrolling (UI-001).
  await page.addStyleTag({ content: 'html { font-size: 200%; }' });
  const enlarged = await measureLogin(page);
  check(`${label} 200% text keeps horizontal reflow`, enlarged.scrollWidth <= enlarged.viewportWidth + 1,
    `scrollWidth=${enlarged.scrollWidth} viewport=${enlarged.viewportWidth}`);
  await page.goto(`${url}/login?surface=login`, { waitUntil: 'load' });
  await page.locator('#login-title').waitFor({ state: 'visible' });

  // Mouse toggle.
  await page.locator('.password-toggle').click();
  const shown = await measureLogin(page);
  check(`${label} toggle reveals password`, shown.passwordType === 'text' && shown.togglePressed === 'true',
    `type=${shown.passwordType} pressed=${shown.togglePressed}`);
  check(`${label} toggle names the action`, shown.toggleName === 'Parolayı gizle', shown.toggleName ?? 'missing');
  await page.locator('.password-toggle').click();
  const hidden = await measureLogin(page);
  check(`${label} toggle hides password`, hidden.passwordType === 'password' && hidden.togglePressed === 'false',
    `type=${hidden.passwordType} pressed=${hidden.togglePressed}`);

  // Keyboard toggle: native button activation through Enter and Space.
  await page.locator('.password-toggle').focus();
  await page.keyboard.press('Enter');
  const enter = await measureLogin(page);
  check(`${label} toggle works with Enter`, enter.passwordType === 'text', enter.passwordType ?? 'missing');
  await page.keyboard.press('Space');
  const space = await measureLogin(page);
  check(`${label} toggle works with Space`, space.passwordType === 'password', space.passwordType ?? 'missing');
  return m;
}

async function measureOverview(page) {
  return page.evaluate(() => {
    const text = document.body.textContent ?? '';
    const kpiCards = [...document.querySelectorAll('.servora-metric-statistic')].map((card) => ({
      text: card.textContent ?? '',
      classes: card.className,
    }));
    const lists = [...document.querySelectorAll('.overview-row-list')].map((list) => {
      const rows = [...list.querySelectorAll(':scope > .overview-row')];
      const second = rows[1];
      return {
        rowCount: rows.length,
        cardCount: list.closest('.servora-operational-card') ? 1 : 0,
        chipCount: list.querySelectorAll('.servora-tone-chip').length,
        dividerWidth: second ? getComputedStyle(second).borderTopWidth : null,
        sectionRadius: list.closest('.overview-section')
          ? getComputedStyle(list.closest('.overview-section')).borderRadius
          : null,
      };
    });
    const zeroBar = document.querySelector('.report-trend-bars span[data-zero="true"]');
    const range = document.querySelector('.report-trend-range');
    const queueSection = document.querySelector('#approval-queue-title')?.closest('section');
    return {
      hasSeconds: /\b\d{1,2}:\d{2}:\d{2}\b/.test(text),
      rowMeta: [...document.querySelectorAll('.overview-row-meta')].map((node) => node.textContent ?? ''),
      hasDateTimeShape: /\b(Pzt|Sal|Çar|Per|Cum|Cmt|Paz) \d{1,2} (Oca|Şub|Mar|Nis|May|Haz|Tem|Ağu|Eyl|Eki|Kas|Ara) · \d{2}:\d{2}\b/.test(text),
      kpiCards,
      lists,
      zeroBarHeight: zeroBar ? zeroBar.getBoundingClientRect().height : 0,
      zeroBarOpacity: zeroBar ? getComputedStyle(zeroBar).opacity : null,
      rangeText: range?.textContent ?? null,
      queueText: queueSection?.textContent ?? null,
      queueHref: queueSection?.querySelector('a')?.getAttribute('href') ?? null,
      trendLabels: document.querySelectorAll('.report-trend-figure .report-trend-range').length,
      unreadSection: Boolean(document.querySelector('#message-summary-title')),
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
      scrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    };
  });
}

async function verifyOverview(page, viewport, captureName) {
  await page.goto(`${url}/overview?surface=overview&unread=0`, { waitUntil: 'load' });
  await page.locator('#approval-queue-title').waitFor({ state: 'visible' });
  await page.evaluate(() => document.fonts.ready);
  const m = await measureOverview(page);
  const label = `${viewport.name} overview`;

  check(`${label} approval queue copy`, Boolean(m.queueText)
    && m.queueText.includes('3 iş onay bekliyor')
    && m.queueText.includes('En eskisi 2 sa 15 dk bekliyor.'), m.queueText ?? 'missing');
  check(`${label} approval queue link`, m.queueHref === '/jobs?status=WAITING_APPROVAL', m.queueHref ?? 'missing');
  check(`${label} overdue KPI is the strongest tone`,
    m.kpiCards.filter((card) => card.classes.includes('servora-metric-statistic--overdue')).length === 1,
    m.kpiCards.map((card) => card.classes).join(' | '));
  check(`${label} waiting-approval KPI stays neutral`,
    m.kpiCards.some((card) => card.text.includes('Kontrol bekleyen')
      && !card.classes.includes('servora-metric-statistic--')), 'waiting KPI missing or toned');
  check(`${label} revision KPI keeps warning tone`,
    m.kpiCards.filter((card) => card.classes.includes('servora-metric-statistic--warning')).length === 1,
    m.kpiCards.map((card) => card.classes).join(' | '));
  check(`${label} waiting second channel`,
    m.kpiCards.some((card) => card.text.includes('Yönetici değerlendirmesinde')), 'phrase missing');
  check(`${label} dates never show seconds`, !m.hasSeconds, 'timestamp with seconds rendered');
  check(`${label} record dates are readable`, m.hasDateTimeShape, `rows=${JSON.stringify(m.rowMeta)}`);
  check(`${label} trend range labels`, m.trendLabels === 1
    && (m.rangeText ?? '').includes('21 Eki') && (m.rangeText ?? '').includes('19 Kas'), m.rangeText ?? 'missing');
  check(`${label} zero-day baseline visible`, m.zeroBarHeight >= 5 && m.zeroBarOpacity === '1',
    `height=${m.zeroBarHeight} opacity=${m.zeroBarOpacity}`);
  check(`${label} one card per list section`, m.lists.length === 3
    && m.lists.every((list) => list.cardCount === 1 && list.sectionRadius === '0px'),
  JSON.stringify(m.lists));
  check(`${label} rows divided, no per-item chips`, m.lists.every((list) => list.chipCount === 0
    && list.dividerWidth === '1px'), JSON.stringify(m.lists));
  check(`${label} empty unread section omitted`, !m.unreadSection, 'unread section rendered at 0');
  check(`${label} no horizontal overflow`, !m.overflowX, `scrollWidth=${m.scrollWidth} viewport=${m.viewportWidth}`);

  await page.screenshot({ path: resolve(out, `${captureName}.png`) });
  await page.screenshot({ path: resolve(out, `${captureName}-full.png`), fullPage: true });

  await page.goto(`${url}/overview?surface=overview&unread=3`, { waitUntil: 'load' });
  await page.locator('#message-summary-title').waitFor({ state: 'visible' });
  const unread = await measureOverview(page);
  check(`${label} unread section returns when needed`, unread.unreadSection, 'unread section missing at 3');
  return m;
}

const { server, vite, url } = await startServer();
const browser = await chromium.launch({ headless: true });
try {
  for (const viewport of [
    { name: '1440x900', width: 1440, height: 900 },
    { name: '390x844', width: 390, height: 844 },
    { name: '320x568', width: 320, height: 568 },
  ]) {
    const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
    page.on('pageerror', (error) => { if (!isRunnerNoise(error.message)) pageErrors.push(`${viewport.name}: ${error.message}`); });
    await verifyLogin(page, viewport, `login-${viewport.name}`);
    await page.close();
  }
  for (const viewport of [
    { name: '1440x900', width: 1440, height: 900 },
    { name: '390x844', width: 390, height: 844 },
  ]) {
    const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
    page.on('pageerror', (error) => { if (!isRunnerNoise(error.message)) pageErrors.push(`${viewport.name}: ${error.message}`); });
    await verifyOverview(page, viewport, `overview-${viewport.name}`);
    await page.close();
  }
  // The login composition also hosts the forced password change; its taller
  // form must stay reachable from the first line on a short phone.
  {
    const viewport = { name: '320x568', width: 320, height: 568 };
    const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
    page.on('pageerror', (error) => { if (!isRunnerNoise(error.message)) pageErrors.push(`${viewport.name} password-change: ${error.message}`); });
    await page.goto(`${url}/login?surface=password-change`, { waitUntil: 'load' });
    await page.locator('#password-change-title').waitFor({ state: 'visible' });
    await page.evaluate(() => { window.scrollTo(0, 0); document.fonts.ready; });
    const m = await page.evaluate(() => {
      const rect = document.querySelector('#password-change-title')?.getBoundingClientRect();
      return {
        titleTop: rect?.top ?? null,
        overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
      };
    });
    check('320x568 password change first line reachable', m.titleTop !== null && m.titleTop >= -1,
      `titleTop=${m.titleTop}`);
    check('320x568 password change no horizontal overflow', !m.overflowX, 'horizontal overflow');
    await page.close();
  }
} finally {
  await browser.close();
  await vite.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}

check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
console.log(JSON.stringify({ checks, failures, captures: out }, null, 2));
if (failures.length > 0) {
  console.error(`login/overview smoke failed (${failures.length}):\n- ${failures.join('\n- ')}`);
  process.exitCode = 1;
} else {
  console.log('login/overview geometry and content contract OK');
}
