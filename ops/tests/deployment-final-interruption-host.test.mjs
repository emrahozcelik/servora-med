import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,writeFileSync,readlinkSync,unlinkSync,symlinkSync,mkdirSync,linkSync,statSync,openSync,fsyncSync,closeSync,readdirSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {hostname} from 'node:os';
import {withRuntimeFixture,prepareRealBackup,readDatabaseInvariants} from './r4-runtime-fixture.mjs';
import {admitAttempt,checkpointAttempt,createAttemptBarrier,alignIdentityEnvironment,revokeStartPermit,runTargetSchemaCheck,sealBackupReceipt,loadAttempt,recordFreshMigrationIntent,abortAttempt} from '../scripts/deployment-controller.mjs';
import {readLatestCheckpoint} from '../scripts/deployment-attempt.mjs';

assert.equal(process.getuid(),0);
assert.equal(hostname(),'lima-servora-r4-20261012');
const state='/var/lib/servora-med/deploy';
const controller='/usr/local/libexec/servora-med/deployment-controller.mjs';
const preload=fileURLToPath(new URL('./r4-interruption-preload.mjs',import.meta.url));
const run=(command,args)=>spawnSync(command,args,{encoding:'utf8',timeout:30000});
function snapshot(id,label) {
  const directory='/var/lib/servora-med/r4-final-test-snapshots';mkdirSync(directory,{recursive:true,mode:0o700});
  const read=path=>existsSync(path)?JSON.parse(readFileSync(path)):null;
  const journalDirectory=state+'/attempts/'+id;
  const journal=existsSync(journalDirectory)?readdirSync(journalDirectory).sort().map(name=>({name,sha256:createHash('sha256').update(readFileSync(journalDirectory+'/'+name)).digest('hex'),record:read(journalDirectory+'/'+name)})):[];
  const data=JSON.stringify({label,attemptId:id,owner:read(state+'/active.json'),initialization:read(state+'/initializations/'+id+'.json'),journal})+'\n';
  writeFileSync(directory+'/'+id+'-'+label+'.json',data,{mode:0o600,flag:'wx'});
  console.log('JOURNAL_OWNER_SNAPSHOT='+label+' sha256='+createHash('sha256').update(data).digest('hex'));
}

function prepareReboot(id,saved,kind) {
  if(process.env.SERVORA_R4_PREPARE_REBOOT!==kind)return;
  const file='/var/lib/servora-med/r4-final-reboot-current.json';
  const record={attemptId:id,kind,bootId:readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),
    saved:Object.fromEntries(Object.entries(saved).map(([key,value])=>[key,Buffer.isBuffer(value)?value.toString():value])),
    dumps:readdirSync('/var/backups/servora-med').length};
  writeFileSync(file,JSON.stringify(record)+'\n',{mode:0o600,flag:'wx'});
  console.log('REAL_REBOOT_PREPARED='+kind+' attempt='+id);
  process.exit(0); // Explicit owned fixture survives without teardown.
}

async function withOldHost(operation, isolatedDatabase = false) {
  const env='/etc/servora-med/servora-med.env',backup='/etc/servora-med/servora-med-backup.env';
  const barrier=state+'/activation.block',policy='/etc/systemd/system/servora-med.service.d/90-servora-recovery.conf';
  const saved={env:readFileSync(env),backup:readFileSync(backup,'utf8'),barrier:readFileSync(barrier),policy:readFileSync(policy),pointer:readlinkSync('/opt/servora-med/current'),profile:existsSync(state+'/profile.json')?readFileSync(state+'/profile.json','utf8'):null};
  let text=readFileSync('/etc/servora-med/r4-abort-fixture.env','utf8');
  if(isolatedDatabase){
    const template=new URL(text.split('\n').find(l=>l.startsWith('DATABASE_URL=')).slice(13)).pathname.slice(1);
    const clone='servora_med_test_r4_fresh_'+randomUUID().replaceAll('-','');
    assert.equal(run('/usr/bin/sudo',['-u','postgres','/usr/bin/createdb','--template',template,clone]).status,0);
    assert.equal(run('/usr/bin/sudo',['-u','postgres','/usr/bin/psql','-X','-v','ON_ERROR_STOP=1','-d',clone,'-c',
      'ALTER SCHEMA public OWNER TO servora_r4_app; ALTER TABLE job_card_meeting_details OWNER TO servora_r4_app']).status,0);
    // Preserve the disposable database as evidence; never drop the template.
    text=text.replace('/'+template,'/'+clone);
  }
  const db=new URL(text.split('\n').find(l=>l.startsWith('DATABASE_URL=')).slice(13)).pathname.slice(1);
  assert.match(db,/^servora_med_test_r4_/);
  writeFileSync(env,text);writeFileSync(backup,saved.backup.replace(/^PGDATABASE=.*$/m,'PGDATABASE='+db));
  unlinkSync(barrier);unlinkSync(policy);unlinkSync('/opt/servora-med/current');symlinkSync('/opt/servora-med/releases/71ae6df6dd0659ed6390a6785d4bab29ddf5b1fa','/opt/servora-med/current');
  try {
    assert.equal(run('/usr/bin/systemctl',['daemon-reload']).status,0);
    assert.equal(run('/usr/bin/systemctl',['start','servora-med.service']).status,0);
    let healthy=false;
    for(let i=0;i<20;i++){if(run('/usr/bin/curl',['--fail','--silent','https://r4.synthetic.invalid/api/health']).status===0){healthy=true;break;}await delay(500);}
    assert.ok(healthy,'actual OLD055 service must be healthy');
    await withRuntimeFixture(grant=>operation(grant,saved));
  } finally {
    run('/usr/bin/systemctl',['stop','servora-med.service']);writeFileSync(env,saved.env);writeFileSync(backup,saved.backup);
    unlinkSync('/opt/servora-med/current');symlinkSync(saved.pointer,'/opt/servora-med/current');
    writeFileSync(barrier,saved.barrier,{mode:0o600});writeFileSync(policy,saved.policy,{mode:0o600});run('/usr/bin/systemctl',['daemon-reload']);
  }
}

test('same approved admission survives SIGKILL after active claim fsync without restarting or resetting ownership',async()=>withOldHost(async (grant,saved)=>{
  const pid=run('/usr/bin/systemctl',['show','servora-med.service','-p','MainPID','--value']).stdout.trim();
  const child=spawn('/usr/bin/node',['--import',preload,controller,'admit',grant.attemptId],{env:{...process.env,SERVORA_R4_FAULT_POINT:'claim-fsync'},stdio:['ignore','pipe','pipe']});
  let output='',errors='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>errors+=c);
  const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
  try {
    for(let i=0;i<100&&!output.includes('FAULT_READY=claim-fsync');i++)await delay(100);
    assert.ok(output.includes('FAULT_READY=claim-fsync'),errors);
    const claim=readFileSync(state+'/active.json');
    snapshot(grant.attemptId,'claim-fsync-before-retry');
    assert.equal(existsSync(state+'/attempts/'+grant.attemptId+'/0000.json'),false);
    child.kill('SIGKILL');assert.equal((await closed).signal,'SIGKILL');
    prepareReboot(grant.attemptId,saved,'admission');
    console.log('REAL_ADMISSION_SIGKILL=claim-fsync checkpoint=absent');
    const foreign=run('/usr/bin/node',[controller,'admit','99999999-9999-4999-8999-999999999999']);assert.notEqual(foreign.status,0);assert.deepEqual(readFileSync(state+'/active.json'),claim);
    const retry=run('/usr/bin/node',[controller,'admit',grant.attemptId]);
    assert.equal(retry.status,0,'same-owner initialization must be recoverable: '+retry.stderr);
    const record=JSON.parse(readFileSync(state+'/attempts/'+grant.attemptId+'/0000.json'));
    assert.equal(record.phase,'ADMITTED');assert.equal(record.starts,0);assert.equal(record.abortStarts,0);assert.equal(record.predeployBackup,null);assert.equal(record.migrationCommitted,false);
    assert.deepEqual(readFileSync(state+'/active.json'),claim);
    assert.equal(run('/usr/bin/systemctl',['show','servora-med.service','-p','MainPID','--value']).stdout.trim(),pid);
    snapshot(grant.attemptId,'claim-fsync-after-retry');
    console.log('TORN_ADMISSION_SAME_OWNER=PASS pid_unchanged=PASS start_slots=0');
  } finally {if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
}));

test('fresh post-stop SQL baseline includes a legitimate customer committed after the live probe',async()=>withOldHost(async grant=>{
  admitAttempt(grant.attemptId);prepareRealBackup(grant);
  const db=JSON.parse(readFileSync(state+'/profile.json')).databaseIdentity.databaseName;
  const before=readDatabaseInvariants();
  const shell=`source /usr/local/libexec/servora-med/deploy-production-host
SHA=${grant.releaseSha}
ATTEMPT_ID=${grant.attemptId}
FQDN=r4.synthetic.invalid
OLD_RELEASE=/opt/servora-med/releases/${grant.oldReleaseSha}
systemctl() {
 if [[ "$1" == stop && "$2" == servora-med.service ]]; then
   printf 'FAULT_READY=before-service-stop\\n'
   kill -STOP "$BASHPID"
 fi
 /usr/bin/systemctl "$@"
}
acquire_host_lock
r4_deploy_attempt /opt/servora-med/releases/${grant.releaseSha}
`;
  const child=spawn('/bin/bash',['-c',shell],{stdio:['ignore','pipe','pipe']});
  let output='',errors='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>errors+=c);
  const closed=new Promise(resolve=>child.once('close',code=>resolve(code)));
  try {
    for(let i=0;i<200&&!output.includes('FAULT_READY=before-service-stop');i++)await delay(100);
    assert.ok(output.includes('FAULT_READY=before-service-stop'),errors);
    assert.notEqual(run('/usr/bin/systemctl',['show','servora-med.service','-p','MainPID','--value']).stdout.trim(),'0');
    const sql="WITH o AS (INSERT INTO organizations(name) VALUES ('R4 synthetic live-write') RETURNING id) INSERT INTO customers(organization_id,name,customer_type) SELECT id,'R4 customer committed before stop','clinic' FROM o";
    const insert=run('/usr/bin/sudo',['-u','postgres','/usr/bin/psql','-X','-v','ON_ERROR_STOP=1','-d',db,'-c',sql]);assert.equal(insert.status,0,insert.stderr);
    child.kill('SIGCONT');const exit=await closed;
    assert.equal(exit,0,'additive migration must accept legitimate pre-stop write: '+errors+' '+output);
    const journal=readLatestCheckpoint(grant.attemptId).record;
    assert.equal(journal.invariantBaseline.organizations,before.organizations+1);
    assert.equal(journal.invariantBaseline.customers,before.customers+1);
    assert.equal(readDatabaseInvariants().customers,before.customers+1);
    assert.equal(journal.phase,'HEALTH_PASSED');assert.equal(journal.schemaChecked,true);
    snapshot(grant.attemptId,'fresh-live-write-after-migration');
    console.log('LIVE_WRITE_FRESH_SQL_BASELINE=PASS migration=055_to_056 rows_preserved=PASS');
  } finally {if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
},true));

test('an external idle database session prevents durable migration intent without changing business data',async()=>withOldHost(async grant=>{
  admitAttempt(grant.attemptId);prepareRealBackup(grant);
  createAttemptBarrier(grant.attemptId);
  writeFileSync('/etc/systemd/system/servora-med.service.d/90-servora-recovery.conf','[Service]\nRestart=no\n',{mode:0o600});
  assert.equal(run('/usr/bin/systemctl',['daemon-reload']).status,0);assert.equal(run('/usr/bin/systemctl',['stop','servora-med.service']).status,0);
  checkpointAttempt(grant.attemptId,'FENCED');const baseline=readDatabaseInvariants();
  const db=JSON.parse(readFileSync(state+'/profile.json')).databaseIdentity.databaseName;
  // A foreign role remains visible to the restricted guard even if its
  // detailed activity fields are redacted. It need not be actively writing.
  const writer=spawn('/usr/bin/sudo',['-u','postgres','/usr/bin/psql','-XAt','-d',db],{stdio:['pipe','pipe','pipe']});
  let output='';writer.stdout.on('data',c=>output+=c);writer.stdin.write("SELECT 'EXTERNAL_SESSION_READY';\n");
  try {
    for(let i=0;i<100&&!output.includes('EXTERNAL_SESSION_READY');i++)await delay(50);
    assert.ok(output.includes('EXTERNAL_SESSION_READY'));
    await assert.rejects(recordFreshMigrationIntent(grant.attemptId,baseline),/RECOVERY_DATABASE_WRITERS_NOT_QUIESCENT/);
    assert.equal(readLatestCheckpoint(grant.attemptId).record.phase,'FENCED');assert.deepEqual(readDatabaseInvariants(),baseline);
    console.log('FOREIGN_IDLE_WRITER=DENIED migration_intent=ABSENT rows_unchanged=PASS');
  } finally {writer.stdin.end('\\q\n');await new Promise(resolve=>writer.once('close',resolve));}
}));

test('SIGKILL after service stop and before migration intent permits only an OLD EXACT controlled abort',async()=>withOldHost(async grant=>{
  admitAttempt(grant.attemptId);prepareRealBackup(grant);const baseline=readDatabaseInvariants();
  const shell=`source /usr/local/libexec/servora-med/deploy-production-host
SHA=${grant.releaseSha}
ATTEMPT_ID=${grant.attemptId}
FQDN=r4.synthetic.invalid
OLD_RELEASE=/opt/servora-med/releases/${grant.oldReleaseSha}
systemctl() {
 /usr/bin/systemctl "$@"
 if [[ "$1" == stop && "$2" == servora-med.service ]]; then printf 'FAULT_READY=after-service-stop\\n';kill -STOP "$BASHPID";fi
}
acquire_host_lock
r4_deploy_attempt /opt/servora-med/releases/${grant.releaseSha}
`;
  const child=spawn('/bin/bash',['-c',shell],{stdio:['ignore','pipe','pipe']});let output='',errors='';
  child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>errors+=c);const closed=new Promise(resolve=>child.once('close',resolve));
  try {
    for(let i=0;i<100&&!output.includes('FAULT_READY=after-service-stop');i++)await delay(100);assert.ok(output.includes('FAULT_READY=after-service-stop'),errors);
    assert.equal(run('/usr/bin/systemctl',['show','servora-med.service','-p','MainPID','--value']).stdout.trim(),'0');
    child.kill('SIGKILL');await closed;snapshot(grant.attemptId,'stopped-before-intent');
    assert.equal(readLatestCheckpoint(grant.attemptId).record.phase,'BACKED_UP');
    const aborted=run('/usr/local/libexec/servora-med/deploy-production-host',['--phase','pre-migration-abort','--attempt-id',grant.attemptId]);assert.equal(aborted.status,0,aborted.stderr);
    const after=readLatestCheckpoint(grant.attemptId).record;assert.equal(after.phase,'COMPLETED_ABORT');assert.equal(after.migrationCommitted,false);assert.equal(after.starts,0);assert.equal(after.abortStarts,1);
    assert.deepEqual(readDatabaseInvariants(),baseline);console.log('POST_STOP_PRE_INTENT_ABORT=PASS OLD_EXACT=PASS rows_unchanged=PASS');
  } finally {if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
}));

test('ABORTED handoff survives SIGTERM after barrier fsync without repeating the OLD start or backup',async()=>withOldHost(async (grant,saved)=>{
  admitAttempt(grant.attemptId);prepareRealBackup(grant);createAttemptBarrier(grant.attemptId);
  writeFileSync('/etc/systemd/system/servora-med.service.d/90-servora-recovery.conf','[Service]\nRestart=no\n',{mode:0o600});
  assert.equal(run('/usr/bin/systemctl',['daemon-reload']).status,0);assert.equal(run('/usr/bin/systemctl',['stop','servora-med.service']).status,0);
  checkpointAttempt(grant.attemptId,'FENCED');
  const fault=process.env.SERVORA_R4_HANDOFF_FAULT??'handoff-fsync';
  assert.ok(['handoff-fsync','completed-fsync','owner-retirement-fsync'].includes(fault));
  const child=spawn('/usr/bin/node',['--import',preload,controller,'abort',grant.attemptId],{env:{...process.env,SERVORA_R4_FAULT_POINT:fault},stdio:['ignore','pipe','pipe']});
  let output='',errors='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>errors+=c);
  const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
  try {
    for(let i=0;i<200&&!output.includes('FAULT_READY='+fault);i++)await delay(50);
    assert.ok(output.includes('FAULT_READY='+fault),errors);
    child.kill('SIGTERM');child.kill('SIGCONT');assert.equal((await closed).signal,'SIGTERM');
    assert.equal(readLatestCheckpoint(grant.attemptId).record.phase,fault==='handoff-fsync'?'ABORTED':'COMPLETED_ABORT');assert.equal(existsSync(state+'/activation.block'),false);
    snapshot(grant.attemptId,'aborted-handoff-before-retry');
    prepareReboot(grant.attemptId,saved,'abort');
    const pid=run('/usr/bin/systemctl',['show','servora-med.service','-p','MainPID','--value']).stdout.trim(),dumps=readdirSync('/var/backups/servora-med').length;
    const retry=run('/usr/local/libexec/servora-med/deploy-production-host',['--phase','pre-migration-abort','--attempt-id',grant.attemptId]);assert.equal(retry.status,0,retry.stderr);
    const final=readLatestCheckpoint(grant.attemptId).record;assert.equal(final.phase,'COMPLETED_ABORT');assert.equal(final.abortStarts,1);assert.equal(final.starts,0);
    assert.equal(run('/usr/bin/systemctl',['show','servora-med.service','-p','MainPID','--value']).stdout.trim(),pid);assert.equal(readdirSync('/var/backups/servora-med').length,dumps);
    assert.equal(existsSync(state+'/active.json'),false);snapshot(grant.attemptId,'aborted-handoff-after-retry');
    console.log('ABORTED_HANDOFF_SIGTERM=PASS pid_unchanged=PASS abort_slots=1 backups_unchanged=PASS');
  } finally {if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
}));

test('ACCEPTED handoff interrupted after barrier fsync finishes without another start, backup or observation',async()=>{
  const env='/etc/servora-med/servora-med.env',backup='/etc/servora-med/servora-med-backup.env',barrier=state+'/activation.block',pointer='/opt/servora-med/current',policy='/etc/systemd/system/servora-med.service.d/90-servora-recovery.conf';
  const saved={env:readFileSync(env,'utf8'),backup:readFileSync(backup,'utf8'),barrier:readFileSync(barrier),pointer:readlinkSync(pointer),policy:readFileSync(policy),profile:existsSync(state+'/profile.json')?readFileSync(state+'/profile.json','utf8'):null};
  let text=saved.env.replace(/^BACKUP_PROVIDER=.*$/m,'BACKUP_PROVIDER=host-observation');
  if(!text.includes('BACKUP_PROVIDER='))text+='BACKUP_PROVIDER=host-observation\n';
  if(!text.includes('BACKUP_OBSERVATION_PATH='))text+='BACKUP_OBSERVATION_PATH=/var/lib/servora-med-backup/observation-v1.json\n';
  const db=new URL(text.split('\n').find(l=>l.startsWith('DATABASE_URL=')).slice(13)).pathname.slice(1);assert.match(db,/^servora_med_test_r4_/);
  writeFileSync(env,text);writeFileSync(backup,saved.backup.replace(/^PGDATABASE=.*$/m,'PGDATABASE='+db));
  let child;
  try {
    await withRuntimeFixture(async grant=>{
      admitAttempt(grant.attemptId);prepareRealBackup(grant);unlinkSync(barrier);createAttemptBarrier(grant.attemptId);
      checkpointAttempt(grant.attemptId,'FENCED');checkpointAttempt(grant.attemptId,{kind:'MIGRATION_INTENT',baseline:readDatabaseInvariants()});
      writeFileSync(env,alignIdentityEnvironment(text,grant.oldCatalog.at(-1).version,grant.oldReleaseSha));unlinkSync(pointer);symlinkSync('/opt/servora-med/releases/'+grant.oldReleaseSha,pointer);
      const recovery=run('/usr/local/libexec/servora-med/deploy-production-host',['--phase','forward-recovery','--attempt-id',grant.attemptId]);assert.equal(recovery.status,0,recovery.stderr);
      assert.equal(run('/usr/bin/systemctl',['start','servora-med-backup.service']).status,0);
      runTargetSchemaCheck(loadAttempt(grant.attemptId));checkpointAttempt(grant.attemptId,'SCHEMA_CHECKED');checkpointAttempt(grant.attemptId,'SMOKE_PASSED');checkpointAttempt(grant.attemptId,'POSTDEPLOY_BACKUP_INTENT');
      const names=new Set(readdirSync('/var/backups/servora-med'));
      // The existing backup contract names dumps to the UTC second. Do not
      // collide with the separately triggered scheduled heartbeat fixture.
      const second=Math.floor(Date.now()/1000);
      while(Math.floor(Date.now()/1000)===second)await delay(25);
      assert.equal(run('/usr/bin/systemctl',['start','servora-med-postdeploy-backup.service']).status,0);
      const fresh=readdirSync('/var/backups/servora-med').filter(n=>!names.has(n)&&n.endsWith('.dump'));assert.equal(fresh.length,1);sealBackupReceipt(grant.attemptId,'post','/var/backups/servora-med/'+fresh[0]);
      // Focused handoff fixture only: the full H8 acceptance independently
      // measures all 1800 real seconds on the final exact source.
      checkpointAttempt(grant.attemptId,{kind:'OBSERVATION_PASSED',elapsedSeconds:1800});
      const pid=run('/usr/bin/systemctl',['show','servora-med.service','-p','MainPID','--value']).stdout.trim();
      const fault=process.env.SERVORA_R4_HANDOFF_FAULT??'handoff-fsync';
      assert.ok(['handoff-fsync','completed-fsync','owner-retirement-fsync'].includes(fault));
      child=spawn('/usr/bin/node',['--import',preload,controller,'observe',grant.attemptId],{env:{...process.env,SERVORA_R4_FAULT_POINT:fault},stdio:['ignore','pipe','pipe']});
      let output='',errors='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>errors+=c);const closed=new Promise(resolve=>child.once('close',resolve));
      for(let i=0;i<100&&!output.includes('FAULT_READY='+fault);i++)await delay(100);assert.ok(output.includes('FAULT_READY='+fault),errors);
      child.kill('SIGKILL');await closed;assert.equal(readLatestCheckpoint(grant.attemptId).record.phase,fault==='handoff-fsync'?'ACCEPTED':'COMPLETED');assert.equal(existsSync(barrier),false);
      snapshot(grant.attemptId,'accepted-handoff-before-retry');
      prepareReboot(grant.attemptId,saved,'accepted');
      const starts=readLatestCheckpoint(grant.attemptId).record.starts,dumps=readdirSync('/var/backups/servora-med').filter(n=>n.endsWith('.dump')).length;
      const preflight=run('/usr/local/libexec/servora-med/deploy-production-host',['--phase','attempt-preflight','--attempt-id',grant.attemptId]);
      assert.equal(preflight.status,0,'accepted handoff must resume: '+preflight.stderr);
      const confirm=run('/usr/local/libexec/servora-med/deploy-production-host',['--phase','forward-recovery','--attempt-id',grant.attemptId]);assert.equal(confirm.status,0,confirm.stderr);
      assert.equal(readLatestCheckpoint(grant.attemptId).record.phase,'COMPLETED');assert.equal(readLatestCheckpoint(grant.attemptId).record.starts,starts);assert.equal(existsSync(state+'/active.json'),false);
      assert.equal(run('/usr/bin/systemctl',['show','servora-med.service','-p','MainPID','--value']).stdout.trim(),pid);assert.equal(readdirSync('/var/backups/servora-med').filter(n=>n.endsWith('.dump')).length,dumps);
      assert.equal(run('/usr/bin/systemctl',['show','servora-med.service','-p','Restart','--value']).stdout.trim(),'on-failure');snapshot(grant.attemptId,'accepted-handoff-after-retry');
      console.log('ACCEPTED_HANDOFF_SIGKILL=PASS fault='+fault+' pid_unchanged=PASS starts_unchanged=PASS backups_unchanged=PASS');
    });
  } finally {
    if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');run('/usr/bin/systemctl',['stop','servora-med.service']);
    writeFileSync(env,saved.env);writeFileSync(backup,saved.backup);unlinkSync(pointer);symlinkSync(saved.pointer,pointer);writeFileSync(barrier,saved.barrier,{mode:0o600});writeFileSync(policy,saved.policy,{mode:0o600});run('/usr/bin/systemctl',['daemon-reload']);
  }
});

test('initialization marker supports checkpoint-first publication without promoting a foreign approved owner',async()=>withOldHost(async grant=>{
  const child=spawn('/usr/bin/node',['--import',preload,controller,'admit',grant.attemptId],{env:{...process.env,SERVORA_R4_FAULT_POINT:'initialization-fsync'},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',c=>output+=c);const closed=new Promise(resolve=>child.once('close',resolve));
  const other=randomUUID(),otherFile=state+'/approvals/'+other+'.json';
  try {
    for(let i=0;i<100&&!output.includes('FAULT_READY=initialization-fsync');i++)await delay(100);
    assert.ok(output.includes('FAULT_READY=initialization-fsync'));child.kill('SIGKILL');await closed;
    assert.equal(existsSync(state+'/active.json'),false);
    const maintenance=run('/bin/bash',['-c',
      'source /usr/local/libexec/servora-med/host-operation-lock.sh; fail(){ echo "$1" >&2; exit 1; }; servora_assert_no_pending_attempt']);
    const legacyDecisions=['postdeploy','rollback'].map(phase=>run('/usr/local/libexec/servora-med/deploy-production-host',
      ['--phase',phase,'--sha',grant.oldReleaseSha,'--fqdn','r4.synthetic.invalid']));
    const marker=state+'/initializations/'+grant.attemptId+'.json',directory=state+'/attempts/'+grant.attemptId;
    mkdirSync(directory,{mode:0o700});linkSync(marker,directory+'/0000.json');const fd=openSync(directory,'r');fsyncSync(fd);closeSync(fd);
    snapshot(grant.attemptId,'checkpoint-first-before-retry');
    writeFileSync(otherFile,JSON.stringify({...grant,attemptId:other})+'\n',{mode:0o600,flag:'wx'});
    const denied=run('/usr/bin/node',[controller,'admit',other]);assert.notEqual(denied.status,0);assert.match(denied.stderr,/RECOVERY_OTHER_ATTEMPT_ACTIVE/);
    assert.equal(existsSync(state+'/active.json'),false);
    const retry=run('/usr/bin/node',[controller,'admit',grant.attemptId]);assert.equal(retry.status,0,retry.stderr);
    assert.equal(existsSync(marker),false);assert.equal(statSync(directory+'/0000.json').nlink,1);
    assert.equal(JSON.parse(readFileSync(state+'/active.json')).attemptId,grant.attemptId);
    assert.equal(JSON.parse(readFileSync(directory+'/0000.json')).starts,0);
    snapshot(grant.attemptId,'checkpoint-first-after-retry');
    assert.notEqual(maintenance.status,0,'marker-only reservation must block unrelated maintenance');
    assert.match(maintenance.stderr,/RECOVERY_ATTEMPT_PENDING/);
    for(const decision of legacyDecisions){assert.notEqual(decision.status,0);assert.match(decision.stderr,/RECOVERY_ATTEMPT_PENDING/);}
    console.log('CHECKPOINT_FIRST_PUBLICATION=PASS foreign_approved_owner=DENIED maintenance=DENIED');
  } finally {if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');if(existsSync(otherFile))unlinkSync(otherFile);}
}));

test('an interrupted restart-policy install resumes only for the verified same attempt',async()=>withOldHost(async grant=>{
  admitAttempt(grant.attemptId);prepareRealBackup(grant);createAttemptBarrier(grant.attemptId);
  const policy='/etc/systemd/system/servora-med.service.d/90-servora-recovery.conf';
  const show=key=>run('/usr/bin/systemctl',['show','servora-med.service','-p',key,'--value']).stdout.trim();
  writeFileSync(policy,'[Service]\nRestart=no\n',{mode:0o600});
  // Exact observable state after the drop-in rename but before daemon-reload.
  assert.equal(show('NeedDaemonReload'),'yes');assert.equal(show('DropInPaths'),'');assert.equal(show('Restart'),'on-failure');
  snapshot(grant.attemptId,'pending-policy-install');
  // Unknown content drift in the same window is never reloaded.
  writeFileSync(policy,'[Service]\nRestart=always\n',{mode:0o600});
  await assert.rejects(abortAttempt(grant.attemptId),/RECOVERY_SERVICE_CONTRACT_MISMATCH/);
  assert.equal(readLatestCheckpoint(grant.attemptId).record.phase,'BACKED_UP');
  writeFileSync(policy,'[Service]\nRestart=no\n',{mode:0o600});
  // A foreign barrier owner is never reloaded either.
  const barrierFile=state+'/activation.block',barrier=readFileSync(barrierFile);
  writeFileSync(barrierFile,JSON.stringify({attemptId:randomUUID(),approvalSha256:'4'.repeat(64)})+'\n',{mode:0o600});
  await assert.rejects(abortAttempt(grant.attemptId),/RECOVERY_BARRIER_UNTRUSTED/);
  writeFileSync(barrierFile,barrier,{mode:0o600});
  // The verified same-attempt pending install resumes to a completed abort.
  const result=await abortAttempt(grant.attemptId);
  assert.equal(result,'PRE_MIGRATION_ABORT=COMPLETE_OLD_EXACT');
  const final=readLatestCheckpoint(grant.attemptId).record;
  assert.equal(final.phase,'COMPLETED_ABORT');assert.equal(final.abortStarts,1);
  assert.equal(existsSync(policy),false);assert.equal(existsSync(barrierFile),false);assert.equal(existsSync(state+'/active.json'),false);
  assert.equal(show('Restart'),'on-failure');assert.equal(show('NeedDaemonReload'),'no');
  snapshot(grant.attemptId,'pending-policy-install-resumed');
  console.log('PENDING_POLICY_INSTALL_RESUME=PASS foreign_drift=DENIED foreign_barrier=DENIED');
}));

async function takePredeployDump(grant){
  // The predeploy unit stamps dumps to the UTC second; never collide with a
  // dump made moments earlier by another fixture or test.
  const second=Math.floor(Date.now()/1000);
  while(Math.floor(Date.now()/1000)===second)await delay(25);
  const backupEnv='/etc/servora-med/servora-med-backup.env';
  const before=readFileSync(backupEnv,'utf8');
  const profile=JSON.parse(readFileSync(state+'/profile.json','utf8'));
  const names=new Set(readdirSync('/var/backups/servora-med'));
  writeFileSync(backupEnv,before.replace(/^PGDATABASE=.*$/m,'PGDATABASE='+profile.databaseIdentity.databaseName));
  try {
    assert.equal(run('/usr/bin/systemctl',['start','servora-med-predeploy-backup@'+grant.releaseSha+'.service']).status,0);
    const created=readdirSync('/var/backups/servora-med').filter(n=>!names.has(n)&&n.endsWith('.dump'));
    assert.equal(created.length,1,'exactly one fresh predeploy dump required');
    return '/var/backups/servora-med/'+created[0];
  } finally { writeFileSync(backupEnv,before); }
}

/** Publishes the sealed copy, then SIGKILLs the controller inside the exact
 * window between that publication and its receipt checkpoint. */
async function sealedWithoutReceipt(grant){
  const dump=await takePredeployDump(grant);
  const child=spawn('/usr/bin/node',['--import',preload,controller,'backup-receipt',grant.attemptId,'pre',dump],
    {env:{...process.env,SERVORA_R4_FAULT_POINT:'seal-publish-fsync'},stdio:['ignore','pipe','pipe']});
  let output='',errors='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>errors+=c);
  const closed=new Promise(resolve=>child.once('close',resolve));
  try {
    for(let i=0;i<200&&!output.includes('FAULT_READY=seal-publish-fsync');i++)await delay(50);
    assert.ok(output.includes('FAULT_READY=seal-publish-fsync'),errors);
    child.kill('SIGKILL');await closed;
  } finally {if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
  const sealed=state+'/backups/'+grant.attemptId+'-pre.dump';
  assert.equal(existsSync(sealed),true);
  assert.equal(readLatestCheckpoint(grant.attemptId).record.phase,'ADMITTED');
  snapshot(grant.attemptId,'sealed-before-receipt');
  return sealed;
}

test('a sealed predeploy dump published without its receipt is adopted by the plain retry',async()=>withRuntimeFixture(async grant=>{
  admitAttempt(grant.attemptId);
  const sealed=await sealedWithoutReceipt(grant);
  const sealedSha=createHash('sha256').update(readFileSync(sealed)).digest('hex');
  // The operator retry takes its own fresh dump first; publishing that second
  // backup is unnecessary and the sealed name already exists. The resume must
  // adopt the verified sealed bytes instead of colliding with them.
  const second=Math.floor(Date.now()/1000);while(Math.floor(Date.now()/1000)===second)await delay(25);
  const dump2=await takePredeployDump(grant);
  const retry=run('/usr/bin/node',[controller,'backup-receipt',grant.attemptId,'pre',dump2]);
  assert.equal(retry.status,0,retry.stderr);
  const receipt=readLatestCheckpoint(grant.attemptId).record;
  assert.equal(receipt.phase,'BACKED_UP');assert.equal(receipt.predeployBackup.sha256,sealedSha);
  assert.equal(createHash('sha256').update(readFileSync(sealed)).digest('hex'),sealedSha,'sealed bytes are immutable');
  snapshot(grant.attemptId,'sealed-after-adoption');
  console.log('SEALED_RECEIPT_ADOPTION=PASS second_publish=DENIED sealed_bytes_unchanged=PASS');
}));

test('a sealed predeploy dump is adopted without forcing any second backup',async()=>withRuntimeFixture(async grant=>{
  admitAttempt(grant.attemptId);
  const sealed=await sealedWithoutReceipt(grant);
  const sealedSha=createHash('sha256').update(readFileSync(sealed)).digest('hex');
  const dumps=()=>readdirSync('/var/backups/servora-med').filter(n=>n.endsWith('.dump')).length;
  const before=dumps();
  const adopt=run('/usr/bin/node',[controller,'adopt-backup',grant.attemptId,'pre']);
  assert.equal(adopt.status,0,adopt.stderr);assert.match(adopt.stdout,/ATTEMPT_BACKUP_ADOPTED/);
  const receipt=readLatestCheckpoint(grant.attemptId).record;
  assert.equal(receipt.phase,'BACKED_UP');assert.equal(receipt.predeployBackup.sha256,sealedSha);
  assert.equal(dumps(),before,'the resume must not force a second backup');
  snapshot(grant.attemptId,'sealed-adopted-without-dump');
  console.log('SEALED_ADOPTION_WITHOUT_DUMP=PASS dumps_delta=0');
}));

test('a lost PostgreSQL guard lock blocks the acceptance checkpoint and the abort retries cleanly',async()=>withOldHost(async grant=>{
  admitAttempt(grant.attemptId);prepareRealBackup(grant);createAttemptBarrier(grant.attemptId);
  const killer=spawn('/bin/bash',['-c',
    `for i in $(seq 1 500); do
       pid="$(/usr/bin/sudo -u postgres /usr/bin/psql -XAt -d postgres -c "SELECT pid FROM pg_stat_activity WHERE application_name='servora-med-recovery-guard' AND state='idle' AND query LIKE 'SELECT version FROM public.schema_migrations%'" | head -1)"
       if [[ -n "$pid" ]]; then /usr/bin/sudo -u postgres /usr/bin/psql -XAt -d postgres -c "SELECT pg_terminate_backend($pid)" >/dev/null 2>&1; echo TERMINATED; exit 0; fi
       sleep 0.02
     done
     echo NOT_FOUND; exit 1`],{stdio:['ignore','pipe','pipe']});
  let killed='';killer.stdout.on('data',c=>killed+=c);
  const closedKiller=new Promise(resolve=>killer.once('close',resolve));
  try {
    await assert.rejects(abortAttempt(grant.attemptId),/RECOVERY_DATABASE_PROBE_FAILED/);
    await closedKiller;
    assert.match(killed,/TERMINATED/);
    // Lock loss must never leave an acceptance checkpoint or consume budget.
    const record=readLatestCheckpoint(grant.attemptId).record;
    assert.equal(record.phase,'BACKED_UP');assert.equal(record.abortStarts,0);
    snapshot(grant.attemptId,'guard-lost-before-abort-intent');
    console.log('GUARD_LOCK_LOSS=DENIED acceptance_checkpoint=ABSENT');
  } finally {if(killer.exitCode===null&&killer.signalCode===null)killer.kill('SIGKILL');}
  // The intact, fenced state retries cleanly under a fresh guard.
  const result=await abortAttempt(grant.attemptId);
  assert.equal(result,'PRE_MIGRATION_ABORT=COMPLETE_OLD_EXACT');
  const final=readLatestCheckpoint(grant.attemptId).record;
  assert.equal(final.phase,'COMPLETED_ABORT');assert.equal(final.abortStarts,1);
  console.log('GUARD_LOCK_LOSS_RETRY=PASS abort_slots=1');
}));
