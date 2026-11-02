import test from 'node:test';
import assert from 'node:assert/strict';
import * as adapter from '../scripts/forward-host-driver.mjs';
import {fixture} from './forward-host-fixture.mjs';
import * as storage from '../scripts/forward-host-storage.mjs';
import {mkdtempSync, readdirSync, rmSync, realpathSync, mkdirSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as evidence from '../scripts/forward-host-evidence.mjs';
import {timeEvidenceAt} from './trusted-time-fixture.mjs';

test('adapter preflight is read-only and validates the forward authorization', async () => {
  const f = fixture();
  const result = await adapter.runForwardHost(f.io, f.authorization, 'preflight');
  assert.equal(result.readOnly, true);
  assert.equal(result.phase, 'READY');
  assert.deepEqual(f.log, []);
  assert.deepEqual(f.effects, []);
});

test('UNKNOWN trusted time denies fresh admission before any journal or owner mutation', async () => {
  const f = fixture();
  f.io.authorizationTime = async () => { throw new Error('TRUSTED_TIME_UNKNOWN'); };
  await assert.rejects(adapter.runForwardHost(f.io, f.authorization, 'apply'), /TRUSTED_TIME_UNKNOWN/);
  assert.deepEqual(f.log, []);
  assert.deepEqual(f.effects, []);
});

test('wall rollback cannot admit a grant expired by trusted elapsed time', async () => {
  const f = fixture();
  f.tick(5 * 3600_000);
  f.io.now = () => '2026-11-01T17:00:00Z';
  await assert.rejects(adapter.runForwardHost(f.io, f.authorization, 'apply'), /TIME_INVALID/);
  assert.deepEqual(f.log, []);
  assert.deepEqual(f.effects, []);
});

test('elapsed expiry denies an unspent START after crash and wall rollback', async () => {
  const f = fixture(), append = f.io.append;
  f.authorization.expiresAtUTC = '2026-11-01T17:05:00Z';
  f.io.append = record => {
    append(record);
    if (record.event === 'PHASE' && record.contract.phase === 'ACTIVATE_INTENT') throw new Error('CRASH_BEFORE_START');
  };
  await assert.rejects(adapter.runForwardHost(f.io, f.authorization, 'apply'), /CRASH_BEFORE_START/);
  f.io.append = append; f.tick(6 * 60_000);
  f.io.now = () => '2026-11-01T17:01:00Z';
  await assert.rejects(adapter.runForwardHost(f.io, f.authorization, 'apply'), /TIME_INVALID/);
  assert.equal(f.log.filter(r => r.event === 'START_INTENT').length, 0);
  assert.equal(f.effects.filter(e => e.operation === 'START').length, 0);
});

test('admission rechecks time after pre-publication checks and records no stale INTENT', async () => {
  const f = fixture(); let checks = 0;
  f.io.check = async () => {
    if (++checks === 2) f.io.authorizationTime = async () => { throw new Error('TRUSTED_TIME_UNKNOWN'); };
  };
  await assert.rejects(adapter.runForwardHost(f.io, f.authorization, 'apply'), /TRUSTED_TIME_UNKNOWN/);
  assert.equal(f.log.length, 0);
  assert.equal(f.effects.length, 0);
});

test('consumed journal status and known activation resume do not reopen an expired grant', async () => {
  const f = fixture(), append = f.io.append;
  f.io.append = record => {
    append(record);
    if (record.event === 'START_DONE') throw new Error('CRASH_AFTER_KNOWN_START');
  };
  await assert.rejects(adapter.runForwardHost(f.io, f.authorization, 'apply'), /CRASH_AFTER_KNOWN_START/);
  f.io.append = append; f.tick(5 * 3600_000);
  f.io.authorizationTime = async () => { throw new Error('TRUSTED_TIME_UNKNOWN'); };
  const original = structuredClone(f.log), effects = f.effects.length;
  assert.equal((await adapter.runForwardHost(f.io, f.authorization, 'status')).starts, 1);
  assert.deepEqual(f.log, original); assert.equal(f.effects.length, effects);
  assert.equal((await adapter.runForwardHost(f.io, f.authorization, 'apply')).phase, 'HEALTH_PASSED');
  assert.equal(f.effects.filter(e => e.operation === 'START').length, 1);
});

test('CI evidence refuses a PASS label with missing checks or files', () => {
  assert.throws(() => evidence.verifyForwardCI({schemaVersion: 2, result: 'PASS', checks: []},
    {releaseSha: 'a'.repeat(40), treeSha: 'b'.repeat(40)}, () => Buffer.from('')), /FORWARD_HOST_CI_INVALID/);
});

test('host journal publishes exclusively and read-only inspection preserves bytes and names', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'servora-forward-')));
  try {
    const f = fixture();
    await adapter.runForwardHost(f.io, f.authorization, 'apply');
    const journal = storage.openHostJournal(directory, {uid: process.getuid(), gid: process.getgid()});
    journal.append(f.log[0]);
    const names = readdirSync(directory);
    assert.deepEqual(journal.read(), [f.log[0]]);
    assert.deepEqual(readdirSync(directory), names);
    assert.throws(() => journal.append(f.log[0]), /EXISTS/);
  } finally { rmSync(directory, {recursive: true, force: true}); }
});

test('adapter stops OLD only after STOP_INTENT and switches only after OLD_STOPPED', async () => {
  const f = fixture();
  const result = await adapter.runForwardHost(f.io, f.authorization, 'apply');
  assert.equal(result.phase, 'HEALTH_PASSED');
  assert.equal(f.effects.find(e => e.operation === 'STOP').phase, 'STOP_INTENT');
  assert.equal(f.effects.find(e => e.operation === 'POINTER').phase, 'ACTIVATE_INTENT');
  assert.ok(f.log.find(e => e.contract.phase === 'OLD_STOPPED'));
  assert.equal(f.effects.filter(e => e.operation === 'START').length, 1);
  assert.equal(f.effects.find(e => e.operation === 'START').event, 'START_INTENT');
  assert.equal(f.log.at(-1).contract.migrationPerformed, false);
});

test('browser smoke is an explicit phase boundary before postdeploy backup', async () => {
  const f = fixture();
  await adapter.runForwardHost(f.io, f.authorization, 'apply');
  assert.equal(f.effects.some(e => e.operation === 'SMOKE'), false);
  const result = await adapter.runForwardHost(f.io, f.authorization, 'smoke');
  assert.equal(result.phase, 'POSTDEPLOY_BACKUP_PASSED');
  assert.equal(f.effects.find(e => e.operation === 'SMOKE').phase, 'HEALTH_PASSED');
  assert.equal(f.effects.find(e => e.operation === 'POST_BACKUP').phase, 'POSTDEPLOY_BACKUP_INTENT');
});

test('synthetic observation permits terminal handoff only after durable observation proof', async () => {
  const f = fixture();
  await adapter.runForwardHost(f.io, f.authorization, 'apply');
  await adapter.runForwardHost(f.io, f.authorization, 'smoke');
  f.io.effect = ((original) => async (op, data, log) => {
    if (op === 'OBSERVE') {
      const identity = await f.io.identity(), start = f.io.now();
      f.tick(1800_000);
      return {startedAtUTC: start, completedAtUTC: f.io.now(), seconds: 1800, samples: 61,
        pid: identity.pid, pidStartTime: identity.startTime, bootId: identity.bootId,
        endPid: identity.pid, endStartTime: identity.startTime, endBootId: identity.bootId};
    }
    // POLICY keeps the gate; HANDOFF releases it only after ACCEPTED.
    if (op === 'POLICY') return original('HANDOFF', data, log);
    return original(op, data, log);
  })(f.io.effect);
  const result = await adapter.runForwardHost(f.io, f.authorization, 'observe');
  assert.equal(result.phase, 'ACCEPTED');
  assert.equal(f.effects.find(e => e.operation === 'RETIRE').phase, 'ACCEPTED');
  assert.equal(f.log.at(-1).contract.parentAttemptCompleted, false);
  assert.equal(f.log.at(-1).event, 'RETIRE_DONE');
});

test('OLD_STOPPED resume revalidates predeploy backup before any activation mutation', async () => {
  const f = fixture(), original = f.io.append;
  f.io.append = record => {
    original(record);
    if (record.event === 'PHASE' && record.contract.phase === 'OLD_STOPPED') throw new Error('FIXTURE_CRASH');
  };
  await assert.rejects(adapter.runForwardHost(f.io, f.authorization, 'apply'), /FIXTURE_CRASH/);
  f.io.append = original;
  f.io.verifyBackups = async () => { throw new Error('BACKUP_LOST_OR_REBOOTED'); };
  await assert.rejects(adapter.runForwardHost(f.io, f.authorization, 'apply'), /BACKUP_LOST_OR_REBOOTED/);
  assert.equal(f.effects.filter(e => ['ENV', 'POINTER', 'START'].includes(e.operation)).length, 0);
});

for (const phase of ['STOP_INTENT', 'OLD_STOPPED', 'ACTIVATE_INTENT']) {
  test('durable crash after ' + phase + ' resumes without duplicate TARGET start', async () => {
    const f = fixture(), append = f.io.append;
    f.io.append = record => { append(record); if (record.event === 'PHASE' && record.contract.phase === phase) throw new Error('FIXTURE_CRASH'); };
    await assert.rejects(adapter.runForwardHost(f.io, f.authorization, 'apply'), /FIXTURE_CRASH/);
    f.io.append = append;
    await adapter.runForwardHost(f.io, f.authorization, 'apply');
    assert.equal(f.effects.filter(e => e.operation === 'START').length, 1);
  });
}
test('unknown START_INTENT outcome consumes the slot and never starts again', async () => {
  const f = fixture(), append = f.io.append;
  f.io.append = record => { append(record); if (record.event === 'START_INTENT') throw new Error('FIXTURE_CRASH'); };
  await assert.rejects(adapter.runForwardHost(f.io, f.authorization, 'apply'), /FIXTURE_CRASH/);
  f.io.append = append;
  const pending = adapter.validateHostLog(f.log, f.authorization, f.log[0].authorizationSha256, f.io.toolHash).pending;
  assert.equal(pending.hash, f.log.at(-1).hash);
  await assert.rejects(adapter.runForwardHost(f.io, f.authorization, 'apply'), /OUTCOME_UNKNOWN/);
  assert.equal(f.effects.filter(e => e.operation === 'START').length, 0);
  assert.equal(f.log.filter(r => r.event === 'START_INTENT').length, 1);
});
test('health failure cannot publish terminal acceptance', async () => {
  const f = fixture();
  f.io.verifyTarget = async () => { throw new Error('TARGET_HEALTH_FAILED'); };
  await assert.rejects(adapter.runForwardHost(f.io, f.authorization, 'apply'), /TARGET_HEALTH_FAILED/);
  assert.equal(f.log.at(-1).contract.phase, 'TARGET_ACTIVATED');
  assert.equal(f.log.some(r => r.contract.acceptance !== null), false);
});
test('foreign owner, wrong DB and wrong artifact/CI never reach admission', async () => {
  for (const mutate of [ctx => ctx.host.activeOwnerIds.push('foreign'), ctx => { ctx.host.database = {...ctx.host.database, clusterId: '456'}; },
    ctx => { ctx.target = {...ctx.target, artifactSha256: '8'.repeat(64)}; }, ctx => { ctx.target = {...ctx.target, ciManifestSha256: '8'.repeat(64)}; }]) {
    const f = fixture(), context = f.io.context;
    f.io.context = async () => { const ctx = await context(); mutate(ctx); return ctx; };
    await assert.rejects(adapter.runForwardHost(f.io, f.authorization, 'apply'));
    assert.deepEqual(f.log, []); assert.deepEqual(f.effects, []);
  }
});
test('journal hash drift and foreign tool cannot resume', async () => {
  const f = fixture(); await adapter.runForwardHost(f.io, f.authorization, 'apply');
  f.io.toolHash = '8'.repeat(64);
  await assert.rejects(adapter.runForwardHost(f.io, f.authorization, 'apply'), /JOURNAL_INVALID/);
});
function proofFixture() {
  const identity = {pid: 101, startTime: '234', bootId: '11111111-1111-4111-8111-111111111111', invocationId: 'a'.repeat(32)};
  const expected = {attemptId: 'attempt', authorizationSha256: 'a'.repeat(64), anchor: 'b'.repeat(64),
    backupReceiptSha256: 'c'.repeat(64), identity, releaseSha: 'd'.repeat(40), schemaHead: '060_crm_duplicate_review_decisions'};
  const samples = [];
  for (let i = 0; i <= 60; i++) samples.push(evidence.seal({index: i, previousHash: samples.at(-1)?.hash ?? null,
    time: timeEvidenceAt(Date.parse('2026-11-01T17:00:00Z') + i * 30000), monotonicNs: String(i * 30_000_000_000),
    identity, releaseSha: expected.releaseSha, schemaHead: expected.schemaHead, health: true, backupHealth: true}));
  expected.now = samples.at(-1).time;
  return {proof: evidence.seal({kind: 'FORWARD_HOST_OBSERVATION', ...Object.fromEntries(['attemptId', 'authorizationSha256', 'anchor', 'backupReceiptSha256', 'identity'].map(k => [k, expected[k]])), samples}), expected};
}
test('observation verifier rejects fake elapsed, short proof, stale journal, PID/start-time/boot drift', () => {
  const {proof, expected} = proofFixture();
  assert.equal(evidence.verifyObservationProof(proof, expected).seconds, 1800);
  for (const change of [e => { e.identity = {...e.identity, pid: 999}; }, e => { e.identity = {...e.identity, startTime: '345'}; },
    e => { e.identity = {...e.identity, bootId: '22222222-2222-4222-8222-222222222222'}; }, e => { e.anchor = 'f'.repeat(64); },
    e => { e.now = timeEvidenceAt(Date.parse(expected.now.wallAtUTC) + 61000); }]) {
    const altered = structuredClone(expected); change(altered);
    assert.throws(() => evidence.verifyObservationProof(proof, altered), /OBSERVATION/);
  }
  const short = {...proof}; delete short.hash; short.samples = short.samples.slice(0, 60);
  assert.throws(() => evidence.verifyObservationProof(evidence.seal(short), expected), /OBSERVATION/);
  const fake = {...proof}; delete fake.hash;
  fake.samples = [];
  for (const sample of proof.samples) { const body = {...sample}; delete body.hash; body.monotonicNs = '0'; body.previousHash = fake.samples.at(-1)?.hash ?? null; fake.samples.push(evidence.seal(body)); }
  assert.throws(() => evidence.verifyObservationProof(evidence.seal(fake), expected), /OBSERVATION/);
});
test('early finish never publishes acceptance or retires owner', async () => {
  const f = fixture(); await adapter.runForwardHost(f.io, f.authorization, 'apply');
  await assert.rejects(adapter.runForwardHost(f.io, f.authorization, 'finish'), /PHASE_CONFLICT/);
  assert.equal(f.effects.some(e => e.operation === 'RETIRE'), false);
});
test('apply cannot enter observation after an interrupted explicit observation boundary', async () => {
  const f = fixture();
  await adapter.runForwardHost(f.io, f.authorization, 'apply');
  await adapter.runForwardHost(f.io, f.authorization, 'smoke');
  const append = f.io.append;
  f.io.append = record => { append(record); if (record.event === 'PHASE' && record.contract.phase === 'OBSERVATION_STARTED') throw new Error('FIXTURE_CRASH'); };
  await assert.rejects(adapter.runForwardHost(f.io, f.authorization, 'observe'), /FIXTURE_CRASH/);
  f.io.append = append;
  await assert.rejects(adapter.runForwardHost(f.io, f.authorization, 'apply'), /PHASE_CONFLICT/);
});
test('service UID probe refuses a transitive pg dependency resolved outside the sealed release', () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'servora-forward-deps-')));
  try {
    mkdirSync(directory + '/release/server/node_modules/first', {recursive: true});
    mkdirSync(directory + '/node_modules/second', {recursive: true});
    writeFileSync(directory + '/release/server/node_modules/first/index.js', 'module.exports = require("second");');
    writeFileSync(directory + '/node_modules/second/index.js', 'process.stdout.write("UNBOUND_CODE_EXECUTED");');
    const probe = new URL('../scripts/forward-host-probe.mjs', import.meta.url).href;
    const code = `import {restrictReleaseRequires} from ${JSON.stringify(probe)}; import {createRequire} from 'node:module'; restrictReleaseRequires(${JSON.stringify(directory + '/release')}); createRequire(${JSON.stringify(directory + '/release/server/package.json')})('first');`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {encoding: 'utf8'});
    assert.notEqual(result.status, 0); assert.match(result.stderr, /FORWARD_HOST_DB_DEPENDENCY_UNBOUND/);
    assert.equal(result.stdout.includes('UNBOUND_CODE_EXECUTED'), false);
  } finally { rmSync(directory, {recursive: true, force: true}); }
});
test('an exhausted start budget cannot append another slot even with a valid hash chain', async () => {
  const f = fixture(); f.authorization.budgets.maxStarts = 1;
  await adapter.runForwardHost(f.io, f.authorization, 'apply');
  const index = f.log.findIndex(r => r.event === 'START_DONE');
  const chain = f.log.slice(0, index + 1), last = chain.at(-1);
  const body = {...last, sequence: chain.length, previousHash: last.hash, event: 'START_INTENT', data: {slot: 2}}; delete body.hash;
  assert.throws(() => adapter.validateHostLog([...chain, evidence.seal(body)], f.authorization,
    chain[0].authorizationSha256, f.io.toolHash), /START_BUDGET_EXHAUSTED/);
});
test('TARGET start requires a durable collector handoff bound to ACTIVATE_INTENT', async () => {
  const f = fixture(); await adapter.runForwardHost(f.io, f.authorization, 'apply');
  const collector = f.effects.find(e => e.operation === 'COLLECTOR');
  assert.equal(collector?.phase, 'ACTIVATE_INTENT');
  assert.equal(collector?.event, 'COLLECTOR_INTENT');
  assert.ok(f.effects.indexOf(collector) < f.effects.findIndex(e => e.operation === 'START'));
});
test('accepted crash recovery releases guards before requiring live runtime health', async () => {
  const f = fixture(); await adapter.runForwardHost(f.io, f.authorization, 'apply');
  await adapter.runForwardHost(f.io, f.authorization, 'smoke');
  const effect = f.io.effect, append = f.io.append;
  let handed = false;
  f.io.effect = async (op, data, log) => {
    if (op === 'OBSERVE') {
      const i = await f.io.identity(), start = f.io.now(); f.tick(1800_000);
      return {startedAtUTC: start, completedAtUTC: f.io.now(), seconds: 1800, samples: 61,
        pid: i.pid, pidStartTime: i.startTime, bootId: i.bootId, endPid: i.pid, endStartTime: i.startTime, endBootId: i.bootId};
    }
    if (op === 'POLICY') return effect('HANDOFF', data, log);
    if (op === 'HANDOFF') handed = true;
    return effect(op, data, log);
  };
  f.io.append = record => { append(record); if (record.event === 'PHASE' && record.contract.phase === 'ACCEPTED') throw new Error('CRASH_AFTER_ACCEPTED'); };
  await assert.rejects(adapter.runForwardHost(f.io, f.authorization, 'observe'), /CRASH_AFTER_ACCEPTED/);
  f.io.append = append;
  f.io.verifyTarget = async () => { if (!handed) throw new Error('RUNTIME_DOWN_UNTIL_HANDBACK'); };
  const result = await adapter.runForwardHost(f.io, f.authorization, 'finish');
  assert.equal(result.ownerRetired, true);
  assert.equal(f.log.filter(r => r.event === 'START_INTENT').length, 1);
});

function syntheticObservation(f) {
  const effect = f.io.effect;
  f.io.effect = async (op, data, log) => {
    if (op === 'OBSERVE') {
      const identity = await f.io.identity(), startedAtUTC = f.io.now(); f.tick(1800_000);
      return {startedAtUTC, completedAtUTC: f.io.now(), seconds: 1800, samples: 61,
        pid: identity.pid, pidStartTime: identity.startTime, bootId: identity.bootId,
        endPid: identity.pid, endStartTime: identity.startTime, endBootId: identity.bootId};
    }
    if (op === 'POLICY') return effect('HANDOFF', data, log);
    return effect(op, data, log);
  };
}
for (const failure of ['TRUSTED_TIME_UNKNOWN', 'FORWARD_HOST_BACKUP_HEALTH_FAILED',
  'FORWARD_HOST_PROCESS_CHANGED', 'FORWARD_HOST_OBSERVATION_INTERRUPTED', 'PROOF_WRITE_INTERRUPTED']) {
  test('synthetic observation failure ' + failure + ' retains owner and spent budget without acceptance', async () => {
    const f = fixture(); await adapter.runForwardHost(f.io, f.authorization, 'apply');
    await adapter.runForwardHost(f.io, f.authorization, 'smoke');
    const effect = f.io.effect;
    f.io.effect = async (op, data, log) => { if (op === 'OBSERVE') throw new Error(failure); return effect(op, data, log); };
    await assert.rejects(adapter.runForwardHost(f.io, f.authorization, 'observe'), new RegExp(failure));
    const state = adapter.validateHostLog(f.log, f.authorization, f.log[0].authorizationSha256, f.io.toolHash);
    assert.equal(state.starts, 1); assert.equal(state.pending.event, 'OBSERVE_INTENT');
    assert.equal(state.contract.acceptance, null);
    const context = await f.io.context(); assert.equal(context.host.restartPolicy, 'no');
    assert.deepEqual(context.host.activeOwnerIds, [f.authorization.attemptId]);
    assert.equal(f.effects.some(e => ['POLICY', 'HANDOFF', 'RETIRE'].includes(e.operation)), false);
  });
}
test('ACCEPTED before policy restoration is structurally impossible', async () => {
  const f = fixture(); await adapter.runForwardHost(f.io, f.authorization, 'apply');
  await adapter.runForwardHost(f.io, f.authorization, 'smoke'); syntheticObservation(f);
  const effect = f.io.effect;
  f.io.effect = async (op, data, log) => { if (op === 'POLICY') throw new Error('POLICY_RESTORE_CRASH'); return effect(op, data, log); };
  await assert.rejects(adapter.runForwardHost(f.io, f.authorization, 'observe'), /POLICY_RESTORE_CRASH/);
  assert.equal(f.log.at(-1).contract.phase, 'OBSERVATION_PASSED');
  assert.equal(f.log.some(r => r.contract.phase === 'ACCEPTED'), false);
  assert.equal((await f.io.context()).host.restartPolicy, 'no');
});
for (const event of ['POLICY_DONE', 'HANDOFF_INTENT', 'HANDOFF_DONE', 'RETIRE_INTENT', 'RETIRE_DONE']) {
  test('synthetic terminal crash after ' + event + ' retains one activation and resumes without another observation', async () => {
    const f = fixture(); await adapter.runForwardHost(f.io, f.authorization, 'apply');
    await adapter.runForwardHost(f.io, f.authorization, 'smoke'); syntheticObservation(f);
    const append = f.io.append;
    f.io.append = record => { append(record); if (record.event === event) throw new Error('TERMINAL_CRASH'); };
    await assert.rejects(adapter.runForwardHost(f.io, f.authorization, 'observe'), /TERMINAL_CRASH/);
    f.io.append = append;
    f.io.reconcile = async (op, pending, log) => {
      if (!['HANDOFF', 'RETIRE'].includes(op)) throw new Error('UNSUPPORTED_RESUME');
      return f.io.effect(op, pending.data, log);
    };
    const result = await adapter.runForwardHost(f.io, f.authorization, 'finish');
    assert.equal(result.ownerRetired, true); assert.equal(result.starts, 1);
    assert.equal(f.log.filter(r => r.event === 'OBSERVE_INTENT').length, 1);
    assert.equal(f.log.filter(r => r.event === 'START_INTENT').length, 1);
    adapter.validateHostLog(f.log, f.authorization, f.log[0].authorizationSha256, f.io.toolHash);
  });
}
