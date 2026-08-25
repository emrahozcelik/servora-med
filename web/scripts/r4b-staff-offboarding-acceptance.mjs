import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { chromium } from 'playwright';

const webDirectory = fileURLToPath(new URL('../', import.meta.url));
const repositoryDirectory = fileURLToPath(new URL('../../', import.meta.url));
const serverDirectory = fileURLToPath(new URL('../../server/', import.meta.url));
const evidenceDirectory = fileURLToPath(new URL('../../docs/evidence/r4b-staff-offboarding/', import.meta.url));
const screenshotDirectory = `${evidenceDirectory}/screenshots`;
const serverRequire = createRequire(new URL('../../server/package.json', import.meta.url));
const { Client } = serverRequire('pg');

const serverOrigin = 'http://127.0.0.1:3000';
const webOrigin = 'http://127.0.0.1:5173';
const storageKey = 'servora:r4b:staff-offboarding-attempt:v1';
const postgresBinCandidates = [
  process.env.R4B_POSTGRES_BIN,
  '/opt/homebrew/opt/postgresql@16/bin',
  '/opt/homebrew/opt/postgresql@17/bin',
  '/opt/homebrew/opt/postgresql@18/bin',
  '/opt/homebrew/opt/postgresql/bin',
  '/Applications/Postgres.app/Contents/Versions/latest/bin',
].filter(Boolean);
const postgresBin = postgresBinCandidates.find((candidate) => (
  existsSync(`${candidate}/initdb`) && existsSync(`${candidate}/pg_ctl`)
));

if (!postgresBin) throw new Error('An isolated PostgreSQL initdb/pg_ctl installation is required');

mkdirSync(screenshotDirectory, { recursive: true });
const results = [];
const screenshots = [];
let serverProcess;
let viteProcess;
let browser;
let page;
let postgresClusterDirectory = '';
let postgresStarted = false;
let disposableDatabaseName = '';
let disposableDatabaseUrl = '';
let adminDatabaseUrl = '';
let databaseCreated = false;
let serverEnvironmentFileCreated = false;
let failure = null;

function sanitize(value) {
  return String(value).replaceAll(/postgres(?:ql)?:\/\/[^@\s]+@/gi, 'postgresql://***@').slice(0, 2_000);
}

function record(id, passed, observed) {
  results.push({ id, status: passed ? 'PASS' : 'FAIL', observed: sanitize(observed) });
  if (!passed) throw new Error(`${id}: ${sanitize(observed)}`);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function environment(overrides = {}) {
  return {
    ...process.env,
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: '3000',
    CORS_ORIGIN: webOrigin,
    DATABASE_URL: disposableDatabaseUrl,
    HEALTH_SCHEMA_VERSION: '',
    CALENDAR_ENABLED: 'true',
    MESSAGING_ENABLED: 'true',
    WEB_PUSH_ENABLED: 'false',
    ACTION_SCOPED_GEOLOCATION_ENABLED: 'false',
    ...overrides,
  };
}

async function runCommand(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: 'inherit',
  });
  const [code, signal] = await once(child, 'exit');
  if (code !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${code ?? signal}`);
}

function startProcess(label, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => process.stdout.write(`[${label}] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[${label}] ${chunk}`));
  return child;
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), delay(5_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
}

async function waitForHttp(url, child, timeoutMilliseconds = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMilliseconds) {
    if (child?.exitCode !== null) throw new Error(`Process exited before ${url} became ready`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Expected while the process starts.
    }
    await delay(150);
  }
  throw new Error(`${url} did not become ready within ${timeoutMilliseconds}ms`);
}

async function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const socket = createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address();
      if (!address || typeof address === 'string') {
        socket.close();
        reject(new Error('Could not reserve a loopback port'));
        return;
      }
      socket.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function startIsolatedPostgres() {
  postgresClusterDirectory = mkdtempSync('/private/tmp/servora-r4b-postgres-');
  const port = await reserveLoopbackPort();
  await runCommand(`${postgresBin}/initdb`, [
    '-D', postgresClusterDirectory, '--auth=trust', '--username=servora_r4b', '--encoding=UTF8', '--no-locale',
  ], { cwd: repositoryDirectory, env: { ...process.env, LC_ALL: 'C' } });
  await runCommand(`${postgresBin}/pg_ctl`, [
    '-D', postgresClusterDirectory, '-l', `${postgresClusterDirectory}/postgres.log`,
    '-o', `-h 127.0.0.1 -p ${port} -F`, 'start', '-w',
  ], { cwd: repositoryDirectory, env: { ...process.env, LC_ALL: 'C' } });
  postgresStarted = true;
  adminDatabaseUrl = `postgresql://servora_r4b@127.0.0.1:${port}/postgres`;
  record('POSTGRES-ISOLATED-CLUSTER', true, 'Disposable PostgreSQL cluster started under /private/tmp');
}

async function stopIsolatedPostgres() {
  if (postgresStarted) {
    await runCommand(`${postgresBin}/pg_ctl`, [
      '-D', postgresClusterDirectory, 'stop', '-m', 'fast', '-w',
    ], { cwd: repositoryDirectory });
    postgresStarted = false;
  }
  if (!postgresClusterDirectory) return;
  if (!postgresClusterDirectory.startsWith('/private/tmp/servora-r4b-postgres-')) {
    throw new Error('Refusing to remove an unexpected PostgreSQL cluster path');
  }
  rmSync(postgresClusterDirectory, { recursive: true, force: true });
  postgresClusterDirectory = '';
}

function databaseUrlFor(name) {
  const url = new URL(adminDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function createDisposableDatabase() {
  disposableDatabaseName = `servora_r4b_${randomBytes(6).toString('hex')}`;
  const admin = new Client({ connectionString: adminDatabaseUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${disposableDatabaseName}"`);
  } finally {
    await admin.end();
  }
  disposableDatabaseUrl = databaseUrlFor(disposableDatabaseName);
  databaseCreated = true;
  record('POSTGRES-DISPOSABLE-CREATED', true, 'Dedicated disposable database created');
}

async function dropDisposableDatabase() {
  if (!databaseCreated) return;
  const admin = new Client({ connectionString: adminDatabaseUrl });
  await admin.connect();
  try {
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [disposableDatabaseName],
    );
    await admin.query(`DROP DATABASE "${disposableDatabaseName}"`);
    databaseCreated = false;
  } finally {
    await admin.end();
  }
}

function ensureServerEnvironmentFile() {
  const environmentFile = `${serverDirectory}/.env`;
  if (existsSync(environmentFile)) return;
  writeFileSync(environmentFile, `DATABASE_URL=${disposableDatabaseUrl}\n`, { mode: 0o600 });
  serverEnvironmentFileCreated = true;
}

async function seedFixture() {
  const admin = {
    email: 'r4b-admin@example.test',
    password: `R4B-Admin-${randomBytes(18).toString('base64url')}!`,
  };
  await runCommand('npm', ['run', 'bootstrap:admin'], {
    cwd: serverDirectory,
    env: environment({
      BOOTSTRAP_ORGANIZATION_NAME: 'R4B Offboarding Acceptance',
      BOOTSTRAP_ADMIN_NAME: 'R4B Admin',
      BOOTSTRAP_ADMIN_EMAIL: admin.email,
      BOOTSTRAP_ADMIN_PASSWORD: admin.password,
    }),
  });
  const { hashPassword } = await import(pathToFileURL(`${serverDirectory}/dist/modules/auth/crypto.js`).href);
  const manager = { email: 'r4b-manager@example.test', password: `R4B-Manager-${randomBytes(12).toString('base64url')}!` };
  const staffViewer = { email: 'r4b-viewer@example.test', password: `R4B-Viewer-${randomBytes(12).toString('base64url')}!` };
  const [managerHash, viewerHash, targetHash] = await Promise.all([
    hashPassword(manager.password), hashPassword(staffViewer.password), hashPassword(`R4B-Target-${randomBytes(12).toString('base64url')}!`),
  ]);
  const client = new Client({ connectionString: disposableDatabaseUrl });
  await client.connect();
  try {
    const adminRow = (await client.query(
      'SELECT id, organization_id FROM users WHERE lower(email) = lower($1)', [admin.email],
    )).rows[0];
    if (!adminRow) throw new Error('Bootstrap Admin was not created');
    const organizationId = adminRow.organization_id;
    async function insertUser(role, name, email, passwordHash = targetHash) {
      const user = (await client.query(
        `INSERT INTO users (organization_id, name, email, password_hash, role)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [organizationId, name, email, passwordHash, role],
      )).rows[0];
      if (role === 'STAFF') {
        await client.query(
          `INSERT INTO staff_profiles (organization_id, user_id, title)
           VALUES ($1, $2, 'Saha uzmanı')`, [organizationId, user.id],
        );
      }
      return user.id;
    }
    const managerId = await insertUser('MANAGER', 'R4B Manager', manager.email, managerHash);
    const viewerId = await insertUser('STAFF', 'R4B Staff Viewer', staffViewer.email, viewerHash);
    const replacementId = await insertUser('STAFF', 'R4B Replacement Staff', 'r4b-replacement@example.test');
    const targets = {};
    for (const [key, name] of [
      ['happy', 'R4B Mixed Target'], ['zero', 'R4B Zero Target'], ['stale', 'R4B Stale Target'],
      ['ambiguous', 'R4B Ambiguous Target'], ['malformed', 'R4B Malformed Target'],
      ['inProgress', 'R4B In Progress Target'], ['reused', 'R4B Reused Target'],
      ['invalidReplacement', 'R4B Invalid Replacement Target'],
    ]) {
      targets[key] = await insertUser('STAFF', name, `r4b-${key.toLowerCase()}@example.test`);
    }

    async function insertJob(title, assignedTo, withFollowUp = false) {
      return (await client.query(
        `INSERT INTO job_cards (
           organization_id, type, status, title, assigned_to, created_by,
           follow_up_proposed_at, follow_up_proposed_type, follow_up_proposed_assignee,
           follow_up_proposal_instructions, follow_up_proposal_origin, follow_up_proposed_by
         ) VALUES (
           $1, 'GENERAL_TASK', 'NEW', $2, $3, $4,
           CASE WHEN $5 THEN '2030-09-03T08:00:00Z'::timestamptz ELSE NULL END,
           CASE WHEN $5 THEN 'GENERAL_TASK' ELSE NULL END,
           CASE WHEN $5 THEN $3::uuid ELSE NULL END,
           CASE WHEN $5 THEN 'R4B follow-up responsibility' ELSE NULL END,
           CASE WHEN $5 THEN 'SYSTEM' ELSE NULL END,
           CASE WHEN $5 THEN $4::uuid ELSE NULL END
         ) RETURNING id`,
        [organizationId, title, assignedTo, adminRow.id, withFollowUp],
      )).rows[0].id;
    }

    const happyCustomer = (await client.query(
      `INSERT INTO customers (organization_id, name, customer_type, status, assigned_staff_user_id)
       VALUES ($1, 'R4B Mavi Klinik', 'clinic', 'active', $2) RETURNING id`,
      [organizationId, targets.happy],
    )).rows[0].id;
    const happyJob = await insertJob('R4B Klinik teslimatı', targets.happy, true);
    const happyCalendar = (await client.query(
      `INSERT INTO calendar_events
        (organization_id, assigned_user_id, title, starts_at, ends_at, timezone, created_by, updated_by)
       VALUES ($1, $2, 'R4B Ürün kurulumu', '2030-09-01T08:00:00Z', '2030-09-01T09:00:00Z',
         'Europe/Istanbul', $3, $3) RETURNING id`,
      [organizationId, targets.happy, adminRow.id],
    )).rows[0].id;
    const happyReminder = (await client.query(
      `INSERT INTO calendar_reminders
        (organization_id, calendar_event_id, recipient_user_id, remind_at, next_attempt_at, dedupe_key)
       VALUES ($1, $2, $3, '2030-09-01T07:45:00Z', '2030-09-01T07:45:00Z', $4) RETURNING id`,
      [organizationId, happyCalendar, targets.happy, `R4B:HAPPY:${randomBytes(8).toString('hex')}`],
    )).rows[0].id;
    await client.query(
      `INSERT INTO sessions (user_id, token_hash, expires_at)
       VALUES ($1, $2, '2099-01-01T00:00:00Z')`,
      [targets.zero, randomBytes(32).toString('hex')],
    );
    const staleJob = await insertJob('R4B Eski sorumluluk', targets.stale);
    const invalidJob = await insertJob('R4B Geçersiz replacement işi', targets.invalidReplacement);
    return {
      organizationId,
      admin: { ...admin, id: adminRow.id },
      manager: { ...manager, id: managerId },
      staffViewer: { ...staffViewer, id: viewerId },
      replacementId,
      targets,
      ids: { happyCustomer, happyJob, happyCalendar, happyReminder, staleJob, invalidJob },
    };
  } finally {
    await client.end();
  }
}

async function loginHttp(credentials) {
  const response = await fetch(`${serverOrigin}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: webOrigin },
    body: JSON.stringify({ email: credentials.email, password: credentials.password }),
  });
  const body = await response.json();
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
  if (!response.ok || !cookie) throw new Error(`Login failed: ${response.status} ${JSON.stringify(body)}`);
  return { cookie, user: body.user };
}

async function apiRequest(cookie, path, init = {}) {
  const response = await fetch(`${serverOrigin}${path}`, {
    ...init,
    headers: {
      origin: webOrigin, cookie,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init.headers ?? {}),
    },
  });
  let body = null;
  try { body = await response.json(); } catch { /* no body */ }
  return { status: response.status, body };
}

async function runBackendRoleAcceptance(fixture) {
  const admin = await loginHttp(fixture.admin);
  const manager = await loginHttp(fixture.manager);
  const staff = await loginHttp(fixture.staffViewer);
  const path = `/api/users/${fixture.targets.reused}/offboarding/preview`;
  const [adminPreview, managerPreview, staffPreview] = await Promise.all([
    apiRequest(admin.cookie, path, { method: 'POST', body: JSON.stringify({}) }),
    apiRequest(manager.cookie, path, { method: 'POST', body: JSON.stringify({}) }),
    apiRequest(staff.cookie, path, { method: 'POST', body: JSON.stringify({}) }),
  ]);
  record('REAL-FASTIFY-ADMIN-PREVIEW', adminPreview.status === 200, `status=${adminPreview.status}`);
  record('REAL-FASTIFY-MANAGER-403', managerPreview.status === 403, `status=${managerPreview.status}`);
  record('REAL-FASTIFY-STAFF-403', staffPreview.status === 403, `status=${staffPreview.status}`);
}

async function screenshot(name) {
  const path = `${screenshotDirectory}/${name}`;
  await page.screenshot({ path, fullPage: true });
  screenshots.push(`screenshots/${name}`);
}

async function loginBrowser(credentials) {
  await page.goto('/login');
  await page.getByLabel('E-posta').fill(credentials.email);
  await page.getByLabel('Parola').fill(credentials.password);
  await page.getByRole('button', { name: 'Giriş yap', exact: true }).click();
  await page.waitForURL((url) => !url.pathname.endsWith('/login'));
  await page.getByRole('button', { name: 'Oturumu kapat', exact: true }).waitFor();
}

async function openWorkflow(targetId) {
  await page.goto(`/users/${targetId}`);
  const trigger = page.getByRole('button', { name: 'Personeli devre dışı bırak', exact: true });
  await trigger.waitFor();
  await trigger.click();
  await page.getByRole('combobox', { name: 'İdari neden' }).waitFor();
}

async function selectAllDecisions(replacementId, { customerAction = 'UNASSIGN', reminderAction = 'CANCEL' } = {}) {
  await page.getByRole('combobox', { name: 'İdari neden' }).selectOption('ACCESS_ENDED');
  for (const selector of ['select[name^="job-"]', 'select[name^="calendar-"]', 'select[name^="follow-up-"]']) {
    const fields = page.locator(selector);
    for (let index = 0; index < await fields.count(); index += 1) await fields.nth(index).selectOption(replacementId);
  }
  const customers = page.locator('select[name^="customer-action-"]');
  for (let index = 0; index < await customers.count(); index += 1) {
    await customers.nth(index).selectOption(customerAction);
  }
  if (customerAction === 'REASSIGN') {
    const replacements = page.locator('select[name^="customer-replacement-"]');
    for (let index = 0; index < await replacements.count(); index += 1) await replacements.nth(index).selectOption(replacementId);
  }
  const reminders = page.locator('select[name^="reminder-action-"]');
  for (let index = 0; index < await reminders.count(); index += 1) await reminders.nth(index).selectOption(reminderAction);
  if (reminderAction === 'TRANSFER') {
    const replacements = page.locator('select[name^="reminder-replacement-"]');
    for (let index = 0; index < await replacements.count(); index += 1) await replacements.nth(index).selectOption(replacementId);
  }
}

async function openFinalConfirmation() {
  await page.getByRole('button', { name: 'Kararları onayla', exact: true }).click();
  const confirmation = page.locator('.workflow-dialog');
  await confirmation.waitFor();
  return confirmation;
}

async function confirmFinal() {
  const confirmation = await openFinalConfirmation();
  await confirmation.getByRole('button', { name: 'Erişimi sonlandır', exact: true }).click();
}

async function waitForSuccess() {
  await page.getByText('Personel devre dışı bırakıldı', { exact: true }).waitFor();
}

async function withDatabase(run) {
  const client = new Client({ connectionString: disposableDatabaseUrl });
  await client.connect();
  try { return await run(client); } finally { await client.end(); }
}

async function runBrowserAcceptance(fixture) {
  const chromeCandidate = process.env.R4B_BROWSER_EXECUTABLE
    ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch(existsSync(chromeCandidate)
    ? { headless: true, executablePath: chromeCandidate }
    : { headless: true });
  const browserContext = await browser.newContext({ baseURL: webOrigin, viewport: { width: 1440, height: 1000 } });
  page = await browserContext.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(sanitize(error.message)));
  await loginBrowser(fixture.admin);

  const executeRequests = new Map();
  page.on('request', (request) => {
    const match = request.url().match(/\/api\/users\/([^/]+)\/offboarding\/execute$/);
    if (!match || request.method() !== 'POST') return;
    const requests = executeRequests.get(match[1]) ?? [];
    requests.push(request.postDataJSON());
    executeRequests.set(match[1], requests);
  });

  await openWorkflow(fixture.targets.happy);
  const happyText = await page.locator('.form-drawer').innerText();
  record('UI-MIXED-PREVIEW-REAL-DATA', ['Aktif işler', 'Müşteriler', 'Takvim atamaları', 'Takip atamaları', 'Hatırlatıcılar']
    .every((label) => happyText.includes(label)), 'All real R4A responsibility categories are visible');
  record('UI-NO-FREE-TEXT-REASON', await page.locator('.offboarding-form textarea').count() === 0,
    'Offboarding reason remains enum-only');
  await selectAllDecisions(fixture.replacementId, { customerAction: 'UNASSIGN', reminderAction: 'CANCEL' });
  const happyConfirmation = await openFinalConfirmation();
  record('UI-FINAL-CONFIRMATION', (await happyConfirmation.innerText()).includes('Erişim sonlandırılır'),
    'Final destructive confirmation summarizes consequences');
  await screenshot('01-mixed-confirmation-desktop.png');
  await happyConfirmation.getByRole('button', { name: 'Erişimi sonlandır', exact: true }).click();
  await waitForSuccess();
  record('UI-HAPPY-AUTHORITATIVE-SUCCESS', executeRequests.get(fixture.targets.happy)?.length === 1,
    `execute count=${executeRequests.get(fixture.targets.happy)?.length ?? 0}`);
  await screenshot('02-mixed-success-desktop.png');

  await openWorkflow(fixture.targets.zero);
  const zeroDrawer = page.locator('.form-drawer');
  record('UI-ZERO-RESPONSIBILITY-EMPTY-STATE', (await zeroDrawer.innerText()).includes('Aktarılması gereken aktif sorumluluk bulunmuyor.'),
    'Server-authoritative zero-business state is explicit');
  record('UI-ZERO-SECURITY-CONSEQUENCE', (await zeroDrawer.innerText()).includes('Aktif oturum')
    && (await zeroDrawer.innerText()).includes('1'), 'Session consequence remains visible');
  record('UI-ZERO-NO-REPLACEMENT', await zeroDrawer.locator('select[name*="replacement"], select[name^="job-"], select[name^="calendar-"], select[name^="follow-up-"]').count() === 0,
    'No replacement decision is required');
  await selectAllDecisions(fixture.replacementId);
  await confirmFinal();
  await waitForSuccess();
  record('UI-ZERO-EXECUTE', executeRequests.get(fixture.targets.zero)?.length === 1,
    `execute count=${executeRequests.get(fixture.targets.zero)?.length ?? 0}`);

  await openWorkflow(fixture.targets.stale);
  await selectAllDecisions(fixture.replacementId);
  const newStaleJobId = await withDatabase(async (client) => (await client.query(
    `INSERT INTO job_cards (organization_id, type, status, title, assigned_to, created_by)
     VALUES ($1, 'GENERAL_TASK', 'NEW', 'R4B Yeni sorumluluk', $2, $3) RETURNING id`,
    [fixture.organizationId, fixture.targets.stale, fixture.admin.id],
  )).rows[0].id);
  await confirmFinal();
  await page.getByText('Sorumluluklar veya uygun personel değişti.', { exact: false }).waitFor();
  await page.getByText('R4B Yeni sorumluluk', { exact: true }).waitFor();
  record('UI-STALE-PLAN-REFRESH', await page.getByText('Personel devre dışı bırakıldı', { exact: true }).count() === 0,
    'Stale plan did not show success and fresh graph is visible');
  await selectAllDecisions(fixture.replacementId);
  await confirmFinal();
  await waitForSuccess();
  record('UI-STALE-RECONFIRM', executeRequests.get(fixture.targets.stale)?.length === 2,
    `execute count=${executeRequests.get(fixture.targets.stale)?.length ?? 0}`);

  const ambiguousPayloads = [];
  let ambiguousBackendReceipt = null;
  await page.route(`**/api/users/${fixture.targets.ambiguous}/offboarding/execute`, async (route) => {
    ambiguousPayloads.push(route.request().postDataJSON());
    if (ambiguousPayloads.length === 1) {
      const response = await route.fetch();
      ambiguousBackendReceipt = { status: response.status(), body: await response.json() };
      await route.abort('connectionfailed');
      return;
    }
    await route.continue();
  });
  await openWorkflow(fixture.targets.ambiguous);
  await selectAllDecisions(fixture.replacementId);
  await confirmFinal();
  await waitForSuccess();
  record('UI-AMBIGUOUS-SAME-ID-REPLAY', ambiguousPayloads.length === 2
    && ambiguousPayloads[0].clientActionId === ambiguousPayloads[1].clientActionId
    && ambiguousBackendReceipt?.status === 200,
  `requests=${ambiguousPayloads.length}, backend=${ambiguousBackendReceipt?.status ?? 'missing'}`);
  await page.unroute(`**/api/users/${fixture.targets.ambiguous}/offboarding/execute`);

  const malformedPayloads = [];
  await page.route(`**/api/users/${fixture.targets.malformed}/offboarding/execute`, async (route) => {
    malformedPayloads.push(route.request().postDataJSON());
    if (malformedPayloads.length === 1) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        status: 'OFFBOARDED', targetUserId: 'wrong-target', planHash: '0'.repeat(64), summary: {},
      }) });
      return;
    }
    await route.continue();
  });
  await openWorkflow(fixture.targets.malformed);
  await selectAllDecisions(fixture.replacementId);
  await confirmFinal();
  await waitForSuccess();
  record('UI-MALFORMED-2XX-SAME-ID-RECONCILIATION', malformedPayloads.length === 2
    && malformedPayloads[0].clientActionId === malformedPayloads[1].clientActionId,
  `requests=${malformedPayloads.length}`);
  await page.unroute(`**/api/users/${fixture.targets.malformed}/offboarding/execute`);

  const progressPayloads = [];
  await page.route(`**/api/users/${fixture.targets.inProgress}/offboarding/execute`, async (route) => {
    progressPayloads.push(route.request().postDataJSON());
    if (progressPayloads.length === 1) {
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({
        code: 'ACTION_IN_PROGRESS', error: 'Aynı işlem halen devam ediyor.',
      }) });
      return;
    }
    await route.continue();
  });
  await openWorkflow(fixture.targets.inProgress);
  await selectAllDecisions(fixture.replacementId);
  await confirmFinal();
  await page.getByRole('button', { name: 'Aynı işlemi yeniden doğrula', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Aynı işlemi yeniden doğrula', exact: true }).click();
  await page.locator('.workflow-dialog').getByRole('button', { name: 'Erişimi sonlandır', exact: true }).click();
  await waitForSuccess();
  record('UI-ACTION-IN-PROGRESS-SAME-ID', progressPayloads.length === 2
    && progressPayloads[0].clientActionId === progressPayloads[1].clientActionId,
  `requests=${progressPayloads.length}`);
  await page.unroute(`**/api/users/${fixture.targets.inProgress}/offboarding/execute`);

  let reusedCount = 0;
  await page.route(`**/api/users/${fixture.targets.reused}/offboarding/execute`, async (route) => {
    reusedCount += 1;
    await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({
      code: 'CLIENT_ACTION_REUSED', error: 'clientActionId farklı bir işlem için kullanılamaz.',
    }) });
  });
  await openWorkflow(fixture.targets.reused);
  await selectAllDecisions(fixture.replacementId);
  await confirmFinal();
  await page.getByText('İşlem kimliği sunucu durumuyla eşleşmedi.', { exact: false }).waitFor();
  record('UI-CLIENT-ACTION-REUSED-FAIL-CLOSED', reusedCount === 1
    && await page.getByText('Personel devre dışı bırakıldı', { exact: true }).count() === 0
    && await page.evaluate((key) => sessionStorage.getItem(key), storageKey) === null,
  `execute count=${reusedCount}`);
  await page.unroute(`**/api/users/${fixture.targets.reused}/offboarding/execute`);

  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  record('UI-390PX-REFLOW', mobile.scrollWidth <= mobile.clientWidth,
    `scrollWidth=${mobile.scrollWidth}, clientWidth=${mobile.clientWidth}`);
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  const zoom200 = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  record('UI-200PCT-TEXT', zoom200.scrollWidth <= zoom200.clientWidth,
    `scrollWidth=${zoom200.scrollWidth}, clientWidth=${zoom200.clientWidth}`);
  await page.evaluate(() => { document.documentElement.style.fontSize = '400%'; });
  const zoom400 = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));


  record('UI-400PCT-REFLOW', zoom400.scrollWidth <= zoom400.clientWidth,
    `scrollWidth=${zoom400.scrollWidth}, clientWidth=${zoom400.clientWidth}`);

  await screenshot('03-responsive-400pct.png');
  await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
  await page.setViewportSize({ width: 1440, height: 1000 });

  // Scope to the panel close button: the full-screen backdrop shares the same
  // accessible name ("Formu kapat") while the drawer is open.
  await page.locator('.form-drawer-header').getByRole('button', { name: 'Formu kapat', exact: true }).click();
  record('UI-FOCUS-RESTORATION', await page.evaluate(() => document.activeElement?.textContent?.trim()) === 'Personeli devre dışı bırak',
    'Drawer close restores focus to the trigger');

  await openWorkflow(fixture.targets.invalidReplacement);
  await selectAllDecisions(fixture.replacementId);
  await withDatabase((client) => client.query('UPDATE users SET is_active = false WHERE id = $1', [fixture.replacementId]));
  await confirmFinal();
  await page.getByText('Sorumluluklar veya uygun personel değişti.', { exact: false }).waitFor();
  record('UI-INVALID-REPLACEMENT-REFRESH', await page.getByText('Personel devre dışı bırakıldı', { exact: true }).count() === 0
    && await page.getByRole('option', { name: /R4B Replacement Staff/ }).count() === 0,
  'Invalid replacement caused fresh preview and no optimistic success');
  record('BROWSER-NO-PAGE-ERRORS', pageErrors.length === 0,
    pageErrors.length === 0 ? 'No uncaught page errors' : pageErrors.join(' | '));

  return { executeRequests, newStaleJobId };
}

async function verifyDatabase(fixture, browserEvidence) {
  await withDatabase(async (client) => {
    const targetIds = [fixture.targets.happy, fixture.targets.zero, fixture.targets.stale,
      fixture.targets.ambiguous, fixture.targets.malformed, fixture.targets.inProgress];
    const users = await client.query('SELECT id, is_active FROM users WHERE id = ANY($1::uuid[])', [targetIds]);
    record('POSTGRES-OFFBOARDED-TARGETS-INACTIVE', users.rows.length === targetIds.length
      && users.rows.every((row) => row.is_active === false), `rows=${users.rows.length}`);
    const preserved = await client.query('SELECT id, is_active FROM users WHERE id = ANY($1::uuid[])', [
      [fixture.targets.reused, fixture.targets.invalidReplacement],
    ]);
    record('POSTGRES-FAILED-TARGETS-PRESERVED', preserved.rows.length === 2
      && preserved.rows.every((row) => row.is_active === true), `rows=${preserved.rows.length}`);
    const graph = (await client.query(
      `SELECT
        (SELECT assigned_to FROM job_cards WHERE id = $1) AS happy_job_owner,
        (SELECT assigned_staff_user_id FROM customers WHERE id = $2) AS happy_customer_owner,
        (SELECT assigned_user_id FROM calendar_events WHERE id = $3) AS happy_calendar_owner,
        (SELECT follow_up_proposed_assignee FROM job_cards WHERE id = $1) AS happy_follow_up_owner,
        (SELECT state FROM calendar_reminders WHERE id = $4) AS happy_reminder_state,
        (SELECT COUNT(*)::int FROM audit_events WHERE subject_id = ANY($5::uuid[]) AND event_type = 'USER_OFFBOARDED') AS audit_count`,
      [fixture.ids.happyJob, fixture.ids.happyCustomer, fixture.ids.happyCalendar, fixture.ids.happyReminder, targetIds],
    )).rows[0];
    record('POSTGRES-EXPLICIT-DECISIONS-PERSISTED', graph.happy_job_owner === fixture.replacementId
      && graph.happy_customer_owner === null
      && graph.happy_calendar_owner === fixture.replacementId
      && graph.happy_follow_up_owner === fixture.replacementId
      && graph.happy_reminder_state === 'CANCELLED', JSON.stringify(graph));
    record('POSTGRES-SINGLE-OFFBOARDING-AUDIT-PER-TARGET', graph.audit_count === targetIds.length,
      `audit count=${graph.audit_count}`);
    const ambiguousActions = (await client.query(
      `SELECT COUNT(*)::int AS count FROM processed_actions
       WHERE operation_key = $1 AND status = 'completed'`,
      [`USER_OFFBOARDING:${fixture.targets.ambiguous}`],
    )).rows[0].count;
    record('POSTGRES-AMBIGUOUS-SINGLE-RECEIPT', ambiguousActions === 1
      && browserEvidence.executeRequests.get(fixture.targets.ambiguous)?.length === 2,
    `receipts=${ambiguousActions}`);
  });
}

async function writeEvidence() {
  mkdirSync(evidenceDirectory, { recursive: true });
  const payload = {
    gate: 'R4B_STAFF_OFFBOARDING_ADMIN_UI_REAL_RUNTIME_ACCEPTANCE',
    executedAt: new Date().toISOString(),
    featureHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryDirectory, encoding: 'utf8' }).trim(),
    runtime: { vite: 'real', fastify: 'real', postgresql: 'disposable-real', browser: 'playwright-chromium' },
    result: failure ? 'FAIL' : 'PASS',
    assertions: results,
    screenshots,
    failure: failure ? sanitize(failure instanceof Error ? failure.message : failure) : null,
  };
  writeFileSync(`${evidenceDirectory}/runtime-results.json`, `${JSON.stringify(payload, null, 2)}\n`);
}

try {
  await startIsolatedPostgres();
  await createDisposableDatabase();
  ensureServerEnvironmentFile();
  const runtimeEnvironment = environment();
  await runCommand('npm', ['run', 'build'], { cwd: serverDirectory, env: runtimeEnvironment });
  await runCommand('npm', ['run', 'migrate'], { cwd: serverDirectory, env: runtimeEnvironment });
  record('POSTGRES-MIGRATIONS-001-037', true, 'All repository migrations completed on disposable PostgreSQL');
  const fixture = await seedFixture();
  serverProcess = startProcess('fastify', 'npm', ['run', 'start:prod'], { cwd: serverDirectory, env: runtimeEnvironment });
  await waitForHttp(`${serverOrigin}/api/health`, serverProcess);
  viteProcess = startProcess('vite', 'npm', [
    'run', 'dev', '--', '--host', '127.0.0.1', '--port', '5173', '--strictPort',
  ], { cwd: webDirectory, env: { ...process.env } });
  await waitForHttp(webOrigin, viteProcess);
  await runBackendRoleAcceptance(fixture);
  const browserEvidence = await runBrowserAcceptance(fixture);
  await verifyDatabase(fixture, browserEvidence);
} catch (caught) {
  failure = caught;
  if (page) {
    try { await screenshot('failure.png'); } catch { /* best effort */ }
  }
} finally {
  try { await browser?.close(); } catch { /* best effort */ }
  await stopProcess(viteProcess);
  await stopProcess(serverProcess);
  if (serverEnvironmentFileCreated) {
    unlinkSync(`${serverDirectory}/.env`);
    serverEnvironmentFileCreated = false;
  }
  try {
    await dropDisposableDatabase();
    if (!failure) record('POSTGRES-DISPOSABLE-DROPPED', true, 'Disposable database removed');
  } catch (cleanupError) {
    failure ??= cleanupError;
  }
  try { await stopIsolatedPostgres(); } catch (cleanupError) { failure ??= cleanupError; }
  await writeEvidence();
}

if (failure) throw failure;
console.info(`R4B runtime acceptance passed (${results.length} assertions).`);
