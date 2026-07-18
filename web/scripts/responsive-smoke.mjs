/**
 * Real-shell responsive smoke (sidebar + filter region + board).
 * Usage: npm run smoke:responsive
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
<div class="authenticated-shell authenticated-shell--desktop" id="shell">
  <aside class="shell-sidebar" style="display:none" id="sidebar">
    <div class="brand-lockup"><span class="brand-mark">S</span><span>Servora-Med</span></div>
    <nav class="shell-nav" aria-label="Ana navigasyon">
      <a href="/jobs" aria-current="page">İşler</a>
      <a href="/customers">Müşteriler</a>
      <a href="/products">Ürünler</a>
      <a href="/reports">Raporlar</a>
      <a href="/staff">Personel</a>
    </nav>
  </aside>
  <div class="shell-content">
    <main class="workspace" style="width:min(100% - 2rem,68rem);margin:1rem auto;">
      <div class="filter-region">
        <form class="customer-filters surface" role="search">
          <div class="field-group"><label>Ara</label><input value="demo"/></div>
          <div class="field-group"><label>Durum</label><select><option>Aktif</option></select></div>
          <div class="field-group"><label>Tür</label><select><option>Klinik</option></select></div>
          <div class="field-group"><label>Şehir</label><select><option>Ankara</option></select></div>
          <div class="field-group"><label>Personel</label><select><option>Tümü</option></select></div>
        </form>
      </div>
      <div class="filter-region">
        <form class="job-filters surface">
          <div class="job-filter-primary">
            <div class="field-group"><label>Ara</label><input/></div>
            <div class="field-group"><label>Tür</label><select><option>Tümü</option></select></div>
            <div class="field-group"><label>Durum</label><select><option>Aktif</option></select></div>
            <button class="secondary-button job-search-submit" type="button">Ara</button>
          </div>
        </form>
      </div>
      <div class="filter-region">
        <form class="report-filters report-filters-wide">
          <label>Başlangıç<input type="date"/></label>
          <label>Bitiş<input type="date"/></label>
          <label>Personel<select><option>Tümü</option></select></label>
          <label>Amaç<select><option>Tümü</option></select></label>
          <button type="button" class="secondary-button">Uygula</button>
        </form>
      </div>
      <section class="job-board" aria-label="Aktif iş panosu">
        <div class="workflow-board">
          <section class="workflow-lane"><header class="workflow-lane-heading"><h2>Hazırlanıyor</h2><a class="workflow-lane-link" href="#">Tümünü gör</a></header>
            <ul class="workflow-lane-cards">
              <li><article class="job-board-card"><a href="#"><strong>İş 1</strong></a></article></li>
              <li><article class="job-board-card"><a href="#"><strong>İş 2</strong></a></article></li>
              <li><article class="job-board-card"><a href="#"><strong>İş 3</strong></a></article></li>
              <li><article class="job-board-card"><a href="#"><strong>İş 4</strong></a></article></li>
            </ul>
          </section>
        </div>
      </section>
      <div class="sticky-new-job" id="sticky-create" style="display:none">
        <div class="new-job-menu">
          <button type="button" class="primary-button compact-button new-job-menu-trigger">Yeni iş</button>
          <div class="new-job-menu-panel surface-raised new-job-menu-panel--sheet" id="sticky-panel" style="display:none">
            <button type="button" class="new-job-menu-item">Yeni görüşme</button>
            <button type="button" class="new-job-menu-item">Yeni görev</button>
            <button type="button" class="new-job-menu-item">Yeni teslim</button>
          </div>
        </div>
      </div>
    </main>
  </div>
</div>
<script>
  function applyLayout() {
    const w = window.innerWidth;
    const desktop = w >= 1024; // 64rem at 16px
    const shell = document.getElementById('shell');
    const sidebar = document.getElementById('sidebar');
    const sticky = document.getElementById('sticky-create');
    const panel = document.getElementById('sticky-panel');
    if (desktop) {
      shell.classList.add('authenticated-shell--desktop');
      shell.classList.remove('authenticated-shell--mobile');
      sidebar.style.display = 'flex';
      sticky.style.display = 'none';
      panel.style.display = 'none';
    } else {
      shell.classList.remove('authenticated-shell--desktop');
      shell.classList.add('authenticated-shell--mobile');
      sidebar.style.display = 'none';
      sticky.style.display = 'flex';
      // sticky always uses sheet presentation when open in product; open for measure at tablet
      if (w >= 641 && w < 1024) panel.style.display = 'grid';
      else panel.style.display = 'none';
    }
  }
  applyLayout();
  window.addEventListener('resize', applyLayout);
</script>
</body></html>`;

const viewports = [
  { name: '390x844', width: 390, height: 844 },
  { name: '768x1024', width: 768, height: 1024 },
  { name: '1024x768', width: 1024, height: 768 },
  { name: '1440x900', width: 1440, height: 900 },
];

function startServer() {
  return new Promise((resolveServer) => {
    const server = createServer((_req, res) => {
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
    for (const sel of ['.customer-filters', '.job-filter-primary', '.report-filters-wide']) {
      const filters = document.querySelector(sel);
      if (!filters) continue;
      const fr = filters.getBoundingClientRect();
      const regionEl = filters.closest('.filter-region');
      const region = regionEl?.getBoundingClientRect()
        ?? filters.closest('main')?.getBoundingClientRect();
      // Container must be an ancestor, not the same node as the grid target.
      const containerIsAncestor = Boolean(regionEl && regionEl !== filters);
      let filterOverflow = false;
      if (region && (fr.right > region.right + 2 || fr.left < region.left - 2)) filterOverflow = true;
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
      const cols = getComputedStyle(filters).gridTemplateColumns.trim().split(/\s+/).filter(Boolean).length;
      results.push({
        sel, filterOverflow, sameRowIntersect, cols, width: fr.width,
        regionWidth: region?.width ?? 0, containerIsAncestor,
      });
    }
    const laneCards = document.querySelector('.workflow-lane-cards');
    let laneCardCols = 0;
    let visiblePreviewCards = 0;
    if (laneCards) {
      laneCardCols = getComputedStyle(laneCards).gridTemplateColumns.trim().split(/\s+/).filter(Boolean).length;
      visiblePreviewCards = Array.from(laneCards.children)
        .filter((item) => getComputedStyle(item).display !== 'none').length;
    }
    const board = document.querySelector('.job-board');
    const boardWidth = board ? board.getBoundingClientRect().width : 0;
    const stickyPanel = document.getElementById('sticky-panel');
    let stickyVisible = false;
    let stickyInViewport = true;
    if (stickyPanel && stickyPanel.style.display !== 'none') {
      stickyVisible = true;
      const r = stickyPanel.getBoundingClientRect();
      stickyInViewport = r.top >= 0 && r.bottom <= window.innerHeight + 1 && r.left >= 0 && r.right <= window.innerWidth + 1;
    }
    const sidebar = document.getElementById('sidebar');
    const sidebarVisible = sidebar && getComputedStyle(sidebar).display !== 'none';
    return {
      overflowX,
      results,
      laneCardCols,
      visiblePreviewCards,
      boardWidth,
      stickyVisible,
      stickyInViewport,
      sidebarVisible,
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
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    const m = await measure(page);
    console.log(JSON.stringify({ viewport: vp.name, ...m }));
    if (m.overflowX) failures.push(`${vp.name}: horizontal overflow`);
    for (const r of m.results) {
      if (r.filterOverflow) failures.push(`${vp.name}: ${r.sel} exceeds filter-region`);
      if (r.sameRowIntersect) failures.push(`${vp.name}: ${r.sel} same-row controls intersect`);
    }
    if (vp.width === 1024) {
      if (!m.sidebarVisible) failures.push(`${vp.name}: sidebar should be visible`);
      for (const r of m.results) {
        if (!r.containerIsAncestor) {
          failures.push(`${vp.name}: ${r.sel} filter-region must be ancestor container`);
        }
        if (r.cols > 1 && r.regionWidth < 52 * 16) {
          failures.push(`${vp.name}: ${r.sel} multi-col in narrow region (${r.regionWidth}px, cols=${r.cols})`);
        }
        if (r.sel === '.report-filters-wide' && r.cols !== 1) {
          failures.push(`${vp.name}: report-filters-wide must be single column under sidebar (cols=${r.cols})`);
        }
      }
    }
    if (vp.width < 1024 && m.laneCardCols !== 1) {
      failures.push(`${vp.name}: compact lane cards must be one column (cols=${m.laneCardCols})`);
    }
    if (vp.width === 1024 && m.laneCardCols !== 3) {
      failures.push(`${vp.name}: expected 3 lane cards at desktop shell width (cols=${m.laneCardCols})`);
    }
    if (vp.width >= 1440 && m.boardWidth >= 68 * 16 && m.laneCardCols !== 4) {
      failures.push(`${vp.name}: expected 4 lane cards when container is wide (cols=${m.laneCardCols}, boardWidth=${m.boardWidth})`);
    }
    const expectedPreviewCards = vp.width < 1024 ? 2 : vp.width < 1440 ? 3 : 4;
    if (m.visiblePreviewCards !== expectedPreviewCards) {
      failures.push(`${vp.name}: expected ${expectedPreviewCards} visible preview cards (visible=${m.visiblePreviewCards})`);
    }
    if (vp.width >= 641 && vp.width < 1024 && m.stickyVisible && !m.stickyInViewport) {
      failures.push(`${vp.name}: sticky Yeni iş sheet panel outside viewport`);
    }
    await page.close();
  }

  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(url, { waitUntil: 'load' });
    await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    const m = await measure(page);
    console.log(JSON.stringify({ viewport: '390-200pct-font', ...m }));
    if (m.overflowX) failures.push('200% text: horizontal overflow');
    for (const r of m.results) {
      if (r.filterOverflow || r.sameRowIntersect) failures.push(`200% text: ${r.sel} layout failure`);
    }
    await page.close();
  }

  {
    // WCAG 1.4.10 reflow evidence: 400% on 1280 CSS px ≈ 320 CSS px width.
    // Prefer viewport reflow over document.zoom (zoom distorts getBoundingClientRect).
    const page = await browser.newPage({ viewport: { width: 320, height: 256 } });
    await page.goto(url, { waitUntil: 'load' });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    const m = await measure(page);
    console.log(JSON.stringify({ viewport: '320-wcag-400pct-reflow', ...m }));
    if (m.overflowX) failures.push('400% reflow: horizontal overflow');
    for (const r of m.results) {
      if (r.filterOverflow || r.sameRowIntersect) {
        failures.push(`400% reflow: ${r.sel} layout failure`);
      }
      if (r.cols !== 1) failures.push(`400% reflow: ${r.sel} expected 1 col (cols=${r.cols})`);
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
