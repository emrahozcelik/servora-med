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

async function openMockedOperatorPage(browser, baseUrl, { width, height, enabled }) {
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
        body: JSON.stringify({
          modules: [{ ...OVERVIEW_BASE, enabled }],
        }),
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
  await page.locator('.operator-switch').waitFor({ state: 'visible' });
  await page.evaluate(() => document.fonts.ready);

  return { context, page, diagnostics };
}

async function assertPageHealth(page, diagnostics, label) {
  assert.deepEqual(diagnostics.pageErrors, [], `${label}: pageErrors`);
  assert.deepEqual(diagnostics.consoleIssues, [], `${label}: consoleIssues`);
  assert.deepEqual(diagnostics.unexpectedRequests, [], `${label}: unexpectedRequests`);

  const metrics = await page.evaluate(() => {
    const switchEl = document.querySelector('.operator-switch');
    const switchRect = switchEl?.getBoundingClientRect();
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      switchWidth: switchRect?.width ?? 0,
      switchHeight: switchRect?.height ?? 0,
      descriptionText: document.querySelector('.operator-module-description')?.textContent ?? '',
      metaText: document.querySelector('.operator-module-meta')?.textContent ?? '',
    };
  });

  assert.ok(
    metrics.scrollWidth <= metrics.clientWidth + 1,
    `${label}: horizontal overflow (${metrics.scrollWidth} > ${metrics.clientWidth})`,
  );
  assert.ok(
    metrics.switchWidth >= 44 && metrics.switchHeight >= 44,
    `${label}: switch target below 44px (${metrics.switchWidth}x${metrics.switchHeight})`,
  );
  assert.equal(metrics.descriptionText, OVERVIEW_BASE.description, `${label}: module description`);
  assert.ok(
    metrics.metaText.includes('kurulum ayarından devralındı'),
    `${label}: ENV_TAKEOVER source text`,
  );
}

async function assertDialogContract(page, diagnostics, expectedHeading, expectedTitle, label) {
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor({ state: 'visible' });

  const info = await page.evaluate(() => {
    const dlg = document.querySelector('[role="dialog"]');
    const lists = Array.from(dlg?.querySelectorAll('[role="list"]') ?? []);
    return {
      title: dlg?.querySelector('h2')?.textContent ?? '',
      text: dlg?.textContent ?? '',
      listItems: lists.map((list) => Array.from(list.querySelectorAll('[role="listitem"]')).map((item) => item.textContent ?? '')),
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    };
  });

  assert.equal(info.title, expectedTitle, `${label}: dialog title`);
  assert.ok(info.text.includes(expectedHeading), `${label}: heading ${expectedHeading}`);
  assert.ok(info.text.includes('Korunanlar:'), `${label}: heading Korunanlar:`);
  assert.ok(info.text.includes('Veriler silinmez.'), `${label}: Veriler silinmez.`);
  assert.equal(info.listItems.length, 2, `${label}: two semantic lists`);
  assert.deepEqual(info.listItems[0], OVERVIEW_BASE.whenDisabled, `${label}: whenDisabled list`);
  assert.deepEqual(info.listItems[1], OVERVIEW_BASE.preserved, `${label}: preserved list`);
  assert.ok(
    info.scrollWidth <= info.clientWidth + 1,
    `${label}: dialog horizontal overflow (${info.scrollWidth} > ${info.clientWidth})`,
  );
  assert.deepEqual(diagnostics.pageErrors, [], `${label}: pageErrors`);
  assert.deepEqual(diagnostics.consoleIssues, [], `${label}: consoleIssues`);
  assert.deepEqual(diagnostics.unexpectedRequests, [], `${label}: unexpectedRequests`);
}

const captures = [];
const { server, vite, url } = await startServer();
let browser;

try {
  browser = await chromium.launch({ headless: true });

  // 1) 390x844 baseline + disable confirmation
  {
    const { context, page, diagnostics } = await openMockedOperatorPage(browser, url, {
      width: 390,
      height: 844,
      enabled: true,
    });
    try {
      await assertPageHealth(page, diagnostics, '390-enabled');
      const basePath = resolve(outDir, 'operator-modules-390.png');
      await page.screenshot({ path: basePath, fullPage: true });
      captures.push(basePath);

      await page.locator('.operator-switch').click();
      await assertDialogContract(
        page,
        diagnostics,
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

  // 2) 1440x900 baseline + disable confirmation
  {
    const { context, page, diagnostics } = await openMockedOperatorPage(browser, url, {
      width: 1440,
      height: 900,
      enabled: true,
    });
    try {
      await assertPageHealth(page, diagnostics, '1440-enabled');
      const basePath = resolve(outDir, 'operator-modules-1440.png');
      await page.screenshot({ path: basePath, fullPage: true });
      captures.push(basePath);

      await page.locator('.operator-switch').click();
      await assertDialogContract(
        page,
        diagnostics,
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

  // 3) 1440x900 enable confirmation (starting disabled)
  {
    const { context, page, diagnostics } = await openMockedOperatorPage(browser, url, {
      width: 1440,
      height: 900,
      enabled: false,
    });
    try {
      await assertPageHealth(page, diagnostics, '1440-disabled');
      await page.locator('.operator-switch').click();
      await assertDialogContract(
        page,
        diagnostics,
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
} finally {
  await browser?.close();
  server.close();
  await vite.close();
}

console.log(JSON.stringify({ outDir, captures }, null, 2));
