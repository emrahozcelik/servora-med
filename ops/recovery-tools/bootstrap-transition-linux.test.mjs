// Disposable Linux acceptance. sudo/visudo, modes, flock, publications and
// SIGKILL are real. Service/route/history data are synthetic; no real reboot,
// systemd or Chrony acceptance is claimed. Never run against an installed host.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {dirname, basename} from 'node:path';
import {encodeBootstrapEnvelope as encode} from './bootstrap-transition.mjs';
import {BOOTSTRAP_TRANSITION_SOURCE_FILES} from './bootstrap-transition-host.mjs';
import {POLICY_FILES} from './bootstrap-delegation-quarantine.mjs';
import {HISTORICAL_ARCHIVED_PATHS, historicalSourceMode} from '../scripts/historical-recovery-evidence.mjs';
import {PRODUCTION_PATHS} from './profile-reseal.mjs';

const enabled = process.env.BOOTSTRAP_TRANSITION_CONTAINER_TEST === '1'
  && process.platform === 'linux' && process.getuid?.() === 0 && fs.existsSync('/.dockerenv');
const scenario = process.env.BOOTSTRAP_TRANSITION_SCENARIO ?? 'install';
const BASE = '/usr/local/libexec/servora-med-bootstrap';
const PRIVATE = '/var/lib/servora-med-bootstrap-transition';
const STATE = '/var/lib/servora-med/deploy';
const ROOT = STATE + '/bootstrap';
const LIB = '/usr/local/libexec/servora-med';
const Q = '/var/lib/servora-med-bootstrap-quarantine';
const TOOL = BASE + '/ops/recovery-tools/bootstrap-transition';
const QUARANTINE = BASE + '/ops/recovery-tools/bootstrap-delegation-quarantine';
const ID = '11111111-1111-4111-8111-111111111111';
const SOURCE = '8'.repeat(40); // Synthetic source identity, not production proof.
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceBytes = path => fs.readFileSync(new URL('../../' + path, import.meta.url));
const run = (file, args = []) => spawnSync(file, args, {encoding: 'utf8', timeout: 30000,
  env: {PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C'}});
const output = r => r.stdout + r.stderr;
const success = r => {assert.equal(r.status, 0, output(r)); return r.stdout;};
const write = (path, bytes, mode = 0o600, directoryMode = 0o700) => {
  fs.mkdirSync(dirname(path), {recursive: true, mode: directoryMode});
  fs.writeFileSync(path, bytes); fs.chmodSync(path, mode);
};

function fixture(t) {
  for (const path of ['/var/lib/servora-med', '/opt/servora-med', PRIVATE, Q, BASE]) {
    assert.equal(fs.existsSync(path), false, 'refusing existing host state: ' + path);
  }
  success(run('/usr/sbin/useradd', ['--no-create-home', '--shell', '/usr/sbin/nologin', 'servora-deploy']));
  success(run('/usr/sbin/useradd', ['--system', '--no-create-home', '--shell', '/usr/sbin/nologin', '_chrony']));
  if (!fs.existsSync('/usr/bin/node')) fs.copyFileSync(process.execPath, '/usr/bin/node');
  fs.chmodSync('/usr/bin/node', 0o755);
  write('/etc/machine-id', '1'.repeat(32) + '\n', 0o444);
  fs.mkdirSync(dirname(BASE), {recursive: true, mode: 0o755});
  fs.mkdirSync(BASE, {mode: 0o750}); fs.chmodSync(BASE, 0o750);
  const wrapper = sourceBytes('ops/recovery-tools/bootstrap-transition').toString('utf8');
  const pins = [...wrapper.matchAll(/^pin "\$BASE\/([^"]+)" [a-f0-9]{64}$/gm)].map(m => m[1]);
  assert.ok(pins.length >= 15);
  for (const path of pins) write(BASE + '/' + path, sourceBytes(path), 0o644, 0o750);
  for (const name of ['bootstrap-transition', 'bootstrap-delegation-quarantine']) {
    write(BASE + '/ops/recovery-tools/' + name, sourceBytes('ops/recovery-tools/' + name), 0o750, 0o750);
  }
  fs.mkdirSync(LIB, {mode: 0o755}); fs.chmodSync(LIB, 0o755);
  for (const item of BOOTSTRAP_TRANSITION_SOURCE_FILES) {
    if (basename(item.path).startsWith('bootstrap-fence')) continue; // Old tools do not know the fence.
    let bytes = sourceBytes(item.source);
    if (item.path.endsWith('/deploy-production-host')) bytes = Buffer.from('#!/bin/sh\nexit 0\n');
    if (item.path.endsWith('/deployment-controller.mjs')) bytes = Buffer.concat([bytes, Buffer.from('\n// synthetic old tool\n')]);
    write(item.path, bytes, item.mode, 0o755);
  }
  write(STATE + '/host.lock', ''); write(STATE + '/profile.json', 'synthetic old profile\n');
  for (const name of ['attempts', 'initializations', 'admission-proofs', 'backups', 'logs']) fs.mkdirSync(STATE + '/' + name, {mode: 0o700});
  for (const path of HISTORICAL_ARCHIVED_PATHS) write(STATE + '/' + path,
    'synthetic historical source: ' + path + '\n', parseInt(historicalSourceMode(path), 8));
  const release = '/opt/servora-med/releases/' + 'a'.repeat(40);
  fs.mkdirSync(release, {recursive: true}); fs.symlinkSync(release, '/opt/servora-med/current');
  const runtime = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio: 'ignore'});
  t.after(() => runtime.kill('SIGKILL'));
  const targetGuardSha = hash(sourceBytes('ops/scripts/bootstrap-fence.sh'));
  write('/usr/bin/systemctl', '#!/bin/sh\n'
    + 'if [ -f /tmp/synthetic-bootstrap-pause-enabled ] && [ -f ' + LIB + '/bootstrap-fence ]\n'
    + 'then\n if [ "$(sha256sum ' + LIB + '/bootstrap-fence | cut -d " " -f 1)" = ' + targetGuardSha + ' ]; then\n'
    + ' : > /tmp/synthetic-bootstrap-pause-ready\n exec /bin/sleep 30\n fi\nfi\n'
    + 'if [ "$1" = show ]; then printf "%s\\n" MainPID=' + runtime.pid + ' InvocationID=' + 'c'.repeat(32)
    + ' NRestarts=0 ActiveState=active SubState=running NeedDaemonReload=no; fi\nexit 0\n', 0o755);
  const grants = ['/usr/bin/systemctl start servora-med.service, /usr/bin/systemctl stop servora-med.service',
    '/usr/bin/systemctl start caddy.service', '/usr/bin/systemctl start servora-med-backup.service',
    LIB + '/deploy-production-host *'];
  POLICY_FILES.forEach((path, i) => write(path, 'servora-deploy ALL=(root) NOPASSWD: ' + grants[i] + '\n', 0o440));
  success(run('/usr/sbin/visudo', ['-c']));
  success(run('/usr/bin/sudo', ['-u', 'servora-deploy', '--', '/usr/bin/sudo', '-n', LIB + '/deploy-production-host', '--help']));
  const q = JSON.parse(success(run(QUARANTINE, ['--capture'])));
  const qa = {formatVersion: 1, kind: 'BOOTSTRAP_SUDO_QUARANTINE_AUTHORIZATION', scope: 'CLOSE_SERVORA_DEPLOY_SUDO_ONLY',
    machineId: q.machineId, hostLock: q.hostLock, sudoListingSha256: q.sudoListingSha256,
    otherPolicySha256: q.otherPolicySha256, preservedState: q.preservedState, policies: q.policies};
  const qaBytes = Buffer.from(JSON.stringify(qa) + '\n'); write(Q + '/authorization.json', qaBytes);
  success(run(QUARANTINE, ['--apply', '--expected-authorization', hash(qaBytes)]));
  fs.mkdirSync(PRIVATE, {mode: 0o700}); fs.mkdirSync(PRIVATE + '/prepared', {mode: 0o700});
  const manifest = {formatVersion: 1, kind: 'BOOTSTRAP_MANAGEMENT_MANIFEST', files:
    BOOTSTRAP_TRANSITION_SOURCE_FILES.map(t => {
      const bytes = sourceBytes(t.source), sha256 = hash(bytes);
      write(PRIVATE + '/prepared/' + sha256, bytes);
      return {path: t.path, mode: t.mode, sha256};
    }).sort((a, b) => a.path < b.path ? -1 : 1)};
  const manifestBytes = encode(manifest); write(PRIVATE + '/manifest.json', manifestBytes);
  const identity = {formatVersion: 1, machineId: q.machineId,
    bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()};
  function operatorReview(phase) {
    const directory = PRIVATE + '/' + phase + '-review';
    const store = (name, record) => {const bytes = encode(record); write(directory + '/' + name + '.json', bytes); return hash(bytes);};
    const categories = ['autonomous-management', 'other-identities', 'polkit', 'ssh', 'sudo'];
    const entries = categories.map(category => {
      const bytes = encode({...identity, kind: 'BOOTSTRAP_ROUTE_EVIDENCE', category,
        observations: ['Dedicated synthetic container; no production inventory.']});
      write(directory + '/route-evidence/' + category + '.json', bytes);
      return {category, evidenceSha256: hash(bytes)};
    });
    const inventorySha256 = store('management-inventory', {...identity,
      kind: 'BOOTSTRAP_MANAGEMENT_ENTRYPOINT_INVENTORY', categories: entries});
    const managementReviewSha256 = store('management-review', {...identity, kind: 'BOOTSTRAP_MANAGEMENT_ROUTE_REVIEW',
      sourceSha: SOURCE, manifestSha256: hash(manifestBytes), scope: 'ALL_NON_ROOT_ROUTES_CLOSED', inventorySha256});
    const rootAccessProofSha256 = store('root-access-proof', {...identity, kind: 'BOOTSTRAP_INDEPENDENT_ROOT_ACCESS_PROOF',
      uid: 0, user: 'root', channel: 'CONSOLE', independentOf: 'servora-deploy-sudo'});
    const processesSha = store('management-process-inventory', {...identity,
      kind: 'BOOTSTRAP_MANAGEMENT_PROCESS_INVENTORY', scope: 'MANAGEMENT_MUTATION_PROCESSES', processes: []});
    const processDrainProofSha256 = store('process-drain-proof', {...identity,
      kind: 'BOOTSTRAP_PRIVILEGED_MUTATION_DRAIN_PROOF', scope: 'NO_INFLIGHT_OR_AUTONOMOUS_MANAGEMENT', inventorySha256: processesSha});
    const external = {...identity, kind: 'BOOTSTRAP_EXTERNAL_QUARANTINE_AUTHORIZATION',
      scope: 'ALL_NON_ROOT_MANAGEMENT_CLOSED_AND_PRIVILEGED_MUTATIONS_DRAINED', fenceId: ID, hostLock: q.hostLock,
      sudoReceiptSha256: hash(fs.readFileSync(Q + '/receipt.json')), managementReviewSha256, rootAccessProofSha256, processDrainProofSha256};
    const bytes = encode(external);
    write(PRIVATE + '/' + (phase === 'install' ? 'external-quarantine-authorization.json' : 'release-external-authorization.json'), bytes);
    return bytes;
  }
  operatorReview('install');
  const proposal = JSON.parse(success(run(TOOL, ['install', '--capture', '--source-sha', SOURCE, '--fence-id', ID])));
  assert.equal(proposal.authority, 'READ_ONLY_NOT_AUTHORIZATION');
  assert.equal(fs.existsSync(ROOT), false);
  const authorizationBytes = encode({...proposal.record, kind: 'BOOTSTRAP_INSTALL_AUTHORIZATION'});
  write(PRIVATE + '/install-authorization.json', authorizationBytes);
  const options = ['install', '--apply', '--expected-authorization', hash(authorizationBytes)];
  const protectedBefore = new Map([STATE + '/profile.json', ...HISTORICAL_ARCHIVED_PATHS.map(p => STATE + '/' + p)]
    .map(path => [path, {bytes: fs.readFileSync(path), mtimeNs: fs.lstatSync(path, {bigint: true}).mtimeNs}]));
  const assertPreserved = () => {
    for (const [path, old] of protectedBefore) {
      assert.deepEqual(fs.readFileSync(path), old.bytes); assert.equal(fs.lstatSync(path, {bigint: true}).mtimeNs, old.mtimeNs);
    }
    assert.equal(fs.readlinkSync('/opt/servora-med/current'), release); process.kill(runtime.pid, 0);
    assert.equal(fs.lstatSync(LIB).mode & 0o7777, 0o755);
  };
  return {options, manifest, authorizationBytes, assertPreserved, operatorReview, runtime};
}

test('real Linux bootstrap transition: ' + scenario, {skip: !enabled, timeout: 120000}, async t => {
  assert.ok(['install', 'crash', 'release'].includes(scenario));
  const f = fixture(t);
  if (scenario === 'crash') {
    write('/tmp/synthetic-bootstrap-pause-enabled', 'fixture-only pause');
    let diagnostic = '';
    const child = spawn(TOOL, f.options, {detached: true, stdio: ['ignore', 'pipe', 'pipe']});
    child.stdout.on('data', b => {diagnostic += b;}); child.stderr.on('data', b => {diagnostic += b;});
    let killed = false;
    const killOwned = () => {if (!killed) {try {process.kill(-child.pid, 'SIGKILL');} catch (e) {if (e.code !== 'ESRCH') throw e;} killed = true;}};
    t.after(killOwned);
    let ready = false;
    for (let i = 0; i < 1000; i++) {
      if (fs.existsSync('/tmp/synthetic-bootstrap-pause-ready')) {ready = true; break;}
      if (child.exitCode !== null) break;
      await new Promise(r => setTimeout(r, 10));
    }
    assert.equal(ready, true, diagnostic);
    assert.equal(hash(fs.readFileSync(f.manifest.files[0].path)), f.manifest.files[0].sha256);
    assert.equal(fs.existsSync(ROOT + '/closed.json'), true);
    const contender = run('/usr/bin/flock', ['--nonblock', STATE + '/host.lock', '/usr/bin/true']);
    assert.equal(contender.status, 1, 'another process must not acquire the installer lock');
    const exited = new Promise(resolve => child.once('exit', resolve)); killOwned(); await exited;
    const retry = run(TOOL, f.options);
    assert.notEqual(retry.status, 0); assert.match(output(retry), /STATE_NOT_FRESH/);
    assert.equal(fs.existsSync(PRIVATE + '/install-receipt.json'), false);
    assert.equal(fs.existsSync(ROOT + '/released.json'), false);
    const guard = run('/usr/bin/node', [BASE + '/ops/scripts/bootstrap-fence.mjs', 'forward']);
    assert.notEqual(guard.status, 0); assert.match(output(guard), /BOOTSTRAP_FENCE_CLOSED/);
    f.assertPreserved();
    return;
  }
  const dry = run(TOOL, ['install', '--dry-run', '--expected-authorization', hash(f.authorizationBytes)]);
  success(dry); assert.equal(fs.existsSync(ROOT), false);
  await t.test('foreign modes and symlinked prepared bytes refuse before a reservation', () => {
    const auth = PRIVATE + '/install-authorization.json';
    fs.chmodSync(auth, 0o644);
    assert.notEqual(run(TOOL, f.options).status, 0); fs.chmodSync(auth, 0o600);
    const prepared = PRIVATE + '/prepared/' + f.manifest.files[0].sha256, saved = '/tmp/synthetic-bootstrap-prepared-saved';
    fs.renameSync(prepared, saved); fs.symlinkSync(saved, prepared);
    assert.notEqual(run(TOOL, f.options).status, 0);
    fs.unlinkSync(prepared); fs.renameSync(saved, prepared);
    assert.equal(fs.existsSync(PRIVATE + '/install-operation.json'), false);
    assert.equal(fs.existsSync(ROOT), false);
  });
  const installed = JSON.parse(success(run(TOOL, f.options)));
  assert.equal(installed.status, 'INSTALLED_CLOSED');
  for (const item of f.manifest.files) {
    assert.equal(hash(fs.readFileSync(item.path)), item.sha256);
    const s = fs.lstatSync(item.path); assert.equal(s.uid, 0); assert.equal(s.gid, 0); assert.equal(s.nlink, 1);
    assert.equal(s.mode & 0o7777, item.mode);
  }
  for (const name of ['closed.json', 'manifest.json']) {
    const s = fs.lstatSync(ROOT + '/' + name); assert.equal(s.uid, 0); assert.equal(s.gid, 0);
    assert.equal(s.mode & 0o7777, 0o600); assert.equal(s.nlink, 1);
  }
  assert.equal(fs.lstatSync(ROOT).mode & 0o7777, 0o700);
  const guard = run(LIB + '/bootstrap-fence', ['forward']);
  assert.notEqual(guard.status, 0); assert.match(output(guard), /BOOTSTRAP_FENCE_CLOSED/);
  for (const phase of ['deploy', 'postdeploy', 'rollback', 'attempt-preflight']) {
    const result = run(LIB + '/deploy-production-host', ['--phase', phase, '--attempt-id', ID]);
    assert.notEqual(result.status, 0); assert.match(output(result), /BOOTSTRAP_FENCE_CLOSED/);
  }
  const delegated = run('/usr/bin/sudo', ['-u', 'servora-deploy', '--', '/usr/bin/sudo', '-n', LIB + '/deploy-production-host', '--help']);
  assert.notEqual(delegated.status, 0);
  success(run('/usr/bin/sudo', ['-u', '_chrony', '--', '/usr/bin/test', '-r', LIB + '/trusted-time.mjs']));
  assert.equal(fs.existsSync(ROOT + '/released.json'), false); f.assertPreserved();
  const retry = run(TOOL, f.options); assert.notEqual(retry.status, 0); assert.match(output(retry), /STATE_NOT_FRESH/);
  if (scenario === 'release') {
    // Test-only stand-in for the separately authorized profile re-seal. No DB,
    // staging or real re-seal command is invoked, and no production data is used.
    write('/etc/systemd/system/servora-med.service', sourceBytes('ops/systemd/servora-med.service'), 0o644);
    write('/etc/chrony/chrony.conf', sourceBytes('ops/chrony/servora-med.conf.example'), 0o644);
    const contracts = Object.fromEntries(PRODUCTION_PATHS.contractSpecs.map(s => [s.key, hash(fs.readFileSync(s.path))]));
    const profile = {formatVersion: 2, machineId: '1'.repeat(32), fqdn: 'synthetic.example',
      databaseIdentity: {clusterId: '1', databaseName: 'servora_med', databaseOid: '1', role: 'servora', host: '127.0.0.1', port: 5432},
      envBaselineSha256: '0'.repeat(64), contracts};
    write(STATE + '/profile.json', JSON.stringify(profile) + '\n');
    f.operatorReview('release');
    const capture = run(TOOL, ['release', '--capture']);
    assert.notEqual(capture.status, 0); assert.match(output(capture), /CANONICAL_TIME_REQUIRED/);
    assert.equal(fs.existsSync(ROOT + '/verification.json'), false);
    assert.equal(fs.existsSync(ROOT + '/release-authorization.json'), false);
    assert.equal(fs.existsSync(ROOT + '/released.json'), false);
    assert.equal(fs.existsSync(PRIVATE + '/release-operation.json'), false);
  }
});
