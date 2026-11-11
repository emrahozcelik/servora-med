// Shared fixed-path evidence layer for the OPS-R4 historical contract.
//
// This module owns the exact 26-file historical inventory, the source-preserving
// OPS-R4-005 staging receipt and the OPS-R4-006 staging readback. It must never
// import the deployment controller: the controller imports this module for its
// OPS-R4-002 in-place acceptance branch, and a cycle would make the admission
// gate depend on its caller's module load order.
//
// Nothing here writes, moves, renames or removes a live historical source, and
// nothing here certifies an archive, independent retention or source removal.
import {createHash} from 'node:crypto';
import {
  constants,closeSync,fstatSync,lstatSync,openSync,readFileSync,readdirSync
} from 'node:fs';

export const HISTORICAL_STATE_ROOT='/var/lib/servora-med/deploy';
export const HISTORICAL_ATTEMPT_ID='6ce4cff0-fa73-450e-b540-3f54ae429e7c';
export const HISTORICAL_LOG_NAMES=Object.freeze([
  'migration.log',
  'observation-80472679-0cbd-49ea-ab59-145af196e01a.log',
  'observation-8656d395-df6e-4161-b353-ca4589221ec6.log',
  'postdeploy-operator-20261101T040551Z.log',
  'postdeploy-operator-20261101T040551Z.rc'
]);
export const HISTORICAL_ARCHIVED_PATHS=Object.freeze([
  ...Array.from({length:18},(_,index)=>'attempts/'+HISTORICAL_ATTEMPT_ID+'/'+
    String(index).padStart(4,'0')+'.json'),
  'admission-proofs/'+HISTORICAL_ATTEMPT_ID+'.json',
  'backups/'+HISTORICAL_ATTEMPT_ID+'-pre.dump',
  'backups/'+HISTORICAL_ATTEMPT_ID+'-post.dump',
  ...HISTORICAL_LOG_NAMES.map(name=>'logs/'+HISTORICAL_ATTEMPT_ID+'/'+name)
]);
export const HISTORICAL_SOURCE_DIRECTORIES=Object.freeze([
  'attempts','initializations','admission-proofs','backups','logs'
]);
export const HISTORICAL_REMOVED_DIRECTORIES=Object.freeze([
  'attempts/'+HISTORICAL_ATTEMPT_ID,
  'logs/'+HISTORICAL_ATTEMPT_ID
]);
export const HISTORICAL_STAGING_ROOT='/var/lib/servora-med-recovery-archive-staging';
export const HISTORICAL_STAGING_DIR=HISTORICAL_STAGING_ROOT+'/'+HISTORICAL_ATTEMPT_ID;
export const HISTORICAL_STAGING_RECEIPT=HISTORICAL_STAGING_ROOT+'/'+HISTORICAL_ATTEMPT_ID+
  '.stage-receipt.json';

/** Only the two operator-postdeploy files are normally 0644; every other
 * historical evidence file is root-only 0600. */
export const historicalSourceMode=path=>path.startsWith(
  'logs/'+HISTORICAL_ATTEMPT_ID+'/postdeploy-operator-')?'0644':'0600';

const ROOT=HISTORICAL_STATE_ROOT;
const HEX=/^[0-9a-f]{64}$/;
const NS=/^(?:0|[1-9][0-9]{0,19})$/;
const FILES=HISTORICAL_ARCHIVED_PATHS;
const STAGED_FILES=Object.freeze([...FILES,'preserved/profile.json','preserved/disposition.json']);
const STAGED_DIRS=Object.freeze(['.','attempts','attempts/'+HISTORICAL_ATTEMPT_ID,
  'admission-proofs','backups','logs','logs/'+HISTORICAL_ATTEMPT_ID,'preserved']);
const MARKERS=[
  ROOT+'/active.json',ROOT+'/activation.block',
  '/run/servora-med-recovery/start.permit',
  '/etc/systemd/system/servora-med.service.d/90-servora-recovery.conf'
];
const EXPECTED_CHILDREN={
  attempts:[HISTORICAL_ATTEMPT_ID],
  initializations:[],
  'admission-proofs':[HISTORICAL_ATTEMPT_ID+'.json'],
  backups:[HISTORICAL_ATTEMPT_ID+'-pre.dump',HISTORICAL_ATTEMPT_ID+'-post.dump'],
  logs:[HISTORICAL_ATTEMPT_ID],
  ['attempts/'+HISTORICAL_ATTEMPT_ID]:FILES.filter(x=>x.startsWith('attempts/'))
    .map(x=>x.split('/').at(-1)),
  ['logs/'+HISTORICAL_ATTEMPT_ID]:FILES.filter(x=>x.startsWith('logs/')).map(x=>x.split('/').at(-1))
};
const fail=()=>{throw new Error('RECOVERY_HISTORICAL_INVENTORY_INVALID');};
const digest=b=>createHash('sha256').update(b).digest('hex');
const exact=(a,b)=>Array.isArray(a)&&a.length===b.length&&a.every((v,i)=>v===b[i]);

export function validateHistoricalSourceInventory(value) {
  if (!value || value.kind!=='HISTORICAL_RECOVERY_SOURCE_INVENTORY'
    || value.formatVersion!==1||value.attemptId!==HISTORICAL_ATTEMPT_ID
    || value.authority!=='READ_ONLY_NOT_ARCHIVE_ACCEPTANCE'
    || !Array.isArray(value.files)||value.files.length!==FILES.length
    || !value.directories||typeof value.directories!=='object'
    || Object.keys(value.directories).length!==HISTORICAL_SOURCE_DIRECTORIES.length
      +HISTORICAL_REMOVED_DIRECTORIES.length
    || !value.pendingMarkers||typeof value.pendingMarkers!=='object'
    || Object.keys(value.pendingMarkers).length!==MARKERS.length
    || Object.values(value.pendingMarkers).some(x=>x!==false))fail();

  const seen=new Set();
  for(const f of value.files){
    if(!f||typeof f.archivePath!=='string'||!FILES.includes(f.archivePath)
      || seen.has(f.archivePath)||f.sourcePath!==ROOT+'/'+f.archivePath
      || f.type!=='file'||f.uid!==0||f.gid!==0||f.nlink!==1
      || f.mode!==historicalSourceMode(f.archivePath)||!NS.test(f.mtimeNs)
      || !Number.isSafeInteger(f.size)||f.size<=0||!HEX.test(f.sha256))fail();
    seen.add(f.archivePath);
  }
  if(seen.size!==FILES.length)fail();
  for(const name of [...HISTORICAL_SOURCE_DIRECTORIES,...HISTORICAL_REMOVED_DIRECTORIES]){
    const d=value.directories[ROOT+'/'+name];
    if(!d||d.type!=='directory'||d.uid!==0||d.gid!==0||d.mode!=='0700'
      || !NS.test(d.mtimeNs)||!Array.isArray(d.children)
      || !exact([...d.children].sort(),[...EXPECTED_CHILDREN[name]].sort()))fail();
  }
  for(const path of MARKERS){if(value.pendingMarkers[path]!==false)fail();}
  return value;
}

const statChecked=(path,kind,mode)=>{
  const s=lstatSync(path,{bigint:true});
  if((kind==='file'?!s.isFile():!s.isDirectory())||s.isSymbolicLink()
    ||s.uid!==0n||s.gid!==0n||(s.mode&0o7777n)!==BigInt(parseInt(mode,8))
    ||(kind==='file'&&s.nlink!==1n))fail();
  return s;
};
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size
  &&a.mode===b.mode&&a.mtimeNs===b.mtimeNs&&a.nlink===b.nlink;

const markerPresent=path=>{
  try{lstatSync(path);return true;}
  catch(error){if(error?.code==='ENOENT')return false;fail();}
};
export function captureHistoricalSourceInventory(){
  if(process.getuid?.()!==0)throw new Error('RECOVERY_HISTORICAL_INVENTORY_ADMIN_REQUIRED');
  // Dangling links and unreadable markers may not masquerade as absence.
  const pendingMarkers=Object.fromEntries(MARKERS.map(p=>[p,markerPresent(p)]));
  if(Object.values(pendingMarkers).some(Boolean))fail();
  const directories={};
  for(const name of [...HISTORICAL_SOURCE_DIRECTORIES,...HISTORICAL_REMOVED_DIRECTORIES]){
    const path=ROOT+'/'+name,pre=statChecked(path,'directory','0700');
    const children=readdirSync(path).sort();
    if(!exact(children,[...EXPECTED_CHILDREN[name]].sort()))fail();
    const post=statChecked(path,'directory','0700');
    if(!same(pre,post))fail();
    directories[path]={type:'directory',uid:0,gid:0,mode:'0700',mtimeNs:pre.mtimeNs.toString(),
      children};
  }
  const files=FILES.map(rel=>{
    const path=ROOT+'/'+rel,mode=historicalSourceMode(rel);
    const pre=statChecked(path,'file',mode);
    if(pre.size<=0n||pre.size>BigInt(Number.MAX_SAFE_INTEGER))fail();
    const bytes=readFileSync(path),post=statChecked(path,'file',mode);
    if(!same(pre,post)||BigInt(bytes.length)!==pre.size)fail();
    return {sourcePath:path,archivePath:rel,type:'file',uid:0,gid:0,nlink:1,
      mode,mtimeNs:pre.mtimeNs.toString(),size:bytes.length,sha256:digest(bytes)};
  });
  return validateHistoricalSourceInventory({formatVersion:1,
    kind:'HISTORICAL_RECOVERY_SOURCE_INVENTORY',attemptId:HISTORICAL_ATTEMPT_ID,
    authority:'READ_ONLY_NOT_ARCHIVE_ACCEPTANCE',files,directories,pendingMarkers});
}

const stageEntryKeys=['archivePath','sha256','size','mtimeNs','mode'];
const receiptKeys=['formatVersion','kind','authority','attemptId','sourceInventorySha256',
  'dispositionSha256','profileSha256','files'];
const readbackFail=()=>{throw new Error('RECOVERY_HISTORICAL_STAGE_READBACK_INVALID');};
const exactKeys=(obj,keys)=>obj&&typeof obj==='object'&&!Array.isArray(obj)
  &&Object.keys(obj).length===keys.length&&keys.every(k=>Object.hasOwn(obj,k));
const eqStat=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size
  &&a.mtimeNs===b.mtimeNs&&a.mode===b.mode&&a.nlink===b.nlink;
const check=(s,kind,uid,gid,mode)=>{
  if((kind==='file'?!s.isFile():!s.isDirectory())||s.isSymbolicLink()
    ||s.uid!==BigInt(uid)||s.gid!==BigInt(gid)
    ||(s.mode&0o7777n)!==BigInt(mode)
    ||(kind==='file'&&s.nlink!==1n))readbackFail();
};
function readTrusted(path,uid,gid,expectedMode=0o600){
  let fd;
  try {
    fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_CLOEXEC);
    const before=fstatSync(fd,{bigint:true});
    check(before,'file',uid,gid,expectedMode);
    const data=readFileSync(fd),after=fstatSync(fd,{bigint:true});
    if(!eqStat(before,after)||BigInt(data.length)!==before.size)readbackFail();
    return {bytes:data,sha256:digest(data),size:data.length,mtimeNs:before.mtimeNs.toString()};
  }catch{readbackFail();}finally{if(fd!==undefined)closeSync(fd);}
}

export function validateHistoricalStageReceipt(r){
  if(!exactKeys(r,receiptKeys)||r.formatVersion!==1
    ||r.kind!=='HISTORICAL_RECOVERY_STAGE_ONLY'
    ||r.authority!=='NOT_ARCHIVED_NOT_RETAINED_NO_SOURCE_REMOVAL'
    ||r.attemptId!==HISTORICAL_ATTEMPT_ID||!HEX.test(r.sourceInventorySha256)
    ||!HEX.test(r.dispositionSha256)||!HEX.test(r.profileSha256)
    ||!Array.isArray(r.files)||r.files.length!==STAGED_FILES.length)readbackFail();
  const seen=new Set();
  for(const entry of r.files){
    if(!exactKeys(entry,stageEntryKeys)||!STAGED_FILES.includes(entry.archivePath)
      ||seen.has(entry.archivePath)||!HEX.test(entry.sha256)
      ||!Number.isSafeInteger(entry.size)||entry.size<=0
      ||!NS.test(entry.mtimeNs)||entry.mode!=='0600')readbackFail();
    seen.add(entry.archivePath);
  }
  if(seen.size!==STAGED_FILES.length)readbackFail();
  if(r.files.find(x=>x.archivePath==='preserved/profile.json').sha256!==r.profileSha256
    ||r.files.find(x=>x.archivePath==='preserved/disposition.json').sha256!==r.dispositionSha256)readbackFail();
  return r;
}

/** Root-private read of the canonical OPS-R4-005 staging receipt. */
export function readHistoricalStageReceipt({receiptPath,uid,gid}){
  if(!Number.isSafeInteger(uid)||uid<0||!Number.isSafeInteger(gid)||gid<0)readbackFail();
  try {
    const bytes=readTrusted(receiptPath,uid,gid).bytes;
    const receipt=JSON.parse(bytes.toString('utf8'));
    if(JSON.stringify(receipt)+'\n'!==bytes.toString('utf8'))readbackFail();
    return {receipt:validateHistoricalStageReceipt(receipt),sha256:digest(bytes)};
  }catch{readbackFail();}
}

export function verifyHistoricalStageReadback({stageRoot,receiptPath,uid,gid,receipt}){
  if(!Number.isSafeInteger(uid)||uid<0||!Number.isSafeInteger(gid)||gid<0)readbackFail();
  let sealed;
  try {
    sealed=receipt??readHistoricalStageReceipt({receiptPath,uid,gid}).receipt;
    validateHistoricalStageReceipt(sealed);
  }catch{readbackFail();}
  const expectedFiles=new Set(STAGED_FILES),expectedDirs=new Set(STAGED_DIRS);
  const measured=new Map();
  const walk=(path,rel)=>{
    let s,names;
    try{s=lstatSync(path,{bigint:true});check(s,'directory',uid,gid,0o700);
      names=readdirSync(path);}catch{readbackFail();}
    if(!expectedDirs.delete(rel||'.'))readbackFail();
    for(const name of names){
      const childRel=rel?rel+'/'+name:name,child=path+'/'+name;
      let info;
      try{info=lstatSync(child,{bigint:true});}catch{readbackFail();}
      if(info.isSymbolicLink())readbackFail();
      if(info.isDirectory())walk(child,childRel);
      else if(info.isFile()){
        if(!expectedFiles.delete(childRel))readbackFail();
        measured.set(childRel,readTrusted(child,uid,gid));
      }else readbackFail();
    }
  };
  walk(stageRoot,'');
  if(expectedFiles.size||expectedDirs.size||measured.size!==STAGED_FILES.length)readbackFail();
  for(const entry of sealed.files){
    const actual=measured.get(entry.archivePath);
    if(!actual||actual.sha256!==entry.sha256||actual.size!==entry.size
      ||actual.mtimeNs!==entry.mtimeNs)readbackFail();
  }
  return Object.freeze({status:'STAGE_READBACK_VERIFIED_ONLY',
    authority:'NOT_ARCHIVED_NOT_INDEPENDENTLY_RETAINED',
    attemptId:HISTORICAL_ATTEMPT_ID,filesVerified:STAGED_FILES.length,
    receiptSha256:digest(Buffer.from(JSON.stringify(sealed)+'\n'))});
}
