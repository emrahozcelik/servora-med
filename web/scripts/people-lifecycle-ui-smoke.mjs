/**
 * Focused rendered-component evidence for PR #441. Synthetic people only.
 * NOT an authenticated AppShell or server-authorization acceptance test.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createServer as createViteServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, process.env.PEOPLE_CAPTURE_DIR ?? '../.impeccable/people-ui-review');
mkdirSync(out, { recursive: true });
const vite = await createViteServer({
  root, configFile: false, appType: 'custom', logLevel: 'error',
  server: { middlewareMode: true, hmr: false },
});
const server = createServer((req, res) => {
  if ((req.url ?? '').split('?')[0] === '/') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/scripts/people-lifecycle-ui-fixture.tsx"></script></body></html>');
    return;
  }
  vite.middlewares(req, res);
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const url = 'http://127.0.0.1:' + server.address().port + '/';
const checks = [];

async function runCase(browser, engine, scenario, width, height) {
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  try {
    await page.goto(url + '?view=' + scenario);
    await page.locator('.page-header-title').waitFor();
    await page.evaluate(() => document.fonts.ready);
    const overflowing = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    assert.equal(overflowing, false, engine + ' ' + scenario + ' ' + width + ': horizontal overflow');
    const rows = await page.locator('.people-list > li').count();
    assert.ok(rows <= 6, engine + ' ' + scenario + ': six-row list bound');
    if (scenario === 'users' || scenario === 'staff') {
      assert.equal(rows, 6, scenario + ': first page has six rows');
      assert.match(await page.locator('.servora-list-pagination').innerText(), /Sayfa 1 \/ 2/);
    }
    if (scenario === 'users-empty') {
      assert.match(await page.locator('main').innerText(), /Aktif kullanıcı yok/);
      assert.equal(await page.locator('.servora-list-pagination').count(), 0);
    }
    if (scenario === 'staff-manager') {
      assert.equal(await page.getByRole('tablist', { name: 'Personel durumu' }).count(), 0);
    }
    if (scenario === 'staff-loading') {
      assert.equal(rows, 0, 'pending filter never exposes old rows');
      assert.match(await page.getByRole('status').innerText(), /listesi yükleniyor/);
    }
    if (scenario === 'detail-staff') {
      assert.equal(await page.getByRole('button', { name: 'Yeniden etkinleştir' }).count(), 0);
      assert.match(await page.locator('.lifecycle-notice').first().innerText(), /yeniden etkinleştirilemez/);
    }
    if (scenario === 'detail-manager') {
      assert.equal(await page.getByRole('button', { name: 'Yeniden etkinleştir' }).count(), 1);
    }
    await page.screenshot({ path: resolve(out, engine + '-' + scenario + '-' + width + '.png'), fullPage: true });

    if (scenario === 'users') {
      await page.locator('[class*="pagination-next"]').click();
      assert.equal(await page.locator('.people-list > li').count(), 2);
      const inactive = page.getByRole('tab', { name: 'Pasif' });
      await inactive.focus();
      await page.keyboard.press('Enter');
      assert.equal(await inactive.getAttribute('aria-selected'), 'true');
      assert.equal(await page.locator('.people-list > li').count(), 2);
      assert.equal(await page.locator('.servora-list-pagination').count(), 0);
      await page.getByRole('tab', { name: 'Aktif' }).click();
      assert.equal(await page.locator('.people-list > li').count(), 6, 'filter reset returns to first page');
    }
    if (scenario === 'staff') {
      await page.getByRole('tab', { name: 'Pasif' }).click();
      await page.getByText('Seçilen personel listesi yükleniyor…').waitFor();
      assert.equal(await page.locator('.people-list > li').count(), 0, 'stale staff rows hidden while loading');
      await page.locator('.people-list > li').first().waitFor();
      assert.equal(await page.locator('.people-list > li').count(), 1);
    }
    if (scenario === 'detail-manager') {
      const action = page.getByRole('button', { name: 'Yeniden etkinleştir' });
      await action.click();
      assert.equal(await action.isDisabled(), true, 'activation button disabled while request pending');
      assert.equal(await page.evaluate(() => window.__peopleRequests.length), 1);
      await page.evaluate(() => window.__releasePeopleAction());
      await page.getByText('Kullanıcı yeniden etkinleştirildi.').waitFor();
      assert.equal(await page.evaluate(() => window.__peopleRequests.length), 1);
    }
    assert.deepEqual(pageErrors, [], engine + ' ' + scenario + ': no page errors');
    checks.push(engine + ' ' + scenario + ' ' + width + 'x' + height + ': PASS');
  } finally {
    await page.close();
  }
}

try {
  for (const [engine, browserType] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await browserType.launch();
    try {
      for (const [scenario, width, height] of [
        ['users', 390, 844], ['users', 1440, 900],
        ['staff', 390, 844], ['staff', 1440, 900],
        ['detail-manager', 390, 844], ['detail-manager', 1440, 900],
        ['detail-staff', 390, 844], ['users-empty', 390, 844],
        ['staff-manager', 390, 844], ['staff-loading', 390, 844],
      ]) await runCase(browser, engine, scenario, width, height);
      if (engine === 'chromium') {
        for (const scenario of ['users', 'staff', 'detail-manager']) {
          await runCase(browser, engine, scenario, 320, 700);
        }
      }
    } finally {
      await browser.close();
    }
  }
  console.log('People lifecycle UI browser acceptance: PASS (' + checks.length + ' scenarios)');
  console.log(checks.join('\n'));
  console.log('Captures: ' + out);
} finally {
  await new Promise((done) => server.close(done));
  await vite.close();
}
