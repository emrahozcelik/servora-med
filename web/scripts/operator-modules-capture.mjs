/**
 * Rendered UI capture for the installation operator Modules page (R0 / MOD-002).
 *
 * Uses the real React entry (`src/main.tsx`), `ServoraAntProvider`, `BrowserRouter`,
 * `App`, `OperatorArea`, `OperatorModulesPage`, production CSS (`src/styles.css` +
 * `src/operator/operator.css`), and deterministic mocked `/api/operator/*` responses
 * via Playwright route interception.
 *
 * Outputs into `$FLEET_EVIDENCE_DIR` (or `.ui-evidence/operator-modules` fallback):
 * - operator-modules-390.png
 * - operator-modules-1440.png
 * - operator-modules-confirm-disable-390.png
 * - operator-modules-confirm-disable-1440.png
 * - operator-modules-confirm-enable-1440.png
 * - operator-modules-two-390.png
 * - operator-modules-two-1440.png
 * - operator-messaging-confirm-disable-390.png
 * - operator-messaging-confirm-disable-1440.png
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(
  process.env.FLEET_EVIDENCE_DIR || resolve(root, '.ui-evidence/operator-modules'),
);
mkdirSync(outDir, { recursive: true });

const packageVersion = JSON.parse(
  readFileSync(resolve(root, 'package.json'), 'utf8'),
).version;
const indexHtml = readFileSync(resolve(root, 'index.html'), 'utf8');

const FIXED_CLOCK_ISO = '2026-11-26T11:00:00.000Z';
const FIXED_UPDATED_AT = '2026-11-26T09:30:00.000Z';

const OPERATOR_PROFILE = {
  id: 'op-1',
  name: 'Kurulum Operatörü',
  email: 'operator@dunyadental.example',
  capabilities: ['MODULE_MANAGEMENT'],
};

const OVERVIEW_BASE = {
  key: 'OVERVIEW',
  label: 'Genel Bakış',
  description:
    'Dönem özeti, onay kuyruğu, yaklaşan ve tamamlanan işleri tek ekranda gösteren başlangıç sayfası.',
  version: 1,
  source: 'ENV_TAKEOVER',
  updatedAt: FIXED_UPDATED_AT,
  whenDisabled: [
    'Genel Bakış menüsü ve sayfası',
    "Genel Bakış'ın açılış sayfası olarak kullanılması",
  ],
  preserved: [
    'İşler, onaylar ve raporlar',
    'Geçmiş kayıtlar ve audit kayıtları',
  ],
};

const MESSAGING_BASE = {
  key: 'MESSAGING',
  label: 'Mesajlaşma',
  description: 'İş ve konu merkezli kurum içi iletişim.',
  version: 1,
  source: 'ENV_TAKEOVER',
  updatedAt: FIXED_UPDATED_AT,
  whenDisabled: [
    'Mesajlar menüsü ve sayfası',
    'Mesajlaşma API erişimi',
    'İş detayından mesajlaşma',
    'Mesaj bildirimleri ve mesaj Web Push teslimatı',
    'Okunmamış mesaj sayacı',
  ],
  preserved: [
    'Konuşmalar ve mesaj geçmişi',
    'Arşiv ve audit kayıtları',
    'Personel devir ve offboarding işlemleri',
  ],
};

// Vite's dev-server HMR transport can race navigation; filter only that runner noise.
const isRunnerNoise = (message) => message.endsWith('WebSocket closed without opened.');

async function startServer() {
  const vite = await createViteServer({
    root,
    configFile: false,
    appType: 'custom',
    logLevel: 'error',
    plugins: [react()],
    define: {
      __SERVORA_APP_VERSION__: JSON.stringify(packageVersion),
    },
    server: { middlewareMode: true, hmr: false },
  });

  return new Promise((resolveServer) => {
    const server = createServer(async (req, res) => {
      try {
        const rawUrl = req.url ?? '/';
        const pathOnly = rawUrl.split('?')[0];
        if (pathOnly === '/operator' || pathOnly.startsWith('/operator/')) {
          const transformed = await vite.transformIndexHtml(rawUrl, indexHtml);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(transformed);
          return;
        }
        vite.middlewares(req, res, () => {
          res.writeHead(404);
          res.end();
        });
      } catch (error) {
        res.writeHead(500);
        res.end(String(error));
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolveServer({ server, vite, url: `http://127.0.0.1:${port}` });
    });
  });
}

async function openMockedOperatorPage(browser, baseUrl, { width, height, modules }) {
  const context = await browser.newContext({
    viewport: { width, height },
    locale: 'tr-TR',
    timezoneId: 'Europe/Istanbul',
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  await page.clock.install({ time: new Date(FIXED_CLOCK_ISO) });

  const diagnostics = {
    pageErrors: [],
    consoleIssues: [],
    unexpectedRequests: [],
  };

  page.on('pageerror', (error) => {
    const msg = String(error?.stack ?? error);
    if (!isRunnerNoise(msg)) diagnostics.pageErrors.push(msg);
  });
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      const text = message.text();
      if (!isRunnerNoise(text)) diagnostics.consoleIssues.push(`${message.type()}: ${text}`);
    }
  });

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (method === 'GET' && url.pathname === '/api/operator/me') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ operator: OPERATOR_PROFILE }),
      });
      return;
    }

    if (method === 'GET' && url.pathname === '/api/operator/modules') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ modules }),
      });
      return;
    }

    diagnostics.unexpectedRequests.push(`${method} ${url.pathname}`);
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'UNEXPECTED_API_CALL', error: `${method} ${url.pathname}` }),
    });
  });

  await page.goto(`${baseUrl}/operator/modules`, { waitUntil: 'load' });
  await page.locator('.operator-switch').first().waitFor({ state: 'visible' });
  await page.evaluate(() => document.fonts.ready);

  return { context, page, diagnostics };
}

async function assertPageHealth(page, diagnostics, expectedModules, label) {
  assert.deepEqual(diagnostics.pageErrors, [], `${label}: pageErrors`);
  assert.deepEqual(diagnostics.consoleIssues, [], `${label}: consoleIssues`);
  assert.deepEqual(diagnostics.unexpectedRequests, [], `${label}: unexpectedRequests`);

  const metrics = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.operator-module-row')).map((row) => {
      const switchEl = row.querySelector('.operator-switch');
      const switchRect = switchEl?.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      const bodyEl = row.querySelector('.operator-module-body');
      const descEl = row.querySelector('.operator-module-description');
      const metaEl = row.querySelector('.operator-module-meta');
      return {
        labelText: row.querySelector('.operator-module-name')?.textContent ?? '',
        descriptionText: descEl?.textContent ?? '',
        metaText: metaEl?.textContent ?? '',
        ariaChecked: switchEl?.getAttribute('aria-checked') ?? '',
        switchWidth: switchRect?.width ?? 0,
        switchHeight: switchRect?.height ?? 0,
        rowWidth: rowRect.width,
        rowHeight: rowRect.height,
        bodyOverflowX: bodyEl ? bodyEl.scrollWidth > bodyEl.clientWidth + 1 : false,
        descClipped: descEl ? descEl.scrollWidth > descEl.clientWidth + 1 : false,
        metaClipped: metaEl ? metaEl.scrollWidth > metaEl.clientWidth + 1 : false,
      };
    });
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
      rows,
    };
  });

  assert.ok(
    metrics.scrollWidth <= metrics.clientWidth + 1,
    `${label}: horizontal overflow (${metrics.scrollWidth} > ${metrics.clientWidth})`,
  );
  assert.equal(metrics.rows.length, expectedModules.length, `${label}: row count`);

  expectedModules.forEach((mod, index) => {
    const row = metrics.rows[index];
    assert.equal(row.labelText, mod.label, `${label} [${mod.key}]: label`);
    assert.equal(row.descriptionText, mod.description, `${label} [${mod.key}]: description`);
    assert.ok(
      row.metaText.includes('kurulum ayarından devralındı'),
      `${label} [${mod.key}]: ENV_TAKEOVER source text`,
    );
    assert.equal(row.ariaChecked, String(mod.enabled), `${label} [${mod.key}]: aria-checked`);
    assert.ok(
      row.switchWidth >= 44 && row.switchHeight >= 44,
      `${label} [${mod.key}]: switch target below 44px (${row.switchWidth}x${row.switchHeight})`,
    );
    assert.ok(row.rowWidth > 0 && row.rowHeight > 0, `${label} [${mod.key}]: row visible`);
    assert.equal(row.bodyOverflowX, false, `${label} [${mod.key}]: body horizontal overflow`);
    assert.equal(row.descClipped, false, `${label} [${mod.key}]: description clipped`);
    assert.equal(row.metaClipped, false, `${label} [${mod.key}]: meta clipped`);
  });

  return metrics;
}

async function assertDialogContract(page, diagnostics, expectedModule, expectedHeading, expectedTitle, label) {
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor({ state: 'visible' });

  const info = await page.evaluate(() => {
    const dlg = document.querySelector('[role="dialog"]');
    const dlgRect = dlg?.getBoundingClientRect();
    const lists = Array.from(dlg?.querySelectorAll('[role="list"]') ?? []);
    const actions = dlg?.querySelector('.product-dialog-actions');
    const actionsRect = actions?.getBoundingClientRect();
    return {
      title: dlg?.querySelector('h2')?.textContent ?? '',
      text: dlg?.textContent ?? '',
      listItems: lists.map((list) => Array.from(list.querySelectorAll('[role="listitem"]')).map((item) => item.textContent ?? '')),
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      dialogWidth: dlgRect?.width ?? 0,
      dialogHeight: dlgRect?.height ?? 0,
      dialogScrollWidth: dlg?.scrollWidth ?? 0,
      dialogClientWidth: dlg?.clientWidth ?? 0,
      dialogScrollHeight: dlg?.scrollHeight ?? 0,
      dialogClientHeight: dlg?.clientHeight ?? 0,
      dialogBottom: dlgRect?.bottom ?? 0,
      actionsBottom: actionsRect?.bottom ?? 0,
    };
  });

  assert.equal(info.title, expectedTitle, `${label}: dialog title`);
  assert.ok(info.text.includes(expectedHeading), `${label}: heading ${expectedHeading}`);
  assert.ok(info.text.includes('Korunanlar:'), `${label}: heading Korunanlar:`);
  assert.ok(info.text.includes('Veriler silinmez.'), `${label}: Veriler silinmez.`);
  assert.equal(info.listItems.length, 2, `${label}: two semantic lists`);
  assert.deepEqual(info.listItems[0], expectedModule.whenDisabled, `${label}: whenDisabled list`);
  assert.deepEqual(info.listItems[1], expectedModule.preserved, `${label}: preserved list`);
  assert.ok(
    info.scrollWidth <= info.clientWidth + 1,
    `${label}: dialog horizontal overflow (${info.scrollWidth} > ${info.clientWidth})`,
  );
  assert.ok(
    info.dialogScrollWidth <= info.dialogClientWidth + 1,
    `${label}: internal dialog horizontal overflow (${info.dialogScrollWidth} > ${info.dialogClientWidth})`,
  );
  assert.deepEqual(diagnostics.pageErrors, [], `${label}: pageErrors`);
  assert.deepEqual(diagnostics.consoleIssues, [], `${label}: consoleIssues`);
  assert.deepEqual(diagnostics.unexpectedRequests, [], `${label}: unexpectedRequests`);

  return {
    viewport: `${info.viewportWidth}x${info.viewportHeight}`,
    dialogSize: `${Math.round(info.dialogWidth)}x${Math.round(info.dialogHeight)}`,
    dialogVerticalScroll: info.dialogScrollHeight > info.dialogClientHeight + 1,
    dialogScrollHeight: info.dialogScrollHeight,
    dialogClientHeight: info.dialogClientHeight,
    actionsBelowFold: info.actionsBottom > info.viewportHeight + 1,
  };
}

const captures = [];
const geometryReport = {};
const { server, vite, url } = await startServer();
let browser;

try {
  browser = await chromium.launch({ headless: true });

  // 1) 390x844 baseline + disable confirmation (OVERVIEW)
  {
    const modules = [{ ...OVERVIEW_BASE, enabled: true }];
    const { context, page, diagnostics } = await openMockedOperatorPage(browser, url, {
      width: 390,
      height: 844,
      modules,
    });
    try {
      await assertPageHealth(page, diagnostics, modules, '390-enabled');
      const basePath = resolve(outDir, 'operator-modules-390.png');
      await page.screenshot({ path: basePath, fullPage: true });
      captures.push(basePath);

      await page.getByRole('switch', { name: OVERVIEW_BASE.label }).click();
      geometryReport['390-confirm-disable'] = await assertDialogContract(
        page,
        diagnostics,
        OVERVIEW_BASE,
        'Kapanacaklar:',
        'Genel Bakış modülü kapatılsın mı?',
        '390-confirm-disable',
      );
      const confirmPath = resolve(outDir, 'operator-modules-confirm-disable-390.png');
      await page.screenshot({ path: confirmPath });
      captures.push(confirmPath);
    } finally {
      await context.close();
    }
  }

  // 2) 1440x900 baseline + disable confirmation (OVERVIEW)
  {
    const modules = [{ ...OVERVIEW_BASE, enabled: true }];
    const { context, page, diagnostics } = await openMockedOperatorPage(browser, url, {
      width: 1440,
      height: 900,
      modules,
    });
    try {
      await assertPageHealth(page, diagnostics, modules, '1440-enabled');
      const basePath = resolve(outDir, 'operator-modules-1440.png');
      await page.screenshot({ path: basePath, fullPage: true });
      captures.push(basePath);

      await page.getByRole('switch', { name: OVERVIEW_BASE.label }).click();
      geometryReport['1440-confirm-disable'] = await assertDialogContract(
        page,
        diagnostics,
        OVERVIEW_BASE,
        'Kapanacaklar:',
        'Genel Bakış modülü kapatılsın mı?',
        '1440-confirm-disable',
      );
      const confirmPath = resolve(outDir, 'operator-modules-confirm-disable-1440.png');
      await page.screenshot({ path: confirmPath });
      captures.push(confirmPath);
    } finally {
      await context.close();
    }
  }

  // 3) 1440x900 enable confirmation (OVERVIEW starting disabled)
  {
    const modules = [{ ...OVERVIEW_BASE, enabled: false }];
    const { context, page, diagnostics } = await openMockedOperatorPage(browser, url, {
      width: 1440,
      height: 900,
      modules,
    });
    try {
      await assertPageHealth(page, diagnostics, modules, '1440-disabled');
      await page.getByRole('switch', { name: OVERVIEW_BASE.label }).click();
      geometryReport['1440-confirm-enable'] = await assertDialogContract(
        page,
        diagnostics,
        OVERVIEW_BASE,
        'Açılacaklar:',
        'Genel Bakış modülü açılsın mı?',
        '1440-confirm-enable',
      );
      const confirmPath = resolve(outDir, 'operator-modules-confirm-enable-1440.png');
      await page.screenshot({ path: confirmPath });
      captures.push(confirmPath);
    } finally {
      await context.close();
    }
  }

  // 4) 390x844 two modules (OVERVIEW + MESSAGING) + MESSAGING disable confirmation
  {
    const modules = [
      { ...OVERVIEW_BASE, enabled: true },
      { ...MESSAGING_BASE, enabled: true },
    ];
    const { context, page, diagnostics } = await openMockedOperatorPage(browser, url, {
      width: 390,
      height: 844,
      modules,
    });
    try {
      geometryReport['390-two'] = await assertPageHealth(page, diagnostics, modules, '390-two');
      const twoPath = resolve(outDir, 'operator-modules-two-390.png');
      await page.screenshot({ path: twoPath, fullPage: true });
      captures.push(twoPath);

      await page.getByRole('switch', { name: MESSAGING_BASE.label }).click();
      geometryReport['390-messaging-confirm-disable'] = await assertDialogContract(
        page,
        diagnostics,
        MESSAGING_BASE,
        'Kapanacaklar:',
        'Mesajlaşma modülü kapatılsın mı?',
        '390-messaging-confirm-disable',
      );
      const confirmPath = resolve(outDir, 'operator-messaging-confirm-disable-390.png');
      await page.screenshot({ path: confirmPath });
      captures.push(confirmPath);
    } finally {
      await context.close();
    }
  }

  // 5) 1440x900 two modules (OVERVIEW + MESSAGING) + MESSAGING disable confirmation
  {
    const modules = [
      { ...OVERVIEW_BASE, enabled: true },
      { ...MESSAGING_BASE, enabled: true },
    ];
    const { context, page, diagnostics } = await openMockedOperatorPage(browser, url, {
      width: 1440,
      height: 900,
      modules,
    });
    try {
      geometryReport['1440-two'] = await assertPageHealth(page, diagnostics, modules, '1440-two');
      const twoPath = resolve(outDir, 'operator-modules-two-1440.png');
      await page.screenshot({ path: twoPath, fullPage: true });
      captures.push(twoPath);

      await page.getByRole('switch', { name: MESSAGING_BASE.label }).click();
      geometryReport['1440-messaging-confirm-disable'] = await assertDialogContract(
        page,
        diagnostics,
        MESSAGING_BASE,
        'Kapanacaklar:',
        'Mesajlaşma modülü kapatılsın mı?',
        '1440-messaging-confirm-disable',
      );
      const confirmPath = resolve(outDir, 'operator-messaging-confirm-disable-1440.png');
      await page.screenshot({ path: confirmPath });
      captures.push(confirmPath);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser?.close();
  server.close();
  await vite.close();
}

console.log(JSON.stringify({ outDir, captures, geometryReport }, null, 2));
