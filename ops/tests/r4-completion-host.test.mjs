import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readlinkSync,unlinkSync,symlinkSync,existsSync,readdirSync} from 'node:fs';
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {withRuntimeFixture,LAB_SHA} from './r4-runtime-fixture.mjs';
import {revokeStartPermit} from '../scripts/deployment-controller.mjs';
import {readLatestCheckpoint} from '../scripts/deployment-attempt.mjs';

test('real host completion requires Mac smoke, distinct backups and uninterrupted measured observation',async()=>{
 const env='/etc/servora-med/servora-med.env',backup='/etc/servora-med/servora-med-backup.env',barrier='/var/lib/servora-med/deploy/activation.block',pointer='/opt/servora-med/current',policy='/etc/systemd/system/servora-med.service.d/90-servora-recovery.conf';
 const saved={env:readFileSync(env),backup:readFileSync(backup,'utf8'),barrier:readFileSync(barrier),pointer:readlinkSync(pointer),policy:readFileSync(policy)};
 let text=readFileSync('/etc/servora-med/r4-normal-fixture.env','utf8').replace(/^BACKUP_PROVIDER=.*$/m,'BACKUP_PROVIDER=host-observation');
 if(!text.includes('BACKUP_OBSERVATION_PATH=')) text+='BACKUP_OBSERVATION_PATH=/var/lib/servora-med-backup/observation-v1.json\n';
 writeFileSync(env,text);
 const db=new URL(text.split('\n').find(line=>line.startsWith('DATABASE_URL=')).slice(13)).pathname.slice(1);
 assert.match(db,/^servora_med_test_r4_normal_[a-z0-9]+$/);
 writeFileSync(backup,saved.backup.replace(/^PGDATABASE=.*$/m,'PGDATABASE='+db));
 try {
  await withRuntimeFixture(async grant=>{
   unlinkSync(barrier);unlinkSync(policy);unlinkSync(pointer);symlinkSync('/opt/servora-med/releases/'+grant.oldReleaseSha,pointer);
   spawnSync('/usr/bin/systemctl',['daemon-reload']);
   assert.equal(spawnSync('/usr/bin/systemctl',['start','servora-med.service']).status,0);
   let oldHealthy=false;
   for(let sample=0;sample<20;sample++) {
    if(spawnSync('/usr/bin/curl',['--fail','--silent','https://r4.synthetic.invalid/api/health']).status===0) {oldHealthy=true;break;}
    await delay(1000);
   }
   assert.equal(oldHealthy,true);
   assert.equal(spawnSync('/usr/bin/systemctl',['start','servora-med-backup.service']).status,0,'real scheduled heartbeat required');
   const sudo=['-u','servora-deploy','--','/usr/bin/sudo','-n','/usr/local/libexec/servora-med/deploy-production-host'];
   const preflight=spawnSync('/usr/bin/sudo',[...sudo,'--phase','attempt-preflight','--attempt-id',grant.attemptId],{encoding:'utf8',timeout:30000});
   assert.equal(preflight.status,0,preflight.stdout+preflight.stderr);
   assert.equal(JSON.parse(preflight.stdout).artifactSha256,grant.artifactSha256);
   const deployment=spawnSync('/usr/bin/sudo',[...sudo,'--phase','deploy','--sha',grant.releaseSha,'--artifact','/home/emrah.guest/r4-rehearsal/servora-med-'+grant.releaseSha+'.tar.gz','--artifact-sha',grant.artifactSha256,'--fqdn','r4.synthetic.invalid','--allow-migrations','--attempt-id',grant.attemptId],{encoding:'utf8',timeout:120000});
   console.log(deployment.stdout.trim());assert.equal(deployment.status,0,deployment.stdout+deployment.stderr);
   assert.match(deployment.stdout,/MIGRATIONS_APPLIED=1/);
   console.log('R4_MAC_SMOKE_READY='+grant.attemptId+' sha='+LAB_SHA);
   const signal='/run/r4-mac-smoke-'+grant.attemptId;
   let ready=false;
   for(let wait=0;wait<240;wait++) {if(existsSync(signal)){ready=true;break;}await delay(1000);}
   assert.equal(ready,true,'actual Mac smoke must pass before postdeploy invocation');
   const dumpNames=()=>readdirSync('/var/backups/servora-med').filter(n=>n.endsWith('.dump'));
   const before=dumpNames();
   const runPost=async(partial)=>{
    const child=spawn('/usr/bin/sudo',[...sudo,'--phase','postdeploy','--sha',grant.releaseSha,'--fqdn','r4.synthetic.invalid','--attempt-id',grant.attemptId],{stdio:['ignore','pipe','pipe'],detached:true});
    let output='',errors='',sent=false;
    child.stdout.on('data',chunk=>{
     const line=chunk.toString();output+=line;process.stdout.write(line);
     if(partial&&!sent&&output.includes('OBSERVATION_SAMPLE=1 ')){sent=true;const pid=execFileSync('/usr/bin/pgrep',['-f','^/usr/bin/node /usr/local/libexec/servora-med/deployment-controller.mjs observe '+grant.attemptId+'$'],{encoding:'utf8'}).trim();assert.match(pid,/^[1-9][0-9]*$/);process.kill(Number(pid),'SIGTERM');}
    });
    child.stderr.on('data',chunk=>{errors+=chunk.toString();process.stderr.write(chunk);});
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
    if(partial){assert.notEqual(code,0);assert.ok(sent);assert.match(errors,/OBSERVATION_PARTIAL_INTERRUPTED/);assert.equal(readLatestCheckpoint(grant.attemptId).record.phase,'POSTDEPLOY_BACKUP_PASSED');}
    else {assert.equal(code,0,output+errors);assert.match(output,/OBSERVATION=PASS/);assert.equal(readLatestCheckpoint(grant.attemptId).record.phase,'COMPLETED');}
   };
   const partial=process.env.SERVORA_R4_PARTIAL_OBSERVATION==='1';
   await runPost(partial);
   assert.equal(dumpNames().length-before.length,1,'exactly one separate postdeploy backup');
   if(partial){await runPost(true);assert.equal(dumpNames().length-before.length,1,'observation retry cannot rerun backup');}
   else {
    const pid=spawnSync('/usr/bin/systemctl',['show','servora-med.service','-p','MainPID','--value'],{encoding:'utf8'}).stdout;
    const repeat=spawnSync('/usr/bin/sudo',[...sudo,'--phase','forward-recovery','--attempt-id',grant.attemptId],{encoding:'utf8',timeout:30000});
    assert.equal(repeat.status,0,repeat.stdout+repeat.stderr);assert.match(repeat.stdout,/ALREADY_COMPLETED_READ_ONLY/);
    assert.equal(spawnSync('/usr/bin/systemctl',['show','servora-med.service','-p','MainPID','--value'],{encoding:'utf8'}).stdout,pid);
    assert.equal(dumpNames().length-before.length,1);
   }
   unlinkSync(signal);
  });
 } finally {
  spawnSync('/usr/bin/systemctl',['stop','servora-med.service']);
  writeFileSync(env,saved.env);writeFileSync(backup,saved.backup);unlinkSync(pointer);symlinkSync(saved.pointer,pointer);
  writeFileSync(barrier,saved.barrier,{mode:0o600});writeFileSync(policy,saved.policy,{mode:0o600});spawnSync('/usr/bin/systemctl',['daemon-reload']);
 }
});
