// Fixed-path root adapter; excluded from release artifacts and sudo delegation.
import fs from 'node:fs';
import {createHash, randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {basename, dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {REQUIRED_MANAGEMENT_FILES, assertBootstrapManagementAllowed, readBootstrapTrustedFile,
  validateBootstrapManagementManifest} from '../scripts/bootstrap-fence.mjs';
import {validateHostProfile} from '../scripts/deployment-attempt.mjs';
import {CHRONY_CONFIG_SHA256, validateCurrentTimeEvidence} from '../scripts/trusted-time.mjs';
import {PRODUCTION_PATHS} from './profile-reseal.mjs';
import {withExistingHostLock} from './bootstrap-delegation-quarantine-host.mjs';
import {POLICY_FILES, QUARANTINED_POLICY} from './bootstrap-delegation-quarantine.mjs';
import {createBootstrapInstaller, createBootstrapReleaser,
  encodeBootstrapEnvelope as encode, decodeBootstrapEnvelope as decode} from './bootstrap-transition.mjs';

const PRIVATE = '/var/lib/servora-med-bootstrap-transition';
const ROOT = '/var/lib/servora-med/deploy/bootstrap';
const BASE = '/usr/local/libexec/servora-med-bootstrap';
const LIB = '/usr/local/libexec/servora-med';
const QUARANTINE = '/var/lib/servora-med-bootstrap-quarantine';
const ENV = Object.freeze({PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C'});
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail = code => {throw new Error('BOOTSTRAP_TRANSITION_' + code);};
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const canonical = v => JSON.stringify(v) + '\n';
const hash = v => createHash('sha256').update(v).digest('hex');
const read = readBootstrapTrustedFile;
const same = (a, b) => ['dev', 'ino', 'size', 'uid', 'gid', 'mode', 'nlink', 'mtimeNs', 'ctimeNs']
  .every(key => a[key] === b[key]);
const categories = ['autonomous-management', 'other-identities', 'polkit', 'ssh', 'sudo'];
const sourceNames = {'bootstrap-fence': 'bootstrap-fence.sh', 'deploy-production-host': 'deploy-production-host.sh'};
const installInputs = ['install-authorization.json', 'manifest.json', 'prepared', 'external-quarantine-authorization.json',
  'install-review'];
export const BOOTSTRAP_TRANSITION_SOURCE_FILES = Object.freeze(REQUIRED_MANAGEMENT_FILES.map(tool =>
  Object.freeze({...tool, source: 'ops/scripts/' + (sourceNames[basename(tool.path)] ?? basename(tool.path))})));

function trustedDirectory(path, mode) {
  let p = path;
  for (;;) {
    const s = fs.lstatSync(p);
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== 0 || s.gid !== 0 || (s.mode & 0o022)
      || (p === path && mode !== undefined && (s.mode & 0o7777) !== mode)) fail('DIRECTORY_UNTRUSTED');
    if (p === '/') break;
    p = dirname(p);
  }
}

function absent(path) {
  try {fs.lstatSync(path);} catch (error) {if (error.code === 'ENOENT') return true; throw error;}
  return false;
}

function flushDirectory(path) {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
}

function exclusiveFile(path, bytes) {
  trustedDirectory(dirname(path));
  const fd = fs.openSync(path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
  flushDirectory(dirname(path));
}

function bootId() {
  const path = '/proc/sys/kernel/random/boot_id';
  trustedDirectory(dirname(path));
  const before = fs.lstatSync(path, {bigint: true});
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== 0n || before.gid !== 0n
    || (before.mode & 0o7777n) !== 0o444n) fail('BOOT_ID_UNTRUSTED');
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    if (!same(before, fs.fstatSync(fd, {bigint: true}))) fail('BOOT_ID_UNTRUSTED');
    // procfs reports size zero; bound the actual kernel reply separately.
    const bytes = fs.readFileSync(fd), value = bytes.toString('ascii').trim();
    if (bytes.length > 37 || !UUID.test(value) || !same(before, fs.fstatSync(fd, {bigint: true}))
      || !same(before, fs.lstatSync(path, {bigint: true}))) fail('BOOT_ID_UNTRUSTED');
    return value;
  } finally {fs.closeSync(fd);}
}

function nodeSha256() {
  const path = '/usr/bin/node';
  trustedDirectory(dirname(path));
  const before = fs.lstatSync(path, {bigint: true});
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== 0n || before.gid !== 0n || before.nlink !== 1n
    || (before.mode & 0o7777n) !== 0o755n || before.size <= 0n || before.size > 256n * 1024n * 1024n) fail('NODE_UNTRUSTED');
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    if (!same(before, fs.fstatSync(fd, {bigint: true}))) fail('NODE_UNTRUSTED');
    const digest = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
    let total = 0, count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) !== 0) {digest.update(buffer.subarray(0, count)); total += count;}
    if (BigInt(total) !== before.size || !same(before, fs.fstatSync(fd, {bigint: true}))
      || !same(before, fs.lstatSync(path, {bigint: true}))) fail('NODE_UNTRUSTED');
    return digest.digest('hex');
  } finally {fs.closeSync(fd);}
}

function plainRecord(path) {
  const bytes = read(path, 0o600), value = JSON.parse(bytes.toString('utf8'));
  if (canonical(value) !== bytes.toString('utf8')) fail('RECORD_INVALID');
  return {bytes, value};
}

function proof(directory, name, sha256) {
  const bytes = read(directory + '/' + name + '.json', 0o600);
  if (hash(bytes) !== sha256) fail('OPERATOR_EVIDENCE_DRIFT');
  return decode(bytes);
}

/** Checks a protected operator attestation, not an automatic proof that every
 * host route was discovered. The CLI never manufactures these permissions. */
export function validateOperatorEvidence({external, context, review, access, drain}) {
  const identity = r => r.formatVersion === 1 && r.machineId === external.machineId && r.bootId === external.bootId
    && r.phase === external.phase && r.reviewId === external.reviewId;
  if (!['install', 'release'].includes(context.phase) || external.phase !== context.phase || !UUID.test(external.reviewId)
    || !exact(review, ['formatVersion', 'kind', 'machineId', 'bootId', 'phase', 'reviewId', 'sourceSha', 'manifestSha256', 'scope', 'inventorySha256'])
    || !identity(review) || review.kind !== 'BOOTSTRAP_MANAGEMENT_ROUTE_REVIEW'
    || review.scope !== 'ALL_NON_ROOT_ROUTES_CLOSED' || review.sourceSha !== context.sourceSha
    || review.manifestSha256 !== context.manifestSha256 || !SHA.test(review.inventorySha256)
    || !exact(access, ['formatVersion', 'kind', 'machineId', 'bootId', 'phase', 'reviewId', 'uid', 'user', 'channel', 'independentOf'])
    || !identity(access) || access.kind !== 'BOOTSTRAP_INDEPENDENT_ROOT_ACCESS_PROOF'
    || access.uid !== 0 || access.user !== 'root' || !['SSH', 'CONSOLE'].includes(access.channel)
    || access.independentOf !== 'servora-deploy-sudo'
    || !exact(drain, ['formatVersion', 'kind', 'machineId', 'bootId', 'phase', 'reviewId', 'scope', 'inventorySha256'])
    || !identity(drain) || drain.kind !== 'BOOTSTRAP_PRIVILEGED_MUTATION_DRAIN_PROOF'
    || drain.scope !== 'NO_INFLIGHT_OR_AUTONOMOUS_MANAGEMENT' || !SHA.test(drain.inventorySha256)) fail('OPERATOR_EVIDENCE_INVALID');
}

export function parseTransitionArguments(argv) {
  const [command, ...a] = argv;
  if (command === 'install') {
    if (a.length === 5 && a[0] === '--capture' && a[1] === '--source-sha'
      && /^[a-f0-9]{40}$/.test(a[2]) && a[3] === '--fence-id' && UUID.test(a[4])) {
      return {command, mode: 'capture', sourceSha: a[2], fenceId: a[4]};
    }
    if (a.length === 3 && ['--dry-run', '--apply'].includes(a[0])
      && a[1] === '--expected-authorization' && SHA.test(a[2])) {
      return {command, mode: a[0].slice(2), expectedAuthorization: a[2]};
    }
  }
  if (command === 'release') {
    if (a.length === 1 && a[0] === '--capture') return {command, mode: 'capture'};
    if (a.length === 5 && a[0] === '--apply' && a[1] === '--expected-authorization' && SHA.test(a[2])
      && a[3] === '--expected-external-authorization' && SHA.test(a[4])) {
      return {command, mode: 'apply', expectedAuthorization: a[2], expectedExternalAuthorization: a[4]};
    }
  }
  fail('ARGUMENTS_INVALID');
}

function assertExternalQuarantine(port, e, context) {
  if (!['install', 'release'].includes(context.phase)) fail('PATH_INVALID');
  const directory = PRIVATE + '/' + context.phase + '-review';
  trustedDirectory(directory, 0o700);
  const q = plainRecord(QUARANTINE + '/receipt.json');
  if (hash(q.bytes) !== e.sudoReceiptSha256 || !exact(q.value, ['formatVersion', 'kind', 'authority',
    'authorizationSha256', 'oldPolicies', 'newPolicySha256', 'preservedState'])
    || q.value.formatVersion !== 1 || q.value.kind !== 'BOOTSTRAP_SUDO_MANAGEMENT_QUARANTINED'
    || q.value.authority !== 'SUDO_ONLY_NOT_BOOTSTRAP_INSTALL_OR_RELEASE'
    || q.value.newPolicySha256 !== hash(QUARANTINED_POLICY)
    || !Array.isArray(q.value.oldPolicies) || q.value.oldPolicies.length !== POLICY_FILES.length
    || q.value.oldPolicies.some((p, i) => p.path !== POLICY_FILES[i] || !SHA.test(p.sha256))) fail('SUDO_QUARANTINE_INVALID');
  const qa = plainRecord(QUARANTINE + '/authorization.json');
  if (hash(qa.bytes) !== q.value.authorizationSha256 || qa.value.kind !== 'BOOTSTRAP_SUDO_QUARANTINE_AUTHORIZATION'
    || qa.value.scope !== 'CLOSE_SERVORA_DEPLOY_SUDO_ONLY' || qa.value.machineId !== e.machineId
    || canonical(qa.value.hostLock) !== canonical(e.hostLock)) fail('SUDO_QUARANTINE_INVALID');
  for (const path of POLICY_FILES) if (!read(path, 0o440).equals(Buffer.from(QUARANTINED_POLICY))) fail('DELEGATION_NOT_CLOSED');
  port.assertSudoClosed();
  const review = proof(directory, 'management-review', e.managementReviewSha256);
  const access = proof(directory, 'root-access-proof', e.rootAccessProofSha256);
  const drain = proof(directory, 'process-drain-proof', e.processDrainProofSha256);
  validateOperatorEvidence({external: e, context, review, access, drain});
  const inventory = proof(directory, 'management-inventory', review.inventorySha256);
  if (!exact(inventory, ['formatVersion', 'kind', 'machineId', 'bootId', 'phase', 'reviewId', 'categories'])
    || inventory.formatVersion !== 1 || inventory.kind !== 'BOOTSTRAP_MANAGEMENT_ENTRYPOINT_INVENTORY'
    || inventory.machineId !== e.machineId || inventory.bootId !== e.bootId
    || inventory.phase !== e.phase || inventory.reviewId !== e.reviewId
    || !Array.isArray(inventory.categories) || inventory.categories.length !== categories.length) fail('OPERATOR_EVIDENCE_INVALID');
  trustedDirectory(directory + '/route-evidence', 0o700);
  if (canonical(fs.readdirSync(directory + '/route-evidence').sort()) !== canonical(categories.map(c => c + '.json'))) fail('OPERATOR_EVIDENCE_INVALID');
  for (const [i, c] of categories.entries()) {
    const entry = inventory.categories[i];
    if (!exact(entry, ['category', 'evidenceSha256']) || entry.category !== c || !SHA.test(entry.evidenceSha256)
      || hash(read(directory + '/route-evidence/' + c + '.json', 0o600)) !== entry.evidenceSha256) fail('OPERATOR_EVIDENCE_INVALID');
  }
  const processes = proof(directory, 'management-process-inventory', drain.inventorySha256);
  if (!exact(processes, ['formatVersion', 'kind', 'machineId', 'bootId', 'phase', 'reviewId', 'scope', 'processes'])
    || processes.formatVersion !== 1 || processes.kind !== 'BOOTSTRAP_MANAGEMENT_PROCESS_INVENTORY'
    || processes.machineId !== e.machineId || processes.bootId !== e.bootId
    || processes.phase !== e.phase || processes.reviewId !== e.reviewId
    || processes.scope !== 'MANAGEMENT_MUTATION_PROCESSES' || !Array.isArray(processes.processes)
    || processes.processes.length) fail('PRIVILEGED_MANAGEMENT_NOT_DRAINED');
}

function readOptionalTool(tool) {
  trustedDirectory(dirname(tool.path), dirname(tool.path) === LIB ? 0o755 : undefined);
  return absent(tool.path) ? null : read(tool.path, tool.mode);
}

function assertFreshInstall() {
  trustedDirectory(PRIVATE, 0o700); trustedDirectory(PRIVATE + '/prepared', 0o700);
  trustedDirectory('/var/lib/servora-med/deploy', 0o700); trustedDirectory(LIB, 0o755);
  if (fs.readdirSync(PRIVATE).some(n => !installInputs.includes(n)) || !absent(ROOT)) fail('STATE_NOT_FRESH');
}

function assertFreshRelease() {
  trustedDirectory(PRIVATE, 0o700); trustedDirectory(ROOT, 0o700);
  const allowed = [...installInputs, 'install-operation.json', 'originals', 'install-receipt.json',
    'release-external-authorization.json', 'release-review'];
  if (fs.readdirSync(PRIVATE).some(n => !allowed.includes(n))) fail('STATE_NOT_FRESH');
  for (const name of ['release-operation.json', 'release-evidence.json']) if (!absent(PRIVATE + '/' + name)) fail('STATE_NOT_FRESH');
  if (fs.readdirSync(ROOT).some(n => !['closed.json', 'manifest.json', 'verification.json', 'release-authorization.json'].includes(n))) fail('STATE_NOT_FRESH');
  for (const name of fs.readdirSync(ROOT)) read(ROOT + '/' + name, 0o600);
}

function assertPreparedClosure(tools) {
  trustedDirectory(PRIVATE + '/prepared', 0o700);
  const names = [...new Set(tools.map(t => t.sha256))].sort();
  if (canonical(fs.readdirSync(PRIVATE + '/prepared').sort()) !== canonical(names)) fail('PREPARED_TOOL_DRIFT');
  for (const source of BOOTSTRAP_TRANSITION_SOURCE_FILES) {
    const target = tools.find(t => t.path === source.path);
    if (!target || target.sha256 !== hash(read(BASE + '/' + source.source, 0o644))) fail('PREPARED_SOURCE_MISMATCH');
  }
  for (const parent of new Set(tools.map(t => dirname(t.path)))) {
    trustedDirectory(parent, parent === LIB ? 0o755 : undefined);
    if (fs.readdirSync(parent).some(n => n.startsWith('.bootstrap-install-'))) fail('PUBLICATION_RESIDUE');
  }
}

function reserveInstall(prepared, authorizationSha256) {
  exclusiveFile(PRIVATE + '/install-operation.json', encode({formatVersion: 1,
    kind: 'BOOTSTRAP_INSTALL_RESERVED', authorizationSha256}));
  fs.mkdirSync(PRIVATE + '/originals', {mode: 0o700}); flushDirectory(PRIVATE);
  const index = prepared.map((p, i) => {
    const original = String(i).padStart(3, '0');
    if (p.previous !== null) exclusiveFile(PRIVATE + '/originals/' + original, p.previous);
    return {path: p.tool.path, mode: p.tool.mode, original: p.previous === null ? null : original,
      sha256: p.previous === null ? null : hash(p.previous)};
  });
  exclusiveFile(PRIVATE + '/originals/index.json', encode({formatVersion: 1, kind: 'BOOTSTRAP_ORIGINAL_TOOLS', files: index}));
}

function publishClosed(manifestBytes, closedBytes) {
  fs.mkdirSync(ROOT, {mode: 0o700}); flushDirectory(dirname(ROOT));
  trustedDirectory(ROOT, 0o700);
  exclusiveFile(ROOT + '/manifest.json', manifestBytes);
  exclusiveFile(ROOT + '/closed.json', closedBytes);
}

function replaceTool(tool, bytes, previous) {
  const manifest = validateBootstrapManagementManifest(decode(read(PRIVATE + '/manifest.json', 0o600)));
  if (!manifest.some(t => canonical(t) === canonical(tool)) || hash(bytes) !== tool.sha256) fail('TOOL_PATH_INVALID');
  const current = readOptionalTool(tool), before = current === null ? null : fs.lstatSync(tool.path, {bigint: true});
  if (previous === null ? current !== null : current === null || !current.equals(previous)) fail('OLD_TOOL_DRIFT');
  if (previous !== null && previous.equals(bytes)) return;
  const temporary = dirname(tool.path) + '/.bootstrap-install-' + randomUUID();
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, tool.mode);
  try {fs.fchmodSync(fd, tool.mode); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
  if (previous === null) {
    if (!absent(tool.path)) fail('OLD_TOOL_DRIFT');
    fs.linkSync(temporary, tool.path); fs.unlinkSync(temporary);
  } else {
    if (!same(before, fs.lstatSync(tool.path, {bigint: true})) || !read(tool.path, tool.mode).equals(previous)) fail('OLD_TOOL_DRIFT');
    fs.renameSync(temporary, tool.path);
  }
  flushDirectory(dirname(tool.path));
  if (!read(tool.path, tool.mode).equals(bytes)) fail('INSTALLED_TOOL_DRIFT');
}

function assertProfileContracts() {
  const bytes = read('/var/lib/servora-med/deploy/profile.json', 0o600);
  const profile = validateHostProfile(JSON.parse(bytes.toString('utf8')));
  if (canonical(profile) !== bytes.toString('utf8')) fail('PROFILE_CONTRACT_MISMATCH');
  for (const spec of PRODUCTION_PATHS.contractSpecs) {
    const actual = spec.key === 'nodeSha256' ? nodeSha256() : hash(read(spec.path, spec.mode));
    if (actual !== profile.contracts[spec.key]) fail('PROFILE_CONTRACT_MISMATCH');
  }
}

// --read-chrony already validates/unwraps the restricted socket reply. Its CLI
// result is TimeEvidence v2 itself, not the collector's identity/time envelope.
export function parseCanonicalTimeOutput(output, expectedBootId) {
  try {
    const time = validateCurrentTimeEvidence(JSON.parse(output));
    if (time.bootId !== expectedBootId) fail('CANONICAL_TIME_REQUIRED');
    return time;
  } catch {fail('CANONICAL_TIME_REQUIRED');}
}

function assertCanonicalTrustedTime() {
  try {
    trustedDirectory(LIB, 0o755);
    const profile = JSON.parse(read('/var/lib/servora-med/deploy/profile.json', 0o600).toString('utf8'));
    const module = LIB + '/trusted-time.mjs', before = read(module, 0o644);
    if (hash(before) !== profile.contracts.timeModuleSha256 || profile.contracts.timeConfigSha256 !== CHRONY_CONFIG_SHA256) fail('CANONICAL_TIME_REQUIRED');
    const output = execFileSync('/usr/bin/node', ['--no-addons', module, '--read-chrony'],
      {env: ENV, timeout: 15000, encoding: 'utf8', maxBuffer: 1024 * 1024});
    const time = parseCanonicalTimeOutput(output, bootId());
    if (!read(module, 0o644).equals(before)) fail('CANONICAL_TIME_REQUIRED');
    return time;
  } catch {fail('CANONICAL_TIME_REQUIRED');}
}

export function createTransitionRootPort(port) {
  return {...port,
    assertRoot() {if (process.platform !== 'linux' || process.getuid?.() !== 0 || process.getgid?.() !== 0) fail('ROOT_LINUX_REQUIRED');},
    bootId, readOptionalTool, assertPreparedClosure, assertFreshInstall, assertFreshRelease,
    assertExternalQuarantine: (e, context) => assertExternalQuarantine(port, e, context),
    list(path) {if (path !== ROOT) fail('PATH_INVALID'); trustedDirectory(ROOT, 0o700); return fs.readdirSync(ROOT);},
    reserveInstall, publishClosed, replaceTool,
    installReceipt: bytes => exclusiveFile(PRIVATE + '/install-receipt.json', bytes),
    assertProfileContracts, assertCanonicalTrustedTime,
    reserveRelease: bytes => exclusiveFile(PRIVATE + '/release-operation.json', bytes),
    publishReleaseEvidence: bytes => exclusiveFile(PRIVATE + '/release-evidence.json', bytes),
    publishReleased: bytes => exclusiveFile(ROOT + '/released.json', bytes),
    assertReleased: () => assertBootstrapManagementAllowed('forward'),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseTransitionArguments(process.argv.slice(2));
    const result = await withExistingHostLock(port => {
      const io = createTransitionRootPort(port);
      return (options.command === 'install' ? createBootstrapInstaller(io) : createBootstrapReleaser(io))(options);
    });
    process.stdout.write(canonical(result));
  } catch (error) {
    console.error(/^BOOTSTRAP_(?:TRANSITION|FENCE|SUDO_QUARANTINE)_[A-Z_]+$/.test(error.message)
      ? error.message : 'BOOTSTRAP_TRANSITION_UNCERTAIN');
    process.exitCode = 1;
  }
}
