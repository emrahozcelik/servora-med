import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';

// Run from web/. Screenshot files are review artifacts, never production data.
const out = process.env.OVERDUE_CAPTURE_DIR;
assert.ok(out, 'Set OVERDUE_CAPTURE_DIR to an owned evidence directory');
mkdirSync(out, { recursive: true });

const html = `<!doctype html><html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
<div id="root"></div><script type="module" src="/scripts/overdue-pagination-fixture.tsx"></script>
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
    vite.middlewares(req, res, () => {
      res.writeHead(404);
      res.end();
    });
  }
});
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const checks = [];
const errors = [];
const unexpected = [];
const fixedTime = '2026-11-17T09:00:00.000Z';

async function visit(kind, width, height, query = '') {
  const page = await browser.newPage({
    viewport: { width, height },
    locale: 'tr-TR', timezoneId: 'Europe/Istanbul',
    reducedMotion: 'reduce', hasTouch: width < 768,
  });
  page.setDefaultTimeout(15000);
  await page.clock.setFixedTime(new Date(fixedTime));
  page.on('pageerror', error => errors.push(`${kind}-${width}: ${error.message}`));
  await page.route('**/api/**', route => {
    unexpected.push(`${kind}-${width}: ${route.request().url()}`);
    return route.abort();
  });
  await page.goto(`${origin}/?kind=${kind}${query}`);
  return page;
}

async function capture(page, name, allowAlert = false) {
  await page.evaluate(() => document.fonts.ready);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  const alertCount = await page.locator('[role="alert"]').count();
  await page.screenshot({ path: resolve(out, `${name}.png`), fullPage: true });
  assert.equal(overflow, false, `${name}: horizontal overflow`);
  if (!allowAlert) assert.equal(alertCount, 0, `${name}: unexpected alert`);
  checks.push({ name, overflow, alertCount });
}

try {
  for (const kind of ['open', 'history']) {
    const selector = kind === 'open' ? '.submission-late-card' : '[data-overdue-history-item]';
    const ready = kind === 'open' ? '[data-open-submission-late="true"]' : '[data-overdue-history="ready"]';
    for (const [width, height] of [[320, 680], [390, 844], [768, 1024], [1024, 768], [1440, 960]]) {
      const page = await visit(kind, width, height);
      try {
        await page.locator(ready).waitFor();
        assert.equal(await page.locator(selector).count(), 6, `${kind}-${width}: first-page records`);
        assert.equal(await page.locator('html').getAttribute('data-overdue-limit'), '6');
        assert.equal(await page.locator('html').getAttribute('data-overdue-offset'), '0');
        assert.match(await page.locator('.servora-list-pagination').innerText(), /Sayfa 1 \/ 3/);
        if (kind === 'history') {
          const breaches = JSON.parse(await page.locator('html').getAttribute('data-overdue-history-breaches'));
          assert.equal(breaches.length, 13);
          assert.deepEqual(breaches, [...breaches].sort().reverse(), 'history fixture must be newest first before paging');
          assert.match(await page.locator(ready).innerText(), /Planlanan bitiş/);
          assert.match(await page.locator(ready).innerText(), /Onay süresi sonu/);
        }
        await capture(page, `${kind}-page-1-${width}`);
        await page.locator('.servora-ant-pagination-next button').click();
        await page.waitForFunction(() => document.documentElement.dataset.overdueOffset === '6'
          && document.querySelectorAll('[data-overdue-history-item],.submission-late-card').length === 6
          && document.querySelector('.servora-list-pagination')?.textContent?.includes('Sayfa 2 / 3'));
        assert.match(await page.locator('.servora-list-pagination').innerText(), /Sayfa 2 \/ 3/);
        await capture(page, `${kind}-page-2-${width}`);
        await page.locator('.servora-ant-pagination-next button').click();
        await page.waitForFunction(() => document.documentElement.dataset.overdueOffset === '12'
          && document.querySelectorAll('[data-overdue-history-item],.submission-late-card').length === 1);
        assert.match(await page.locator('.servora-list-pagination').innerText(), /Sayfa 3 \/ 3/);
        await capture(page, `${kind}-last-page-${width}`);
      } finally { await page.close(); }
    }
    const page = await visit(kind, 390, 844);
    try {
      await page.locator(ready).waitFor();
      // The app uses fixed px sizes for record text; html font-size alone
      // does not enlarge those records. Apply a measured 2x text-only probe.
      const selectors = kind === 'open'
        ? ['.submission-late-card .servora-operational-card__title a', '.submission-late-card .servora-operational-card__body > span']
        : ['[data-overdue-history-item] strong', '[data-overdue-history-item] span'];
      const baseline = await page.evaluate((paths) => paths.map(selector => {
        const element = document.querySelector(selector);
        if (!element) throw new Error(`Missing text measurement target: ${selector}`);
        return { selector, pixels: Number.parseFloat(getComputedStyle(element).fontSize) };
      }), selectors);
      assert.ok(baseline.every(row => Number.isFinite(row.pixels) && row.pixels > 0));
      await page.addStyleTag({ content: [
        'html { font-size: 200% !important; }',
        ...baseline.map(row => `${row.selector} { font-size: ${row.pixels * 2}px !important; line-height: 1.4 !important; }`),
      ].join('\n') });
      const enlarged = await page.evaluate((rows) => rows.map(row => ({
        selector: row.selector,
        pixels: Number.parseFloat(getComputedStyle(document.querySelector(row.selector)).fontSize),
      })), baseline);
      for (let i = 0; i < baseline.length; i++) {
        assert.ok(Math.abs(enlarged[i].pixels - baseline[i].pixels * 2) < 0.1,
          `${kind}: ${baseline[i].selector} did not double`);
      }
      checks.push({ name: `${kind}-text-growth-390`, baseline, enlarged });
      await capture(page, `${kind}-200percent-text-390`);
    } finally { await page.close(); }

    // Reproduce the independent review's 120ms in-flight paging case with
    // real keyboard events, not an instantly resolved API fixture.
    const keyboard = await visit(kind, 390, 844, '&delay=120');
    try {
      await keyboard.locator(ready).waitFor();
      await keyboard.locator('.servora-ant-pagination-next').focus();
      await keyboard.keyboard.press('Space');
      await keyboard.waitForFunction(() => document.querySelector('.servora-list-pagination')?.textContent?.includes('Sayfa 2 / 3')
        && document.activeElement?.classList.contains('servora-list-pagination'));
      await capture(keyboard, `${kind}-keyboard-space-next-390`);
      await keyboard.locator('.servora-ant-pagination-prev').focus();
      await keyboard.keyboard.press('Enter');
      await keyboard.waitForFunction(() => document.querySelector('.servora-list-pagination')?.textContent?.includes('Sayfa 1 / 3')
        && document.activeElement?.classList.contains('servora-list-pagination'));
      await capture(keyboard, `${kind}-keyboard-enter-prev-390`);
    } finally { await keyboard.close(); }

    for (const [width, height] of [[390, 844], [1440, 960]]) {
      const shrinking = await visit(kind, width, height, '&delay=120&shrink=7');
      try {
        await shrinking.locator(ready).waitFor();
        await shrinking.locator('.servora-ant-pagination-next').focus();
        await shrinking.keyboard.press('Space');
        await shrinking.waitForFunction(() => document.querySelector('.servora-list-pagination')?.textContent?.includes('Sayfa 2 / 3')
          && document.activeElement?.classList.contains('servora-list-pagination'));
        await shrinking.locator('.servora-ant-pagination-next').focus();
        await shrinking.keyboard.press('Space');
        await shrinking.waitForFunction(() => document.documentElement.dataset.overdueOffset === '6'
          && document.querySelector('.servora-list-pagination')?.textContent?.includes('Sayfa 2 / 2')
          && document.activeElement?.classList.contains('servora-list-pagination'));
        assert.equal(await shrinking.locator(selector).count(), 1);
        await capture(shrinking, `${kind}-keyboard-clamped-${width}`);
      } finally { await shrinking.close(); }
    }

    const emptyPage = await visit(`${kind}-empty`, 390, 844);
    try {
      await emptyPage.locator('main h1').waitFor();
      await emptyPage.waitForFunction(() => document.documentElement.dataset.overdueLimit === '6');
      assert.equal(await emptyPage.locator(selector).count(), 0);
      assert.equal(await emptyPage.locator('.servora-list-pagination').count(), 0);
      await capture(emptyPage, `${kind}-empty-390`);
    } finally { await emptyPage.close(); }

    const retry = await visit(`${kind}-retry`, 390, 844);
    try {
      await retry.getByText('Gecikme listesi yüklenemedi', { exact: true })
        .or(retry.getByText('Gecikme geçmişi yüklenemedi', { exact: true })).waitFor();
      await capture(retry, `${kind}-error-390`, true);
      await retry.getByRole('button', { name: 'Tekrar dene' }).click();
      await retry.locator(ready).waitFor();
      assert.equal(await retry.locator(selector).count(), 6);
      await capture(retry, `${kind}-retry-success-390`);
    } finally { await retry.close(); }
  }

  assert.deepEqual(errors, [], 'no browser page errors');
  assert.deepEqual(unexpected, [], 'no unexpected backend API requests');
  writeFileSync(resolve(out, 'checks.json'), JSON.stringify({
    source: 'real React component fixture, not App/AppShell',
    browser: browser.version(), fixedTime, locale: 'tr-TR', timezone: 'Europe/Istanbul',
    mocked: ['synthetic list functions', 'EventSource disabled', 'no auth/backend'],
    checks, errors, unexpected,
    limits: ['Chromium only', '320px reflow and scoped 200% record text simulation, not 400% zoom', 'no full AppShell/role authorization verification'],
  }, null, 2));
  const captureCount = checks.filter(check => 'overflow' in check).length;
  console.log(`PASS overdue visual: ${captureCount} screenshots; six-row server paging, keyboard focus, retry and no overflow`);
} catch (error) {
  writeFileSync(resolve(out, 'failure.json'), JSON.stringify({ error: String(error), errors, unexpected, checks }, null, 2));
  throw error;
} finally {
  await browser.close();
  await vite.close();
  await new Promise(resolveClose => server.close(resolveClose));
}
