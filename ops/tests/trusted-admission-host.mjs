/** Destructive fixture setup is restricted to this task's disposable amd64 VM. */
import assert from 'node:assert/strict';
import {hostname} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,copyFileSync,chmodSync,lstatSync,existsSync,
  unlinkSync,linkSync,symlinkSync,realpathSync,chownSync,renameSync} from 'node:fs';
import {execFileSync,spawnSync,spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {issueRootApproval,readRootApproval,initialAttempt,publishRootAdmissionConfirmation,
  readRootAdmissionConfirmation,readLatestCheckpoint,readProtectedRecord} from '../scripts/deployment-attempt.mjs';
import {admitAttempt,currentAttempt,checkpointAttempt,createAttemptBarrier,loadAttempt,
  environmentBaseline,verifyAttemptRelease,recoverAttempt} from '../scripts/deployment-controller.mjs';
import {sampleTrustedTime} from '../scripts/trusted-time.mjs';
import {approvalFixture} from './trusted-time-fixture.mjs';

assert.equal(process.getuid(),0);
assert.equal(hostname(),'lima-servora-tt-a-amd64-20261026');
assert.equal(execFileSync('/usr/bin/uname',['-m'],{encoding:'utf8'}).trim(),'x86_64');
assert.equal(process.versions.node.split('.')[0],'22');
const source=fileURLToPath(new URL('../..',import.meta.url));
const root='/var/lib/servora-med/deploy', installed='/usr/local/libexec/servora-med';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonical=(path,record)=>writeFileSync(path,JSON.stringify(record)+'\n',{mode:0o600,flag:'wx'});
const systemctl=(...args)=>execFileSync('/usr/bin/systemctl',args,{encoding:'utf8'}).trim();
const profileFile=root+'/profile.json', saved=root+'/tt-a-reboot.json';
function fields() {
  const {formatVersion,issuedAtUTC,expiresAtUTC,issuedTime,...record}=approvalFixture();
  return {...record,attemptId:randomUUID(),profileSha256:sha(readFileSync(profileFile))};
}
function grant(ttl=7200000) {return issueRootApproval(fields(),ttl).record;}
function reserve(record) {
  const context=readRootApproval(record.attemptId),initial=initialAttempt(context);
  canonical(root+'/initializations/'+record.attemptId+'.json',initial);
  return {context,initial};
}
function retireOwnedMarker(id) {
  const marker=root+'/initializations/'+id+'.json';if(existsSync(marker))unlinkSync(marker);
}
const command=process.argv[2];
if(command==='setup') {
  assert.equal(existsSync(root),false,'fixture state must never overwrite another run');
  for(const dir of ['/var/lib/servora-med','/etc/servora-med',installed,'/opt/servora-med/releases/'+ '1'.repeat(40)+'/server'])mkdirSync(dir,{recursive:true,mode:0o755});
  for(const dir of [root,...['approvals','initializations','attempts'].map(name=>root+'/'+name)])mkdirSync(dir,{mode:0o700});
  for(const name of ['deployment-attempt.mjs','deployment-controller.mjs','deployment-db-guard.mjs','migration-reconciliation.mjs','trusted-time.mjs']) {
    copyFileSync(source+'/ops/scripts/'+name,installed+'/'+name);chownSync(installed+'/'+name,0,0);chmodSync(installed+'/'+name,0o644);
  }
  copyFileSync(source+'/ops/scripts/deploy-production-host.sh',installed+'/deploy-production-host');chownSync(installed+'/deploy-production-host',0,0);chmodSync(installed+'/deploy-production-host',0o755);
  if(!existsSync('/usr/bin/node'))symlinkSync(process.execPath,'/usr/bin/node');
  if(spawnSync('/usr/bin/id',['servora-med']).status!==0)execFileSync('/usr/sbin/useradd',['--system','--no-create-home','servora-med']);
  const oldRelease='/opt/servora-med/releases/'+'1'.repeat(40);
  if(!existsSync('/opt/servora-med/current'))symlinkSync(oldRelease,'/opt/servora-med/current');
  else assert.equal(realpathSync('/opt/servora-med/current'),oldRelease);
  writeFileSync('/opt/servora-med/current/server/dist-placeholder','synthetic fixture, no application or database deployment\n');
  copyFileSync(source+'/ops/systemd/servora-med.service','/etc/systemd/system/servora-med.service');chownSync('/etc/systemd/system/servora-med.service',0,0);chmodSync('/etc/systemd/system/servora-med.service',0o644);
  const env='NODE_ENV=production\nHEALTH_SCHEMA_VERSION=001_baseline\nSERVORA_RELEASE_SHA='+'1'.repeat(40)+'\n';
  writeFileSync('/etc/servora-med/servora-med.env',env,{mode:0o640});
  systemctl('daemon-reload');
  const files={helperSha256:installed+'/deploy-production-host',nodeSha256:realpathSync('/usr/bin/node'),unitSha256:'/etc/systemd/system/servora-med.service',
    attemptModuleSha256:installed+'/deployment-attempt.mjs',dbGuardModuleSha256:installed+'/deployment-db-guard.mjs',
    reconciliationModuleSha256:installed+'/migration-reconciliation.mjs',controllerModuleSha256:installed+'/deployment-controller.mjs',
    timeModuleSha256:installed+'/trusted-time.mjs',timeConfigSha256:'/etc/chrony/chrony.conf'};
  const profile={formatVersion:2,machineId:readFileSync('/etc/machine-id','utf8').trim(),fqdn:'tt-a.synthetic.invalid',
    databaseIdentity:{clusterId:'1',databaseName:'servora_med_test_tt_a',databaseOid:'1',role:'servora_tt_a',host:'127.0.0.1',port:5432},
    envBaselineSha256:environmentBaseline(env),contracts:Object.fromEntries(Object.entries(files).map(([key,path])=>[key,sha(readFileSync(path))]))};
  canonical(profileFile,profile);
  console.log('HOST_SETUP=PASS synthetic_profile=true database_used=false');
} else if(command==='check') {
  const record=grant(),file=root+'/approvals/'+record.attemptId+'.json';
  assert.equal(lstatSync(file).uid,0);assert.equal(lstatSync(file).gid,0);assert.equal(lstatSync(file).mode&0o777,0o600);
  assert.equal(readFileSync(file,'utf8'),JSON.stringify(record)+'\n');
  assert.deepEqual(readRootApproval(record.attemptId).approval.issuedTime,record.issuedTime);
  const child=spawnSync(process.execPath,['--input-type=module','-e',`import {readRootApproval} from ${JSON.stringify(source+'/ops/scripts/deployment-attempt.mjs')};console.log(readRootApproval('${record.attemptId}').approval.issuedTime.bootLowerMs);`],{encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);assert.equal(Number(child.stdout.trim()),record.issuedTime.bootLowerMs);
  chmodSync(file,0o644);assert.throws(()=>readRootApproval(record.attemptId),/ATTEMPT_FILE_UNTRUSTED/);chmodSync(file,0o600);
  chownSync(file,65534,65534);assert.throws(()=>readRootApproval(record.attemptId),/ATTEMPT_FILE_UNTRUSTED/);chownSync(file,0,0);
  const second=file+'.link';linkSync(file,second);assert.throws(()=>readRootApproval(record.attemptId),/ATTEMPT_FILE_UNTRUSTED/);unlinkSync(second);
  const short=grant(1);assert.throws(()=>readRootApproval(short.attemptId),/ATTEMPT_APPROVAL_TIME_INVALID|TRUSTED_TIME_UNKNOWN/);
  const {context,initial}=reserve(record);
  assert.equal(readRootAdmissionConfirmation(context,initial),null);
  const proof=publishRootAdmissionConfirmation(context,initial),proofFile=root+'/admission-proofs/'+record.attemptId+'.json';
  assert.equal(lstatSync(proofFile).uid,0);assert.equal(lstatSync(proofFile).mode&0o777,0o600);
  assert.equal(proof.initialSha256,sha(JSON.stringify(initial)+'\n'));
  assert.deepEqual(publishRootAdmissionConfirmation(context,initial),proof,'repeat cannot reset confirmation');
  assert.equal(readRootApproval(record.attemptId).approvalSha256,context.approvalSha256);
  for(const mode of [0o644,0o400]) {chmodSync(proofFile,mode);assert.throws(()=>readRootApproval(record.attemptId),/ATTEMPT_FILE_UNTRUSTED/);}
  chmodSync(proofFile,0o600);chownSync(proofFile,65534,65534);assert.throws(()=>readRootApproval(record.attemptId),/ATTEMPT_FILE_UNTRUSTED/);chownSync(proofFile,0,0);
  const original=readFileSync(proofFile);writeFileSync(proofFile,'{"torn":');assert.throws(()=>readRootApproval(record.attemptId));writeFileSync(proofFile,original);
  const foreign=root+'/admission-proofs/foreign';writeFileSync(foreign,'x',{mode:0o600});assert.throws(()=>readRootApproval(record.attemptId),/FOREIGN/);unlinkSync(foreign);
  const temp=root+'/admission-proofs/.admission-'+record.attemptId+'.tmp';linkSync(proofFile,temp);
  assert.equal(readRootApproval(record.attemptId).approval.attemptId,record.attemptId);publishRootAdmissionConfirmation(context,initial);assert.equal(existsSync(temp),false);
  retireOwnedMarker(record.attemptId);
  assert.throws(()=>readRootApproval(record.attemptId),/CONFIRMATION_INVALID/,'orphan confirmation cannot become an unconsumed grant');
  const active=grant();const admitted=admitAttempt(active.attemptId);assert.equal(admitted.checkpoint.record.phase,'ADMITTED');
  assert.equal(currentAttempt(active.attemptId).checkpoint.record.starts,0);
  assert.throws(()=>admitAttempt(record.attemptId));
  const before=readFileSync(installed+'/trusted-time.mjs');writeFileSync(installed+'/trusted-time.mjs',Buffer.concat([before,Buffer.from('\n// drift\n')]));
  assert.throws(()=>loadAttempt(active.attemptId),/RECOVERY_HOST_CONTRACT_MISMATCH/);writeFileSync(installed+'/trusted-time.mjs',before);
  const envFile='/etc/servora-med/servora-med.env',env=readFileSync(envFile);writeFileSync(envFile,Buffer.concat([env,Buffer.from('UNAPPROVED=1\n')]));
  assert.throws(()=>loadAttempt(active.attemptId),/RECOVERY_ENV_BASELINE_MISMATCH/);writeFileSync(envFile,env);
  assert.throws(()=>verifyAttemptRelease(active.attemptId,'target'),/RECOVERY_RELEASE_UNPROVEN/);
  assert.equal(readLatestCheckpoint(active.attemptId).record.starts,0);
  canonical(root+'/tt-a-active.json',{attemptId:active.attemptId});
  console.log('REAL_ROOT_CHECK=PASS ownership=true canonical=true restart=true confirmation=true mismatch_denials=true synthetic_payload=true');
} else if(command==='race') {
  const isolated='/var/lib/servora-tt-a-race-'+randomUUID();mkdirSync(isolated,{mode:0o700});
  for(const dir of ['approvals','initializations','attempts'])mkdirSync(isolated+'/'+dir,{mode:0o700});
  copyFileSync(profileFile,isolated+'/profile.json');chownSync(isolated+'/profile.json',0,0);chmodSync(isolated+'/profile.json',0o600);
  const ownerBefore=sha(readFileSync(root+'/active.json'));
  const run=spawnSync('/usr/bin/unshare',['--mount','--propagation','private',process.execPath,fileURLToPath(import.meta.url),'race-child',isolated],{encoding:'utf8',timeout:60000});
  console.log(run.stdout);assert.equal(run.status,0,run.stderr);
  assert.equal(sha(readFileSync(root+'/active.json')),ownerBefore);
} else if(command==='race-child') {
  assert.match(process.argv[3],/^\/var\/lib\/servora-tt-a-race-[0-9a-f-]{36}$/);
  execFileSync('/usr/bin/mount',['--bind',process.argv[3],root]);
  const record=grant(),context=readRootApproval(record.attemptId),initial=initialAttempt(context),alias=randomUUID();
  canonical(root+'/approvals/'+alias+'.json',record);canonical(root+'/initializations/'+alias+'.json',initial);
  assert.throws(()=>readRootApproval(alias),/ATTEMPT_APPROVAL_IDENTITY_INVALID/,'marker-only early return must not bypass the path UUID');
  renameSync(root+'/initializations/'+alias+'.json',root+'/'+alias+'-alias-initial.json');
  renameSync(root+'/approvals/'+alias+'.json',root+'/'+alias+'-alias-grant.json');
  const run=()=>new Promise(resolve=>{
    const child=spawn('/usr/bin/flock',['-x',root+'/host.lock',process.execPath,fileURLToPath(import.meta.url),'race-admit',record.attemptId],{stdio:['ignore','pipe','pipe']});
    let out='',err='';child.stdout.on('data',data=>out+=data);child.stderr.on('data',data=>err+=data);child.on('close',status=>resolve({status,out,err}));
  });
  const results=await Promise.all([run(),run()]);
  assert.ok(results.every(r=>r.status===0),JSON.stringify(results));
  assert.equal(results.filter(r=>r.out.includes('resumed=false')).length,1);
  assert.equal(results.filter(r=>r.out.includes('resumed=true')).length,1);
  assert.equal(readLatestCheckpoint(record.attemptId).record.sequence,0);
  console.log('ROOT_RACE=PASS exact_admission_count=1 same_attempt_resume_count=1 alias_UUID=DENY physical_owner_unchanged=true');
} else if(command==='race-admit') {
  console.log('resumed='+admitAttempt(process.argv[3]).resumed);
} else if(command==='fault-worker') {
  const id=process.argv[3],record=readRootApproval(id).approval;
  const {context,initial}=reserve(record);publishRootAdmissionConfirmation(context,initial);
} else if(command==='faults') {
  const ownerBefore=readFileSync(root+'/active.json'),archive=root+'/tt-a-fault-evidence';
  mkdirSync(archive,{mode:0o700});
  for(const fault of ['marker-stop','proof-file-error','proof-directory-error']) {
    const record=grant(),id=record.attemptId;
    const args=['--import',source+'/ops/tests/trusted-admission-fault-preload.mjs',fileURLToPath(import.meta.url),'fault-worker',id];
    let result;
    if(fault==='marker-stop') {
      const child=spawn(process.execPath,args,{env:{...process.env,TT_A_PUBLICATION_FAULT:fault},stdio:['ignore','pipe','pipe']});
      let output='',errors='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>errors+=data);
      const closed=new Promise(resolve=>child.once('close',resolve));
      try {
        for(let i=0;i<200&&!output.includes('FAULT_READY');i++)await delay(50);
        assert.match(output,/FAULT_READY/,errors);child.kill('SIGKILL');await closed;
      } finally {if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
      result={status:null,signal:'SIGKILL',stdout:output,stderr:errors};
    } else result=spawnSync(process.execPath,args,{env:{...process.env,TT_A_PUBLICATION_FAULT:fault},encoding:'utf8',timeout:30000});
    canonical(archive+'/'+id+'-result.json',{fault,status:result.status,signal:result.signal,stdout:result.stdout,stderr:result.stderr});
    if(fault!=='marker-stop') {assert.notEqual(result.status,0);assert.match(result.stderr,/INJECTED_FSYNC_EIO/);}
    const initial=readProtectedRecord(root+'/initializations/'+id+'.json').record;
    const context={approval:record,approvalSha256:sha(JSON.stringify(record)+'\n')};
    if(fault==='proof-file-error') {
      assert.throws(()=>readRootAdmissionConfirmation(context,initial),/INCOMPLETE/);
      // Explicit owned lab teardown, preserving the incomplete bytes. No runtime repair.
      renameSync(root+'/admission-proofs/.admission-'+id+'.tmp',archive+'/'+id+'-unpublished.tmp');
    } else {
      const before=readRootAdmissionConfirmation(context,initial);
      const completed=publishRootAdmissionConfirmation(context,initial);
      if(before)assert.deepEqual(completed,before,'directory retry must not renew authority');
      assert.equal(readRootAdmissionConfirmation(context,initial).initialSha256,sha(JSON.stringify(initial)+'\n'));
    }
    assert.deepEqual(readFileSync(root+'/active.json'),ownerBefore,'publication faults cannot change active owner');
    renameSync(root+'/initializations/'+id+'.json',archive+'/'+id+'-initial.json');
    console.log('PUBLICATION_FAULT=PASS kind='+fault+' owner_unchanged=true no_business_effects=true');
  }
} else if(command==='prepare-reboot') {
  const active=JSON.parse(readFileSync(root+'/tt-a-active.json')),unconsumed=grant();
  checkpointAttempt(active.attemptId,{kind:'PREDEPLOY_BACKUP',receipt:{sha256:'6'.repeat(64),completedAtUTC:sampleTrustedTime().wallAtUTC}});
  createAttemptBarrier(active.attemptId);checkpointAttempt(active.attemptId,'FENCED');
  checkpointAttempt(active.attemptId,{kind:'MIGRATION_INTENT',baseline:{organizations:0,admins:0,staff:0,customers:0,products:0,jobs:0,demoData:0}});
  checkpointAttempt(active.attemptId,'DB_EXACT');checkpointAttempt(active.attemptId,'ENV_INTENT');checkpointAttempt(active.attemptId,'ENV_ALIGNED');
  checkpointAttempt(active.attemptId,'POINTER_INTENT');checkpointAttempt(active.attemptId,'POINTER_ALIGNED');checkpointAttempt(active.attemptId,'START_INTENT');
  mkdirSync('/etc/systemd/system/servora-med.service.d',{recursive:true});writeFileSync('/etc/systemd/system/servora-med.service.d/90-servora-recovery.conf','[Service]\nRestart=no\n',{mode:0o600});
  mkdirSync('/run/servora-med-recovery',{recursive:true,mode:0o700});canonical('/run/servora-med-recovery/start.permit',{attemptId:active.attemptId});
  systemctl('daemon-reload');systemctl('enable','servora-med.service');
  canonical(saved,{active:active.attemptId,unconsumed:unconsumed.attemptId,bootId:sampleTrustedTime().bootId,
    proofSha256:sha(readFileSync(root+'/admission-proofs/'+active.attemptId+'.json')),sequence:readLatestCheckpoint(active.attemptId).record.sequence});
  console.log('REBOOT_READY=PASS starts=1 migrations_executed=0 synthetic_phase_fixture=true');
} else if(command==='verify-reboot') {
  const state=JSON.parse(readFileSync(saved));assert.notEqual(readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),state.bootId);
  assert.throws(()=>readRootApproval(state.unconsumed),/TRUSTED_TIME_UNKNOWN/);
  assert.equal(readRootApproval(state.active).approval.attemptId,state.active);
  assert.equal(sha(readFileSync(root+'/admission-proofs/'+state.active+'.json')),state.proofSha256);
  assert.equal(existsSync('/run/servora-med-recovery/start.permit'),false);
  assert.equal(systemctl('show','servora-med.service','-p','MainPID','--value'),'0');
  const context=currentAttempt(state.active);assert.equal(context.checkpoint.record.starts,1);assert.equal(context.checkpoint.record.sequence,state.sequence);
  assert.throws(()=>checkpointAttempt(state.active,'START_INTENT'),/ATTEMPT_START_AMBIGUOUS/);
  await assert.rejects(()=>recoverAttempt(state.active));
  assert.equal(readLatestCheckpoint(state.active).record.starts,1);
  assert.equal(readProtectedRecord(root+'/active.json').record.attemptId,state.active);
  assert.equal(existsSync(root+'/activation.block'),true);
  console.log('REAL_REBOOT=PASS unconsumed=DENY consumed=BOUND_ONLY volatile_permit=ABSENT owner_barrier=PRESERVED ambiguous_start=DENY');
} else throw new Error('DISPOSABLE_HOST_COMMAND_INVALID');
