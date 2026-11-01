import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateEmergencyHandoffAuthorization,
  initialEmergencyHandoff,
  advanceEmergencyHandoff,
  nextEmergencyHandoffAction,
} from '../scripts/emergency-handoff.mjs';

const h = c => c.repeat(64);
const NOW = '2026-11-01T07:30:00Z';

function authorization() {
  return {
    formatVersion:1, kind:'EMERGENCY_HANDOFF_AUTHORIZATION',
    authorizationId:'11111111-1111-4111-8111-111111111111',
    issuedAtUTC:'2026-11-01T07:00:00Z', expiresAtUTC:'2026-11-01T11:00:00Z',
    maxUses:1, reason:'R4_OBSERVATION_TRUSTED_TIME_BLOCKED',
    parent:{
      attemptId:'6ce4cff0-fa73-450e-b540-3f54ae429e7c',
      approvalSha256:h('a'), profileSha256:h('b'),
      checkpointSequence:17, checkpointSha256:h('c'),
      phase:'POSTDEPLOY_BACKUP_PASSED', migrationCommitted:true,
    },
    host:{
      machineId:'ae00df7d546249218e3c5c2b5e21ecb6',
      database:{clusterId:'7678331783042422178',databaseName:'servora_med',databaseOid:16389},
      schemaHead:'060_crm_duplicate_review_decisions',
      releaseSha:'f5f87d450061ca12ee80451c55eb56e99b80823c',
      releaseArtifactSha256:h('d'), timeModuleSha256:h('e'), timeConfigSha256:h('f'),
      startBudget:{used:2,max:2},
    },
    backups:{preSha256:h('1'),postSha256:h('2')},
    actions:['restore_restart_on_failure','remove_barrier','retire_owner'],
    forbidden:['observation_passed','completed','migration','release_change'],
    toolSha256:h('3'),
  };
}

function context() {
  const a = authorization();
  return {
    nowUTC:NOW, authorizationSha256:h('4'), toolSha256:h('3'),
    parent:{...a.parent}, host:JSON.parse(JSON.stringify(a.host)), backups:{...a.backups},
    live:{
      activeAttemptId:a.parent.attemptId, activeApprovalSha256:a.parent.approvalSha256,
      barrierAttemptId:a.parent.attemptId, barrierApprovalSha256:a.parent.approvalSha256,
      permitPresent:false, foreignOwner:false, appActive:true, appPid:451513, coreHealth:true,
      releaseSha:a.host.releaseSha, schemaHead:a.host.schemaHead,
      starts:2, maxStarts:2, dropInPresent:true, restartPolicy:'no',
    },
  };
}

test('EH-01: valid authorization seals INTENT without observation authority',()=>{
  const auth=authorization(), ctx=context();
  assert.equal(validateEmergencyHandoffAuthorization(auth,ctx),auth);
  const j=initialEmergencyHandoff(auth,ctx);
  assert.equal(j.phase,'INTENT');
  assert.equal(j.observationPassed,false);
  assert.equal(j.acceptanceWaived,true);
  assert.equal(j.handoffCompleted,false);
  assert.equal(j.sequence,0);
  assert.match(j.hash,/^[0-9a-f]{64}$/);
  assert.deepEqual(nextEmergencyHandoffAction(j,{dropInPresent:true,barrierPresent:true,ownerPresent:true,restartPolicy:'no'}),'REMOVE_POLICY');
});

test('EH-02: wrong parent approval is rejected before any mutation',()=>{
  const auth=authorization(), ctx=context();
  ctx.parent.approvalSha256=h('9');
  assert.throws(()=>validateEmergencyHandoffAuthorization(auth,ctx),/EMERGENCY_HANDOFF_BINDING_MISMATCH/);
});

test('EH-03: non-060 schema is rejected',()=>{
  const auth=authorization();
  auth.host.schemaHead='059_crm_duplicate_read_indexes';
  assert.throws(()=>validateEmergencyHandoffAuthorization(auth,context()),/EMERGENCY_HANDOFF_AUTHORIZATION_INVALID/);
});

test('EH-04: module hash drift after issuance is rejected',()=>{
  const auth=authorization(), ctx=context();
  auth.host.timeModuleSha256=h('9');
  assert.throws(()=>validateEmergencyHandoffAuthorization(auth,ctx),/EMERGENCY_HANDOFF_BINDING_MISMATCH/);
});

test('EH-05: foreign active owner or live start budget drift is rejected',()=>{
  let ctx=context();
  ctx.live.activeApprovalSha256=h('9');
  assert.throws(()=>validateEmergencyHandoffAuthorization(authorization(),ctx),/EMERGENCY_HANDOFF_LIVE_STATE_MISMATCH/);
  ctx=context(); ctx.live.starts=1;
  assert.throws(()=>validateEmergencyHandoffAuthorization(authorization(),ctx),/EMERGENCY_HANDOFF_LIVE_STATE_MISMATCH/);
});

test('EH-06: missing or mismatched backup binding is rejected',()=>{
  const auth=authorization(), ctx=context();
  auth.backups.postSha256=h('9');
  assert.throws(()=>validateEmergencyHandoffAuthorization(auth,ctx),/EMERGENCY_HANDOFF_BINDING_MISMATCH/);
  const short=context(); delete short.backups.preSha256;
  assert.throws(()=>validateEmergencyHandoffAuthorization(authorization(),short),/EMERGENCY_HANDOFF_CONTEXT_INVALID/);
});

test('EH-07: half-completed policy step advances to barrier removal without repeating policy',()=>{
  let j=initialEmergencyHandoff(authorization(),context());
  j=advanceEmergencyHandoff(j,'POLICY_RESTORED',NOW);
  const next=nextEmergencyHandoffAction(j,{dropInPresent:false,barrierPresent:true,ownerPresent:true,restartPolicy:'on-failure'});
  assert.equal(next,'REMOVE_BARRIER');
  j=advanceEmergencyHandoff(j,'BARRIER_REMOVED',NOW);
  assert.equal(j.steps.barrierRemoved,true);
  assert.equal(j.steps.policyRestored,true);
});

test('EH-08: crash after owner retirement deterministically seals COMPLETED without observation',()=>{
  let j=initialEmergencyHandoff(authorization(),context());
  j=advanceEmergencyHandoff(j,'POLICY_RESTORED',NOW);
  j=advanceEmergencyHandoff(j,'BARRIER_REMOVED',NOW);
  j=advanceEmergencyHandoff(j,'OWNER_RETIRED',NOW);
  assert.equal(nextEmergencyHandoffAction(j,{dropInPresent:false,barrierPresent:false,ownerPresent:false,restartPolicy:'on-failure'}),'SEAL_COMPLETED');
  j=advanceEmergencyHandoff(j,'COMPLETED',NOW);
  assert.equal(j.phase,'COMPLETED');
  assert.equal(j.handoffCompleted,true);
  assert.equal(j.observationPassed,false);
  assert.equal(j.acceptanceWaived,true);
  assert.equal(nextEmergencyHandoffAction(j,{dropInPresent:false,barrierPresent:false,ownerPresent:false,restartPolicy:'on-failure'}),'DONE');
});

test('EH-09: exhausted start budget is bound, and the handoff never starts the app',()=>{
  const ctx=context();
  assert.equal(ctx.live.starts,2);
  assert.equal(ctx.live.maxStarts,2);
  const j=initialEmergencyHandoff(authorization(),ctx);
  assert.equal(Object.hasOwn(j,'starts'),false);
});

test('EH-10: core health failure denies before mutation',()=>{
  const ctx=context(); ctx.live.coreHealth=false;
  assert.throws(()=>validateEmergencyHandoffAuthorization(authorization(),ctx),/EMERGENCY_HANDOFF_LIVE_STATE_MISMATCH/);
});

test('EH-11: observation/completion events have no transition authority',()=>{
  const j=initialEmergencyHandoff(authorization(),context());
  for (const event of ['OBSERVATION_PASSED','ACCEPTED','COMPLETED_ACCEPTANCE']) {
    assert.throws(()=>advanceEmergencyHandoff(j,event,NOW),/EMERGENCY_HANDOFF_EVENT_INVALID/);
  }
  assert.equal(j.observationPassed,false);
});

test('EH-12: inconsistent live state stops instead of guessing',()=>{
  const j=initialEmergencyHandoff(authorization(),context());
  assert.equal(nextEmergencyHandoffAction(j,{dropInPresent:false,barrierPresent:true,ownerPresent:true,restartPolicy:'no'}),'STOP');
  assert.equal(nextEmergencyHandoffAction(j,{dropInPresent:true,barrierPresent:false,ownerPresent:true,restartPolicy:'no'}),'STOP');
});

test('EH-13: journal hash tamper and duplicate terminal events are rejected',()=>{
  const j=initialEmergencyHandoff(authorization(),context());
  const tampered={...j,hash:h('0')};
  assert.throws(()=>advanceEmergencyHandoff(tampered,'POLICY_RESTORED',NOW),/EMERGENCY_HANDOFF_JOURNAL_HASH_INVALID/);
  let done=advanceEmergencyHandoff(j,'POLICY_RESTORED',NOW);
  done=advanceEmergencyHandoff(done,'BARRIER_REMOVED',NOW);
  done=advanceEmergencyHandoff(done,'OWNER_RETIRED',NOW);
  done=advanceEmergencyHandoff(done,'COMPLETED',NOW);
  assert.throws(()=>advanceEmergencyHandoff(done,'COMPLETED',NOW),/EMERGENCY_HANDOFF_TRANSITION_INVALID/);
});
