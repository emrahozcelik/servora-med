// Fixed Linux root adapter. This tool is excluded from release artifacts and
// must be reviewed and provisioned separately; never delegate it through sudo.
import fs from 'node:fs';
import {createHash, randomUUID} from 'node:crypto';
import {execFileSync, spawnSync} from 'node:child_process';
import {basename, dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readBootstrapTrustedFile} from '../scripts/bootstrap-fence.mjs';
import {captureHistoricalSourceInventory} from '../scripts/historical-recovery-evidence.mjs';
import {createDelegationQuarantine, POLICY_FILES} from './bootstrap-delegation-quarantine.mjs';

const ROOT = '/var/lib/servora-med-bootstrap-quarantine';
const LOCK = '/var/lib/servora-med/deploy/host.lock';
const ENV = Object.freeze({PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C'});
const canonical = value => JSON.stringify(value) + '\n';
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw new Error('BOOTSTRAP_SUDO_QUARANTINE_' + code); };
const read = readBootstrapTrustedFile;
const same = (a, b) => ['dev', 'ino', 'size', 'uid', 'gid', 'mode', 'nlink', 'mtimeNs', 'ctimeNs']
  .every(key => a[key] === b[key]);
const run = (file, args) => execFileSync(file, args, {env: ENV, timeout: 10000, encoding: 'utf8'});

function flushDirectory(path) {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function exclusiveFile(file, bytes) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  flushDirectory(dirname(file));
}

function assertRoot() {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) fail('ROOT_LINUX_REQUIRED');
}

function assertLock() {
  if (read(LOCK, 0o600).length) fail('LOCK_UNTRUSTED');
  const named = fs.lstatSync(LOCK, {bigint: true}), held = fs.fstatSync(9, {bigint: true});
  if (!same(named, held)) fail('LOCK_UNTRUSTED');
  execFileSync('/usr/bin/flock', ['--nonblock', '9'], {env: ENV, timeout: 2000,
    stdio: ['ignore', 'pipe', 'pipe', ...Array(6).fill('ignore'), 9]});
  if (!same(named, fs.lstatSync(LOCK, {bigint: true}))) fail('LOCK_UNTRUSTED');
  return {device: String(named.dev), inode: String(named.ino)};
}

function machineId() {
  const mode = Number(fs.lstatSync('/etc/machine-id', {bigint: true}).mode & 0o7777n);
  if (![0o444, 0o644].includes(mode)) fail('MACHINE_ID_UNTRUSTED');
  const id = read('/etc/machine-id', mode).toString('utf8').trim();
  if (!/^[a-f0-9]{32}$/.test(id)) fail('MACHINE_ID_UNTRUSTED');
  return id;
}

function sudoListing() {
  return spawnSync('/usr/bin/sudo', ['-n', '-l', '-U', 'servora-deploy'],
    {env: ENV, timeout: 10000, encoding: 'utf8', maxBuffer: 1024 * 1024});
}

function sudoListingHash() {
  const result = sudoListing();
  if (result.error || result.status !== 0) fail('SUDO_LISTING_UNAVAILABLE');
  return hash(result.stdout);
}

function otherPolicyHash() {
  const entries = [];
  for (const file of ['/etc/sudoers', '/etc/passwd', '/etc/group',
    ...fs.readdirSync('/etc/sudoers.d').sort().map(name => '/etc/sudoers.d/' + name)]) {
    if (POLICY_FILES.includes(file)) continue;
    const stat = fs.lstatSync(file, {bigint: true}), mode = Number(stat.mode & 0o7777n);
    if (file.startsWith('/etc/sudoers.d/.bootstrap-quarantine-')) fail('PUBLICATION_RESIDUE');
    entries.push({path: file, mode, sha256: hash(read(file, mode))});
  }
  return hash(canonical(entries));
}

function snapshot() {
  const current = fs.lstatSync('/opt/servora-med/current');
  const link = fs.readlinkSync('/opt/servora-med/current');
  if (!current.isSymbolicLink() || current.uid !== 0
    || !/^\/opt\/servora-med\/releases\/[a-f0-9]{40}$/.test(link)) fail('CURRENT_UNTRUSTED');
  const service = run('/usr/bin/systemctl', ['show', 'servora-med.service',
    '--property=MainPID,InvocationID,NRestarts,ActiveState,SubState,NeedDaemonReload']);
  for (const pattern of [/^MainPID=[1-9][0-9]*$/m, /^InvocationID=[a-f0-9]{32}$/m,
    /^NRestarts=[0-9]+$/m, /^ActiveState=active$/m, /^SubState=running$/m, /^NeedDaemonReload=no$/m]) {
    if (!pattern.test(service)) fail('SERVICE_UNTRUSTED');
  }
  return {currentRelease: basename(link), profileSha256: hash(read('/var/lib/servora-med/deploy/profile.json', 0o600)),
    serviceIdentity: hash(service), historicalInventorySha256: hash(canonical(captureHistoricalSourceInventory()))};
}

function assertFresh() {
  const stat = fs.lstatSync(ROOT);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== 0
    || (stat.mode & 0o7777) !== 0o700 || canonical(fs.readdirSync(ROOT).sort()) !== canonical(['authorization.json'])) fail('STATE_NOT_FRESH');
}

function replacePolicy(file, bytes, original) {
  if (!POLICY_FILES.includes(file)) fail('POLICY_PATH_INVALID');
  const old = fs.lstatSync(file, {bigint: true});
  if (!read(file, 0o440).equals(original)) fail('POLICY_DRIFT');
  const temporary = '/etc/sudoers.d/.bootstrap-quarantine-' + randomUUID() + '.tmp';
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o440);
  try { fs.fchmodSync(fd, 0o440); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  // No cleanup/repair on failure: preserve the candidate and operation record.
  run('/usr/sbin/visudo', ['-c', '-f', temporary]);
  if (!same(old, fs.lstatSync(file, {bigint: true})) || !read(file, 0o440).equals(original)) fail('POLICY_DRIFT');
  fs.renameSync(temporary, file);
  flushDirectory('/etc/sudoers.d');
  if (!read(file, 0o440).equals(bytes)) fail('PUBLISHED_POLICY_MISMATCH');
}

function reserve(originals, authorizationSha256) {
  exclusiveFile(ROOT + '/operation.json', Buffer.from(canonical({formatVersion: 1,
    kind: 'BOOTSTRAP_SUDO_QUARANTINE_RESERVED', authorizationSha256})));
  fs.mkdirSync(ROOT + '/originals', {mode: 0o700}); flushDirectory(ROOT);
  for (const original of originals) exclusiveFile(ROOT + '/originals/' + basename(original.path), original.bytes);
}

function assertSudoClosed() {
  run('/usr/sbin/visudo', ['-c']);
  const result = sudoListing();
  if (result.error || result.status !== 1
    || !/servora-deploy is not allowed to run sudo/.test(result.stdout + result.stderr)) fail('DELEGATION_REMAINS_OPEN');
}

export function createRootPort() {
  return {assertRoot, assertLock, readTrusted: read, machineId, otherPolicyHash, snapshot,
    sudoListingHash, assertFresh, replacePolicy, reserve, assertSudoClosed,
    receipt: bytes => exclusiveFile(ROOT + '/receipt.json', bytes)};
}

export function parseArguments(argv) {
  if (argv.length === 1 && argv[0] === '--capture') return {mode: 'capture'};
  if (argv.length === 3 && ['--dry-run', '--apply'].includes(argv[0])
    && argv[1] === '--expected-authorization' && /^[a-f0-9]{64}$/.test(argv[2])) {
    return {mode: argv[0].slice(2), expectedAuthorization: argv[2]};
  }
  fail('ARGUMENTS_INVALID');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArguments(process.argv.slice(2)), io = createRootPort();
    io.assertRoot();
    if (options.mode === 'capture') {
      // A capture is explicitly NOT an authorization. Independent owner review
      // and a separate root-owned record are required before any write.
      const proposal = {formatVersion: 1, kind: 'BOOTSTRAP_SUDO_QUARANTINE_PROPOSAL',
        authority: 'READ_ONLY_NOT_AUTHORIZATION', machineId: io.machineId(), hostLock: io.assertLock(),
        sudoListingSha256: io.sudoListingHash(), otherPolicySha256: io.otherPolicyHash(),
        preservedState: io.snapshot(), policies: POLICY_FILES.map(path => ({path, sha256: hash(read(path, 0o440))}))};
      process.stdout.write(canonical(proposal));
    } else {
      process.stdout.write(canonical(createDelegationQuarantine(io)(options)));
    }
  } catch (error) {
    console.error(/^BOOTSTRAP_SUDO_QUARANTINE_[A-Z_]+$/.test(error.message) ? error.message : 'BOOTSTRAP_SUDO_QUARANTINE_UNCERTAIN');
    process.exitCode = 1;
  }
}
