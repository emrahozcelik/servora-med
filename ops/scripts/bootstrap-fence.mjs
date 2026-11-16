/** B1-01 read-only management fence. No create, repair, release or bypass API.
 * Root may deliberately change any host policy; that actor is outside this
 * fence's threat model. Delegated commands must never receive that authority. */
import * as fs from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {dirname} from 'node:path';
import {pathToFileURL} from 'node:url';

const ROOT = '/var/lib/servora-med/deploy/bootstrap';
const LIB = '/usr/local/libexec/servora-med';
const PROFILE = '/var/lib/servora-med/deploy/profile.json';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const canonical = value => JSON.stringify(value) + '\n';
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw new Error('BOOTSTRAP_FENCE_' + code); };

// Minimum canonical closure. Additional active, versioned forward/emergency
// tools belong in the owner-reviewed manifest too; this is never a path selector.
export const REQUIRED_MANAGEMENT_FILES = Object.freeze([
  ['bootstrap-fence', 0o755], ['bootstrap-fence.mjs', 0o644],
  ['deploy-production-host', 0o755], ['deployment-attempt.mjs', 0o644],
  ['deployment-controller.mjs', 0o644], ['deployment-db-guard.mjs', 0o644],
  ['historical-recovery-evidence.mjs', 0o644], ['host-operation-lock.sh', 0o644],
  ['migration-reconciliation.mjs', 0o644], ['trusted-time.mjs', 0o644],
].map(([name, mode]) => Object.freeze({path: LIB + '/' + name, mode})));
const ATTEMPT_OPERATIONS = ['deploy', 'postdeploy', 'attempt-preflight', 'forward-recovery', 'pre-migration-abort', 'controller'];
const OPERATIONS = [...ATTEMPT_OPERATIONS, 'controller', 'forward', 'emergency-handoff',
  'preserve-authorization', 'adoption', 'legacy-deploy', 'rollback', 'legacy-restore'];
export const BOOTSTRAP_RELEASE_CHECKS = Object.freeze(['toolClosure', 'mutationCoverage', 'delegatedAccess', 'noPendingOperation',
  'historicalPreservation', 'canonicalTrustedTime', 'profileContracts', 'serviceUnchanged']);
const CHECKS = BOOTSTRAP_RELEASE_CHECKS;
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const sameStat = (a, b) => ['dev', 'ino', 'size', 'uid', 'gid', 'mode', 'nlink', 'mtimeNs', 'ctimeNs']
  .every(key => a[key] === b[key]);

/** Descriptor-based trusted reader; injected fs exists only for synthetic tests.
 * Ancestors are physical, root-owned and not group/other writable. The shared
 * libexec directory can remain 0755 for _chrony; bootstrap records are 0600. */
export function readBootstrapTrustedFile(file, mode, io = fs) {
  try {
    let parent = dirname(file);
    for (;;) {
      const info = io.lstatSync(parent, {bigint: true});
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0n
        || (info.mode & 0o022n) !== 0n
        || (parent === ROOT && (info.gid !== 0n || (info.mode & 0o7777n) !== 0o700n))) fail('PATH_UNTRUSTED');
      if (parent === '/') break;
      parent = dirname(parent);
    }
    const before = io.lstatSync(file, {bigint: true});
    const trusted = info => info.isFile() && !info.isSymbolicLink() && info.uid === 0n && info.gid === 0n
      && info.nlink === 1n && (info.mode & 0o7777n) === BigInt(mode) && info.size <= 4n * 1024n * 1024n;
    if (!trusted(before)) fail('FILE_UNTRUSTED');
    const fd = io.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const opened = io.fstatSync(fd, {bigint: true});
      if (!trusted(opened) || !sameStat(before, opened)) fail('FILE_UNTRUSTED');
      const bytes = io.readFileSync(fd);
      const after = io.fstatSync(fd, {bigint: true});
      const named = io.lstatSync(file, {bigint: true});
      if (!sameStat(before, after) || !sameStat(after, named) || BigInt(bytes.length) !== before.size) fail('FILE_CHANGED');
      return bytes;
    } finally { io.closeSync(fd); }
  } catch (error) {
    if (/^BOOTSTRAP_FENCE_/.test(error.message)) throw error;
    // Preserve ENOENT only for the optional RELEASED record, after validating
    // every ancestor. EACCES, ENOTDIR and dangling links are never absence.
    if (error.code === 'ENOENT') throw Object.assign(new Error('BOOTSTRAP_FENCE_UNREADABLE'), {code: 'ENOENT'});
    fail('UNREADABLE');
  }
}

/** Shared by the read-only guard and separately authorized installation writer.
 * Validation grants no release or filesystem mutation authority. */
export function validateBootstrapManagementManifest(body) {
  if (!exactKeys(body, ['formatVersion', 'kind', 'files']) || body.formatVersion !== 1
    || body.kind !== 'BOOTSTRAP_MANAGEMENT_MANIFEST') fail('RECORD_INVALID');
  if (!Array.isArray(body.files) || body.files.length < REQUIRED_MANAGEMENT_FILES.length
    || body.files.length > 128) fail('MANIFEST_INVALID');
  let previous = '';
  for (const tool of body.files) {
    if (!exactKeys(tool, ['path', 'mode', 'sha256']) || typeof tool.path !== 'string'
      || !/^\/usr\/local\/libexec\/servora-med(?:-[a-z0-9-]+)?\/[a-zA-Z0-9/_.-]+$/.test(tool.path)
      || tool.path.slice(1).split('/').some(part => !part || part === '.' || part === '..')
      || tool.path <= previous || ![0o600, 0o644, 0o750, 0o755].includes(tool.mode) || !SHA.test(tool.sha256)) fail('MANIFEST_INVALID');
    previous = tool.path;
  }
  if (REQUIRED_MANAGEMENT_FILES.some(required => !body.files.some(tool => tool.path === required.path && tool.mode === required.mode))) fail('MANIFEST_INVALID');
  return body.files;
}

/** Synthetic port constructor. The production entrypoint never accepts a path,
 * UID, fs adapter, environment switch, clock or state override from its caller. */
export function createBootstrapFenceGuard(io) {
  const read = (path, mode = 0o600) => {
    try { return io.readTrusted(path, mode); }
    catch (error) {
      if (/^BOOTSTRAP_FENCE_/.test(error.message)) throw error;
      throw Object.assign(new Error('BOOTSTRAP_FENCE_UNREADABLE'), {code: error.code});
    }
  };
  const record = bytes => {
    try {
      const envelope = JSON.parse(bytes.toString('utf8'));
      if (!exactKeys(envelope, ['record', 'sha256']) || !SHA.test(envelope.sha256)
        || canonical(envelope) !== bytes.toString('utf8')
        || hash(canonical(envelope.record)) !== envelope.sha256) fail('RECORD_INVALID');
      return envelope.record;
    } catch { fail('RECORD_INVALID'); }
  };
  const readRecord = path => { const bytes = read(path); return {body: record(bytes), sha256: hash(bytes)}; };
  const kind = (body, name, fields) => {
    if (!exactKeys(body, ['formatVersion', 'kind', ...fields])
      || body.formatVersion !== 1 || body.kind !== name) fail('RECORD_INVALID');
  };
  return (operation, attemptId) => {
    io.assertRoot();
    if (!OPERATIONS.includes(operation)) fail('OPERATION_INVALID');
    const closed = readRecord(ROOT + '/closed.json');
    try {
      const names = io.list(ROOT);
      if (names.some(name => !['closed.json', 'manifest.json', 'verification.json',
        'release-authorization.json', 'released.json'].includes(name))) fail('DIRECTORY_INVALID');
    } catch (error) {
      if (/^BOOTSTRAP_FENCE_/.test(error.message)) throw error;
      fail('UNREADABLE');
    }
    kind(closed.body, 'BOOTSTRAP_FENCE_CLOSED', ['fenceId', 'machineId', 'manifestSha256', 'hostLock']);
    if (!UUID.test(closed.body.fenceId) || !/^[0-9a-f]{32}$/.test(closed.body.machineId)
      || closed.body.machineId !== io.machineId() || !SHA.test(closed.body.manifestSha256)
      || !exactKeys(closed.body.hostLock, ['device', 'inode'])
      || !/^[0-9]+$/.test(closed.body.hostLock.device) || !/^[1-9][0-9]*$/.test(closed.body.hostLock.inode)) fail('RECORD_INVALID');
    let releasedBytes;
    try { releasedBytes = read(ROOT + '/released.json'); }
    catch (error) { if (error.code === 'ENOENT') fail('CLOSED'); throw error; }
    const released = record(releasedBytes);
    kind(released, 'BOOTSTRAP_FENCE_RELEASED', ['fenceSha256', 'authorizationSha256', 'verificationSha256']);
    const authorization = readRecord(ROOT + '/release-authorization.json');
    kind(authorization.body, 'BOOTSTRAP_RELEASE_AUTHORIZATION',
      ['fenceSha256', 'manifestSha256', 'profileSha256', 'verificationSha256', 'scope']);
    const verification = readRecord(ROOT + '/verification.json');
    kind(verification.body, 'BOOTSTRAP_RELEASE_VERIFICATION',
      ['fenceSha256', 'manifestSha256', 'profileSha256', 'checks']);
    const a = authorization.body, v = verification.body;
    if (released.fenceSha256 !== closed.sha256 || a.fenceSha256 !== closed.sha256 || v.fenceSha256 !== closed.sha256
      || released.authorizationSha256 !== authorization.sha256 || released.verificationSha256 !== verification.sha256
      || a.verificationSha256 !== verification.sha256 || a.scope !== 'ENABLE_APPROVAL_GATED_MANAGEMENT'
      || a.manifestSha256 !== closed.body.manifestSha256 || v.manifestSha256 !== a.manifestSha256
      || !SHA.test(a.profileSha256) || v.profileSha256 !== a.profileSha256
      || !exactKeys(v.checks, CHECKS) || CHECKS.some(key => v.checks[key] !== true)) fail('RELEASE_INVALID');
    if (hash(read(PROFILE)) !== a.profileSha256) fail('PROFILE_DRIFT');
    const lock = io.lockIdentity();
    if (lock.device !== closed.body.hostLock.device || lock.inode !== closed.body.hostLock.inode) fail('LOCK_UNTRUSTED');
    const manifest = readRecord(ROOT + '/manifest.json');
    if (manifest.sha256 !== a.manifestSha256) fail('MANIFEST_INVALID');
    const tools = validateBootstrapManagementManifest(manifest.body);
    for (const tool of tools) {
      if (hash(read(tool.path, tool.mode)) !== tool.sha256) fail('TOOL_DRIFT');
    }
    if (['legacy-deploy', 'rollback', 'legacy-restore'].includes(operation)) fail('LEGACY_MUTATION_DISABLED');
    if (ATTEMPT_OPERATIONS.includes(operation) && !UUID.test(attemptId ?? '')) fail('ATTEMPT_REQUIRED');
    // This permission is a prerequisite, never a deployment approval. The
    // caller must still run its existing R4 or forward/emergency authorization.
    return {state: 'RELEASED', fenceSha256: closed.sha256, manifestSha256: manifest.sha256};
  };
}

export function assertBootstrapManagementAllowed(operation, attemptId) {
  return createBootstrapFenceGuard({
    assertRoot: () => { if (process.platform !== 'linux' || process.getuid?.() !== 0) fail('ROOT_LINUX_REQUIRED'); },
    readTrusted: readBootstrapTrustedFile,
    list: directory => fs.readdirSync(directory),
    lockIdentity: () => {
      const file = '/var/lib/servora-med/deploy/host.lock';
      if (readBootstrapTrustedFile(file, 0o600).length !== 0) fail('LOCK_UNTRUSTED');
      const info = fs.lstatSync(file, {bigint: true});
      return {device: String(info.dev), inode: String(info.ino)};
    },
    machineId: () => {
      const mode = Number(fs.lstatSync('/etc/machine-id', {bigint: true}).mode & 0o7777n);
      if (![0o444, 0o644].includes(mode)) fail('FILE_UNTRUSTED');
      return readBootstrapTrustedFile('/etc/machine-id', mode).toString('utf8').trim();
    },
  })(operation, attemptId);
}

/** For standalone root maintenance CLIs without an inherited host lock. Never
 * creates, unlinks or reclaims the stable inode. A closed fence is read before
 * locking and again while holding the same kernel lock as the host helper.
 * Returns a Promise: callers MUST await it before reporting success or exiting.
 * Retain the lock until the callback settles, including asynchronous rejection. */
export async function withBootstrapMutationLock(operation, attemptId, action) {
  assertBootstrapManagementAllowed(operation, attemptId);
  const lock = '/var/lib/servora-med/deploy/host.lock';
  if (readBootstrapTrustedFile(lock, 0o600).length !== 0) fail('LOCK_UNTRUSTED');
  const before = fs.lstatSync(lock, {bigint: true});
  const fd = fs.openSync(lock, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    if (!sameStat(before, fs.fstatSync(fd, {bigint: true}))) fail('LOCK_UNTRUSTED');
    try {
      execFileSync('/usr/bin/flock', ['--nonblock', '3'],
        {stdio: ['ignore', 'pipe', 'pipe', fd], env: {PATH: '/usr/bin:/bin'}, timeout: 2000});
    } catch { fail('LOCK_BUSY'); }
    if (!sameStat(before, fs.lstatSync(lock, {bigint: true}))) fail('LOCK_UNTRUSTED');
    assertBootstrapManagementAllowed(operation, attemptId);
    return await action();
  } finally { fs.closeSync(fd); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [operation, attemptId, ...extra] = process.argv.slice(2);
    if (extra.length || !operation) fail('ARGUMENTS_INVALID');
    process.stdout.write(canonical(assertBootstrapManagementAllowed(operation, attemptId)));
  } catch (error) {
    console.error(/^BOOTSTRAP_FENCE_[A-Z_]+$/.test(error.message) ? error.message : 'BOOTSTRAP_FENCE_UNREADABLE');
    process.exitCode = 1;
  }
}
