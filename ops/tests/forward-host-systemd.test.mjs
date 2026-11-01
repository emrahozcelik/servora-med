// Run only named targeted cases. No real observation or full acceptance.
import test, {before, beforeEach, after} from 'node:test';
import assert from 'node:assert/strict';
import {setup, reset, restore, host, assertImmutable, ctl, waitHealth, TARGET, fault, write, smokeReceipt, readOnlySnapshot} from './forward-host-systemd-fixture.mjs';
import {spawn, spawnSync, execFileSync} from 'node:child_process';
import {PATHS} from '../scripts/forward-host.mjs';
import {readFileSync, readdirSync, existsSync, realpathSync, unlinkSync, renameSync} from 'node:fs';
import {canonical} from '../scripts/forward-host-storage.mjs';
import {digest} from '../scripts/forward-host-evidence.mjs';
import {createInterface} from 'node:readline';
let saved, authorization;
before(() => { saved = setup(); });
beforeEach(() => { authorization = reset(saved); });
after(() => { if (saved) restore(saved); });
test('FHOST-01 read-only preflight proves real DB 060, OLD and sealed emergency receipt', () => {
  const before = readOnlySnapshot();
  const result = host('preflight');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).phase, 'READY');
  assert.deepEqual(readOnlySnapshot(), before);
  assertImmutable(saved);
});
for (const [number, phase] of [['03', 'STOP_INTENT'], ['04', 'OLD_STOPPED'], ['05', 'ACTIVATE_INTENT']]) {
  test('FHOST-' + number + ' crash after ' + phase + ' resumes one activation', () => {
    const result = fault('phase-' + phase);
    assert.equal(result.signal, 'SIGKILL', result.stderr);
    const attempt = PATHS.root + '/' + authorization.attemptId;
    assert.equal(realpathSync(PATHS.current), saved.oldRoot);
    assert.equal(readdirSync(attempt).filter(n => /^start-\d+\.json$/.test(n)).length, 0);
    const resumed = host('apply');
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(JSON.parse(resumed.stdout).starts, 1);
    assert.equal(JSON.parse(resumed.stdout).phase, 'HEALTH_PASSED'); assertImmutable(saved);
  });
}
test('FHOST-06 START_INTENT crash has unknown outcome and cannot reset its budget', () => {
  authorization.budgets.maxStarts = 1;
  write(PATHS.root + '/authorization.json', canonical(authorization));
  const result = fault('event-START_INTENT'); assert.equal(result.signal, 'SIGKILL', result.stderr);
  const resumed = host('apply'); assert.equal(resumed.status, 1);
  assert.equal(ctl('show', 'servora-med.service', '-p', 'MainPID', '--value'), '0');
  const attempt = PATHS.root + '/' + authorization.attemptId;
  const records = readdirSync(attempt + '/journal').filter(n => /^\d{4}\.json$/.test(n)).map(n => JSON.parse(readFileSync(attempt + '/journal/' + n)));
  assert.equal(records.filter(r => r.event === 'START_INTENT').length, 1); assertImmutable(saved);
});
test('FHOST-17 collector handoff selects the manifested module and preserves the sealed legacy file', () => {
  const crashed = fault('event-COLLECTOR_DONE'); assert.equal(crashed.signal, 'SIGKILL', crashed.stderr);
  assert.equal(ctl('show', 'servora-med.service', '-p', 'MainPID', '--value'), '0');
  const unit = 'servora-med-time-evidence@forward-probe.service';
  assert.match(ctl('show', unit, '-p', 'ExecStart', '--value'), /servora-med-forward\/trusted-time\.mjs --collect-chrony/);
  assert.equal(ctl('show', unit, '-p', 'User', '--value'), '_chrony');
  assert.equal(ctl('show', unit, '-p', 'CapabilityBoundingSet', '--value'), '');
  const profile = JSON.parse(readFileSync(PATHS.state + '/profile.json'));
  assert.equal(digest(readFileSync(PATHS.installed + '/trusted-time.mjs')), profile.contracts.timeModuleSha256);
  assert.equal(digest(readFileSync(PATHS.tool + '/trusted-time.mjs')), digest(readFileSync('/opt/servora-med/releases/' + TARGET + '/ops/scripts/trusted-time.mjs')));
  const script = `import fs from 'node:fs'; import {dirname} from 'node:path'; import {validateTimeModuleContract} from '${PATHS.tool}/trusted-time.mjs';
const path='${PATHS.tool}/trusted-time.mjs'; const d=s=>({kind:s.isFile()?'file':s.isDirectory()?'directory':'other',uid:s.uid,gid:s.gid,nlink:s.nlink,mode:s.mode&0o7777}); const parents=[]; for(let p=dirname(path);p!=='/';p=dirname(p))parents.push(d(fs.lstatSync(p))); console.log(validateTimeModuleContract(path,d(fs.lstatSync(path)),parents,-1));`;
  assert.equal(execFileSync('/usr/bin/sudo', ['-u', '_chrony', '/usr/bin/node', '--input-type=module', '-e', script], {encoding: 'utf8'}).trim(), 'installed');
  const direct = spawnSync('/usr/bin/sudo', ['-u', 'servora-med', '/usr/bin/node', '--input-type=module', '-e', "import fs from 'node:fs'; fs.accessSync('/run/chrony/chronyd.sock',fs.constants.R_OK|fs.constants.W_OK);"], {encoding: 'utf8'});
  assert.notEqual(direct.status, 0, 'app UID must not gain direct Chrony access');
  const resumed = host('apply'); assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).starts, 1); assertImmutable(saved);
});
test('FHOST-18 collector publication crash is read-only inspectable and resumes exact reload', () => {
  const crashed = fault('collector-before-reload'); assert.equal(crashed.signal, 'SIGKILL', crashed.stderr);
  const unit = 'servora-med-time-evidence@forward-probe.service';
  const reload = ctl('show', unit, '-p', 'NeedDaemonReload', '--value');
  // Inactive template instances may be garbage-collected and freshly loaded
  // by show; NeedDaemonReload can already be no without a daemon-reload.
  const status = fault('deny-reload', 'status'); assert.equal(status.status, 0, status.stderr);
  assert.equal(ctl('show', unit, '-p', 'NeedDaemonReload', '--value'), reload);
  assert.equal(ctl('show', 'servora-med.service', '-p', 'MainPID', '--value'), '0');
  const resumed = host('apply'); assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(ctl('show', unit, '-p', 'NeedDaemonReload', '--value'), 'no');
  assert.equal(JSON.parse(resumed.stdout).starts, 1); assertImmutable(saved);
});
test('FHOST-19 foreign collector path fails preflight without reload or ownership mutation', () => {
  execFileSync('/usr/bin/mkdir', ['-p', '/etc/systemd/system/servora-med-time-evidence@.service.d']);
  write(PATHS.collectorDropin, '[Service]\nExecStart=\nExecStart=/bin/true\n');
  const unit = 'servora-med-time-evidence@forward-probe.service';
  try {
    const reload = ctl('show', unit, '-p', 'NeedDaemonReload', '--value');
    const result = fault('deny-reload', 'preflight'); assert.equal(result.status, 1);
    assert.equal(ctl('show', unit, '-p', 'NeedDaemonReload', '--value'), reload);
    assert.equal(existsSync(PATHS.owner), false); assertImmutable(saved);
  } finally { unlinkSync(PATHS.collectorDropin); }
});
test('FHOST-20 actual socket worker runs the forward module as chrony with no capabilities and denies malformed input', async () => {
  const applied = host('apply'); assert.equal(applied.status, 0, applied.stderr);
  const script = `import {createConnection} from 'node:net'; const socket=createConnection('${PATHS.timeSocket}'); let body='';
socket.on('connect',()=>console.log('CONNECTED')); socket.on('data',chunk=>body+=chunk.toString());
process.stdin.once('data',()=>socket.end('invalid\\n')); socket.on('end',()=>{console.log('BODY='+JSON.stringify(body));process.exit(0);}); socket.on('error',()=>process.exit(2));`;
  const client = spawn('/usr/bin/sudo', ['-u', 'servora-med', '/usr/bin/node', '--input-type=module', '-e', script],
    {env: {PATH: '/usr/bin:/bin'}, stdio: ['pipe', 'pipe', 'pipe']});
  client.stderr.resume();
  const lines = createInterface({input: client.stdout})[Symbol.asyncIterator]();
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('SOCKET_FIXTURE_TIMEOUT')), 6000).unref());
  try {
    assert.equal((await Promise.race([lines.next(), timeout])).value, 'CONNECTED');
    await new Promise(resolve => setTimeout(resolve, 750));
    const units = ctl('list-units', '--all', '--type=service', '--state=active,activating', '--plain', '--no-legend', 'servora-med-time-evidence@*.service');
    const unit = units.split('\n').map(line => line.trim().split(/\s+/)[0]).find(name => /^servora-med-time-evidence@[^\s]+\.service$/.test(name));
    assert.ok(unit, 'the collector must wait for input at the newly authorized path');
    const pid = ctl('show', unit, '-p', 'MainPID', '--value'); assert.notEqual(pid, '0');
    const status = readFileSync('/proc/' + pid + '/status', 'utf8');
    const uid = execFileSync('/usr/bin/id', ['-u', '_chrony'], {encoding: 'utf8'}).trim();
    assert.match(status, new RegExp('^Uid:\\s+' + uid + '\\s+' + uid + '\\s+' + uid + '\\s+' + uid + '$', 'm'));
    assert.match(status, /^CapEff:\s+0000000000000000$/m); assert.match(status, /^NoNewPrivs:\s+1$/m);
    assert.match(readFileSync('/proc/' + pid + '/cmdline', 'utf8'), /servora-med-forward\/trusted-time\.mjs/);
    client.stdin.end('send\n');
    const result = await Promise.race([lines.next(), timeout]); assert.equal(result.value, 'BODY=""');
    assertImmutable(saved);
  } finally { client.kill('SIGKILL'); }
});
test('FHOST-07 crash after systemd start reconciles known invocation and owned permit without another start', () => {
  const result = fault('target-started'); assert.equal(result.signal, 'SIGKILL', result.stderr);
  const pid = ctl('show', 'servora-med.service', '-p', 'MainPID', '--value');
  assert.notEqual(pid, '0'); assert.equal(existsSync(PATHS.permit), true);
  const resumed = host('apply'); assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(ctl('show', 'servora-med.service', '-p', 'MainPID', '--value'), pid);
  assert.equal(existsSync(PATHS.permit), false); assert.equal(JSON.parse(resumed.stdout).starts, 1); assertImmutable(saved);
});
test('FHOST-02 060 to 060 activation consumes one durable slot and fences automatic restart', () => {
  const result = host('apply');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).phase, 'HEALTH_PASSED');
  waitHealth(TARGET);
  assert.equal(realpathSync(PATHS.current), '/opt/servora-med/releases/' + TARGET);
  assert.equal(ctl('show', 'servora-med.service', '-p', 'Restart', '--value'), 'no');
  const attempt = PATHS.root + '/' + authorization.attemptId;
  assert.equal(readdirSync(attempt).filter(n => /^start-\d+\.json$/.test(n)).length, 1);
  const before = ctl('show', 'servora-med.service', '-p', 'MainPID', '--value');
  // Deliberately load on-failure while leaving the actual ExecStartPre gate.
  // This exercises automatic restart, which skips ConditionPathExists.
  unlinkSync(PATHS.policy); ctl('daemon-reload');
  assert.equal(ctl('show', 'servora-med.service', '-p', 'Restart', '--value'), 'on-failure');
  process.kill(Number(before), 'SIGKILL');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6500);
  assert.notEqual(ctl('show', 'servora-med.service', '-p', 'ActiveState', '--value'), 'active');
  assert.ok(Number(ctl('show', 'servora-med.service', '-p', 'NRestarts', '--value')) >= 1);
  assert.equal(existsSync(PATHS.permit), false);
  // Even a manual start cannot reuse the consumed gate slot.
  const manual = spawnSync('/usr/bin/systemctl', ['start', 'servora-med.service'], {encoding: 'utf8'});
  // A skipped condition returns 0; a job coalesced with the failed automatic
  // restart returns 1. Neither may execute another candidate process.
  assert.ok([0, 1].includes(manual.status));
  assert.equal(ctl('show', 'servora-med.service', '-p', 'MainPID', '--value'), '0');
  assert.equal(readdirSync(attempt).filter(n => /^start-\d+\.json$/.test(n)).length, 1);
  assertImmutable(saved);
});
test('FHOST-08 wrong DB/catalog/artifact/CI, incomplete receipt and foreign owner fail read-only', () => {
  const base = canonical(authorization), pid = ctl('show', 'servora-med.service', '-p', 'MainPID', '--value');
  for (const mutate of [a => { a.host.database.databaseOid = '1'; }, a => { a.target.artifactSha256 = '0'.repeat(64); },
    a => { a.target.ciManifestSha256 = '0'.repeat(64); }, a => { a.target.catalog[59].sha256 = '0'.repeat(64); },
    a => { a.parent.emergencyReceiptSha256 = '0'.repeat(64); }]) {
    const a = JSON.parse(base); mutate(a); write(PATHS.root + '/authorization.json', canonical(a));
    const result = host('preflight'); assert.equal(result.status, 1, result.stdout);
    assert.equal(existsSync(PATHS.owner), false); assert.equal(existsSync(PATHS.barrier), false);
    assert.equal(ctl('show', 'servora-med.service', '-p', 'MainPID', '--value'), pid);
  }
  write(PATHS.root + '/authorization.json', base);
  write(PATHS.owner, canonical({attemptId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', approvalSha256: 'f'.repeat(64)}));
  try { assert.equal(host('preflight').status, 1); } finally { unlinkSync(PATHS.owner); }
  renameSync(PATHS.root + '/authorization.json', PATHS.root + '/fixture-authorization.saved');
  try { assert.equal(host('preflight').status, 1); } finally { renameSync(PATHS.root + '/fixture-authorization.saved', PATHS.root + '/authorization.json'); }
  const appliedAt = execFileSync('/usr/bin/sudo', ['-u', 'postgres', '/usr/lib/postgresql/17/bin/psql', '-At', '-d', 'servora_med_test_eh', '-c', "SELECT applied_at::text FROM schema_migrations WHERE version='060_crm_duplicate_review_decisions'"], {encoding: 'utf8'}).trim();
  assert.match(appliedAt, /^[0-9 .:+-]+$/);
  execFileSync('/usr/bin/sudo', ['-u', 'postgres', '/usr/lib/postgresql/17/bin/psql', '-d', 'servora_med_test_eh', '-c', "DELETE FROM schema_migrations WHERE version='060_crm_duplicate_review_decisions'"]);
  try { assert.equal(host('preflight').status, 1); }
  finally { execFileSync('/usr/bin/sudo', ['-u', 'postgres', '/usr/lib/postgresql/17/bin/psql', '-d', 'servora_med_test_eh', '-c', "INSERT INTO schema_migrations(version, applied_at) VALUES ('060_crm_duplicate_review_decisions', '" + appliedAt + "')"]); }
  assertImmutable(saved);
});
test('FHOST-09 backup failure cannot stop OLD or advance to activation', () => {
  const result = fault('backup-fail'); assert.equal(result.status, 1, result.stderr);
  assert.equal(realpathSync(PATHS.current), saved.oldRoot);
  assert.equal(ctl('show', 'servora-med.service', '-p', 'Restart', '--value'), 'on-failure');
  const attempt = PATHS.root + '/' + authorization.attemptId;
  assert.equal(existsSync(attempt + '/pre-backup.json'), false);
  assert.equal(host('apply').status, 1); assertImmutable(saved);
});
for (const [number, name] of [['10', 'health'], ['11', 'schema']]) {
  test('FHOST-' + number + ' TARGET ' + name + ' failure cannot pass health or accept', () => {
    write('/opt/servora-med/forward-fixture-flags/' + name + '-fail', 'fixture\n', 0o644);
    const result = host('apply'); assert.equal(result.status, 1, result.stdout);
    const attempt = PATHS.root + '/' + authorization.attemptId;
    const records = readdirSync(attempt + '/journal').filter(n => /^\d{4}\.json$/.test(n)).map(n => JSON.parse(readFileSync(attempt + '/journal/' + n)));
    assert.equal(records.at(-1).contract.phase, 'TARGET_ACTIVATED');
    assert.equal(records.some(r => r.contract.acceptance !== null), false); assertImmutable(saved);
  });
}
test('FHOST-12 interrupted journal publication is read-only inspectable and apply-only recoverable', () => {
  const result = fault('publication-before-link'); assert.equal(result.signal, 'SIGKILL', result.stderr);
  const directory = PATHS.root + '/' + authorization.attemptId + '/journal';
  const names = readdirSync(directory), before = names.map(n => [n, readFileSync(directory + '/' + n, 'utf8')]);
  const inspected = host('preflight'); assert.equal(inspected.status, 0, inspected.stderr);
  assert.equal(JSON.parse(inspected.stdout).pendingPublications, 1);
  assert.deepEqual(readdirSync(directory).map(n => [n, readFileSync(directory + '/' + n, 'utf8')]), before);
  const resumed = host('apply'); assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).starts, 1); assertImmutable(saved);
});
test('FHOST-13 sealed post backup and smoke boundary cannot bypass backup-health 503 or early acceptance', () => {
  const applied = host('apply'); assert.equal(applied.status, 0, applied.stderr);
  assert.equal(host('finish').status, 1);
  smokeReceipt(authorization);
  const smoked = host('smoke'); assert.equal(smoked.status, 0, smoked.stderr);
  assert.equal(JSON.parse(smoked.stdout).phase, 'POSTDEPLOY_BACKUP_PASSED');
  const directory = PATHS.root + '/' + authorization.attemptId;
  write(directory + '/observation.json', canonical({kind: 'FAKE_OBSERVATION', seconds: 1800}));
  assert.equal(host('finish').status, 1);
  write('/opt/servora-med/forward-fixture-flags/backup-fail', 'fixture 503\n', 0o644);
  const observed = host('observe'); assert.equal(observed.status, 1);
  assert.match(observed.stderr, /BACKUP_HEALTH_FAILED/);
  const status = host('status'); assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).phase, 'POSTDEPLOY_BACKUP_PASSED'); assertImmutable(saved);
});
test('FHOST-14 platform handback mechanics preserve PID and restore real on-failure recovery without claiming acceptance', () => {
  const applied = host('apply'); assert.equal(applied.status, 0, applied.stderr);
  const pid = ctl('show', 'servora-med.service', '-p', 'MainPID', '--value');
  // Mechanical systemd contract only. The adapter still has no observation
  // proof and its journal must remain HEALTH_PASSED throughout this test.
  unlinkSync(PATHS.policy); ctl('daemon-reload');
  assert.equal(ctl('show', 'servora-med.service', '-p', 'Restart', '--value'), 'on-failure');
  unlinkSync(PATHS.guard); ctl('daemon-reload'); unlinkSync(PATHS.barrier);
  assert.equal(ctl('show', 'servora-med.service', '-p', 'MainPID', '--value'), pid);
  process.kill(Number(pid), 'SIGKILL');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6500);
  assert.notEqual(ctl('show', 'servora-med.service', '-p', 'MainPID', '--value'), pid);
  waitHealth(TARGET);
  assert.equal(realpathSync('/proc/' + ctl('show', 'servora-med.service', '-p', 'MainPID', '--value') + '/cwd'), '/opt/servora-med/releases/' + TARGET + '/server');
  const directory = PATHS.root + '/' + authorization.attemptId + '/journal';
  const last = readdirSync(directory).filter(n => /^\d{4}\.json$/.test(n)).sort().at(-1);
  assert.equal(JSON.parse(readFileSync(directory + '/' + last)).contract.phase, 'HEALTH_PASSED'); assertImmutable(saved);
});
test('FHOST-15 journal hash drift refuses read-only status without repairing bytes', () => {
  const crashed = fault('phase-STOP_INTENT'); assert.equal(crashed.signal, 'SIGKILL', crashed.stderr);
  const directory = PATHS.root + '/' + authorization.attemptId + '/journal';
  const file = directory + '/0000.json', before = readFileSync(file, 'utf8').replace('FORWARD_HOST_EVENT', 'FOREIGN_HOST_EVENT');
  write(file, before);
  assert.equal(host('status').status, 1); assert.equal(readFileSync(file, 'utf8'), before); assertImmutable(saved);
});
test('FHOST-16 another process lock cannot authorize an unlocked inherited fd', async () => {
  const holder = spawn('/usr/bin/flock', [PATHS.state + '/host.lock', '/usr/bin/sleep', '4'], {stdio: 'ignore', detached: true});
  try {
    await new Promise(resolve => setTimeout(resolve, 200));
    const script = 'exec 3<>/var/lib/servora-med/deploy/host.lock\nexec /usr/bin/env -i PATH=/usr/bin:/bin SERVORA_FORWARD_LOCKED=1 SERVORA_FORWARD_LOCK_FD=3 /usr/bin/node ' + PATHS.tool + '/forward-host.mjs apply';
    const result = spawnSync('/usr/bin/bash', ['-c', script], {encoding: 'utf8', timeout: 20000});
    assert.equal(result.status, 1); assert.match(result.stderr, /LOCK_NOT_HELD/);
    assert.equal(existsSync(PATHS.owner), false); assertImmutable(saved);
  } finally { try { process.kill(-holder.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
});
