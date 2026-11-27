/**
 * RESCUE-002 rendered capture (UI-003): the Staff decline form gets a
 * mandatory typed suggested solution, and the management panel presents it.
 *
 * Renders the real `JobWorkflowDialog` / `AssignmentReasonSection` and the real
 * `AssignmentOfferSection` through `web/scripts/rescue-002-assignment-suggestion-fixture.tsx`
 * with the production stylesheet and deterministic local state. No API calls.
 *
 * Outputs `<screen>-<width>.png` into `$FLEET_EVIDENCE_DIR` (or
 * `web/.ui-evidence/rescue-002-assignment-suggestion` as fallback), plus a
 * `capture-summary.json` with the assertions and viewport metrics.
 *
 * Usage: node scripts/rescue-002-assignment-suggestion-capture.mjs
 * Env: SERVORA_CHROME_PATH overrides the Chromium executable.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(
  process.env.FLEET_EVIDENCE_DIR || resolve(root, '.ui-evidence/rescue-002-assignment-suggestion'),
);
mkdirSync(outDir, { recursive: true });

const css = readFileSync(resolve(root, 'src/styles.css'), 'utf8');
const html = `<!doctype html><html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>RESCUE-002 capture</title><style>${css}</style></head>
<body><div id="rescue-002-root"></div>
<script type="module" src="/scripts/rescue-002-assignment-suggestion-fixture.tsx"></script>
</body></html>`;

const CASES = [
  { screen: 'staff-decline-empty', case: 'staff-empty', page: 'staff' },
  { screen: 'staff-decline-reschedule', case: 'staff-reschedule', page: 'staff' },
  { screen: 'staff-decline-error', case: 'staff-error', page: 'staff' },
  { screen: 'manager-panel', case: 'manager', page: 'manager' },
];
const FIXED_CLOCK_ISO = '2026-11-26T11:00:00.000Z';

async function startServer() {
  const vite = await createViteServer({
    root,
    configFile: false,
    appType: 'custom',
    logLevel: 'error',
    plugins: [react()],
    server: { middlewareMode: true, hmr: false },
  });
  return new Promise((resolveServer) => {
    const server = createServer(async (request, response) => {
      try {
        const pathOnly = (request.url ?? '/').split('?')[0];
        if (pathOnly === '/') {
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          response.end(html);
          return;
        }
        vite.middlewares(request, response, () => {
          response.writeHead(404);
          response.end();
        });
      } catch (error) {
        response.writeHead(500);
        response.end(String(error));
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolveServer({ server, vite, url: `http://127.0.0.1:${address.port}/` });
    });
  });
}

async function inspect(page, captureCase) {
  return page.evaluate(({ captureCase }) => {
    const dialog = document.querySelector('[role="dialog"]');
    const recovery = document.querySelectorAll('[data-assignment-offer-recovery]');
    const labels = Array.from(document.querySelectorAll('input[name="assignment-suggested-solution"]'))
      .map((input) => input.closest('label')?.textContent?.trim() ?? '');
    return {
      case: captureCase,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      documentScrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      dialogCount: document.querySelectorAll('[role="dialog"]').length,
      dialogScrollHeight: dialog?.scrollHeight ?? null,
      dialogClientHeight: dialog?.clientHeight ?? null,
      requestCount: performance.getEntriesByType('resource')
        .filter((entry) => entry.name.includes('/api/')).length,
      suggestionLabels: labels,
      timeFieldVisible: document.querySelector('#assignment-proposed-at') !== null,
      suggestionError: document.querySelector('#assignment-suggested-solution-error')?.textContent ?? null,
      managerSuggestionText: Array.from(document.querySelectorAll('[data-assignment-offer-suggested-solution]'))
        .map((node) => node.textContent?.trim() ?? ''),
      proposalConfirmButtons: Array.from(document.querySelectorAll('[data-assignment-offer-action="accept-proposal"]'))
        .map((node) => node.textContent?.trim() ?? ''),
      recoveryCount: recovery.length,
    };
  }, { captureCase });
}

const captures = [];
const summary = [];
const { server, vite, url } = await startServer();
const launchOptions = { headless: true };
if (process.env.SERVORA_CHROME_PATH) {
  launchOptions.executablePath = process.env.SERVORA_CHROME_PATH;
}

let browser;
let browserVersion = null;
try {
  browser = await chromium.launch(launchOptions);
  browserVersion = browser.version();

  for (const width of [390, 1440]) {
    for (const captureCase of CASES) {
      const context = await browser.newContext({
        viewport: { width, height: 1300 },
        locale: 'tr-TR',
        timezoneId: 'Europe/Istanbul',
        reducedMotion: 'reduce',
      });
      try {
        const page = await context.newPage();
        const pageErrors = [];
        const consoleIssues = [];
        page.on('pageerror', (error) => {
          pageErrors.push(String(error?.stack ?? error));
          console.error(`${captureCase.screen}-${width}: pageerror`, error);
        });
        page.on('console', (message) => {
          if (message.type() === 'error' || message.type() === 'warning') {
            consoleIssues.push(`${message.type()}: ${message.text()}`);
            console.error(`${captureCase.screen}-${width}: console`, message.text());
          }
        });

        await page.clock.install({ time: new Date(FIXED_CLOCK_ISO) });
        await page.goto(`${url}?case=${captureCase.case}`, { waitUntil: 'load' });
        await page.waitForSelector('html[data-rescue-002-ready="true"]', { timeout: 30_000 });
        await page.evaluate(() => document.fonts.ready);
        if (captureCase.page === 'staff') {
          await page.locator('[role="dialog"]').waitFor({ state: 'visible' });
        } else {
          await page.locator('[data-assignment-offer-recovery]').first().waitFor({ state: 'visible' });
        }

        const metrics = await inspect(page, captureCase.case);
        assert.deepEqual(pageErrors, [], `${captureCase.screen}-${width}: pageErrors`);
        assert.deepEqual(consoleIssues, [], `${captureCase.screen}-${width}: consoleIssues`);
        assert.equal(metrics.requestCount, 0, `${captureCase.screen}-${width}: fixture must not call the API`);
        assert.ok(
          metrics.documentScrollWidth <= metrics.clientWidth + 1,
          `${captureCase.screen}-${width}: horizontal overflow`,
        );

        if (captureCase.page === 'staff') {
          assert.equal(metrics.dialogCount, 1, `${captureCase.screen}-${width}: single dialog`);
          assert.deepEqual(metrics.suggestionLabels, [
            'Başka bir zamanda kendim yapabilirim',
            'Başka bir personele verilsin',
            'İş bilgileri düzeltilsin',
            'İptal edilmesini öneriyorum',
            'Yönetici karar versin',
          ], `${captureCase.screen}-${width}: five suggestions`);
          if (captureCase.case === 'staff-reschedule') {
            assert.equal(metrics.timeFieldVisible, true, `${captureCase.screen}-${width}: time field visible`);
          }
          if (captureCase.case === 'staff-error') {
            assert.equal(
              metrics.suggestionError,
              'Çözüm önerisi zorunludur.',
              `${captureCase.screen}-${width}: validation error`,
            );
          }
        } else {
          assert.equal(metrics.recoveryCount, 2, `${captureCase.screen}-${width}: two manager cards`);
          assert.ok(
            metrics.managerSuggestionText.includes('Personelin önerisi: Başka bir personele verilsin'),
            `${captureCase.screen}-${width}: reassign suggestion`,
          );
          assert.ok(
            metrics.managerSuggestionText.includes('Personelin önerisi: Başka bir zamanda kendim yapabilirim'),
            `${captureCase.screen}-${width}: reschedule suggestion`,
          );
          assert.ok(
            metrics.proposalConfirmButtons.includes('Önerilen zamanı onayla'),
            `${captureCase.screen}-${width}: proposal confirmation`,
          );
        }

        const path = resolve(outDir, `${captureCase.screen}-${width}.png`);
        await page.screenshot({ path, fullPage: captureCase.page === 'manager' });
        captures.push(path);
        summary.push({ path, width, ...metrics });
        await context.close();
      } catch (error) {
        await context.close();
        throw error;
      }
    }
  }
} finally {
  await browser?.close();
  server.close();
  await vite.close();
}

const summaryPath = resolve(outDir, 'capture-summary.json');
writeFileSync(summaryPath, `${JSON.stringify({
  outDir,
  command: 'node scripts/rescue-002-assignment-suggestion-capture.mjs',
  capturedAt: new Date().toISOString(),
  fixedClock: FIXED_CLOCK_ISO,
  locale: 'tr-TR',
  timezone: 'Europe/Istanbul',
  browserVersion,
  captures,
  summary,
}, null, 2)}\n`);
console.log(JSON.stringify({ outDir, captures, summary }, null, 2));
