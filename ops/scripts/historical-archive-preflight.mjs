// OPS-R4-004: read-only, exact-path historical source inventory. This module
// never publishes an archive, moves a source, issues a grant or seals a record.
// Its JSON output is NOT a disposition, approval, or archival acceptance proof.
import {createHash} from 'node:crypto';
import {existsSync,lstatSync,readdirSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {OPS_R4_003_POLICY,OPS_R4_003_LAYOUT} from './deployment-controller.mjs';

const ROOT='/var/lib/servora-med/deploy';
const ID=OPS_R4_003_POLICY.attemptId;
const HEX=/^[0-9a-f]{64}$/;
const NS=/^(?:0|[1-9][0-9]{0,19})$/;
const FILES=OPS_R4_003_LAYOUT.archivedPaths;
const SOURCE_DIRS=['attempts','initializations','admission-proofs','backups','logs'];
const REMOVED_DIRS=['attempts/'+ID,'logs/'+ID];
const MARKERS=[
  ROOT+'/active.json',ROOT+'/activation.block',
  '/run/servora-med-recovery/start.permit',
  '/etc/systemd/system/servora-med.service.d/90-servora-recovery.conf'
];
const EXPECTED_CHILDREN={
  attempts:[ID],
  initializations:[],
  'admission-proofs':[ID+'.json'],
  backups:[ID+'-pre.dump',ID+'-post.dump'],
  logs:[ID],
  ['attempts/'+ID]:FILES.filter(x=>x.startsWith('attempts/')).map(x=>x.split('/').at(-1)),
  ['logs/'+ID]:FILES.filter(x=>x.startsWith('logs/')).map(x=>x.split('/').at(-1))
};
const sourceMode=rel=>rel.startsWith('logs/'+ID+'/postdeploy-operator-')?'0644':'0600';
const fail=()=>{throw new Error('RECOVERY_HISTORICAL_INVENTORY_INVALID');};
const digest=b=>createHash('sha256').update(b).digest('hex');
const exact=(a,b)=>Array.isArray(a)&&a.length===b.length&&a.every((v,i)=>v===b[i]);

export function validateHistoricalSourceInventory(value) {
  if (!value || value.kind!=='HISTORICAL_RECOVERY_SOURCE_INVENTORY'
    || value.formatVersion!==1||value.attemptId!==ID
    || value.authority!=='READ_ONLY_NOT_ARCHIVE_ACCEPTANCE'
    || !Array.isArray(value.files)||value.files.length!==FILES.length
    || !value.directories||typeof value.directories!=='object'
    || Object.keys(value.directories).length!==SOURCE_DIRS.length+REMOVED_DIRS.length
    || !value.pendingMarkers||typeof value.pendingMarkers!=='object'
    || Object.keys(value.pendingMarkers).length!==MARKERS.length
    || Object.values(value.pendingMarkers).some(x=>x!==false))fail();

  const seen=new Set();
  for(const f of value.files){
    if(!f||typeof f.archivePath!=='string'||!FILES.includes(f.archivePath)
      || seen.has(f.archivePath)||f.sourcePath!==ROOT+'/'+f.archivePath
      || f.type!=='file'||f.uid!==0||f.gid!==0||f.nlink!==1
      || f.mode!==sourceMode(f.archivePath)||!NS.test(f.mtimeNs)
      || !Number.isSafeInteger(f.size)||f.size<=0||!HEX.test(f.sha256))fail();
    seen.add(f.archivePath);
  }
  if(seen.size!==FILES.length)fail();
  for(const name of [...SOURCE_DIRS,...REMOVED_DIRS]){
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

export function captureHistoricalSourceInventory(){
  if(process.getuid?.()!==0)throw new Error('RECOVERY_HISTORICAL_INVENTORY_ADMIN_REQUIRED');
  const pendingMarkers=Object.fromEntries(MARKERS.map(p=>[p,existsSync(p)]));
  if(Object.values(pendingMarkers).some(Boolean))fail();
  const directories={};
  for(const name of [...SOURCE_DIRS,...REMOVED_DIRS]){
    const path=ROOT+'/'+name,pre=statChecked(path,'directory','0700');
    const children=readdirSync(path).sort();
    if(!exact(children,[...EXPECTED_CHILDREN[name]].sort()))fail();
    const post=statChecked(path,'directory','0700');
    if(!same(pre,post))fail();
    directories[path]={type:'directory',uid:0,gid:0,mode:'0700',mtimeNs:pre.mtimeNs.toString(),children};
  }
  const files=FILES.map(rel=>{
    const path=ROOT+'/'+rel,mode=sourceMode(rel);
    const pre=statChecked(path,'file',mode);
    if(pre.size<=0n||pre.size>BigInt(Number.MAX_SAFE_INTEGER))fail();
    const bytes=readFileSync(path),post=statChecked(path,'file',mode);
    if(!same(pre,post)||BigInt(bytes.length)!==pre.size)fail();
    return {sourcePath:path,archivePath:rel,type:'file',uid:0,gid:0,nlink:1,
      mode,mtimeNs:pre.mtimeNs.toString(),size:bytes.length,sha256:digest(bytes)};
  });
  return validateHistoricalSourceInventory({formatVersion:1,
    kind:'HISTORICAL_RECOVERY_SOURCE_INVENTORY',attemptId:ID,
    authority:'READ_ONLY_NOT_ARCHIVE_ACCEPTANCE',files,directories,pendingMarkers});
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  if(process.argv.length!==2)throw new Error('RECOVERY_HISTORICAL_INVENTORY_ARGUMENTS_INVALID');
  // Root-only readback; deliberately no filesystem mutation and no output files.
  process.stdout.write(JSON.stringify(captureHistoricalSourceInventory())+'\n');
}
