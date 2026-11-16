// Negative and fault-injection coverage for the atomic profile re-seal.
// Every case is synthetic and fail-closed: no production dump, approval,
// secret or profile is used.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import fsDefault from 'node:fs';
import path from 'node:path';
import {validateHostProfile} from '../scripts/deployment-attempt.mjs';
import {validateDatabaseIdentity} from '../scripts/deployment-db-guard.mjs';
import {environmentBaseline} from '../scripts/deployment-controller.mjs';
import {
  readHistoricalStageReceipt,verifyHistoricalStageReadback
} from '../scripts/historical-recovery-evidence.mjs';
import {timeEvidenceAt} from '../tests/trusted-time-fixture.mjs';
import {createFixture} from './profile-reseal-fixture.mjs';
import {resealProfile} from './profile-reseal.mjs';

const depsFor=(fixture,overrides={})=>({
  uid:fixture.uid,
  gid:fixture.gid,
  validateHostProfile,
  validateDatabaseIdentity,
  environmentBaseline,
  sampleTrustedTime:()=>timeEvidenceAt(),
  readDatabaseIdentity:()=>fixture.profile.databaseIdentity,
  // The production verifier is required; tests inject a deterministic accepted result.
  verifyHistoricalPreservation:()=>({status:'IN_PLACE_PRESERVATION_VERIFIED'}),
  readStageReceipt:readHistoricalStageReceipt,
  verifyStageReadback:verifyHistoricalStageReadback,
  assertLock:()=>{},
  ...overrides
});
const apply=(fixture,overrides={},hooks={})=>resealProfile({
  mode:'apply',expectedOld:fixture.oldProfileSha256,
  expectedCandidate:fixture.expectedCandidate,paths:fixture.paths,
  deps:depsFor(fixture,{...overrides,hooks})
});
const tempFiles=fixture=>fs.readdirSync(fixture.paths.stateRoot)
  .filter(name=>name.startsWith('.profile.json.')&&name.endsWith('.tmp'));
const assertUnchanged=(fixture)=>{
  assert.equal(fs.readFileSync(fixture.paths.profileFile).equals(fixture.profileBytes),true);
  assert.deepEqual(tempFiles(fixture),[]);
};

test('a pending active.json fails closed',async t=>{
  const fixture=createFixture();
  t.after(fixture.cleanup);
  fs.writeFileSync(fixture.paths.pendingMarkers[0],'pending\n');
  assert.throws(()=>apply(fixture),/PROFILE_RESEAL_PENDING_STATE/);
  assertUnchanged(fixture);
});

test('a reserved initialization fails closed',async t=>{
  const fixture=createFixture();
  t.after(fixture.cleanup);
  fs.writeFileSync(path.join(fixture.paths.initializationsDir,'reserved.json'),'{}\n');
  assert.throws(()=>apply(fixture),/PROFILE_RESEAL_PENDING_STATE/);
  assertUnchanged(fixture);
});

test('TT-A UNKNOWN aborts before any write',async t=>{
  const fixture=createFixture();
  t.after(fixture.cleanup);
  assert.throws(()=>apply(fixture,{sampleTrustedTime:()=>{throw new Error('TRUSTED_TIME_UNKNOWN');}}),
    /TRUSTED_TIME_UNKNOWN/);
  assertUnchanged(fixture);
});

test('a legacy v1 time evidence object is rejected',async t=>{
  const fixture=createFixture();
  t.after(fixture.cleanup);
  assert.throws(()=>apply(fixture,{sampleTrustedTime:()=>timeEvidenceAt(undefined,{formatVersion:1})}),
    /PROFILE_RESEAL_TIME_INVALID/);
  assertUnchanged(fixture);
});

test('a changed env file is rejected',async t=>{
  const fixture=createFixture();
  t.after(fixture.cleanup);
  fs.writeFileSync(fixture.paths.envFile,fs.readFileSync(fixture.paths.envFile,'utf8')
    .replace('PORT=3000','PORT=3001'));
  assert.throws(()=>apply(fixture),/PROFILE_RESEAL_ENV_MISMATCH/);
  assertUnchanged(fixture);
});

test('a changed machine id is rejected',async t=>{
  const fixture=createFixture();
  t.after(fixture.cleanup);
  fs.writeFileSync(fixture.paths.machineIdFile,'b'.repeat(32)+'\n');
  assert.throws(()=>apply(fixture),/PROFILE_RESEAL_MACHINE_MISMATCH/);
  assertUnchanged(fixture);
});

test('a changed database cluster identity is rejected',async t=>{
  const fixture=createFixture();
  t.after(fixture.cleanup);
  assert.throws(()=>apply(fixture,{readDatabaseIdentity:()=>({
    ...fixture.profile.databaseIdentity,clusterId:'2'})}),
  /PROFILE_RESEAL_DATABASE_MISMATCH/);
  assertUnchanged(fixture);
});

test('a disposition that does not bind the old profile is rejected',async t=>{
  const fixture=createFixture();
  t.after(fixture.cleanup);
  const bad={...fixture.disposition,profileSha256:'f'.repeat(64)};
  fs.writeFileSync(fixture.paths.dispositionFile,JSON.stringify(bad)+'\n');
  assert.throws(()=>apply(fixture),/PROFILE_RESEAL_DISPOSITION_INVALID/);
  assertUnchanged(fixture);
});

test('a stage receipt that does not bind the old profile is rejected',async t=>{
  const fixture=createFixture();
  t.after(fixture.cleanup);
  const bad={...fixture.receipt,profileSha256:'f'.repeat(64)};
  fs.writeFileSync(fixture.paths.receiptFile,JSON.stringify(bad)+'\n');
  assert.throws(()=>apply(fixture),/PROFILE_RESEAL_STAGE_INVALID/);
  assertUnchanged(fixture);
});

test('a tampered staged file is rejected by the 28-file readback',async t=>{
  const fixture=createFixture();
  t.after(fixture.cleanup);
  const rel=fixture.stagedEntries[0].archivePath;
  fs.appendFileSync(path.join(fixture.paths.stagingDir,rel),'tampered\n');
  assert.throws(()=>apply(fixture),/PROFILE_RESEAL_STAGE_INVALID/);
  assertUnchanged(fixture);
});

test('missing historical verifier fails closed before any profile write',async t=>{
  for(const absent of [undefined,null]){
    const fixture=createFixture();
    t.after(fixture.cleanup);
    assert.throws(()=>apply(fixture,{verifyHistoricalPreservation:absent}),
      /PROFILE_RESEAL_HISTORICAL_INVALID/);
    assertUnchanged(fixture);
  }
});

test('a failing historical gate aborts before any write',async t=>{
  const fixture=createFixture();
  t.after(fixture.cleanup);
  assert.throws(()=>apply(fixture,{verifyHistoricalPreservation:()=>({status:'X'})}),
    /PROFILE_RESEAL_HISTORICAL_INVALID/);
  assertUnchanged(fixture);
});

test('the historical gate is checked before and after the atomic write',async t=>{
  const fixture=createFixture();
  t.after(fixture.cleanup);
  let calls=0;
  const result=apply(fixture,{verifyHistoricalPreservation:()=>{
    calls+=1;return {status:'IN_PLACE_PRESERVATION_VERIFIED'};
  }});
  assert.equal(result.status,'PROFILE_RESEALED');
  assert.equal(calls,2);
  assert.deepEqual(fixture.snapshot(),fixture.before);
  assert.equal(fs.readFileSync(fixture.paths.profileFile).toString(),
    JSON.stringify(fixture.expectedProfile)+'\n');
});

for(const [name,hook] of [
  ['beforeTempWrite',{beforeTempWrite:()=>{throw Object.assign(new Error('ENOSPC'),{code:'ENOSPC'});}}],
  ['afterTempWrite',{afterTempWrite:()=>{throw Object.assign(new Error('EIO'),{code:'EIO'});}}],
  ['afterTempFsync',{afterTempFsync:()=>{throw Object.assign(new Error('EIO'),{code:'EIO'});}}],
  ['beforeRename',{beforeRename:()=>{throw Object.assign(new Error('EIO'),{code:'EIO'});}}]
]){
  test(`${name} failure leaves the old profile and removes only the temp file`,async t=>{
    const fixture=createFixture();
    t.after(fixture.cleanup);
    assert.throws(()=>apply(fixture,{},hook),/ENOSPC|EIO/);
    assertUnchanged(fixture);
  });
}

for(const [name,hook] of [
  ['afterRename',{afterRename:()=>{throw Object.assign(new Error('EIO'),{code:'EIO'});}}],
  ['beforeDirFsync',{beforeDirFsync:()=>{throw Object.assign(new Error('EIO'),{code:'EIO'});}}],
  ['afterDirFsync',{afterDirFsync:()=>{throw Object.assign(new Error('EIO'),{code:'EIO'});}}]
]){
  test(`${name} interruption leaves the new profile and never repairs it`,async t=>{
    const fixture=createFixture();
    t.after(fixture.cleanup);
    assert.throws(()=>apply(fixture,{},hook),/EIO/);
    assert.equal(fs.readFileSync(fixture.paths.profileFile).toString(),
      JSON.stringify(fixture.expectedProfile)+'\n');
    assert.deepEqual(tempFiles(fixture),[]);
  });
}

test('a post-rename readback failure stops without rollback or a second write',async t=>{
  const fixture=createFixture();
  t.after(fixture.cleanup);
  let failRead=false;
  const proxy=new Proxy(fsDefault,{get(target,property){
    if(property==='readFileSync')return (...args)=>{
      if(failRead)throw Object.assign(new Error('EIO'),{code:'EIO'});
      return target.readFileSync(...args);
    };
    return target[property];
  }});
  assert.throws(()=>apply(fixture,{fs:proxy},{afterRename:()=>{failRead=true;}}),
    /PROFILE_RESEAL_READBACK_INVALID/);
  assert.equal(fs.readFileSync(fixture.paths.profileFile).toString(),
    JSON.stringify(fixture.expectedProfile)+'\n');
  assert.deepEqual(tempFiles(fixture),[]);
});

test('a wrong profile mode is rejected',async t=>{
  const fixture=createFixture();
  t.after(fixture.cleanup);
  fs.chmodSync(fixture.paths.profileFile,0o640);
  assert.throws(()=>apply(fixture),/PROFILE_RESEAL_PROFILE_UNTRUSTED/);
  assertUnchanged(fixture);
});

test('a contract path below a plain file is rejected (ENOTDIR)',async t=>{
  const fixture=createFixture();
  t.after(fixture.cleanup);
  const blocker=path.join(fixture.root,'not-a-directory');
  fs.writeFileSync(blocker,'x');
  fixture.paths.contractSpecs=[
    ...fixture.paths.contractSpecs.slice(0,-1),
    {key:'timeConfigSha256',path:path.join(blocker,'chrony.conf'),mode:0o644}
  ];
  assert.throws(()=>apply(fixture),/PROFILE_RESEAL_CONTRACT_UNTRUSTED/);
  assertUnchanged(fixture);
});

test('an EACCES contract read is rejected',async t=>{
  const fixture=createFixture();
  t.after(fixture.cleanup);
  const denied=fixture.paths.contractSpecs.find(spec=>spec.key==='helperSha256').path;
  const proxy=new Proxy(fsDefault,{get(target,property){
    if(property==='openSync')return (file,...args)=>{
      if(file===denied)throw Object.assign(new Error('EACCES'),{code:'EACCES'});
      return target.openSync(file,...args);
    };
    return target[property];
  }});
  assert.throws(()=>apply(fixture,{fs:proxy}),/PROFILE_RESEAL_CONTRACT_UNTRUSTED/);
  assertUnchanged(fixture);
});

test('a foreign-owned contract is rejected',{skip:process.getuid()!==0},async t=>{
  const fixture=createFixture();
  t.after(fixture.cleanup);
  const spec=fixture.paths.contractSpecs.find(item=>item.key==='controllerModuleSha256');
  fs.chownSync(spec.path,65534,fixture.gid);
  assert.throws(()=>apply(fixture),/PROFILE_RESEAL_CONTRACT_UNTRUSTED/);
  assertUnchanged(fixture);
});

test('a foreign-owned profile is rejected',{skip:process.getuid()!==0},async t=>{
  const fixture=createFixture();
  t.after(fixture.cleanup);
  fs.chownSync(fixture.paths.profileFile,65534,fixture.gid);
  assert.throws(()=>apply(fixture),/PROFILE_RESEAL_PROFILE_UNTRUSTED/);
});
