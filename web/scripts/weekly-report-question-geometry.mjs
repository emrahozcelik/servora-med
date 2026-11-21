/**
 * Weekly Report manager-question editor geometry smoke.
 *
 * Guards the custom-question editor layout and the staff bulk-actions row
 * across mobile, tablet and desktop viewports (WR-WEEK D6: no preset checkboxes).
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
  { name: '390x844', width: 390, height: 844 },
  { name: '768x1024', width: 768, height: 1024 },
  { name: '1440x900', width: 1440, height: 900 },
];

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
    const presetCheckboxes = scope.querySelectorAll('input[type="checkbox"]').length;
    const customRows = [...scope.querySelectorAll('.field-row')].map((row) => {
      const input = row.querySelector('input');
      const remove = row.querySelector('button');
      return {
        row: rect(row),
        input: input ? rect(input) : null,
        remove: remove ? rect(remove) : null,
      };
    });
    const actionButton = scope.querySelector('.weekly-question-actions > button');
    return {
      scope: rect(scope),
      presetCheckboxes,
      customRows,
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

function separation(a, b) {
  if (sameLine(a, b)) return { axis: 'horizontal', value: b.left - a.right };
  return { axis: 'vertical', value: b.top - a.bottom };
}

function editorFailures(measurement, label) {
  const failures = [];
  if (!measurement) {
    failures.push(`${label}: editor root not found`);
    return failures;
  }
  if (measurement.presetCheckboxes !== 0) {
    failures.push(`${label}: expected 0 preset checkboxes, got ${measurement.presetCheckboxes}`);
  }
  if (measurement.customRows.length !== 1) {
    failures.push(`${label}: expected 1 custom question row, got ${measurement.customRows.length}`);
  }
  for (const row of measurement.customRows) {
    if (!row.input || row.input.height < 44) {
      failures.push(`${label}: custom question input below 44px height`);
    }
    if (row.input && row.input.right > measurement.scope.right + 1) {
      failures.push(`${label}: custom question input overflows scope`);
    }
    if (!row.remove || row.remove.height < 44) {
      failures.push(`${label}: remove button below 44px height`);
    }
  }
  if (!measurement.action) {
    failures.push(`${label}: add-custom action missing`);
  } else {
    if (measurement.action.width > measurement.scope.width * 0.6) {
      failures.push(`${label}: add-custom action is ${measurement.action.width.toFixed(1)}px wide (stretched)`);
    }
    if (Math.abs(measurement.action.left - measurement.scope.left) > 2) {
      failures.push(`${label}: add-custom action is not left aligned with the editor`);
    }
    if (measurement.action.right > measurement.scope.right + 1) {
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
    await page.waitForSelector('#weekly-add-custom-question');

    const overflowX = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    if (overflowX) failures.push(`${viewport.name}: horizontal overflow`);

    const create = await measureEditor(page, '#weekly-questions');
    const bulk = await measureBulkActions(page);
    console.log(JSON.stringify({
      viewport: viewport.name,
      overflowX,
      presetCheckboxes: create?.presetCheckboxes ?? null,
      customRows: create?.customRows.length ?? null,
      createActionWidth: create?.action?.width ?? null,
      createScopeWidth: create?.scope?.width ?? null,
      bulkSeparations: bulk
        ? [...bulk.buttons, bulk.count].slice(1).map((item, index) => {
          const previous = [...bulk.buttons, bulk.count][index];
          const { axis, value } = separation(previous, item);
          return `${axis}:${value.toFixed(1)}`;
        })
        : null,
    }));

    failures.push(...editorFailures(create, `${viewport.name} create`));
    failures.push(...bulkActionFailures(bulk, `${viewport.name} bulk`));

    await page.screenshot({
      path: join(tmpdir(), `servora-weekly-question-${viewport.name}.png`),
      fullPage: true,
    });

    if (viewport.name === '390x844') {
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
