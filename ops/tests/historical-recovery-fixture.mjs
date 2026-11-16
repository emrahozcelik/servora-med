// Synthetic OPS-R4-003 evidence. No production record, dump, log or secret is
// used. The exact historical attempt/release identities are public constants;
// all record bodies, hashes and backups below are synthetic test fixtures.
import {createHash} from 'node:crypto';
import {
  HISTORICAL_ARCHIVED_PATHS as EVIDENCE_ARCHIVED_PATHS,
  HISTORICAL_SOURCE_DIRECTORIES,HISTORICAL_REMOVED_DIRECTORIES,
  HISTORICAL_STAGING_DIR,HISTORICAL_STAGING_RECEIPT,HISTORICAL_STAGING_ROOT,historicalSourceMode
} from '../scripts/historical-recovery-evidence.mjs';
import {approvalFixture,timeEvidenceAt} from './trusted-time-fixture.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const json=value=>Buffer.from(JSON.stringify(value)+'\n');
const jsonHash=value=>hash(JSON.stringify(value)+'\n');

export const ATTEMPT='6ce4cff0-fa73-450e-b540-3f54ae429e7c';
export const OLD='71ae6df6dd0659ed6390a6785d4bab29ddf5b1fa';
export const OLD_ARTIFACT='6f9dbb6a211813fd0d6d5e92396b71045d506eb959cd98d883e257663af79672';
export const TARGET='f5f87d450061ca12ee80451c55eb56e99b80823c';
export const TARGET_TREE='ab6f387460259c29ff3a30ba25e9619b39b7f7c8';
export const TARGET_ARTIFACT='d85c13c465a4ad5e3ea33ed2a8d8d6271707d3303c000ea731648f1f49153b33';
export const BASELINE='20261028T055858Z-issue369-71ae6df6';
export const STATE='/var/lib/servora-med/deploy';
export const ARCHIVE_ROOT='/var/lib/servora-med-recovery-archive';
export const ARCHIVE_DIR=ARCHIVE_ROOT+'/'+ATTEMPT;
export const DISPOSITION=STATE+'/historical-dispositions/'+ATTEMPT+'.json';
export const OLD_ADOPTION=STATE+'/installed-old-adoption.json';
export const OLD_APPROVAL=STATE+'/approvals/'+ATTEMPT+'.json';
export const OLD_BASELINE_DIR='/var/lib/servora-med-recovery-baselines/'+BASELINE;
export const OLD_BASELINE_MANIFEST=OLD_BASELINE_DIR+'/baseline-manifest.json';
export const OLD_BASELINE_SUMS=OLD_BASELINE_DIR+'/SHA256SUMS';
export const EMERGENCY=STATE+'/emergency/52f632ef-ca3e-49ab-a26e-0b562adc2c78/receipt.json';

export const LOG_FILES=Object.freeze([
  'migration.log',
  'observation-80472679-0cbd-49ea-ab59-145af196e01a.log',
  'observation-8656d395-df6e-4161-b353-ca4589221ec6.log',
  'postdeploy-operator-20261101T040551Z.log',
  'postdeploy-operator-20261101T040551Z.rc'
]);

export const ARCHIVED_PATHS=Object.freeze([
  ...Array.from({length:18},(_,index)=>'attempts/'+ATTEMPT+'/'+String(index).padStart(4,'0')+'.json'),
  'admission-proofs/'+ATTEMPT+'.json',
  'backups/'+ATTEMPT+'-pre.dump',
  'backups/'+ATTEMPT+'-post.dump',
  ...LOG_FILES.map(name=>'logs/'+ATTEMPT+'/'+name)
]);

export const PRESERVED_EVIDENCE=Object.freeze([
  {path:OLD_ADOPTION,role:'old-adoption',liveSource:true},
  {path:OLD_APPROVAL,role:'old-approval',liveSource:true},
  {path:OLD_BASELINE_MANIFEST,role:'old-baseline-manifest',liveSource:true},
  {path:OLD_BASELINE_SUMS,role:'old-baseline-sha256sums',liveSource:true},
  {path:EMERGENCY,role:'emergency-receipt',liveSource:true},
  {path:'preserved/profile.json',role:'old-profile-copy',liveSource:false},
  {path:'preserved/disposition.json',role:'disposition-copy',liveSource:true,sourcePath:DISPOSITION}
]);

const PHASES=Object.freeze([
  'ADMITTED','BACKED_UP','FENCED','MIGRATION_INTENT','DB_EXACT','ENV_INTENT',
  'ENV_ALIGNED','POINTER_INTENT','POINTER_ALIGNED','START_INTENT','HEALTH_PASSED',
  'HEALTH_PASSED','START_FAILED','START_INTENT','HEALTH_PASSED','SMOKE_PASSED',
  'POSTDEPLOY_BACKUP_INTENT','POSTDEPLOY_BACKUP_PASSED'
]);

const at=ms=>new Date(ms).toISOString();
// Synthetic precision-preserving file timestamp for archive acceptance fixtures.
const SOURCE_MTIME_NS='1762770600000000000';
const T0=Date.parse('2026-10-31T19:46:00.000Z');

export function historicalFixture() {
  const oldProfile={formatVersion:2,machineId:'1'.repeat(32)};
  const oldProfileBytes=json(oldProfile);
  const profileSha256=hash(oldProfileBytes);
  const approval={...approvalFixture(),attemptId:ATTEMPT,releaseSha:TARGET,treeSha:TARGET_TREE,
    artifactSha256:TARGET_ARTIFACT,oldReleaseSha:OLD,oldArtifactSha256:OLD_ARTIFACT,
    profileSha256,issuedAtUTC:'2026-10-31T19:39:02.795Z',expiresAtUTC:'2026-10-31T23:39:02.795Z',
    issuedTime:timeEvidenceAt(Date.parse('2026-10-31T19:39:02.795Z')),maxStarts:2,maxAbortStarts:1};
  const approvalBytes=json(approval),approvalSha256=hash(approvalBytes);

  const preBytes=Buffer.from('synthetic predeploy dump\n');
  const postBytes=Buffer.from('synthetic postdeploy dump\n');
  const preSha256=hash(preBytes),postSha256=hash(postBytes);
  const checkpoints=[];let previousHash=null;
  for(let index=0;index<18;index++){
    const record={formatVersion:2,attemptId:ATTEMPT,approvalSha256,profileSha256,sequence:index,
      previousHash,phase:PHASES[index],starts:index>=13?2:0,abortStarts:0,migrationCommitted:index>=4,
      lastStart:index>=9?'intent':'none',
      predeployBackup:index>=1?{sha256:preSha256,completedAtUTC:'2026-10-31T19:46:13.264Z'}:null,
      postdeployBackup:index>=17?{sha256:postSha256,completedAtUTC:'2026-11-01T03:03:19.149Z'}:null,
      smokePassed:index>=15,observationPassed:false,
      invariantBaseline:index>=3?{organizations:1,admins:1,staff:1,customers:1,products:1,jobs:1,demoData:0}:null,
      schemaChecked:index>=10,updatedAtUTC:at(T0+index*1000),
      admissionTime:timeEvidenceAt(T0),timeEvidence:timeEvidenceAt(T0+index*1000)};
    const bytes=json(record);
    checkpoints.push({record,bytes,sha256:hash(bytes)});
    previousHash=hash(bytes);
  }
  const initial=checkpoints[0],last=checkpoints[17];
  const admissionProof={formatVersion:2,attemptId:ATTEMPT,approvalSha256,initialSha256:initial.sha256,
    postFsyncTime:timeEvidenceAt(T0+1000)};
  const admissionBytes=json(admissionProof),admissionSha256=hash(admissionBytes);

  const emergencyReceipt={formatVersion:1,kind:'EMERGENCY_HANDOFF_RECEIPT',
    parent:{attemptId:ATTEMPT,phase:'POSTDEPLOY_BACKUP_PASSED'},parentAttemptCompleted:false,
    r4Acceptance:'NOT_ACCEPTED',r4TerminalState:'HEALTH_PASSED_FENCED',
    operationalStatus:'EMERGENCY_RESTART_POLICY_RESTORED',observationPassed:false,
    host:{releaseSha:TARGET},authorizationId:'52f632ef-ca3e-49ab-a26e-0b562adc2c78',
    authorizationSha256:'a'.repeat(64),backups:{preSha256,postSha256},
    handoff:{completedAtUTC:'2026-11-01T18:04:59.844Z'},hash:'b'.repeat(64),
    futureReleaseAuthority:false,toolArtifactSha256:'c'.repeat(64)};
  const emergencyBytes=json(emergencyReceipt),emergencySha256=hash(emergencyBytes);

  const postdeployLog=Buffer.from('OBSERVATION_STOP_UTC=2026-11-01T04:20:37.057Z samples=28 reason=RECOVERY_BACKUP_HEALTH_FAILED\n'+
    'RECOVERY_BACKUP_HEALTH_FAILED\nPRODUCTION_DEPLOYMENT_FAILED phase=POSTDEPLOY_BACKUP sha='+TARGET+' reason=unexpected_error_1\n');
  const postdeployRc=Buffer.from('1\n');
  const logs={
    'migration.log':Buffer.from('START_UTC=2026-10-31T19:46:21Z\nMigration applied: 056_meeting_met_contact.sql\nEND_UTC=2026-10-31T19:46:21Z\nEXIT_CODE=0\n'),
    'observation-80472679-0cbd-49ea-ab59-145af196e01a.log':Buffer.from('OBSERVATION_STOP_UTC=2026-11-01T04:20:37.057Z samples=28 reason=RECOVERY_BACKUP_HEALTH_FAILED\n'),
    'observation-8656d395-df6e-4161-b353-ca4589221ec6.log':Buffer.from('OBSERVATION_STOP_UTC=2026-11-01T03:04:26.033Z samples=3 reason=TRUSTED_TIME_UNKNOWN\n'),
    'postdeploy-operator-20261101T040551Z.log':postdeployLog,
    'postdeploy-operator-20261101T040551Z.rc':postdeployRc
  };

  const oldBaselineDump=Buffer.from('synthetic OPS-R4-001 baseline database dump\n');
  const oldBaselineArchive=Buffer.from('synthetic OPS-R4-001 baseline recovered archive\n');
  const oldBaselineContent=Buffer.from('synthetic OPS-R4-001 baseline content manifest\n');
  const oldBaselineFiles=Object.fromEntries([
    ['database.dump',oldBaselineDump],
    ['installed-old-release.adopted.tar.gz',oldBaselineArchive],
    ['installed-old-content.sha256',oldBaselineContent]
  ].map(([name,bytes])=>[name,{name,sha256:hash(bytes),bytes:bytes.length}]));
  const oldBaselineManifest={formatVersion:1,kind:'RECOVERY_BASELINE_NOT_ORIGINAL_ARTIFACT',
    baselineId:BASELINE,machineId:oldProfile.machineId,sourceReleaseSha:OLD,originalArtifactSha256:OLD_ARTIFACT,
    installedContentManifestSha256:oldBaselineFiles['installed-old-content.sha256'].sha256,databaseIdentity:{},catalog:approval.oldCatalog,
    restoreAcceptance:false,completedAtUTC:'2026-10-28T05:59:02.470Z',verifications:{},files:oldBaselineFiles};
  const oldBaselineBytes=json(oldBaselineManifest),oldBaselineSha256=hash(oldBaselineBytes);
  const oldBaselineSums=Buffer.from(Object.entries(oldBaselineFiles)
    .map(([name,entry])=>entry.sha256+'  '+name+'\n').join(''));
  const oldAdoption={formatVersion:1,kind:'ADOPTED_INSTALLED_OLD_FIRST_CUTOVER',attemptId:ATTEMPT,
    approvalSha256,profileSha256,machineId:oldProfile.machineId,oldReleaseSha:OLD,
    originalArtifactSha256:OLD_ARTIFACT,oldCatalogSha256:jsonHash(approval.oldCatalog),
    oldContentManifestSha256:oldBaselineFiles['installed-old-content.sha256'].sha256,
    targetReleaseSha:TARGET,targetTreeSha:TARGET_TREE,
    targetArtifactSha256:TARGET_ARTIFACT,baselineId:BASELINE,baselineManifestSha256:oldBaselineSha256,
    adoptedArchiveSha256:oldBaselineFiles['installed-old-release.adopted.tar.gz'].sha256,
    databaseDumpSha256:oldBaselineFiles['database.dump'].sha256,attestedTime:timeEvidenceAt(T0)};
  const oldAdoptionBytes=json(oldAdoption),oldAdoptionSha256=hash(oldAdoptionBytes);

  const dispositionTime=timeEvidenceAt(Date.parse('2026-11-10T10:00:00.000Z'));
  const currentTime=timeEvidenceAt(Date.parse('2026-11-10T10:30:00.000Z'));
  const disposition={formatVersion:1,kind:'HISTORICAL_RECOVERY_DISPOSITION',
    dispositionId:'22222222-2222-4222-8222-222222222222',attemptId:ATTEMPT,
    classification:'ABANDONED_SUPERSEDED',approvalSha256,profileSha256,machineId:oldProfile.machineId,
    oldReleaseSha:OLD,targetReleaseSha:TARGET,targetTreeSha:TARGET_TREE,targetArtifactSha256:TARGET_ARTIFACT,
    initialCheckpointSha256:initial.sha256,lastCheckpointSha256:last.sha256,admissionProofSha256:admissionSha256,
    checkpointCount:18,lastSequence:17,
    lastPhase:'POSTDEPLOY_BACKUP_PASSED',observationPassed:false,smokePassed:true,starts:2,maxStarts:2,
    abortStarts:0,maxAbortStarts:1,terminal:false,r4Acceptance:'NOT_ACCEPTED',
    emergencyReceiptSha256:emergencySha256,postdeployLogSha256:hash(postdeployLog),postdeployRcSha256:hash(postdeployRc),
    oldAdoptionSha256,oldBaselineManifestSha256:oldBaselineSha256,
    oldBaselineSha256SumsSha256:hash(oldBaselineSums),issuedAtUTC:dispositionTime.wallAtUTC,issuedTime:dispositionTime};
  const dispositionBytes=json(disposition),dispositionSha256=hash(dispositionBytes);

  const movedFiles=new Map();
  for(const checkpoint of checkpoints)movedFiles.set('attempts/'+ATTEMPT+'/'+String(checkpoint.record.sequence).padStart(4,'0')+'.json',checkpoint.bytes);
  movedFiles.set('admission-proofs/'+ATTEMPT+'.json',admissionBytes);
  movedFiles.set('backups/'+ATTEMPT+'-pre.dump',preBytes);
  movedFiles.set('backups/'+ATTEMPT+'-post.dump',postBytes);
  for(const [name,bytes] of Object.entries(logs))movedFiles.set('logs/'+ATTEMPT+'/'+name,bytes);

  const liveEvidence=new Map([
    [OLD_ADOPTION,oldAdoptionBytes],[OLD_APPROVAL,approvalBytes],
    [OLD_BASELINE_MANIFEST,oldBaselineBytes],[OLD_BASELINE_SUMS,oldBaselineSums],
    [OLD_BASELINE_DIR+'/database.dump',oldBaselineDump],
    [OLD_BASELINE_DIR+'/installed-old-release.adopted.tar.gz',oldBaselineArchive],
    [OLD_BASELINE_DIR+'/installed-old-content.sha256',oldBaselineContent],
    [EMERGENCY,emergencyBytes]
  ]);
  const copies=new Map([['preserved/profile.json',oldProfileBytes],['preserved/disposition.json',dispositionBytes]]);

  const manifest={formatVersion:1,kind:'HISTORICAL_RECOVERY_ARCHIVE_MANIFEST',attemptId:ATTEMPT,
    dispositionSha256,approvalSha256,profileSha256,machineId:oldProfile.machineId,oldReleaseSha:OLD,
    targetReleaseSha:TARGET,targetTreeSha:TARGET_TREE,targetArtifactSha256:TARGET_ARTIFACT,
    archivedFiles:[...movedFiles].map(([path,bytes])=>({sourcePath:STATE+'/'+path,archivePath:path,
      type:'file',mode:'0600',
      sourceMode:path.startsWith('logs/'+ATTEMPT+'/postdeploy-operator-')?'0644':'0600',
      sourceMtimeNs:SOURCE_MTIME_NS,uid:0,gid:0,nlink:1,
      size:bytes.length,sha256:hash(bytes),symlinkTarget:null})),
    preservedEvidence:PRESERVED_EVIDENCE.map(entry=>{
      const bytes=entry.path.startsWith('preserved/')?copies.get(entry.path):liveEvidence.get(entry.path);
      return {...entry,sha256:hash(bytes),size:bytes.length};
    }),
    sourceDirectories:Object.fromEntries([
      ['attempts',1],['initializations',0],['admission-proofs',1],['backups',2],['logs',1]
    ].map(([name,beforeEntries])=>[STATE+'/'+name,
      {beforeEntries,afterEntries:0,sourceMtimeNs:SOURCE_MTIME_NS}])),
    removedDirectories:Object.fromEntries(['attempts/'+ATTEMPT,'logs/'+ATTEMPT]
      .map(name=>[STATE+'/'+name,{mode:'0700',uid:0,gid:0,sourceMtimeNs:SOURCE_MTIME_NS}])),
    checkpoint:{count:18,lastSequence:17,lastSha256:last.sha256,lastPhase:'POSTDEPLOY_BACKUP_PASSED',
      observationPassed:false,smokePassed:true,starts:2,abortStarts:0},
    createdAtUTC:at(Date.parse(disposition.issuedAtUTC)+1000)};
  const manifestBytes=json(manifest),manifestSha256=hash(manifestBytes);

  const sourceProof={formatVersion:1,kind:'HISTORICAL_RECOVERY_SOURCE_EMPTY_PROOF',attemptId:ATTEMPT,
    dispositionSha256,manifestSha256,directories:Object.fromEntries(['attempts','initializations',
      'admission-proofs','backups','logs'].map(name=>[STATE+'/'+name,
        {exists:true,type:'directory',symlink:false,uid:0,gid:0,mode:'0700',entries:0}])),
    pendingMarkers:{active:false,activation:false,permit:false,recoveryDropIn:false},
    verifiedAtUTC:at(Date.parse(manifest.createdAtUTC)+1000)};
  const sourceProofBytes=json(sourceProof),sourceProofSha256=hash(sourceProofBytes);

  const complete={formatVersion:1,kind:'HISTORICAL_RECOVERY_ARCHIVE_COMPLETE',attemptId:ATTEMPT,
    dispositionSha256,manifestSha256,sourceEmptyProofSha256:sourceProofSha256,archiveId:ATTEMPT,complete:true,
    checkpointCount:18,lastCheckpointSha256:last.sha256,lastPhase:'POSTDEPLOY_BACKUP_PASSED',
    observationPassed:false,terminal:false,starts:2,completedAtUTC:at(Date.parse(sourceProof.verifiedAtUTC)+1000)};
  const completeBytes=json(complete),completeSha256=hash(completeBytes);

  const metadata=new Map([['ARCHIVE-MANIFEST.json',manifestBytes],['SOURCE-EMPTY-PROOF.json',sourceProofBytes],
    ['ARCHIVE-COMPLETE.json',completeBytes]]);

  const context={approval,approvalSha256,profile:oldProfile,profileSha256,machineId:oldProfile.machineId,
    initialCheckpoint:initial,lastCheckpoint:last,admissionProof,admissionProofSha256:admissionSha256,emergencyReceipt,emergencyReceiptSha256:emergencySha256,
    postdeployLogSha256:hash(postdeployLog),postdeployRcSha256:hash(postdeployRc),oldAdoption,oldAdoptionSha256,
    oldBaselineManifest,oldBaselineManifestSha256:oldBaselineSha256,
    oldBaselineSha256SumsSha256:hash(oldBaselineSums),currentTime};

  return {oldProfile,oldProfileBytes,profileSha256,approval,approvalBytes,approvalSha256,checkpoints,initial,last,
    admissionProof,admissionBytes,admissionSha256,emergencyReceipt,emergencyBytes,emergencySha256,logs,
    postdeployLog,postdeployRc,oldBaselineManifest,oldBaselineBytes,oldBaselineSha256,oldBaselineSums,
    oldAdoption,oldAdoptionBytes,oldAdoptionSha256,currentTime,disposition,dispositionBytes,dispositionSha256,
    movedFiles,liveEvidence,copies,manifest,manifestBytes,manifestSha256,sourceProof,sourceProofBytes,
    sourceProofSha256,complete,completeBytes,completeSha256,metadata,context};
}

export function installHistoricalSource(host,f){
  for(const [path,bytes] of f.liveEvidence)host.add(path,bytes,0o600);
  for(const [path,bytes] of f.movedFiles)host.add(path.startsWith('attempts/')||path.startsWith('admission-proofs/')||
    path.startsWith('backups/')||path.startsWith('logs/')?STATE+'/'+path:path,bytes,
    path.endsWith('.log')&&path.includes('postdeploy-operator')||path.endsWith('.rc')?0o644:0o600);
  for(const name of ['attempts','initializations','admission-proofs','backups','logs'])host.directories.set(STATE+'/'+name,0o700);
  host.directories.set(STATE+'/attempts/'+ATTEMPT,0o700);
  host.directories.set(STATE+'/logs/'+ATTEMPT,0o700);
  host.directories.set(OLD_BASELINE_DIR,0o700);
  host.files.set(STATE+'/profile.json',{data:f.oldProfileBytes,mode:0o600,uid:0,gid:0,nlink:1});
  host.now=f.currentTime;
}

export function installHistoricalArchive(host,f){
  for(const [path,bytes] of f.movedFiles)host.add(ARCHIVE_DIR+'/'+path,bytes,0o600);
  for(const [path,bytes] of f.copies)host.add(ARCHIVE_DIR+'/'+path,bytes,0o600);
  for(const [path,bytes] of f.metadata)host.add(ARCHIVE_DIR+'/'+path,bytes,0o600);
  for(const [path,bytes] of f.liveEvidence)host.add(path,bytes,0o600);
  host.add(DISPOSITION,f.dispositionBytes,0o600);
  for(const path of [ARCHIVE_DIR,ARCHIVE_DIR+'/attempts',ARCHIVE_DIR+'/attempts/'+ATTEMPT,
    ARCHIVE_DIR+'/admission-proofs',ARCHIVE_DIR+'/backups',ARCHIVE_DIR+'/logs',ARCHIVE_DIR+'/logs/'+ATTEMPT,
    ARCHIVE_DIR+'/preserved',STATE+'/historical-dispositions',STATE+'/attempts',STATE+'/initializations',
    STATE+'/admission-proofs',STATE+'/backups',STATE+'/logs',OLD_BASELINE_DIR])host.directories.set(path,0o700);
  host.now=f.currentTime;
}

// OPS-R4-002 in-place preservation: the exact inventory the staging receipt
// binds, plus an in-memory stage tree shaped like the OPS-R4-005 CLI output.
export function historicalInventory(f){
  const files=EVIDENCE_ARCHIVED_PATHS.map(rel=>{
    const bytes=f.movedFiles.get(rel);
    if(!bytes)throw new Error('fixture is missing '+rel);
    return {sourcePath:STATE+'/'+rel,archivePath:rel,type:'file',uid:0,gid:0,nlink:1,
      mode:historicalSourceMode(rel),mtimeNs:SOURCE_MTIME_NS,size:bytes.length,sha256:hash(bytes)};
  });
  const children={
    attempts:[ATTEMPT],initializations:[],
    'admission-proofs':[ATTEMPT+'.json'],
    backups:[ATTEMPT+'-post.dump',ATTEMPT+'-pre.dump'],
    logs:[ATTEMPT],
    ['attempts/'+ATTEMPT]:Array.from({length:18},(_,index)=>String(index).padStart(4,'0')+'.json'),
    ['logs/'+ATTEMPT]:[...LOG_FILES].sort()
  };
  const directories=Object.fromEntries([...HISTORICAL_SOURCE_DIRECTORIES,
    ...HISTORICAL_REMOVED_DIRECTORIES].map(name=>[STATE+'/'+name,
      {type:'directory',uid:0,gid:0,mode:'0700',mtimeNs:SOURCE_MTIME_NS,children:children[name]}]));
  return {formatVersion:1,kind:'HISTORICAL_RECOVERY_SOURCE_INVENTORY',attemptId:ATTEMPT,
    authority:'READ_ONLY_NOT_ARCHIVE_ACCEPTANCE',files,directories,
    pendingMarkers:Object.fromEntries([
      STATE+'/active.json',STATE+'/activation.block',
      '/run/servora-med-recovery/start.permit',
      '/etc/systemd/system/servora-med.service.d/90-servora-recovery.conf'
    ].map(path=>[path,false]))};
}

export function installHistoricalStage(host,f,{mutateReceipt,dispositionBytes,profileBytes}={}){
  const inventory=historicalInventory(f);
  const sourceInventorySha256=hash(Buffer.from(JSON.stringify(inventory)+'\n'));
  const disposition=dispositionBytes??host.files.get(DISPOSITION).data;
  const profile=profileBytes??host.files.get(STATE+'/profile.json').data;
  const stagedFiles=[...EVIDENCE_ARCHIVED_PATHS,'preserved/profile.json','preserved/disposition.json'];
  for(const rel of EVIDENCE_ARCHIVED_PATHS)host.add(HISTORICAL_STAGING_DIR+'/'+rel,f.movedFiles.get(rel),0o600);
  const copies=new Map([['preserved/profile.json',profile],['preserved/disposition.json',disposition]]);
  for(const [rel,bytes] of copies)host.add(HISTORICAL_STAGING_DIR+'/'+rel,bytes,0o600);
  for(const dir of ['.','attempts','attempts/'+ATTEMPT,'admission-proofs','backups',
    'logs','logs/'+ATTEMPT,'preserved'])
    host.directories.set(HISTORICAL_STAGING_DIR+(dir==='.'?'':'/'+dir),0o700);
  host.directories.set(HISTORICAL_STAGING_ROOT,0o700);
  const receipt={formatVersion:1,kind:'HISTORICAL_RECOVERY_STAGE_ONLY',
    authority:'NOT_ARCHIVED_NOT_RETAINED_NO_SOURCE_REMOVAL',attemptId:ATTEMPT,
    sourceInventorySha256,dispositionSha256:hash(disposition),profileSha256:hash(profile),
    files:stagedFiles.map(rel=>{
      const bytes=rel.startsWith('preserved/')?copies.get(rel):f.movedFiles.get(rel);
      return {archivePath:rel,sha256:hash(bytes),size:bytes.length,mtimeNs:SOURCE_MTIME_NS,mode:'0600'};
    })};
  if(mutateReceipt)mutateReceipt(receipt);
  const receiptBytes=Buffer.from(JSON.stringify(receipt)+'\n');
  host.add(HISTORICAL_STAGING_RECEIPT,receiptBytes,0o600);
  return {inventory,sourceInventorySha256,receipt,receiptBytes,receiptSha256:hash(receiptBytes),
    copies};
}
