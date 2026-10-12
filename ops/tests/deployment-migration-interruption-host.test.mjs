import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,readlinkSync,unlinkSync,symlinkSync,existsSync} from 'node:fs';
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {withRuntimeFixture,LAB_SHA} from './r4-runtime-fixture.mjs';
import {readLatestCheckpoint} from '../scripts/deployment-attempt.mjs';

for(const point of ['before-commit','after-commit']) test('real migration SIGKILL '+point+' preserves the correct abort/forward boundary',async()=>{
 const env='/etc/servora-med/servora-med.env',backup='/etc/servora-med/servora-med-backup.env',barrier='/var/lib/servora-med/deploy/activation.block',pointer='/opt/servora-med/current',policy='/etc/systemd/system/servora-med.service.d/90-servora-recovery.conf';
 const saved={env:readFileSync(env,'utf8'),backup:readFileSync(backup,'utf8'),barrier:readFileSync(barrier),pointer:readlinkSync(pointer),policy:readFileSync(policy)};
 const db='servora_med_test_r4_crash_'+randomUUID().replaceAll('-','');
 assert.equal(spawnSync('/usr/bin/sudo',['-u','postgres','--','/usr/bin/createdb','-O','servora_r4_app','-T','servora_med_test_r4_abort_20261012',db]).status,0);
 const text=readFileSync('/etc/servora-med/r4-abort-fixture.env','utf8');
 const url=new URL(text.split('\n').find(line=>line.startsWith('DATABASE_URL=')).slice(13));url.pathname='/'+db;
 writeFileSync(env,text.replace(/^DATABASE_URL=.*$/m,'DATABASE_URL='+url.toString()));
 writeFileSync(backup,saved.backup.replace(/^PGDATABASE=.*$/m,'PGDATABASE='+db));
 let actor;
 try {
  await withRuntimeFixture(async grant=>{
   unlinkSync(barrier);unlinkSync(policy);unlinkSync(pointer);symlinkSync('/opt/servora-med/releases/'+grant.oldReleaseSha,pointer);
   spawnSync('/usr/bin/systemctl',['daemon-reload']);assert.equal(spawnSync('/usr/bin/systemctl',['start','servora-med.service']).status,0);
   for(let wait=0;wait<20;wait++) {if(spawnSync('/usr/bin/curl',['--fail','--silent','https://r4.synthetic.invalid/api/health']).status===0)break;await delay(1000);}
   const sqlRuntime=`import {createRequire} from 'node:module';import {createInterface} from 'node:readline';const {Client}=createRequire('/opt/servora-med/releases/${LAB_SHA}/server/package.json')('pg');const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();`;
   const actorCode=point==='before-commit'
    ? `await c.query('BEGIN');await c.query('LOCK TABLE job_card_meeting_details IN ACCESS SHARE MODE');console.log('FAULT_READY');for await(const line of createInterface({input:process.stdin})){if(line==='STATUS'){const r=await c.query("SELECT count(*)::int AS n FROM pg_locks WHERE relation='job_card_meeting_details'::regclass AND NOT granted");console.log('MIGRATION_WAITERS='+r.rows[0].n);}else break;}await c.query('ROLLBACK');await c.end();`
    : `await c.query("CREATE FUNCTION r4_test_commit_notification() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_notify('r4_commit',NEW.version); RETURN NEW; END $$");await c.query('CREATE TRIGGER r4_test_commit_notification AFTER INSERT ON schema_migrations FOR EACH ROW EXECUTE FUNCTION r4_test_commit_notification()');await c.query('LISTEN r4_commit');c.on('notification',message=>{if(message.payload.startsWith('056_'))console.log('COMMIT_OBSERVED');});console.log('FAULT_READY');for await(const line of createInterface({input:process.stdin})){if(line==='STOP')break;}await c.query('DROP TRIGGER r4_test_commit_notification ON schema_migrations');await c.query('DROP FUNCTION r4_test_commit_notification()');await c.end();`;
   actor=spawn('/usr/bin/sudo',['-u','servora-med','--','/usr/bin/node','--env-file='+env,'--input-type=module','-e',sqlRuntime+actorCode],{stdio:['pipe','pipe','pipe']});
   let actorOutput='',actorErrors='',deployment;
   const actorClosed=new Promise(resolve=>actor.once('close',resolve));
   actor.stderr.on('data',chunk=>actorErrors+=chunk.toString());
   actor.stdout.on('data',chunk=>{actorOutput+=chunk.toString();if(point==='after-commit'&&actorOutput.includes('COMMIT_OBSERVED')&&deployment){process.kill(-deployment.pid,'SIGKILL');deployment=null;}});
   for(let wait=0;wait<100&&!actorOutput.includes('FAULT_READY');wait++)await delay(100);
   assert.ok(actorOutput.includes('FAULT_READY'),actorErrors);
   const sudo=['-u','servora-deploy','--','/usr/bin/sudo','-n','/usr/local/libexec/servora-med/deploy-production-host'];
   deployment=spawn('/usr/bin/sudo',[...sudo,'--phase','deploy','--sha',grant.releaseSha,'--artifact','/home/emrah.guest/r4-rehearsal/servora-med-'+grant.releaseSha+'.tar.gz','--artifact-sha',grant.artifactSha256,'--fqdn','r4.synthetic.invalid','--allow-migrations','--attempt-id',grant.attemptId],{stdio:['ignore','pipe','pipe'],detached:true});
   let output='',errors='';deployment.stdout.on('data',chunk=>output+=chunk.toString());deployment.stderr.on('data',chunk=>errors+=chunk.toString());
   const ended=new Promise(resolve=>deployment.once('close',(code,signal)=>resolve({code,signal})));
   if(point==='before-commit') {
    for(let wait=0;wait<100&&!actorOutput.includes('MIGRATION_WAITERS=1');wait++){actor.stdin.write('STATUS\n');await delay(250);}
    assert.ok(actorOutput.includes('MIGRATION_WAITERS=1'),'real ALTER TABLE must be blocked, not only journal intent');
    const profile=JSON.parse(readFileSync('/var/lib/servora-med/deploy/profile.json'));
    const probe=spawnSync('/usr/bin/sudo',['-u','servora-med','--','/usr/bin/node','--env-file='+env,'/usr/local/libexec/servora-med/deployment-db-guard.mjs','--hold'],{encoding:'utf8',input:JSON.stringify({releaseDirectory:'/opt/servora-med/releases/'+LAB_SHA,expectedIdentity:profile.databaseIdentity,expectedCatalog:grant.oldCatalog.map(e=>e.version)})+'\n',timeout:10000});
    assert.match(probe.stderr,/RECOVERY_DATABASE_LOCK_BUSY/,'probe shares the real Migrator advisory lock');
    const pid=execFileSync('/usr/bin/pgrep',['-f','^/usr/bin/node /opt/servora-med/releases/'+LAB_SHA+'/server/dist/db/migrate.js$'],{encoding:'utf8'}).trim();assert.match(pid,/^[1-9][0-9]*$/);
    process.kill(Number(pid),'SIGKILL');
   }
   const result=await Promise.race([ended,delay(60000).then(()=>{throw Error('MIGRATION_FAULT_TIMEOUT');})]);
   assert.notEqual(result.code,0,output+errors);actor.stdin.end('STOP\n');assert.equal(await actorClosed,0,actorErrors);actor=null;
   const state=readLatestCheckpoint(grant.attemptId).record;
   assert.equal(state.starts,0,'fault is observed before any candidate activation');
   console.log('REAL_MIGRATION_INTERRUPTED='+point+' phase='+state.phase+' exit='+result.code+' signal='+result.signal+' database='+db);
   const operation=point==='before-commit'?'pre-migration-abort':'forward-recovery';
   const recovery=spawnSync('/usr/bin/sudo',[...sudo,'--phase',operation,'--attempt-id',grant.attemptId],{encoding:'utf8',timeout:90000});
   assert.equal(recovery.status,0,recovery.stdout+recovery.stderr);
   const final=readLatestCheckpoint(grant.attemptId).record;
   assert.equal(final.phase,point==='before-commit'?'COMPLETED_ABORT':'HEALTH_PASSED');
   assert.equal(final.migrationCommitted,point==='after-commit');
   console.log(recovery.stdout.trim());console.log('REAL_TRANSACTION_BOUNDARY_'+point.toUpperCase()+'=PASS');
  });
 } finally {
  if(actor){actor.stdin.end('STOP\n');actor.kill('SIGTERM');}
  spawnSync('/usr/bin/systemctl',['stop','servora-med.service']);writeFileSync(env,saved.env);writeFileSync(backup,saved.backup);
  unlinkSync(pointer);symlinkSync(saved.pointer,pointer);writeFileSync(barrier,saved.barrier,{mode:0o600});writeFileSync(policy,saved.policy,{mode:0o600});spawnSync('/usr/bin/systemctl',['daemon-reload']);
 }
});
