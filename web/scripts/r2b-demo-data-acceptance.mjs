import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const webDirectory = fileURLToPath(new URL('../', import.meta.url));
const repositoryDirectory = fileURLToPath(new URL('../../', import.meta.url));
const serverDirectory = fileURLToPath(new URL('../../server/', import.meta.url));
const evidenceDirectory = fileURLToPath(new URL('../../docs/evidence/r2b-demo-data/', import.meta.url));
const screenshotDirectory = `${evidenceDirectory}/screenshots`;
const serverRequire = createRequire(new URL('../../server/package.json', import.meta.url));
const { Client } = serverRequire('pg');

const serverOrigin = 'http://127.0.0.1:3000';
const webOrigin = 'http://127.0.0.1:5173';
const routePath = '/settings/data-management/demo-data';
const postgresBinCandidates = [
  process.env.R2B_POSTGRES_BIN,
  '/opt/homebrew/opt/postgresql@16/bin',
  '/opt/homebrew/opt/postgresql@17/bin',
  '/opt/homebrew/opt/postgresql@18/bin',
  '/opt/homebrew/opt/postgresql/bin',
  '/Applications/Postgres.app/Contents/Versions/latest/bin',
].filter(Boolean);
const postgresBin = postgresBinCandidates.find((candidate) =>
  existsSync(`${candidate}/initdb`) && existsSync(`${candidate}/pg_ctl`));

if (!postgresBin) throw new Error('An isolated PostgreSQL initdb/pg_ctl installation is required');

mkdirSync(screenshotDirectory, { recursive: true });
const failureScreenshotPath = `${screenshotDirectory}/failure.png`;
if (existsSync(failureScreenshotPath)) unlinkSync(failureScreenshotPath);

const results = [];
const screenshots = [];
let serverProcess;
let viteProcess;
let browser;
let page;
let disposableDatabaseName = '';
let disposableDatabaseUrl = '';
let adminDatabaseUrl = '';
let databaseCreated = false;
let postgresClusterDirectory = '';
let postgresStarted = false;
let failure = null;
let serverEnvironmentFileCreated = false;

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

function commandEnvironment(overrides = {}) {
  return {
    ...process.env,
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: '3000',
    CORS_ORIGIN: webOrigin,
    DATABASE_URL: disposableDatabaseUrl,
    HEALTH_SCHEMA_VERSION: '',
    CALENDAR_ENABLED: 'false',
    WEB_PUSH_ENABLED: 'false',
    ACTION_SCOPED_GEOLOCATION_ENABLED: 'false',
    ...overrides,
  };
}

function ensureServerEnvironmentFile(environment) {
  const environmentFile = `${serverDirectory}/.env`;
  if (existsSync(environmentFile)) return;
  writeFileSync(environmentFile, [
    `DATABASE_URL=${environment.DATABASE_URL}`,
    '',
  ].join('\n'), { mode: 0o600 });
  serverEnvironmentFileCreated = true;
}

async function runCommand(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: 'inherit',
  });
  const [code, signal] = await once(child, 'exit');
  if (code !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${code ?? signal}`);
  }
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
    if (child?.exitCode !== null) {
      throw new Error(`Process exited before ${url} became ready`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Expected while the process is starting.
    }
    await delay(150);
  }
  throw new Error(`${url} did not become ready within ${timeoutMilliseconds}ms`);
}

function databaseUrlFor(name) {
  const url = new URL(adminDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not reserve a loopback port'));
        return;
      }
      const { port } = address;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function startIsolatedPostgres() {
  postgresClusterDirectory = mkdtempSync('/private/tmp/servora-r2b-postgres-');
  const port = await reserveLoopbackPort();
  await runCommand(`${postgresBin}/initdb`, [
    '-D', postgresClusterDirectory,
    '--auth=trust',
    '--username=servora_r2b',
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
  adminDatabaseUrl = `postgresql://servora_r2b@127.0.0.1:${port}/postgres`;
  record('POSTGRES-ISOLATED-CLUSTER', true,
    'A private PostgreSQL cluster was started under /private/tmp for this acceptance only');
}

async function stopIsolatedPostgres() {
  if (postgresStarted) {
    await runCommand(`${postgresBin}/pg_ctl`, [
      '-D', postgresClusterDirectory,
      'stop',
      '-m', 'fast',
      '-w',
    ], { cwd: repositoryDirectory });
    postgresStarted = false;
  }
  if (postgresClusterDirectory) {
    if (!postgresClusterDirectory.startsWith('/private/tmp/servora-r2b-postgres-')) {
      throw new Error('Refusing to remove an unexpected PostgreSQL cluster path');
    }
    rmSync(postgresClusterDirectory, { recursive: true, force: true });
    postgresClusterDirectory = '';
  }
}

async function createDisposableDatabase() {
  disposableDatabaseName = `servora_r2b_${randomBytes(6).toString('hex')}`;
  if (!/^[a-z0-9_]+$/.test(disposableDatabaseName)) {
    throw new Error('Disposable database name is invalid');
  }
  const admin = new Client({ connectionString: adminDatabaseUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${disposableDatabaseName}"`);
  } finally {
    await admin.end();
  }
  disposableDatabaseUrl = databaseUrlFor(disposableDatabaseName);
  databaseCreated = true;
  record('POSTGRES-DISPOSABLE-CREATED', true, 'A dedicated disposable PostgreSQL database was created');
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

async function seedFixture(email, password) {
  const environment = commandEnvironment({
    BOOTSTRAP_ORGANIZATION_NAME: 'R2B Demo Data Acceptance',
    BOOTSTRAP_ADMIN_NAME: 'R2B Acceptance Admin',
    BOOTSTRAP_ADMIN_EMAIL: email,
    BOOTSTRAP_ADMIN_PASSWORD: password,
  });
  await runCommand('npm', ['run', 'bootstrap:admin'], { cwd: serverDirectory, env: environment });

  const client = new Client({ connectionString: disposableDatabaseUrl });
  await client.connect();
  try {
    const identity = await client.query(
      `SELECT u.id AS user_id, u.organization_id
       FROM users u WHERE lower(u.email) = lower($1)`,
      [email],
    );
    const admin = identity.rows[0];
    if (!admin) throw new Error('Synthetic business admin was not created');

    const dataset = await client.query(
      `INSERT INTO demo_datasets (organization_id, dataset_key, seed_version, created_by)
       VALUES ($1, 'r2b-ui-acceptance', 'r2b-v1', $2)
       RETURNING id`,
      [admin.organization_id, admin.user_id],
    );
    const datasetId = dataset.rows[0]?.id;
    if (!datasetId) throw new Error('Synthetic demo dataset was not created');

    await client.query(
      `INSERT INTO customers
         (organization_id, name, customer_type, status, data_class, demo_dataset_id)
       VALUES
         ($1, 'R2B DEMO CUSTOMER', 'clinic', 'active', 'DEMO', $2),
         ($1, 'R2B BUSINESS SENTINEL CUSTOMER', 'clinic', 'active', 'BUSINESS', NULL)`,
      [admin.organization_id, datasetId],
    );
    await client.query(
      `INSERT INTO products
         (organization_id, sku, name, unit, data_class, demo_dataset_id)
       VALUES
         ($1, 'R2B-DEMO-SKU', 'R2B DEMO PRODUCT', 'adet', 'DEMO', $2),
         ($1, 'R2B-BUSINESS-SENTINEL', 'R2B BUSINESS SENTINEL PRODUCT', 'adet', 'BUSINESS', NULL)`,
      [admin.organization_id, datasetId],
    );
    return {
      organizationId: admin.organization_id,
      datasetId,
    };
  } finally {
    await client.end();
  }
}

async function verifyDatabase(fixture) {
  const client = new Client({ connectionString: disposableDatabaseUrl });
  await client.connect();
  try {
    const result = await client.query(
      `SELECT
         d.status,
         (d.purged_at IS NOT NULL) AS has_purged_at,
         (SELECT COUNT(*)::int FROM customers
          WHERE organization_id = $1 AND data_class = 'DEMO' AND demo_dataset_id = $2) AS demo_customers,
         (SELECT COUNT(*)::int FROM products
          WHERE organization_id = $1 AND data_class = 'DEMO' AND demo_dataset_id = $2) AS demo_products,
         (SELECT COUNT(*)::int FROM customers
          WHERE organization_id = $1 AND name = 'R2B BUSINESS SENTINEL CUSTOMER') AS business_customers,
         (SELECT COUNT(*)::int FROM products
          WHERE organization_id = $1 AND sku = 'R2B-BUSINESS-SENTINEL') AS business_products,
         (SELECT COUNT(*)::int FROM demo_dataset_purge_operations
          WHERE organization_id = $1 AND dataset_id = $2 AND status = 'COMPLETED') AS completed_operations
       FROM demo_datasets d
       WHERE d.organization_id = $1 AND d.id = $2`,
      [fixture.organizationId, fixture.datasetId],
    );
    const row = result.rows[0];
    record('POSTGRES-TOMBSTONE', row?.status === 'PURGED' && row?.has_purged_at === true,
      `Dataset status=${row?.status ?? 'missing'}, purgedAt=${row?.has_purged_at === true}`);
    record('POSTGRES-DEMO-PURGED', row?.demo_customers === 0 && row?.demo_products === 0,
      `Remaining DEMO customers=${row?.demo_customers}, products=${row?.demo_products}`);
    record('POSTGRES-BUSINESS-PRESERVED', row?.business_customers === 1 && row?.business_products === 1,
      `BUSINESS sentinels customers=${row?.business_customers}, products=${row?.business_products}`);
    record('POSTGRES-ONE-COMPLETION', row?.completed_operations === 1,
      `Completed purge operations=${row?.completed_operations}`);
  } finally {
    await client.end();
  }
}

async function screenshot(name) {
  const path = `${screenshotDirectory}/${name}`;
  await page.screenshot({ path, fullPage: true });
  screenshots.push(`screenshots/${name}`);
}

async function runBrowserAcceptance(credentials, fixture) {
  const chromeCandidate = process.env.R2B_BROWSER_EXECUTABLE
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
  let backendMutationCompleted = false;
  await page.route('**/api/admin/demo-datasets/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const purgePath = `/api/admin/demo-datasets/${fixture.datasetId}/purge`;
    const inspectPath = `/api/admin/demo-datasets/${fixture.datasetId}`;

    if (request.method() === 'POST' && path === purgePath) {
      mutationCount += 1;
      await delay(500);
      const response = await route.fetch();
      backendReceipt = {
        httpStatus: response.status(),
        body: await response.json(),
      };
      backendMutationCompleted = true;
      await route.abort('connectionfailed');
      return;
    }
    if (backendMutationCompleted && request.method() === 'GET' && path === inspectPath) {
      await delay(900);
    }
    await route.continue();
  });

  await page.goto(routePath);
  await page.getByLabel('E-posta').fill(credentials.email);
  await page.getByLabel('Parola').fill(credentials.password);
  await page.getByRole('button', { name: 'Giriş yap', exact: true }).click();
  await page.getByRole('heading', { name: 'Demo verileri', level: 1 }).waitFor();
  await page.getByText('Kaldırmaya hazır', { exact: true }).waitFor();

  record('REAL-VITE-FASTIFY-LOGIN', true, 'Synthetic BUSINESS Admin loaded the real Demo Data route');
  const initialText = await page.locator('body').innerText();
  record('UI-NO-INTERNAL-HASH', !/\b[0-9a-f]{64}\b/i.test(initialText),
    'No 64-character plan hash is visible in the Admin UI');
  await screenshot('01-safe-preview-desktop.png');

  await page.getByRole('button', { name: 'Demo verilerini kaldır', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  const focusedBeforeConfirm = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '');
  record('DIALOG-INITIAL-FOCUS', focusedBeforeConfirm === 'Vazgeç',
    `Initial dialog focus=${focusedBeforeConfirm || 'none'}`);
  record('DIALOG-COUNTS', (await dialog.innerText()).includes('Müşteriler: 1')
    && (await dialog.innerText()).includes('Ürünler: 1'),
  'Confirmation contains the server preview count snapshot');
  await screenshot('02-confirmation-desktop.png');

  await dialog.getByRole('button', { name: 'Demo verilerini kaldır', exact: true }).click();
  await page.locator('[role="dialog"][aria-busy="true"]').waitFor();
  const pendingState = await page.evaluate(() => {
    const currentDialog = document.querySelector('[role="dialog"]');
    const datasetRow = document.querySelector('.demo-data-dataset-row');
    const purgeTrigger = Array.from(document.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Demo verilerini kaldır'
        && !currentDialog?.contains(button));
    const dialogButtons = currentDialog ? Array.from(currentDialog.querySelectorAll('button')) : [];
    return {
      datasetDisabled: datasetRow instanceof HTMLButtonElement && datasetRow.disabled,
      triggerDisabled: purgeTrigger instanceof HTMLButtonElement && purgeTrigger.disabled,
      dialogButtonsDisabled: dialogButtons.length === 2
        && dialogButtons.every((button) => button instanceof HTMLButtonElement && button.disabled),
    };
  });
  record('PENDING-SURFACE-LOCK', pendingState.datasetDisabled
    && pendingState.triggerDisabled
    && pendingState.dialogButtonsDisabled,
  `dataset=${pendingState.datasetDisabled}, trigger=${pendingState.triggerDisabled}, dialog=${pendingState.dialogButtonsDisabled}`);
  await screenshot('03-purge-pending-desktop.png');

  await page.getByText('İşlemin sonucu doğrulanamadı. Güncel durum kontrol ediliyor.', { exact: true }).waitFor();
  const ambiguousText = await page.locator('body').innerText();
  record('AMBIGUOUS-COPY', !ambiguousText.includes('Veriler değiştirilmedi.'),
    'Ambiguous transport state does not claim that data is unchanged');
  await screenshot('04-ambiguous-reconciliation-desktop.png');

  await page.getByRole('heading', { name: 'Demo verileri kaldırıldı.' }).waitFor({ timeout: 15_000 });
  record('LOST-RESPONSE-RECOVERY', backendReceipt?.httpStatus === 200
    && backendReceipt?.body?.status === 'COMPLETED'
    && backendReceipt?.body?.dataset?.status === 'PURGED',
  `Backend receipt http=${backendReceipt?.httpStatus ?? 'missing'}, status=${backendReceipt?.body?.status ?? 'missing'}, dataset=${backendReceipt?.body?.dataset?.status ?? 'missing'}`);
  record('NO-AUTOMATIC-POST-RETRY', mutationCount === 1, `Observed purge POST count=${mutationCount}`);
  record('UI-PURGED-TOMBSTONE', await page.getByText('Kaldırıldı', { exact: true }).count() === 1,
    'Dataset list shows one Kaldırıldı tombstone');
  record('SUCCESS-NO-DESTRUCTIVE-ACTION', await page.getByRole('button', {
    name: 'Demo verilerini kaldır', exact: true,
  }).count() === 0, 'No purge action remains after confirmed completion');
  await screenshot('05-recovered-success-desktop.png');

  await page.reload();
  await page.getByText('Demo veri kümesi kaldırıldı', { exact: true }).waitFor();
  record('RELOAD-PERSISTS-TOMBSTONE', await page.getByText('Kaldırıldı', { exact: true }).count() === 1,
    'Reload reads the persisted PURGED tombstone without previewing it');
  await screenshot('06-persisted-tombstone-desktop.png');

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileReflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  record('MOBILE-REFLOW', mobileReflow.scrollWidth <= mobileReflow.clientWidth,
    `scrollWidth=${mobileReflow.scrollWidth}, clientWidth=${mobileReflow.clientWidth}`);
  await screenshot('07-persisted-tombstone-mobile.png');

  record('BROWSER-NO-PAGE-ERRORS', pageErrors.length === 0,
    pageErrors.length === 0 ? 'No uncaught page errors' : pageErrors.join(' | '));
}

async function writeEvidence() {
  const payload = {
    gate: 'R2B_DESTRUCTIVE_ADMIN_UI_REAL_RUNTIME_ACCEPTANCE',
    executedAt: new Date().toISOString(),
    featureHead: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repositoryDirectory,
      encoding: 'utf8',
    }).trim(),
    runtime: {
      vite: 'real',
      fastify: 'real',
      postgresql: 'disposable-real',
      browser: 'playwright-chromium',
    },
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
  const environment = commandEnvironment();
  ensureServerEnvironmentFile(environment);
  await runCommand('npm', ['run', 'build'], { cwd: serverDirectory, env: environment });
  await runCommand('npm', ['run', 'migrate'], { cwd: serverDirectory, env: environment });
  record('POSTGRES-MIGRATIONS-001-035', true, 'All repository migrations completed on the disposable database');

  const credentials = {
    email: 'r2b-admin@example.test',
    password: `R2B-${randomBytes(18).toString('base64url')}!`,
  };
  const fixture = await seedFixture(credentials.email, credentials.password);

  serverProcess = startProcess('fastify', 'npm', ['run', 'start:prod'], {
    cwd: serverDirectory,
    env: environment,
  });
  await waitForHttp(`${serverOrigin}/api/health`, serverProcess);

  const webEnvironment = { ...process.env };
  delete webEnvironment.DATABASE_URL;
  delete webEnvironment.TEST_DATABASE_URL;
  delete webEnvironment.R2B_ADMIN_DATABASE_URL;
  viteProcess = startProcess('vite', 'npm', [
    'run', 'dev', '--', '--host', '127.0.0.1', '--port', '5173', '--strictPort',
  ], {
    cwd: webDirectory,
    env: webEnvironment,
  });
  await waitForHttp(webOrigin, viteProcess);

  await runBrowserAcceptance(credentials, fixture);
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
    if (!failure) record('POSTGRES-DISPOSABLE-DROPPED', true, 'Disposable PostgreSQL database was removed');
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
console.info(`R2B runtime acceptance passed (${results.length} assertions).`);
