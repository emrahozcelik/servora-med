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
    ...(draft ? { questions: [{ key: 'old_q', prompt: 'OLD_PRIVATE_CLINIC_QUESTION' }] } : {}),
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
      answers: [{ questionKey: 'old_q', answer: 'OLD_PRIVATE_CLINIC_ANSWER' }],
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

// Exercise real popup geometry and task completion with motion enabled and disabled.
async function loggedInPage(browser, f, origin, width, reducedMotion = 'reduce') {
  const context = await browser.newContext({ baseURL: origin, viewport: { width, height: 900 }, hasTouch: width === 390, isMobile: width === 390, reducedMotion });
  const cookie = await f.login(f.administrator);
  const separator = cookie.indexOf('=');
  await context.addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1),
    url: origin, httpOnly: true, sameSite: 'Lax' }]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return { context, page, errors };
}

async function assertUsable(page, name, keyboardOnly = false) {
  const geometry = await page.evaluate(() => ({ viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert(geometry.scrollWidth <= geometry.viewport + 1, `${name}: horizontal overflow ${JSON.stringify(geometry)}`);
  const links = page.locator('.offboarding-blocker-list a');
  if (await links.count()) {
    const box = await links.first().boundingBox();
    assert(box && box.height >= 44, `${name}: report link touch height`);
    if (keyboardOnly) await tabTo(page, links.first());
    else await links.first().focus();
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

async function tabTo(page, locator) {
  for (let index = 0; index < 100; index += 1) {
    if (await locator.evaluate((node) => node === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('Keyboard target was not reachable by Tab');
}

async function enterText(page, locator, value, keyboardOnly) {
  if (!keyboardOnly) { await locator.fill(value); return; }
  await tabTo(page, locator);
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type(value);
}

async function selectGeometry(page) {
  return page.locator('.servora-ant-select-dropdown').last().evaluate((popup) => {
    const trigger = document.querySelector('#weekly-assignees').closest('.servora-ant-select');
    const box = (node) => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
    const p = box(popup), t = box(trigger), style = getComputedStyle(popup);
    return { popup: p, trigger: t, viewport: { width: innerWidth, height: innerHeight },
      inViewport: p.x >= -1 && p.y >= -1 && p.right <= innerWidth + 1 && p.bottom <= innerHeight + 1,
      aligned: Math.abs(p.x - t.x) <= 2 && Math.min(Math.abs(p.y - t.bottom), Math.abs(t.y - p.bottom)) <= 8,
      expanded: document.querySelector('#weekly-assignees').getAttribute('aria-expanded'),
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      container: popup.parentElement.tagName, transitionProperty: style.transitionProperty,
      transitionDuration: style.transitionDuration, opacity: style.opacity, scrollY };
  });
}

async function selectReplacement(page, replacement, profile, motion, activate, keyboardOnly) {
  const input = page.locator('#weekly-assignees');
  const checks = [];
  async function aligned(stage) {
    try {
      await expect.poll(async () => { const g = await selectGeometry(page); return g.inViewport && g.aligned && Number(g.opacity) === 1; },
        { timeout: 3000, message: `${profile}/${stage}: real Select must be aligned inside the viewport` }).toBe(true);
    } catch (error) {
      await writeFile(resolve(evidence, `${profile}-${stage}-failure.json`), JSON.stringify(await selectGeometry(page), null, 2));
      await page.screenshot({ path: resolve(evidence, `${profile}-${stage}-failure.png`), fullPage: true });
      throw error;
    }
    const g = await selectGeometry(page);
    assert.equal(g.expanded, 'true'); assert.equal(g.reducedMotion, motion === 'reduce'); assert.equal(g.container, 'BODY');
    if (motion === 'reduce') assert.equal(g.transitionProperty, 'none');
    checks.push({ stage, ...g });
  }
  async function open() { if (keyboardOnly) { await tabTo(page, input); await page.keyboard.press('ArrowDown'); } else await activate(input); }
  await open(); await aligned('open');
  await page.evaluate(() => window.scrollBy(0, 80)); await aligned('scroll');
  await enterText(page, input, replacement.name, keyboardOnly); await aligned('filter');
  const option = page.locator('.servora-ant-select-dropdown').last().getByText(replacement.name, { exact: true });
  if (keyboardOnly) await page.keyboard.press('Enter');
  else { await (profile.startsWith('390') ? option.tap({ trial: true }) : option.click({ trial: true })); await activate(option); }
  await expect(page.locator('#weekly-assignee-count')).toHaveText('1 personel seçildi');
  await page.keyboard.press('Escape'); await expect(input).toHaveAttribute('aria-expanded', 'false'); await expect(input).toBeFocused();
  await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab'); await expect(input).toBeFocused();
  await open(); await aligned('reopen');
  await enterText(page, input, replacement.name, keyboardOnly); await aligned('filter-reopened');
  if (keyboardOnly) await page.keyboard.press('Enter'); else await activate(option);
  await expect(page.locator('#weekly-assignee-count')).toHaveText('0 personel seçildi');
  await enterText(page, input, replacement.name, keyboardOnly); await aligned('keyboard-selection'); await input.press('Enter');
  await expect(page.locator('#weekly-assignee-count')).toHaveText('1 personel seçildi');
  await page.keyboard.press('Escape'); await expect(input).toBeFocused();
  await page.screenshot({ path: resolve(evidence, `${profile}-select.png`), fullPage: true });
  await writeFile(resolve(evidence, `${profile}-select-checks.json`), JSON.stringify(checks, null, 2));
  return checks;
}

async function resolveAndOffboard(browser, f, origin, width, target, jobCardId, replacementPeriod, motion, keyboardOnly = false, replacementUser = f.secondStaff) {
  const { context, page, errors } = await loggedInPage(browser, f, origin, width, motion);
  const profile = `${width}-${motion}${keyboardOnly ? '-keyboard' : ''}`;
  const activate = async (locator) => {
    if (keyboardOnly) { await tabTo(page, locator); await page.keyboard.press('Enter'); }
    else if (width === 390) await locator.tap();
    else await locator.click();
  };
  try {
    await page.goto(`/users/${target.id}`);
    await activate(page.getByRole('button', { name: 'Personeli devre dışı bırak' }));
    await expect(page.getByText('1 engel var; 1 kayıt görüntüleniyor.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Kararları onayla' })).toHaveCount(0);
    await expect(page.locator('.offboarding-blockers')).not.toContainText('OLD_PRIVATE_CLINIC_DRAFT');
    const reportLink = page.getByRole('link', { name: 'İş kartında incele' });
    await expect(reportLink).toHaveAttribute('href', `/jobs/${jobCardId}?offboardingTarget=${target.id}`);
    await assertUsable(page, `${profile}-blocker`, keyboardOnly);
    await activate(reportLink);
    await expect(page).toHaveURL(new RegExp(`/jobs/${jobCardId}\\?offboardingTarget=${target.id}$`));
    await activate(page.getByRole('button', { name: 'İşi iptal et', exact: true }).first());
    const dialog = page.getByRole('dialog', { name: 'İşi iptal et' });
    await enterText(page, dialog.getByRole('textbox', { name: 'İptal nedeni' }), 'Personel ayrılışı nedeniyle yönetici kararı.', keyboardOnly);
    await activate(dialog.getByRole('button', { name: 'İşi iptal et' }));
    await expect(page.locator('[data-job-detail-meta]')).toContainText('İptal edildi');
    await activate(page.getByRole('link', { name: 'Personel ayrılma ekranına dön ve planı yenile' }));
    await expect(page.getByRole('combobox', { name: 'İdari neden' })).toBeVisible();
    const reasonBox = await page.getByRole('combobox', { name: 'İdari neden' }).boundingBox();
    assert(reasonBox && reasonBox.height >= 44, `${width}: fresh-preview reason touch height`);
    await expect(page.locator('.offboarding-blockers')).toHaveCount(0);
    await page.screenshot({ path: resolve(evidence, `${profile}-fresh-preview.png`), fullPage: true });
    await activate(page.getByRole('link', { name: 'Gerekirse yeni personel için bağımsız haftalık rapor oluştur' }));
    await expect(page.locator('#weekly-period')).toBeVisible();
    if (replacementPeriod) await page.locator('#weekly-period').fill(replacementPeriod);
    else replacementPeriod = await page.locator('#weekly-period').inputValue();
    const selectChecks = await selectReplacement(page, replacementUser, profile, motion, activate, keyboardOnly);
    await enterText(page, page.locator('#weekly-instructions'), 'Yeni personel için bağımsız saha raporu.', keyboardOnly);
    await activate(page.getByRole('button', { name: 'Rapor isteklerini oluştur' }));
    await expect(page).toHaveURL(new RegExp(`/jobs/[0-9a-f-]+\\?offboardingTarget=${target.id}$`));
    await activate(page.getByRole('link', { name: 'Personel ayrılma ekranına dön ve planı yenile' }));
    await expect(page.getByRole('combobox', { name: 'İdari neden' })).toBeVisible();
    const reason = page.getByRole('combobox', { name: 'İdari neden' });
    if (keyboardOnly) { await tabTo(page, reason); await page.keyboard.press('e'); }
    else await reason.selectOption('ACCESS_ENDED');
    await expect(reason).toHaveValue('ACCESS_ENDED');
    await activate(page.getByRole('button', { name: 'Kararları onayla' }));
    await activate(page.getByRole('dialog', { name: 'Personel devre dışı bırakılsın mı?' })
      .getByRole('button', { name: 'Erişimi sonlandır' }));
    await expect(page.getByText('Personel devre dışı bırakıldı', { exact: true })).toBeVisible();
    await page.screenshot({ path: resolve(evidence, `${profile}-complete.png`), fullPage: true });
    assert.deepEqual(errors, [], `browser errors at ${width}`);
    const original = (await f.pool.query(`SELECT j.status, r.staff_user_id, r.draft_summary, r.manager_answers, r.manager_questions
      FROM job_cards j JOIN weekly_reports r ON r.job_card_id = j.id WHERE j.id = $1`, [jobCardId])).rows[0];
    assert.equal(original.status, 'CANCELLED');
    assert.equal(original.staff_user_id, target.id);
    assert.equal(original.draft_summary, 'OLD_PRIVATE_CLINIC_DRAFT');
    assert.equal(original.manager_answers[0].answer, 'OLD_PRIVATE_CLINIC_ANSWER');
    assert.equal(original.manager_questions[0].prompt, 'OLD_PRIVATE_CLINIC_QUESTION');
    const replacement = (await f.pool.query(`SELECT r.job_card_id, r.draft_summary, r.manager_answers, r.manager_questions,
      (SELECT count(*)::int FROM weekly_report_submissions s WHERE s.weekly_report_id = r.id) AS submission_count,
      r.staff_user_id FROM weekly_reports r WHERE r.organization_id = $1 AND r.staff_user_id = $2
      AND r.period_start = $3`, [f.org, replacementUser.id, replacementPeriod])).rows[0];
    assert(replacement && replacement.job_card_id !== jobCardId);
    assert.equal(replacement.staff_user_id, replacementUser.id);
    assert.equal(replacement.draft_summary, null);
    assert.deepEqual(replacement.manager_answers, []);
    assert.equal(replacement.submission_count, 0);
    assert.deepEqual(replacement.manager_questions, []);
    assert.equal((await f.pool.query('SELECT is_active FROM users WHERE id = $1', [target.id])).rows[0].is_active, false);
    results.push({ width, motion, interaction: keyboardOnly ? 'keyboard-only (Tab/Enter)' : width === 390 ? 'Chromium synthesized touch' : 'mouse',
      flow: 'resolve-create-refresh-execute', selectChecks, independentReplacement: true, oldContentPreserved: true, status: 'PASS' });
  } catch (error) {
    await writeFile(resolve(evidence, `${profile}-failure.json`), JSON.stringify({ message: error.message,
      activeElement: await page.evaluate(() => ({ tag: document.activeElement?.tagName, name: document.activeElement?.getAttribute('name') })),
      reason: await page.getByRole('combobox', { name: 'İdari neden' }).inputValue().catch(() => null) }, null, 2));
    await page.screenshot({ path: resolve(evidence, `${profile}-failure.png`), fullPage: true });
    throw error;
  } finally {
    await context.close();
  }
}

await withRetirementFixture(async (f) => {
  const desktopJob = await addReport(f, f.staff, '2026-08-10', true);
  const mobileStaff = await addStaff(f, 'Mobil Klinik Temsilcisi');
  const mobileJob = await addReport(f, mobileStaff, '2026-08-17', true);
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
    await resolveAndOffboard(browser, f, origin, 1440, f.staff, desktopJob, '2026-10-05', 'no-preference');
    await resolveAndOffboard(browser, f, origin, 390, mobileStaff, mobileJob, '2026-10-12', 'no-preference');
    for (const [width, week] of [[1440, '2026-10-19'], [390, '2026-10-26']]) {
      const target = await addStaff(f, `Reduced motion ${width}`);
      const job = await addReport(f, target, '2026-08-17', true);
      await resolveAndOffboard(browser, f, origin, width, target, job, week, 'reduce');
    }
    const keyboardTarget = await addStaff(f, 'Klavye akışı');
    const keyboardReplacement = await addStaff(f, 'Klavye yeni personel');
    const keyboardJob = await addReport(f, keyboardTarget, '2026-08-17', true);
    await resolveAndOffboard(browser, f, origin, 1440, keyboardTarget, keyboardJob, null, 'reduce', true, keyboardReplacement);
    await f.unchanged('SOF-2C browser resolution leaves historical recurrence and submissions unchanged');
    const { buildWeeklyReportPdfDocumentModel } = await import('../../server/dist/modules/weekly-reports/pdf/document-model.js');
    const oldSubmission = (await f.service.listWeeklyReportSubmissions(f.actor(f.manager), f.old.jobCardId))[0];
    assert.deepEqual(buildWeeklyReportPdfDocumentModel({ submission: oldSubmission, staffName: f.staff.name }), f.pdfModel);
  } finally {
    await browser?.close();
    await vite.close();
    await writeFile(resolve(evidence, 'results.json'), JSON.stringify(results, null, 2));
  }
});
console.log('SOF2C_BROWSER_PASS', results.length);
