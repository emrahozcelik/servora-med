// Real root ownership, sudo/visudo, stable flock and policy publication.
// Service metadata and historical bytes are synthetic; no systemd/reboot or
// Chrony acceptance is claimed. ONLY run in the dedicated disposable image.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {dirname} from 'node:path';
import {POLICY_FILES, QUARANTINED_POLICY} from './bootstrap-delegation-quarantine.mjs';
import {HISTORICAL_ARCHIVED_PATHS, historicalSourceMode} from '../scripts/historical-recovery-evidence.mjs';

const enabled = process.env.BOOTSTRAP_QUARANTINE_CONTAINER_TEST === '1'
  && process.platform === 'linux' && process.getuid?.() === 0 && fs.existsSync('/.dockerenv');
const BASE = '/usr/local/libexec/servora-med-bootstrap';
const ROOT = '/var/lib/servora-med-bootstrap-quarantine';
const STATE = '/var/lib/servora-med/deploy';
const TOOL = BASE + '/ops/recovery-tools/bootstrap-delegation-quarantine';
const hash = value => createHash('sha256').update(value).digest('hex');
const run = (file, args = []) => spawnSync(file, args,
  {encoding: 'utf8', timeout: 15000, env: {PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C'}});
const text = r => r.stdout + r.stderr;

test('real Linux sudo delegation closes durably while historical and runtime state remain unchanged', {skip: !enabled}, async t => {
  for (const path of ['/var/lib/servora-med', '/opt/servora-med', ROOT, BASE]) {
    assert.equal(fs.existsSync(path), false, 'refusing an existing host: ' + path);
  }
  const write = (path, bytes, mode = 0o600, directoryMode = 0o700) => {
    fs.mkdirSync(dirname(path), {recursive: true, mode: directoryMode});
    fs.writeFileSync(path, bytes); fs.chmodSync(path, mode);
  };
  assert.equal(run('/usr/sbin/useradd', ['--no-create-home', '--shell', '/usr/sbin/nologin', 'servora-deploy']).status, 0);
  if (!fs.existsSync('/usr/bin/node')) fs.copyFileSync(process.execPath, '/usr/bin/node');
  fs.chmodSync('/usr/bin/node', 0o755);
  write('/etc/machine-id', '1'.repeat(32) + '\n', 0o444);
  fs.mkdirSync(dirname(BASE), {recursive: true, mode: 0o755});
  fs.mkdirSync(BASE, {mode: 0o750}); fs.chmodSync(BASE, 0o750);
  for (const file of ['bootstrap-delegation-quarantine', 'bootstrap-delegation-quarantine.mjs',
    'bootstrap-delegation-quarantine-host.mjs']) {
    write(BASE + '/ops/recovery-tools/' + file, fs.readFileSync(new URL(file, import.meta.url)),
      file.endsWith('.mjs') ? 0o644 : 0o750, 0o750);
  }
  for (const file of ['bootstrap-fence.mjs', 'historical-recovery-evidence.mjs']) {
    write(BASE + '/ops/scripts/' + file, fs.readFileSync(new URL('../scripts/' + file, import.meta.url)), 0o644, 0o750);
  }
  write('/usr/local/libexec/servora-med/host-operation-lock.sh',
    fs.readFileSync(new URL('../scripts/host-operation-lock.sh', import.meta.url)), 0o644, 0o755);
  write('/usr/local/libexec/servora-med/deploy-production-host', '#!/bin/sh\nexit 0\n', 0o755);
  write(STATE + '/host.lock', '');
  write(STATE + '/profile.json', 'synthetic old profile\n');
  for (const directory of ['attempts', 'initializations', 'admission-proofs', 'backups', 'logs']) {
    fs.mkdirSync(STATE + '/' + directory, {mode: 0o700});
  }
  for (const relative of HISTORICAL_ARCHIVED_PATHS) write(STATE + '/' + relative,
    'synthetic historical evidence: ' + relative + '\n', parseInt(historicalSourceMode(relative), 8));
  const release = '/opt/servora-med/releases/' + 'a'.repeat(40);
  fs.mkdirSync(release, {recursive: true}); fs.symlinkSync(release, '/opt/servora-med/current');
  const runtime = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio: 'ignore'});
  t.after(() => runtime.kill('SIGKILL'));
  // Explicit synthetic service probe. Real systemd acceptance remains separate.
  write('/usr/bin/systemctl', '#!/bin/sh\nif [ "$1" = show ]; then\n'
    + 'printf "%s\\n" MainPID=' + runtime.pid + ' InvocationID=' + 'c'.repeat(32)
    + ' NRestarts=0 ActiveState=active SubState=running NeedDaemonReload=no\nfi\nexit 0\n', 0o755);
  const grants = [
    '/usr/bin/systemctl start servora-med.service, /usr/bin/systemctl stop servora-med.service, /usr/bin/systemctl restart servora-med.service',
    '/usr/bin/systemctl start caddy.service, /usr/bin/systemctl enable caddy.service',
    '/usr/bin/systemctl start servora-med-backup.service',
    '/usr/local/libexec/servora-med/deploy-production-host *',
  ];
  POLICY_FILES.forEach((path, i) => write(path, 'servora-deploy ALL=(root) NOPASSWD: ' + grants[i] + '\n', 0o440));
  assert.equal(run('/usr/sbin/visudo', ['-c']).status, 0);
  const before = new Map(POLICY_FILES.map(path => [path, fs.readFileSync(path)]));
  let authorizationHash;

  await t.test('the actual service and helper sudo grants are reachable in the synthetic old installation', () => {
    for (const command of [['/usr/bin/systemctl', 'restart', 'servora-med.service'],
      ['/usr/local/libexec/servora-med/deploy-production-host', '--phase', 'deploy']]) {
      const result = run('/usr/bin/sudo', ['-u', 'servora-deploy', '--', '/usr/bin/sudo', '-n', ...command]);
      assert.equal(result.status, 0, text(result));
    }
  });

  await t.test('capture is read-only and explicitly lacks owner authority', () => {
    const result = run(TOOL, ['--capture']);
    assert.equal(result.status, 0, text(result));
    const proposal = JSON.parse(result.stdout);
    assert.equal(proposal.authority, 'READ_ONLY_NOT_AUTHORIZATION');
    assert.equal(fs.existsSync(ROOT), false);
    const a = {formatVersion: 1, kind: 'BOOTSTRAP_SUDO_QUARANTINE_AUTHORIZATION',
      scope: 'CLOSE_SERVORA_DEPLOY_SUDO_ONLY', machineId: proposal.machineId, hostLock: proposal.hostLock,
      sudoListingSha256: proposal.sudoListingSha256, otherPolicySha256: proposal.otherPolicySha256,
      preservedState: proposal.preservedState, policies: proposal.policies};
    const bytes = JSON.stringify(a) + '\n';
    write(ROOT + '/authorization.json', bytes);
    authorizationHash = hash(bytes);
    for (const path of POLICY_FILES) assert.deepEqual(fs.readFileSync(path), before.get(path));
  });

  await t.test('a foreign authorization mode refuses before touching the policies', () => {
    fs.chmodSync(ROOT + '/authorization.json', 0o644);
    assert.notEqual(run(TOOL, ['--apply', '--expected-authorization', authorizationHash]).status, 0);
    fs.chmodSync(ROOT + '/authorization.json', 0o600);
    for (const path of POLICY_FILES) assert.deepEqual(fs.readFileSync(path), before.get(path));
    assert.deepEqual(fs.readdirSync(ROOT), ['authorization.json']);
  });

  await t.test('a symlinked policy or hard-linked authorization cannot reach publication', () => {
    const path = POLICY_FILES[0], saved = '/tmp/synthetic-sudo-policy-original';
    fs.renameSync(path, saved); fs.symlinkSync(saved, path);
    assert.notEqual(run(TOOL, ['--apply', '--expected-authorization', authorizationHash]).status, 0);
    fs.unlinkSync(path); fs.renameSync(saved, path);
    const linked = '/tmp/synthetic-authorization-link';
    fs.linkSync(ROOT + '/authorization.json', linked);
    assert.notEqual(run(TOOL, ['--apply', '--expected-authorization', authorizationHash]).status, 0);
    fs.unlinkSync(linked);
    assert.deepEqual(fs.readdirSync(ROOT), ['authorization.json']);
    for (const policy of POLICY_FILES) assert.deepEqual(fs.readFileSync(policy), before.get(policy));
  });

  await t.test('the real stable lock excludes a second process', async () => {
    const holder = spawn('/usr/bin/flock', ['--nonblock', STATE + '/host.lock', '/bin/sleep', '30'], {stdio: 'ignore', detached: true});
    let groupKilled = false;
    const killOwnedGroup = () => {
      if (groupKilled) return;
      try { process.kill(-holder.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      groupKilled = true;
    };
    t.after(killOwnedGroup);
    let observed = false;
    for (let index = 0; index < 100; index++) {
      if (run('/usr/bin/flock', ['--nonblock', STATE + '/host.lock', '/bin/true']).status !== 0) { observed = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(observed, true);
    const result = run(TOOL, ['--dry-run', '--expected-authorization', authorizationHash]);
    assert.notEqual(result.status, 0); assert.match(text(result), /HOST_DEPLOYMENT_LOCK_BUSY/);
    const exited = new Promise(resolve => holder.once('exit', resolve));
    killOwnedGroup(); await exited;
  });

  await t.test('dry-run creates no reservation and changes no grant', () => {
    const result = run(TOOL, ['--dry-run', '--expected-authorization', authorizationHash]);
    assert.equal(result.status, 0, text(result)); assert.equal(JSON.parse(result.stdout).status, 'DRY_RUN_OK');
    assert.deepEqual(fs.readdirSync(ROOT), ['authorization.json']);
  });

  await t.test('apply closes real sudo grants, retains originals and preserves the synthetic service', () => {
    const result = run(TOOL, ['--apply', '--expected-authorization', authorizationHash]);
    assert.equal(result.status, 0, text(result));
    assert.equal(JSON.parse(result.stdout).authority, 'SUDO_ONLY_NOT_BOOTSTRAP_INSTALL_OR_RELEASE');
    for (const path of POLICY_FILES) {
      assert.equal(fs.readFileSync(path, 'utf8'), QUARANTINED_POLICY);
      const s = fs.lstatSync(path);
      assert.equal(s.uid, 0); assert.equal(s.gid, 0); assert.equal(s.nlink, 1); assert.equal(s.mode & 0o7777, 0o440);
      assert.deepEqual(fs.readFileSync(ROOT + '/originals/' + path.split('/').at(-1)), before.get(path));
    }
    process.kill(runtime.pid, 0);
    assert.equal(fs.readlinkSync('/opt/servora-med/current'), release);
    assert.equal(fs.existsSync(STATE + '/bootstrap'), false);
    assert.equal(fs.existsSync(ROOT + '/receipt.json'), true);
  });

  await t.test('fresh processes stay denied and the tool refuses automatic retry', () => {
    for (const command of [['/usr/bin/systemctl', 'restart', 'servora-med.service'],
      ['/usr/local/libexec/servora-med/deploy-production-host', '--phase', 'deploy']]) {
      const result = run('/usr/bin/sudo', ['-u', 'servora-deploy', '--', '/usr/bin/sudo', '-n', ...command]);
      assert.notEqual(result.status, 0, text(result));
    }
    const again = run(TOOL, ['--apply', '--expected-authorization', authorizationHash]);
    assert.notEqual(again.status, 0); assert.match(text(again), /STATE_NOT_FRESH/);
  });
});
