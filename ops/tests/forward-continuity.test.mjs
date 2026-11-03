import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {
  COLLECTOR_DRAIN_MS, COLLECTOR_INSTANCE_MAX_MS, assertCollectorDrainBound,
  collectorText, collectorExpectation, collectorSwitchPlan, isContinuity,
  preserveAttemptAuthorization, assertNoLineageFork, atomicReplaceFile,
} from '../scripts/forward-host-continuity.mjs';
import {CONTINUITY_KIND, CONTINUITY_SCOPE} from '../scripts/forward-transition.mjs';

const h = c => c.repeat(64);
const digest = value => createHash('sha256').update(value).digest('hex');
const LIVE = 'c8efe8a7999f879683a62454ff74b2b649c4dee3';
const VERSIONED = '/usr/local/libexec/servora-med-forward-tools/' + 'a'.repeat(64);
const legacyGrant = (overrides = {}) => ({kind: 'FORWARD_TRANSITION_AUTHORIZATION', ...overrides});
const continuityGrant = (overrides = {}) => ({
  kind: CONTINUITY_KIND, lineage: {predecessorCollectorPath: '/usr/local/libexec/servora-med-forward/trusted-time.mjs',
    predecessorCollectorModuleSha256: h('1')}, ...overrides,
});

test('CONT-H01: collector expectations keep v2 legacy, continuity predecessor and target distinct', () => {
  const target = h('2');
  const v2 = collectorExpectation(legacyGrant(), {complete: false, toolDir: VERSIONED, targetModule: target,
    installed: '/usr/local/libexec/servora-med'});
  assert.equal(v2.path, '/usr/local/libexec/servora-med/trusted-time.mjs');
  assert.equal(v2.dropin, false);
  const pre = collectorExpectation(continuityGrant(), {complete: false, toolDir: VERSIONED, targetModule: target,
    installed: '/usr/local/libexec/servora-med'});
  assert.equal(pre.path, '/usr/local/libexec/servora-med-forward/trusted-time.mjs');
  assert.equal(pre.dropin, true);
  assert.equal(pre.text, collectorText('/usr/local/libexec/servora-med-forward'));
  const post = collectorExpectation(continuityGrant(), {complete: true, toolDir: VERSIONED, targetModule: target,
    installed: '/usr/local/libexec/servora-med'});
  assert.equal(post.path, VERSIONED + '/trusted-time.mjs');
  assert.equal(post.moduleSha256, target);
  assert.equal(post.text, collectorText(VERSIONED));
});

test('CONT-H02: the collector switch is atomic in decision and never overwrites unknown content', () => {
  const oldText = collectorText('/usr/local/libexec/servora-med-forward');
  const newText = collectorText(VERSIONED);
  assert.deepEqual(collectorSwitchPlan({currentText: oldText, oldText, newText}), {write: true, reload: true});
  assert.deepEqual(collectorSwitchPlan({currentText: newText, oldText, newText}), {write: false, reload: false});
  assert.deepEqual(collectorSwitchPlan({currentText: null, oldText: null, newText}), {write: true, reload: true});
  assert.throws(() => collectorSwitchPlan({currentText: 'foreign', oldText, newText}), /COLLECTOR_UNIT_DRIFT/);
});

test('CONT-H03: the drain bound covers the sealed instance lifetime', () => {
  assert.equal(COLLECTOR_DRAIN_MS, 4500);
  assert.equal(COLLECTOR_INSTANCE_MAX_MS, 4000);
  assert.ok(COLLECTOR_DRAIN_MS > COLLECTOR_INSTANCE_MAX_MS);
  assert.equal(assertCollectorDrainBound(), 4500);
});

test('CONT-H04: predecessor authorization preservation is exact, exclusive and idempotent', t => {
  const root = mkdtempSync(join(tmpdir(), 'servora-cont-copy-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const source = join(root, 'source.json'), destination = join(root, 'attempt', 'authorization.json');
  const attempt = '11111111-1111-4111-8111-111111111111';
  const bytes = Buffer.from(JSON.stringify({attemptId: attempt, kind: 'FORWARD_CONTINUITY_TEST'}) + '\n');
  writeFileSync(source, bytes);
  const read = path => readFileSync(path);
  const publish = (path, value, mode) => writeFileSync(path, value, {mode});
  const validate = () => {};
  mkdirSync(join(root, 'attempt'));
  assert.equal(preserveAttemptAuthorization({source, destination, expectedSha: digest(bytes), attemptId: attempt,
    read, publish, validate}), true);
  assert.deepEqual(readFileSync(destination), bytes);
  assert.equal(preserveAttemptAuthorization({source, destination, expectedSha: digest(bytes), attemptId: attempt,
    read, publish, validate}), false);
  assert.throws(() => preserveAttemptAuthorization({source, destination, expectedSha: digest(bytes),
    attemptId: '22222222-2222-4222-8222-222222222222', read, publish, validate}),
    /LINEAGE_AUTHORIZATION_DRIFT/);
  writeFileSync(destination, 'foreign');
  assert.throws(() => preserveAttemptAuthorization({source, destination, expectedSha: digest(bytes), attemptId: attempt,
    read, publish, validate}), /LINEAGE_AUTHORIZATION_DRIFT/);
  assert.throws(() => preserveAttemptAuthorization({source, destination: join(root, 'x'), expectedSha: h('0'),
    attemptId: attempt, read, publish, validate}), /LINEAGE_AUTHORIZATION_DRIFT/);
});

test('CONT-H05: two continuity attempts cannot fork from the same predecessor', t => {
  const root = mkdtempSync(join(tmpdir(), 'servora-cont-fork-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const current = '11111111-1111-4111-8111-111111111111';
  const other = '22222222-2222-4222-8222-222222222222';
  const predecessor = '33333333-3333-4333-8333-333333333333';
  mkdirSync(join(root, current)); mkdirSync(join(root, other));
  const grant = (attempt, pred = predecessor) => JSON.stringify(continuityGrant({attemptId: attempt,
    lineage: {predecessorAttemptId: pred, predecessorCollectorPath: '/usr/local/libexec/servora-med-forward/trusted-time.mjs',
      predecessorCollectorModuleSha256: h('1')}}));
  const files = new Map([[join(root, other, 'authorization.json'), grant(other)]]);
  const list = () => [current, other];
  const read = path => files.get(path);
  const exists = path => files.has(path);
  assert.throws(() => assertNoLineageFork({root, authorization: JSON.parse(grant(current)), list, read, exists}),
    /FORWARD_HOST_LINEAGE_FORK/);
  files.set(join(root, other, 'authorization.json'), grant('44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555'));
  assert.doesNotThrow(() => assertNoLineageFork({root, authorization: JSON.parse(grant(current)), list, read, exists}));
  files.set(join(root, other, 'authorization.json'), JSON.stringify(legacyGrant({attemptId: other})));
  assert.doesNotThrow(() => assertNoLineageFork({root, authorization: JSON.parse(grant(current)), list, read, exists}));
  assert.equal(isContinuity({kind: CONTINUITY_KIND}), true);
  assert.equal(isContinuity({kind: 'FORWARD_TRANSITION_AUTHORIZATION'}), false);
});

test('CONT-H06: the one-time preservation CLI is fail-closed and documents exact inputs', () => {
  const script = new URL('../scripts/preserve-forward-authorization.mjs', import.meta.url).pathname;
  const help = spawnSync(process.execPath, [script, '--help'], {encoding: 'utf8'});
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--attempt-id/); assert.match(help.stdout, /--expected-sha256/);
  const missing = spawnSync(process.execPath, [script], {encoding: 'utf8'});
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /ARGUMENTS_INVALID/);
});

test('CONT-H07: the drop-in replacement is atomic and leaves the old text on failure', t => {
  const root = mkdtempSync(join(tmpdir(), 'servora-cont-atomic-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const path = join(root, 'dropin.conf');
  writeFileSync(path, 'old\n', {mode: 0o600});
  atomicReplaceFile({path, text: 'new\n', directory: root});
  assert.equal(readFileSync(path, 'utf8'), 'new\n');
  writeFileSync(path, 'old\n');
  assert.throws(() => atomicReplaceFile({path, text: 'new\n', directory: root,
    rename: () => { throw new Error('RENAME_FAILED'); }}), /RENAME_FAILED/);
  assert.equal(readFileSync(path, 'utf8'), 'old\n');
  assert.deepEqual(readdirSync(root).filter(name => name.startsWith('.collector-')), []);
});

// --- filesystem lineage validator (CONT-L01..) -----------------------------
import {timeEvidenceAt} from './trusted-time-fixture.mjs';
import {validateForwardAuthorizationStructure, CONTINUITY_KIND as KIND,
  CONTINUITY_SCOPE as SCOPE, CONTINUITY_RECOVERY_OUTCOME, FORWARD_ACTIONS, FORWARD_FORBIDDEN} from '../scripts/forward-transition.mjs';
import {recoveryDigest} from '../scripts/forward-host-recovery.mjs';
import {validateContinuityLineage} from '../scripts/forward-host-continuity.mjs';

const HEAD = '060_crm_duplicate_review_decisions';
const CATALOG = [...Array.from({length: 59}, (_, index) => ({
  version: String(index + 1).padStart(3, '0') + '_step_' + (index + 1), sha256: h('1'),
})), {version: HEAD, sha256: h('2')}];
const NOW = '2026-11-03T12:00:00Z';
const ISSUED = timeEvidenceAt(Date.parse(NOW));
const ISSUED_AT = ISSUED.wallAtUTC.replace(/\.\d{3}Z$/, 'Z');
const PRED = '11111111-1111-4111-8111-111111111111';
const CONT = '33333333-3333-4333-8333-333333333333';
const PRED_AUTH_ID = '22222222-2222-4222-8222-222222222222';
const CONT_AUTH_ID = '44444444-4444-4444-8444-444444444444';
const PARENT = {attemptId: '6ce4cff0-fa73-450e-b540-3f54ae429e7c', approvalSha256: h('a'),
  profileSha256: h('b'), checkpointSequence: 17, checkpointSha256: h('c'),
  emergencyAuthorizationId: '52f632ef-ca3e-49ab-a26e-0b562adc2c78', emergencyJournalHeadSha256: h('d'),
  emergencyReceiptSha256: h('e'), disposition: 'SUPERSEDED_BY_EMERGENCY_HANDOFF'};
const HOST = {machineId: 'ae00df7d546249218e3c5c2b5e21ecb6', database: {clusterId: '7678331783042422178',
  databaseName: 'servora_med', databaseOid: '16389', role: 'servora', host: '127.0.0.1', port: 5432}};
function grant(overrides = {}) {
  return {formatVersion: 2, kind: 'FORWARD_TRANSITION_AUTHORIZATION', authorizationId: PRED_AUTH_ID,
    issuedAtUTC: ISSUED_AT, expiresAtUTC: '2026-11-03T13:00:00Z', issuedTime: ISSUED, maxUses: 1,
    reason: 'RECOVERY_LINEAGE_FIXTURE', scope: 'FORWARD_ONLY_RELEASE_TRANSITION', attemptId: PRED,
    parent: {...PARENT}, old: {releaseSha: 'f5f87d450061ca12ee80451c55eb56e99b80823c', artifactSha256: h('f'),
      schemaHead: HEAD, catalog: [...CATALOG]},
    target: {releaseSha: LIVE, treeSha: 'b'.repeat(40), artifactSha256: h('3'), ciManifestSha256: h('4'),
      schemaHead: HEAD, catalog: [...CATALOG]},
    host: {...HOST}, migration: {allowed: false, required: false, authorizedMigrations: []},
    budgets: {maxStarts: 2, maxObservationAttempts: 1}, actions: [...FORWARD_ACTIONS], forbidden: [...FORWARD_FORBIDDEN], ...overrides};
}
function lineage(overrides = {}) {
  return {type: 'RECOVERY', predecessorAttemptId: PRED, predecessorAuthorizationSha256: h('1'),
    predecessorToolHash: h('2'), predecessorJournalHeadSha256: h('3'), predecessorTerminalPhase: 'OBSERVATION_STARTED',
    predecessorReleaseSha: LIVE, predecessorArtifactSha256: h('3'), predecessorCollectorModuleSha256: h('4'),
    predecessorCollectorPath: '/usr/local/libexec/servora-med-forward/trusted-time.mjs',
    recoveryAuthorizationSha256: h('5'), recoveryJournalHeadSha256: h('6'), recoveryReceiptSha256: h('7'),
    recoveryOutcome: CONTINUITY_RECOVERY_OUTCOME, ...overrides};
}
function continuity(line, overrides = {}) {
  return {formatVersion: 1, kind: KIND, authorizationId: CONT_AUTH_ID, issuedAtUTC: ISSUED_AT,
    expiresAtUTC: '2026-11-03T13:00:00Z', issuedTime: ISSUED, maxUses: 1, reason: 'CONTINUITY_FIXTURE',
    scope: SCOPE, attemptId: CONT, parent: {...PARENT}, old: {releaseSha: LIVE, artifactSha256: h('3'),
      schemaHead: HEAD, catalog: [...CATALOG]},
    target: {releaseSha: 'c'.repeat(40), treeSha: 'd'.repeat(40), artifactSha256: h('8'), ciManifestSha256: h('9'),
      schemaHead: HEAD, catalog: [...CATALOG]},
    host: {...HOST}, migration: {allowed: false, required: false, authorizedMigrations: []},
    budgets: {maxStarts: 1, maxObservationAttempts: 1}, actions: [...FORWARD_ACTIONS], forbidden: [...FORWARD_FORBIDDEN], lineage: line, ...overrides};
}
function lineageFixture(line) {
  const predecessor = grant({target: {...grant().target, artifactSha256: h('3')}});
  const authBytes = Buffer.from(JSON.stringify(predecessor));
  const moduleBytes = Buffer.from('module-bytes');
  const moduleSha = digest(moduleBytes);
  const receipt = {mode: 'RESTORE_HEALTHY_TARGET', outcome: CONTINUITY_RECOVERY_OUTCOME,
    accepted: false, completed: false, deploymentPhase: line.predecessorTerminalPhase};
  const receiptBytes = Buffer.from(JSON.stringify(receipt));
  const recoveryGrant = {kind: 'FORWARD_FAILURE_RECOVERY_AUTHORIZATION'};
  const l = {...line, predecessorAuthorizationSha256: digest(authBytes),
    predecessorCollectorModuleSha256: moduleSha, recoveryReceiptSha256: digest(receiptBytes),
    recoveryAuthorizationSha256: recoveryDigest(recoveryGrant)};
  const paths = {
    auth: join('/forward', PRED, 'authorization.json'),
    journal: join('/forward', PRED, 'journal'),
    grant: join('/forward', PRED, 'recovery-authorization.json'),
    receipt: join('/forward', PRED, 'recovery', 'receipt.json'),
    recoveryJournal: join('/forward', PRED, 'recovery', 'journal'),
    recovery: join('/forward', PRED, 'recovery'),
  };
  const log = [{event: 'OBSERVE_INTENT', hash: l.predecessorJournalHeadSha256,
    contract: {phase: 'OBSERVATION_STARTED'}}];
  const state = {pending: {event: 'OBSERVE_INTENT'}, contract: {phase: 'OBSERVATION_STARTED'},
    done: new Map([['START', {data: {}}], ['PRE_BACKUP', {data: {}}], ['POST_BACKUP', {data: {}}],
      ['COLLECTOR', {data: {moduleSha256: moduleSha}}]])};
  const recoveryLog = [{event: 'FINAL', hash: l.recoveryJournalHeadSha256, data: {ownerRetired: true}}];
  const deps = {
    root: '/forward',
    releasesRoot: '/releases',
    exists: () => true,
    readAuthorization: path => path === paths.auth ? authBytes : path === paths.receipt ? receiptBytes : null,
    readManifest: () => ({hash: l.predecessorToolHash}),
    openJournal: directory => directory === paths.journal ? {pending: () => 0, read: () => log}
      : directory === paths.recoveryJournal ? {pending: () => 0, read: () => recoveryLog} : null,
    validateDeploymentLog: () => state,
    validateRecovery: () => ({final: true, fallback: false}),
    readReceipt: path => path === paths.grant ? recoveryGrant : receipt,
    readFile: () => moduleBytes,
    digestValue: digest,
    verifyAcceptance: () => true,
  };
  return {lineage: l, grant: continuity(l), predecessor, deps, paths, log, state, recoveryLog, moduleBytes};
}
function acceptedFixture() {
  const base = lineageFixture(lineage({type: 'ACCEPTED', predecessorTerminalPhase: 'ACCEPTED',
    acceptanceContractSha256: h('a')}));
  for (const key of ['recoveryAuthorizationSha256', 'recoveryJournalHeadSha256',
    'recoveryReceiptSha256', 'recoveryOutcome']) delete base.lineage[key];
  base.grant = continuity(base.lineage);
  base.log = [{event: 'PHASE', hash: base.lineage.predecessorJournalHeadSha256,
    contract: {phase: 'ACCEPTED', hash: base.lineage.acceptanceContractSha256}}];
  base.state = {pending: null, contract: {phase: 'ACCEPTED'},
    done: new Map([['START', {data: {}}], ['PRE_BACKUP', {data: {}}], ['POST_BACKUP', {data: {}}],
      ['COLLECTOR', {data: {moduleSha256: base.lineage.predecessorCollectorModuleSha256}}],
      ['HANDOFF', {data: {}}], ['RETIRE', {data: {}}]])};
  base.deps.exists = path => path !== base.paths.recovery;
  base.deps.validateDeploymentLog = () => base.state;
  base.deps.openJournal = directory => directory === base.paths.journal
    ? {pending: () => 0, read: () => base.log} : null;
  return base;
}

test('CONT-L01: a valid recovery lineage validates end-to-end', () => {
  const f = lineageFixture(lineage());
  assert.equal(validateContinuityLineage(f.grant, f.deps).predecessor.attemptId, PRED);
});

test('CONT-L02: missing or changed predecessor authorization fails closed', () => {
  const f = lineageFixture(lineage());
  assert.throws(() => validateContinuityLineage(f.grant, {...f.deps, exists: path => path !== f.paths.auth}),
    /LINEAGE_AUTHORIZATION_MISSING/);
  assert.throws(() => validateContinuityLineage(f.grant, {...f.deps,
    readAuthorization: path => path === f.paths.auth ? Buffer.from('{}') : f.deps.readAuthorization(path)}),
    /LINEAGE_AUTHORIZATION_DRIFT/);
});

test('CONT-L03: tool, journal and collector drift fail closed', () => {
  const f = lineageFixture(lineage());
  assert.throws(() => validateContinuityLineage(f.grant, {...f.deps, readManifest: () => ({hash: h('0')})}),
    /LINEAGE_TOOL_DRIFT/);
  assert.throws(() => validateContinuityLineage(f.grant, {...f.deps, exists: path => path !== f.paths.journal}),
    /LINEAGE_JOURNAL_MISSING/);
  assert.throws(() => validateContinuityLineage(f.grant, {...f.deps,
    openJournal: dir => dir === f.paths.journal ? {pending: () => 1, read: () => f.log} : f.deps.openJournal(dir)}),
    /LINEAGE_JOURNAL_PENDING/);
  assert.throws(() => validateContinuityLineage(f.grant, {...f.deps,
    validateDeploymentLog: () => ({...f.state, done: new Map([...f.state.done].filter(([op]) => op !== 'START'))})}),
    /LINEAGE_INCOMPLETE/);
  assert.throws(() => validateContinuityLineage(f.grant, {...f.deps,
    validateDeploymentLog: () => ({...f.state, done: new Map([...f.state.done].map(([op, value]) =>
      op === 'COLLECTOR' ? [op, {data: {moduleSha256: h('0')}}] : [op, value]))})}),
    /LINEAGE_COLLECTOR_DRIFT/);
  assert.throws(() => validateContinuityLineage(f.grant, {...f.deps, readFile: () => Buffer.from('other')}),
    /LINEAGE_COLLECTOR_DRIFT/);
});

test('CONT-L04: recovery evidence must be present, final, non-fallback and exact', () => {
  const f = lineageFixture(lineage());
  assert.throws(() => validateContinuityLineage(f.grant, {...f.deps, exists: path => path !== f.paths.grant}),
    /LINEAGE_RECOVERY_MISSING/);
  assert.throws(() => validateContinuityLineage(f.grant, {...f.deps,
    openJournal: dir => dir === f.paths.recoveryJournal ? {pending: () => 1, read: () => f.recoveryLog} : f.deps.openJournal(dir)}),
    /LINEAGE_RECOVERY_PENDING/);
  for (const validated of [{final: false, fallback: false}, {final: true, fallback: true}]) {
    assert.throws(() => validateContinuityLineage(f.grant, {...f.deps, validateRecovery: () => validated}),
      /LINEAGE_RECOVERY_DRIFT/);
  }
  for (const change of [
    {outcome: 'FORWARD_FAILURE_FENCED_NOT_ACCEPTED'},
    {accepted: true},
    {deploymentPhase: 'ACCEPTED'},
    {mode: 'CLOSE_FENCED'},
  ]) {
    assert.throws(() => validateContinuityLineage(f.grant, {...f.deps,
      readReceipt: path => path === f.paths.receipt ? {mode: 'RESTORE_HEALTHY_TARGET',
        outcome: CONTINUITY_RECOVERY_OUTCOME, accepted: false, completed: false,
        deploymentPhase: 'OBSERVATION_STARTED', ...change} : f.deps.readReceipt(path)}),
      /LINEAGE_RECOVERY_DRIFT/);
  }
  assert.throws(() => validateContinuityLineage(f.grant, {...f.deps,
    openJournal: dir => dir === f.paths.recoveryJournal ? {pending: () => 0,
      read: () => [{event: 'FINAL', hash: f.lineage.recoveryJournalHeadSha256, data: {ownerRetired: false}}]} : f.deps.openJournal(dir)}),
    /LINEAGE_RECOVERY_DRIFT/);
});

test('CONT-L05: an accepted predecessor requires acceptance, handoff and retire', () => {
  const f = acceptedFixture();
  assert.equal(validateContinuityLineage(f.grant, f.deps).predecessor.attemptId, PRED);
  assert.throws(() => validateContinuityLineage(f.grant, {...f.deps, exists: () => true}),
    /LINEAGE_ACCEPTANCE_DRIFT/);
  assert.throws(() => validateContinuityLineage(f.grant, {...f.deps,
    validateDeploymentLog: () => ({...f.state, done: new Map([...f.state.done].filter(([op]) => op !== 'HANDOFF'))})}),
    /LINEAGE_ACCEPTANCE_DRIFT/);
  assert.throws(() => validateContinuityLineage(f.grant, {...f.deps,
    validateDeploymentLog: () => ({...f.state, contract: {phase: 'ACCEPTED'}, pending: {event: 'HANDOFF_INTENT'}})}),
    /LINEAGE_JOURNAL_DRIFT/);
});

test('CONT-L06: cross-lineage binding drift fails closed', () => {
  const f = lineageFixture(lineage());
  const drifted = grant({target: {...grant().target, artifactSha256: h('0')}});
  const bytes = Buffer.from(JSON.stringify(drifted));
  assert.throws(() => validateContinuityLineage(f.grant, {...f.deps,
    readAuthorization: path => path === f.paths.auth ? bytes : f.deps.readAuthorization(path)}),
    /LINEAGE_AUTHORIZATION_DRIFT/);
  const wrongParent = {...f.grant, parent: {...f.grant.parent, approvalSha256: h('0')}};
  assert.throws(() => validateContinuityLineage(wrongParent, f.deps), /LINEAGE_MISMATCH/);
  const wrongOld = {...f.grant, old: {...f.grant.old, releaseSha: 'a'.repeat(40)}};
  assert.throws(() => validateContinuityLineage(wrongOld, f.deps), /LINEAGE_MISMATCH/);
});
