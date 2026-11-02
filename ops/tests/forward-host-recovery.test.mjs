import test from 'node:test';
import assert from 'node:assert/strict';
import * as recovery from '../scripts/forward-host-recovery.mjs';
import {runForwardHost} from '../scripts/forward-host-driver.mjs';
import {fixture, hash} from './forward-host-fixture.mjs';
import {seal} from '../scripts/forward-host-evidence.mjs';

const digest = value => hash(JSON.stringify(value) + '\n');
async function recoveryFixture() {
  const f = fixture(); await runForwardHost(f.io, f.authorization, 'apply');
  await runForwardHost(f.io, f.authorization, 'smoke');
  const records = [], effects = [], identity = await f.io.identity();
  const snapshot = {identity, releaseSha: f.authorization.target.releaseSha,
    pointerSha: f.authorization.target.releaseSha, environmentSha: f.authorization.target.releaseSha,
    bootId: identity.bootId, health: 'PASS', schema: 'PASS', backupHealth: 'FAIL', trustedTime: 'UNKNOWN',
    owner: true, barrier: true, gate: true, restart: 'no', backupIntegrity: 'VALID'};
  const grant = {formatVersion: 1, kind: 'FORWARD_FAILURE_RECOVERY_AUTHORIZATION',
    authorizationId: '55555555-5555-4555-8555-555555555555', attemptId: f.authorization.attemptId,
    scope: 'FORWARD_FAILURE_RECOVERY', mode: 'RESTORE_HEALTHY_TARGET', onFailure: 'CLOSE_FENCED', maxUses: 1,
    bootId: snapshot.bootId, issuedUptimeMs: 0, expiresUptimeMs: 3600_000,
    issuedAtUTC: f.io.now(), expiresAtUTC: '2026-11-01T18:00:00Z', reason: 'FIXTURE_RECOVERY',
    deploymentAuthorizationSha256: digest(f.authorization), deploymentJournalHeadSha256: f.log.at(-1).hash,
    toolHash: f.io.toolHash, snapshotSha256: digest(snapshot)};
  Object.assign(f.io, {
    recoveryContext: async () => ({snapshot: structuredClone(snapshot), deploymentLog: f.io.readLog(),
      uptimeMs: Date.parse(f.io.now()) - Date.parse('2026-11-01T17:00:00Z')}),
    readRecoveryLog: () => structuredClone(records),
    appendRecovery: record => records.push(structuredClone(record)),
    recoveryEffect: async (op, data, log) => {
      effects.push({op, event: log.at(-1).event, snapshot: structuredClone(snapshot)});
      if (op === 'POLICY') snapshot.restart = 'on-failure';
      if (op === 'HANDOFF') { snapshot.gate = false; snapshot.barrier = false; }
      if (op === 'RETIRE') snapshot.owner = false;
      if (op === 'FENCE') { snapshot.restart = 'no'; snapshot.barrier = true; snapshot.gate = true; }
      if (op === 'QUIESCE') snapshot.identity = null;
      return op === 'SEAL' ? {receipt: data.receipt} : {op, identity: snapshot.identity};
    },
    reconcileRecovery: async (op, data, log) => f.io.recoveryEffect(op, data, log),
  });
  return {...f, snapshot, grant, records, recoveryEffects: effects};
}

test('healthy interrupted observation requires a separate root grant and ends NOT_ACCEPTED', async () => {
  const f = await recoveryFixture(), original = structuredClone(f.log);
  const result = await recovery.runFailureRecovery(f.io, f.authorization, f.grant, 'recover');
  assert.equal(result.outcome, 'FORWARD_TARGET_POLICY_RESTORED_NOT_ACCEPTED');
  assert.equal(result.accepted, false); assert.equal(result.productionGo, false);
  assert.equal(f.snapshot.restart, 'on-failure'); assert.equal(f.snapshot.owner, false);
  assert.equal(f.snapshot.barrier, false); assert.equal(f.snapshot.gate, false);
  assert.deepEqual(f.log, original);
  const sealIndex = f.records.findIndex(r => r.event === 'SEAL_DONE');
  assert.ok(sealIndex >= 0 && sealIndex < f.records.findIndex(r => r.event === 'HANDOFF_INTENT'));
  assert.equal(f.records[sealIndex].data.receipt.evidence.backupHealth, 'FAIL');
  assert.equal(f.records[sealIndex].data.receipt.evidence.trustedTime, 'UNKNOWN');
});

test('recovery INTENT permanently prevents the consumed deployment grant from resuming', async () => {
  const f = await recoveryFixture(), append = f.io.appendRecovery;
  f.io.appendRecovery = record => { append(record); throw new Error('CRASH_RECOVERY_ADMISSION'); };
  await assert.rejects(recovery.runFailureRecovery(f.io, f.authorization, f.grant, 'recover'), /CRASH_RECOVERY_ADMISSION/);
  f.io.recoveryStarted = () => f.records.length > 0;
  await assert.rejects(runForwardHost(f.io, f.authorization, 'observe'), /RECOVERY_OWNS_ATTEMPT/);
});

test('recovery journal rejects a foreign grant embedded under another grant digest', async () => {
  const f = await recoveryFixture();
  await recovery.runFailureRecovery(f.io, f.authorization, f.grant, 'recover');
  const log = structuredClone(f.records.slice(0, 1));
  log[0].data.grant.authorizationId = '66666666-6666-4666-8666-666666666666';
  const body = {...log[0]}; delete body.hash; log[0] = seal(body);
  assert.throws(() => recovery.validateRecoveryLog(log, f.grant, f.authorization, f.log, f.io.toolHash), /JOURNAL_INVALID/);
});

test('read-only recovery status cannot consume authorization or mutate deployment state', async () => {
  const f = await recoveryFixture(), original = structuredClone(f.log);
  const result = await recovery.runFailureRecovery(f.io, f.authorization, f.grant, 'recovery-status');
  assert.equal(result.readOnly, true); assert.equal(result.recoveryPhase, 'READY');
  assert.deepEqual(f.records, []); assert.deepEqual(f.recoveryEffects, []); assert.deepEqual(f.log, original);
});

test('wrong grant, DB/artifact binding, expiry and healthy-process drift deny recovery admission', async () => {
  for (const change of [f => { f.grant.deploymentAuthorizationSha256 = '0'.repeat(64); },
    f => { f.grant.deploymentJournalHeadSha256 = '0'.repeat(64); },
    f => { f.grant.toolHash = '0'.repeat(64); }, f => { f.grant.scope = 'EMERGENCY_HANDOFF'; },
    f => { f.grant.maxUses = 2; }, f => { f.tick(3600_000); },
    f => { f.grant.mode = 'RELEASE_UNCHANGED_OLD'; },
    f => { f.grant.mode = 'constructor'; },
    f => { f.grant.bootId = 'foreign-boot'; },
    f => { f.snapshot.identity.pid++; f.grant.snapshotSha256 = digest(f.snapshot); },
    f => { f.snapshot.health = 'FAIL'; f.grant.snapshotSha256 = digest(f.snapshot); },
    f => { f.snapshot.schema = 'FAIL'; f.grant.snapshotSha256 = digest(f.snapshot); },
    f => { f.snapshot.backupIntegrity = 'INVALID'; f.grant.snapshotSha256 = digest(f.snapshot); },
    f => { f.snapshot.pointerSha = f.authorization.old.releaseSha; f.grant.snapshotSha256 = digest(f.snapshot); }]) {
    const f = await recoveryFixture(); change(f);
    await assert.rejects(recovery.runFailureRecovery(f.io, f.authorization, f.grant, 'recover'), /RECOVERY_/);
    assert.deepEqual(f.records, []); assert.deepEqual(f.recoveryEffects, []);
  }
});

test('failed TARGET can only close fenced without acceptance, owner retirement or another slot', async () => {
  const f = await recoveryFixture(), original = structuredClone(f.log);
  f.snapshot.identity = null; f.snapshot.health = 'FAIL'; f.grant.mode = 'CLOSE_FENCED';
  f.grant.snapshotSha256 = digest(f.snapshot);
  const result = await recovery.runFailureRecovery(f.io, f.authorization, f.grant, 'recover');
  assert.equal(result.outcome, 'FORWARD_FAILURE_FENCED_NOT_ACCEPTED');
  assert.equal(result.ownerRetired, false); assert.equal(f.snapshot.owner, true);
  assert.equal(f.snapshot.restart, 'no'); assert.equal(f.snapshot.barrier, true);
  assert.deepEqual(f.recoveryEffects.map(e => e.op), ['FENCE', 'QUIESCE', 'SEAL']);
  assert.deepEqual(f.log, original);
});

for (const event of ['INTENT', 'POLICY_INTENT', 'POLICY_DONE', 'SEAL_INTENT', 'SEAL_DONE',
  'HANDOFF_INTENT', 'HANDOFF_DONE', 'RETIRE_INTENT', 'RETIRE_DONE', 'FINAL']) {
  test('recovery crash after ' + event + ' resumes its intent and never changes deployment slots', async () => {
    const f = await recoveryFixture(), append = f.io.appendRecovery, original = structuredClone(f.log);
    f.io.appendRecovery = record => { append(record); if (record.event === event) throw new Error('FIXTURE_CRASH'); };
    await assert.rejects(recovery.runFailureRecovery(f.io, f.authorization, f.grant, 'recover'), /FIXTURE_CRASH/);
    f.io.appendRecovery = append; f.tick(7200_000); // consumed expiry cannot reset/regrant authority
    const result = await recovery.runFailureRecovery(f.io, f.authorization, f.grant, 'recover');
    assert.equal(result.ownerRetired, true); assert.deepEqual(f.log, original);
    assert.equal(f.records.at(-1).event, 'FINAL');
  });
}

test('separate grant explicitly closes fenced if healthy restoration loses its process', async () => {
  const f = await recoveryFixture(), effect = f.io.recoveryEffect;
  f.io.recoveryEffect = async (op, data, log) => {
    if (op === 'POLICY') { f.snapshot.identity = null; throw new Error('FORWARD_HOST_PROCESS_CHANGED'); }
    return effect(op, data, log);
  };
  const result = await recovery.runFailureRecovery(f.io, f.authorization, f.grant, 'recover');
  assert.equal(result.outcome, 'FORWARD_FAILURE_FENCED_NOT_ACCEPTED');
  assert.equal(result.ownerRetired, false); assert.equal(f.snapshot.restart, 'no');
  assert.equal(f.records.some(r => r.event === 'FALLBACK_INTENT'), true);
});

test('UNKNOWN trusted time cannot extend the separate grant boot/monotonic admission window', async () => {
  const f = await recoveryFixture();
  const context = f.io.recoveryContext;
  f.io.recoveryContext = async () => ({...await context(), uptimeMs: f.grant.expiresUptimeMs});
  await assert.rejects(recovery.runFailureRecovery(f.io, f.authorization, f.grant, 'recover'), /WINDOW_EXPIRED/);
  assert.deepEqual(f.records, []); assert.deepEqual(f.recoveryEffects, []);
});

test('separate root approval can release an unchanged healthy OLD after pre-stop backup failure', async () => {
  const f = fixture(), effect = f.io.effect;
  f.io.effect = async (op, data, log) => {
    if (op === 'PRE_BACKUP') throw new Error('BACKUP_FAILURE_BEFORE_STOP');
    return effect(op, data, log);
  };
  await assert.rejects(runForwardHost(f.io, f.authorization, 'apply'), /BACKUP_FAILURE_BEFORE_STOP/);
  const prepared = await recoveryFixture();
  // Reuse only the synthetic recovery port; bind it to this pre-stop journal.
  const snapshot = {...prepared.snapshot, identity: await f.io.identity(), releaseSha: f.authorization.old.releaseSha,
    pointerSha: f.authorization.old.releaseSha, environmentSha: f.authorization.old.releaseSha,
    gate: false, barrier: false, restart: 'on-failure', backupIntegrity: 'INVALID'};
  const grant = {...prepared.grant, mode: 'RELEASE_UNCHANGED_OLD', deploymentJournalHeadSha256: f.log.at(-1).hash,
    snapshotSha256: digest(snapshot)};
  prepared.io.recoveryContext = async () => ({snapshot, deploymentLog: f.io.readLog(), uptimeMs: 0});
  prepared.io.readLog = f.io.readLog;
  const result = await recovery.runFailureRecovery(prepared.io, f.authorization, grant, 'recover');
  assert.equal(result.outcome, 'FORWARD_UNCHANGED_OLD_RELEASED_NOT_ACCEPTED');
  assert.equal(result.ownerRetired, true);
  assert.deepEqual(prepared.recoveryEffects.map(e => e.op), ['SEAL', 'RETIRE']);
  assert.equal(f.log.some(r => r.contract.phase === 'STOP_INTENT'), false);
  assert.equal(f.log.some(r => r.event === 'START_INTENT'), false);
});
