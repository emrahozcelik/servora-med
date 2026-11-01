// Disposable Linux/amd64 + systemd + PostgreSQL 17 fixture for the emergency
// handoff host acceptance. Never run outside the authorized isolated host.
import assert from 'node:assert/strict';
import {hostname} from 'node:os';
import {
  copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  readlinkSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, chmodSync,
  chownSync,
  readSync, openSync, closeSync, constants,
} from 'node:fs';
import {createHash, randomUUID} from 'node:crypto';
import {execFileSync, spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {environmentBaseline} from '../scripts/deployment-controller.mjs';
import {
  initialAttempt, appendRootCheckpoint, advanceAttempt, admissionConfirmation,
  readLatestCheckpoint,
} from '../scripts/deployment-attempt.mjs';
import {
  SOURCE_POLICY, CHRONY_CONFIG_SHA256, NTS_SOURCES,
} from '../scripts/trusted-time.mjs';

assert.equal(hostname(), 'lima-servora-r4-20261012');
assert.equal(process.getuid(), 0);
assert.equal(readFileSync('/proc/1/comm', 'utf8').trim(), 'systemd');

export const SOURCE = process.env.SERVORA_EH_SOURCE ?? '/tmp/servora-eh-src';
export const TARGET_SHA = 'e4ca2b19f7865dca3f1e4597dd099ed167667a19';
export const OLD_SHA = '71ae6df6dd0659ed6390a6785d4bab29ddf5b1fa';
export const FIXTURE_ROOT = '/var/lib/servora-eh-fixture';
const STATE = '/var/lib/servora-med/deploy';
const EMERGENCY = STATE + '/emergency';
const INSTALLED = '/usr/local/libexec/servora-med';
const ARTIFACT = '/usr/local/libexec/servora-med-emergency';
const DROPIN = '/etc/systemd/system/servora-med.service.d/90-servora-recovery.conf';
const UNIT = '/etc/systemd/system/servora-med.service';
const ENV = '/etc/servora-med/servora-med.env';
const DB_NAME = 'servora_med_test_eh';
const DB_ROLE = 'servora_r4_app';
const DB_PASSWORD = 'fixture-only-not-a-secret';
const BASE_WALL = Date.parse('2026-11-01T06:00:00.000Z');
const hash = value => createHash('sha256').update(value).digest('hex');

function run(command, args, options = {}) {
  return execFileSync(command, args, {encoding: 'utf8', timeout: 120000, ...options});
}
function psql(sql, database = 'postgres') {
  return run('/usr/bin/sudo', ['-u', 'postgres', '/usr/bin/psql', '--no-psqlrc', '-v',
    'ON_ERROR_STOP=1', '-d', database, '-Atc', sql]);
}
function write(path, bytes, mode = 0o600) {
  writeFileSync(path, bytes, {mode});
  chmodSync(path, mode);
  chownSync(path, 0, 0);
}
function mkdir(path, mode = 0o700) {
  mkdirSync(path, {recursive: true, mode});
  chmodSync(path, mode);
  chownSync(path, 0, 0);
}
function rm(path) { rmSync(path, {recursive: true, force: true}); }

function catalogue(root) {
  return readdirSync(root).filter(name => /^[0-9]{3}_[a-z0-9_]+\.sql$/.test(name)).sort()
    .map(name => ({version: name.slice(0, -4), sha256: hash(readFileSync(join(root, name)))}));
}

function contentManifest(root) {
  const entries = [];
  const walk = relative => {
    const path = join(root, relative);
    const info = lstatSync(path);
    if (info.uid !== 0 || (!info.isSymbolicLink() && (info.mode & 0o022) !== 0)) {
      throw new Error('FIXTURE_RELEASE_UNTRUSTED ' + relative);
    }
    if (info.isSymbolicLink()) {
      entries.push([relative, 'l ' + relative + ' ' + readlinkSync(path)]);
    } else if (info.isDirectory()) {
      if (relative !== '.') entries.push([relative, 'd ' + relative]);
      for (const name of readdirSync(path)) {
        if (relative === '.' && ['.servora-release-artifact.sha256',
          '.servora-release-content.sha256'].includes(name)) continue;
        walk(relative === '.' ? './' + name : relative + '/' + name);
      }
    } else if (info.isFile() && info.nlink === 1) {
      entries.push([relative, 'f ' + relative + ' ' + hash(readFileSync(path))]);
    } else {
      throw new Error('FIXTURE_RELEASE_UNTRUSTED ' + relative);
    }
  };
  walk('.');
  entries.sort(([a, lineA], [b, lineB]) =>
    Buffer.compare(Buffer.from(lineA[0] + ' ' + a), Buffer.from(lineB[0] + ' ' + b)));
  return entries.map(([, line]) => line).join('\n') + '\n';
}

function waitHealth(releaseSha, seconds = 30) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const result = spawnSync('/usr/bin/curl', ['--silent', '--max-time', '2',
      'http://127.0.0.1:3000/api/health'], {encoding: 'utf8'});
    try {
      const body = JSON.parse(result.stdout);
      if (result.status === 0 && body.status === 'ok' && body.releaseSha === releaseSha) return;
    } catch { /* retry */ }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw new Error('FIXTURE_HEALTH_TIMEOUT');
}

function timeClock(startWallMs) {
  const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  const timeNamespaceId = readlinkSync('/proc/self/ns/time');
  const bootMs = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]) * 1000;
  let last = -1;
  return delta => {
    assert.ok(delta > last, 'fixture clock must advance');
    last = delta;
    const lower = Math.floor(bootMs + delta);
    return {
      formatVersion: 2, source: 'linux-boottime', bootId, timeNamespaceId,
      bootLowerMs: lower, bootUpperMs: lower + 5, wallResolutionMs: 1,
      wallAtUTC: new Date(startWallMs + delta).toISOString(),
      synchronization: {
        service: 'chrony', referenceAgeMs: 1000, rootDistanceMs: 1, correctionMs: 0,
        sourceCount: 3, sourcePolicy: SOURCE_POLICY, configSha256: CHRONY_CONFIG_SHA256,
        configuredSourceCount: 3, authenticatedSourceCount: 3,
        selectableSources: [...NTS_SOURCES].sort(), selectedSource: 'bevtime1.metrologie.at',
      },
    };
  };
}

function buildRelease(sha) {
  const root = `/opt/servora-med/releases/${sha}`;
  rm(root);
  mkdir('/opt/servora-med/releases', 0o755);
  mkdir(root, 0o755);
  for (const directory of ['ops/scripts', 'ops/systemd', 'server/dist/db/migrations']) {
    mkdir(join(root, directory), 0o755);
  }
  for (const name of readdirSync(join(SOURCE, 'ops/scripts')).filter(name =>
    lstatSync(join(SOURCE, 'ops/scripts', name)).isFile())) {
    copyFileSync(join(SOURCE, 'ops/scripts', name), join(root, 'ops/scripts', name));
    const mode = name === 'deploy-production-host.sh' ? 0o750
      : ['deployment-attempt.mjs', 'deployment-controller.mjs', 'deployment-db-guard.mjs',
        'migration-reconciliation.mjs', 'trusted-time.mjs', 'host-operation-lock.sh'].includes(name)
        ? 0o650 : 0o644;
    chmodSync(join(root, 'ops/scripts', name), mode);
    chownSync(join(root, 'ops/scripts', name), 0, 0);
  }
  copyFileSync(join(SOURCE, 'ops/systemd/servora-med.service'),
    join(root, 'ops/systemd/servora-med.service'));
  chmodSync(join(root, 'ops/systemd/servora-med.service'), 0o640);
  chownSync(join(root, 'ops/systemd/servora-med.service'), 0, 0);
  for (const name of readdirSync(join(SOURCE, 'server/src/db/migrations'))) {
    copyFileSync(join(SOURCE, 'server/src/db/migrations', name),
      join(root, 'server/dist/db/migrations', name));
    chmodSync(join(root, 'server/dist/db/migrations', name), 0o640);
    chownSync(join(root, 'server/dist/db/migrations', name), 0, 0);
  }
  write(join(root, 'server/package.json'),
    JSON.stringify({name: 'servora-fixture', private: true, type: 'module'}) + '\n', 0o644);
  write(join(root, 'server/dist/index.js'), `
import {createServer} from 'node:http';
const releaseSha = process.env.SERVORA_RELEASE_SHA;
createServer((request, response) => {
  if (request.url === '/api/health') {
    response.writeHead(200, {'content-type': 'application/json'});
    response.end(JSON.stringify({status: 'ok', releaseSha}));
    return;
  }
  if (request.url === '/api/health/backup') {
    response.writeHead(200, {'content-type': 'application/json'});
    response.end(JSON.stringify({status: 'ok', releaseSha}));
    return;
  }
  response.writeHead(404); response.end();
}).listen(3000, '127.0.0.1');
`, 0o644);
  run('/usr/bin/tar', ['-czf', '/tmp/eh-release-' + sha + '.tar.gz', '-C', root, '.']);
  const artifactSha256 = hash(readFileSync('/tmp/eh-release-' + sha + '.tar.gz'));
  mkdir(STATE + '/artifacts', 0o700);
  copyFileSync('/tmp/eh-release-' + sha + '.tar.gz', STATE + '/artifacts/' + sha + '.tar.gz');
  chmodSync(STATE + '/artifacts/' + sha + '.tar.gz', 0o600);
  chownSync(STATE + '/artifacts/' + sha + '.tar.gz', 0, 0);
  write(join(root, '.servora-release-artifact.sha256'), artifactSha256 + '\n', 0o600);
  write(join(root, '.servora-release-content.sha256'), contentManifest(root), 0o600);
  unlinkSync('/tmp/eh-release-' + sha + '.tar.gz');
  return {root, artifactSha256, catalog: catalogue(join(root, 'server/dist/db/migrations'))};
}

function installTooling() {
  rm(INSTALLED);
  mkdir(INSTALLED, 0o755);
  for (const name of readdirSync(join(SOURCE, 'ops/scripts')).filter(name =>
    lstatSync(join(SOURCE, 'ops/scripts', name)).isFile())) {
    if (!name.endsWith('.mjs') && name !== 'host-operation-lock.sh') continue;
    copyFileSync(join(SOURCE, 'ops/scripts', name), join(INSTALLED, name));
    chmodSync(join(INSTALLED, name), 0o644);
    chownSync(join(INSTALLED, name), 0, 0);
  }
  copyFileSync(join(SOURCE, 'ops/scripts/deploy-production-host.sh'),
    join(INSTALLED, 'deploy-production-host'));
  chmodSync(join(INSTALLED, 'deploy-production-host'), 0o755);
  chownSync(join(INSTALLED, 'deploy-production-host'), 0, 0);
  chmodSync(INSTALLED, 0o755);
  chownSync(INSTALLED, 0, 0);

  rm(ARTIFACT);
  mkdir(ARTIFACT, 0o755);
  for (const name of ['emergency-handoff-artifact.mjs', 'emergency-handoff.mjs',
    'emergency-handoff-host.mjs', 'issue-emergency-handoff.mjs']) {
    copyFileSync(join(SOURCE, 'ops/scripts', name), join(ARTIFACT, name));
    chmodSync(join(ARTIFACT, name),
      name === 'emergency-handoff.mjs' || name === 'emergency-handoff-artifact.mjs' ? 0o644 : 0o755);
    chownSync(join(ARTIFACT, name), 0, 0);
  }
  chownSync(ARTIFACT, 0, 0);
  const script = `
import {writeArtifactManifest} from '${ARTIFACT}/emergency-handoff-artifact.mjs';
writeArtifactManifest('${ARTIFACT}', {uid: 0, gid: 0});
`;
  run('/usr/bin/node', ['--input-type=module', '-e', script]);
  chmodSync(join(ARTIFACT, 'manifest.json'), 0o644);
}

function installUnit() {
  copyFileSync(join(SOURCE, 'ops/systemd/servora-med.service'), UNIT);
  chmodSync(UNIT, 0o644);
  chownSync(UNIT, 0, 0);
  mkdir('/etc/systemd/system/servora-med.service.d', 0o755);
  run('/usr/bin/systemctl', ['daemon-reload']);
}

function buildDatabase() {
  psql(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${DB_NAME}'`);
  psql(`DROP DATABASE IF EXISTS ${DB_NAME}`);
  psql(`DROP ROLE IF EXISTS ${DB_ROLE}`);
  psql(`CREATE ROLE ${DB_ROLE} LOGIN PASSWORD '${DB_PASSWORD}'`);
  psql(`CREATE DATABASE ${DB_NAME} OWNER ${DB_ROLE}`);
  psql('CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())', DB_NAME);
  psql(`ALTER TABLE schema_migrations OWNER TO ${DB_ROLE}`, DB_NAME);
  psql(`GRANT CONNECT ON DATABASE ${DB_NAME} TO ${DB_ROLE}`);
  psql(`GRANT pg_monitor TO ${DB_ROLE}`);
}

function identity() {
  const text = run('/usr/bin/psql', ['--no-psqlrc', '-Atc', `SELECT json_build_object(
    'clusterId', (pg_control_system()).system_identifier::text,
    'databaseName', current_database(),
    'databaseOid', (SELECT oid::text FROM pg_database WHERE datname=current_database()),
    'role', current_user,
    'host', host(inet_server_addr()),
    'port', inet_server_port()::text)`, 'postgresql://' + DB_ROLE + ':' + DB_PASSWORD + '@127.0.0.1:5432/' + DB_NAME],
  {env: {...process.env, PGPASSWORD: DB_PASSWORD}});
  const row = JSON.parse(text);
  return {...row, port: Number(row.port)};
}

function applyCatalog(catalog) {
  psql('TRUNCATE schema_migrations', DB_NAME);
  const values = catalog.map(entry => `('${entry.version}')`).join(',');
  psql(`INSERT INTO schema_migrations(version) VALUES ${values}`, DB_NAME);
}

/**
 * Builds one production-shaped sealed parent and the exact installed identity.
 * Rebuilds are explicit; this is never a migration or artifact acceptance.
 */
export function build() {
  if (existsSync(STATE + '/active.json') || existsSync(STATE + '/activation.block')) {
    throw new Error('FIXTURE_REFUSES_EXISTING_OWNER');
  }
  spawnSync('/usr/bin/systemctl', ['stop', 'servora-med.service']);
  spawnSync('/usr/bin/systemctl', ['reset-failed', 'servora-med.service']);
  for (const account of ['servora-med']) {
    if (spawnSync('/usr/bin/id', [account]).status !== 0) {
      run('/usr/sbin/useradd', ['--system', '--no-create-home', '--shell', '/usr/sbin/nologin', account]);
    }
  }
  rm(FIXTURE_ROOT);
  mkdir(FIXTURE_ROOT, 0o700);
  rm(STATE);
  mkdir(STATE, 0o700);
  for (const directory of ['approvals', 'attempts', 'initializations', 'admission-proofs',
    'backups', 'artifacts', 'emergency']) {
    mkdir(join(STATE, directory), directory === 'approvals' || directory === 'attempts'
      || directory === 'initializations' || directory === 'admission-proofs' ? 0o700 : 0o700);
  }
  write(STATE + '/host.lock', '', 0o600);
  chownSync(STATE + '/host.lock', 0, 0);
  mkdir('/etc/servora-med', 0o755);
  installUnit();
  installTooling();
  rm('/opt/servora-med/current');
  if (!existsSync('/opt/servora-med/node_modules/pg')) {
    run('/usr/bin/npm', ['install', '--prefix', '/opt/servora-med', '--no-audit', '--no-fund', 'pg@8']);
  }
  const target = buildRelease(TARGET_SHA);
  const old = buildRelease(OLD_SHA);
  symlinkSync(target.root, '/opt/servora-med/current');

  buildDatabase();
  applyCatalog(target.catalog);
  const databaseIdentity = identity();
  const envText = [
    'NODE_ENV=production',
    `DATABASE_URL=postgresql://${DB_ROLE}:${DB_PASSWORD}@127.0.0.1:5432/${DB_NAME}`,
    'HEALTH_SCHEMA_VERSION=' + target.catalog.at(-1).version,
    'SERVORA_RELEASE_SHA=' + TARGET_SHA,
    '',
  ].join('\n');
  write(ENV, envText, 0o640);
  chownSync(ENV, 0, Number(run('/usr/bin/id', ['-g', 'servora-med'])));

  run('/usr/bin/systemctl', ['daemon-reload']);
  run('/usr/bin/systemctl', ['start', 'servora-med.service']);
  waitHealth(TARGET_SHA);

  write(DROPIN, '[Service]\nRestart=no\n', 0o600);
  run('/usr/bin/systemctl', ['daemon-reload']);
  assert.equal(run('/usr/bin/systemctl', ['show', 'servora-med.service', '-p', 'Restart', '--value']).trim(), 'no');

  const profile = {
    formatVersion: 2, machineId: readFileSync('/etc/machine-id', 'utf8').trim(),
    fqdn: 'r4.synthetic.invalid', databaseIdentity,
    envBaselineSha256: environmentBaseline(envText),
    contracts: {
      helperSha256: hash(readFileSync(INSTALLED + '/deploy-production-host')),
      nodeSha256: hash(readFileSync('/usr/bin/node')),
      unitSha256: hash(readFileSync(UNIT)),
      attemptModuleSha256: hash(readFileSync(INSTALLED + '/deployment-attempt.mjs')),
      dbGuardModuleSha256: hash(readFileSync(INSTALLED + '/deployment-db-guard.mjs')),
      reconciliationModuleSha256: hash(readFileSync(INSTALLED + '/migration-reconciliation.mjs')),
      controllerModuleSha256: hash(readFileSync(INSTALLED + '/deployment-controller.mjs')),
      timeModuleSha256: hash(readFileSync(INSTALLED + '/trusted-time.mjs')),
      timeConfigSha256: hash(readFileSync('/etc/chrony/chrony.conf')),
    },
  };
  const profileText = JSON.stringify(profile) + '\n';
  write(STATE + '/profile.json', profileText, 0o600);

  const attemptId = randomUUID();
  const clock = timeClock(BASE_WALL);
  const issuedTime = clock(5_000);
  const approval = {
    formatVersion: 2, attemptId, releaseSha: TARGET_SHA,
    treeSha: 'b94bbfb4a7a07249ea4b40ecb1e5c9ebe04ba641',
    artifactSha256: target.artifactSha256, ciManifestSha256: 'd'.repeat(64),
    targetCatalog: target.catalog, oldReleaseSha: OLD_SHA,
    oldArtifactSha256: old.artifactSha256, oldCatalog: old.catalog,
    profileSha256: hash(profileText), issuedTime, issuedAtUTC: issuedTime.wallAtUTC,
    expiresAtUTC: new Date(BASE_WALL + 3 * 60 * 60 * 1000).toISOString(),
    maxStarts: 2, maxAbortStarts: 1, allowMigration: true,
    allowForwardRecovery: true, allowPreMigrationAbort: true,
    allowPostdeployBackup: true,
  };
  const approvalText = JSON.stringify(approval) + '\n';
  write(`${STATE}/approvals/${attemptId}.json`, approvalText, 0o600);
  const approvalSha256 = hash(approvalText);

  // Real retained receipts whose bytes match the sealed checkpoint hashes.
  const pre = Buffer.from('synthetic predeploy dump for the emergency fixture\n');
  const post = Buffer.from('synthetic postdeploy dump for the emergency fixture\n');
  write(`${STATE}/backups/${attemptId}-pre.dump`, pre, 0o600);
  write(`${STATE}/backups/${attemptId}-post.dump`, post, 0o600);
  // Real PostgreSQL archives are not required by the emergency checks, but
  // the retained file shape is.
  const context = {approval, approvalSha256};
  const initial = initialAttempt(context, clock(10_000));
  let checkpoint = appendRootCheckpoint(attemptId, initial);
  linkSync(`${STATE}/attempts/${attemptId}/0000.json`,
    `${STATE}/initializations/${attemptId}.json`);
  const proof = admissionConfirmation(context, initial, clock(11_000));
  write(`${STATE}/admission-proofs/${attemptId}.json`, JSON.stringify(proof) + '\n', 0o600);
  // Same publication protocol as finishInitialization: the verified pair is
  // reduced to the single checkpoint inode before later appends.
  unlinkSync(`${STATE}/initializations/${attemptId}.json`);

  let journal = initial;
  const events = [
    [{kind: 'PREDEPLOY_BACKUP', receipt: {sha256: hash(pre),
      completedAtUTC: clock(12_000).wallAtUTC}}],
    ['FENCED'],
    [{kind: 'MIGRATION_INTENT', baseline: {organizations: 0, admins: 1, staff: 0,
      customers: 0, products: 0, jobs: 0, demoData: 0}}],
    ['DB_EXACT'], ['ENV_INTENT'], ['ENV_ALIGNED'], ['POINTER_INTENT'], ['POINTER_ALIGNED'],
    ['START_INTENT'], ['HEALTH_PASSED'], ['HEALTH_LOST'], ['START_INTENT'],
    ['HEALTH_PASSED'], ['SCHEMA_CHECKED'], ['SMOKE_PASSED'], ['POSTDEPLOY_BACKUP_INTENT'],
    [{kind: 'POSTDEPLOY_BACKUP_PASSED', receipt: {sha256: hash(post),
      completedAtUTC: clock(14_000).wallAtUTC}}],
  ];
  let delta = 20_000;
  for (const event of events) {
    journal = advanceAttempt(journal, context, event[0], clock(delta));
    checkpoint = appendRootCheckpoint(attemptId, {...journal, previousHash: checkpoint.sha256});
    journal = checkpoint.record;
    delta += 1_000;
  }
  assert.equal(journal.phase, 'POSTDEPLOY_BACKUP_PASSED');
  assert.equal(journal.starts, 2);

  write(STATE + '/activation.block',
    JSON.stringify({attemptId, approvalSha256}) + '\n', 0o600);
  write(STATE + '/active.json',
    JSON.stringify({attemptId, approvalSha256}) + '\n', 0o600);
  mkdir('/run/servora-med-recovery', 0o700);

  mkdir(FIXTURE_ROOT + '/saved', 0o700);
  for (const name of ['activation.block', 'active.json']) {
    copyFileSync(STATE + '/' + name, FIXTURE_ROOT + '/saved/' + name);
  }
  copyFileSync(DROPIN, FIXTURE_ROOT + '/saved/policy.conf');
  write(FIXTURE_ROOT + '/identity.json', JSON.stringify({attemptId, approvalSha256,
    targetSha: TARGET_SHA, oldSha: OLD_SHA, preSha256: hash(pre), postSha256: hash(post),
    checkpointSha256: readLatestCheckpoint(attemptId).sha256}, null, 2) + '\n', 0o600);
  return {attemptId, approvalSha256, targetSha: TARGET_SHA, profileSha256: hash(profileText),
    preSha256: hash(pre), postSha256: hash(post),
    checkpointSequence: readdirSync(`${STATE}/attempts/${attemptId}`).length - 1};
}

/** Restores only mutable fixture state; sealed parent records are untouched. */
export function resetMutable() {
  rm(EMERGENCY);
  mkdir(EMERGENCY, 0o700);
  copyFileSync(FIXTURE_ROOT + '/saved/activation.block', STATE + '/activation.block');
  chmodSync(STATE + '/activation.block', 0o600);
  copyFileSync(FIXTURE_ROOT + '/saved/active.json', STATE + '/active.json');
  chmodSync(STATE + '/active.json', 0o600);
  copyFileSync(FIXTURE_ROOT + '/saved/policy.conf', DROPIN);
  chmodSync(DROPIN, 0o600);
  run('/usr/bin/systemctl', ['daemon-reload']);
  const active = run('/usr/bin/systemctl', ['show', 'servora-med.service',
    '-p', 'ActiveState', '--value']).trim();
  if (active !== 'active') {
    run('/usr/bin/systemctl', ['reset-failed', 'servora-med.service']);
    run('/usr/bin/systemctl', ['start', 'servora-med.service']);
  }
  waitHealth(TARGET_SHA);
}

export function restoreCatalog() {
  applyCatalog(catalogue('/opt/servora-med/releases/' + TARGET_SHA + '/server/dist/db/migrations'));
}

export function parentSnapshot(attemptId) {
  const files = [];
  for (const directory of ['attempts/' + attemptId, 'approvals', 'initializations',
    'admission-proofs', 'backups']) {
    for (const name of readdirSync(join(STATE, directory))) {
      const path = join(STATE, directory, name);
      if (lstatSync(path).isFile()) files.push([path, hash(readFileSync(path))]);
    }
  }
  files.push([STATE + '/profile.json', hash(readFileSync(STATE + '/profile.json'))]);
  return files.sort(([left], [right]) => left < right ? -1 : 1);
}

export function serviceFacts() {
  const properties = {};
  for (const line of run('/usr/bin/systemctl', ['show', 'servora-med.service', '-p',
    'ActiveState', '-p', 'MainPID', '-p', 'Restart', '-p', 'DropInPaths',
    '-p', 'NeedDaemonReload', '-p', 'NRestarts']).split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) properties[line.slice(0, at)] = line.slice(at + 1);
  }
  return properties;
}

export function fileSnapshot(path) {
  return existsSync(path) ? hash(readFileSync(path)) : null;
}

/** Metadata/content snapshot that excludes atime (reads may update it). */
export function treeSnapshot(root) {
  if (!existsSync(root)) return null;
  const entries = [];
  const walk = (path, relative) => {
    const info = lstatSync(path);
    entries.push([relative, info.mode, info.uid, info.gid, info.nlink, info.ino,
      info.size, info.mtimeMs, info.ctimeMs,
      info.isSymbolicLink() ? readlinkSync(path) : null,
      info.isFile() ? hash(readFileSync(path)) : null]);
    if (info.isDirectory()) {
      for (const name of readdirSync(path).sort()) walk(join(path, name), relative + '/' + name);
    }
  };
  walk(root, '.');
  return entries;
}

function processStartTime(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
}

/** Every filesystem/systemd/process fact a read-only command must preserve. */
export function readOnlySnapshot(attemptId) {
  const facts = serviceFacts();
  const pid = Number(facts.MainPID);
  return {
    emergency: treeSnapshot(EMERGENCY),
    parent: parentSnapshot(attemptId),
    owner: fileSnapshot(STATE + '/active.json'),
    barrier: fileSnapshot(STATE + '/activation.block'),
    hostLock: fileSnapshot(STATE + '/host.lock'),
    env: fileSnapshot(ENV),
    dropin: fileSnapshot(DROPIN),
    unit: fileSnapshot(UNIT),
    permit: existsSync('/run/servora-med-recovery/start.permit'),
    current: realpathSync('/opt/servora-med/current'),
    service: facts,
    process: pid > 0 ? {pid, startTime: processStartTime(pid)} : null,
  };
}

export function readSealed(path) {
  return readFileSync(path);
}

export function issueAuthorization(attemptId, extra = []) {
  return JSON.parse(run('/usr/bin/node', [ARTIFACT + '/issue-emergency-handoff.mjs',
    '--parent', attemptId, '--expires-minutes', '45',
    '--reason', 'R4_OBSERVATION_TRUSTED_TIME_BLOCKED', ...extra]));
}

export function runHost(mode, environment = {}, args = []) {
  return spawnSync('/usr/bin/node', [ARTIFACT + '/emergency-handoff-host.mjs', mode, ...args], {
    encoding: 'utf8', timeout: 180000, env: {...process.env, ...environment},
  });
}

export function paths() {
  return {STATE, EMERGENCY, INSTALLED, ARTIFACT, DROPIN, UNIT, ENV, DB_NAME};
}
