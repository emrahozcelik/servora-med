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
import {readLatestCheckpoint,readRootApproval,initialAttempt} from '../scripts/deployment-attempt.mjs';

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

test('a FENCED interruption resumes the approved migration without abort permission or a second backup',async()=>withOldHost(async (grant,saved)=>{
  grant.allowPreMigrationAbort=false;grant.maxAbortStarts=0;
  writeFileSync(state+'/approvals/'+grant.attemptId+'.json',JSON.stringify(grant)+'\n');
  admitAttempt(grant.attemptId);prepareRealBackup(grant);createAttemptBarrier(grant.attemptId);
  const child=spawn('/bin/bash',['-c',`source /usr/local/libexec/servora-med/deploy-production-host
SHA=${grant.releaseSha}; ATTEMPT_ID=${grant.attemptId}; FQDN=r4.synthetic.invalid
acquire_host_lock
r4_suppress_restarts
systemctl stop "$SERVICE"
r4_controller event "$ATTEMPT_ID" FENCED
printf 'FAULT_READY=fenced-fsync\n'
kill -STOP "$BASHPID"
`],{stdio:['ignore','pipe','pipe']});
  let output='',errors='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>errors+=c);
  const closed=new Promise(resolve=>child.once('close',resolve));
  try {
    for(let i=0;i<200&&!output.includes('FAULT_READY=fenced-fsync');i++)await delay(50);
    assert.ok(output.includes('FAULT_READY=fenced-fsync'),errors);child.kill('SIGKILL');await closed;
    assert.equal(readLatestCheckpoint(grant.attemptId).record.phase,'FENCED');
    prepareReboot(grant.attemptId,saved,'fenced');
    const owner=readFileSync(state+'/active.json'),backups=readdirSync('/var/backups/servora-med').filter(n=>n.endsWith('.dump')).length;
    writeFileSync(state+'/active.json',JSON.stringify({attemptId:randomUUID(),approvalSha256:'4'.repeat(64)})+'\n');
    const foreign=run('/usr/local/libexec/servora-med/deploy-production-host',['--phase','attempt-preflight','--attempt-id',grant.attemptId]);
    assert.notEqual(foreign.status,0);writeFileSync(state+'/active.json',owner);
    const db=JSON.parse(readFileSync(state+'/profile.json')).databaseIdentity.databaseName;
    const sql=statement=>run('/usr/bin/sudo',['-u','postgres','/usr/bin/psql','-X','-v','ON_ERROR_STOP=1','-d',db,'-c',statement]);
    assert.equal(sql("INSERT INTO schema_migrations(version) VALUES ('999_r4_future')").status,0);
    try {
      const diverged=run('/usr/local/libexec/servora-med/deploy-production-host',['--phase','attempt-preflight','--attempt-id',grant.attemptId]);
      assert.notEqual(diverged.status,0);assert.match(diverged.stderr,/RECOVERY_DATABASE_NOT_EXACT/);
      assert.equal(readLatestCheckpoint(grant.attemptId).record.phase,'FENCED');
    } finally {assert.equal(sql("DELETE FROM schema_migrations WHERE version='999_r4_future'").status,0);}
    const preflight=run('/usr/local/libexec/servora-med/deploy-production-host',['--phase','attempt-preflight','--attempt-id',grant.attemptId]);
    assert.equal(preflight.status,0,'FENCED OLD EXACT must be a deploy resume: '+preflight.stderr);
    assert.equal(JSON.parse(preflight.stdout).mode,'deploy');
    const artifact=state+'/artifacts/'+grant.releaseSha+'.tar.gz';
    const retry=spawnSync('/usr/local/libexec/servora-med/deploy-production-host',['--phase','deploy','--sha',grant.releaseSha,
      '--artifact',artifact,'--artifact-sha',grant.artifactSha256,'--fqdn','r4.synthetic.invalid','--allow-migrations','--attempt-id',grant.attemptId],{encoding:'utf8',timeout:180000});
    assert.equal(retry.status,0,'actual fixed helper FENCED resume failed: '+retry.stderr+' '+retry.stdout);
    const record=readLatestCheckpoint(grant.attemptId).record;
    assert.equal(record.phase,'HEALTH_PASSED');assert.equal(record.starts,1);assert.equal(record.schemaChecked,true);
    assert.equal(record.migrationCommitted,true);assert.equal(record.abortStarts,0);
    assert.equal(readdirSync('/var/backups/servora-med').filter(n=>n.endsWith('.dump')).length,backups);
    assert.deepEqual(readFileSync(state+'/active.json'),owner);
    const stateText=readFileSync(state+'/'+grant.releaseSha+'.state','utf8');
    assert.match(stateText,/migrations_applied=1\n/);assert.ok(stateText.includes('old_release=/opt/servora-med/releases/'+grant.oldReleaseSha+'\n'));
    console.log('FENCED_SAME_OWNER_RESUME=PASS real_migration=055_to_056 second_prebackup=0 start_slots=1');
  } finally {if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
},true));

test('a timely sealed marker consumes authority before checkpoint zero and rejects late or foreign markers',async()=>withOldHost(async grant=>{
  const now=Date.now(),admittedAt=now-7200000;
  grant.issuedAtUTC=new Date(admittedAt-1000).toISOString();grant.expiresAtUTC=new Date(now-1000).toISOString();
  const approvalText=JSON.stringify(grant)+'\n',approvalSha256=createHash('sha256').update(approvalText).digest('hex');
  writeFileSync(state+'/approvals/'+grant.attemptId+'.json',approvalText);
  const marker=state+'/initializations/'+grant.attemptId+'.json';
  const first=initialAttempt({approval:grant,approvalSha256},admittedAt);
  mkdirSync(state+'/initializations',{recursive:true,mode:0o700});
  writeFileSync(marker,JSON.stringify(first)+'\n',{mode:0o600,flag:'wx'});
  const fd=openSync(marker,'r');fsyncSync(fd);closeSync(fd);
  try {
    assert.equal(existsSync(state+'/attempts/'+grant.attemptId+'/0000.json'),false);
    assert.doesNotThrow(()=>readRootApproval(grant.attemptId,now),'the exact timely marker must count as consumed authority');
    writeFileSync(marker,JSON.stringify({...first,updatedAtUTC:new Date(now).toISOString()})+'\n');
    assert.throws(()=>readRootApproval(grant.attemptId,now),/ATTEMPT_APPROVAL_TIME_INVALID|ATTEMPT_APPROVAL_WINDOW_INSUFFICIENT|RECOVERY_INITIALIZATION_CONFLICT/);
    writeFileSync(marker,JSON.stringify({...first,approvalSha256:'4'.repeat(64)})+'\n');
    assert.throws(()=>readRootApproval(grant.attemptId,now),/RECOVERY_INITIALIZATION_CONFLICT|ATTEMPT_JOURNAL_INVALID/);
    writeFileSync(marker,JSON.stringify(first)+'\n');
    const retry=run('/usr/bin/node',[controller,'admit',grant.attemptId]);assert.equal(retry.status,0,retry.stderr);
    assert.equal(existsSync(marker),false);assert.equal(readLatestCheckpoint(grant.attemptId).record.phase,'ADMITTED');
    console.log('TIMELY_MARKER_CONSUMED_AUTHORITY=PASS expiration_clock_fixture=PAST late_marker=DENIED foreign_hash=DENIED');
  } finally {if(existsSync(marker))unlinkSync(marker);}
}));

test('a separate postdeploy process preserves old release and applied migration count',()=>{
  // Execute the real shell function in a fresh Bash process. Mock only the
  // external backup/observation side effects for this state regression;
  // the fixed-helper H8 acceptance exercises the real commands separately.
  const sha='76b32f76a748e4a0a650010bba5ddd385cb3d132';
  const file=state+'/'+sha+'.state',saved=existsSync(file)?readFileSync(file):null;
  const old='/opt/servora-med/releases/71ae6df6dd0659ed6390a6785d4bab29ddf5b1fa';
  const initial=`sha=${sha}\nold_release=${old}\nnew_release=/opt/servora-med/releases/${sha}\nmigrations_applied=1\npostdeploy=not_run\n`;
  writeFileSync(file,initial,{mode:0o600});
  try {
    const script=`source /usr/local/libexec/servora-med/deploy-production-host
SHA=${sha}; FQDN=r4.synthetic.invalid; ATTEMPT_ID=11111111-1111-4111-8111-111111111111
require_commands(){ :; }; assert_env_contract(){ :; }; assert_host_backup_contract(){ :; }
r4_controller(){ if [[ "$1" == prepare-postdeploy ]]; then echo BACKUP_REQUIRED; elif [[ "$1" == deployment-state ]]; then read_state; printf 'OLD_RELEASE=%s\nMIGRATIONS_APPLIED=%s\nSTATE_MISSING=false\n' "$OLD_RELEASE" "$MIGRATIONS_APPLIED"; fi; }
current_release(){ echo /opt/servora-med/releases/${sha}; }
systemctl(){ if [[ "$1" == show && "$4" == Result ]]; then echo success; elif [[ "$1" == show && "$4" == ExecMainStatus ]]; then echo 0; fi; }
health_gate(){ :; }; verify_backup_artifact(){ echo BACKUP_ARTIFACT=servora-med-20000101T000000Z.dump; }
assert_observation_state_contract(){ :; }
postdeploy_phase
`;
    const result=run('/bin/bash',['-c',script]);assert.equal(result.status,0,result.stderr);
    const after=readFileSync(file,'utf8');assert.equal(after,initial.replace('postdeploy=not_run','postdeploy=success'));
    console.log('SEPARATE_POSTDEPLOY_STATE=PASS old_release_preserved=PASS migration_count=1');
  } finally {if(saved)writeFileSync(file,saved);else unlinkSync(file);}
});
