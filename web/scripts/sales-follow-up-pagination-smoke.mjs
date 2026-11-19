import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';

// Run from web/. Rendered evidence for UI audit F-10 on /reports/sales-follow-up:
// both server-paged queue pagers must use the owned ServoraListPagination
// contract — >= 44 x 44 CSS px prev/next targets, Turkish accessible names and
// the same pointer/keyboard paging as every other list. Deterministic synthetic
// data, production CSS, real components, no API traffic.
const MIN_TARGET_PX = 44;
const PAGE_SIZE = 10;
const VIEWPORTS = [[390, 844], [1440, 900]];

const html = `<!doctype html><html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
<div id="root"></div><script type="module" src="/scripts/sales-follow-up-pagination-fixture.tsx"></script>
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
const capture = process.env.SALES_FOLLOW_UP_CAPTURE;
if (capture) mkdirSync(capture, { recursive: true });
const browser = await chromium.launch();
const errors = [];
const violations = [];
const results = [];

function check(condition, message) {
  if (condition) return true;
  violations.push(message);
  return false;
}

function rectScript() {
  const round = (value) => Math.round(value * 10) / 10;
  const rect = (element) => {
    const box = element.getBoundingClientRect();
    return { width: round(box.width), height: round(box.height) };
  };
  const pagers = [...document.querySelectorAll('.servora-list-pagination')].map((nav) => ({
    label: nav.getAttribute('aria-label'),
    summary: nav.querySelector('.servora-list-pagination__summary')?.textContent?.trim() ?? null,
    items: [...nav.querySelectorAll('[class*="pagination-prev"], [class*="pagination-next"]')].map((item) => {
      const button = item.querySelector('button');
      return {
        name: item.getAttribute('aria-label'),
        title: item.getAttribute('title'),
        role: item.getAttribute('role'),
        ariaDisabled: item.getAttribute('aria-disabled'),
        tabIndex: item.tabIndex,
        ...rect(item),
        button: button ? { name: button.getAttribute('aria-label'), title: button.getAttribute('title'), ...rect(button) } : null,
      };
    }),
    numberedItems: nav.querySelectorAll('li[class*="pagination-item"]').length,
    unnamedButtons: [...nav.querySelectorAll('button')]
      .filter((button) => !(button.getAttribute('aria-label') ?? button.textContent ?? '').trim()).length,
  }));
  return {
    pagers,
    // Ant table pagination must be off: its 33 px items and unnamed disabled
    // controls were the audit defect.
    tablePaginators: document.querySelectorAll('.ant-table-pagination, .servora-ant-table-pagination').length,
    // Legacy Ant table pager targets, measured only so a pre-change run reports
    // the audit defect instead of a bare missing-selector timeout.
    tablePagerItems: [...document.querySelectorAll('.ant-table-pagination [class*="pagination-prev"], .ant-table-pagination [class*="pagination-next"], .servora-ant-table-pagination [class*="pagination-prev"], .servora-ant-table-pagination [class*="pagination-next"]')]
      .map((item) => {
        const button = item.querySelector('button');
        return {
          name: item.getAttribute('aria-label') ?? button?.getAttribute('aria-label') ?? null,
          ...rect(item),
          button: button ? { name: button.getAttribute('aria-label'), title: button.getAttribute('title'), ...rect(button) } : null,
        };
      }),
    unnamedButtons: [...document.querySelectorAll('button')]
      .filter((button) => !((button.getAttribute('aria-label') ?? button.textContent ?? '').trim()))
      .map((button) => button.outerHTML.slice(0, 120)),
    overflow: document.documentElement.scrollWidth > innerWidth + 1,
  };
}

try {
  for (const [width, height] of VIEWPORTS) {
    const page = await browser.newPage({
      viewport: { width, height }, locale: 'tr-TR', timezoneId: 'Europe/Istanbul',
      reducedMotion: 'reduce', hasTouch: width < 768,
    });
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => {
      // Vite's dev client is transport noise in middleware mode, especially
      // when another smoke owns the default HMR port; app errors stay.
      if (/WebSocket/.test(error.message)) return;
      errors.push(`${width}: ${error.message}`);
    });
    page.on('console', message => {
      if (message.type() !== 'error') return;
      const text = message.text();
      if (/WebSocket|\[vite\]|Vite server/.test(text)) return;
      // Pre-existing Ant 6.7 deprecation notice from the report's expandable
      // table (and StaffPerformanceTable); not a rendering error and out of scope.
      if (/^Warning: \[antd: .*`.*` is deprecated/.test(text)) return;
      errors.push(`${width}: ${text}`);
    });
    await page.goto(origin);
    await page.locator('.servora-list-pagination, .servora-ant-table-pagination, .ant-table-pagination').first().waitFor();
    await page.evaluate(() => document.fonts.ready);

    if (capture) await page.screenshot({ path: `${capture}/sales-follow-up-pager-${width}x${height}.png`, fullPage: true });

    const measured = await page.evaluate(rectScript);
    check(!measured.overflow, `${width}: horizontal overflow`);
    check(measured.tablePaginators === 0,
      `${width}: Ant table pagination must be disabled; legacy targets ${JSON.stringify(measured.tablePagerItems)}`);
    check(measured.unnamedButtons.length === 0, `${width}: unnamed buttons ${JSON.stringify(measured.unnamedButtons)}`);
    const hasOwnedPagers = check(measured.pagers.length === 2,
      `${width}: two owned pagers; legacy targets ${JSON.stringify(measured.tablePagerItems)}`);

    if (hasOwnedPagers) {
      const [salesPagerData, proposalPagerData] = measured.pagers;
      check(JSON.stringify(measured.pagers.map(pager => pager.label)) === JSON.stringify([
        'Satış görüşmesi kuyruğu sayfaları',
        'Takip önerisi sayfaları',
      ]), `${width}: Turkish pager landmarks ${JSON.stringify(measured.pagers.map(pager => pager.label))}`);
      check(/^Sayfa 1 \/ 3 · Toplam 25 satış görüşmesi işi$/.test(salesPagerData.summary ?? ''),
        `${width}: sales pager summary ${salesPagerData.summary}`);
      check(/^Sayfa 1 \/ 2 · Toplam 13 takip önerisi$/.test(proposalPagerData.summary ?? ''),
        `${width}: proposal pager summary ${proposalPagerData.summary}`);
      for (const pager of measured.pagers) {
        check(pager.items.length === 2, `${width}: ${pager.label} prev/next items`);
        check(pager.numberedItems === 0, `${width}: ${pager.label} has no numbered page items`);
        check(pager.unnamedButtons === 0, `${width}: ${pager.label} unnamed buttons`);
        for (const item of pager.items) {
          const expected = item.name === 'Önceki sayfa' ? 'Önceki sayfa' : 'Sonraki sayfa';
          check(item.name === expected, `${width}: ${pager.label} Turkish arrow name ${item.name}`);
          const expectedTitle = expected === 'Önceki sayfa' ? 'Önceki Sayfa' : 'Sonraki Sayfa';
          check([item.title, item.button?.title].includes(expectedTitle),
            `${width}: ${pager.label} Turkish arrow title ${item.title ?? item.button?.title}`);
          check(item.role === 'button', `${width}: ${pager.label} ${item.name} role ${item.role}`);
          check(item.width >= MIN_TARGET_PX && item.height >= MIN_TARGET_PX,
            `${width}: ${pager.label} ${item.name} target ${item.width}×${item.height}`);
          check(Boolean(item.button), `${width}: ${pager.label} ${item.name} keeps a native inner button`);
          check(item.button && item.button.width >= MIN_TARGET_PX && item.button.height >= MIN_TARGET_PX,
            `${width}: ${pager.label} ${item.name} inner button ${item.button && `${item.button.width}×${item.button.height}`}`);
        }
        const [prev, next] = pager.items;
        check(prev.ariaDisabled === 'true', `${width}: ${pager.label} previous arrow is disabled on page 1`);
        check(prev.tabIndex === -1, `${width}: ${pager.label} disabled previous arrow leaves the tab order`);
        check(next.ariaDisabled === 'false', `${width}: ${pager.label} next arrow is enabled on page 1`);
        check(next.tabIndex === 0, `${width}: ${pager.label} next arrow is tabbable on page 1`);
      }

      const [salesPager, proposalPager] = await page.locator('.servora-list-pagination').all();
      try {
        // Pointer paging on the first queue: page 2 of 3, offset = page size.
        await salesPager.locator('[class*="pagination-next"] button').click();
        await salesPager.locator('.servora-list-pagination__summary').filter({ hasText: 'Sayfa 2 / 3' }).waitFor();
        check(/Sayfa 1 \/ 2/.test(await proposalPager.locator('.servora-list-pagination__summary').innerText()),
          `${width}: proposal pager must not follow the sales pager`);

        // Keyboard paging matches every other owned list: Enter advances once
        // and focus returns to the pager landmark, Space then walks back.
        await salesPager.locator('[class*="pagination-next"]').focus();
        await page.keyboard.press('Enter');
        await salesPager.locator('.servora-list-pagination__summary').filter({ hasText: 'Sayfa 3 / 3' }).waitFor();
        check(await page.evaluate(() => document.activeElement?.classList.contains('servora-list-pagination')),
          `${width}: keyboard paging must restore focus to the pager`);
        await page.keyboard.press('Tab');
        await page.keyboard.press(' ');
        await salesPager.locator('.servora-list-pagination__summary').filter({ hasText: 'Sayfa 2 / 3' }).waitFor();
        check(await page.evaluate(() => document.activeElement?.classList.contains('servora-list-pagination')),
          `${width}: Space on the previous arrow must restore pager focus`);

        // The second queue pages independently.
        await proposalPager.locator('[class*="pagination-next"] button').click();
        await proposalPager.locator('.servora-list-pagination__summary').filter({ hasText: 'Sayfa 2 / 2' }).waitFor();
        check(/Sayfa 2 \/ 3/.test(await salesPager.locator('.servora-list-pagination__summary').innerText()),
          `${width}: sales pager must not follow the proposal pager`);
        if (capture) await page.screenshot({ path: `${capture}/sales-follow-up-pager-${width}x${height}-page2.png`, fullPage: true });
      } catch (error) {
        violations.push(`${width}: pager interaction failed — ${error.message}`);
      }
    }

    results.push({
      width, height, pageSize: PAGE_SIZE,
      tablePaginators: measured.tablePaginators,
      legacyTargets: measured.tablePagerItems,
      pagers: measured.pagers.map(pager => ({
        label: pager.label,
        summary: pager.summary,
        items: pager.items.map(item => ({
          name: item.name,
          role: item.role,
          tabIndex: item.tabIndex,
          ariaDisabled: item.ariaDisabled,
          ...(item.button ? { width: item.button.width, height: item.button.height } : {}),
        })),
      })),
    });
    await page.close();
  }
  assert.deepEqual(errors, [], 'no page or console errors');
  assert.deepEqual(violations, [], `sales follow-up pager contract violated:\n- ${violations.join('\n- ')}`);
  console.log(JSON.stringify({ ok: true, browser: browser.version(), engine: 'chromium', results }, null, 2));
} finally {
  await browser.close();
  await new Promise(resolveClose => server.close(resolveClose));
  await vite.close();
}
