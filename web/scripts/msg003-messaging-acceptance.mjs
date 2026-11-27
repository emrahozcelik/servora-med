import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { chromium } from 'playwright';

const webDirectory = fileURLToPath(new URL('../', import.meta.url));
const repositoryDirectory = fileURLToPath(new URL('../../', import.meta.url));
const serverDirectory = fileURLToPath(new URL('../../server/', import.meta.url));
const evidenceDirectory = fileURLToPath(new URL('../../docs/evidence/msg003-messaging-module/', import.meta.url));
const screenshotDirectory = `${evidenceDirectory}/screenshots`;
const fleetEvidenceDirectory = process.env.FLEET_EVIDENCE_DIR?.trim() ?? '';
// Raw process logs stay out of the repository: FLEET_EVIDENCE_DIR when the runner sets it, else an OS temp dir.
const logDirectory = fleetEvidenceDirectory || mkdtempSync(`${tmpdir()}/servora-msg003-acceptance-logs-`);
const serverRequire = createRequire(new URL('../../server/package.json', import.meta.url));
const { Client } = serverRequire('pg');

const serverOrigin = 'http://127.0.0.1:3000';
const webOrigin = 'http://127.0.0.1:5173';
const IDENTITY_REVALIDATION_WINDOW_MS = 30_500;
const postgresBinCandidates = [
  process.env.MSG003_POSTGRES_BIN,
  '/opt/homebrew/opt/postgresql@17/bin',
  '/opt/homebrew/opt/postgresql@16/bin',
  '/opt/homebrew/opt/postgresql@18/bin',
  '/opt/homebrew/opt/postgresql/bin',
  '/Applications/Postgres.app/Contents/Versions/latest/bin',
].filter(Boolean);
const postgresBin = postgresBinCandidates.find((candidate) => (
  existsSync(`${candidate}/initdb`) && existsSync(`${candidate}/pg_ctl`)
));

if (!postgresBin) throw new Error('An isolated PostgreSQL initdb/pg_ctl installation is required');

mkdirSync(screenshotDirectory, { recursive: true });
mkdirSync(logDirectory, { recursive: true });

const results = [];
const screenshots = [];
const runLog = [];
const scenarioPrefixes = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'];
const scenarioTitles = {
  A1: 'Fresh-database takeover with MESSAGING_ENABLED=true; operator Modules page shows Mesajlaşma Açık with the takeover source',
  A2: 'Two off/on operator cycles with an open MANAGER session: nav, /messages, Job Detail action, Overview summary and notification visibility',
  A3: 'Messaging API while disabled: authenticated 404 NOT_FOUND and unauthenticated 401',
  A4: 'Push queue while disabled (WEB_PUSH stays disabled; DB only)',
  A5: 'Pending assignee sync: reassignment while off, later notice and explicit participant sync, unread 0 for the new assignee',
  A6: 'Offboarding a STAFF assignee while messaging is off transfers the job conversation; replacement opens it with unread 0',
};
const limits = [
  'No staging environment exists and deployment is not authorized (docs/operations/staging-contract.md). Acceptance ran locally against the real Fastify server, a disposable PostgreSQL 17 cluster, real Vite and Playwright Chromium with synthetic data only.',
  'A4 was not run: WEB_PUSH_ENABLED=false means no web-push dispatcher is constructed (server/src/app.ts), so there is no dispatcher tick to observe. No push delivery rows were fabricated.',
  'No Web Push device or service worker subscription is exercised; the push queue, VAPID delivery and service-worker click routing are outside this run.',
  'No backup/restore cycle is included here; restore-*.json/md in this folder belong to a separate author.',
  'Realtime SSE fan-out, multi-tab concurrency, version-conflict races and cross-organization isolation are not covered by this acceptance run (covered by server suites where applicable).',
  'Screenshots use Chromium at 1440 and 390 CSS pixels; other browsers and real mobile devices are not covered.',
];

let serverProcess;
let viteProcess;
let browser;
let operatorContext;
let operatorPage;
let managerContext;
let managerPage;
let managerOverviewPage;
let managerJobPage;
let adminContext;
let adminPage;
let postgresClusterDirectory = '';
let postgresStarted = false;
let disposableDatabaseName = '';
let disposableDatabaseUrl = '';
let adminDatabaseUrl = '';
let databaseCreated = false;
let serverEnvironmentFileCreated = false;
let failure = null;
let lastManagerIdentityRequestAt = 0;

function sanitize(value) {
  return String(value)
    .replaceAll(/postgres(?:ql)?:\/\/[^@\s]+@/gi, 'postgresql://***@')
    .slice(0, 4_000);
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${sanitize(message)}`;
  runLog.push(line);
  console.info(line);
}

function record(id, passed, observed) {
  results.push({
    id,
    status: passed ? 'PASS' : 'FAIL',
    observed: sanitize(observed ?? (passed ? 'ok' : 'not observed')),
    at: new Date().toISOString(),
  });
  log(`${id}: ${passed ? 'PASS' : 'FAIL'} — ${sanitize(observed ?? '')}`);
}

function recordNotRun(id, reason) {
  results.push({ id, status: 'NOT_RUN', observed: sanitize(reason), at: new Date().toISOString() });
  log(`${id}: NOT_RUN — ${sanitize(reason)}`);
}

async function check(id, run) {
  try {
    const observed = await run();
    record(id, true, observed === undefined ? 'ok' : observed);
    return true;
  } catch (error) {
    record(id, false, error instanceof Error ? error.message : String(error));
    return false;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForLocatorCount(locator, expected, timeoutMilliseconds = 12_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMilliseconds) {
    if (await locator.count() === expected) return true;
    await delay(100);
  }
  return false;
}

async function waitForAttribute(locator, name, expected, timeoutMilliseconds = 12_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMilliseconds) {
    if (await locator.getAttribute(name) === expected) return true;
    await delay(100);
  }
  return false;
}

async function waitForText(page, text, timeoutMilliseconds = 12_000) {
  try {
    await page.getByText(text, { exact: true }).first().waitFor({ timeout: timeoutMilliseconds });
    return true;
  } catch {
    return false;
  }
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
    OVERVIEW_DASHBOARD_ENABLED: 'true',
    CALENDAR_ENABLED: 'false',
    MESSAGING_ENABLED: 'true',
    WEB_PUSH_ENABLED: 'false',
    ACTION_SCOPED_GEOLOCATION_ENABLED: 'false',
    ...overrides,
  };
}

async function runCommand(label, command, args, options = {}) {
  log(`run: ${command} ${args.join(' ')} (${label})`);
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: 'inherit',
  });
  const [code, signal] = await once(child, 'exit');
  if (code !== 0) throw new Error(`${label}: ${command} ${args.join(' ')} exited with ${code ?? signal}`);
}

async function runCommandWithInput(label, command, args, input, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.stdin.end(input);
  const [code, signal] = await once(child, 'exit');
  if (code !== 0) {
    throw new Error(`${label} exited with ${code ?? signal}: ${sanitize(stderr || stdout).slice(0, 800)}`);
  }
  return sanitize(stdout).trim();
}

function startProcess(label, command, args, options = {}) {
  const logPath = `${logDirectory}/${label}.log`;
  const stream = createWriteStream(logPath, { flags: 'a' });
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const write = (streamName, chunk) => {
    const text = sanitize(chunk.toString());
    process[streamName].write(`[${label}] ${text}`);
    stream.write(text);
  };
  child.stdout.on('data', (chunk) => write('stdout', chunk));
  child.stderr.on('data', (chunk) => write('stderr', chunk));
  child.on('exit', (code, signal) => {
    stream.write(`\n[${label}] exited code=${code} signal=${signal}\n`);
    stream.end();
  });
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

async function waitForHttp(url, child, timeoutMilliseconds = 45_000) {
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
  postgresClusterDirectory = mkdtempSync('/private/tmp/servora-msg003-postgres-');
  const port = await reserveLoopbackPort();
  await runCommand('postgres-initdb', `${postgresBin}/initdb`, [
    '-D', postgresClusterDirectory, '--auth=trust', '--username=servora_msg003',
    '--encoding=UTF8', '--no-locale',
  ], { cwd: repositoryDirectory, env: { ...process.env, LC_ALL: 'C' } });
  await runCommand('postgres-start', `${postgresBin}/pg_ctl`, [
    '-D', postgresClusterDirectory, '-l', `${postgresClusterDirectory}/postgres.log`,
    '-o', `-h 127.0.0.1 -p ${port} -F`, 'start', '-w',
  ], { cwd: repositoryDirectory, env: { ...process.env, LC_ALL: 'C' } });
  postgresStarted = true;
  adminDatabaseUrl = `postgresql://servora_msg003@127.0.0.1:${port}/postgres`;
  record('ENV-POSTGRES-ISOLATED-CLUSTER', true, `Disposable PostgreSQL cluster started on a random loopback port under /private/tmp`);
}

async function stopIsolatedPostgres() {
  if (postgresStarted) {
    await runCommand('postgres-stop', `${postgresBin}/pg_ctl`, [
      '-D', postgresClusterDirectory, 'stop', '-m', 'fast', '-w',
    ], { cwd: repositoryDirectory });
    postgresStarted = false;
  }
  if (!postgresClusterDirectory) return;
  if (!postgresClusterDirectory.startsWith('/private/tmp/servora-msg003-postgres-')) {
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
  disposableDatabaseName = `servora_msg003_${randomBytes(6).toString('hex')}`;
  const admin = new Client({ connectionString: adminDatabaseUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${disposableDatabaseName}"`);
  } finally {
    await admin.end();
  }
  disposableDatabaseUrl = databaseUrlFor(disposableDatabaseName);
  databaseCreated = true;
  record('ENV-POSTGRES-DISPOSABLE-CREATED', true, 'Dedicated disposable database created');
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

async function withDatabase(run) {
  const client = new Client({ connectionString: disposableDatabaseUrl });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

async function seedFixture() {
  const admin = {
    email: 'msg003-admin@example.test',
    password: `MSG003-Admin-${randomBytes(18).toString('base64url')}!`,
  };
  await runCommand('bootstrap-admin', 'npm', ['run', 'bootstrap:admin'], {
    cwd: serverDirectory,
    env: environment({
      BOOTSTRAP_ORGANIZATION_NAME: 'MSG-003 Messaging Acceptance',
      BOOTSTRAP_ADMIN_NAME: 'MSG-003 Yönetici',
      BOOTSTRAP_ADMIN_EMAIL: admin.email,
      BOOTSTRAP_ADMIN_PASSWORD: admin.password,
    }),
  });
  const { hashPassword } = await import(pathToFileURL(`${serverDirectory}/dist/modules/auth/crypto.js`).href);
  const manager = {
    email: 'msg003-manager@example.test',
    password: `MSG003-Manager-${randomBytes(12).toString('base64url')}!`,
  };
  const staffA = {
    email: 'msg003-staff-a@example.test',
    password: `MSG003-StaffA-${randomBytes(12).toString('base64url')}!`,
  };
  const staffB = {
    email: 'msg003-staff-b@example.test',
    password: `MSG003-StaffB-${randomBytes(12).toString('base64url')}!`,
  };
  const staffC = {
    email: 'msg003-staff-c@example.test',
    password: `MSG003-StaffC-${randomBytes(12).toString('base64url')}!`,
  };
  const [managerHash, staffAHash, staffBHash, staffCHash] = await Promise.all([
    hashPassword(manager.password),
    hashPassword(staffA.password),
    hashPassword(staffB.password),
    hashPassword(staffC.password),
  ]);
  const client = new Client({ connectionString: disposableDatabaseUrl });
  await client.connect();
  try {
    const adminRow = (await client.query(
      'SELECT id, organization_id FROM users WHERE lower(email) = lower($1)',
      [admin.email],
    )).rows[0];
    if (!adminRow) throw new Error('Bootstrap Admin was not created');
    const organizationId = adminRow.organization_id;

    async function insertUser(role, name, email, passwordHash) {
      const user = (await client.query(
        `INSERT INTO users (organization_id, name, email, password_hash, role)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [organizationId, name, email, passwordHash, role],
      )).rows[0];
      if (role === 'STAFF') {
        await client.query(
          `INSERT INTO staff_profiles (organization_id, user_id, title)
           VALUES ($1, $2, 'Saha uzmanı')`,
          [organizationId, user.id],
        );
      }
      return user.id;
    }

    const managerId = await insertUser('MANAGER', 'MSG-003 Yönetici', manager.email, managerHash);
    const staffAId = await insertUser('STAFF', 'MSG-003 Personel A', staffA.email, staffAHash);
    const staffBId = await insertUser('STAFF', 'MSG-003 Personel B', staffB.email, staffBHash);
    const staffCId = await insertUser('STAFF', 'MSG-003 Personel C', staffC.email, staffCHash);

    const customer = (await client.query(
      `INSERT INTO customers (organization_id, name, customer_type, status, assigned_staff_user_id)
       VALUES ($1, 'MSG-003 Mavi Klinik', 'clinic', 'active', $2) RETURNING id`,
      [organizationId, managerId],
    )).rows[0];
    const job = (await client.query(
      `INSERT INTO job_cards (
         organization_id, type, status, title, customer_id, assigned_to, created_by, priority
       ) VALUES ($1, 'GENERAL_TASK', 'NEW', 'MSG-003 Mesajlaşma kabul işi', $2, $3, $4, 'normal')
       RETURNING id`,
      [organizationId, customer.id, staffAId, adminRow.id],
    )).rows[0];

    return {
      organizationId,
      admin: { ...admin, id: adminRow.id },
      manager: { ...manager, id: managerId, name: 'MSG-003 Yönetici' },
      staffA: { ...staffA, id: staffAId, name: 'MSG-003 Personel A' },
      staffB: { ...staffB, id: staffBId, name: 'MSG-003 Personel B' },
      staffC: { ...staffC, id: staffCId, name: 'MSG-003 Personel C' },
      ids: { customer: customer.id, job: job.id },
    };
  } finally {
    await client.end();
  }
}

async function loginHttp(credentials) {
  const response = await fetch(`${serverOrigin}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: webOrigin },
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
      origin: webOrigin,
      ...(cookie ? { cookie } : {}),
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init.headers ?? {}),
    },
  });
  let body = null;
  try { body = await response.json(); } catch { /* no body */ }
  return { status: response.status, body };
}

async function screenshot(page, screen, width, options = {}) {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1_000 });
  await delay(300);
  const name = `${screen}-${width}.png`;
  await page.screenshot({ path: `${screenshotDirectory}/${name}`, fullPage: options.fullPage !== false });
  screenshots.push(`screenshots/${name}`);
}

async function screenshotBoth(page, screen, options = {}) {
  await screenshot(page, screen, 1440, options);
  await screenshot(page, screen, 390, options);
  await page.setViewportSize({ width: 1_440, height: 1_000 });
}

async function loginCustomer(context, credentials) {
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByLabel('E-posta', { exact: true }).fill(credentials.email);
  await page.getByLabel('Parola', { exact: true }).fill(credentials.password);
  await page.getByRole('button', { name: 'Giriş yap', exact: true }).click();
  await page.waitForURL((url) => !url.pathname.endsWith('/login'), { timeout: 20_000 });
  await page.getByRole('navigation', { name: 'Ana navigasyon' }).waitFor({ timeout: 20_000 });
  return page;
}

async function loginOperator(page, credentials) {
  await page.goto('/operator/modules');
  await page.getByLabel('E-posta', { exact: true }).fill(credentials.email);
  await page.getByLabel('Parola', { exact: true }).fill(credentials.password);
  await page.getByRole('button', { name: 'Giriş yap', exact: true }).click();
  await page.getByRole('heading', { name: 'Modüller', exact: true }).waitFor({ timeout: 20_000 });
}

function messagingModuleRow() {
  return operatorPage.locator('.operator-module-row').filter({ hasText: 'Mesajlaşma' }).first();
}

async function messagingSwitchState() {
  const row = messagingModuleRow();
  const value = await row.getByRole('switch').getAttribute('aria-checked');
  return value === 'true';
}

async function setMessagingEnabled(enabled, options = {}) {
  await operatorPage.goto('/operator/modules');
  const row = messagingModuleRow();
  await row.waitFor({ timeout: 20_000 });
  const current = await messagingSwitchState();
  if (current === enabled) return { changed: false, dialogText: '' };
  await row.getByRole('switch').click();
  const dialog = operatorPage.getByRole('dialog');
  await dialog.waitFor({ timeout: 10_000 });
  const dialogText = await dialog.innerText();
  if (options.captureDialog) await screenshot(operatorPage, options.captureDialog, 1440);
  await dialog.getByRole('button', { name: enabled ? 'Modülü aç' : 'Modülü kapat' }).click();
  await operatorPage.getByText(
    enabled ? 'Mesajlaşma modülü açıldı.' : 'Mesajlaşma modülü kapatıldı.',
    { exact: true },
  ).waitFor({ timeout: 20_000 });
  const settled = await waitForAttribute(row.getByRole('switch'), 'aria-checked', String(enabled));
  if (!settled) throw new Error(`The Mesajlaşma switch did not settle at ${enabled}`);
  if (options.captureAfter) await screenshot(operatorPage, options.captureAfter, 1440);
  return { changed: true, dialogText };
}

async function assertDisableDialogCopy(prefix, dialogText) {
  const required = [
    'Kapanacaklar:',
    'Mesajlar menüsü ve sayfası',
    'Mesajlaşma API erişimi',
    'İş detayından mesajlaşma',
    'Mesaj bildirimleri ve mesaj Web Push teslimatı',
    'Okunmamış mesaj sayacı',
  ];
  await check(`${prefix}-DIALOG-TURNS-OFF`, () => {
    const missing = required.filter((entry) => !dialogText.includes(entry));
    if (missing.length > 0) throw new Error(`Eksik: ${missing.join(' | ')}`);
    return 'Kapanacaklar listesi tam';
  });
  const preserved = [
    'Korunanlar:',
    'Konuşmalar ve mesaj geçmişi',
    'Arşiv ve audit kayıtları',
    'Personel devir ve offboarding işlemleri',
  ];
  await check(`${prefix}-DIALOG-PRESERVED`, () => {
    const missing = preserved.filter((entry) => !dialogText.includes(entry));
    if (missing.length > 0) throw new Error(`Eksik: ${missing.join(' | ')}`);
    return 'Korunanlar listesi tam';
  });
  await check(`${prefix}-DIALOG-NO-DELETE`, () => {
    if (!dialogText.includes('Veriler silinmez.')) throw new Error('Veriler silinmez. metni yok');
    return 'Veriler silinmez. görünür';
  });
}

async function assertEnableDialogCopy(prefix, dialogText) {
  await check(`${prefix}-DIALOG-TURNS-ON`, () => {
    const missing = ['Açılacaklar:', 'Mesajlar menüsü ve sayfası', 'Mesajlaşma API erişimi',
      'İş detayından mesajlaşma', 'Mesaj bildirimleri ve mesaj Web Push teslimatı',
      'Okunmamış mesaj sayacı'].filter((entry) => !dialogText.includes(entry));
    if (missing.length > 0) throw new Error(`Eksik: ${missing.join(' | ')}`);
    return 'Açılacaklar listesi tam';
  });
  await check(`${prefix}-DIALOG-PRESERVED`, () => {
    const missing = ['Korunanlar:', 'Konuşmalar ve mesaj geçmişi', 'Arşiv ve audit kayıtları',
      'Personel devir ve offboarding işlemleri'].filter((entry) => !dialogText.includes(entry));
    if (missing.length > 0) throw new Error(`Eksik: ${missing.join(' | ')}`);
    return 'Korunanlar listesi tam';
  });
  await check(`${prefix}-DIALOG-NO-DELETE`, () => {
    if (!dialogText.includes('Veriler silinmez.')) throw new Error('Veriler silinmez. metni yok');
    return 'Veriler silinmez. görünür';
  });
}

async function waitForIdentityWindow() {
  const elapsed = Date.now() - lastManagerIdentityRequestAt;
  if (elapsed < IDENTITY_REVALIDATION_WINDOW_MS) {
    log(`waiting ${IDENTITY_REVALIDATION_WINDOW_MS - elapsed}ms for the identity revalidation window`);
    await delay(IDENTITY_REVALIDATION_WINDOW_MS - elapsed);
  }
}

async function triggerFocusRevalidation(page) {
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

async function openNotificationCenter(page) {
  const trigger = page.getByRole('button', { name: 'Bildirimler', exact: true }).first();
  await trigger.click();
  const panel = page.locator('.notification-center-panel');
  await panel.waitFor({ timeout: 10_000 });
  return panel;
}

async function closeNotificationCenter(page) {
  const close = page.getByRole('button', { name: 'Bildirimleri kapat', exact: true }).first();
  await close.click();
}

async function openMobileMenu(page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Menü', exact: true }).click();
  await page.locator('.shell-drawer').waitFor({ timeout: 10_000 });
}

async function closeMobileMenu(page) {
  await page.getByRole('button', { name: 'Menüyü kapat', exact: true }).first().click();
  await page.locator('.shell-drawer').waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});
  await page.setViewportSize({ width: 1_440, height: 1_000 });
}

function scenarioStatus(prefix) {
  const entries = results.filter((entry) => entry.id === prefix || entry.id.startsWith(`${prefix}-`));
  if (entries.length === 0) return 'NOT_RUN';
  if (entries.some((entry) => entry.status === 'FAIL')) return 'FAIL';
  if (entries.every((entry) => entry.status === 'NOT_RUN')) return 'NOT_RUN';
  return 'PASS';
}

function scenarioSummary() {
  return scenarioPrefixes.map((prefix) => ({
    scenario: prefix,
    title: scenarioTitles[prefix],
    status: scenarioStatus(prefix),
    records: results.filter((entry) => entry.id === prefix || entry.id.startsWith(`${prefix}-`)).map((entry) => ({
      id: entry.id,
      status: entry.status,
      observed: entry.observed,
    })),
  }));
}

async function runScenario(prefix, run) {
  log(`scenario ${prefix} start`);
  try {
    await run();
  } catch (error) {
    record(`${prefix}-EXCEPTION`, false, error instanceof Error ? error.message : String(error));
  }
  log(`scenario ${prefix} end`);
}

async function readModuleRow() {
  return withDatabase(async (client) => (await client.query(
    `SELECT module_key, enabled, version, source
       FROM installation_module_state
      WHERE module_key = 'MESSAGING'`,
  )).rows[0] ?? null);
}

async function getParticipantRows(conversationId) {
  return withDatabase(async (client) => (await client.query(
    `SELECT user_id, last_read_message_id
       FROM conversation_participants
      WHERE conversation_id = $1
      ORDER BY user_id`,
    [conversationId],
  )).rows);
}

async function latestMessageId(conversationId) {
  return withDatabase(async (client) => (await client.query(
    `SELECT id FROM messages
      WHERE conversation_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [conversationId],
  )).rows[0]?.id ?? null);
}

try {
  await startIsolatedPostgres();
  await createDisposableDatabase();
  ensureServerEnvironmentFile();
  const runtimeEnvironment = environment();
  await runCommand('server-build', 'npm', ['run', 'build'], { cwd: serverDirectory, env: runtimeEnvironment });
  record('ENV-SERVER-BUILD', true, 'TypeScript server build completed');
  await runCommand('server-migrate', 'npm', ['run', 'migrate'], { cwd: serverDirectory, env: runtimeEnvironment });
  record('ENV-SERVER-MIGRATIONS', true, 'All repository migrations completed on the disposable PostgreSQL 17 database');

  const fixture = await seedFixture();
  record('ENV-SYNTHETIC-FIXTURE', true,
    'Bootstrap Admin plus synthetic MANAGER, STAFF A/B/C, one customer and one GENERAL_TASK job created');

  const operator = {
    email: 'msg003-operator@example.test',
    password: `MSG003-Operator-${randomBytes(18).toString('base64url')}!`,
  };
  const grantOutput = await runCommandWithInput(
    'operator-grant',
    'node',
    ['dist/db/operator-cli-main.js', 'grant', '--email', operator.email, '--name', 'MSG-003 Operatör', '--password-stdin'],
    `${operator.password}\n`,
    { cwd: serverDirectory, env: environment() },
  );
  record('ENV-OPERATOR-GRANTED', grantOutput.includes(operator.email), grantOutput || 'Operator grant completed');

  serverProcess = startProcess('fastify', 'node', ['dist/index.js'], {
    cwd: serverDirectory,
    env: runtimeEnvironment,
  });
  await waitForHttp(`${serverOrigin}/api/health`, serverProcess);
  record('ENV-REAL-FASTIFY-READY', true, 'Real built Fastify server answered /api/health');

  viteProcess = startProcess('vite', 'npm', [
    'run', 'dev', '--', '--host', '127.0.0.1', '--port', '5173', '--strictPort',
  ], { cwd: webDirectory, env: { ...process.env } });
  await waitForHttp(webOrigin, viteProcess);
  record('ENV-REAL-VITE-READY', true, 'Real Vite dev server answered on the web origin');

  browser = await chromium.launch(
    existsSync(process.env.MSG003_BROWSER_EXECUTABLE ?? '')
      ? { headless: true, executablePath: process.env.MSG003_BROWSER_EXECUTABLE }
      : existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
        ? { headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }
        : { headless: true },
  );
  record('ENV-PLAYWRIGHT-CHROMIUM', true, 'Playwright Chromium launched');

  operatorContext = await browser.newContext({ baseURL: webOrigin, viewport: { width: 1_440, height: 1_000 } });
  operatorPage = await operatorContext.newPage();
  await loginOperator(operatorPage, operator);

  await runScenario('A1', async () => {
    await operatorPage.goto('/operator/modules');
    const row = messagingModuleRow();
    await row.waitFor({ timeout: 20_000 });
    await check('A1-MODULE-VISIBLE', async () => {
      if (!(await row.getByRole('heading', { name: 'Mesajlaşma', exact: true }).isVisible())) {
        throw new Error('Mesajlaşma başlığı görünür değil');
      }
      return 'Mesajlaşma modül satırı görünür';
    });
    await check('A1-MODULE-ENABLED', async () => {
      const state = (await row.locator('.operator-switch-state').innerText()).trim();
      if (state !== 'Açık') throw new Error(`Görünen durum=${state}`);
      return `Görünen durum=${state}`;
    });
    await check('A1-TAKEOVER-SOURCE', async () => {
      const meta = (await row.locator('.operator-module-meta').innerText()).trim();
      if (!meta.includes('kurulum ayarından devralındı')) throw new Error(meta);
      return meta;
    });
    await check('A1-DESCRIPTION-VISIBLE', async () => {
      const description = (await row.locator('.operator-module-description').innerText()).trim();
      if (!description) throw new Error('Açıklama boş');
      return description;
    });
    await check('A1-SWITCH-CHECKED', async () => {
      const checked = await row.getByRole('switch').getAttribute('aria-checked');
      if (checked !== 'true') throw new Error(`aria-checked=${checked}`);
      return 'aria-checked=true';
    });
    await screenshotBoth(operatorPage, 'a1-operator-modules');
    await operatorPage.setViewportSize({ width: 1_440, height: 1_000 });
    await check('A1-DB-ENV-TAKEOVER', async () => {
      const rowData = await readModuleRow();
      if (!rowData) throw new Error('MESSAGING state row missing');
      if (rowData.enabled !== true || rowData.source !== 'ENV_TAKEOVER') {
        throw new Error(JSON.stringify(rowData));
      }
      return JSON.stringify(rowData);
    });
    await check('A1-DB-TAKEOVER-AUDIT', async () => withDatabase(async (client) => {
      const event = (await client.query(
        `SELECT event_type, new_value
           FROM operator_audit_events
          WHERE module_key = 'MESSAGING'
          ORDER BY occurred_at ASC
          LIMIT 1`,
      )).rows[0];
      if (!event || event.event_type !== 'MODULE_STATE_TAKEN_OVER' || event.new_value?.enabled !== true) {
        throw new Error(JSON.stringify(event ?? null));
      }
      return `${event.event_type} enabled=${event.new_value.enabled}`;
    }));
  });

  const manager = await loginHttp(fixture.manager);
  const staffA = await loginHttp(fixture.staffA);
  const createdConversation = await apiRequest(manager.cookie, '/api/messaging/conversations', {
    method: 'POST',
    body: JSON.stringify({
      contextType: 'JOB',
      jobId: fixture.ids.job,
      participantUserIds: [fixture.staffA.id],
    }),
  });
  if (createdConversation.status !== 201 && createdConversation.status !== 200) {
    throw new Error(`Conversation creation failed: ${createdConversation.status} ${JSON.stringify(createdConversation.body)}`);
  }
  const conversationId = createdConversation.body.id;
  const messageBodies = [
    'MSG-003 kabul mesajı 1: numune teslimi planlandı.',
    'MSG-003 kabul mesajı 2: klinik stok kontrolü tamamlandı.',
  ];
  for (const body of messageBodies) {
    const sent = await apiRequest(staffA.cookie, `/api/messaging/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body, clientActionId: randomUUID() }),
    });
    if (sent.status !== 201 && sent.status !== 200) {
      throw new Error(`Message send failed: ${sent.status} ${JSON.stringify(sent.body)}`);
    }
  }
  const initialMe = await apiRequest(manager.cookie, '/api/auth/me');
  const initialNotifications = await apiRequest(manager.cookie, '/api/notifications/unread-count');
  record('ENV-MESSAGING-FIXTURE', initialMe.status === 200
    && initialMe.body?.user?.capabilities?.messaging === true
    && initialNotifications.status === 200
    && initialNotifications.body?.unreadCount >= 2,
  `capability=${initialMe.body?.user?.capabilities?.messaging}, notificationCount=${initialNotifications.body?.unreadCount}`);
  const latestMessageAtSetup = await latestMessageId(conversationId);
  record('ENV-MESSAGING-HISTORY', Boolean(latestMessageAtSetup), `messages sent=${messageBodies.length}`);

  managerContext = await browser.newContext({ baseURL: webOrigin, viewport: { width: 1_440, height: 1_000 } });
  managerPage = await loginCustomer(managerContext, fixture.manager);
  managerPage.on('request', (request) => {
    if (request.url().includes('/api/auth/me')) lastManagerIdentityRequestAt = Date.now();
  });
  managerOverviewPage = await managerContext.newPage();
  managerJobPage = await managerContext.newPage();

  async function managerHomeMessages() {
    await managerPage.goto('/messages');
    await managerPage.locator('.conversation-item').first().waitFor({ timeout: 20_000 });
    await managerPage.getByRole('button', { name: 'Bildirimler', exact: true }).first().waitFor({ timeout: 10_000 });
  }

  async function verifyNotificationBadge(prefix, expectedText) {
    await check(`${prefix}-NOTIFICATION-BADGE`, async () => {
      // The unread count refetches asynchronously after a capability change, so settle before asserting.
      if (expectedText === null) {
        await waitForLocatorCount(managerPage.locator('.notification-center-badge'), 0, 10_000);
      } else {
        await managerPage.locator('.notification-center-badge').first()
          .waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
      }
      const badge = managerPage.locator('.notification-center-badge').first();
      const count = await badge.count();
      const text = count > 0 ? (await badge.innerText()).trim() : '';
      if (expectedText === null && count > 0) throw new Error(`Rozet görünür: ${text}`);
      if (expectedText !== null && text !== expectedText) throw new Error(`Rozet metni=${text || '(yok)'}`);
      return count > 0 ? `Rozet=${text}` : 'Rozet yok';
    });
  }

  async function verifyNotificationList(prefix, expectedCount, expectedUnread, options = {}) {
    let panel;
    try {
      panel = await openNotificationCenter(managerPage);
    } catch (error) {
      record(`${prefix}-NOTIFICATION-LIST`, false, error instanceof Error ? error.message : String(error));
      return;
    }
    try {
      const items = panel.locator('[data-notification-id]');
      if (expectedCount === 0) {
        await panel.getByText('Henüz bildiriminiz yok.', { exact: true }).waitFor({ timeout: 10_000 });
      } else {
        await waitForLocatorCount(items, expectedCount, 10_000);
      }
      const actual = await items.count();
      const states = expectedCount > 0
        ? await items.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-read-state')))
        : [];
      const text = await panel.innerText();
      const hidesEmpty = expectedCount === 0 && text.includes('Henüz bildiriminiz yok.');
      record(`${prefix}-NOTIFICATION-LIST`,
        actual === expectedCount
        && (expectedCount === 0
          ? hidesEmpty
          : expectedUnread === null || states.every((state) => state === expectedUnread)),
        `items=${actual}, states=${states.join(',') || '(none)'}`);
      if (options.capture) await screenshot(managerPage, options.capture, 1440);
    } finally {
      await closeNotificationCenter(managerPage).catch(() => {});
    }
  }

  async function verifyOverviewSection(prefix, expectedCount) {
    await check(`${prefix}-OVERVIEW`, async () => {
      await managerOverviewPage.goto('/overview');
      await managerOverviewPage.getByRole('heading', { name: 'Genel Bakış', exact: true }).waitFor({ timeout: 20_000 }).catch(() => {});
      const section = managerOverviewPage.locator('#message-summary-title');
      if (expectedCount === 0) {
        if (await section.count() !== 0) throw new Error('Okunmamış mesaj bölümü görünür');
        return 'Okunmamış mesaj bölümü yok';
      }
      await section.waitFor({ timeout: 15_000 });
      const text = await section.locator('..').innerText();
      if (!text.includes(`${expectedCount} okunmamış mesaj`)) throw new Error(text);
      return text.replaceAll('\n', ' / ');
    });
  }

  async function verifyJobDetailAction(prefix, expected) {
    await check(`${prefix}-JOB-DETAIL-ACTION`, async () => {
      await managerJobPage.goto(`/jobs/${fixture.ids.job}`);
      await managerJobPage.getByRole('heading', { name: 'MSG-003 Mesajlaşma kabul işi', exact: true }).waitFor({ timeout: 20_000 }).catch(() => {});
      const action = managerJobPage.locator('[data-job-detail-messaging="true"]');
      if (!expected) {
        if (await action.count() !== 0) throw new Error('Konuşma aksiyonu görünür');
        return 'Konuşma aksiyonu yok';
      }
      await action.waitFor({ timeout: 15_000 });
      const text = (await action.innerText()).trim();
      if (!text.includes('Konuşmayı aç')) throw new Error(text);
      return text.replaceAll('\n', ' / ');
    });
  }

  async function verifyNav(prefix, expected, width = 1440) {
    if (width === 1440) {
      await check(`${prefix}-NAV`, async () => {
        const link = managerPage.getByRole('link', { name: 'Mesajlar', exact: true });
        if (expected) {
          await link.first().waitFor({ timeout: 15_000 });
          return 'Mesajlar bağlantısı görünür';
        }
        const settled = await waitForLocatorCount(link, 0, 15_000);
        if (!settled) throw new Error(`Mesajlar bağlantısı hâlâ görünür (${await link.count()})`);
        return 'Mesajlar bağlantısı yok';
      });
      return;
    }
    await openMobileMenu(managerPage);
    try {
      await check(`${prefix}-MOBILE-MENU-NAV`, async () => {
        const drawer = managerPage.locator('.shell-drawer');
        const link = drawer.getByRole('link', { name: 'Mesajlar', exact: true });
        if (expected) {
          await link.waitFor({ timeout: 10_000 });
          return 'Mobil menüde Mesajlar görünür';
        }
        if (await link.count() !== 0) throw new Error('Mobil menüde Mesajlar görünür');
        return 'Mobil menüde Mesajlar yok';
      });
    } finally {
      await closeMobileMenu(managerPage);
    }
  }

  async function verifyCustomerOff(prefix) {
    const state = `${prefix}-OFF`;
    await managerPage.locator('.conversation-item').first().click();
    let redirected = true;
    try {
      await managerPage.waitForURL((url) => url.pathname === '/jobs', { timeout: 20_000 });
    } catch {
      redirected = false;
    }
    record(`${prefix}-REDIRECT`, redirected, redirected ? 'Müşteri sekmesi /jobs adresine geçti' : `URL=${managerPage.url()}`);
    await verifyNav(state, false, 1440);
    await verifyNotificationBadge(state, null);
    await screenshot(managerPage, `${prefix.toLowerCase()}-customer-off-stale-badge`, 1440);
    await check(`${state}-NOTIFICATION-COUNT-API`, async () => {
      const unread = await apiRequest(manager.cookie, '/api/notifications/unread-count');
      if (unread.status !== 200 || unread.body?.unreadCount !== 0) throw new Error(JSON.stringify(unread));
      return `server unreadCount=${unread.body.unreadCount}`;
    });
    await verifyNotificationList(state, 0, null, {
      capture: `${prefix.toLowerCase()}-notifications-off`,
    });
    await managerPage.reload();
    await managerPage.getByRole('navigation', { name: 'Ana navigasyon' }).waitFor({ timeout: 20_000 });
    await verifyNotificationBadge(`${state}-AFTER-RELOAD`, null);
    await verifyOverviewSection(state, 0);
    await verifyJobDetailAction(state, false);
    await verifyNav(state, false, 390);
    await screenshot(managerPage, `${prefix.toLowerCase()}-customer-off`, 1440);
    await screenshot(managerPage, `${prefix.toLowerCase()}-customer-off`, 390);
    await managerPage.setViewportSize({ width: 1_440, height: 1_000 });
    await screenshot(managerJobPage, `${prefix.toLowerCase()}-job-detail-off`, 1440);
    await screenshot(managerJobPage, `${prefix.toLowerCase()}-job-detail-off`, 390);
    await managerJobPage.setViewportSize({ width: 1_440, height: 1_000 });
  }

  async function verifyCustomerOn(prefix) {
    const state = `${prefix}-ON`;
    await waitForIdentityWindow();
    const before = Date.now();
    await triggerFocusRevalidation(managerPage);
    let navBack = true;
    try {
      await managerPage.getByRole('link', { name: 'Mesajlar', exact: true }).first().waitFor({ timeout: 15_000 });
    } catch {
      navBack = false;
    }
    record(`${prefix}-REVALIDATION`, navBack,
      navBack ? `Tek odak/visibility revalidation sonrası menü döndü (${Date.now() - before}ms)`
        : 'Revalidation sonrası Mesajlar menüsü dönmedi');
    await check(`${prefix}-MESSAGES-PAGE`, async () => {
      await managerPage.goto('/messages');
      await managerPage.locator('.conversation-item').first().waitFor({ timeout: 20_000 });
      return 'Gerçek /messages konuşma listesi yüklendi';
    });
    await verifyNotificationBadge(state, '2');
    await verifyNotificationList(state, 2, 'unread');
    await verifyOverviewSection(state, 2);
    await verifyJobDetailAction(state, true);
    await verifyNav(state, true, 1440);
    await verifyNav(state, true, 390);
    await managerHomeMessages();
    await screenshot(managerPage, `${prefix.toLowerCase()}-customer-on`, 1440);
    await screenshot(managerPage, `${prefix.toLowerCase()}-customer-on`, 390);
    await managerPage.setViewportSize({ width: 1_440, height: 1_000 });
    await screenshot(managerOverviewPage, `${prefix.toLowerCase()}-overview-on`, 1440);
  }

  await runScenario('A2', async () => {
    for (const [cycle, prefix] of [['cycle 1', 'A2-C1'], ['cycle 2', 'A2-C2']]) {
      await managerHomeMessages();
      await verifyNotificationBadge(`${prefix}-BEFORE`, '2');
      const off = await setMessagingEnabled(false, {
        captureDialog: `${prefix.toLowerCase()}-operator-disable-dialog`,
      });
      if (!off.changed) throw new Error(`${cycle}: Messaging was already off before the operator toggle`);
      await assertDisableDialogCopy(prefix, off.dialogText);
      await verifyCustomerOff(prefix);
      await check(`${prefix}-DB-PRESERVED`, async () => withDatabase(async (client) => {
        const rows = (await client.query(
          `SELECT id, read_at FROM in_app_notifications
            WHERE recipient_user_id = $1 AND entity_type = 'conversation'
            ORDER BY created_at`,
          [fixture.manager.id],
        )).rows;
        if (rows.length !== 2 || rows.some((row) => row.read_at !== null)) {
          throw new Error(JSON.stringify(rows));
        }
        return `notification rows=${rows.length}, all unread, none deleted`;
      }));
      const on = await setMessagingEnabled(true, {
        captureDialog: `${prefix.toLowerCase()}-operator-enable-dialog`,
      });
      if (!on.changed) throw new Error(`${cycle}: Messaging was already on before the operator toggle`);
      await assertEnableDialogCopy(`${prefix}-ENABLE`, on.dialogText);
      await verifyCustomerOn(prefix);
    }
  });

  await setMessagingEnabled(false);
  await runScenario('A3', async () => {
    const authenticated = await apiRequest(manager.cookie, '/api/messaging/conversations');
    record('A3-AUTHENTICATED-404',
      authenticated.status === 404 && authenticated.body?.code === 'NOT_FOUND',
      `status=${authenticated.status}, code=${authenticated.body?.code}, error=${authenticated.body?.error}`);
    const unauthenticated = await apiRequest('', '/api/messaging/conversations');
    record('A3-UNAUTHENTICATED-401', unauthenticated.status === 401,
      `status=${unauthenticated.status}, code=${unauthenticated.body?.code}`);
    const me = await apiRequest(manager.cookie, '/api/auth/me');
    record('A3-ME-CAPABILITY-FALSE', me.status === 200 && me.body?.user?.capabilities?.messaging === false,
      `status=${me.status}, messaging=${me.body?.user?.capabilities?.messaging}`);
    const overview = await apiRequest(manager.cookie, '/api/overview');
    const hasSummary = overview.body && Object.prototype.hasOwnProperty.call(overview.body, 'messageUnreadSummary');
    record('A3-OVERVIEW-OMITS-SUMMARY', overview.status === 200 && !hasSummary,
      `status=${overview.status}, messageUnreadSummary=${hasSummary ? 'present' : 'omitted'}`);
  });

  await runScenario('A4', async () => {
    const webPush = await apiRequest(manager.cookie, '/api/web-push/status');
    record('ENV-WEB-PUSH-DISABLED', webPush.status === 200 && webPush.body?.enabled === false,
      `status=${webPush.status}, enabled=${webPush.body?.enabled}`);
    recordNotRun('A4-NOT-RUN',
      'WEB_PUSH_ENABLED=false: server/src/app.ts constructs the dispatcher only when config.webPush.enabled is true, so no dispatcher tick exists to observe. No PENDING delivery row was fabricated and no assertion is claimed.');
  });

  await runScenario('A5', async () => {
    await managerJobPage.goto(`/jobs/${fixture.ids.job}`);
    await managerJobPage.getByRole('button', { name: 'Görevi düzenle', exact: true }).waitFor({ timeout: 20_000 });
    await managerJobPage.getByRole('button', { name: 'Görevi düzenle', exact: true }).click();
    await managerJobPage.locator('#general-task-edit-assignee').waitFor({ timeout: 10_000 });
    await managerJobPage.locator('#general-task-edit-assignee').selectOption(fixture.staffB.id);
    await managerJobPage.getByRole('button', { name: 'Değişiklikleri kaydet', exact: true }).click();
    const saved = await waitForText(managerJobPage, 'Görev bilgileri güncellendi.', 20_000);
    record('A5-REASSIGN-OFF-SAVED', saved, saved ? 'Görev B personeline atandı' : 'Başarı metni görünmedi');
    await check('A5-REASSIGN-OFF-DB', async () => withDatabase(async (client) => {
      const job = (await client.query(
        'SELECT assigned_to FROM job_cards WHERE id = $1',
        [fixture.ids.job],
      )).rows[0];
      const activity = (await client.query(
        `SELECT id, event_type, new_value
           FROM job_card_activity_logs
          WHERE job_card_id = $1 AND event_type = 'JOB_ASSIGNED'
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
        [fixture.ids.job],
      )).rows[0];
      if (job?.assigned_to !== fixture.staffB.id || !activity) {
        throw new Error(`assigned_to=${job?.assigned_to}, activity=${JSON.stringify(activity ?? null)}`);
      }
      return `assigned_to=${fixture.staffB.id}, activity=${activity.id}`;
    }));
    const promptCount = await managerJobPage.locator('.reassignment-sync-body').count();
    record('A5-NO-PROMPT-WHILE-OFF', promptCount === 0, `sync prompt count=${promptCount}`);

    await setMessagingEnabled(true);
    await managerJobPage.goto(`/jobs/${fixture.ids.job}`);
    const notice = managerJobPage.locator('[data-job-assignee-sync-notice="true"]');
    const noticeVisible = await check('A5-SYNC-NOTICE', async () => {
      await notice.waitFor({ timeout: 20_000 });
      const text = (await notice.innerText()).trim();
      if (!text.includes(`İşin yeni sorumlusu ${fixture.staffB.name} bu iş konuşmasının katılımcısı değil.`)) {
        throw new Error(text);
      }
      if (!text.includes('Konuşmaya ekle')) throw new Error('Konuşmaya ekle aksiyonu yok');
      return text.replaceAll('\n', ' / ');
    });
    if (noticeVisible) {
      await screenshotBoth(managerJobPage, 'a5-sync-notice');
      await notice.getByRole('button', { name: 'Konuşmaya ekle', exact: true }).click();
      const dialog = managerJobPage.getByRole('dialog');
      await dialog.waitFor({ timeout: 10_000 });
      const dialogText = await dialog.innerText();
      await check('A5-SYNC-DIALOG', async () => {
        if (!dialogText.includes('Konuşma katılımcısı güncel değil')) throw new Error(dialogText);
        if (!dialogText.includes(`İşin yeni sorumlusu ${fixture.staffB.name} bu iş konuşmasının katılımcısı değil.`)) {
          throw new Error(dialogText);
        }
        if (!dialogText.includes('Şimdi değil derseniz konuşmadaki mevcut katılımcılar değişmez.')) {
          throw new Error('Durable membership helper missing');
        }
        return dialogText.replaceAll('\n', ' / ');
      });
      await screenshot(managerJobPage, 'a5-sync-dialog', 1440);
      await dialog.getByRole('button', { name: new RegExp(`${fixture.staffA.name} yerine ${fixture.staffB.name} ekle`) }).click();
      await dialog.waitFor({ state: 'detached', timeout: 20_000 }).catch(() => {});
      const gone = await waitForLocatorCount(notice, 0, 20_000);
      record('A5-SYNC-NOTICE-GONE', gone, gone ? 'Senkron sonrası kalıcı uyarı kayboldu' : 'Uyarı hâlâ görünür');
      await check('A5-SYNC-DB', async () => {
        const participants = await getParticipantRows(conversationId);
        const latest = await latestMessageId(conversationId);
        const byUser = new Map(participants.map((row) => [row.user_id, row.last_read_message_id]));
        const hasA = byUser.has(fixture.staffA.id);
        const hasB = byUser.has(fixture.staffB.id);
        const bRead = byUser.get(fixture.staffB.id);
        if (hasA || !hasB || bRead !== latest) {
          throw new Error(`participants=${JSON.stringify(participants)}, latest=${latest}`);
        }
        return `A removed, B added, B.last_read=${bRead}`;
      });
      await check('A5-SYNC-ACTIVITY', async () => withDatabase(async (client) => {
        const activity = (await client.query(
          `SELECT details FROM messaging_activity_logs
            WHERE conversation_id = $1 AND action = 'PARTICIPANTS_CHANGED'
            ORDER BY created_at DESC, id DESC
            LIMIT 1`,
          [conversationId],
        )).rows[0];
        if (!activity
          || !activity.details?.removedUserIds?.includes(fixture.staffA.id)
          || !activity.details?.addedUserIds?.includes(fixture.staffB.id)) {
          throw new Error(JSON.stringify(activity ?? null));
        }
        return JSON.stringify(activity.details);
      }));
    }

    const staffBHttp = await loginHttp(fixture.staffB);
    const staffBContext = await browser.newContext({ baseURL: webOrigin, viewport: { width: 1_440, height: 1_000 } });
    const staffBPage = await loginCustomer(staffBContext, fixture.staffB);
    await check('A5-STAFF-B-UNREAD-ZERO', async () => {
      await staffBPage.goto('/messages');
      await staffBPage.locator('.conversation-item').first().waitFor({ timeout: 20_000 });
      const unread = await staffBPage.locator('.unread-count').count();
      if (unread !== 0) throw new Error(`Görünen unread-count=${unread}`);
      return 'Görünen okunmamış rozeti yok';
    });
    await check('A5-STAFF-B-UNREAD-API', async () => {
      const unreadApi = await apiRequest(staffBHttp.cookie, '/api/messaging/unread-count');
      if (unreadApi.status !== 200 || unreadApi.body?.unreadCount !== 0) {
        throw new Error(JSON.stringify(unreadApi));
      }
      return `unreadCount=${unreadApi.body.unreadCount}`;
    });
    await check('A5-STAFF-B-HISTORY', async () => {
      await staffBPage.locator('.conversation-item').first().click();
      await staffBPage.getByText(messageBodies[0], { exact: false }).waitFor({ timeout: 20_000 });
      const text = await staffBPage.locator('.message-list, .messaging-thread, main').first().innerText();
      if (!text.includes(messageBodies[1])) throw new Error('İkinci mesaj görünmedi');
      return 'B konuşma geçmişini gördü';
    });
    await screenshotBoth(staffBPage, 'a5-staff-b-conversation');
    await staffBContext.close();
  });

  await runScenario('A6', async () => {
    await setMessagingEnabled(false);
    adminContext = await browser.newContext({ baseURL: webOrigin, viewport: { width: 1_440, height: 1_000 } });
    adminPage = await loginCustomer(adminContext, fixture.admin);
    await adminPage.goto(`/users/${fixture.staffB.id}`);
    await adminPage.getByRole('button', { name: 'Personeli devre dışı bırak', exact: true }).waitFor({ timeout: 20_000 });
    await adminPage.getByRole('button', { name: 'Personeli devre dışı bırak', exact: true }).click();
    await adminPage.getByRole('combobox', { name: 'İdari neden' }).waitFor({ timeout: 15_000 });
    await adminPage.getByRole('combobox', { name: 'İdari neden' }).selectOption('ACCESS_ENDED');
    const jobSelects = adminPage.locator('select[name^="job-"]');
    const jobSelectCount = await jobSelects.count();
    for (let index = 0; index < jobSelectCount; index += 1) {
      await jobSelects.nth(index).selectOption(fixture.staffC.id);
    }
    await screenshotBoth(adminPage, 'a6-offboarding-preview', { fullPage: true });
    await adminPage.setViewportSize({ width: 1_440, height: 1_000 });
    await adminPage.getByRole('button', { name: 'Kararları onayla', exact: true }).click();
    const confirmation = adminPage.locator('.workflow-dialog');
    await confirmation.waitFor({ timeout: 15_000 });
    await check('A6-CONFIRMATION', async () => {
      const text = await confirmation.innerText();
      if (!text.includes('Erişim sonlandırılır')) throw new Error(text);
      return text.replaceAll('\n', ' / ').slice(0, 500);
    });
    await confirmation.getByRole('button', { name: 'Erişimi sonlandır', exact: true }).click();
    const success = await waitForText(adminPage, 'Personel devre dışı bırakıldı', 25_000);
    record('A6-OFFBOARD-OFF-SUCCEEDED', success, success ? 'Offboarding messaging kapalıyken tamamlandı' : 'Başarı metni görünmedi');
    await screenshot(adminPage, 'a6-offboarding-success', 1440);
    await check('A6-DB-TRANSFER', async () => withDatabase(async (client) => {
      const user = (await client.query('SELECT is_active FROM users WHERE id = $1', [fixture.staffB.id])).rows[0];
      const job = (await client.query('SELECT assigned_to FROM job_cards WHERE id = $1', [fixture.ids.job])).rows[0];
      const audit = (await client.query(
        `SELECT COUNT(*)::int AS count FROM audit_events
          WHERE subject_id = $1 AND event_type = 'USER_OFFBOARDED'`,
        [fixture.staffB.id],
      )).rows[0].count;
      if (user?.is_active !== false || job?.assigned_to !== fixture.staffC.id || audit !== 1) {
        throw new Error(`active=${user?.is_active}, assigned_to=${job?.assigned_to}, audit=${audit}`);
      }
      return `B inactive, job assigned C, offboarding audit=${audit}`;
    }));
    await check('A6-DB-PARTICIPANTS', async () => {
      const participants = await getParticipantRows(conversationId);
      const latest = await latestMessageId(conversationId);
      const byUser = new Map(participants.map((row) => [row.user_id, row.last_read_message_id]));
      if (byUser.has(fixture.staffB.id) || !byUser.has(fixture.staffC.id)
        || byUser.get(fixture.staffC.id) !== latest) {
        throw new Error(`participants=${JSON.stringify(participants)}, latest=${latest}`);
      }
      return `B removed, C added, C.last_read=${latest}`;
    });
    await setMessagingEnabled(true);
    const staffCContext = await browser.newContext({ baseURL: webOrigin, viewport: { width: 1_440, height: 1_000 } });
    const staffCPage = await loginCustomer(staffCContext, fixture.staffC);
    await check('A6-STAFF-C-OPENS', async () => {
      await staffCPage.goto('/messages');
      await staffCPage.locator('.conversation-item').first().waitFor({ timeout: 20_000 });
      const unread = await staffCPage.locator('.unread-count').count();
      await staffCPage.locator('.conversation-item').first().click();
      await staffCPage.getByText(messageBodies[0], { exact: false }).waitFor({ timeout: 20_000 });
      if (unread !== 0) throw new Error(`unread-count=${unread}`);
      return 'C konuşmayı unread 0 ile açtı ve geçmişi gördü';
    });
    await screenshotBoth(staffCPage, 'a6-staff-c-conversation');
    await staffCContext.close();
  });
} catch (caught) {
  failure = caught;
  log(`FATAL: ${caught instanceof Error ? caught.stack ?? caught.message : String(caught)}`);
  if (managerPage) {
    try { await screenshot(managerPage, 'failure-customer', 1440); } catch { /* best effort */ }
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
    record('ENV-POSTGRES-DISPOSABLE-DROPPED', true, 'Disposable database removed');
  } catch (cleanupError) {
    failure ??= cleanupError;
    record('ENV-POSTGRES-DISPOSABLE-DROPPED', false, cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
  }
  try {
    await stopIsolatedPostgres();
    record('ENV-POSTGRES-CLUSTER-REMOVED', true, 'Isolated PostgreSQL cluster stopped and removed');
  } catch (cleanupError) {
    failure ??= cleanupError;
    record('ENV-POSTGRES-CLUSTER-REMOVED', false, cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
  }
  await writeEvidence();
}

async function writeEvidence() {
  mkdirSync(evidenceDirectory, { recursive: true });
  const featureHead = process.env.MSG003_BASE_SHA
    ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryDirectory, encoding: 'utf8' }).trim();
  const failures = results.filter((entry) => entry.status === 'FAIL');
  const scenarios = scenarioSummary();
  const payload = {
    gate: 'MSG003_MESSAGING_MODULE_ACCEPTANCE_LOCAL_REAL_RUNTIME',
    executedAt: new Date().toISOString(),
    featureHead,
    branch: execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repositoryDirectory, encoding: 'utf8',
    }).trim(),
    runtime: {
      fastify: 'real built dist (node dist/index.js)',
      postgresql: 'disposable isolated PostgreSQL 17 cluster (initdb/pg_ctl, random loopback port)',
      vite: 'real Vite dev server',
      browser: 'Playwright Chromium',
      data: 'synthetic only',
      webPush: 'disabled (WEB_PUSH_ENABLED=false)',
    },
    result: failure || failures.length > 0 ? 'FAIL' : 'PASS',
    counts: {
      pass: results.filter((entry) => entry.status === 'PASS').length,
      fail: failures.length,
      notRun: results.filter((entry) => entry.status === 'NOT_RUN').length,
    },
    scenarios,
    assertions: results,
    screenshots,
    limits,
    failure: failure ? sanitize(failure instanceof Error ? failure.stack ?? failure.message : String(failure)) : null,
  };
  writeFileSync(`${evidenceDirectory}/runtime-results.json`, `${JSON.stringify(payload, null, 2)}\n`);
  writeFileSync(`${logDirectory}/runtime-log.txt`, `${runLog.join('\n')}\n`);

  const rows = scenarios.map((scenario) => (
    `| ${scenario.scenario} | ${scenario.status} | ${scenario.records.filter((entry) => entry.status === 'PASS').length}/${scenario.records.length} | ${scenario.title} |`
  )).join('\n');
  const screenshotRows = screenshots.map((entry) => `- \`${entry}\``).join('\n') || '- (none)';
  const failureRows = failures.length > 0
    ? failures.map((entry) => `- \`${entry.id}\`: ${entry.observed}`).join('\n')
    : '- Yok';
  const staleBadgeFailures = failures.filter((entry) => entry.id.endsWith('OFF-NOTIFICATION-BADGE'));
  const findingLines = [];
  if (staleBadgeFailures.length > 0) {
    findingLines.push(
      `- Strict A2 criterion: after the single identity revalidation that removed navigation, /messages, the Job Detail action and the Overview summary, the already-open tab still showed the previous notification badge count (2) for the hidden message notifications (${staleBadgeFailures.map((entry) => `\`${entry.id}\``).join(', ')}). The server-side unread notification count was 0 and the opened panel was empty; a full page reload/remount cleared the badge (recorded as \`*-OFF-AFTER-RELOAD-NOTIFICATION-BADGE\`). This is a client-side stale count in the open session, not a server-side exposure or data deletion.`,
    );
  }
  const findings = findingLines.length > 0 ? findingLines.join('\n') : '- Yok';
  writeFileSync(`${evidenceDirectory}/README.md`, `# MSG-003 messaging module acceptance — local real-runtime evidence

- Executed at: ${payload.executedAt}
- Commit: \`${featureHead}\` (branch \`${payload.branch}\`)
- Result: **${payload.result}** — ${payload.counts.pass} PASS, ${payload.counts.fail} FAIL, ${payload.counts.notRun} NOT_RUN
- Command: \`cd web && node scripts/msg003-messaging-acceptance.mjs\`

## Scenarios

| Scenario | Status | PASS/records | What was exercised |
| -------- | ------ | ------------ | ------------------ |
${rows}

## Failures observed by the harness

${failureRows}

## Findings

${findings}

## Environment

- Real built Fastify server (\`node dist/index.js\`) started with \`MESSAGING_ENABLED=true\` on a fresh disposable database.
- Isolated PostgreSQL 17 cluster created with \`initdb\` / \`pg_ctl\` on a random loopback port and removed at the end.
- Real Vite web app and Playwright Chromium at 1440 and 390 CSS px.
- Synthetic organization, users, customer, job, conversation and messages only.
- Operator account granted through the host CLI (\`operator grant --password-stdin\`).
- No staging environment exists; deployment is not authorized.

## Limits / not covered

${limits.map((entry) => `- ${entry}`).join('\n')}

## Screenshots

${screenshotRows}

## Files

- \`runtime-results.json\` — every assertion with status, observed value and timestamp.
- \`screenshots/\` — scenario screenshots named \`<screen>-<width>.png\`.
- Raw logs (\`runtime-log.txt\`, \`fastify.log\`, \`vite.log\`) are not committed: the
  harness writes them to \`$FLEET_EVIDENCE_DIR\` when set, else to an OS temp directory.
`);

  if (fleetEvidenceDirectory) {
    try {
      mkdirSync(fleetEvidenceDirectory, { recursive: true });
      cpSync(evidenceDirectory, fleetEvidenceDirectory, { recursive: true });
    } catch (copyError) {
      log(`Could not copy evidence to FLEET_EVIDENCE_DIR: ${copyError instanceof Error ? copyError.message : String(copyError)}`);
    }
  }
}

const failures = results.filter((entry) => entry.status === 'FAIL');
if (failure) {
  console.error(failure instanceof Error ? failure.stack ?? failure.message : String(failure));
  process.exitCode = 1;
} else if (failures.length > 0) {
  console.error(`MSG-003 acceptance finished with ${failures.length} failed assertion(s).`);
  process.exitCode = 1;
} else {
  console.info(`MSG-003 messaging acceptance passed (${results.length} records, ${results.filter((entry) => entry.status === 'NOT_RUN').length} NOT_RUN).`);
}
