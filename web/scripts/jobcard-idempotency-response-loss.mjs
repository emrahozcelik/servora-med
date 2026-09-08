import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { chromium } from 'playwright';
import { createServer as createViteServer, loadConfigFromFile } from 'vite';

const root = fileURLToPath(new URL('../../', import.meta.url));
const web = fileURLToPath(new URL('../', import.meta.url));
const server = fileURLToPath(new URL('../../server/', import.meta.url));
const requireServer = createRequire(new URL('../../server/package.json', import.meta.url));
const { Client } = requireServer('pg');
const postgresBins = [process.env.JCID_POSTGRES_BIN, '/opt/homebrew/opt/postgresql@16/bin', '/opt/homebrew/opt/postgresql@17/bin', '/opt/homebrew/opt/postgresql/bin', '/Applications/Postgres.app/Contents/Versions/latest/bin'].filter(Boolean);
const postgresBin = postgresBins.find((p) => existsSync(`${p}/initdb`) && existsSync(`${p}/pg_ctl`));
if (!postgresBin) throw new Error('JCID_POSTGRES_BIN or a local PostgreSQL installation is required');

const evidenceDir = process.env.JCID_EVIDENCE_DIR || mkdtempSync('/private/tmp/servora-jobcard-idempotency-');
const assertions = [];
const screenshots = [];
const processes = [];
let cluster = '';
let clusterPort = 0;
let database = '';
let adminUrl = '';
let databaseUrl = '';
let databaseCreated = false;
let page;
let deliveryPage;
let activePage;
let browser;
let viteServer;
let failure = null;
const browserExecutable = process.env.JCID_BROWSER_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browserLaunchOptions = existsSync(browserExecutable)
  ? { headless: true, executablePath: browserExecutable }
  : { headless: true };

const clean = (value) => String(value).replaceAll(/postgres(?:ql)?:\/\/[^@\s]+@/gi, 'postgresql://***@').slice(0, 2000);
function record(id, pass, observed) {
  assertions.push({ id, status: pass ? 'PASS' : 'FAIL', observed: clean(observed) });
  if (!pass) throw new Error(`${id}: ${clean(observed)}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function port() {
  return new Promise((resolve, reject) => {
    const socket = createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address();
      socket.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}
async function command(cmd, args, options = {}) {
  const child = spawn(cmd, args, { cwd: options.cwd, env: options.env || process.env, stdio: options.stdio || 'inherit' });
  const [code, signal] = await once(child, 'exit');
  if (code !== 0) throw new Error(`${cmd} ${args.join(' ')} exited with ${code ?? signal}`);
}
function start(label, cmd, args, options = {}) {
  const child = spawn(cmd, args, { cwd: options.cwd, env: options.env || process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (b) => process.stdout.write(`[${label}] ${b}`));
  child.stderr.on('data', (b) => process.stderr.write(`[${label}] ${b}`));
  processes.push(child);
  return child;
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), sleep(5000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}
async function ready(url, child) {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    if (child.exitCode !== null) throw new Error(`${url} process exited`);
    try { if ((await fetch(url)).ok) return; } catch { /* startup */ }
    await sleep(150);
  }
  throw new Error(`${url} did not become ready`);
}
async function startPostgres() {
  cluster = mkdtempSync('/private/tmp/servora-jcid-postgres-');
  clusterPort = await port();
  await command(`${postgresBin}/initdb`, ['-D', cluster, '--auth=trust', '--username=servora_jcid', '--encoding=UTF8', '--no-locale'], { cwd: root });
  await command(`${postgresBin}/pg_ctl`, ['-D', cluster, '-l', `${cluster}/postgres.log`, '-o', `-h 127.0.0.1 -p ${clusterPort} -F`, 'start', '-w'], { cwd: root });
  adminUrl = `postgresql://servora_jcid@127.0.0.1:${clusterPort}/postgres`;
  record('POSTGRES-ISOLATED-CLUSTER', true, `port=${clusterPort}`);
}
async function createDatabase() {
  database = `servora_jcid_${randomBytes(6).toString('hex')}`;
  const client = new Client({ connectionString: adminUrl }); await client.connect();
  try { await client.query(`CREATE DATABASE "${database}"`); } finally { await client.end(); }
  databaseUrl = new URL(`/${database}`, adminUrl).toString(); databaseCreated = true;
  record('POSTGRES-DISPOSABLE-CREATED', true, database);
}
function env(overrides = {}) {
  return { ...process.env, NODE_ENV: 'development', HOST: '127.0.0.1', DATABASE_URL: databaseUrl, CORS_ORIGIN: webOrigin, HEALTH_SCHEMA_VERSION: '', CALENDAR_ENABLED: 'false', MESSAGING_ENABLED: 'true', WEB_PUSH_ENABLED: 'false', ACTION_SCOPED_GEOLOCATION_ENABLED: 'false', ...overrides };
}
let serverOrigin;
let webOrigin;
async function seed() {
  const admin = { email: 'jcid-admin@example.test', password: `JCID-${randomBytes(18).toString('base64url')}!` };
  await command('node', ['dist/db/bootstrap-admin.js'], { cwd: server, env: env({ BOOTSTRAP_ORGANIZATION_NAME: 'JCID Acceptance', BOOTSTRAP_ADMIN_NAME: 'JCID Admin', BOOTSTRAP_ADMIN_EMAIL: admin.email, BOOTSTRAP_ADMIN_PASSWORD: admin.password }) });
  const { hashPassword } = await import(pathToFileURL(`${server}/dist/modules/auth/crypto.js`).href);
  const client = new Client({ connectionString: databaseUrl }); await client.connect();
  try {
    const identity = (await client.query('SELECT id, organization_id FROM users WHERE lower(email)=lower($1)', [admin.email])).rows[0];
    if (!identity) throw new Error('bootstrap admin missing');
    const staffHash = await hashPassword(`JCID-Staff-${randomBytes(10).toString('base64url')}!`);
    const staff = (await client.query(`INSERT INTO users (organization_id,name,email,password_hash,role) VALUES ($1,'JCID Staff','jcid-staff@example.test',$2,'STAFF') RETURNING id`, [identity.organization_id, staffHash])).rows[0].id;
    await client.query(`INSERT INTO staff_profiles (organization_id,user_id) VALUES ($1,$2)`, [identity.organization_id, staff]);
    async function job(title, status) {
      const row = (await client.query(`INSERT INTO job_cards (organization_id,type,status,version,title,assigned_to,created_by,priority,accepted_at,accepted_by,started_at,staff_completed_at,staff_completed_by,manager_approved_at,manager_approved_by) VALUES ($1,'GENERAL_TASK',$2::varchar,1,$3,$4::uuid,$5::uuid,'normal',CASE WHEN $6::boolean THEN NOW() END,CASE WHEN $6::boolean THEN $5::uuid END,CASE WHEN $7::boolean THEN NOW() END,CASE WHEN $8::boolean THEN NOW() END,CASE WHEN $8::boolean THEN $4::uuid END,CASE WHEN $9::boolean THEN NOW() END,CASE WHEN $9::boolean THEN $5::uuid END) RETURNING id`, [identity.organization_id, status, title, staff, identity.id, status !== 'NEW', ['IN_PROGRESS','WAITING_APPROVAL','COMPLETED'].includes(status), ['WAITING_APPROVAL','COMPLETED'].includes(status), status === 'COMPLETED'])).rows[0];
      await client.query(`INSERT INTO job_card_activity_logs (organization_id,job_card_id,actor_id,event_type,old_value,new_value) VALUES ($1,$2,$3,'JOB_CREATED',NULL,jsonb_build_object('status',$4::text))`, [identity.organization_id, row.id, identity.id, status]);
      await client.query(`INSERT INTO job_card_schedule_revisions (organization_id,job_card_id,revision_no,organization_timezone,source,created_by) VALUES ($1,$2,1,'Europe/Istanbul','CREATE',$3)`, [identity.organization_id, row.id, identity.id]);
      return row.id;
    }
    const meetingJob = (await client.query(`INSERT INTO job_cards (organization_id,type,status,version,title,assigned_to,created_by,priority,accepted_at,accepted_by,started_at,engagement_kind) VALUES ($1,'SALES_MEETING','IN_PROGRESS',1,'JCID meeting response loss',$2,$3,'normal',NOW(),$3,NOW(),'SALES_MEETING') RETURNING id`, [identity.organization_id, staff, identity.id])).rows[0].id;
    await client.query(`INSERT INTO job_card_meeting_details (job_card_id,organization_id) VALUES ($1,$2)`, [meetingJob, identity.organization_id]);
    await client.query(`INSERT INTO job_card_schedule_revisions (organization_id,job_card_id,revision_no,organization_timezone,source,created_by) VALUES ($1,$2,1,'Europe/Istanbul','CREATE',$3)`, [identity.organization_id, meetingJob, identity.id]);
    const customer = (await client.query(`INSERT INTO customers (organization_id,name,customer_type,status) VALUES ($1,'JCID Delivery Klinik','clinic','active') RETURNING id`, [identity.organization_id])).rows[0].id;
    const product = (await client.query(`INSERT INTO products (organization_id,sku,name,unit,is_active) VALUES ($1,'JCID-P1','JCID İmplant','adet',true) RETURNING id`, [identity.organization_id])).rows[0].id;
    return {
      organizationId: identity.organization_id,
      admin,
      staff,
      customer,
      product,
      revisionJob: await job('JCID revision response loss', 'WAITING_APPROVAL'),
      browserRevisionJob: await job('JCID browser revision response loss', 'WAITING_APPROVAL'),
      cancelJob: await job('JCID cancel response loss', 'IN_PROGRESS'),
      noteJob: await job('JCID note response loss', 'IN_PROGRESS'),
      followUpSource: await job('JCID follow-up source', 'COMPLETED'),
      meetingJob,
      staff,
    };
  } finally { await client.end(); }
}
const loginCache = new Map();
async function login(credentials) {
  const cached = loginCache.get(credentials.email);
  if (cached) return cached;
  const response = await fetch(`${serverOrigin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: webOrigin }, body: JSON.stringify(credentials) });
  const body = await response.json(); const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
  if (!response.ok || !cookie) throw new Error(`login ${response.status}`);
  const session = { cookie, user: body.user };
  loginCache.set(credentials.email, session);
  return session;
}
async function loginBrowser(context, credentials) {
  const session = await login(credentials);
  const [name, value] = session.cookie.split('=', 2);
  await context.addCookies([{ name, value, domain: '127.0.0.1', path: '/', httpOnly: true }]);
}
async function api(cookie, path, body) {
  const response = await fetch(`${serverOrigin}${path}`, { method: body ? 'POST' : 'GET', headers: { origin: webOrigin, cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let parsed = null; try { parsed = await response.json(); } catch { /* no body */ }
  return { status: response.status, body: parsed };
}
async function screenshot(name, target = page) { const path = `${evidenceDir}/${name}`; await target.screenshot({ path, fullPage: true }); screenshots.push(path); }

async function browserCase(fixture) {
  if (!browser) browser = await chromium.launch(browserLaunchOptions);
  const context = await browser.newContext({ baseURL: webOrigin, viewport: { width: 1440, height: 1000 } }); page = await context.newPage();
  const requests = []; let committed = null; let loseNext = true;
  await page.route('**/api/job-cards/**', async (route) => {
    if (route.request().method() !== 'POST' || !/\/(cancel|request-revision)$/.test(new URL(route.request().url()).pathname)) return route.continue();
    const request = route.request(); const body = JSON.parse(request.postData() || '{}');
    requests.push({ url: new URL(request.url()).pathname, body });
    if (!loseNext) return route.continue();
    loseNext = false; const response = await route.fetch(); committed = { status: response.status(), body: await response.json() }; await route.abort('connectionfailed');
  });
  await loginBrowser(context, fixture.admin);
  await page.goto(`/jobs/${fixture.browserRevisionJob}`); await page.getByRole('heading', { name: 'JCID browser revision response loss', exact: true }).waitFor();
  const revision = page.getByRole('button', { name: /geri gönder/i }).first(); await revision.waitFor(); await revision.click();
  const revisionDialog = page.getByRole('dialog'); await revisionDialog.getByRole('textbox').fill('JCID original revision reason'); await revisionDialog.getByRole('button', { name: /geri gönder/i }).click();
  await page.getByText(/doğrulanamadı|belirsiz|tekrar/i).first().waitFor();
  record('UI-LOST-RESPONSE-COMMITTED', committed?.status === 200 && committed?.body?.status === 'REVISION_REQUESTED', `status=${committed?.status}; state=${committed?.body?.status}`);
  const frozenInputs = page.getByRole('dialog').locator('input, textarea, select');
  record('UI-INPUTS-FROZEN-AFTER-LOSS', await frozenInputs.count() > 0
    && await frozenInputs.evaluateAll((nodes) => nodes.every((node) => node.disabled)),
  'original lifecycle fields remain disabled while retry is pending');
  const firstBody = requests[0]?.body;
  const retry = page.getByRole('button', { name: /tekrar dene|tekrar gönder|yeniden dene|aynı işlemi/i }).first(); await retry.waitFor();
  await retry.click(); await page.waitForTimeout(250);
  record('UI-RETRY-EXACT-ORIGINAL-REQUEST', requests.length === 2 && JSON.stringify(requests[0]) === JSON.stringify(requests[1]), JSON.stringify(requests));
  record('UI-RETRY-USES-ORIGINAL-VERSION', Number(firstBody?.expectedVersion) === 1 && requests[1]?.body?.expectedVersion === 1, JSON.stringify(requests[1]?.body));
  await screenshot('jcid-revision-retry.png');
}

async function meetingCase(fixture) {
  if (!browser) browser = await chromium.launch(browserLaunchOptions);
  const context = await browser.newContext({ baseURL: webOrigin, viewport: { width: 1440, height: 1000 } });
  const meetingPage = await context.newPage(); activePage = meetingPage;
  const requests = []; let committed = null; let loseNext = true;
  await meetingPage.route(`**/api/job-cards/${fixture.meetingJob}/meeting-details`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    const body = JSON.parse(route.request().postData() || '{}'); requests.push(body);
    if (!loseNext) return route.continue();
    loseNext = false; const response = await route.fetch(); committed = { status: response.status(), body: await response.json() }; await route.abort('connectionfailed');
  });
  await loginBrowser(context, fixture.admin);
  await meetingPage.goto(`/jobs/${fixture.meetingJob}`);
  await meetingPage.getByRole('heading', { name: 'JCID meeting response loss', exact: true }).waitFor();
  await meetingPage.locator('#meeting-outcome').selectOption('FOLLOW_UP_REQUIRED');
  await meetingPage.locator('#meeting-unsuccessful-reason').selectOption('REQUESTED_LATER');
  await meetingPage.locator('#meeting-summary').fill('JCID meeting A original summary');
  await meetingPage.getByRole('button', { name: /sonucunu kaydet/i }).click();
  await meetingPage.getByRole('button', { name: 'Özgün isteği tekrar dene', exact: true }).waitFor({ timeout: 10000 });
  record('MEETING-A-COMMITTED-RESPONSE-LOST', committed?.status === 200 && committed?.body?.jobCardVersion === 2, `status=${committed?.status}; version=${committed?.body?.jobCardVersion}`);
  const fields = meetingPage.locator('.meeting-result-form input, .meeting-result-form select, .meeting-result-form textarea');
  record('MEETING-A-INPUTS-FROZEN', await fields.evaluateAll((nodes) => nodes.every((node) => node.disabled || node.closest('fieldset')?.disabled)), 'meeting inputs disabled after lost response');
  await injectRealtimeUpdate(fixture);
  await meetingPage.waitForTimeout(500);
  record('MEETING-A-REALTIME-UPDATE-OBSERVED', await meetingPage.getByRole('button', { name: 'Özgün isteği tekrar dene', exact: true }).count() === 1, 'retry affordance survives a realtime invalidation');
  await meetingPage.getByRole('button', { name: 'Özgün isteği tekrar dene', exact: true }).click(); await meetingPage.waitForTimeout(300);
  record('MEETING-A-EXACT-RETRY', requests.length === 2 && JSON.stringify(requests[0]) === JSON.stringify(requests[1]), JSON.stringify(requests));
  record('MEETING-A-RETRY-SAME-VERSION-KEY', requests[0]?.expectedVersion === 1 && requests[0]?.clientActionId === requests[1]?.clientActionId, JSON.stringify(requests[1]));
  await meetingPage.waitForTimeout(200);
  const b = { ...requests[0], clientActionId: `${requests[0]?.clientActionId}-B`, expectedVersion: 2, meetingSummary: 'JCID meeting B new summary' };
  const bResponse = await meetingPage.evaluate(async ({ id, input }) => {
    const response = await fetch(`/api/job-cards/${id}/meeting-details`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    return { status: response.status, body: await response.json() };
  }, { id: fixture.meetingJob, input: b });
  record('MEETING-B-NEW-KEY-CURRENT-VERSION', bResponse.status === 200 && bResponse.body?.jobCardVersion === 3 && bResponse.body?.meetingSummary === 'JCID meeting B new summary', `status=${bResponse.status}; version=${bResponse.body?.jobCardVersion}`);
  record('MEETING-B-FOLLOWUP-BEARING-PRESERVED', bResponse.body?.outcome === 'FOLLOW_UP_REQUIRED' && bResponse.body?.unsuccessfulReason === 'REQUESTED_LATER', JSON.stringify(bResponse.body));
  await context.close();
}

async function deliveryCase(fixture) {
  if (!browser) browser = await chromium.launch(browserLaunchOptions);
  const context = await browser.newContext({ baseURL: webOrigin, viewport: { width: 1440, height: 1000 } });
  deliveryPage = await context.newPage(); activePage = deliveryPage;
  const requests = []; let committed = null; let loseNext = true;
  await deliveryPage.route('**/api/job-cards/product-deliveries', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const body = JSON.parse(route.request().postData() || '{}'); requests.push(body);
    if (!loseNext) return route.continue();
    loseNext = false; const response = await route.fetch(); committed = { status: response.status(), body: await response.json() }; await route.abort('connectionfailed');
  });
  await loginBrowser(context, fixture.admin);
  await deliveryPage.goto('/jobs/new-delivery');
  await deliveryPage.getByText('Arama yaparak ürün seçin.').waitFor();
  // Choose the seeded customer (antd select: open via the selector container).
  await deliveryPage.locator('.delivery-form .servora-ant-select').first().click();
  await deliveryPage.locator('.servora-ant-select-dropdown .servora-ant-select-item-option').first().waitFor({ timeout: 10000 }).catch(async () => {
    await screenshot('jcid-delivery-dropdown-fail.png', deliveryPage);
    throw new Error('customer dropdown did not open');
  });
  await deliveryPage.locator('.servora-ant-select-dropdown .servora-ant-select-item-option', { hasText: 'JCID Delivery Klinik' }).first().click();
  await deliveryPage.locator('#delivery-assignee option', { hasText: 'JCID Staff' }).first().waitFor({ state: 'attached', timeout: 10000 });
  await deliveryPage.locator('#delivery-assignee').selectOption(fixture.staff);
  // Search and select the seeded product.
  await deliveryPage.locator('#delivery-product-search').fill('JCID İmplant');
  await deliveryPage.getByRole('button', { name: 'Ürün ara' }).click();
  await deliveryPage.locator('[data-product-id]').first().waitFor();
  await deliveryPage.locator('[data-product-id]').first().click();
  await deliveryPage.locator('.delivery-selected-quantities input').first().fill('2');
  await deliveryPage.getByRole('button', { name: 'Teslimi kaydet' }).click();
  await deliveryPage.getByRole('button', { name: 'Özgün isteği tekrar dene', exact: true }).waitFor({ timeout: 10000 });
  record('DELIVERY-COMMITTED-RESPONSE-LOST', committed?.status === 201 && committed?.body?.jobCardId, `status=${committed?.status}; jobCardId=${committed?.body?.jobCardId}`);
  const frozen = deliveryPage.locator('.delivery-form input, .delivery-form select, .delivery-form textarea');
  record('DELIVERY-INPUTS-FROZEN', await frozen.count() > 0
    && await frozen.evaluateAll((nodes) => nodes.every((node) => node.disabled || node.closest('fieldset')?.disabled)),
  'delivery inputs disabled after lost response');
  await deliveryPage.getByRole('button', { name: 'Özgün isteği tekrar dene', exact: true }).click(); await deliveryPage.waitForTimeout(400);
  record('DELIVERY-EXACT-RETRY', requests.length === 2 && JSON.stringify(requests[0]) === JSON.stringify(requests[1]), JSON.stringify(requests[1] ?? null));
  const client = new Client({ connectionString: databaseUrl }); await client.connect();
  try {
    const jobs = (await client.query(`SELECT count(*)::int AS n FROM job_cards WHERE organization_id=$1 AND type='PRODUCT_DELIVERY' AND title LIKE 'JCID Delivery Klinik%'`, [fixture.organizationId])).rows[0].n;
    record('DELIVERY-DB-NO-DUPLICATE', jobs === 1, `product delivery job cards=${jobs}`);
    const processed = (await client.query(`SELECT count(DISTINCT client_action_id)::int AS n FROM processed_actions WHERE organization_id=$1 AND operation_key = 'PRODUCT_DELIVERY_CREATE'`, [fixture.organizationId])).rows[0].n;
    record('DELIVERY-DB-SINGLE-ACTION-ID', processed === 1, `distinct PRODUCT_DELIVERY_CREATE clientActionIds=${processed}`);
  } finally { await client.end(); }
  await context.close(); deliveryPage = null;
}

async function followUpCase(fixture) {
  if (!browser) browser = await chromium.launch(browserLaunchOptions);
  const context = await browser.newContext({ baseURL: webOrigin, viewport: { width: 1440, height: 1000 } });
  const followUpPage = await context.newPage(); activePage = followUpPage;
  const requests = []; let committed = null; let loseNext = true;
  await followUpPage.route(`**/api/job-cards/${fixture.followUpSource}/follow-ups`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const body = JSON.parse(route.request().postData() || '{}'); requests.push(body);
    if (!loseNext) return route.continue();
    loseNext = false; const response = await route.fetch(); committed = { status: response.status(), body: await response.json() }; await route.abort('connectionfailed');
  });
  await loginBrowser(context, fixture.admin);
  await followUpPage.goto(`/jobs/new-follow-up?source=${fixture.followUpSource}`);
  await followUpPage.getByRole('heading', { name: 'Takip işi oluştur', exact: true }).waitFor();
  await followUpPage.locator('#follow-up-title').fill('JCID follow-up A');
  await followUpPage.locator('#follow-up-instructions').fill('JCID follow-up A kapsam');
  await followUpPage.locator('#follow-up-assignee').selectOption(fixture.staff);
  await followUpPage.getByRole('button', { name: 'Takip işini oluştur' }).click();
  await followUpPage.getByRole('button', { name: 'Özgün isteği tekrar dene', exact: true }).waitFor({ timeout: 10000 });
  record('FOLLOWUP-COMMITTED-RESPONSE-LOST', committed?.status === 201 && committed?.body?.id, `status=${committed?.status}; childId=${committed?.body?.id}`);
  record('FOLLOWUP-FORM-FROZEN', await followUpPage.locator('#follow-up-title').isDisabled()
    && await followUpPage.locator('#follow-up-instructions').isDisabled(), 'follow-up semantic fields disabled while ambiguous');
  await followUpPage.getByRole('button', { name: 'Özgün isteği tekrar dene', exact: true }).click(); await followUpPage.waitForTimeout(400);
  record('FOLLOWUP-EXACT-RETRY-SAME-SOURCE-KEY', requests.length === 2 && JSON.stringify(requests[0]) === JSON.stringify(requests[1]), JSON.stringify(requests[1] ?? null));
  const client = new Client({ connectionString: databaseUrl }); await client.connect();
  try {
    const children = (await client.query(`SELECT count(*)::int AS n FROM job_cards WHERE source_job_card_id=$1`, [fixture.followUpSource])).rows[0].n;
    record('FOLLOWUP-DB-NO-DUPLICATE', children === 1, `follow-up children=${children}`);
  } finally { await client.end(); }
  await context.close();
}

async function noteCase(fixture) {
  if (!browser) browser = await chromium.launch(browserLaunchOptions);
  const context = await browser.newContext({ baseURL: webOrigin, viewport: { width: 1440, height: 1000 } });
  const notePage = await context.newPage(); activePage = notePage;
  const requests = []; let committed = null; let loseNext = true;
  await notePage.route(`**/api/job-cards/${fixture.noteJob}/notes`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const body = JSON.parse(route.request().postData() || '{}'); requests.push(body);
    if (!loseNext) return route.continue();
    loseNext = false; const response = await route.fetch(); committed = { status: response.status(), body: await response.json() }; await route.abort('connectionfailed');
  });
  await loginBrowser(context, fixture.admin);
  await notePage.goto(`/jobs/${fixture.noteJob}`);
  await notePage.getByRole('heading', { name: 'Notlar', exact: true }).waitFor();
  await notePage.locator('#job-note').fill('JCID note A original');
  await notePage.getByRole('button', { name: 'Not ekle' }).click();
  await notePage.getByRole('button', { name: 'Özgün isteği tekrar dene', exact: true }).waitFor({ timeout: 10000 });
  record('NOTE-COMMITTED-RESPONSE-LOST', committed?.status === 201 && committed?.body?.note === 'JCID note A original', `status=${committed?.status}; note=${committed?.body?.note}`);
  record('NOTE-FIELDS-FROZEN', await notePage.locator('#job-note').isDisabled(), 'note textarea disabled while ambiguous');
  await notePage.getByRole('button', { name: 'Özgün isteği tekrar dene', exact: true }).click(); await notePage.waitForTimeout(400);
  record('NOTE-EXACT-RETRY', requests.length === 2 && JSON.stringify(requests[0]) === JSON.stringify(requests[1]), JSON.stringify(requests[1] ?? null));
  // After reconciliation a deliberately new note B works with a new key.
  await notePage.locator('#job-note').fill('JCID note B later');
  await notePage.getByRole('button', { name: 'Not ekle' }).click(); await notePage.waitForTimeout(400);
  const noteBRequests = requests.length - 2;
  record('NOTE-NEW-INTENT-AFTER-RECONCILIATION', noteBRequests === 1 && requests[2]?.note === 'JCID note B later' && requests[2]?.clientActionId !== requests[0]?.clientActionId, JSON.stringify(requests[2] ?? null));
  const client = new Client({ connectionString: databaseUrl }); await client.connect();
  try {
    const noteA = (await client.query(`SELECT count(*)::int AS n FROM job_card_notes WHERE job_card_id=$1 AND note='JCID note A original'`, [fixture.noteJob])).rows[0].n;
    const noteB = (await client.query(`SELECT count(*)::int AS n FROM job_card_notes WHERE job_card_id=$1 AND note='JCID note B later'`, [fixture.noteJob])).rows[0].n;
    record('NOTE-DB-NO-DUPLICATE', noteA === 1 && noteB === 1, `noteA=${noteA}; noteB=${noteB}`);
  } finally { await client.end(); }
  await context.close();
}

async function injectRealtimeUpdate(fixture) {
  const client = new Client({ connectionString: databaseUrl }); await client.connect();
  try {
    const activity = (await client.query(`INSERT INTO job_card_activity_logs (organization_id,job_card_id,actor_id,event_type,old_value,new_value) VALUES ($1,$2,$3,'MEETING_DETAILS_UPDATED',NULL,'{}') RETURNING id`, [fixture.organizationId, fixture.meetingJob, fixture.staff])).rows[0].id;
    await client.query(`INSERT INTO realtime_events (organization_id,source_activity_id,event_type,entity_type,entity_id,actor_user_id,audience_roles,audience_user_ids,resource_keys) VALUES ($1,$2,'job.updated','job-card',$3,NULL,ARRAY['ADMIN']::varchar[],ARRAY[]::uuid[],ARRAY[$4])`, [fixture.organizationId, activity, fixture.meetingJob, `job-detail:${fixture.meetingJob}`]);
  } finally { await client.end(); }
}


async function invalidResponseCase(fixture) {
  // Two create screens, one failure mode: the backend COMMITS the mutation and
  // returns HTTP 201, but the response body delivered to the browser is
  // corrupted so the real api parser raises ApiError(0, INVALID_RESPONSE).
  if (!browser) browser = await chromium.launch(browserLaunchOptions);
  const context = await browser.newContext({ baseURL: webOrigin, viewport: { width: 1440, height: 1000 } });
  const gtPage = await context.newPage(); activePage = gtPage;
  const gtRequests = []; let gtCommitted = null; let gtCorruptNext = true;
  await gtPage.route('**/api/job-cards', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'POST' || url.pathname !== '/api/job-cards') return route.continue();
    const body = JSON.parse(route.request().postData() || '{}'); gtRequests.push(body);
    if (!gtCorruptNext) return route.continue();
    gtCorruptNext = false;
    const response = await route.fetch(); gtCommitted = { status: response.status(), body: await response.json() };
    await route.fulfill({ status: response.status(), contentType: 'application/json', body: '{"jobCardId":"截断' });
  });
  await loginBrowser(context, fixture.admin);
  await gtPage.goto('/jobs/new-task');
  await gtPage.getByText('Takip edilmesi gereken işi kısa ve açık biçimde kaydedin.').waitFor();
  await gtPage.locator('#task-title').fill('JCID invalid response task A');
  await gtPage.locator('#task-assignee option', { hasText: 'JCID Staff' }).first().waitFor({ state: 'attached', timeout: 10000 });
  await gtPage.locator('#task-assignee').selectOption(fixture.staff);
  await gtPage.getByRole('button', { name: 'Görevi oluştur' }).click();
  await gtPage.waitForTimeout(800); await screenshot('gt-after-submit.png', gtPage).catch(() => {});
  await gtPage.getByRole('button', { name: 'Özgün isteği tekrar dene', exact: true }).waitFor({ timeout: 10000 });
  record('GT-INVALID-RESPONSE-COMMITTED', gtCommitted?.status === 201 && gtCommitted?.body?.id, `status=${gtCommitted?.status}; id=${gtCommitted?.body?.id}`);
  record('GT-INVALID-RESPONSE-FROZEN', await gtPage.locator('#task-title').isDisabled(), 'general task form frozen after invalid success response');
  await gtPage.getByRole('button', { name: 'Özgün isteği tekrar dene', exact: true }).click(); await gtPage.waitForTimeout(400);
  record('GT-INVALID-RESPONSE-EXACT-RETRY', gtRequests.length === 2 && JSON.stringify(gtRequests[0]) === JSON.stringify(gtRequests[1]), JSON.stringify(gtRequests[1] ?? null));
  const gtClient = new Client({ connectionString: databaseUrl }); await gtClient.connect();
  try {
    const gtJobs = (await gtClient.query(`SELECT count(*)::int AS n FROM job_cards WHERE organization_id=$1 AND type='GENERAL_TASK' AND title='JCID invalid response task A'`, [fixture.organizationId])).rows[0].n;
    record('GT-INVALID-RESPONSE-DB-NO-DUPLICATE', gtJobs === 1, `general task job cards=${gtJobs}`);
  } finally { await gtClient.end(); }

  // Sales meeting create: same failure mode, duplicate durable JobCard risk.
  const smPage = await context.newPage(); activePage = smPage;
  const smRequests = []; let smCommitted = null; let smCorruptNext = true;
  await smPage.route('**/api/job-cards', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'POST' || url.pathname !== '/api/job-cards') return route.continue();
    const body = JSON.parse(route.request().postData() || '{}'); smRequests.push(body);
    if (!smCorruptNext) return route.continue();
    smCorruptNext = false;
    const response = await route.fetch(); smCommitted = { status: response.status(), body: await response.json() };
    await route.fulfill({ status: response.status(), contentType: 'application/json', body: '{"jobCardId":"截断' });
  });
  await smPage.goto('/jobs/new-meeting');
  await smPage.getByRole('heading', { name: 'Görüşme / ziyaret planla', exact: true }).waitFor();
  await smPage.locator('#meeting-title').fill('JCID invalid response meeting A');
  await smPage.locator('#meeting-engagement-kind').selectOption('PRODUCT_DEMO');
  await smPage.locator('.servora-ant-select').first().click();
  await smPage.locator('.servora-ant-select-dropdown .servora-ant-select-item-option', { hasText: 'JCID Delivery Klinik' }).first().waitFor({ timeout: 10000 });
  await smPage.locator('.servora-ant-select-dropdown .servora-ant-select-item-option', { hasText: 'JCID Delivery Klinik' }).first().click();
  await smPage.locator('#meeting-assignee option', { hasText: 'JCID Staff' }).first().waitFor({ state: 'attached', timeout: 10000 });
  await smPage.locator('#meeting-assignee').selectOption(fixture.staff);
  await smPage.locator('#meeting-scheduled-at').fill('2026-09-20T11:00');
  await smPage.getByRole('button', { name: /planla/i }).click();
  await smPage.getByRole('button', { name: 'Özgün isteği tekrar dene', exact: true }).waitFor({ timeout: 10000 });
  record('SM-INVALID-RESPONSE-COMMITTED', smCommitted?.status === 201 && smCommitted?.body?.id, `status=${smCommitted?.status}; id=${smCommitted?.body?.id}`);
  record('SM-INVALID-RESPONSE-FROZEN', await smPage.locator('#meeting-title').isDisabled(), 'sales meeting form frozen after invalid success response');
  await smPage.getByRole('button', { name: 'Özgün isteği tekrar dene', exact: true }).click(); await smPage.waitForTimeout(400);
  record('SM-INVALID-RESPONSE-EXACT-RETRY', smRequests.length === 2 && JSON.stringify(smRequests[0]) === JSON.stringify(smRequests[1]), JSON.stringify(smRequests[1] ?? null));
  const smClient = new Client({ connectionString: databaseUrl }); await smClient.connect();
  try {
    const smJobs = (await smClient.query(`SELECT count(*)::int AS n FROM job_cards WHERE organization_id=$1 AND type='SALES_MEETING' AND title='JCID invalid response meeting A'`, [fixture.organizationId])).rows[0].n;
    record('SM-INVALID-RESPONSE-DB-NO-DUPLICATE', smJobs === 1, `sales meeting job cards=${smJobs}`);
  } finally { await smClient.end(); }
  await context.close();
}

async function backendCases(fixture) {
  const session = await login(fixture.admin);
  const cancel = { clientActionId: 'jcid-cancel-original', expectedVersion: 1, cancelReason: 'JCID cancellation reason' };
  const revision = { clientActionId: 'jcid-revision-original', expectedVersion: 1, revisionReason: 'JCID revision reason' };
  const firstCancel = await api(session.cookie, `/api/job-cards/${fixture.cancelJob}/cancel`, cancel);
  const replayCancel = await api(session.cookie, `/api/job-cards/${fixture.cancelJob}/cancel`, cancel);
  record('CANCEL-PAYLOAD-AND-IDEMPOTENCY', firstCancel.status === 200 && replayCancel.status === 200 && firstCancel.body?.status === 'CANCELLED' && replayCancel.body?.version === 2, `first=${firstCancel.status}; replay=${replayCancel.status}`);
  const firstRevision = await api(session.cookie, `/api/job-cards/${fixture.revisionJob}/request-revision`, revision);
  const replayRevision = await api(session.cookie, `/api/job-cards/${fixture.revisionJob}/request-revision`, revision);
  record('REVISION-PAYLOAD-AND-IDEMPOTENCY', firstRevision.status === 200 && replayRevision.status === 200 && firstRevision.body?.status === 'REVISION_REQUESTED' && replayRevision.body?.version === 2, `first=${firstRevision.status}; replay=${replayRevision.status}`);
}

try {
  serverOrigin = `http://127.0.0.1:${await port()}`; webOrigin = `http://127.0.0.1:${await port()}`;
  await startPostgres(); await createDatabase(); const runtime = env({ PORT: serverOrigin.split(':').pop() });
  await command('npm', ['run', 'build'], { cwd: server, env: runtime }); await command('node', ['dist/db/migrate.js'], { cwd: server, env: runtime });
  const fixture = await seed(); const apiServer = start('fastify', 'node', ['dist/index.js'], { cwd: server, env: runtime }); await ready(`${serverOrigin}/api/health`, apiServer);
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, `${web}/vite.config.ts`, web);
  viteServer = await createViteServer({ ...(loaded?.config || {}), configFile: false, root: web, server: { ...(loaded?.config.server || {}), host: '127.0.0.1', port: Number(webOrigin.split(':').pop()), strictPort: true, proxy: { '/api': { target: serverOrigin, changeOrigin: true } } } });
  await viteServer.listen();
  await backendCases(fixture); await meetingCase(fixture); await browserCase(fixture);
  await deliveryCase(fixture); await followUpCase(fixture); await noteCase(fixture); await invalidResponseCase(fixture);
} catch (error) { failure = error; if (activePage) try { await screenshot('failure.png', activePage); } catch { /* best effort */ } }
finally {
  if (viteServer) await viteServer.close().catch(() => {});
  for (const child of processes.reverse()) await stop(child);
  if (databaseCreated) { const client = new Client({ connectionString: adminUrl }); try { await client.connect(); await client.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [database]); await client.query(`DROP DATABASE "${database}"`); } finally { await client.end(); } }
  if (cluster) { await command(`${postgresBin}/pg_ctl`, ['-D', cluster, 'stop', '-m', 'fast', '-w'], { cwd: root }).catch(() => {}); rmSync(cluster, { recursive: true, force: true }); }
  if (browser) await browser.close().catch(() => {});
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(`${evidenceDir}/runtime-results.json`, `${JSON.stringify({ gate: 'JOBCARD_IDEMPOTENCY_RESPONSE_LOSS', result: failure ? 'FAIL' : 'PASS', assertions, screenshots, failure: failure ? clean(failure.message) : null }, null, 2)}\n`);
}
if (failure) throw failure;
console.info(`JobCard idempotency response-loss acceptance passed (${assertions.length} assertions). Evidence: ${evidenceDir}`);
