/**
 * Rendered evidence for the compact job-detail schedule block.
 *
 * Measures and captures (390px) the collapsed summary and the expanded editor
 * with six slots, (1440px) 21 same-day slots after "Daha fazla göster", and
 * (320px) 200% text reflow. Screenshots and measurements go to
 * `JOB_SCHEDULE_CAPTURE_DIR` (defaults to `FLEET_EVIDENCE_DIR`).
 *
 * Usage: node scripts/job-schedule-compact-geometry.mjs
 */
import { createServer } from 'node:http';
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(resolve(root, 'src/styles.css'), 'utf8');
const captureDir = process.env.JOB_SCHEDULE_CAPTURE_DIR ?? process.env.FLEET_EVIDENCE_DIR;
const html = `<!doctype html><html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/><style>${css}</style></head>
<body><div id="schedule-evidence-root" class="shell-content"></div>
<script type="module" src="/scripts/job-schedule-compact-fixture.tsx"></script></body></html>`;

async function startServer() {
  const vite = await createViteServer({
    root, configFile: false, appType: 'custom', logLevel: 'error',
    server: { middlewareMode: true, hmr: false },
  });
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
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  return { server, vite, url: `http://127.0.0.1:${address.port}/` };
}

function round(value) {
  return Math.round(value * 10) / 10;
}

async function measure(page) {
  return page.evaluate(() => {
    const section = document.querySelector('.job-schedule-edit');
    const rect = section?.getBoundingClientRect();
    const chips = [...document.querySelectorAll('button[data-available-slot]')];
    return {
      height: rect ? Math.round(rect.height * 10) / 10 : null,
      width: rect ? Math.round(rect.width * 10) / 10 : null,
      sectionScrollWidth: section?.scrollWidth ?? null,
      sectionClientWidth: section?.clientWidth ?? null,
      pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
      chipCount: chips.length,
      chipHeight: chips[0] ? Math.round(chips[0].getBoundingClientRect().height) : null,
      chipLabels: chips.slice(0, 3).map((chip) => chip.getAttribute('aria-label')),
      dayLabels: [...document.querySelectorAll('.available-slots-day-label')]
        .map((label) => label.textContent),
      layout: {
        viewport: window.innerWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        detailWidth: document.querySelector('.job-detail')?.getBoundingClientRect().width ?? null,
        contentWidth: document.querySelector('.job-detail-content')?.getBoundingClientRect().width ?? null,
        widest: section ? [...section.querySelectorAll('*')]
          .map((node) => {
            const box = node.getBoundingClientRect();
            return {
              tag: node.tagName,
              className: typeof node.className === 'string' ? node.className : '',
              width: Math.round(box.width * 10) / 10,
              right: Math.round(box.right * 10) / 10,
            };
          })
          .sort((a, b) => b.width - a.width)
          .slice(0, 8) : [],
      },
    };
  });
}

const failures = [];
function invariant(condition, message) {
  if (!condition) failures.push(message);
}

const { server, vite, url } = await startServer();
const sha = execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8' }).trim();
const browser = await chromium.launch();
const results = {};
try {
  if (captureDir) mkdirSync(captureDir, { recursive: true });

  const compactPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await compactPage.goto(`${url}?case=compact`, { waitUntil: 'load' });
  await compactPage.waitForSelector('[data-job-schedule-summary="true"]');
  results.compactCollapsed = await measure(compactPage);
  if (captureDir) {
    await compactPage.locator('.job-schedule-edit').screenshot({
      path: resolve(captureDir, 'job-schedule-summary-390.png'),
    });
  }

  await compactPage.getByRole('button', { name: 'Değiştir' }).click();
  await compactPage.waitForSelector('.wheel-field-trigger');
  await compactPage.waitForFunction(
    () => document.querySelectorAll('button[data-available-slot]').length === 6,
  );
  results.compactExpanded = await measure(compactPage);
  if (captureDir) {
    await compactPage.locator('.job-schedule-edit').screenshot({
      path: resolve(captureDir, 'job-schedule-editor-390.png'),
    });
  }

  const desktopPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await desktopPage.goto(`${url}?case=many`, { waitUntil: 'load' });
  await desktopPage.getByRole('button', { name: 'Değiştir' }).click();
  await desktopPage.waitForFunction(
    () => document.querySelectorAll('button[data-available-slot]').length === 6,
  );
  await desktopPage.getByRole('button', { name: 'Daha fazla göster' }).click();
  await desktopPage.waitForFunction(
    () => document.querySelectorAll('button[data-available-slot]').length === 21,
  );
  results.desktopMany = await measure(desktopPage);
  if (captureDir) {
    await desktopPage.locator('.job-schedule-edit').screenshot({
      path: resolve(captureDir, 'job-schedule-slots-1440.png'),
    });
  }

  const reflowPage = await browser.newPage({ viewport: { width: 320, height: 844 } });
  await reflowPage.goto(`${url}?case=compact`, { waitUntil: 'load' });
  await reflowPage.evaluate(() => { document.documentElement.style.fontSize = '32px'; });
  await reflowPage.getByRole('button', { name: 'Değiştir' }).click();
  await reflowPage.waitForFunction(
    () => document.querySelectorAll('button[data-available-slot]').length === 6,
  );
  results.reflow320Zoom200 = await measure(reflowPage);
  if (captureDir) {
    await reflowPage.screenshot({
      path: resolve(captureDir, 'job-schedule-320-zoom200.png'),
      fullPage: false,
    });
  }

  invariant(
    results.compactCollapsed.height !== null && results.compactCollapsed.height <= 110,
    `collapsed summary ${results.compactCollapsed.height}px exceeds 110px`,
  );
  invariant(
    results.compactExpanded.height !== null && results.compactExpanded.height <= 560,
    `expanded editor ${results.compactExpanded.height}px exceeds 560px`,
  );
  invariant(results.compactExpanded.chipCount === 6, 'expected six compact slots');
  invariant(results.compactExpanded.chipHeight === 44, 'expected 44px slot chips');
  invariant(
    results.desktopMany.chipCount === 21,
    'expected 21 desktop same-day slots after Daha fazla göster',
  );
  invariant(
    results.desktopMany.sectionScrollWidth <= results.desktopMany.sectionClientWidth + 1,
    'desktop slot chips widen the schedule section',
  );
  invariant(
    results.desktopMany.pageOverflow <= 0,
    `desktop page overflows by ${results.desktopMany.pageOverflow}px`,
  );
  invariant(
    results.reflow320Zoom200.sectionScrollWidth <= results.reflow320Zoom200.sectionClientWidth + 1,
    '320px 200% text schedule section overflows horizontally',
  );
  invariant(
    results.reflow320Zoom200.pageOverflow <= 0,
    `320px 200% text page overflows by ${results.reflow320Zoom200.pageOverflow}px`,
  );

  console.log(JSON.stringify({ sha, results, failures }, null, 2));
  if (captureDir) {
    writeFileSync(
      resolve(captureDir, 'job-schedule-geometry.json'),
      `${JSON.stringify({ sha, results, failures }, null, 2)}\n`,
    );
  }
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
  await vite.close();
}

if (failures.length > 0) process.exitCode = 1;
