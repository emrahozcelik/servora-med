import assert from 'node:assert/strict';
import test from 'node:test';
import {validateApproval,initialAttempt,advanceAttempt,acceptedHandoffDirection,
  admissionConfirmation,validateAdmissionConfirmation} from '../scripts/deployment-attempt.mjs';
import {approvalFixture,timeEvidenceAt} from './trusted-time-fixture.mjs';

test('A2-01/04/05/06: v2 uses its persisted issue anchor, including expiry+1ms rollback',()=>{
  const grant=approvalFixture(),issued=Date.parse(grant.issuedAtUTC),expiry=Date.parse(grant.expiresAtUTC);
  assert.equal(validateApproval(grant,timeEvidenceAt(issued+1000)),grant);
  assert.throws(()=>validateApproval(grant,timeEvidenceAt(expiry)),/ATTEMPT_APPROVAL_TIME_INVALID/);
  assert.throws(()=>validateApproval(grant,timeEvidenceAt(expiry+1)),/ATTEMPT_APPROVAL_TIME_INVALID/);
  assert.throws(()=>validateApproval(grant,timeEvidenceAt(expiry+1,{wallAtUTC:timeEvidenceAt(issued+1000).wallAtUTC})),/TRUSTED_TIME_UNKNOWN|ATTEMPT_APPROVAL_TIME_INVALID/);
});

test('A2-18/19/24/26: consumed authority survives expiry/reboot without resetting start or abort budgets',()=>{
  const grant=approvalFixture(),context={approval:grant,approvalSha256:'4'.repeat(64)};
  const initial=initialAttempt(context,timeEvidenceAt());
  const later=timeEvidenceAt(Date.parse(grant.expiresAtUTC)+1,{bootId:'22222222-2222-4222-8222-222222222222',bootLowerMs:1000,bootUpperMs:1000});
  const backed=advanceAttempt(initial,context,{kind:'PREDEPLOY_BACKUP',receipt:{sha256:'6'.repeat(64),completedAtUTC:grant.issuedAtUTC}},later);
  assert.equal(backed.phase,'BACKED_UP');assert.deepEqual(backed.admissionTime,initial.admissionTime);
  const ambiguous={...backed,phase:'START_INTENT',starts:1,lastStart:'intent',migrationCommitted:true};
  assert.throws(()=>advanceAttempt(ambiguous,context,'START_INTENT',later),/ATTEMPT_START_AMBIGUOUS/);
  const abort={...backed,phase:'ABORTED',abortStarts:1,lastStart:'pass'};
  assert.equal(acceptedHandoffDirection(abort,context,later),'old');
  assert.equal(advanceAttempt(abort,context,'COMPLETED_ABORT',later).abortStarts,1);
});

test('A2-21/27/29/30: post-fsync confirmation binds the exact initial record and original window',()=>{
  const grant=approvalFixture(),context={approval:grant,approvalSha256:'4'.repeat(64)};
  const initial=initialAttempt(context,timeEvidenceAt());
  const proof=admissionConfirmation(context,initial,timeEvidenceAt(Date.parse(grant.issuedAtUTC)+20));
  assert.equal(validateAdmissionConfirmation(context,initial,proof),proof);
  for(const invalid of [{...proof,initialSha256:'5'.repeat(64)},{...proof,extra:true},
    {...proof,postFsyncTime:timeEvidenceAt(Date.parse(grant.expiresAtUTC)-3599999)},
    {...proof,postFsyncTime:{...proof.postFsyncTime,bootId:'22222222-2222-4222-8222-222222222222'}}]) {
    assert.throws(()=>validateAdmissionConfirmation(context,initial,invalid));
  }
  assert.throws(()=>validateAdmissionConfirmation(context,{...initial,starts:1},proof));
});

test('A2-07/08/09/11/12/13/14/20: ambiguous clocks and legacy authority fail closed',()=>{
  const grant=approvalFixture(),issued=Date.parse(grant.issuedAtUTC),normal=timeEvidenceAt(issued+1000);
  const cases=[
    {...normal,wallAtUTC:timeEvidenceAt(issued-1000).wallAtUTC},
    {...normal,wallAtUTC:timeEvidenceAt(issued+2000).wallAtUTC},
    {...normal,wallAtUTC:timeEvidenceAt(Date.parse(grant.expiresAtUTC)+1).wallAtUTC},
    {...normal,bootId:'22222222-2222-4222-8222-222222222222'},
    {...normal,timeNamespaceId:'time:[99]'},
    {...normal,synchronization:null},
    {...normal,synchronization:{...normal.synchronization,referenceAgeMs:768001}},
    {...normal,synchronization:{...normal.synchronization,rootDistanceMs:1001}},
    {...normal,synchronization:{...normal.synchronization,correctionMs:101}},
    {...normal,bootUpperMs:NaN},issued+1000,
  ];
  for(const current of cases)assert.throws(()=>validateApproval(grant,current),/TRUSTED_TIME_UNKNOWN|ATTEMPT_APPROVAL_TIME_INVALID/);
  assert.throws(()=>validateApproval({...grant,formatVersion:1},normal));
  const context={approval:grant,approvalSha256:'4'.repeat(64)},initial=initialAttempt(context,timeEvidenceAt());
  const {admissionTime,timeEvidence,...legacy}=initial;
  assert.throws(()=>advanceAttempt({...legacy,formatVersion:1},context,'VALIDATE',normal),/ATTEMPT_JOURNAL_INVALID/);
});

test('A2-18: a newly synchronized UTC correction cannot renew or revoke proven consumed scope',()=>{
  const grant=approvalFixture(),context={approval:grant,approvalSha256:'4'.repeat(64)};
  const initial=initialAttempt(context,timeEvidenceAt());
  const corrected=timeEvidenceAt(Date.parse(grant.expiresAtUTC)+1000,{wallAtUTC:'2026-10-12T12:00:02.000Z'});
  assert.throws(()=>validateApproval(grant,corrected));
  const next=advanceAttempt(initial,context,'ABORT_INTENT',corrected);
  assert.equal(next.abortStarts,1);assert.deepEqual(next.admissionTime,initial.admissionTime);
  assert.throws(()=>advanceAttempt(next,context,'ABORT_INTENT',corrected),/ATTEMPT_TRANSITION_INVALID/);
});

test('A2-02/03/16: admission keeps the exact 3600-second window and the original boot proof',()=>{
  const grant=approvalFixture(),expiry=Date.parse(grant.expiresAtUTC),context={approval:grant,approvalSha256:'4'.repeat(64)};
  const atBoundary=timeEvidenceAt(expiry-3600000);
  const initial=initialAttempt(context,atBoundary);
  assert.equal(initial.formatVersion,2);assert.deepEqual(initial.admissionTime,atBoundary);
  assert.equal(validateApproval(grant,timeEvidenceAt(expiry-1)),grant,'validity lasts until E-1ms without admitting new work');
  for(const now of [expiry-3599999,expiry-1])assert.throws(()=>initialAttempt(context,timeEvidenceAt(now)),/WINDOW_INSUFFICIENT/);
  assert.throws(()=>initialAttempt(context,{...atBoundary,bootLowerMs:atBoundary.bootLowerMs+1,bootUpperMs:atBoundary.bootUpperMs+1}),/WINDOW_INSUFFICIENT/);
});
