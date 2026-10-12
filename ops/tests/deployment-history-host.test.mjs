import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {hostname} from 'node:os';
import {readFileSync,writeFileSync,readlinkSync,unlinkSync,symlinkSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {withRuntimeFixture,prepareRealBackup,LAB_SHA} from './r4-runtime-fixture.mjs';
import {admitAttempt,checkpointAttempt,createAttemptBarrier,alignIdentityEnvironment,revokeStartPermit} from '../scripts/deployment-controller.mjs';
import {readLatestCheckpoint} from '../scripts/deployment-attempt.mjs';
assert.equal(hostname(),'lima-servora-r4-20261012');assert.equal(process.getuid(),0);
const faults={
 interleaved:"UPDATE schema_migrations SET applied_at=TIMESTAMPTZ '2026-01-01' - substring(version,1,3)::int * INTERVAL '1 hour'",
 equal:"UPDATE schema_migrations SET applied_at=TIMESTAMPTZ '2026-01-01'",
 missing:"DELETE FROM schema_migrations WHERE version LIKE '017_%'",
 branch:"UPDATE schema_migrations SET version='055_alternative_branch' WHERE version LIKE '055_%'",
 future:"INSERT INTO schema_migrations(version) VALUES ('057_synthetic_future')",
 duplicate:"INSERT INTO schema_migrations(version) VALUES ('056_duplicate_number')",
 invalid:"INSERT INTO schema_migrations(version) VALUES ('invalid_version')",
 empty:"DELETE FROM schema_migrations",
};
for(const [name,sql] of Object.entries(faults)) test('full real history '+name+' is '+(['interleaved','equal'].includes(name)?'accepted':'refused before host mutation'),()=>{
 const env='/etc/servora-med/servora-med.env',barrier='/var/lib/servora-med/deploy/activation.block',pointer='/opt/servora-med/current';
 const saved={env:readFileSync(env,'utf8'),barrier:readFileSync(barrier),pointer:readlinkSync(pointer)};
 const db='servora_med_test_r4_history_'+randomUUID().replaceAll('-','');
 assert.equal(spawnSync('/usr/bin/sudo',['-u','postgres','--','/usr/bin/createdb','--template=servora_med_test_r4_host',db],{encoding:'utf8'}).status,0);
 const lines=saved.env.split('\n'),url=new URL(lines.find(line=>line.startsWith('DATABASE_URL=')).slice(13));url.pathname='/'+db;
 writeFileSync(env,lines.map(line=>line.startsWith('DATABASE_URL=')?'DATABASE_URL='+url.toString():line).join('\n'));
 try {
  withRuntimeFixture(grant=>{
   admitAttempt(grant.attemptId);prepareRealBackup(grant);unlinkSync(barrier);createAttemptBarrier(grant.attemptId);checkpointAttempt(grant.attemptId,'FENCED');
   writeFileSync(env,alignIdentityEnvironment(readFileSync(env,'utf8'),grant.oldCatalog.at(-1).version,grant.oldReleaseSha));
   unlinkSync(pointer);symlinkSync('/opt/servora-med/releases/'+grant.oldReleaseSha,pointer);
   const mutation=spawnSync('/usr/bin/sudo',['-u','servora-med','--','/usr/bin/node','--env-file='+env,'--input-type=module','-e',
    `import {createRequire} from 'node:module';const {Client}=createRequire('/opt/servora-med/releases/${LAB_SHA}/server/package.json')('pg');const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();await c.query(process.argv[1]);console.log('DISPOSABLE_HISTORY_FIXTURE='+JSON.stringify((await c.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(r=>r.version)));await c.end();`,sql],{encoding:'utf8',timeout:10000});
   assert.equal(mutation.status,0,mutation.stderr);console.log('DATABASE='+db+' '+mutation.stdout.trim());
   const before={env:readFileSync(env),pointer:readlinkSync(pointer),journal:readLatestCheckpoint(grant.attemptId)};
   const result=spawnSync('/usr/local/libexec/servora-med/deploy-production-host',['--phase','forward-recovery','--attempt-id',grant.attemptId],{encoding:'utf8',timeout:90000});
   if(['interleaved','equal'].includes(name)) {assert.equal(result.status,0,result.stdout+result.stderr);assert.equal(readLatestCheckpoint(grant.attemptId).record.starts,1);}
   else {assert.notEqual(result.status,0);assert.match(result.stderr,/RECOVERY_DATABASE_NOT_EXACT/);assert.deepEqual(readFileSync(env),before.env);assert.equal(readlinkSync(pointer),before.pointer);assert.deepEqual(readLatestCheckpoint(grant.attemptId),before.journal);}
   console.log('HISTORY_'+name.toUpperCase()+'=PASS');
  });
 } finally {
  spawnSync('/usr/bin/systemctl',['stop','servora-med.service']);
  writeFileSync(env,saved.env);unlinkSync(pointer);symlinkSync(saved.pointer,pointer);writeFileSync(barrier,saved.barrier);
 }
});
