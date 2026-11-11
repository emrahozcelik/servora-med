// TDD suite for the root-only OPS-R4-002 atomic profile re-seal tool.
//
// All identities and bytes are synthetic. No production profile, approval,
// dump or secret is opened or copied. The suite is designed to run on Linux as
// an ordinary user and, for the root-only integration cases, inside a
// disposable root container.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {validateHostProfile} from '../scripts/deployment-attempt.mjs';
import {validateDatabaseIdentity} from '../scripts/deployment-db-guard.mjs';
import {environmentBaseline} from '../scripts/deployment-controller.mjs';
import {
  readHistoricalStageReceipt,verifyHistoricalStageReadback
} from '../scripts/historical-recovery-evidence.mjs';
import {timeEvidenceAt} from '../tests/trusted-time-fixture.mjs';
import {createFixture} from './profile-reseal-fixture.mjs';
import {parseArguments,resealProfile} from './profile-reseal.mjs';

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

const tempFiles=fixture=>fs.readdirSync(fixture.paths.stateRoot)
  .filter(name=>name.startsWith('.profile.json.')&&name.endsWith('.tmp'));

test('dry-run computes the measured candidate and writes nothing',async t=>{
  const fixture=createFixture();
  t.after(fixture.cleanup);
  const result=resealProfile({mode:'dry-run',expectedOld:fixture.oldProfileSha256,
    expectedCandidate:fixture.expectedCandidate,paths:fixture.paths,deps:depsFor(fixture)});
  assert.equal(result.status,'DRY_RUN_OK');
  assert.equal(result.oldProfileSha256,fixture.oldProfileSha256);
  assert.equal(result.candidateProfileSha256,fixture.expectedCandidate);
  assert.equal(fs.readFileSync(fixture.paths.profileFile).equals(fixture.profileBytes),true);
  assert.deepEqual(tempFiles(fixture),[]);
  assert.deepEqual(fixture.snapshot(),fixture.before);
});

test('apply atomically publishes the measured profile and preserves historical evidence',async t=>{
  const fixture=createFixture();
  t.after(fixture.cleanup);
  const result=resealProfile({mode:'apply',expectedOld:fixture.oldProfileSha256,
    expectedCandidate:fixture.expectedCandidate,paths:fixture.paths,deps:depsFor(fixture)});
  assert.equal(result.status,'PROFILE_RESEALED');
  assert.equal(result.newProfileSha256,fixture.expectedCandidate);
  const published=fs.readFileSync(fixture.paths.profileFile);
  assert.equal(published.toString(),JSON.stringify(fixture.expectedProfile)+'\n');
  assert.deepEqual(JSON.parse(published).contracts,fixture.liveContracts);
  const stat=fs.statSync(fixture.paths.profileFile);
  assert.equal(stat.uid,fixture.uid);
  assert.equal(stat.gid,fixture.gid);
  assert.equal(stat.mode&0o7777,0o600);
  assert.equal(stat.nlink,1);
  assert.deepEqual(tempFiles(fixture),[]);
  // The staged pre-reseal profile and every live historical byte stay intact.
  assert.deepEqual(fixture.snapshot(),fixture.before);
  assert.equal(fs.readFileSync(path.join(fixture.paths.stagingDir,'preserved/profile.json'))
    .equals(fixture.profileBytes),true);
});

test('the temp file is same-directory 0600 single-link and never survives apply',async t=>{
  const fixture=createFixture();
  t.after(fixture.cleanup);
  let observed=null;
  const result=resealProfile({mode:'apply',expectedOld:fixture.oldProfileSha256,
    expectedCandidate:fixture.expectedCandidate,paths:fixture.paths,
    deps:depsFor(fixture,{hooks:{afterTempFsync:()=>{
      const names=fs.readdirSync(fixture.paths.stateRoot)
        .filter(name=>name.startsWith('.profile.json.')&&name.endsWith('.tmp'));
      observed=names.map(name=>{
        const file=path.join(fixture.paths.stateRoot,name);
        const stat=fs.statSync(file);
        return {file,dir:path.dirname(file),mode:stat.mode&0o7777,nlink:stat.nlink};
      });
    }}})});
  assert.equal(result.status,'PROFILE_RESEALED');
  assert.equal(observed.length,1);
  assert.equal(observed[0].dir,fixture.paths.stateRoot);
  assert.equal(observed[0].mode,0o600);
  assert.equal(observed[0].nlink,1);
  assert.deepEqual(tempFiles(fixture),[]);
});

test('the CLI accepts only the two documented modes and rejects path/force selectors',()=>{
  assert.deepEqual(parseArguments(['--dry-run']),{mode:'dry-run'});
  assert.deepEqual(parseArguments(['--apply','--expected-old','a'.repeat(64),
    '--expected-candidate','b'.repeat(64)]),{mode:'apply',expectedOld:'a'.repeat(64),
    expectedCandidate:'b'.repeat(64)});
  for(const args of [[],['--dry-run','--path','/tmp/profile.json'],['--force'],
    ['--apply','--expected-old','a'.repeat(64)],
    ['--apply','--expected-old','a'.repeat(63),'--expected-candidate','b'.repeat(64)],
    ['--apply','--expected-old','A'.repeat(64),'--expected-candidate','b'.repeat(64)],
    ['--apply','--expected-old','a'.repeat(64),'--expected-candidate','b'.repeat(64),'extra']]){
    assert.throws(()=>parseArguments(args),/PROFILE_RESEAL_ARGUMENTS_INVALID/,args.join(' '));
  }
});

test('the production path is fixed and contains no caller-selectable profile path',async()=>{
  const module=await import('./profile-reseal.mjs');
  assert.equal(module.PRODUCTION_PATHS.profileFile,'/var/lib/servora-med/deploy/profile.json');
  assert.equal(module.PRODUCTION_PATHS.stateRoot,'/var/lib/servora-med/deploy');
  assert.equal(module.PRODUCTION_PATHS.attemptId,'6ce4cff0-fa73-450e-b540-3f54ae429e7c');
});

test('an old profile CAS mismatch is rejected before any write',async t=>{
  const fixture=createFixture();
  t.after(fixture.cleanup);
  assert.throws(()=>resealProfile({mode:'apply',expectedOld:'f'.repeat(64),
    expectedCandidate:fixture.expectedCandidate,paths:fixture.paths,deps:depsFor(fixture)}),
  /PROFILE_RESEAL_OLD_MISMATCH/);
  assert.equal(fs.readFileSync(fixture.paths.profileFile).equals(fixture.profileBytes),true);
  assert.deepEqual(tempFiles(fixture),[]);
});

test('a wrong expected candidate is rejected before any write',async t=>{
  const fixture=createFixture();
  t.after(fixture.cleanup);
  assert.throws(()=>resealProfile({mode:'apply',expectedOld:fixture.oldProfileSha256,
    expectedCandidate:'f'.repeat(64),paths:fixture.paths,deps:depsFor(fixture)}),
  /PROFILE_RESEAL_CANDIDATE_MISMATCH/);
  assert.equal(fs.readFileSync(fixture.paths.profileFile).equals(fixture.profileBytes),true);
  assert.deepEqual(tempFiles(fixture),[]);
});

test('a contract hash drift is rejected and never changes the profile',async t=>{
  const fixture=createFixture();
  t.after(fixture.cleanup);
  const spec=fixture.paths.contractSpecs.find(item=>item.key==='controllerModuleSha256');
  fs.writeFileSync(spec.path,'tampered\n');
  assert.throws(()=>resealProfile({mode:'dry-run',expectedOld:fixture.oldProfileSha256,
    expectedCandidate:fixture.expectedCandidate,paths:fixture.paths,deps:depsFor(fixture)}),
  /PROFILE_RESEAL_CONTRACT|PROFILE_RESEAL_CANDIDATE_MISMATCH/);
  assert.equal(fs.readFileSync(fixture.paths.profileFile).equals(fixture.profileBytes),true);
});

test('a contract mode drift is rejected',async t=>{
  const fixture=createFixture();
  t.after(fixture.cleanup);
  const spec=fixture.paths.contractSpecs.find(item=>item.key==='timeModuleSha256');
  fs.chmodSync(spec.path,0o600);
  assert.throws(()=>resealProfile({mode:'dry-run',expectedOld:fixture.oldProfileSha256,
    expectedCandidate:fixture.expectedCandidate,paths:fixture.paths,deps:depsFor(fixture)}),
  /PROFILE_RESEAL_CONTRACT/);
});

test('a symlinked contract is rejected',async t=>{
  const fixture=createFixture();
  t.after(fixture.cleanup);
  const spec=fixture.paths.contractSpecs.find(item=>item.key==='helperSha256');
  const target=spec.path+'.real';
  fs.renameSync(spec.path,target);
  fs.symlinkSync(target,spec.path);
  assert.throws(()=>resealProfile({mode:'dry-run',expectedOld:fixture.oldProfileSha256,
    expectedCandidate:fixture.expectedCandidate,paths:fixture.paths,deps:depsFor(fixture)}),
  /PROFILE_RESEAL_CONTRACT/);
});

test('a hardlinked contract is rejected',async t=>{
  const fixture=createFixture();
  t.after(fixture.cleanup);
  const spec=fixture.paths.contractSpecs.find(item=>item.key==='unitSha256');
  fs.linkSync(spec.path,spec.path+'.link');
  assert.throws(()=>resealProfile({mode:'dry-run',expectedOld:fixture.oldProfileSha256,
    expectedCandidate:fixture.expectedCandidate,paths:fixture.paths,deps:depsFor(fixture)}),
  /PROFILE_RESEAL_CONTRACT/);
});

test('a symlinked old profile is rejected',async t=>{
  const fixture=createFixture();
  t.after(fixture.cleanup);
  fs.renameSync(fixture.paths.profileFile,fixture.paths.profileFile+'.real');
  fs.symlinkSync(fixture.paths.profileFile+'.real',fixture.paths.profileFile);
  assert.throws(()=>resealProfile({mode:'dry-run',expectedOld:fixture.oldProfileSha256,
    expectedCandidate:fixture.expectedCandidate,paths:fixture.paths,deps:depsFor(fixture)}),
  /PROFILE_RESEAL_PROFILE_UNTRUSTED/);
});
