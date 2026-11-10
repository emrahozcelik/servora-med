// OPS-R4-006: strict, read-only readback of the historical staging tree.
// It never certifies independent retention, a historical archive, approval,
// disposition, source removal, restore success or deploy eligibility.
import {createHash} from 'node:crypto';
import {constants,closeSync,existsSync,fstatSync,lstatSync,openSync,readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {OPS_R4_003_POLICY,OPS_R4_003_LAYOUT} from './deployment-controller.mjs';

const ID=OPS_R4_003_POLICY.attemptId;
const ROOT='/var/lib/servora-med-recovery-archive-staging';
const FILES=Object.freeze([...OPS_R4_003_LAYOUT.archivedPaths,
  'preserved/profile.json','preserved/disposition.json']);
const DIRS=Object.freeze(['.','attempts','attempts/'+ID,
  'admission-proofs','backups','logs','logs/'+ID,'preserved']);
const HEX=/^[0-9a-f]{64}$/;
const NS=/^(?:0|[1-9][0-9]{0,19})$/;
const sha=buffer=>createHash('sha256').update(buffer).digest('hex');
const fail=()=>{throw new Error('RECOVERY_HISTORICAL_STAGE_READBACK_INVALID');};
const exactKeys=(obj,keys)=>obj&&typeof obj==='object'&&!Array.isArray(obj)
  &&Object.keys(obj).length===keys.length&&keys.every(k=>Object.hasOwn(obj,k));
const eqStat=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size
  &&a.mtimeNs===b.mtimeNs&&a.mode===b.mode&&a.nlink===b.nlink;
const check=(s,kind,uid,gid,mode)=>{
  if((kind==='file'?!s.isFile():!s.isDirectory())||s.isSymbolicLink()
    ||s.uid!==BigInt(uid)||s.gid!==BigInt(gid)
    ||(s.mode&0o7777n)!==BigInt(mode)
    ||(kind==='file'&&s.nlink!==1n))fail();
};
function readTrusted(path,uid,gid,expectedMode=0o600){
  let fd;
  try {
    fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_CLOEXEC);
    const before=fstatSync(fd,{bigint:true});
    check(before,'file',uid,gid,expectedMode);
    const data=readFileSync(fd),after=fstatSync(fd,{bigint:true});
    if(!eqStat(before,after)||BigInt(data.length)!==before.size)fail();
    return {bytes:data,sha256:sha(data),size:data.length,mtimeNs:before.mtimeNs.toString()};
  }catch{fail();}finally{if(fd!==undefined)closeSync(fd);}
}
const stageEntryKeys=['archivePath','sha256','size','mtimeNs','mode'];
const receiptKeys=['formatVersion','kind','authority','attemptId','sourceInventorySha256',
  'dispositionSha256','profileSha256','files'];

export function validateHistoricalStageReceipt(r){
  if(!exactKeys(r,receiptKeys)||r.formatVersion!==1
    ||r.kind!=='HISTORICAL_RECOVERY_STAGE_ONLY'
    ||r.authority!=='NOT_ARCHIVED_NOT_RETAINED_NO_SOURCE_REMOVAL'
    ||r.attemptId!==ID||!HEX.test(r.sourceInventorySha256)
    ||!HEX.test(r.dispositionSha256)||!HEX.test(r.profileSha256)
    ||!Array.isArray(r.files)||r.files.length!==FILES.length)fail();
  const seen=new Set();
  for(const entry of r.files){
    if(!exactKeys(entry,stageEntryKeys)||!FILES.includes(entry.archivePath)
      ||seen.has(entry.archivePath)||!HEX.test(entry.sha256)
      ||!Number.isSafeInteger(entry.size)||entry.size<=0
      ||!NS.test(entry.mtimeNs)||entry.mode!=='0600')fail();
    seen.add(entry.archivePath);
  }
  if(seen.size!==FILES.length)fail();
  if(r.files.find(x=>x.archivePath==='preserved/profile.json').sha256!==r.profileSha256
    ||r.files.find(x=>x.archivePath==='preserved/disposition.json').sha256!==r.dispositionSha256)fail();
  return r;
}

export function verifyHistoricalStageReadback({stageRoot,receiptPath,uid,gid}){
  if(!Number.isSafeInteger(uid)||uid<0||!Number.isSafeInteger(gid)||gid<0)fail();
  let receipt;
  try {
    const bytes=readTrusted(receiptPath,uid,gid).bytes;
    receipt=JSON.parse(bytes.toString('utf8'));
    if(JSON.stringify(receipt)+'\n'!==bytes.toString('utf8'))fail();
    validateHistoricalStageReceipt(receipt);
  }catch{fail();}
  const expectedFiles=new Set(FILES),expectedDirs=new Set(DIRS);
  const measured=new Map();
  const walk=(path,rel)=>{
    let s,names;
    try{s=lstatSync(path,{bigint:true});check(s,'directory',uid,gid,0o700);
      names=readdirSync(path);}catch{fail();}
    if(!expectedDirs.delete(rel||'.'))fail();
    for(const name of names){
      const childRel=rel?rel+'/'+name:name,child=path+'/'+name;
      let info;
      try{info=lstatSync(child,{bigint:true});}catch{fail();}
      if(info.isSymbolicLink())fail();
      if(info.isDirectory())walk(child,childRel);
      else if(info.isFile()){
        if(!expectedFiles.delete(childRel))fail();
        measured.set(childRel,readTrusted(child,uid,gid));
      }else fail();
    }
  };
  walk(stageRoot,'');
  if(expectedFiles.size||expectedDirs.size||measured.size!==FILES.length)fail();
  for(const entry of receipt.files){
    const actual=measured.get(entry.archivePath);
    if(!actual||actual.sha256!==entry.sha256||actual.size!==entry.size
      ||actual.mtimeNs!==entry.mtimeNs)fail();
  }
  return Object.freeze({status:'STAGE_READBACK_VERIFIED_ONLY',
    authority:'NOT_ARCHIVED_NOT_INDEPENDENTLY_RETAINED',
    attemptId:ID,filesVerified:FILES.length,
    receiptSha256:sha(Buffer.from(JSON.stringify(receipt)+'\n'))});
}

export function verifyFixedHistoricalStage(){
  if(process.getuid?.()!==0)
    throw new Error('RECOVERY_HISTORICAL_STAGE_READBACK_ADMIN_REQUIRED');
  if(process.argv.length!==2)
    throw new Error('RECOVERY_HISTORICAL_STAGE_READBACK_ARGUMENTS_INVALID');
  return verifyHistoricalStageReadback({
    stageRoot:ROOT+'/'+ID,receiptPath:ROOT+'/'+ID+'.stage-receipt.json',uid:0,gid:0
  });
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  try{process.stdout.write(JSON.stringify(verifyFixedHistoricalStage())+'\n');}
  catch(e){process.stderr.write((/^[A-Z][A-Z0-9_]+$/.test(e.message)
    ?e.message:'RECOVERY_HISTORICAL_STAGE_READBACK_INVALID')+'\n');process.exitCode=1;}
}
