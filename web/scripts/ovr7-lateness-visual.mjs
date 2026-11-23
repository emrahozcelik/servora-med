/**
 * OVR-7 lateness visual evidence runner (docs/ui/visual-review-workflow.md).
 *
 * Renders the real React components — StaffOperationalReport and the Reports
 * dashboard with LatenessSummaryCard — against deterministic synthetic data,
 * with production CSS, the canonical Ant provider and the reports shell, then
 * captures desktop and 390x844 screenshots and checks overflow, 44 px targets
 * and the list disclosure.
 *
 * Usage:
 *   node scripts/ovr7-lateness-visual.mjs
 *   OVR7_CAPTURE_DIR=/path/to/out node scripts/ovr7-lateness-visual.mjs
 */
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(
  process.env.OVR7_CAPTURE_DIR
  ?? '/private/tmp/claude-501/-Users-emrah-Documents-Servora-Med/5684dd8e-7808-47ef-b1a3-f9985fd782d4/scratchpad/ovr7-shots',
);
mkdirSync(out, { recursive: true });

const vite = await createViteServer({
  root,
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false },
});
const server = createServer((req, res) => {
  if (req.url.split('?')[0] === '/') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><html lang="tr"><head><meta charset="utf-8">'
      + '<meta name="viewport" content="width=device-width,initial-scale=1">'
      + '</head><body><div id="root"></div>'
      + '<script type="module" src="/scripts/ovr7-lateness-fixture.tsx"></script>'
      + '</body></html>');
  } else {
    vite.middlewares(req, res);
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const pageErrors = [];
const checks = [];
const shots = [];

function track(page) {
  page.on('pageerror', (error) => pageErrors.push(error.message));
}

async function capture(page, name, { viewport }) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: resolve(out, `${name}.png`),
    fullPage: true,
    animations: 'disabled',
  });
  shots.push(`${name}.png (${viewport.width}x${viewport.height})`);
}

async function assertNoOverflow(page, name) {
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true,
    `${name}: document must not overflow horizontally`,
  );
}

async function assertTargets(page, names, name) {
  for (const buttonName of names) {
    const box = await page.getByRole('button', { name: buttonName, exact: true }).first()
      .boundingBox();
    assert.ok(box, `${name}: ${buttonName} must be visible`);
    assert.ok(box.height >= 44, `${name}: ${buttonName} must be at least 44 px high`);
    assert.ok(box.width >= 44, `${name}: ${buttonName} must be at least 44 px wide`);
  }
}

async function summaryPayload(page) {
  return page.evaluate(() => globalThis.__ovr7LatenessFixtures.organizationLateness);
}

try {
  // ---- Staff report (management view and Staff self view share the component) ----
  for (const [label, width, height] of [['desktop', 1440, 960], ['mobile', 390, 844]]) {
    const page = await browser.newPage({
      viewport: { width, height },
      hasTouch: width < 600,
      reducedMotion: 'reduce',
    });
    track(page);

    await page.goto(`${origin}/?view=staff&case=data`);
    await page.getByRole('heading', { name: 'Gecikme kayıtları' }).waitFor();
    await page.getByRole('button', { name: 'Kayıtları göster', exact: true }).waitFor();
    await assertNoOverflow(page, `staff-${label}-data (collapsed)`);
    await capture(page, `staff-${label}-data`, { viewport: { width, height } });

    const toggle = page.getByRole('button', { name: 'Kayıtları göster', exact: true });
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    await toggle.click();
    assert.equal(
      await page.getByRole('button', { name: 'Kayıtları gizle', exact: true })
        .getAttribute('aria-expanded'),
      'true',
    );
    await page.locator('.staff-lateness-row').first().waitFor();
    assert.equal(await page.locator('.staff-lateness-row').count(), 20);
    await assertTargets(page, ['Kayıtları gizle', 'Daha fazla göster'], `staff-${label}-data`);
    await assertNoOverflow(page, `staff-${label}-data (expanded)`);
    await capture(page, `staff-${label}-data-list`, { viewport: { width, height } });

    await page.getByRole('button', { name: 'Daha fazla göster', exact: true }).click();
    await page.locator('.staff-lateness-row').nth(24).waitFor();
    assert.equal(await page.locator('.staff-lateness-row').count(), 25);
    assert.equal(
      await page.getByRole('button', { name: 'Daha fazla göster', exact: true }).count(),
      0,
    );
    checks.push(`staff-${label}: 20-row pages append to 25 and the pager closes`);
    await page.close();

    const emptyPage = await browser.newPage({
      viewport: { width, height },
      hasTouch: width < 600,
      reducedMotion: 'reduce',
    });
    track(emptyPage);
    await emptyPage.goto(`${origin}/?view=staff&case=empty`);
    await emptyPage.getByText('Bu dönemde gecikme kaydı yok.').waitFor();
    assert.equal(
      await emptyPage.getByRole('button', { name: 'Kayıtları göster', exact: true }).count(),
      0,
    );
    await assertNoOverflow(emptyPage, `staff-${label}-empty`);
    await capture(emptyPage, `staff-${label}-empty`, { viewport: { width, height } });
    await emptyPage.close();

    const errorPage = await browser.newPage({
      viewport: { width, height },
      hasTouch: width < 600,
      reducedMotion: 'reduce',
    });
    track(errorPage);
    await errorPage.goto(`${origin}/?view=staff&case=list-error`);
    await errorPage.getByRole('button', { name: 'Kayıtları göster', exact: true }).click();
    await errorPage.getByRole('alert').waitFor();
    await assertTargets(errorPage, ['Tekrar dene'], `staff-${label}-list-error`);
    await capture(errorPage, `staff-${label}-list-error`, { viewport: { width, height } });
    await errorPage.getByRole('button', { name: 'Tekrar dene', exact: true }).click();
    await errorPage.locator('.staff-lateness-row').first().waitFor();
    assert.equal(await errorPage.getByRole('alert').count(), 0);
    checks.push(`staff-${label}-list-error: local error and retry load the first page`);
    await assertNoOverflow(errorPage, `staff-${label}-list-error`);
    await errorPage.close();
  }

  // ---- Organization card on the Reports page ----
  for (const [label, width, height] of [['desktop', 1440, 960], ['mobile', 390, 844]]) {
    for (const scenario of ['data', 'empty', 'error']) {
      const page = await browser.newPage({
        viewport: { width, height },
        hasTouch: width < 600,
        reducedMotion: 'reduce',
      });
      track(page);
      let failing = scenario === 'error';
      await page.route('**/api/reports/lateness**', async (route) => {
        if (failing) {
          return route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({
              error: 'Rapor servisi geçici olarak yanıt vermedi.',
              code: 'UNAVAILABLE',
            }),
          });
        }
        if (scenario === 'empty') {
          return route.fulfill({
            json: await page.evaluate(
              () => globalThis.__ovr7LatenessFixtures.emptyOrganizationLateness,
            ),
          });
        }
        return route.fulfill({ json: await summaryPayload(page) });
      });

      await page.goto(`${origin}/?view=management&case=${scenario}`);
      if (scenario === 'error') {
        await page.getByRole('button', { name: 'Tekrar dene', exact: true }).waitFor();
        assert.match(
          await page.locator('[role="alert"]').first().innerText(),
          /Rapor servisi geçici olarak yanıt vermedi\./,
        );
        // The operational summary stays available while the local card fails.
        assert.equal(await page.locator('[data-report-kpi]').count(), 5);
        await assertTargets(page, ['Tekrar dene'], `management-${label}-error`);
        await assertNoOverflow(page, `management-${label}-error`);
        await capture(page, `management-${label}-error`, { viewport: { width, height } });
        failing = false;
        await page.getByRole('button', { name: 'Tekrar dene', exact: true }).click();
        await page.getByRole('heading', { name: 'Yönetici onayı beklemesi' }).waitFor();
        checks.push(`management-${label}-error: local card error, retry recovers`);
      } else if (scenario === 'empty') {
        await page.getByText('Bu dönemde gecikme kaydı yok.').waitFor();
        await assertNoOverflow(page, `management-${label}-empty`);
        await capture(page, `management-${label}-empty`, { viewport: { width, height } });
        checks.push(`management-${label}-empty: single empty sentence`);
      } else {
        await page.getByRole('heading', { name: 'Yönetici onayı beklemesi' }).waitFor();
        const card = page.locator('.report-lateness');
        assert.match(await card.innerText(), /10 kayıt · 8 iş/);
        assert.match(await card.innerText(), /3 kayıt · 3 iş/);
        assert.match(await card.innerText(), /1 kayıt · 1 iş/);
        assert.match(await card.innerText(), /Devam eden en uzun süre/);
        await assertTargets(page, ['Yenile'], `management-${label}-data`);
        await assertNoOverflow(page, `management-${label}-data`);
        await capture(page, `management-${label}-data`, { viewport: { width, height } });
        const before = await card.innerText();
        await page.getByRole('button', { name: 'Yenile', exact: true }).click();
        await page.getByRole('heading', { name: 'Yönetici onayı beklemesi' }).waitFor();
        assert.equal(await card.innerText(), before);
        checks.push(`management-${label}-data: groups, durations, freshness and Yenile`);
      }
      await page.close();
    }
  }

  writeFileSync(resolve(out, 'browser-checks.json'), JSON.stringify({
    sourceCommit: process.env.OVR7_SOURCE_SHA ?? 'working-tree',
    runner: 'web/scripts/ovr7-lateness-visual.mjs',
    fixture: 'web/scripts/ovr7-lateness-fixture.tsx',
    browser: `Chromium ${browser.version()}`,
    viewports: ['1440x960', '390x844'],
    timezone: 'Europe/Istanbul',
    clock: 'generatedAt 2026-11-02T09:15:00.000Z, range 2026-09-01..2026-10-31',
    syntheticData: true,
    mockedServices: ['GET /api/reports/lateness (page.route)'],
    screenshots: shots,
    checks,
  }, null, 2));

  if (pageErrors.length > 0) throw new Error(pageErrors.join('\n'));
  console.log(`OVR-7 lateness screenshots written to ${out}`);
  console.log(shots.join('\n'));
} finally {
  await browser.close();
  await vite.close();
  await new Promise((done) => server.close(done));
}
