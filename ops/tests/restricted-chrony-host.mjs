/** Fresh signed lab only. Never a production bootstrap/issuer entrypoint. */
import assert from 'node:assert/strict';
import {createHash,createPublicKey,verify,randomUUID} from 'node:crypto';
import {readFileSync,lstatSync,openSync,closeSync,fstatSync,constants,writeFileSync,fsyncSync,mkdirSync,chmodSync,chownSync,renameSync,symlinkSync,unlinkSync,realpathSync,linkSync} from 'node:fs';
import {hostname} from 'node:os';
import {execFileSync,spawnSync} from 'node:child_process';
import {createConnection} from 'node:net';
/** Deployment APIs execute the installed, descriptor-bound modules; the staged
 * source tree at SOURCE stays hash-only evidence and is never imported. */
import {validateCurrentTimeEvidence} from '/usr/local/libexec/servora-med/trusted-time.mjs';
import {validateHostProfile,issueRootApproval,readRootApproval,readLatestCheckpoint} from '/usr/local/libexec/servora-med/deployment-attempt.mjs';
import {environmentBaseline,admitAttempt,currentAttempt} from '/usr/local/libexec/servora-med/deployment-controller.mjs';
const ROOT='/var/lib/servora-med/deploy',LAB='/etc/servora-reader-lab',SOURCE='/opt/servora-lab',INSTALLED='/usr/local/libexec/servora-med';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const run=(file,args)=>execFileSync(file,args,{encoding:'utf8',timeout:10000,env:{PATH:'/usr/sbin:/usr/bin:/bin',LC_ALL:'C'}}).trim();
const boot=()=>readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
function protectedRead(file,mode=0o600){
 const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);try{
  const s=fstatSync(fd),n=lstatSync(file);assert(s.isFile()&&s.uid===0&&s.gid===0&&s.nlink===1&&(s.mode&0o7777)===mode&&s.size<262144&&s.ino===n.ino&&s.dev===n.dev);return readFileSync(fd);
 }finally{closeSync(fd);}
}
function guard(){
 assert.equal(process.getuid(),0);assert.equal(process.platform,'linux');assert.equal(process.arch,'x64');
 assert(readFileSync('/etc/os-release','utf8').includes('VERSION_ID="24.04"'));
 assert.equal(readFileSync('/proc/1/comm','utf8').trim(),'systemd');
 const d=JSON.parse(protectedRead(LAB+'/descriptor.json')),sig=protectedRead(LAB+'/descriptor.sig'),pub=createPublicKey(protectedRead(LAB+'/operator.pub',0o644));
 assert.equal(pub.asymmetricKeyType,'ed25519');assert(verify(null,Buffer.from(JSON.stringify(d)+'\n'),pub,sig));
 assert.equal(d.kind,'USER_AUTHORIZED_READER_LAB');assert.equal(d.externalOperatorApproval,false);assert.equal(d.productionGo,false);
 assert.match(d.runId,/^[0-9a-f-]{36}$/);assert.equal(d.hostname,hostname());assert(hostname().startsWith('lima-servora-rr-'));
 assert.equal(d.machineId,readFileSync('/etc/machine-id','utf8').trim());
 assert.equal(d.resourceId,readFileSync('/sys/class/dmi/id/product_uuid','utf8').trim().toLowerCase());
 for(const [name,digest] of Object.entries(d.sourceFiles)){assert(!name.includes('..')&&!name.startsWith('/'));assert.equal(hash(protectedRead(SOURCE+'/'+name,0o644)),digest);}
 for(const name of ['trusted-time','deployment-attempt','deployment-controller','deployment-db-guard','migration-reconciliation'])
  assert.equal(hash(protectedRead(INSTALLED+'/'+name+'.mjs',0o644)),d.sourceFiles['ops/scripts/'+name+'.mjs'],'installed module must match the signed source capsule');
 return d;
}
const d=guard(),phase=process.argv[2];assert.equal(process.argv.length,3);
const probe=()=>spawnSync('/usr/sbin/runuser',['-u','servora-med','--','/usr/bin/node','/usr/local/libexec/servora-med/trusted-time.mjs','--read-chrony'],{encoding:'utf8',timeout:4000});
const known=()=>{const p=probe();assert.equal(p.status,0,p.stderr);const t=validateCurrentTimeEvidence(JSON.parse(p.stdout));console.log(JSON.stringify({kind:'REAL_APP_UID_KNOWN',time:t}));return t;};
const denied=name=>{const p=probe();assert.notEqual(p.status,0,name);assert.equal(p.stdout,'');console.log(JSON.stringify({kind:'DENIAL',name,status:p.status,bootId:boot()}));};
const publish=(file,value)=>{const fd=openSync(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{writeFileSync(fd,JSON.stringify(value)+'\n');fsyncSync(fd);}finally{closeSync(fd);}const dir=openSync(file.slice(0,file.lastIndexOf('/')),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{fsyncSync(dir);}finally{closeSync(dir);}};
if(phase==='sample'){known();}
else if(phase==='negative'){
 known();const socket='/run/servora-med-time/evidence.sock',config='/etc/chrony/chrony.conf';
 const cfg=protectedRead(config,0o644);const gid=lstatSync(socket).gid;
 linkSync(config,config+'.owned-link');try{denied('hardlink config');}finally{unlinkSync(config+'.owned-link');}
 assert.notEqual(spawnSync('/usr/sbin/runuser',['-u','servora-med','--','/usr/bin/touch','/run/servora-med-time/foreign']).status,0);
 assert.notEqual(spawnSync('/usr/sbin/runuser',['-u','servora-med','--','/usr/bin/chronyc','selectdata','-a']).status,0);
 chmodSync(socket,0o666);try{denied('writable socket');}finally{chmodSync(socket,0o660);}
 chownSync(socket,65534,gid);try{denied('foreign socket owner');}finally{chownSync(socket,0,gid);}
 renameSync(socket,socket+'.owned');symlinkSync(socket+'.owned',socket);try{denied('symlink socket');}finally{unlinkSync(socket);renameSync(socket+'.owned',socket);}
 writeFileSync(config,Buffer.concat([cfg,Buffer.from('# deliberate owned lab config drift\n')]));try{denied('config drift');}finally{writeFileSync(config,cfg);}
 run('/usr/bin/systemctl',['stop','servora-med-time-evidence.socket']);try{denied('collector absent');}finally{run('/usr/bin/systemctl',['start','servora-med-time-evidence.socket']);}
 const bad=await new Promise((resolve,reject)=>{let bytes=0;const c=createConnection('/run/servora-med-time/evidence.sock');c.setTimeout(4000,()=>{c.destroy();reject(new Error('protocol timeout'));});c.on('connect',()=>c.end('tracking\n'));c.on('data',b=>bytes+=b.length);c.on('error',reject);c.on('end',()=>resolve(bytes));});assert.equal(bad,0);
 console.log(JSON.stringify({kind:'FIXED_PROTOCOL_COMMAND_REJECTED',bytes:bad}));
}
else if(phase==='prepare-reboot'){
 known();assert.equal(spawnSync('/usr/bin/test',['-e',ROOT]).status,1,'fresh signed lab required: /var/lib/servora-med/deploy must not exist');
 mkdirSync('/var/lib/servora-med',{mode:0o755});mkdirSync(ROOT,{mode:0o700});
 for(const name of ['approvals','attempts','initializations'])mkdirSync(ROOT+'/'+name,{mode:0o700});
 const fd=openSync(ROOT+'/host.lock',constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);closeSync(fd);
 const installed='/usr/local/libexec/servora-med',paths={helperSha256:installed+'/deploy-production-host',nodeSha256:realpathSync('/usr/bin/node'),unitSha256:'/etc/systemd/system/servora-med.service',attemptModuleSha256:installed+'/deployment-attempt.mjs',dbGuardModuleSha256:installed+'/deployment-db-guard.mjs',reconciliationModuleSha256:installed+'/migration-reconciliation.mjs',controllerModuleSha256:installed+'/deployment-controller.mjs',timeModuleSha256:installed+'/trusted-time.mjs',timeConfigSha256:'/etc/chrony/chrony.conf'};
 const profile=validateHostProfile({formatVersion:2,machineId:d.machineId,fqdn:d.hostname+'.synthetic.invalid',databaseIdentity:d.databaseIdentity,envBaselineSha256:environmentBaseline(readFileSync('/etc/servora-med/servora-med.env','utf8')),contracts:Object.fromEntries(Object.entries(paths).map(([k,p])=>[k,hash(readFileSync(p))]))});publish(ROOT+'/profile.json',profile);
 const fields=()=>({attemptId:randomUUID(),releaseSha:d.sourceSha,treeSha:d.sourceTree,artifactSha256:d.sourceCapsuleSha256,ciManifestSha256:hash(protectedRead(LAB+'/descriptor.json')),oldReleaseSha:d.sourceSha,oldArtifactSha256:d.sourceCapsuleSha256,targetCatalog:d.catalog,oldCatalog:d.catalog,profileSha256:hash(readFileSync(ROOT+'/profile.json')),maxStarts:1,maxAbortStarts:0,allowMigration:false,allowForwardRecovery:false,allowPreMigrationAbort:false,allowPostdeployBackup:false});
 // Source-capsule/API lab only: no deployment/artifact acceptance or effects.
 const unconsumed=issueRootApproval(fields(),7200000),consumed=issueRootApproval(fields(),7200000);
 const lock=run('/usr/bin/flock',['-n',ROOT+'/host.lock','/usr/bin/node','--input-type=module','--eval',`import {admitAttempt} from '${installed}/deployment-controller.mjs'; console.log(JSON.stringify(admitAttempt('${consumed.record.attemptId}')));`]);assert.equal(JSON.parse(lock).checkpoint.record.phase,'ADMITTED');
 const pathsToKeep=[ROOT+'/profile.json',ROOT+'/approvals/'+unconsumed.record.attemptId+'.json',ROOT+'/approvals/'+consumed.record.attemptId+'.json',ROOT+'/attempts/'+consumed.record.attemptId+'/0000.json',ROOT+'/admission-proofs/'+consumed.record.attemptId+'.json',ROOT+'/active.json'];
 const saved={bootId:boot(),unconsumedId:unconsumed.record.attemptId,consumedId:consumed.record.attemptId,files:Object.fromEntries(pathsToKeep.map(p=>[p,hash(readFileSync(p))])),hostLock:{dev:lstatSync(ROOT+'/host.lock').dev,ino:lstatSync(ROOT+'/host.lock').ino},grant:consumed.record};publish(LAB+'/before-reboot.json',saved);
 console.log(JSON.stringify({kind:'PREPARED_REAL_REBOOT',bootId:saved.bootId,unconsumedId:saved.unconsumedId,consumedId:saved.consumedId,hostLock:saved.hostLock,starts:0}));
}
else if(phase==='post-reboot'){
 const fresh=known(),saved=JSON.parse(protectedRead(LAB+'/before-reboot.json'));assert.notEqual(boot(),saved.bootId);
 assert.throws(()=>readRootApproval(saved.unconsumedId),/TRUSTED_TIME_UNKNOWN|ATTEMPT_APPROVAL_TIME_INVALID/);
 const consumed=currentAttempt(saved.consumedId);assert.equal(consumed.checkpoint.record.phase,'ADMITTED');assert.equal(consumed.checkpoint.record.starts,0);assert.deepEqual(consumed.approval,saved.grant);
 for(const [path,digest]of Object.entries(saved.files))assert.equal(hash(readFileSync(path)),digest);
 assert.deepEqual({dev:lstatSync(ROOT+'/host.lock').dev,ino:lstatSync(ROOT+'/host.lock').ino},saved.hostLock);
 assert.equal(readLatestCheckpoint(saved.consumedId).record.sequence,0);
 console.log(JSON.stringify({kind:'REAL_REBOOT_AND_CONSUMED_CONTINUATION_PASS',oldBootId:saved.bootId,newBootId:boot(),known:fresh.formatVersion,unconsumedDenied:true,phase:'ADMITTED',starts:0,sequence:0,allGrantProfileProofBytesUnchanged:true,ttlReset:false,budgetReset:false,scope:'API-only synthetic authority; no release/artifact/DB acceptance'}));
}
else throw new Error('READER_LAB_PHASE_DENIED');
