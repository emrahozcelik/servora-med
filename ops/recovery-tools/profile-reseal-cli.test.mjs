// CLI and production DB adapter coverage. The runCli happy path is root-only
// and runs in the disposable Linux container.
import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {validateHostProfile} from '../scripts/deployment-attempt.mjs';
import {validateDatabaseIdentity} from '../scripts/deployment-db-guard.mjs';
import {environmentBaseline} from '../scripts/deployment-controller.mjs';
import {
  readHistoricalStageReceipt,verifyHistoricalStageReadback
} from '../scripts/historical-recovery-evidence.mjs';
import {timeEvidenceAt} from '../tests/trusted-time-fixture.mjs';
import {createFixture} from './profile-reseal-fixture.mjs';
import {readProductionDatabaseIdentity,runCli} from './profile-reseal.mjs';

const depsFor=(fixture)=>({
  uid:fixture.uid,gid:fixture.gid,
  validateHostProfile,validateDatabaseIdentity,environmentBaseline,
  sampleTrustedTime:()=>timeEvidenceAt(),
  readDatabaseIdentity:()=>fixture.profile.databaseIdentity,
  readStageReceipt:readHistoricalStageReceipt,
  verifyStageReadback:verifyHistoricalStageReadback,
  assertLock:()=>{}
});

test('the wrapper pins the reviewed module bytes',()=>{
  const wrapper=readFileSync(new URL('./profile-reseal',import.meta.url),'utf8');
  const pinned=wrapper.match(/readonly MODULE_SHA256=([0-9a-f]{64})/);
  assert.ok(pinned,'wrapper must pin the module');
  assert.equal(pinned[1],createHash('sha256')
    .update(readFileSync(new URL('./profile-reseal.mjs',import.meta.url))).digest('hex'));
});

test('the production DB adapter is fixed, read-only and secret-free',()=>{
  let call;
  const identity={clusterId:'123',databaseName:'servora_med',databaseOid:'456',
    role:'servora',host:'127.0.0.1',port:5432};
  const result=readProductionDatabaseIdentity(identity,{exec:(file,args,options)=>{
    call={file,args,options};return '123|456\n';
  }});
  assert.deepEqual(result,{clusterId:'123',databaseOid:'456',databaseName:'servora_med'});
  assert.equal(call.file,'/usr/sbin/runuser');
  assert.deepEqual(call.args.slice(0,4),['-u','postgres','--','/usr/bin/psql']);
  assert.ok(call.args.includes('-d'));
  assert.ok(call.args.includes('servora_med'));
  assert.equal(call.args.some(arg=>/password|DATABASE_URL|secret/i.test(arg)),false);
  assert.equal(JSON.stringify(call.options).includes('servora:synthetic'),false);
});

test('the production DB adapter fails closed on unavailable or malformed output',()=>{
  const identity={clusterId:'123',databaseName:'servora_med',databaseOid:'456',
    role:'servora',host:'127.0.0.1',port:5432};
  assert.throws(()=>readProductionDatabaseIdentity(identity,{exec:()=>{throw new Error('x');}}),
    /PROFILE_RESEAL_DATABASE_UNAVAILABLE/);
  assert.throws(()=>readProductionDatabaseIdentity(identity,{exec:()=>'not-a-number|456\n'}),
    /PROFILE_RESEAL_DATABASE_UNAVAILABLE/);
  assert.throws(()=>readProductionDatabaseIdentity({...identity,databaseName:'Bad-Name'},
    {exec:()=>'123|456\n'}),/PROFILE_RESEAL_DATABASE_MISMATCH/);
});

test('runCli rejects caller-selected paths and force flags',{skip:process.getuid()!==0},async()=>{
  await assert.rejects(()=>runCli(['--dry-run','--path','/tmp/profile.json']),
    /PROFILE_RESEAL_ARGUMENTS_INVALID/);
  await assert.rejects(()=>runCli(['--force']),/PROFILE_RESEAL_ARGUMENTS_INVALID/);
});

test('runCli wires the reviewed entrypoint to the fixed-path core',{skip:process.getuid()!==0},async t=>{
  const fixture=createFixture();
  t.after(fixture.cleanup);
  const result=await runCli(['--dry-run'],{paths:fixture.paths,deps:depsFor(fixture)});
  assert.equal(result.status,'DRY_RUN_OK');
  assert.equal(result.oldProfileSha256,fixture.oldProfileSha256);
  assert.equal(result.candidateProfileSha256,fixture.expectedCandidate);
});
