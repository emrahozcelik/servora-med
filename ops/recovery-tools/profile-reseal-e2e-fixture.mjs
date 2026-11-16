// Real-filesystem synthetic host for the disposable-container re-seal E2E.
//
// Every byte is synthetic. The fixture writes the fixed production paths only
// inside a throwaway container, installs the reviewed tool/module and the real
// host modules, creates a real PostgreSQL database identity, and materialises
// the complete OPS-R4 historical evidence chain. It refuses to run when any
// production state already exists.
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {environmentBaseline} from '../scripts/deployment-controller.mjs';
import {
  captureHistoricalSourceInventory,HISTORICAL_ARCHIVED_PATHS,HISTORICAL_LOG_NAMES,
  HISTORICAL_STAGING_DIR,HISTORICAL_STAGING_RECEIPT,HISTORICAL_STAGING_ROOT
} from '../scripts/historical-recovery-evidence.mjs';
import {approvalFixture,timeEvidenceAt} from '../tests/trusted-time-fixture.mjs';
import {
  ATTEMPT,OLD,OLD_ARTIFACT,TARGET,TARGET_TREE,TARGET_ARTIFACT,BASELINE
} from '../tests/historical-recovery-fixture.mjs';

export const STATE='/var/lib/servora-med/deploy';
const STATE_PARENT='/var/lib/servora-med';
const BASELINE_DIR='/var/lib/servora-med-recovery-baselines/'+BASELINE;
const INSTALLED='/usr/local/libexec/servora-med';
const TOOL_DIR='/usr/local/libexec/servora-med-profile-reseal';
const DISPOSITION=STATE+'/historical-dispositions/'+ATTEMPT+'.json';
const APPROVAL=STATE+'/approvals/'+ATTEMPT+'.json';
const ADOPTION=STATE+'/installed-old-adoption.json';
const EMERGENCY=STATE+'/emergency/52f632ef-ca3e-49ab-a26e-0b562adc2c78/receipt.json';
const PROFILE=STATE+'/profile.json';
const LOCK=STATE+'/host.lock';
const DISPOSITION_ID='22222222-2222-4222-8222-222222222222';
const BASELINE_ID=BASELINE;
const SYNTHETIC_CURRENT_MS=Date.parse('2026-11-10T10:30:00.000Z');
const T0=Date.parse('2026-10-31T19:46:00.000Z');
const PHASES=Object.freeze([
  'ADMITTED','BACKED_UP','FENCED','MIGRATION_INTENT','DB_EXACT','ENV_INTENT',
  'ENV_ALIGNED','POINTER_INTENT','POINTER_ALIGNED','START_INTENT','HEALTH_PASSED',
  'HEALTH_PASSED','START_FAILED','START_INTENT','HEALTH_PASSED','SMOKE_PASSED',
  'POSTDEPLOY_BACKUP_INTENT','POSTDEPLOY_BACKUP_PASSED'
]);
const FORBIDDEN=[
  STATE_PARENT,'/var/lib/servora-med-recovery-archive-staging',
  '/var/lib/servora-med-recovery-archive','/var/lib/servora-med-recovery-baselines',
  INSTALLED,TOOL_DIR,'/etc/servora-med','/etc/systemd/system/servora-med.service',
  '/etc/chrony/chrony.conf'
];

const hash=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>Buffer.from(JSON.stringify(value)+'\n');
const jsonHash=value=>hash(Buffer.from(JSON.stringify(value)+'\n'));
const run=(file,args)=>execFileSync(file,args,{encoding:'utf8',timeout:20000,
  env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin',LANG:'C',LC_ALL:'C'},
  stdio:['ignore','pipe','pipe']});
const mkdir=(directory,mode)=>{fs.mkdirSync(directory,{recursive:true,mode});
  fs.chmodSync(directory,mode);fs.chownSync(directory,0,0);};
const writeBytes=(file,bytes,mode)=>{fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,bytes,{mode});fs.chmodSync(file,mode);fs.chownSync(file,0,0);};
const writeRecord=(file,record,mode=0o600)=>writeBytes(file,canonical(record),mode);
const copyBytes=(source,destination,mode)=>{
  fs.copyFileSync(source,destination);fs.chmodSync(destination,mode);
  fs.chownSync(destination,0,0);};
const setMtimeNs=(file,ns)=>{
  const seconds=(ns/1000000000n).toString();
  const fraction=(ns%1000000000n).toString().padStart(9,'0');
  run('/usr/bin/touch',['-m','-d','@'+seconds+'.'+fraction,file]);
};

/** A schema-valid v2 TT-A record. This is the only substituted adapter; the
 * real validators in trusted-time.mjs still consume it. */
export function syntheticTimeEvidence(wallMs=SYNTHETIC_CURRENT_MS){
  return {
    formatVersion:2,source:'linux-boottime',
    bootId:'11111111-1111-4111-8111-111111111111',
    timeNamespaceId:'time:[4026531834]',
    bootLowerMs:wallMs,bootUpperMs:wallMs,
    wallAtUTC:new Date(wallMs).toISOString(),wallResolutionMs:1,
    synchronization:{service:'chrony',referenceAgeMs:1000,rootDistanceMs:1,correctionMs:0,
      sourceCount:2,sourcePolicy:'nts-quorum-v1',
      configSha256:'540e7dbc2091f128b0115d0cbab082c9cf360bab478d5484531fddafcc2cb559',
      configuredSourceCount:3,authenticatedSourceCount:2,
      selectableSources:['1.ntp.ubuntu.com','time.cloudflare.com'],
      selectedSource:'time.cloudflare.com'}
  };
}

function ensurePostgres(){
  const postgres=(file,args)=>run('/usr/sbin/runuser',['-u','postgres','--',file,...args]);
  try{postgres('/usr/bin/psql',['-X','-q','-A','-t','-d','postgres','-c','SELECT 1']);}
  catch{
    const versions=fs.readdirSync('/etc/postgresql').sort();
    run('/usr/bin/pg_ctlcluster',[versions.at(-1),'main','start']);
  }
  const exists=postgres('/usr/bin/psql',['-X','-q','-A','-t','-d','postgres','-c',
    "SELECT 1 FROM pg_database WHERE datname='servora_med'"]).trim();
  if(exists!=='1')postgres('/usr/bin/createdb',['servora_med']);
}

function databaseIdentity(){
  const sql="SELECT system_identifier::text || '|' || "
    +"(SELECT oid::text FROM pg_database WHERE datname=current_database()) "
    +'FROM pg_control_system()';
  const output=run('/usr/sbin/runuser',['-u','postgres','--','/usr/bin/psql','-X','-q','-A','-t',
    '-d','servora_med','-c',sql]).trim();
  const [clusterId,databaseOid]=output.split('|');
  if(!/^[1-9][0-9]*$/.test(clusterId??'')||!/^[1-9][0-9]*$/.test(databaseOid??'')){
    throw new Error('E2E_DATABASE_IDENTITY_UNAVAILABLE');
  }
  return {clusterId,databaseName:'servora_med',databaseOid,role:'postgres',
    host:'127.0.0.1',port:5432};
}

function installSyntheticTimeModule(){
  const evidence=syntheticTimeEvidence();
  const source=`// Synthetic TT-A adapter for the disposable container only.\n`
    +`import {\n  validateTimeEvidence, validateCurrentTimeEvidence, elapsedBootTime, elapsedTime,\n`
    +`  parseSynchronization, evidenceFromLinuxReads, validateRestrictedReply,\n`
    +`  sameSourceReport, SOURCE_POLICY, NTS_SOURCES, MONITOR_SOURCE,\n`
    +`  CHRONY_CONFIG_SHA256, MAX_REFERENCE_AGE_MS, MAX_ROOT_DISTANCE_MS, MAX_CORRECTION_MS,\n`
    +`  READER_UNIT_SHA256, READER_SOCKET_UNIT_SHA256, validateTimeModuleContract,\n`
    +`  validateReaderSocketMetadata\n} from './trusted-time-real.mjs';\n`
    +`export {\n  validateTimeEvidence, validateCurrentTimeEvidence, elapsedBootTime, elapsedTime,\n`
    +`  parseSynchronization, evidenceFromLinuxReads, validateRestrictedReply,\n`
    +`  sameSourceReport, SOURCE_POLICY, NTS_SOURCES, MONITOR_SOURCE,\n`
    +`  CHRONY_CONFIG_SHA256, MAX_REFERENCE_AGE_MS, MAX_ROOT_DISTANCE_MS, MAX_CORRECTION_MS,\n`
    +`  READER_UNIT_SHA256, READER_SOCKET_UNIT_SHA256, validateTimeModuleContract,\n`
    +`  validateReaderSocketMetadata\n};\n`
    +`const EVIDENCE = ${JSON.stringify(evidence)};\n`
    +`export function sampleTrustedTime(){ return JSON.parse(JSON.stringify(EVIDENCE)); }\n`;
  writeBytes(INSTALLED+'/trusted-time.mjs',Buffer.from(source),0o644);
}

function installHostModules(repo){
  mkdir(INSTALLED,0o755);
  const copy=(name,destination,mode)=>copyBytes(path.join(repo,name),destination,mode);
  for(const name of ['deployment-attempt.mjs','deployment-controller.mjs',
    'deployment-db-guard.mjs','migration-reconciliation.mjs',
    'historical-recovery-evidence.mjs','host-operation-lock.sh']){
    copy(name,INSTALLED+'/'+name,0o644);
  }
  copy('deploy-production-host.sh',INSTALLED+'/deploy-production-host',0o755);
  copy('trusted-time.mjs',INSTALLED+'/trusted-time-real.mjs',0o644);
  installSyntheticTimeModule();
}

function installTool(repo){
  mkdir(TOOL_DIR,0o750);
  copyBytes(path.join(repo,'profile-reseal'),TOOL_DIR+'/profile-reseal',0o750);
  copyBytes(path.join(repo,'profile-reseal.mjs'),TOOL_DIR+'/profile-reseal.mjs',0o644);
}

let createdNodeLink=false;

function prepareEnvironment(){
  if(fs.existsSync('/usr/bin/node')===false){
    fs.symlinkSync(process.execPath,'/usr/bin/node');
    createdNodeLink=true;
  }
  mkdir('/etc/servora-med',0o755);
  mkdir('/etc/chrony',0o755);
  writeBytes('/etc/systemd/system/servora-med.service',Buffer.from('synthetic unit\n'),0o644);
  writeBytes('/etc/chrony/chrony.conf',Buffer.from('synthetic chrony config\n'),0o644);
  let machineId;
  try{machineId=fs.readFileSync('/etc/machine-id','utf8').trim();}catch{}
  if(!/^[0-9a-f]{32}$/.test(machineId??'')){
    machineId='a'.repeat(32);
    writeBytes('/etc/machine-id',Buffer.from(machineId+'\n'),0o444);
  }
  const envText='DATABASE_URL=postgresql://postgres@127.0.0.1:5432/servora_med\n'
    +'PORT=3000\nHEALTH_SCHEMA_VERSION=060_synthetic\nSERVORA_RELEASE_SHA='+'b'.repeat(40)+'\n';
  writeBytes('/etc/servora-med/servora-med.env',Buffer.from(envText),0o640);
  return {machineId,envText,envBaseline:environmentBaseline(envText)};
}

function buildProfile(env,machineId,db){
  return {formatVersion:2,machineId,fqdn:'synthetic.example',
    databaseIdentity:db,envBaselineSha256:env.envBaseline,
    contracts:Object.fromEntries(['helperSha256','nodeSha256','unitSha256',
      'attemptModuleSha256','dbGuardModuleSha256','reconciliationModuleSha256',
      'controllerModuleSha256','timeModuleSha256','timeConfigSha256']
      .map(key=>[key,'0'.repeat(64)]))};
}

function buildHistoricalRecords(oldProfile,oldProfileBytes){
  const profileSha256=hash(oldProfileBytes);
  const preBytes=Buffer.from('synthetic predeploy dump\n');
  const postBytes=Buffer.from('synthetic postdeploy dump\n');
  const preSha256=hash(preBytes),postSha256=hash(postBytes);
  const approval={...approvalFixture(),attemptId:ATTEMPT,releaseSha:TARGET,treeSha:TARGET_TREE,
    artifactSha256:TARGET_ARTIFACT,oldReleaseSha:OLD,oldArtifactSha256:OLD_ARTIFACT,
    profileSha256,issuedAtUTC:'2026-10-31T19:39:02.795Z',expiresAtUTC:'2026-10-31T23:39:02.795Z',
    issuedTime:timeEvidenceAt(Date.parse('2026-10-31T19:39:02.795Z')),maxStarts:2,maxAbortStarts:1};
  const approvalSha256=hash(canonical(approval));
  const checkpoints=[];let previousHash=null;
  for(let index=0;index<18;index+=1){
    const record={formatVersion:2,attemptId:ATTEMPT,approvalSha256,profileSha256,
      sequence:index,previousHash,phase:PHASES[index],starts:index>=13?2:0,abortStarts:0,
      migrationCommitted:index>=4,lastStart:index>=9?'intent':'none',
      predeployBackup:index>=1?{sha256:preSha256,completedAtUTC:'2026-10-31T19:46:13.264Z'}:null,
      postdeployBackup:index>=17?{sha256:postSha256,completedAtUTC:'2026-11-01T03:03:19.149Z'}:null,
      smokePassed:index>=15,observationPassed:false,
      invariantBaseline:index>=3?{organizations:1,admins:1,staff:1,customers:1,products:1,jobs:1,demoData:0}:null,
      schemaChecked:index>=10,updatedAtUTC:new Date(T0+index*1000).toISOString(),
      admissionTime:timeEvidenceAt(T0),timeEvidence:timeEvidenceAt(T0+index*1000)};
    const bytes=canonical(record);
    checkpoints.push({record,bytes,sha256:hash(bytes)});
    previousHash=hash(bytes);
  }
  const admissionProof={formatVersion:2,attemptId:ATTEMPT,approvalSha256,
    initialSha256:checkpoints[0].sha256,postFsyncTime:timeEvidenceAt(T0+1000)};
  const admissionBytes=canonical(admissionProof),admissionSha256=hash(admissionBytes);
  const emergencyReceipt={formatVersion:1,kind:'EMERGENCY_HANDOFF_RECEIPT',
    parent:{attemptId:ATTEMPT,phase:'POSTDEPLOY_BACKUP_PASSED'},parentAttemptCompleted:false,
    r4Acceptance:'NOT_ACCEPTED',r4TerminalState:'HEALTH_PASSED_FENCED',
    operationalStatus:'EMERGENCY_RESTART_POLICY_RESTORED',observationPassed:false,
    host:{releaseSha:TARGET},authorizationId:'52f632ef-ca3e-49ab-a26e-0b562adc2c78',
    authorizationSha256:'a'.repeat(64),backups:{preSha256,postSha256},
    handoff:{completedAtUTC:'2026-11-01T18:04:59.844Z'},hash:'b'.repeat(64),
    futureReleaseAuthority:false,toolArtifactSha256:'c'.repeat(64)};
  const emergencyBytes=canonical(emergencyReceipt),emergencySha256=hash(emergencyBytes);
  const postdeployLog=Buffer.from('OBSERVATION_STOP_UTC=2026-11-01T04:20:37.057Z samples=28 reason=RECOVERY_BACKUP_HEALTH_FAILED\n'
    +'RECOVERY_BACKUP_HEALTH_FAILED\nPRODUCTION_DEPLOYMENT_FAILED phase=POSTDEPLOY_BACKUP sha='+TARGET+' reason=unexpected_error_1\n');
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
    baselineId:BASELINE_ID,machineId:oldProfile.machineId,sourceReleaseSha:OLD,
    originalArtifactSha256:OLD_ARTIFACT,
    installedContentManifestSha256:oldBaselineFiles['installed-old-content.sha256'].sha256,
    databaseIdentity:{},catalog:approval.oldCatalog,restoreAcceptance:false,
    completedAtUTC:'2026-10-28T05:59:02.470Z',verifications:{},files:oldBaselineFiles};
  const oldBaselineBytes=canonical(oldBaselineManifest),oldBaselineSha256=hash(oldBaselineBytes);
  const oldBaselineSums=Buffer.from(Object.entries(oldBaselineFiles)
    .map(([name,entry])=>entry.sha256+'  '+name+'\n').join(''));
  const oldAdoption={formatVersion:1,kind:'ADOPTED_INSTALLED_OLD_FIRST_CUTOVER',attemptId:ATTEMPT,
    approvalSha256,profileSha256,machineId:oldProfile.machineId,oldReleaseSha:OLD,
    originalArtifactSha256:OLD_ARTIFACT,oldCatalogSha256:jsonHash(approval.oldCatalog),
    oldContentManifestSha256:oldBaselineFiles['installed-old-content.sha256'].sha256,
    targetReleaseSha:TARGET,targetTreeSha:TARGET_TREE,targetArtifactSha256:TARGET_ARTIFACT,
    baselineId:BASELINE_ID,baselineManifestSha256:oldBaselineSha256,
    adoptedArchiveSha256:oldBaselineFiles['installed-old-release.adopted.tar.gz'].sha256,
    databaseDumpSha256:oldBaselineFiles['database.dump'].sha256,attestedTime:timeEvidenceAt(T0)};
  const oldAdoptionBytes=canonical(oldAdoption),oldAdoptionSha256=hash(oldAdoptionBytes);
  const dispositionTime=timeEvidenceAt(Date.parse('2026-11-10T10:00:00.000Z'));
  const disposition={formatVersion:1,kind:'HISTORICAL_RECOVERY_DISPOSITION',
    dispositionId:DISPOSITION_ID,attemptId:ATTEMPT,classification:'ABANDONED_SUPERSEDED',
    approvalSha256,profileSha256,machineId:oldProfile.machineId,oldReleaseSha:OLD,
    targetReleaseSha:TARGET,targetTreeSha:TARGET_TREE,targetArtifactSha256:TARGET_ARTIFACT,
    initialCheckpointSha256:checkpoints[0].sha256,lastCheckpointSha256:checkpoints[17].sha256,
    admissionProofSha256:admissionSha256,checkpointCount:18,lastSequence:17,
    lastPhase:'POSTDEPLOY_BACKUP_PASSED',observationPassed:false,smokePassed:true,starts:2,
    maxStarts:2,abortStarts:0,maxAbortStarts:1,terminal:false,r4Acceptance:'NOT_ACCEPTED',
    emergencyReceiptSha256:emergencySha256,postdeployLogSha256:hash(postdeployLog),
    postdeployRcSha256:hash(postdeployRc),oldAdoptionSha256,
    oldBaselineManifestSha256:oldBaselineSha256,
    oldBaselineSha256SumsSha256:hash(oldBaselineSums),
    issuedAtUTC:dispositionTime.wallAtUTC,issuedTime:dispositionTime};
  return {approval,approvalSha256,checkpoints,admissionProof,admissionBytes,emergencyReceipt,
    emergencyBytes,postdeployLog,postdeployRc,logs,preBytes,postBytes,oldBaselineFiles,
    oldBaselineManifest,oldBaselineBytes,oldBaselineSums,oldAdoption,oldAdoptionBytes,
    disposition,oldBaselinePayloads:{
      'database.dump':oldBaselineDump,
      'installed-old-release.adopted.tar.gz':oldBaselineArchive,
      'installed-old-content.sha256':oldBaselineContent
    }};
}

function writeHistoricalSource(records,oldProfileBytes){
  mkdir(STATE_PARENT,0o755);
  mkdir(STATE,0o700);
  mkdir(STATE+'/attempts',0o700);
  mkdir(STATE+'/attempts/'+ATTEMPT,0o700);
  mkdir(STATE+'/initializations',0o700);
  mkdir(STATE+'/admission-proofs',0o700);
  mkdir(STATE+'/backups',0o700);
  mkdir(STATE+'/logs',0o700);
  mkdir(STATE+'/logs/'+ATTEMPT,0o700);
  mkdir(STATE+'/historical-dispositions',0o700);
  mkdir(STATE+'/approvals',0o700);
  mkdir(STATE+'/emergency/52f632ef-ca3e-49ab-a26e-0b562adc2c78',0o700);
  mkdir(BASELINE_DIR,0o700);

  writeBytes(PROFILE,oldProfileBytes,0o600);
  writeBytes(LOCK,Buffer.alloc(0),0o600);
  writeRecord(APPROVAL,records.approval);
  writeRecord(ADOPTION,records.oldAdoption);
  writeRecord(BASELINE_DIR+'/baseline-manifest.json',records.oldBaselineManifest);
  writeBytes(BASELINE_DIR+'/SHA256SUMS',records.oldBaselineSums,0o600);
  for(const [name,bytes] of Object.entries(records.oldBaselinePayloads)){
    writeBytes(BASELINE_DIR+'/'+name,bytes,0o600);
  }
  writeRecord(EMERGENCY,records.emergencyReceipt);
  writeRecord(DISPOSITION,records.disposition);
  for(const checkpoint of records.checkpoints){
    writeRecord(STATE+'/attempts/'+ATTEMPT+'/'+
      String(checkpoint.record.sequence).padStart(4,'0')+'.json',checkpoint.record);
  }
  writeRecord(STATE+'/admission-proofs/'+ATTEMPT+'.json',records.admissionProof);
  writeBytes(STATE+'/backups/'+ATTEMPT+'-pre.dump',records.preBytes,0o600);
  writeBytes(STATE+'/backups/'+ATTEMPT+'-post.dump',records.postBytes,0o600);
  for(const [name,bytes] of Object.entries(records.logs)){
    writeBytes(STATE+'/logs/'+ATTEMPT+'/'+name,bytes,
      name.startsWith('postdeploy-operator-')?0o644:0o600);
  }
}

function stageEvidence(records,oldProfileBytes){
  mkdir(HISTORICAL_STAGING_ROOT,0o700);
  mkdir(HISTORICAL_STAGING_DIR,0o700);
  for(const dir of ['attempts','attempts/'+ATTEMPT,'admission-proofs','backups',
    'logs','logs/'+ATTEMPT,'preserved']){
    mkdir(HISTORICAL_STAGING_DIR+'/'+dir,0o700);
  }
  const liveMtime=new Map();
  for(const rel of HISTORICAL_ARCHIVED_PATHS){
    const source=STATE+'/'+rel,destination=HISTORICAL_STAGING_DIR+'/'+rel;
    liveMtime.set(rel,fs.lstatSync(source,{bigint:true}).mtimeNs);
    run('/bin/cp',['-p',source,destination]);
    fs.chmodSync(destination,0o600);fs.chownSync(destination,0,0);
    let staged=fs.lstatSync(destination,{bigint:true}).mtimeNs;
    if(staged!==liveMtime.get(rel)){
      setMtimeNs(destination,liveMtime.get(rel));
      staged=fs.lstatSync(destination,{bigint:true}).mtimeNs;
    }
    if(staged!==liveMtime.get(rel))throw new Error('E2E_MTIME_PRESERVATION_FAILED');
  }
  for(const rel of ['preserved/profile.json','preserved/disposition.json']){
    const source=rel==='preserved/profile.json'?PROFILE:DISPOSITION;
    const destination=HISTORICAL_STAGING_DIR+'/'+rel;
    run('/bin/cp',['-p',source,destination]);
    fs.chmodSync(destination,0o600);fs.chownSync(destination,0,0);
  }
  const inventory=captureHistoricalSourceInventory();
  const sourceInventorySha256=hash(canonical(inventory));
  const files=[];
  for(const rel of HISTORICAL_ARCHIVED_PATHS){
    const live=fs.readFileSync(STATE+'/'+rel);
    const staged=fs.lstatSync(HISTORICAL_STAGING_DIR+'/'+rel,{bigint:true});
    files.push({archivePath:rel,sha256:hash(live),size:live.length,
      mtimeNs:staged.mtimeNs.toString(),mode:'0600'});
  }
  for(const rel of ['preserved/profile.json','preserved/disposition.json']){
    const bytes=fs.readFileSync(HISTORICAL_STAGING_DIR+'/'+rel);
    const staged=fs.lstatSync(HISTORICAL_STAGING_DIR+'/'+rel,{bigint:true});
    files.push({archivePath:rel,sha256:hash(bytes),size:bytes.length,
      mtimeNs:staged.mtimeNs.toString(),mode:'0600'});
  }
  const receipt={formatVersion:1,kind:'HISTORICAL_RECOVERY_STAGE_ONLY',
    authority:'NOT_ARCHIVED_NOT_RETAINED_NO_SOURCE_REMOVAL',attemptId:ATTEMPT,
    sourceInventorySha256,dispositionSha256:hash(canonical(records.disposition)),
    profileSha256:hash(oldProfileBytes),files};
  writeRecord(HISTORICAL_STAGING_RECEIPT,receipt);
  return receipt;
}

function measureContracts(){
  const specs=[
    ['helperSha256',INSTALLED+'/deploy-production-host',0o755],
    ['nodeSha256',fs.realpathSync('/usr/bin/node'),0o755],
    ['unitSha256','/etc/systemd/system/servora-med.service',0o644],
    ['attemptModuleSha256',INSTALLED+'/deployment-attempt.mjs',0o644],
    ['dbGuardModuleSha256',INSTALLED+'/deployment-db-guard.mjs',0o644],
    ['reconciliationModuleSha256',INSTALLED+'/migration-reconciliation.mjs',0o644],
    ['controllerModuleSha256',INSTALLED+'/deployment-controller.mjs',0o644],
    ['timeModuleSha256',INSTALLED+'/trusted-time.mjs',0o644],
    ['timeConfigSha256','/etc/chrony/chrony.conf',0o644]
  ];
  const measured={};
  for(const [key,file,mode] of specs){
    const info=fs.lstatSync(file,{bigint:true});
    if(!info.isFile()||info.isSymbolicLink()||info.uid!==0n||info.gid!==0n
      ||info.nlink!==1n||(info.mode&0o7777n)!==BigInt(mode))throw new Error('E2E_CONTRACT_UNTRUSTED '+key);
    measured[key]=hash(fs.readFileSync(file));
  }
  return measured;
}

function snapshot(){
  const result={};
  for(const rel of HISTORICAL_ARCHIVED_PATHS){
    result['live/'+rel]=hash(fs.readFileSync(STATE+'/'+rel));
    result['staged/'+rel]=hash(fs.readFileSync(HISTORICAL_STAGING_DIR+'/'+rel));
  }
  for(const rel of ['preserved/profile.json','preserved/disposition.json']){
    result['staged/'+rel]=hash(fs.readFileSync(HISTORICAL_STAGING_DIR+'/'+rel));
  }
  for(const [key,file] of [['approval',APPROVAL],['adoption',ADOPTION],
    ['disposition',DISPOSITION],['receipt',HISTORICAL_STAGING_RECEIPT],
    ['emergency',EMERGENCY],['baselineManifest',BASELINE_DIR+'/baseline-manifest.json'],
    ['baselineSums',BASELINE_DIR+'/SHA256SUMS'],
    ['baselineDump',BASELINE_DIR+'/database.dump'],
    ['baselineArchive',BASELINE_DIR+'/installed-old-release.adopted.tar.gz'],
    ['baselineContent',BASELINE_DIR+'/installed-old-content.sha256']]){
    result[key]=hash(fs.readFileSync(file));
  }
  return result;
}

function cleanup(){
  for(const directory of [STATE_PARENT,'/var/lib/servora-med-recovery-archive-staging',
    '/var/lib/servora-med-recovery-archive','/var/lib/servora-med-recovery-baselines',
    INSTALLED,TOOL_DIR,'/etc/servora-med']){
    fs.rmSync(directory,{recursive:true,force:true});
  }
  for(const file of ['/etc/systemd/system/servora-med.service','/etc/chrony/chrony.conf']){
    fs.rmSync(file,{force:true});
  }
  if(createdNodeLink){
    fs.rmSync('/usr/bin/node',{force:true});
    createdNodeLink=false;
  }
}

/** @param {{repo?:string}} [options] */
export function createE2eHost(options={}){
  if(process.platform!=='linux'||process.getuid?.()!==0||!fs.existsSync('/.dockerenv')){
    throw new Error('E2E_CONTAINER_REQUIRED');
  }
  for(const target of FORBIDDEN){
    if(fs.existsSync(target))throw new Error('E2E_HOST_NOT_DISPOSABLE '+target);
  }
  const repo=options.repo??fileURLToPath(new URL('../scripts/',import.meta.url));
  try{
    ensurePostgres();
    installHostModules(repo);
    installTool(fileURLToPath(new URL('.',import.meta.url)));
    const env=prepareEnvironment();
    const db=databaseIdentity();
    const oldProfile=buildProfile(env,env.machineId,db);
    const oldProfileBytes=canonical(oldProfile);
    const records=buildHistoricalRecords(oldProfile,oldProfileBytes);
    writeHistoricalSource(records,oldProfileBytes);
    stageEvidence(records,oldProfileBytes);
    const liveContracts=measureContracts();
    const expectedProfile={...oldProfile,contracts:liveContracts};
    const installedHashes={
      wrapper:hash(fs.readFileSync(TOOL_DIR+'/profile-reseal')),
      module:hash(fs.readFileSync(TOOL_DIR+'/profile-reseal.mjs')),
      evidence:hash(fs.readFileSync(INSTALLED+'/historical-recovery-evidence.mjs')),
      controller:hash(fs.readFileSync(INSTALLED+'/deployment-controller.mjs')),
      helper:hash(fs.readFileSync(INSTALLED+'/deploy-production-host')),
      ttAReal:hash(fs.readFileSync(INSTALLED+'/trusted-time-real.mjs')),
      ttASynthetic:hash(fs.readFileSync(INSTALLED+'/trusted-time.mjs'))
    };
    const before=snapshot();
    return {attemptId:ATTEMPT,oldProfile,oldProfileBytes,oldProfileSha256:hash(oldProfileBytes),
      expectedProfile,expectedCandidate:hash(canonical(expectedProfile)),liveContracts,
      installedHashes,before,snapshot,cleanup,
      verifyHistoricalGate:async()=>{
        const controller=await import(INSTALLED+'/deployment-controller.mjs');
        return controller.verifyHistoricalPreservationGate();
      }};
  }catch(error){
    cleanup();
    throw error;
  }
}
