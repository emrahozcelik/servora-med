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
 *  - the shared OperationalCard title contract (slice B): plain adapter
 *    cards wrap long titles, narrow grids stay contained, title+extra never
 *    collide, and short titles with actions stay stable.
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

async function measureSharedCard(page, stack) {
  return page.evaluate((stackSel) => {
    const rootEl = document.documentElement;
    const card = document.querySelector(`${stackSel} .servora-operational-card`);
    const title = card?.querySelector('.servora-operational-card__title') ?? null;
    const link = title?.querySelector('a') ?? null;
    const heading = title?.querySelector('h2') ?? null;
    const textEl = link ?? heading;
    const cs = textEl ? getComputedStyle(textEl) : null;
    const tcs = title ? getComputedStyle(title) : null;
    const lineHeight = cs ? Number.parseFloat(cs.lineHeight) || 0 : 0;
    const lines = textEl && lineHeight > 0 ? textEl.getBoundingClientRect().height / lineHeight : 0;
    const titleFits = !textEl || textEl.scrollWidth <= textEl.clientWidth + 1;
    const body = card?.querySelector('.servora-ant-card-body') ?? null;
    const extra = card?.querySelector('[data-shared-extra]') ?? null;
    const tb = title?.getBoundingClientRect() ?? null;
    const eb = extra?.getBoundingClientRect() ?? null;
    const actions = card?.querySelector('.servora-ant-card-actions') ?? null;
    const actionButton = actions?.querySelector('button') ?? null;
    const ab = actionButton?.getBoundingClientRect() ?? null;
    const cb = card?.getBoundingClientRect() ?? null;
    return {
      overflowX: rootEl.scrollWidth > rootEl.clientWidth + 1,
      cardContained: !card || card.scrollWidth <= card.clientWidth + 1,
      titleWS: tcs?.whiteSpace ?? 'n/a',
      titleWrap: tcs?.overflowWrap ?? 'n/a',
      titleLines: Math.round(lines * 10) / 10,
      titleFits,
      titleText: textEl?.textContent ?? '',
      titleSeparated: !textEl || !body
        || textEl.getBoundingClientRect().bottom <= body.getBoundingClientRect().top + 1,
      extraIntersect: !!(tb && eb && !(tb.right <= eb.left + 1 || tb.bottom <= eb.top + 1
        || eb.bottom <= tb.top + 1 || eb.right <= tb.left + 1)),
      extraVisible: !extra || (eb.width > 0 && eb.height > 0),
      actionsIntact: !actions || (!!ab && ab.width > 0 && ab.left >= cb.left - 1 && ab.right <= cb.right + 1),
    };
  }, stack);
}

async function measureSharedGrid(page) {
  return page.evaluate(() => {
    const rootEl = document.documentElement;
    const grid = document.querySelector('#shared-grid-stack');
    const cards = [...(grid?.querySelectorAll('.servora-operational-card') ?? [])];
    const gb = grid?.getBoundingClientRect() ?? null;
    return {
      overflowX: rootEl.scrollWidth > rootEl.clientWidth + 1,
      track: grid ? getComputedStyle(grid).gridTemplateColumns : 'n/a',
      cardsInside: !gb || cards.every((k) => {
        const b = k.getBoundingClientRect();
        return b.left >= gb.left - 1 && b.right <= gb.right + 1;
      }),
      cardsContained: cards.every((k) => k.scrollWidth <= k.clientWidth + 1),
      firstTitleWS: cards[0]
        ? getComputedStyle(cards[0].querySelector('.servora-operational-card__title')).whiteSpace : 'n/a',
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
  // Shared OperationalCard title contract (Slice B): plain adapter cards
  // with no surface-scoped classes. 200% text uses the project 400%-reflow
  // convention (root font-size scaling), not CSS zoom.
  const sharedCases = [
    { name: 'shared-title', stack: '#shared-title-stack', long: true },
    { name: 'shared-extra', stack: '#shared-extra-stack', long: true },
    { name: 'shared-actions', stack: '#shared-actions-stack', long: false },
  ];
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 700 }]) {
    for (const c of sharedCases) {
      const page = await openCase(browser, url, c.name, viewport);
      for (const scaled of [false, true]) {
        if (scaled) {
          await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
          await page.waitForTimeout(250);
        }
        const tag = scaled ? `${viewport.width}px@200%` : `${viewport.width}px`;
        const m = await measureSharedCard(page, c.stack);
        console.log(JSON.stringify({ viewport: tag, case: c.name, ...m }));
        invariant(m.titleWS === 'normal', `${tag} ${c.name}: title white-space is ${m.titleWS}`, failures);
        invariant(!m.overflowX, `${tag} ${c.name}: document horizontal overflow`, failures);
        invariant(m.cardContained, `${tag} ${c.name}: card exceeds its own width`, failures);
        invariant(m.titleSeparated, `${tag} ${c.name}: title and body not separated`, failures);
        if (c.long) {
          invariant(m.titleLines > 1 || m.titleFits,
            `${tag} ${c.name}: long title neither wraps (${m.titleLines} lines) nor fits without clipping`, failures);
          invariant(m.titleText.includes('hazırlığı çalışması'),
            `${tag} ${c.name}: long title semantically clipped`, failures);
        } else {
          invariant(m.titleLines <= 1.5, `${tag} ${c.name}: short title unexpectedly wraps`, failures);
          invariant(m.actionsIntact, `${tag} ${c.name}: actions area not intact`, failures);
        }
        if (c.name === 'shared-extra') {
          invariant(!m.extraIntersect, `${tag} ${c.name}: title and extra intersect`, failures);
          invariant(m.extraVisible, `${tag} ${c.name}: extra not visible`, failures);
        }
      }
      await page.close();
    }
    const gridPage = await openCase(browser, url, 'shared-grid', viewport);
    for (const scaled of [false, true]) {
      if (scaled) {
        await gridPage.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
        await gridPage.waitForTimeout(250);
      }
      const tag = scaled ? `${viewport.width}px@200%` : `${viewport.width}px`;
      const g = await measureSharedGrid(gridPage);
      console.log(JSON.stringify({ viewport: tag, case: 'shared-grid', ...g }));
      invariant(!g.overflowX, `${tag} shared-grid: document horizontal overflow`, failures);
      invariant(g.cardsInside, `${tag} shared-grid: card escapes grid container`, failures);
      invariant(g.cardsContained, `${tag} shared-grid: card exceeds its own width`, failures);
      invariant(g.firstTitleWS === 'normal', `${tag} shared-grid: title white-space is ${g.firstTitleWS}`, failures);
    }
    await gridPage.close();
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
