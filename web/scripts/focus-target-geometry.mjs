import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium, webkit } from 'playwright';
import { createServer as createViteServer } from 'vite';

// Run from web/. Rendered geometry for UI audit 2026-11-18 F-02 and F-10:
// keyboard focus on Ant Select/inputs shows the Servora focus ring, and shared
// pagination items / settings tabs keep ≥ 44 × 44 CSS px touch targets.
const MIN_TARGET_PX = 44;
const MIN_RING_PX = 2;

const html = `<!doctype html><html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
<div id="root"></div><script type="module" src="/scripts/focus-target-fixture.tsx"></script>
</body></html>`;
const vite = await createViteServer({
  root: process.cwd(), configFile: false, appType: 'custom', logLevel: 'error',
  server: { middlewareMode: true, hmr: false },
});
const server = createServer((req, res) => {
  if ((req.url ?? '/').split('?')[0] === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } else {
    vite.middlewares(req, res, () => { res.writeHead(404); res.end(); });
  }
});
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const origin = `http://127.0.0.1:${server.address().port}`;
const engine = process.env.ENGINE === 'webkit' ? 'webkit' : 'chromium';
const browser = await (engine === 'webkit' ? webkit : chromium).launch();
const errors = [];
const results = [];

/** Width of a visible focus indicator from outline or box-shadow spread. */
function ringWidthScript(selector) {
  const element = document.querySelector(selector);
  if (!element) return { found: false };
  const style = getComputedStyle(element);
  const outline = style.outlineStyle !== 'none' ? Number.parseFloat(style.outlineWidth) || 0 : 0;
  let shadow = 0;
  if (style.boxShadow && style.boxShadow !== 'none') {
    // Only visible, zero-offset/zero-blur spreads count as a ring; Ant's
    // theme-disabled ring computes to a fully transparent colour.
    for (const layer of style.boxShadow.split(/,(?![^(]*\))/)) {
      if (/rgba\([^)]*,\s*0\)|transparent/.test(layer)) continue;
      const lengths = [...layer.matchAll(/(-?[\d.]+)px/g)].map((match) => Number(match[1]));
      if (lengths.length === 4 && lengths[0] === 0 && lengths[1] === 0 && lengths[2] === 0) {
        shadow = Math.max(shadow, lengths[3]);
      }
    }
  }
  return { found: true, outline, shadow, ring: Math.max(outline, shadow),
    outlineStyle: style.outlineStyle, boxShadow: style.boxShadow };
}

try {
  for (const [width, height] of [[320, 720], [390, 844], [1440, 960]]) {
    const page = await browser.newPage({
      viewport: { width, height }, locale: 'tr-TR', timezoneId: 'Europe/Istanbul',
      // Motion stays on: Ant's own ring fades in, the Servora outline must not.
      reducedMotion: 'no-preference', hasTouch: width < 768,
    });
    page.on('pageerror', error => errors.push(`${width}: ${error.message}`));
    // Vite's dev client (HMR socket) is transport noise in middleware mode,
    // especially when another smoke owns the default HMR port; app errors stay.
    page.on('console', message => {
      const text = message.text();
      if (message.type() !== 'error' || /WebSocket|\[vite\]|Vite server/.test(text)) return;
      errors.push(`${width}: ${text}`);
    });
    await page.route('**/api/**', route => route.abort());
    await page.goto(origin);
    await page.locator('html[data-fixture-ready="true"]').waitFor();
    await page.evaluate(() => document.fonts.ready);

    // F-02: keyboard focus into the Select (Tab from the preceding control).
    await page.locator('body').click({ position: { x: 1, y: 1 } });
    await page.keyboard.press('Tab');
    const selectFocused = await page.evaluate(() => document.activeElement?.closest('.servora-select') !== null);
    assert.ok(selectFocused, `${width}: Tab must focus the Select`);
    const selectRing = await page.evaluate(ringWidthScript, '.servora-select:has(#fixture-select)');
    assert.ok(selectRing.found);
    // The Servora outline (not Ant's fading box-shadow) must be present at once
    // and survive forced-colors; the two indicators must not stack.
    assert.ok(selectRing.outline >= MIN_RING_PX && selectRing.outlineStyle === 'solid',
      `${width}: focused Select needs the Servora focus outline ≥ ${MIN_RING_PX}px (${JSON.stringify(selectRing)})`);
    assert.equal(selectRing.shadow, 0, `${width}: Ant focus shadow must not stack with the outline`);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'fixture-select-error');
    const errorRing = await page.evaluate(ringWidthScript, '.servora-select:has(#fixture-select-error)');
    assert.ok(errorRing.outline >= MIN_RING_PX && errorRing.outlineStyle === 'solid',
      `${width}: error-status Select focus outline (${JSON.stringify(errorRing)})`);
    assert.equal(errorRing.shadow, 0, `${width}: error-status Ant shadow must not stack (${errorRing.boxShadow})`);
    if (process.env.FOCUS_TARGET_CAPTURE) await page.screenshot({ path: `${process.env.FOCUS_TARGET_CAPTURE}-${width}.png` });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Tab');
    const inputRing = await page.evaluate(ringWidthScript, '#fixture-input');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'fixture-input');
    assert.ok(inputRing.ring >= MIN_RING_PX, `${width}: focused input ring (${JSON.stringify(inputRing)})`);

    // F-10: shared pagination items and settings tabs.
    const targets = await page.evaluate(() => {
      const rect = (element) => {
        const box = element.getBoundingClientRect();
        return { width: Math.round(box.width * 10) / 10, height: Math.round(box.height * 10) / 10 };
      };
      const pagination = [...document.querySelectorAll('.servora-list-pagination [class*="pagination-prev"], .servora-list-pagination [class*="pagination-next"]')]
        .map(element => ({
          name: element.getAttribute('aria-label'), ...rect(element),
          // Ant 6.7 moved the click target to a full-size inner button.
          button: element.querySelector('button') ? rect(element.querySelector('button')) : null,
        }));
      const tabs = [...document.querySelectorAll('.servora-settings-tabs [role="tab"]')]
        .map(element => ({ name: element.textContent?.trim(), ...rect(element), link: rect(element.querySelector('a') ?? element) }));
      return { pagination, tabs, overflow: document.documentElement.scrollWidth > innerWidth + 1 };
    });
    assert.equal(targets.overflow, false, `${width}: horizontal overflow`);
    assert.equal(targets.pagination.length, 2, `${width}: prev/next pagination items`);
    for (const item of targets.pagination) {
      assert.ok(item.width >= MIN_TARGET_PX && item.height >= MIN_TARGET_PX,
        `${width}: pagination ${item.name} target ${item.width}×${item.height}`);
    }
    assert.equal(targets.tabs.length, 4, `${width}: settings tabs`);
    for (const tab of targets.tabs) {
      assert.ok(tab.link.width >= MIN_TARGET_PX && tab.link.height >= MIN_TARGET_PX,
        `${width}: settings tab ${tab.name} link target ${tab.link.width}×${tab.link.height}`);
    }
    for (const item of targets.pagination) {
      assert.ok(item.button && item.button.width >= MIN_TARGET_PX && item.button.height >= MIN_TARGET_PX,
        `${width}: pagination ${item.name} inner button ${JSON.stringify(item.button)}`);
    }

    // F-10 interaction: real pointer click on the arrow advances a controlled
    // pager; keyboard Enter/Space advance and return focus to the pager.
    const summary = page.locator('.servora-list-pagination__summary');
    assert.match(await summary.innerText(), /Sayfa 1 \/ 3/);
    await page.locator('body').click({ position: { x: 1, y: 1 } });
    await page.locator('.servora-list-pagination [class*="pagination-next"]').click();
    await summary.filter({ hasText: 'Sayfa 2 / 3' }).waitFor();
    await page.locator('.servora-list-pagination [class*="pagination-next"]').focus();
    await page.keyboard.press('Enter');
    await summary.filter({ hasText: 'Sayfa 3 / 3' }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('servora-list-pagination')), true,
      `${width}: keyboard paging restores focus to the pager`);
    await page.keyboard.press('Tab');
    await page.keyboard.press(' ');
    await summary.filter({ hasText: 'Sayfa 2 / 3' }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('servora-list-pagination')), true,
      `${width}: Space on the previous arrow restores pager focus`);
    // Ant 6.7 keeps the role="tab" element as the keyboard focus target and
    // uses arrow keys for roving focus; the nested link remains the pointer
    // destination and is measured above.
    const firstTab = page.locator('.servora-settings-tabs [role="tab"]').first();
    await firstTab.focus();
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('role')), 'tab',
      `${width}: settings tab is keyboard focusable`);
    await page.keyboard.press('ArrowRight');
    const secondTabName = await page.evaluate(() => document.activeElement?.textContent?.replace('Tab 2 of 4', '').trim());
    assert.equal(secondTabName, 'Güvenlik', `${width}: ArrowRight moves roving tab focus`);
    results.push({ engine, width, selectRing: selectRing.ring, inputRing: inputRing.ring, ...targets });
    await page.close();
  }
  assert.deepEqual(errors, [], 'no page/console errors');

  // F-18: Turkish 403/404 headings, one h1 and decorative artwork excluded
  // from the accessibility tree on both engines.
  for (const [status, title] of [['403', 'Erişim yetkiniz yok'], ['404', 'Sayfa bulunamadı']]) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'tr-TR', timezoneId: 'Europe/Istanbul' });
    page.on('pageerror', error => errors.push(`${status}: ${error.message}`));
    await page.goto(`${origin}/?case=${status}`);
    await page.locator('html[data-fixture-ready="true"]').waitFor();
    await page.evaluate(() => document.fonts.ready);
    const headings = await page.locator('h1').allInnerTexts();
    assert.deepEqual(headings, [title], `${status}: exactly one Turkish h1`);
    const snapshot = await page.locator('body').ariaSnapshot();
    assert.ok(snapshot.includes(`heading "${title}" [level=1]`), `${status}: aria heading (${snapshot})`);
    assert.ok(!/Unauthorized|No Found/.test(snapshot), `${status}: English artwork text must not reach the accessibility tree`);
    const icon = page.locator('.servora-result-state__icon');
    assert.equal(await icon.count(), 1, `${status}: artwork slot present`);
    assert.equal(await icon.getAttribute('aria-hidden'), 'true', `${status}: artwork hidden`);
    if (process.env.FOCUS_TARGET_CAPTURE) {
      await page.screenshot({ path: `${process.env.FOCUS_TARGET_CAPTURE}-${status}-${engine}.png` });
    }
    results.push({ engine, kind: 'result', status, headings, ariaHiddenArtwork: true });
    await page.close();
  }

  // 320 px at 200% text: content must reflow without horizontal overflow.
  {
    const page = await browser.newPage({ viewport: { width: 320, height: 720 }, locale: 'tr-TR', timezoneId: 'Europe/Istanbul' });
    page.on('pageerror', error => errors.push(`text200: ${error.message}`));
    await page.goto(origin);
    await page.locator('html[data-fixture-ready="true"]').waitFor();
    await page.addStyleTag({ content: 'html { font-size: 200%; }' });
    await page.evaluate(() => document.fonts.ready);
    const enlargement = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth,
    }));
    assert.equal(enlargement.overflow, false, `320px/200% text overflow (${JSON.stringify(enlargement)})`);
    if (process.env.FOCUS_TARGET_CAPTURE) {
      await page.screenshot({ path: `${process.env.FOCUS_TARGET_CAPTURE}-text200-${engine}.png` });
    }
    results.push({ engine, kind: 'text200', ...enlargement });
    await page.close();
  }

  // Forced colors: the Servora outline must remain a visible >=2px ring.
  {
    let page;
    try {
      page = await browser.newPage({ viewport: { width: 390, height: 844 }, forcedColors: 'active', locale: 'tr-TR' });
    } catch (error) {
      results.push({ engine, kind: 'forcedColors', supported: false, reason: String(error) });
    }
    if (page) {
      page.on('pageerror', error => errors.push(`forcedColors: ${error.message}`));
      await page.goto(origin);
      await page.locator('html[data-fixture-ready="true"]').waitFor();
      await page.locator('body').click({ position: { x: 1, y: 1 } });
      await page.keyboard.press('Tab');
      const ring = await page.evaluate(ringWidthScript, '.servora-select:has(#fixture-select)');
      assert.ok(ring.outline >= MIN_RING_PX && ring.outlineStyle === 'solid', `forced colors focus outline (${JSON.stringify(ring)})`);
      results.push({ engine, kind: 'forcedColors', supported: true, ring });
      await page.close();
    }
  }

  assert.deepEqual(errors, [], 'no page/console errors');
  console.log(JSON.stringify({ ok: true, engine, browser: browser.version(), results }, null, 2));
} finally {
  await browser.close();
  await new Promise(resolveClose => server.close(resolveClose));
  await vite.close();
}
