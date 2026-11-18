import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { createServer as createViteServer } from 'vite';

// Run from web/. Synthetic data only; /api/customers is fulfilled locally and
// every other API request fails, so the fixture cannot mutate a database.
const out = process.env.CUSTOMER_SEARCH_CAPTURE_DIR;
assert.ok(out, 'Set CUSTOMER_SEARCH_CAPTURE_DIR to a task-owned output directory.');
mkdirSync(out, { recursive: true });
const root = process.cwd();
const html = '<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/scripts/customer-search-load-more-fixture.tsx"></script></body></html>';
const vite = await createViteServer({
  root, configFile: false, appType: 'custom', logLevel: 'error',
  server: { middlewareMode: true, hmr: false },
});
const server = createServer((req, res) => {
  if ((req.url ?? '/').split('?')[0] === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } else vite.middlewares(req, res, () => { res.writeHead(404); res.end(); });
});
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const origin = `http://127.0.0.1:${server.address().port}`;

const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const allCustomers = Array.from({ length: 45 }, (_, index) => {
  const n = index + 1;
  return {
    id: `customer-${String(n).padStart(2, '0')}`, organizationId: ORG,
    name: `Sentetik Klinik ${String(n).padStart(2, '0')}`, customerType: 'clinic',
    taxNumber: null, phone: `0532000${String(n).padStart(4, '0')}`, email: null,
    city: 'İstanbul', district: null, address: null, assignedStaffUserId: null,
    status: 'active', version: 1, assignedStaffName: null, primaryContact: null,
  };
});
function pageItems(offset) {
  if (offset === 0) return allCustomers.slice(0, 20);
  if (offset === 20) {
    // Concurrent inserts can duplicate rows across pages; the client keeps the
    // first occurrence and pages from the deduplicated length (38).
    return [
      { ...allCustomers[19], name: 'KOPYA-20' },
      { ...allCustomers[18], name: 'KOPYA-19' },
      ...allCustomers.slice(20, 38),
    ];
  }
  if (offset === 38) return allCustomers.slice(38);
  return [];
}

const evidence = { sourceHead: null, browsers: {}, checks: [], files: {} };
try {
  evidence.sourceHead = (await import('node:child_process')).execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await launcher.launch();
    evidence.browsers[engine] = browser.version();
    for (const width of [390, 1440]) {
      const height = width < 768 ? 844 : 960;
      const page = await browser.newPage({
        viewport: { width, height }, locale: 'tr-TR', timezoneId: 'Europe/Istanbul',
        reducedMotion: 'reduce', hasTouch: width < 768,
      });
      const errors = [];
      const requests = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => {
        if (message.type() !== 'error') return;
        const text = message.text();
        if (/WebSocket|\[vite\]|Vite server/.test(text)) return;
        errors.push(text);
      });
      await page.route('**/api/**', async route => {
        const url = new URL(route.request().url());
        if (route.request().method() !== 'GET') return route.fulfill({ status: 500, json: {} });
        if (url.pathname !== '/api/customers') return route.fulfill({ status: 500, json: {} });
        const limit = Number(url.searchParams.get('limit'));
        const offset = Number(url.searchParams.get('offset'));
        const q = url.searchParams.get('q') ?? '';
        requests.push({ limit, offset, q });
        const rows = pageItems(offset).filter(item => q === '' || item.name.includes(q));
        return route.fulfill({ json: { items: rows, total: allCustomers.length, limit, offset } });
      });
      const open = async (mode) => {
        await page.goto(`${origin}/?mode=${mode}`);
        await page.locator('html[data-fixture-ready="true"]').waitFor();
        await page.evaluate(() => document.fonts.ready);
        await page.locator('#customer-search').click();
        await page.locator('.servora-ant-select-dropdown').waitFor();
      };
      const scrollList = async (index) => {
        await page.locator('.servora-ant-select-dropdown .servora-ant-select-dropdown-list-holder').evaluate((element, targetIndex) => {
          const row = element.querySelector('.servora-ant-select-item-option');
          const itemHeight = row?.getBoundingClientRect().height ?? 44;
          element.scrollTop = targetIndex === 'bottom'
            ? element.scrollHeight
            : Math.max(0, targetIndex * itemHeight - 60);
          element.dispatchEvent(new Event('scroll', { bubbles: true }));
        }, index);
      };
      const loadMore = page.getByRole('button', { name: /Daha fazla yükle/ });

      // Pointer path: open → pointer load-more → scroll → pointer select page-2 row.
      await open('pointer');
      const firstPageTwo = page.waitForResponse(response => new URL(response.url()).pathname === '/api/customers'
        && new URL(response.url()).searchParams.get('offset') === '20');
      await loadMore.click();
      await firstPageTwo;
      assert.deepEqual(requests.map(item => item.offset), [0, 20]);
      await scrollList(20);
      const pageTwoOption = page.locator('.servora-ant-select-item-option', { hasText: 'Sentetik Klinik 21' });
      await pageTwoOption.waitFor();
      const bodyText = await page.locator('.servora-ant-select-dropdown').innerText();
      assert.ok(!bodyText.includes('KOPYA'), `${engine}/${width}: duplicate ids must keep first occurrence`);
      await pageTwoOption.click();
      await page.locator('[data-fixture-selected]').filter({ hasText: 'Seçili: customer-21 — Sentetik Klinik 21' }).waitFor();
      const captureName = `customer-search-page2-pointer-${engine}-${width}`;
      await page.screenshot({ path: resolve(out, `${captureName}.png`) });
      evidence.files[`${captureName}.png`] = createHash('sha256')
        .update(readFileSync(resolve(out, `${captureName}.png`))).digest('hex');
      evidence.checks.push({ engine, width, mode: 'pointer', offsets: requests.map(item => item.offset), selected: 'customer-21' });
      requests.length = 0;

      // Keyboard path: open → keyboard load-more → arrow to the 21st row → Enter.
      await open('keyboard');
      await loadMore.focus();
      const keyboardPageTwo = page.waitForResponse(response => new URL(response.url()).pathname === '/api/customers'
        && new URL(response.url()).searchParams.get('offset') === '20');
      await page.keyboard.press('Enter');
      await keyboardPageTwo;
      await page.locator('#customer-search').focus();
      // Move the active row with the keyboard until the page-two target is
      // active (the first ArrowDown keeps the initial row). A realistic
      // key-repeat interval keeps each native key event in its own task.
      let activeRow = '';
      for (let index = 0; index < 30; index += 1) {
        activeRow = (await page.locator('.servora-ant-select-item-option-active').innerText()).split('\n')[0];
        if (activeRow === 'Sentetik Klinik 21') break;
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(30);
      }
      assert.equal(activeRow, 'Sentetik Klinik 21', `${engine}/${width}: ArrowDown must reach page-two row`);
      await page.keyboard.press('Enter');
      await page.locator('[data-fixture-selected]').filter({ hasText: 'Seçili: customer-21 — Sentetik Klinik 21' }).waitFor();
      evidence.checks.push({ engine, width, mode: 'keyboard', offsets: requests.map(item => item.offset), selected: 'customer-21' });
      requests.length = 0;

      // Deduplicated paging: second page contains duplicate ids; the next page
      // must be requested at the deduplicated length (38) and total stays 45.
      await open('paging');
      const pagingPageTwo = page.waitForResponse(response => new URL(response.url()).pathname === '/api/customers'
        && new URL(response.url()).searchParams.get('offset') === '20');
      await loadMore.click();
      await pagingPageTwo;
      const pagingPageThree = page.waitForResponse(response => new URL(response.url()).pathname === '/api/customers'
        && new URL(response.url()).searchParams.get('offset') === '38');
      await loadMore.click();
      await pagingPageThree;
      await scrollList('bottom');
      await page.locator('.servora-ant-select-item-option', { hasText: 'Sentetik Klinik 45' }).waitFor();
      assert.deepEqual(requests.map(item => item.offset), [0, 20, 38]);
      assert.equal(await page.getByRole('button', { name: /Daha fazla yükle/ }).count(), 0);
      const pagingCapture = `customer-search-page3-${engine}-${width}`;
      await page.screenshot({ path: resolve(out, `${pagingCapture}.png`) });
      evidence.files[`${pagingCapture}.png`] = createHash('sha256')
        .update(readFileSync(resolve(out, `${pagingCapture}.png`))).digest('hex');
      evidence.checks.push({ engine, width, mode: 'paging', offsets: requests.map(item => item.offset), totalRows: 45 });
      assert.deepEqual(errors, [], `${engine}/${width}: page/console errors`);
      await page.close();
    }
    await browser.close();
  }
  writeFileSync(resolve(out, 'evidence.json'), JSON.stringify({
    ...evidence,
    fixture: 'web/scripts/customer-search-load-more-fixture.tsx',
    runner: 'web/scripts/customer-search-load-more-smoke.mjs',
    command: 'CUSTOMER_SEARCH_CAPTURE_DIR=<dir> node scripts/customer-search-load-more-smoke.mjs',
    date: new Date().toISOString(),
    viewports: [390, 1440], locale: 'tr-TR', timezone: 'Europe/Istanbul',
    syntheticData: true, apiMutations: 'rejected', database: 'not used',
  }, null, 2));
  console.log(JSON.stringify(evidence.checks, null, 2));
} finally {
  await new Promise(resolveClose => server.close(resolveClose));
  await vite.close();
}
