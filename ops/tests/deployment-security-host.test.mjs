import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readlinkSync,unlinkSync,symlinkSync,renameSync,chmodSync,readdirSync,mkdirSync,rmdirSync,existsSync,chownSync} from 'node:fs';
import {spawnSync,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {withRuntimeFixture,prepareRealBackup,readDatabaseInvariants} from './r4-runtime-fixture.mjs';
import {admitAttempt,checkpointAttempt,createAttemptBarrier,revokeStartPermit,alignIdentityEnvironment,sealBackupReceipt} from '../scripts/deployment-controller.mjs';
import {readLatestCheckpoint} from '../scripts/deployment-attempt.mjs';
const root='/var/lib/servora-med/deploy',env='/etc/servora-med/servora-med.env',pointer='/opt/servora-med/current',barrier=root+'/activation.block';
const hash=b=>createHash('sha256').update(b).digest('hex');
function run(grant,phase='forward-recovery') {
 const args=['--phase',phase,'--attempt-id',grant.attemptId];
 if(phase==='postdeploy')args.push('--sha',grant.releaseSha,'--fqdn','r4.synthetic.invalid');
 return spawnSync('/usr/local/libexec/servora-med/deploy-production-host',args,{encoding:'utf8',timeout:90000});
}
function fenced(action,beforeAdmission=()=>{}) {
 return withRuntimeFixture(async grant=>{
  const saved={env:readFileSync(env),pointer:readlinkSync(pointer),barrier:readFileSync(barrier)};
  try {
   beforeAdmission(grant);admitAttempt(grant.attemptId);prepareRealBackup(grant);
   unlinkSync(barrier);createAttemptBarrier(grant.attemptId);checkpointAttempt(grant.attemptId,'FENCED');
   checkpointAttempt(grant.attemptId,{kind:'MIGRATION_INTENT',baseline:readDatabaseInvariants()});
   writeFileSync(env,alignIdentityEnvironment(readFileSync(env,'utf8'),grant.oldCatalog.at(-1).version,grant.oldReleaseSha));
   unlinkSync(pointer);symlinkSync('/opt/servora-med/releases/'+grant.oldReleaseSha,pointer);
   await action(grant);
  } finally {
   spawnSync('/usr/bin/systemctl',['stop','servora-med.service']);revokeStartPermit(grant.attemptId);
   writeFileSync(env,saved.env);unlinkSync(pointer);symlinkSync(saved.pointer,pointer);writeFileSync(barrier,saved.barrier);
  }
 });
}
function unchangedRefusal(grant,expected) {
 const before={env:readFileSync(env),pointer:readlinkSync(pointer),barrier:readFileSync(barrier),pid:spawnSync('/usr/bin/systemctl',['show','servora-med.service','-p','MainPID','--value']).stdout};
 const result=run(grant);assert.notEqual(result.status,0,result.stdout+result.stderr);assert.match(result.stderr,expected);
 assert.deepEqual(readFileSync(env),before.env);assert.equal(readlinkSync(pointer),before.pointer);assert.deepEqual(readFileSync(barrier),before.barrier);
 assert.deepEqual(spawnSync('/usr/bin/systemctl',['show','servora-med.service','-p','MainPID','--value']).stdout,before.pid);
}
test('real helper rejects archive corruption, unsafe permissions and release symlink escape before mutation',()=>fenced(grant=>{
 const archive=root+'/artifacts/'+grant.releaseSha+'.tar.gz',bytes=readFileSync(archive),digest=hash(bytes);
 try{writeFileSync(archive,Buffer.concat([bytes,Buffer.from([0])]));unchangedRefusal(grant,/RECOVERY_RELEASE_UNPROVEN/);}finally{writeFileSync(archive,bytes);}
 assert.equal(hash(readFileSync(archive)),digest);
 const file='/opt/servora-med/releases/'+grant.releaseSha+'/server/dist/index.js';
 try{chmodSync(file,0o660);unchangedRefusal(grant,/RECOVERY_RELEASE_UNPROVEN/);}finally{chmodSync(file,0o640);}
 const saved=root+'/r4-security-'+grant.attemptId+'.js';
 renameSync(file,saved);symlinkSync('/etc/passwd',file);
 try{unchangedRefusal(grant,/RECOVERY_RELEASE_UNPROVEN/);}finally{unlinkSync(file);renameSync(saved,file);}
 assert.equal(readLatestCheckpoint(grant.attemptId).record.phase,'FENCED');
 console.log('ARCHIVE_OWNER_PATH_NEGATIVES=PASS');
}));
test('real helper rejects corrupt journal and third env identity without repair',()=>fenced(grant=>{
 const checkpoint=root+'/attempts/'+grant.attemptId+'/0001.json',bytes=readFileSync(checkpoint);
 try{writeFileSync(checkpoint,'{');unchangedRefusal(grant,/ATTEMPT_RECORD_NOT_CANONICAL/);}finally{writeFileSync(checkpoint,bytes);}
 const original=readFileSync(env,'utf8');
 try{writeFileSync(env,original.replace(/^SERVORA_RELEASE_SHA=.*$/m,'SERVORA_RELEASE_SHA='+ 'f'.repeat(40)));unchangedRefusal(grant,/ENV_IDENTITY_DRIFT/);}finally{writeFileSync(env,original);}
 assert.equal(readLatestCheckpoint(grant.attemptId).record.phase,'FENCED');
 console.log('JOURNAL_ENV_FAIL_CLOSED=PASS');
}));
test('same-history wrong database fingerprint is refused by the real service-UID probe',()=>fenced(grant=>{
 unchangedRefusal(grant,/RECOVERY_DATABASE_IDENTITY_MISMATCH/);
 assert.equal(readLatestCheckpoint(grant.attemptId).record.starts,0);
 console.log('WRONG_DATABASE_FINGERPRINT=PASS');
},grant=>{
 const file=root+'/profile.json',profile=JSON.parse(readFileSync(file));profile.databaseIdentity.databaseOid='1';
 const text=JSON.stringify(profile)+'\n';writeFileSync(file,text);grant.profileSha256=hash(text);writeFileSync(root+'/approvals/'+grant.attemptId+'.json',JSON.stringify(grant)+'\n');
}));
test('HTTP200 wrong public release identity cannot pass recovery; healthy target without backup health cannot complete',()=>fenced(grant=>{
 const config='/etc/caddy/Caddyfile',prior=readFileSync(config);
 const bad='r4.synthetic.invalid {\n tls internal\n handle /api/health {\n respond `{"status":"ok","releaseSha":"'+'f'.repeat(40)+'"}` 200\n }\n handle /api/* {\n reverse_proxy 127.0.0.1:3000\n }\n handle {\n root * /opt/servora-med/current/web/dist\n try_files {path} /index.html\n file_server\n }\n}\n';
 try {
  writeFileSync(config,bad);assert.equal(spawnSync('/usr/bin/systemctl',['reload','caddy']).status,0);
  const response=spawnSync('/usr/bin/curl',['--fail','--silent','https://r4.synthetic.invalid/api/health'],{encoding:'utf8'});assert.equal(response.status,0);assert.equal(JSON.parse(response.stdout).releaseSha,'f'.repeat(40));
  const result=run(grant);assert.notEqual(result.status,0);assert.match(result.stderr,/RECOVERY_HEALTH_FAILED/);
  assert.equal(readLatestCheckpoint(grant.attemptId).record.phase,'START_FAILED');assert.equal(readLatestCheckpoint(grant.attemptId).record.starts,1);
 }finally{writeFileSync(config,prior);assert.equal(spawnSync('/usr/bin/systemctl',['reload','caddy']).status,0);}
 const green=run(grant);assert.equal(green.status,0,green.stdout+green.stderr);assert.equal(readLatestCheckpoint(grant.attemptId).record.starts,2);
 const before=readLatestCheckpoint(grant.attemptId),dumps=readdirSync('/var/backups/servora-med').filter(x=>x.endsWith('.dump')).length;
 const post=run(grant,'postdeploy');assert.notEqual(post.status,0);assert.match(post.stderr,/RECOVERY_BACKUP_HEALTH_FAILED/);
 assert.deepEqual(readLatestCheckpoint(grant.attemptId),before);assert.equal(readdirSync('/var/backups/servora-med').filter(x=>x.endsWith('.dump')).length,dumps);
 console.log('WRONG_HEALTH_IDENTITY=DENIED_REAL_HTTP200\nSECOND_BOUNDED_ACTIVATION=PASS\nHEALTH_WITHOUT_BACKUP_ACCEPTANCE=DENIED');
}));

test('DB055 EXACT cannot enter TARGET forward recovery, even when migration has not started',async()=>{
 const prior=readFileSync(env);writeFileSync(env,readFileSync('/etc/servora-med/r4-abort-fixture.env'));
 try{await fenced(grant=>{unchangedRefusal(grant,/RECOVERY_DATABASE_NOT_EXACT/);assert.equal(readLatestCheckpoint(grant.attemptId).record.starts,0);console.log('DB055_FORWARD_DENIED_BEFORE_MUTATION=PASS');});}finally{writeFileSync(env,prior);}
});
test('mixed approved env and real health loss consume only the remaining explicit slot',()=>fenced(async grant=>{
 writeFileSync(env,readFileSync(env,'utf8').replace(/^HEALTH_SCHEMA_VERSION=.*$/m,'HEALTH_SCHEMA_VERSION='+grant.targetCatalog.at(-1).version));
 const first=run(grant);assert.equal(first.status,0,first.stdout+first.stderr);assert.equal(readLatestCheckpoint(grant.attemptId).record.starts,1);
 const pid=Number(spawnSync('/usr/bin/systemctl',['show','servora-med.service','-p','MainPID','--value'],{encoding:'utf8'}).stdout.trim());assert.ok(pid>0);
 process.kill(pid,'SIGKILL');await new Promise(resolve=>setTimeout(resolve,6000));
 assert.equal(spawnSync('/usr/bin/systemctl',['show','servora-med.service','-p','MainPID','--value'],{encoding:'utf8'}).stdout.trim(),'0');
 assert.equal(spawnSync('/usr/bin/systemctl',['show','servora-med.service','-p','NRestarts','--value'],{encoding:'utf8'}).stdout.trim(),'0');
 const second=run(grant);assert.equal(second.status,0,second.stdout+second.stderr);assert.equal(readLatestCheckpoint(grant.attemptId).record.starts,2);
 assert.notEqual(Number(spawnSync('/usr/bin/systemctl',['show','servora-med.service','-p','MainPID','--value'],{encoding:'utf8'}).stdout.trim()),pid);
 console.log('MIXED_APPROVED_TUPLE=ALIGNED\nREAL_HEALTH_LOSS_SECOND_EXPLICIT_START=PASS\nAUTOMATIC_RESTARTS=0');
}));

test('real failed postdeploy unit leaves a live fenced attempt and cannot run a second backup automatically',async()=>{
 const prior=readFileSync(env,'utf8'),policy='/etc/systemd/system/servora-med-postdeploy-backup.service.d';
 assert.equal(existsSync(policy),false);
 let text=prior.replace(/^BACKUP_PROVIDER=.*$/m,'BACKUP_PROVIDER=host-observation');
 if(!text.includes('BACKUP_OBSERVATION_PATH='))text+='BACKUP_OBSERVATION_PATH=/var/lib/servora-med-backup/observation-v1.json\n';
 writeFileSync(env,text);
 try {
  await fenced(grant=>{
   const recovered=run(grant);assert.equal(recovered.status,0,recovered.stdout+recovered.stderr);
   // Scheduled unit executes the now-verified candidate's backup script.
   assert.equal(spawnSync('/usr/bin/systemctl',['start','servora-med-backup.service']).status,0);
   mkdirSync(policy,{mode:0o755});writeFileSync(policy+'/90-r4-synthetic-failure.conf','[Service]\nExecStart=\nExecStart=/bin/false\n',{mode:0o644,flag:'wx'});
   try {
    assert.equal(spawnSync('/usr/bin/systemctl',['daemon-reload']).status,0);
    const failed=run(grant,'postdeploy');assert.equal(failed.status,2,failed.stdout+failed.stderr);assert.match(failed.stderr,/LIVE_BUT_POSTDEPLOY_BACKUP_FAILED/);
    const before=readLatestCheckpoint(grant.attemptId);assert.equal(before.record.phase,'POSTDEPLOY_BACKUP_INTENT');assert.equal(before.record.postdeployBackup,null);
    const invocation=spawnSync('/usr/bin/systemctl',['show','servora-med-postdeploy-backup.service','-p','InvocationID','--value'],{encoding:'utf8'}).stdout;
    const repeat=run(grant,'postdeploy');assert.notEqual(repeat.status,0);assert.match(repeat.stderr,/POSTDEPLOY_BACKUP_AMBIGUOUS_OPERATOR_REVIEW_REQUIRED/);
    assert.deepEqual(readLatestCheckpoint(grant.attemptId),before);assert.equal(spawnSync('/usr/bin/systemctl',['show','servora-med-postdeploy-backup.service','-p','InvocationID','--value'],{encoding:'utf8'}).stdout,invocation);
    assert.equal(spawnSync('/usr/bin/systemctl',['is-active','servora-med.service'],{encoding:'utf8'}).stdout.trim(),'active');
     console.log('REAL_POSTDEPLOY_BACKUP_FAILED=LIVE_FENCED\nSECOND_BACKUP_INVOCATION=DENIED\nFALSE_RECOVERY_PASS=ABSENT');
    } finally {unlinkSync(policy+'/90-r4-synthetic-failure.conf');rmdirSync(policy);spawnSync('/usr/bin/systemctl',['daemon-reload']);}
   });
  } finally {writeFileSync(env,prior);}
});

test('a sealed receipt rejects swapped bytes that are not a real PostgreSQL archive', () => withRuntimeFixture(grant => {
  admitAttempt(grant.attemptId);
  const directory='/var/backups/servora-med';
  const name='servora-med-20261012T000000Z.dump';
  const file=directory+'/'+name;
  const uid=Number(execFileSync('/usr/bin/id',['-u','servora-med'],{encoding:'utf8'}));
  const gid=Number(execFileSync('/usr/bin/id',['-g','servora-med'],{encoding:'utf8'}));
  assert.equal(existsSync(file),false);
  // The service account can replace its own dump and sidecar after the helper
  // verified them; only a real archive may be sealed by the root receipt.
  const garbage=Buffer.from('not a postgres archive at all');
  writeFileSync(file,garbage,{mode:0o600});chownSync(file,uid,gid);
  writeFileSync(file+'.sha256',hash(garbage)+'  '+name+'\n',{mode:0o600});chownSync(file+'.sha256',uid,gid);
  try {
    assert.throws(()=>sealBackupReceipt(grant.attemptId,'pre',file),/RECOVERY_BACKUP_ARCHIVE_INVALID/);
    assert.equal(existsSync('/var/lib/servora-med/deploy/backups/'+grant.attemptId+'-pre.dump'),false,'no receipt may be published for invalid bytes');
    const journal=readLatestCheckpoint(grant.attemptId).record;
    assert.equal(journal.phase,'ADMITTED');assert.equal(journal.predeployBackup,null);
    console.log('SEALED_BYTES_FORMAT_GATE=PASS');
  } finally {unlinkSync(file);unlinkSync(file+'.sha256');}
}));
