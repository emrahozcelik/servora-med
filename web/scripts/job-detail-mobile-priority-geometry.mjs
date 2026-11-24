/**
 * UI-005 rendered geometry check: mobile job work priority.
 *
 * Renders the real JobDetailPanel (with the real lateness components) through
 * the production stylesheet and the owned Ant provider in headless Chromium.
 * The mount sits in a `.shell-content` wrapper that reproduces the composed
 * mobile shell spacing (0.5rem top padding, first-child top margin removed), so
 * the measurements reflect the merged shell contract:
 *
 *  - at 390×844 the primary command of a Staff IN_PROGRESS job and of a Manager
 *    WAITING_APPROVAL job is fully inside the first viewport,
 *  - the responsibility panel precedes the compact lifecycle summary,
 *  - the compact summary is a closed native disclosure with a >=44px target,
 *  - the revision/attention state renders Delay Amber with text and never Ant's
 *    error status,
 *  - manager lateness history is a collapsed disclosure below the record
 *    details on mobile and above the workflow on desktop,
 *  - desktop keeps the horizontal five-step stepper and the rail decision group.
 *
 * Usage: node scripts/job-detail-mobile-priority-geometry.mjs
 * Env: SERVORA_CHROME_PATH overrides the Chromium executable.
 *      JOB_DETAIL_PRIORITY_CAPTURE_DIR saves viewport + full-page PNGs.
 */
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(resolve(root, 'src/styles.css'), 'utf8');
// Composed mobile shell spacing shared with the parallel shell branch:
// `.shell-content { padding-top: .5rem }` and no top margin on its first child.
const shellSpacing = `
@media (width < 64rem) {
  .shell-content { padding-top: 0.5rem; }
  .shell-content > :first-child { margin-top: 0; }
  /* The fixture mounts the panel inside the Ant provider wrapper, which the real
     shell renders outside .shell-content; zero the page root's top margin the
     way the shell's first-child rule does in the application. */
  .shell-content .job-detail { margin-top: 0; }
}
`;
const html = `<!doctype html><html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/><style>${css}${shellSpacing}</style></head>
<body><div id="job-detail-mobile-priority-root" class="shell-content"></div>
<script type="module" src="/scripts/job-detail-mobile-priority-fixture.tsx"></script></body></html>`;

const MOBILE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };
const MIN_TARGET_PX = 44;
// The fixture reproduces the composed mobile shell spacing above; only the
// sticky mobile top bar (4.5rem) still sits above the page at 390x844.
const SHELL_CHROME_ALLOWANCE = 72;
const captureDir = process.env.JOB_DETAIL_PRIORITY_CAPTURE_DIR;

const failures = [];
function invariant(condition, message) {
  if (!condition) failures.push(message);
}

async function startServer() {
  const vite = await createViteServer({
    root, configFile: false, appType: 'custom', logLevel: 'error',
    // No HMR socket: the harness page is served by a plain HTTP server.
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

async function openCase(browser, url, fixtureCase, viewport) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error?.message ?? error)));
  await page.goto(`${url}?case=${fixtureCase}`, { waitUntil: 'load' });
  await page.waitForSelector('[data-job-detail="true"]');
  await page.waitForSelector('[data-workflow-compact="true"], .servora-ant-steps-horizontal', {
    timeout: 30_000,
  });
  return { page, errors };
}

async function measure(page) {
  return page.evaluate(({ minTarget }) => {
    const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect() ?? null;
    const round = (value) => (value === null ? null : Math.round(value * 10) / 10);
    const summary = document.querySelector('[data-workflow-compact="true"] summary');
    const disclosure = document.querySelector('[data-workflow-compact="true"]');
    const attentionSummary = document.querySelector('.servora-workflow-steps-summary--attention');
    const attentionTitle = document.querySelector('.servora-workflow-step--attention .servora-ant-steps-item-title');
    const historyDisclosure = document.querySelector('[data-overdue-history-disclosure="true"]');
    const historyRegion = document.querySelector('[data-overdue-history="ready"]');
    const primary = document.querySelector('[data-job-decision-panel="true"] .primary-button');
    const responsibility = document.querySelector('[data-job-detail-section="responsibility"]');
    const lifecycle = document.querySelector('[data-job-detail-section="lifecycle"]');
    const actions = document.querySelector('[data-job-detail-section="actions"]');
    const facts = document.querySelector('[data-job-detail-section="facts"]');
    const lateness = document.querySelector('[data-job-detail-section="lateness-history"]');
    const rail = document.querySelector('[data-job-detail-rail="true"]');
    const probe = document.createElement('span');
    probe.style.color = 'var(--warning)';
    probe.style.backgroundColor = 'var(--warning-soft)';
    probe.style.position = 'absolute';
    document.body.append(probe);
    const warningColor = getComputedStyle(probe).color;
    const warningSoftColor = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const attentionStep = document.querySelector('.servora-workflow-step--attention');
    const attentionIcon = attentionStep?.querySelector('.servora-workflow-attention-icon') ?? null;
    const latenessFacts = document.querySelector('[data-submission-lateness="open"] .job-row-facts');
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      primary: primary ? {
        text: primary.textContent,
        top: round(primary.getBoundingClientRect().top),
        bottom: round(primary.getBoundingClientRect().bottom),
        height: round(primary.getBoundingClientRect().height),
      } : null,
      responsibilityTop: round(responsibility?.getBoundingClientRect().top ?? null),
      lifecycleTop: round(lifecycle?.getBoundingClientRect().top ?? null),
      actionsTop: round(actions?.getBoundingClientRect().top ?? null),
      factsTop: round(facts?.getBoundingClientRect().top ?? null),
      latenessTop: round(lateness?.getBoundingClientRect().top ?? null),
      compact: disclosure ? {
        open: disclosure.hasAttribute('open'),
        summaryText: summary?.textContent ?? null,
        summaryHeight: round(summary?.getBoundingClientRect().height ?? null),
      } : null,
      horizontalSteps: document.querySelector('.servora-ant-steps-horizontal') !== null,
      attentionInSummary: attentionSummary !== null,
      attentionSummaryColor: attentionSummary ? getComputedStyle(attentionSummary).color : null,
      attentionTitleColor: attentionTitle ? getComputedStyle(attentionTitle).color : null,
      attentionIcon: attentionIcon ? {
        background: getComputedStyle(attentionIcon).backgroundColor,
        color: getComputedStyle(attentionIcon).color,
        numericIcon: attentionStep.querySelector('.servora-ant-steps-item-icon-number') !== null,
        width: Math.round(attentionIcon.getBoundingClientRect().width),
        height: Math.round(attentionIcon.getBoundingClientRect().height),
      } : null,
      warningColor,
      warningSoftColor,
      latenessFactsColumns: latenessFacts ? getComputedStyle(latenessFacts).gridTemplateColumns : null,
      errorStep: document.querySelector('.servora-ant-steps-item-error') !== null,
      historyDisclosure: historyDisclosure ? {
        open: historyDisclosure.hasAttribute('open'),
        summaryHeight: round(
          historyDisclosure.querySelector('summary')?.getBoundingClientRect().height ?? null,
        ),
        height: round(historyDisclosure.getBoundingClientRect().height),
      } : null,
      historyTop: round(historyRegion?.getBoundingClientRect().top ?? null),
      decisionInRail: rail !== null && rail.contains(document.querySelector('[data-job-decision-panel="true"]')),
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      minTarget: minTarget,
    };
  }, { minTarget: MIN_TARGET_PX });
}

/**
 * P0 regression: keyboard paging inside the collapsible history must keep the
 * disclosure open, keep the pager mounted and return focus to it.
 */
async function pageCollapsibleHistory(page) {
  const details = page.locator('details[data-overdue-history-disclosure="true"]');
  await details.locator('summary').click();
  const openAfterClick = await details.evaluate((element) => element.open);
  await page.locator('.overdue-history .servora-ant-pagination-next').focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => {
    const region = document.querySelector('[data-overdue-history="ready"]');
    return region?.getAttribute('data-overdue-history-busy') === 'false'
      && (region.textContent ?? '').includes('Sayfa 2 / 2');
  }, undefined, { timeout: 10_000 });
  return page.evaluate(() => ({
    openAfterClick: null,
    openAfterPaging: document.querySelector('details[data-overdue-history-disclosure="true"]')?.open ?? null,
    focusedClass: document.activeElement?.getAttribute('class') ?? null,
    pageText: document.querySelector('.overdue-history .servora-list-pagination__summary')?.textContent ?? null,
  })).then((result) => ({ ...result, openAfterClick }));
}

async function capture(page, name) {
  if (!captureDir) return;
  mkdirSync(captureDir, { recursive: true });
  await page.screenshot({ path: resolve(captureDir, `${name}-viewport.png`) });
  await page.screenshot({ path: resolve(captureDir, `${name}-full.png`), fullPage: true });
}

const { server, vite, url } = await startServer();
const launchOptions = { headless: true };
if (process.env.SERVORA_CHROME_PATH) launchOptions.executablePath = process.env.SERVORA_CHROME_PATH;
const browser = await chromium.launch(launchOptions);
const rows = [];
try {
  for (const fixtureCase of ['staff-in-progress', 'manager-waiting', 'revision', 'manager-late-history', 'staff-late']) {
    const { page, errors } = await openCase(browser, url, fixtureCase, MOBILE);
    const m = await measure(page);
    rows.push({ case: fixtureCase, layout: 'mobile', ...m });
    await capture(page, `mobile-${fixtureCase}`);

    invariant(errors.length === 0, `${fixtureCase}@390: page errors ${errors.join(' | ')}`);
    invariant(m.pageOverflow <= 1, `${fixtureCase}@390: page overflow ${m.pageOverflow}px`);
    invariant(m.primary !== null, `${fixtureCase}@390: no primary command rendered`);
    if (m.primary) {
      invariant(m.primary.top >= 0, `${fixtureCase}@390: primary command starts above the viewport (${m.primary.top})`);
      invariant(
        m.primary.bottom <= m.viewport.height - SHELL_CHROME_ALLOWANCE,
        `${fixtureCase}@390: primary command bottom ${m.primary.bottom} is below the first screen `
          + `(${m.viewport.height - SHELL_CHROME_ALLOWANCE} usable px after shell chrome)`,
      );
      invariant(m.primary.height >= MIN_TARGET_PX, `${fixtureCase}@390: primary target height ${m.primary.height}px`);
    }
    invariant(
      m.responsibilityTop !== null && m.lifecycleTop !== null && m.responsibilityTop < m.lifecycleTop,
      `${fixtureCase}@390: responsibility (${m.responsibilityTop}) is not above the lifecycle summary (${m.lifecycleTop})`,
    );
    invariant(
      m.actionsTop !== null && m.actionsTop < m.lifecycleTop,
      `${fixtureCase}@390: primary command group (${m.actionsTop}) is not above the lifecycle summary (${m.lifecycleTop})`,
    );
    invariant(m.compact !== null, `${fixtureCase}@390: compact lifecycle summary missing`);
    if (m.compact) {
      invariant(m.compact.open === false, `${fixtureCase}@390: compact summary is expanded by default`);
      invariant(m.compact.summaryHeight >= MIN_TARGET_PX,
        `${fixtureCase}@390: summary target height ${m.compact.summaryHeight}px`);
      invariant((m.compact.summaryText ?? '').includes('/ 5'),
        `${fixtureCase}@390: compact summary lacks the ordinal phase ("${m.compact.summaryText}")`);
    }
    invariant(m.horizontalSteps === false, `${fixtureCase}@390: horizontal stepper rendered on mobile`);
    invariant(m.errorStep === false, `${fixtureCase}@390: Ant error step status rendered`);
    if (fixtureCase === 'revision') {
      invariant(m.attentionInSummary, 'revision@390: compact summary lacks the attention state');
      invariant(m.attentionSummaryColor === m.warningColor,
        `revision@390: attention summary color ${m.attentionSummaryColor} != Delay Amber ${m.warningColor}`);
      invariant(m.attentionIcon !== null, 'revision@390: owned attention icon missing');
      if (m.attentionIcon) {
        invariant(m.attentionIcon.background === m.warningSoftColor,
          `revision@390: attention icon background ${m.attentionIcon.background} != Delay Amber soft ${m.warningSoftColor}`);
        invariant(m.attentionIcon.color === m.warningColor,
          `revision@390: attention icon color ${m.attentionIcon.color} != Delay Amber ${m.warningColor}`);
        invariant(m.attentionIcon.numericIcon === false,
          'revision@390: primary numeric step icon still rendered');
      }
    }
    if (fixtureCase === 'manager-late-history') {
      invariant(m.historyDisclosure !== null, 'manager-late-history@390: history disclosure missing');
      if (m.historyDisclosure) {
        invariant(m.historyDisclosure.open === false, 'manager-late-history@390: history disclosure is expanded');
        invariant(m.historyDisclosure.summaryHeight >= MIN_TARGET_PX,
          `manager-late-history@390: history summary height ${m.historyDisclosure.summaryHeight}px`);
        invariant(
          Math.abs(m.historyDisclosure.height - m.historyDisclosure.summaryHeight) <= 2,
          `manager-late-history@390: collapsed history occupies ${m.historyDisclosure.height}px `
            + `for a ${m.historyDisclosure.summaryHeight}px summary`,
        );
      }
      invariant(m.latenessTop !== null && m.factsTop !== null && m.latenessTop > m.factsTop,
        `manager-late-history@390: lateness history (${m.latenessTop}) is not below the record details (${m.factsTop})`);
      invariant((m.latenessFactsColumns ?? '').includes(' '),
        `manager-late-history@390: lateness facts are not two columns (${m.latenessFactsColumns})`);
    } else {
      invariant(m.historyDisclosure === null, `${fixtureCase}@390: unexpected lateness history disclosure`);
    }
    await page.close();
  }

  // P0: the collapsible history stays open with the pager focused across paging.
  {
    const { page, errors } = await openCase(browser, url, 'manager-late-history', MOBILE);
    const paging = await pageCollapsibleHistory(page);
    rows.push({ case: 'manager-late-history', layout: 'mobile-paging', ...paging });
    await capture(page, 'mobile-manager-late-history-paging');
    invariant(errors.length === 0, `manager-late-history@390 paging: page errors ${errors.join(' | ')}`);
    invariant(paging.openAfterClick === true, 'manager-late-history@390 paging: disclosure did not open');
    invariant(paging.openAfterPaging === true,
      'manager-late-history@390 paging: disclosure collapsed after paging (P0 regression)');
    invariant((paging.focusedClass ?? '').includes('servora-list-pagination'),
      `manager-late-history@390 paging: focus left the pager (${paging.focusedClass})`);
    invariant((paging.pageText ?? '').includes('Sayfa 2 / 2'),
      `manager-late-history@390 paging: wrong page (${paging.pageText})`);
    await page.close();
  }

  // 320px reflow probe for the densest first screen (open lateness + history).
  {
    const { page, errors } = await openCase(browser, url, 'manager-late-history', { width: 320, height: 700 });
    const m = await measure(page);
    rows.push({ case: 'manager-late-history', layout: 'mobile-320', ...m });
    await capture(page, 'mobile320-manager-late-history');
    invariant(errors.length === 0, `manager-late-history@320: page errors ${errors.join(' | ')}`);
    invariant(m.pageOverflow <= 1, `manager-late-history@320: page overflow ${m.pageOverflow}px`);
    invariant(m.compact !== null && m.compact.open === false, 'manager-late-history@320: compact summary state');
    invariant(m.historyDisclosure !== null, 'manager-late-history@320: history disclosure missing');
    // The 20rem reflow contract wins over the two-column lateness facts.
    invariant(m.latenessFactsColumns !== null && !(m.latenessFactsColumns ?? '').includes(' '),
      `manager-late-history@320: lateness facts are not a single column (${m.latenessFactsColumns})`);
    await page.close();
  }

  for (const fixtureCase of ['staff-in-progress', 'manager-waiting', 'revision', 'manager-late-history']) {
    const { page, errors } = await openCase(browser, url, fixtureCase, DESKTOP);
    const m = await measure(page);
    rows.push({ case: fixtureCase, layout: 'desktop', ...m });
    await capture(page, `desktop-${fixtureCase}`);

    invariant(errors.length === 0, `${fixtureCase}@1440: page errors ${errors.join(' | ')}`);
    invariant(m.compact === null, `${fixtureCase}@1440: compact disclosure rendered on desktop`);
    invariant(m.horizontalSteps === true, `${fixtureCase}@1440: horizontal stepper missing`);
    invariant(m.decisionInRail === true, `${fixtureCase}@1440: decision group left the work rail`);
    invariant(
      m.lifecycleTop !== null && m.responsibilityTop !== null && m.lifecycleTop < m.responsibilityTop,
      `${fixtureCase}@1440: lifecycle (${m.lifecycleTop}) is not above responsibility (${m.responsibilityTop})`,
    );
    invariant(m.errorStep === false, `${fixtureCase}@1440: Ant error step status rendered`);
    if (fixtureCase === 'revision') {
      invariant(m.attentionIcon !== null, 'revision@1440: owned attention icon missing');
      if (m.attentionIcon) {
        invariant(m.attentionIcon.background === m.warningSoftColor,
          `revision@1440: attention icon background ${m.attentionIcon.background} != Delay Amber soft`);
        invariant(m.attentionIcon.color === m.warningColor,
          `revision@1440: attention icon color ${m.attentionIcon.color} != Delay Amber`);
        invariant(m.attentionIcon.numericIcon === false,
          'revision@1440: primary numeric step icon still rendered');
        invariant(m.attentionIcon.width >= 24 && m.attentionIcon.height >= 24,
          `revision@1440: attention icon is ${m.attentionIcon.width}x${m.attentionIcon.height}`);
      }
    }
    if (fixtureCase === 'manager-late-history') {
      invariant(
        m.historyDisclosure !== null && !m.historyDisclosure.open,
        'manager-late-history@1440: history is not a collapsed disclosure on desktop',
      );
      invariant(m.historyTop !== null && m.lifecycleTop !== null && m.historyTop < m.lifecycleTop,
        `manager-late-history@1440: lateness history (${m.historyTop}) is not above the workflow (${m.lifecycleTop})`);
    }
    await page.close();
  }
} catch (error) {
  console.error(error);
  failures.push(String(error?.message ?? error));
} finally {
  await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
  await vite.close();
}

if (captureDir) {
  writeFileSync(resolve(captureDir, 'measurements.json'), `${JSON.stringify(rows, null, 2)}\n`);
}
console.log(JSON.stringify(rows, null, 2));

if (failures.length) {
  console.error(`SMOKE FAILURES:\n${failures.join('\n')}`);
  process.exit(1);
}
console.log('job detail mobile priority geometry OK');
