// Host acceptance for the emergency restart-policy handoff.
// Runs only on the disposable Linux/amd64 + systemd + PostgreSQL 17 fixture.
import test, {before, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync, chownSync, copyFileSync, existsSync, lstatSync, readFileSync, readdirSync,
  rmSync, unlinkSync, writeFileSync, chmodSync,
} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {hostname} from 'node:os';
import {
  build, resetMutable, issueAuthorization, runHost, paths, serviceFacts,
  parentSnapshot, readOnlySnapshot, restoreCatalog, TARGET_SHA,
} from './emergency-handoff-fixture.mjs';

assert.equal(hostname(), 'lima-servora-r4-20261012');
assert.equal(process.getuid(), 0);
const hash = value => createHash('sha256').update(value).digest('hex');
const P = paths();
let fixture;

function processStart(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
}
function waitFor(predicate, seconds = 40) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  return false;
}
function applicable() {
  return readdirSync(P.EMERGENCY).filter(name => /^[0-9a-f-]{36}$/.test(name));
}
function journalPhases(authorizationId) {
  const directory = join(P.EMERGENCY, authorizationId);
  return readdirSync(directory).filter(name => /^\d{4}\.json$/.test(name)).sort()
    .map(name => JSON.parse(readFileSync(join(directory, name), 'utf8')).phase);
}
function receipt(authorizationId) {
  return JSON.parse(readFileSync(join(P.EMERGENCY, authorizationId, 'receipt.json'), 'utf8'));
}
function rewriteAuthorization(mutate) {
  const file = join(P.EMERGENCY, 'authorization.json');
  const record = JSON.parse(readFileSync(file, 'utf8'));
  mutate(record);
  writeFileSync(file, JSON.stringify(record) + '\n', {mode: 0o600});
  chmodSync(file, 0o600);
}
function failure(result) {
  return (result.stderr || '').trim().split('\n').at(-1);
}

before(() => { fixture = build(); });
beforeEach(() => { resetMutable(); });

test('HOST-01: verify is read-only and reports READY', () => {
  const authorization = issueAuthorization(fixture.attemptId);
  const parent = parentSnapshot(fixture.attemptId);
  const facts = serviceFacts();
  const result = runHost('verify');
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout.trim());
  assert.equal(body.result, 'EMERGENCY_HANDOFF_READY');
  assert.equal(body.authorizationId, authorization.authorizationId);
  assert.deepEqual(parentSnapshot(fixture.attemptId), parent);
  assert.deepEqual(serviceFacts().MainPID, facts.MainPID);
  assert.equal(existsSync(join(P.EMERGENCY, authorization.authorizationId)), false);
});

test('HOST-02: policy-first handoff completes without restarting the app', () => {
  const authorization = issueAuthorization(fixture.attemptId);
  const parent = parentSnapshot(fixture.attemptId);
  const before = serviceFacts();
  const pid = Number(before.MainPID);
  const start = processStart(pid);
  const preBackup = hash(readFileSync(`${P.STATE}/backups/${fixture.attemptId}-pre.dump`));
  const postBackup = hash(readFileSync(`${P.STATE}/backups/${fixture.attemptId}-post.dump`));
  const result = runHost('apply');
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout.trim());
  assert.equal(body.result, 'EMERGENCY_HANDOFF_COMPLETE');
  assert.equal(body.operationalStatus, 'EMERGENCY_RESTART_POLICY_RESTORED');
  assert.equal(body.r4TerminalState, 'HEALTH_PASSED_FENCED');
  assert.equal(body.r4Acceptance, 'NOT_ACCEPTED');
  assert.equal(body.appPid, pid);
  assert.equal(body.initialAppPid, pid);
  assert.equal(body.processContinuity, 'PRESERVED');
  assert.deepEqual(journalPhases(authorization.authorizationId), [
    'INTENT', 'POLICY_INTENT', 'POLICY_RESTORED', 'BARRIER_INTENT', 'BARRIER_REMOVED',
    'OWNER_INTENT', 'OWNER_RETIRED', 'HANDOFF_COMPLETE',
  ]);
  const after = serviceFacts();
  assert.equal(after.ActiveState, 'active');
  assert.equal(after.MainPID, String(pid), 'handoff must not restart the app');
  assert.equal(processStart(pid), start);
  assert.equal(after.Restart, 'on-failure');
  assert.equal(after.DropInPaths, '');
  assert.equal(after.NeedDaemonReload, 'no');
  assert.equal(after.NRestarts, '0');
  assert.equal(existsSync(P.STATE + '/activation.block'), false);
  assert.equal(existsSync(P.STATE + '/active.json'), false);
  assert.equal(existsSync(P.DROPIN), false);
  assert.equal(existsSync('/run/servora-med-recovery/start.permit'), false);
  assert.deepEqual(parentSnapshot(fixture.attemptId), parent, 'sealed parent history must be byte-identical');
  assert.equal(hash(readFileSync(`${P.STATE}/backups/${fixture.attemptId}-pre.dump`)), preBackup);
  assert.equal(hash(readFileSync(`${P.STATE}/backups/${fixture.attemptId}-post.dump`)), postBackup);
  const sealed = receipt(authorization.authorizationId);
  assert.equal(sealed.operationalStatus, 'EMERGENCY_RESTART_POLICY_RESTORED');
  assert.equal(sealed.r4TerminalState, 'HEALTH_PASSED_FENCED');
  assert.equal(sealed.r4Acceptance, 'NOT_ACCEPTED');
  assert.equal(sealed.observationPassed, false);
  assert.equal(sealed.parentAttemptCompleted, false);
  assert.equal(sealed.futureReleaseAuthority, false);
  assert.deepEqual(sealed.host.startBudget, {used: 2, max: 2});
  assert.equal(sealed.handoff.processContinuity, 'PRESERVED');
  assert.equal(sealed.handoff.rebootObservationSha256, null);
});

test('HOST-03: wrong parent approval or checkpoint is rejected without mutation', () => {
  for (const mutate of [
    authorization => { authorization.parent.approvalSha256 = '9'.repeat(64); },
    authorization => { authorization.parent.checkpointSha256 = '9'.repeat(64); },
    authorization => { authorization.parent.checkpointSequence += 1; },
  ]) {
    resetMutable();
    issueAuthorization(fixture.attemptId);
    rewriteAuthorization(mutate);
    const parent = parentSnapshot(fixture.attemptId);
    const result = runHost('apply');
    assert.notEqual(result.status, 0);
    assert.match(failure(result), /EMERGENCY_HANDOFF_(BINDING_MISMATCH|LIVE_STATE_MISMATCH|RUNTIME_BINDING_MISMATCH)/);
    assert.deepEqual(parentSnapshot(fixture.attemptId), parent);
    assert.equal(existsSync(P.STATE + '/activation.block'), true);
    assert.equal(existsSync(P.STATE + '/active.json'), true);
    assert.equal(existsSync(P.DROPIN), true);
    assert.equal(applicable().length, 0);
  }
});

test('HOST-04: DB 055 or 061 is rejected without mutation', () => {
  const db = P.DB_NAME;
  const psql = sql => {
    const result = spawnSync('/usr/bin/sudo',
      ['-u', 'postgres', '/usr/bin/psql', '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-d', db, '-Atc', sql],
      {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  for (const mutate of [
    () => psql("DELETE FROM schema_migrations WHERE version > '055'"),
    () => psql("INSERT INTO schema_migrations(version) VALUES ('061_fixture_future')"),
  ]) {
    resetMutable();
    issueAuthorization(fixture.attemptId);
    mutate();
    try {
      const result = runHost('apply');
      assert.notEqual(result.status, 0);
      assert.match(failure(result), /RECOVERY_DATABASE_(NOT_EXACT|IDENTITY_MISMATCH|PROBE_FAILED)/);
      assert.equal(existsSync(P.STATE + '/activation.block'), true);
      assert.equal(existsSync(P.STATE + '/active.json'), true);
      assert.equal(existsSync(P.DROPIN), true);
      assert.equal(applicable().length, 0);
    } finally { restoreCatalog(); }
  }
});

test('HOST-05: installed time-module drift is rejected without mutation', () => {
  issueAuthorization(fixture.attemptId);
  const file = P.INSTALLED + '/trusted-time.mjs';
  const original = readFileSync(file);
  appendFileSync(file, '\n// fixture drift\n');
  try {
    const parent = parentSnapshot(fixture.attemptId);
    const result = runHost('apply');
    assert.notEqual(result.status, 0);
    assert.match(failure(result), /RECOVERY_HOST_CONTRACT_MISMATCH/);
    assert.deepEqual(parentSnapshot(fixture.attemptId), parent);
    assert.equal(existsSync(P.STATE + '/activation.block'), true);
    assert.equal(applicable().length, 0);
  } finally {
    writeFileSync(file, original);
    chmodSync(file, 0o644);
  }
});

test('HOST-06: a foreign active owner is rejected without mutation', () => {
  issueAuthorization(fixture.attemptId);
  writeFileSync(P.STATE + '/active.json', JSON.stringify({
    attemptId: '22222222-2222-4222-8222-222222222222',
    approvalSha256: '9'.repeat(64),
  }) + '\n', {mode: 0o600});
  chmodSync(P.STATE + '/active.json', 0o600);
  const result = runHost('apply');
  assert.notEqual(result.status, 0);
  assert.match(failure(result), /EMERGENCY_HANDOFF_(LIVE_STATE_MISMATCH|OWNER_UNTRUSTED)/);
  assert.equal(existsSync(P.STATE + '/activation.block'), true);
  assert.equal(existsSync(P.DROPIN), true);
  assert.equal(applicable().length, 0);
});

test('HOST-07: a missing or corrupt retained backup is rejected without mutation', () => {
  for (const kind of ['pre', 'post']) {
    resetMutable();
    issueAuthorization(fixture.attemptId);
    const file = `${P.STATE}/backups/${fixture.attemptId}-${kind}.dump`;
    const original = readFileSync(file);
    if (kind === 'post') writeFileSync(file, Buffer.from('corrupt\n'), {mode: 0o600});
    else unlinkSync(file);
    try {
      const result = runHost('apply');
      assert.notEqual(result.status, 0);
      assert.match(failure(result), /EMERGENCY_HANDOFF_BACKUP_(MISSING|MISMATCH)/);
      assert.equal(existsSync(P.STATE + '/activation.block'), true);
      assert.equal(existsSync(P.DROPIN), true);
      assert.equal(applicable().length, 0);
    } finally {
      writeFileSync(file, original, {mode: 0o600});
      chmodSync(file, 0o600);
    }
  }
});

test('HOST-08: a second handoff is a no-op after completion and a new grant is refused', () => {
  const authorization = issueAuthorization(fixture.attemptId);
  const first = runHost('apply');
  assert.equal(first.status, 0, first.stderr);
  const parent = parentSnapshot(fixture.attemptId);
  const facts = serviceFacts();
  const second = runHost('apply');
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout.trim()).result, 'EMERGENCY_HANDOFF_ALREADY_COMPLETE');
  assert.deepEqual(parentSnapshot(fixture.attemptId), parent);
  assert.equal(serviceFacts().MainPID, facts.MainPID);
  const reissue = spawnSync('/usr/bin/node',
    [P.ARTIFACT + '/issue-emergency-handoff.mjs', '--parent', fixture.attemptId],
    {encoding: 'utf8'});
  assert.notEqual(reissue.status, 0);
  assert.match((reissue.stderr || '').trim(), /EMERGENCY_HANDOFF_(AUTHORIZATION_EXISTS|JOURNAL_EXISTS)/);
  assert.equal(journalPhases(authorization.authorizationId).at(-1), 'HANDOFF_COMPLETE');
});

test('HOST-09: every critical publication boundary recovers deterministically', () => {
  const points = [
    'runtime-fsync', 'journal-fsync', 'journal-link-before', 'journal-link-after',
    'state-root-fsync', 'barrier-unlink-before', 'barrier-unlink-after',
    'policy-unlink-before', 'policy-unlink-after', 'policy-dir-fsync',
    'owner-unlink-before', 'owner-unlink-after', 'receipt-link-before',
    'receipt-link-after', 'receipt-fsync',
  ];
  for (const point of points) {
    resetMutable();
    const authorization = issueAuthorization(fixture.attemptId);
    const before = serviceFacts();
    const pid = Number(before.MainPID);
    const start = processStart(pid);
    const parent = parentSnapshot(fixture.attemptId);
    const interrupted = runHost('apply', {
      NODE_OPTIONS: '--import ' + join(import.meta.dirname, 'emergency-handoff-fault-preload.mjs'),
      SERVORA_EH_FAULT_POINT: point,
    });
    assert.notEqual(interrupted.status, 0, `fault ${point} must stop the tool`);
    assert.match(interrupted.stdout + interrupted.stderr, new RegExp('EMERGENCY_FAULT=' + point),
      `fault ${point} must be reached`);
    const interruptedState = readOnlySnapshot(fixture.attemptId);
    const statusResult = runHost('status');
    assert.equal(statusResult.status, 0, `${point} status: ${statusResult.stderr}`);
    assert.equal(JSON.parse(statusResult.stdout.trim()).readOnly, true, point);
    assert.deepEqual(readOnlySnapshot(fixture.attemptId), interruptedState,
      `${point} status changed state`);
    const verifyResult = runHost('verify');
    assert.equal(verifyResult.status, 0, `${point} verify: ${verifyResult.stderr}`);
    assert.equal(JSON.parse(verifyResult.stdout.trim()).readOnly, true, point);
    assert.deepEqual(readOnlySnapshot(fixture.attemptId), interruptedState,
      `${point} verify changed state`);
    const resumed = runHost('apply');
    assert.equal(resumed.status, 0, `${point}: ${resumed.stderr}`);
    assert.ok(['EMERGENCY_HANDOFF_COMPLETE', 'EMERGENCY_HANDOFF_ALREADY_COMPLETE']
      .includes(JSON.parse(resumed.stdout.trim()).result), point);
    assert.equal(serviceFacts().MainPID, String(pid), `${point} must not restart the app`);
    assert.equal(processStart(pid), start, `${point} must preserve the process identity`);
    assert.equal(serviceFacts().Restart, 'on-failure', point);
    assert.equal(serviceFacts().NeedDaemonReload, 'no', point);
    assert.equal(existsSync(P.STATE + '/activation.block'), false, point);
    assert.equal(existsSync(P.STATE + '/active.json'), false, point);
    assert.equal(existsSync(P.DROPIN), false, point);
    assert.deepEqual(parentSnapshot(fixture.attemptId), parent, `${point} changed parent history`);
    assert.deepEqual(journalPhases(authorization.authorizationId), [
      'INTENT', 'POLICY_INTENT', 'POLICY_RESTORED', 'BARRIER_INTENT', 'BARRIER_REMOVED',
      'OWNER_INTENT', 'OWNER_RETIRED', 'HANDOFF_COMPLETE',
    ], point);
    assert.equal(receipt(authorization.authorizationId).observationPassed, false, point);
  }
});

test('HOST-10: a second, different authorization cannot adopt an interrupted journal', () => {
  issueAuthorization(fixture.attemptId);
  const interrupted = runHost('apply', {
    NODE_OPTIONS: '--import ' + join(import.meta.dirname, 'emergency-handoff-fault-preload.mjs'),
    SERVORA_EH_FAULT_POINT: 'barrier-unlink-after',
  });
  assert.notEqual(interrupted.status, 0);
  const directories = applicable();
  assert.equal(directories.length, 1);
  const before = readdirSync(join(P.EMERGENCY, directories[0])).sort();
  rewriteAuthorization(authorization => {
    authorization.authorizationId = '33333333-3333-4333-8333-333333333333';
  });
  const result = runHost('apply');
  assert.notEqual(result.status, 0);
  assert.match(failure(result), /EMERGENCY_HANDOFF_(LIVE_STATE_MISMATCH|OTHER_AUTHORIZATION|FOREIGN_STATE)/);
  assert.deepEqual(readdirSync(join(P.EMERGENCY, directories[0])).sort(), before);
  assert.equal(existsSync(P.STATE + '/activation.block'), false);

  resetMutable();
  issueAuthorization(fixture.attemptId);
  const second = runHost('apply', {
    NODE_OPTIONS: '--import ' + join(import.meta.dirname, 'emergency-handoff-fault-preload.mjs'),
    SERVORA_EH_FAULT_POINT: 'barrier-unlink-after',
  });
  assert.notEqual(second.status, 0);
  const secondDirectory = applicable();
  assert.equal(secondDirectory.length, 1);
  const secondBefore = readdirSync(join(P.EMERGENCY, secondDirectory[0])).sort();
  rewriteAuthorization(authorization => { authorization.reason = 'tampered-after-start'; });
  const changedBytes = runHost('apply');
  assert.notEqual(changedBytes.status, 0);
  assert.match(failure(changedBytes), /EMERGENCY_HANDOFF_OTHER_AUTHORIZATION/);
  assert.deepEqual(readdirSync(join(P.EMERGENCY, secondDirectory[0])).sort(), secondBefore);
  assert.equal(existsSync(P.STATE + '/activation.block'), false);
});

test('HOST-11: after the handoff, systemd restarts a crashed app (fixture only)', () => {
  const authorization = issueAuthorization(fixture.attemptId);
  const first = runHost('apply');
  assert.equal(first.status, 0, first.stderr);
  const before = serviceFacts();
  assert.equal(before.Restart, 'on-failure');
  const pid = Number(before.MainPID);
  const start = processStart(pid);
  process.kill(pid, 'SIGKILL');
  assert.ok(waitFor(() => {
    const facts = serviceFacts();
    if (facts.ActiveState !== 'active') return false;
    const next = Number(facts.MainPID);
    return next > 0 && next !== pid && processStart(next) !== start;
  }, 45), 'systemd must restart the crashed app after the handoff');
  assert.ok(Number(serviceFacts().NRestarts) >= 1);
  let health = null;
  assert.ok(waitFor(() => {
    const result = spawnSync('/usr/bin/curl',
      ['--silent', '--max-time', '3', 'http://127.0.0.1:3000/api/health'], {encoding: 'utf8'});
    try { health = JSON.parse(result.stdout); return health.releaseSha === TARGET_SHA; }
    catch { return false; }
  }, 20), 'restarted app must become healthy');
  assert.equal(health.releaseSha, TARGET_SHA);
  assert.equal(receipt(authorization.authorizationId).parentAttemptCompleted, false);
});

test('HOST-12: preflight is read-only and runs before authorization', () => {
  rmSync(P.EMERGENCY, {recursive: true, force: true});
  const before = readOnlySnapshot(fixture.attemptId);
  const result = runHost('preflight', {}, ['--parent', fixture.attemptId]);
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout.trim());
  assert.equal(body.result, 'EMERGENCY_HANDOFF_PREFLIGHT_READY');
  assert.equal(body.readOnly, true);
  assert.equal(body.authorizationPresent, false);
  assert.equal(body.emergencyRootPresent, false);
  assert.equal(body.parentAttemptId, fixture.attemptId);
  assert.equal(existsSync(P.EMERGENCY), false, 'preflight must not create the emergency root');
  assert.deepEqual(readOnlySnapshot(fixture.attemptId), before);

  for (const mode of ['verify', 'status']) {
    const missing = runHost(mode);
    assert.notEqual(missing.status, 0, `${mode} must fail without an authorization`);
    assert.match(failure(missing), /EMERGENCY_HANDOFF_AUTHORIZATION_MISSING/);
    assert.equal(existsSync(P.EMERGENCY), false);
    assert.deepEqual(readOnlySnapshot(fixture.attemptId), before, `${mode} changed state`);
  }

  const discovered = runHost('preflight');
  assert.equal(discovered.status, 0, discovered.stderr);
  assert.equal(JSON.parse(discovered.stdout.trim()).parentAttemptId, fixture.attemptId);
  assert.deepEqual(readOnlySnapshot(fixture.attemptId), before);
});

test('HOST-13: verify is strictly read-only, including a half policy unlink', () => {
  const authorization = issueAuthorization(fixture.attemptId);
  const initialFacts = serviceFacts();
  const pid = Number(initialFacts.MainPID);
  const start = processStart(pid);
  let before = readOnlySnapshot(fixture.attemptId);
  let result = runHost('verify');
  assert.equal(result.status, 0, result.stderr);
  let body = JSON.parse(result.stdout.trim());
  assert.equal(body.result, 'EMERGENCY_HANDOFF_READY');
  assert.equal(body.readOnly, true);
  assert.equal(body.pendingReload, false);
  assert.equal(existsSync(join(P.EMERGENCY, authorization.authorizationId)), false);
  assert.deepEqual(readOnlySnapshot(fixture.attemptId), before);
  assert.equal(serviceFacts().MainPID, String(pid));
  assert.equal(processStart(pid), start);

  resetMutable();
  issueAuthorization(fixture.attemptId);
  const interrupted = runHost('apply', {
    NODE_OPTIONS: '--import ' + join(import.meta.dirname, 'emergency-handoff-fault-preload.mjs'),
    SERVORA_EH_FAULT_POINT: 'policy-unlink-after',
  });
  assert.notEqual(interrupted.status, 0);
  assert.match(interrupted.stdout + interrupted.stderr, /EMERGENCY_FAULT=policy-unlink-after/);
  const pendingFacts = serviceFacts();
  assert.equal(pendingFacts.MainPID, String(pid), 'the app must not restart');
  assert.equal(pendingFacts.NeedDaemonReload, 'yes');
  assert.equal(existsSync(P.DROPIN), false);

  before = readOnlySnapshot(fixture.attemptId);
  result = runHost('verify');
  assert.equal(result.status, 0, result.stderr);
  body = JSON.parse(result.stdout.trim());
  assert.equal(body.result, 'EMERGENCY_HANDOFF_READY');
  assert.equal(body.readOnly, true);
  assert.equal(body.pendingReload, true);
  assert.equal(body.nextAction, 'RELOAD_POLICY');
  assert.equal(serviceFacts().NeedDaemonReload, 'yes', 'verify must not reload systemd');
  assert.deepEqual(readOnlySnapshot(fixture.attemptId), before, 'verify changed state');

  result = runHost('apply');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout.trim()).result, 'EMERGENCY_HANDOFF_COMPLETE');
  assert.equal(serviceFacts().MainPID, String(pid));
  assert.equal(processStart(pid), start);
  assert.equal(serviceFacts().Restart, 'on-failure');
  assert.equal(serviceFacts().NeedDaemonReload, 'no');
});

test('HOST-14: status is strictly read-only and fails closed on damaged state', () => {
  const authorization = issueAuthorization(fixture.attemptId);
  const completed = runHost('apply');
  assert.equal(completed.status, 0, completed.stderr);
  const completedState = readOnlySnapshot(fixture.attemptId);
  const statusResult = runHost('status');
  assert.equal(statusResult.status, 0, statusResult.stderr);
  const statusBody = JSON.parse(statusResult.stdout.trim());
  assert.equal(statusBody.readOnly, true);
  assert.equal(statusBody.journalPhase, 'HANDOFF_COMPLETE');
  assert.equal(statusBody.receipt.r4Acceptance, 'NOT_ACCEPTED');
  assert.deepEqual(readOnlySnapshot(fixture.attemptId), completedState);

  resetMutable();
  const corruptAuth = issueAuthorization(fixture.attemptId);
  const interrupted = runHost('apply', {
    NODE_OPTIONS: '--import ' + join(import.meta.dirname, 'emergency-handoff-fault-preload.mjs'),
    SERVORA_EH_FAULT_POINT: 'journal-link-after',
  });
  assert.notEqual(interrupted.status, 0);
  const corruptDirectory = join(P.EMERGENCY, corruptAuth.authorizationId);
  for (const name of readdirSync(corruptDirectory)) {
    if (name.startsWith('.')) unlinkSync(join(corruptDirectory, name));
  }
  const recordFile = join(corruptDirectory, '0000.json');
  const record = JSON.parse(readFileSync(recordFile, 'utf8'));
  record.phase = 'BARRIER_REMOVED';
  writeFileSync(recordFile, JSON.stringify(record) + '\n', {mode: 0o600});
  chmodSync(recordFile, 0o600);
  let damagedState = readOnlySnapshot(fixture.attemptId);
  for (const mode of ['status', 'verify']) {
    const result = runHost(mode);
    assert.notEqual(result.status, 0, `${mode} must reject a corrupt journal`);
    assert.match(failure(result), /EMERGENCY_HANDOFF_JOURNAL_(HASH_INVALID|INVALID)/);
    assert.deepEqual(readOnlySnapshot(fixture.attemptId), damagedState,
      `${mode} changed a corrupt journal`);
  }

  resetMutable();
  const foreignAuth = issueAuthorization(fixture.attemptId);
  const foreignRun = runHost('apply', {
    NODE_OPTIONS: '--import ' + join(import.meta.dirname, 'emergency-handoff-fault-preload.mjs'),
    SERVORA_EH_FAULT_POINT: 'journal-link-after',
  });
  assert.notEqual(foreignRun.status, 0);
  const foreignDirectory = join(P.EMERGENCY, foreignAuth.authorizationId);
  for (const name of readdirSync(foreignDirectory)) {
    if (name.startsWith('.')) unlinkSync(join(foreignDirectory, name));
  }
  const foreign = join(foreignDirectory, '.11111111-1111-4111-8111-111111111111.tmp');
  writeFileSync(foreign, 'foreign\n', {mode: 0o600});
  chmodSync(foreign, 0o600);
  chownSync(foreign, 1, 1);
  damagedState = readOnlySnapshot(fixture.attemptId);
  for (const mode of ['status', 'verify']) {
    const result = runHost(mode);
    assert.notEqual(result.status, 0, `${mode} must reject a foreign journal`);
    assert.match(failure(result), /EMERGENCY_HANDOFF_JOURNAL_INVALID/);
    assert.deepEqual(readOnlySnapshot(fixture.attemptId), damagedState,
      `${mode} changed a foreign journal`);
  }

  resetMutable();
  issueAuthorization(fixture.attemptId);
  writeFileSync(P.STATE + '/active.json', JSON.stringify({
    attemptId: '22222222-2222-4222-8222-222222222222',
    approvalSha256: '9'.repeat(64),
  }) + '\n', {mode: 0o600});
  chmodSync(P.STATE + '/active.json', 0o600);
  damagedState = readOnlySnapshot(fixture.attemptId);
  const foreignOwner = runHost('verify');
  assert.notEqual(foreignOwner.status, 0);
  assert.match(failure(foreignOwner), /EMERGENCY_HANDOFF_(LIVE_STATE_MISMATCH|OWNER_UNTRUSTED)/);
  assert.deepEqual(readOnlySnapshot(fixture.attemptId), damagedState);
});


test('HOST-15: read commands leave sealed checkpoint records byte-identical', () => {
  resetMutable();
  issueAuthorization(fixture.attemptId);
  const directory = join(P.STATE, 'attempts', fixture.attemptId);
  const residueName = '.11111111-1111-4111-8111-111111111111.tmp';
  const residue = join(directory, residueName);
  const records = () => readdirSync(directory).filter(name => /^\d{4}\.json$/.test(name)).sort()
    .map(name => ({name, sha256: hash(readFileSync(join(directory, name)))}));
  const beforeRecords = records();
  const seedResidue = () => {
    writeFileSync(residue, 'checkpoint residue\n', {mode: 0o600});
    chmodSync(residue, 0o600);
    chownSync(residue, 0, 0);
  };
  const facts = serviceFacts();
  const pid = Number(facts.MainPID);
  const start = processStart(pid);
  seedResidue();
  const verify = runHost('verify');
  assert.equal(verify.status, 0, verify.stderr);
  assert.equal(JSON.parse(verify.stdout.trim()).readOnly, true);
  assert.equal(existsSync(residue), false,
    'the canonical checkpoint reader completes only its own residue');
  assert.deepEqual(records(), beforeRecords, 'checkpoint record bytes changed');
  assert.deepEqual(serviceFacts(), facts, 'systemd state changed');
  assert.equal(processStart(pid), start, 'app process changed');

  seedResidue();
  const preflight = runHost('preflight', {}, ['--parent', fixture.attemptId]);
  assert.equal(preflight.status, 0, preflight.stderr);
  assert.equal(existsSync(residue), false);
  assert.deepEqual(records(), beforeRecords, 'checkpoint record bytes changed');
  assert.deepEqual(serviceFacts(), facts, 'systemd state changed');
  assert.equal(processStart(pid), start, 'app process changed');
});

test('HOST-16: resumed handoffs reject foreign ownership and damaged runtime before mutation', () => {
  resetMutable();
  issueAuthorization(fixture.attemptId);
  const interrupted = runHost('apply', {
    NODE_OPTIONS: '--import ' + join(import.meta.dirname, 'emergency-handoff-fault-preload.mjs'),
    SERVORA_EH_FAULT_POINT: 'barrier-unlink-after',
  });
  assert.notEqual(interrupted.status, 0);
  writeFileSync(P.STATE + '/active.json', JSON.stringify({
    attemptId: '22222222-2222-4222-8222-222222222222',
    approvalSha256: '9'.repeat(64),
  }) + '\n', {mode: 0o600});
  chmodSync(P.STATE + '/active.json', 0o600);
  const ownerSnapshot = readOnlySnapshot(fixture.attemptId);
  for (const mode of ['verify', 'apply']) {
    const result = runHost(mode);
    assert.notEqual(result.status, 0, `${mode} must reject a foreign owner`);
    assert.match(failure(result), /EMERGENCY_HANDOFF_OWNER_UNTRUSTED/);
    assert.deepEqual(readOnlySnapshot(fixture.attemptId), ownerSnapshot,
      `${mode} changed state before rejecting a foreign owner`);
  }

  resetMutable();
  issueAuthorization(fixture.attemptId);
  const pendingOwner = runHost('apply', {
    NODE_OPTIONS: '--import ' + join(import.meta.dirname, 'emergency-handoff-fault-preload.mjs'),
    SERVORA_EH_FAULT_POINT: 'policy-unlink-after',
  });
  assert.notEqual(pendingOwner.status, 0);
  assert.equal(serviceFacts().NeedDaemonReload, 'yes');
  writeFileSync(P.STATE + '/active.json', JSON.stringify({
    attemptId: '22222222-2222-4222-8222-222222222222',
    approvalSha256: '9'.repeat(64),
  }) + '\n', {mode: 0o600});
  chmodSync(P.STATE + '/active.json', 0o600);
  const pendingSnapshot = readOnlySnapshot(fixture.attemptId);
  for (const mode of ['verify', 'apply']) {
    const result = runHost(mode);
    assert.notEqual(result.status, 0, `${mode} must reject a foreign owner before reload`);
    assert.match(failure(result), /EMERGENCY_HANDOFF_OWNER_UNTRUSTED/);
    assert.equal(serviceFacts().NeedDaemonReload, 'yes',
      `${mode} reloaded systemd before the ownership check`);
    assert.deepEqual(readOnlySnapshot(fixture.attemptId), pendingSnapshot,
      `${mode} changed state before rejecting a foreign owner`);
  }

  resetMutable();
  const runtimeAuth = issueAuthorization(fixture.attemptId);
  const runtimeRun = runHost('apply', {
    NODE_OPTIONS: '--import ' + join(import.meta.dirname, 'emergency-handoff-fault-preload.mjs'),
    SERVORA_EH_FAULT_POINT: 'journal-link-after',
  });
  assert.notEqual(runtimeRun.status, 0);
  unlinkSync(join(P.EMERGENCY, runtimeAuth.authorizationId, 'runtime.json'));
  const runtimeSnapshot = readOnlySnapshot(fixture.attemptId);
  for (const mode of ['verify', 'apply']) {
    const result = runHost(mode);
    assert.notEqual(result.status, 0, `${mode} must reject a missing runtime`);
    assert.match(failure(result), /EMERGENCY_HANDOFF_RUNTIME_INVALID/);
    assert.deepEqual(readOnlySnapshot(fixture.attemptId), runtimeSnapshot,
      `${mode} changed state before rejecting a missing runtime`);
  }
});
