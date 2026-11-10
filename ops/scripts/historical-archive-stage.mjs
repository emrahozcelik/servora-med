// OPS-R4-005: source-preserving historical archive staging.
// This is NOT an archive sealer, retention proof, source-removal procedure,
// deployment approval or substitute for OPS-R4-003 ARCHIVE-COMPLETE.
// Production CLI has no arguments or selectable paths and requires the host lock.
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {
  closeSync,constants,existsSync,fsyncSync,chmodSync,lstatSync,fstatSync,mkdirSync,
  openSync,readFileSync,readdirSync,writeFileSync
} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {OPS_R4_003_POLICY,OPS_R4_003_LAYOUT} from './deployment-controller.mjs';
import {
  captureHistoricalSourceInventory,validateHistoricalSourceInventory
} from './historical-archive-preflight.mjs';

const STATE='/var/lib/servora-med/deploy';
const STAGING_PARENT='/var/lib/servora-med-recovery-archive-staging';
const ID=OPS_R4_003_POLICY.attemptId;
const BYTES=OPS_R4_003_LAYOUT.archivedPaths;
const MODE_DIR=0o700,MODE_FILE=0o600;
const sha=b=>createHash('sha256').update(b).digest('hex');
const fail=(code='RECOVERY_HISTORICAL_STAGE_INVALID')=>{throw new Error(code);};
const meta=path=>lstatSync(path,{bigint:true});
const regular=(path,mode,uid)=> {
  const s=meta(path);
  if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1n
    ||s.uid!==BigInt(uid)||(s.mode&0o7777n)!==BigInt(mode))fail();
  return s;
};
const directory=(path,uid,mode=MODE_DIR)=>{
  const s=meta(path);
  if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==BigInt(uid)
    ||(s.mode&0o7777n)!==BigInt(mode))fail();
  return s;
};
const equalStat=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size
  &&a.mtimeNs===b.mtimeNs&&a.mode===b.mode&&a.nlink===b.nlink;
const durable=(path,isDirectory=false)=>{
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|
    constants.O_CLOEXEC|(isDirectory?constants.O_DIRECTORY:0));
  try{fsyncSync(fd);}finally{closeSync(fd);}
};
const exact=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);

function captureTrustedBytes(path,mode,uid){
  const before=regular(path,mode,uid);
  const bytes=readFileSync(path),after=regular(path,mode,uid);
  if(!equalStat(before,after)||BigInt(bytes.length)!==before.size)fail();
  return {bytes,sha256:sha(bytes),mtimeNs:before.mtimeNs.toString(),size:bytes.length};
}

function assertDispositions(profile,disposition){
  let d;
  try {d=JSON.parse(disposition.bytes.toString('utf8'));}catch{fail();}
  if(disposition.bytes.toString('utf8')!==JSON.stringify(d)+'\n'
    ||d.kind!=='HISTORICAL_RECOVERY_DISPOSITION'||d.attemptId!==ID
    ||d.terminal!==false||d.r4Acceptance!=='NOT_ACCEPTED'
    ||d.classification!=='ABANDONED_SUPERSEDED'
    ||d.profileSha256!==profile.sha256)fail();
  return d;
}

function mkdirExact(path,uid){
  mkdirSync(path,{mode:MODE_DIR});
  directory(path,uid);
  durable(path,true);
  durable(path.slice(0,path.lastIndexOf('/')),true);
}

function copyExact(src,dst,expected,uid){
  const source=regular(src,parseInt(expected.mode,8),uid);
  if(source.mtimeNs.toString()!==expected.mtimeNs
    ||Number(source.size)!==expected.size)fail();
  const bytes=captureTrustedBytes(src,parseInt(expected.mode,8),uid);
  if(bytes.sha256!==expected.sha256||bytes.mtimeNs!==expected.mtimeNs)fail();
  if(existsSync(dst))fail();
  // GNU coreutils cp preserves the exact nanosecond timestamp via futimens;
  // Node's fs.utimesSync() alone must not be used for this fidelity requirement.
  execFileSync('/usr/bin/cp',[
    '--no-dereference','--reflink=never','--preserve=timestamps','--',src,dst
  ],{stdio:'pipe',timeout:30000,env:{PATH:'/usr/bin:/bin',LANG:'C'}});
  chmodSync(dst,MODE_FILE);
  const staged=captureTrustedBytes(dst,MODE_FILE,uid);
  if(staged.sha256!==bytes.sha256||staged.size!==bytes.size
    ||staged.mtimeNs!==bytes.mtimeNs)fail();
  durable(dst);
  return {archivePath:expected.archivePath,sha256:staged.sha256,
    size:staged.size,mtimeNs:staged.mtimeNs,mode:'0600'};
}

function verifyStageTree(stageRoot,uid){
  const files=new Set([...BYTES,'preserved/profile.json','preserved/disposition.json']);
  const dirs=new Set(['.','attempts','attempts/'+ID,'admission-proofs','backups',
    'logs','logs/'+ID,'preserved']);
  let count=0;
  function walk(path,rel){
    directory(path,uid);
    if(!dirs.delete(rel||'.'))fail();
    for(const n of readdirSync(path)){
      const child=rel?rel+'/'+n:n,full=path+'/'+n,s=meta(full);
      if(s.isSymbolicLink())fail();
      if(s.isDirectory())walk(full,child);
      else if(s.isFile()){
        regular(full,MODE_FILE,uid);
        if(!files.delete(child))fail();
        count++;
      }else fail();
    }
  }
  walk(stageRoot,'');
  if(files.size||dirs.size||count!==28)fail();
}

/**
 * Testable, source-preserving copy engine. Caller paths can only be supplied
 * by trusted module callers; production CLI exposes no CLI selectors.
 * No unlink, rename or delete is used anywhere in this module.
 */
export function stageHistoricalEvidence({sourceRoot,stagingParent,inventory,uid}) {
  validateHistoricalSourceInventory(inventory);
  directory(stagingParent,uid);
  const stageRoot=stagingParent+'/'+ID;
  const receiptPath=stagingParent+'/'+ID+'.stage-receipt.json';
  if(existsSync(stageRoot)||existsSync(receiptPath))fail('RECOVERY_HISTORICAL_STAGE_ALREADY_PRESENT');
  const profile=captureTrustedBytes(sourceRoot+'/profile.json',MODE_FILE,uid);
  const disposition=captureTrustedBytes(sourceRoot+'/historical-dispositions/'+ID+'.json',MODE_FILE,uid);
  assertDispositions(profile,disposition);
  const entries=[];
  // Stage creation happens only after source and disposition preflight.
  mkdirExact(stageRoot,uid);
  for(const d of ['attempts','attempts/'+ID,'admission-proofs','backups',
    'logs','logs/'+ID,'preserved'])mkdirExact(stageRoot+'/'+d,uid);
  const byPath=new Map(inventory.files.map(f=>[f.archivePath,f]));
  for(const rel of BYTES){
    const expected=byPath.get(rel);
    if(!expected)fail();
    entries.push(copyExact(sourceRoot+'/'+rel,stageRoot+'/'+rel,expected,uid));
  }
  for(const [rel,src,snapshot] of [
    ['preserved/profile.json',sourceRoot+'/profile.json',profile],
    ['preserved/disposition.json',sourceRoot+'/historical-dispositions/'+ID+'.json',disposition]
  ]){
    entries.push(copyExact(src,stageRoot+'/'+rel,{
      archivePath:rel,sha256:snapshot.sha256,size:snapshot.size,
      mtimeNs:snapshot.mtimeNs,mode:'0600'
    },uid));
  }
  verifyStageTree(stageRoot,uid);
  for(const dir of ['preserved','logs/'+ID,'logs','backups','admission-proofs',
    'attempts/'+ID,'attempts',''])durable(stageRoot+(dir?'/'+dir:''),true);

  const receipt={formatVersion:1,kind:'HISTORICAL_RECOVERY_STAGE_ONLY',
    authority:'NOT_ARCHIVED_NOT_RETAINED_NO_SOURCE_REMOVAL',
    attemptId:ID,sourceInventorySha256:sha(Buffer.from(JSON.stringify(inventory)+'\n')),
    dispositionSha256:disposition.sha256,profileSha256:profile.sha256,
    files:entries};
  const contents=JSON.stringify(receipt)+'\n';
  const fd=openSync(receiptPath,constants.O_CREAT|constants.O_EXCL|
    constants.O_WRONLY|constants.O_NOFOLLOW,MODE_FILE);
  try{writeFileSync(fd,contents);fsyncSync(fd);}finally{closeSync(fd);}
  durable(stagingParent,true);
  return {receiptSha256:sha(Buffer.from(contents)),files:entries.length,
    status:'STAGED_ONLY_NO_SOURCE_REMOVAL'};
}

export function stageHistoricalArchive() {
  if(process.getuid?.()!==0)fail('RECOVERY_HISTORICAL_STAGE_ADMIN_REQUIRED');
  if(process.argv.length!==2)fail('RECOVERY_HISTORICAL_STAGE_ARGUMENTS_INVALID');
  // The invoking shell wrapper must acquire the stable host lock before Node.
  // Staging is deliberately not made available through deployment sudoers.
  directory(STATE,0);
  const lock=regular(STATE+'/host.lock',MODE_FILE,0);
  let inherited;
  try{inherited=fstatSync(9,{bigint:true});}catch{fail('RECOVERY_HISTORICAL_STAGE_HOST_LOCK_REQUIRED');}
  if(inherited.dev!==lock.dev||inherited.ino!==lock.ino)
    fail('RECOVERY_HISTORICAL_STAGE_HOST_LOCK_REQUIRED');
  const snapshot=captureHistoricalSourceInventory();
  if(!existsSync(STAGING_PARENT))mkdirExact(STAGING_PARENT,0);
  const result=stageHistoricalEvidence({
    sourceRoot:STATE,stagingParent:STAGING_PARENT,inventory:snapshot,uid:0
  });
  const after=captureHistoricalSourceInventory();
  if(JSON.stringify(after)!==JSON.stringify(snapshot))fail();
  return result;
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  try{
    const result=stageHistoricalArchive();
    process.stdout.write(JSON.stringify(result)+'\n');
  }catch(e){
    process.stderr.write((/^[A-Z][A-Z0-9_]+$/.test(e.message)
      ?e.message:'RECOVERY_HISTORICAL_STAGE_FAILED')+'\n');
    process.exitCode=1;
  }
}
