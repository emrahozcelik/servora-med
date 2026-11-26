/**
 * UI-FEEDBACK/A rendered evidence capture: committed mutation whose canonical
 * re-read failed.
 *
 * Renders the real JobDetailPanel + CommittedStaleNotice through the production
 * stylesheet and the owned Ant provider in headless Chromium, then captures:
 *  - 390×844 mobile baseline,
 *  - 1440×900 desktop,
 *  - 320×800 reflow probe,
 *  - 390×844 with `html { font-size: 200% }`.
 *
 * It records computed heading/help/button font sizes and asserts that heading
 * and button text scale with 200% text enlargement, that the 44px-class action
 * grows instead of clipping, and that the notice itself never overflows.
 *
 * Usage:
 *   JOB_DETAIL_COMMITTED_REFRESH_CAPTURE_DIR=<dir> \
 *     node scripts/job-detail-committed-refresh-capture.mjs
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
<body><div id="job-detail-committed-refresh-root" class="shell-content"></div>
<script type="module" src="/scripts/job-detail-committed-refresh-fixture.tsx"></script></body></html>`;

const MOBILE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };
const REFLOW = { width: 320, height: 800 };
const captureDir = process.env.JOB_DETAIL_COMMITTED_REFRESH_CAPTURE_DIR
  ?? process.env.FLEET_EVIDENCE_DIR;

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

async function openCase(browser, url, viewport, options = {}) {
  const page = await browser.newPage({ viewport });
  if (options.reducedMotion) await page.emulateMedia({ reducedMotion: options.reducedMotion });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error?.message ?? error)));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForSelector('html[data-committed-refresh-ready="true"]', { timeout: 30_000 });
  await page.waitForSelector('[data-job-detail-committed-refresh="true"]');
  return { page, errors };
}

async function measure(page) {
  return page.evaluate(() => {
    const box = (element) => {
      const rect = element.getBoundingClientRect();
      return {
        top: Math.round(rect.top * 10) / 10,
        bottom: Math.round(rect.bottom * 10) / 10,
        height: Math.round(rect.height * 10) / 10,
        width: Math.round(rect.width * 10) / 10,
      };
    };
    const type = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const style = getComputedStyle(element);
      return {
        text: element.textContent?.trim() ?? null,
        fontSize: Math.round(Number.parseFloat(style.fontSize) * 100) / 100,
        lineHeight: style.lineHeight,
        color: style.color,
        ...box(element),
      };
    };
    // P3: the notice must render without depending on motion. Record the
    // computed shorthand and its longhands so reduced-motion evidence can prove
    // that no transition/animation is carrying the message.
    const motion = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const style = getComputedStyle(element);
      return {
        transition: style.transition,
        transitionProperty: style.transitionProperty,
        transitionDuration: style.transitionDuration,
        animation: style.animation,
        animationName: style.animationName,
        animationDuration: style.animationDuration,
      };
    };
    const notice = document.querySelector('[data-job-detail-committed-refresh="true"]');
    const button = notice?.querySelector('button') ?? null;
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      documentScrollWidth: document.documentElement.scrollWidth,
      notice: notice ? {
        role: notice.getAttribute('role'),
        text: notice.textContent?.trim() ?? null,
        scrollWidth: notice.scrollWidth,
        clientWidth: notice.clientWidth,
        ...box(notice),
      } : null,
      heading: type('.detail-feedback-stale-heading'),
      help: type('.detail-feedback-stale-help'),
      button: type('.detail-feedback-stale > button'),
      buttonLabel: button?.textContent?.trim() ?? null,
      noticeMotion: motion('[data-job-detail-committed-refresh="true"]'),
      buttonMotion: motion('.detail-feedback-stale > button'),
    };
  });
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
  const mobile = await openCase(browser, url, MOBILE);
  const mobileMeasure = await measure(mobile.page);
  await capture(mobile.page, 'job-detail-committed-refresh-390');
  rows.push({ case: 'mobile-390', ...mobileMeasure });
  invariant(mobile.errors.length === 0, `mobile page errors: ${mobile.errors.join(' | ')}`);
  invariant(mobileMeasure.notice?.role === 'status', 'notice must be one role=status region');
  invariant(mobileMeasure.notice?.text?.includes('Planlanan zaman güncellendi.'), 'heading must name the committed action');
  invariant(mobileMeasure.notice?.text?.includes('Güncel kayıt henüz yüklenemedi.'), 'heading must state the failed read');
  invariant(mobileMeasure.notice?.text?.includes('Gösterilen bilgiler eski olabilir'), 'help text must explain staleness');
  invariant(mobileMeasure.buttonLabel === 'Güncel durumu yenile', 'retry label must be the serialized reload action');
  invariant((mobileMeasure.button?.height ?? 0) >= 44, `retry target must be >= 44px, got ${mobileMeasure.button?.height}`);
  invariant((mobileMeasure.notice?.scrollWidth ?? 0) <= (mobileMeasure.notice?.clientWidth ?? 0) + 1,
    'notice must not overflow its own box at 390px');

  const desktop = await openCase(browser, url, DESKTOP);
  const desktopMeasure = await measure(desktop.page);
  await capture(desktop.page, 'job-detail-committed-refresh-1440');
  rows.push({ case: 'desktop-1440', ...desktopMeasure });
  invariant(desktop.errors.length === 0, `desktop page errors: ${desktop.errors.join(' | ')}`);
  invariant((desktopMeasure.notice?.width ?? 0) <= 768, `desktop notice should stay at its rem max width, got ${desktopMeasure.notice?.width}`);

  const reflow = await openCase(browser, url, REFLOW);
  const reflowMeasure = await measure(reflow.page);
  await capture(reflow.page, 'job-detail-committed-refresh-320');
  rows.push({ case: 'reflow-320', ...reflowMeasure });
  invariant(reflow.errors.length === 0, `320px page errors: ${reflow.errors.join(' | ')}`);
  invariant((reflowMeasure.documentScrollWidth ?? 0) <= REFLOW.width + 1,
    `320px reflow must not scroll horizontally, scrollWidth=${reflowMeasure.documentScrollWidth}`);

  const text200 = await openCase(browser, url, MOBILE);
  await text200.page.addStyleTag({ content: 'html { font-size: 200%; }' });
  await text200.page.waitForTimeout(50);
  const text200Measure = await measure(text200.page);
  // The measured box proves scaling; the screenshot scrolls the whole notice
  // (including its action) into the viewport so the visible result is reviewed.
  await text200.page.locator('[data-job-detail-committed-refresh="true"]').scrollIntoViewIfNeeded();
  await capture(text200.page, 'job-detail-committed-refresh-390-200-text');
  if (captureDir) {
    mkdirSync(captureDir, { recursive: true });
    await text200.page.screenshot({
      path: resolve(captureDir, 'job-detail-committed-refresh-390-200-text-full.png'),
      fullPage: true,
    });
  }
  rows.push({ case: 'text-200-390', ...text200Measure });
  invariant(text200.errors.length === 0, `200% text page errors: ${text200.errors.join(' | ')}`);
  const headingBase = mobileMeasure.heading?.fontSize ?? 0;
  const buttonBase = mobileMeasure.button?.fontSize ?? 0;
  invariant(Math.abs((text200Measure.heading?.fontSize ?? 0) - headingBase * 2) <= 0.6,
    `heading must scale at 200% text: ${headingBase} -> ${text200Measure.heading?.fontSize}`);
  invariant(Math.abs((text200Measure.button?.fontSize ?? 0) - buttonBase * 2) <= 0.6,
    `button must scale at 200% text: ${buttonBase} -> ${text200Measure.button?.fontSize}`);
  invariant((text200Measure.button?.height ?? 0) >= 88,
    `200% retry target must grow past 88px, got ${text200Measure.button?.height}`);
  invariant((text200Measure.notice?.scrollWidth ?? 0) <= (text200Measure.notice?.clientWidth ?? 0) + 1,
    'notice must not clip at 200% text');

  // P3: `prefers-reduced-motion: reduce` must not change or hide the result:
  // the copy, the action and its 44px target stay rendered, and the notice and
  // button carry no motion of their own.
  const reduced = await openCase(browser, url, MOBILE, { reducedMotion: 'reduce' });
  const reducedMeasure = await measure(reduced.page);
  await capture(reduced.page, 'job-detail-committed-refresh-390-reduced-motion');
  rows.push({ case: 'reduced-motion-390', ...reducedMeasure });
  invariant(reduced.errors.length === 0, `reduced-motion page errors: ${reduced.errors.join(' | ')}`);
  invariant(reducedMeasure.notice?.text?.includes('Planlanan zaman güncellendi.'),
    'reduced-motion notice must keep the committed receipt');
  invariant(reducedMeasure.notice?.text?.includes('Güncel kayıt henüz yüklenemedi.'),
    'reduced-motion notice must keep the failed-read statement');
  invariant(reducedMeasure.buttonLabel === 'Güncel durumu yenile',
    'reduced-motion action must stay the serialized reload');
  invariant((reducedMeasure.button?.height ?? 0) >= 44,
    `reduced-motion retry target must be >= 44px, got ${reducedMeasure.button?.height}`);
  invariant(reducedMeasure.noticeMotion?.transitionProperty === 'none',
    `reduced-motion notice transition must be none, got ${reducedMeasure.noticeMotion?.transition}`);
  invariant(reducedMeasure.noticeMotion?.animationName === 'none',
    `reduced-motion notice animation must be none, got ${reducedMeasure.noticeMotion?.animation}`);
  invariant(reducedMeasure.buttonMotion?.transitionProperty === 'none',
    `reduced-motion button transition must be none, got ${reducedMeasure.buttonMotion?.transition}`);
  invariant(reducedMeasure.buttonMotion?.animationName === 'none',
    `reduced-motion button animation must be none, got ${reducedMeasure.buttonMotion?.animation}`);
} finally {
  await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
  await vite.close();
}

if (captureDir) {
  mkdirSync(captureDir, { recursive: true });
  writeFileSync(
    resolve(captureDir, 'job-detail-committed-refresh-measurements.json'),
    `${JSON.stringify({ cases: rows, failures }, null, 2)}\n`,
  );
}

if (failures.length > 0) {
  console.error(JSON.stringify({ failures }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ failures: [], cases: rows.map((row) => ({
    case: row.case,
    headingFontSize: row.heading?.fontSize,
    helpFontSize: row.help?.fontSize,
    buttonFontSize: row.button?.fontSize,
    buttonHeight: row.button?.height,
    documentScrollWidth: row.documentScrollWidth,
  })) }, null, 2));
}
