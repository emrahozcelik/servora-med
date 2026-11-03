// Named disposable scenarios only. Synthetic release/CI/browser evidence;
// no actual 1800-second observation or production authorization.
import test, {before, beforeEach, after} from 'node:test';
import assert from 'node:assert/strict';
import {setup, reset, restore, host, fault, smokeReceipt, write, ctl, readOnlySnapshot,
  assertImmutable, recoveryFixtureGrant, waitHealth} from './forward-host-systemd-fixture.mjs';
import {PATHS} from '../scripts/forward-host.mjs';
import {canonical} from '../scripts/forward-host-storage.mjs';
import {recoveryDigest} from '../scripts/forward-host-recovery.mjs';
import {validateRecoveryLog} from '../scripts/forward-host-recovery.mjs';
import {validateHostLog} from '../scripts/forward-host-driver.mjs';
import {readFileSync, readdirSync, existsSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
let saved, authorization;
before(() => { saved = setup(); });
beforeEach(() => { authorization = reset(saved); });
after(() => { if (saved) restore(saved); });
const attempt = () => PATHS.root + '/' + authorization.attemptId;
function records(path = attempt() + '/journal') {
  return readdirSync(path).filter(n => /^\d{4}\.json$/.test(n)).sort().map(n => JSON.parse(readFileSync(path + '/' + n)));
}
function prepareObservation() {
  const applied = host('apply'); assert.equal(applied.status, 0, applied.stderr);
  smokeReceipt(authorization);
  const smoked = host('smoke'); assert.equal(smoked.status, 0, smoked.stderr);
}
function grant(mode = 'RESTORE_HEALTHY_TARGET') {
  return recoveryFixtureGrant(authorization, mode);
}
function assertSafety(original, {restart, owner, barrier, pid = null}) {
  assert.deepEqual(records(), original);
  const toolHash = JSON.parse(readFileSync(PATHS.tool + '/manifest.json')).hash;
  validateHostLog(records(), authorization, recoveryDigest(authorization), toolHash);
  assert.equal(ctl('show', 'servora-med.service', '-p', 'Restart', '--value'), restart);
  assert.equal(existsSync(PATHS.owner), owner); assert.equal(existsSync(PATHS.barrier), barrier);
  const actual = ctl('show', 'servora-med.service', '-p', 'MainPID', '--value');
  if (pid !== null) assert.equal(actual, pid);
  const started = original.find(r => r.event === 'START_DONE')?.data.identity ?? original[0]?.data.oldIdentity;
  if (Number(actual) > 0 && started) {
    assert.equal(Number(actual), started.pid);
    const stat = readFileSync('/proc/' + actual + '/stat', 'utf8');
    assert.equal(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19], started.startTime);
    assert.equal(readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), started.bootId);
  }
  if (existsSync(attempt() + '/recovery/journal')) {
    const g = JSON.parse(readFileSync(attempt() + '/recovery-authorization.json'));
    validateRecoveryLog(records(attempt() + '/recovery/journal'), g, authorization, original, toolHash);
  }
  assert.equal(original.some(r => r.contract.acceptance !== null), false); assertImmutable(saved);
}
test('FSAFE-01 separate root grant restores healthy TARGET without acceptance or another start', () => {
  prepareObservation();
  const before = readOnlySnapshot(), original = records();
  const status = host('recovery-status'); assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(readOnlySnapshot(), before);
  assert.equal(host('recover').status, 1, 'the deployment grant alone grants no recovery');
  grant();
  const result = host('recover'); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).outcome, 'FORWARD_TARGET_POLICY_RESTORED_NOT_ACCEPTED');
  assert.equal(ctl('show', 'servora-med.service', '-p', 'MainPID', '--value'), before.pid);
  assert.equal(ctl('show', 'servora-med.service', '-p', 'Restart', '--value'), 'on-failure');
  assert.equal(existsSync(PATHS.owner), false); assert.equal(existsSync(PATHS.barrier), false);
  assert.deepEqual(records(), original);
  assert.equal(original.filter(r => r.event === 'START_INTENT').length, 1);
  assert.equal(original.some(r => r.contract.acceptance !== null), false);
  assert.equal(host('observe').status, 1); assertImmutable(saved);
});

test('FSAFE-09 recovery admission revokes an armed but unconsumed deployment start permit', () => {
  const armed = fault('permit-before-start'); assert.equal(armed.signal, 'SIGKILL', armed.stderr);
  assert.equal(existsSync(PATHS.ticket), true); assert.equal(existsSync(PATHS.permit), true);
  grant('CLOSE_FENCED');
  const admitted = fault('recovery-INTENT', 'recover'); assert.equal(admitted.signal, 'SIGKILL', admitted.stderr);
  // A valid old ticket must no longer authorize ExecStart after recovery owns
  // the attempt. systemd really runs ExecStartPre in its root sandbox here.
  try { ctl('start', 'servora-med.service'); } catch { /* expected failed gate */ }
  assert.equal(ctl('show', 'servora-med.service', '-p', 'MainPID', '--value'), '0');
  assert.equal(readdirSync(attempt()).filter(n => /^start-\d+\.json$/.test(n)).length, 0);
  const recovered = host('recover'); assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(existsSync(PATHS.ticket), false); assert.equal(existsSync(PATHS.permit), false);
  assert.equal(records().filter(r => r.event === 'START_INTENT').length, 1);
  assertImmutable(saved);
});

for (const [id, point] of [['02', 'phase-OBSERVATION_STARTED'], ['03', 'event-OBSERVE_INTENT']]) {
  test('FSAFE-' + id + ' interruption ' + point + ' requires separate healthy restoration', () => {
    prepareObservation();
    const crashed = fault(point, 'observe'); assert.equal(crashed.signal, 'SIGKILL', crashed.stderr);
    const original = records(), pid = ctl('show', 'servora-med.service', '-p', 'MainPID', '--value');
    assertSafety(original, {restart: 'no', owner: true, barrier: true, pid});
    grant(); const result = host('recover'); assert.equal(result.status, 0, result.stderr);
    assertSafety(original, {restart: 'on-failure', owner: false, barrier: false, pid});
  });
}
test('FSAFE-04 observation process crash closes fenced without a second start', () => {
  prepareObservation();
  const failed = fault('observation-process-crash', 'observe'); assert.equal(failed.status, 1);
  const original = records();
  assertSafety(original, {restart: 'no', owner: true, barrier: true, pid: '0'});
  grant('CLOSE_FENCED'); const closed = host('recover'); assert.equal(closed.status, 0, closed.stderr);
  assert.equal(JSON.parse(closed.stdout).outcome, 'FORWARD_FAILURE_FENCED_NOT_ACCEPTED');
  assertSafety(original, {restart: 'no', owner: true, barrier: true, pid: '0'});
});
test('FSAFE-05 Trusted Time UNKNOWN interrupts observation and never becomes acceptance', () => {
  prepareObservation();
  const unknown = fault('forced-time-unknown', 'observe'); assert.equal(unknown.status, 1);
  const original = records(); assert.equal(existsSync(attempt() + '/observation.json'), false);
  grant(); const result = host('recover'); assert.equal(result.status, 0, result.stderr);
  assertSafety(original, {restart: 'on-failure', owner: false, barrier: false});
});
test('FSAFE-06 backup503 during observation stays FAIL in separate healthy policy restoration', () => {
  prepareObservation();
  const failed = fault('observation-backup-fail', 'observe'); assert.equal(failed.status, 1);
  assert.match(failed.stderr, /BACKUP_HEALTH_FAILED/);
  const original = records(); grant();
  const result = host('recover'); assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(readFileSync(attempt() + '/recovery/receipt.json'));
  assert.equal(receipt.evidence.backupHealth, 'FAIL'); assert.equal(receipt.accepted, false);
  assertSafety(original, {restart: 'on-failure', owner: false, barrier: false});
});
test('FSAFE-07 interrupted partial observation publication is retained and cannot accept', () => {
  prepareObservation();
  const crashed = fault('observation-partial-proof', 'observe'); assert.equal(crashed.signal, 'SIGKILL', crashed.stderr);
  const original = records(), partial = readFileSync(attempt() + '/observation.json', 'utf8');
  assert.throws(() => JSON.parse(partial));
  grant(); const result = host('recover'); assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(attempt() + '/observation.json', 'utf8'), partial);
  assertSafety(original, {restart: 'on-failure', owner: false, barrier: false});
});
test('FSAFE-08 incomplete activation preserves mixed OLD pointer and TARGET environment under fenced closure', () => {
  const crashed = fault('event-ENV_DONE'); assert.equal(crashed.signal, 'SIGKILL', crashed.stderr);
  const original = records(), pointer = readFileSync(PATHS.env, 'utf8');
  assert.match(pointer, new RegExp('SERVORA_RELEASE_SHA=' + authorization.target.releaseSha));
  grant('CLOSE_FENCED'); const result = host('recover'); assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(PATHS.env, 'utf8'), pointer);
  assert.equal(records().filter(r => r.event === 'START_INTENT').length, 0);
  assertSafety(original, {restart: 'no', owner: true, barrier: true, pid: '0'});
});

test('FSAFE-10 separately approved healthy restoration narrows to fenced closure if the process crashes', () => {
  prepareObservation(); const original = records(); grant();
  const result = fault('recovery-runtime-crash', 'recover'); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).outcome, 'FORWARD_FAILURE_FENCED_NOT_ACCEPTED');
  assert.equal(records(attempt() + '/recovery/journal').some(r => r.event === 'FALLBACK_INTENT'), true);
  assertSafety(original, {restart: 'no', owner: true, barrier: true, pid: '0'});
});

test('FSAFE-11 unknown TARGET executable is inspectable and closes fenced without killing or starting it', () => {
  prepareObservation(); const original = records();
  const pid = ctl('show', 'servora-med.service', '-p', 'MainPID', '--value');
  write('/opt/servora-med/forward-fixture-flags/unknown-exe', 'SYNTHETIC EXECVE FIXTURE\n', 0o644);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  grant('CLOSE_FENCED');
  const result = host('recover'); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(attempt() + '/recovery/receipt.json')).evidence.releaseSha, null);
  assertSafety(original, {restart: 'no', owner: true, barrier: true, pid});
});

for (const [id, event] of [['12', 'SEAL_DONE'], ['13', 'RETIRE_INTENT']]) {
  test('FSAFE-' + id + ' failed-observation policy handback crash after ' + event + ' resumes without start', () => {
    prepareObservation(); const original = records(), pid = ctl('show', 'servora-med.service', '-p', 'MainPID', '--value');
    grant(); const crashed = fault('recovery-' + event, 'recover'); assert.equal(crashed.signal, 'SIGKILL', crashed.stderr);
    const before = readOnlySnapshot();
    const status = host('recovery-status'); assert.equal(status.status, 0, status.stderr);
    assert.deepEqual(readOnlySnapshot(), before);
    const resumed = host('recover'); assert.equal(resumed.status, 0, resumed.stderr);
    assertSafety(original, {restart: 'on-failure', owner: false, barrier: false, pid});
  });
}
test('FSAFE-14 synthetic accepted checkpoint resumes terminal handback with the same real process', () => {
  prepareObservation();
  execFileSync('/usr/bin/flock', ['--nonblock', PATHS.state + '/host.lock', '/usr/bin/node',
    '/tmp/servora-forward-src/ops/tests/forward-host-terminal-fixture.mjs']);
  const original = records(), pid = ctl('show', 'servora-med.service', '-p', 'MainPID', '--value');
  const crashed = fault('accepted-event-HANDOFF_INTENT', 'finish'); assert.equal(crashed.signal, 'SIGKILL', crashed.stderr);
  const resumed = fault('accepted-none', 'finish'); assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).ownerRetired, true);
  assert.equal(ctl('show', 'servora-med.service', '-p', 'MainPID', '--value'), pid);
  assert.equal(ctl('show', 'servora-med.service', '-p', 'Restart', '--value'), 'on-failure');
  assert.equal(existsSync(PATHS.owner), false); assert.equal(existsSync(PATHS.barrier), false);
  assert.equal(records().filter(r => r.event === 'START_INTENT').length, 1);
  assert.equal(records().filter(r => r.event === 'OBSERVE_INTENT').length, 1);
  assert.equal(original.at(-1).contract.phase, 'ACCEPTED'); assertImmutable(saved);
});

test('FSAFE-15 read-only preflight rejects environment drift before any deployment mutation', () => {
  const original = readFileSync(PATHS.env, 'utf8'), before = readOnlySnapshot();
  try {
    writeFileSync(PATHS.env, original + '\nFORWARD_FIXTURE_EXTRA=true\n');
    const changed = readOnlySnapshot(), result = host('preflight');
    assert.equal(result.status, 1); assert.match(result.stderr, /ENV_DRIFT/);
    assert.deepEqual(readOnlySnapshot(), changed);
    assert.equal(existsSync(PATHS.owner), false); assert.equal(existsSync(PATHS.barrier), false);
    assert.equal(ctl('show', 'servora-med.service', '-p', 'MainPID', '--value'), before.pid);
  } finally { writeFileSync(PATHS.env, original); }
  assertImmutable(saved);
});
test('FSAFE-16 pre-stop backup failure can release unchanged healthy OLD and owner without stop/start', () => {
  const failed = fault('backup-fail'); assert.equal(failed.status, 1);
  const original = records(), pid = ctl('show', 'servora-med.service', '-p', 'MainPID', '--value');
  assert.equal(original.some(r => r.contract.phase === 'STOP_INTENT'), false);
  grant('RELEASE_UNCHANGED_OLD');
  const recovered = host('recover'); assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).outcome, 'FORWARD_UNCHANGED_OLD_RELEASED_NOT_ACCEPTED');
  assert.equal(JSON.parse(readFileSync(attempt() + '/recovery/receipt.json')).evidence.backupIntegrity, 'NOT_COMPLETED');
  assert.equal(ctl('show', 'servora-med.service', '-p', 'MainPID', '--value'), pid);
  assertSafety(original, {restart: 'on-failure', owner: false, barrier: false, pid});
  assert.equal(records().filter(r => r.event === 'START_INTENT').length, 0);
});
test('FSAFE-17 owner unlink crash resumes terminal receipt while normal policy handles runtime crash', () => {
  prepareObservation(); const original = records(); grant();
  const previousPid = ctl('show', 'servora-med.service', '-p', 'MainPID', '--value');
  const crashed = fault('owner-retired', 'recover'); assert.equal(crashed.signal, 'SIGKILL', crashed.stderr);
  assert.equal(existsSync(PATHS.owner), false); assert.equal(existsSync(PATHS.barrier), false);
  const resumed = host('recover'); assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).accepted, false);
  assert.equal(ctl('show', 'servora-med.service', '-p', 'Restart', '--value'), 'on-failure');
  assert.deepEqual(records(), original);
  assert.equal(records().filter(r => r.event === 'START_INTENT').length, 1);
  waitHealth(authorization.target.releaseSha);
  assert.notEqual(ctl('show', 'servora-med.service', '-p', 'MainPID', '--value'), previousPid);
  const currentPid = ctl('show', 'servora-med.service', '-p', 'MainPID', '--value');
  const started = original.find(r => r.event === 'START_DONE').data.identity;
  const stat = readFileSync('/proc/' + currentPid + '/stat', 'utf8');
  assert.notEqual(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19], started.startTime);
  assert.equal(readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), started.bootId);
  assert.equal(records(attempt() + '/recovery/journal').at(-1).event, 'FINAL');
  assertImmutable(saved);
});

test('FSAFE-18 unchanged OLD closure still denies a failing verified TARGET schema checker', () => {
  const failed = fault('backup-fail'); assert.equal(failed.status, 1);
  const original = records(), pid = ctl('show', 'servora-med.service', '-p', 'MainPID', '--value');
  write('/opt/servora-med/forward-fixture-flags/schema-fail', 'SYNTHETIC CHECKER FAILURE\n', 0o644);
  grant('RELEASE_UNCHANGED_OLD');
  const result = host('recover'); assert.equal(result.status, 1); assert.match(result.stderr, /TARGET_UNSAFE/);
  assert.equal(existsSync(attempt() + '/recovery/journal'), false);
  assertSafety(original, {restart: 'on-failure', owner: true, barrier: false, pid});
});
