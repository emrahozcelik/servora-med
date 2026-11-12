/**
 * Root-only host adapter for the emergency restart-policy handoff.
 *
 * Invariants:
 * - Never starts, stops or restarts the application.
 * - Never migrates, restores, changes the release or resets the start budget.
 * - Never modifies the sealed R4 approval, profile, checkpoint or barrier history.
 * - Uses the installed, hash-bound canonical readers for the sealed parent.
 * - Every mutation is preceded by a durable INTENT record and followed by a
 *   durable DONE record. Re-running is idempotent or fails closed.
 *
 * The production path is fixed. A fixture cannot redirect these operations to
 * another host: the authorization binds machine-id, DB identity, parent
 * approval/profile/checkpoint, release and installed tooling, and the tool
 * refuses any mismatch.
 */
import {createHash, randomUUID} from 'node:crypto';
import {assertBootstrapManagementAllowed} from './bootstrap-fence.mjs';
import {
  closeSync, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, readFileSync, readSync, readdirSync, readlinkSync, realpathSync, unlinkSync,
  writeFileSync, constants,
} from 'node:fs';
import {request as httpRequest} from 'node:http';
import {spawn, spawnSync, execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {basename, join} from 'node:path';
import {
  validateEmergencyHandoffAuthorization,
  validateEmergencyHandoffAuthorizationStructure,
  initialEmergencyHandoff,
  advanceEmergencyHandoff,
  nextEmergencyHandoffAction,
  validateEmergencyHandoffChain,
  sealEmergencyHandoffReceipt,
  verifyEmergencyHandoffReceipt,
  emergencyAuthorizationBinding,
  EMERGENCY_OPERATIONAL_STATUS,
  EMERGENCY_R4_TERMINAL_STATE,
} from './emergency-handoff.mjs';
import {verifyInstalledArtifact} from './emergency-handoff-artifact.mjs';
import {loadAttempt, verifyAttemptRelease} from '/usr/local/libexec/servora-med/deployment-controller.mjs';
import {readLatestCheckpoint, readProtectedRecord, readRootApproval, readRootProfile}
  from '/usr/local/libexec/servora-med/deployment-attempt.mjs';
export {loadAttempt, verifyAttemptRelease, readLatestCheckpoint};

export const STATE_ROOT = '/var/lib/servora-med/deploy';
export const EMERGENCY_ROOT = STATE_ROOT + '/emergency';
export const AUTHORIZATION_FILE = EMERGENCY_ROOT + '/authorization.json';
export const ARTIFACT_ROOT = '/usr/local/libexec/servora-med-emergency';
export const INSTALLED = '/usr/local/libexec/servora-med';
export const DROPIN = '/etc/systemd/system/servora-med.service.d/90-servora-recovery.conf';
export const UNIT = '/etc/systemd/system/servora-med.service';
export const BARRIER = STATE_ROOT + '/activation.block';
export const OWNER = STATE_ROOT + '/active.json';
export const PERMIT = '/run/servora-med-recovery/start.permit';
export const ENV_FILE = '/etc/servora-med/servora-med.env';
export const HOST_LOCK = STATE_ROOT + '/host.lock';
export const CURRENT = '/opt/servora-med/current';
export const BACKUP_ROOT = STATE_ROOT + '/backups';
export const RECOVERY_POLICY = '[Service]\nRestart=no\n';
const JOURNAL_NAME = /^\d{4}\.json$/;
const JOURNAL_TEMP = /^\.[0-9a-f-]{36}\.tmp$/;
const MAX_RECORDS = 64;

const nowUTC = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const digest = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value) + '\n';
const fail = code => { throw new Error(code); };

export function assertRoot() {
  if (process.getuid?.() !== 0) fail('EMERGENCY_HANDOFF_ROOT_REQUIRED');
}

/**
 * Reads a root record that may still carry its paired publication temp
 * (final + temp hardlink, both nlink 2). It never removes the temp.
 */
function readEmergencyRecord(file) {
  const directory = file.slice(0, file.lastIndexOf('/'));
  const info = lstatSync(file);
  let paired = 0;
  for (const name of readdirSync(directory)) {
    if (!JOURNAL_TEMP.test(name)) continue;
    const temp = lstatSync(join(directory, name));
    if (temp.dev === info.dev && temp.ino === info.ino) paired += 1;
  }
  if (paired === 0) return readProtectedRecord(file);
  if (paired !== 1 || info.nlink !== 2) fail('EMERGENCY_HANDOFF_RECORD_UNTRUSTED');
  return readProtectedRecord(file, 2);
}

function flush(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function sha256File(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== 0 || info.gid !== 0 || info.nlink !== 1
      || (info.mode & 0o7777) !== 0o600) fail('EMERGENCY_HANDOFF_FILE_UNTRUSTED');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    let count;
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
    return hash.digest('hex');
  } finally { closeSync(fd); }
}

function assertRootDirectory(path) {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0
    || (info.mode & 0o7777) !== 0o700) fail('EMERGENCY_HANDOFF_DIRECTORY_UNTRUSTED');
}

export function ensureEmergencyRoot() {
  if (!existsSync(EMERGENCY_ROOT)) {
    mkdirSync(EMERGENCY_ROOT, {mode: 0o700});
    flush(STATE_ROOT);
  }
  assertRootDirectory(EMERGENCY_ROOT);
}

/** Read-only counterpart: never creates the emergency directory. */
function assertEmergencyRootIfPresent() {
  if (existsSync(EMERGENCY_ROOT)) assertRootDirectory(EMERGENCY_ROOT);
}

/** Publishes an immutable canonical record without ever overwriting one. */
export function publishRecord(directory, record) {
  const file = join(directory, String(record.sequence).padStart(4, '0') + '.json');
  if (existsSync(file)) {
    const existing = readProtectedRecord(file);
    if (JSON.stringify(existing.record) !== JSON.stringify(record)) {
      fail('EMERGENCY_HANDOFF_JOURNAL_CONFLICT');
    }
    return existing;
  }
  const temporary = join(directory, '.' + randomUUID() + '.tmp');
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
    | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, canonical(record)); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    linkSync(temporary, file);
    flush(directory);
  } finally {
    if (existsSync(temporary)) { unlinkSync(temporary); flush(directory); }
  }
  return readProtectedRecord(file);
}

function reconcileJournalTemps(directory) {
  const finals = readdirSync(directory).filter(name => JOURNAL_NAME.test(name))
    .map(name => lstatSync(join(directory, name)));
  for (const name of readdirSync(directory)) {
    if (!JOURNAL_TEMP.test(name)) continue;
    const path = join(directory, name);
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0) {
      fail('EMERGENCY_HANDOFF_JOURNAL_INVALID');
    }
    const published = finals.some(final => final.dev === info.dev && final.ino === info.ino);
    if (info.nlink === 1 || (published && info.nlink === 2)) {
      unlinkSync(path); flush(directory);
    } else if (info.nlink !== 2) {
      fail('EMERGENCY_HANDOFF_JOURNAL_INVALID');
    }
  }
}

/** Reconciles record temps, then the two named sidecar publications. */
export function reconcileJournalDirectory(directory) {
  reconcileJournalTemps(directory);
  reconcileNamedTemps(directory);
}

/** Finishes or discards only our own interrupted named publication. */
function reconcileNamedTemps(directory) {
  const finals = ['runtime.json', 'receipt.json', 'reboot.json'].map(name => {
    const path = join(directory, name);
    return existsSync(path) ? lstatSync(path) : null;
  });
  for (const name of readdirSync(directory)) {
    if (!JOURNAL_TEMP.test(name)) continue;
    const path = join(directory, name);
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0) {
      fail('EMERGENCY_HANDOFF_RECORD_UNTRUSTED');
    }
    const paired = finals.some(final => final && final.dev === info.dev && final.ino === info.ino);
    if (info.nlink === 2 && paired) { unlinkSync(path); flush(directory); continue; }
    fail('EMERGENCY_HANDOFF_RECORD_FOREIGN');
  }
}

function inspectJournalTemps(directory) {
  let pending = 0;
  for (const name of readdirSync(directory)) {
    if (!JOURNAL_TEMP.test(name)) continue;
    const info = lstatSync(join(directory, name));
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0
      || ![1, 2].includes(info.nlink)) {
      fail('EMERGENCY_HANDOFF_JOURNAL_INVALID');
    }
    pending += 1;
  }
  return pending;
}

/** Pure journal reader. It never removes interrupted publications. */
export function readJournalChain(directory) {
  const names = readdirSync(directory);
  for (const name of names) {
    if (!JOURNAL_NAME.test(name) && !JOURNAL_TEMP.test(name)
      && !['runtime.json', 'receipt.json', 'reboot.json'].includes(name)) {
      fail('EMERGENCY_HANDOFF_JOURNAL_INVALID');
    }
  }
  const records = names.filter(name => JOURNAL_NAME.test(name)).sort();
  if (records.length > MAX_RECORDS) fail('EMERGENCY_HANDOFF_JOURNAL_INVALID');
  records.forEach((name, index) => {
    if (name !== String(index).padStart(4, '0') + '.json') fail('EMERGENCY_HANDOFF_JOURNAL_INVALID');
  });
  const entries = records.map(name => readEmergencyRecord(join(directory, name)));
  if (entries.length === 0) return [];
  validateEmergencyHandoffChain(entries.map(entry => entry.record));
  return entries;
}

/** Read-only journal inspection used by verify/status. */
export function inspectJournal(directory) {
  assertRootDirectory(directory);
  const pendingPublications = inspectJournalTemps(directory);
  return {chain: readJournalChain(directory), pendingPublications};
}

export function publishNamedJson(file, body) {
  if (existsSync(file)) {
    const existing = readProtectedRecord(file).record;
    if (JSON.stringify(existing) !== JSON.stringify(body)) fail('EMERGENCY_HANDOFF_RECORD_CONFLICT');
    return readProtectedRecord(file);
  }
  const temporary = join(file.slice(0, file.lastIndexOf('/')), '.' + randomUUID() + '.tmp');
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
    | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, canonical(body)); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    linkSync(temporary, file);
    flush(file.slice(0, file.lastIndexOf('/')));
  } finally {
    if (existsSync(temporary)) { unlinkSync(temporary); flush(file.slice(0, file.lastIndexOf('/'))); }
  }
  return readProtectedRecord(file);
}

function requireRoot(path, mode = 0o600) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0
    || info.nlink !== 1 || (info.mode & 0o7777) !== mode) fail('EMERGENCY_HANDOFF_FILE_UNTRUSTED');
  return readFileSync(path, 'utf8');
}

export function systemctl(...args) {
  return execFileSync('/usr/bin/systemctl', args, {
    encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024,
    env: {PATH: '/usr/bin:/bin', LC_ALL: 'C'},
  });
}

export function serviceProperties() {
  const text = systemctl('show', 'servora-med.service', '-p', 'ActiveState', '-p', 'SubState',
    '-p', 'MainPID', '-p', 'NRestarts', '-p', 'Restart', '-p', 'DropInPaths',
    '-p', 'NeedDaemonReload', '-p', 'User', '-p', 'Group', '-p', 'WorkingDirectory',
    '-p', 'FragmentPath', '-p', 'ExecStart', '-p', 'EnvironmentFiles');
  const properties = {};
  for (const line of text.split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) properties[line.slice(0, at)] = line.slice(at + 1);
  }
  return properties;
}

export function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) fail('EMERGENCY_HANDOFF_PID_INVALID');
  let stat;
  try { stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { fail('EMERGENCY_HANDOFF_PID_INVALID'); }
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const startTime = fields[19];
  if (!/^\d+$/.test(startTime ?? '')) fail('EMERGENCY_HANDOFF_PID_INVALID');
  return {
    pid,
    startTime,
    cwd: realpathSync(`/proc/${pid}/cwd`),
    exe: realpathSync(`/proc/${pid}/exe`),
  };
}

function coreHealth(releaseSha) {
  return new Promise(resolve => {
    const request = httpRequest({
      host: '127.0.0.1', port: 3000, path: '/api/health', method: 'GET', timeout: 3000,
    }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { if (text.length < 8192) text += chunk; });
      response.on('end', () => {
        try {
          const body = JSON.parse(text);
          resolve(response.statusCode === 200 && body?.status === 'ok'
            && body?.releaseSha === releaseSha);
        } catch { resolve(false); }
      });
    });
    request.on('timeout', () => { request.destroy(); resolve(false); });
    request.on('error', () => resolve(false));
    request.end();
  });
}

/**
 * Read-only DB identity + exact catalog probe through the installed,
 * hash-bound service-UID guard. No secret is placed on a command line.
 */
export function probeDatabase(profile, approval) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/sudo', ['-u', 'servora-med', '--', '/usr/bin/env', '-i',
      'PATH=/usr/local/bin:/usr/bin:/bin', '/usr/bin/node', '--env-file=' + ENV_FILE,
      INSTALLED + '/deployment-db-guard.mjs', '--hold'],
    {stdio: ['pipe', 'pipe', 'pipe'], env: {PATH: '/usr/local/bin:/usr/bin:/bin'}});
    let stderr = '';
    child.stderr.on('data', chunk => { if (stderr.length < 4096) stderr += chunk.toString(); });
    const lines = createInterface({input: child.stdout, crlfDelay: Infinity})[Symbol.asyncIterator]();
    let exit = null;
    child.once('exit', (code, signal) => { exit = {code, signal}; });
    child.once('error', () => { exit = {code: -1, signal: null}; });
    const next = async expected => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, 15000);
      try {
        const line = await lines.next();
        if (line.done || line.value !== expected) {
          const code = stderr.trim();
          throw new Error(/^RECOVERY_DATABASE_[A-Z_]+$/.test(code) ? code : 'RECOVERY_DATABASE_PROBE_FAILED');
        }
      } finally { clearTimeout(timer); }
    };
    (async () => {
      child.stdin.write(JSON.stringify({
        releaseDirectory: '/opt/servora-med/releases/' + approval.releaseSha,
        expectedIdentity: profile.databaseIdentity,
        expectedCatalog: approval.targetCatalog.map(entry => entry.version),
      }) + '\n');
      await next('READY');
      child.stdin.write('CHECK\n');
      await next('EXACT');
      child.stdin.write('RELEASE\n');
      child.stdin.end();
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, 10000);
      try {
        while (exit === null) await new Promise(resolve => setTimeout(resolve, 20));
      } finally { clearTimeout(timer); }
      if (exit.code !== 0) fail('RECOVERY_DATABASE_PROBE_FAILED');
      resolve({applied: approval.targetCatalog.map(entry => entry.version)});
    })().catch(reject);
  });
}

export function assertBackups(attemptId, checkpoint) {
  const receipts = {pre: checkpoint.predeployBackup, post: checkpoint.postdeployBackup};
  for (const kind of ['pre', 'post']) {
    const receipt = receipts[kind];
    if (!receipt || !/^[0-9a-f]{64}$/.test(receipt.sha256 ?? '')) {
      fail('EMERGENCY_HANDOFF_BACKUP_MISSING');
    }
    const file = `${BACKUP_ROOT}/${attemptId}-${kind}.dump`;
    if (!existsSync(file)) fail('EMERGENCY_HANDOFF_BACKUP_MISSING');
    if (sha256File(file) !== receipt.sha256) fail('EMERGENCY_HANDOFF_BACKUP_MISMATCH');
  }
}

function readOptionalProtected(path) {
  if (!existsSync(path)) return null;
  return readEmergencyRecord(path).record;
}

function foreignEmergencyEntries(journalDirectoryName) {
  if (!existsSync(EMERGENCY_ROOT)) return false;
  return readdirSync(EMERGENCY_ROOT).some(name => name !== 'authorization.json'
    && name !== journalDirectoryName);
}

/** Stored owner/barrier must belong to the authorized parent. */
function assertStoredOwnershipMatches(authorization) {
  const parent = authorization.parent;
  const owner = readOptionalProtected(OWNER);
  if (owner && (owner.attemptId !== parent.attemptId
    || owner.approvalSha256 !== parent.approvalSha256)) {
    fail('EMERGENCY_HANDOFF_OWNER_UNTRUSTED');
  }
  const barrier = readOptionalProtected(BARRIER);
  if (barrier && (barrier.attemptId !== parent.attemptId
    || barrier.approvalSha256 !== parent.approvalSha256)) {
    fail('EMERGENCY_HANDOFF_BARRIER_UNTRUSTED');
  }
}

/** A present owner/barrier must always belong to the authorized parent. */
function assertLiveOwnershipMatches(authorization, captured) {
  const parent = authorization.parent;
  if (captured.meta.owner
    && (captured.live.activeAttemptId !== parent.attemptId
      || captured.live.activeApprovalSha256 !== parent.approvalSha256)) {
    fail('EMERGENCY_HANDOFF_OWNER_UNTRUSTED');
  }
  if (captured.meta.barrier
    && (captured.live.barrierAttemptId !== parent.attemptId
      || captured.live.barrierApprovalSha256 !== parent.approvalSha256)) {
    fail('EMERGENCY_HANDOFF_BARRIER_UNTRUSTED');
  }
}

/** Read-only rejection of unrelated emergency state before any mutation. */
function assertEmergencyRootEntries(authorizationId) {
  if (!existsSync(EMERGENCY_ROOT)) return;
  for (const name of readdirSync(EMERGENCY_ROOT)) {
    if (name === 'authorization.json' || name === authorizationId) continue;
    fail('EMERGENCY_HANDOFF_FOREIGN_STATE');
  }
}

/**
 * Captures the current live state. `verify`/`apply` share this exact shape.
 */
export async function captureLive(approval, profile, checkpoint, journalDirectoryName) {
  const properties = serviceProperties();
  const owner = readOptionalProtected(OWNER);
  const barrier = readOptionalProtected(BARRIER);
  const permitPresent = existsSync(PERMIT);
  const pid = Number(properties.MainPID);
  const appActive = properties.ActiveState === 'active' && properties.SubState === 'running'
    && Number.isSafeInteger(pid) && pid > 0;
  const releaseSha = basename(realpathSync(CURRENT));
  const identity = appActive ? processIdentity(pid) : null;
  const db = await probeDatabase(profile, approval).catch(error => {
    throw new Error(error.message === 'RECOVERY_DATABASE_NOT_EXACT'
      || error.message === 'RECOVERY_DATABASE_IDENTITY_MISMATCH'
      ? error.message : 'RECOVERY_DATABASE_PROBE_FAILED');
  });
  const health = appActive ? await coreHealth(approval.releaseSha) : false;
  return {
    observed: {
      dropInPresent: existsSync(DROPIN),
      restartPolicy: properties.Restart,
      needDaemonReload: properties.NeedDaemonReload === 'yes',
      barrierPresent: barrier !== null,
      ownerPresent: owner !== null,
      permitPresent,
      receiptPresent: false,
    },
    live: {
      activeAttemptId: owner?.attemptId ?? null,
      activeApprovalSha256: owner?.approvalSha256 ?? null,
      barrierAttemptId: barrier?.attemptId ?? null,
      barrierApprovalSha256: barrier?.approvalSha256 ?? null,
      permitPresent,
      foreignOwner: foreignEmergencyEntries(journalDirectoryName),
      appActive,
      appPid: appActive ? pid : 0,
      coreHealth: health,
      releaseSha,
      schemaHead: db.applied.at(-1),
      starts: checkpoint.starts,
      maxStarts: approval.maxStarts,
      dropInPresent: existsSync(DROPIN),
      restartPolicy: properties.Restart,
      needDaemonReload: properties.NeedDaemonReload === 'yes',
    },
    meta: {properties, owner, barrier, identity, pid, db},
  };
}

export function readAuthorization() {
  if (!existsSync(AUTHORIZATION_FILE)) fail('EMERGENCY_HANDOFF_AUTHORIZATION_MISSING');
  const {record, sha256} = readProtectedRecord(AUTHORIZATION_FILE);
  validateEmergencyHandoffAuthorizationStructure(record);
  return {authorization: record, authorizationSha256: sha256};
}

export function journalDirectory(authorizationId) {
  return join(EMERGENCY_ROOT, authorizationId);
}

export function readRuntime(directory, authorizationSha256) {
  const file = join(directory, 'runtime.json');
  if (!existsSync(file)) fail('EMERGENCY_HANDOFF_RUNTIME_INVALID');
  const {record, sha256} = readEmergencyRecord(file);
  if (record.formatVersion !== 1 || record.kind !== 'EMERGENCY_HANDOFF_RUNTIME'
    || typeof record.authorizationId !== 'string' || record.authorizationSha256 !== authorizationSha256
    || typeof record.startedAtUTC !== 'string' || typeof record.bootId !== 'string'
    || !Number.isSafeInteger(record.pid) || record.pid < 1 || typeof record.startTime !== 'string'
    || record.initialContext === null || typeof record.initialContext !== 'object'
    || record.initialContext.parent === null || typeof record.initialContext.parent !== 'object'
    || record.initialContext.host === null || typeof record.initialContext.host !== 'object'
    || record.initialContext.live === null || typeof record.initialContext.live !== 'object') {
    fail('EMERGENCY_HANDOFF_RUNTIME_INVALID');
  }
  return record;
}

export function publishRuntime(directory, context, identity, authorizationSha256) {
  const body = {
    formatVersion: 1, kind: 'EMERGENCY_HANDOFF_RUNTIME',
    authorizationId: context.authorizationId ?? null,
    authorizationSha256,
    startedAtUTC: context.nowUTC,
    bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    pid: identity.pid,
    startTime: identity.startTime,
    initialContext: {
      parent: context.parent, host: context.host, backups: context.backups, live: context.live,
    },
  };
  return publishNamedJson(join(directory, 'runtime.json'), body).record;
}

export function assertPidStable(runtime, identity) {
  if (!identity || identity.pid !== runtime.pid || identity.startTime !== runtime.startTime) {
    fail('EMERGENCY_HANDOFF_PID_CHANGED');
  }
}

const currentBootId = () => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();

/**
 * Same-boot handoffs require the exact PID/start-time captured at INTENT. A
 * reboot necessarily replaces the process; it is accepted only as an explicit,
 * sealed observation that binds the previous and current boot/process pairs.
 * No restart is ever hidden: the receipt records REBOOT_OBSERVED.
 */
export function ensureProcessContinuity(directory, runtime, captured, {publish = true} = {}) {
  const bootId = currentBootId();
  if (runtime.bootId === bootId) {
    assertPidStable(runtime, captured.meta.identity);
    return {mode: 'PRESERVED', rebootObservationSha256: null};
  }
  if (!captured.live.appActive || !captured.live.coreHealth) {
    fail('EMERGENCY_HANDOFF_HEALTH_LOST');
  }
  const file = join(directory, 'reboot.json');
  const expected = {
    previous: {bootId: runtime.bootId, pid: runtime.pid, startTime: runtime.startTime},
    current: {bootId, pid: captured.meta.identity.pid,
      startTime: captured.meta.identity.startTime},
  };
  if (existsSync(file)) {
    const {record, sha256} = readEmergencyRecord(file);
    if (record.formatVersion !== 1 || record.kind !== 'EMERGENCY_HANDOFF_REBOOT_OBSERVATION'
      || record.authorizationId !== runtime.authorizationId
      || record.authorizationSha256 !== runtime.authorizationSha256
      || JSON.stringify(record.previous) !== JSON.stringify(expected.previous)
      || JSON.stringify(record.current) !== JSON.stringify(expected.current)) {
      fail('EMERGENCY_HANDOFF_REBOOT_OBSERVATION_CONFLICT');
    }
    return {mode: 'REBOOT_OBSERVED', rebootObservationSha256: sha256};
  }
  if (!publish) {
    return {mode: 'REBOOT_OBSERVED_PENDING', rebootObservationSha256: null};
  }
  const {sha256} = publishNamedJson(file, {
    formatVersion: 1, kind: 'EMERGENCY_HANDOFF_REBOOT_OBSERVATION',
    authorizationId: runtime.authorizationId,
    authorizationSha256: runtime.authorizationSha256,
    previous: expected.previous, current: expected.current, observedAtUTC: nowUTC(),
  });
  return {mode: 'REBOOT_OBSERVED', rebootObservationSha256: sha256};
}

/**
 * Completes our own interrupted daemon-reload before the canonical host
 * verifier runs. The R4 verifier only tolerates the policy-unlinked pending
 * state for an already ACCEPTED attempt (it samples fresh trusted time), which
 * this emergency handoff is not. The reload is idempotent and touches no
 * business state.
 */
function completeOwnedReload() {
  const properties = serviceProperties();
  if (properties.NeedDaemonReload !== 'yes' || existsSync(DROPIN)) return false;
  if (properties.DropInPaths !== '' && properties.DropInPaths !== DROPIN) return false;
  if (!['no', 'on-failure'].includes(properties.Restart)) return false;
  systemctl('daemon-reload');
  return true;
}

/** Exact sealed-parent eligibility shared by preflight and issuance. */
export function assertParentEligible(checkpoint, approval) {
  if (checkpoint.phase !== 'POSTDEPLOY_BACKUP_PASSED' || checkpoint.migrationCommitted !== true
    || checkpoint.smokePassed !== true || !checkpoint.postdeployBackup
    || checkpoint.starts < 1 || checkpoint.starts !== approval.maxStarts
    || checkpoint.lastStart !== 'pass') {
    fail('EMERGENCY_HANDOFF_PARENT_NOT_ELIGIBLE');
  }
}

/**
 * Read-only parent load for verify while our own policy unlink is pending.
 * loadAttempt() samples trusted time through acceptedHandoffDirection() in that
 * exact systemd state; those canonical modules are hash-bound and must not be
 * changed. This path keeps the same approval/profile/checkpoint binding without
 * reloading systemd or sampling the broken production collector.
 */
function loadParentReadOnly(attemptId) {
  const context = readRootApproval(attemptId);
  const profile = readRootProfile(context.approval);
  if (readFileSync('/etc/machine-id', 'utf8').trim() !== profile.machineId) {
    fail('RECOVERY_HOST_MACHINE_MISMATCH');
  }
  return {...context, profile};
}

/** Read-only release identity proof for the pending-reload verify path. */
function assertReleaseIdentity(approval) {
  const root = '/opt/servora-med/releases/' + approval.releaseSha;
  if (realpathSync(CURRENT) !== root) fail('RECOVERY_RELEASE_UNPROVEN');
  if (readFileSync(root + '/.servora-release-artifact.sha256', 'utf8')
    !== approval.artifactSha256 + '\n') fail('RECOVERY_RELEASE_UNPROVEN');
  const retained = `${STATE_ROOT}/artifacts/${approval.releaseSha}.tar.gz`;
  if (!existsSync(retained) || sha256File(retained) !== approval.artifactSha256) {
    fail('RECOVERY_RELEASE_UNPROVEN');
  }
}

/** Read-only detection of our own interrupted policy unlink. */
function detectPendingReload(properties = serviceProperties()) {
  return properties.NeedDaemonReload === 'yes' && !existsSync(DROPIN)
    && (properties.DropInPaths === '' || properties.DropInPaths === DROPIN)
    && ['no', 'on-failure'].includes(properties.Restart);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : null;
}

const ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Acquires the fixed host lock by re-executing the CLI under flock. */
export function withHostLock(argv) {
  if (process.env.SERVORA_EH_LOCKED === '1') {
    const lock = realpathSync(HOST_LOCK);
    const held = readdirSync('/proc/self/fd').some(fd => {
      try { return readlinkSync('/proc/self/fd/' + fd) === lock; } catch { return false; }
    });
    if (!held) fail('EMERGENCY_HANDOFF_LOCK_NOT_HELD');
    return null;
  }
  const result = spawnSync('/usr/bin/flock', ['--nonblock', HOST_LOCK, process.execPath,
    process.argv[1], ...argv], {
    stdio: 'inherit', env: {...process.env, SERVORA_EH_LOCKED: '1'},
  });
  process.exit(result.status ?? 1);
}

function assertDropInTrusted() {
  if (requireRoot(DROPIN) !== RECOVERY_POLICY) fail('EMERGENCY_HANDOFF_POLICY_UNTRUSTED');
}

function assertBarrierMatches(authorization) {
  const barrier = readEmergencyRecord(BARRIER).record;
  if (Object.keys(barrier).length !== 2
    || barrier.attemptId !== authorization.parent.attemptId
    || barrier.approvalSha256 !== authorization.parent.approvalSha256) {
    fail('EMERGENCY_HANDOFF_BARRIER_UNTRUSTED');
  }
}

function assertOwnerMatches(authorization) {
  const owner = readEmergencyRecord(OWNER).record;
  if (Object.keys(owner).length !== 2
    || owner.attemptId !== authorization.parent.attemptId
    || owner.approvalSha256 !== authorization.parent.approvalSha256) {
    fail('EMERGENCY_HANDOFF_OWNER_UNTRUSTED');
  }
}

function unlinkAndFlush(path, directory) {
  unlinkSync(path);
  flush(directory);
}

/** Publishes the intent exactly once; a resumed intent phase is reused. */
function ensureIntent(directory, latest, predecessor, intent, timestamp) {
  if (latest.phase === predecessor) {
    return publishRecord(directory, advanceEmergencyHandoff(latest, intent, timestamp)).record;
  }
  if (latest.phase === intent) return latest;
  fail('EMERGENCY_HANDOFF_STATE_AMBIGUOUS');
}

/**
 * Runs the handoff. `execute: false` (verify) is strictly read-only: it never
 * creates directories, reloads systemd, reconciles journal residue or writes a
 * reboot observation. Mutations only run on the authorized `apply` path after
 * the authorization and its journal ownership have been validated.
 */
export async function runHandoff({execute = true} = {}) {
  assertRoot();
  const artifact = verifyInstalledArtifact(ARTIFACT_ROOT);
  if (execute) ensureEmergencyRoot();
  else assertEmergencyRootIfPresent();
  const {authorization, authorizationSha256} = readAuthorization();
  assertEmergencyRootEntries(authorization.authorizationId);
  const parentId = authorization.parent?.attemptId;
  const directory = journalDirectory(authorization.authorizationId);
  const directoryName = authorization.authorizationId;
  const journalExists = existsSync(directory);
  if (journalExists) assertRootDirectory(directory);
  let runtime = null;
  const pendingReload = detectPendingReload();
  let inspection = journalExists
    ? inspectJournal(directory) : {chain: [], pendingPublications: 0};
  // Completing our own interrupted policy unlink is the only systemd mutation.
  // It is gated on this authorization's journal and never runs for verify.
  if (execute && pendingReload && journalExists) {
    const latest = inspection.chain.at(-1)?.record;
    if (!latest || latest.phase !== 'POLICY_INTENT'
      || latest.authorizationId !== authorization.authorizationId
      || latest.authorizationSha256 !== authorizationSha256
      || latest.toolArtifactSha256 !== artifact.artifactSha256) {
      fail('EMERGENCY_HANDOFF_POLICY_UNTRUSTED');
    }
    runtime = readRuntime(directory, authorizationSha256);
    if (runtime.initialContext.parent?.attemptId !== authorization.parent?.attemptId
      || runtime.initialContext.parent?.checkpointSha256 !== authorization.parent?.checkpointSha256
      || runtime.initialContext.host?.machineId !== authorization.host?.machineId
      || runtime.initialContext.host?.releaseArtifactSha256 !== authorization.host?.releaseArtifactSha256) {
      fail('EMERGENCY_HANDOFF_RUNTIME_BINDING_MISMATCH');
    }
    assertStoredOwnershipMatches(authorization);
    completeOwnedReload();
    inspection = inspectJournal(directory);
  }
  const deferReleaseProof = !execute && pendingReload;
  const loaded = deferReleaseProof ? loadParentReadOnly(parentId) : loadAttempt(parentId);
  if (loaded.approvalSha256 !== authorization.parent.approvalSha256) {
    fail('EMERGENCY_HANDOFF_BINDING_MISMATCH');
  }
  const checkpointFile = readLatestCheckpoint(parentId);
  const checkpoint = checkpointFile.record;
  if (deferReleaseProof) assertReleaseIdentity(loaded.approval);
  else verifyAttemptRelease(parentId, 'target');
  assertBackups(parentId, checkpoint);
  const binding = emergencyAuthorizationBinding({
    attemptId: parentId, approvalSha256: loaded.approvalSha256,
    profileSha256: loaded.approval.profileSha256,
    checkpoint: {...checkpoint, sha256: checkpointFile.sha256},
    approval: loaded.approval, profile: loaded.profile,
  });
  const captured = await captureLive(loaded.approval, loaded.profile, checkpoint, directoryName);
  assertLiveOwnershipMatches(authorization, captured);
  if (captured.live.releaseSha !== authorization.host.releaseSha) fail('EMERGENCY_HANDOFF_BINDING_MISMATCH');
  let chain = inspection.chain;
  if (chain.length > 0 && (chain[0].record.authorizationId !== authorization.authorizationId
    || chain[0].record.authorizationSha256 !== authorizationSha256)) {
    fail('EMERGENCY_HANDOFF_OTHER_AUTHORIZATION');
  }
  const journalState = {
    present: chain.length > 0,
    authorizationId: chain.length > 0 ? authorization.authorizationId : null,
    authorizationSha256: chain.length > 0 ? authorizationSha256 : null,
    terminal: chain.length > 0 && chain.at(-1).record.phase === 'HANDOFF_COMPLETE',
  };
  const backups = {
    preSha256: checkpoint.predeployBackup?.sha256 ?? '',
    postSha256: checkpoint.postdeployBackup?.sha256 ?? '',
  };
  const base = {
    authorizationSha256, toolArtifactSha256: artifact.artifactSha256,
    parent: binding.parent, host: binding.host, backups, journal: journalState,
  };
  if (chain.length === 0) {
    const runtimePath = join(directory, 'runtime.json');
    const previous = existsSync(runtimePath) ? readRuntime(directory, authorizationSha256) : null;
    const context = {...base,
      nowUTC: previous ? previous.startedAtUTC : nowUTC(),
      live: previous ? previous.initialContext.live : captured.live};
    validateEmergencyHandoffAuthorization(authorization, context);
    if (!execute) {
      return {result: 'EMERGENCY_HANDOFF_READY', nextAction: 'START',
        authorizationId: authorization.authorizationId, toolArtifactSha256: artifact.artifactSha256,
        readOnly: true, pendingReload, pendingPublications: inspection.pendingPublications};
    }
    if (!existsSync(directory)) { mkdirSync(directory, {mode: 0o700}); flush(EMERGENCY_ROOT); }
    assertRootDirectory(directory);
    // Reconciliation is a mutation; it runs only after the authorization was
    // validated above and this journal directory is bound to it.
    reconcileJournalDirectory(directory);
    if (existsSync(join(directory, '0000.json'))) fail('EMERGENCY_HANDOFF_JOURNAL_CONFLICT');
    if (previous) {
      runtime = previous;
    } else {
      runtime = publishRuntime(directory, {...context, authorizationId: authorization.authorizationId},
        captured.meta.identity, authorizationSha256);
    }
    const initialContinuity = ensureProcessContinuity(directory, runtime, captured);
    if (!initialContinuity) fail('EMERGENCY_HANDOFF_PID_INVALID');
    publishRecord(directory, initialEmergencyHandoff(authorization, context));
  } else {
    if (runtime === null) runtime = readRuntime(directory, authorizationSha256);
    if (runtime.authorizationId !== authorization.authorizationId
      || runtime.authorizationSha256 !== authorizationSha256
      || runtime.initialContext.parent.checkpointSha256 !== binding.parent.checkpointSha256
      || runtime.initialContext.host.machineId !== binding.host.machineId
      || runtime.initialContext.host.releaseArtifactSha256 !== binding.host.releaseArtifactSha256) {
      fail('EMERGENCY_HANDOFF_RUNTIME_BINDING_MISMATCH');
    }
    const resumed = {...runtime.initialContext, nowUTC: runtime.startedAtUTC,
      authorizationSha256, toolArtifactSha256: artifact.artifactSha256,
      journal: {present: true, authorizationId: authorization.authorizationId,
        authorizationSha256, terminal: journalState.terminal}};
    validateEmergencyHandoffAuthorization(authorization, resumed);
    if (execute) {
      reconcileJournalDirectory(directory);
      inspection = inspectJournal(directory);
      chain = inspection.chain;
    }
  }
  let continuity = {mode: 'PRESERVED', rebootObservationSha256: null};
  for (let round = 0; round < MAX_RECORDS; round += 1) {
    const records = readJournalChain(directory);
    const latest = records.at(-1).record;
    const receiptPath = join(directory, 'receipt.json');
    const receiptPresent = existsSync(receiptPath);
    const current = await captureLive(loaded.approval, loaded.profile, checkpoint, directoryName);
    if (current.live.foreignOwner) fail('EMERGENCY_HANDOFF_FOREIGN_STATE');
    assertLiveOwnershipMatches(authorization, current);
    if (!receiptPresent && current.live.releaseSha !== authorization.host.releaseSha) {
      fail('EMERGENCY_HANDOFF_RELEASE_CHANGED');
    }
    const action = nextEmergencyHandoffAction(latest, {
      ...current.observed, receiptPresent,
    });
    if (action === 'STOP') fail('EMERGENCY_HANDOFF_STATE_AMBIGUOUS');
    if (action === 'DONE') {
      const receipt = readEmergencyRecord(receiptPath).record;
      verifyEmergencyHandoffReceipt(receipt, {
        authorizationId: authorization.authorizationId, authorizationSha256,
        toolArtifactSha256: authorization.toolArtifactSha256, parent: binding.parent,
      });
      return {result: 'EMERGENCY_HANDOFF_ALREADY_COMPLETE',
        operationalStatus: EMERGENCY_OPERATIONAL_STATUS,
        r4TerminalState: EMERGENCY_R4_TERMINAL_STATE, r4Acceptance: 'NOT_ACCEPTED',
        parentAttemptId: parentId, authorizationId: authorization.authorizationId,
        receiptSha256: receipt.hash, journalHeadSha256: latest.hash,
        steps: latest.steps, appPid: current.meta.identity?.pid ?? runtime.pid,
        initialAppPid: runtime.pid,
        processContinuity: receipt.handoff.processContinuity,
        readOnly: !execute, pendingReload, pendingPublications: inspection.pendingPublications};
    }
    if (!receiptPresent) {
      continuity = ensureProcessContinuity(directory, runtime, current, {publish: execute});
    }
    if (!execute) {
      return {result: 'EMERGENCY_HANDOFF_READY', nextAction: action,
        authorizationId: authorization.authorizationId,
        toolArtifactSha256: artifact.artifactSha256,
        readOnly: true, pendingReload, pendingPublications: inspection.pendingPublications,
        processContinuity: continuity.mode};
    }
    const timestamp = nowUTC();
    if (action === 'REMOVE_BARRIER') {
      assertBarrierMatches(authorization);
      ensureIntent(directory, latest, 'POLICY_RESTORED', 'BARRIER_INTENT', timestamp);
      unlinkAndFlush(BARRIER, STATE_ROOT);
      const after = await captureLive(loaded.approval, loaded.profile, checkpoint, directoryName);
      ensureProcessContinuity(directory, runtime, after);
      if (after.observed.barrierPresent) fail('EMERGENCY_HANDOFF_BARRIER_UNTRUSTED');
      publishRecord(directory, advanceEmergencyHandoff(readJournalChain(directory).at(-1).record,
        'BARRIER_REMOVED', nowUTC()));
      continue;
    }
    if (action === 'RECORD_BARRIER') {
      const pending = ensureIntent(directory, latest, 'POLICY_RESTORED', 'BARRIER_INTENT', timestamp);
      publishRecord(directory, advanceEmergencyHandoff(pending, 'BARRIER_REMOVED', timestamp));
      continue;
    }
    if (action === 'REMOVE_POLICY') {
      assertDropInTrusted();
      ensureIntent(directory, latest, 'INTENT', 'POLICY_INTENT', timestamp);
      unlinkAndFlush(DROPIN, '/etc/systemd/system/servora-med.service.d');
      systemctl('daemon-reload');
      const after = await captureLive(loaded.approval, loaded.profile, checkpoint, directoryName);
      ensureProcessContinuity(directory, runtime, after);
      if (after.observed.dropInPresent || after.observed.restartPolicy !== 'on-failure'
        || after.observed.needDaemonReload) fail('EMERGENCY_HANDOFF_POLICY_UNTRUSTED');
      publishRecord(directory, advanceEmergencyHandoff(readJournalChain(directory).at(-1).record,
        'POLICY_RESTORED', nowUTC()));
      continue;
    }
    if (action === 'RELOAD_POLICY') {
      systemctl('daemon-reload');
      const after = await captureLive(loaded.approval, loaded.profile, checkpoint, directoryName);
      ensureProcessContinuity(directory, runtime, after);
      if (after.observed.restartPolicy !== 'on-failure' || after.observed.needDaemonReload) {
        fail('EMERGENCY_HANDOFF_POLICY_UNTRUSTED');
      }
      publishRecord(directory, advanceEmergencyHandoff(latest, 'POLICY_RESTORED', timestamp));
      continue;
    }
    if (action === 'RECORD_POLICY') {
      const pending = ensureIntent(directory, latest, 'INTENT', 'POLICY_INTENT', timestamp);
      publishRecord(directory, advanceEmergencyHandoff(pending, 'POLICY_RESTORED', timestamp));
      continue;
    }
    if (action === 'RETIRE_OWNER') {
      assertOwnerMatches(authorization);
      if (!latest.steps.barrierRemoved || !latest.steps.policyRestored) {
        fail('EMERGENCY_HANDOFF_STATE_AMBIGUOUS');
      }
      ensureIntent(directory, latest, 'BARRIER_REMOVED', 'OWNER_INTENT', timestamp);
      unlinkAndFlush(OWNER, STATE_ROOT);
      const after = await captureLive(loaded.approval, loaded.profile, checkpoint, directoryName);
      ensureProcessContinuity(directory, runtime, after);
      if (after.observed.ownerPresent) fail('EMERGENCY_HANDOFF_OWNER_UNTRUSTED');
      publishRecord(directory, advanceEmergencyHandoff(readJournalChain(directory).at(-1).record,
        'OWNER_RETIRED', nowUTC()));
      continue;
    }
    if (action === 'RECORD_OWNER') {
      const pending = ensureIntent(directory, latest, 'BARRIER_REMOVED', 'OWNER_INTENT', timestamp);
      publishRecord(directory, advanceEmergencyHandoff(pending, 'OWNER_RETIRED', timestamp));
      continue;
    }
    if (action === 'SEAL_COMPLETE') {
      publishRecord(directory, advanceEmergencyHandoff(latest, 'HANDOFF_COMPLETE', timestamp));
      continue;
    }
    if (action === 'SEAL_RECEIPT') {
      const receipt = sealEmergencyHandoffReceipt(latest, authorization, {
        ...runtime.initialContext, nowUTC: runtime.startedAtUTC,
        authorizationSha256, toolArtifactSha256: artifact.artifactSha256,
        journal: {present: true, authorizationId: authorization.authorizationId,
          authorizationSha256, terminal: false},
      }, timestamp, continuity);
      publishNamedJson(receiptPath, receipt);
      verifyEmergencyHandoffReceipt(receipt, {
        authorizationId: authorization.authorizationId, authorizationSha256,
        toolArtifactSha256: authorization.toolArtifactSha256, parent: binding.parent,
      });
      return {result: 'EMERGENCY_HANDOFF_COMPLETE',
        operationalStatus: EMERGENCY_OPERATIONAL_STATUS,
        r4TerminalState: EMERGENCY_R4_TERMINAL_STATE, r4Acceptance: 'NOT_ACCEPTED',
        parentAttemptId: parentId, authorizationId: authorization.authorizationId,
        receiptSha256: receipt.hash, journalHeadSha256: latest.hash,
        steps: latest.steps, appPid: current.meta.identity?.pid ?? runtime.pid,
        initialAppPid: runtime.pid,
        processContinuity: receipt.handoff.processContinuity,
        readOnly: false, pendingReload, pendingPublications: inspection.pendingPublications};
    }
  }
  fail('EMERGENCY_HANDOFF_LOOP_EXHAUSTED');
}

/**
 * Read-only preflight. It can run before any authorization exists and never
 * creates the emergency directory, reloads systemd or touches journal residue.
 */
export async function preflight() {
  assertRoot();
  const artifact = verifyInstalledArtifact(ARTIFACT_ROOT);
  assertEmergencyRootIfPresent();
  const explicit = argument('--parent');
  let parentId = explicit;
  if (parentId !== null && !ATTEMPT_ID.test(parentId)) fail('EMERGENCY_HANDOFF_ARGUMENTS_INVALID');
  if (parentId === null) {
    for (const path of [OWNER, BARRIER]) {
      if (!existsSync(path)) continue;
      const record = readEmergencyRecord(path).record;
      if (ATTEMPT_ID.test(record.attemptId ?? '')) { parentId = record.attemptId; break; }
    }
  }
  if (parentId === null) fail('EMERGENCY_HANDOFF_PREFLIGHT_PARENT_UNKNOWN');
  const authorizationPresent = existsSync(AUTHORIZATION_FILE);
  let journalPresent = false;
  let journalPhase = null;
  let pendingPublications = 0;
  let journalAuthorizationId = null;
  if (authorizationPresent) {
    const {authorization} = readAuthorization();
    assertEmergencyRootEntries(authorization.authorizationId);
    const directory = journalDirectory(authorization.authorizationId);
    journalAuthorizationId = authorization.authorizationId;
    if (existsSync(directory)) {
      const inspection = inspectJournal(directory);
      journalPresent = inspection.chain.length > 0;
      journalPhase = inspection.chain.at(-1)?.record.phase ?? null;
      pendingPublications = inspection.pendingPublications;
    }
  } else if (existsSync(EMERGENCY_ROOT) && readdirSync(EMERGENCY_ROOT).length > 0) {
    fail('EMERGENCY_HANDOFF_FOREIGN_STATE');
  }
  if (detectPendingReload()) fail('EMERGENCY_HANDOFF_RECOVERY_PENDING');
  const parent = loadAttempt(parentId);
  const checkpointFile = readLatestCheckpoint(parentId);
  const checkpoint = checkpointFile.record;
  assertParentEligible(checkpoint, parent.approval);
  verifyAttemptRelease(parentId, 'target');
  assertBackups(parentId, checkpoint);
  const binding = emergencyAuthorizationBinding({
    attemptId: parentId, approvalSha256: parent.approvalSha256,
    profileSha256: parent.approval.profileSha256,
    checkpoint: {...checkpoint, sha256: checkpointFile.sha256},
    approval: parent.approval, profile: parent.profile,
  });
  const captured = await captureLive(parent.approval, parent.profile, checkpoint,
    journalAuthorizationId);
  const live = captured.live;
  if (live.activeAttemptId !== parentId || live.activeApprovalSha256 !== parent.approvalSha256
    || live.barrierAttemptId !== parentId || live.barrierApprovalSha256 !== parent.approvalSha256
    || live.permitPresent || live.foreignOwner || !live.appActive || !live.coreHealth
    || live.releaseSha !== binding.host.releaseSha
    || live.schemaHead !== binding.parent.schemaHead
    || live.starts !== binding.parent.starts || live.maxStarts !== binding.parent.maxStarts
    || live.dropInPresent !== true || live.restartPolicy !== 'no'
    || live.needDaemonReload !== false) {
    fail('EMERGENCY_HANDOFF_PREFLIGHT_STATE_MISMATCH');
  }
  return {
    kind: 'EMERGENCY_HANDOFF_PREFLIGHT',
    result: 'EMERGENCY_HANDOFF_PREFLIGHT_READY',
    readOnly: true,
    parentAttemptId: parentId,
    checkpointSequence: checkpoint.sequence,
    checkpointSha256: checkpointFile.sha256,
    releaseSha: binding.host.releaseSha,
    releaseArtifactSha256: binding.host.releaseArtifactSha256,
    schemaHead: binding.parent.schemaHead,
    startBudget: {used: live.starts, max: live.maxStarts},
    app: {active: live.appActive, pid: live.appPid, coreHealth: live.coreHealth},
    state: {dropInPresent: live.dropInPresent, restartPolicy: live.restartPolicy,
      barrierPresent: live.barrierAttemptId !== null, ownerPresent: live.activeAttemptId !== null,
      permitPresent: live.permitPresent},
    toolArtifactSha256: artifact.artifactSha256,
    emergencyRootPresent: existsSync(EMERGENCY_ROOT),
    authorizationPresent, journalPresent, journalPhase, pendingPublications,
  };
}

/** Read-only status. Never reloads systemd or reconciles journal residue. */
export function status() {
  assertRoot();
  const artifact = verifyInstalledArtifact(ARTIFACT_ROOT);
  assertEmergencyRootIfPresent();
  const {authorization, authorizationSha256} = readAuthorization();
  assertEmergencyRootEntries(authorization.authorizationId);
  const directory = journalDirectory(authorization.authorizationId);
  const inspection = existsSync(directory)
    ? inspectJournal(directory) : {chain: [], pendingPublications: 0};
  const receiptPath = join(directory, 'receipt.json');
  const receipt = existsSync(receiptPath) ? readEmergencyRecord(receiptPath).record : null;
  if (receipt) {
    verifyEmergencyHandoffReceipt(receipt, {
      authorizationId: authorization.authorizationId,
      authorizationSha256,
      toolArtifactSha256: authorization.toolArtifactSha256,
      parent: authorization.parent,
    });
  }
  return {kind: 'EMERGENCY_HANDOFF_STATUS', readOnly: true,
    authorizationPresent: true, authorizationId: authorization.authorizationId,
    authorizationSha256, toolArtifactSha256: artifact.artifactSha256,
    journalPresent: inspection.chain.length > 0,
    journalPhase: inspection.chain.at(-1)?.record.phase ?? null,
    journalHeadSha256: inspection.chain.at(-1)?.record.hash ?? null,
    pendingPublications: inspection.pendingPublications,
    receipt: receipt ? {operationalStatus: receipt.operationalStatus,
      r4TerminalState: receipt.r4TerminalState, r4Acceptance: receipt.r4Acceptance,
      processContinuity: receipt.handoff.processContinuity,
      receiptSha256: receipt.hash} : null};
}

function main() {
  const action = process.argv[2];
  const run = promise => promise.then(result => {
    process.stdout.write(JSON.stringify(result) + '\n');
  }).catch(error => {
    process.stderr.write((error.message || 'EMERGENCY_HANDOFF_FAILED') + '\n');
    process.exitCode = 1;
  });
  try {
    assertRoot();
    if (action === 'status') {
      process.stdout.write(JSON.stringify(status()) + '\n');
      return;
    }
    if (action === 'preflight') { run(preflight()); return; }
    if (action === 'verify') { run(runHandoff({execute: false})); return; }
    if (action === 'apply') {
      assertBootstrapManagementAllowed('emergency-handoff');
      withHostLock(process.argv.slice(2));
      assertBootstrapManagementAllowed('emergency-handoff');
      run(runHandoff({execute: true}));
      return;
    }
    fail('EMERGENCY_HANDOFF_ARGUMENTS_INVALID');
  } catch (error) {
    process.stderr.write((error.message || 'EMERGENCY_HANDOFF_FAILED') + '\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
