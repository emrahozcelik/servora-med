// Fixed-path acceptance, ONLY inside a disposable Linux root container.
// It never contacts production, PostgreSQL or an external network.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import {spawn, spawnSync} from 'node:child_process';
import {dirname, join} from 'node:path';
import {REQUIRED_MANAGEMENT_FILES, readBootstrapTrustedFile} from '../scripts/bootstrap-fence.mjs';
import {fenceFixture, encode, hash, ROOT, LIB, ID} from './bootstrap-fence-fixture.mjs';

const enabled = process.env.BOOTSTRAP_FENCE_CONTAINER_TEST === '1'
  && process.platform === 'linux' && process.getuid?.() === 0 && fs.existsSync('/.dockerenv');
const source = new URL('../scripts/', import.meta.url);
const state = '/var/lib/servora-med/deploy';
const run = (file, args = [], env = {}) => spawnSync(file, args,
  {encoding: 'utf8', timeout: 10000, env: {PATH: '/usr/local/bin:/usr/bin:/bin', ...env}});
const text = result => result.stdout + result.stderr;
const denied = (result, pattern = /BOOTSTRAP_FENCE_/) => {
  assert.notEqual(result.status, 0, text(result)); assert.match(text(result), pattern);
};

test('real Linux ownership, fixed entrypoints, interrupted state and process death', {skip: !enabled}, async t => {
  for (const path of ['/var/lib/servora-med', LIB, '/opt/servora-med']) {
    assert.equal(fs.existsSync(path), false, 'refusing an existing host: ' + path);
  }
  const write = (path, bytes, mode = 0o600) => {
    fs.mkdirSync(dirname(path), {recursive: true, mode: 0o755});
    fs.writeFileSync(path, bytes, {mode}); fs.chmodSync(path, mode);
  };
  fs.mkdirSync(ROOT, {recursive: true, mode: 0o700}); fs.chmodSync(ROOT, 0o700);
  fs.mkdirSync(LIB, {recursive: true, mode: 0o755}); fs.chmodSync(LIB, 0o755);
  if (!fs.existsSync('/usr/bin/node')) fs.symlinkSync(process.execPath, '/usr/bin/node');
  if (!fs.existsSync('/etc/machine-id')) write('/etc/machine-id', '1'.repeat(32) + '\n', 0o444);
  for (const name of fs.readdirSync(source)) {
    if (!name.endsWith('.mjs')) continue;
    write(LIB + '/' + name, fs.readFileSync(new URL(name, source)), 0o644);
  }
  write(LIB + '/host-operation-lock.sh', fs.readFileSync(new URL('host-operation-lock.sh', source)), 0o644);
  write(LIB + '/bootstrap-fence', fs.readFileSync(new URL('bootstrap-fence.sh', source)), 0o755);
  write(LIB + '/deploy-production-host', fs.readFileSync(new URL('deploy-production-host.sh', source)), 0o755);
  for (const directory of ['/usr/local/libexec/servora-med-forward', '/usr/local/libexec/servora-med-emergency']) {
    fs.mkdirSync(directory, {mode: 0o755});
    for (const name of fs.readdirSync(source).filter(name => name.endsWith('.mjs'))) {
      write(directory + '/' + name, fs.readFileSync(new URL(name, source)), 0o644);
    }
  }
  write(state + '/host.lock', '');
  write(state + '/profile.json', 'synthetic immutable profile\n');
  fs.mkdirSync('/opt/servora-med/releases/' + 'a'.repeat(40), {recursive: true});
  fs.symlinkSync('/opt/servora-med/releases/' + 'a'.repeat(40), '/opt/servora-med/current');
  const historical = Array.from({length: 26}, (_, index) => state + '/historical/synthetic-' + index);
  historical.forEach(path => write(path, 'immutable ' + path));
  const snapshot = () => historical.map(path => {
    const s = fs.lstatSync(path, {bigint: true});
    return [path, hash(fs.readFileSync(path)), String(s.ino), String(s.mtimeNs), String(s.mode)];
  });
  const before = snapshot(), profile = fs.readFileSync(state + '/profile.json');
  const pointer = fs.readlinkSync('/opt/servora-med/current');
  const runtime = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'});
  t.after(() => runtime.kill('SIGKILL'));

  const f = fenceFixture(REQUIRED_MANAGEMENT_FILES);
  f.manifest.files = REQUIRED_MANAGEMENT_FILES.map(({path, mode}) => ({path, mode, sha256: hash(fs.readFileSync(path))}));
  f.fence.machineId = fs.readFileSync('/etc/machine-id', 'utf8').trim();
  const stableLock = fs.lstatSync(state + '/host.lock', {bigint: true});
  f.fence.hostLock = {device: String(stableLock.dev), inode: String(stableLock.ino)};
  f.fence.manifestSha256 = hash(encode(f.manifest));
  const fenceHash = hash(encode(f.fence)), manifestHash = hash(encode(f.manifest));
  Object.assign(f.verification, {fenceSha256: fenceHash, manifestSha256: manifestHash, profileSha256: hash(profile)});
  Object.assign(f.authorization, {fenceSha256: fenceHash, manifestSha256: manifestHash,
    profileSha256: hash(profile), verificationSha256: hash(encode(f.verification))});
  Object.assign(f.release, {fenceSha256: fenceHash, authorizationSha256: hash(encode(f.authorization)),
    verificationSha256: hash(encode(f.verification))});
  const release = () => {
    write(ROOT + '/verification.json', encode(f.verification));
    write(ROOT + '/release-authorization.json', encode(f.authorization));
    write(ROOT + '/released.json', encode(f.release));
  };
  const guard = (operation = 'deploy', id = ID) => run(LIB + '/bootstrap-fence', [operation, id]);

  await t.test('missing fence refuses before creating a lock or deployment state', () => {
    denied(guard(), /BOOTSTRAP_FENCE_UNREADABLE/);
    assert.deepEqual(fs.readdirSync(ROOT), []);
    assert.equal(fs.readFileSync(state + '/host.lock').length, 0);
  });
  await t.test('the one-entry deny-first candidate persists before tools understand CLOSED', () => {
    const helper = LIB + '/deploy-production-host', helperBytes = fs.readFileSync(helper);
    const temporary = LIB + '/.quarantine-synthetic';
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o755);
    try {
      fs.writeFileSync(fd, '#!/bin/sh\nprintf "%s\\n" BOOTSTRAP_MANAGEMENT_QUARANTINED >&2\nexit 1\n');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, helper);
    const directory = fs.openSync(LIB, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    assert.equal(fs.existsSync(ROOT + '/closed.json'), false);
    for (const phase of ['deploy', 'postdeploy', 'rollback', 'arbitrary-old-operation']) {
      denied(run(helper, ['--phase', phase]), /BOOTSTRAP_MANAGEMENT_QUARANTINED/);
    }
    // Only the disposable fixture writes records. Production has no issuer in
    // B1-01. Keep denial until CLOSED and the checked tool set can be read.
    write(ROOT + '/closed.json', encode(f.fence));
    write(ROOT + '/manifest.json', encode(f.manifest));
    write(helper, helperBytes, 0o755);
    denied(run(helper, ['--phase', 'deploy']), /BOOTSTRAP_FENCE_CLOSED/);
  });
  await t.test('all host helper phases stop while CLOSED', () => {
    for (const phase of ['deploy', 'postdeploy', 'rollback', 'attempt-preflight', 'forward-recovery', 'pre-migration-abort']) {
      denied(run(LIB + '/deploy-production-host', ['--phase', phase, '--attempt-id', ID]), /BOOTSTRAP_FENCE_CLOSED/);
    }
    denied(run('/usr/bin/node', [LIB + '/deployment-controller.mjs', 'admit', ID]), /BOOTSTRAP_FENCE_CLOSED/);
    for (const command of ['apply', 'smoke', 'observe', 'finish', 'recover']) {
      denied(run('/usr/bin/node', ['/usr/local/libexec/servora-med-forward/forward-host.mjs', command]), /BOOTSTRAP_FENCE_CLOSED/);
    }
    denied(run('/usr/bin/node', ['/usr/local/libexec/servora-med-emergency/emergency-handoff-host.mjs', 'apply']), /BOOTSTRAP_FENCE_CLOSED/);
    denied(run('/usr/bin/node', ['/usr/local/libexec/servora-med-emergency/issue-emergency-handoff.mjs', '--parent', ID]), /BOOTSTRAP_FENCE_CLOSED/);
  });

  await t.test('closed record metadata, links, parent substitution and unreadable records fail closed', () => {
    const closed = ROOT + '/closed.json', bytes = fs.readFileSync(closed);
    fs.chmodSync(closed, 0o644); denied(guard(), /FILE_UNTRUSTED/); fs.chmodSync(closed, 0o600);
    fs.chownSync(closed, 65534, 65534); denied(guard(), /FILE_UNTRUSTED/); fs.chownSync(closed, 0, 0);
    fs.linkSync(closed, ROOT + '/hardlink'); denied(guard(), /FILE_UNTRUSTED/); fs.unlinkSync(ROOT + '/hardlink');
    fs.unlinkSync(closed); fs.symlinkSync(ROOT + '/missing', closed);
    denied(guard(), /FILE_UNTRUSTED/); fs.unlinkSync(closed); write(closed, bytes);
    fs.chmodSync(ROOT, 0o755); denied(guard(), /PATH_UNTRUSTED/); fs.chmodSync(ROOT, 0o700);
    fs.renameSync(ROOT, ROOT + '-saved'); fs.symlinkSync(ROOT + '-saved', ROOT);
    denied(guard(), /PATH_UNTRUSTED/); fs.unlinkSync(ROOT); fs.renameSync(ROOT + '-saved', ROOT);
    write(closed, '{'); denied(guard(), /RECORD_INVALID/); write(closed, bytes);
  });

  await t.test('SIGKILL releases flock but cannot release the persistent fence', async () => {
    const ready = '/tmp/bootstrap-lock-ready';
    const holder = spawn('/bin/bash', ['-c', 'exec 9>>/var/lib/servora-med/deploy/host.lock; flock -n 9; : > /tmp/bootstrap-lock-ready; exec sleep 30'], {stdio: 'ignore'});
    t.after(() => holder.kill('SIGKILL'));
    for (let index = 0; index < 100 && !fs.existsSync(ready); index++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(fs.existsSync(ready), true);
    holder.kill('SIGKILL'); await new Promise(resolve => holder.once('exit', resolve));
    assert.equal(run('/usr/bin/flock', ['--nonblock', state + '/host.lock', '/bin/true']).status, 0);
    denied(guard(), /BOOTSTRAP_FENCE_CLOSED/);
  });

  await t.test('partial RELEASED publication survives process restart as a refusal without repair', () => {
    write(ROOT + '/released.json', '{"record":');
    const bytes = fs.readFileSync(ROOT + '/released.json');
    for (let restart = 0; restart < 3; restart++) denied(guard(), /RECORD_INVALID/);
    assert.deepEqual(fs.readFileSync(ROOT + '/released.json'), bytes);
    fs.unlinkSync(ROOT + '/released.json');
  });

  await t.test('RELEASED admits only the guard prerequisite; a UUID cannot substitute for root approval', () => {
    release();
    assert.equal(guard().status, 0, text(guard()));
    for (const phase of ['deploy', 'postdeploy', 'forward-recovery', 'pre-migration-abort', 'attempt-preflight']) {
      denied(run(LIB + '/deploy-production-host', ['--phase', phase]), /ATTEMPT_REQUIRED/);
    }
    denied(run(LIB + '/deploy-production-host', ['--phase', 'rollback', '--sha', 'a'.repeat(40)]), /LEGACY_MUTATION_DISABLED/);
    fs.mkdirSync(state + '/approvals', {mode: 0o700});
    denied(run('/usr/bin/node', [LIB + '/deployment-controller.mjs', 'admit', ID]), /ATTEMPT_APPROVAL_MISSING/);
    assert.equal(fs.existsSync(state + '/active.json'), false);
    assert.equal(fs.existsSync(state + '/initializations'), false);
  });

  await t.test('legacy entrypoints refuse after RELEASED even with a test database selector', () => {
    const deploy = new URL('deploy-release.sh', source).pathname;
    denied(run('/bin/bash', [deploy], {SHA: 'a'.repeat(40)}), /LEGACY_MUTATION_DISABLED/);
    const recovery = new URL('production-recovery.sh', source).pathname;
    denied(run('/bin/bash', [recovery, '--backup', '/tmp/servora-med-synthetic.dump', '--checksum', '/tmp/synthetic.sha256',
      '--target-db', 'servora_med', '--expected-host', '127.0.0.1', '--allow-destructive', '--old-release', 'a'.repeat(40),
      '--old-health-schema-version', '060_crm_duplicate_review_decisions'], {
      TEST_DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1/servora_med_test_fence', OPS_LOG: '/tmp/refusal.log',
    }), /LEGACY_MUTATION_DISABLED/);
  });

  await t.test('partial tool installation or manifest drift cannot start normal management', () => {
    const file = LIB + '/deployment-controller.mjs', bytes = fs.readFileSync(file);
    fs.appendFileSync(file, '\n// partial install\n'); denied(guard(), /TOOL_DRIFT/); write(file, bytes, 0o644);
    fs.renameSync(file, file + '.saved'); denied(guard(), /UNREADABLE/); fs.renameSync(file + '.saved', file);
    fs.chmodSync(file, 0o666); denied(guard(), /FILE_UNTRUSTED/); fs.chmodSync(file, 0o644);
  });

  await t.test('a missing or substituted stable lock is never silently created or reclaimed', () => {
    const lock = state + '/host.lock';
    fs.renameSync(lock, lock + '.saved');
    denied(run(LIB + '/deploy-production-host', ['--phase', 'attempt-preflight', '--attempt-id', ID]), /UNREADABLE/);
    assert.equal(fs.existsSync(lock), false);
    write(lock, ''); denied(guard(), /LOCK_UNTRUSTED/);
    fs.unlinkSync(lock); fs.renameSync(lock + '.saved', lock);
  });

  await t.test('shared 0755 traversal and service runtime are independent of the fence', () => {
    assert.equal(fs.statSync(LIB).mode & 0o777, 0o755);
    const accessible = run('/usr/bin/setpriv', ['--reuid=65534', '--regid=65534', '--clear-groups',
      '/usr/bin/node', '-e', 'require("node:fs").readFileSync("/usr/local/libexec/servora-med/trusted-time.mjs")']);
    assert.equal(accessible.status, 0, text(accessible));
    process.kill(runtime.pid, 0);
    assert.equal(fs.readlinkSync('/opt/servora-med/current'), pointer);
    assert.deepEqual(fs.readFileSync(state + '/profile.json'), profile);
    assert.deepEqual(snapshot(), before);
    assert.equal(readBootstrapTrustedFile(ROOT + '/closed.json', 0o600).length > 0, true);
  });
});
