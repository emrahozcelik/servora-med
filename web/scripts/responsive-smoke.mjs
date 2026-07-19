/**
 * Real-shell responsive smoke (sidebar + filter region + board).
 * Usage: npm run smoke:responsive
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';

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
      <section class="report-workspace" aria-label="Teslim raporu responsive fixture" data-smoke-report>
        <h2>Teslim raporu</h2>
        <div id="responsive-operational-table-root"></div>
      </section>
      <section class="report-workspace" aria-label="Onay raporu responsive fixture" data-smoke-approval-report>
        <div id="responsive-approval-report-root"></div>
      </section>
      <section class="report-workspace" aria-label="Personel raporu responsive fixture" data-smoke-staff-report>
        <div id="responsive-staff-report-root"></div>
      </section>
      <section class="report-workspace" aria-label="Ortak durum bileşenleri responsive fixture" data-smoke-state-adapters>
        <div id="responsive-state-adapters-root"></div>
      </section>
      <section class="report-workspace" aria-label="Chart bileşenleri responsive fixture" data-smoke-charts>
        <div id="responsive-chart-fixture-root"></div>
      </section>
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
      <section class="job-detail" aria-label="İş detayı responsive fixture">
        <div class="servora-workflow-steps">Atandı → Uygulanıyor → Yönetici kontrolü</div>
        <section class="workflow-responsibility surface"><h2>Şimdi sizden beklenen</h2><p>Gerekli kayıtları tamamlayıp işi yönetici kontrolüne gönderin.</p></section>
        <div class="job-detail-content">
          <section class="detail-summary surface"><div id="responsive-descriptions-root"></div></section>
          <section class="delivery-lines"><h2>Teslim bilgileri</h2><p>ProSeal Membran · 2 kutu</p></section>
          <section class="workflow-requirements surface-flat"><h2>Kontrole hazırlık</h2><p>Ürün, amaç, miktar ve teslim zamanı</p></section>
          <section class="detail-action surface-flat" data-smoke-action><p>Kontrol sırasında kayıtlar salt okunur olur.</p><button class="primary-button">Kontrole gönder</button></section>
        </div>
        <section class="job-timeline" data-smoke-timeline><h2>İşlem geçmişi</h2><div id="responsive-timeline-root"></div></section>
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
<script type="module" src="/scripts/responsive-job-detail-fixture.tsx"></script>
<script type="module" src="/scripts/responsive-operational-table-fixture.tsx"></script>
<script type="module" src="/scripts/responsive-approval-report-fixture.tsx"></script>
<script type="module" src="/scripts/responsive-staff-report-fixture.tsx"></script>
<script type="module" src="/scripts/responsive-state-adapters-fixture.tsx"></script>
<script type="module" src="/scripts/responsive-chart-fixture.tsx"></script>
</body></html>`;

const viewports = [
  { name: '390x844', width: 390, height: 844 },
  { name: '720x900', width: 720, height: 900 },
  { name: '768x1024', width: 768, height: 1024 },
  { name: '1024x768', width: 1024, height: 768 },
  { name: '1440x900', width: 1440, height: 900 },
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
      if (req.url === '/') {
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
    const detail = document.querySelector('.job-detail');
    const detailContent = document.querySelector('.job-detail-content');
    const detailRect = detail?.getBoundingClientRect();
    const detailContentRect = detailContent?.getBoundingClientRect();
    const detailOverflow = Boolean(detailRect && detailContentRect
      && (detailContentRect.left < detailRect.left - 2 || detailContentRect.right > detailRect.right + 2));
    const detailCols = detailContent
      ? getComputedStyle(detailContent).gridTemplateColumns.trim().split(/\s+/).filter(Boolean).length
      : 0;
    const action = document.querySelector('[data-smoke-action]');
    const timeline = document.querySelector('[data-smoke-timeline]');
    const actionBeforeTimeline = Boolean(action && timeline
      && (action.compareDocumentPosition(timeline) & Node.DOCUMENT_POSITION_FOLLOWING));
    const summary = document.querySelector('.detail-summary');
    const descriptions = summary?.querySelector('.servora-record-descriptions');
    const summaryRect = summary?.getBoundingClientRect();
    const descriptionsRect = descriptions?.getBoundingClientRect();
    const summaryStyle = summary ? getComputedStyle(summary) : null;
    const summaryContentWidth = summaryRect && summaryStyle
      ? summaryRect.width
        - Number.parseFloat(summaryStyle.paddingLeft)
        - Number.parseFloat(summaryStyle.paddingRight)
      : 0;
    const descriptionsUseFullWidth = Boolean(summaryRect && descriptionsRect
      && descriptionsRect.width >= summaryContentWidth - 2);
    const timelineRoot = timeline?.querySelector('.servora-ant-timeline');
    const timelineArticle = timeline?.querySelector('.servora-activity-timeline article');
    const timelineRail = timeline?.querySelector('.servora-ant-timeline-item-rail');
    const timelineRect = timeline?.getBoundingClientRect();
    const articleRect = timelineArticle?.getBoundingClientRect();
    const timelineAdapterFits = Boolean(timelineRoot && timelineRect && articleRect
      && articleRect.left >= timelineRect.left - 2 && articleRect.right <= timelineRect.right + 2);
    const timelineRailIntact = Boolean(timelineRail
      && getComputedStyle(timelineRail).position === 'absolute');
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
    const reportRoot = document.querySelector('[data-servora-operational-table="true"]');
    const reportSection = document.querySelector('[data-smoke-report]');
    const desktopTable = reportRoot?.querySelector('.servora-operational-table__desktop');
    const mobileSurface = reportRoot?.querySelector('.servora-operational-table__mobile');
    const mobileCaption = reportRoot?.querySelector('.servora-operational-table__mobile-caption');
    const reportRect = reportSection?.getBoundingClientRect();
    const desktopRect = desktopTable?.getBoundingClientRect();
    const mobileRect = mobileSurface?.getBoundingClientRect();
    const desktopDisplay = desktopTable ? getComputedStyle(desktopTable).display : 'none';
    const mobileDisplay = mobileSurface ? getComputedStyle(mobileSurface).display : 'none';
    const desktopVisible = Boolean(desktopTable && desktopDisplay !== 'none');
    const mobileVisible = Boolean(mobileSurface && mobileDisplay !== 'none' && mobileDisplay !== 'contents');
    const captionVisible = Boolean(
      mobileCaption
      && getComputedStyle(mobileCaption).display !== 'none'
      && (mobileCaption.textContent ?? '').includes('birim kırılımları birleştirilmez'),
    );
    const reportOverflow = Boolean(reportRect && (
      (desktopVisible && desktopRect && (desktopRect.right > reportRect.right + 2 || desktopRect.left < reportRect.left - 2))
      || (mobileVisible && mobileRect && (mobileRect.right > reportRect.right + 2 || mobileRect.left < reportRect.left - 2))
    ));
    const mobileFieldCount = reportRoot
      ? reportRoot.querySelectorAll('.servora-operational-table__card:first-child .servora-operational-table__field').length
      : 0;
    const desktopColumnCount = reportRoot
      ? reportRoot.querySelectorAll('.servora-operational-table__desktop thead th').length
      : 0;
    const approvalSection = document.querySelector('[data-smoke-approval-report]');
    const approvalTable = approvalSection?.querySelector('[data-servora-operational-table="true"]');
    const approvalDesktop = approvalTable?.querySelector('.servora-operational-table__desktop');
    const approvalMobile = approvalTable?.querySelector('.servora-operational-table__mobile');
    const approvalSectionRect = approvalSection?.getBoundingClientRect();
    const approvalDesktopRect = approvalDesktop?.getBoundingClientRect();
    const approvalMobileRect = approvalMobile?.getBoundingClientRect();
    const approvalDesktopVisible = Boolean(approvalDesktop
      && getComputedStyle(approvalDesktop).display !== 'none');
    const approvalMobileDisplay = approvalMobile ? getComputedStyle(approvalMobile).display : 'none';
    const approvalMobileVisible = Boolean(approvalMobile
      && approvalMobileDisplay !== 'none' && approvalMobileDisplay !== 'contents');
    const approvalOverflow = Boolean(approvalSectionRect && (
      (approvalDesktopVisible && approvalDesktopRect
        && (approvalDesktopRect.right > approvalSectionRect.right + 2
          || approvalDesktopRect.left < approvalSectionRect.left - 2))
      || (approvalMobileVisible && approvalMobileRect
        && (approvalMobileRect.right > approvalSectionRect.right + 2
          || approvalMobileRect.left < approvalSectionRect.left - 2))
    ));
    const approvalDesktopValues = approvalTable
      ? Array.from(approvalTable.querySelectorAll(
        '.servora-operational-table__desktop tbody tr:first-child > *',
      )).map((cell) => cell.textContent?.trim() ?? '')
      : [];
    const approvalMobileValues = approvalTable
      ? Array.from(approvalTable.querySelectorAll(
        '.servora-operational-table__card:first-child dd',
      )).map((cell) => cell.textContent?.trim() ?? '')
      : [];
    const approvalLink = approvalTable?.querySelector('a[href="/jobs/smoke-approval-job"]');
    const staffSection = document.querySelector('[data-smoke-staff-report]');
    const staffSectionRect = staffSection?.getBoundingClientRect();
    const staffTables = staffSection
      ? Array.from(staffSection.querySelectorAll('[data-servora-operational-table="true"]'))
      : [];
    const staffTableMetrics = staffTables.map((table) => {
      const desktop = table.querySelector('.servora-operational-table__desktop');
      const mobile = table.querySelector('.servora-operational-table__mobile');
      const desktopRect = desktop?.getBoundingClientRect();
      const mobileRect = mobile?.getBoundingClientRect();
      const desktopVisible = Boolean(desktop && getComputedStyle(desktop).display !== 'none');
      const mobileDisplay = mobile ? getComputedStyle(mobile).display : 'none';
      const mobileVisible = Boolean(mobile
        && mobileDisplay !== 'none' && mobileDisplay !== 'contents');
      const desktopValues = Array.from(table.querySelectorAll(
        '.servora-operational-table__desktop tbody tr:first-child > *',
      )).map((cell) => cell.textContent?.trim() ?? '');
      const mobileValues = Array.from(table.querySelectorAll(
        '.servora-operational-table__card:first-child dd',
      )).map((cell) => cell.textContent?.trim() ?? '');
      const overflow = Boolean(staffSectionRect && (
        (desktopVisible && desktopRect
          && (desktopRect.right > staffSectionRect.right + 2
            || desktopRect.left < staffSectionRect.left - 2))
        || (mobileVisible && mobileRect
          && (mobileRect.right > staffSectionRect.right + 2
            || mobileRect.left < staffSectionRect.left - 2))
      ));
      return {
        desktopVisible,
        mobileVisible,
        overflow,
        desktopValues,
        mobileValues,
        caption: table.querySelector('caption')?.textContent?.trim() ?? '',
        rowHeader: table.querySelector('tbody th[scope="row"]')?.textContent?.trim() ?? '',
      };
    });
    const stateAdapterSection = document.querySelector('[data-smoke-state-adapters]');
    const stateAdapterSectionRect = stateAdapterSection?.getBoundingClientRect();
    const stateAdapters = stateAdapterSection
      ? Array.from(stateAdapterSection.querySelectorAll(
        '[data-servora-result-state], [data-servora-empty-state], [data-servora-loading-skeleton]',
      ))
      : [];
    const stateAdapterOverflow = stateAdapters.some((adapter) => {
      const rect = adapter.getBoundingClientRect();
      return Boolean(stateAdapterSectionRect
        && (rect.right > stateAdapterSectionRect.right + 2
          || rect.left < stateAdapterSectionRect.left - 2
          || adapter.scrollWidth > adapter.clientWidth + 2));
    });
    // Chart component measurements
    const chartSection = document.querySelector('[data-smoke-charts]');
    const chartSectionRect = chartSection?.getBoundingClientRect();
    const trendSection = chartSection?.querySelector('[data-smoke-chart-trend]');
    const calendarSection = chartSection?.querySelector('[data-smoke-chart-calendar]');
    const metersSection = chartSection?.querySelector('[data-smoke-chart-meters]');
    const segmentedSection = chartSection?.querySelector('[data-smoke-chart-segmented]');
    function sectionOverflows(section) {
      if (!section || !chartSectionRect) return false;
      const r = section.getBoundingClientRect();
      return r.right > chartSectionRect.right + 2 || r.left < chartSectionRect.left - 2
        || section.scrollWidth > section.clientWidth + 2;
    }
    const trendBarsEl = trendSection?.querySelector('[data-report-trend-bars="true"]');
    const trendBarsRect = trendBarsEl?.getBoundingClientRect();
    const trendSectionRect = trendSection?.getBoundingClientRect();
    const trendOverflow = Boolean(trendBarsRect && trendSectionRect
      && (
        trendBarsRect.right > trendSectionRect.right + 2
        || trendBarsRect.left < trendSectionRect.left - 2
        || (trendBarsEl?.scrollWidth ?? 0) > (trendBarsEl?.clientWidth ?? 0) + 2
      ));
    const calendarTables = calendarSection
      ? Array.from(calendarSection.querySelectorAll('.report-calendar-table'))
      : [];
    const calendarOverflow = calendarTables.some((table) => {
      if (!chartSectionRect) return false;
      const r = table.getBoundingClientRect();
      return r.right > chartSectionRect.right + 2
        || r.left < chartSectionRect.left - 2
        || table.scrollWidth > table.clientWidth + 2;
    });
    const metersEl = metersSection?.querySelector('[data-report-meters="true"]');
    const metersRect = metersEl?.getBoundingClientRect();
    const metersSectionRect = metersSection?.getBoundingClientRect();
    const metersOverflow = Boolean(metersRect && metersSectionRect
      && (metersRect.right > metersSectionRect.right + 2
        || metersRect.left < metersSectionRect.left - 2));
    const segmentedEl = segmentedSection?.querySelector('[data-report-segmented="true"]');
    const segmentedRect = segmentedEl?.getBoundingClientRect();
    const segmentedSectionRect = segmentedSection?.getBoundingClientRect();
    const segmentedOverflow = Boolean(segmentedRect && segmentedSectionRect
      && (segmentedRect.right > segmentedSectionRect.right + 2
        || segmentedRect.left < segmentedSectionRect.left - 2));
    const legendItems = segmentedSection
      ? Array.from(segmentedSection.querySelectorAll('.report-segmented-legend li'))
      : [];
    const legendOverflow = legendItems.some((item) => {
      if (!segmentedSectionRect) return false;
      const r = item.getBoundingClientRect();
      return r.right > segmentedSectionRect.right + 2
        || r.left < segmentedSectionRect.left - 2
        || item.scrollWidth > item.clientWidth + 2;
    });
    const meterLabels = metersSection
      ? Array.from(metersSection.querySelectorAll('.report-meter-label'))
      : [];
    const meterLabelOverflow = meterLabels.some((label) => {
      if (!metersSectionRect) return false;
      const r = label.getBoundingClientRect();
      return r.right > metersSectionRect.right + 2
        || r.left < metersSectionRect.left - 2
        || label.scrollWidth > label.clientWidth + 2;
    });
    return {
      overflowX,
      results,
      laneCardCols,
      visiblePreviewCards,
      boardWidth,
      detailOverflow,
      detailCols,
      actionBeforeTimeline,
      descriptionsUseFullWidth,
      timelineAdapterFits,
      timelineRailIntact,
      stickyVisible,
      stickyInViewport,
      sidebarVisible,
      reportPresent: Boolean(reportRoot),
      desktopVisible,
      mobileVisible,
      captionVisible,
      reportOverflow,
      mobileFieldCount,
      desktopColumnCount,
      approvalPresent: Boolean(approvalTable),
      approvalDesktopVisible,
      approvalMobileVisible,
      approvalOverflow,
      approvalDesktopValues,
      approvalMobileValues,
      approvalLinkName: approvalLink?.getAttribute('aria-label') ?? '',
      staffPresent: staffTableMetrics.length === 2,
      staffTables: staffTableMetrics,
      stateAdaptersPresent: stateAdapters.length === 3,
      stateAdapterOverflow,
      resultStateAnnounced: Boolean(stateAdapterSection?.querySelector(
        '[data-servora-result-state="true"][role="alert"]',
      )),
      emptyStateExplained: Boolean(stateAdapterSection?.querySelector(
        '[data-servora-empty-state="true"] h3',
      )),
      loadingSkeletonBusy: Boolean(stateAdapterSection?.querySelector(
        '[data-servora-loading-skeleton="true"] .servora-loading-skeleton__geometry[aria-busy="true"]',
      )),
      loadingSkeletonDecorative: Boolean(stateAdapterSection?.querySelector(
        '[data-servora-loading-skeleton="true"] [aria-hidden="true"] .servora-loading-skeleton__content',
      )),
      loadingStatusOutsideBusy: Boolean((() => {
        const status = stateAdapterSection?.querySelector(
          '[data-servora-loading-skeleton="true"] [role="status"]',
        );
        return status && !status.closest('[aria-busy="true"]');
      })()),
      loadingTitleVisible: Boolean((() => {
        const title = stateAdapterSection?.querySelector(
          '[data-servora-loading-skeleton="true"] .servora-loading-skeleton__title',
        );
        if (!title) return false;
        const style = getComputedStyle(title);
        const rect = title.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.height > 0;
      })()),
      stateActionVisible: Boolean(stateAdapterSection?.querySelector('button')),
      // Chart measurements
      chartsPresent: Boolean(chartSection),
      trendPresent: Boolean(trendBarsEl),
      trendOverflow,
      trendDensity: trendBarsEl?.getAttribute('data-density') ?? '',
      trendPointCount: Number(trendBarsEl?.getAttribute('data-point-count') ?? 0),
      calendarTableCount: calendarTables.length,
      calendarOverflow,
      metersPresent: Boolean(metersEl),
      metersOverflow,
      meterLabelOverflow,
      segmentedPresent: Boolean(segmentedEl),
      segmentedOverflow,
      legendOverflow,
      clientWidth: root.clientWidth,
      scrollWidth: root.scrollWidth,
    };
  });
}

const { server, vite, url } = await startServer();
const failures = [];
let browser;

/**
 * Wait for the chart fixture React components to actually mount.
 * [data-smoke-charts] is static HTML so it exists before React runs;
 * these selectors prove that each chart component has rendered its output.
 */
async function waitForChartFixtures(page) {
  await page.waitForSelector(
    '[data-report-trend-bars="true"][data-point-count="366"]',
  );
  await page.waitForSelector('[data-report-meters="true"]');
  await page.waitForSelector('[data-report-segmented="true"]');
  await page.waitForFunction(() =>
    document.querySelectorAll(
      '[data-smoke-chart-calendar] .report-calendar-table',
    ).length === 12,
  );
}

/**
 * Full chart contract: every component present, correct data shape, no overflow.
 * Used identically in normal, 200 %, and 400 % reflow blocks so a single
 * regression causes the same diagnostic message regardless of context.
 */
function chartContractFailed(m) {
  return (
    !m.chartsPresent
    || !m.trendPresent
    || m.trendDensity !== 'density-dense'
    || m.trendPointCount !== 366
    || m.calendarTableCount !== 12
    || !m.metersPresent
    || !m.segmentedPresent
    || m.trendOverflow
    || m.calendarOverflow
    || m.metersOverflow
    || m.meterLabelOverflow
    || m.segmentedOverflow
    || m.legendOverflow
  );
}

try {
  browser = await chromium.launch({ headless: true });
  for (const vp of viewports) {
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForSelector('.servora-ant-timeline');
    await page.waitForSelector('[data-servora-operational-table="true"]');
    await waitForChartFixtures(page);
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    const m = await measure(page);
    console.log(JSON.stringify({ viewport: vp.name, ...m }));
    if (m.overflowX) failures.push(`${vp.name}: horizontal overflow`);
    if (m.detailOverflow) failures.push(`${vp.name}: job detail exceeds its workspace`);
    if (!m.actionBeforeTimeline) failures.push(`${vp.name}: detail action must precede Timeline in DOM`);
    if (!m.reportPresent) failures.push(`${vp.name}: OperationalTable fixture missing`);
    if (m.reportOverflow) failures.push(`${vp.name}: OperationalTable exceeds report workspace`);
    if (!m.approvalPresent) failures.push(`${vp.name}: Approval OperationalTable fixture missing`);
    if (m.approvalOverflow) failures.push(`${vp.name}: Approval OperationalTable exceeds report workspace`);
    if (m.approvalLinkName !== 'Klinik kontrolü işini aç') {
      failures.push(`${vp.name}: Approval row link needs its accessible job name`);
    }
    if (JSON.stringify(m.approvalDesktopValues) !== JSON.stringify(m.approvalMobileValues)) {
      failures.push(`${vp.name}: Approval desktop/mobile field parity mismatch`);
    }
    if (!m.staffPresent) failures.push(`${vp.name}: Staff OperationalTable fixtures missing`);
    for (const table of m.staffTables) {
      if (table.overflow) failures.push(`${vp.name}: Staff OperationalTable exceeds report workspace`);
      if (JSON.stringify(table.desktopValues) !== JSON.stringify(table.mobileValues)) {
        failures.push(`${vp.name}: Staff desktop/mobile field parity mismatch`);
      }
      if (!table.caption || !table.rowHeader) {
        failures.push(`${vp.name}: Staff table needs caption and row header`);
      }
    }
    if (!m.stateAdaptersPresent || m.stateAdapterOverflow || !m.resultStateAnnounced
      || !m.emptyStateExplained || !m.loadingSkeletonBusy || !m.loadingSkeletonDecorative
      || !m.loadingStatusOutsideBusy || !m.loadingTitleVisible || !m.stateActionVisible) {
      failures.push(`${vp.name}: shared state adapter contract failure`);
    }
    if (vp.width <= 720) {
      if (m.desktopVisible) failures.push(`${vp.name}: OperationalTable desktop must be hidden at/under 720px`);
      if (!m.mobileVisible) failures.push(`${vp.name}: OperationalTable mobile must be visible at/under 720px`);
      if (!m.captionVisible) failures.push(`${vp.name}: mobile caption text must be visible`);
      if (m.mobileFieldCount !== 5) {
        failures.push(`${vp.name}: expected 5 mobile product fields (got ${m.mobileFieldCount})`);
      }
      if (m.approvalDesktopVisible || !m.approvalMobileVisible) {
        failures.push(`${vp.name}: Approval must use mobile cards at/under 720px`);
      }
      if (m.staffTables.some((table) => table.desktopVisible || !table.mobileVisible)) {
        failures.push(`${vp.name}: Staff must use mobile cards at/under 720px`);
      }
    }
    if (vp.width > 720) {
      if (!m.desktopVisible) failures.push(`${vp.name}: OperationalTable desktop must be visible above 720px`);
      if (m.mobileVisible) failures.push(`${vp.name}: OperationalTable mobile must be hidden above 720px`);
      if (m.desktopColumnCount !== 5) {
        failures.push(`${vp.name}: expected 5 desktop product columns (got ${m.desktopColumnCount})`);
      }
      if (!m.approvalDesktopVisible || m.approvalMobileVisible) {
        failures.push(`${vp.name}: Approval must use the desktop table above 720px`);
      }
      if (m.staffTables.some((table) => !table.desktopVisible || table.mobileVisible)) {
        failures.push(`${vp.name}: Staff must use desktop tables above 720px`);
      }
    }
    if ((vp.width === 390 || vp.width === 1024) && !m.descriptionsUseFullWidth) {
      failures.push(`${vp.name}: RecordDescriptions must use the full summary width`);
    }
    if ((vp.width === 390 || vp.width === 1024) && (!m.timelineAdapterFits || !m.timelineRailIntact)) {
      failures.push(`${vp.name}: real ActivityTimeline must fit without breaking its rail layout`);
    }
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
    const expectedDetailCols = vp.width < 1024 ? 1 : 2;
    if (m.detailCols !== expectedDetailCols) {
      failures.push(`${vp.name}: expected ${expectedDetailCols} detail columns (cols=${m.detailCols})`);
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
    if (!m.chartsPresent) {
      failures.push(`${vp.name}: chart fixture section missing`);
    } else {
      if (chartContractFailed(m)) {
        failures.push(
          `${vp.name}: chart contract failure — trendPresent:${m.trendPresent} density:${m.trendDensity}` +
          ` pts:${m.trendPointCount} calTables:${m.calendarTableCount}` +
          ` metersPresent:${m.metersPresent} segPresent:${m.segmentedPresent}` +
          ` trendOvf:${m.trendOverflow} calOvf:${m.calendarOverflow}` +
          ` meterOvf:${m.metersOverflow} labelOvf:${m.meterLabelOverflow}` +
          ` segOvf:${m.segmentedOverflow} legendOvf:${m.legendOverflow}`,
        );
      }
    }
    await page.close();
  }

  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForSelector('.servora-ant-timeline');
    await page.waitForSelector('[data-servora-operational-table="true"]');
    await waitForChartFixtures(page);
    await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    const m = await measure(page);
    console.log(JSON.stringify({ viewport: '390-200pct-font', ...m }));
    if (m.overflowX) failures.push('200% text: horizontal overflow');
    if (m.detailOverflow || m.detailCols !== 1 || !m.actionBeforeTimeline) {
      failures.push('200% text: job detail reflow failure');
    }
    if (m.reportOverflow || !m.mobileVisible || !m.captionVisible) {
      failures.push('200% text: OperationalTable mobile reflow failure');
    }
    if (m.approvalOverflow || !m.approvalMobileVisible
      || m.approvalLinkName !== 'Klinik kontrolü işini aç'
      || JSON.stringify(m.approvalDesktopValues) !== JSON.stringify(m.approvalMobileValues)) {
      failures.push('200% text: Approval mobile reflow failure');
    }
    if (!m.staffPresent || m.staffTables.some((table) => table.overflow
      || !table.mobileVisible || table.desktopVisible
      || JSON.stringify(table.desktopValues) !== JSON.stringify(table.mobileValues))) {
      failures.push('200% text: Staff mobile reflow failure');
    }
    if (!m.stateAdaptersPresent || m.stateAdapterOverflow || !m.resultStateAnnounced
      || !m.emptyStateExplained || !m.loadingSkeletonBusy || !m.loadingSkeletonDecorative
      || !m.loadingStatusOutsideBusy || !m.loadingTitleVisible || !m.stateActionVisible) {
      failures.push('200% text: shared state adapter reflow failure');
    }
    if (chartContractFailed(m)) failures.push('200% text: chart component contract failure');
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
    await page.waitForSelector('.servora-ant-timeline');
    await page.waitForSelector('[data-servora-operational-table="true"]');
    await waitForChartFixtures(page);
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    const m = await measure(page);
    console.log(JSON.stringify({ viewport: '320-wcag-400pct-reflow', ...m }));
    if (m.overflowX) failures.push('400% reflow: horizontal overflow');
    if (m.detailOverflow || m.detailCols !== 1 || !m.actionBeforeTimeline) {
      failures.push('400% reflow: job detail reflow failure');
    }
    if (m.reportOverflow || !m.mobileVisible || !m.captionVisible) {
      failures.push('400% reflow: OperationalTable mobile reflow failure');
    }
    if (m.approvalOverflow || !m.approvalMobileVisible
      || m.approvalLinkName !== 'Klinik kontrolü işini aç'
      || JSON.stringify(m.approvalDesktopValues) !== JSON.stringify(m.approvalMobileValues)) {
      failures.push('400% reflow: Approval mobile reflow failure');
    }
    if (!m.staffPresent || m.staffTables.some((table) => table.overflow
      || !table.mobileVisible || table.desktopVisible
      || JSON.stringify(table.desktopValues) !== JSON.stringify(table.mobileValues))) {
      failures.push('400% reflow: Staff mobile reflow failure');
    }
    if (!m.stateAdaptersPresent || m.stateAdapterOverflow || !m.resultStateAnnounced
      || !m.emptyStateExplained || !m.loadingSkeletonBusy || !m.loadingSkeletonDecorative
      || !m.loadingStatusOutsideBusy || !m.loadingTitleVisible || !m.stateActionVisible) {
      failures.push('400% reflow: shared state adapter reflow failure');
    }
    if (chartContractFailed(m)) failures.push('400% reflow: chart component contract failure');
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
  await vite.close();
}

if (failures.length) {
  console.error('SMOKE FAILURES:\n' + failures.join('\n'));
  process.exit(1);
}
console.log('responsive smoke OK');
