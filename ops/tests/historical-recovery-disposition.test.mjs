import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {
  OPS_R4_003_POLICY,
  OPS_R4_003_LAYOUT,
  historicalRecoveryDispositionRecord,
  validateHistoricalRecoveryDisposition,
  issueHistoricalRecoveryDisposition,
  verifyHistoricalArchiveGate,
  issueInstalledOldAdoption67d3318
} from '../scripts/deployment-controller.mjs';
import {adoptionHost,adoptionFixture67d3318 as adoptionFixture} from './installed-old-adoption-fixture.mjs';
import {legacyTimeEvidenceAt} from './trusted-time-fixture.mjs';
import {
  historicalFixture,installHistoricalSource,installHistoricalArchive,
  ATTEMPT,DISPOSITION,ARCHIVE_DIR,STATE,OLD_APPROVAL,OLD_ADOPTION,OLD_BASELINE_MANIFEST,
  OLD_BASELINE_SUMS,EMERGENCY,OLD_BASELINE_DIR,ARCHIVED_PATHS,PRESERVED_EVIDENCE
} from './historical-recovery-fixture.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const read=(host,path)=>JSON.parse(host.files.get(path).data.toString());
const write=(host,path,record)=>{const bytes=Buffer.from(JSON.stringify(record)+'\n');host.files.get(path).data=bytes;return bytes;};
const manifestPath=ARCHIVE_DIR+'/ARCHIVE-MANIFEST.json';
const proofPath=ARCHIVE_DIR+'/SOURCE-EMPTY-PROOF.json';
const completePath=ARCHIVE_DIR+'/ARCHIVE-COMPLETE.json';

function reseal(host){
  const disposition=read(host,DISPOSITION);
  const dispositionBytes=write(host,DISPOSITION,disposition);
  const dispositionSha256=hash(dispositionBytes);
  const copyPath=ARCHIVE_DIR+'/preserved/disposition.json';
  if(host.files.has(copyPath))host.files.get(copyPath).data=dispositionBytes;
  const manifest=read(host,manifestPath);
  manifest.dispositionSha256=dispositionSha256;
  const copyEntry=manifest.preservedEvidence.find(entry=>entry.role==='disposition-copy');
  if(copyEntry){copyEntry.sha256=dispositionSha256;copyEntry.size=dispositionBytes.length;}
  const manifestBytes=write(host,manifestPath,manifest);
  const manifestSha256=hash(manifestBytes);
  const proof=read(host,proofPath);
  proof.dispositionSha256=dispositionSha256;proof.manifestSha256=manifestSha256;
  const proofBytes=write(host,proofPath,proof);
  const proofSha256=hash(proofBytes);
  const complete=read(host,completePath);
  complete.dispositionSha256=dispositionSha256;complete.manifestSha256=manifestSha256;
  complete.sourceEmptyProofSha256=proofSha256;
  write(host,completePath,complete);
  return {dispositionSha256,manifestSha256,proofSha256};
}

async function gateHost(){
  const f=historicalFixture();
  const host=await adoptionHost(adoptionFixture());
  installHistoricalArchive(host,f);
  return {f,host};
}

test('OPS-R4-003 policy and layout pin the exact nonterminal historical identity',()=>{
  assert.equal(OPS_R4_003_POLICY.policyId,'OPS-R4-003');
  assert.equal(OPS_R4_003_POLICY.attemptId,ATTEMPT);
  assert.equal(OPS_R4_003_POLICY.lastSequence,17);
  assert.equal(OPS_R4_003_POLICY.checkpointCount,18);
  assert.equal(OPS_R4_003_POLICY.lastPhase,'POSTDEPLOY_BACKUP_PASSED');
  assert.equal(OPS_R4_003_POLICY.observationPassed,false);
  assert.equal(OPS_R4_003_POLICY.starts,2);
  assert.equal(OPS_R4_003_POLICY.maxStarts,2);
  assert.equal(OPS_R4_003_POLICY.abortStarts,0);
  assert.equal(OPS_R4_003_POLICY.classification,'ABANDONED_SUPERSEDED');
  assert.equal(OPS_R4_003_POLICY.r4Acceptance,'NOT_ACCEPTED');
  assert.equal(OPS_R4_003_POLICY.dispositionFile,DISPOSITION);
  assert.equal(OPS_R4_003_POLICY.archiveDir,ARCHIVE_DIR);
  assert.equal(OPS_R4_003_LAYOUT.archivedPaths.length,26);
  assert.equal(OPS_R4_003_LAYOUT.archivedPaths[0],'attempts/'+ATTEMPT+'/0000.json');
  assert.equal(OPS_R4_003_LAYOUT.archivedPaths.at(-1),'logs/'+ATTEMPT+'/postdeploy-operator-20261101T040551Z.rc');
  assert.deepEqual(OPS_R4_003_LAYOUT.archivedPaths,ARCHIVED_PATHS);
  assert.deepEqual(OPS_R4_003_LAYOUT.preservedEvidence,PRESERVED_EVIDENCE);
});

test('valid disposition binds the exact nonterminal attempt without becoming COMPLETED or ACCEPTED',()=>{
  const f=historicalFixture();
  assert.equal(validateHistoricalRecoveryDisposition(f.disposition,f.context),f.disposition);
  const built=historicalRecoveryDispositionRecord(f.context);
  assert.equal(built.attemptId,ATTEMPT);
  assert.equal(built.lastPhase,'POSTDEPLOY_BACKUP_PASSED');
  assert.equal(built.observationPassed,false);
  assert.equal(built.terminal,false);
  assert.equal(built.r4Acceptance,'NOT_ACCEPTED');
  assert.equal(built.starts,2);
  assert.equal(built.lastCheckpointSha256,f.last.sha256);
  assert.equal(built.initialCheckpointSha256,f.initial.sha256);
  assert.equal(built.approvalSha256,f.approvalSha256);
  assert.equal(built.emergencyReceiptSha256,f.emergencySha256);
  assert.equal(validateHistoricalRecoveryDisposition(built,f.context),built);
});

test('disposition rejects a terminal, accepted, observed or budget-reset attempt',()=>{
  for(const mutate of [
    f=>{f.context.lastCheckpoint.record.phase='COMPLETED';},
    f=>{f.context.lastCheckpoint.record.phase='ACCEPTED';},
    f=>{f.context.lastCheckpoint.record.observationPassed=true;},
    f=>{f.context.lastCheckpoint.record.starts=1;},
    f=>{f.context.lastCheckpoint.record.abortStarts=1;},
    f=>{f.context.approval.releaseSha='0'.repeat(40);},
    f=>{f.context.approval.oldReleaseSha='0'.repeat(40);},
    f=>{f.context.approval.profileSha256='0'.repeat(64);},
    f=>{f.context.emergencyReceipt.parentAttemptCompleted=true;},
    f=>{f.context.emergencyReceipt.r4Acceptance='ACCEPTED';},
    f=>{f.context.emergencyReceipt.parent.phase='COMPLETED';},
    f=>{f.context.oldAdoption.baselineId='20261028T055858Z-issue369-deadbeef';},
    f=>{f.context.oldAdoption.originalArtifactSha256='0'.repeat(64);},
    f=>{f.context.oldBaselineManifest.restoreAcceptance=true;},
    f=>{delete f.disposition.admissionProofSha256;}
  ]){
    const f=historicalFixture();mutate(f);
    assert.throws(()=>validateHistoricalRecoveryDisposition(f.disposition,f.context),
      /RECOVERY_HISTORICAL_DISPOSITION_INVALID/);
  }
});

test('disposition cannot use legacy UNKNOWN trusted-time evidence',()=>{
  const f=historicalFixture();
  const legacy=legacyTimeEvidenceAt(Date.parse(f.disposition.issuedAtUTC));
  f.disposition.issuedTime=legacy;
  f.disposition.issuedAtUTC=legacy.wallAtUTC;
  assert.throws(()=>validateHistoricalRecoveryDisposition(f.disposition,f.context),
    /TIME|TRUSTED_TIME/);
});

test('a non-root caller cannot issue a historical disposition',t=>{
  t.mock.method(process,'getuid',()=>1001);
  assert.throws(()=>issueHistoricalRecoveryDisposition(),/RECOVERY_DISPOSITION_ADMIN_REQUIRED/);
});

test('administrator seals exactly one disposition from the exact live evidence',async t=>{
  const f=historicalFixture();
  const host=await adoptionHost(adoptionFixture());
  t.after(host.cleanup);
  installHistoricalSource(host,f);
  host.directories.set(STATE+'/historical-dispositions',0o700);
  const sealed=host.controller.issueHistoricalRecoveryDisposition();
  assert.equal(sealed.record.attemptId,ATTEMPT);
  assert.equal(sealed.record.kind,'HISTORICAL_RECOVERY_DISPOSITION');
  assert.equal(sealed.record.classification,'ABANDONED_SUPERSEDED');
  assert.equal(sealed.record.terminal,false);
  assert.equal(sealed.record.r4Acceptance,'NOT_ACCEPTED');
  assert.equal(sealed.sha256,hash(host.files.get(DISPOSITION).data));
  assert.throws(()=>host.controller.issueHistoricalRecoveryDisposition(),
    /RECOVERY_DISPOSITION_ALREADY_SEALED/);
});

test('valid disposition and complete sealed archive pass the OPS-R4-002 archive gate',async t=>{
  const {host}=await gateHost();
  t.after(host.cleanup);
  const result=host.controller.verifyHistoricalArchiveGate();
  assert.equal(result.attemptId,ATTEMPT);
  assert.equal(result.complete,true);
  assert.equal(result.terminal,false);
  assert.match(result.dispositionSha256,/^[0-9a-f]{64}$/);
  assert.match(result.manifestSha256,/^[0-9a-f]{64}$/);
});

test('missing disposition blocks the archive gate',async t=>{
  const {host}=await gateHost();
  t.after(host.cleanup);
  host.files.delete(DISPOSITION);
  assert.throws(()=>host.controller.verifyHistoricalArchiveGate(),
    /RECOVERY_HISTORICAL_DISPOSITION/);
});

test('a disposition for another attempt or a terminal disposition is rejected',async t=>{
  const {host}=await gateHost();
  t.after(host.cleanup);
  const disposition=read(host,DISPOSITION);
  disposition.attemptId='11111111-1111-4111-8111-111111111111';
  write(host,DISPOSITION,disposition);reseal(host);
  assert.throws(()=>host.controller.verifyHistoricalArchiveGate(),
    /RECOVERY_HISTORICAL_DISPOSITION/);

  const {host:host2}=await gateHost();
  t.after(host2.cleanup);
  const terminal=read(host2,DISPOSITION);
  terminal.terminal=true;terminal.lastPhase='COMPLETED';terminal.r4Acceptance='ACCEPTED';
  write(host2,DISPOSITION,terminal);reseal(host2);
  assert.throws(()=>host2.controller.verifyHistoricalArchiveGate(),
    /RECOVERY_HISTORICAL_DISPOSITION/);
});

test('an archive manifest or complete record for another attempt is rejected',async t=>{
  {
    const {host}=await gateHost();t.after(host.cleanup);
    const manifest=read(host,manifestPath);
    manifest.attemptId='11111111-1111-4111-8111-111111111111';
    write(host,manifestPath,manifest);reseal(host);
    assert.throws(()=>host.controller.verifyHistoricalArchiveGate(),/RECOVERY_HISTORICAL_ARCHIVE/);
  }
  {
    const {host}=await gateHost();t.after(host.cleanup);
    const complete=read(host,completePath);
    complete.attemptId='11111111-1111-4111-8111-111111111111';
    write(host,completePath,complete);
    assert.throws(()=>host.controller.verifyHistoricalArchiveGate(),/RECOVERY_HISTORICAL_ARCHIVE/);
  }
});

test('empty source directories without ARCHIVE-COMPLETE are rejected',async t=>{
  const {host}=await gateHost();
  t.after(host.cleanup);
  host.files.delete(completePath);
  assert.throws(()=>host.controller.verifyHistoricalArchiveGate(),
    /RECOVERY_HISTORICAL_ARCHIVE/);
});

test('missing archive manifest or source-empty proof is rejected',async t=>{
  const {host}=await gateHost();
  t.after(host.cleanup);
  host.files.delete(manifestPath);
  assert.throws(()=>host.controller.verifyHistoricalArchiveGate(),
    /RECOVERY_HISTORICAL_ARCHIVE/);

  const {host:host2}=await gateHost();
  t.after(host2.cleanup);
  host2.files.delete(proofPath);
  assert.throws(()=>host2.controller.verifyHistoricalArchiveGate(),
    /RECOVERY_HISTORICAL_ARCHIVE/);
});

test('a changed archived checkpoint, broken hash chain or partial archive is rejected',async t=>{
  const {host}=await gateHost();
  t.after(host.cleanup);
  const p=ARCHIVE_DIR+'/attempts/'+ATTEMPT+'/0017.json';
  const record=read(host,p);
  record.phase='COMPLETED';
  write(host,p,record);
  assert.throws(()=>host.controller.verifyHistoricalArchiveGate(),
    /RECOVERY_HISTORICAL_ARCHIVE/);

  const {host:host2}=await gateHost();
  t.after(host2.cleanup);
  const q=ARCHIVE_DIR+'/attempts/'+ATTEMPT+'/0001.json';
  const record2=read(host2,q);
  record2.previousHash='0'.repeat(64);
  write(host2,q,record2);
  assert.throws(()=>host2.controller.verifyHistoricalArchiveGate(),
    /RECOVERY_HISTORICAL_ARCHIVE/);

  const {host:host3}=await gateHost();
  t.after(host3.cleanup);
  host3.files.delete(ARCHIVE_DIR+'/attempts/'+ATTEMPT+'/0007.json');
  assert.throws(()=>host3.controller.verifyHistoricalArchiveGate(),
    /RECOVERY_HISTORICAL_ARCHIVE/);
});

test('a changed admission proof is rejected',async t=>{
  const {host}=await gateHost();
  t.after(host.cleanup);
  const p=ARCHIVE_DIR+'/admission-proofs/'+ATTEMPT+'.json';
  const entry=host.files.get(p);entry.data=Buffer.from(entry.data);entry.data[0]^=0xff;
  assert.throws(()=>host.controller.verifyHistoricalArchiveGate(),
    /RECOVERY_HISTORICAL_ARCHIVE|RECOVERY_HISTORICAL_DISPOSITION/);
});

test('a source proof with a pending marker or nonempty directory is rejected',async t=>{
  {
    const {host}=await gateHost();t.after(host.cleanup);
    const proof=read(host,proofPath);proof.pendingMarkers.active=true;write(host,proofPath,proof);
    assert.throws(()=>host.controller.verifyHistoricalArchiveGate(),/RECOVERY_HISTORICAL_ARCHIVE/);
  }
  {
    const {host}=await gateHost();t.after(host.cleanup);
    const proof=read(host,proofPath);proof.directories[STATE+'/logs'].entries=1;
    write(host,proofPath,proof);
    assert.throws(()=>host.controller.verifyHistoricalArchiveGate(),/RECOVERY_HISTORICAL_ARCHIVE/);
  }
});

test('a complete record with a changed manifest digest or terminal phase is rejected',async t=>{
  {
    const {host}=await gateHost();t.after(host.cleanup);
    const complete=read(host,completePath);complete.manifestSha256='0'.repeat(64);
    write(host,completePath,complete);
    assert.throws(()=>host.controller.verifyHistoricalArchiveGate(),/RECOVERY_HISTORICAL_ARCHIVE/);
  }
  {
    const {host}=await gateHost();t.after(host.cleanup);
    const complete=read(host,completePath);complete.lastPhase='ACCEPTED';
    write(host,completePath,complete);
    assert.throws(()=>host.controller.verifyHistoricalArchiveGate(),/RECOVERY_HISTORICAL_ARCHIVE/);
  }
});

test('a changed backup, postdeploy log, rc or receipt is rejected',async t=>{
  for(const [path,mutate] of [
    [ARCHIVE_DIR+'/backups/'+ATTEMPT+'-post.dump',bytes=>{bytes[0]^=0xff;}],
    [ARCHIVE_DIR+'/logs/'+ATTEMPT+'/postdeploy-operator-20261101T040551Z.log',bytes=>{bytes[0]^=0xff;}],
    [ARCHIVE_DIR+'/logs/'+ATTEMPT+'/postdeploy-operator-20261101T040551Z.rc',bytes=>{bytes[0]=0x30;}],
    [EMERGENCY,bytes=>{bytes[0]^=0xff;}]
  ]){
    const {host}=await gateHost();t.after(host.cleanup);
    const entry=host.files.get(path);entry.data=Buffer.from(entry.data);mutate(entry.data);
    assert.throws(()=>host.controller.verifyHistoricalArchiveGate(),
      /RECOVERY_HISTORICAL_ARCHIVE|RECOVERY_HISTORICAL_DISPOSITION/);
  }
});

test('a changed old approval, adoption, baseline or archived profile is rejected',async t=>{
  for(const path of [OLD_APPROVAL,OLD_ADOPTION,OLD_BASELINE_MANIFEST,OLD_BASELINE_SUMS,
    OLD_BASELINE_DIR+'/database.dump',ARCHIVE_DIR+'/preserved/profile.json']){
    const {host}=await gateHost();t.after(host.cleanup);
    const entry=host.files.get(path);entry.data=Buffer.from(entry.data);entry.data[0]^=0xff;
    assert.throws(()=>host.controller.verifyHistoricalArchiveGate(),
      /RECOVERY_HISTORICAL_ARCHIVE|RECOVERY_HISTORICAL_DISPOSITION/);
  }
});

test('archived disposition copy is independently checked against the live record',async t=>{
  const {host}=await gateHost();t.after(host.cleanup);
  const copy=host.files.get(ARCHIVE_DIR+'/preserved/disposition.json');
  copy.data=Buffer.from(copy.data);copy.data[0]^=0xff;
  assert.throws(()=>host.controller.verifyHistoricalArchiveGate(),
    /RECOVERY_HISTORICAL_ARCHIVE/);
});

test('source mode and nanosecond mtime needed for exact historical restore are sealed',async t=>{
  const {host}=await gateHost();t.after(host.cleanup);
  const manifest=read(host,manifestPath);
  const log=manifest.archivedFiles.find(entry=>entry.archivePath.endsWith('postdeploy-operator-20261101T040551Z.log'));
  const rc=manifest.archivedFiles.find(entry=>entry.archivePath.endsWith('postdeploy-operator-20261101T040551Z.rc'));
  assert.equal(log.sourceMode,'0644');assert.equal(rc.sourceMode,'0644');
  assert.equal(log.mode,'0600');assert.match(log.sourceMtimeNs,/^[0-9]+$/);
  assert.equal(Object.keys(manifest.removedDirectories).length,2);
  assert.equal(manifest.sourceDirectories[STATE+'/attempts'].sourceMtimeNs,log.sourceMtimeNs);
});

test('invalid original metadata or changed archive mtime fails closed',async t=>{
  const mutated=async edit=>{
    const {host}=await gateHost();t.after(host.cleanup);
    const manifest=read(host,manifestPath);edit(manifest);
    write(host,manifestPath,manifest);reseal(host);
    assert.throws(()=>host.controller.verifyHistoricalArchiveGate(),
      /RECOVERY_HISTORICAL_ARCHIVE/);
  };
  await mutated(m=>{m.archivedFiles[0].sourceMode='0644';});
  await mutated(m=>{m.archivedFiles[0].sourceMtimeNs='1762770600000000001';});
  await mutated(m=>{delete m.sourceDirectories[STATE+'/attempts'].sourceMtimeNs;});
  await mutated(m=>{delete m.removedDirectories[STATE+'/logs/'+ATTEMPT];});
  await mutated(m=>{m.removedDirectories[STATE+'/attempts/'+ATTEMPT].mode='0755';});
  const {host}=await gateHost();t.after(host.cleanup);
  host.files.get(ARCHIVE_DIR+'/attempts/'+ATTEMPT+'/0000.json').mtimeNs='1762770600000000001';
  assert.throws(()=>host.controller.verifyHistoricalArchiveGate(),
    /RECOVERY_HISTORICAL_ARCHIVE/);
});

test('an extra archive file, foreign owner, hardlink or symlink is rejected',async t=>{
  {
    const {host}=await gateHost();t.after(host.cleanup);
    host.add(ARCHIVE_DIR+'/attempts/'+ATTEMPT+'/9999.json','unexpected\n',0o600);
    assert.throws(()=>host.controller.verifyHistoricalArchiveGate(),/RECOVERY_HISTORICAL_ARCHIVE/);
  }
  {
    const {host}=await gateHost();t.after(host.cleanup);
    host.files.get(ARCHIVE_DIR+'/attempts/'+ATTEMPT+'/0000.json').uid=1000;
    assert.throws(()=>host.controller.verifyHistoricalArchiveGate(),/RECOVERY_HISTORICAL_ARCHIVE/);
  }
  {
    const {host}=await gateHost();t.after(host.cleanup);
    host.files.get(ARCHIVE_DIR+'/attempts/'+ATTEMPT+'/0000.json').nlink=2;
    assert.throws(()=>host.controller.verifyHistoricalArchiveGate(),/RECOVERY_HISTORICAL_ARCHIVE/);
  }
  {
    const {host}=await gateHost();t.after(host.cleanup);
    const manifest=read(host,manifestPath);
    manifest.archivedFiles[0].type='symlink';
    write(host,manifestPath,manifest);reseal(host);
    assert.throws(()=>host.controller.verifyHistoricalArchiveGate(),/RECOVERY_HISTORICAL_ARCHIVE/);
  }
  {
    const {host}=await gateHost();t.after(host.cleanup);
    const entry=host.files.get(ARCHIVE_DIR+'/attempts/'+ATTEMPT+'/0000.json');
    entry.isSymbolicLink=()=>true;entry.isFile=()=>false;
    assert.throws(()=>host.controller.verifyHistoricalArchiveGate(),/RECOVERY_HISTORICAL_ARCHIVE/);
  }
});

test('nonempty or absent trusted source directories are rejected by the archive gate',async t=>{
  {
    const {host}=await gateHost();t.after(host.cleanup);
    host.add(STATE+'/logs/'+ATTEMPT+'/unexpected.log','x\n',0o600);
    assert.throws(()=>host.controller.verifyHistoricalArchiveGate(),
      /RECOVERY_HISTORICAL_ARCHIVE|RECOVERY_ADOPTION_STATE_NOT_EMPTY/);
  }
  {
    const {host}=await gateHost();t.after(host.cleanup);
    host.directories.delete(STATE+'/initializations');
    assert.throws(()=>host.controller.verifyHistoricalArchiveGate(),/RECOVERY_HISTORICAL_ARCHIVE/);
  }
});

test('a foreign host machine id is rejected',async t=>{
  const {host}=await gateHost();t.after(host.cleanup);
  const profile=read(host,STATE+'/profile.json');
  profile.machineId='9'.repeat(32);
  write(host,STATE+'/profile.json',profile);
  assert.throws(()=>host.controller.verifyHistoricalArchiveGate(),
    /RECOVERY_HISTORICAL_ARCHIVE|RECOVERY_HISTORICAL_DISPOSITION/);
});

test('a complete record that claims terminal success is rejected',async t=>{
  const {host}=await gateHost();t.after(host.cleanup);
  const complete=read(host,completePath);
  complete.terminal=true;complete.lastPhase='COMPLETED';
  write(host,completePath,complete);
  assert.throws(()=>host.controller.verifyHistoricalArchiveGate(),
    /RECOVERY_HISTORICAL_ARCHIVE/);
});

test('OPS-R4-002 issuance calls the archive gate before any adoption publication',async t=>{
  const f=adoptionFixture();
  const host=await adoptionHost(f);
  t.after(host.cleanup);
  for(const name of ['attempts','initializations','admission-proofs','backups','logs'])host.directories.set(STATE+'/'+name,0o700);
  assert.throws(()=>host.controller.issueInstalledOldAdoption67d3318(
    f.context.approval.attemptId,f.baseline.baselineId),/RECOVERY_HISTORICAL_(ARCHIVE|DISPOSITION)/);
  assert.equal(host.files.has(STATE+'/installed-old-adoption-67d3318.json'),false);
});

test('the historical disposition CLI refuses a non-root caller before privileged state',{
  skip: process.getuid?.() === 0 ? 'requires an ordinary user' : false
},()=>{
  const command=fileURLToPath(new URL('../scripts/issue-historical-recovery-disposition-6ce4cff0.sh',import.meta.url));
  const result=spawnSync('/bin/bash',[command,],{encoding:'utf8',env:{PATH:'/usr/bin:/bin',NODE_OPTIONS:'untrusted'}});
  assert.equal(result.status,1);
  assert.equal(result.stderr.trim(),'RECOVERY_DISPOSITION_ADMIN_REQUIRED');
  assert.equal(result.stdout,'');
});
