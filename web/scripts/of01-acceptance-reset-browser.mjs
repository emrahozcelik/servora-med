import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from 'playwright/test';
import { createServer, preview } from 'vite';
import { withRetirementFixture, port } from '../../server/scripts/acceptance/weekly-report-retirement.mjs';

// Real compiled Fastify + PostgreSQL + authenticated browser traffic. No routes
// or SQL are mocked. WRRET_BASE_SERVER selects an archived baseline for RED.
const output = resolve(process.env.OF01_EVIDENCE_DIR ?? '../evidence/browser-of01');
const runtime = process.env.OF01_WEB_RUNTIME ?? 'vite';
const engines = (process.env.OF01_ENGINES ?? 'chromium,chrome').split(',');
const profiles = [
  { name: 'desktop-normal', width: 1440, motion: 'no-preference' },
  { name: 'desktop-reduced', width: 1440, motion: 'reduce' },
  { name: 'mobile-normal', width: 390, motion: 'no-preference' },
  { name: 'mobile-reduced', width: 390, motion: 'reduce' },
  { name: 'keyboard', width: 1440, motion: 'no-preference', keyboard: true },
];
const selected = process.env.OF01_PROFILE ? profiles.filter((p) => p.name === process.env.OF01_PROFILE) : profiles;
assert(selected.length, 'known browser profile required');
await mkdir(output, { recursive: true });
const results = { sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim(),
  dirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
  apiBaseline: process.env.WRRET_BASE_SERVER ?? null, runtime, status: 'BLOCKED', cases: [] };

// Each profile gets its own server/schema and the unchanged production auth
// rate limiter. Repeated matrix logins must not consume one shared IP budget.
if (!process.env.OF01_PROFILE) {
  for (const engine of engines) for (const profile of profiles) {
    const directory = resolve(output, `${engine}-${profile.name}`);
    await mkdir(directory, { recursive: true });
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { encoding: 'utf8',
      env: { ...process.env, OF01_PROFILE: profile.name, OF01_ENGINES: engine, OF01_EVIDENCE_DIR: directory } });
    await writeFile(resolve(directory, 'driver.log'), (child.stdout ?? '') + (child.stderr ?? ''));
    const result = JSON.parse(await readFile(resolve(directory, 'results.json'), 'utf8'));
    results.cases.push(...result.cases);
    if (child.status !== 0) {
      results.status = 'FAIL'; results.error = result.error ?? child.error?.message ?? 'Profile failed';
      await writeFile(resolve(output, 'results.json'), JSON.stringify(results, null, 2));
      process.exit(1);
    }
  }
  results.status = 'PASS';
  await writeFile(resolve(output, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
  process.exit(0);
}

async function tabTo(page, locator) {
  for (let index = 0; index < 180; index += 1) {
    if (await locator.evaluate((node) => document.activeElement === node)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('Control unreachable by keyboard');
}

async function loggedIn(browser, f, origin, user, profile) {
  const context = await browser.newContext({ baseURL: origin, viewport: { width: profile.width, height: 900 },
    hasTouch: profile.width === 390, isMobile: profile.width === 390, reducedMotion: profile.motion });
  const cookie = await f.login(user), separator = cookie.indexOf('=');
  await context.addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1),
    url: origin, httpOnly: true, sameSite: 'Lax' }]);
  const page = await context.newPage();
  const errors = [];
  const warnings = [];
  page.on('pageerror', (error) => errors.push({ type: 'exception', message: error.message }));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const entry = { type: 'console', message: message.text(), location: message.location() };
    // Existing absent favicon is reported explicitly; application errors fail.
    if (message.location().url === `${origin}/favicon.ico` && message.text().includes('404')) warnings.push(entry);
    else errors.push(entry);
  });
  page.on('requestfailed', (request) => {
    if (!request.failure()?.errorText.includes('ERR_ABORTED')) errors.push({ type: 'network', url: new URL(request.url()).pathname, error: request.failure() });
  });
  page.on('response', (response) => {
    if (response.status() < 400) return;
    const entry = { type: 'http', url: new URL(response.url()).pathname, status: response.status() };
    if (response.url() === `${origin}/favicon.ico` && response.status() === 404) warnings.push(entry);
    else errors.push(entry);
  });
  return { context, page, errors, warnings };
}

async function activate(page, locator, profile) {
  await expect(locator).toBeEnabled();
  if (profile.keyboard) { await tabTo(page, locator); await page.keyboard.press('Enter'); }
  else if (profile.width === 390) await locator.tap();
  else await locator.click();
}

async function select(page, locator, value, profile) {
  if (!profile.keyboard) { await locator.selectOption(value); return; }
  await tabTo(page, locator);
  const label = await locator.evaluate((node, selectedValue) => [...node.options].find((o) => o.value === selectedValue)?.textContent.trim(), value);
  assert(label);
  // Native select type-ahead; fixture labels have unique initial letters.
  await page.keyboard.press(label[0].toLowerCase());
  await page.keyboard.press('Tab');
  await expect(locator).toHaveValue(value);
}

async function geometry(page, controls) {
  const sizes = [];
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    { timeout: 3000, message: 'responsive layout settles without horizontal task scroll' }).toBeLessThanOrEqual(1);
  const dimensions = await page.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth }));
  assert(dimensions.scroll <= dimensions.viewport + 1, `horizontal overflow: ${JSON.stringify(dimensions)}`);
  for (const locator of controls) {
    const box = await locator.boundingBox();
    assert(box && box.height >= 24 && box.width >= 24, `WCAG AA action target: ${JSON.stringify(box)}`);
    sizes.push({ ...box, preferred44: box.height >= 44 && box.width >= 44 });
  }
  return { dimensions, sizes };
}

try {
  await withRetirementFixture(async (f) => {
    await f.pool.query("UPDATE users SET name='Yeni sorumlu' WHERE id=$1", [f.secondStaff.id]);
    let web;
    try {
      const webPort = await port();
      const proxy = { '/api': { target: f.origin, changeOrigin: true } };
      web = runtime === 'dist'
        ? await preview({ root: resolve('web'), preview: { host: '127.0.0.1', port: webPort, strictPort: true, proxy } })
        : await createServer({ root: resolve('web'), server: { host: '127.0.0.1', port: webPort, strictPort: true, proxy } });
      if (runtime !== 'dist') await web.listen();
      const origin = `http://127.0.0.1:${webPort}`;
      async function request(user, path, body) {
        const response = await f.request(user, path, body);
        const data = await response.json();
        assert(response.ok, JSON.stringify({ status: response.status, data }));
        return data;
      }
      for (const engine of engines) {
        assert(['chromium', 'chrome'].includes(engine));
        const browser = await chromium.launch(engine === 'chrome'
          ? { channel: 'chrome', headless: false } : { headless: true });
        try {
          for (const profile of selected) {
            const name = `${runtime}-${engine}-${profile.name}`;
            const record = { name, engine, version: browser.version(), headed: engine === 'chrome',
              viewport: profile.width, motion: profile.motion, keyboard: !!profile.keyboard,
              syntheticTouch: profile.width === 390, status: 'BLOCKED' };
            results.cases.push(record);
            const oldStaff = (await f.pool.query(`INSERT INTO users
              (organization_id,name,email,password_hash,role,is_active,must_change_password)
              SELECT organization_id,$2,$3,password_hash,'STAFF',true,false FROM users WHERE id=$1
              RETURNING id,name,email,role`, [f.staff.id, `OF01 ${name}`, `${randomUUID()}@acceptance.local`])).rows[0];
            await f.pool.query('INSERT INTO staff_profiles(organization_id,user_id,title) VALUES($1,$2,$3)', [f.org, oldStaff.id, 'Saha temsilcisi']);
            let job = await request(f.manager, '/api/job-cards', { clientActionId: randomUUID(), type: 'GENERAL_TASK',
              title: `Dental clinic coordination ${name}`, assignedTo: oldStaff.id });
            job = await request(oldStaff, `/api/job-cards/${job.id}/accept`, { clientActionId: randomUUID(), expectedVersion: job.version });
            const history = (await f.pool.query('SELECT id,to_jsonb(a) AS row FROM job_card_activity_logs a WHERE job_card_id=$1 ORDER BY id', [job.id])).rows;
            const admin = await loggedIn(browser, f, origin, f.administrator, profile);
            const replacement = await loggedIn(browser, f, origin, f.secondStaff, profile);
            let executeInput;
            admin.page.on('request', (r) => { if (new URL(r.url()).pathname === `/api/users/${oldStaff.id}/offboarding/execute`) executeInput = r.postDataJSON(); });
            try {
              await admin.page.goto(`/users/${oldStaff.id}`);
              await activate(admin.page, admin.page.getByRole('button', { name: 'Personeli devre dışı bırak', exact: true }), profile);
              const reason = admin.page.getByRole('combobox', { name: 'İdari neden' });
              await expect(reason).toBeVisible();
              await select(admin.page, reason, 'ACCESS_ENDED', profile);
              const jobSelect = admin.page.locator(`select[name="job-${job.id}"]`);
              await select(admin.page, jobSelect, f.secondStaff.id, profile);
              const confirm = admin.page.getByRole('button', { name: 'Kararları onayla', exact: true });
              record.adminGeometry = await geometry(admin.page, [reason, jobSelect, confirm]);
              await activate(admin.page, confirm, profile);
              const dialog = admin.page.locator('.workflow-dialog');
              await expect(dialog).toBeVisible();
              await activate(admin.page, dialog.getByRole('button', { name: 'Erişimi sonlandır', exact: true }), profile);
              await expect(admin.page.getByText('Personel devre dışı bırakıldı', { exact: true })).toBeVisible();
              assert(executeInput, 'real UI execute payload captured');
              const transferred = await request(f.secondStaff, `/api/job-cards/${job.id}`);
              record.afterTransfer = { status: transferred.status, version: transferred.version,
                acceptedBy: transferred.workflowContext.lifecycle.acceptedBy, acceptedAt: transferred.workflowContext.lifecycle.acceptedAt };
              // This is the baseline RED assertion: inherited ACCEPTED is a defect.
              assert.equal(transferred.status, 'NEW');
              assert.equal(transferred.workflowContext.lifecycle.acceptedBy, null);
              assert.equal(transferred.workflowContext.lifecycle.acceptedAt, null);
              assert.equal((await f.request(oldStaff, '/api/auth/me')).status, 401);
              await replacement.page.goto(`/jobs/${job.id}`);
              const accept = replacement.page.getByRole('button', { name: 'İşi kabul et', exact: true });
              await expect(accept).toBeVisible();
              await expect(replacement.page.getByRole('button', { name: 'İşi başlat', exact: true })).toHaveCount(0);
              record.newGeometry = await geometry(replacement.page, [accept]);
              await replacement.page.screenshot({ path: resolve(output, `${name}-new.png`), fullPage: true });
              if (profile.name === 'desktop-normal') {
                // Text resize and 320 CSS-pixel reflow are explicit emulations,
                // not claims of physical-device testing or native browser zoom.
                await replacement.page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
                record.text200 = await geometry(replacement.page, [accept]);
                await replacement.page.screenshot({ path: resolve(output, `${name}-text200.png`), fullPage: true });
                await replacement.page.evaluate(() => { document.documentElement.style.fontSize = ''; });
                await replacement.page.setViewportSize({ width: 320, height: 900 });
                record.reflow320 = await geometry(replacement.page, [accept]);
                await replacement.page.screenshot({ path: resolve(output, `${name}-reflow320.png`), fullPage: true });
                await replacement.page.setViewportSize({ width: profile.width, height: 900 });
              }
              await activate(replacement.page, accept, profile);
              const start = replacement.page.getByRole('button', { name: 'İşi başlat', exact: true });
              await expect(start).toBeVisible();
              const accepted = await request(f.secondStaff, `/api/job-cards/${job.id}`);
              assert.equal(accepted.workflowContext.lifecycle.acceptedBy.id, f.secondStaff.id);
              record.acceptedGeometry = await geometry(replacement.page, [start]);
              await activate(replacement.page, start, profile);
              await expect(replacement.page.getByRole('button', { name: 'Kontrole gönder', exact: true })).toBeVisible();
              await replacement.page.reload();
              await expect(replacement.page.getByRole('button', { name: 'Kontrole gönder', exact: true })).toBeVisible();
              await replacement.page.screenshot({ path: resolve(output, `${name}-started.png`), fullPage: true });
              const final = (await f.pool.query('SELECT to_jsonb(j) AS row FROM job_cards j WHERE id=$1', [job.id])).rows;
              assert.equal(final[0].row.status, 'IN_PROGRESS');
              const activities = (await f.pool.query('SELECT id,to_jsonb(a) AS row FROM job_card_activity_logs a WHERE job_card_id=$1 ORDER BY id', [job.id])).rows;
              assert.deepEqual(activities.filter((a) => history.some((old) => old.id === a.id)), history, 'every old activity column preserved');
              assert.equal(activities.filter((a) => a.row.event_type === 'JOB_ACCEPTED' && a.row.actor_id === oldStaff.id).length, 1);
              assert.equal(activities.filter((a) => a.row.event_type === 'JOB_ACCEPTED' && a.row.actor_id === f.secondStaff.id).length, 1);
              const assignment = activities.find((a) => a.row.event_type === 'JOB_ASSIGNED');
              assert.deepEqual(assignment.row.old_value, { assignedTo: oldStaff.id, status: 'ACCEPTED' });
              assert.deepEqual(assignment.row.new_value, { assignedTo: f.secondStaff.id, status: 'NEW' });
              await request(f.administrator, `/api/users/${oldStaff.id}/offboarding/execute`, executeInput);
              assert.deepEqual((await f.pool.query('SELECT to_jsonb(j) AS row FROM job_cards j WHERE id=$1', [job.id])).rows, final, 'replay must not reset the replacement acceptance');
              assert.deepEqual(admin.errors, []);
              assert.deepEqual(replacement.errors, []);
              Object.assign(record, { status: 'PASS', oldSession: 401, finalStatus: 'IN_PROGRESS', historyPreserved: true,
                oldAcceptanceEvents: 1, newAcceptanceEvents: 1, replayUnchanged: true, errors: [],
                warnings: [...admin.warnings, ...replacement.warnings] });
            } catch (error) {
              Object.assign(record, { status: 'FAIL', error: error.message, errors: [...admin.errors, ...replacement.errors] });
              await admin.page.screenshot({ path: resolve(output, `${name}-admin-failure.png`), fullPage: true });
              await replacement.page.screenshot({ path: resolve(output, `${name}-staff-failure.png`), fullPage: true });
              throw error;
            } finally { await admin.context.close(); await replacement.context.close(); }
          }
        } finally { await browser.close(); }
      }
      await f.unchanged('of01-does-not-change-weekly-history-or-recurrences');
      results.status = 'PASS';
    } finally {
      if (runtime === 'dist' && web) await new Promise((done) => web.httpServer.close(done));
      else await web?.close();
    }
  }, resolve(output, 'fixture'));
} catch (error) { results.status = 'FAIL'; results.error = error.message; process.exitCode = 1; }
finally { await writeFile(resolve(output, 'results.json'), JSON.stringify(results, null, 2)); }
console.log(JSON.stringify(results));
