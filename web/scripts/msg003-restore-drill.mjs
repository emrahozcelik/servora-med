#!/usr/bin/env node
/**
 * MSG-003 restore drill (contract docs/features/messaging-module-registry.md §10
 * "Restore" + docs/operations/backup-restore.md).
 *
 * Runs against the real built Fastify server and a disposable PostgreSQL 17
 * cluster with the real pg_dump/pg_restore binaries from the same installation.
 * No application API is mocked; the only synthetic parts are accounts and data.
 *
 * R1: migrated DB, first start with MESSAGING_ENABLED=true (takeover on),
 *     operator switches MESSAGING off, custom-format pg_dump.
 * R2: operator switches MESSAGING on again (state differs from the dump).
 * R3: restore the dump into a new database, run
 *     `operator reset-after-restore`, start the server with
 *     MESSAGING_ENABLED=true; the backup-instant state (MESSAGING off, same
 *     version) must win, every old operator credential must be rejected until
 *     a host re-grant, and a customer must see messaging:false.
 * R4: pre-takeover backup (migrated, server never started, no module rows):
 *     restore into a new database and start with MESSAGING_ENABLED=true; the
 *     takeover must create exactly one MESSAGING row (ENV_TAKEOVER) and one
 *     MODULE_STATE_TAKEN_OVER event.
 *
 * Evidence (results JSON and markdown) is written under
 * docs/evidence/msg003-messaging-module/. Raw run logs are not committed: they go
 * to $FLEET_EVIDENCE_DIR when set, else to an OS temp directory. Dump files are NOT
 * retained because they contain operator password and session hashes; only size and
 * SHA-256 are recorded. Passwords, cookies and database URLs with credentials are
 * never written to evidence.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repositoryDirectory = fileURLToPath(new URL('../../', import.meta.url));
const serverDirectory = fileURLToPath(new URL('../../server/', import.meta.url));
const evidenceDirectory = fileURLToPath(new URL('../../docs/evidence/msg003-messaging-module/', import.meta.url));
const fleetEvidenceDirectory = process.env.FLEET_EVIDENCE_DIR?.trim() || null;
// Raw run logs stay out of the repository: FLEET_EVIDENCE_DIR when the runner sets it, else an OS temp dir.
const logDirectory = fleetEvidenceDirectory || mkdtempSync(`${tmpdir()}/servora-msg003-restore-logs-`);
const serverRequire = createRequire(new URL('../../server/package.json', import.meta.url));
const { Client } = serverRequire('pg');

const webOrigin = 'http://127.0.0.1:5173';
const postgresBinCandidates = [
  process.env.MSG003_POSTGRES_BIN,
  '/opt/homebrew/opt/postgresql@17/bin',
  '/opt/homebrew/opt/postgresql@18/bin',
  '/opt/homebrew/opt/postgresql/bin',
].filter(Boolean);
const postgresBin = postgresBinCandidates.find((candidate) => (
  existsSync(`${candidate}/initdb`)
  && existsSync(`${candidate}/pg_ctl`)
  && existsSync(`${candidate}/pg_dump`)
  && existsSync(`${candidate}/pg_restore`)
  && existsSync(`${candidate}/postgres`)
));
if (!postgresBin) {
  throw new Error('A PostgreSQL installation with initdb/pg_ctl/pg_dump/pg_restore is required');
}
const postgresVersion = execFileSync(`${postgresBin}/postgres`, ['--version'], { encoding: 'utf8' }).trim();
if (!/PostgreSQL\) 17\./.test(postgresVersion)) {
  throw new Error(`PostgreSQL 17 is required for the MSG-003 restore drill, got: ${postgresVersion}`);
}

mkdirSync(evidenceDirectory, { recursive: true });
mkdirSync(logDirectory, { recursive: true });

const startedAt = new Date().toISOString();
const runSuffix = randomBytes(4).toString('hex');
const assertions = [];
const backups = [];
const scenarioSummaries = new Map();
const scenarioRuns = new Map();
const runLog = [];
const createdDatabases = [];

const scenarioDefinitions = [
  {
    id: 'R1',
    title: 'Migrated DB, first-start takeover on, operator disables MESSAGING, pg_dump',
  },
  {
    id: 'R2',
    title: 'Operator re-enables MESSAGING after the dump (state drift)',
  },
  {
    id: 'R3',
    title: 'Restore + reset-after-restore + restart: backup instant wins, old operator access rejected',
  },
  {
    id: 'R4',
    title: 'Pre-takeover backup restore: takeover creates MESSAGING and one audit event',
  },
];

let currentScenario = null;
let failure = null;
let postgresClusterDirectory = '';
let temporaryDirectory = '';
let postgresStarted = false;
let adminDatabaseUrl = '';
let serverProcess = null;
let serverOrigin = '';
let serverPort = 0;
let serverEnvironmentFileCreated = false;
let postgresVersionOutput = '';

let operatorEmail = '';
let operatorPassword = '';
let customerCredentials = null;

function sanitize(value) {
  return String(value)
    .replaceAll(/postgres(?:ql)?:\/\/[^@\s]+@/gi, 'postgresql://***@')
    .replaceAll(/(servora_(?:operator_)?session=)[^\s;]+/g, '$1***')
    .slice(0, 4_000);
}

function logLine(line) {
  const entry = `[${new Date().toISOString()}] ${sanitize(line)}`;
  runLog.push(entry);
  console.info(entry);
}

function scenarioState(id) {
  return scenarioRuns.get(id) ?? null;
}

function record(scenario, check, passed, observed) {
  const entry = {
    scenario,
    check,
    status: passed ? 'PASS' : 'FAIL',
    observed: sanitize(observed),
  };
  assertions.push(entry);
  logLine(`${scenario}/${check}: ${entry.status} - ${entry.observed}`);
  if (!passed) throw new Error(`${scenario}/${check}: ${entry.observed}`);
}

function beginScenario(id) {
  currentScenario = id;
  scenarioRuns.set(id, {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: 'RUNNING',
  });
}

function completeScenario(id, summary) {
  const run = scenarioState(id);
  run.finishedAt = new Date().toISOString();
  run.status = 'PASS';
  scenarioSummaries.set(id, sanitize(summary));
  currentScenario = null;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assertGroup(label, condition, observed) {
  record(currentScenario, label, condition, observed);
}

async function runCommand(label, command, args, options = {}) {
  logLine(`$ [${label}] ${command} ${args.join(' ')}`);
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  if (options.stdin !== undefined) child.stdin.end(options.stdin);
  else child.stdin.end();
  const [code, signal] = await once(child, 'exit');
  for (const line of output.trimEnd().split('\n')) {
    if (line) logLine(`[${label}] ${line}`);
  }
  if (code !== 0) {
    throw new Error(`${label} exited with ${code ?? signal}: ${output.slice(-1_500)}`);
  }
  return output;
}

function startProcess(label, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => logLine(`[${label}] ${chunk.toString().trimEnd()}`));
  child.stderr.on('data', (chunk) => logLine(`[${label}] ${chunk.toString().trimEnd()}`));
  return child;
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), delay(8_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
}

async function waitForHttp(url, child, timeoutMilliseconds = 45_000) {
  const startedWaiting = Date.now();
  while (Date.now() - startedWaiting < timeoutMilliseconds) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`Process exited before ${url} became ready`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Expected while the process starts.
    }
    await delay(200);
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
  postgresClusterDirectory = mkdtempSync('/private/tmp/servora-msg003-restore-');
  const postgresPort = await reserveLoopbackPort();
  await runCommand('initdb', `${postgresBin}/initdb`, [
    '-D', postgresClusterDirectory,
    '--auth=trust',
    `--username=servora_msg003_${runSuffix}`,
    '--encoding=UTF8',
    '--no-locale',
  ], { cwd: repositoryDirectory, env: { ...process.env, LC_ALL: 'C' } });
  await runCommand('pg_ctl:start', `${postgresBin}/pg_ctl`, [
    '-D', postgresClusterDirectory,
    '-l', `${postgresClusterDirectory}/postgres.log`,
    '-o', `-h 127.0.0.1 -p ${postgresPort} -F`,
    'start', '-w',
  ], { cwd: repositoryDirectory, env: { ...process.env, LC_ALL: 'C' } });
  postgresStarted = true;
  adminDatabaseUrl = `postgresql://servora_msg003_${runSuffix}@127.0.0.1:${postgresPort}/postgres`;
  postgresVersionOutput = execFileSync(`${postgresBin}/postgres`, ['--version'], { encoding: 'utf8' }).trim();
  logLine(`Isolated PostgreSQL cluster ready: ${postgresVersionOutput}`);
  serverPort = await reserveLoopbackPort();
  serverOrigin = `http://127.0.0.1:${serverPort}`;
}

async function stopIsolatedPostgres() {
  if (postgresStarted) {
    await runCommand('pg_ctl:stop', `${postgresBin}/pg_ctl`, [
      '-D', postgresClusterDirectory, 'stop', '-m', 'fast', '-w',
    ], { cwd: repositoryDirectory });
    postgresStarted = false;
  }
}

function databaseUrlFor(name) {
  const url = new URL(adminDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function withAdmin(run) {
  const client = new Client({ connectionString: adminDatabaseUrl });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

function assertSafeDatabaseName(name) {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error('Unsafe disposable database name');
}

async function createDisposableDatabase(name) {
  assertSafeDatabaseName(name);
  await withAdmin((client) => client.query(`CREATE DATABASE "${name}"`));
  createdDatabases.push(name);
  return databaseUrlFor(name);
}

async function dropDisposableDatabase(name) {
  assertSafeDatabaseName(name);
  await withAdmin(async (client) => {
    await client.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [name],
    );
    await client.query(`DROP DATABASE IF EXISTS "${name}"`);
  });
}

async function query(databaseUrl, sql, parameters = []) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await client.query(sql, parameters);
  } finally {
    await client.end();
  }
}

function jsonRows(result) {
  return result.rows.map((row) => JSON.parse(JSON.stringify(row)));
}

function ensureServerEnvironmentFile(databaseUrl) {
  const environmentFile = `${serverDirectory}/.env`;
  if (existsSync(environmentFile)) return;
  writeFileSync(environmentFile, `DATABASE_URL=${databaseUrl}\n`, { mode: 0o600 });
  serverEnvironmentFileCreated = true;
}

function applicationEnvironment(databaseUrl, messagingEnabled) {
  return {
    ...process.env,
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: String(serverPort),
    CORS_ORIGIN: webOrigin,
    TRUSTED_PROXY: 'loopback',
    DATABASE_URL: databaseUrl,
    HEALTH_SCHEMA_VERSION: '',
    LOG_LEVEL: 'warn',
    LOGIN_RATE_LIMIT_MAX: '100',
    OVERVIEW_DASHBOARD_ENABLED: 'false',
    MESSAGING_ENABLED: messagingEnabled ? 'true' : 'false',
    CALENDAR_ENABLED: 'false',
    WEB_PUSH_ENABLED: 'false',
    ACTION_SCOPED_GEOLOCATION_ENABLED: 'false',
    CRM_DUPLICATE_COMPARISON_ENABLED: 'false',
    BACKUP_ENABLED: 'false',
    DEMO_DATA_CREATION_ENABLED: 'false',
  };
}

async function migrateDatabase(databaseUrl, label) {
  await runCommand(`migrate:${label}`, 'npm', ['run', 'migrate'], {
    cwd: serverDirectory,
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  const versions = jsonRows(await query(
    databaseUrl,
    'SELECT version FROM schema_migrations ORDER BY version ASC',
  )).map((row) => row.version);
  const head = versions.at(-1) ?? '';
  return { count: versions.length, head };
}

async function bootstrapCustomer(databaseUrl) {
  const credentials = {
    email: `msg003-customer-${runSuffix}@example.test`,
    password: `Msg003-Customer-${randomBytes(10).toString('base64url')}!A7`,
  };
  await runCommand('bootstrap:admin', 'npm', ['run', 'bootstrap:admin'], {
    cwd: serverDirectory,
    env: {
      ...applicationEnvironment(databaseUrl, true),
      BOOTSTRAP_ORGANIZATION_NAME: 'MSG-003 Restore Drill',
      BOOTSTRAP_ADMIN_NAME: 'MSG-003 Customer Admin',
      BOOTSTRAP_ADMIN_EMAIL: credentials.email,
      BOOTSTRAP_ADMIN_PASSWORD: credentials.password,
    },
  });
  customerCredentials = credentials;
  return credentials;
}

async function grantOperator(databaseUrl, password) {
  return runCommand('operator:grant', process.execPath, [
    `${serverDirectory}/dist/db/operator-cli-main.js`,
    'grant', '--email', operatorEmail, '--name', 'MSG-003 Operator', '--password-stdin',
  ], {
    cwd: serverDirectory,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdin: `${password}\n`,
  });
}

async function resetAfterRestore(databaseUrl) {
  return runCommand('operator:reset-after-restore', process.execPath, [
    `${serverDirectory}/dist/db/operator-cli-main.js`,
    'reset-after-restore',
  ], {
    cwd: serverDirectory,
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}

async function dumpDatabase(databaseUrl, name) {
  const file = `${temporaryDirectory}/${name}.dump`;
  await runCommand(`pg_dump:${name}`, `${postgresBin}/pg_dump`, [
    '--format=custom',
    '--no-owner',
    '--no-acl',
    '--file', file,
    '--dbname', databaseUrl,
  ], { cwd: repositoryDirectory });
  const bytes = readFileSync(file);
  const artifact = {
    name,
    format: 'custom',
    sizeBytes: statSync(file).size,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  backups.push(artifact);
  logLine(`pg_dump artifact ${name}: ${artifact.sizeBytes} bytes sha256=${artifact.sha256}`);
  return { ...artifact, file };
}

async function restoreDatabase(databaseUrl, dump, name) {
  await runCommand(`pg_restore:${name}`, `${postgresBin}/pg_restore`, [
    '--no-owner',
    '--no-acl',
    '--exit-on-error',
    '--single-transaction',
    '--dbname', databaseUrl,
    dump.file,
  ], { cwd: repositoryDirectory });
}

async function startServer(label, databaseUrl, messagingEnabled) {
  const child = startProcess(`server:${label}`, 'npm', ['run', 'start:prod'], {
    cwd: serverDirectory,
    env: applicationEnvironment(databaseUrl, messagingEnabled),
  });
  await waitForHttp(`${serverOrigin}/api/health`, child);
  return child;
}

async function stopServer() {
  await stopProcess(serverProcess);
  serverProcess = null;
}

async function httpRequest(path, options = {}) {
  const headers = { origin: webOrigin };
  if (options.cookie) headers.cookie = options.cookie;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${serverOrigin}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    // 204 and non-JSON responses.
  }
  return {
    status: response.status,
    body,
    cookie: response.headers.get('set-cookie')?.split(';', 1)[0] ?? null,
  };
}

async function loginOperator(password) {
  const response = await httpRequest('/api/operator/login', {
    method: 'POST',
    body: { email: operatorEmail, password },
  });
  return response;
}

async function customerLogin() {
  return httpRequest('/api/auth/login', {
    method: 'POST',
    body: { email: customerCredentials.email, password: customerCredentials.password },
  });
}

async function listModules(operatorCookie) {
  return httpRequest('/api/operator/modules', { cookie: operatorCookie });
}

function selectModule(response, key = 'MESSAGING') {
  return response.body?.modules?.find((module) => module.key === key) ?? null;
}

function projectModule(module) {
  if (!module) return null;
  return {
    key: module.key,
    enabled: module.enabled,
    version: module.version,
    source: module.source,
    updatedAt: module.updatedAt,
  };
}

async function moduleRows(databaseUrl) {
  return jsonRows(await query(
    databaseUrl,
    `SELECT module_key, enabled, version, source, updated_at, updated_by_operator_id
       FROM installation_module_state
      ORDER BY module_key`,
  ));
}

async function moduleAuditRows(databaseUrl) {
  return jsonRows(await query(
    databaseUrl,
    `SELECT id, actor_kind, event_type, operator_id, target_operator_id, module_key,
            old_value, new_value, occurred_at
       FROM operator_audit_events
      WHERE module_key IS NOT NULL
      ORDER BY id`,
  ));
}

async function operatorAccountRow(databaseUrl) {
  const rows = jsonRows(await query(
    databaseUrl,
    `SELECT id, email, name, is_active, version, updated_at
       FROM operator_accounts
      WHERE lower(email) = lower($1)`,
    [operatorEmail],
  ));
  return rows[0] ?? null;
}

async function activeOperatorSessionCount(databaseUrl) {
  const rows = jsonRows(await query(
    databaseUrl,
    `SELECT COUNT(*)::int AS count
       FROM operator_sessions s
       JOIN operator_accounts a ON a.id = s.operator_id
      WHERE lower(a.email) = lower($1) AND s.revoked_at IS NULL`,
    [operatorEmail],
  ));
  return rows[0].count;
}

async function operatorResetEvents(databaseUrl) {
  return jsonRows(await query(
    databaseUrl,
    `SELECT actor_kind, event_type, target_operator_id, new_value, occurred_at
       FROM operator_audit_events
      WHERE event_type = 'OPERATOR_ACCESS_RESET_BY_RESTORE'
      ORDER BY id`,
  ));
}

async function moduleTakeoverEventCount(databaseUrl, key = 'MESSAGING') {
  const rows = jsonRows(await query(
    databaseUrl,
    `SELECT COUNT(*)::int AS count
       FROM operator_audit_events
      WHERE event_type = 'MODULE_STATE_TAKEN_OVER' AND module_key = $1`,
    [key],
  ));
  return rows[0].count;
}

function newPassword(label) {
  return `Msg003-${label}-${randomBytes(12).toString('base64url')}!A9`;
}

async function runR1() {
  beginScenario('R1');
  const primaryName = `msg003_primary_${runSuffix}`;
  const primaryUrl = await createDisposableDatabase(primaryName);
  ensureServerEnvironmentFile(primaryUrl);
  const migration = await migrateDatabase(primaryUrl, 'primary');
  assertGroup(
    'MIGRATED-TO-HEAD',
    migration.head === '076_assignment_offer_suggested_solution',
    `applied=${migration.count}, head=${migration.head}`,
  );

  await bootstrapCustomer(primaryUrl);
  assertGroup('SYNTHETIC-CUSTOMER-SEEDED', true, `bootstrap:admin completed for ${customerCredentials.email}`);

  operatorEmail = `msg003-operator-${runSuffix}@example.test`;
  operatorPassword = newPassword('Operator');

  serverProcess = await startServer('primary', primaryUrl, true);
  assertGroup('SERVER-FIRST-START', true, `real dist server healthy on ${serverOrigin}`);

  const takeoverRows = await moduleRows(primaryUrl);
  const messagingRow = takeoverRows.find((row) => row.module_key === 'MESSAGING');
  assertGroup(
    'TAKEOVER-MESSAGING-ON',
    messagingRow?.enabled === true
      && messagingRow?.source === 'ENV_TAKEOVER'
      && messagingRow?.version === 1,
    `row=${JSON.stringify(messagingRow)}`,
  );
  const takeoverEvents = await moduleAuditRows(primaryUrl);
  const messagingTakeoverEvents = takeoverEvents.filter(
    (event) => event.event_type === 'MODULE_STATE_TAKEN_OVER' && event.module_key === 'MESSAGING',
  );
  assertGroup(
    'TAKEOVER-SINGLE-EVENT',
    messagingTakeoverEvents.length === 1
      && messagingTakeoverEvents[0].actor_kind === 'SYSTEM'
      && messagingTakeoverEvents[0].new_value?.enabled === true
      && messagingTakeoverEvents[0].new_value?.source === 'ENV_TAKEOVER',
    `events=${JSON.stringify(messagingTakeoverEvents.map((event) => ({
      event_type: event.event_type,
      actor_kind: event.actor_kind,
      new_value: event.new_value,
    })))}`,
  );

  await grantOperator(primaryUrl, operatorPassword);
  const grantRow = await operatorAccountRow(primaryUrl);
  assertGroup(
    'OPERATOR-GRANTED',
    grantRow?.is_active === true,
    `account=${JSON.stringify(grantRow)}`,
  );

  const login = await loginOperator(operatorPassword);
  assertGroup(
    'OPERATOR-LOGIN',
    login.status === 200 && Boolean(login.cookie),
    `status=${login.status}, cookie=${login.cookie ? 'set' : 'missing'}`,
  );
  const operatorCookie = login.cookie;

  const initialModules = await listModules(operatorCookie);
  const initialMessaging = selectModule(initialModules);
  assertGroup(
    'MESSAGING-INITIALLY-ON',
    initialModules.status === 200 && initialMessaging?.enabled === true && initialMessaging?.version === 1,
    `status=${initialModules.status}, module=${JSON.stringify(projectModule(initialMessaging))}`,
  );

  const toggleOff = await httpRequest('/api/operator/modules/MESSAGING', {
    method: 'PUT',
    cookie: operatorCookie,
    body: { enabled: false, expectedVersion: initialMessaging.version },
  });
  assertGroup(
    'OPERATOR-SWITCHES-MESSAGING-OFF',
    toggleOff.status === 200
      && toggleOff.body?.module?.enabled === false
      && toggleOff.body?.module?.version === 2
      && toggleOff.body?.module?.source === 'OPERATOR',
    `status=${toggleOff.status}, module=${JSON.stringify(projectModule(toggleOff.body?.module))}`,
  );

  const afterOff = await listModules(operatorCookie);
  const offModule = selectModule(afterOff);
  assertGroup(
    'MESSAGING-OFF-VISIBLE-TO-OPERATOR',
    afterOff.status === 200 && offModule?.enabled === false && offModule?.version === 2,
    `status=${afterOff.status}, module=${JSON.stringify(projectModule(offModule))}`,
  );

  const backupState = {
    modules: await moduleRows(primaryUrl),
    moduleAudit: await moduleAuditRows(primaryUrl),
    operator: await operatorAccountRow(primaryUrl),
    activeOperatorSessions: await activeOperatorSessionCount(primaryUrl),
    messaging: projectModule(offModule),
    // In-memory only; the cookie is never written to evidence.
    cookie: operatorCookie,
  };
  logLine(`Backup-instant snapshot: ${JSON.stringify({ ...backupState, cookie: 'set' })}`);

  const dump = await dumpDatabase(primaryUrl, `msg003-r1-${runSuffix}`);
  assertGroup(
    'CUSTOM-FORMAT-DUMP-TAKEN',
    dump.sizeBytes > 0 && dump.format === 'custom',
    `sizeBytes=${dump.sizeBytes}, sha256=${dump.sha256}`,
  );

  completeScenario(
    'R1',
    `MESSAGING takeover ON (version 1, ENV_TAKEOVER); operator login 200; PUT off 200 -> version 2; `
    + `dump ${dump.sizeBytes} bytes sha256=${dump.sha256}; backup audit events=${backupState.moduleAudit.length}`,
  );
  return { primaryName, primaryUrl, dump, backupState };
}

async function runR2(primaryUrl, dump) {
  beginScenario('R2');
  const login = await loginOperator(operatorPassword);
  assertGroup('OPERATOR-LOGIN-AFTER-DUMP', login.status === 200 && Boolean(login.cookie), `status=${login.status}`);

  const toggleOn = await httpRequest('/api/operator/modules/MESSAGING', {
    method: 'PUT',
    cookie: login.cookie,
    body: { enabled: true, expectedVersion: 2 },
  });
  assertGroup(
    'OPERATOR-SWITCHES-MESSAGING-ON',
    toggleOn.status === 200
      && toggleOn.body?.module?.enabled === true
      && toggleOn.body?.module?.version === 3
      && toggleOn.body?.module?.source === 'OPERATOR',
    `status=${toggleOn.status}, module=${JSON.stringify(projectModule(toggleOn.body?.module))}`,
  );

  const row = (await moduleRows(primaryUrl)).find((entry) => entry.module_key === 'MESSAGING');
  assertGroup(
    'PRIMARY-STATE-DIFFERS-FROM-DUMP',
    row?.enabled === true && row?.version === 3 && dump.sizeBytes > 0,
    `primary row=${JSON.stringify(row)}; dump captured version 2/off`,
  );

  await stopServer();
  assertGroup('PRIMARY-SERVER-STOPPED', true, 'Primary server stopped before restore work began');

  completeScenario(
    'R2',
    'MESSAGING switched ON again: version 3 / enabled true in the primary database while the dump still holds version 2 / disabled',
  );
}

async function runR3Rest(restoredUrl, backupState, oldCookie) {
  const oldCookieModules = await listModules(oldCookie);
  record(
    'R3',
    'OLD-OPERATOR-COOKIE-REJECTED',
    oldCookieModules.status === 401 && oldCookieModules.body?.code === 'OPERATOR_UNAUTHENTICATED',
    `status=${oldCookieModules.status}, code=${oldCookieModules.body?.code ?? 'none'}`,
  );

  const oldPasswordLogin = await loginOperator(operatorPassword);
  record(
    'R3',
    'OLD-OPERATOR-PASSWORD-REJECTED-BEFORE-REGRANT',
    oldPasswordLogin.status === 401 && oldPasswordLogin.body?.code === 'INVALID_CREDENTIALS',
    `status=${oldPasswordLogin.status}, code=${oldPasswordLogin.body?.code ?? 'none'}`,
  );

  const customerSession = await customerLogin();
  record(
    'R3',
    'CUSTOMER-LOGIN-ON-RESTORED-DB',
    customerSession.status === 200 && Boolean(customerSession.cookie),
    `status=${customerSession.status}`,
  );
  const me = await httpRequest('/api/auth/me', { cookie: customerSession.cookie });
  record(
    'R3',
    'CUSTOMER-ME-REPORTS-MESSAGING-FALSE',
    me.status === 200 && me.body?.user?.capabilities?.messaging === false,
    `status=${me.status}, capabilities=${JSON.stringify(me.body?.user?.capabilities)}`,
  );

  const operatorPasswordAfterRegrant = newPassword('Regrant');
  const regrantOutput = await grantOperator(restoredUrl, operatorPasswordAfterRegrant);
  const regrantRow = await operatorAccountRow(restoredUrl);
  record(
    'R3',
    'HOST-REGRANT-REACTIVATES-ACCOUNT',
    regrantOutput.includes('Reactivated operator')
      && regrantRow?.is_active === true,
    `output=${regrantOutput.trim()}, account=${JSON.stringify(regrantRow)}`,
  );

  const oldPasswordAfterRegrant = await loginOperator(operatorPassword);
  record(
    'R3',
    'OLD-PASSWORD-STILL-REJECTED-AFTER-REGRANT',
    oldPasswordAfterRegrant.status === 401,
    `status=${oldPasswordAfterRegrant.status}, code=${oldPasswordAfterRegrant.body?.code ?? 'none'}`,
  );

  const newLogin = await loginOperator(operatorPasswordAfterRegrant);
  record(
    'R3',
    'NEW-PASSWORD-LOGIN',
    newLogin.status === 200 && Boolean(newLogin.cookie),
    `status=${newLogin.status}, cookie=${newLogin.cookie ? 'set' : 'missing'}`,
  );

  const modules = await listModules(newLogin.cookie);
  const messaging = selectModule(modules);
  record(
    'R3',
    'MODULES-SHOW-BACKUP-INSTANT-AFTER-REGRANT',
    modules.status === 200
      && messaging?.enabled === false
      && messaging?.version === backupState.messaging.version
      && messaging?.source === 'OPERATOR'
      && messaging?.updatedAt === backupState.messaging.updatedAt,
    `status=${modules.status}, module=${JSON.stringify(projectModule(messaging))}, `
    + `backup=${JSON.stringify(backupState.messaging)}`,
  );

  const oldCookieAfterRegrant = await listModules(oldCookie);
  record(
    'R3',
    'OLD-COOKIE-STILL-REJECTED-AFTER-REGRANT',
    oldCookieAfterRegrant.status === 401,
    `status=${oldCookieAfterRegrant.status}`,
  );

  const postLoginResetEvents = await operatorResetEvents(restoredUrl);
  record(
    'R3',
    'SINGLE-RESET-AUDIT-EVENT',
    postLoginResetEvents.length === 1,
    `OPERATOR_ACCESS_RESET_BY_RESTORE events=${postLoginResetEvents.length}`,
  );

  await stopServer();
  completeScenario(
    'R3',
    `Restore returned MESSAGING off at version ${backupState.messaging.version}; reset-after-restore deactivated 1 operator `
    + 'and revoked 1 session; old cookie/password 401; re-grant + new password 200; customer /me messaging=false; '
    + 'MESSAGING_ENABLED=true ignored',
  );
}

async function runR4() {
  beginScenario('R4');
  const sourceName = `msg003_pretakeover_${runSuffix}`;
  const sourceUrl = await createDisposableDatabase(sourceName);
  const migration = await migrateDatabase(sourceUrl, 'pre-takeover-source');
  assertGroup(
    'PRE-TAKEOVER-SOURCE-MIGRATED-TO-HEAD',
    migration.head === '076_assignment_offer_suggested_solution',
    `applied=${migration.count}, head=${migration.head}`,
  );

  const sourceModules = await moduleRows(sourceUrl);
  const sourceAudit = await moduleAuditRows(sourceUrl);
  assertGroup(
    'SOURCE-HAS-NO-MODULE-STATE',
    sourceModules.length === 0 && sourceAudit.length === 0,
    `moduleRows=${sourceModules.length}, moduleAuditEvents=${sourceAudit.length} (server never started)`,
  );

  const dump = await dumpDatabase(sourceUrl, `msg003-r4-${runSuffix}`);
  const restoredName = `msg003_pre_restored_${runSuffix}`;
  const restoredUrl = await createDisposableDatabase(restoredName);
  await restoreDatabase(restoredUrl, dump, restoredName);
  assertGroup(
    'PRE-TAKEOVER-BACKUP-RESTORED',
    true,
    `pg_restore completed into ${restoredName}; dump size=${dump.sizeBytes}`,
  );

  serverProcess = await startServer('pre-restored', restoredUrl, true);
  assertGroup(
    'PRE-TAKEOVER-SERVER-STARTED-WITH-ENV-TRUE',
    true,
    'Real built server started on the restored pre-takeover database with MESSAGING_ENABLED=true',
  );

  const rows = await moduleRows(restoredUrl);
  const messagingRow = rows.find((row) => row.module_key === 'MESSAGING');
  assertGroup(
    'TAKEOVER-CREATES-MESSAGING-ROW',
    messagingRow?.enabled === true
      && messagingRow?.version === 1
      && messagingRow?.source === 'ENV_TAKEOVER'
      && messagingRow?.updated_by_operator_id === null,
    `row=${JSON.stringify(messagingRow)}`,
  );
  const overviewRow = rows.find((row) => row.module_key === 'OVERVIEW');
  logLine(`R4 OVERVIEW row=${JSON.stringify(overviewRow)} (recorded, not asserted)`);

  const takeoverEvents = (await moduleAuditRows(restoredUrl)).filter(
    (event) => event.event_type === 'MODULE_STATE_TAKEN_OVER' && event.module_key === 'MESSAGING',
  );
  assertGroup(
    'TAKEOVER-EXACTLY-ONE-MESSAGING-EVENT',
    takeoverEvents.length === 1
      && takeoverEvents[0].actor_kind === 'SYSTEM'
      && takeoverEvents[0].new_value?.enabled === true
      && takeoverEvents[0].new_value?.source === 'ENV_TAKEOVER',
    `events=${JSON.stringify(takeoverEvents.map((event) => ({
      actor_kind: event.actor_kind,
      event_type: event.event_type,
      new_value: event.new_value,
    })))}`,
  );

  operatorEmail = `msg003-operator-r4-${runSuffix}@example.test`;
  operatorPassword = newPassword('R4Operator');
  await grantOperator(restoredUrl, operatorPassword);
  const login = await loginOperator(operatorPassword);
  assertGroup('R4-OPERATOR-LOGIN', login.status === 200 && Boolean(login.cookie), `status=${login.status}`);

  const modules = await listModules(login.cookie);
  const messaging = selectModule(modules);
  assertGroup(
    'TAKEOVER-VISIBLE-ON-MODULES-API',
    modules.status === 200
      && messaging?.enabled === true
      && messaging?.version === 1
      && messaging?.source === 'ENV_TAKEOVER',
    `status=${modules.status}, module=${JSON.stringify(projectModule(messaging))}`,
  );

  await stopServer();
  completeScenario(
    'R4',
    `Pre-takeover dump (no module rows) restored; first start created MESSAGING enabled=true version 1 ENV_TAKEOVER `
    + 'with exactly one MODULE_STATE_TAKEN_OVER event; Modules API confirms it',
  );
}

async function runDrill() {
  await startIsolatedPostgres();
  await runCommand('build', 'npm', ['run', 'build'], { cwd: serverDirectory });

  const r1 = await runR1();
  await runR2(r1.primaryUrl, r1.dump);

  // R3 is split so the old operator cookie captured in R1 is available while the
  // original server process is no longer running.
  beginScenario('R3');
  const restoredName = `msg003_restored_${runSuffix}`;
  const restoredUrl = await createDisposableDatabase(restoredName);
  await restoreDatabase(restoredUrl, r1.dump, restoredName);
  assertGroup('PG-RESTORE-INTO-NEW-DATABASE', true, `pg_restore completed into disposable database ${restoredName}`);

  const restoredModules = await moduleRows(restoredUrl);
  const restoredAudit = await moduleAuditRows(restoredUrl);
  const restoredOperator = await operatorAccountRow(restoredUrl);
  assertGroup(
    'RESTORED-MODULE-STATE-EQUALS-BACKUP-INSTANT',
    JSON.stringify(restoredModules) === JSON.stringify(r1.backupState.modules)
      && JSON.stringify(restoredAudit) === JSON.stringify(r1.backupState.moduleAudit)
      && restoredOperator?.is_active === r1.backupState.operator?.is_active
      && restoredOperator?.version === r1.backupState.operator?.version,
    `modules=${JSON.stringify(restoredModules)}, moduleAuditEvents=${restoredAudit.length}, `
    + `operator=${JSON.stringify(restoredOperator)}`,
  );
  const restoredMessaging = restoredModules.find((row) => row.module_key === 'MESSAGING');
  assertGroup(
    'RESTORED-MESSAGING-OFF-BACKUP-VERSION',
    restoredMessaging?.enabled === false
      && restoredMessaging?.version === r1.backupState.messaging.version
      && restoredMessaging?.source === 'OPERATOR',
    `row=${JSON.stringify(restoredMessaging)}; backupApiRow=${JSON.stringify(r1.backupState.messaging)}`,
  );

  const resetOutput = await resetAfterRestore(restoredUrl);
  assertGroup(
    'RESET-AFTER-RESTORE-COMMAND',
    resetOutput.includes('Operator access reset: 1 account(s) deactivated, 1 session(s) revoked.'),
    resetOutput.trim(),
  );

  const resetOperator = await operatorAccountRow(restoredUrl);
  const activeSessions = await activeOperatorSessionCount(restoredUrl);
  const resetEvents = await operatorResetEvents(restoredUrl);
  assertGroup(
    'OPERATOR-DEACTIVATED-AND-SESSIONS-REVOKED',
    resetOperator?.is_active === false
      && activeSessions === 0
      && resetEvents.length === 1
      && resetEvents[0].actor_kind === 'SYSTEM'
      && resetEvents[0].target_operator_id === resetOperator.id
      && resetEvents[0].new_value?.revokedSessions === 1,
    `account=${JSON.stringify(resetOperator)}, activeSessions=${activeSessions}, resetEvents=${JSON.stringify(resetEvents)}`,
  );

  const postResetModules = await moduleRows(restoredUrl);
  assertGroup(
    'RESET-LEAVES-MODULE-STATE-AT-BACKUP-INSTANT',
    JSON.stringify(postResetModules) === JSON.stringify(r1.backupState.modules),
    `modules=${JSON.stringify(postResetModules)}`,
  );

  serverProcess = await startServer('restored', restoredUrl, true);
  assertGroup(
    'RESTORED-SERVER-STARTED-WITH-ENV-TRUE',
    true,
    'Real built server started on the restored database with MESSAGING_ENABLED=true',
  );

  const startedRows = await moduleRows(restoredUrl);
  const startedMessaging = startedRows.find((row) => row.module_key === 'MESSAGING');
  assertGroup(
    'ENV-IGNORED-AFTER-RESTORE',
    startedMessaging?.enabled === false && startedMessaging?.version === r1.backupState.messaging.version,
    `row=${JSON.stringify(startedMessaging)} (env MESSAGING_ENABLED=true)`,
  );
  const takeoverAfterRestore = await moduleTakeoverEventCount(restoredUrl, 'MESSAGING');
  assertGroup(
    'NO-NEW-TAKEOVER-EVENT-ON-RESTORE',
    takeoverAfterRestore === 1,
    `MESSAGING MODULE_STATE_TAKEN_OVER events=${takeoverAfterRestore} (the one restored from the backup)`,
  );

  await runR3Rest(restoredUrl, r1.backupState, r1.backupState.cookie);
  await runR4();
}

async function writeEvidence() {
  const finishedAt = new Date().toISOString();
  const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryDirectory, encoding: 'utf8' }).trim();
  let branch = '';
  try {
    branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repositoryDirectory, encoding: 'utf8',
    }).trim();
  } catch {
    branch = 'unknown';
  }

  const scenarios = scenarioDefinitions.map((definition) => {
    const run = scenarioState(definition.id);
    const checks = assertions.filter((entry) => entry.scenario === definition.id);
    return {
      id: definition.id,
      title: definition.title,
      status: run?.status ?? 'NOT_RUN',
      startedAt: run?.startedAt ?? null,
      finishedAt: run?.finishedAt ?? null,
      summary: scenarioSummaries.get(definition.id) ?? null,
      checks,
    };
  });

  const passedChecks = assertions.filter((entry) => entry.status === 'PASS').length;
  const payload = {
    gate: 'MSG003_RESTORE_DRILL_REAL_RUNTIME',
    scenario: 'MSG-003 restore/reset acceptance (contract §10)',
    executedAt: startedAt,
    finishedAt,
    featureHead: commitSha,
    branch,
    result: failure ? 'FAIL' : 'PASS',
    runtime: {
      postgresql: postgresVersionOutput,
      postgresBin,
      server: 'real Fastify production build (dist/index.js)',
      dumpRestore: 'real pg_dump/pg_restore custom format from the same PostgreSQL 17 installation',
      database: 'isolated disposable cluster in /private/tmp, removed at the end',
      applicationApiMocked: false,
    },
    assertionCounts: { total: assertions.length, passed: passedChecks, failed: assertions.length - passedChecks },
    scenarios,
    assertions,
    backups,
    failure: failure ? sanitize(failure instanceof Error ? failure.message : failure) : null,
  };

  writeFileSync(
    `${evidenceDirectory}/restore-results.json`,
    `${JSON.stringify(payload, null, 2)}\n`,
  );

  const scenarioRows = scenarios.map((scenario) => (
    `| ${scenario.id} | ${scenario.title} | **${scenario.status}** | ${scenario.startedAt ?? '-'} | ${scenario.checks.length} |`
  )).join('\n');

  const observationRows = scenarios.map((scenario) => {
    const checks = scenario.checks.map((check) => (
      `- ${check.status === 'PASS' ? 'PASS' : 'FAIL'} \`${check.check}\`: ${check.observed}`
    )).join('\n');
    return `### ${scenario.id} — ${scenario.title}\n\nResult: **${scenario.status}**\n\n${scenario.summary ? `Summary: ${scenario.summary}\n\n` : ''}${checks || 'No assertions recorded.'}`;
  }).join('\n\n');

  const markdown = `# MSG-003 restore drill — evidence

- Result: **${payload.result}** (${passedChecks}/${assertions.length} assertions passed)
- Executed: ${startedAt} → ${finishedAt}
- Application commit under test: \`${commitSha}\` (branch \`${branch}\`; the harness and evidence are committed as its child)
- Runtime: ${postgresVersionOutput}; real Fastify production build; real \`pg_dump\`/\`pg_restore\` custom format.
- Command: \`node web/scripts/msg003-restore-drill.mjs\`
- Isolated resources: disposable PostgreSQL cluster in \`/private/tmp\` (random port), disposable databases, real built server on a loopback port. Everything was removed at the end.

## Scenarios

| ID | Scenario | Result | Started | Checks |
| -- | -------- | ------ | ------- | ------ |
${scenarioRows}

## Recorded observations

${observationRows}

## Backup artifacts

${backups.length === 0 ? 'No dump was produced.' : backups.map((artifact) => (
  `- \`${artifact.name}\`: format=${artifact.format}, sizeBytes=${artifact.sizeBytes}, sha256=\`${artifact.sha256}\``
)).join('\n')}

Dump files are not retained and are not part of the evidence: a dump contains
operator password and session hashes. Only the size and SHA-256 are recorded.

## Limits / not covered

- No staging environment exists (docs/operations/staging-contract.md); this is a
  local drill against the real application and real PostgreSQL, not production acceptance.
- This drill is server/database level. No browser/UI flow is exercised, so no
  screenshots are attached; the operator Modules page and customer menu behaviour
  belong to the separate MSG-003 UI acceptance.
- Only one restore cycle and one pre-takeover restore are covered. BR7 new-target
  cutover, host recovery cutover, offsite backups and dump encryption are not
  exercised.
- The drill runs on a single PostgreSQL 17 installation (dump and target same
  major version); cross-version restore is not covered.
- No concurrency is exercised around takeover/restore; MS1's concurrent-startup
  and MS10's version-conflict scenarios are covered by the server test suite and
  the separate messaging acceptance, not here.
- The customer account is bootstrapped synthetic data; no medical/dental business
  records are needed for this drill.
- \`pg_dump\` was taken while the primary server was running (consistent snapshot),
  which mirrors the backup worker's live-database path, not a quiesced maintenance window.

## Files

- \`restore-results.json\` — every assertion, scenario status and backup artifact digest.
- \`restore-drill.md\` — this report.
- The raw run log (\`restore-run.log\`) is not committed: the harness writes it to
  \`$FLEET_EVIDENCE_DIR\` when set, else to an OS temp directory.
`;

  writeFileSync(`${evidenceDirectory}/restore-drill.md`, markdown);
  writeFileSync(`${logDirectory}/restore-run.log`, `${runLog.join('\n')}\n`);

  if (fleetEvidenceDirectory) {
    mkdirSync(fleetEvidenceDirectory, { recursive: true });
    for (const fileName of ['restore-results.json', 'restore-drill.md']) {
      copyFileSync(`${evidenceDirectory}/${fileName}`, `${fleetEvidenceDirectory}/${fileName}`);
    }
  }

  logLine(`Evidence written to ${evidenceDirectory}`);
}

async function cleanup() {
  await stopServer();
  for (const name of createdDatabases.reverse()) {
    try {
      await dropDisposableDatabase(name);
    } catch (error) {
      failure ??= error;
    }
  }
  try {
    await stopIsolatedPostgres();
  } catch (error) {
    failure ??= error;
  }
  if (serverEnvironmentFileCreated) {
    const environmentFile = `${serverDirectory}/.env`;
    if (existsSync(environmentFile)) unlinkSync(environmentFile);
    serverEnvironmentFileCreated = false;
  }
  if (temporaryDirectory) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = '';
  }
  if (postgresClusterDirectory) {
    if (!postgresClusterDirectory.startsWith('/private/tmp/servora-msg003-restore-')) {
      throw new Error('Refusing to remove an unexpected PostgreSQL cluster path');
    }
    rmSync(postgresClusterDirectory, { recursive: true, force: true });
    postgresClusterDirectory = '';
  }
}

try {
  temporaryDirectory = mkdtempSync('/private/tmp/servora-msg003-restore-dumps-');
  await runDrill();
} catch (error) {
  failure = error;
  if (currentScenario) {
    const run = scenarioState(currentScenario);
    if (run) {
      run.status = 'FAIL';
      run.finishedAt = new Date().toISOString();
    }
  }
  logLine(`FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
} finally {
  try {
    await cleanup();
  } catch (cleanupError) {
    failure ??= cleanupError;
    console.error('Cleanup failed', cleanupError);
  }
  try {
    await writeEvidence();
  } catch (evidenceError) {
    failure ??= evidenceError;
    console.error('Could not write evidence', evidenceError);
  }
}

if (failure) throw failure;
console.info(`MSG-003 restore drill passed (${assertions.length} assertions).`);
