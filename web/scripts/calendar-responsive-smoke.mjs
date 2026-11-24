/**
 * Real-shell responsive smoke for the monthly Calendar mini-grid.
 * Usage: npm run smoke:responsive
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';

import { calendarScreenshotPath } from './calendar-responsive-screenshot-path.mjs';
import { assertNoSubMinimumText, collectSubMinimumText } from './min-text-size.mjs';

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
    <div id="calendar-responsive-root"></div>
    <script type="module" src="/scripts/calendar-responsive-fixture.tsx"></script>
  </body>
</html>`;

const viewports = [
  { name: '390x844', width: 390, height: 844, compact: true },
  { name: '420x844', width: 420, height: 844, compact: true },
  { name: '768x1024', width: 768, height: 1024, compact: false },
  { name: '1024x768', width: 1024, height: 768, compact: false },
  { name: '1440x900', width: 1440, height: 900, compact: false },
];

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
    if (message.type() === 'error' || message.type() === 'warning') {
      diagnostics.consoleErrors.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on('requestfailed', (request) => {
    diagnostics.requestFailures.push(
      `${request.url()} — ${request.failure()?.errorText ?? 'failed'}`,
    );
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      diagnostics.badResponses.push(`${response.status()} ${response.url()}`);
    }
  });
}

async function measure(page) {
  return page.evaluate(() => {
    const smokeRoot = document.querySelector('[data-calendar-smoke-ready="true"]');
    const calendarRoot = smokeRoot?.querySelector('.servora-calendar-root');
    const calendarFrame = calendarRoot?.getBoundingClientRect();
    const personnelFilter = smokeRoot?.querySelector('#calendar-personnel-filter');
    const personnelFilterFrame = personnelFilter?.getBoundingClientRect();
    const agenda = smokeRoot?.querySelector('.calendar-agenda-section');
    const agendaFrame = agenda?.getBoundingClientRect();
    const rows = [...(calendarRoot?.querySelectorAll('tbody tr') ?? [])];
    const rowCells = rows.map((row) => [...row.querySelectorAll('td')]);
    const cells = rowCells.flat();
    const rowHeights = rows.map((row) => row.getBoundingClientRect().height);
    const rowHeightRange = rowHeights.length
      ? Math.max(...rowHeights) - Math.min(...rowHeights)
      : Number.POSITIVE_INFINITY;
    const cellOverlaps = rowCells.some((row) => row.some((cell, index) => {
      const next = row[index + 1];
      if (!next) return false;
      const currentRect = cell.getBoundingClientRect();
      const nextRect = next.getBoundingClientRect();
      return currentRect.right > nextRect.left + 1;
    }));
    const count = [...(smokeRoot?.querySelectorAll('.servora-calendar-count') ?? [])]
      .find((candidate) => candidate.textContent?.trim() === '12');
    const countContent = count?.closest('[class*="picker-calendar-date-content"]');
    const countDateValue = count?.closest('[class*="picker-calendar-date"]')
      ?.querySelector('[class*="picker-calendar-date-value"]');
    const countRect = count?.getBoundingClientRect();
    const countDateValueRect = countDateValue?.getBoundingClientRect();
    const countDateOverlap = Boolean(countRect && countDateValueRect
      && countRect.left < countDateValueRect.right - 1
      && countRect.right > countDateValueRect.left + 1
      && countRect.top < countDateValueRect.bottom - 1
      && countRect.bottom > countDateValueRect.top + 1);
    const selectedCell = smokeRoot?.querySelector('[class*="picker-cell-selected"]');
    const todayCell = smokeRoot?.querySelector('[class*="picker-calendar-date-today"]');
    const headerButtons = [...(smokeRoot?.querySelectorAll('.servora-calendar-header button') ?? [])];
    const headerButtonsInFrame = headerButtons.every((button) => {
      if (!calendarFrame) return false;
      const rect = button.getBoundingClientRect();
      return rect.left >= calendarFrame.left - 1
        && rect.right <= calendarFrame.right + 1
        && rect.top >= calendarFrame.top - 1
        && rect.bottom <= calendarFrame.bottom + 1;
    });
    // UI audit F-10: month/today controls keep a 44 × 44 CSS px target.
    const headerButtonMinSize = headerButtons.length === 0 ? 0 : Math.min(...headerButtons.flatMap((button) => {
      const rect = button.getBoundingClientRect();
      return [rect.width, rect.height];
    }));
    const personnelFilterUsable = Boolean(personnelFilter && !personnelFilter.disabled
      && personnelFilterFrame && personnelFilterFrame.width > 0
      && personnelFilterFrame.left >= 0
      && personnelFilterFrame.right <= document.documentElement.clientWidth + 1);
    // C2 follow-up: the filter is a real 44px FormControl whose value text is
    // not painted against the border.
    const personnelFilterStyle = personnelFilter ? getComputedStyle(personnelFilter) : null;
    const personnelFilterHeight = personnelFilterFrame?.height ?? 0;
    const personnelFilterPaddingInline = personnelFilterStyle
      ? Math.min(
        parseFloat(personnelFilterStyle.paddingInlineStart),
        parseFloat(personnelFilterStyle.paddingInlineEnd),
      )
      : 0;
    const personnelFilterLabel = document.querySelector('label[for="calendar-personnel-filter"]')
      ?? personnelFilter?.closest('label');
    const personnelFilterLabelVisible = Boolean(personnelFilterLabel
      && personnelFilterLabel.getClientRects().length
      && personnelFilterLabel.textContent?.includes('Personel'));
    const agendaReachable = Boolean(agendaFrame && agendaFrame.width > 0 && agendaFrame.height > 0
      && agendaFrame.top >= 0
      && agendaFrame.bottom <= Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) + 1);
    const desktopSummaries = smokeRoot?.querySelectorAll('.servora-calendar-event-summary').length ?? 0;
    // Visual review (C1 follow-up): 12px chips must still show the time, a
    // visible source cue and about ten title characters without becoming
    // 44px pills inside the month cell.
    const eventChips = [...(smokeRoot?.querySelectorAll('.servora-calendar-event-summary') ?? [])].map((chip) => {
      const chipRect = chip.getBoundingClientRect();
      const label = chip.querySelector('.servora-calendar-event-label');
      const labelRect = label?.getBoundingClientRect();
      const labelText = label?.textContent ?? '';
      const probeLength = Math.min(10, labelText.length);
      let tenCharsOnOneLine = true;
      if (label && probeLength >= 10 && label.firstChild?.nodeType === 3) {
        const range = document.createRange();
        range.setStart(label.firstChild, 0);
        range.setEnd(label.firstChild, probeLength);
        const rects = [...range.getClientRects()];
        tenCharsOnOneLine = rects.length === 1 && rects[0].width <= (labelRect?.width ?? 0) + 1;
      }
      return {
        kind: chip.querySelector('.servora-calendar-event-kind')?.textContent?.trim() ?? null,
        kindTruncated: (() => {
          const kind = chip.querySelector('.servora-calendar-event-kind');
          return kind ? kind.scrollWidth > kind.clientWidth + 1 : true;
        })(),
        accessibleName: chip.getAttribute('aria-label'),
        chipHeight: Number(chipRect.height.toFixed(2)),
        minHeight: getComputedStyle(chip).minHeight,
        labelWidth: labelRect ? Number(labelRect.width.toFixed(2)) : 0,
        labelFontPixels: label ? Number.parseFloat(getComputedStyle(label).fontSize) : 0,
        lineClamp: label ? getComputedStyle(label).webkitLineClamp : null,
        tenCharsOnOneLine,
      };
    });
    // A taller chip must not be clipped by the cell's overflow.
    const clippedEventCells = [...(smokeRoot?.querySelectorAll('.servora-calendar-cell') ?? [])]
      .filter((cell) => {
        const events = cell.querySelector('.servora-calendar-events');
        if (!events) return false;
        const eventsRect = events.getBoundingClientRect();
        const cellRect = cell.getBoundingClientRect();
        return eventsRect.bottom > cellRect.bottom + 1;
      })
      .map((cell) => cell.getAttribute('data-date'));
    const dateButtons = [...(smokeRoot?.querySelectorAll('.servora-calendar-date') ?? [])];
    const maxDateButtonHeight = dateButtons.length
      ? Math.max(...dateButtons.map((button) => button.getBoundingClientRect().height))
      : 0;
    const dateButtonMinHeight = dateButtons.length ? getComputedStyle(dateButtons[0]).minHeight : null;
    const compactNativeDates = smokeRoot?.querySelectorAll('[class*="picker-calendar-date"]').length ?? 0;
    const nativeDateValues = smokeRoot?.querySelectorAll('[class*="picker-calendar-date-value"]').length ?? 0;

    return {
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      documentScrollWidth: document.documentElement.scrollWidth,
      documentClientWidth: document.documentElement.clientWidth,
      calendarWidth: calendarFrame?.width ?? null,
      rowCount: rows.length,
      rowCellCounts: rowCells.map((row) => row.length),
      rowHeightRange,
      cellCount: cells.length,
      cellOverlaps,
      hasSemanticRoot: Boolean(calendarRoot),
      hasSemanticItems: Boolean(smokeRoot?.querySelector('.servora-calendar-item')),
      customCompactCells: smokeRoot?.querySelectorAll('.servora-calendar-cell').length ?? 0,
      nativeSelected: Boolean(selectedCell),
      nativeToday: Boolean(todayCell),
      countText: count?.textContent?.trim() ?? null,
      countInsideNativeContent: Boolean(countContent),
      countDateOverlap,
      headerButtons: headerButtons.length,
      headerButtonsInFrame,
      headerButtonMinSize,
      personnelFilterUsable,
      personnelFilterHeight,
      personnelFilterPaddingInline,
      personnelFilterLabelVisible,
      agendaReachable,
      desktopSummaries,
      eventChips,
      maxDateButtonHeight: Number(maxDateButtonHeight.toFixed(2)),
      dateButtonMinHeight,
      clippedEventCells,
      compactNativeDates,
      nativeDateValues,
      selectedKey: smokeRoot?.querySelector('[data-calendar-state]')?.getAttribute('data-calendar-selected') ?? null,
      targetKey: smokeRoot?.querySelector('[data-calendar-state]')?.getAttribute('data-calendar-target') ?? null,
    };
  });
}

function contractFailures(measurement, viewport) {
  const failures = [];
  if (measurement.overflowX) failures.push('horizontal overflow');
  if (!measurement.hasSemanticRoot || !measurement.hasSemanticItems) failures.push('semantic calendar hooks missing');
  if (measurement.rowCount < 4 || measurement.rowCellCounts.some((count) => count !== 7)) {
    failures.push(`malformed seven-column grid (${JSON.stringify(measurement.rowCellCounts)})`);
  }
  if (measurement.cellCount !== measurement.rowCount * 7) failures.push('cell count mismatch');
  if (measurement.cellOverlaps) failures.push('adjacent calendar cells overlap');
  if (viewport.compact && measurement.rowHeightRange > 3) {
    failures.push(`uneven row rhythm (${measurement.rowHeightRange.toFixed(2)}px)`);
  }
  if (measurement.headerButtons !== 3 || !measurement.headerButtonsInFrame) {
    failures.push('calendar header controls leave the frame');
  }
  if (measurement.headerButtonMinSize < 44) {
    failures.push(`calendar header control below 44px target (${measurement.headerButtonMinSize.toFixed(1)}px)`);
  }
  if (!measurement.personnelFilterUsable) failures.push('personnel filter is not usable');
  if (measurement.personnelFilterHeight < 43.5) {
    failures.push(`personnel filter below the 44px control height (${measurement.personnelFilterHeight.toFixed(1)}px)`);
  }
  if (measurement.personnelFilterPaddingInline < 8) {
    failures.push(`personnel filter value has no inline inset (${measurement.personnelFilterPaddingInline}px)`);
  }
  if (!measurement.personnelFilterLabelVisible) failures.push('personnel filter label is not visible');
  if (!measurement.agendaReachable) failures.push('agenda is not reachable');

  if (viewport.compact) {
    if (measurement.customCompactCells !== 0) failures.push('custom compact cell replaced native geometry');
    if (!measurement.nativeSelected || !measurement.nativeToday) failures.push('native selected/today state missing');
    if (measurement.countText !== '12' || !measurement.countInsideNativeContent) {
      failures.push('two-digit count decoration missing or misplaced');
    }
    if (measurement.countDateOverlap) failures.push('event count overlaps native date value');
    if (measurement.desktopSummaries !== 0) failures.push('desktop event summaries leaked into compact mode');
    if (measurement.compactNativeDates < 28 || measurement.nativeDateValues < 28) {
      failures.push('native compact date content missing');
    }
  } else if (measurement.desktopSummaries < 3) {
    failures.push('desktop rich event summaries missing');
  }

  if (!viewport.compact && measurement.desktopSummaries >= 3) {
    // The global 44px button floor must not stretch in-cell controls.
    if (measurement.dateButtonMinHeight !== '0px') {
      failures.push(`day number keeps a min-height floor (${measurement.dateButtonMinHeight})`);
    }
    if (measurement.maxDateButtonHeight > 24) {
      failures.push(`day number stretched into a ${measurement.maxDateButtonHeight}px pill`);
    }
    for (const chip of measurement.eventChips) {
      if (chip.minHeight !== '0px') failures.push(`event chip keeps a min-height floor (${chip.minHeight})`);
      if (chip.chipHeight > 50) failures.push(`event chip grew into a ${chip.chipHeight}px block`);
      if (chip.labelFontPixels < 12) failures.push(`event label type below 12px (${chip.labelFontPixels}px)`);
      if (!['İş', 'Plan'].includes(chip.kind)) failures.push('event source cue missing from the chip');
      if (chip.kindTruncated) failures.push('event source cue is truncated in the chip');
      if (!/İş|Kişisel plan/.test(chip.accessibleName ?? '')) failures.push('event source missing from the accessible name');
      if (chip.lineClamp !== '2') failures.push('event label is not two-line clamped');
    }
    // Wide desktop is the reviewed surface: about ten title characters must stay visible.
    if (viewport.width >= 1440 && measurement.eventChips.some((chip) => !chip.tenCharsOnOneLine)) {
      failures.push('event label shows fewer than ten characters at 1440');
    }
    if (measurement.clippedEventCells.length > 0) {
      failures.push(`event chips clipped by their cell (${measurement.clippedEventCells.join(', ')})`);
    }
  }

  return failures;
}

async function exerciseSelection(page, targetKey) {
  // AntD renders the mini-calendar day value zero-padded ("01".."31"); match
  // the exact rendered text instead of stripping the leading zero, which made
  // single-digit targets (day 1..9 of the month) unmatchable and broke the
  // selection exercise whenever the resolved target fell in 1..9.
  const targetDay = targetKey.slice(-2);
  const targetCell = page.locator(
    `[class*="picker-cell-in-view"]:has([class*="picker-calendar-date-value"]:text-is("${targetDay}"))`,
  ).first();
  await targetCell.click();
  await page.waitForFunction(
    (expected) => document.querySelector('[data-calendar-state]')?.getAttribute('data-calendar-selected') === expected,
    targetKey,
  );
}

async function runViewport(browser, baseUrl, viewport, failures) {
  const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
  const diagnostics = { pageErrors: [], consoleErrors: [], requestFailures: [], badResponses: [] };
  attachDiagnostics(page, diagnostics);
  try {
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-calendar-smoke-ready="true"]');
    await page.waitForSelector('.servora-calendar-root');
    await page.waitForFunction(() => document.querySelectorAll('tbody tr td').length >= 28);

    const measurement = await measure(page);
    console.log(JSON.stringify({ viewport: viewport.name, ...measurement }));
    const viewportFailures = contractFailures(measurement, viewport);
    failures.push(...viewportFailures.map((failure) => `${viewport.name}: ${failure}`));

    await page.screenshot({ path: calendarScreenshotPath(viewport.name), fullPage: true });
    try {
      assertNoSubMinimumText(
        await page.evaluate(collectSubMinimumText, { min: 12 }),
        `${viewport.name}: calendar text floor`,
      );
    } catch (error) {
      failures.push(error.message);
    }

    if (viewport.compact) {
      await exerciseSelection(page, measurement.targetKey);
      const selectedKey = await page.locator('[data-calendar-state]').getAttribute('data-calendar-selected');
      if (selectedKey !== measurement.targetKey) {
        failures.push(`${viewport.name}: native cell selection did not update selected date`);
      }
    }

    if (viewport.name === '390x844') {
      await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
      const zoomed = await measure(page);
      console.log(JSON.stringify({ viewport: `${viewport.name}-200pct`, ...zoomed }));
      if (zoomed.overflowX) failures.push(`${viewport.name}-200pct: horizontal overflow`);
      if (!zoomed.personnelFilterUsable || !zoomed.agendaReachable) {
        failures.push(`${viewport.name}-200pct: filter or agenda reflow failure`);
      }
    }

    await page.close();

    if (viewport.name === '390x844') {
      const reflowPage = await browser.newPage({ viewport: { width: 320, height: 844 } });
      const reflowDiagnostics = { pageErrors: [], consoleErrors: [], requestFailures: [], badResponses: [] };
      attachDiagnostics(reflowPage, reflowDiagnostics);
      try {
        await reflowPage.goto(baseUrl, { waitUntil: 'networkidle' });
        await reflowPage.waitForSelector('.servora-calendar-root');
        const reflow = await measure(reflowPage);
        console.log(JSON.stringify({ viewport: '320-wcag-400pct-reflow', ...reflow }));
        if (reflow.overflowX) failures.push('320-wcag-400pct-reflow: horizontal overflow');
        failures.push(...contractFailures(reflow, { ...viewport, name: '320-wcag-400pct-reflow' })
          .map((failure) => `320-wcag-400pct-reflow: ${failure}`));
      } finally {
        await reflowPage.close();
      }
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
  await vite.transformRequest('/scripts/calendar-responsive-fixture.tsx');
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
  console.error('CALENDAR RESPONSIVE SMOKE FAILURES:\n' + failures.join('\n'));
  process.exit(1);
}

console.log('calendar responsive smoke OK');
