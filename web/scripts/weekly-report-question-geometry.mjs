/**
 * Weekly Report manager-question editor geometry smoke.
 *
 * Guards the layout regression where the preset rows used a bare native
 * checkbox inside a `.field-group`, so the generic `.field-group input`
 * text-control box stretched AntD's (visually hidden) checkbox input into a
 * large, misplaced hit area and pushed the box away from its prompt.
 *
 * Usage: node scripts/weekly-report-question-geometry.mjs
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(resolve(root, 'src/styles.css'), 'utf8');

const fixture = `<!doctype html>
<html lang="tr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>${css}</style>
  </head>
  <body>
    <div id="weekly-question-create-root"></div>
    <script type="module" src="/scripts/weekly-report-question-fixture.tsx"></script>
  </body>
</html>`;

const viewports = [
  { name: '390x844', width: 390, height: 844, compact: true },
  { name: '768x1024', width: 768, height: 1024, compact: false },
  { name: '1440x900', width: 1440, height: 900, compact: false },
];

// --control-height / AntD controlHeight is 44px (servora-visual-tokens), so
// AntD's controlInteractiveSize (controlHeight / 2) is 22px. The checkbox must
// keep that square size and must never take the text-control box.
const CONTROL_HEIGHT_PX = 44;
const MAX_CHECKBOX_SIZE_PX = CONTROL_HEIGHT_PX / 2 + 2;
// One control gap between the checkbox and its prompt.
const MIN_GAP_PX = 4;
const MAX_GAP_PX = 16;
const MIN_SEPARATION_PX = 8;

async function startServer() {
  const vite = await createViteServer({
    root,
    configFile: false,
    appType: 'custom',
    logLevel: 'error',
    server: { middlewareMode: true },
  });

  return new Promise((resolveServer) => {
    const server = createServer((req, res) => {
      const pathOnly = (req.url ?? '/').split('?')[0];
      if (pathOnly === '/' || pathOnly === '') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fixture);
        return;
      }
      vite.middlewares(req, res, () => {
        res.writeHead(404);
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolveServer({ server, vite, url: `http://127.0.0.1:${port}/` });
    });
  });
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

async function measureEditor(page, scopeSelector) {
  return page.evaluate((selector) => {
    const scope = document.querySelector(selector);
    if (!scope) return null;
    const rect = (element) => {
      const box = element.getBoundingClientRect();
      return {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        width: box.width,
        height: box.height,
      };
    };
    const rows = [...scope.querySelectorAll('.weekly-question-preset')];
    const rowMetrics = rows.map((row) => {
      // Prefix-agnostic hooks: the owned boundary renders `servora-ant-*` in
      // production while these class suffixes are stable AntD structure.
      // RcCheckbox renders <span class="*-checkbox"><input class="*-checkbox-input"/></span>.
      const input = row.querySelector('input[type="checkbox"]');
      const checkboxBox = input.parentElement;
      const label = row.querySelector('[class*="-checkbox-label"]');
      // Range rect = the TEXT only, excluding the label span's inline padding.
      const textRange = document.createRange();
      textRange.selectNodeContents(label);
      const text = rect(label);
      const textContent = textRange.getBoundingClientRect();
      const inputStyle = getComputedStyle(input);
      return {
        row: rect(row),
        box: rect(checkboxBox),
        label: text,
        text: {
          left: textContent.left,
          right: textContent.right,
          top: textContent.top,
          bottom: textContent.bottom,
          width: textContent.width,
          height: textContent.height,
        },
        input: rect(input),
        inputMinHeight: parseFloat(inputStyle.minHeight) || 0,
        inputPaddingLeft: parseFloat(inputStyle.paddingLeft) || 0,
        inputBorderTopWidth: parseFloat(inputStyle.borderTopWidth) || 0,
      };
    });
    const presets = scope.querySelector('.weekly-question-presets');
    const actionButton = scope.querySelector('.weekly-question-actions > button');
    return {
      rowCount: rows.length,
      rowMetrics,
      presets: presets ? rect(presets) : null,
      action: actionButton ? rect(actionButton) : null,
    };
  }, scopeSelector);
}

async function measureBulkActions(page) {
  return page.evaluate(() => {
    const container = document.querySelector('#weekly-staff-bulk-actions');
    if (!container) return null;
    const rect = (element) => {
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width };
    };
    const buttons = [...container.querySelectorAll('button')];
    const count = container.querySelector('#weekly-assignee-count');
    return {
      container: rect(container),
      buttons: buttons.map(rect),
      count: count ? rect(count) : null,
    };
  });
}

const sameLine = (a, b) => a.bottom > b.top + 1 && b.bottom > a.top + 1;

/** Visible separation between two boxes, whichever axis they are separated on. */
function separation(a, b) {
  if (sameLine(a, b)) return { axis: 'horizontal', value: b.left - a.right };
  return { axis: 'vertical', value: b.top - a.bottom };
}

function editorFailures(measurement, viewport, label) {
  const failures = [];
  if (!measurement) {
    failures.push(`${label}: editor root not found`);
    return failures;
  }
  if (measurement.rowCount !== 5) {
    failures.push(`${label}: expected 5 preset rows, got ${measurement.rowCount}`);
  }

  const rowHeights = measurement.rowMetrics.map((row) => row.row.height);
  const heightRange = Math.max(...rowHeights) - Math.min(...rowHeights);
  if (!viewport.compact && heightRange > 2) {
    failures.push(`${label}: inconsistent preset row rhythm (${heightRange.toFixed(2)}px)`);
  }

  measurement.rowMetrics.forEach((row, index) => {
    const id = `${label} row ${index + 1}`;
    const size = `${row.box.width.toFixed(1)}x${row.box.height.toFixed(1)}px`;
    // The checkbox keeps AntD's own square size.
    if (Math.abs(row.box.width - row.box.height) > 1) {
      failures.push(`${id}: checkbox is not square (${size})`);
    }
    if (row.box.width > MAX_CHECKBOX_SIZE_PX || row.box.height > MAX_CHECKBOX_SIZE_PX) {
      failures.push(`${id}: checkbox is ${size}, expected AntD's ${CONTROL_HEIGHT_PX / 2}px control`);
    }
    // Root cause: the generic text-control box must not reach the hidden input,
    // which would stretch its hit area far past the visible 22px square.
    if (row.input.height > row.box.height + 4 || row.input.width > row.box.width + 4) {
      failures.push(`${id}: checkbox input hit area ${row.input.width.toFixed(1)}x${row.input.height.toFixed(1)}px exceeds the ${size} box`);
    }
    if (row.inputMinHeight > row.box.height) {
      failures.push(`${id}: checkbox input min-height is ${row.inputMinHeight}px (text-control leak)`);
    }
    if (row.inputPaddingLeft > 0) {
      failures.push(`${id}: checkbox input carries ${row.inputPaddingLeft}px padding`);
    }
    if (row.inputBorderTopWidth > 0) {
      failures.push(`${id}: checkbox input carries a ${row.inputBorderTopWidth}px border`);
    }
    // The checkbox sits immediately left of its prompt.
    if (row.box.left - row.row.left > 2) {
      failures.push(`${id}: checkbox starts ${(row.box.left - row.row.left).toFixed(1)}px into the row`);
    }
    const gap = row.text.left - row.box.right;
    if (gap < MIN_GAP_PX || gap > MAX_GAP_PX) {
      failures.push(`${id}: checkbox/prompt gap is ${gap.toFixed(1)}px`);
    }
    // Vertically centered on the prompt, never detached onto its own line.
    const boxCenterY = row.box.top + row.box.height / 2;
    const textCenterY = row.text.top + row.text.height / 2;
    const centreDelta = Math.abs(boxCenterY - textCenterY);
    if (centreDelta > Math.max(4, row.text.height / 2)) {
      failures.push(`${id}: checkbox is ${centreDelta.toFixed(1)}px off the prompt centre`);
    }
    if (boxCenterY < row.text.top - 2 || boxCenterY > row.text.bottom + 2) {
      failures.push(`${id}: checkbox is vertically detached from its prompt`);
    }
    if (row.text.width <= 0) failures.push(`${id}: prompt text has no width`);
  });

  // "+ Özel soru ekle" is content width and left aligned, not a stretched grid item.
  if (!measurement.action || !measurement.presets) {
    failures.push(`${label}: add-custom action or presets container missing`);
  } else {
    if (measurement.action.width > measurement.presets.width * 0.6) {
      failures.push(`${label}: add-custom action is ${measurement.action.width.toFixed(1)}px wide (stretched)`);
    }
    if (Math.abs(measurement.action.left - measurement.presets.left) > 2) {
      failures.push(`${label}: add-custom action is not left aligned with the presets`);
    }
    if (measurement.action.right > measurement.presets.right + 1) {
      failures.push(`${label}: add-custom action overflows the form width`);
    }
  }
  return failures;
}

function bulkActionFailures(measurement, label) {
  const failures = [];
  if (!measurement) {
    failures.push(`${label}: staff bulk actions container not found`);
    return failures;
  }
  if (measurement.buttons.length !== 2) {
    failures.push(`${label}: expected 2 bulk action buttons, got ${measurement.buttons.length}`);
  }
  if (!measurement.count) {
    failures.push(`${label}: selection count missing`);
    return failures;
  }
  const sequence = [...measurement.buttons, measurement.count];
  sequence.slice(1).forEach((item, index) => {
    const previous = sequence[index];
    const { axis, value } = separation(previous, item);
    if (value < MIN_SEPARATION_PX) {
      failures.push(`${label}: adjacent controls are only ${value.toFixed(1)}px apart (${axis})`);
    }
  });
  if (measurement.count.right > measurement.container.right + 1) {
    failures.push(`${label}: selection count overflows its row`);
  }
  if (measurement.count.width <= 0) failures.push(`${label}: selection count has no width`);
  return failures;
}

async function runViewport(browser, baseUrl, viewport, failures) {
  const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
  const diagnostics = { pageErrors: [], consoleErrors: [], requestFailures: [], badResponses: [] };
  attachDiagnostics(page, diagnostics);
  try {
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-weekly-question-ready="true"]');
    await page.waitForSelector('#weekly-preset-questions input[type="checkbox"]');

    const overflowX = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    if (overflowX) failures.push(`${viewport.name}: horizontal overflow`);

    const create = await measureEditor(page, '#weekly-questions');
    const bulk = await measureBulkActions(page);
    console.log(JSON.stringify({
      viewport: viewport.name,
      overflowX,
      createRows: create?.rowCount ?? null,
      createBoxSizes: create?.rowMetrics.map((row) => `${row.box.width.toFixed(0)}x${row.box.height.toFixed(0)}`) ?? null,
      createGaps: create?.rowMetrics.map((row) => Number((row.text.left - row.box.right).toFixed(1))) ?? null,
      createInputBoxes: create?.rowMetrics.map((row) => `${row.input.width.toFixed(0)}x${row.input.height.toFixed(0)}`) ?? null,
      createInputMinHeights: create?.rowMetrics.map((row) => row.inputMinHeight) ?? null,
      createActionWidth: create?.action?.width ?? null,
      createPresetsWidth: create?.presets?.width ?? null,
      bulkSeparations: bulk
        ? [...bulk.buttons, bulk.count].slice(1).map((item, index) => {
          const previous = [...bulk.buttons, bulk.count][index];
          const { axis, value } = separation(previous, item);
          return `${axis}:${value.toFixed(1)}`;
        })
        : null,
    }));

    failures.push(...editorFailures(create, viewport, `${viewport.name} create`));
    failures.push(...bulkActionFailures(bulk, `${viewport.name} bulk`));

    await page.screenshot({
      path: join(tmpdir(), `servora-weekly-question-${viewport.name}.png`),
      fullPage: true,
    });

    if (viewport.name === '390x844') {
      // WCAG 400% reflow: no horizontal overflow, layout still coherent.
      await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
      const zoomed = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      console.log(JSON.stringify({ viewport: `${viewport.name}-200pct`, overflowX: zoomed }));
      if (zoomed) failures.push(`${viewport.name}-200pct: horizontal overflow`);
    }

    if (diagnostics.pageErrors.length || diagnostics.consoleErrors.length
      || diagnostics.requestFailures.length || diagnostics.badResponses.length) {
      failures.push(`${viewport.name}: page diagnostics ${JSON.stringify(diagnostics)}`);
    }
  } catch (error) {
    failures.push(`${viewport.name}: ${error}`);
    console.error(JSON.stringify({ viewport: viewport.name, diagnostics }, null, 2));
  } finally {
    if (!page.isClosed()) await page.close();
  }
}

const { server, vite, url } = await startServer();
const failures = [];
let browser;

try {
  await vite.transformRequest('/scripts/weekly-report-question-fixture.tsx');
  browser = await chromium.launch({ headless: true });
  for (const viewport of viewports) {
    await runViewport(browser, url, viewport, failures);
  }
} catch (error) {
  console.error(error);
  failures.push(String(error));
} finally {
  await browser?.close();
  server.close();
  await vite.close();
}

if (failures.length) {
  console.error('WEEKLY REPORT QUESTION GEOMETRY FAILURES:\n' + failures.join('\n'));
  process.exit(1);
}

console.log('weekly report question geometry OK');
