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
    <div class="brand-lockup"><span class="dunya-dental-brand dunya-dental-brand--sidebar" aria-label="Dünya Dental"><img alt="" src="/branding/dunya-dental.png"></span></div>
    <nav class="shell-nav" aria-label="Ana navigasyon">
      <a href="/jobs" aria-current="page">İşler</a>
      <a href="/customers">Müşteriler</a>
      <a href="/products">Ürünler</a>
      <a href="/reports">Raporlar</a>
      <a href="/staff">Personel</a>
    </nav>
  </aside>
  <header class="desktop-shell-topbar" style="display:none" id="desktop-topbar">
    <button class="shell-notification-trigger" type="button" aria-label="Bildirimler"><svg class="shell-notification-icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /></svg></button>
  </header>
  <header class="compact-shell-header mobile-top-bar" style="display:none" id="mobile-topbar">
    <div class="mobile-top-bar-start">
      <span class="dunya-dental-brand dunya-dental-brand--topbar" aria-label="Dünya Dental"><img alt="" src="/branding/dunya-dental.png"></span>
      <p class="mobile-shell-title">İşlerim</p>
    </div>
    <div class="mobile-top-bar-actions">
      <button class="shell-notification-trigger" type="button" aria-label="Bildirimler"><svg class="shell-notification-icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /></svg></button>
      <button class="shell-menu-button" type="button">Menü</button>
    </div>
  </header>
  <nav class="mobile-bottom-nav" id="mobile-bottom-nav" style="display:none" aria-label="Mobil ana navigasyon">
    <a class="mobile-bottom-nav-item mobile-bottom-nav-item--active" href="/jobs" aria-current="page">İşler</a>
    <a class="mobile-bottom-nav-item" href="/customers">Müşteriler</a>
    <a class="mobile-bottom-nav-item" href="/products">Ürünler</a>
    <a class="mobile-bottom-nav-item" href="/staff">Profilim</a>
  </nav>
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
      <section class="report-workspace" aria-label="Bildirim merkezi responsive fixture" data-smoke-notification>
        <div id="responsive-notification-center-root"></div>
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
          <section class="detail-action surface-flat" data-smoke-action><p class="start-location-notice">İşi başlattığınızda cihazınızdan bir kez yaklaşık konum alınmaya çalışılır. Konum, iş başlangıcını operasyonel olarak kayıt altına almak amacıyla yetkili kullanıcıların görebildiği iş geçmişinde saklanır. Konum alınamazsa iş yine başlar.</p><button class="primary-button">İşi başlat</button></section>
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
    const desktopTopbar = document.getElementById('desktop-topbar');
    const mobileTopbar = document.getElementById('mobile-topbar');
    const sticky = document.getElementById('sticky-create');
    const panel = document.getElementById('sticky-panel');
    const bottomNav = document.getElementById('mobile-bottom-nav');
    if (desktop) {
      shell.classList.add('authenticated-shell--desktop');
      shell.classList.remove('authenticated-shell--mobile');
      sidebar.style.display = 'flex';
      desktopTopbar.style.display = 'flex';
      mobileTopbar.style.display = 'none';
      if (bottomNav) bottomNav.style.display = 'none';
      sticky.style.display = 'none';
      panel.style.display = 'none';
    } else {
      shell.classList.remove('authenticated-shell--desktop');
      shell.classList.add('authenticated-shell--mobile');
      sidebar.style.display = 'none';
      desktopTopbar.style.display = 'none';
      mobileTopbar.style.display = 'flex';
      if (bottomNav) bottomNav.style.display = 'grid';
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
<script type="module" src="/scripts/responsive-notification-center-fixture.tsx"></script>
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
    const notificationSection = document.querySelector('[data-smoke-notification]');
    const notificationPanel = notificationSection?.querySelector('[role="dialog"]');
    const notificationPanelRect = notificationPanel?.getBoundingClientRect();
    const notificationOverflow = Boolean(notificationPanelRect && (
      notificationPanelRect.left < -2 || notificationPanelRect.right > window.innerWidth + 2
      || notificationPanelRect.top < -2 || notificationPanelRect.bottom > window.innerHeight + 2
    ));
    const notificationHeading = notificationPanel?.querySelector('.notification-center-heading h2');
    const notificationClose = notificationPanel?.querySelector('.notification-center-heading .drawer-close');
    const notificationHeadingRect = notificationHeading?.getBoundingClientRect();
    const notificationCloseRect = notificationClose?.getBoundingClientRect();
    const notificationItem = notificationPanel?.querySelector('.notification-center-item');
    const notificationItemRect = notificationItem?.getBoundingClientRect();
    const notificationRowOverflow = Boolean(notificationItem && (
      notificationItem.scrollWidth > notificationItem.clientWidth + 1
      || (notificationItemRect && notificationPanelRect
        && (notificationItemRect.left < notificationPanelRect.left - 2
          || notificationItemRect.right > notificationPanelRect.right + 2))
    ));
    const notificationPanelHOverflow = Boolean(
      notificationPanel && notificationPanel.scrollWidth > notificationPanel.clientWidth + 1,
    );
    const notificationHeadingCloseClear = Boolean(
      notificationHeadingRect
      && notificationCloseRect
      && !(
        notificationHeadingRect.right > notificationCloseRect.left + 2
        && notificationHeadingRect.left < notificationCloseRect.right - 2
        && notificationHeadingRect.bottom > notificationCloseRect.top + 2
        && notificationHeadingRect.top < notificationCloseRect.bottom - 2
      ),
    );
    const notificationPanelContract = Boolean(
      notificationPanelRect
      && !notificationOverflow
      && !notificationPanelHOverflow
      && notificationHeadingRect
      && notificationHeadingRect.width > 0
      && notificationCloseRect
      && notificationCloseRect.left >= -2
      && notificationCloseRect.right <= window.innerWidth + 2
      && notificationHeadingCloseClear
      && !notificationRowOverflow
      && (
        notificationPanelRect.width <= window.innerWidth - 8
        || notificationPanel.classList.contains('notification-center-panel--mobile')
      )
      && notificationPanelRect.height <= window.innerHeight + 2,
    );
    const desktopTopbar = document.getElementById('desktop-topbar');
    const mobileTopbar = document.getElementById('mobile-topbar');
    const activeTopbar = getComputedStyle(desktopTopbar).display !== 'none' ? desktopTopbar : mobileTopbar;
    const topbarRect = activeTopbar?.getBoundingClientRect();
    const topbarBrand = activeTopbar?.querySelector('.dunya-dental-brand');
    const topbarAction = activeTopbar?.querySelector('[aria-label="Bildirimler"]');
    const topbarActionRect = topbarAction?.getBoundingClientRect();
    const topbarIconRect = topbarAction?.querySelector('.shell-notification-icon')?.getBoundingClientRect();
    const topbarMenu = activeTopbar?.querySelector('.shell-menu-button');
    const topbarMenuRect = topbarMenu?.getBoundingClientRect();
    const topbarTitle = activeTopbar?.querySelector('.mobile-shell-title');
    const topbarTitleRect = topbarTitle?.getBoundingClientRect();
    const topbarActions = activeTopbar?.querySelector('.mobile-top-bar-actions');
    const topbarActionsRect = topbarActions?.getBoundingClientRect();
    const topbarBrandRequired = activeTopbar === mobileTopbar;
    const rectsIntersect = (a, b) => Boolean(
      a && b
      && a.right > b.left + 2
      && a.left < b.right - 2
      && a.bottom > b.top + 2
      && a.top < b.bottom - 2,
    );
    const rectInViewport = (r) => Boolean(
      r
      && r.left >= -2
      && r.right <= window.innerWidth + 2
      && r.top >= -2
      && r.bottom <= window.innerHeight + 2,
    );
    const topbarContract = Boolean(topbarRect && (!topbarBrandRequired || topbarBrand) && topbarActionRect
      && topbarRect.left >= -2 && topbarRect.right <= window.innerWidth + 2
      && topbarActionRect.right <= window.innerWidth + 2
      && topbarActionRect.left >= topbarRect.left - 2
      && topbarIconRect
      && Math.abs((topbarIconRect.left + topbarIconRect.width / 2)
        - (topbarActionRect.left + topbarActionRect.width / 2)) <= 2
      && (
        activeTopbar !== mobileTopbar
        || (
          rectInViewport(topbarMenuRect)
          && topbarTitleRect
          && topbarTitleRect.width > 0
          && topbarActionsRect
          && !rectsIntersect(topbarTitleRect, topbarActionsRect)
        )
      ));
    const bottomNav = document.getElementById('mobile-bottom-nav');
    const bottomNavVisible = Boolean(
      bottomNav
      && getComputedStyle(bottomNav).display !== 'none'
      && bottomNav.style.display !== 'none',
    );
    const bottomNavRect = bottomNavVisible ? bottomNav.getBoundingClientRect() : null;
    const stickyCreate = document.getElementById('sticky-create');
    const stickyCreateVisible = Boolean(
      stickyCreate
      && stickyCreate.style.display !== 'none'
      && getComputedStyle(stickyCreate).display !== 'none',
    );
    const stickyCreateRect = stickyCreateVisible ? stickyCreate.getBoundingClientRect() : null;
    const mobileChromeContract = activeTopbar !== mobileTopbar || Boolean(
      topbarContract
      && bottomNavVisible
      && rectInViewport(bottomNavRect)
      && (
        !stickyCreateVisible
        || (stickyCreateRect && bottomNavRect && stickyCreateRect.bottom <= bottomNavRect.top + 2
          && !rectsIntersect(stickyCreateRect, bottomNavRect))
      ),
    );
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
    const requirements = document.querySelector('.workflow-requirements');
    const requirementsRect = requirements?.getBoundingClientRect();
    const secondaryRecordRect = document.querySelector(
      '.delivery-lines, .job-detail-records',
    )?.getBoundingClientRect();
    const desktopSidePanelBackfillsFirstRow = Boolean(
      requirementsRect && secondaryRecordRect
      && requirementsRect.top < secondaryRecordRect.top - 2,
    );
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
    const sidebarRect = sidebar?.getBoundingClientRect();
    const sidebarBrandRect = sidebar?.querySelector('.dunya-dental-brand--sidebar img')?.getBoundingClientRect();
    const sidebarBrandFitted = !sidebarVisible || Boolean(sidebarRect && sidebarBrandRect
      && sidebarBrandRect.width >= 140
      && sidebarBrandRect.left >= sidebarRect.left - 2
      && sidebarBrandRect.right <= sidebarRect.right + 2);
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
      desktopSidePanelBackfillsFirstRow,
      actionBeforeTimeline,
      descriptionsUseFullWidth,
      timelineAdapterFits,
      timelineRailIntact,
      stickyVisible,
      stickyInViewport,
      sidebarVisible,
      sidebarBrandFitted,
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
      notificationPresent: Boolean(notificationPanel),
      notificationOverflow,
      notificationPanelContract,
      notificationHeadingWidth: notificationHeadingRect?.width ?? 0,
      notificationHeadingCloseClear,
      notificationRowOverflow,
      notificationPanelHOverflow,
      notificationItems: notificationSection?.querySelectorAll('[data-notification-id]').length ?? 0,
      notificationLoadMore: Boolean(notificationSection?.querySelector('.notification-center-more')),
      notificationBadge: notificationSection?.querySelector('.notification-center-badge')?.textContent ?? '',
      notificationMobile: notificationPanel?.classList.contains('notification-center-panel--mobile') ?? false,
      topbarContract,
      mobileChromeContract,
      mobileTitleWidth: topbarTitleRect?.width ?? 0,
      mobileMenuInViewport: activeTopbar !== mobileTopbar || rectInViewport(topbarMenuRect),
      mobileBottomNavInViewport: activeTopbar !== mobileTopbar || rectInViewport(bottomNavRect),
      stickyClearOfBottomNav: activeTopbar !== mobileTopbar || !stickyCreateVisible
        || Boolean(stickyCreateRect && bottomNavRect && stickyCreateRect.bottom <= bottomNavRect.top + 2
          && !rectsIntersect(stickyCreateRect, bottomNavRect)),
      notificationSettingsPresent: Boolean(notificationSection?.querySelector('.notification-settings')),
      notificationManualGuidance: (() => {
        const text = notificationSection?.textContent ?? '';
        // Desktop/Firefox/Safari manual install + iOS Home Screen note (no beforeinstallprompt).
        return text.includes('Siteyi yükle')
          && text.includes('Ana Ekrana Ekle')
          && (text.includes('iPhone') || text.includes('iPad'));
      })(),
      notificationPushDisabled: notificationSection?.textContent?.includes('Cihaz bildirimleri şu anda kullanıma kapalıdır.') ?? false,
      notificationSettingsOverflow: (() => {
        const settings = notificationSection?.querySelector('.notification-settings');
        if (!settings) return false;
        return settings.scrollWidth > settings.clientWidth + 1;
      })(),
      notificationSettingsHeadingVisible: Boolean(
        notificationSection?.querySelector('.notification-settings h3')
          && (() => {
            const h = notificationSection.querySelector('.notification-settings h3');
            const r = h?.getBoundingClientRect();
            return Boolean(r && r.height > 0 && r.width > 0);
          })(),
      ),
      notificationLoadingVisible: notificationSection?.textContent?.includes('Cihaz bildirimi durumu yükleniyor…') ?? false,
      notificationErrorVisible: Boolean(notificationSection?.querySelector('.notification-device-push-error, .form-error[role="alert"]')),
      notificationErrorOverflow: (() => {
        const err = notificationSection?.querySelector('.notification-device-push-error, .notification-device-push .form-error');
        if (!err) return false;
        return err.scrollWidth > err.clientWidth + 1;
      })(),
      notificationActionVisible: Boolean(notificationSection?.querySelector('.notification-device-push-action')),
      notificationActionDisabled: Boolean(
        notificationSection?.querySelector('.notification-device-push-action')?.hasAttribute('disabled'),
      ),
      notificationDeniedVisible: notificationSection?.textContent?.includes('Bildirim izni kapalı') ?? false,
      notificationUnsupportedVisible:
        (notificationSection?.textContent?.includes('Bu tarayıcı cihaz bildirimlerini desteklemiyor')
          || notificationSection?.textContent?.includes('Ana Ekrana ekleyip')) ?? false,
      notificationRenewalVisible: notificationSection?.textContent?.includes('aboneliği yenilenmeli') ?? false,
      notificationLongCopyFits: (() => {
        const section = notificationSection?.querySelector('.notification-device-push');
        const copy = section?.querySelector('.notification-device-push-copy')
          ?? section?.querySelector('p');
        const panel = notificationSection?.querySelector('[role="dialog"]');
        if (!copy || !panel) return true;
        const c = copy.getBoundingClientRect();
        const p = panel.getBoundingClientRect();
        // Bounds must remain inside the dialog panel (scrollWidth can exceed
        // clientWidth slightly under large text zoom even when CSS wraps).
        return c.left >= p.left - 2
          && c.right <= p.right + 2
          && c.width > 0
          && c.height > 0;
      })(),
      notificationFocusInsideDialog: (() => {
        const dialog = notificationSection?.querySelector('[role="dialog"]');
        const active = document.activeElement;
        return Boolean(dialog && active && dialog.contains(active));
      })(),
      clientWidth: root.clientWidth,
      scrollWidth: root.scrollWidth,
    };
  });
}

const PUSH_STATES = [
  'loading',
  'disabled',
  'denied',
  'install-required',
  'enabled-not-subscribed',
  'enabled-subscribed',
  'pending-enable',
  'pending-disable',
  'long-error',
  'renewal-required',
];

function pushStateContractFailed(state, m) {
  if (!m.notificationSettingsPresent || m.notificationOverflow || m.notificationSettingsOverflow) return true;
  if (!m.notificationSettingsHeadingVisible || !m.notificationLongCopyFits) return true;
  if (!m.notificationFocusInsideDialog) return true;
  switch (state) {
    case 'loading':
      return !m.notificationLoadingVisible || m.notificationActionVisible;
    case 'disabled':
      return !m.notificationPushDisabled || m.notificationActionVisible;
    case 'denied':
      return !m.notificationDeniedVisible || m.notificationActionVisible;
    case 'install-required':
    case 'unsupported':
      return !m.notificationUnsupportedVisible || m.notificationActionVisible;
    case 'enabled-not-subscribed':
      return !m.notificationActionVisible || m.notificationActionDisabled;
    case 'enabled-subscribed':
      return !m.notificationActionVisible || m.notificationActionDisabled;
    case 'pending-enable':
    case 'pending-disable':
      return !m.notificationActionVisible || !m.notificationActionDisabled;
    case 'long-error':
      return !m.notificationErrorVisible || m.notificationErrorOverflow;
    case 'renewal-required':
      return !m.notificationRenewalVisible || !m.notificationActionVisible;
    default:
      return false;
  }
}

async function openNotificationSettings(page) {
  await page.waitForSelector('[data-smoke-notification] [role="dialog"]');
  const hasSettings = await page.$('[data-smoke-notification] .notification-settings');
  if (!hasSettings) {
    await page.click('[data-smoke-notification] .notification-settings-trigger');
    await page.waitForSelector('[data-smoke-notification] .notification-settings');
  }
}

async function measurePushState(page, baseUrl, state) {
  const sep = baseUrl.includes('?') ? '&' : '?';
  await page.goto(`${baseUrl}${sep}pushState=${state}`, { waitUntil: 'load' });
  await page.waitForSelector('[data-smoke-notification-center]');
  await openNotificationSettings(page);
  return measure(page);
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
    await page.waitForSelector('[data-smoke-notification] [role="dialog"]');
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
    if (vp.width >= 1024 && !m.desktopSidePanelBackfillsFirstRow) {
      failures.push(`${vp.name}: Staff detail side panel must backfill the first grid row`);
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
    if (!m.notificationPresent || m.notificationOverflow || m.notificationItems !== 2
      || !m.notificationLoadMore || m.notificationBadge !== '123'
      || m.notificationMobile !== (vp.width < 1024)) {
      failures.push(`${vp.name}: notification center responsive contract failure`);
    }
    if ([390, 1024, 1440].includes(vp.width) && !m.notificationPanelContract) {
      failures.push(
        `${vp.name}: notification panel geometry failure`
        + ` hW=${m.notificationHeadingWidth}`
        + ` closeClear=${m.notificationHeadingCloseClear}`
        + ` rowOvf=${m.notificationRowOverflow}`
        + ` panelHOvf=${m.notificationPanelHOverflow}`,
      );
    }
    if (!m.topbarContract) failures.push(`${vp.name}: branding topbar contract failure`);
    if (vp.width < 1024 && !m.mobileChromeContract) {
      failures.push(
        `${vp.name}: mobile chrome geometry failure`
        + ` titleW=${m.mobileTitleWidth}`
        + ` menuIn=${m.mobileMenuInViewport}`
        + ` bottomIn=${m.mobileBottomNavInViewport}`
        + ` stickyClear=${m.stickyClearOfBottomNav}`,
      );
    }
    if (!m.sidebarBrandFitted) failures.push(`${vp.name}: sidebar brand fit failure`);
    await page.click('[data-smoke-notification] .notification-settings-trigger');
    await page.waitForSelector('[data-smoke-notification] .notification-settings');
    const settings = await measure(page);
    if (!settings.notificationSettingsPresent || settings.notificationOverflow
      || !settings.notificationManualGuidance || !settings.notificationPushDisabled) {
      failures.push(`${vp.name}: install settings responsive contract failure`);
    }
    for (const state of PUSH_STATES) {
      const stateMeasure = await measurePushState(page, url, state);
      console.log(JSON.stringify({ viewport: vp.name, pushState: state, ...stateMeasure }));
      if (pushStateContractFailed(state, stateMeasure) || stateMeasure.overflowX) {
        failures.push(`${vp.name}: push settings state ${state} contract failure`);
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
    await page.waitForSelector('[data-smoke-notification] [role="dialog"]');
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
    if (!m.notificationPresent || m.notificationOverflow || !m.notificationMobile) {
      failures.push('200% text: notification center reflow failure');
    }
    if (!m.notificationPanelContract || m.notificationHeadingWidth <= 0 || !m.notificationHeadingCloseClear) {
      failures.push(
        '200% text: notification panel geometry failure'
        + ` hW=${m.notificationHeadingWidth}`
        + ` closeClear=${m.notificationHeadingCloseClear}`
        + ` rowOvf=${m.notificationRowOverflow}`,
      );
    }
    if (!m.topbarContract) failures.push('200% text: branding topbar reflow failure');
    if (!m.mobileChromeContract) {
      failures.push(
        '200% text: mobile chrome geometry failure'
        + ` titleW=${m.mobileTitleWidth}`
        + ` menuIn=${m.mobileMenuInViewport}`
        + ` bottomIn=${m.mobileBottomNavInViewport}`
        + ` stickyClear=${m.stickyClearOfBottomNav}`,
      );
    }
    await page.click('[data-smoke-notification] .notification-settings-trigger');
    await page.waitForSelector('[data-smoke-notification] .notification-settings');
    const settings = await measure(page);
    if (!settings.notificationSettingsPresent || settings.notificationOverflow
      || !settings.notificationManualGuidance || !settings.notificationPushDisabled) {
      failures.push('200% text: install settings reflow failure');
    }
    for (const state of ['long-error', 'denied', 'pending-enable']) {
      const sep = url.includes('?') ? '&' : '?';
      await page.goto(`${url}${sep}pushState=${state}`, { waitUntil: 'load' });
      await page.waitForSelector('[data-smoke-notification-center]');
      await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
      await openNotificationSettings(page);
      const rem = await measure(page);
      console.log(JSON.stringify({ viewport: '390-200pct-font', pushState: state, ...rem }));
      if (
        rem.overflowX
        || rem.notificationOverflow
        || rem.notificationSettingsOverflow
        || rem.notificationErrorOverflow
        || !rem.notificationSettingsPresent
        || (state === 'long-error' && !rem.notificationErrorVisible)
        || (state === 'denied' && !rem.notificationDeniedVisible)
        || (state === 'pending-enable' && (!rem.notificationActionVisible || !rem.notificationActionDisabled))
      ) {
        failures.push(`200% text: push state ${state} reflow failure`);
      }
    }
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
    await page.waitForSelector('[data-smoke-notification] [role="dialog"]');
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
    if (!m.notificationPresent || m.notificationOverflow || !m.notificationMobile
      || m.notificationItems !== 2 || !m.notificationLoadMore) {
      failures.push('400% reflow: notification center reflow failure');
    }
    if (!m.topbarContract) failures.push('400% reflow: branding topbar reflow failure');
    await page.click('[data-smoke-notification] .notification-settings-trigger');
    await page.waitForSelector('[data-smoke-notification] .notification-settings');
    const settings = await measure(page);
    if (!settings.notificationSettingsPresent || settings.notificationOverflow
      || !settings.notificationManualGuidance || !settings.notificationPushDisabled) {
      failures.push('400% reflow: install settings reflow failure');
    }
    for (const state of ['long-error', 'install-required', 'pending-enable']) {
      const rem = await measurePushState(page, url, state);
      if (pushStateContractFailed(state, rem) || rem.overflowX || rem.notificationSettingsOverflow) {
        failures.push(`400% reflow: push state ${state} failure`);
      }
      console.log(JSON.stringify({ viewport: '320-wcag-400pct-reflow', pushState: state, ...rem }));
    }
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
