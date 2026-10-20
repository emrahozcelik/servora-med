import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { request as proxyRequest } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { buildApp } from '../../server/dist/app.js';
import { loadConfig } from '../../server/dist/config.js';
import { createSessionToken } from '../../server/dist/modules/auth/crypto.js';
import { PostgresAuthRepository } from '../../server/dist/modules/auth/repository.js';
import { PostgresCrmRepository } from '../../server/dist/modules/crm/repository.js';
import { PostgresMigrationStore } from '../../server/dist/db/index.js';
import { runMigrations } from '../../server/dist/db/migrate-runner.js';

const require = createRequire(new URL('../../server/package.json', import.meta.url));
const { Pool } = require('pg');
const url = new URL(process.env.TEST_DATABASE_URL);
assert.match(url.pathname, /^\/servora_med_test_pr380_/); assert.equal(url.hostname, '127.0.0.1');
const admin = new Pool({ connectionString: url.toString() });
const schema = `pr380_browser_${randomUUID().replaceAll('-', '')}`;
const pool = new Pool({ connectionString: url.toString(), options: `-c search_path=${schema},public` });
const manager = '10000000-0000-4000-8000-0000000000aa';
const org = '10000000-0000-4000-8000-0000000000bb';
const a = '10000000-0000-4000-8000-000000000001'; const b = '10000000-0000-4000-8000-000000000002';
const contact = randomUUID();
const out = process.env.DUPLICATE_REVIEW_OUT;
assert.ok(out); mkdirSync(out, { recursive: true });
let app; let server; let browser;
try {
  assert.equal(Math.trunc(Number((await admin.query('SHOW server_version_num')).rows[0].server_version_num) / 10000), 17);
  await admin.query(`CREATE SCHEMA ${schema}`);
  await runMigrations({ migrationsDirectory: fileURLToPath(new URL('../../server/dist/db/migrations', import.meta.url)), store: new PostgresMigrationStore(pool) });
  await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Synthetic live browser')", [org]);
  await pool.query("INSERT INTO users(id,organization_id,name,email,password_hash,role) VALUES($1,$2,'Synthetic Manager','manager@browser.invalid','unused','MANAGER')", [manager, org]);
  await pool.query("INSERT INTO customers(id,organization_id,name,customer_type,status,phone) VALUES($1,$3,'Sentetik Klinik','clinic','active','+905321234567'),($2,$3,'SENTETİK KLİNİK','clinic','inactive','+905321234567')", [a, b, org]);
  await pool.query("INSERT INTO contacts(id,organization_id,customer_id,name) VALUES($1,$2,$3,'Sentetik kişi')", [contact, org, a]);
  const before = (await pool.query('SELECT row_to_json(c) AS value FROM customers c ORDER BY id')).rows;
  const token = createSessionToken();
  await pool.query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,NOW()+interval '1 hour')", [manager, token.tokenHash]);
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: url.toString(), LOG_LEVEL: 'silent', CRM_DUPLICATE_COMPARISON_ENABLED: 'true',
    CRM_DUPLICATE_EVIDENCE_KEYRING: JSON.stringify({ activeKeyId: 'synthetic', keys: { synthetic: Buffer.alloc(32, 91).toString('base64') } }) });
  app = await buildApp(config, { pool, authRepository: new PostgresAuthRepository(pool), crmRepository: new PostgresCrmRepository(pool) });
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  server = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', plugins: [react()], server: { host: '127.0.0.1', port: 0 } });
  server.middlewares.use((req, res, next) => {
    if (!req.url?.startsWith('/api/')) return next();
    const proxy = proxyRequest(`${api}${req.url}`, { method: req.method, headers: { ...req.headers, host: new URL(api).host } }, (reply) => { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res); });
    proxy.on('error', () => { res.statusCode = 503; res.end(); }); req.pipe(proxy);
  });
  server.middlewares.use(async (req, res, next) => {
    if (!req.url?.startsWith('/duplicate-browser-test')) return next();
    res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml('/duplicate-browser-test', '<!doctype html><html lang="tr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/fixtures/duplicate-review-browser-entry.tsx"></script></body></html>'));
  });
  await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([{ name: 'servora_session', value: token.rawToken, url: origin, httpOnly: true, sameSite: 'Lax' }]);
  const page = await context.newPage(); const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/duplicate-browser-test?comparison`);
  await page.getByRole('radio', { name: 'Mükerrer olarak doğrula' }).check();
  await page.locator('.duplicate-reason select').selectOption('SAME_OPERATIONAL_CUSTOMER_VERIFIED');
  await pool.query("UPDATE contacts SET name='Sentetik değişen kişi' WHERE id=$1", [contact]);
  await page.waitForTimeout(1_050); await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByRole('button', { name: 'Güncel kanıtı inceledim', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Mükerrer olarak doğrula', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Güncel kanıtı inceledim', exact: true }).click();
  let lostBody; let firstReceipt;
  await page.route('**/api/customers/duplicate-review-pairs/*/*/decisions', async (route) => {
    lostBody = route.request().postDataJSON(); const response = await route.fetch(); assert.equal(response.status(), 200); firstReceipt = await response.json();
    await route.abort('failed'); await page.unroute('**/api/customers/duplicate-review-pairs/*/*/decisions');
  });
  await page.getByRole('button', { name: 'Mükerrer olarak doğrula', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Kararı kaydet' }).click();
  await page.getByRole('button', { name: 'Özgün isteği tekrar dene' }).waitFor();
  assert.equal((await pool.query('SELECT count(*) FROM customer_duplicate_review_events')).rows[0].count, '1');
  await page.reload(); await page.getByRole('button', { name: 'Özgün isteği tekrar dene' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Yeniden incele', exact: true }).isDisabled(), true);
  const replayResponse = page.waitForResponse((response) => response.url().endsWith('/decisions') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Özgün isteği tekrar dene' }).click();
  const replay = await replayResponse; assert.equal(replay.headers()['idempotency-replayed'], 'true'); assert.deepEqual(await replay.json(), firstReceipt); assert.deepEqual(replay.request().postDataJSON(), lostBody);
  await page.getByText('Güncel durum yüklendi.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Yeniden incele', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Yeniden incelemeye aç' }).click();
  await page.getByRole('radio', { name: 'Mükerrer olarak doğrula' }).waitFor();
  await page.getByRole('radio', { name: 'Eşleşmeyi reddet' }).check(); await page.locator('.duplicate-reason select').selectOption('DISTINCT_BRANCH');
  await page.getByRole('button', { name: 'Eşleşmeyi reddet', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: 'Kararı kaydet' }).click();
  await page.getByText('Güncel durum yüklendi.', { exact: true }).waitFor();
  await page.getByRole('link', { name: /Olası mükerrerler'e dön/ }).click();
  await page.getByLabel('İnceleme görünümü').selectOption('ALL');
  await page.getByRole('link', { name: /İki müşteriyi karşılaştır/ }).click(); await page.getByText('Karar geçmişi').waitFor();
  assert.equal(await page.locator('.duplicate-history-list > li').count(), 3);
  await page.screenshot({ path: `${out}/live-desktop.png`, fullPage: true });
  for (const width of [390, 320]) { await page.setViewportSize({ width, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); }
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.getByRole('button', { name: 'Yeniden incele', exact: true }).focus();
  await page.keyboard.press('Enter'); await page.getByRole('dialog').waitFor(); await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('button', { name: 'Yeniden incele', exact: true }).evaluate((el) => el === document.activeElement), true);
  await page.screenshot({ path: `${out}/live-mobile.png`, fullPage: true });
  assert.deepEqual(errors, []);
  const counts = (await pool.query(`SELECT (SELECT max(version) FROM customer_duplicate_reviews) AS version,(SELECT count(*)::int FROM customer_duplicate_review_events) AS events,
    (SELECT count(*)::int FROM audit_events WHERE subject_type='CUSTOMER_DUPLICATE_REVIEW') AS audits,(SELECT count(*)::int FROM processed_actions WHERE operation_key IN ('CRM_DUPLICATE_DECISION','CRM_DUPLICATE_REOPEN')) AS receipts`)).rows[0];
  assert.deepEqual(counts, { version: 3, events: 3, audits: 3, receipts: 3 });
  assert.deepEqual((await pool.query('SELECT row_to_json(c) AS value FROM customers c ORDER BY id')).rows, before);
  writeFileSync(`${out}/results.json`, JSON.stringify({ status: 'PASS', browser: await browser.version(), node: process.version, syntheticPgMajor: 17, actualSessionAuthentication: true,
    contactDraftBinding: 'PASS', committedLostResponseReloadExactReceiptReplay: 'PASS', explicitReopenDecisionHistoryAll: 'PASS', keyboardFocus390320Text200ReducedMotion: 'PASS', counts, pageErrors: errors }, null, 2));
  console.log('PR380_LIVE_BROWSER_PASS');
} finally {
  await browser?.close(); await server?.close(); await app?.close(); await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end();
}
