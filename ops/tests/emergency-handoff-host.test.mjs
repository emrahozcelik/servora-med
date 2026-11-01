// Host acceptance for the emergency restart-policy handoff.
// Runs only on the disposable Linux/amd64 + systemd + PostgreSQL 17 fixture.
import test, {before, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync, copyFileSync, existsSync, lstatSync, readFileSync, readdirSync, unlinkSync,
  writeFileSync, chmodSync,
} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {hostname} from 'node:os';
import {
  build, resetMutable, issueAuthorization, runHost, paths, serviceFacts,
  parentSnapshot, restoreCatalog, TARGET_SHA,
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

test('HOST-02: barrier-first handoff completes without restarting the app', () => {
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
  assert.match(failure(result), /EMERGENCY_HANDOFF_LIVE_STATE_MISMATCH/);
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
  assert.match(failure(result), /EMERGENCY_HANDOFF_(LIVE_STATE_MISMATCH|OTHER_AUTHORIZATION)/);
  assert.deepEqual(readdirSync(join(P.EMERGENCY, directories[0])).sort(), before);
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
