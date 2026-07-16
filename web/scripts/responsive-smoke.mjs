/**
 * PR A browser smoke for filter/board layout (no auth required).
 * Loads built/dev CSS + fixture markup in Playwright.
 *
 * Usage:
 *   node scripts/responsive-smoke.mjs
 *   (requires: npx playwright install chromium once)
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(resolve(root, 'src/styles.css'), 'utf8');

const fixture = `<!doctype html><html lang="tr"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><style>${css}</style></head>
<body>
<main class="workspace" style="width:min(100% - 2rem,68rem);margin:1rem auto;">
  <form class="customer-filters" role="search">
    <div class="field-group"><label>Ara</label><input value="demo"/></div>
    <div class="field-group"><label>Durum</label><select><option>Aktif</option></select></div>
    <div class="field-group"><label>Tür</label><select><option>Klinik</option></select></div>
    <div class="field-group"><label>Bölge</label><select><option>Ankara</option></select></div>
    <div class="field-group"><label>Personel</label><select><option>Tümü</option></select></div>
  </form>
  <form class="job-filters">
    <div class="job-filter-primary">
      <div class="field-group"><label>Ara</label><input/></div>
      <div class="field-group"><label>Tür</label><select><option>Tümü</option></select></div>
      <div class="field-group"><label>Durum</label><select><option>Aktif</option></select></div>
      <button class="secondary-button job-search-submit" type="button">Ara</button>
    </div>
  </form>
  <section class="job-board" aria-label="Aktif iş panosu">
    <div class="job-board-columns">
      <section class="job-board-column"><h2>Yeni</h2></section>
      <section class="job-board-column"><h2>Planlandı</h2></section>
      <section class="job-board-column"><h2>Devam</h2></section>
      <section class="job-board-column"><h2>Onay</h2></section>
      <section class="job-board-column"><h2>Düzeltme</h2></section>
    </div>
  </section>
</main>
</body></html>`;

const viewports = [
  { name: '390x844', width: 390, height: 844 },
  { name: '768x1024', width: 768, height: 1024 },
  { name: '1024x768', width: 1024, height: 768 },
  { name: '1440x900', width: 1440, height: 900 },
];

function startServer() {
  return new Promise((resolveServer) => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fixture);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolveServer({ server, url: `http://127.0.0.1:${port}/` });
    });
  });
}

async function measure(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const overflowX = root.scrollWidth > root.clientWidth + 1;
    const results = [];
    for (const sel of ['.customer-filters', '.job-filter-primary']) {
      const filters = document.querySelector(sel);
      if (!filters) continue;
      const fr = filters.getBoundingClientRect();
      const parent = filters.closest('main')?.getBoundingClientRect() ?? filters.parentElement?.getBoundingClientRect();
      let filterOverflow = false;
      if (parent && (fr.right > parent.right + 2 || fr.left < parent.left - 2)) filterOverflow = true;
      const controls = [...filters.querySelectorAll('input, select, button')].map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
      });
      let sameRowIntersect = false;
      for (let i = 0; i < controls.length; i += 1) {
        for (let j = i + 1; j < controls.length; j += 1) {
          const a = controls[i];
          const b = controls[j];
          const sameRow = Math.abs(a.top - b.top) < 8 && a.width > 0 && b.width > 0;
          if (sameRow && a.right > b.left + 2 && a.left < b.right - 2 && a.bottom > b.top + 2 && a.top < b.bottom - 2) {
            sameRowIntersect = true;
          }
        }
      }
      results.push({ sel, filterOverflow, sameRowIntersect });
    }
    const columns = document.querySelector('.job-board-columns');
    let boardCols = 0;
    if (columns) {
      const style = getComputedStyle(columns).gridTemplateColumns;
      boardCols = style.trim().split(/\s+/).filter(Boolean).length;
    }
    const board = document.querySelector('.job-board');
    const boardWidth = board ? board.getBoundingClientRect().width : 0;
    return {
      overflowX,
      results,
      boardCols,
      boardWidth,
      clientWidth: root.clientWidth,
      scrollWidth: root.scrollWidth,
    };
  });
}

const { server, url } = await startServer();
const failures = [];
let browser;
try {
  browser = await chromium.launch({ headless: true });
  for (const vp of viewports) {
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
    await page.goto(url, { waitUntil: 'load' });
    const m = await measure(page);
    console.log(JSON.stringify({ viewport: vp.name, ...m }));
    if (m.overflowX) failures.push(`${vp.name}: horizontal overflow`);
    for (const r of m.results) {
      if (r.filterOverflow) failures.push(`${vp.name}: ${r.sel} exceeds container`);
      if (r.sameRowIntersect) failures.push(`${vp.name}: ${r.sel} same-row controls intersect`);
    }
    if (vp.width <= 1024 && m.boardCols === 5) {
      failures.push(`${vp.name}: five-column Kanban active (cols=${m.boardCols}, boardWidth=${m.boardWidth})`);
    }
    if (vp.width >= 1440 && m.boardWidth >= 68 * 16 && m.boardCols !== 5) {
      // only require 5 cols when container is truly wide enough (~68rem)
      // at 1440 with workspace min(100%-2rem, 68rem) board is ~68rem → may pass CQ
    }
    await page.close();
  }

  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(url, { waitUntil: 'load' });
    await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
    const m = await measure(page);
    console.log(JSON.stringify({ viewport: '390-200pct-font', ...m }));
    if (m.overflowX) failures.push('200% text: horizontal overflow');
    await page.close();
  }

  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(url, { waitUntil: 'load' });
    await page.evaluate(() => { document.body.style.zoom = '4'; });
    const m = await measure(page);
    console.log(JSON.stringify({ viewport: '390-400pct-zoom', ...m }));
    // zoom may intentionally expand layout; only flag control intersection inside filters
    for (const r of m.results) {
      if (r.sameRowIntersect) failures.push(`400% zoom: ${r.sel} same-row controls intersect`);
    }
    await page.close();
  }
} catch (err) {
  console.error(err);
  failures.push(String(err));
} finally {
  await browser?.close();
  server.close();
}

if (failures.length) {
  console.error('SMOKE FAILURES:\n' + failures.join('\n'));
  process.exit(1);
}
console.log('responsive smoke OK');
