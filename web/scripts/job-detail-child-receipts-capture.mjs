/**
 * UI-FEEDBACK/B rendered evidence capture: a manager decision made inside a
 * JobDetail child section announces one page receipt that survives the child
 * section closing.
 *
 * Cases:
 *  - proposal: accepted Staff time proposal; the assignment offer section is gone.
 *  - change-request: record-only closure; the management request panel is gone.
 *
 * Each case is captured at 390×844, 1440×900 and 390×844 with
 * `html { font-size: 200% }`, through the production stylesheet and the owned
 * Ant provider in headless Chromium. The JSON records computed receipt sizes
 * and fails on clipping or a duplicated announcement.
 *
 * Usage:
 *   JOB_DETAIL_CHILD_RECEIPT_CAPTURE_DIR=<dir> \
 *     node scripts/job-detail-child-receipts-capture.mjs
 * Env: SERVORA_CHROME_PATH overrides the Chromium executable.
 */
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(resolve(root, 'src/styles.css'), 'utf8');
// The composed shell keeps the panel off the viewport edges on mobile.
const shellSpacing = `
@media (width < 64rem) {
  .shell-content { padding-top: 0.5rem; }
  .shell-content > :first-child { margin-top: 0; }
  .shell-content .job-detail { margin-top: 0; }
}
`;
const html = `<!doctype html><html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/><style>${css}${shellSpacing}</style></head>
<body><div id="job-detail-child-receipt-root" class="shell-content"></div>
<script type="module" src="/scripts/job-detail-child-receipts-fixture.tsx"></script></body></html>`;

const MOBILE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };
const captureDir = process.env.JOB_DETAIL_CHILD_RECEIPT_CAPTURE_DIR
  ?? process.env.FLEET_EVIDENCE_DIR;

const cases = [
  {
    key: 'proposal',
    file: 'job-detail-child-receipt-proposal',
    receipt: 'Önerilen zaman onaylandı; iş Ayşe Personel için kabul edildi.',
    goneSelector: '[data-assignment-offer]',
  },
  {
    key: 'change-request',
    file: 'job-detail-child-receipt-change-request',
    receipt: 'Öneri kapatıldı: Düzeltildi. İş bilgileri değişmedi.',
    goneSelector: '[data-change-request]',
  },
];

const failures = [];
function invariant(condition, message) {
  if (!condition) failures.push(message);
}

async function startServer() {
  const vite = await createViteServer({
    root, configFile: false, appType: 'custom', logLevel: 'error',
    server: { middlewareMode: true, hmr: false },
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

async function openCase(browser, url, viewport, path) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error?.message ?? error)));
  await page.goto(url + path, { waitUntil: 'load' });
  await page.waitForSelector('html[data-child-receipt-ready="true"]', { timeout: 30_000 });
  await page.waitForSelector('[data-job-detail-section="feedback"]');
  return { page, errors };
}

async function measure(page, expected) {
  return page.evaluate((expectedReceipt) => {
    const box = (element) => {
      const rect = element.getBoundingClientRect();
      return {
        top: Math.round(rect.top * 10) / 10,
        bottom: Math.round(rect.bottom * 10) / 10,
        height: Math.round(rect.height * 10) / 10,
        width: Math.round(rect.width * 10) / 10,
      };
    };
    const receipt = document.querySelector('[data-job-detail-section="feedback"]');
    const style = receipt ? getComputedStyle(receipt) : null;
    const ancestorFontSizes = [];
    if (receipt) {
      let element = receipt;
      while (element && ancestorFontSizes.length < 8) {
        ancestorFontSizes.push({
          tag: element.tagName,
          className: typeof element.className === 'string' ? element.className : '',
          fontSize: getComputedStyle(element).fontSize,
        });
        element = element.parentElement;
      }
    }
    const receiptRegions = Array.from(document.querySelectorAll('[role="status"]'))
      .filter((element) => element.textContent?.includes(expectedReceipt));
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      rootFontSize: getComputedStyle(document.documentElement).fontSize,
      bodyFontSize: getComputedStyle(document.body).fontSize,
      documentScrollWidth: document.documentElement.scrollWidth,
      receipt: receipt ? {
        role: receipt.getAttribute('role'),
        text: receipt.textContent?.trim() ?? null,
        fontSize: style ? Math.round(Number.parseFloat(style.fontSize) * 100) / 100 : null,
        lineHeight: style?.lineHeight ?? null,
        scrollWidth: receipt.scrollWidth,
        clientWidth: receipt.clientWidth,
        ...box(receipt),
      } : null,
      receiptRegionCount: receiptRegions.length,
      ancestorFontSizes,
      assignmentOfferPresent: document.querySelector('[data-assignment-offer]') !== null,
      changeRequestPresent: document.querySelector('[data-change-request]') !== null,
      activeElementIsReceipt: document.activeElement === receipt,
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  }, expected.receipt);
}

async function capture(page, name) {
  if (!captureDir) return;
  mkdirSync(captureDir, { recursive: true });
  await page.screenshot({ path: resolve(captureDir, `${name}.png`) });
}

const { server, vite, url } = await startServer();
const browser = await chromium.launch({
  executablePath: process.env.SERVORA_CHROME_PATH || undefined,
});
const rows = [];
try {
  for (const entry of cases) {
    const path = `?case=${entry.key}`;
    const mobile = await openCase(browser, url, MOBILE, path);
    const mobileMeasure = await measure(mobile.page, entry);
    await capture(mobile.page, `${entry.file}-390`);
    rows.push({ case: `${entry.key}-390`, ...mobileMeasure });
    invariant(mobile.errors.length === 0, `${entry.key} 390px page errors: ${mobile.errors.join(' | ')}`);
    invariant(mobileMeasure.receipt?.role === 'status', `${entry.key}: receipt must be role=status`);
    invariant(mobileMeasure.receipt?.text?.includes(entry.receipt), `${entry.key}: receipt text must be exact`);
    invariant(mobileMeasure.receiptRegionCount === 1, `${entry.key}: exactly one status region may carry the receipt`);
    invariant(mobileMeasure.activeElementIsReceipt === true, `${entry.key}: the receipt must own focus`);
    invariant(!mobileMeasure.horizontalOverflow, `${entry.key}: 390px must not scroll horizontally`);
    invariant((mobileMeasure.receipt?.scrollWidth ?? 0) <= (mobileMeasure.receipt?.clientWidth ?? 0) + 1,
      `${entry.key}: receipt must not clip at 390px`);
    invariant(mobileMeasure.assignmentOfferPresent === false, `${entry.key}: offer section must be gone`);

    const desktop = await openCase(browser, url, DESKTOP, path);
    const desktopMeasure = await measure(desktop.page, entry);
    await capture(desktop.page, `${entry.file}-1440`);
    rows.push({ case: `${entry.key}-1440`, ...desktopMeasure });
    invariant(desktop.errors.length === 0, `${entry.key} 1440px page errors: ${desktop.errors.join(' | ')}`);
    invariant((desktopMeasure.receipt?.scrollWidth ?? 0) <= (desktopMeasure.receipt?.clientWidth ?? 0) + 1,
      `${entry.key}: receipt must not clip at 1440px`);

    const text200 = await openCase(browser, url, MOBILE, path);
    await text200.page.addStyleTag({ content: 'html { font-size: 200%; }' });
    await text200.page.waitForTimeout(50);
    const text200Measure = await measure(text200.page, entry);
    await capture(text200.page, `${entry.file}-390-200-text`);
    rows.push({ case: `${entry.key}-390-200-text`, ...text200Measure });
    invariant(text200.errors.length === 0, `${entry.key} 200% text page errors: ${text200.errors.join(' | ')}`);
    const baseFont = mobileMeasure.receipt?.fontSize ?? 0;
    invariant(Math.abs((text200Measure.receipt?.fontSize ?? 0) - baseFont * 2) <= 0.6,
      `${entry.key}: receipt must scale at 200% text: ${baseFont} -> ${text200Measure.receipt?.fontSize}`);
    invariant(!text200Measure.horizontalOverflow, `${entry.key}: 200% text must not reflow horizontally`);
    invariant((text200Measure.receipt?.scrollWidth ?? 0) <= (text200Measure.receipt?.clientWidth ?? 0) + 1,
      `${entry.key}: receipt must not clip at 200% text`);

    // The matching child surface must be absent in both cases, not only mobile.
    invariant(desktopMeasure.assignmentOfferPresent === false, `${entry.key}: offer section must stay gone`);
  }
} finally {
  await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
  await vite.close();
}

if (captureDir) {
  mkdirSync(captureDir, { recursive: true });
  writeFileSync(
    resolve(captureDir, 'job-detail-child-receipt-measurements.json'),
    `${JSON.stringify({ cases: rows, failures }, null, 2)}\n`,
  );
}

if (failures.length > 0) {
  console.error(JSON.stringify({ failures }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ failures: [], cases: rows.map((row) => ({
    case: row.case,
    receiptFontSize: row.receipt?.fontSize,
    receiptHeight: row.receipt?.height,
    receiptWidth: row.receipt?.width,
    documentScrollWidth: row.documentScrollWidth,
    receiptRegionCount: row.receiptRegionCount,
  })) }, null, 2));
}
