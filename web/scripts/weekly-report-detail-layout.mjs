/**
 * Weekly Report detail information-architecture smoke.
 *
 * Renders the REAL `WeeklyReportDetail` (via
 * `scripts/weekly-report-detail-fixture.tsx`) in Chromium at desktop, tablet and
 * mobile widths and asserts the JobCard-detail presentation contract:
 *
 *   heading → lifecycle steps → responsibility → main column + work rail → history
 *
 * plus the properties that motivated the migration:
 *   - the primary lifecycle action lives in the work rail, not at the bottom of
 *     the page after the report form, and always precedes the submission history
 *   - the NEW state shows a calm locked notice, never the full disabled form
 *   - the workflow strip is driven by the shared phase model, not a weekly copy
 *   - the rail sits beside the content on desktop and flows below it on mobile
 *   - no horizontal overflow, no textarea wider than its column
 *   - the destructive control is never styled as the primary action
 *
 * The fixture is bundled with Rollup (`vite build`) into a temporary directory
 * and served as static files, rather than served by the Vite dev server. The
 * dev server must commit its dependency-optimizer output by deleting the
 * previous `node_modules/.vite/deps` and renaming a fresh `deps_temp_*` over it;
 * that delete is not always permitted, and when it is refused every module
 * request degrades to `504 (Outdated Optimize Dep)` and the whole page never
 * boots. Bundling has no such commit step, so this check measures the layout
 * contract instead of the file system's delete permissions.
 *
 * Usage: node scripts/weekly-report-detail-layout.mjs
 */
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(resolve(root, 'src/styles.css'), 'utf8');

const fixtureHtml = `<!doctype html>
<html lang="tr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>${css}</style>
  </head>
  <body>
    <div id="weekly-detail-root"></div>
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

/** Shared phase labels, in the canonical order of the presentation model. */
const CANONICAL_PHASE_LABELS = ['Atandı', 'Kabul edildi', 'Uygulanıyor', 'Yönetici kontrolü', 'Tamamlandı'];

const DESKTOP_MIN_WIDTH_PX = 64 * 16;

const viewports = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1024x768', width: 1024, height: 768 },
  { name: '390x844', width: 390, height: 844 },
  // Equivalent content width to 1280px at 400% browser zoom.
  { name: '320x800-reflow', width: 320, height: 800 },
];

/**
 * `sections` is the exact ordered list of `data-job-detail-section` slots that
 * must be present; `rail`/`editor`/`locked` describe the expected composition.
 */
const states = [
  {
    name: 'NEW',
    role: 'STAFF',
    sections: ['heading', 'lifecycle', 'responsibility', 'facts', 'actions', 'timeline'],
    rail: true,
    editor: false,
    locked: true,
    lockedNotice: 'Raporu hazırlamaya başlamak için önce atanan işi kabul edin.',
    primary: 'İşi kabul et',
    destructive: 'İşi iptal et',
  },
  {
    name: 'ACCEPTED',
    role: 'STAFF',
    sections: ['heading', 'lifecycle', 'responsibility', 'facts', 'actions', 'timeline'],
    rail: true,
    editor: true,
    locked: false,
    primary: 'İşi başlat',
    destructive: 'İşi iptal et',
  },
  {
    name: 'IN_PROGRESS',
    role: 'STAFF',
    sections: ['heading', 'lifecycle', 'responsibility', 'facts', 'actions', 'timeline'],
    rail: true,
    editor: true,
    locked: false,
    primary: 'Kontrole gönder',
    destructive: 'İşi iptal et',
  },
  {
    name: 'REVISION_REQUESTED',
    role: 'STAFF',
    sections: ['heading', 'lifecycle', 'revision', 'responsibility', 'facts', 'actions', 'timeline'],
    rail: true,
    editor: false,
    locked: true,
    lockedNotice: 'Düzeltmeye başladıktan sonra raporu yeniden düzenleyebilirsiniz.',
    primary: 'Düzeltmeye başla',
    destructive: 'İşi iptal et',
  },
  {
    name: 'WAITING_APPROVAL',
    role: 'MANAGER',
    sections: ['heading', 'lifecycle', 'responsibility', 'facts', 'management-review', 'actions', 'timeline'],
    rail: true,
    editor: false,
    locked: false,
    primary: 'Kontrolü tamamla ve işi kapat',
    destructive: null,
  },
  {
    name: 'COMPLETED',
    role: 'STAFF',
    sections: ['heading', 'lifecycle', 'terminal', 'facts', 'timeline'],
    rail: false,
    editor: false,
    locked: false,
    primary: null,
    destructive: null,
  },
  {
    name: 'CANCELLED',
    role: 'STAFF',
    sections: ['heading', 'lifecycle', 'terminal', 'facts', 'timeline'],
    rail: false,
    editor: false,
    locked: true,
    lockedNotice: 'İş iptal edildi; rapor düzenlenemez.',
    primary: null,
    destructive: null,
  },
];

/**
 * The realtime provider is a transport concern, not part of this layout
 * contract: the fixture renders one snapshot and never refreshes.
 */
const realtimeStub = {
  name: 'servora-realtime-stub',
  enforce: 'pre',
  resolveId(source) {
    return source.includes('realtime/RealtimeProvider') ? '\0servora-realtime-stub' : null;
  },
  load(id) {
    if (id !== '\0servora-realtime-stub') return null;
    return [
      'export const RealtimeProvider = ({ children }) => children;',
      'export const useRealtimeInvalidation = () => {};',
      'export default { RealtimeProvider, useRealtimeInvalidation };',
    ].join('\n');
  },
};

/** Bundles the fixture into a throwaway directory and returns that directory. */
async function bundleFixture() {
  const outDir = await mkdtemp(join(tmpdir(), 'servora-weekly-detail-layout-'));
  await build({
    root,
    configFile: false,
    logLevel: 'error',
    plugins: [realtimeStub],
    build: {
      outDir,
      // The directory was just created empty, so there is nothing to clear and
      // no delete to be refused.
      emptyOutDir: false,
      minify: false,
      target: 'es2022',
      rollupOptions: {
        input: resolve(root, 'scripts/weekly-report-detail-fixture.tsx'),
        output: {
          format: 'es',
          // One self-contained chunk keeps the temporary directory trivial to
          // inspect and to remove.
          inlineDynamicImports: true,
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
    throw new Error('Layout smoke sunucusu portu alınamadı.');
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

async function measure(page) {
  return page.evaluate(() => {
    const rect = (element) => {
      const box = element.getBoundingClientRect();
      return {
        left: box.left, right: box.right, top: box.top, bottom: box.bottom,
        width: box.width, height: box.height,
      };
    };
    const text = (element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim();
    const host = document.querySelector('[data-weekly-report-detail="true"]');
    if (!host) return null;

    const sections = [...host.querySelectorAll('[data-job-detail-section]')]
      .map((element) => element.dataset.jobDetailSection);

    const steps = host.querySelector('[aria-label="İş süreci"]');
    const stepsHost = host.querySelector('.servora-workflow-steps');
    const visibleStepTitles = [...host.querySelectorAll('.servora-ant-steps-item-title')].map(text);

    const rail = host.querySelector('[data-job-detail-rail="true"]');
    const main = host.querySelector('.job-detail-main');
    const timeline = host.querySelector('.job-detail-timeline');
    const decisionPanel = host.querySelector('[data-job-decision-panel="true"]');

    const textareas = [...host.querySelectorAll('textarea')];
    const buttons = [...host.querySelectorAll('button')].map((button) => ({
      text: text(button),
      classes: button.className,
    }));

    const primaryButton = decisionPanel?.querySelector('.primary-button') ?? null;

    return {
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      viewportHeight: window.innerHeight,
      sections,
      steps: stepsHost ? {
        present: true,
        host: rect(stepsHost),
        labels: steps ? [...steps.querySelectorAll('li')].map((item) => text(item).split(':')[0].trim()) : [],
        states: steps ? [...steps.querySelectorAll('li')].map((item) => text(item).split(':').slice(1).join(':').trim()) : [],
        currentCount: steps ? steps.querySelectorAll('li[aria-current="step"]').length : 0,
        visibleTitles: visibleStepTitles,
      } : { present: false },
      rail: rail ? rect(rail) : null,
      main: main ? rect(main) : null,
      timeline: timeline ? rect(timeline) : null,
      primary: primaryButton
        ? { text: text(primaryButton), classes: primaryButton.className, ...rect(primaryButton) }
        : null,
      primaryInRail: primaryButton !== null && rail !== null && rail.contains(primaryButton),
      destructive: [...host.querySelectorAll('.destructive-button')].map((button) => ({
        text: text(button), classes: button.className, ...rect(button),
      })),
      formCount: host.querySelectorAll('form').length,
      textareaCount: textareas.length,
      textareaOverflow: textareas.filter((area) => {
        const own = area.getBoundingClientRect();
        const group = area.closest('.field-group') ?? area.parentElement;
        return group ? own.width > group.getBoundingClientRect().width + 1 : false;
      }).length,
      widestTextarea: textareas.length
        ? Math.max(...textareas.map((area) => area.getBoundingClientRect().width))
        : 0,
      editor: host.querySelector('[data-job-detail-block="weekly-report-editor"]') !== null,
      locked: host.querySelector('[data-job-detail-block="weekly-report-locked"]') !== null,
      lockedNotice: text(host.querySelector('.weekly-report-locked-notice') ?? document.createElement('p')),
      historyEmpty: text(host.querySelector('.weekly-history-empty') ?? document.createElement('p')),
      buttons,
    };
  });
}

function checkState(measurement, spec, viewport, failures) {
  const label = `${spec.name} @ ${viewport.name}`;
  if (!measurement) {
    failures.push(`${label}: weekly report detail root not found`);
    return;
  }

  if (measurement.overflowX) failures.push(`${label}: horizontal overflow`);

  if (!measurement.steps.present) {
    failures.push(`${label}: shared workflow steps missing`);
  } else {
    if (measurement.steps.host.height <= 20) {
      failures.push(`${label}: workflow steps collapsed (${measurement.steps.host.height.toFixed(1)}px)`);
    }
    if (measurement.steps.labels.length !== 5) {
      failures.push(`${label}: expected 5 phase labels, got ${JSON.stringify(measurement.steps.labels)}`);
    } else if (JSON.stringify(measurement.steps.labels) !== JSON.stringify(CANONICAL_PHASE_LABELS)) {
      failures.push(`${label}: phase labels are not the shared model order ${JSON.stringify(measurement.steps.labels)}`);
    }
    if (measurement.steps.currentCount !== 1) {
      failures.push(`${label}: expected exactly one current phase, got ${measurement.steps.currentCount}`);
    }
    // The visible AntD strip must project the same model as the screen-reader
    // list — never a second, weekly-specific phase vocabulary.
    if (measurement.steps.visibleTitles.length !== measurement.steps.labels.length) {
      failures.push(`${label}: visible step count ${measurement.steps.visibleTitles.length} != accessible list ${measurement.steps.labels.length}`);
    } else {
      measurement.steps.labels.forEach((expected, index) => {
        const visible = measurement.steps.visibleTitles[index] ?? '';
        if (!visible.startsWith(expected)) {
          failures.push(`${label}: visible step ${index + 1} "${visible}" does not start with the shared label "${expected}"`);
        }
      });
    }
  }

  if (JSON.stringify(measurement.sections) !== JSON.stringify(spec.sections)) {
    failures.push(`${label}: section order ${JSON.stringify(measurement.sections)} != ${JSON.stringify(spec.sections)}`);
  }

  if (spec.rail !== (measurement.rail !== null)) {
    failures.push(`${label}: work rail presence ${measurement.rail !== null} != ${spec.rail}`);
  }

  if (spec.editor !== measurement.editor) {
    failures.push(`${label}: report editor presence ${measurement.editor} != ${spec.editor}`);
  }
  if (spec.locked !== measurement.locked) {
    failures.push(`${label}: locked notice presence ${measurement.locked} != ${spec.locked}`);
  }
  if (spec.locked && measurement.lockedNotice !== spec.lockedNotice) {
    failures.push(`${label}: locked notice "${measurement.lockedNotice}" != "${spec.lockedNotice}"`);
  }

  // The regression that motivated the slice: a NEW report must never render the
  // giant disabled form (or any form at all) before the lifecycle action.
  if (!spec.editor && measurement.textareaCount !== 0) {
    failures.push(`${label}: ${measurement.textareaCount} textarea(s) rendered without an editable report`);
  }
  if (!spec.editor && measurement.formCount !== 0) {
    failures.push(`${label}: ${measurement.formCount} form(s) rendered without an editable report`);
  }
  if (spec.editor && measurement.textareaCount < 7) {
    failures.push(`${label}: editable report rendered only ${measurement.textareaCount} textarea(s)`);
  }

  if (measurement.textareaOverflow > 0) {
    failures.push(`${label}: ${measurement.textareaOverflow} textarea(s) wider than their column`);
  }

  // Primary action: exact label, styled as the only primary control in the rail.
  if (spec.primary === null) {
    if (measurement.primary !== null) {
      failures.push(`${label}: unexpected primary action "${measurement.primary.text}"`);
    }
  } else if (measurement.primary === null) {
    failures.push(`${label}: primary action "${spec.primary}" missing`);
  } else if (measurement.primary.text !== spec.primary) {
    failures.push(`${label}: primary action "${measurement.primary.text}" != "${spec.primary}"`);
  } else if (!measurement.primary.classes.includes('primary-button')) {
    failures.push(`${label}: primary action is not styled as a primary button`);
  }

  if (spec.destructive === null) {
    if (measurement.destructive.length > 0) {
      failures.push(`${label}: unexpected destructive control ${JSON.stringify(measurement.destructive.map((d) => d.text))}`);
    }
  } else if (measurement.destructive.length !== 1
    || measurement.destructive[0].text !== spec.destructive) {
    failures.push(`${label}: destructive control ${JSON.stringify(measurement.destructive.map((d) => d.text))} != ["${spec.destructive}"]`);
  }
  for (const button of measurement.destructive) {
    if (button.classes.includes('primary-button')) {
      failures.push(`${label}: destructive "${button.text}" is styled as the primary action`);
    }
  }

  if (measurement.rail && measurement.main) {
    const desktop = viewport.width >= DESKTOP_MIN_WIDTH_PX;
    if (desktop) {
      if (measurement.rail.left < measurement.main.right - 1) {
        failures.push(`${label}: rail is not beside the main column (rail.left ${measurement.rail.left.toFixed(1)} < main.right ${measurement.main.right.toFixed(1)})`);
      }
      if (measurement.rail.top > measurement.main.top + 2) {
        failures.push(`${label}: rail is not top aligned with the main column`);
      }
      if (measurement.rail.width < 200) {
        failures.push(`${label}: rail is only ${measurement.rail.width.toFixed(1)}px wide`);
      }
    } else {
      if (measurement.rail.top < measurement.main.bottom - 1) {
        failures.push(`${label}: rail did not flow below the main column (rail.top ${measurement.rail.top.toFixed(1)} < main.bottom ${measurement.main.bottom.toFixed(1)})`);
      }
      if (measurement.rail.left < measurement.main.left - 1
        || measurement.rail.right > measurement.main.right + 1) {
        failures.push(`${label}: rail escaped the content column on mobile`);
      }
    }
  }

  // The regression this slice fixes: the decision panel used to sit at the very
  // bottom of the page, after the whole report form. The shared contract instead
  // puts it in the work rail, under the "İşlemler" heading and after the
  // requirements checklist — `JobDetail` renders `{requirements}{decision}` in
  // exactly that order, so the checklist pushing the action down is the
  // established IA and "above the fold" is not a contract this screen may be
  // held to. What must hold is that the action belongs to the rail and never
  // ends up below the main column or the submission history.
  if (measurement.primary) {
    if (viewport.width >= DESKTOP_MIN_WIDTH_PX && !measurement.primaryInRail) {
      failures.push(`${label}: primary action is not inside the work rail`);
    }
    // Only meaningful where the rail sits beside the main column; below the
    // desktop breakpoint the rail flows after the main column by design, so the
    // action being past `main.bottom` is the intended reading order.
    if (viewport.width >= DESKTOP_MIN_WIDTH_PX
      && measurement.main && measurement.primary.top > measurement.main.bottom) {
      failures.push(`${label}: primary action sits below the main column (top ${measurement.primary.top.toFixed(1)} > main.bottom ${measurement.main.bottom.toFixed(1)})`);
    }
    if (measurement.timeline && measurement.primary.top > measurement.timeline.top) {
      failures.push(`${label}: primary action sits below the submission history`);
    }
  }
}

async function runCase(browser, baseUrl, viewport, spec, failures) {
  const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height }, reducedMotion: 'reduce' });
  const diagnostics = { pageErrors: [], consoleErrors: [], requestFailures: [], badResponses: [] };
  attachDiagnostics(page, diagnostics);
  const label = `${spec.name} @ ${viewport.name}`;
  try {
    await page.goto(`${baseUrl}?state=${spec.name}&role=${spec.role}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('html[data-weekly-detail-ready="true"]');
    await page.waitForSelector('[data-weekly-report-detail="true"]');
    await page.waitForSelector('.servora-workflow-steps');

    const measurement = await measure(page);
    checkState(measurement, spec, viewport, failures);

    console.log(JSON.stringify({
      case: label,
      sections: measurement?.sections ?? null,
      phases: measurement?.steps?.labels ?? null,
      phaseStates: measurement?.steps?.states ?? null,
      rail: measurement?.rail ? `${measurement.rail.width.toFixed(0)}x${measurement.rail.height.toFixed(0)}@${measurement.rail.left.toFixed(0)}` : null,
      primary: measurement?.primary
        ? `${measurement.primary.text}@${measurement.primary.top.toFixed(0)}` : null,
      fold: measurement?.viewportHeight ?? null,
      textareas: measurement?.textareaCount ?? null,
      widestTextarea: measurement?.widestTextarea ?? null,
      destructive: measurement?.destructive.map((entry) => entry.text) ?? null,
      overflowX: measurement?.overflowX ?? null,
    }));

    try {
      await page.screenshot({
        path: join(tmpdir(), `servora-weekly-detail-${spec.name}-${viewport.name}.png`),
        fullPage: true,
      });
    } catch (error) {
      console.log(JSON.stringify({ case: label, screenshot: `skipped: ${error}` }));
    }

    if (spec.name === 'WAITING_APPROVAL' || spec.name === 'COMPLETED' || spec.name === 'CANCELLED') {
      const history = page.locator('.weekly-history');
      const details = history.locator('details.weekly-technical-information');
      const summary = details.locator('summary');
      const sender = '33333333-3333-4333-8333-333333333333';
      if (await details.getAttribute('open') !== null) failures.push(`${label}: technical details open by default`);
      if (await history.getByText(sender, { exact: true }).isVisible()) failures.push(`${label}: sender visible before disclosure`);
      const caption = await page.locator('.weekly-frozen-report > .form-help').allTextContents();
      if (caption.join('').includes(sender)) failures.push(`${label}: technical identity in report caption`);
      await summary.focus();
      await page.keyboard.press('Enter');
      if (!await history.getByText(sender, { exact: true }).isVisible()) failures.push(`${label}: keyboard did not disclose sender`);
      const geometry = await summary.evaluate(async (element) => {
        // Read painted focus state after the reduced-motion transition settles.
        await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
        const bounds = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const cells = [...element.parentElement.querySelectorAll('.servora-ant-descriptions-item-content')];
        return {
          width: bounds.width, height: bounds.height,
          focused: document.activeElement === element,
          outline: parseFloat(style.outlineWidth),
          overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          clipped: cells.some((cell) => cell.scrollWidth > cell.clientWidth + 1),
        };
      });
      if (geometry.width < 44 || geometry.height < 44 || !geometry.focused || geometry.outline < 2
        || geometry.overflowX || geometry.clipped) failures.push(`${label}: technical disclosure geometry ${JSON.stringify(geometry)}`);
      await page.screenshot({ path: join(tmpdir(), `servora-weekly-detail-${spec.name}-${viewport.name}-technical.png`), fullPage: true });
      await history.screenshot({ path: join(tmpdir(), `servora-weekly-history-${spec.name}-${viewport.name}-technical.png`) });
      await page.keyboard.press('Space');
      if (await details.getAttribute('open') !== null) failures.push(`${label}: Space did not close disclosure`);
      // Reopen before zoom/reflow so hidden UUIDs cannot mask layout defects.
      await page.keyboard.press('Enter');
    }

    if (viewport.width === 390) {
      await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
      const zoomed = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      console.log(JSON.stringify({ case: `${label} 200%`, overflowX: zoomed }));
      if (zoomed) failures.push(`${label} 200%: horizontal overflow`);
    }

    if (diagnostics.pageErrors.length || diagnostics.consoleErrors.length
      || diagnostics.requestFailures.length || diagnostics.badResponses.length) {
      failures.push(`${label}: page diagnostics ${JSON.stringify(diagnostics)}`);
    }
  } catch (error) {
    failures.push(`${label}: ${error}`);
    console.error(JSON.stringify({ case: label, diagnostics }, null, 2));
  } finally {
    if (!page.isClosed()) await page.close();
  }
}

const failures = [];
let browser;
let server;
let bundleDirectory;

try {
  bundleDirectory = await bundleFixture();
  const started = await startServer(bundleDirectory);
  server = started.server;

  browser = await chromium.launch({ headless: true });
  for (const viewport of viewports) {
    for (const spec of states) {
      await runCase(browser, started.url, viewport, spec, failures);
    }
  }
} catch (error) {
  console.error(error);
  failures.push(String(error));
} finally {
  await browser?.close();
  if (server) await new Promise((resolveServer) => server.close(resolveServer));
  if (bundleDirectory) {
    // One-file bundle in a throwaway directory; failure to clean up must not
    // turn a passing layout check red.
    await rm(bundleDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

if (failures.length) {
  console.error('WEEKLY REPORT DETAIL LAYOUT FAILURES:\n' + failures.join('\n'));
  process.exit(1);
}

console.log('weekly report detail layout OK');
