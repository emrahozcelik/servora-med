import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { chromium, expect } from 'playwright/test';
import { createServer } from 'vite';

import { withRetirementFixture } from '../../server/scripts/acceptance/weekly-report-retirement.mjs';

const evidence = resolve(process.env.SOF2C_EVIDENCE_DIRECTORY ?? '/private/tmp/sof2c-browser-evidence');
await mkdir(evidence, { recursive: true });
const results = [];
const { parseWeeklyReportCreateInput } = await import('../../server/dist/modules/weekly-reports/create-input.js');

async function addReport(f, target, periodStart, draft = false) {
  const created = await f.service.createWeeklyReport(f.actor(f.manager), parseWeeklyReportCreateInput({
    clientActionId: randomUUID(), periodStart, assignedTo: target.id,
  }));
  if (draft) {
    await f.service.acceptAssignment(f.actor(target), created.jobCardId,
      { clientActionId: randomUUID(), expectedVersion: 1 });
    await f.service.start(f.actor(target), created.jobCardId,
      { clientActionId: randomUUID(), expectedVersion: 2 });
    await f.service.updateWeeklyReportDraft(f.actor(target), created.jobCardId, {
      expectedVersion: 1,
      draft: { summary: 'OLD_PRIVATE_CLINIC_DRAFT', nextWeekPlan: 'Eski personel planı',
        blockers: null, highlights: null, fieldObservations: null, supportNeeded: null },
      answers: [],
    });
  }
  return created.jobCardId;
}

async function addStaff(f, name) {
  const hash = (await f.pool.query('SELECT password_hash FROM users WHERE id = $1', [f.staff.id])).rows[0].password_hash;
  const user = (await f.pool.query(`INSERT INTO users
    (organization_id, name, email, password_hash, role, is_active, must_change_password)
    VALUES ($1, $2, $3, $4, 'STAFF', true, false) RETURNING id, name, email, role`,
  [f.org, name, `${randomUUID()}@acceptance.local`, hash])).rows[0];
  await f.pool.query('INSERT INTO staff_profiles (organization_id, user_id, title) VALUES ($1, $2, $3)',
    [f.org, user.id, 'Saha temsilcisi']);
  return user;
}

async function addBulkBlockers(f, target, count) {
  for (let index = 0; index < count; index += 1) {
    const root = (await f.pool.query(`INSERT INTO job_cards
      (organization_id, type, status, title, assigned_to, created_by)
      VALUES ($1, 'WEEKLY_REPORT', 'NEW', 'Klinik haftalık raporu', $2, $3) RETURNING id`,
    [f.org, target.id, f.manager.id])).rows[0];
    await f.pool.query(`INSERT INTO weekly_reports
      (organization_id, job_card_id, staff_user_id, period_start, period_end)
      VALUES ($1, $2, $3, '2020-01-06'::date + $4::int * 7,
        '2020-01-12'::date + $4::int * 7)`, [f.org, root.id, target.id, index]);
  }
}

// `reducedMotion` is explicit per flow. This slice owns and validates its blocker
// panel under reduced motion; the untouched manual-report form is exercised with
// the default motion preference because a separate, pre-existing defect keeps
// antd Select popups unaligned when `prefers-reduced-motion: reduce` disables
// antd motion app-wide (recorded as an out-of-scope finding, not fixed here).
async function loggedInPage(browser, f, origin, width, reducedMotion = 'reduce') {
  const context = await browser.newContext({ baseURL: origin, viewport: { width, height: 900 }, reducedMotion });
  const cookie = await f.login(f.administrator);
  const separator = cookie.indexOf('=');
  await context.addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1),
    url: origin, httpOnly: true, sameSite: 'Lax' }]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return { context, page, errors };
}

async function assertUsable(page, name) {
  const geometry = await page.evaluate(() => ({ viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert(geometry.scrollWidth <= geometry.viewport + 1, `${name}: horizontal overflow ${JSON.stringify(geometry)}`);
  const links = page.locator('.offboarding-blocker-list a');
  if (await links.count()) {
    const box = await links.first().boundingBox();
    assert(box && box.height >= 44, `${name}: report link touch height`);
    await links.first().focus();
    await expect(links.first()).toBeFocused();
    await page.keyboard.press('Tab');
    assert(await page.evaluate(() => document.querySelector('.offboarding-blockers')
      ?.contains(document.activeElement)), `${name}: keyboard focus stays in the resolution panel`);
    await page.keyboard.press('Shift+Tab');
    await expect(links.first()).toBeFocused();
  }
  for (const label of ['Güncel sorumlulukları yeniden yükle', 'Gerekirse bağımsız yeni rapor oluştur']) {
    const box = await page.getByRole(label.startsWith('Güncel') ? 'button' : 'link', { name: label }).boundingBox();
    assert(box && box.height >= 44, `${name}: ${label} touch height`);
  }
  await page.screenshot({ path: resolve(evidence, `${name}.png`), fullPage: true });
}

async function resolveAndOffboard(browser, f, origin, width, target, jobCardId, replacementPeriod) {
  const { context, page, errors } = await loggedInPage(browser, f, origin, width, 'no-preference');
  try {
    await page.goto(`/users/${target.id}`);
    await page.getByRole('button', { name: 'Personeli devre dışı bırak' }).click();
    await expect(page.getByText('1 engel var; 1 kayıt görüntüleniyor.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Kararları onayla' })).toHaveCount(0);
    await expect(page.locator('.offboarding-blockers')).not.toContainText('OLD_PRIVATE_CLINIC_DRAFT');
    const reportLink = page.getByRole('link', { name: 'İş kartında incele' });
    await expect(reportLink).toHaveAttribute('href', `/jobs/${jobCardId}?offboardingTarget=${target.id}`);
    await assertUsable(page, `${width}-blocker`);
    await reportLink.click();
    await expect(page).toHaveURL(new RegExp(`/jobs/${jobCardId}\\?offboardingTarget=${target.id}$`));
    await page.getByRole('button', { name: 'İşi iptal et', exact: true }).first().click();
    const dialog = page.getByRole('dialog', { name: 'İşi iptal et' });
    await dialog.getByRole('textbox', { name: 'İptal nedeni' }).fill('Personel ayrılışı nedeniyle yönetici kararı.');
    await dialog.getByRole('button', { name: 'İşi iptal et' }).click();
    await expect(page.locator('[data-job-detail-meta]')).toContainText('İptal edildi');
    await page.getByRole('link', { name: 'Personel ayrılma ekranına dön ve planı yenile' }).click();
    await expect(page.getByRole('combobox', { name: 'İdari neden' })).toBeVisible();
    const reasonBox = await page.getByRole('combobox', { name: 'İdari neden' }).boundingBox();
    assert(reasonBox && reasonBox.height >= 44, `${width}: fresh-preview reason touch height`);
    await expect(page.locator('.offboarding-blockers')).toHaveCount(0);
    await page.screenshot({ path: resolve(evidence, `${width}-fresh-preview.png`), fullPage: true });
    await page.getByRole('link', { name: 'Gerekirse yeni personel için bağımsız haftalık rapor oluştur' }).click();
    await expect(page.locator('#weekly-period')).toBeVisible();
    await page.locator('#weekly-period').fill(replacementPeriod);
    await page.locator('#weekly-assignees').click();
    await page.getByText(f.secondStaff.name, { exact: true }).last().click();
    await page.locator('#weekly-instructions').fill('Yeni personel için bağımsız saha raporu.');
    await page.getByRole('button', { name: 'Rapor isteklerini oluştur' }).click();
    await expect(page).toHaveURL(new RegExp(`/jobs/[0-9a-f-]+\\?offboardingTarget=${target.id}$`));
    await page.getByRole('link', { name: 'Personel ayrılma ekranına dön ve planı yenile' }).click();
    await expect(page.getByRole('combobox', { name: 'İdari neden' })).toBeVisible();
    await page.getByRole('combobox', { name: 'İdari neden' }).selectOption('ACCESS_ENDED');
    await page.getByRole('button', { name: 'Kararları onayla' }).click();
    await page.getByRole('dialog', { name: 'Personel devre dışı bırakılsın mı?' })
      .getByRole('button', { name: 'Erişimi sonlandır' }).click();
    await expect(page.getByText('Personel devre dışı bırakıldı', { exact: true })).toBeVisible();
    await page.screenshot({ path: resolve(evidence, `${width}-complete.png`), fullPage: true });
    assert.deepEqual(errors, [], `browser errors at ${width}`);
    const original = (await f.pool.query(`SELECT j.status, r.staff_user_id, r.draft_summary
      FROM job_cards j JOIN weekly_reports r ON r.job_card_id = j.id WHERE j.id = $1`, [jobCardId])).rows[0];
    assert.equal(original.status, 'CANCELLED');
    assert.equal(original.staff_user_id, target.id);
    const replacement = (await f.pool.query(`SELECT r.job_card_id, r.draft_summary, r.manager_questions,
      r.staff_user_id FROM weekly_reports r WHERE r.organization_id = $1 AND r.staff_user_id = $2
      AND r.period_start = $3`, [f.org, f.secondStaff.id, replacementPeriod])).rows[0];
    assert(replacement && replacement.job_card_id !== jobCardId);
    assert.equal(replacement.draft_summary, null);
    assert.deepEqual(replacement.manager_questions, []);
    assert.equal((await f.pool.query('SELECT is_active FROM users WHERE id = $1', [target.id])).rows[0].is_active, false);
    results.push({ width, flow: 'resolve-create-refresh-execute', status: 'PASS' });
  } finally {
    await context.close();
  }
}

await withRetirementFixture(async (f) => {
  const desktopJob = await addReport(f, f.staff, '2026-08-10', true);
  const mobileStaff = await addStaff(f, 'Mobil Klinik Temsilcisi');
  const mobileJob = await addReport(f, mobileStaff, '2026-08-17');
  await addBulkBlockers(f, f.secondStaff, 201);
  const vite = await createServer({ root: resolve('web'), server: { host: '127.0.0.1', port: 5173, strictPort: true,
    proxy: { '/api': { target: f.origin, changeOrigin: true } } } });
  let browser;
  try {
    await vite.listen();
    const origin = vite.resolvedUrls.local[0];
    browser = await chromium.launch({ headless: true });
    const { context, page, errors } = await loggedInPage(browser, f, origin, 390);
    try {
      await page.goto(`/users/${f.secondStaff.id}`);
      await page.getByRole('button', { name: 'Personeli devre dışı bırak' }).click();
      await expect(page.getByText('201 engel var; 50 kayıt görüntüleniyor.')).toBeVisible();
      let failedOnce = false;
      await page.route('**/offboarding/weekly-report-blockers?**', async (route) => {
        if (!failedOnce) { failedOnce = true; await route.abort('connectionfailed'); }
        else await route.continue();
      });
      await page.getByRole('button', { name: 'Daha fazla rapor göster' }).click();
      await expect(page.getByRole('alert')).toContainText('Sunucuya ulaşılamadı');
      await page.getByRole('button', { name: 'Daha fazla rapor göster' }).click();
      for (let index = 0; index < 3; index += 1) {
        await page.getByRole('button', { name: 'Daha fazla rapor göster' }).click();
      }
      await expect(page.getByText('201 engel var; 201 kayıt görüntüleniyor.')).toBeVisible();
      assert.equal(await page.locator('.offboarding-blocker-list li').count(), 201);
      const last = page.locator('.offboarding-blocker-list li').last();
      await last.scrollIntoViewIfNeeded();
      await expect(last).toBeVisible();
      await assertUsable(page, '390-pagination-201');
      assert.deepEqual(errors, []);
      results.push({ width: 390, flow: '201-keyset-pages-network-retry', status: 'PASS' });
    } finally { await context.close(); }
    await resolveAndOffboard(browser, f, origin, 1440, f.staff, desktopJob, '2026-10-19');
    await resolveAndOffboard(browser, f, origin, 390, mobileStaff, mobileJob, '2026-10-26');
    await f.unchanged('SOF-2C browser resolution leaves historical recurrence and submissions unchanged');
  } finally {
    await browser?.close();
    await vite.close();
    await writeFile(resolve(evidence, 'results.json'), JSON.stringify(results, null, 2));
  }
});
console.log('SOF2C_BROWSER_PASS', results.length);
