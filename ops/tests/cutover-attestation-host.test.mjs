// Synthetic I/O and two explicitly synthetic payload pins; real controller,
// historical preservation, protected readers and admission state machine.
import assert from 'node:assert/strict';
import test from 'node:test';
import {cutoverHost,freshGrant,ATTESTATION,hash,json} from './cutover-attestation-fixture.mjs';
import {STATE} from './historical-recovery-fixture.mjs';

test('root issuer seals separate identity/plan evidence without writing an adoption or admission',async t=>{
  const {f,host,approval}=await cutoverHost(t);
  const before=new Map([...host.files].map(([path,file])=>[path,hash(file.data)]));
  const sealed=host.controller.issueInstalledOldCutoverAttestation67d3318(approval.attemptId,f.baseline.baselineId);
  assert.equal(sealed.record.authority,'IDENTITY_AND_PLAN_ONLY_NOT_EXECUTION');
  assert.equal(Object.hasOwn(sealed.record,'attemptId'),false);
  assert.equal(Object.hasOwn(sealed.record,'approvalSha256'),false);
  assert.equal(sealed.sha256,hash(host.files.get(ATTESTATION).data));
  assert.deepEqual([...host.files.keys()].filter(path=>!before.has(path)),[ATTESTATION]);
  for(const [path,digest] of before)assert.equal(hash(host.files.get(path).data),digest,path);
});

test('real admission persistence consumes the exception even at starts=0; expiry/reboot permits only the confirmed same UUID',async t=>{
  const {f,host,approval}=await cutoverHost(t);
  host.controller.issueInstalledOldCutoverAttestation67d3318(approval.attemptId,f.baseline.baselineId);
  const grant=freshGrant(host,approval);
  const admitted=host.controller.admitAttempt(grant.attemptId);
  assert.equal(admitted.checkpoint.record.starts,0);
  assert.equal(admitted.checkpoint.record.phase,'ADMITTED');
  assert.equal(host.files.has(STATE+'/initializations/'+grant.attemptId+'.json'),false);
  const other=freshGrant(host,approval,{attemptId:'44444444-4444-4444-8444-444444444444'});
  assert.throws(()=>host.controller.verifyAttemptRelease(other.attemptId,'old'),/RECOVERY_RELEASE_UNPROVEN/);
  assert.throws(()=>host.controller.admitAttempt(other.attemptId),/RECOVERY_RELEASE_UNPROVEN/);
  assert.equal(host.files.has(STATE+'/initializations/'+other.attemptId+'.json'),false);
  // Simulate owner retirement without deleting consumption evidence. Terminal
  // or zero-start records must not make the exception available to a new UUID.
  host.files.delete(STATE+'/active.json');
  assert.throws(()=>host.controller.admitAttempt(other.attemptId),/RECOVERY_RELEASE_UNPROVEN/);
  host.now={...host.now,bootId:'55555555-5555-4555-8555-555555555555',wallAtUTC:'2026-11-15T10:00:00.000Z'};
  host.controller=await host.restart();
  assert.doesNotThrow(()=>host.controller.verifyAttemptRelease(grant.attemptId,'old'));
  assert.equal(host.controller.loadAttempt(grant.attemptId).approval.maxStarts,grant.maxStarts);
  assert.equal(admitted.checkpoint.record.starts,0);
});

test('fresh same-plan authority proves OLD after reboot while the old grant remains denied',async t=>{
  const {f,host,approval}=await cutoverHost(t);
  const sealed=host.controller.issueInstalledOldCutoverAttestation67d3318(approval.attemptId,f.baseline.baselineId);
  const grant=freshGrant(host,approval);
  host.controller=await host.restart();
  assert.throws(()=>host.controller.verifyAttemptRelease(approval.attemptId,'old'),
    /TIME|TRUSTED_TIME/);
  assert.doesNotThrow(()=>host.controller.verifyAttemptRelease(grant.attemptId,'old'));
  assert.equal(hash(host.files.get(ATTESTATION).data),sealed.sha256);
});

test('a direct fresh admission cannot use identity evidence without the stable host lock',async t=>{
  const {f,host,approval}=await cutoverHost(t);
  host.controller.issueInstalledOldCutoverAttestation67d3318(approval.attemptId,f.baseline.baselineId);
  const grant=freshGrant(host,approval);
  host.fds.delete(9);
  const before=[...host.files.keys()];
  assert.throws(()=>host.controller.admitAttempt(grant.attemptId),/RECOVERY_RELEASE_UNPROVEN/);
  assert.deepEqual([...host.files.keys()],before);
});

test('3599 seconds refuses before publication or admission writes, while the exact 3600-second boundary is admitted',async t=>{
  const {f,host,approval}=await cutoverHost(t);
  approval.expiresAtUTC=new Date(Date.parse(host.now.wallAtUTC)+3599_000).toISOString();
  host.add(STATE+'/approvals/'+approval.attemptId+'.json',json(approval));
  assert.throws(()=>host.controller.issueInstalledOldCutoverAttestation67d3318(
    approval.attemptId,f.baseline.baselineId),/WINDOW_INSUFFICIENT/);
  assert.equal(host.files.has(ATTESTATION),false);
  approval.expiresAtUTC=new Date(Date.parse(host.now.wallAtUTC)+3600_000).toISOString();
  host.add(STATE+'/approvals/'+approval.attemptId+'.json',json(approval));
  const sealed=host.controller.issueInstalledOldCutoverAttestation67d3318(approval.attemptId,f.baseline.baselineId);
  const grant=freshGrant(host,approval,{expiresAtUTC:'2026-11-14T10:59:59.000Z'});
  const before=[...host.files.keys()];
  assert.throws(()=>host.controller.admitAttempt(grant.attemptId),/RECOVERY_RELEASE_UNPROVEN/);
  assert.deepEqual([...host.files.keys()],before);
  grant.expiresAtUTC='2026-11-14T11:00:00.000Z';
  host.add(STATE+'/approvals/'+grant.attemptId+'.json',json(grant));
  assert.equal(host.controller.admitAttempt(grant.attemptId).checkpoint.record.phase,'ADMITTED');
  assert.equal(hash(host.files.get(ATTESTATION).data),sealed.sha256);
});

test('confirmed consumption rejects a rewritten approval even when its UUID and plan remain the same',async t=>{
  const {f,host,approval}=await cutoverHost(t);
  host.controller.issueInstalledOldCutoverAttestation67d3318(approval.attemptId,f.baseline.baselineId);
  const grant=freshGrant(host,approval);
  host.controller.admitAttempt(grant.attemptId);
  // A separate root action overwriting an existing approval is forbidden in
  // production. Even injected here, it cannot renew consumed authority.
  const changed={...grant,expiresAtUTC:'2026-11-14T13:00:00.000Z'};
  host.add(STATE+'/approvals/'+grant.attemptId+'.json',json(changed));
  const before=new Map([...host.files].map(([path,file])=>[path,hash(file.data)]));
  assert.throws(()=>host.controller.admitAttempt(grant.attemptId),/INITIALIZATION_CONFLICT/);
  assert.deepEqual(new Map([...host.files].map(([path,file])=>[path,hash(file.data)])),before);
});
