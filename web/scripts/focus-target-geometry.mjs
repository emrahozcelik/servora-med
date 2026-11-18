import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
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
const browser = await chromium.launch();
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
  for (const [width, height] of [[390, 844], [1440, 960]]) {
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
        .map(element => ({ name: element.getAttribute('aria-label'), ...rect(element) }));
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
    results.push({ width, selectRing: selectRing.ring, inputRing: inputRing.ring, ...targets });
    await page.close();
  }
  assert.deepEqual(errors, [], 'no page/console errors');
  console.log(JSON.stringify({ ok: true, results }, null, 2));
} finally {
  await browser.close();
  await new Promise(resolveClose => server.close(resolveClose));
  await vite.close();
}
