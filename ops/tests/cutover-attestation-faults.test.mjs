// Injected I/O/restart faults, not real power loss or systemd/Chrony acceptance.
import assert from 'node:assert/strict';
import test from 'node:test';
import {cutoverHost,freshGrant,ATTESTATION,hash,json,readRecord} from './cutover-attestation-fixture.mjs';
import {STATE,ATTEMPT,ARCHIVED_PATHS} from './historical-recovery-fixture.mjs';

const legacy=STATE+'/installed-old-adoption-67d3318.json';
const snapshot=host=>new Map([...host.files].map(([path,file])=>[path,hash(file.data)]));
const unchanged=(host,before)=>{
  assert.deepEqual(snapshot(host),before);
};
async function sealedHost(t){
  const result=await cutoverHost(t),{f,host,approval}=result;
  host.controller.issueInstalledOldCutoverAttestation67d3318(approval.attemptId,f.baseline.baselineId);
  return result;
}

test('every initializer, journal, proof, backup, log or pending footprint blocks another UUID without writes',async t=>{
  const other='44444444-4444-4444-8444-444444444444';
  const paths=[STATE+'/initializations/'+other+'.json',STATE+'/attempts/'+other+'/0000.json',
    STATE+'/admission-proofs/'+other+'.json',STATE+'/backups/'+other+'-pre.dump',
    STATE+'/logs/'+other+'/unfinished.log',STATE+'/active.json',STATE+'/activation.block',
    '/run/servora-med-recovery/start.permit',
    '/etc/systemd/system/servora-med.service.d/90-servora-recovery.conf'];
  for(const path of paths){
    const {host,approval}=await sealedHost(t);
    const grant=freshGrant(host,approval);
    host.add(path,'uncertain\n');
    const before=snapshot(host);
    assert.throws(()=>host.controller.verifyAttemptRelease(grant.attemptId,'old'),/RECOVERY_RELEASE_UNPROVEN/);
    assert.throws(()=>host.controller.admitAttempt(grant.attemptId));
    unchanged(host,before);
  }
});

test('an unconfirmed same-UUID initializer cannot be promoted by new identity evidence or a different grant',async t=>{
  const {host,approval}=await sealedHost(t);
  const grant=freshGrant(host,approval),context=host.controller.loadAttempt(grant.attemptId);
  const initial=host.attempt.initialAttempt(context,host.now);
  host.add(STATE+'/initializations/'+grant.attemptId+'.json',json(initial));
  assert.equal(host.controller.loadAttempt(grant.attemptId).initializationPending,true);
  const next=freshGrant(host,approval,{attemptId:'44444444-4444-4444-8444-444444444444'});
  const before=snapshot(host);
  assert.throws(()=>host.controller.verifyAttemptRelease(grant.attemptId,'old'),/RECOVERY_RELEASE_UNPROVEN/);
  assert.throws(()=>host.controller.admitAttempt(grant.attemptId));
  assert.throws(()=>host.controller.admitAttempt(next.attemptId));
  unchanged(host,before);
});

test('a simulated admission write interruption survives controller restart and blocks fresh authority',async t=>{
  const {host,approval}=await sealedHost(t);
  const grant=freshGrant(host,approval);
  host.interruptWrite=true;
  assert.throws(()=>host.controller.admitAttempt(grant.attemptId),/simulated interruption/);
  host.interruptWrite=false;
  host.controller=await host.restart();
  const next=freshGrant(host,approval,{attemptId:'44444444-4444-4444-8444-444444444444'});
  const before=snapshot(host);
  assert.throws(()=>host.controller.admitAttempt(grant.attemptId),/NOT_CANONICAL/);
  assert.throws(()=>host.controller.admitAttempt(next.attemptId),/RECOVERY_RELEASE_UNPROVEN/);
  unchanged(host,before);
});

test('torn attestation publication burns its slot across restart and cannot fall back to adoption',async t=>{
  const {f,host,approval}=await cutoverHost(t);
  host.interruptWrite=true;
  assert.throws(()=>host.controller.issueInstalledOldCutoverAttestation67d3318(
    approval.attemptId,f.baseline.baselineId),/simulated interruption/);
  host.interruptWrite=false;
  host.controller=await host.restart();
  const before=snapshot(host),grant=freshGrant(host,approval);
  before.set(STATE+'/approvals/'+grant.attemptId+'.json',hash(host.files.get(STATE+'/approvals/'+grant.attemptId+'.json').data));
  assert.throws(()=>host.controller.issueInstalledOldCutoverAttestation67d3318(
    grant.attemptId,f.baseline.baselineId),/ALREADY_SEALED/);
  assert.throws(()=>host.controller.issueInstalledOldAdoption67d3318(
    grant.attemptId,f.baseline.baselineId),/EVIDENCE_CONFLICT/);
  assert.throws(()=>host.controller.admitAttempt(grant.attemptId),/RECOVERY_RELEASE_UNPROVEN/);
  unchanged(host,before);
});

test('EIO and ENOSPC during attestation fsync never report success, retry, publish adoption or touch historical files',async t=>{
  for(const code of ['EIO','ENOSPC']){
    const {f,host,approval}=await cutoverHost(t);
    const historical=new Map(ARCHIVED_PATHS.map(path=>[STATE+'/'+path,hash(host.files.get(STATE+'/'+path).data)]));
    host.onFsync=path=>{if(path===ATTESTATION)throw Object.assign(new Error(code),{code});};
    assert.throws(()=>host.controller.issueInstalledOldCutoverAttestation67d3318(
      approval.attemptId,f.baseline.baselineId),new RegExp(code));
    host.onFsync=null;
    host.controller=await host.restart();
    assert.throws(()=>host.controller.issueInstalledOldCutoverAttestation67d3318(
      approval.attemptId,f.baseline.baselineId),/ALREADY_SEALED/);
    assert.equal(host.files.has(legacy),false);
    for(const [path,digest] of historical)assert.equal(hash(host.files.get(path).data),digest);
    assert.equal(host.files.has(STATE+'/attempts/'+approval.attemptId+'/0000.json'),false);
  }
});

test('unreadable, linked, wrong-owner/mode and malformed evidence is never absent or fallback authority',async t=>{
  const mutations=[
    host=>{host.files.get(ATTESTATION).uid=1001;},
    host=>{host.files.get(ATTESTATION).gid=1001;},
    host=>{host.files.get(ATTESTATION).mode=0o644;},
    host=>{host.files.get(ATTESTATION).nlink=2;},
    host=>{host.files.get(ATTESTATION).data=Buffer.from('{');},
    host=>{host.files.delete(ATTESTATION);host.addSymlink(ATTESTATION,'/missing');},
    ...['EACCES','ENOTDIR'].map(code=>host=>{host.lstatErrors.set(ATTESTATION,code);})
  ];
  for(const mutate of mutations){
    const {f,host,approval}=await sealedHost(t);
    const grant=freshGrant(host,approval);mutate(host);
    const before=snapshot(host);
    assert.throws(()=>host.controller.admitAttempt(grant.attemptId));
    assert.throws(()=>host.controller.issueInstalledOldCutoverAttestation67d3318(grant.attemptId,f.baseline.baselineId));
    unchanged(host,before);
  }
});

test('legacy and new records cannot coexist and a corrupt present original archive never falls back',async t=>{
  const {f,host,approval}=await sealedHost(t);
  const grant=freshGrant(host,approval);
  host.add(legacy,'legacy bytes\n');
  const before=snapshot(host);
  assert.throws(()=>host.controller.verifyAttemptRelease(grant.attemptId,'old'),/RECOVERY_RELEASE_UNPROVEN/);
  unchanged(host,before);
  host.files.delete(legacy);
  const retained=STATE+'/artifacts/'+approval.oldReleaseSha+'.tar.gz';
  host.add(retained,'not the original archive');
  assert.throws(()=>host.controller.verifyAttemptRelease(grant.attemptId,'old'),/RECOVERY_RELEASE_UNPROVEN/);
  assert.equal(host.files.has(STATE+'/initializations/'+grant.attemptId+'.json'),false);
  assert.equal(readRecord(host,ATTESTATION).baselineId,f.baseline.baselineId);
  assert.equal(host.files.has(STATE+'/attempts/'+ATTEMPT+'/0017.json'),true);
});

test('the identity record alone cannot replace a missing execution approval',async t=>{
  const {host}=await sealedHost(t);
  const before=snapshot(host);
  assert.throws(()=>host.controller.admitAttempt('44444444-4444-4444-8444-444444444444'),/APPROVAL_MISSING/);
  unchanged(host,before);
});
