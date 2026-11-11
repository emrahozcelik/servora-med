// Root-only atomic profile re-seal for the OPS-R4-002 bootstrap.
//
// Production CLI is intentionally narrow: it reads the one fixed profile at
// /var/lib/servora-med/deploy/profile.json and accepts only `--dry-run` or
// `--apply --expected-old <sha256> --expected-candidate <sha256>`. It never
// accepts a path, force flag, recovery mode or caller-selected archive.
//
// This module is a bootstrap/review tool, not a release component. The
// repository packaging excludes ops/recovery-tools/; the reviewed bytes must be
// transferred and hash-pinned separately on the host.
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import fsDefault from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const PROFILE_KEYS=Object.freeze(['formatVersion','machineId','fqdn','databaseIdentity',
  'envBaselineSha256','contracts']);
const CONTRACT_KEYS=Object.freeze(['helperSha256','nodeSha256','unitSha256',
  'attemptModuleSha256','dbGuardModuleSha256','reconciliationModuleSha256',
  'controllerModuleSha256','timeModuleSha256','timeConfigSha256']);
const ATTEMPT='6ce4cff0-fa73-450e-b540-3f54ae429e7c';
const HEX64=/^[0-9a-f]{64}$/;

export const PRODUCTION_PATHS=Object.freeze({
  stateRoot:'/var/lib/servora-med/deploy',
  profileFile:'/var/lib/servora-med/deploy/profile.json',
  installedDir:'/usr/local/libexec/servora-med',
  envFile:'/etc/servora-med/servora-med.env',
  machineIdFile:'/etc/machine-id',
  dispositionFile:'/var/lib/servora-med/deploy/historical-dispositions/'+ATTEMPT+'.json',
  stagingDir:'/var/lib/servora-med-recovery-archive-staging/'+ATTEMPT,
  receiptFile:'/var/lib/servora-med-recovery-archive-staging/'+ATTEMPT+'.stage-receipt.json',
  lockFile:'/var/lib/servora-med/deploy/host.lock',
  attemptId:ATTEMPT,
  trustedAnchor:'/',
  pendingMarkers:Object.freeze([
    '/var/lib/servora-med/deploy/active.json',
    '/var/lib/servora-med/deploy/activation.block',
    '/run/servora-med-recovery/start.permit',
    '/etc/systemd/system/servora-med.service.d/90-servora-recovery.conf'
  ]),
  initializationsDir:'/var/lib/servora-med/deploy/initializations',
  contractSpecs:Object.freeze([
    {key:'helperSha256',path:'/usr/local/libexec/servora-med/deploy-production-host',mode:0o755},
    {key:'nodeSha256',path:'/usr/bin/node',mode:0o755},
    {key:'unitSha256',path:'/etc/systemd/system/servora-med.service',mode:0o644},
    {key:'attemptModuleSha256',path:'/usr/local/libexec/servora-med/deployment-attempt.mjs',mode:0o644},
    {key:'dbGuardModuleSha256',path:'/usr/local/libexec/servora-med/deployment-db-guard.mjs',mode:0o644},
    {key:'reconciliationModuleSha256',path:'/usr/local/libexec/servora-med/migration-reconciliation.mjs',mode:0o644},
    {key:'controllerModuleSha256',path:'/usr/local/libexec/servora-med/deployment-controller.mjs',mode:0o644},
    {key:'timeModuleSha256',path:'/usr/local/libexec/servora-med/trusted-time.mjs',mode:0o644},
    {key:'timeConfigSha256',path:'/etc/chrony/chrony.conf',mode:0o644}
  ])
});

const fail=code=>{throw new Error(code);};
const digest=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>JSON.stringify(value)+'\n';

/** The only accepted command shapes. No path, force, mode or environment
 * selector exists. Values are mandatory for apply and must be lowercase hex. */
export function parseArguments(argv){
  if(!Array.isArray(argv))fail('PROFILE_RESEAL_ARGUMENTS_INVALID');
  if(argv.length===1&&argv[0]==='--dry-run')return {mode:'dry-run'};
  if(argv.length===5&&argv[0]==='--apply'&&argv[1]==='--expected-old'
    &&argv[3]==='--expected-candidate'&&HEX64.test(argv[2])&&HEX64.test(argv[4])){
    return {mode:'apply',expectedOld:argv[2],expectedCandidate:argv[4]};
  }
  fail('PROFILE_RESEAL_ARGUMENTS_INVALID');
}

const statEqual=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size
  &&a.mtimeNs===b.mtimeNs&&a.mode===b.mode&&a.nlink===b.nlink;

function trustedParents(file,{anchor,uid,fs}){
  const parent=path.dirname(file);
  const relative=path.relative(anchor,parent);
  if(relative.startsWith('..')||path.isAbsolute(relative))fail('PROFILE_RESEAL_PATH_UNTRUSTED');
  let current=anchor;
  const check=directory=>{
    let info;
    try{info=fs.lstatSync(directory);}catch{fail('PROFILE_RESEAL_PATH_UNTRUSTED');}
    if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==uid
      ||(info.mode&0o022)!==0)fail('PROFILE_RESEAL_PATH_UNTRUSTED');
  };
  check(current);
  for(const component of relative.split(path.sep).filter(Boolean)){
    current=path.join(current,component);
    check(current);
  }
}

/** Root-private, O_NOFOLLOW read with exact owner/mode/link checks and a
 * before/after identity comparison. `error` is the caller's fail-closed
 * diagnostic code so a foreign contract, profile or temp file is reported at
 * the correct boundary. */
function trustedBytes(file,{mode,gid=null,uid,fs,anchor,error}){
  trustedParents(file,{anchor,uid,fs});
  let fd;
  try{
    fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_CLOEXEC);
    const before=fs.fstatSync(fd,{bigint:true});
    if(!before.isFile()||before.uid!==BigInt(uid)||before.nlink!==1n
      ||(gid!==null&&before.gid!==BigInt(gid))
      ||(before.mode&0o7777n)!==BigInt(mode))fail(error);
    const bytes=fs.readFileSync(fd);
    const after=fs.fstatSync(fd,{bigint:true});
    if(!statEqual(before,after)||BigInt(bytes.length)!==before.size)fail(error);
    return {bytes,sha256:digest(bytes),stat:before};
  }catch{
    throw new Error(error);
  }finally{if(fd!==undefined){try{fs.closeSync(fd);}catch{}}}
}

function readCanonical(file,options){
  let bytes;
  try{({bytes}=trustedBytes(file,options));}
  catch{throw new Error(options.error);}
  let record;
  try{record=JSON.parse(bytes.toString('utf8'));}catch{fail(options.error);}
  if(record===null||typeof record!=='object'||Array.isArray(record)
    ||canonical(record)!==bytes.toString('utf8'))fail(options.error);
  return {record,sha256:digest(bytes),bytes};
}

function readSmallText(file,{uid,fs,anchor,error}){
  let fd;
  try{
    trustedParents(file,{anchor,uid,fs});
    fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_CLOEXEC);
    const before=fs.fstatSync(fd,{bigint:true});
    if(!before.isFile()||before.uid!==BigInt(uid)||before.nlink!==1n
      ||before.size>1024n)fail(error);
    const bytes=fs.readFileSync(fd);
    const after=fs.fstatSync(fd,{bigint:true});
    if(!statEqual(before,after)||BigInt(bytes.length)!==before.size)fail(error);
    return bytes.toString('utf8');
  }catch{
    throw new Error(error);
  }finally{if(fd!==undefined){try{fs.closeSync(fd);}catch{}}}
}

export function assertNoPendingState(paths,{uid,fs}){
  for(const marker of paths.pendingMarkers){
    try{fs.lstatSync(marker);}
    catch(error){if(error?.code==='ENOENT')continue;fail('PROFILE_RESEAL_PENDING_STATE');}
    fail('PROFILE_RESEAL_PENDING_STATE');
  }
  let info;
  try{info=fs.lstatSync(paths.initializationsDir);}
  catch(error){
    if(error?.code==='ENOENT')return;
    fail('PROFILE_RESEAL_PENDING_STATE');
  }
  if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==uid
    ||(info.mode&0o7777)!==0o700)fail('PROFILE_RESEAL_PENDING_STATE');
  if(fs.readdirSync(paths.initializationsDir).length)fail('PROFILE_RESEAL_PENDING_STATE');
}

/** Stable host lock: the invoking shell wrapper must hold fd 9 on the exact
 * host.lock inode. The module re-checks the inode and confirms the kernel lock
 * before reading any state. */
export function assertHostLock(paths,{uid,gid,fs,exec=execFileSync}={}){
  let held,named;
  try{
    held=fs.fstatSync(9,{bigint:true});
    named=fs.lstatSync(paths.lockFile,{bigint:true});
  }catch{fail('PROFILE_RESEAL_HOST_LOCK_REQUIRED');}
  if(!held.isFile()||!named.isFile()||named.isSymbolicLink()
    ||held.dev!==named.dev||held.ino!==named.ino
    ||named.uid!==BigInt(uid)||(gid!==undefined&&named.gid!==BigInt(gid))
    ||named.nlink!==1n||(named.mode&0o7777n)!==0o600n)fail('PROFILE_RESEAL_HOST_LOCK_REQUIRED');
  try{
    exec('/usr/bin/flock',['--nonblock','9'],{timeout:2000,
      env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'},
      stdio:['ignore','pipe','pipe',...Array(6).fill('ignore'),9]});
  }catch{fail('PROFILE_RESEAL_HOST_LOCK_REQUIRED');}
}

function validateDisposition(record,paths,oldProfileSha256){
  if(record.formatVersion!==1||record.kind!=='HISTORICAL_RECOVERY_DISPOSITION'
    ||record.attemptId!==paths.attemptId||record.profileSha256!==oldProfileSha256
    ||record.classification!=='ABANDONED_SUPERSEDED'
    ||record.r4Acceptance!=='NOT_ACCEPTED'||record.terminal!==false
    ||record.lastPhase!=='POSTDEPLOY_BACKUP_PASSED'||record.lastSequence!==17
    ||record.starts!==2)fail('PROFILE_RESEAL_DISPOSITION_INVALID');
}

function measureContracts(paths,{uid,fs,anchor}){
  if(!Array.isArray(paths.contractSpecs)||paths.contractSpecs.length!==CONTRACT_KEYS.length
    ||paths.contractSpecs.some(spec=>!CONTRACT_KEYS.includes(spec.key))
    ||new Set(paths.contractSpecs.map(spec=>spec.key)).size!==CONTRACT_KEYS.length){
    fail('PROFILE_RESEAL_CONTRACT_INVALID');
  }
  const measured={};
  for(const spec of paths.contractSpecs){
    let bytes;
    try{
      ({bytes}=trustedBytes(spec.path,{mode:spec.mode,gid:spec.gid??null,uid,fs,anchor,
        error:'PROFILE_RESEAL_CONTRACT_UNTRUSTED'}));
    }catch{throw new Error('PROFILE_RESEAL_CONTRACT_UNTRUSTED');}
    measured[spec.key]=digest(bytes);
  }
  return measured;
}

function buildCandidate(profile,measured,{validateHostProfile}){
  const contracts={};
  for(const key of CONTRACT_KEYS)contracts[key]=measured[key];
  const candidate={};
  for(const key of PROFILE_KEYS)candidate[key]=key==='contracts'?contracts:profile[key];
  try{validateHostProfile(candidate);}
  catch{fail('PROFILE_RESEAL_CANDIDATE_INVALID');}
  return {candidate,text:canonical(candidate),sha256:digest(canonical(candidate))};
}

function changedContractKeys(profile,measured){
  return CONTRACT_KEYS.filter(key=>profile.contracts?.[key]!==measured[key])
    .map(key=>({key,from:profile.contracts?.[key]??null,to:measured[key]}));
}

function checkEnv(record,paths,{uid,fs,anchor,environmentBaseline}){
  let text;
  try{text=trustedBytes(paths.envFile,{mode:0o640,gid:null,uid,fs,anchor,
    error:'PROFILE_RESEAL_ENV_UNTRUSTED'}).bytes.toString('utf8');}
  catch{throw new Error('PROFILE_RESEAL_ENV_UNTRUSTED');}
  let baseline;
  try{baseline=environmentBaseline(text);}
  catch{fail('PROFILE_RESEAL_ENV_MISMATCH');}
  if(baseline!==record.envBaselineSha256)fail('PROFILE_RESEAL_ENV_MISMATCH');
}

function checkMachine(record,paths,{uid,fs,anchor}){
  const value=readSmallText(paths.machineIdFile,{uid,fs,anchor,
    error:'PROFILE_RESEAL_MACHINE_UNTRUSTED'}).trim();
  if(value!==record.machineId)fail('PROFILE_RESEAL_MACHINE_MISMATCH');
}

function checkDatabase(record,{validateDatabaseIdentity,readDatabaseIdentity}){
  try{validateDatabaseIdentity(record.databaseIdentity);}
  catch{fail('PROFILE_RESEAL_DATABASE_MISMATCH');}
  let live;
  try{live=readDatabaseIdentity(record.databaseIdentity);}
  catch{throw new Error('PROFILE_RESEAL_DATABASE_UNAVAILABLE');}
  if(live.clusterId!==record.databaseIdentity.clusterId
    ||live.databaseOid!==record.databaseIdentity.databaseOid
    ||live.databaseName!==record.databaseIdentity.databaseName){
    fail('PROFILE_RESEAL_DATABASE_MISMATCH');
  }
}

function checkTime(sampleTrustedTime){
  let evidence;
  try{evidence=sampleTrustedTime();}
  catch(error){throw new Error(error?.message==='TRUSTED_TIME_UNKNOWN'
    ?'TRUSTED_TIME_UNKNOWN':'PROFILE_RESEAL_TIME_INVALID');}
  if(!evidence||evidence.formatVersion!==2||evidence.source!=='linux-boottime'){
    fail('PROFILE_RESEAL_TIME_INVALID');
  }
  return evidence;
}

function checkHistorical(verifyHistoricalPreservation){
  if(typeof verifyHistoricalPreservation!=='function')return null;
  let result;
  try{result=verifyHistoricalPreservation();}
  catch(error){throw error;}
  if(!result||result.status!=='IN_PLACE_PRESERVATION_VERIFIED'){
    fail('PROFILE_RESEAL_HISTORICAL_INVALID');
  }
  return result.status;
}

function readAll({paths,uid,gid,fs,anchor,deps}){
  const profile=readCanonical(paths.profileFile,{mode:0o600,gid,uid,fs,anchor,
    error:'PROFILE_RESEAL_PROFILE_UNTRUSTED'});
  try{deps.validateHostProfile(profile.record);}
  catch{fail('PROFILE_RESEAL_PROFILE_INVALID');}

  const disposition=readCanonical(paths.dispositionFile,{mode:0o600,gid,uid,fs,anchor,
    error:'PROFILE_RESEAL_DISPOSITION_INVALID'});
  validateDisposition(disposition.record,paths,profile.sha256);

  let receipt;
  let receiptExists=true;
  try{fs.lstatSync(paths.receiptFile);}
  catch(error){
    if(error?.code==='ENOENT')receiptExists=false;
    else fail('PROFILE_RESEAL_STAGE_INVALID');
  }
  try{receipt=deps.readStageReceipt({receiptPath:paths.receiptFile,uid,gid});}
  catch{throw new Error(receiptExists?'PROFILE_RESEAL_STAGE_INVALID':'PROFILE_RESEAL_STAGE_REQUIRED');}
  if(receipt.receipt.profileSha256!==profile.sha256
    ||receipt.receipt.dispositionSha256!==disposition.sha256
    ||receipt.receipt.files.length!==28)fail('PROFILE_RESEAL_STAGE_INVALID');
  try{
    deps.verifyStageReadback({stageRoot:paths.stagingDir,receiptPath:paths.receiptFile,
      uid,gid,receipt:receipt.receipt});
  }catch{fail('PROFILE_RESEAL_STAGE_INVALID');}

  const measured=measureContracts(paths,{uid,fs,anchor});
  checkEnv(profile.record,paths,{uid,fs,anchor,environmentBaseline:deps.environmentBaseline});
  checkMachine(profile.record,paths,{uid,fs,anchor});
  checkDatabase(profile.record,deps);
  const evidence=checkTime(deps.sampleTrustedTime);
  const historical=checkHistorical(deps.verifyHistoricalPreservation);
  const candidate=buildCandidate(profile.record,measured,deps);
  return {profile,disposition,receipt,measured,evidence,historical,candidate};
}

/** Read-only dry-run / fail-closed apply. `deps` is mandatory for the installed
 * module adapters; the production CLI wires them from the fixed libexec paths.
 * Tests supply synthetic adapters. */
export function resealProfile({mode,expectedOld,expectedCandidate,paths=PRODUCTION_PATHS,deps}){
  if(mode!=='dry-run'&&mode!=='apply')fail('PROFILE_RESEAL_ARGUMENTS_INVALID');
  if(!deps||typeof deps!=='object')fail('PROFILE_RESEAL_DEPENDENCIES_REQUIRED');
  if(mode==='apply'&&(!HEX64.test(expectedOld??'')||!HEX64.test(expectedCandidate??'')))fail('PROFILE_RESEAL_ARGUMENTS_INVALID');
  if((deps.getuid??process.getuid)()!==deps.uid)fail('PROFILE_RESEAL_ADMIN_REQUIRED');
  const uid=deps.uid,gid=deps.gid??0,fs=deps.fs??fsDefault,anchor=paths.trustedAnchor??'/';
  if(deps.assertLock)deps.assertLock(paths);
  assertNoPendingState(paths,{uid,fs});

  const state=readAll({paths,uid,gid,fs,anchor,deps});
  if(expectedOld!==undefined&&state.profile.sha256!==expectedOld)fail('PROFILE_RESEAL_OLD_MISMATCH');
  if(expectedCandidate!==undefined&&state.candidate.sha256!==expectedCandidate)fail('PROFILE_RESEAL_CANDIDATE_MISMATCH');

  const summary={oldProfileSha256:state.profile.sha256,
    candidateProfileSha256:state.candidate.sha256,
    changedContracts:changedContractKeys(state.profile.record,state.measured),
    dispositionSha256:state.disposition.sha256,
    stageReceiptSha256:digest(Buffer.from(JSON.stringify(state.receipt.receipt)+'\n')),
    ttAFormatVersion:state.evidence.formatVersion,
    historicalStatus:state.historical};
  if(mode==='dry-run')return {status:'DRY_RUN_OK',...summary};

  deps.hooks?.beforeTempWrite?.();
  const temp=path.join(path.dirname(paths.profileFile),
    '.'+path.basename(paths.profileFile)+'.'+randomUUID()+'.tmp');
  let committed=false;
  try{
    let fd;
    try{
      fd=fs.openSync(temp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL
        |fs.constants.O_NOFOLLOW,0o600);
      fs.writeFileSync(fd,state.candidate.text);
      deps.hooks?.afterTempWrite?.();
      fs.fchmodSync(fd,0o600);
      if((deps.getuid??process.getuid)()===0)fs.fchownSync(fd,uid,gid);
      fs.fsyncSync(fd);
    }finally{if(fd!==undefined){try{fs.closeSync(fd);}catch{}}}
    deps.hooks?.afterTempFsync?.();

    const staged=readCanonical(temp,{mode:0o600,gid,uid,fs,anchor,
      error:'PROFILE_RESEAL_TEMP_INVALID'});
    if(staged.sha256!==state.candidate.sha256)fail('PROFILE_RESEAL_TEMP_INVALID');
    try{deps.validateHostProfile(staged.record);}
    catch{fail('PROFILE_RESEAL_TEMP_INVALID');}
    deps.hooks?.beforeRename?.();

    // Last-moment CAS. Any concurrent/foreign profile change aborts before the
    // atomic rename. The temp file is the only file this tool ever removes.
    const latest=readCanonical(paths.profileFile,{mode:0o600,gid,uid,fs,anchor,
      error:'PROFILE_RESEAL_PROFILE_UNTRUSTED'});
    if(latest.sha256!==state.profile.sha256)fail('PROFILE_RESEAL_OLD_MISMATCH');

    fs.renameSync(temp,paths.profileFile);
    committed=true;
    deps.hooks?.afterRename?.();
    deps.hooks?.beforeDirFsync?.();
    let directoryFd;
    try{
      directoryFd=fs.openSync(paths.stateRoot,fs.constants.O_RDONLY
        |fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
      fs.fsyncSync(directoryFd);
    }finally{if(directoryFd!==undefined){try{fs.closeSync(directoryFd);}catch{}}}
    deps.hooks?.afterDirFsync?.();
  }finally{
    if(!committed){
      try{fs.unlinkSync(temp);}catch{}
    }
  }

  // Exact post-rename readback. A failure here is a STOP: no rollback, no
  // repair and no second write.
  const published=readCanonical(paths.profileFile,{mode:0o600,gid,uid,fs,anchor,
    error:'PROFILE_RESEAL_READBACK_INVALID'});
  if(published.sha256!==state.candidate.sha256)fail('PROFILE_RESEAL_READBACK_INVALID');
  try{deps.validateHostProfile(published.record);}
  catch{fail('PROFILE_RESEAL_READBACK_INVALID');}
  const remeasured=measureContracts(paths,{uid,fs,anchor});
  for(const key of CONTRACT_KEYS){
    if(published.record.contracts[key]!==remeasured[key])fail('PROFILE_RESEAL_READBACK_INVALID');
  }
  checkEnv(published.record,paths,{uid,fs,anchor,environmentBaseline:deps.environmentBaseline});
  checkMachine(published.record,paths,{uid,fs,anchor});
  checkDatabase(published.record,deps);
  checkTime(deps.sampleTrustedTime);
  checkHistorical(deps.verifyHistoricalPreservation);

  return {status:'PROFILE_RESEALED',...summary,newProfileSha256:published.sha256};
}

/** Read-only DB identity probe. Runs as the postgres OS user so the tool never
 * needs to parse the application's DATABASE_URL or hold a service password. */
export function readProductionDatabaseIdentity(expected,{exec=execFileSync}={}){
  if(!expected||typeof expected.databaseName!=='string'
    ||!/^[a-z_][a-z0-9_]*$/.test(expected.databaseName))fail('PROFILE_RESEAL_DATABASE_MISMATCH');
  const sql="SELECT system_identifier::text || '|' || "
    +"(SELECT oid::text FROM pg_database WHERE datname=current_database()) "
    +"FROM pg_control_system()";
  let output;
  try{
    output=exec('/usr/sbin/runuser',
      ['-u','postgres','--','/usr/bin/psql','-X','-q','-A','-t',
        '-d',expected.databaseName,'-c',sql],
      {encoding:'utf8',timeout:5000,env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'}});
  }catch{throw new Error('PROFILE_RESEAL_DATABASE_UNAVAILABLE');}
  const [clusterId,databaseOid]=output.trim().split('|');
  if(!/^[1-9][0-9]*$/.test(clusterId??'')||!/^[1-9][0-9]*$/.test(databaseOid??'')){
    throw new Error('PROFILE_RESEAL_DATABASE_UNAVAILABLE');
  }
  return {clusterId,databaseOid,databaseName:expected.databaseName};
}

/** Production paths with the same realpath resolution the controller uses for
 * `/usr/bin/node`. The wrapper and module never accept a caller-selected path. */
export function productionPaths(){
  return {...PRODUCTION_PATHS,
    contractSpecs:PRODUCTION_PATHS.contractSpecs.map(spec=>spec.key==='nodeSha256'
      ?{...spec,path:fsDefault.realpathSync('/usr/bin/node')}:spec)};
}

/** Production entry point. The installed module paths are fixed; `deps` is
 * reserved for the synthetic test harness and is never selectable from CLI. */
export async function runCli(argv,{paths=PRODUCTION_PATHS,deps}={}){
  const options=parseArguments(argv);
  if((process.getuid?.()??-1)!==0)fail('PROFILE_RESEAL_ADMIN_REQUIRED');
  const resolvedPaths=paths===PRODUCTION_PATHS?productionPaths():paths;
  if(!deps){
    const [attempt,controller,time,evidence,guard]=await Promise.all([
      import(resolvedPaths.installedDir+'/deployment-attempt.mjs'),
      import(resolvedPaths.installedDir+'/deployment-controller.mjs'),
      import(resolvedPaths.installedDir+'/trusted-time.mjs'),
      import(resolvedPaths.installedDir+'/historical-recovery-evidence.mjs'),
      import(resolvedPaths.installedDir+'/deployment-db-guard.mjs')
    ]);
    deps={uid:0,gid:0,validateHostProfile:attempt.validateHostProfile,
      validateDatabaseIdentity:guard.validateDatabaseIdentity,
      environmentBaseline:controller.environmentBaseline,
      sampleTrustedTime:time.sampleTrustedTime,
      verifyHistoricalPreservation:controller.verifyHistoricalPreservationGate,
      readStageReceipt:evidence.readHistoricalStageReceipt,
      verifyStageReadback:evidence.verifyHistoricalStageReadback,
      assertLock:lock=>assertHostLock(lock,{uid:0,gid:0,fs:fsDefault}),
      readDatabaseIdentity:readProductionDatabaseIdentity};
  }
  return resealProfile({...options,paths:resolvedPaths,deps});
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  runCli(process.argv.slice(2)).then(result=>{
    process.stdout.write(JSON.stringify(result)+'\n');
  }).catch(error=>{
    const message=/^[A-Z][A-Z0-9_]+$/.test(error?.message??'')
      ?error.message:'PROFILE_RESEAL_FAILED';
    process.stderr.write(message+'\n');
    process.exitCode=1;
  });
}
