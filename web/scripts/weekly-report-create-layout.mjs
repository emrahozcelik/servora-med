/**
 * Weekly Report manager create screen visual/layout capture and assertion script.
 *
 * Renders the REAL `WeeklyReportCreateScreen` (via
 * `scripts/weekly-report-create-fixture.tsx`) in headless Chromium at 390x844
 * and 1440x900 (plus a 200% text-zoom reflow probe on 390x844) and verifies
 * WR-WEEK §5 scenarios A12-A14 and A21:
 *   (a) Friday 2026-11-20 reference, "Bu hafta" preselected
 *   (b) Tuesday 2026-11-24 reference, "Geçen hafta" selected (today deadline, no overdue warning)
 *   (c) Single-staff `existing` outcome notice without navigation
 *   (d) Bulk result with separate `created` and `existing` counts
 *
 * Usage: node scripts/weekly-report-create-layout.mjs
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const css = readFileSync(resolve(root, 'src/styles.css'), 'utf8');
const captureDir = process.env.WEEKLY_CREATE_CAPTURE_DIR || tmpdir();

const fixtureHtml = `<!doctype html>
<html lang="tr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>${css}</style>
  </head>
  <body>
    <div id="weekly-create-root"></div>
    <script type="module" src="/fixture.js"></script>
  </body>
</html>`;

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const viewports = [
  { name: '390x844', width: 390, height: 844 },
  { name: '1440x900', width: 1440, height: 900 },
];

async function bundleFixture() {
  const outDir = await mkdtemp(join(tmpdir(), 'servora-weekly-create-bundle-'));
  await build({
    root,
    configFile: false,
    logLevel: 'error',
    build: {
      outDir,
      emptyOutDir: false,
      minify: false,
      target: 'es2022',
      rollupOptions: {
        input: resolve(root, 'scripts/weekly-report-create-fixture.tsx'),
        output: {
          format: 'es',
          codeSplitting: false,
          entryFileNames: 'fixture.js',
          chunkFileNames: 'fixture-[name].js',
          assetFileNames: 'fixture.[ext]',
        },
      },
    },
  });
  return outDir;
}

async function existingFile(directory, pathname) {
  const filePath = resolve(directory, `.${pathname}`);
  if (!filePath.startsWith(`${directory}/`)) return null;
  try {
    const fileStats = await stat(filePath);
    return fileStats.isFile() ? filePath : null;
  } catch {
    return null;
  }
}

async function startServer(outDir) {
  const server = createServer(async (request, response) => {
    const pathname = decodeURIComponent(
      new URL(request.url ?? '/', 'http://127.0.0.1').pathname,
    );
    if (pathname.includes('\0') || pathname.split('/').includes('..')) {
      response.writeHead(400).end();
      return;
    }

    const filePath = pathname === '/' ? null : await existingFile(outDir, pathname);
    if (!filePath) {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(fixtureHtml);
      return;
    }

    const body = await readFile(filePath);
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': contentTypes[extname(filePath)] ?? 'application/octet-stream',
      'Content-Length': body.byteLength,
    });
    response.end(body);
  });

  await new Promise((resolveServer, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveServer);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Weekly report create layout server failed to bind.');
  }
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

function attachDiagnostics(page, diagnostics) {
  page.on('pageerror', (error) => diagnostics.pageErrors.push(String(error?.stack ?? error)));
  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.consoleErrors.push(message.text());
  });
  page.on('requestfailed', (request) => {
    diagnostics.requestFailures.push(`${request.url()} — ${request.failure()?.errorText ?? 'failed'}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) diagnostics.badResponses.push(`${response.status()} ${response.url()}`);
  });
}

async function assertNoOverflow(page, label) {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }));
  assert.ok(
    metrics.scrollWidth <= metrics.clientWidth + 1 && metrics.bodyScrollWidth <= metrics.clientWidth + 1,
    `${label}: horizontal overflow detected (${JSON.stringify(metrics)})`,
  );
}

async function openReadyPage(browser, baseUrl, viewport, query, fixedTime) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    locale: 'tr-TR',
    timezoneId: 'Europe/Istanbul',
    reducedMotion: 'reduce',
    hasTouch: viewport.width < 768,
  });
  const page = await context.newPage();
  const diagnostics = { pageErrors: [], consoleErrors: [], requestFailures: [], badResponses: [] };
  attachDiagnostics(page, diagnostics);
  await page.clock.setFixedTime(new Date(fixedTime));
  await page.goto(`${baseUrl}${query}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('html[data-weekly-create-ready="true"]');
  await page.waitForSelector('#weekly-period-preview');
  await page.waitForSelector('#weekly-select-all-staff:not([disabled])');
  await page.evaluate(() => document.fonts.ready);
  return { context, page, diagnostics };
}

function assertCleanDiagnostics(diagnostics, page, label) {
  assert.deepEqual(diagnostics.pageErrors, [], `${label}: page errors`);
  assert.deepEqual(diagnostics.consoleErrors, [], `${label}: console errors`);
  assert.deepEqual(diagnostics.requestFailures, [], `${label}: request failures`);
  assert.deepEqual(diagnostics.badResponses, [], `${label}: bad responses`);
  return page.evaluate(() => window.weeklyCreateUnexpected ?? []).then((unexpected) => {
    assert.deepEqual(unexpected, [], `${label}: unexpected API requests`);
  });
}

const scenarios = [
  {
    id: 'friday-this-week',
    query: '?ref=friday',
    fixedTime: '2026-11-20T10:00:00+03:00',
    run: async (page, label) => {
      const checkedValue = await page.locator('input[name="weeklyPeriodChoice"]:checked').inputValue();
      assert.equal(checkedValue, 'this_week', `${label}: expected "this_week" preselected`);
      const preview = (await page.locator('#weekly-period-preview').textContent())?.trim();
      assert.equal(preview, 'Dönem 16–21 Kasım 2026 · Son teslim 23 Kasım Pazartesi', `${label}: preview`);
      const checkboxCount = await page.locator('input[type="checkbox"]').count();
      assert.equal(checkboxCount, 0, `${label}: expected no preset checkboxes`);
    },
  },
  {
    id: 'tuesday-last-week',
    query: '?ref=tuesday',
    fixedTime: '2026-11-24T10:00:00+03:00',
    run: async (page, label) => {
      const lastWeekRadio = page.locator('input[name="weeklyPeriodChoice"][value="last_week"]');
      await lastWeekRadio.check();
      const preview = (await page.locator('#weekly-period-preview').textContent())?.trim();
      assert.equal(preview, 'Dönem 16–21 Kasım 2026 · Son teslim 24 Kasım Salı', `${label}: preview`);
      const bodyText = (await page.locator('main.task-create').textContent()) ?? '';
      assert.equal(/gecik/i.test(bodyText), false, `${label}: unexpected overdue warning`);
      assert.equal(await page.locator('.form-error').count(), 0, `${label}: unexpected error banner`);
    },
  },
  {
    id: 'single-existing',
    query: '?ref=friday&initialStaff=1',
    fixedTime: '2026-11-20T10:00:00+03:00',
    run: async (page, label) => {
      await page.getByRole('button', { name: 'Rapor isteklerini oluştur', exact: true }).click();
      const notice = page.locator('#weekly-existing-notice');
      await notice.waitFor();
      const noticeText = ((await notice.textContent()) ?? '').replace(/\s+/g, ' ').trim();
      assert.ok(
        noticeText.includes('Bu personelin bu hafta için raporu zaten var.'),
        `${label}: missing existing message (${noticeText})`,
      );
      assert.ok(
        noticeText.includes('Mevcut rapora git'),
        `${label}: missing link (${noticeText})`,
      );
      assert.ok(
        noticeText.includes('İptal edilmiş bir rapor varsa, yalnızca bir Admin kaldırdıktan sonra yerine yeni rapor oluşturulabilir.'),
        `${label}: missing cancelled replacement hint (${noticeText})`,
      );
      const linkRect = await notice.locator('a.weekly-existing-notice-link').boundingBox();
      assert.ok(
        linkRect && linkRect.height >= 44,
        `${label}: "Mevcut rapora git" touch target below 44px (${JSON.stringify(linkRect)})`,
      );
      const navigated = await page.evaluate(() => window.weeklyCreateNavigated ?? null);
      assert.equal(navigated, null, `${label}: must not navigate on existing outcome`);
    },
  },
  {
    id: 'bulk-mixed',
    query: '?ref=friday',
    fixedTime: '2026-11-20T10:00:00+03:00',
    run: async (page, label) => {
      await page.locator('#weekly-select-all-staff').click();
      const countText = ((await page.locator('#weekly-assignee-count').textContent()) ?? '').trim();
      assert.equal(countText, '3 personel seçildi', `${label}: selection count`);
      await page.getByRole('button', { name: 'Rapor isteklerini oluştur', exact: true }).click();
      await page.locator('#weekly-bulk-result-title').waitFor();
      const titleText = ((await page.locator('#weekly-bulk-result-title').textContent()) ?? '').trim();
      assert.equal(titleText, '3 haftalık rapor isteği işlendi', `${label}: bulk title`);
      const createdText = ((await page.locator('#weekly-bulk-created').textContent()) ?? '').trim();
      const existingText = ((await page.locator('#weekly-bulk-existing').textContent()) ?? '').trim();
      assert.equal(createdText, '2 oluşturuldu', `${label}: created count`);
      assert.equal(existingText, '1 zaten mevcuttu', `${label}: existing count`);
      const sectionText = ((await page.locator('main.task-create').textContent()) ?? '').replace(/\s+/g, ' ').trim();
      assert.ok(
        sectionText.includes('2 yeni rapor oluşturuldu, 1 personel için mevcut rapor korundu.'),
        `${label}: summary sentence (${sectionText})`,
      );
      const rows = page.locator('#weekly-bulk-result-items li.weekly-bulk-result-row');
      assert.equal(await rows.count(), 3, `${label}: result rows`);
      const listMetrics = await page.evaluate(() => {
        const list = document.querySelector('#weekly-bulk-result-items');
        const link = document.querySelector('#weekly-bulk-result-items a.weekly-bulk-result-link');
        const linkBox = link ? link.getBoundingClientRect() : null;
        return {
          listStyleType: list ? getComputedStyle(list).listStyleType : null,
          createdCount: document.querySelectorAll('.bulk-result-outcome--created').length,
          existingCount: document.querySelectorAll('.bulk-result-outcome--existing').length,
          linkHeight: linkBox ? linkBox.height : 0,
        };
      });
      assert.equal(listMetrics.listStyleType, 'none', `${label}: bulk list still shows bullets`);
      assert.equal(listMetrics.createdCount, 2, `${label}: created badge count`);
      assert.equal(listMetrics.existingCount, 1, `${label}: existing badge count`);
      assert.ok(listMetrics.linkHeight >= 44, `${label}: "Raporu aç" link height ${listMetrics.linkHeight} < 44`);
    },
  },
];

let bundleDirectory;
let server;
let browser;

try {
  await mkdir(captureDir, { recursive: true });
  bundleDirectory = await bundleFixture();
  const started = await startServer(bundleDirectory);
  server = started.server;
  browser = await chromium.launch({ headless: true });

  const captured = [];

  for (const viewport of viewports) {
    for (const scenario of scenarios) {
      const label = `${scenario.id} @ ${viewport.name}`;
      const { context, page, diagnostics } = await openReadyPage(
        browser, started.url, viewport, scenario.query, scenario.fixedTime,
      );
      try {
        await scenario.run(page, label);
        await assertNoOverflow(page, label);

        const outPath = join(captureDir, `servora-weekly-create-${scenario.id}-${viewport.name}.png`);
        await page.screenshot({ path: outPath, fullPage: true });

        let zoomOverflowX = null;
        if (viewport.width === 390 && scenario.id === 'friday-this-week') {
          await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
          zoomOverflowX = await page.evaluate(
            () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          );
          assert.equal(zoomOverflowX, false, `${label} 200%: horizontal overflow`);
          const zoomPath = join(captureDir, `servora-weekly-create-${scenario.id}-${viewport.name}-200pct.png`);
          await page.screenshot({ path: zoomPath, fullPage: true });
          captured.push(zoomPath);
        }

        await assertCleanDiagnostics(diagnostics, page, label);
        captured.push(outPath);
        console.log(JSON.stringify({
          case: label,
          overflowX: false,
          zoom200OverflowX: zoomOverflowX,
          screenshot: outPath,
        }));
      } finally {
        await context.close();
      }
    }
  }

  console.log(JSON.stringify({
    result: 'PASS',
    browser: browser.version(),
    captureDir,
    screenshots: captured,
  }));
} finally {
  await browser?.close();
  if (server) await new Promise((resolveServer) => server.close(resolveServer));
  if (bundleDirectory) await rm(bundleDirectory, { recursive: true, force: true }).catch(() => {});
}
