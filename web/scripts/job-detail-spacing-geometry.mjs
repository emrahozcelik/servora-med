/**
 * Computed-layout regression guard for UI polish slice A.
 *
 * Serves static, class-faithful fixtures through the real stylesheet (plus
 * the Ant runtime cascade for the OperationalCard cases) and measures
 * rendered boxes in Chromium:
 *  - follow-up panels keep positive separation from the terminal banner
 *    (broken = 0px, fixed ~= 18px; threshold 8px distinguishes robustly),
 *  - the JobDetail heading group keeps positive separation from the next
 *    surface,
 *  - the late-submission card title wraps (long titles stay fully readable,
 *    including at 200% text) without horizontal overflow.
 *
 * Usage: node scripts/job-detail-spacing-geometry.mjs
 * Env: SERVORA_CHROME_PATH overrides the Chromium executable (CI default otherwise).
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
<body><div id="job-detail-spacing-root"></div>
<script type="module" src="/scripts/job-detail-spacing-fixture.tsx"></script></body></html>`;

const MIN_SEPARATION_PX = 8;

function invariant(condition, message, failures) {
  if (!condition) failures.push(message);
}

async function startServer() {
  const vite = await createViteServer({
    root, configFile: false, appType: 'custom', logLevel: 'error',
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

async function openCase(browser, url, fixtureCase, viewport) {
  const page = await browser.newPage({ viewport });
  await page.goto(`${url}?case=${fixtureCase}`, { waitUntil: 'load' });
  await page.waitForSelector('html[data-smoke-job-spacing-ready="true"]', { timeout: 30_000 });
  return page;
}

function gapOf(a, b) {
  if (!a || !b) return null;
  return b.top - a.bottom;
}

async function measureSpacing(page, first, second) {
  return page.evaluate(({ first: f, second: s }) => {
    const r = (sel) => document.querySelector(sel)?.getBoundingClientRect() ?? null;
    const a = r(f);
    const b = r(s);
    if (!a || !b) return { gap: null };
    return { gap: Math.round((b.top - a.bottom) * 10) / 10 };
  }, { first, second });
}

async function measureLateCard(page) {
  return page.evaluate(() => {
    const rootEl = document.documentElement;
    const card = document.querySelector('#late-stack .submission-late-card');
    const link = card?.querySelector('.servora-operational-card__title a') ?? null;
    const body = card?.querySelector('.servora-ant-card-body') ?? null;
    const lineHeight = link ? Number.parseFloat(getComputedStyle(link).lineHeight) || 0 : 0;
    const lines = link && lineHeight > 0 ? link.getBoundingClientRect().height / lineHeight : 0;
    return {
      overflowX: rootEl.scrollWidth > rootEl.clientWidth + 1,
      cardContained: !card || card.scrollWidth <= card.clientWidth + 1,
      titleLines: Math.round(lines * 10) / 10,
      titleSeparated: !link || !body
        || link.getBoundingClientRect().bottom <= body.getBoundingClientRect().top + 1,
      titleText: link?.textContent ?? '',
      bodyText: body?.textContent ?? '',
    };
  });
}

const failures = [];
const { server, vite, url } = await startServer();
const launchOptions = { headless: true };
if (process.env.SERVORA_CHROME_PATH) launchOptions.executablePath = process.env.SERVORA_CHROME_PATH;
const browser = await chromium.launch(launchOptions);
try {
  const spacingCases = [
    { name: 'create-terminal', first: '.follow-up-create-action', second: '[data-job-detail-section="terminal"]' },
    { name: 'recommendation-terminal', first: '.follow-up-recommendation', second: '[data-job-detail-section="terminal"]' },
    { name: 'source-terminal', first: '.follow-up-source-context', second: '[data-job-detail-section="terminal"]' },
    { name: 'heading-steps', first: '[data-job-detail-section="heading"]', second: '.servora-workflow-steps' },
    { name: 'heading-lateness', first: '[data-job-detail-section="heading"]', second: '[data-submission-lateness="open"]' },
  ];
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    for (const c of spacingCases) {
      const page = await openCase(browser, url, c.name, viewport);
      const m = await measureSpacing(page, c.first, c.second);
      console.log(JSON.stringify({ viewport: `${viewport.width}x${viewport.height}`, case: c.name, gap: m.gap }));
      invariant(m.gap !== null && m.gap >= MIN_SEPARATION_PX,
        `${viewport.width}px ${c.name}: separation ${m.gap}px < ${MIN_SEPARATION_PX}px`, failures);
      await page.close();
    }
  }

  // Late-submission card: wraps at 100% and stays wrap-safe at 200% text.
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 700 }]) {
    const page = await openCase(browser, url, 'late-card', viewport);
    const m = await measureLateCard(page);
    console.log(JSON.stringify({ viewport: `${viewport.width}x${viewport.height}`, case: 'late-card', ...m }));
    invariant(!m.overflowX, `${viewport.width}px late-card: document horizontal overflow`, failures);
    invariant(m.cardContained, `${viewport.width}px late-card: card exceeds its own width`, failures);
    invariant(m.titleLines > 1, `${viewport.width}px late-card: long title does not wrap (${m.titleLines} lines)`, failures);
    invariant(m.titleSeparated, `${viewport.width}px late-card: title and metadata not separated`, failures);
    invariant(m.titleText.includes('hazırlığı çalışması'),
      `${viewport.width}px late-card: long title semantically clipped`, failures);

    await page.evaluate(() => {
      document.getElementById('late-stack').style.zoom = '2';
    });
    const z = await measureLateCard(page);
    console.log(JSON.stringify({ viewport: `${viewport.width}x${viewport.height}@200%`, case: 'late-card', ...z }));
    invariant(!z.overflowX, `${viewport.width}px late-card@200%: document horizontal overflow`, failures);
    invariant(z.cardContained, `${viewport.width}px late-card@200%: card exceeds its own width`, failures);
    invariant(z.titleLines > 1, `${viewport.width}px late-card@200%: long title does not wrap`, failures);
    invariant(z.titleText.includes('hazırlığı çalışması'),
      `${viewport.width}px late-card@200%: long title semantically clipped`, failures);
    await page.close();
  }
} catch (err) {
  console.error(err);
  failures.push(String(err?.message ?? err));
} finally {
  await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
  await vite.close();
}

if (failures.length) {
  console.error(`SMOKE FAILURES:\n${failures.join('\n')}`);
  process.exit(1);
}
console.log('job detail spacing geometry OK');
