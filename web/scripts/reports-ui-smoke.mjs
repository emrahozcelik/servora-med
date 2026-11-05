import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, process.env.REPORTS_CAPTURE_DIR ?? '../.impeccable/review');
mkdirSync(out, { recursive: true });
const vite = await createViteServer({ root, configFile: false, appType: 'custom', logLevel: 'error', server: { middlewareMode: true, hmr: false } });
const server = createServer((req, res) => {
  if (req.url.split('?')[0] === '/') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/scripts/reports-ui-fixture.tsx"></script></body></html>');
  } else vite.middlewares(req, res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch();
const errors = [];
const checks = [];
const url = `http://127.0.0.1:${server.address().port}/`;

async function assertStaffLayout(page, name) {
  const desktop = await page.locator('.staff-performance-desktop').isVisible();
  const cards = await page.locator('.staff-performance-mobile').isVisible();
  assert.notEqual(desktop, cards, `${name}: exactly one staff layout is visible`);
  if (!desktop) return;
  const fragmentedWords = await page.locator('.staff-performance-sort > span').evaluateAll((labels) => labels.flatMap((label) => {
    const node = label.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) return ['Missing sort label'];
    return [...node.textContent.matchAll(/\S+/gu)].flatMap((word) => {
      const range = document.createRange();
      range.setStart(node, word.index);
      range.setEnd(node, word.index + word[0].length);
      return range.getClientRects().length > 1 ? [word[0]] : [];
    });
  }));
  assert.deepEqual(fragmentedWords, [], `${name}: staff header words must remain intact`);
  assert.equal(await page.locator('.staff-performance-expand').evaluateAll((buttons) => buttons.every((button) => {
    const bounds = button.getBoundingClientRect();
    const cell = button.closest('td').getBoundingClientRect();
    return bounds.left >= cell.left && bounds.right <= cell.right + 1 && bounds.height >= 44;
  })), true, `${name}: details controls fit inside their cells`);
}

try {
  for (const [name, width, staff] of [
    ['desktop', 1440, false], ['mobile', 390, false], ['tablet-768', 768, false], ['desktop-1024', 1024, false],
    ['staff-desktop', 1440, true], ['staff-mobile', 390, true], ['staff-tablet-768', 768, true], ['staff-desktop-1024', 1024, true],
  ]) {
    const page = await browser.newPage({ viewport: { width, height: 960 }, reducedMotion: 'reduce' });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/?${staff ? 'staff' : ''}`);
    await page.locator(staff ? '.staff-performance-comparison' : '[data-report-kpi]').first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: resolve(out, `${name}.png`), fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    if (overflow) throw new Error(`${name}: document overflow`);
    if (staff) {
      await assertStaffLayout(page, name);
      const desktop = await page.locator('.staff-performance-desktop').isVisible();
      if (name === 'staff-desktop') assert.equal(desktop, true, 'roomy desktop retains the comparison table');
      if (desktop) {
        const expand = page.getByRole('button', { name: /^Ayşe Demir ayrıntılarını/ });
        await expand.focus(); await page.keyboard.press('Enter');
        assert.equal(await expand.getAttribute('aria-expanded'), 'true');
        if (name === 'staff-desktop') await page.screenshot({ path: resolve(out, 'staff-expanded.png'), fullPage: true });
        await page.keyboard.press('Enter');
        assert.equal(await expand.getAttribute('aria-expanded'), 'false');
        const sort = page.getByRole('button', { name: /^Tamamlanan sütununu sırala/ });
        await sort.click();
        assert.match(await page.locator('tbody tr[data-row-key]').first().innerText(), /Zeynep/);
        assert.equal((await expand.boundingBox()).height >= 44, true);
      } else {
        await page.locator('.staff-performance-mobile-sort select').selectOption('completedJobs');
        assert.match(await page.locator('.staff-performance-mobile-record').first().innerText(), /Zeynep/);
        await page.locator('.staff-performance-mobile-record summary').first().click();
        assert.equal(await page.locator('.staff-performance-mobile-record details').first().getAttribute('open'), '');
      }
      checks.push(`${name}: explicit expansion and sorting`);
    } else {
      const slider = page.getByRole('slider', { name: 'Günü incele' });
      await slider.focus(); await page.keyboard.press('Home');
      assert.match(await slider.getAttribute('aria-valuetext'), /^1 Eki/);
      await page.keyboard.press('ArrowRight');
      assert.match(await slider.getAttribute('aria-valuetext'), /^2 Eki/);
      await page.keyboard.press('End');
      assert.match(await slider.getAttribute('aria-valuetext'), /^28 Eki/);
      assert.equal(await slider.evaluate((el) => getComputedStyle(el).outlineStyle !== 'none'), true);
      await page.locator('.business-trend-data summary').click();
      assert.equal(await page.locator('.business-trend-data tbody tr').count(), 28);
      checks.push(`${name}: keyboard inspection, visible focus, daily table`);
    }
    checks.push(`${name}: no document overflow; reduced motion`);
    await page.close();
  }
  for (const staff of [false, true]) {
    for (const [name, width, textScale] of [['text-200', 1440, true], ['text-200-wide', 1920, true], ['reflow-400', 320, false]]) {
      const page = await browser.newPage({ viewport: { width, height: 960 } });
      await page.goto(`${url}?${staff ? 'staff' : ''}`);
      await page.locator(staff ? '.staff-performance-comparison' : '.business-trend-plot').waitFor();
      if (textScale) await page.addStyleTag({ content: 'html { font-size: 200%; }' });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `${name} overflow`);
      if (staff) await assertStaffLayout(page, name);
      if (staff && textScale) {
        assert.equal(await page.locator('.staff-performance-desktop').isVisible(), false, '200% text switches to cards');
        assert.equal(await page.locator('.staff-performance-mobile').isVisible(), true);
        const summary = page.locator('.staff-performance-mobile-record summary').first();
        await summary.focus(); await page.keyboard.press('Enter');
        assert.equal(await page.locator('.staff-performance-mobile-record details').first().getAttribute('open'), '');
        await page.keyboard.press('Enter');
      }
      if (!staff) {
        assert.equal(await page.locator('.report-attention-card').evaluateAll((cards) => cards.every((card) => {
          const bounds = card.getBoundingClientRect(); const action = card.querySelector('a').getBoundingClientRect();
          return action.left >= bounds.left && action.right <= bounds.right + 1;
        })), true, 'attention actions stay inside their cards');
        assert.equal(await page.locator('.report-executive-metrics dt').evaluateAll((labels) => labels.every((label) => label.scrollWidth <= label.clientWidth + 1)), true);
      }

      await page.screenshot({ path: resolve(out, `${staff ? 'staff-' : ''}${name}.png`), fullPage: true });
      checks.push(`${staff ? 'staff' : 'summary'} ${name}: no document or component overflow; controls operable`);
      await page.close();
    }
  }
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  for (const scenario of ['zero', 'future', 'long']) {
    await page.goto(`${url}?case=${scenario}`);
    await page.locator('.business-trend').waitFor();
    if (scenario === 'zero') assert.match(await page.locator('.business-trend-empty').innerText(), /kaydı bulunmuyor/);
    if (scenario === 'future') assert.equal(await page.getByRole('slider').count(), 0);
    if (scenario === 'long') {
      await page.locator('.business-trend-data summary').click();
      assert.equal(await page.locator('.business-trend-data tbody tr').count(), 366);
      await page.locator('.business-trend-data summary').click();
      await page.locator('.business-trend-plot').tap({ position: { x: 120, y: 100 } });
      assert.notEqual(await page.getByRole('slider').inputValue(), '365');
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    checks.push(`${scenario}: bounded truthful state, touch inspection and no overflow`);
  }
  let failed = true;
  await page.route('**/api/reports/business-trend**', async (route) => {
    if (failed) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Geçici bağlantı hatası' } }) });
    const payload = await page.evaluate(async () => (await import('/scripts/reports-ui-fixture.tsx')).business);
    return route.fulfill({ json: payload });
  });
  await page.goto(`${url}?case=remote`);
  await page.getByRole('button', { name: 'Tekrar dene' }).waitFor();
  assert.equal(await page.locator('[data-report-kpi]').count(), 5);
  failed = false;
  await page.getByRole('button', { name: 'Tekrar dene' }).click();
  await page.locator('.business-trend-plot').waitFor();
  checks.push('remote report: error is local; retry loads data; operational summary remains available');
  await page.close();
  writeFileSync(resolve(out, 'browser-checks.json'), JSON.stringify({ browser: 'Chromium', syntheticData: true, checks }, null, 2));
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(`Reports UI screenshots and overflow checks: ${out}`);
} finally { await browser.close(); await vite.close(); await new Promise((r) => server.close(r)); }
