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
import {readLatestCheckpoint, readProtectedRecord} from '/usr/local/libexec/servora-med/deployment-attempt.mjs';
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
  const finals = ['runtime.json', 'receipt.json'].map(name => {
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

export function readJournalChain(directory) {
  reconcileJournalTemps(directory);
  const names = readdirSync(directory).filter(name => JOURNAL_NAME.test(name)).sort();
  if (names.length > MAX_RECORDS) fail('EMERGENCY_HANDOFF_JOURNAL_INVALID');
  names.forEach((name, index) => {
    if (name !== String(index).padStart(4, '0') + '.json') fail('EMERGENCY_HANDOFF_JOURNAL_INVALID');
  });
  const records = names.map(name => readProtectedRecord(join(directory, name)));
  if (records.length === 0) return [];
  validateEmergencyHandoffChain(records.map(entry => entry.record));
  return records;
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
  return readProtectedRecord(path).record;
}

function foreignEmergencyEntries(journalDirectoryName) {
  if (!existsSync(EMERGENCY_ROOT)) return false;
  return readdirSync(EMERGENCY_ROOT).some(name => name !== 'authorization.json'
    && name !== journalDirectoryName);
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
  const {record, sha256} = readProtectedRecord(AUTHORIZATION_FILE);
  return {authorization: record, authorizationSha256: sha256};
}

export function journalDirectory(authorizationId) {
  return join(EMERGENCY_ROOT, authorizationId);
}

export function readRuntime(directory, authorizationSha256) {
  const {record, sha256} = readProtectedRecord(join(directory, 'runtime.json'));
  if (record.formatVersion !== 1 || record.kind !== 'EMERGENCY_HANDOFF_RUNTIME'
    || typeof record.authorizationId !== 'string' || record.authorizationSha256 !== authorizationSha256
    || typeof record.startedAtUTC !== 'string' || typeof record.bootId !== 'string'
    || !Number.isSafeInteger(record.pid) || record.pid < 1 || typeof record.startTime !== 'string'
    || typeof record.initialContext !== 'object') {
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
export function ensureProcessContinuity(directory, runtime, captured) {
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
    const {record, sha256} = readProtectedRecord(file);
    if (record.formatVersion !== 1 || record.kind !== 'EMERGENCY_HANDOFF_REBOOT_OBSERVATION'
      || record.authorizationId !== runtime.authorizationId
      || record.authorizationSha256 !== runtime.authorizationSha256
      || JSON.stringify(record.previous) !== JSON.stringify(expected.previous)
      || JSON.stringify(record.current) !== JSON.stringify(expected.current)) {
      fail('EMERGENCY_HANDOFF_REBOOT_OBSERVATION_CONFLICT');
    }
    return {mode: 'REBOOT_OBSERVED', rebootObservationSha256: sha256};
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
  const barrier = readProtectedRecord(BARRIER).record;
  if (Object.keys(barrier).length !== 2
    || barrier.attemptId !== authorization.parent.attemptId
    || barrier.approvalSha256 !== authorization.parent.approvalSha256) {
    fail('EMERGENCY_HANDOFF_BARRIER_UNTRUSTED');
  }
}

function assertOwnerMatches(authorization) {
  const owner = readProtectedRecord(OWNER).record;
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
 * Runs the handoff. Read-only when `execute` is false.
 */
export async function runHandoff({execute = true} = {}) {
  assertRoot();
  ensureEmergencyRoot();
  const artifact = verifyInstalledArtifact(ARTIFACT_ROOT);
  completeOwnedReload();
  const {authorization, authorizationSha256} = readAuthorization();
  const parentId = authorization.parent?.attemptId;
  const loaded = loadAttempt(parentId);
  if (loaded.approvalSha256 !== authorization.parent.approvalSha256) {
    fail('EMERGENCY_HANDOFF_BINDING_MISMATCH');
  }
  const checkpointFile = readLatestCheckpoint(parentId);
  const checkpoint = checkpointFile.record;
  verifyAttemptRelease(parentId, 'target');
  assertBackups(parentId, checkpoint);
  const binding = emergencyAuthorizationBinding({
    attemptId: parentId, approvalSha256: loaded.approvalSha256,
    profileSha256: loaded.approval.profileSha256,
    checkpoint: {...checkpoint, sha256: checkpointFile.sha256},
    approval: loaded.approval, profile: loaded.profile,
  });
  const directory = journalDirectory(authorization.authorizationId);
  const directoryName = authorization.authorizationId;
  const journalExists = existsSync(directory);
  if (journalExists) assertRootDirectory(directory);
  const captured = await captureLive(loaded.approval, loaded.profile, checkpoint, directoryName);
  if (captured.live.releaseSha !== authorization.host.releaseSha) fail('EMERGENCY_HANDOFF_BINDING_MISMATCH');
  if (journalExists) reconcileJournalDirectory(directory);
  const chain = journalExists ? readJournalChain(directory) : [];
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
  let runtime = null;
  if (chain.length === 0) {
    const runtimePath = join(directory, 'runtime.json');
    const previous = existsSync(runtimePath) ? readRuntime(directory, authorizationSha256) : null;
    const context = {...base,
      nowUTC: previous ? previous.startedAtUTC : nowUTC(),
      live: previous ? previous.initialContext.live : captured.live};
    validateEmergencyHandoffAuthorization(authorization, context);
    if (!execute) {
      return {result: 'EMERGENCY_HANDOFF_READY', nextAction: 'START',
        authorizationId: authorization.authorizationId, toolArtifactSha256: artifact.artifactSha256};
    }
    if (!existsSync(directory)) { mkdirSync(directory, {mode: 0o700}); flush(EMERGENCY_ROOT); }
    assertRootDirectory(directory);
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
    runtime = readRuntime(directory, authorizationSha256);
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
  }
  let continuity = {mode: 'PRESERVED', rebootObservationSha256: null};
  for (let round = 0; round < MAX_RECORDS; round += 1) {
    const records = readJournalChain(directory);
    const latest = records.at(-1).record;
    const receiptPath = join(directory, 'receipt.json');
    const receiptPresent = existsSync(receiptPath);
    const current = await captureLive(loaded.approval, loaded.profile, checkpoint, directoryName);
    if (!receiptPresent) {
      continuity = ensureProcessContinuity(directory, runtime, current);
      if (current.live.releaseSha !== authorization.host.releaseSha) fail('EMERGENCY_HANDOFF_RELEASE_CHANGED');
    }
    const action = nextEmergencyHandoffAction(latest, {
      ...current.observed, receiptPresent,
    });
    if (action === 'STOP') fail('EMERGENCY_HANDOFF_STATE_AMBIGUOUS');
    if (action === 'DONE') {
      const receipt = readProtectedRecord(receiptPath).record;
      verifyEmergencyHandoffReceipt(receipt, {
        authorizationId: authorization.authorizationId, authorizationSha256,
        toolArtifactSha256: artifact.artifactSha256, parent: binding.parent,
      });
      return {result: 'EMERGENCY_HANDOFF_ALREADY_COMPLETE',
        operationalStatus: EMERGENCY_OPERATIONAL_STATUS,
        r4TerminalState: EMERGENCY_R4_TERMINAL_STATE, r4Acceptance: 'NOT_ACCEPTED',
        parentAttemptId: parentId, authorizationId: authorization.authorizationId,
        receiptSha256: receipt.hash, journalHeadSha256: latest.hash,
        steps: latest.steps, appPid: current.meta.identity?.pid ?? runtime.pid,
        initialAppPid: runtime.pid,
        processContinuity: receipt.handoff.processContinuity};
    }
    if (!execute) {
      return {result: 'EMERGENCY_HANDOFF_READY', nextAction: action,
        authorizationId: authorization.authorizationId,
        toolArtifactSha256: artifact.artifactSha256};
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
        toolArtifactSha256: artifact.artifactSha256, parent: binding.parent,
      });
      return {result: 'EMERGENCY_HANDOFF_COMPLETE',
        operationalStatus: EMERGENCY_OPERATIONAL_STATUS,
        r4TerminalState: EMERGENCY_R4_TERMINAL_STATE, r4Acceptance: 'NOT_ACCEPTED',
        parentAttemptId: parentId, authorizationId: authorization.authorizationId,
        receiptSha256: receipt.hash, journalHeadSha256: latest.hash,
        steps: latest.steps, appPid: current.meta.identity?.pid ?? runtime.pid,
        initialAppPid: runtime.pid,
        processContinuity: receipt.handoff.processContinuity};
    }
  }
  fail('EMERGENCY_HANDOFF_LOOP_EXHAUSTED');
}

export function status() {
  assertRoot();
  ensureEmergencyRoot();
  const artifact = verifyInstalledArtifact(ARTIFACT_ROOT);
  completeOwnedReload();
  const {authorization, authorizationSha256} = readAuthorization();
  const directory = journalDirectory(authorization.authorizationId);
  if (existsSync(directory)) reconcileJournalDirectory(directory);
  const chain = existsSync(directory) ? readJournalChain(directory) : [];
  const receiptPath = join(directory, 'receipt.json');
  const receipt = existsSync(receiptPath) ? readProtectedRecord(receiptPath).record : null;
  return {kind: 'EMERGENCY_HANDOFF_STATUS', authorizationId: authorization.authorizationId,
    authorizationSha256, toolArtifactSha256: artifact.artifactSha256,
    journalPhase: chain.at(-1)?.record.phase ?? null,
    journalHeadSha256: chain.at(-1)?.record.hash ?? null,
    receipt: receipt ? {operationalStatus: receipt.operationalStatus,
      r4TerminalState: receipt.r4TerminalState, r4Acceptance: receipt.r4Acceptance,
      receiptSha256: receipt.hash} : null};
}

function main() {
  const action = process.argv[2];
  try {
    assertRoot();
    if (action === 'status') {
      process.stdout.write(JSON.stringify(status()) + '\n');
      return;
    }
    if (action === 'verify' || action === 'apply') {
      withHostLock(process.argv.slice(2));
      runHandoff({execute: action === 'apply'}).then(result => {
        process.stdout.write(JSON.stringify(result) + '\n');
      }).catch(error => { process.stderr.write((error.message || 'EMERGENCY_HANDOFF_FAILED') + '\n'); process.exitCode = 1; });
      return;
    }
    fail('EMERGENCY_HANDOFF_ARGUMENTS_INVALID');
  } catch (error) {
    process.stderr.write((error.message || 'EMERGENCY_HANDOFF_FAILED') + '\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
