import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCanonicalRecord, validateApproval as validateTimedApproval, assertPreMigrationAbortCompatibility as timedAbortCompatibility, advanceAttempt as advanceTimedAttempt,
  validateHostProfile, initialAttempt as initialTimedAttempt } from '../scripts/deployment-attempt.mjs';

import {timeEvidenceAt} from './trusted-time-fixture.mjs';
const validateApproval=(record,now)=>validateTimedApproval(record,timeEvidenceAt(now));
const initialAttempt=(context,now)=>initialTimedAttempt(context,timeEvidenceAt(now));
const advanceAttempt=(journal,context,event,now)=>advanceTimedAttempt(journal,context,event,timeEvidenceAt(now));
const assertPreMigrationAbortCompatibility=(approval,versions,now)=>timedAbortCompatibility(approval,versions,timeEvidenceAt(now));

const approval = () => ({
  formatVersion: 2,
  attemptId: '11111111-1111-4111-8111-111111111111',
  releaseSha: 'a'.repeat(40),
  treeSha: 'b'.repeat(40),
  artifactSha256: 'c'.repeat(64),
  ciManifestSha256: 'd'.repeat(64),
  targetCatalog: [{ version: '001_baseline', sha256: 'e'.repeat(64) },
    { version: '002_additive', sha256: 'f'.repeat(64) }],
  oldReleaseSha: '1'.repeat(40),
  oldArtifactSha256: '2'.repeat(64),
  oldCatalog: [{ version: '001_baseline', sha256: 'e'.repeat(64) }],
  profileSha256: '3'.repeat(64),
  issuedTime: timeEvidenceAt(),
  issuedAtUTC: '2026-10-12T09:00:00.000Z',
  // Admission must still leave the full mandatory acceptance window (see the
  // window contract below); fixtures keep a 3-hour grant for that purpose.
  expiresAtUTC: '2026-10-12T12:00:00.000Z',
  maxStarts: 2,
  maxAbortStarts: 1,
  allowMigration: true,
  allowForwardRecovery: true,
  allowPreMigrationAbort: true,
  allowPostdeployBackup: true,
});

test('host profile rejects an arbitrary command or alternate privileged helper', () => {
  assert.throws(() => validateHostProfile({ command: '/bin/sh', helper: '/tmp/helper' }),
    /RECOVERY_HOST_PROFILE_INVALID/);
});

test('rejects duplicate state keys instead of trusting JSON last-write-wins', () => {
  assert.throws(() => parseCanonicalRecord('{"attempt":"first","attempt":"second"}\n'),
    /ATTEMPT_RECORD_NOT_CANONICAL/);
});

test('rejects an unexpected command field in a root approval', () => {
  assert.throws(() => validateApproval({ ...approval(), command: '/bin/sh' },
    Date.parse('2026-10-12T09:30:00.000Z')), /ATTEMPT_APPROVAL_KEYS_INVALID/);
});

test('rejects expired approval without renewing its activation authority', () => {
  assert.throws(() => validateApproval({
    ...approval(),
    issuedAtUTC: '2026-10-12T09:00:00.000Z',
    expiresAtUTC: '2026-10-12T10:00:00.000Z',
  }, Date.parse('2026-10-12T10:00:00.000Z')), /ATTEMPT_APPROVAL_TIME_INVALID/);
});

test('admission proves a remaining authorization window for the mandatory acceptance interval', () => {
  const now = Date.parse('2026-10-12T09:30:00.000Z');
  // The grant must still cover the mandatory 1,800-second observation plus the
  // transition-phase budget when the FIRST durable mutation happens.
  for (const remainingSeconds of [1800, 3599]) {
    const record = { ...approval(), expiresAtUTC: new Date(now + remainingSeconds * 1000).toISOString() };
    assert.throws(() => initialAttempt({ approval: record, approvalSha256: '4'.repeat(64) }, now),
      /ATTEMPT_APPROVAL_WINDOW_INSUFFICIENT/);
  }
  const boundary = { ...approval(), expiresAtUTC: new Date(now + 3600 * 1000).toISOString() };
  assert.equal(initialAttempt({ approval: boundary, approvalSha256: '4'.repeat(64) }, now).phase, 'ADMITTED');
});

test('an admitted attempt keeps its consumed authority after expiry without bypassing structure or budgets', () => {
  const now = Date.parse('2026-10-12T09:30:00.000Z');
  const grant = { ...approval(), expiresAtUTC: '2026-10-12T11:30:00.000Z' };
  const context = { approval: grant, approvalSha256: '4'.repeat(64) };
  const admitted = initialAttempt(context, now);
  const later = Date.parse('2026-10-12T10:30:00.000Z'); // Beyond the sealed expiry.
  const backup = { kind: 'PREDEPLOY_BACKUP',
    receipt: { sha256: '6'.repeat(64), completedAtUTC: '2026-10-12T09:59:00.000Z' } };
  // The grant was consumed at admission; the already-authorized transition may
  // still finish after wall-clock expiry.
  assert.equal(advanceAttempt(admitted, context, backup, later).phase, 'BACKED_UP');
  // Structure, scope and budget contracts remain fully enforced after expiry.
  assert.throws(() => advanceAttempt(admitted,
    { approval: { ...grant, maxStarts: 100 }, approvalSha256: '4'.repeat(64) }, backup, later),
  /ATTEMPT_APPROVAL_SCOPE_INVALID/);
  // A grant issued after the durable journal timeline was never consumed by it.
  assert.throws(() => advanceAttempt(admitted,
    { approval: { ...grant, issuedAtUTC: '2026-10-12T10:00:00.000Z', expiresAtUTC: '2026-10-12T12:00:00.000Z' },
      approvalSha256: '4'.repeat(64) }, backup, later),
  /ATTEMPT_APPROVAL_TIME_INVALID/);
});

test('rejects a non-canonical release identity even in otherwise valid approval', () => {
  assert.throws(() => validateApproval({ ...approval(), releaseSha: 'main' },
    Date.parse('2026-10-12T09:30:00.000Z')), /ATTEMPT_APPROVAL_IDENTITY_INVALID/);
});

test('rejects a gapped catalog through the existing migration comparator', () => {
  const record = approval();
  record.targetCatalog[1].version = '003_wrong_branch';
  assert.throws(() => validateApproval(record, Date.parse('2026-10-12T09:30:00.000Z')),
    /ATTEMPT_APPROVAL_CATALOG_INVALID/);
});

test('rejects an approval that would allow unlimited activation starts', () => {
  assert.throws(() => validateApproval({ ...approval(), maxStarts: 100 },
    Date.parse('2026-10-12T09:30:00.000Z')), /ATTEMPT_APPROVAL_SCOPE_INVALID/);
});

test('accepts the explicit bounded fixture grant without weakening its catalog', () => {
  const record = approval();
  assert.deepEqual(validateApproval(record, Date.parse('2026-10-12T09:30:00.000Z')), record);
});

test('pre-migration abort rejects the committed candidate catalog regardless of retry delta', () => {
  const record = approval();
  assert.throws(() => assertPreMigrationAbortCompatibility(record,
    record.targetCatalog.map((entry) => entry.version), Date.parse('2026-10-12T09:30:00.000Z')),
  /PRE_MIGRATION_ABORT_DB_NOT_OLD_EXACT/);
});

test('an ambiguous start intent cannot allocate an unused recovery slot', () => {
  const record = approval();
  const context = { approval: record, approvalSha256: '4'.repeat(64) };
  const journal = {
    formatVersion: 2, admissionTime:timeEvidenceAt(), timeEvidence:timeEvidenceAt(Date.parse('2026-10-12T09:20:00.000Z')), attemptId: record.attemptId, approvalSha256: context.approvalSha256,
    profileSha256: record.profileSha256, sequence: 5, previousHash: '5'.repeat(64),
    phase: 'START_INTENT', starts: 1, abortStarts: 0, migrationCommitted: true,
    lastStart: 'intent', predeployBackup: null, postdeployBackup: null,
    smokePassed: false, observationPassed: false, invariantBaseline: null,
    schemaChecked: true, updatedAtUTC: '2026-10-12T09:20:00.000Z',
  };
  assert.throws(() => advanceAttempt(journal, context, 'START_INTENT',
    Date.parse('2026-10-12T09:30:00.000Z')), /ATTEMPT_START_AMBIGUOUS/);
});

test('admission binds an initial journal to the sealed grant before migration or activation', () => {
  const grant = approval();
  const journal = initialAttempt({ approval: grant, approvalSha256: '4'.repeat(64) },
    Date.parse('2026-10-12T09:30:00.000Z'));
  assert.equal(journal.phase, 'ADMITTED');
  assert.equal(journal.approvalSha256, '4'.repeat(64));
  assert.equal(journal.profileSha256, grant.profileSha256);
  assert.equal(journal.sequence, 0);
  assert.equal(journal.previousHash, null);
  assert.equal(journal.starts, 0);
  assert.equal(journal.migrationCommitted, false);
});

test('migration intent requires a verified predeploy backup and a stopped fenced service', () => {
  const context = { approval: approval(), approvalSha256: '4'.repeat(64) };
  const now = Date.parse('2026-10-12T09:30:00.000Z');
  const admitted = initialAttempt(context, now);
  assert.throws(() => advanceAttempt(admitted, context, { kind:'MIGRATION_INTENT', baseline:INVARIANT_BASELINE }, now), /ATTEMPT_TRANSITION_INVALID/);
  const backup = advanceAttempt(admitted, context, { kind: 'PREDEPLOY_BACKUP',
    receipt: { sha256: '6'.repeat(64), completedAtUTC: '2026-10-12T09:30:00.000Z' } }, now);
  const fenced = advanceAttempt(backup, context, 'FENCED', now);
  const intent = advanceAttempt(fenced, context, { kind:'MIGRATION_INTENT', baseline:INVARIANT_BASELINE }, now);
  assert.equal(intent.phase, 'MIGRATION_INTENT');
  assert.equal(intent.migrationCommitted, false);
  assert.equal(intent.predeployBackup.sha256, '6'.repeat(64));
  assert.deepEqual(intent.invariantBaseline, INVARIANT_BASELINE);
});

test('exact database admission retains the migration boundary through env, pointer and bounded start', () => {
  const context = { approval: approval(), approvalSha256: '4'.repeat(64) };
  const now = Date.parse('2026-10-12T09:30:00.000Z');
  let journal = { ...initialAttempt(context, now), phase: 'MIGRATION_INTENT', invariantBaseline: INVARIANT_BASELINE,
    predeployBackup: { sha256: '6'.repeat(64), completedAtUTC: '2026-10-12T09:30:00.000Z' } };
  journal = advanceAttempt(journal, context, 'DB_EXACT', now);
  assert.equal(journal.migrationCommitted, true);
  journal = advanceAttempt(journal, context, 'ENV_INTENT', now);
  journal = advanceAttempt(journal, context, 'ENV_ALIGNED', now);
  journal = advanceAttempt(journal, context, 'POINTER_INTENT', now);
  journal = advanceAttempt(journal, context, 'POINTER_ALIGNED', now);
  journal = advanceAttempt(journal, context, 'START_INTENT', now);
  journal = advanceAttempt(journal, context, 'START_FAILED', now);
  journal = advanceAttempt(journal, context, 'START_INTENT', now);
  journal = advanceAttempt(journal, context, 'START_FAILED', now);
  assert.equal(journal.starts, 2);
  assert.throws(() => advanceAttempt(journal, context, 'START_INTENT', now), /BUDGET_EXHAUSTED/);
  assert.throws(() => advanceAttempt(journal, context, 'ABORT_INTENT', now), /ATTEMPT_TRANSITION_INVALID/);
});

test('pre-migration abort has a separate single start budget and cannot reuse an ambiguous abort intent', () => {
  const context = { approval: approval(), approvalSha256: '4'.repeat(64) };
  const now = Date.parse('2026-10-12T09:30:00.000Z');
  const fenced = { ...initialAttempt(context, now), phase: 'FENCED',
    predeployBackup: { sha256: '6'.repeat(64), completedAtUTC: '2026-10-12T09:30:00.000Z' } };
  const abort = advanceAttempt(fenced, context, 'ABORT_INTENT', now);
  assert.equal(abort.abortStarts, 1);
  assert.equal(abort.starts, 0);
  assert.throws(() => advanceAttempt(abort, context, 'ABORT_INTENT', now), /ATTEMPT_TRANSITION_INVALID/);
  assert.throws(() => advanceAttempt({ ...fenced, migrationCommitted: true }, context, 'ABORT_INTENT', now), /ATTEMPT_TRANSITION_INVALID/);
});

test('health cannot complete an attempt before separate smoke, backup and full observation receipts', () => {
  const context = { approval: approval(), approvalSha256: '4'.repeat(64) };
  const now = Date.parse('2026-10-12T09:30:00.000Z');
  let journal = { ...initialAttempt(context, now), phase: 'START_INTENT', starts: 1, lastStart: 'intent', migrationCommitted: true };
  journal = advanceAttempt(journal, context, 'HEALTH_PASSED', now);
  assert.throws(() => advanceAttempt(journal, context, 'ACCEPTED', now), /ATTEMPT_TRANSITION_INVALID/);
  assert.throws(() => advanceAttempt(journal, context, 'SMOKE_PASSED', now), /ATTEMPT_TRANSITION_INVALID/);
  journal = advanceAttempt(journal, context, 'SCHEMA_CHECKED', now);
  assert.equal(journal.phase, 'HEALTH_PASSED');
  assert.equal(journal.schemaChecked, true);
  journal = advanceAttempt(journal, context, 'SMOKE_PASSED', now);
  journal = advanceAttempt(journal, context, 'POSTDEPLOY_BACKUP_INTENT', now);
  journal = advanceAttempt(journal, context, { kind: 'POSTDEPLOY_BACKUP_PASSED',
    receipt: { sha256: '7'.repeat(64), completedAtUTC: '2026-10-12T09:30:00.000Z' } }, now);
  assert.throws(() => advanceAttempt(journal, context, { kind: 'OBSERVATION_PASSED', elapsedSeconds: 1799 }, now), /ATTEMPT_TRANSITION_INVALID/);
  journal = advanceAttempt(journal, context, { kind: 'OBSERVATION_PASSED', elapsedSeconds: 1800 }, now);
  journal = advanceAttempt(journal, context, 'ACCEPTED', now);
  assert.equal(journal.phase, 'ACCEPTED');
  assert.equal(journal.lastStart, 'pass');
  // An ACCEPTED label alone cannot authorize an unfenced handoff. The full
  // durable evidence remains mandatory even if a root journal is malformed.
  assert.throws(() => advanceAttempt(journal,context,'COMPLETED',now),/RECOVERY_HANDOFF_EVIDENCE_MISSING/);
  journal.predeployBackup={sha256:'6'.repeat(64),completedAtUTC:'2026-10-12T09:30:00.000Z'};
  journal.invariantBaseline={organizations:1,admins:1,staff:1,customers:1,products:1,jobs:1,demoData:0};
  assert.equal(advanceAttempt(journal,context,'COMPLETED',now).phase,'COMPLETED');
  for(const field of ['schemaChecked','smokePassed','observationPassed','migrationCommitted']){
    assert.throws(()=>advanceAttempt({...journal,[field]:false},context,'COMPLETED',now),/RECOVERY_HANDOFF_EVIDENCE_MISSING/);
  }
});

test('journal readback rejects an unknown phase or malformed receipt instead of emitting shell fields', () => {
  const context = {approval:approval(),approvalSha256:'4'.repeat(64)};
  const now = Date.parse('2026-10-12T09:30:00.000Z');
  const journal = initialAttempt(context,now);
  assert.throws(() => advanceAttempt({...journal,phase:'START_INTENT\nOTHER=value'},context,'VALIDATE',now), /ATTEMPT_JOURNAL_INVALID/);
  assert.throws(() => advanceAttempt({...journal,predeployBackup:{sha256:'missing'}},context,'VALIDATE',now), /ATTEMPT_JOURNAL_INVALID/);
});

test('backup intent cannot start an operation excluded by the sealed approval', () => {
  const context = {approval:{...approval(),allowPostdeployBackup:false},approvalSha256:'4'.repeat(64)};
  const now = Date.parse('2026-10-12T09:30:00.000Z');
  const journal = {...initialAttempt(context,now),phase:'SMOKE_PASSED',smokePassed:true};
  assert.throws(() => advanceAttempt(journal,context,'POSTDEPLOY_BACKUP_INTENT',now),/ATTEMPT_TRANSITION_INVALID/);
});

test('smoke cannot pass on a health checkpoint without a durable schema-check result', () => {
  const context = { approval: approval(), approvalSha256: '4'.repeat(64) };
  const now = Date.parse('2026-10-12T09:30:00.000Z');
  const healthy = { ...initialAttempt(context, now), phase: 'HEALTH_PASSED', starts: 1, lastStart: 'pass', migrationCommitted: true };
  assert.throws(() => advanceAttempt(healthy, context, 'SMOKE_PASSED', now), /ATTEMPT_TRANSITION_INVALID/);
  const checked = advanceAttempt(healthy, context, 'SCHEMA_CHECKED', now);
  assert.equal(checked.phase, 'HEALTH_PASSED');
  assert.equal(checked.schemaChecked, true);
  assert.equal(advanceAttempt(checked, context, 'SMOKE_PASSED', now).phase, 'SMOKE_PASSED');
});

test('schema check result can only be recorded from the health checkpoint', () => {
  const context = { approval: approval(), approvalSha256: '4'.repeat(64) };
  const now = Date.parse('2026-10-12T09:30:00.000Z');
  const started = { ...initialAttempt(context, now), phase: 'START_INTENT', starts: 1, lastStart: 'intent', migrationCommitted: true };
  assert.throws(() => advanceAttempt(started, context, 'SCHEMA_CHECKED', now), /ATTEMPT_TRANSITION_INVALID/);
  assert.throws(() => advanceAttempt({ ...started, phase: 'ENV_ALIGNED' }, context, 'SCHEMA_CHECKED', now), /ATTEMPT_TRANSITION_INVALID/);
});

test('health lost before smoke may reserve only the remaining explicit start, never revive accepted mutations', () => {
  const context = {approval:approval(),approvalSha256:'4'.repeat(64)};
  const now = Date.parse('2026-10-12T09:30:00.000Z');
  const healthy = {...initialAttempt(context,now),phase:'HEALTH_PASSED',starts:1,lastStart:'pass',migrationCommitted:true};
  const failed = advanceAttempt(healthy,context,'HEALTH_LOST',now);
  assert.equal(failed.phase,'START_FAILED');
  assert.equal(advanceAttempt(failed,context,'START_INTENT',now).starts,2);
  assert.throws(() => advanceAttempt({...healthy,phase:'SMOKE_PASSED',smokePassed:true},context,'HEALTH_LOST',now),/ATTEMPT_TRANSITION_INVALID/);
  assert.throws(() => advanceAttempt({...healthy,starts:2},context,'HEALTH_LOST',now),/BUDGET_EXHAUSTED/);
});

const INVARIANT_BASELINE = { organizations:2, admins:1, staff:3, customers:7, products:11, jobs:5, demoData:0 };
const fencedFixture = (context, now) => ({ ...initialAttempt(context, now), phase:'FENCED',
  predeployBackup:{ sha256:'6'.repeat(64), completedAtUTC:'2026-10-12T09:30:00.000Z' } });

test('migration intent persists the verified pre-migration invariant baseline durably', () => {
  const context = { approval: approval(), approvalSha256: '4'.repeat(64) };
  const now = Date.parse('2026-10-12T09:30:00.000Z');
  const intent = advanceAttempt(fencedFixture(context, now), context,
    { kind:'MIGRATION_INTENT', baseline:INVARIANT_BASELINE }, now);
  assert.equal(intent.phase, 'MIGRATION_INTENT');
  assert.deepEqual(intent.invariantBaseline, INVARIANT_BASELINE);
});

test('migration intent fails closed without a complete verified invariant baseline', () => {
  const context = { approval: approval(), approvalSha256: '4'.repeat(64) };
  const now = Date.parse('2026-10-12T09:30:00.000Z');
  const events = [
    'MIGRATION_INTENT',
    { kind:'MIGRATION_INTENT' },
    { kind:'MIGRATION_INTENT', baseline:{ organizations:1 } },
    { kind:'MIGRATION_INTENT', baseline:{ ...INVARIANT_BASELINE, jobs:-1 } },
    { kind:'MIGRATION_INTENT', baseline:{ ...INVARIANT_BASELINE, demoData:1.5 } },
    { kind:'MIGRATION_INTENT', baseline:{ ...INVARIANT_BASELINE, extra:1 } },
  ];
  for (const event of events) {
    assert.throws(() => advanceAttempt(fencedFixture(context, now), context, event, now),
      /ATTEMPT_TRANSITION_INVALID/);
  }
});

test('migration intent requires every downstream deployment scope before any migration', () => {
  const now = Date.parse('2026-10-12T09:30:00.000Z');
  for (const override of [{ allowForwardRecovery:false }, { allowPostdeployBackup:false }]) {
    const context = { approval:{ ...approval(), ...override }, approvalSha256:'4'.repeat(64) };
    assert.throws(() => advanceAttempt(fencedFixture(context, now), context,
      { kind:'MIGRATION_INTENT', baseline:INVARIANT_BASELINE }, now), /ATTEMPT_TRANSITION_INVALID/);
  }
});

test('pre-migration abort can cancel an interrupted admitted or backed-up attempt', () => {
  const context = { approval: approval(), approvalSha256: '4'.repeat(64) };
  const now = Date.parse('2026-10-12T09:30:00.000Z');
  const admitted = initialAttempt(context, now);
  const backedUp = { ...fencedFixture(context, now), phase:'BACKED_UP' };
  for (const journal of [admitted, backedUp]) {
    const abort = advanceAttempt(journal, context, 'ABORT_INTENT', now);
    assert.equal(abort.phase, 'ABORT_INTENT');
    assert.equal(abort.abortStarts, 1);
    assert.equal(abort.starts, 0);
  }
  assert.throws(() => advanceAttempt({ ...backedUp, migrationCommitted:true }, context, 'ABORT_INTENT', now),
    /ATTEMPT_TRANSITION_INVALID/);
});
