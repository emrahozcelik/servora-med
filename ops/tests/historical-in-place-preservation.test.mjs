// OPS-R4-002 non-destructive (in-place) historical preservation.
//
// These tests exercise the real controller, the real evidence layer and the real
// protected readers through the in-memory Linux host boundary. Every record,
// dump and log is synthetic; no production path is opened or written.
import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {
  adoptionHost,adoptionFixture67d3318 as adoptionFixture
} from './installed-old-adoption-fixture.mjs';
import {legacyTimeEvidenceAt,timeEvidenceAt} from './trusted-time-fixture.mjs';
import {
  historicalFixture,installHistoricalSource,installHistoricalStage,
  ATTEMPT,STATE,DISPOSITION,OLD_APPROVAL,ARCHIVED_PATHS
} from './historical-recovery-fixture.mjs';
import {
  HISTORICAL_STAGING_DIR,HISTORICAL_STAGING_RECEIPT
} from '../scripts/historical-recovery-evidence.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const json=value=>Buffer.from(JSON.stringify(value)+'\n');
const adoptionRecord=STATE+'/installed-old-adoption-67d3318.json';
const archiveDir='/var/lib/servora-med-recovery-archive/'+ATTEMPT;
const readRecord=(host,path)=>JSON.parse(host.files.get(path).data.toString());
const writeRecord=(host,path,record)=>{
  const bytes=json(record);host.files.get(path).data=bytes;return bytes;
};
const invalid=fn=>assert.throws(fn,/RECOVERY_HISTORICAL_PRESERVATION_INVALID/);

/**
 * Full synthetic host at the exact state the operator reaches after the
 * disposition, the OPS-R4-005 stage and the profile re-seal.
 */
async function preservedHost(t,{stageOptions}={}){
  const historical=historicalFixture();
  const adoption=adoptionFixture();
  const host=await adoptionHost(adoption);
  if(t)t.after(host.cleanup);
  installHistoricalSource(host,historical);
  host.directories.set(STATE+'/historical-dispositions',0o700);
  const disposition=host.controller.issueHistoricalRecoveryDisposition();
  const stage=installHistoricalStage(host,historical,stageOptions);
  // A genuine new root approval is issued after the re-seal. The fixture clock
  // is already the disposition day, so only the approval window changes.
  const approval=adoption.context.approval;
  Object.assign(approval,{issuedAtUTC:'2026-11-10T10:05:00.000Z',
    expiresAtUTC:'2026-11-10T11:40:00.000Z',
    issuedTime:timeEvidenceAt(Date.parse('2026-11-10T10:05:00.000Z'))});
  host.add(STATE+'/approvals/'+approval.attemptId+'.json',json(approval),0o600);
  host.add(STATE+'/profile.json',json(adoption.context.profile),0o600);
  return {historical,adoption,host,disposition,stage,approval};
}

function resealDisposition(host,mutate){
  const record=readRecord(host,DISPOSITION);
  mutate(record);
  const bytes=writeRecord(host,DISPOSITION,record);
  host.files.get(HISTORICAL_STAGING_DIR+'/preserved/disposition.json').data=bytes;
  const receipt=readRecord(host,HISTORICAL_STAGING_RECEIPT);
  receipt.dispositionSha256=hash(bytes);
  const entry=receipt.files.find(item=>item.archivePath==='preserved/disposition.json');
  entry.sha256=hash(bytes);entry.size=bytes.length;
  writeRecord(host,HISTORICAL_STAGING_RECEIPT,receipt);
}

function resealReceipt(host,mutate){
  const receipt=readRecord(host,HISTORICAL_STAGING_RECEIPT);
  mutate(receipt);
  writeRecord(host,HISTORICAL_STAGING_RECEIPT,receipt);
}

test('the exact historical attempt stays in place and the new policy passes the historical gate',async t=>{
  const {historical,adoption,host,stage}=await preservedHost(t);
  const gate=host.controller.verifyHistoricalInPlacePreservation();
  assert.equal(gate.status,'IN_PLACE_PRESERVATION_VERIFIED');
  assert.equal(gate.authority,'SOURCE_RETAINED_NOT_ARCHIVED_NOT_INDEPENDENTLY_RETAINED');
  assert.equal(gate.archived,false);
  assert.equal(gate.sourceRetained,true);
  assert.equal(gate.filesVerified,26);
  assert.equal(gate.terminal,false);
  assert.equal(gate.r4Acceptance,'NOT_ACCEPTED');
  assert.equal(gate.receiptSha256,stage.receiptSha256);
  assert.equal(host.files.has(archiveDir),false);
  assert.equal(host.directories.has(archiveDir),false);

  // The synthetic release cannot reproduce the real recovered content manifest
  // (059dedcb…), so issuance stops at the pinned release identity — never at the
  // historical gate — and publishes nothing.
  assert.throws(()=>host.controller.issueInstalledOldAdoption67d3318(
    adoption.context.approval.attemptId,adoption.baseline.baselineId),
  /RECOVERY_INSTALLED_OLD_ADOPTION_INVALID/);
  assert.equal(host.files.has(adoptionRecord),false);
  // Exactly one record; no archive metadata and no source removal.
  for(const path of [archiveDir+'/ARCHIVE-MANIFEST.json',archiveDir+'/ARCHIVE-COMPLETE.json',
    archiveDir+'/SOURCE-EMPTY-PROOF.json'])assert.equal(host.files.has(path),false);
  for(const rel of ARCHIVED_PATHS){
    assert.equal(hash(host.files.get(STATE+'/'+rel).data),hash(historical.movedFiles.get(rel)));
  }
  // The 71ae6df6 record and the live disposition are not rewritten.
  assert.equal(hash(host.files.get(DISPOSITION).data),
    hash(host.files.get(HISTORICAL_STAGING_DIR+'/preserved/disposition.json').data));
});

test('no stage receipt means no in-place acceptance',async t=>{
  const {adoption,host}=await preservedHost(t);
  host.files.delete(HISTORICAL_STAGING_RECEIPT);
  assert.throws(()=>host.controller.verifyHistoricalInPlacePreservation(),
    /RECOVERY_HISTORICAL_PRESERVATION_REQUIRED/);
  assert.throws(()=>host.controller.issueInstalledOldAdoption67d3318(
    adoption.context.approval.attemptId,adoption.baseline.baselineId),
  /RECOVERY_HISTORICAL_PRESERVATION_REQUIRED/);
  assert.equal(host.files.has(adoptionRecord),false);
});

test('a partial or foreign stage tree is never accepted',async t=>{
  for(const kind of ['missing-file','extra-file','extra-directory']){
    const {host}=await preservedHost(t);
    if(kind==='missing-file')host.files.delete(HISTORICAL_STAGING_DIR+'/'+ARCHIVED_PATHS[3]);
    if(kind==='extra-file')host.add(HISTORICAL_STAGING_DIR+'/attempts/.hidden','x',0o600);
    if(kind==='extra-directory')host.directories.set(HISTORICAL_STAGING_DIR+'/scratch',0o700);
    assert.throws(()=>host.controller.verifyHistoricalInPlacePreservation(),
      /RECOVERY_HISTORICAL_STAGE_READBACK_INVALID/);
  }
});

test('a modified, missing, extra or re-timestamped live evidence file is rejected',async t=>{
  const mutations=[
    host=>host.files.get(STATE+'/'+ARCHIVED_PATHS[7]).data=Buffer.from('tampered\n'),
    host=>host.files.delete(STATE+'/'+ARCHIVED_PATHS[0]),
    host=>host.add(STATE+'/attempts/'+ATTEMPT+'/0018.json','extra\n',0o600),
    host=>host.files.get(STATE+'/'+ARCHIVED_PATHS[2]).mtimeNs='1762770600000000001',
    host=>host.add(STATE+'/attempts/11111111-1111-4111-8111-111111111111/0000.json','x\n',0o600),
    host=>host.files.get(STATE+'/backups/'+ATTEMPT+'-pre.dump').data=Buffer.from('corrupt dump\n'),
    host=>host.add(STATE+'/logs/'+ATTEMPT+'/unexpected.log','x\n',0o600),
  ];
  for(const mutate of mutations){
    const {host}=await preservedHost(t);
    mutate(host);
    invalid(()=>host.controller.verifyHistoricalInPlacePreservation());
  }
});

test('a forged disposition, terminal state or wrong profile binding is rejected',async t=>{
  const mutations=[
    record=>{record.terminal=true;},
    record=>{record.r4Acceptance='ACCEPTED';},
    record=>{record.lastPhase='COMPLETED';},
    record=>{record.classification='COMPLETED';},
    record=>{record.profileSha256='0'.repeat(64);},
    record=>{record.approvalSha256='0'.repeat(64);},
    record=>{record.lastCheckpointSha256='0'.repeat(64);},
    record=>{record.starts=1;},
    record=>{record.machineId='2'.repeat(32);},
  ];
  for(const mutate of mutations){
    const {host}=await preservedHost(t);
    resealDisposition(host,mutate);
    invalid(()=>host.controller.verifyHistoricalInPlacePreservation());
  }
});

test('UNKNOWN trusted time cannot authorize in-place preservation',async t=>{
  const {host}=await preservedHost(t);
  resealDisposition(host,record=>{
    const legacy=legacyTimeEvidenceAt(Date.parse(record.issuedAtUTC));
    record.issuedTime=legacy;record.issuedAtUTC=legacy.wallAtUTC;
  });
  assert.throws(()=>host.controller.verifyHistoricalInPlacePreservation(),
    /TIME|TRUSTED_TIME/);
});

test('the stage profile copy must keep the exact pre-reseal hash binding',async t=>{
  const {host}=await preservedHost(t);
  const replacement=json({formatVersion:2,machineId:'3'.repeat(32)});
  host.files.get(HISTORICAL_STAGING_DIR+'/preserved/profile.json').data=replacement;
  resealReceipt(host,receipt=>{
    receipt.profileSha256=hash(replacement);
    const entry=receipt.files.find(item=>item.archivePath==='preserved/profile.json');
    entry.sha256=hash(replacement);entry.size=replacement.length;
  });
  invalid(()=>host.controller.verifyHistoricalInPlacePreservation());
});

test('a different approval, release or artifact identity is rejected',async t=>{
  const mutations=[
    approval=>{approval.releaseSha='0'.repeat(40);},
    approval=>{approval.treeSha='0'.repeat(40);},
    approval=>{approval.artifactSha256='0'.repeat(64);},
    approval=>{approval.maxStarts=3;},
  ];
  for(const mutate of mutations){
    const {host}=await preservedHost(t);
    const approval=readRecord(host,OLD_APPROVAL);
    mutate(approval);
    writeRecord(host,OLD_APPROVAL,approval);
    assert.throws(()=>host.controller.verifyHistoricalInPlacePreservation(),
      /RECOVERY_HISTORICAL_PRESERVATION_INVALID/);
  }
});

test('pending deployment state and a lost host lock still fail closed',async t=>{
  const active=(await preservedHost(t)).host;
  active.add(STATE+'/active.json',json({attemptId:ATTEMPT,approvalSha256:'0'.repeat(64)}),0o600);
  assert.throws(()=>active.controller.verifyHistoricalInPlacePreservation(),
    /RECOVERY_HISTORICAL_PRESERVATION_INVALID/);

  const activation=(await preservedHost(t)).host;
  activation.add(STATE+'/activation.block',json({attemptId:ATTEMPT,approvalSha256:'0'.repeat(64)}),0o600);
  assert.throws(()=>activation.controller.verifyHistoricalInPlacePreservation(),
    /RECOVERY_HISTORICAL_PRESERVATION_INVALID/);

  const {adoption,host:locked}=await preservedHost(t);
  locked.fds.delete(9);
  assert.throws(()=>locked.controller.issueInstalledOldAdoption67d3318(
    adoption.context.approval.attemptId,adoption.baseline.baselineId),
  /RECOVERY_ADOPTION_HOST_LOCK_REQUIRED/);
  assert.equal(locked.files.has(adoptionRecord),false);
});

test('a started but incomplete sealed archive never falls back to in-place acceptance',async t=>{
  const {host}=await preservedHost(t);
  host.directories.set(archiveDir,0o700);
  assert.throws(()=>host.controller.verifyHistoricalPreservationGate(),
    /RECOVERY_HISTORICAL_ARCHIVE_/);
});

test('the OPS-R4-003 sealed archive remains the accepted first branch',async t=>{
  const {installHistoricalArchive}=await import('./historical-recovery-fixture.mjs');
  const f=historicalFixture(),adoption=adoptionFixture();
  const host=await adoptionHost(adoption);
  t.after(host.cleanup);
  installHistoricalArchive(host,f);
  const result=host.controller.verifyHistoricalPreservationGate();
  assert.equal(result.complete,true);
  assert.equal(result.terminal,false);
  assert.equal(result.attemptId,ATTEMPT);
});

test('the historical attempt UUID cannot be reused as the new deployment attempt',async t=>{
  const {adoption,host}=await preservedHost(t);
  assert.throws(()=>host.controller.issueInstalledOldAdoption67d3318(
    ATTEMPT,adoption.baseline.baselineId));
  assert.equal(host.files.has(adoptionRecord),false);
});

test('a non-root caller cannot run the in-place verifier',async t=>{
  const {host}=await preservedHost(t);
  t.mock.method(host.process,'getuid',()=>1001);
  assert.throws(()=>host.controller.verifyHistoricalInPlacePreservation(),
    /RECOVERY_HISTORICAL_PRESERVATION_INVALID/);
});

test('a new attempt starts its own chain and does not inherit the old start budget',async t=>{
  const {host,adoption}=await preservedHost(t);
  const attemptId=adoption.context.approval.attemptId;
  const context=host.controller.loadAttempt(attemptId);
  const initial=host.attempt.initialAttempt(context,
    timeEvidenceAt(Date.parse('2026-11-10T10:30:00.000Z')));
  assert.equal(initial.attemptId,attemptId);
  assert.notEqual(initial.attemptId,ATTEMPT);
  assert.equal(initial.sequence,0);
  assert.equal(initial.previousHash,null);
  assert.equal(initial.phase,'ADMITTED');
  assert.equal(initial.starts,0);
  assert.equal(initial.abortStarts,0);
  // The consumed historical chain keeps its own terminal evidence untouched.
  assert.equal(readRecord(host,STATE+'/attempts/'+ATTEMPT+'/0017.json').starts,2);
  assert.equal(host.files.has(STATE+'/attempts/'+ATTEMPT+'/0018.json'),false);
  assert.equal(host.directories.has(STATE+'/attempts/'+attemptId),false);
});
