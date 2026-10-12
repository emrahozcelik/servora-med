/** Trusted fixed-path host operations. No candidate code executes as root. */
import { createHash, randomUUID } from 'node:crypto';
import { readRootApproval, readRootProfile, initialAttempt, appendRootCheckpoint,
  readProtectedRecord, readLatestCheckpoint, advanceAttempt } from './deployment-attempt.mjs';
import { readFileSync, constants, lstatSync, openSync, fstatSync, closeSync, realpathSync,
  writeFileSync, fsyncSync, fchmodSync, fchownSync, renameSync, unlinkSync,
  symlinkSync, mkdirSync, readdirSync, readlinkSync, readSync, writeSync, linkSync } from 'node:fs';
import { parseCanonicalRecord } from './deployment-attempt.mjs';
import { classifyMigrationState } from './migration-reconciliation.mjs';
import { pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

const digest = value => createHash('sha256').update(value).digest('hex');
const INSTALLED = '/usr/local/libexec/servora-med';
const ENV_FILE = '/etc/servora-med/servora-med.env';
const STATE_ROOT = '/var/lib/servora-med/deploy';
const PERMIT_DIRECTORY = '/run/servora-med-recovery';
const PERMIT_FILE = `${PERMIT_DIRECTORY}/start.permit`;
const PG_RESTORE_BIN = '/usr/bin/pg_restore';

function existsSync(path) {
  // A dangling link is an existing, untrusted resource; never treat it as
  // permission to recreate a barrier, permit, approval or active owner.
  try { lstatSync(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function flushDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function attemptLogDirectory(attemptId) {
  currentAttempt(attemptId);
  for (const directory of [STATE_ROOT+'/logs',STATE_ROOT+'/logs/'+attemptId]) {
    if (!existsSync(directory)) { mkdirSync(directory,{mode:0o700}); flushDirectory(directory.slice(0,directory.lastIndexOf('/'))); }
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0
      || (info.mode & 0o7777) !== 0o700) throw new Error('RECOVERY_LOG_DIRECTORY_UNTRUSTED');
  }
  return STATE_ROOT+'/logs/'+attemptId;
}

/** Caller holds the common host lock; an active owner survives process exit.
 * A same-owner retry of an early, unmigrated attempt resumes instead of
 * stranding: no other attempt phase or owner is ever reclaimed here.
 */
export function admitAttempt(attemptId) {
  const context = loadAttempt(attemptId);
  if (existsSync(`${STATE_ROOT}/active.json`)) {
    const active = readProtectedRecord(`${STATE_ROOT}/active.json`).record;
    const checkpoint = readLatestCheckpoint(attemptId);
    if (Object.keys(active).length !== 2 || active.attemptId !== attemptId
      || active.approvalSha256 !== context.approvalSha256
      || !['ADMITTED','BACKED_UP'].includes(checkpoint.record.phase)) {
      throw new Error('RECOVERY_OTHER_ATTEMPT_ACTIVE');
    }
    assertRetainedBackups({ approval: context.approval, checkpoint });
    return { resumed: true, checkpoint };
  }
  if (existsSync(`${STATE_ROOT}/attempts/${attemptId}`)) throw new Error('ATTEMPT_ALREADY_ADMITTED');
  const active = { attemptId, approvalSha256: context.approvalSha256 };
  const fd = openSync(`${STATE_ROOT}/active.json`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(active)+'\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
  flushDirectory(STATE_ROOT);
  return { resumed: false, checkpoint: appendRootCheckpoint(attemptId, initialAttempt(context)) };
}

export function currentAttempt(attemptId) {
  const context = loadAttempt(attemptId);
  const checkpoint = readLatestCheckpoint(attemptId);
  // A completed retry is read-only. It cannot reclaim ownership or reset any
  // counter, and must not interfere with a newer active attempt.
  if (!existsSync(`${STATE_ROOT}/active.json`) && ['COMPLETED','COMPLETED_ABORT'].includes(checkpoint.record.phase)) {
    advanceAttempt(checkpoint.record,context,'VALIDATE');
    return {...context,checkpoint};
  }
  const active = readProtectedRecord(`${STATE_ROOT}/active.json`).record;
  if (Object.keys(active).length !== 2 || active.attemptId !== attemptId
    || active.approvalSha256 !== context.approvalSha256) throw new Error('RECOVERY_OTHER_ATTEMPT_ACTIVE');
  advanceAttempt(checkpoint.record, context, 'VALIDATE');
  return { ...context, checkpoint };
}

export function checkpointAttempt(attemptId, event) {
  const context = currentAttempt(attemptId);
  const next = advanceAttempt(context.checkpoint.record, context, event);
  next.previousHash = context.checkpoint.sha256;
  return appendRootCheckpoint(attemptId, next);
}

function writeAttemptBarrier(attemptId, approvalSha256) {
  const owner = { attemptId, approvalSha256 };
  const file = `${STATE_ROOT}/activation.block`;
  if (existsSync(file)) {
    try {
      const existing = readProtectedRecord(file).record;
      if (Object.keys(existing).length !== 2 || existing.attemptId !== attemptId
        || existing.approvalSha256 !== owner.approvalSha256) throw new Error('RECOVERY_BARRIER_UNTRUSTED');
    } catch { throw new Error('RECOVERY_BARRIER_UNTRUSTED'); }
    return;
  }
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd,JSON.stringify(owner)+'\n'); fsyncSync(fd); } finally { closeSync(fd); }
  flushDirectory(STATE_ROOT);
}

export function createAttemptBarrier(attemptId) {
  const context = currentAttempt(attemptId);
  if (!context.checkpoint.record.predeployBackup || context.checkpoint.record.phase === 'ADMITTED') throw new Error('ATTEMPT_TRANSITION_INVALID');
  writeAttemptBarrier(attemptId, context.approvalSha256);
}

function assertBarrier(context) {
  let record;
  try { record = readProtectedRecord(`${STATE_ROOT}/activation.block`).record; }
  catch { throw new Error('RECOVERY_BARRIER_UNTRUSTED'); }
  if (Object.keys(record).length !== 2 || record.attemptId !== context.approval.attemptId
    || record.approvalSha256 !== context.approvalSha256) throw new Error('RECOVERY_BARRIER_UNTRUSTED');
}

export function alignAttemptPointer(attemptId, direction) {
  const context = currentAttempt(attemptId);
  const {approval,checkpoint} = context;
  if (direction === 'target' ? checkpoint.record.phase !== 'POINTER_INTENT'
    : direction !== 'old' || checkpoint.record.phase !== 'ABORT_INTENT') throw new Error('ATTEMPT_TRANSITION_INVALID');
  assertBarrier(context);
  const current = '/opt/servora-med/current';
  const info = lstatSync(current);
  const resolved = realpathSync(current);
  const approved = [approval.oldReleaseSha,approval.releaseSha].map(sha => '/opt/servora-med/releases/'+sha);
  if (!info.isSymbolicLink() || info.uid !== 0 || !approved.includes(resolved)) throw new Error('RECOVERY_POINTER_UNTRUSTED');
  const target = direction === 'old' ? approved[0] : approved[1];
  for (const path of ['/opt','/opt/servora-med','/opt/servora-med/releases',target]) {
    const dir = lstatSync(path);
    if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== 0 || (dir.mode & 0o022)) throw new Error('RECOVERY_POINTER_UNTRUSTED');
  }
  if (resolved === target) return;
  const temporary = `/opt/servora-med/.r4-current-${randomUUID()}`;
  symlinkSync(target,temporary);
  try { renameSync(temporary,current); flushDirectory('/opt/servora-med'); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
  if (realpathSync(current) !== target) throw new Error('RECOVERY_POINTER_READBACK_FAILED');
}

export function grantStartPermit(attemptId) {
  const context = currentAttempt(attemptId);
  const record = context.checkpoint.record;
  if (!['START_INTENT','ABORT_INTENT'].includes(record.phase) || record.lastStart !== 'intent'
    || (record.phase === 'START_INTENT' ? record.starts < 1 : record.abortStarts < 1)) throw new Error('ATTEMPT_TRANSITION_INVALID');
  assertBarrier(context);
  if (!existsSync(PERMIT_DIRECTORY)) {
    mkdirSync(PERMIT_DIRECTORY,{mode:0o700}); flushDirectory('/run');
  }
  const dir = lstatSync(PERMIT_DIRECTORY);
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== 0 || dir.gid !== 0
    || (dir.mode & 0o7777) !== 0o700) throw new Error('RECOVERY_PERMIT_UNTRUSTED');
  const fd = openSync(PERMIT_FILE,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try {
    writeFileSync(fd,JSON.stringify({attemptId,approvalSha256:context.approvalSha256})+'\n'); fsyncSync(fd);
  } finally { closeSync(fd); }
  flushDirectory(PERMIT_DIRECTORY);
}

/** Revocation is safe after expiry: it cannot activate anything. */
export function revokeStartPermit(attemptId) {
  if (!existsSync(PERMIT_FILE)) return;
  const active = readProtectedRecord(`${STATE_ROOT}/active.json`).record;
  const permit = parseCanonicalRecord(trustedFile(PERMIT_FILE,0o600).toString('utf8'));
  if (Object.keys(active).length !== 2 || Object.keys(permit).length !== 2
    || active.attemptId !== attemptId || permit.attemptId !== attemptId
    || permit.approvalSha256 !== active.approvalSha256) throw new Error('RECOVERY_PERMIT_UNTRUSTED');
  unlinkSync(PERMIT_FILE); flushDirectory(PERMIT_DIRECTORY);
}

export function verifyAttemptCatalog(attemptId, direction) {
  const {approval} = loadAttempt(attemptId);
  if (!['old','target'].includes(direction)) throw new Error('RECOVERY_CONTROLLER_ARGUMENTS_INVALID');
  const sha = direction === 'old' ? approval.oldReleaseSha : approval.releaseSha;
  const expected = direction === 'old' ? approval.oldCatalog : approval.targetCatalog;
  const directory = `/opt/servora-med/releases/${sha}/server/dist/db/migrations`;
  // Same catalog contract as MigrationCatalog: only SQL files participate;
  // malformed SQL names, duplicate/gapped versions and branches fail closed.
  const files = readdirSync(directory).filter(file => file.endsWith('.sql')).sort();
  if (classifyMigrationState(expected.map(entry => entry.version),files.map(file => file.slice(0,-4))).status !== 'EXACT') {
    throw new Error('RECOVERY_CATALOG_MISMATCH');
  }
  const catalog = files.map(file => ({version:file.slice(0,-4),sha256:digest(trustedFile(directory+'/'+file,0o640,null))}));
  if (JSON.stringify(catalog) !== JSON.stringify(expected)) throw new Error('RECOVERY_CATALOG_MISMATCH');
}

/** Markers are created only by the reviewed staging path after archive byte
 * comparison. Every payload entry remains root-owned and non-writable by the
 * operator/service; retained archives are sealed by the root admission path.
 */
export function verifyAttemptRelease(attemptId, direction) {
  const {approval} = loadAttempt(attemptId);
  if (!['old','target'].includes(direction)) throw new Error('RECOVERY_CONTROLLER_ARGUMENTS_INVALID');
  const sha = direction === 'old' ? approval.oldReleaseSha : approval.releaseSha;
  const expected = direction === 'old' ? approval.oldArtifactSha256 : approval.artifactSha256;
  const root = '/opt/servora-med/releases/'+sha;
  try {
    if (digest(trustedFile(`${STATE_ROOT}/artifacts/${sha}.tar.gz`,0o600)) !== expected
      || trustedFile(root+'/.servora-release-artifact.sha256',0o600).toString('utf8') !== expected+'\n') {
      throw new Error('RECOVERY_RELEASE_UNPROVEN');
    }
    const entries = [];
    const walk = relative => {
      const path = root+'/'+relative;
      const info = lstatSync(path);
      if (info.uid !== 0 || (!info.isSymbolicLink() && (info.mode & 0o022))) throw new Error('RECOVERY_RELEASE_UNPROVEN');
      if (info.isSymbolicLink()) {
        if (!realpathSync(path).startsWith(root+'/')) throw new Error('RECOVERY_RELEASE_UNPROVEN');
        entries.push([relative,'l '+relative+' '+readlinkSync(path)]);
      } else if (info.isDirectory()) {
        if (relative !== '.') entries.push([relative,'d '+relative]);
        for (const name of readdirSync(path)) {
          if (relative === '.' && ['.servora-release-artifact.sha256','.servora-release-content.sha256'].includes(name)) continue;
          if (/[\r\n]/.test(name)) throw new Error('RECOVERY_RELEASE_UNPROVEN');
          walk(relative === '.' ? './'+name : relative+'/'+name);
        }
      } else if (info.isFile() && info.nlink === 1) entries.push([relative,'f '+relative+' '+digest(readFileSync(path))]);
      else throw new Error('RECOVERY_RELEASE_UNPROVEN');
    };
    walk('.');
    // The existing staging manifest sorts `find`'s TYPE + PATH, in C locale.
    entries.sort(([a,lineA],[b,lineB]) => Buffer.compare(Buffer.from(lineA[0]+' '+a),Buffer.from(lineB[0]+' '+b)));
    const manifest = entries.map(([,line]) => line).join('\n')+'\n';
    if (trustedFile(root+'/.servora-release-content.sha256',0o600).toString('utf8') !== manifest) {
      throw new Error('RECOVERY_RELEASE_UNPROVEN');
    }
    if (direction === 'target' && digest(trustedFile(root+'/ops/scripts/deploy-production-host.sh',0o750,null))
      !== digest(trustedFile(INSTALLED+'/deploy-production-host',0o755))) throw new Error('RECOVERY_RELEASE_UNPROVEN');
    if (direction === 'target') {
      for (const name of ['deployment-attempt.mjs','deployment-controller.mjs','deployment-db-guard.mjs','migration-reconciliation.mjs']) {
        if (digest(trustedFile(root+'/ops/scripts/'+name,0o650,null)) !== digest(trustedFile(INSTALLED+'/'+name,0o644))) {
          throw new Error('RECOVERY_RELEASE_UNPROVEN');
        }
      }
      if (digest(trustedFile(root+'/ops/scripts/host-operation-lock.sh',0o650,null)) !== digest(trustedFile(INSTALLED+'/host-operation-lock.sh',0o644))) throw new Error('RECOVERY_RELEASE_UNPROVEN');
      if (digest(trustedFile(root+'/ops/systemd/servora-med.service',0o640,null))
        !== digest(trustedFile('/etc/systemd/system/servora-med.service',0o644))) throw new Error('RECOVERY_RELEASE_UNPROVEN');
    }
  } catch { throw new Error('RECOVERY_RELEASE_UNPROVEN'); }
  verifyAttemptCatalog(attemptId,direction);
}

export function alignAttemptEnvironment(attemptId, direction) {
  const { approval, profile, checkpoint } = currentAttempt(attemptId);
  if (direction === 'target' ? checkpoint.record.phase !== 'ENV_INTENT'
    : direction !== 'old' || checkpoint.record.phase !== 'ABORT_INTENT') throw new Error('ATTEMPT_TRANSITION_INVALID');
  const before = trustedFile(ENV_FILE, 0o640, null).toString('utf8');
  validateIdentityTuple(before, approval);
  if (environmentBaseline(before) !== profile.envBaselineSha256) throw new Error('RECOVERY_ENV_BASELINE_MISMATCH');
  const schema = (direction === 'old' ? approval.oldCatalog : approval.targetCatalog).at(-1).version;
  const release = direction === 'old' ? approval.oldReleaseSha : approval.releaseSha;
  const next = alignIdentityEnvironment(before, schema, release);
  if (before === next) return;
  const temporary = `/etc/servora-med/.r4-env-${randomUUID()}.tmp`;
  const gid = lstatSync(ENV_FILE).gid;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    fchownSync(fd, 0, gid); fchmodSync(fd, 0o640);
    writeFileSync(fd, next); fsyncSync(fd);
  } finally { closeSync(fd); }
  try {
    renameSync(temporary, ENV_FILE); flushDirectory('/etc/servora-med');
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  if (trustedFile(ENV_FILE, 0o640, gid).toString('utf8') !== next) throw new Error('RECOVERY_ENV_READBACK_FAILED');
}

function trustedFile(path, mode, gid = 0) {
  let parent = '';
  for (const component of path.split('/').slice(1, -1)) {
    parent += '/' + component;
    const info = lstatSync(parent);
    if (!info.isDirectory() || info.uid !== 0 || info.isSymbolicLink() || (info.mode & 0o022)) throw new Error('RECOVERY_HOST_FILE_UNTRUSTED');
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== 0 || (gid !== null && info.gid !== gid) || info.nlink !== 1
      || (info.mode & 0o7777) !== mode) throw new Error('RECOVERY_HOST_FILE_UNTRUSTED');
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

function verifyHostProfile(profile) {
  const files = {
    helperSha256: [`${INSTALLED}/deploy-production-host`, 0o755],
    nodeSha256: [realpathSync('/usr/bin/node'), 0o755],
    unitSha256: ['/etc/systemd/system/servora-med.service', 0o644],
    attemptModuleSha256: [`${INSTALLED}/deployment-attempt.mjs`, 0o644],
    dbGuardModuleSha256: [`${INSTALLED}/deployment-db-guard.mjs`, 0o644],
    reconciliationModuleSha256: [`${INSTALLED}/migration-reconciliation.mjs`, 0o644],
    controllerModuleSha256: [`${INSTALLED}/deployment-controller.mjs`, 0o644],
  };
  for (const [key, [path, mode]] of Object.entries(files)) {
    if (digest(trustedFile(path, mode)) !== profile.contracts[key]) throw new Error('RECOVERY_HOST_CONTRACT_MISMATCH');
  }
  if (environmentBaseline(trustedFile(ENV_FILE, 0o640, null).toString('utf8')) !== profile.envBaselineSha256) {
    throw new Error('RECOVERY_ENV_BASELINE_MISMATCH');
  }
  const properties = Object.fromEntries(systemctl('show','servora-med.service',
    '-p','User','-p','Group','-p','WorkingDirectory','-p','FragmentPath','-p','DropInPaths',
    '-p','ExecStart','-p','EnvironmentFiles','-p','NeedDaemonReload','-p','Restart').split('\n')
    .map(line => [line.slice(0,line.indexOf('=')),line.slice(line.indexOf('=')+1)]));
  const policy = '/etc/systemd/system/servora-med.service.d/90-servora-recovery.conf';
  if (properties.User !== 'servora-med' || properties.Group !== 'servora-med'
    || properties.WorkingDirectory !== '/opt/servora-med/current/server'
    || properties.FragmentPath !== '/etc/systemd/system/servora-med.service'
    || properties.EnvironmentFiles !== ENV_FILE+' (ignore_errors=no)'
    || properties.NeedDaemonReload !== 'no'
    || !/^\{ path=\/usr\/bin\/node ; argv\[\]=\/usr\/bin\/node dist\/index\.js ; ignore_errors=no ; [^}]*\}$/.test(properties.ExecStart)
    || !['',policy].includes(properties.DropInPaths)
    || properties.Restart !== (properties.DropInPaths ? 'no' : 'on-failure')) {
    throw new Error('RECOVERY_SERVICE_CONTRACT_MISMATCH');
  }
  if (properties.DropInPaths && trustedFile(policy,0o600).toString('utf8') !== '[Service]\nRestart=no\n') {
    throw new Error('RECOVERY_SERVICE_CONTRACT_MISMATCH');
  }
}

export function loadAttempt(attemptId) {
  let context;
  try { context = readRootApproval(attemptId); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('ATTEMPT_APPROVAL_MISSING');
    throw error;
  }
  const profile = readRootProfile(context.approval);
  if (readFileSync('/etc/machine-id', 'utf8').trim() !== profile.machineId) throw new Error('RECOVERY_HOST_MACHINE_MISMATCH');
  verifyHostProfile(profile);
  return { ...context, profile };
}

function identityLines(text) {
  if (typeof text !== 'string' || !text.endsWith('\n') || text.includes('\r')) throw new Error('ENV_IDENTITY_INVALID');
  const lines = text.split('\n');
  const schema = lines.filter(line => line.startsWith('HEALTH_SCHEMA_VERSION='));
  const release = lines.filter(line => line.startsWith('SERVORA_RELEASE_SHA='));
  if (schema.length !== 1 || release.length !== 1
    || !/^HEALTH_SCHEMA_VERSION=[0-9]{3}_[a-z0-9_]+$/.test(schema[0])
    || !/^SERVORA_RELEASE_SHA=[0-9a-f]{40}$/.test(release[0])
    || lines.some(line => /^(?:\s|export\s+)+(HEALTH_SCHEMA_VERSION|SERVORA_RELEASE_SHA)\s*=/.test(line))) {
    throw new Error('ENV_IDENTITY_INVALID');
  }
  return lines;
}

export function environmentBaseline(text) {
  return digest(identityLines(text).filter(line => !/^(HEALTH_SCHEMA_VERSION|SERVORA_RELEASE_SHA)=/.test(line)).join('\n'));
}

export function alignIdentityEnvironment(text, schema, release) {
  if (!/^[0-9]{3}_[a-z0-9_]+$/.test(schema) || !/^[0-9a-f]{40}$/.test(release)) throw new Error('ENV_IDENTITY_INVALID');
  return identityLines(text).map(line => line.startsWith('HEALTH_SCHEMA_VERSION=') ? `HEALTH_SCHEMA_VERSION=${schema}`
    : line.startsWith('SERVORA_RELEASE_SHA=') ? `SERVORA_RELEASE_SHA=${release}` : line).join('\n');
}

export function validateIdentityTuple(text, approval) {
  const lines = identityLines(text);
  const schema = lines.find(line => line.startsWith('HEALTH_SCHEMA_VERSION=')).slice('HEALTH_SCHEMA_VERSION='.length);
  const release = lines.find(line => line.startsWith('SERVORA_RELEASE_SHA=')).slice('SERVORA_RELEASE_SHA='.length);
  if (![approval.oldCatalog.at(-1).version, approval.targetCatalog.at(-1).version].includes(schema)
    || ![approval.oldReleaseSha, approval.releaseSha].includes(release)) throw new Error('ENV_IDENTITY_DRIFT');
  return { schema, release };
}

const COMMAND_ENV = {PATH:'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'};
function systemctl(...args) {
  return execFileSync('/usr/bin/systemctl',args,{env:COMMAND_ENV,encoding:'utf8',timeout:40000,stdio:['ignore','pipe','pipe']}).trim();
}

/** Seal the bytes of a freshly verified fixed-path host backup. Never retain
 * only the service-writable pathname: root retains its own immutable copy.
 */
export function sealBackupReceipt(attemptId, kind, file) {
  const context = currentAttempt(attemptId);
  if (!['pre','post'].includes(kind) || !/^\/var\/backups\/servora-med\/servora-med-[0-9]{8}T[0-9]{6}Z\.dump$/.test(file)
    || context.checkpoint.record.phase !== (kind === 'pre' ? 'ADMITTED' : 'POSTDEPLOY_BACKUP_INTENT')) {
    throw new Error('ATTEMPT_TRANSITION_INVALID');
  }
  const uid = Number(execFileSync('/usr/bin/id',['-u','servora-med'],{encoding:'utf8'}));
  const gid = Number(execFileSync('/usr/bin/id',['-g','servora-med'],{encoding:'utf8'}));
  const sourceDir = lstatSync('/var/backups/servora-med');
  if (!sourceDir.isDirectory() || sourceDir.isSymbolicLink() || sourceDir.uid !== uid || sourceDir.gid !== gid
    || (sourceDir.mode & 0o7777) !== 0o700) throw new Error('RECOVERY_BACKUP_UNTRUSTED');
  const source = openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  const checksum = openSync(file+'.sha256',constants.O_RDONLY|constants.O_NOFOLLOW);
  const directory = STATE_ROOT+'/backups';
  let temporary;
  try {
    for (const fd of [source,checksum]) {
      const info = fstatSync(fd);
      if (!info.isFile() || info.uid !== uid || info.gid !== gid || info.nlink !== 1
        || (info.mode & 0o7777) !== 0o600 || info.mtimeMs < Date.parse(context.checkpoint.record.updatedAtUTC)-1000) {
        throw new Error('RECOVERY_BACKUP_UNTRUSTED');
      }
    }
    const line = readFileSync(checksum,'utf8');
    const name = file.split('/').at(-1);
    const expected = line.match(/^([0-9a-f]{64})  ([^\s/]+)\n$/);
    if (!expected || expected[2] !== name) throw new Error('RECOVERY_BACKUP_UNTRUSTED');
    if (!existsSync(directory)) { mkdirSync(directory,{mode:0o700}); flushDirectory(STATE_ROOT); }
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0 || (info.mode & 0o7777) !== 0o700) throw new Error('RECOVERY_BACKUP_UNTRUSTED');
    temporary = directory+'/.backup-'+randomUUID();
    const output = openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    const hash = createHash('sha256');
    try {
      const buffer = Buffer.alloc(1024*1024);
      for (let count; (count = readSync(source,buffer,0,buffer.length,null)) > 0;) {
        hash.update(buffer.subarray(0,count));
        for (let offset = 0; offset < count;) offset += writeSync(output,buffer,offset,count-offset);
      }
      fsyncSync(output);
    } finally { closeSync(output); }
    const sha256 = hash.digest('hex');
    if (sha256 !== expected[1]) throw new Error('RECOVERY_BACKUP_UNTRUSTED');
    // The copied root-private bytes must themselves be a real PostgreSQL
    // archive: digest agreement with the equally service-writable sidecar is
    // not proof, and the source pathname may have been swapped between the
    // helper's verification and this sealed copy.
    try {
      execFileSync(PG_RESTORE_BIN,['--list',temporary],{env:COMMAND_ENV,timeout:30000,stdio:['ignore','ignore','ignore']});
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('RECOVERY_BACKUP_VALIDATION_UNAVAILABLE');
      throw new Error('RECOVERY_BACKUP_ARCHIVE_INVALID');
    }
    linkSync(temporary,`${directory}/${attemptId}-${kind}.dump`); unlinkSync(temporary); temporary = null; flushDirectory(directory);
    return checkpointAttempt(attemptId,{kind:kind === 'pre' ? 'PREDEPLOY_BACKUP' : 'POSTDEPLOY_BACKUP_PASSED',
      receipt:{sha256,completedAtUTC:new Date().toISOString()}});
  } finally { closeSync(source); closeSync(checksum); if (temporary && existsSync(temporary)) unlinkSync(temporary); }
}

function validateBackupDatabase(profile) {
  const text = trustedFile('/etc/servora-med/servora-med-backup.env',0o640,null).toString('utf8');
  const keys = {PGHOST:profile.databaseIdentity.host,PGPORT:String(profile.databaseIdentity.port),
    PGUSER:profile.databaseIdentity.role,PGDATABASE:profile.databaseIdentity.databaseName};
  for (const [key,value] of Object.entries(keys)) {
    const lines = text.split('\n').filter(line => line.startsWith(key+'='));
    if (lines.length !== 1 || lines[0] !== key+'='+value) throw new Error('RECOVERY_BACKUP_DATABASE_MISMATCH');
  }
}

/** Fixed service-UID probe holds the Migrator's advisory lock throughout the
 * host transition. No protected URL is printed or put on the command line.
 * The root parent retains host flock; no root lock fd reaches the service UID.
 */
async function withGuard(context, direction, operation) {
  const child = spawn('/usr/bin/sudo',['-u','servora-med','--','/usr/bin/env','-i',
    'PATH='+COMMAND_ENV.PATH,'/usr/bin/node','--env-file='+ENV_FILE,
    INSTALLED+'/deployment-db-guard.mjs','--hold'],{env:COMMAND_ENV,stdio:['pipe','pipe','pipe']});
  child.stdin.on('error',() => {});
  let probeError = '';
  child.stderr.on('data',chunk => { if (probeError.length < 1024) probeError += chunk.toString(); });
  const finished = new Promise(resolve => { child.once('error',() => resolve(-1)); child.once('exit',code => resolve(code)); });
  const reader = createInterface({input:child.stdout,crlfDelay:Infinity});
  const lines = reader[Symbol.asyncIterator]();
  const expect = async value => {
    let timer;
    try {
      const line = await Promise.race([lines.next(),new Promise((_,reject) => {
        timer = setTimeout(() => reject(new Error('RECOVERY_DATABASE_PROBE_FAILED')),10000);
      })]);
      if (line.done || line.value !== value) {
        const code = probeError.trim();
        throw new Error(/^RECOVERY_DATABASE_[A-Z_]+$/.test(code) ? code : 'RECOVERY_DATABASE_PROBE_FAILED');
      }
    } finally { clearTimeout(timer); }
  };
  const counts = async () => {
    let timer;
    try {
      child.stdin.write('COUNTS\n');
      const line = await Promise.race([lines.next(),new Promise((_,reject) => {
        timer = setTimeout(() => reject(new Error('RECOVERY_DATABASE_PROBE_FAILED')),10000);
      })]);
      if (line.done || typeof line.value !== 'string' || !line.value.startsWith('COUNTS=')) {
        const code = probeError.trim();
        throw new Error(/^RECOVERY_DATABASE_[A-Z_]+$/.test(code) ? code : 'RECOVERY_DATABASE_PROBE_FAILED');
      }
      const parsed = JSON.parse(line.value.slice('COUNTS='.length));
      for (const key of ['organizations','admins','staff','customers','products','jobs','demo_data']) {
        if (!Number.isSafeInteger(parsed[key]) || parsed[key] < 0) throw new Error('RECOVERY_DATABASE_PROBE_FAILED');
      }
      return parsed;
    } finally { clearTimeout(timer); }
  };
  child.stdin.write(JSON.stringify({releaseDirectory:'/opt/servora-med/releases/'+(direction === 'old' ? context.approval.oldReleaseSha : context.approval.releaseSha),
    expectedIdentity:context.profile.databaseIdentity,
    expectedCatalog:(direction === 'old' ? context.approval.oldCatalog : context.approval.targetCatalog).map(entry => entry.version)})+'\n');
  try {
    await expect('READY');
    const check = async () => { child.stdin.write('CHECK\n'); await expect('EXACT'); };
    return await operation(check, counts);
  } finally {
    child.stdin.end('RELEASE\n');
    const timer = setTimeout(() => child.kill('SIGTERM'),5000);
    try { await finished; } finally { clearTimeout(timer); reader.close(); }
  }
}

function assertApprovedPointer(approval) {
  const file = '/opt/servora-med/current';
  const info = lstatSync(file);
  if (!info.isSymbolicLink() || info.uid !== 0 || ![approval.oldReleaseSha,approval.releaseSha]
    .map(sha => '/opt/servora-med/releases/'+sha).includes(realpathSync(file))) throw new Error('RECOVERY_POINTER_UNTRUSTED');
}

function assertProcessAndHealth(context, direction = 'target') {
  const sha = direction === 'old' ? context.approval.oldReleaseSha : context.approval.releaseSha;
  const root = '/opt/servora-med/releases/'+sha;
  const tuple = validateIdentityTuple(trustedFile(ENV_FILE,0o640,null).toString('utf8'),context.approval);
  const head = (direction === 'old' ? context.approval.oldCatalog : context.approval.targetCatalog).at(-1).version;
  if (tuple.release !== sha || tuple.schema !== head || realpathSync('/opt/servora-med/current') !== root) throw new Error('RECOVERY_RELEASE_IDENTITY_MISMATCH');
  if (systemctl('is-active','servora-med.service') !== 'active') throw new Error('RECOVERY_SERVICE_NOT_ACTIVE');
  const pid = systemctl('show','servora-med.service','-p','MainPID','--value');
  if (!/^[1-9][0-9]*$/.test(pid) || realpathSync('/proc/'+pid+'/cwd') !== root+'/server'
    || realpathSync('/proc/'+pid+'/exe') !== realpathSync('/usr/bin/node')) throw new Error('RECOVERY_PROCESS_IDENTITY_MISMATCH');
  for (const url of ['http://127.0.0.1:3000/api/health','https://'+context.profile.fqdn+'/api/health']) {
    const text = execFileSync('/usr/bin/curl',['--fail','--silent','--show-error','--max-time','5',url],
      {env:COMMAND_ENV,encoding:'utf8',timeout:6000,stdio:['ignore','pipe','pipe']});
    const health = JSON.parse(text);
    if (health.status !== 'ok' || health.releaseSha !== sha) throw new Error('RECOVERY_RELEASE_IDENTITY_MISMATCH');
  }
  if (systemctl('show','servora-med.service','-p','MainPID','--value') !== pid) throw new Error('RECOVERY_PROCESS_CHANGED');
  return pid;
}

/** Fresh schema-check gate. Runs the sealed target release's own
 * schema-check as the service UID with the protected env file; the root
 * controller never executes candidate code as root. Any failure fails closed.
 */
export function runTargetSchemaCheck(context) {
  const release = '/opt/servora-med/releases/'+context.approval.releaseSha;
  try {
    execFileSync('/usr/bin/sudo',['-u','servora-med','--','/usr/bin/env','-i',
      'PATH='+COMMAND_ENV.PATH,'NODE_ENV=production','/usr/bin/node','--env-file='+ENV_FILE,
      release+'/server/dist/db/schema-check.js'],
      {env:COMMAND_ENV,timeout:120000,stdio:['ignore','ignore','ignore']});
  } catch { throw new Error('RECOVERY_SCHEMA_CHECK_FAILED'); }
}

/** DB056 recovery never migrates/restores. Ambiguous start intent is denied;
 * resumable env/pointer intents only replay their exact sealed destinations.
 */
export async function recoverAttempt(attemptId) {
  const context = currentAttempt(attemptId);
  if (!context.approval.allowForwardRecovery) throw new Error('ATTEMPT_START_NOT_AUTHORIZED');
  verifyAttemptRelease(attemptId,'target');
  assertRetainedBackups(context);
  assertApprovedPointer(context.approval);
  validateIdentityTuple(trustedFile(ENV_FILE,0o640,null).toString('utf8'),context.approval);
  if (context.checkpoint.record.phase === 'COMPLETED') {
    return withGuard(context,'target',async check => {
      await check(); assertProcessAndHealth(context); assertBackupHealth(context);
      return retireCompletedOwner(context) ? 'FORWARD_RECOVERY=ALREADY_COMPLETED_OWNER_RETIRED' : 'FORWARD_RECOVERY=ALREADY_COMPLETED_READ_ONLY';
    });
  }
  assertBarrier(context);
  let phase = context.checkpoint.record.phase;
  if (!['FENCED','MIGRATION_INTENT','DB_EXACT','ENV_INTENT','ENV_ALIGNED','POINTER_INTENT',
    'POINTER_ALIGNED','START_FAILED','HEALTH_PASSED','SMOKE_PASSED','POSTDEPLOY_BACKUP_INTENT',
    'POSTDEPLOY_BACKUP_PASSED','OBSERVATION_PASSED','ACCEPTED'].includes(phase)) throw new Error('ATTEMPT_TRANSITION_INVALID');
  return withGuard(context,'target',async (check,counts) => {
    if (['HEALTH_PASSED','SMOKE_PASSED','POSTDEPLOY_BACKUP_INTENT','POSTDEPLOY_BACKUP_PASSED','OBSERVATION_PASSED','ACCEPTED'].includes(phase)) {
      await check();
      try { assertProcessAndHealth(context); }
      catch (error) {
        if (phase !== 'HEALTH_PASSED') throw error;
        phase = checkpointAttempt(attemptId,'HEALTH_LOST').record.phase;
      }
      if (phase !== 'START_FAILED') {
        // Durable schema-check acceptance: a health checkpoint alone must not
        // satisfy the schema gate. If no durable result exists (interruption
        // between activation and the wrapper's recorded check), run the
        // sealed release's own check again before any smoke/postdeploy step.
        if (!readLatestCheckpoint(attemptId).record.schemaChecked) {
          await runTargetSchemaCheck(context);
          checkpointAttempt(attemptId,'SCHEMA_CHECKED');
        }
        return 'FORWARD_RECOVERY=HEALTH_PASSED_PENDING_ACCEPTANCE';
      }
    }
    // Deny an exhausted start budget before stopping or changing the host.
    if (context.checkpoint.record.starts >= context.approval.maxStarts) throw new Error('ATTEMPT_START_BUDGET_EXHAUSTED');
    // Only admitted, exact-DB attempts may change policy or stop the service.
    await check();
    // A committed migration must re-prove the persisted pre-migration business
    // baseline before the durable DB_EXACT boundary or any activation. A
    // TARGET-exact ledger alone is not data-integrity proof.
    if (['FENCED','MIGRATION_INTENT'].includes(phase)) {
      const baseline = readLatestCheckpoint(attemptId).record.invariantBaseline;
      if (!baseline) throw new Error('RECOVERY_INVARIANT_BASELINE_MISSING');
      const fresh = await counts();
      const pairs = [['organizations','organizations'],['admins','admins'],['staff','staff'],
        ['customers','customers'],['products','products'],['jobs','jobs'],['demoData','demo_data']];
      for (const [journalKey,freshKey] of pairs) {
        if (baseline[journalKey] !== fresh[freshKey]) throw new Error('RECOVERY_BUSINESS_DATA_INVARIANT_CHANGED');
      }
    }
    execFileSync('/bin/bash',['--noprofile','--norc','-c',
      'source /usr/local/libexec/servora-med/deploy-production-host; r4_suppress_restarts'],
      {env:COMMAND_ENV,timeout:40000,stdio:['ignore','pipe','pipe']});
    systemctl('stop','servora-med.service');
    revokeStartPermit(attemptId);
    const record = event => { phase = checkpointAttempt(attemptId,event).record.phase; };
    if (['FENCED','MIGRATION_INTENT'].includes(phase)) record('DB_EXACT');
    if (phase === 'DB_EXACT') record('ENV_INTENT');
    if (phase === 'ENV_INTENT') { await check(); alignAttemptEnvironment(attemptId,'target'); record('ENV_ALIGNED'); }
    if (phase === 'ENV_ALIGNED') record('POINTER_INTENT');
    if (phase === 'POINTER_INTENT') { await check(); alignAttemptPointer(attemptId,'target'); record('POINTER_ALIGNED'); }
    await check();
    if (!['POINTER_ALIGNED','START_FAILED'].includes(phase)) throw new Error('ATTEMPT_TRANSITION_INVALID');
    record('START_INTENT'); // fsync before the only explicit start
    let interrupted = false;
    const interrupt = () => { interrupted = true; };
    process.once('SIGTERM',interrupt); process.once('SIGINT',interrupt);
    try {
      grantStartPermit(attemptId);
      systemctl('reset-failed','servora-med.service');
      systemctl('start','servora-med.service');
      revokeStartPermit(attemptId);
      let healthy = false;
      for (let sample = 0; sample < 30; sample++) {
        if (interrupted) throw new Error('RECOVERY_INTERRUPTED');
        await check();
        if (systemctl('show','servora-med.service','-p','Restart','--value') !== 'no') throw new Error('RECOVERY_AUTOMATIC_RESTART_NOT_DISABLED');
        if (systemctl('show','servora-med.service','-p','ActiveState','--value') === 'failed') throw new Error('RECOVERY_SERVICE_START_FAILED');
        try { assertProcessAndHealth(context); healthy = true; break; } catch { await delay(1000); }
      }
      if (!healthy) throw new Error('RECOVERY_HEALTH_FAILED');
      await check(); assertProcessAndHealth(context); record('HEALTH_PASSED');
      return 'FORWARD_RECOVERY=HEALTH_PASSED_PENDING_ACCEPTANCE';
    } catch (error) {
      // No OLD rollback. Keep the boot barrier and disable automatic starts.
      try { systemctl('stop','servora-med.service'); } catch { /* stays fenced */ }
      if (!interrupted) record('START_FAILED');
      throw error;
    } finally {
      revokeStartPermit(attemptId);
      process.removeListener('SIGTERM',interrupt); process.removeListener('SIGINT',interrupt);
    }
  });
}

function handBackToSystemd(context) {
  // Accepted ownership hand-off only. Keep the barrier while reloading the
  // ordinary restart policy; an interruption cannot boot an unaccepted app.
  context = currentAttempt(context.approval.attemptId);
  if (!['ACCEPTED','ABORTED'].includes(context.checkpoint.record.phase)) throw new Error('ATTEMPT_TRANSITION_INVALID');
  if (existsSync(STATE_ROOT+'/activation.block')) assertBarrier(context);
  revokeStartPermit(context.approval.attemptId);
  const policy = '/etc/systemd/system/servora-med.service.d/90-servora-recovery.conf';
  if (existsSync(policy)) {
    if (trustedFile(policy,0o600).toString('utf8') !== '[Service]\nRestart=no\n') throw new Error('RECOVERY_POLICY_FILE_UNTRUSTED');
    unlinkSync(policy); flushDirectory('/etc/systemd/system/servora-med.service.d');
  }
  systemctl('daemon-reload');
  if (systemctl('show','servora-med.service','-p','Restart','--value') !== 'on-failure') throw new Error('RECOVERY_NORMAL_RESTART_POLICY_MISMATCH');
  if (existsSync(STATE_ROOT+'/activation.block')) { unlinkSync(STATE_ROOT+'/activation.block'); flushDirectory(STATE_ROOT); }
}

function assertBackupHealth(context) {
  let health;
  try {
    const text = execFileSync('/usr/bin/curl',['--fail','--silent','--show-error','--max-time','5',
      'http://127.0.0.1:3000/api/health/backup'],{env:COMMAND_ENV,encoding:'utf8',timeout:6000,stdio:['ignore','pipe','pipe']});
    health = JSON.parse(text);
  } catch { throw new Error('RECOVERY_BACKUP_HEALTH_FAILED'); }
  // Use the existing application projection/freshness SSOT; postdeploy success
  // must not substitute for its separate scheduled heartbeat.
  if (health.status !== 'ok' || health.provider !== 'host-observation') throw new Error('RECOVERY_BACKUP_HEALTH_FAILED');
  validateBackupDatabase(context.profile);
}

function assertRetainedBackups(context) {
  for (const [kind,receipt] of [['pre',context.checkpoint.record.predeployBackup],['post',context.checkpoint.record.postdeployBackup]]) {
    if (receipt && digest(trustedFile(`${STATE_ROOT}/backups/${context.approval.attemptId}-${kind}.dump`,0o600)) !== receipt.sha256) {
      throw new Error('RECOVERY_BACKUP_UNTRUSTED');
    }
  }
}

function retireCompletedOwner(context) {
  // Crash after terminal journal fsync but before claim retirement. Only
  // matching completed ownership may be retired; no activation is repeated.
  if (!existsSync(STATE_ROOT+'/active.json')) return false;
  currentAttempt(context.approval.attemptId);
  if (!['COMPLETED','COMPLETED_ABORT'].includes(context.checkpoint.record.phase)
    || existsSync(STATE_ROOT+'/activation.block') || existsSync(PERMIT_FILE)
    || existsSync('/etc/systemd/system/servora-med.service.d/90-servora-recovery.conf')) throw new Error('RECOVERY_COMPLETION_AMBIGUOUS');
  unlinkSync(STATE_ROOT+'/active.json'); flushDirectory(STATE_ROOT); return true;
}

/** Read-only confirmation of a terminal attempt. No mutation, no claim, no
 * service start, no backup. Unknown/malformed/revoked/conflicting terminal
 * records fail closed through the same validators.
 */
async function assertTerminalReadOnly(context, record) {
  const direction = record.phase === 'COMPLETED' ? 'target' : 'old';
  if (existsSync(STATE_ROOT+'/activation.block') || existsSync(PERMIT_FILE)
    || existsSync('/etc/systemd/system/servora-med.service.d/90-servora-recovery.conf')) {
    throw new Error('RECOVERY_COMPLETION_AMBIGUOUS');
  }
  verifyAttemptRelease(context.approval.attemptId,'target');
  if (record.phase === 'COMPLETED_ABORT') verifyAttemptRelease(context.approval.attemptId,'old');
  assertRetainedBackups(context);
  assertApprovedPointer(context.approval);
  await withGuard(context,direction,async check => {
    await check(); assertProcessAndHealth(context,direction);
    if (record.phase === 'COMPLETED') assertBackupHealth(context);
  });
}

/** Non-secret projection, validated before any operator artifact transfer. */
export async function preflightAttempt(attemptId) {
  let context = loadAttempt(attemptId);
  let mode = 'deploy';
  if (existsSync(STATE_ROOT+'/active.json')) {
    context = currentAttempt(attemptId);
    const record = context.checkpoint.record;
    if (['COMPLETED','COMPLETED_ABORT'].includes(record.phase)) {
      // Crash window: terminal journal fsynced before claim retirement.
      mode = record.phase === 'COMPLETED' ? 'forward-recovery' : 'pre-migration-abort';
      await assertTerminalReadOnly(context, record);
    } else if (['ADMITTED','BACKED_UP'].includes(record.phase)) {
      // Same-owner retry of an early, unmigrated attempt: resume as a deploy.
      verifyAttemptRelease(attemptId,'target'); assertRetainedBackups(context);
      assertApprovedPointer(context.approval);
      if (existsSync(STATE_ROOT+'/activation.block')) assertBarrier(context);
      await withGuard(context,'old',async check => { await check(); });
    } else {
      mode = 'forward-recovery';
      verifyAttemptRelease(attemptId,'target'); assertRetainedBackups(context);
      assertApprovedPointer(context.approval); assertBarrier(context);
      await withGuard(context,'target',async check => { await check(); });
    }
  } else if (existsSync(STATE_ROOT+'/attempts/'+attemptId)) {
    const checkpoint = readLatestCheckpoint(attemptId);
    const record = checkpoint.record;
    if (!['COMPLETED','COMPLETED_ABORT'].includes(record.phase)) throw new Error('ATTEMPT_DEPLOYMENT_IDENTITY_MISMATCH');
    // Terminal read-only confirmation after successful claim retirement.
    mode = record.phase === 'COMPLETED' ? 'forward-recovery' : 'pre-migration-abort';
    await assertTerminalReadOnly({ approval: context.approval, checkpoint, approvalSha256: context.approvalSha256 }, record);
  } else {
    if (!context.approval.allowMigration || !context.approval.allowForwardRecovery
      || !context.approval.allowPostdeployBackup
      || existsSync(STATE_ROOT+'/activation.block')) throw new Error('ATTEMPT_DEPLOYMENT_IDENTITY_MISMATCH');
    verifyAttemptRelease(attemptId,'old');
    await withGuard(context,'old',async check => {
      await check(); assertProcessAndHealth(context,'old'); assertBackupHealth(context);
    });
  }
  return {mode,releaseSha:context.approval.releaseSha,treeSha:context.approval.treeSha,
    artifactSha256:context.approval.artifactSha256,ciManifestSha256:context.approval.ciManifestSha256,
    fqdn:context.profile.fqdn,oldReleaseSha:context.approval.oldReleaseSha};
}

export async function preparePostdeploy(attemptId,sha,fqdn) {
  const context = currentAttempt(attemptId);
  if (sha !== context.approval.releaseSha || fqdn !== context.profile.fqdn || !context.approval.allowPostdeployBackup) throw new Error('ATTEMPT_DEPLOYMENT_IDENTITY_MISMATCH');
  verifyAttemptRelease(attemptId,'target'); assertRetainedBackups(context);
  return withGuard(context,'target',async check => {
    await check(); assertProcessAndHealth(context); assertBackupHealth(context);
    let phase = context.checkpoint.record.phase;
    // Calling this fixed phase attests the operator wrapper's completed Mac
    // smoke. It is operator-trusted provenance, not independent authentication.
    if (phase === 'HEALTH_PASSED') phase = checkpointAttempt(attemptId,'SMOKE_PASSED').record.phase;
    if (phase === 'SMOKE_PASSED') { checkpointAttempt(attemptId,'POSTDEPLOY_BACKUP_INTENT'); return 'BACKUP_REQUIRED'; }
    if (['POSTDEPLOY_BACKUP_PASSED','OBSERVATION_PASSED','ACCEPTED','COMPLETED'].includes(phase)) return 'BACKUP_ALREADY_VERIFIED';
    throw new Error('POSTDEPLOY_BACKUP_AMBIGUOUS_OPERATOR_REVIEW_REQUIRED');
  });
}

/** No duration input exists. A fresh full interval is required after an
 * interrupted observation; completed backup/start operations are not repeated.
 */
export async function observeAttempt(attemptId) {
  const context = currentAttempt(attemptId);
  verifyAttemptRelease(attemptId,'target'); assertRetainedBackups(context);
  if (!['POSTDEPLOY_BACKUP_PASSED','OBSERVATION_PASSED','ACCEPTED','COMPLETED'].includes(context.checkpoint.record.phase)) throw new Error('ATTEMPT_TRANSITION_INVALID');
  return withGuard(context,'target',async check => {
    if (context.checkpoint.record.phase === 'COMPLETED') {
      await check(); assertProcessAndHealth(context); assertBackupHealth(context);
      return retireCompletedOwner(context) ? 'OBSERVATION=ALREADY_COMPLETED_OWNER_RETIRED' : 'OBSERVATION=ALREADY_COMPLETED_READ_ONLY';
    }
    if (context.checkpoint.record.phase !== 'ACCEPTED') assertBarrier(context);
    let phase = context.checkpoint.record.phase;
    if (phase === 'POSTDEPLOY_BACKUP_PASSED') {
      const startUTC = new Date().toISOString();
      const start = process.hrtime.bigint();
      const boot = readFileSync('/proc/sys/kernel/random/boot_id','utf8');
      let samples = 0, pid, interrupted = false;
      const interrupt = () => { interrupted = true; };
      process.once('SIGTERM',interrupt); process.once('SIGINT',interrupt);
      const logDirectory = attemptLogDirectory(attemptId);
      const logFd = openSync(`${logDirectory}/observation-${randomUUID()}.log`,
        constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      flushDirectory(logDirectory);
      const emit = text => { writeFileSync(logFd,text+'\n'); fsyncSync(logFd); console.log(text); };
      emit('OBSERVATION_START_UTC='+startUTC);
      try {
        while (true) {
          if (interrupted) throw new Error('OBSERVATION_PARTIAL_INTERRUPTED');
          await check();
          const currentPid = assertProcessAndHealth(context); assertBackupHealth(context);
          if ((pid && pid !== currentPid) || readFileSync('/proc/sys/kernel/random/boot_id','utf8') !== boot
            || systemctl('show','servora-med.service','-p','Restart','--value') !== 'no') throw new Error('RECOVERY_OBSERVATION_UNSTABLE');
          pid = currentPid; samples++;
          const elapsedSeconds = Number((process.hrtime.bigint()-start)/1000000000n);
          emit(`OBSERVATION_SAMPLE=${samples} UTC=${new Date().toISOString()} elapsed_seconds=${elapsedSeconds} health=PASS release=PASS backup=PASS pid=${pid}`);
          if (elapsedSeconds >= 1800) {
            phase = checkpointAttempt(attemptId,{kind:'OBSERVATION_PASSED',elapsedSeconds}).record.phase;
            emit('OBSERVATION_END_UTC='+new Date().toISOString()); break;
          }
          await delay(Math.min(30000,(1800-elapsedSeconds)*1000));
        }
      } catch (error) {
        emit(`OBSERVATION_STOP_UTC=${new Date().toISOString()} samples=${samples} reason=${/^[A-Z_]+$/.test(error.message)?error.message:'CHECK_FAILED'}`);
        throw error;
      } finally { closeSync(logFd); process.removeListener('SIGTERM',interrupt); process.removeListener('SIGINT',interrupt); }
    }
    if (phase === 'OBSERVATION_PASSED') phase = checkpointAttempt(attemptId,'ACCEPTED').record.phase;
    await check(); assertProcessAndHealth(context); assertBackupHealth(context);
    if (phase !== 'ACCEPTED') throw new Error('ATTEMPT_TRANSITION_INVALID');
    handBackToSystemd(context);
    checkpointAttempt(attemptId,'COMPLETED');
    unlinkSync(STATE_ROOT+'/active.json'); flushDirectory(STATE_ROOT);
    return 'OBSERVATION=PASS';
  });
}

export async function abortAttempt(attemptId) {
  const context = currentAttempt(attemptId);
  assertRetainedBackups(context);
  if (context.checkpoint.record.phase === 'COMPLETED_ABORT') {
    verifyAttemptRelease(attemptId,'target'); verifyAttemptRelease(attemptId,'old');
    return withGuard(context,'old',async check => {
      await check(); assertProcessAndHealth(context,'old');
      return retireCompletedOwner(context) ? 'PRE_MIGRATION_ABORT=ALREADY_COMPLETED_OWNER_RETIRED' : 'PRE_MIGRATION_ABORT=ALREADY_COMPLETED_READ_ONLY';
    });
  }
  if (!context.approval.allowPreMigrationAbort || context.checkpoint.record.migrationCommitted
    || !['ADMITTED','BACKED_UP','FENCED','MIGRATION_INTENT','ABORTED'].includes(context.checkpoint.record.phase)) {
    throw new Error('PRE_MIGRATION_ABORT_NOT_AUTHORIZED');
  }
  verifyAttemptRelease(attemptId,'target'); // trusted pg runtime for the UID probe
  assertApprovedPointer(context.approval);
  // An early interruption (ADMITTED hello-window) may have no barrier yet;
  // only a same-owner barrier is ever created or reused below.
  if (context.checkpoint.record.phase !== 'ABORTED' && existsSync(STATE_ROOT+'/activation.block')) assertBarrier(context);
  return withGuard(context,'old',async check => {
    // DB OLD EXACT precedes every mutation and any barrier removal. Never
    // decide this from a retry's migrations_applied=0 or schema head alone.
    await check(); verifyAttemptRelease(attemptId,'old');
    if (context.checkpoint.record.phase !== 'ABORTED') {
      if (!existsSync(STATE_ROOT+'/activation.block')) writeAttemptBarrier(attemptId, context.approvalSha256);
      execFileSync('/bin/bash',['--noprofile','--norc','-c',
        'source /usr/local/libexec/servora-med/deploy-production-host; r4_suppress_restarts'],
        {env:COMMAND_ENV,timeout:40000,stdio:['ignore','pipe','pipe']});
      systemctl('stop','servora-med.service'); revokeStartPermit(attemptId);
      checkpointAttempt(attemptId,'ABORT_INTENT');
      await check(); alignAttemptEnvironment(attemptId,'old');
      await check(); alignAttemptPointer(attemptId,'old');
      try {
        grantStartPermit(attemptId);
        systemctl('reset-failed','servora-med.service'); systemctl('start','servora-med.service');
        revokeStartPermit(attemptId);
        let healthy = false;
        for (let sample = 0; sample < 30; sample++) {
          await check();
          try { assertProcessAndHealth(context,'old'); healthy = true; break; } catch { await delay(1000); }
        }
        if (!healthy) throw new Error('PRE_MIGRATION_ABORT_HEALTH_FAILED');
        checkpointAttempt(attemptId,'ABORTED');
      } catch (error) {
        try { systemctl('stop','servora-med.service'); } catch { /* barrier stays */ }
        throw error; // Ambiguous/failed abort never restores normal restarts.
      } finally { revokeStartPermit(attemptId); }
    }
    await check(); assertProcessAndHealth(context,'old');
    handBackToSystemd(context);
    checkpointAttempt(attemptId,'COMPLETED_ABORT');
    unlinkSync(STATE_ROOT+'/active.json'); flushDirectory(STATE_ROOT);
    return 'PRE_MIGRATION_ABORT=COMPLETE_OLD_EXACT';
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, attemptId, ...extra] = process.argv.slice(2);
    if (command === 'preflight' && extra.length === 0) {
      process.stdout.write(JSON.stringify(await preflightAttempt(attemptId))+'\n');
    } else if (command === 'inspect' && extra.length === 0) {
      process.stdout.write(JSON.stringify(loadAttempt(attemptId).approval)+'\n');
    } else if (command === 'match-deploy' && extra.length === 3) {
      const {approval,profile,approvalSha256: contextSha256} = loadAttempt(attemptId);
      const tuple = validateIdentityTuple(trustedFile(ENV_FILE,0o640,null).toString('utf8'),approval);
      // Every scope the normal deployment path unconditionally needs must be
      // granted before admission, backup, migration or any service mutation.
      if (!approval.allowMigration || !approval.allowForwardRecovery || !approval.allowPostdeployBackup) {
        throw new Error('ATTEMPT_DEPLOYMENT_SCOPES_INCOMPLETE');
      }
      if (extra[0] !== approval.releaseSha || extra[1] !== approval.artifactSha256
        || extra[2] !== profile.fqdn || realpathSync('/opt/servora-med/current') !== '/opt/servora-med/releases/'+approval.oldReleaseSha
        || tuple.release !== approval.oldReleaseSha || tuple.schema !== approval.oldCatalog.at(-1).version) throw new Error('ATTEMPT_DEPLOYMENT_IDENTITY_MISMATCH');
      validateBackupDatabase(profile);
      // A same-owner resume of an early, unmigrated attempt is admitted;
      // any other active owner, later phase or foreign barrier blocks a
      // fresh deployment binding. No claim is ever silently replaced.
      if (existsSync(STATE_ROOT+'/active.json')) {
        const active = readProtectedRecord(STATE_ROOT+'/active.json').record;
        const phase = readLatestCheckpoint(attemptId).record.phase;
        if (Object.keys(active).length !== 2 || active.attemptId !== attemptId
          || active.approvalSha256 !== contextSha256
          || !['ADMITTED','BACKED_UP'].includes(phase)) throw new Error('RECOVERY_OTHER_ATTEMPT_ACTIVE');
      }
      if (existsSync(STATE_ROOT+'/activation.block')) {
        let barrier;
        try { barrier = readProtectedRecord(STATE_ROOT+'/activation.block').record; }
        catch { throw new Error('RECOVERY_OTHER_ATTEMPT_ACTIVE'); }
        if (Object.keys(barrier).length !== 2 || barrier.attemptId !== attemptId
          || barrier.approvalSha256 !== contextSha256) throw new Error('RECOVERY_OTHER_ATTEMPT_ACTIVE');
      }
      process.stdout.write('ATTEMPT_DEPLOYMENT_BINDING_PASS\n');
    } else if (command === 'probe-old' && extra.length === 0) {
      const context = loadAttempt(attemptId);
      verifyAttemptRelease(attemptId,'target'); verifyAttemptRelease(attemptId,'old');
      await withGuard(context,'old',async check => { await check(); });
      process.stdout.write('ATTEMPT_OLD_DATABASE_EXACT_PASS\n');
    } else if (command === 'migration-log-path' && extra.length === 0) {
      process.stdout.write(attemptLogDirectory(attemptId)+'/migration.log\n');
    } else if (command === 'admit' && extra.length === 0) {
      const admitted = admitAttempt(attemptId);
      process.stdout.write(admitted.resumed
        ? 'ATTEMPT_RESUMED phase='+admitted.checkpoint.record.phase+'\n' : 'ATTEMPT_ADMITTED\n');
    } else if (command === 'migration-intent' && extra.length === 7) {
      const values = extra.map(value => Number(value));
      if (values.some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error('RECOVERY_CONTROLLER_ARGUMENTS_INVALID');
      checkpointAttempt(attemptId,{kind:'MIGRATION_INTENT',baseline:{organizations:values[0],admins:values[1],
        staff:values[2],customers:values[3],products:values[4],jobs:values[5],demoData:values[6]}});
      process.stdout.write('ATTEMPT_EVENT_RECORDED\n');
    } else if (command === 'event' && extra.length === 1) {
      if (!['FENCED','SCHEMA_CHECKED','SMOKE_PASSED','POSTDEPLOY_BACKUP_INTENT'].includes(extra[0])) throw new Error('RECOVERY_CONTROLLER_ARGUMENTS_INVALID');
      checkpointAttempt(attemptId,extra[0]); process.stdout.write('ATTEMPT_EVENT_RECORDED\n');
    } else if (command === 'barrier' && extra.length === 0) {
      createAttemptBarrier(attemptId); process.stdout.write('ATTEMPT_BARRIER_CREATED\n');
    } else if (command === 'backup-receipt' && extra.length === 2) {
      sealBackupReceipt(attemptId,extra[0],extra[1]); process.stdout.write('ATTEMPT_BACKUP_SEALED\n');
    } else if (command === 'prepare-postdeploy' && extra.length === 2) {
      process.stdout.write(await preparePostdeploy(attemptId,...extra)+'\n');
    } else if (command === 'observe' && extra.length === 0) {
      process.stdout.write(await observeAttempt(attemptId)+'\n');
    } else if (command === 'recover' && extra.length === 0) {
      process.stdout.write(await recoverAttempt(attemptId)+'\n');
    } else if (command === 'abort' && extra.length === 0) {
      process.stdout.write(await abortAttempt(attemptId)+'\n');
    } else if (command === 'verify-release' && extra.length === 1 && ['old','target'].includes(extra[0])) {
      verifyAttemptRelease(attemptId,extra[0]);
      process.stdout.write('RECOVERY_RELEASE_PROOF_PASS\n');
    } else if (command === 'db-config' && extra.length === 1 && ['old','target'].includes(extra[0])) {
      const {approval,profile} = loadAttempt(attemptId);
      verifyAttemptCatalog(attemptId,'target');
      verifyAttemptCatalog(attemptId,extra[0]);
      process.stdout.write(JSON.stringify({releaseDirectory:'/opt/servora-med/releases/'+approval.releaseSha,
        expectedIdentity:profile.databaseIdentity,
        expectedCatalog:(extra[0] === 'old' ? approval.oldCatalog : approval.targetCatalog).map(entry => entry.version)})+'\n');
    } else throw new Error('RECOVERY_CONTROLLER_ARGUMENTS_INVALID');
  } catch (error) {
    // Print only our constant contract errors; no filesystem, connection or
    // protected environment values may reach the operator log.
    console.error(/^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'RECOVERY_CONTROLLER_FAILED');
    process.exitCode = 1;
  }
}
