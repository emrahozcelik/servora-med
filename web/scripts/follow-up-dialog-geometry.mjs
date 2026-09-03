/**
 * Follow-up workflow dialog geometry acceptance (Slice C).
 *
 * Serves a faithful static replica of the Staff submit-for-approval dialog
 * (ReasonDialog > JobWorkflowDialog prelude > FollowUpProposalSection, staff
 * mode, expanded editors to force overflow) inside the real mobile shell
 * (top bar + bottom nav AFTER the dialog, matching AppShell DOM order),
 * styled with the repository styles.css. No backend, no production.
 *
 * Asserts with DOM geometry (never screenshots alone) and reports each
 * dimension separately so an unsupported input can never pass as success:
 * - PROGRAMMATIC_SCROLL: PASS/FAIL
 * - USER_STYLE_SCROLL: PASS/FAIL/NOT_SUPPORTED
 * - CTA_RECT (CTA bottom <= nav top): PASS/FAIL
 * - CTA_HIT_TARGET (positive CTA identity): PASS/FAIL
 * - HORIZONTAL_OVERFLOW: PASS/FAIL
 *
 * Usage: node scripts/follow-up-dialog-geometry.mjs
 * Requires: playwright chromium + webkit browsers installed.
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';

import { userStyleScroll } from './follow-up-dialog-geometry-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(resolve(root, 'src/styles.css'), 'utf8');

const fixture = `<!doctype html><html lang="tr"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<style>${css}</style></head>
<body>
<div class="authenticated-shell authenticated-shell--mobile">
  <header class="compact-shell-header mobile-top-bar">
    <div class="mobile-top-bar-start"><p class="mobile-shell-title">İş detayı</p></div>
  </header>
  <div class="shell-content"><main class="job-detail"><p>İş içeriği (arka plan)</p></main></div>
  <div class="dialog-backdrop product-dialog-backdrop">
    <div class="workflow-dialog reason-dialog product-dialog" role="dialog" aria-modal="true" aria-labelledby="d-title" tabindex="-1" id="dialog">
      <h2 id="d-title">İşi kontrole göndermek üzeresiniz</h2>
      <p>İş yönetici kontrolüne geçecek ve kontrol sona erene kadar kayıtlar düzenlenemeyecektir. Takip işi planı zorunludur. Ek açıklama metni kaydırma davranışını zorlamak için uzatıldı. İkinci cümle. Üçüncü cümle. Dördüncü cümle.</p>
      <section class="follow-up-proposal-card" aria-label="Takip işi planı">
        <div class="follow-up-proposal-heading"><h3>Takip işi planı</h3><span class="follow-up-proposal-badge">ÖNERİLEN</span></div>
        <p class="follow-up-proposal-summary"><time datetime="2026-09-10T10:00:00.000Z">10 Eylül 2026 13:00</time> · Satış görüşmesi · Ayşe Yılmaz</p>
        <p class="form-help follow-up-proposal-notice">Uygun zaman sistem tarafından seçildi.</p>
        <details class="task-optional-fields follow-up-edit" open><summary>Tarih ve saati değiştir</summary>
          <div class="field-group"><label for="f-sched">Takip tarihi ve saati</label>
          <input id="f-sched" type="datetime-local" value="2026-09-10T13:00"/>
          <p class="form-help">Saat dilimi: Europe/Istanbul</p></div>
        </details>
        <details class="task-optional-fields follow-up-edit" open><summary>Takip kapsamını düzenle</summary>
          <div class="field-group"><label for="f-scope">Takip kapsamı / talimatlar</label>
          <textarea id="f-scope" rows="2" maxlength="4000">Takip: Klinik ziyareti</textarea></div>
        </details>
      </section>
      <form novalidate>
        <div class="field-group"><label for="reason">Tamamlanma sonucu</label>
        <textarea id="reason" rows="4">Ziyaret tamamlandı, takip gerekli.</textarea></div>
        <p class="form-help">Bu açıklama, yönetici kontrolüne gönderilen iş kaydında saklanır.</p>
        <div class="review-buttons product-dialog-actions">
          <button class="secondary-button" type="button">Vazgeç</button>
          <button class="primary-button compact-button" type="submit" id="cta-btn">Tamamla ve yönetici onayına gönder</button>
        </div>
      </form>
    </div>
  </div>
  <nav class="mobile-bottom-nav" aria-label="Mobil ana navigasyon">
    <a class="mobile-bottom-nav-item mobile-bottom-nav-item--active" href="/jobs" aria-current="page">İşler</a>
    <a class="mobile-bottom-nav-item" href="/customers">Müşteriler</a>
    <a class="mobile-bottom-nav-item" href="/products">Ürünler</a>
    <a class="mobile-bottom-nav-item" href="/staff">Profilim</a>
  </nav>
</div>
</body></html>`;

// Production classes the fixture must mirror. If production renames any of
// these, the fixture silently stops proving anything — fail instead.
const REQUIRED_PRODUCTION_CLASSES = [
  'dialog-backdrop',
  'product-dialog-backdrop',
  'workflow-dialog',
  'reason-dialog',
  'product-dialog',
  'review-buttons',
  'product-dialog-actions',
  'mobile-bottom-nav',
];

const server = createServer((req, res) => {
  if ((req.url ?? '/').split('?')[0] !== '/') { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fixture);
});

await new Promise((resolveServer) => server.listen(0, '127.0.0.1', resolveServer));
const base = `http://127.0.0.1:${server.address().port}/`;

const viewports = [
  { name: '390x844', width: 390, height: 844 },
  { name: '393x852', width: 393, height: 852 },
  { name: '430x932', width: 430, height: 932 },
  { name: '390x700', width: 390, height: 700 },
];

const failures = [];
function check(dimension, label, detail, ok) {
  console.log(`  ${ok ? '✓' : '✗'} [${dimension}] ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures.push(`[${dimension}] ${label} ${detail}`);
}
function note(dimension, label, detail) {
  console.log(`  ○ [${dimension}] ${label}${detail ? `: ${detail}` : ''}`);
}

for (const [browserName, browserType] of [['chromium', chromium], ['webkit', webkit]]) {
  const browser = await browserType.launch();
  try {
    for (const viewport of viewports) {
      const page = await browser.newPage({
        viewport: { width: viewport.width, height: viewport.height },
        hasTouch: true,
        // Mobile WebKit has no wheel input; desktop emulation keeps the same
        // CSS geometry path (width-driven media queries, dvh units).
        isMobile: browserName !== 'webkit',
      });
      await page.goto(base);
      await page.waitForSelector('#dialog');
      const measured = await page.evaluate((requiredClasses) => {
        const rect = (el) => {
          const box = el.getBoundingClientRect();
          return {
            x: Math.round(box.x), y: Math.round(box.y),
            width: Math.round(box.width), height: Math.round(box.height),
            top: Math.round(box.top), bottom: Math.round(box.bottom),
          };
        };
        const dialog = document.querySelector('#dialog');
        const cta = document.querySelector('#cta-btn');
        const nav = document.querySelector('.mobile-bottom-nav');
        const missingClasses = requiredClasses.filter((name) => !document.querySelector(`.${name}`));
        const before = { scrollTop: dialog.scrollTop, scrollHeight: dialog.scrollHeight, clientHeight: dialog.clientHeight };
        dialog.scrollTop = dialog.scrollHeight;
        const progTop = dialog.scrollTop;
        const ctaRect = rect(cta);
        const navRect = rect(nav);
        // Positive CTA identity: the hit target must be the CTA button itself
        // or one of its descendants. Anything else (BODY, backdrop, dialog
        // container, nav, unrelated overlay) fails.
        const probeX = Math.min(ctaRect.x + ctaRect.width / 2, window.innerWidth - 1);
        const probeY = Math.min(ctaRect.bottom - 2, window.innerHeight - 1);
        const hit = document.elementFromPoint(probeX, probeY);
        const ctaHit = hit === cta || (hit !== null && cta.contains(hit));
        const hitDescriptor = hit
          ? `${hit.tagName}.${String(hit.className?.baseVal ?? hit.className ?? '').split(' ').slice(0, 2).join('.')}`
          : 'none';
        // Negative control: a backdrop corner point must NOT satisfy the CTA
        // identity check, proving the check discriminates.
        const control = document.elementFromPoint(8, 8);
        const controlPassesAsCta = control === cta || (control !== null && cta.contains(control));
        return {
          missingClasses, before, progTop, ctaRect, navRect,
          ctaHit, hitDescriptor, controlPassesAsCta,
          overflowY: getComputedStyle(dialog).overflowY,
          docScrollW: document.documentElement.scrollWidth,
          docClientW: document.documentElement.clientWidth,
        };
      }, REQUIRED_PRODUCTION_CLASSES);
      const prefix = `${browserName} ${viewport.name}`;
      const overflows = measured.before.scrollHeight > measured.before.clientHeight + 1;
      check('FIXTURE', `${prefix} production class match`,
        measured.missingClasses.length > 0 ? `missing: ${measured.missingClasses.join(',')}` : '',
        measured.missingClasses.length === 0);
      check('PROGRAMMATIC_SCROLL', `${prefix} dialog scrolls when overflowing`, `scrollTop=${measured.progTop}`,
        !overflows || measured.progTop > 0);
      check('CTA_RECT', `${prefix} CTA above bottom nav`, `ctaBottom=${measured.ctaRect.bottom} navTop=${measured.navRect.top}`,
        measured.ctaRect.bottom <= measured.navRect.top);
      check('CTA_HIT_TARGET', `${prefix} hit target is the CTA button`, measured.hitDescriptor, measured.ctaHit);
      check('CTA_HIT_TARGET', `${prefix} backdrop corner is not the CTA`, 'negative control', !measured.controlPassesAsCta);
      check('HORIZONTAL_OVERFLOW', `${prefix} no horizontal page overflow`, `scrollWidth=${measured.docScrollW}`,
        measured.docScrollW <= measured.docClientW + 1);
      await page.evaluate(() => { document.querySelector('#dialog').scrollTop = 0; });
      const wheel = await userStyleScroll(page, viewport);
      if (wheel.result === 'NOT_SUPPORTED') {
        note('USER_STYLE_SCROLL', `${prefix} user-style scroll NOT_SUPPORTED`,
          'input unavailable; programmatic proof governs');
      } else {
        check('USER_STYLE_SCROLL', `${prefix} user-style scroll ${wheel.result}`, `wheelTop=${wheel.wheelTop}`,
          wheel.result === 'PASS');
      }
      await page.screenshot({ path: resolve(tmpdir(), `servora-followup-dialog-${browserName}-${viewport.name}.png`) });
      await page.close();
    }
  } finally {
    await browser.close();
  }
}
server.close();

if (failures.length > 0) {
  console.error(`\nGEOMETRY FAILURES (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('\nFollow-up dialog geometry: PASS (Chromium + WebKit, 390/393/430/390x700).');
