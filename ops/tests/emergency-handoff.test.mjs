import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateEmergencyHandoffAuthorization,
  initialEmergencyHandoff,
  advanceEmergencyHandoff,
  nextEmergencyHandoffAction,
  sealEmergencyHandoffReceipt,
  verifyEmergencyHandoffReceipt,
  assertForwardTransitionEligible,
  EMERGENCY_HANDOFF_ACTIONS,
  EMERGENCY_HANDOFF_FORBIDDEN,
  EMERGENCY_HANDOFF_PHASES,
  validateEmergencyHandoffChain,
  EMERGENCY_OPERATIONAL_STATUS,
  EMERGENCY_R4_TERMINAL_STATE,
} from '../scripts/emergency-handoff.mjs';

const h = c => c.repeat(64);
const NOW = '2026-11-01T07:30:00Z';
const PARENT_ID = '6ce4cff0-fa73-450e-b540-3f54ae429e7c';

function authorization(overrides = {}) {
  return {
    formatVersion: 2, kind: 'EMERGENCY_HANDOFF_AUTHORIZATION',
    authorizationId: '11111111-1111-4111-8111-111111111111',
    issuedAtUTC: '2026-11-01T07:00:00Z', expiresAtUTC: '2026-11-01T07:45:00Z',
    maxUses: 1, reason: 'R4_OBSERVATION_TRUSTED_TIME_BLOCKED',
    scope: 'EMERGENCY_RESTART_POLICY_HANDOFF',
    parent: {
      attemptId: PARENT_ID,
      approvalSha256: h('a'), profileSha256: h('b'),
      checkpointSequence: 17, checkpointSha256: h('c'),
      phase: 'POSTDEPLOY_BACKUP_PASSED', migrationCommitted: true,
      schemaHead: '060_crm_duplicate_review_decisions',
      starts: 2, maxStarts: 2, lastStart: 'pass',
    },
    host: {
      machineId: 'ae00df7d546249218e3c5c2b5e21ecb6',
      database: { clusterId: '7678331783042422178', databaseName: 'servora_med', databaseOid: '16389', role: 'servora_med_app', host: '127.0.0.1', port: 5432 },
      releaseSha: 'f5f87d450061ca12ee80451c55eb56e99b80823c',
      releaseArtifactSha256: h('d'),
      timeModuleSha256: h('e'), timeConfigSha256: h('f'),
    },
    backups: { preSha256: h('1'), postSha256: h('2') },
    actions: [...EMERGENCY_HANDOFF_ACTIONS],
    forbidden: [...EMERGENCY_HANDOFF_FORBIDDEN],
    toolArtifactSha256: h('3'),
    ...overrides,
  };
}

function context(overrides = {}) {
  const a = authorization();
  return {
    nowUTC: NOW, authorizationSha256: h('4'), toolArtifactSha256: h('3'),
    parent: { ...a.parent }, host: JSON.parse(JSON.stringify(a.host)), backups: { ...a.backups },
    live: {
      activeAttemptId: a.parent.attemptId, activeApprovalSha256: a.parent.approvalSha256,
      barrierAttemptId: a.parent.attemptId, barrierApprovalSha256: a.parent.approvalSha256,
      permitPresent: false, foreignOwner: false, appActive: true, appPid: 451513, coreHealth: true,
      releaseSha: a.host.releaseSha, schemaHead: a.parent.schemaHead,
      starts: 2, maxStarts: 2, dropInPresent: true, restartPolicy: 'no', needDaemonReload: false,
    },
    journal: { present: false, authorizationId: null, authorizationSha256: null, terminal: false },
    ...overrides,
  };
}

const PRE = { dropInPresent: true, restartPolicy: 'no', needDaemonReload: false, barrierPresent: true, ownerPresent: true, permitPresent: false, receiptPresent: false };
const POST_POLICY = { dropInPresent: false, restartPolicy: 'on-failure', needDaemonReload: false, barrierPresent: true, ownerPresent: true, permitPresent: false, receiptPresent: false };
const POST_BARRIER = { dropInPresent: false, restartPolicy: 'on-failure', needDaemonReload: false, barrierPresent: false, ownerPresent: true, permitPresent: false, receiptPresent: false };
const POST_OWNER = { dropInPresent: false, restartPolicy: 'on-failure', needDaemonReload: false, barrierPresent: false, ownerPresent: false, permitPresent: false, receiptPresent: false };

function completeHandoff() {
  let j = initialEmergencyHandoff(authorization(), context());
  for (const event of ['POLICY_INTENT', 'POLICY_RESTORED', 'BARRIER_INTENT', 'BARRIER_REMOVED', 'OWNER_INTENT', 'OWNER_RETIRED', 'HANDOFF_COMPLETE']) {
    j = advanceEmergencyHandoff(j, event, NOW);
  }
  return j;
}

test('EH-01: valid authorization seals INTENT with a bounded, non-acceptance status', () => {
  const auth = authorization(), ctx = context();
  assert.equal(validateEmergencyHandoffAuthorization(auth, ctx), auth);
  const j = initialEmergencyHandoff(auth, ctx);
  assert.equal(j.phase, 'INTENT');
  assert.equal(j.observationPassed, false);
  assert.equal(j.r4Acceptance, 'NOT_ACCEPTED');
  assert.equal(j.r4TerminalState, EMERGENCY_R4_TERMINAL_STATE);
  assert.equal(j.handoffComplete, false);
  assert.equal(j.sequence, 0);
  assert.match(j.hash, /^[0-9a-f]{64}$/);
  assert.equal('acceptanceWaived' in j, false);
});

test('EH-02: terminal phase is HANDOFF_COMPLETE, never COMPLETED', () => {
  const j = completeHandoff();
  assert.equal(j.phase, 'HANDOFF_COMPLETE');
  assert.equal(j.handoffComplete, true);
  assert.equal(j.observationPassed, false);
  assert.equal(EMERGENCY_HANDOFF_PHASES.includes('COMPLETED'), false);
});

test('EH-03: restart policy is restored before the barrier is removed', () => {
  let j = initialEmergencyHandoff(authorization(), context());
  assert.equal(nextEmergencyHandoffAction(j, PRE), 'REMOVE_POLICY');
  j = advanceEmergencyHandoff(j, 'POLICY_INTENT', NOW);
  assert.equal(nextEmergencyHandoffAction(j, PRE), 'REMOVE_POLICY');
  j = advanceEmergencyHandoff(j, 'POLICY_RESTORED', NOW);
  assert.equal(nextEmergencyHandoffAction(j, POST_POLICY), 'REMOVE_BARRIER');
  assert.equal(j.steps.policyRestored, true);
  assert.equal(j.steps.barrierRemoved, false);
  assert.equal(nextEmergencyHandoffAction(j, { ...POST_POLICY, dropInPresent: true, restartPolicy: 'no' }), 'STOP');
});

test('EH-04: the barrier is never removed before the restart policy is proven', () => {
  let j = initialEmergencyHandoff(authorization(), context());
  j = advanceEmergencyHandoff(j, 'POLICY_INTENT', NOW);
  assert.equal(nextEmergencyHandoffAction(j, { ...PRE, barrierPresent: false }), 'STOP');
  // The same observation can be our own interrupted post-reload publication.
  assert.equal(nextEmergencyHandoffAction(j, { ...PRE, dropInPresent: false, restartPolicy: 'on-failure' }), 'RECORD_POLICY');
  j = advanceEmergencyHandoff(j, 'POLICY_RESTORED', NOW);
  assert.equal(nextEmergencyHandoffAction(j, { ...POST_POLICY, barrierPresent: false }), 'RECORD_BARRIER');
});

test('EH-05: an interrupted daemon-reload is resumed without repeating the unlink', () => {
  let j = initialEmergencyHandoff(authorization(), context());
  for (const event of ['POLICY_INTENT']) j = advanceEmergencyHandoff(j, event, NOW);
  assert.equal(nextEmergencyHandoffAction(j, { ...PRE, dropInPresent: false, restartPolicy: 'no', needDaemonReload: true }), 'RELOAD_POLICY');
  assert.equal(nextEmergencyHandoffAction(j, POST_POLICY), 'RECORD_POLICY');
});

test('EH-06: wrong parent approval or checkpoint is rejected before any mutation', () => {
  let ctx = context(); ctx.parent.approvalSha256 = h('9');
  assert.throws(() => validateEmergencyHandoffAuthorization(authorization(), ctx), /EMERGENCY_HANDOFF_BINDING_MISMATCH/);
  ctx = context(); ctx.parent.checkpointSha256 = h('9');
  assert.throws(() => validateEmergencyHandoffAuthorization(authorization(), ctx), /EMERGENCY_HANDOFF_BINDING_MISMATCH/);
});

test('EH-07: a foreign or stale DB schema head is rejected', () => {
  const a = authorization(); a.parent.schemaHead = '059_crm_duplicate_read_indexes';
  assert.throws(() => validateEmergencyHandoffAuthorization(a, context()), /EMERGENCY_HANDOFF_AUTHORIZATION_INVALID|EMERGENCY_HANDOFF_BINDING_MISMATCH/);
  const ctx = context(); ctx.live.schemaHead = '061_fixture_future';
  assert.throws(() => validateEmergencyHandoffAuthorization(authorization(), ctx), /EMERGENCY_HANDOFF_BINDING_MISMATCH|EMERGENCY_HANDOFF_LIVE_STATE_MISMATCH/);
});

test('EH-08: installed time module or module drift is rejected', () => {
  const a = authorization(); a.host.timeModuleSha256 = h('9');
  assert.throws(() => validateEmergencyHandoffAuthorization(a, context()), /EMERGENCY_HANDOFF_BINDING_MISMATCH/);
  const ctx = context(); ctx.live.releaseSha = '9'.repeat(40);
  assert.throws(() => validateEmergencyHandoffAuthorization(authorization(), ctx), /EMERGENCY_HANDOFF_LIVE_STATE_MISMATCH/);
});

test('EH-09: a foreign active owner, foreign barrier or live permit is rejected', () => {
  for (const mutate of [
    ctx => { ctx.live.activeApprovalSha256 = h('9'); },
    ctx => { ctx.live.barrierAttemptId = '22222222-2222-4222-8222-222222222222'; },
    ctx => { ctx.live.permitPresent = true; },
    ctx => { ctx.live.foreignOwner = true; },
  ]) {
    const ctx = context(); mutate(ctx);
    assert.throws(() => validateEmergencyHandoffAuthorization(authorization(), ctx), /EMERGENCY_HANDOFF_LIVE_STATE_MISMATCH/);
  }
});

test('EH-10: missing or mismatched backup binding is rejected', () => {
  const a = authorization(); a.backups.postSha256 = h('9');
  assert.throws(() => validateEmergencyHandoffAuthorization(a, context()), /EMERGENCY_HANDOFF_BINDING_MISMATCH/);
  const short = context(); delete short.backups.preSha256;
  assert.throws(() => validateEmergencyHandoffAuthorization(authorization(), short), /EMERGENCY_HANDOFF_CONTEXT_INVALID/);
});

test('EH-11: exhausted start budget is bound and the handoff never starts the app', () => {
  const ctx = context();
  assert.equal(ctx.live.starts, 2); assert.equal(ctx.live.maxStarts, 2);
  const j = initialEmergencyHandoff(authorization(), ctx);
  assert.equal(Object.hasOwn(j, 'starts'), false);
  assert.equal(Object.hasOwn(j, 'appPid'), false);
});

test('EH-12: a down app, unhealthy core or changed PID-facing state denies before mutation', () => {
  for (const mutate of [
    ctx => { ctx.live.appActive = false; },
    ctx => { ctx.live.coreHealth = false; },
    ctx => { ctx.live.starts = 1; },
    ctx => { ctx.live.restartPolicy = 'on-failure'; },
  ]) {
    const ctx = context(); mutate(ctx);
    assert.throws(() => validateEmergencyHandoffAuthorization(authorization(), ctx), /EMERGENCY_HANDOFF_LIVE_STATE_MISMATCH/);
  }
});

test('EH-13: an expired, not-yet-valid or over-long authorization is rejected', () => {
  const late = context(); late.nowUTC = '2026-11-01T07:45:00Z';
  assert.throws(() => validateEmergencyHandoffAuthorization(authorization(), late), /EMERGENCY_HANDOFF_AUTHORIZATION_EXPIRED/);
  const early = context(); early.nowUTC = '2026-11-01T06:59:59Z';
  assert.throws(() => validateEmergencyHandoffAuthorization(authorization(), early), /EMERGENCY_HANDOFF_AUTHORIZATION_EXPIRED/);
  const tooLong = authorization({ expiresAtUTC: '2026-11-01T09:00:01Z' });
  assert.throws(() => validateEmergencyHandoffAuthorization(tooLong, context()), /EMERGENCY_HANDOFF_AUTHORIZATION_INVALID/);
});

test('EH-14: scope, actions and forbidden authority cannot be widened', () => {
  assert.throws(() => validateEmergencyHandoffAuthorization(authorization({ scope: 'FULL_ACCEPTANCE' }), context()), /EMERGENCY_HANDOFF_AUTHORIZATION_INVALID/);
  const extra = authorization({ actions: [...EMERGENCY_HANDOFF_ACTIONS, 'start_app'] });
  assert.throws(() => validateEmergencyHandoffAuthorization(extra, context()), /EMERGENCY_HANDOFF_AUTHORIZATION_INVALID/);
  const allowed = authorization({ forbidden: EMERGENCY_HANDOFF_FORBIDDEN.filter(x => x !== 'completed') });
  assert.throws(() => validateEmergencyHandoffAuthorization(allowed, context()), /EMERGENCY_HANDOFF_AUTHORIZATION_INVALID/);
});

test('EH-15: a second, different authorization cannot adopt an existing journal', () => {
  const ctx = context();
  ctx.journal = { present: true, authorizationId: '22222222-2222-4222-8222-222222222222', authorizationSha256: h('9'), terminal: false };
  assert.throws(() => validateEmergencyHandoffAuthorization(authorization(), ctx), /EMERGENCY_HANDOFF_OTHER_AUTHORIZATION/);
  ctx.journal = { present: true, authorizationId: '11111111-1111-4111-8111-111111111111', authorizationSha256: h('4'), terminal: false };
  assert.doesNotThrow(() => validateEmergencyHandoffAuthorization(authorization(), ctx));
  assert.throws(() => initialEmergencyHandoff(authorization(), ctx), /EMERGENCY_HANDOFF_ALREADY_STARTED/);
});

test('EH-16: half-completed policy work is recorded, not repeated', () => {
  let j = initialEmergencyHandoff(authorization(), context());
  for (const event of ['POLICY_INTENT']) j = advanceEmergencyHandoff(j, event, NOW);
  assert.equal(nextEmergencyHandoffAction(j, POST_POLICY), 'RECORD_POLICY');
  j = advanceEmergencyHandoff(j, 'POLICY_RESTORED', NOW);
  assert.equal(nextEmergencyHandoffAction(j, POST_POLICY), 'REMOVE_BARRIER');
  j = advanceEmergencyHandoff(j, 'BARRIER_INTENT', NOW);
  j = advanceEmergencyHandoff(j, 'BARRIER_REMOVED', NOW);
  assert.equal(nextEmergencyHandoffAction(j, { ...POST_BARRIER, ownerPresent: false }), 'RECORD_OWNER');
});

test('EH-17: crash after owner retirement deterministically seals the handoff', () => {
  let j = initialEmergencyHandoff(authorization(), context());
  for (const event of ['POLICY_INTENT', 'POLICY_RESTORED', 'BARRIER_INTENT', 'BARRIER_REMOVED', 'OWNER_INTENT', 'OWNER_RETIRED']) {
    j = advanceEmergencyHandoff(j, event, NOW);
  }
  assert.equal(nextEmergencyHandoffAction(j, POST_OWNER), 'SEAL_COMPLETE');
  j = advanceEmergencyHandoff(j, 'HANDOFF_COMPLETE', NOW);
  assert.equal(nextEmergencyHandoffAction(j, { ...POST_OWNER, receiptPresent: true }), 'DONE');
  assert.equal(nextEmergencyHandoffAction(j, POST_OWNER), 'SEAL_RECEIPT');
});

test('EH-18: inconsistent live state stops instead of guessing', () => {
  const j = initialEmergencyHandoff(authorization(), context());
  for (const observed of [
    { ...PRE, ownerPresent: false },
    { ...PRE, barrierPresent: false },
    { ...PRE, permitPresent: true },
    { ...PRE, dropInPresent: false, restartPolicy: 'on-failure', needDaemonReload: true },
  ]) assert.equal(nextEmergencyHandoffAction(j, observed), 'STOP');
});

test('EH-19: journal hash tamper, foreign journal and duplicate terminal events are rejected', () => {
  const j = initialEmergencyHandoff(authorization(), context());
  const tampered = { ...j, hash: h('0') };
  assert.throws(() => advanceEmergencyHandoff(tampered, 'BARRIER_INTENT', NOW), /EMERGENCY_HANDOFF_JOURNAL_HASH_INVALID/);
  let done = completeHandoff();
  assert.throws(() => advanceEmergencyHandoff(done, 'HANDOFF_COMPLETE', NOW), /EMERGENCY_HANDOFF_TRANSITION_INVALID/);
  assert.throws(() => advanceEmergencyHandoff(done, 'POLICY_INTENT', NOW), /EMERGENCY_HANDOFF_TRANSITION_INVALID/);
});

test('EH-20: observation, acceptance and completion events have no transition authority', () => {
  const j = initialEmergencyHandoff(authorization(), context());
  for (const event of ['OBSERVATION_PASSED', 'ACCEPTED', 'COMPLETED', 'COMPLETED_ABORT', 'START_APP']) {
    assert.throws(() => advanceEmergencyHandoff(j, event, NOW), /EMERGENCY_HANDOFF_EVENT_INVALID/);
  }
});

test('EH-21: the terminal receipt is a distinct operational status, not R4 acceptance', () => {
  const auth = authorization(), ctx = context();
  const j = completeHandoff();
  const receipt = sealEmergencyHandoffReceipt(j, auth, { ...ctx, journal: { present: true, authorizationId: auth.authorizationId, authorizationSha256: h('4'), terminal: false } }, NOW);
  assert.equal(receipt.operationalStatus, EMERGENCY_OPERATIONAL_STATUS);
  assert.equal(receipt.r4TerminalState, EMERGENCY_R4_TERMINAL_STATE);
  assert.equal(receipt.r4Acceptance, 'NOT_ACCEPTED');
  assert.equal(receipt.observationPassed, false);
  assert.equal(receipt.parentAttemptCompleted, false);
  assert.equal(receipt.futureReleaseAuthority, false);
  assert.equal(receipt.handoff.journalHeadSha256, j.hash);
  assert.equal(receipt.parent.checkpointSha256, h('c'));
  assert.match(receipt.hash, /^[0-9a-f]{64}$/);
});

test('EH-22: a receipt cannot be sealed from an incomplete journal or forged flags', () => {
  const auth = authorization(), ctx = context();
  let j = initialEmergencyHandoff(auth, ctx);
  assert.throws(() => sealEmergencyHandoffReceipt(j, auth, ctx, NOW), /EMERGENCY_HANDOFF_NOT_COMPLETE/);
  j = completeHandoff();
  const forged = { ...j, observationPassed: true };
  const resealed = { ...forged, hash: '0'.repeat(64) };
  assert.throws(() => sealEmergencyHandoffReceipt(resealed, auth, ctx, NOW), /EMERGENCY_HANDOFF_JOURNAL_HASH_INVALID/);
});

test('EH-23: the receipt yields a future-owner supersession record, never COMPLETED', () => {
  const auth = authorization(), ctx = context();
  const j = completeHandoff();
  const receipt = sealEmergencyHandoffReceipt(j, auth, { ...ctx, journal: { present: true, authorizationId: auth.authorizationId, authorizationSha256: h('4'), terminal: false } }, NOW);
  const supersession = verifyEmergencyHandoffReceipt(receipt, {
    authorizationId: auth.authorizationId, authorizationSha256: h('4'), toolArtifactSha256: h('3'),
    parent: { ...auth.parent },
  });
  assert.equal(supersession.disposition, 'SUPERSEDED_BY_EMERGENCY_HANDOFF');
  assert.equal(supersession.parentAttemptId, PARENT_ID);
  assert.equal(supersession.parentAttemptCompleted, false);
  assert.equal(supersession.grantsReleaseAuthority, false);
  assert.equal(supersession.r4TerminalState, EMERGENCY_R4_TERMINAL_STATE);
});

test('EH-24: a receipt bound to another parent, tool or authorization is rejected', () => {
  const auth = authorization(), ctx = context();
  const receipt = sealEmergencyHandoffReceipt(completeHandoff(), auth, { ...ctx, journal: { present: true, authorizationId: auth.authorizationId, authorizationSha256: h('4'), terminal: false } }, NOW);
  const expected = { authorizationId: auth.authorizationId, authorizationSha256: h('4'), toolArtifactSha256: h('3'), parent: { ...auth.parent } };
  assert.throws(() => verifyEmergencyHandoffReceipt({ ...receipt, parent: { ...receipt.parent, attemptId: '22222222-2222-4222-8222-222222222222' } }, expected), /EMERGENCY_HANDOFF_RECEIPT_HASH_INVALID|EMERGENCY_HANDOFF_RECEIPT_INVALID/);
  assert.throws(() => verifyEmergencyHandoffReceipt(receipt, { ...expected, toolArtifactSha256: h('9') }), /EMERGENCY_HANDOFF_RECEIPT_BINDING_MISMATCH/);
  assert.throws(() => verifyEmergencyHandoffReceipt({ ...receipt, observationPassed: true }, expected), /EMERGENCY_HANDOFF_RECEIPT_HASH_INVALID|EMERGENCY_HANDOFF_RECEIPT_INVALID/);
});

test('EH-25: a future release transition requires exclusive, clean, restart-protected ownership', () => {
  const auth = authorization(), ctx = context();
  const receipt = sealEmergencyHandoffReceipt(completeHandoff(), auth, { ...ctx, journal: { present: true, authorizationId: auth.authorizationId, authorizationSha256: h('4'), terminal: false } }, NOW);
  const expected = { authorizationId: auth.authorizationId, authorizationSha256: h('4'), toolArtifactSha256: h('3'), parent: { ...auth.parent } };
  const clean = { activeAttemptId: null, barrierPresent: false, permitPresent: false, dropInPresent: false, restartPolicy: 'on-failure' };
  assert.equal(assertForwardTransitionEligible({ receipt, expected, live: clean }).disposition, 'SUPERSEDED_BY_EMERGENCY_HANDOFF');
  for (const mutate of [
    live => { live.activeAttemptId = PARENT_ID; },
    live => { live.barrierPresent = true; },
    live => { live.permitPresent = true; },
    live => { live.dropInPresent = true; },
    live => { live.restartPolicy = 'no'; },
  ]) {
    const live = { ...clean }; mutate(live);
    assert.throws(() => assertForwardTransitionEligible({ receipt, expected, live }), /FORWARD_TRANSITION_(OWNERSHIP|POLICY)_CONFLICT/);
  }
});

test('EH-26: a missing, truncated or foreign receipt never enables a future transition', () => {
  const expected = { authorizationId: '11111111-1111-4111-8111-111111111111', authorizationSha256: h('4'), toolArtifactSha256: h('3'), parent: { ...authorization().parent } };
  const clean = { activeAttemptId: null, barrierPresent: false, permitPresent: false, dropInPresent: false, restartPolicy: 'on-failure' };
  assert.throws(() => assertForwardTransitionEligible({ receipt: null, expected, live: clean }), /EMERGENCY_HANDOFF_RECEIPT_INVALID/);
  assert.throws(() => verifyEmergencyHandoffReceipt({ kind: 'EMERGENCY_HANDOFF_RECEIPT' }, expected), /EMERGENCY_HANDOFF_RECEIPT_INVALID/);
});
