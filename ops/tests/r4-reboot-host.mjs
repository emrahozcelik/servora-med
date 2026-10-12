/** Fixed disposable-host interruption fixture. No production path or credentials. */
import assert from 'node:assert/strict';
import {hostname} from 'node:os';
import {readFileSync,writeFileSync,mkdirSync,existsSync,readlinkSync,unlinkSync,symlinkSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {withRuntimeFixture,prepareRealBackup,readDatabaseInvariants} from './r4-runtime-fixture.mjs';
import {admitAttempt,checkpointAttempt,createAttemptBarrier,alignIdentityEnvironment,alignAttemptEnvironment,alignAttemptPointer,grantStartPermit,revokeStartPermit} from '../scripts/deployment-controller.mjs';
import {readLatestCheckpoint} from '../scripts/deployment-attempt.mjs';
assert.equal(hostname(),'lima-servora-r4-20261012');assert.equal(process.getuid(),0);
const root='/var/lib/servora-med/deploy', env='/etc/servora-med/servora-med.env',pointer='/opt/servora-med/current';
const barrier=root+'/activation.block',policy='/etc/systemd/system/servora-med.service.d/90-servora-recovery.conf';
const fixture='/var/lib/servora-med/r4-reboot-fixture';
const [command,kind]=process.argv.slice(2);
if(command==='prepare') {
 assert.ok(['ENV_INTENT','POINTER_INTENT','START_INTENT','MIGRATION_INTENT'].includes(kind));
 assert.equal(existsSync(fixture+'/current.json'),false,'previous owned interruption fixture must be inspected first');
 mkdirSync(fixture,{recursive:true,mode:0o700});
 const saved={env:readFileSync(env,'utf8'),pointer:readlinkSync(pointer),barrier:readFileSync(barrier,'utf8'),policy:readFileSync(policy,'utf8'),profile:existsSync(root+'/profile.json')?readFileSync(root+'/profile.json','utf8'):null};
 if(kind==='MIGRATION_INTENT') writeFileSync(env,readFileSync('/etc/servora-med/r4-abort-fixture.env'));
 withRuntimeFixture(grant=>{
  const backup=JSON.parse(readFileSync(root+'/profile.json'));
  assert.ok(backup.databaseIdentity.databaseName.startsWith('servora_med_test_r4_'));
  const profileText=readFileSync(root+'/profile.json');
  admitAttempt(grant.attemptId);prepareRealBackup(grant);
  unlinkSync(barrier);createAttemptBarrier(grant.attemptId);
  spawnSync('/usr/bin/systemctl',['stop','servora-med.service']);
  writeFileSync(env,alignIdentityEnvironment(readFileSync(env,'utf8'),grant.oldCatalog.at(-1).version,grant.oldReleaseSha));
  unlinkSync(pointer);symlinkSync('/opt/servora-med/releases/'+grant.oldReleaseSha,pointer);
  checkpointAttempt(grant.attemptId,'FENCED');checkpointAttempt(grant.attemptId,{kind:'MIGRATION_INTENT',baseline:readDatabaseInvariants()});
  if(kind!=='MIGRATION_INTENT') {
   checkpointAttempt(grant.attemptId,'DB_EXACT');checkpointAttempt(grant.attemptId,'ENV_INTENT');
   alignAttemptEnvironment(grant.attemptId,'target');
   if(kind!=='ENV_INTENT') {
    checkpointAttempt(grant.attemptId,'ENV_ALIGNED');checkpointAttempt(grant.attemptId,'POINTER_INTENT');alignAttemptPointer(grant.attemptId,'target');
    if(kind==='START_INTENT') {checkpointAttempt(grant.attemptId,'POINTER_ALIGNED');checkpointAttempt(grant.attemptId,'START_INTENT');grantStartPermit(grant.attemptId);}
   }
  }
  const record={attemptId:grant.attemptId,kind,bootId:readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),saved,profile:profileText.toString()};
  writeFileSync(fixture+'/current.json',JSON.stringify(record)+'\n',{mode:0o600});
  console.log('REBOOT_FIXTURE_READY='+grant.attemptId+' phase='+kind+' boot='+record.bootId);
  // Fixture intentionally survives process death. Never call generic cleanup
  // on the active owner or journal that the interrupted host must inspect.
  process.exit(0);
 });
} else if(command==='verify-and-retire') {
 const record=JSON.parse(readFileSync(fixture+'/current.json'));
 assert.notEqual(readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),record.bootId);
 assert.equal(existsSync('/run/servora-med-recovery/start.permit'),false,'volatile start permit must not survive reboot');
 assert.equal(spawnSync('/usr/bin/systemctl',['show','servora-med.service','-p','MainPID','--value'],{encoding:'utf8'}).stdout.trim(),'0','pending attempt must not auto-boot');
 assert.equal(JSON.parse(readFileSync(root+'/active.json')).attemptId,record.attemptId);
 const phase=record.kind==='MIGRATION_INTENT'?'pre-migration-abort':'forward-recovery';
 const result=spawnSync('/usr/local/libexec/servora-med/deploy-production-host',['--phase',phase,'--attempt-id',record.attemptId],{encoding:'utf8',timeout:90000});
 const checkpoint=readLatestCheckpoint(record.attemptId).record;
 if(record.kind==='START_INTENT') {
  assert.notEqual(result.status,0);assert.match(result.stderr,/ATTEMPT_TRANSITION_INVALID/);
  assert.equal(checkpoint.phase,'START_INTENT');assert.equal(checkpoint.starts,1);
 } else {
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.equal(checkpoint.phase,record.kind==='MIGRATION_INTENT'?'COMPLETED_ABORT':'HEALTH_PASSED');
  assert.equal(checkpoint.starts,record.kind==='MIGRATION_INTENT'?0:1);
 }
 console.log(result.stdout.trim());
 console.log('REAL_REBOOT_RECOVERY=PASS phase='+record.kind+' start_slots='+checkpoint.starts+' abort_slots='+checkpoint.abortStarts);
 // Explicit owned lab teardown, preserving every grant/journal/artifact.
 spawnSync('/usr/bin/systemctl',['stop','servora-med.service']);
 if(existsSync(root+'/active.json')) { assert.equal(JSON.parse(readFileSync(root+'/active.json')).attemptId,record.attemptId);revokeStartPermit(record.attemptId);unlinkSync(root+'/active.json'); }
 writeFileSync(env,record.saved.env);unlinkSync(pointer);symlinkSync(record.saved.pointer,pointer);
 writeFileSync(barrier,record.saved.barrier,{mode:0o600});writeFileSync(policy,record.saved.policy,{mode:0o600});
 if(record.saved.profile) writeFileSync(root+'/profile.json',record.saved.profile);else unlinkSync(root+'/profile.json');
 spawnSync('/usr/bin/systemctl',['daemon-reload']);
 writeFileSync(fixture+'/'+record.attemptId+'.json',JSON.stringify(record)+'\n',{mode:0o600});unlinkSync(fixture+'/current.json');
} else throw Error('DISPOSABLE_FIXTURE_COMMAND_INVALID');
