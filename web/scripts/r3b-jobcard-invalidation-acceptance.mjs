import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { chromium } from 'playwright';

const webDirectory = fileURLToPath(new URL('../', import.meta.url));
const repositoryDirectory = fileURLToPath(new URL('../../', import.meta.url));
const serverDirectory = fileURLToPath(new URL('../../server/', import.meta.url));
const evidenceDirectory = fileURLToPath(new URL('../../docs/evidence/r3b-jobcard-invalidation/', import.meta.url));
const screenshotDirectory = `${evidenceDirectory}/screenshots`;
const serverRequire = createRequire(new URL('../../server/package.json', import.meta.url));
const { Client } = serverRequire('pg');

const serverOrigin = 'http://127.0.0.1:3000';
const webOrigin = 'http://127.0.0.1:5173';
const postgresBinCandidates = [
  process.env.R3B_POSTGRES_BIN,
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
let databaseCreated = false;
let postgresClusterDirectory = '';
let postgresStarted = false;
let disposableDatabaseName = '';
let disposableDatabaseUrl = '';
let adminDatabaseUrl = '';
let serverEnvironmentFileCreated = false;
let failure = null;

function sanitize(value) {
  return String(value)
    .replaceAll(/postgres(?:ql)?:\/\/[^@\s]+@/gi, 'postgresql://***@')
    .slice(0, 2_000);
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
    CALENDAR_ENABLED: 'false',
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
      // Expected while a process is starting.
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
  postgresClusterDirectory = mkdtempSync('/private/tmp/servora-r3b-postgres-');
  const port = await reserveLoopbackPort();
  await runCommand(`${postgresBin}/initdb`, [
    '-D', postgresClusterDirectory,
    '--auth=trust',
    '--username=servora_r3b',
    '--encoding=UTF8',
    '--no-locale',
  ], { cwd: repositoryDirectory });
  await runCommand(`${postgresBin}/pg_ctl`, [
    '-D', postgresClusterDirectory,
    '-l', `${postgresClusterDirectory}/postgres.log`,
    '-o', `-h 127.0.0.1 -p ${port} -F`,
    'start',
    '-w',
  ], { cwd: repositoryDirectory });
  postgresStarted = true;
  adminDatabaseUrl = `postgresql://servora_r3b@127.0.0.1:${port}/postgres`;
  record('POSTGRES-ISOLATED-CLUSTER', true, 'Disposable PostgreSQL cluster started under /private/tmp');
}

async function stopIsolatedPostgres() {
  if (postgresStarted) {
    await runCommand(`${postgresBin}/pg_ctl`, [
      '-D', postgresClusterDirectory, 'stop', '-m', 'fast', '-w',
    ], { cwd: repositoryDirectory });
    postgresStarted = false;
  }
  if (postgresClusterDirectory) {
    if (!postgresClusterDirectory.startsWith('/private/tmp/servora-r3b-postgres-')) {
      throw new Error('Refusing to remove an unexpected PostgreSQL cluster path');
    }
    rmSync(postgresClusterDirectory, { recursive: true, force: true });
    postgresClusterDirectory = '';
  }
}

function databaseUrlFor(name) {
  const url = new URL(adminDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function createDisposableDatabase() {
  disposableDatabaseName = `servora_r3b_${randomBytes(6).toString('hex')}`;
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

async function ensureServerEnvironmentFile() {
  const environmentFile = `${serverDirectory}/.env`;
  if (existsSync(environmentFile)) return;
  writeFileSync(environmentFile, `DATABASE_URL=${disposableDatabaseUrl}\n`, { mode: 0o600 });
  serverEnvironmentFileCreated = true;
}

async function seedFixture() {
  const credentials = {
    email: 'r3b-admin@example.test',
    password: `R3B-${randomBytes(18).toString('base64url')}!`,
  };
  await runCommand('npm', ['run', 'bootstrap:admin'], {
    cwd: serverDirectory,
    env: environment({
      BOOTSTRAP_ORGANIZATION_NAME: 'R3B Invalidation Acceptance',
      BOOTSTRAP_ADMIN_NAME: 'R3B Admin',
      BOOTSTRAP_ADMIN_EMAIL: credentials.email,
      BOOTSTRAP_ADMIN_PASSWORD: credentials.password,
    }),
  });

  const { hashPassword } = await import(pathToFileURL(
    `${serverDirectory}/dist/modules/auth/crypto.js`,
  ).href);
  const managerPassword = `R3B-Manager-${randomBytes(12).toString('base64url')}!`;
  const staffPassword = `R3B-Staff-${randomBytes(12).toString('base64url')}!`;
  const otherPassword = `R3B-Other-${randomBytes(12).toString('base64url')}!`;
  const [managerHash, staffHash, otherHash] = await Promise.all([
    hashPassword(managerPassword), hashPassword(staffPassword), hashPassword(otherPassword),
  ]);

  const client = new Client({ connectionString: disposableDatabaseUrl });
  await client.connect();
  try {
    const identity = await client.query(
      'SELECT id AS admin_id, organization_id FROM users WHERE lower(email) = lower($1)',
      [credentials.email],
    );
    const admin = identity.rows[0];
    if (!admin) throw new Error('Bootstrap Admin was not created');
    const manager = (await client.query(
      `INSERT INTO users (organization_id, name, email, password_hash, role)
       VALUES ($1, 'R3B Manager', 'r3b-manager@example.test', $2, 'MANAGER') RETURNING id`,
      [admin.organization_id, managerHash],
    )).rows[0].id;
    const staff = (await client.query(
      `INSERT INTO users (organization_id, name, email, password_hash, role)
       VALUES ($1, 'R3B Staff', 'r3b-staff@example.test', $2, 'STAFF') RETURNING id`,
      [admin.organization_id, staffHash],
    )).rows[0].id;

    async function insertJob({ title, status = 'NEW', assignedTo = staff, sourceJobCardId = null }) {
      const started = ['IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED', 'COMPLETED', 'CANCELLED'].includes(status);
      const accepted = status !== 'NEW';
      const submitted = ['WAITING_APPROVAL', 'COMPLETED'].includes(status);
      const approved = status === 'COMPLETED';
      const cancelled = status === 'CANCELLED';
      const row = (await client.query(
        `INSERT INTO job_cards (
           organization_id, type, status, version, title, assigned_to, created_by, priority,
           accepted_at, accepted_by, started_at, staff_completed_at, staff_completed_by,
           manager_approved_at, manager_approved_by, cancelled_at, cancelled_by, cancel_reason,
           source_job_card_id, follow_up_instructions
         ) VALUES (
           $1::uuid, 'GENERAL_TASK', $2, 1, $3, $4::uuid, $5::uuid, 'normal',
           CASE WHEN $6 THEN NOW() ELSE NULL END,
           CASE WHEN $6 THEN $4::uuid ELSE NULL END,
           CASE WHEN $7 THEN NOW() ELSE NULL END,
           CASE WHEN $8 THEN NOW() ELSE NULL END,
           CASE WHEN $8 THEN $4::uuid ELSE NULL END,
           CASE WHEN $9 THEN NOW() ELSE NULL END,
           CASE WHEN $9 THEN $4::uuid ELSE NULL END,
           CASE WHEN $10 THEN NOW() ELSE NULL END,
           CASE WHEN $10 THEN $4::uuid ELSE NULL END,
           CASE WHEN $10 THEN 'Acceptance cancellation' ELSE NULL END,
           $11::uuid, CASE WHEN $11::uuid IS NULL THEN NULL ELSE 'Active follow-up acceptance child' END
         ) RETURNING id`,
        [admin.organization_id, status, title, assignedTo, admin.admin_id,
          accepted, started, submitted, approved, cancelled, sourceJobCardId],
      )).rows[0];
      await client.query(
        `INSERT INTO job_card_activity_logs
          (organization_id, job_card_id, actor_id, event_type, old_value, new_value)
         VALUES ($1, $2, $3, 'JOB_CREATED', NULL, jsonb_build_object('status', $4::text))`,
        [admin.organization_id, row.id, admin.admin_id, status],
      );
      return row.id;
    }

    const uiJobId = await insertJob({ title: 'R3B UI lost-response job' });
    const focusJobId = await insertJob({ title: 'R3B responsive focus job' });
    const completedJobId = await insertJob({ title: 'R3B completed direct job', status: 'COMPLETED' });
    const cancelledJobId = await insertJob({ title: 'R3B cancelled direct job', status: 'CANCELLED' });
    const blockedParentId = await insertJob({ title: 'R3B follow-up blocker parent', status: 'COMPLETED' });
    const blockedChildId = await insertJob({ title: 'R3B active follow-up child', sourceJobCardId: blockedParentId });

    const otherOrganization = (await client.query(
      `INSERT INTO organizations (name) VALUES ('R3B Other Organization') RETURNING id`,
    )).rows[0].id;
    const otherAdmin = (await client.query(
      `INSERT INTO users (organization_id, name, email, password_hash, role)
       VALUES ($1, 'Other Admin', 'r3b-other@example.test', $2, 'ADMIN') RETURNING id`,
      [otherOrganization, otherHash],
    )).rows[0].id;
    const otherJobId = (await client.query(
      `INSERT INTO job_cards (organization_id, type, status, title, assigned_to, created_by)
       VALUES ($1, 'GENERAL_TASK', 'NEW', 'R3B cross-scope job', $2, $2) RETURNING id`,
      [otherOrganization, otherAdmin],
    )).rows[0].id;

    return {
      organizationId: admin.organization_id,
      admin: credentials,
      manager: { email: 'r3b-manager@example.test', password: managerPassword },
      staff: { email: 'r3b-staff@example.test', password: staffPassword },
      other: { email: 'r3b-other@example.test', password: otherPassword },
      staffId: staff,
      uiJobId, focusJobId, completedJobId, cancelledJobId, blockedParentId, blockedChildId, otherJobId,
    };
  } finally {
    await client.end();
  }
}

async function loginHttp(credentials) {
  const response = await fetch(`${serverOrigin}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: webOrigin },
    body: JSON.stringify(credentials),
  });
  const body = await response.json();
  const rawCookie = response.headers.get('set-cookie');
  const cookie = rawCookie?.split(';', 1)[0];
  if (!response.ok || !cookie) throw new Error(`Login failed: ${response.status} ${JSON.stringify(body)}`);
  return { cookie, user: body.user };
}

async function apiRequest(cookie, path, init = {}) {
  const headers = {
    origin: webOrigin,
    ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    cookie,
    ...(init.headers ?? {}),
  };
  const response = await fetch(`${serverOrigin}${path}`, { ...init, headers });
  let body = null;
  try { body = await response.json(); } catch { /* 204 */ }
  return { status: response.status, body };
}

async function runBackendAcceptance(fixture) {
  const admin = await loginHttp(fixture.admin);
  const manager = await loginHttp(fixture.manager);
  const staff = await loginHttp(fixture.staff);

  record('REAL-FASTIFY-ADMIN-LOGIN', admin.user.role === 'ADMIN', `role=${admin.user.role}`);
  record('REAL-FASTIFY-MANAGER-LOGIN', manager.user.role === 'MANAGER', `role=${manager.user.role}`);
  record('REAL-FASTIFY-STAFF-LOGIN', staff.user.role === 'STAFF', `role=${staff.user.role}`);

  const managerAttempt = await apiRequest(manager.cookie, `/api/job-cards/${fixture.uiJobId}/invalidate`, {
    method: 'POST', body: JSON.stringify({
      clientActionId: 'r3b-manager-forbidden', expectedVersion: 1, reasonCode: 'DUPLICATE', note: null,
    }),
  });
  const staffAttempt = await apiRequest(staff.cookie, `/api/job-cards/${fixture.uiJobId}/invalidate`, {
    method: 'POST', body: JSON.stringify({
      clientActionId: 'r3b-staff-forbidden', expectedVersion: 1, reasonCode: 'DUPLICATE', note: null,
    }),
  });
  record('ROLE-MANAGER-403', managerAttempt.status === 403, `status=${managerAttempt.status}`);
  record('ROLE-STAFF-403', staffAttempt.status === 403, `status=${staffAttempt.status}`);

  const idor = await apiRequest(admin.cookie, `/api/job-cards/${fixture.otherJobId}/invalidate`, {
    method: 'POST', body: JSON.stringify({
      clientActionId: 'r3b-cross-scope', expectedVersion: 1, reasonCode: 'DUPLICATE', note: null,
    }),
  });
  record('CROSS-SCOPE-OPAQUE-404', idor.status === 404 && idor.body?.code === 'JOB_CARD_NOT_FOUND',
    `status=${idor.status}, code=${idor.body?.code}`);

  const versionConflict = await apiRequest(admin.cookie, `/api/job-cards/${fixture.uiJobId}/invalidate`, {
    method: 'POST', body: JSON.stringify({
      clientActionId: 'r3b-version-conflict', expectedVersion: 2, reasonCode: 'DUPLICATE', note: null,
    }),
  });
  record('VERSION-CONFLICT-409', versionConflict.status === 409 && versionConflict.body?.code === 'VERSION_CONFLICT',
    `status=${versionConflict.status}, code=${versionConflict.body?.code}`);

  const blocker = await apiRequest(admin.cookie, `/api/job-cards/${fixture.blockedParentId}/invalidate`, {
    method: 'POST', body: JSON.stringify({
      clientActionId: 'r3b-follow-up-blocker', expectedVersion: 1, reasonCode: 'DUPLICATE', note: null,
    }),
  });
  record('ACTIVE-FOLLOW-UP-BLOCKER-409', blocker.status === 409 && blocker.body?.code === 'JOB_HAS_ACTIVE_FOLLOW_UPS',
    `status=${blocker.status}, code=${blocker.body?.code}`);

  const cancelled = await apiRequest(admin.cookie, `/api/job-cards/${fixture.cancelledJobId}/invalidate`, {
    method: 'POST', body: JSON.stringify({
      clientActionId: 'r3b-direct-cancelled', expectedVersion: 1,
      reasonCode: 'CREATED_BY_MISTAKE', note: null,
    }),
  });
  record('DIRECT-CANCELLED-INVALIDATION', cancelled.status === 200
    && cancelled.body?.status === 'INVALIDATED' && cancelled.body?.version === 2,
  `status=${cancelled.status}, state=${cancelled.body?.status}, version=${cancelled.body?.version}`);

  const conversation = await apiRequest(admin.cookie, '/api/messaging/conversations', {
    method: 'POST', body: JSON.stringify({
      contextType: 'JOB', jobId: fixture.uiJobId, participantUserIds: [fixture.staffId],
    }),
  });
  const conversationId = conversation.body?.id;
  record('MESSAGING-HISTORY-SEED', conversation.status === 201 && typeof conversationId === 'string',
    `status=${conversation.status}`);
  const seedMessage = typeof conversationId === 'string'
    ? await apiRequest(admin.cookie, `/api/messaging/conversations/${conversationId}/messages`, {
      method: 'POST', body: JSON.stringify({
        body: 'R3B historical conversation message', clientActionId: 'r3b-message-seed',
      }),
    })
    : { status: 0, body: null };
  record('MESSAGING-HISTORY-MESSAGE', seedMessage.status === 201, `status=${seedMessage.status}`);

  const directBody = {
    clientActionId: 'r3b-direct-completed', expectedVersion: 1, reasonCode: 'DUPLICATE', note: null,
  };
  const direct = await apiRequest(admin.cookie, `/api/job-cards/${fixture.completedJobId}/invalidate`, {
    method: 'POST', body: JSON.stringify(directBody),
  });
  const replay = await apiRequest(admin.cookie, `/api/job-cards/${fixture.completedJobId}/invalidate`, {
    method: 'POST', body: JSON.stringify(directBody),
  });
  const reused = await apiRequest(admin.cookie, `/api/job-cards/${fixture.completedJobId}/invalidate`, {
    method: 'POST', body: JSON.stringify({ ...directBody, note: 'different semantic request' }),
  });
  record('DIRECT-COMPLETED-INVALIDATION', direct.status === 200 && direct.body?.status === 'INVALIDATED'
    && direct.body?.version === 2, `status=${direct.status}, state=${direct.body?.status}, version=${direct.body?.version}`);
  record('SAME-ID-IDEMPOTENT-REPLAY', replay.status === 200 && replay.body?.version === 2,
    `status=${replay.status}, version=${replay.body?.version}`);
  record('CLIENT-ACTION-REUSED-FAIL-CLOSED', reused.status === 409 && reused.body?.code === 'CLIENT_ACTION_REUSED',
    `status=${reused.status}, code=${reused.body?.code}`);

  const alreadyInvalidated = await apiRequest(admin.cookie, `/api/job-cards/${fixture.completedJobId}/invalidate`, {
    method: 'POST', body: JSON.stringify({
      clientActionId: 'r3b-new-after-invalidation', expectedVersion: 2, reasonCode: 'OTHER', note: 'second attempt',
    }),
  });
  record('ALREADY-INVALIDATED-409', alreadyInvalidated.status === 409
    && alreadyInvalidated.body?.code === 'JOB_ALREADY_INVALIDATED',
  `status=${alreadyInvalidated.status}, code=${alreadyInvalidated.body?.code}`);

  const notes = await apiRequest(admin.cookie, `/api/job-cards/${fixture.completedJobId}/notes?limit=25`);
  const activity = await apiRequest(admin.cookie, `/api/job-cards/${fixture.completedJobId}/activity?limit=50`);
  record('INVALIDATED-HISTORY-READ', notes.status === 200 && activity.status === 200,
    `notes=${notes.status}, activity=${activity.status}`);
  return { adminCookie: admin.cookie, conversationId };
}

async function screenshot(name) {
  const path = `${screenshotDirectory}/${name}`;
  await page.screenshot({ path, fullPage: true });
  screenshots.push(`screenshots/${name}`);
}

async function runBrowserAcceptance(fixture) {
  const chromeCandidate = process.env.R3B_BROWSER_EXECUTABLE
    ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const launchOptions = existsSync(chromeCandidate)
    ? { headless: true, executablePath: chromeCandidate }
    : { headless: true };
  browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    baseURL: webOrigin,
    viewport: { width: 1440, height: 1000 },
  });
  page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(sanitize(error.message)));

  let mutationCount = 0;
  let backendReceipt = null;
  await page.route(`**/api/job-cards/${fixture.uiJobId}/invalidate`, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    mutationCount += 1;
    await delay(500);
    const response = await route.fetch();
    backendReceipt = { status: response.status(), body: await response.json() };
    await route.abort('connectionfailed');
  });

  await page.goto('/login');
  await page.getByLabel('E-posta').fill(fixture.admin.email);
  await page.getByLabel('Parola').fill(fixture.admin.password);
  await page.getByRole('button', { name: 'Giriş yap', exact: true }).click();
  await page.goto(`/jobs/${fixture.uiJobId}`);
  await page.getByRole('heading', { name: 'R3B UI lost-response job', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Geçersiz olarak işaretle', exact: true }).click();
  record('UI-ADMIN-ACTION-VISIBLE', await page.getByRole('combobox', { name: 'Neden' }).count() === 1,
    'Admin Job Detail exposes the inline invalidation form');
  record('UI-FORM-NO-NESTED-DIALOG', await page.getByRole('dialog').count() === 0,
    'Reason capture remains inline before confirmation');

  await page.getByRole('combobox', { name: 'Neden' }).selectOption('OTHER');
  await page.getByRole('textbox', { name: /Açıklama/ }).fill('R3B lost response acceptance note');
  await page.getByRole('button', { name: 'Devam et', exact: true }).click();
  const confirmation = page.getByRole('dialog');
  await confirmation.waitFor();
  record('UI-SINGLE-CONFIRMATION', await page.getByRole('dialog').count() === 1,
    'Only the final confirmation owns role=dialog');
  record('UI-CONFIRMATION-REASON-LABEL', (await confirmation.innerText()).includes('Diğer'),
    'Confirmation shows the user-facing reason label');
  record('UI-CONFIRMATION-INITIAL-FOCUS', await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '') === 'Vazgeç',
    'Confirmation restores its documented initial focus');
  await screenshot('01-r3b-confirmation-desktop.png');

  await confirmation.getByRole('button', { name: 'Geçersiz olarak işaretle', exact: true }).click();
  const pendingDialog = page.locator('[role="dialog"][aria-busy="true"]');
  await pendingDialog.waitFor();
  const pendingButtons = pendingDialog.getByRole('button');
  record('UI-PENDING-DIALOG-LOCK', await pendingButtons.nth(0).isDisabled() && await pendingButtons.nth(1).isDisabled(),
    'Confirmation controls stay disabled while the request is pending');
  record('UI-NAVIGATION-REMAINS-AVAILABLE', await page.getByRole('button', { name: 'Listeye dön', exact: true }).isDisabled() === false,
    'Navigation remains available during the JobCard-local mutation');
  await screenshot('02-r3b-pending-desktop.png');

  await page.getByText('İşlem sonucu doğrulanamadı.', { exact: true }).waitFor();
  record('UI-AMBIGUOUS-RECOVERY-CTA', await page.getByRole('button', {
    name: 'Durumu yeniden kontrol et', exact: true,
  }).count() === 1, 'Lost response exposes status recheck as the first recovery CTA');
  record('UI-NO-AUTOMATIC-POST-RETRY', mutationCount === 1, `Observed POST count=${mutationCount}`);
  await screenshot('03-r3b-ambiguous-recovery-desktop.png');

  await page.getByRole('button', { name: 'Durumu yeniden kontrol et', exact: true }).click();
  await page.locator('[data-terminal-state="INVALIDATED"]').waitFor();
  await page.getByText('Kayıt zaten geçersiz durumda.', { exact: true }).waitFor();
  const recoveredText = await page.locator('body').innerText();
  record('UI-LOST-RESPONSE-GET-RECOVERY', backendReceipt?.status === 200
    && backendReceipt?.body?.status === 'INVALIDATED'
    && backendReceipt?.body?.version === 2,
  `backend=${backendReceipt?.status ?? 'missing'}, status=${backendReceipt?.body?.status ?? 'missing'}`);
  record('UI-ALREADY-INVALIDATED-NO-CELEBRATION', !recoveredText.includes('İş kaydı geçersiz kılındı.'),
    'Already-invalidated recovery does not attribute the current attempt as a success');
  record('UI-INVALIDATION-REASON-LABEL', recoveredText.includes('Diğer') && !recoveredText.includes('OTHER'),
    'Terminal history uses the Turkish reason label');
  record('UI-INVALIDATION-NOTE-HISTORY', recoveredText.includes('R3B lost response acceptance note'),
    'OTHER note is visible in read-only Notes history');
  record('UI-NOTES-READ-ONLY', await page.locator('#job-note').count() === 0
    && await page.getByRole('button', { name: 'Not ekle', exact: true }).count() === 0,
  'Historical notes remain visible without a writable note composer');
  record('UI-TIMELINE-PRESERVED', recoveredText.includes('İş geçersiz kılındı'),
    'The invalidation activity remains in the read-only timeline');
  record('UI-INVALIDATION-ACTION-REMOVED', await page.getByRole('button', {
    name: 'Geçersiz olarak işaretle', exact: true,
  }).count() === 0, 'Terminal JobCard has no destructive action');
  await screenshot('04-r3b-recovered-invalidated-desktop.png');

  await page.goto('/jobs?status=INVALIDATED&view=board');
  await page.getByText('R3B UI lost-response job', { exact: true }).waitFor();
  record('UI-EXPLICIT-INVALIDATED-FILTER-LIST', new URL(page.url()).searchParams.get('status') === 'INVALIDATED'
    && new URL(page.url()).searchParams.get('view') === null
    && await page.locator('[data-job-board]').count() === 0,
  'Explicit Geçersiz filter forces list mode while Tümü remains separate');

  await page.goto(`/jobs/${fixture.focusJobId}`);
  await page.getByRole('heading', { name: 'R3B responsive focus job', exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  record('UI-390PX-REFLOW', mobile.scrollWidth <= mobile.clientWidth,
    `scrollWidth=${mobile.scrollWidth}, clientWidth=${mobile.clientWidth}`);
  for (let index = 0; index < 3; index += 1) await page.keyboard.press('Meta+Equal');
  const zoomed = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  record('UI-200-400PCT-REFLOW', zoomed.scrollWidth <= zoomed.clientWidth,
    `scrollWidth=${zoomed.scrollWidth}, clientWidth=${zoomed.clientWidth}`);
  await screenshot('05-r3b-responsive-mobile.png');
  record('BROWSER-NO-PAGE-ERRORS', pageErrors.length === 0,
    pageErrors.length === 0 ? 'No uncaught page errors' : pageErrors.join(' | '));
}

async function verifyMessagingAcceptance(backend) {
  if (typeof backend.conversationId !== 'string') {
    record('MESSAGING-HISTORY-PRESERVED', false, 'Conversation fixture was not created');
    return;
  }
  const history = await apiRequest(
    backend.adminCookie,
    `/api/messaging/conversations/${backend.conversationId}/messages?limit=50`,
  );
  record('MESSAGING-HISTORY-PRESERVED', history.status === 200
    && history.body?.items?.some((item) => item.body === 'R3B historical conversation message'),
  `status=${history.status}`);
  const send = await apiRequest(
    backend.adminCookie,
    `/api/messaging/conversations/${backend.conversationId}/messages`,
    {
      method: 'POST', body: JSON.stringify({
        body: 'R3B message must be rejected after invalidation', clientActionId: 'r3b-message-after-invalidation',
      }),
    },
  );
  record('MESSAGING-SEND-BLOCKED', send.status === 403,
    `status=${send.status}, code=${send.body?.code}`);
}

async function verifyDatabase(fixture) {
  const client = new Client({ connectionString: disposableDatabaseUrl });
  await client.connect();
  try {
    const rows = await client.query(
      `SELECT
         (SELECT status FROM job_cards WHERE id = $1) AS ui_status,
         (SELECT invalidation_reason_code FROM job_cards WHERE id = $1) AS ui_reason,
         (SELECT COUNT(*)::int FROM job_card_activity_logs WHERE job_card_id = $1 AND event_type = 'JOB_INVALIDATED') AS ui_invalidations,
         (SELECT COUNT(*)::int FROM job_card_notes WHERE job_card_id = $1 AND context = 'INVALIDATE') AS ui_notes,
         (SELECT status FROM job_cards WHERE id = $2) AS blocked_parent_status,
         (SELECT status FROM job_cards WHERE id = $3) AS blocked_child_status,
         (SELECT status FROM job_cards WHERE id = $4) AS completed_status,
         (SELECT COUNT(*)::int FROM processed_actions WHERE client_action_id = 'r3b-direct-completed' AND status = 'completed') AS direct_action_rows`,
      [fixture.uiJobId, fixture.blockedParentId, fixture.blockedChildId, fixture.completedJobId],
    );
    const row = rows.rows[0];
    record('POSTGRES-UI-PERSISTED-INVALIDATION', row.ui_status === 'INVALIDATED'
      && row.ui_reason === 'OTHER' && row.ui_invalidations === 1 && row.ui_notes === 1,
    `status=${row.ui_status}, reason=${row.ui_reason}, activity=${row.ui_invalidations}, notes=${row.ui_notes}`);
    record('POSTGRES-NO-FOLLOW-UP-CASCADE', row.blocked_parent_status === 'COMPLETED'
      && row.blocked_child_status === 'NEW',
    `parent=${row.blocked_parent_status}, child=${row.blocked_child_status}`);
    record('POSTGRES-IDEMPOTENCY-SINGLE-RECEIPT', row.completed_status === 'INVALIDATED'
      && row.direct_action_rows === 1,
    `completedJob=${row.completed_status}, actionRows=${row.direct_action_rows}`);
  } finally {
    await client.end();
  }
}

async function writeEvidence() {
  mkdirSync(evidenceDirectory, { recursive: true });
  const payload = {
    gate: 'R3B_JOBCARD_INVALIDATION_ADMIN_UI_REAL_RUNTIME_ACCEPTANCE',
    executedAt: new Date().toISOString(),
    featureHead: (await import('node:child_process')).execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repositoryDirectory, encoding: 'utf8',
    }).trim(),
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
  await ensureServerEnvironmentFile();
  const runtimeEnvironment = environment();
  await runCommand('npm', ['run', 'build'], { cwd: serverDirectory, env: runtimeEnvironment });
  await runCommand('npm', ['run', 'migrate'], { cwd: serverDirectory, env: runtimeEnvironment });
  record('POSTGRES-MIGRATIONS-001-036', true, 'All repository migrations completed on the disposable database');
  const fixture = await seedFixture();
  serverProcess = startProcess('fastify', 'npm', ['run', 'start:prod'], {
    cwd: serverDirectory, env: runtimeEnvironment,
  });
  await waitForHttp(`${serverOrigin}/api/health`, serverProcess);
  viteProcess = startProcess('vite', 'npm', [
    'run', 'dev', '--', '--host', '127.0.0.1', '--port', '5173', '--strictPort',
  ], { cwd: webDirectory, env: { ...process.env } });
  await waitForHttp(webOrigin, viteProcess);
  const backendAcceptance = await runBackendAcceptance(fixture);
  await runBrowserAcceptance(fixture);
  await verifyMessagingAcceptance(backendAcceptance);
  await verifyDatabase(fixture);
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
  try {
    await stopIsolatedPostgres();
  } catch (cleanupError) {
    failure ??= cleanupError;
  }
  await writeEvidence();
}

if (failure) throw failure;
console.info(`R3B runtime acceptance passed (${results.length} assertions).`);
