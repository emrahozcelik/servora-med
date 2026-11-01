#!/usr/bin/node
/** Root-only, fixed-path forward-only 060 -> 060 host adapter.
 * No issuance, installation, migration, rollback or arbitrary-command API.
 * Pure orchestration and evidence validators also run against synthetic ports;
 * this CLI always constructs the real Linux adapter below. */
import {createHash, randomUUID} from 'node:crypto';
import {constants, existsSync, lstatSync, fstatSync, openSync, closeSync, fsyncSync,
  readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync, unlinkSync,
  mkdirSync, renameSync, symlinkSync, fchmodSync, fchownSync} from 'node:fs';
import {execFileSync, spawn, spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {dirname, join, basename} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {runForwardHost, validateHostLog} from './forward-host-driver.mjs';
import {assertEmergencySupersession, validateForwardAuthorizationStructure,
  FORWARD_OBSERVATION_SECONDS, FORWARD_OBSERVATION_MIN_SAMPLES} from './forward-transition.mjs';
import {validateEmergencyHandoffChain} from './emergency-handoff.mjs';
import {digest, seal, verifyForwardCI, verifyObservationProof} from './forward-host-evidence.mjs';
import {sampleTrustedTime, elapsedTime, READER_UNIT_SHA256, READER_SOCKET_UNIT_SHA256,
  validateTimeModuleContract, validateReaderSocketMetadata} from './trusted-time.mjs';
import {canonical, protectedBytes, protectedJson, trustedParents, flushDirectory,
  publishExclusive, openHostJournal} from './forward-host-storage.mjs';

export const PATHS = Object.freeze({
  state: '/var/lib/servora-med/deploy', root: '/var/lib/servora-med/deploy/forward',
  tool: '/usr/local/libexec/servora-med-forward', installed: '/usr/local/libexec/servora-med',
  owner: '/var/lib/servora-med/deploy/active.json', barrier: '/var/lib/servora-med/deploy/activation.block',
  permit: '/run/servora-med-recovery/start.permit', env: '/etc/servora-med/servora-med.env',
  current: '/opt/servora-med/current', unit: '/etc/systemd/system/servora-med.service',
  guard: '/etc/systemd/system/servora-med.service.d/90-servora-forward-guard.conf',
  policy: '/etc/systemd/system/servora-med.service.d/91-servora-forward-budget.conf',
  ticket: '/run/servora-med-forward/start.json',
  collectorUnit: '/etc/systemd/system/servora-med-time-evidence@.service',
  collectorSocket: '/etc/systemd/system/servora-med-time-evidence.socket',
  collectorDropin: '/etc/systemd/system/servora-med-time-evidence@.service.d/90-servora-forward-time.conf',
  timeSocket: '/run/servora-med-time/evidence.sock',
});
export const TOOL_FILES = Object.freeze([
  'forward-host.mjs', 'forward-host-driver.mjs', 'forward-host-storage.mjs', 'forward-host-evidence.mjs',
  'forward-host-probe.mjs', 'forward-transition.mjs', 'emergency-handoff.mjs',
  'migration-reconciliation.mjs', 'deployment-db-guard.mjs', 'trusted-time.mjs', 'required-checks.txt',
]);
const UNIT_NAME = 'servora-med.service';
const HEAD = '060_crm_duplicate_review_decisions';
const CLEAN_ENV = {PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C'};
const POLICY_TEXT = '[Service]\nRestart=no\n';
const GUARD_TEXT = '[Service]\nExecStartPre=+/usr/bin/node ' + PATHS.tool + '/forward-host.mjs start-gate\nReadWritePaths=' + PATHS.root + ' /run/servora-med-forward\n';
const COLLECTOR_TEXT = '[Service]\nExecStart=\nExecStart=/usr/bin/node --no-addons ' + PATHS.tool + '/trusted-time.mjs --collect-chrony\n';
const fail = code => { throw new Error(code); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
function root() { if (process.getuid?.() !== 0 || process.platform !== 'linux') fail('FORWARD_HOST_ROOT_LINUX_REQUIRED'); }
function execute(file, args, options = {}) {
  try { return execFileSync(file, args, {env: CLEAN_ENV, encoding: 'utf8', timeout: 40000,
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024, ...options}); }
  catch { fail('FORWARD_HOST_OPERATION_FAILED'); }
}
const systemctl = (...args) => execute('/usr/bin/systemctl', args).trim();
function unitProperties(unit, keys) {
  const text = systemctl('show', unit, ...keys.flatMap(key => ['-p', key]));
  return {...Object.fromEntries(keys.map(key => [key, ''])), ...Object.fromEntries(text.split('\n').map(line => {
    const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)];
  }))};
}
function properties() {
  const keys = ['ActiveState', 'SubState', 'MainPID', 'NRestarts', 'Restart', 'DropInPaths',
    'NeedDaemonReload', 'User', 'Group', 'WorkingDirectory', 'FragmentPath', 'ExecStart',
    'ExecStartPre', 'EnvironmentFiles', 'InvocationID', 'ControlGroup', 'Job'];
  return unitProperties(UNIT_NAME, keys);
}
function assertCollectorBinding(state) {
  if (fileHash(PATHS.collectorUnit, {mode: 0o644}) !== READER_UNIT_SHA256
    || fileHash(PATHS.collectorSocket, {mode: 0o644}) !== READER_SOCKET_UNIT_SHA256) fail('FORWARD_HOST_COLLECTOR_UNIT_DRIFT');
  const p = unitProperties('servora-med-time-evidence@forward-probe.service', ['FragmentPath', 'DropInPaths',
    'NeedDaemonReload', 'ExecStart', 'User', 'Group', 'NoNewPrivileges', 'CapabilityBoundingSet',
    'AmbientCapabilities', 'ProtectSystem', 'ProtectHome', 'RestrictAddressFamilies']);
  const socket = unitProperties('servora-med-time-evidence.socket', ['FragmentPath', 'DropInPaths', 'NeedDaemonReload', 'ActiveState']);
  if (p.FragmentPath !== PATHS.collectorUnit || p.User !== '_chrony' || p.Group !== '_chrony'
    || p.NoNewPrivileges !== 'yes' || p.CapabilityBoundingSet !== '' || p.AmbientCapabilities !== ''
    || p.ProtectSystem !== 'strict' || p.ProtectHome !== 'yes' || p.RestrictAddressFamilies !== 'AF_UNIX'
    || socket.FragmentPath !== PATHS.collectorSocket || socket.DropInPaths !== '' || socket.NeedDaemonReload !== 'no'
    || socket.ActiveState !== 'active') fail('FORWARD_HOST_COLLECTOR_SANDBOX_DRIFT');
  trustedParents(PATHS.timeSocket);
  try { validateReaderSocketMetadata(lstatSync(PATHS.timeSocket), Number(execute('/usr/bin/id', ['-g', 'servora-med']).trim())); }
  catch { fail('FORWARD_HOST_COLLECTOR_SOCKET_INVALID'); }
  const present = existsSync(PATHS.collectorDropin);
  if (present && protectedBytes(PATHS.collectorDropin).toString() !== COLLECTOR_TEXT) fail('FORWARD_HOST_COLLECTOR_UNIT_DRIFT');
  const complete = state.done.has('COLLECTOR'), pending = state.pending?.event === 'COLLECTOR_INTENT';
  const oldPrefix = '{ path=/usr/bin/node ; argv[]=/usr/bin/node --no-addons ' + PATHS.installed + '/trusted-time.mjs --collect-chrony ; ignore_errors=no ; ';
  const newPrefix = '{ path=/usr/bin/node ; argv[]=/usr/bin/node --no-addons ' + PATHS.tool + '/trusted-time.mjs --collect-chrony ; ignore_errors=no ; ';
  const oldLoaded = p.DropInPaths === '' && p.ExecStart.startsWith(oldPrefix);
  const newLoaded = p.DropInPaths === PATHS.collectorDropin && p.ExecStart.startsWith(newPrefix);
  if ((p.ExecStart.match(/\{/g) ?? []).length !== 1 || !p.ExecStart.endsWith(' }')
    || (pending ? (!oldLoaded && !newLoaded) || !['yes', 'no'].includes(p.NeedDaemonReload)
      : complete ? !present || !newLoaded || p.NeedDaemonReload !== 'no'
        : present || !oldLoaded || p.NeedDaemonReload !== 'no')) fail('FORWARD_HOST_COLLECTOR_BINDING_INVALID');
}
const bootId = () => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
const uptime = () => Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]) * 1000;
function mkdir(path, mode = 0o700) {
  trustedParents(path);
  if (!existsSync(path)) { mkdirSync(path, {mode}); flushDirectory(dirname(path)); }
  const info = lstatSync(path);
  if (!info.isDirectory() || info.uid !== 0 || info.gid !== 0 || (info.mode & 0o7777) !== mode) fail('FORWARD_HOST_DIRECTORY_UNTRUSTED');
}
function checkDirectory(path, mode = 0o700) {
  trustedParents(path + '/entry');
  const info = lstatSync(path);
  if (!info.isDirectory() || info.uid !== 0 || info.gid !== 0 || (info.mode & 0o7777) !== mode) fail('FORWARD_HOST_DIRECTORY_UNTRUSTED');
}
function fileHash(path, options) { return digest(protectedBytes(path, options)); }
function envText() {
  const gid = Number(execute('/usr/bin/id', ['-g', 'servora-med']).trim());
  return protectedBytes(PATHS.env, {gid, mode: 0o640}).toString();
}
function identity(props = properties()) {
  const pid = Number(props.MainPID);
  if (props.ActiveState !== 'active' || props.SubState !== 'running' || !Number.isSafeInteger(pid) || pid < 1) return null;
  const stat = readFileSync('/proc/' + pid + '/stat', 'utf8');
  const startTime = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  if (!/^\d+$/.test(startTime) || !/^[a-f0-9]{32}$/.test(props.InvocationID)) fail('FORWARD_HOST_PROCESS_INVALID');
  if (realpathSync('/proc/' + pid + '/exe') !== realpathSync('/usr/bin/node')) fail('FORWARD_HOST_PROCESS_INVALID');
  return {pid, startTime, bootId: bootId(), invocationId: props.InvocationID};
}
function assertStopped(oldIdentity) {
  const p = properties();
  if (!['inactive', 'failed'].includes(p.ActiveState) || Number(p.MainPID) !== 0
    || (p.Job && p.Job !== '0') || p.Restart !== 'no') fail('FORWARD_HOST_NOT_STOPPED');
  // cgroup v2 proves no old child/writer survived KillMode=mixed.
  const group = p.ControlGroup || '/system.slice/' + UNIT_NAME;
  if (!/^\/system.slice\/servora-med\.service$/.test(group)) fail('FORWARD_HOST_CGROUP_INVALID');
  const procs = '/sys/fs/cgroup' + group + '/cgroup.procs';
  if (existsSync(procs) && readFileSync(procs, 'utf8').trim() !== '') fail('FORWARD_HOST_OLD_STILL_RUNNING');
  if (oldIdentity?.bootId === bootId() && existsSync('/proc/' + oldIdentity.pid)) {
    const stat = readFileSync('/proc/' + oldIdentity.pid + '/stat', 'utf8');
    if (stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] === oldIdentity.startTime) fail('FORWARD_HOST_OLD_STILL_RUNNING');
  }
}

/** The installed tool has a fixed manifest and must equal the exact TARGET
 * artifact's corresponding source files. A root grant cannot authorize a
 * mutable checkout or a different controller. */
export function toolManifest(directory = PATHS.tool) {
  checkDirectory(directory, 0o755);
  if (!same(readdirSync(directory).filter(n => n !== 'manifest.json').sort(), [...TOOL_FILES].sort())) fail('FORWARD_HOST_TOOL_INVALID');
  const files = TOOL_FILES.map(name => ({name, sha256: fileHash(join(directory, name), {mode: 0o644})}));
  return seal({kind: 'FORWARD_HOST_TOOL', files});
}
function verifyTool() {
  const actual = toolManifest();
  const installed = protectedJson(PATHS.tool + '/manifest.json', {mode: 0o644});
  if (!same(actual, installed)) fail('FORWARD_HOST_TOOL_DRIFT');
  return actual.hash;
}
function releaseRoot(sha) { return '/opt/servora-med/releases/' + sha; }
function verifyRelease(release) {
  const directory = releaseRoot(release.releaseSha);
  trustedParents(directory + '/entry');
  if (protectedBytes(directory + '/.servora-release-artifact.sha256').toString() !== release.artifactSha256 + '\n'
    || fileHash(PATHS.state + '/artifacts/' + release.releaseSha + '.tar.gz', {limit: 1024 * 1024 * 1024}) !== release.artifactSha256) fail('FORWARD_HOST_ARTIFACT_INVALID');
  const entries = [];
  const walk = relative => {
    const path = join(directory, relative), info = lstatSync(path);
    if (info.uid !== 0 || (!info.isSymbolicLink() && (info.mode & 0o022))) fail('FORWARD_HOST_RELEASE_UNTRUSTED');
    const name = relative === '.' ? '.' : './' + relative;
    if (info.isSymbolicLink()) {
      if (!realpathSync(path).startsWith(directory + '/')) fail('FORWARD_HOST_RELEASE_UNTRUSTED');
      entries.push('l ' + name + ' ' + readlinkSync(path));
    } else if (info.isDirectory()) {
      if (relative !== '.') entries.push('d ' + name);
      for (const file of readdirSync(path)) {
        if (relative === '.' && ['.servora-release-artifact.sha256', '.servora-release-content.sha256'].includes(file)) continue;
        if (/[\r\n]/.test(file)) fail('FORWARD_HOST_RELEASE_UNTRUSTED');
        walk(relative === '.' ? file : relative + '/' + file);
      }
    } else if (info.isFile() && info.nlink === 1) entries.push('f ' + name + ' ' + digest(readFileSync(path)));
    else fail('FORWARD_HOST_RELEASE_UNTRUSTED');
  };
  walk('.');
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.slice(0, a.indexOf(' ', 2) < 0 ? a.length : a.indexOf(' ', 2))), Buffer.from(b.slice(0, b.indexOf(' ', 2) < 0 ? b.length : b.indexOf(' ', 2)))));
  if (protectedBytes(directory + '/.servora-release-content.sha256').toString() !== entries.join('\n') + '\n') fail('FORWARD_HOST_RELEASE_CONTENT_DRIFT');
  // Do not trust a self-reported installed manifest: compare bytes with the
  // retained, grant-hashed archive. Archive reads never execute release code.
  execute('/usr/bin/tar', ['--compare', '--gzip', '--file', PATHS.state + '/artifacts/' + release.releaseSha + '.tar.gz', '--directory', directory], {timeout: 120000});
  const migrations = directory + '/server/dist/db/migrations';
  const catalog = readdirSync(migrations).filter(n => /^\d{3}_[a-z0-9_]+\.sql$/.test(n)).sort().map(name => ({version: name.slice(0, -4), sha256: digest(readFileSync(join(migrations, name)))}));
  if (catalog.length !== 60 || catalog.at(-1).version !== HEAD || !same(catalog, release.catalog) || release.schemaHead !== HEAD) fail('FORWARD_HOST_CATALOG_INVALID');
}

/** No canonical reader that reconciles temp files is used on this path. The
 * parent chain is inspected byte-for-byte and remains strictly read-only. */
async function readParent(authorization) {
  // Prove the import closure from protected data BEFORE executing a sealed
  // helper. Reading a root-owned file is not itself proof of its granted hash.
  const approvalPath = PATHS.state + '/approvals/' + authorization.parent.attemptId + '.json';
  const rawApproval = protectedJson(approvalPath);
  const rawProfile = protectedJson(PATHS.state + '/profile.json');
  if (fileHash(approvalPath) !== authorization.parent.approvalSha256
    || fileHash(PATHS.state + '/profile.json') !== authorization.parent.profileSha256
    || rawApproval.profileSha256 !== authorization.parent.profileSha256) fail('FORWARD_HOST_PARENT_DRIFT');
  for (const [key, path, mode] of [
    ['attemptModuleSha256', PATHS.installed + '/deployment-attempt.mjs', 0o644],
    ['controllerModuleSha256', PATHS.installed + '/deployment-controller.mjs', 0o644],
    ['dbGuardModuleSha256', PATHS.installed + '/deployment-db-guard.mjs', 0o644],
    ['reconciliationModuleSha256', PATHS.installed + '/migration-reconciliation.mjs', 0o644],
    ['timeModuleSha256', PATHS.installed + '/trusted-time.mjs', 0o644],
    ['helperSha256', PATHS.installed + '/deploy-production-host', 0o755],
    ['nodeSha256', realpathSync('/usr/bin/node'), 0o755],
    ['unitSha256', PATHS.unit, 0o644],
  ]) if (fileHash(path, {mode, limit: 1024 * 1024 * 1024}) !== rawProfile.contracts[key]) fail('FORWARD_HOST_ROOT_HELPER_DRIFT');
  const {readRootApproval, readRootProfile, readRootCheckpoint} = await import(PATHS.installed + '/deployment-attempt.mjs');
  const parent = readRootApproval(authorization.parent.attemptId);
  const profile = readRootProfile(parent.approval);
  const names = readdirSync(PATHS.state + '/attempts/' + authorization.parent.attemptId).sort();
  if (names.length !== authorization.parent.checkpointSequence + 1 || names.some((n, i) => n !== String(i).padStart(4, '0') + '.json')) fail('FORWARD_HOST_PARENT_DRIFT');
  const checkpoint = readRootCheckpoint(authorization.parent.attemptId, authorization.parent.checkpointSequence);
  if (parent.approvalSha256 !== authorization.parent.approvalSha256 || parent.approval.profileSha256 !== authorization.parent.profileSha256
    || checkpoint.sha256 !== authorization.parent.checkpointSha256 || checkpoint.record.phase !== 'POSTDEPLOY_BACKUP_PASSED'
    || checkpoint.record.parentAttemptCompleted === true || checkpoint.record.migrationCommitted !== true
    || checkpoint.record.lastStart !== 'pass' || checkpoint.record.starts !== parent.approval.maxStarts) fail('FORWARD_HOST_PARENT_DRIFT');
  const emergency = PATHS.state + '/emergency';
  const emergencyAuthorization = protectedJson(emergency + '/authorization.json');
  const emergencyDir = emergency + '/' + authorization.parent.emergencyAuthorizationId;
  const files = readdirSync(emergencyDir).filter(n => /^\d{4}\.json$/.test(n)).sort();
  const chain = files.map((name, i) => {
    if (name !== String(i).padStart(4, '0') + '.json') fail('FORWARD_HOST_EMERGENCY_INVALID');
    return protectedJson(join(emergencyDir, name));
  });
  const latest = validateEmergencyHandoffChain(chain);
  const receipt = protectedJson(emergencyDir + '/receipt.json');
  const supersession = assertEmergencySupersession({receipt, receiptSha256: authorization.parent.emergencyReceiptSha256,
    expected: {authorizationId: emergencyAuthorization.authorizationId, authorizationSha256: fileHash(emergency + '/authorization.json'), toolArtifactSha256: emergencyAuthorization.toolArtifactSha256, parent: emergencyAuthorization.parent}});
  if (latest.phase !== 'HANDOFF_COMPLETE' || latest.hash !== authorization.parent.emergencyJournalHeadSha256
    || !same(receipt.host.database, authorization.host.database) || receipt.host.machineId !== authorization.host.machineId
    || receipt.host.releaseSha !== authorization.old.releaseSha || receipt.host.schemaHead !== HEAD
    || parent.approval.releaseSha !== authorization.old.releaseSha || parent.approval.artifactSha256 !== authorization.old.artifactSha256
    || !same(parent.approval.targetCatalog, authorization.old.catalog)) fail('FORWARD_HOST_EMERGENCY_INVALID');
  for (const [kind, expected] of [['pre', receipt.backups.preSha256], ['post', receipt.backups.postSha256]]) {
    if (fileHash(PATHS.state + '/backups/' + authorization.parent.attemptId + '-' + kind + '.dump') !== expected) fail('FORWARD_HOST_PARENT_BACKUP_DRIFT');
  }
  return {...parent, profile, checkpoint, receipt, supersession};
}

function processRelease(expectedSha, expectedIdentity = null) {
  const current = identity();
  if (!current || expectedIdentity && !same(current, expectedIdentity)
    || realpathSync('/proc/' + current.pid + '/cwd') !== releaseRoot(expectedSha) + '/server') fail('FORWARD_HOST_PROCESS_CHANGED');
  const environment = readFileSync('/proc/' + current.pid + '/environ', 'utf8').split('\0');
  if (environment.filter(l => l.startsWith('SERVORA_RELEASE_SHA=')).join() !== 'SERVORA_RELEASE_SHA=' + expectedSha
    || environment.filter(l => l.startsWith('HEALTH_SCHEMA_VERSION=')).join() !== 'HEALTH_SCHEMA_VERSION=' + HEAD) fail('FORWARD_HOST_PROCESS_RELEASE_INVALID');
  return current;
}
function health(sha, backup = false) {
  let response;
  try { response = JSON.parse(execute('/usr/bin/curl', ['--fail', '--silent', '--show-error', '--max-time', '4', 'http://127.0.0.1:3000/api/health' + (backup ? '/backup' : '')], {timeout: 5000})); }
  catch { fail(backup ? 'FORWARD_HOST_BACKUP_HEALTH_FAILED' : 'FORWARD_HOST_TARGET_UNHEALTHY'); }
  if (response.status !== 'ok' || (!backup && response.releaseSha !== sha)
    || (backup && (response.provider !== 'host-observation' || response.providerStatus !== 'healthy'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(response.latestScheduledVerifiedAt ?? '')))) fail(backup ? 'FORWARD_HOST_BACKUP_HEALTH_FAILED' : 'FORWARD_HOST_TARGET_UNHEALTHY');
  return response;
}
function childArguments(mode) {
  return ['-u', 'servora-med', '--', '/usr/bin/env', '-i', 'PATH=' + CLEAN_ENV.PATH,
    '/usr/bin/node', '--env-file=' + PATHS.env, PATHS.tool + '/forward-host-probe.mjs', mode];
}
function dbOptions(a) {
  return {releaseDirectory: releaseRoot(a.target.releaseSha), expectedIdentity: a.host.database,
    expectedCatalog: a.target.catalog.map(c => c.version)};
}
async function holdDatabase(a, operation) {
  const child = spawn('/usr/bin/sudo', childArguments('--hold'), {env: CLEAN_ENV, stdio: ['pipe', 'pipe', 'pipe']});
  child.stderr.resume();
  const lines = createInterface({input: child.stdout, crlfDelay: Infinity})[Symbol.asyncIterator]();
  let exit = null;
  const exited = new Promise(resolve => {
    child.once('exit', code => { exit = code ?? -1; resolve(); });
    child.once('error', () => { exit = -1; resolve(); });
  });
  const next = async expected => {
    let timer;
    try {
      const line = await Promise.race([lines.next(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('FORWARD_HOST_DB_TIMEOUT')), 15000);
      })]);
      if (exit !== null || line.done || line.value !== expected) fail('FORWARD_HOST_DATABASE_CHECK_FAILED');
    } finally { clearTimeout(timer); }
  };
  try {
    child.stdin.write(canonical(dbOptions(a))); await next('READY');
    const check = async () => { if (exit !== null) fail('FORWARD_HOST_DB_GUARD_LOST'); child.stdin.write('CHECK\n'); await next('EXACT'); };
    const result = await operation(check);
    await check(); child.stdin.end('RELEASE\n');
    let timer;
    try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('FORWARD_HOST_DB_TIMEOUT')), 10000); })]); }
    finally { clearTimeout(timer); }
    if (exit !== 0) fail('FORWARD_HOST_DB_GUARD_LOST');
    return result;
  } finally { if (exit === null) child.kill('SIGKILL'); child.stdin.destroy(); }
}

export async function createHostIO(a, check = async () => {}) {
  root(); validateForwardAuthorizationStructure(a);
  if (a.old.schemaHead !== HEAD || a.target.schemaHead !== HEAD) fail('FORWARD_HOST_CATALOG_INVALID');
  const toolHash = verifyTool(), authorizationSha256 = fileHash(PATHS.root + '/authorization.json');
  const attempt = PATHS.root + '/' + a.attemptId, journalPath = attempt + '/journal';
  const readLog = () => existsSync(journalPath) ? openHostJournal(journalPath).read(log => validateHostLog(log, a, authorizationSha256, toolHash)) : [];
  const hostState = () => validateHostLog(readLog(), a, authorizationSha256, toolHash);
  const assertOwner = (optional = false) => {
    if (!existsSync(PATHS.owner)) { if (optional) return; fail('FORWARD_HOST_OWNER_MISSING'); }
    if (!same(protectedJson(PATHS.owner), {attemptId: a.attemptId, approvalSha256: authorizationSha256})) fail('FORWARD_HOST_FOREIGN_OWNER');
  };
  const assertBarrier = () => {
    if (!same(protectedJson(PATHS.barrier), {attemptId: a.attemptId, approvalSha256: authorizationSha256})) fail('FORWARD_HOST_FOREIGN_BARRIER');
  };
  const tuple = sha => {
    const text = envText();
    if (text.split('\n').filter(l => l.startsWith('SERVORA_RELEASE_SHA=')).join() !== 'SERVORA_RELEASE_SHA=' + sha
      || text.split('\n').filter(l => l.startsWith('HEALTH_SCHEMA_VERSION=')).join() !== 'HEALTH_SCHEMA_VERSION=' + HEAD
      || realpathSync(PATHS.current) !== releaseRoot(sha)) fail('FORWARD_HOST_ALIGNMENT_INVALID');
  };
  const verifyStatic = async () => {
    if (verifyTool() !== toolHash || fileHash(PATHS.root + '/authorization.json') !== authorizationSha256) fail('FORWARD_HOST_HASH_DRIFT');
    const parent = await readParent(a);
    if (readFileSync('/etc/machine-id', 'utf8').trim() !== a.host.machineId
      || !same(parent.profile.databaseIdentity, a.host.database)) fail('FORWARD_HOST_HOST_IDENTITY_INVALID');
    // Sealed R4 root readers are imports only. Never install TARGET over them.
    for (const [key, path, mode] of [
      ['attemptModuleSha256', PATHS.installed + '/deployment-attempt.mjs', 0o644],
      ['controllerModuleSha256', PATHS.installed + '/deployment-controller.mjs', 0o644],
      ['dbGuardModuleSha256', PATHS.installed + '/deployment-db-guard.mjs', 0o644],
      ['reconciliationModuleSha256', PATHS.installed + '/migration-reconciliation.mjs', 0o644],
      ['timeModuleSha256', PATHS.installed + '/trusted-time.mjs', 0o644],
      ['unitSha256', PATHS.unit, 0o644],
    ]) if (fileHash(path, {mode}) !== parent.profile.contracts[key]) fail('FORWARD_HOST_ROOT_HELPER_DRIFT');
    verifyRelease(a.old); verifyRelease(a.target);
    const targetTime = releaseRoot(a.target.releaseSha) + '/ops/scripts/trusted-time.mjs';
    const descriptor = info => ({kind: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other',
      uid: info.uid, gid: info.gid, mode: info.mode & 0o7777, nlink: info.nlink});
    const ancestors = [];
    for (let path = dirname(targetTime); path !== '/'; path = dirname(path)) ancestors.push(descriptor(lstatSync(path)));
    try { validateTimeModuleContract(targetTime, descriptor(lstatSync(targetTime)), ancestors,
      Number(execute('/usr/bin/id', ['-g', 'servora-med']).trim())); }
    catch { fail('FORWARD_HOST_TIME_MODULE_INVALID'); }
    for (const [name, expected] of [['servora-med-time-evidence@.service', READER_UNIT_SHA256], ['servora-med-time-evidence.socket', READER_SOCKET_UNIT_SHA256]]) {
      if (digest(readFileSync(releaseRoot(a.target.releaseSha) + '/ops/systemd/' + name)) !== expected) fail('FORWARD_HOST_COLLECTOR_UNIT_DRIFT');
    }
    for (const name of TOOL_FILES) {
      const source = name === 'required-checks.txt' ? '/ops/local-ci/required-checks.txt' : '/ops/scripts/' + name;
      if (digest(readFileSync(releaseRoot(a.target.releaseSha) + source)) !== fileHash(PATHS.tool + '/' + name, {mode: 0o644})) fail('FORWARD_HOST_TOOL_TARGET_MISMATCH');
    }
    const ci = PATHS.root + '/ci/' + a.target.releaseSha;
    const manifestBytes = protectedBytes(ci + '/manifest.json');
    if (digest(manifestBytes) !== a.target.ciManifestSha256) fail('FORWARD_HOST_CI_INVALID');
    const required = protectedBytes(PATHS.tool + '/required-checks.txt', {mode: 0o644}).toString().split('\n').filter(l => l && !l.startsWith('#'));
    const ciManifest = JSON.parse(manifestBytes);
    verifyForwardCI(ciManifest, a.target, name => protectedBytes(ci + '/' + name), required);
    const actualLogs = readdirSync(ci + '/logs').filter(n => n.endsWith('.log')).sort();
    if (!same(actualLogs, ciManifest.checks.map(c => c.log.slice(5)).sort())) fail('FORWARD_HOST_CI_INVALID');
    const state = hostState(), p = properties();
    assertCollectorBinding(state);
    const allowed = [PATHS.guard, PATHS.policy];
    const dropins = p.DropInPaths.split(' ').filter(Boolean);
    if (p.User !== 'servora-med' || p.Group !== 'servora-med' || p.FragmentPath !== PATHS.unit
      || p.WorkingDirectory !== '/opt/servora-med/current/server' || p.EnvironmentFiles !== PATHS.env + ' (ignore_errors=no)'
      || !p.ExecStart.startsWith('{ path=/usr/bin/node ; argv[]=/usr/bin/node dist/index.js ; ignore_errors=no ; ')
      || dropins.some(path => !allowed.includes(path))) fail('FORWARD_HOST_SYSTEMD_DRIFT');
    if (existsSync(PATHS.state + '/initializations') && readdirSync(PATHS.state + '/initializations').length) fail('FORWARD_HOST_FOREIGN_OWNER');
    if (existsSync(PATHS.permit)) {
      const permit = protectedJson(PATHS.permit);
      if (state.pending?.event !== 'START_INTENT' || !same(permit, {attemptId: a.attemptId,
        authorizationSha256, intentHash: state.pending.hash})) fail('FORWARD_HOST_FOREIGN_PERMIT');
    }
    if (existsSync(PATHS.guard) && protectedBytes(PATHS.guard).toString() !== GUARD_TEXT
      || existsSync(PATHS.policy) && protectedBytes(PATHS.policy).toString() !== POLICY_TEXT) fail('FORWARD_HOST_SYSTEMD_DRIFT');
    if (!state.contract) {
      if (existsSync(PATHS.owner) || existsSync(PATHS.barrier) || existsSync(PATHS.guard) || existsSync(PATHS.policy)
        || existsSync(PATHS.ticket) || p.Restart !== 'on-failure' || p.NeedDaemonReload !== 'no') fail('FORWARD_HOST_FOREIGN_OWNER');
      tuple(a.old.releaseSha); processRelease(a.old.releaseSha); health(a.old.releaseSha);
    } else {
      assertOwner(state.contract.phase === 'INTENT' || state.contract.phase === 'ACCEPTED');
      if (existsSync(PATHS.barrier)) assertBarrier();
      if (state.done.has('FENCE') && !state.done.has('HANDOFF')) {
        if (!existsSync(PATHS.guard) || (!state.done.has('POLICY') && !existsSync(PATHS.policy))) {
          // Only the corresponding durable removal intent may reconcile it.
          if (!['POLICY_INTENT', 'HANDOFF_INTENT'].includes(state.pending?.event)) fail('FORWARD_HOST_FENCE_MISSING');
        }
      }
      if (state.done.has('START') && state.contract.phase !== 'ACCEPTED') processRelease(a.target.releaseSha, state.done.get('START').data.identity);
      if (state.contract.phase === 'OBSERVATION_PASSED') {
        health(a.target.releaseSha); health(a.target.releaseSha, true);
      }
      const pending = state.pending?.event;
      const policyRemoved = state.done.has('POLICY') || state.done.has('HANDOFF');
      const handoff = state.done.has('HANDOFF');
      const changing = ['FENCE_INTENT', 'POLICY_INTENT', 'HANDOFF_INTENT'].includes(pending);
      if (!changing) {
        const fenced = state.done.has('FENCE') && !handoff;
        const expectedDropins = fenced ? [PATHS.guard, ...(!policyRemoved ? [PATHS.policy] : [])] : [];
        const hasLoadedGate = /^\{ path=\/usr\/bin\/node ; argv\[\]=\/usr\/bin\/node \/usr\/local\/libexec\/servora-med-forward\/forward-host\.mjs start-gate ; ignore_errors=no ; [^}]*\}$/.test(p.ExecStartPre);
        if (p.NeedDaemonReload !== 'no' || !same(dropins, expectedDropins)
          || p.Restart !== (fenced && !policyRemoved ? 'no' : 'on-failure')
          || (fenced ? !hasLoadedGate : p.ExecStartPre !== '')
          || (fenced && !existsSync(PATHS.barrier))) fail('FORWARD_HOST_SYSTEMD_DRIFT');
      }
    }
    await check(); return parent;
  };
  const verifyBackup = kind => {
    const receipt = protectedJson(attempt + '/' + kind + '-backup.json');
    const state = hostState(), intent = readLog().find(r => r.event === (kind === 'pre' ? 'PRE_BACKUP_INTENT' : 'POST_BACKUP_INTENT'));
    const completed = state.done.get(kind === 'pre' ? 'PRE_BACKUP' : 'POST_BACKUP');
    const accepted = state.contract.phase === 'ACCEPTED';
    if (completed && completed.data.receiptSha256 !== fileHash(attempt + '/' + kind + '-backup.json')) fail('FORWARD_HOST_BACKUP_HASH_DRIFT');
    if (!intent || receipt.kind !== 'FORWARD_HOST_BACKUP' || receipt.attemptId !== a.attemptId
      || receipt.authorizationSha256 !== authorizationSha256 || receipt.intentHash !== intent.hash
      || !same(receipt.database, a.host.database) || receipt.schemaHead !== HEAD
      || !accepted && (receipt.bootId !== bootId() || uptime() < receipt.completedUptimeMs || uptime() - receipt.completedUptimeMs > 26 * 3600_000)
      || !Number.isFinite(receipt.completedUptimeMs) || receipt.completedUptimeMs < 0
      || typeof receipt.completedAtUTC !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(receipt.completedAtUTC)
      || !Number.isFinite(Date.parse(receipt.completedAtUTC)) || Date.parse(receipt.completedAtUTC) > Date.parse(now())
      || Date.parse(receipt.completedAtUTC) < Date.parse(intent.atUTC)
      || fileHash(attempt + '/' + kind + '.dump', {limit: 1024 * 1024 * 1024}) !== receipt.sha256) fail('FORWARD_HOST_BACKUP_INVALID');
    execute('/usr/lib/postgresql/17/bin/pg_restore', ['--list', attempt + '/' + kind + '.dump']);
    if (kind === 'post' && !state.done.has('PRE_BACKUP')) fail('FORWARD_HOST_BACKUP_INVALID');
    return receipt;
  };
  const verifyTarget = async () => {
    await check(); tuple(a.target.releaseSha);
    const s = hostState(), start = s.done.get('START');
    if (!start) fail('FORWARD_HOST_START_PROOF_MISSING');
    const before = processRelease(a.target.releaseSha, s.contract.phase === 'ACCEPTED' ? null : start.data.identity);
    health(a.target.releaseSha);
    if (['POSTDEPLOY_BACKUP_PASSED', 'OBSERVATION_INTENT', 'OBSERVATION_STARTED', 'OBSERVATION_PASSED', 'ACCEPTED'].includes(s.contract.phase)) health(a.target.releaseSha, true);
    execute('/usr/bin/sudo', ['-u', 'servora-med', '--', '/usr/bin/env', '-i', 'PATH=' + CLEAN_ENV.PATH, 'NODE_ENV=production',
      '/usr/bin/node', '--env-file=' + PATHS.env, releaseRoot(a.target.releaseSha) + '/server/dist/db/schema-check.js'], {timeout: 120000});
    processRelease(a.target.releaseSha, before); await check();
  };
  const gateResult = (pending) => {
    const receipt = protectedJson(attempt + '/start-' + pending.data.slot + '.json');
    const current = processRelease(a.target.releaseSha);
    if (receipt.intentHash !== pending.hash || receipt.authorizationSha256 !== authorizationSha256
      || receipt.bootId !== bootId() || receipt.invocationId !== current.invocationId) fail('FORWARD_HOST_ACTIVATION_UNKNOWN');
    return {identity: current, slot: pending.data.slot, gateReceiptHash: digest(canonical(receipt))};
  };
  const io = {
    now, toolHash, readLog,
    pendingPublications: () => existsSync(journalPath) ? openHostJournal(journalPath).pending() : 0,
    check: verifyStatic,
    identity: async () => identity(),
    context: async () => {
      const parent = await readParent(a), p = properties(), active = identity(p), sha = basename(realpathSync(PATHS.current));
      return {nowUTC: now(), authorizationSha256, supersession: parent.supersession,
        emergency: {receiptSha256: parent.receipt.hash, journalHeadSha256: parent.receipt.handoff.journalHeadSha256},
        parentIdentity: {approvalSha256: parent.approvalSha256, profileSha256: parent.approval.profileSha256},
        host: {machineId: readFileSync('/etc/machine-id', 'utf8').trim(), database: a.host.database,
          schemaHead: HEAD, appActive: Boolean(active), restartPolicy: p.Restart, releaseSha: sha,
          artifactSha256: sha === a.old.releaseSha ? a.old.artifactSha256 : a.target.artifactSha256,
          activeOwnerIds: existsSync(PATHS.owner) ? [protectedJson(PATHS.owner).attemptId] : []},
        target: a.target, journal: {present: readLog().length > 0}};
    },
    append: record => {
      mkdir(attempt); mkdir(journalPath);
      openHostJournal(journalPath).append(record);
    },
    verifyTarget,
    verifyBackups: async kind => { verifyBackup('pre'); if (kind === 'post') verifyBackup('post'); },
    verifyObservation: async (proof, log) => {
      const intent = log.find(r => r.event === 'OBSERVE_INTENT');
      if (!intent || !same(proof, protectedJson(attempt + '/observation.json', {limit: 1024 * 1024}))) fail('FORWARD_HOST_OBSERVATION_INVALID');
      return verifyObservationProof(proof, {attemptId: a.attemptId, authorizationSha256, anchor: intent.data.anchor,
        identity: processRelease(a.target.releaseSha), releaseSha: a.target.releaseSha, schemaHead: HEAD,
        backupReceiptSha256: fileHash(attempt + '/post-backup.json'), now: sampleTrustedTime()});
    },
    effect: async (op, data, log) => {
      assertOwner(op === 'OWNER');
      const pending = log.at(-1);
      if (pending.event !== op + '_INTENT') fail('FORWARD_HOST_INTENT_REQUIRED');
      switch (op) {
        case 'OWNER': {
          if (existsSync(PATHS.owner)) assertOwner();
          else publishExclusive(PATHS.owner, canonical({attemptId: a.attemptId, approvalSha256: authorizationSha256}));
          return {owner: a.attemptId};
        }
        case 'PRE_BACKUP': case 'POST_BACKUP': {
          const kind = op === 'PRE_BACKUP' ? 'pre' : 'post';
          const file = attempt + '/' + kind + '.dump';
          const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          try {
            const result = spawnSync('/usr/bin/sudo', childArguments('backup'), {env: CLEAN_ENV,
              input: canonical(dbOptions(a)), stdio: ['pipe', fd, 'pipe'], timeout: 240000});
            if (result.status !== 0) fail('FORWARD_HOST_BACKUP_FAILED');
            fsyncSync(fd);
          } finally { closeSync(fd); }
          flushDirectory(attempt);
          execute('/usr/lib/postgresql/17/bin/pg_restore', ['--list', file]);
          const receipt = {kind: 'FORWARD_HOST_BACKUP', attemptId: a.attemptId, authorizationSha256,
            intentHash: pending.hash, database: a.host.database, schemaHead: HEAD, sha256: fileHash(file, {limit: 1024 * 1024 * 1024}),
            bootId: bootId(), completedUptimeMs: uptime(), completedAtUTC: now()};
          publishExclusive(attempt + '/' + kind + '-backup.json', canonical(receipt));
          return {receiptSha256: fileHash(attempt + '/' + kind + '-backup.json')};
        }
        case 'FENCE': {
          // Installing the gate and Restart=no happens before OLD stop. A
          // queued auto-restart is drained by systemctl stop; pointer mutation
          // subsequently requires an empty cgroup and the original PID gone.
          const old = log[0].data.oldIdentity;
          processRelease(a.old.releaseSha, old);
          if (!existsSync(PATHS.barrier)) publishExclusive(PATHS.barrier, canonical({attemptId: a.attemptId, approvalSha256: authorizationSha256}));
          else assertBarrier();
          mkdir('/etc/systemd/system/servora-med.service.d', 0o755);
          for (const [path, text] of [[PATHS.guard, GUARD_TEXT], [PATHS.policy, POLICY_TEXT]]) {
            if (!existsSync(path)) publishExclusive(path, text);
            else if (protectedBytes(path).toString() !== text) fail('FORWARD_HOST_SYSTEMD_DRIFT');
          }
          mkdir('/run/servora-med-forward');
          systemctl('daemon-reload');
          if (properties().Restart !== 'no' || properties().NeedDaemonReload !== 'no') fail('FORWARD_HOST_BUDGET_POLICY_INVALID');
          processRelease(a.old.releaseSha, old);
          return {restart: 'no'};
        }
        case 'STOP':
          assertBarrier();
          if (identity()) processRelease(a.old.releaseSha, data.oldIdentity);
          systemctl('stop', UNIT_NAME); assertStopped(data.oldIdentity); return {stopped: true};
        case 'ENV': {
          assertStopped(log[0].data.oldIdentity); assertBarrier();
          const {environmentBaseline, alignIdentityEnvironment} = await import(PATHS.installed + '/deployment-controller.mjs');
          const parent = await readParent(a), before = envText();
          if (environmentBaseline(before) !== parent.profile.envBaselineSha256) fail('FORWARD_HOST_ENV_DRIFT');
          const next = alignIdentityEnvironment(before, HEAD, a.target.releaseSha);
          if (next !== before) {
            const path = '/etc/servora-med/.forward-' + randomUUID();
            const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
            try { fchownSync(fd, 0, lstatSync(PATHS.env).gid); fchmodSync(fd, 0o640); writeFileSync(fd, next); fsyncSync(fd); } finally { closeSync(fd); }
            renameSync(path, PATHS.env); flushDirectory('/etc/servora-med');
          }
          return {environmentSha256: digest(next)};
        }
        case 'POINTER': {
          assertStopped(log[0].data.oldIdentity); assertBarrier();
          const path = '/opt/servora-med/.forward-' + randomUUID();
          symlinkSync(releaseRoot(a.target.releaseSha), path); renameSync(path, PATHS.current); flushDirectory('/opt/servora-med');
          tuple(a.target.releaseSha); return {releaseSha: a.target.releaseSha};
        }
        case 'COLLECTOR': {
          assertStopped(log[0].data.oldIdentity); assertBarrier(); tuple(a.target.releaseSha);
          mkdir(dirname(PATHS.collectorDropin), 0o755);
          if (!existsSync(PATHS.collectorDropin)) publishExclusive(PATHS.collectorDropin, COLLECTOR_TEXT);
          else if (protectedBytes(PATHS.collectorDropin).toString() !== COLLECTOR_TEXT) fail('FORWARD_HOST_COLLECTOR_UNIT_DRIFT');
          systemctl('daemon-reload');
          // Prior socket instances have a sealed 3s lifetime + 1s stop budget.
          // Do not restart Chrony, the socket, or the application.
          await delay(4500);
          assertCollectorBinding({...hostState(), pending: null, done: new Map([...hostState().done, ['COLLECTOR', pending]])});
          return {moduleSha256: fileHash(PATHS.tool + '/trusted-time.mjs', {mode: 0o644}),
            dropinSha256: fileHash(PATHS.collectorDropin), collectorUid: '_chrony'};
        }
        case 'START': {
          assertStopped(log[0].data.oldIdentity); assertBarrier(); tuple(a.target.releaseSha);
          if (Date.parse(now()) >= Date.parse(a.expiresAtUTC)) fail('FORWARD_HOST_START_WINDOW_EXPIRED');
          mkdir('/run/servora-med-forward');
          publishExclusive(PATHS.ticket, canonical({attemptId: a.attemptId, authorizationSha256,
            intentHash: pending.hash, slot: data.slot, bootId: bootId()}));
          // The base unit's OR condition is satisfied only for this start.
          mkdir('/run/servora-med-recovery');
          publishExclusive(PATHS.permit, canonical({attemptId: a.attemptId, authorizationSha256, intentHash: pending.hash}));
          try { systemctl('start', UNIT_NAME); }
          finally { if (existsSync(PATHS.permit)) { unlinkSync(PATHS.permit); flushDirectory(dirname(PATHS.permit)); } }
          // This is identity discovery, not an extra activation attempt.
          for (let i = 0; i < 50; i++) {
            try { if (identity()) break; }
            catch (error) { if (error.message !== 'FORWARD_HOST_PROCESS_INVALID') throw error; }
            // Type=simple acknowledges the fork before execve. Discover the
            // already-started node identity; never issue another start.
            await delay(100);
          }
          return gateResult(pending);
        }
        case 'SMOKE': {
          await verifyTarget();
          const receipt = protectedJson(attempt + '/smoke.json');
          const {hash, ...body} = receipt;
          if (seal(body).hash !== hash || body.kind !== 'FORWARD_HOST_BROWSER_SMOKE' || body.result !== 'PASS'
            || body.attemptId !== a.attemptId || body.authorizationSha256 !== authorizationSha256
            || body.targetReleaseSha !== a.target.releaseSha || body.healthPhaseHash !== pending.contract.hash
            || !same(body.identity, processRelease(a.target.releaseSha)) || !['chromium', 'webkit'].includes(body.browser)
            || Date.parse(body.completedAtUTC) < Date.parse(pending.contract.updatedAtUTC)
            || Date.parse(body.completedAtUTC) > Date.parse(now()) || Date.parse(now()) - Date.parse(body.completedAtUTC) > 3600_000
            || fileHash(attempt + '/smoke.log') !== body.logSha256) fail('FORWARD_HOST_SMOKE_INVALID');
          return {receiptSha256: fileHash(attempt + '/smoke.json')};
        }
        case 'OBSERVE': {
          // No imported observation, fake clock argument, shortened duration
          // or environment override is accepted by the production adapter.
          const samples = [], started = process.hrtime.bigint();
          let interrupted = false;
          const stop = () => { interrupted = true; };
          process.once('SIGTERM', stop); process.once('SIGINT', stop);
          try {
            while (true) {
              if (interrupted) fail('FORWARD_HOST_OBSERVATION_INTERRUPTED');
              await verifyTarget(); health(a.target.releaseSha, true); verifyBackup('post');
              const current = processRelease(a.target.releaseSha, data.identity), time = sampleTrustedTime();
              const sample = seal({index: samples.length, previousHash: samples.at(-1)?.hash ?? null,
                time, monotonicNs: process.hrtime.bigint().toString(), identity: current,
                releaseSha: a.target.releaseSha, schemaHead: HEAD, health: true, backupHealth: true});
              samples.push(sample);
              if (samples.length > 128) fail('FORWARD_HOST_OBSERVATION_INVALID');
              const interval = elapsedTime(samples[0].time, time);
              if (interval.status !== 'KNOWN') fail('FORWARD_HOST_OBSERVATION_INTERRUPTED');
              if (interval.lowerMs >= FORWARD_OBSERVATION_SECONDS * 1000
                && process.hrtime.bigint() - started >= BigInt(FORWARD_OBSERVATION_SECONDS) * 1_000_000_000n
                && samples.length >= FORWARD_OBSERVATION_MIN_SAMPLES) break;
              await delay(30_000);
            }
          } finally { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); }
          const proof = seal({kind: 'FORWARD_HOST_OBSERVATION', attemptId: a.attemptId, authorizationSha256,
            anchor: data.anchor, identity: data.identity, backupReceiptSha256: fileHash(attempt + '/post-backup.json'), samples});
          publishExclusive(attempt + '/observation.json', canonical(proof));
          await io.verifyObservation(proof, log); return proof;
        }
        case 'POLICY':
          assertBarrier();
          if (existsSync(PATHS.policy)) { unlinkSync(PATHS.policy); flushDirectory(dirname(PATHS.policy)); }
          systemctl('daemon-reload');
          if (properties().Restart !== 'on-failure' || !existsSync(PATHS.guard)) fail('FORWARD_HOST_POLICY_INVALID');
          return {restart: 'on-failure', startGate: 'CLOSED'};
        case 'HANDOFF':
          if (pending.contract.phase !== 'ACCEPTED') fail('FORWARD_HOST_NOT_ACCEPTED');
          tuple(a.target.releaseSha); verifyBackup('pre'); verifyBackup('post');
          if (identity()) processRelease(a.target.releaseSha);
          if (existsSync(PATHS.guard)) { unlinkSync(PATHS.guard); flushDirectory(dirname(PATHS.guard)); }
          systemctl('daemon-reload');
          if (properties().Restart !== 'on-failure' || properties().DropInPaths !== '' || properties().NeedDaemonReload !== 'no') fail('FORWARD_HOST_POLICY_INVALID');
          if (existsSync(PATHS.barrier)) { assertBarrier(); unlinkSync(PATHS.barrier); flushDirectory(PATHS.state); }
          // Only after durable terminal acceptance: ordinary runtime startup,
          // not another deployment activation or a reset of its spent slots.
          const runtimeStart = !identity();
          if (runtimeStart) systemctl('start', UNIT_NAME);
          for (let i = 0; i < 50; i++) {
            try { if (identity()) break; }
            catch (error) { if (error.message !== 'FORWARD_HOST_PROCESS_INVALID') throw error; }
            await delay(100);
          }
          return {restart: 'on-failure', startGate: 'REMOVED', normalRuntimeStart: runtimeStart,
            identity: processRelease(a.target.releaseSha)};
        case 'RETIRE':
          if (!hostState().done.has('HANDOFF') || existsSync(PATHS.barrier) || existsSync(PATHS.guard)
            || existsSync(PATHS.policy) || existsSync(PATHS.permit) || existsSync(PATHS.ticket)
            || properties().Restart !== 'on-failure') fail('FORWARD_HOST_RETIREMENT_INVALID');
          assertOwner(); unlinkSync(PATHS.owner); flushDirectory(PATHS.state); return {ownerRetired: true};
        default: fail('FORWARD_HOST_OPERATION_INVALID');
      }
    },
    reconcile: async (op, pending, log) => {
      // These operations re-observe or align the exact intended destination.
      // Backups/observation require their own already-published sealed result.
      if (['OWNER', 'FENCE', 'STOP', 'ENV', 'POINTER', 'COLLECTOR', 'POLICY', 'HANDOFF'].includes(op)) return io.effect(op, pending.data, log);
      if (op === 'START') {
        const result = gateResult(pending); // never systemctl start twice
        for (const path of [PATHS.permit, PATHS.ticket]) if (existsSync(path)) {
          const record = protectedJson(path);
          if (record.intentHash !== pending.hash || record.authorizationSha256 !== authorizationSha256) fail('FORWARD_HOST_FOREIGN_PERMIT');
          unlinkSync(path); flushDirectory(dirname(path));
        }
        return result;
      }
      if (op === 'PRE_BACKUP' || op === 'POST_BACKUP') {
        const kind = op === 'PRE_BACKUP' ? 'pre' : 'post'; verifyBackup(kind);
        return {receiptSha256: fileHash(attempt + '/' + kind + '-backup.json')};
      }
      if (op === 'SMOKE') return io.effect(op, pending.data, log);
      if (op === 'OBSERVE') {
        const proof = protectedJson(attempt + '/observation.json', {limit: 1024 * 1024});
        await io.verifyObservation(proof, log); return proof;
      }
      if (op === 'RETIRE' && !existsSync(PATHS.owner)) return {ownerRetired: true};
      fail('FORWARD_HOST_OUTCOME_UNKNOWN');
    },
  };
  return io;
}

/** ExecStartPre executes as root under the service sandbox. It must consume
 * one durable slot BEFORE ExecStart, even if systemd attempts an automatic
 * restart. The canonical host lock is held by the parent, so this narrow gate
 * uses exclusive publication, never attempts to acquire that same lock. */
async function startGate() {
  root(); verifyTool();
  const a = protectedJson(PATHS.root + '/authorization.json'); validateForwardAuthorizationStructure(a);
  const authHash = fileHash(PATHS.root + '/authorization.json');
  const attempt = PATHS.root + '/' + a.attemptId;
  const log = openHostJournal(attempt + '/journal').read();
  const s = validateHostLog(log, a, authHash, verifyTool());
  const pending = s.pending;
  if (!pending || pending.event !== 'START_INTENT' || s.contract.phase !== 'ACTIVATE_INTENT'
    || s.starts > a.budgets.maxStarts || Date.parse(now()) >= Date.parse(a.expiresAtUTC)
    || !/^[a-f0-9]{32}$/.test(process.env.INVOCATION_ID ?? '')
    || !readFileSync('/proc/self/cgroup', 'utf8').includes('/system.slice/servora-med.service')
    || !s.done.has('COLLECTOR')) fail('FORWARD_HOST_START_GATE_DENIED');
  assertCollectorBinding(s);
  for (const path of [PATHS.owner, PATHS.barrier]) if (!same(protectedJson(path), {attemptId: a.attemptId, approvalSha256: authHash})) fail('FORWARD_HOST_START_GATE_DENIED');
  const ticket = protectedJson(PATHS.ticket);
  if (!same(ticket, {attemptId: a.attemptId, authorizationSha256: authHash, intentHash: pending.hash, slot: s.starts, bootId: bootId()})
    || realpathSync(PATHS.current) !== releaseRoot(a.target.releaseSha)
    || properties().Restart !== 'no' || envText().split('\n').filter(l => l.startsWith('SERVORA_RELEASE_SHA=')).join() !== 'SERVORA_RELEASE_SHA=' + a.target.releaseSha) fail('FORWARD_HOST_START_GATE_DENIED');
  // O_EXCL consumes the slot permanently before any candidate instruction.
  publishExclusive(attempt + '/start-' + s.starts + '.json', canonical({...ticket,
    invocationId: process.env.INVOCATION_ID, consumedAtUTC: now()}));
  unlinkSync(PATHS.ticket); flushDirectory(dirname(PATHS.ticket));
  // The controller, outside the sandbox, retires the old-condition permit.
}

function lockedReexec(args) {
  const lock = PATHS.state + '/host.lock';
  protectedBytes(lock);
  if (process.env.SERVORA_FORWARD_LOCKED === '1') {
    const inode = lstatSync(lock);
    const fd = Number(process.env.SERVORA_FORWARD_LOCK_FD);
    const held = fstatSync(fd);
    const lockText = readFileSync('/proc/self/fdinfo/' + fd, 'utf8');
    if (held.ino !== inode.ino || held.dev !== inode.dev || !lockText.split('\n').some(line => /^lock:\s+\d+: FLOCK\s+ADVISORY\s+WRITE\s+/.test(line) && line.includes(':' + inode.ino + ' '))) fail('FORWARD_HOST_LOCK_NOT_HELD');
    return;
  }
  // fd 9 is opened once by the fixed shell; no caller path or shell text is accepted.
  const result = spawnSync('/usr/bin/flock', ['--nonblock', lock, '/usr/bin/env', '-i',
    ...Object.entries(CLEAN_ENV).map(([key, value]) => key + '=' + value), 'SERVORA_FORWARD_LOCKED=1',
    'SERVORA_FORWARD_LOCK_FD=3', '/usr/bin/node', PATHS.tool + '/forward-host.mjs', ...args],
  {env: CLEAN_ENV, stdio: 'inherit'});
  process.exit(result.status ?? 1);
}

async function main() {
  root();
  if (realpathSync(process.argv[1]) !== PATHS.tool + '/forward-host.mjs') fail('FORWARD_HOST_INSTALLED_TOOL_REQUIRED');
  const command = process.argv[2];
  if (process.argv.length !== 3) fail('FORWARD_HOST_ARGUMENTS_INVALID');
  if (command === 'start-gate') { await startGate(); return; }
  if (!['preflight', 'status', 'apply', 'smoke', 'observe', 'finish'].includes(command)) fail('FORWARD_HOST_COMMAND_INVALID');
  verifyTool(); checkDirectory(PATHS.root);
  const a = protectedJson(PATHS.root + '/authorization.json'); validateForwardAuthorizationStructure(a);
  const readOnly = ['preflight', 'status'].includes(command);
  if (!readOnly) lockedReexec([command]);
  // Artifact, CI, import closure and authority checks precede loading even
  // service-UID candidate dependencies with access to the database credential.
  let guardedCheck = async () => {};
  const io = await createHostIO(a, () => guardedCheck());
  await runForwardHost(io, a, 'preflight');
  const result = await holdDatabase(a, async check => {
    guardedCheck = check;
    await io.check();
    const journalPath = PATHS.root + '/' + a.attemptId + '/journal';
    if (!readOnly && existsSync(journalPath)) openHostJournal(journalPath).reconcile(log => validateHostLog(log, a,
      fileHash(PATHS.root + '/authorization.json'), io.toolHash));
    return runForwardHost(io, a, command);
  });
  process.stdout.write(canonical(result));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(error => {
  process.stderr.write((/^(?:FORWARD_HOST|FORWARD_TRANSITION|EMERGENCY_HANDOFF|RECOVERY|ATTEMPT)_[A-Z_]+$/.test(error.message) ? error.message : 'FORWARD_HOST_FAILED') + '\n');
  process.exitCode = 1;
});
