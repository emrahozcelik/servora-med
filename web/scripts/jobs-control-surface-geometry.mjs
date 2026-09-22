import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createServer as createViteServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(resolve(root, 'src/styles.css'), 'utf8');
const html = `<!doctype html><html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/><style>${css}</style></head>
<body><div id="jobs-control-surface-root"></div>
<script type="module" src="/scripts/jobs-control-surface-fixture.tsx"></script></body></html>`;

const viewports = [
  { width: 320, height: 568 },
  { width: 360, height: 740 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
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

async function measure(page, viewport, fixtureCase, role = 'manager') {
  await page.setViewportSize(viewport);
  await page.goto(`${url}?case=${fixtureCase}&role=${role}`, { waitUntil: 'networkidle' });
  await page.locator('[data-job-results-state="ready"], [data-job-board="true"]').waitFor();
  return page.evaluate(({ fixtureCase: currentCase, role: currentRole }) => {
    const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect() ?? null;
    const quickLinks = [...document.querySelectorAll('.job-quick-view')];
    const quickTops = new Set(quickLinks.map((link) => Math.round(link.getBoundingClientRect().top)));
    const result = document.querySelector('.structured-job-list > li, [data-board-card]');
    const searchInput = document.querySelector('#job-search');
    const searchSubmit = document.querySelector('.job-search-submit');
    const filterTrigger = document.querySelector('.filter-sheet-trigger');
    const mode = document.querySelector('[data-job-view-mode]');
    const desktopControlRows = new Set(
      [...document.querySelectorAll('.job-filter-primary > .field-group, .job-filter-primary > button')]
        .map((control) => Math.round(control.getBoundingClientRect().top)),
    ).size;
    const targets = [...document.querySelectorAll(
      '.job-quick-view, #job-search, .job-search-submit, .filter-sheet-trigger, .job-view-switcher-option',
    )].map((target) => {
      const bounds = target.getBoundingClientRect();
      return { width: bounds.width, height: bounds.height };
    });
    const strip = document.querySelector('[data-job-quick-views]');
    const firstResultY = result?.getBoundingClientRect().top ?? null;
    return {
      case: currentCase,
      role: currentRole,
      width: window.innerWidth,
      height: window.innerHeight,
      pageHeaderBottom: rect('.page-header')?.bottom ?? null,
      quickRows: quickTops.size,
      persistentControlRows: window.innerWidth < 1024
        ? quickTops.size + 1 + (mode ? 1 : 0)
        : quickTops.size + desktopControlRows,
      quickHeight: rect('[data-job-quick-views]')?.height ?? null,
      searchRowBottom: Math.max(
        searchInput?.getBoundingClientRect().bottom ?? 0,
        searchSubmit?.getBoundingClientRect().bottom ?? 0,
        filterTrigger?.getBoundingClientRect().bottom ?? 0,
      ),
      searchControlTops: [searchInput, searchSubmit, filterTrigger]
        .filter(Boolean).map((target) => Math.round(target.getBoundingClientRect().top)),
      searchControlBottoms: [searchInput, searchSubmit, filterTrigger]
        .filter(Boolean).map((target) => Math.round(target.getBoundingClientRect().bottom)),
      modeHeight: mode?.getBoundingClientRect().height ?? null,
      firstResultY,
      viewportFraction: firstResultY === null ? null : Number((firstResultY / window.innerHeight).toFixed(3)),
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      overflowers: [...document.querySelectorAll('body *')]
        .filter((element) => !element.closest('.job-quick-views'))
        .map((element) => {
          const bounds = element.getBoundingClientRect();
          return { selector: element.className || element.tagName, left: bounds.left, right: bounds.right };
        })
        .filter((entry) => entry.left < -1 || entry.right > document.documentElement.clientWidth + 1)
        .slice(0, 12),
      stripClientWidth: strip?.clientWidth ?? null,
      stripScrollWidth: strip?.scrollWidth ?? null,
      minTargetWidth: targets.length ? Math.min(...targets.map((target) => target.width)) : null,
      minTargetHeight: targets.length ? Math.min(...targets.map((target) => target.height)) : null,
    };
  }, { fixtureCase, role });
}

function verifyMobile(row) {
  invariant(row.quickRows === 1, `${row.width}px ${row.case}: quick views wrapped to ${row.quickRows} rows`);
  invariant(row.persistentControlRows === 3,
    `${row.width}px ${row.case}: expected 3 persistent control rows, got ${row.persistentControlRows}`);
  invariant(Math.max(...row.searchControlBottoms) - Math.min(...row.searchControlBottoms) <= 1,
    `${row.width}px ${row.case}: search/submit/filter controls are not one row ${row.searchControlBottoms}`);
  invariant(row.pageOverflow <= 1,
    `${row.width}px ${row.case}: page overflow ${row.pageOverflow}px ${JSON.stringify(row.overflowers)}`);
  invariant(row.minTargetHeight >= 44, `${row.width}px ${row.case}: target height ${row.minTargetHeight}px`);
  invariant(row.minTargetWidth >= 44, `${row.width}px ${row.case}: target width ${row.minTargetWidth}px`);
  if (row.width <= 430) {
    invariant(row.stripScrollWidth > row.stripClientWidth,
      `${row.width}px ${row.case}: quick-view strip should own horizontal overflow`);
  }
  if ([360, 390, 430].includes(row.width)) {
    invariant(row.firstResultY < row.height,
      `${row.width}px ${row.case}: first result starts below the viewport (${row.firstResultY}px)`);
  }
  if (row.width === 320) {
    invariant(row.viewportFraction < 0.9,
      `320px ${row.case}: expected substantial improvement, got ${row.viewportFraction}`);
  }
}

const { server, vite, url } = await startServer();
const chromiumBrowser = await chromium.launch({ headless: true });
const rows = [];
try {
  const page = await chromiumBrowser.newPage();
  for (const viewport of viewports) {
    const row = await measure(page, viewport, 'active-list');
    rows.push(row);
    if (viewport.width < 1024) verifyMobile(row);
  }
  for (const fixtureCase of ['active-board', 'approval-board', 'closed', 'overdue']) {
    const row = await measure(page, { width: 390, height: 844 }, fixtureCase);
    rows.push(row);
    verifyMobile(row);
  }
  const staffRow = await measure(page, { width: 390, height: 844 }, 'active-list', 'staff');
  rows.push(staffRow);
  verifyMobile(staffRow);
} finally {
  await chromiumBrowser.close();
}

const webkitBrowser = await webkit.launch({ headless: true });
try {
  const page = await webkitBrowser.newPage();
  const row = await measure(page, { width: 390, height: 844 }, 'active-list');
  verifyMobile(row);
  rows.push({ ...row, engine: 'webkit' });
} finally {
  await webkitBrowser.close();
  await vite.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}

console.log(JSON.stringify(rows, null, 2));
