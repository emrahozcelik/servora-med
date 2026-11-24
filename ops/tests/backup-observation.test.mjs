import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs,{mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync,readdirSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {timeEvidenceAt} from './trusted-time-fixture.mjs';
import {publishObservation,TRUSTED_TIME_RETRY_DELAYS_MS} from '../scripts/backup-observation-writer.mjs';
import {parseBackupObservationState} from '../scripts/backup-observation.mjs';
const legacySample=(ms=0)=>({formatVersion:1,source:'linux-boottime',bootId:'11111111-1111-4111-8111-111111111111',
  timeNamespaceId:'time:[4026531834]',bootLowerMs:100000+ms,bootUpperMs:100000+ms,
  wallAtUTC:new Date(Date.parse('2026-10-27T09:00:00Z')+ms).toISOString(),wallResolutionMs:1,
  synchronization:{service:'chrony',referenceAgeMs:1,rootDistanceMs:1,correctionMs:0,sourceCount:2}});
const sample=(ms=0)=>timeEvidenceAt(Date.parse('2026-10-27T09:00:00Z')+ms);
// Records retry waits instead of sleeping; captures the operator-facing warning.
const retryRecorder=()=>{const r={sleeps:[],warnings:[]};r.options={sleep:ms=>r.sleeps.push(ms),warn:line=>r.warnings.push(line)};return r;};
const unknown=()=>{throw new Error('TRUSTED_TIME_UNKNOWN');};
const sequence=(...samplers)=>{let index=0;const calls=()=>index;const read=()=>samplers[Math.min(index++,samplers.length-1)]();return Object.assign(read,{calls});};
test('TT-B producer binds the original event interval to the actual artifact and sidecar',()=>{
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'ttb-writer-')));
  try {
    const statePath=join(dir,'observation-v1.json'),artifactPath=join(dir,'backup.dump'),sidecarPath=artifactPath+'.sha256';
    const digest=createHash('sha256').update('actual backup').digest('hex');
    const base={statePath,trigger:'scheduled',startedAt:'2026-10-27T09:00:00Z'};
    publishObservation({...base,outcome:'running'},()=>sample());
    writeFileSync(artifactPath,'actual backup',{mode:0o600});writeFileSync(sidecarPath,`${digest}  backup.dump\n`,{mode:0o600});
    publishObservation({...base,outcome:'success',artifactPath,sidecarPath},()=>sample(1000));
    const raw=JSON.parse(readFileSync(statePath,'utf8')),state=parseBackupObservationState(raw);
    assert.equal(raw.schemaVersion,2);assert.ok(state);
    assert.equal(state.latestVerifiedSuccess.proof.artifactSha256,digest);
    assert.deepEqual(state.latestVerifiedSuccess.proof.before,sample());
    assert.deepEqual(state.latestVerifiedSuccess.proof.after,sample(1000));
    assert.deepEqual(state.latestScheduledVerifiedSuccess,state.latestVerifiedSuccess);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

function fixture(run) {
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'ttb-writer-')));
  try {
    const statePath=join(dir,'observation-v1.json'),artifactPath=join(dir,'backup.dump');
    const base={statePath,trigger:'scheduled',startedAt:'2026-10-27T09:00:00Z'};
    const bytes=Buffer.from('actual backup'),digest=createHash('sha256').update(bytes).digest('hex');
    writeFileSync(artifactPath,bytes,{mode:0o600});writeFileSync(artifactPath+'.sha256',`${digest}  backup.dump\n`,{mode:0o600});
    const success=(input=base,clock=()=>sample(1000))=>publishObservation({...input,outcome:'success',artifactPath,sidecarPath:artifactPath+'.sha256'},clock);
    run({dir,base,statePath,artifactPath,success});
  } finally {rmSync(dir,{recursive:true,force:true});}
}
test('TT-B duplicate success preserves original time, id and bytes; changed artifact is denied',()=>fixture(({base,statePath,artifactPath,success})=>{
  publishObservation({...base,outcome:'running'},()=>sample());success();
  const original=readFileSync(statePath,'utf8');
  success(base,()=>{throw new Error('must not resample');});assert.equal(readFileSync(statePath,'utf8'),original);
  writeFileSync(artifactPath,'corrupt');assert.throws(()=>success());assert.equal(readFileSync(statePath,'utf8'),original);
}));
test('TT-B fsync failure before rename preserves prior state; directory fsync failure is reported',()=>fixture(({base,statePath})=>{
  publishObservation({...base,outcome:'running'},()=>sample());
  const original=readFileSync(statePath,'utf8'),fsync=fs.fsyncSync;
  try {
    fs.fsyncSync=()=>{throw new Error('EIO');};syncBuiltinESMExports();
    assert.throws(()=>publishObservation({...base,trigger:'manual',startedAt:'2026-10-27T09:01:00Z',outcome:'running'},()=>sample(60000)));
    assert.equal(readFileSync(statePath,'utf8'),original);
    fs.fsyncSync=fd=>{if(fs.fstatSync(fd).isDirectory())throw new Error('EIO');return fsync(fd);};syncBuiltinESMExports();
    assert.throws(()=>publishObservation({...base,trigger:'manual',startedAt:'2026-10-27T09:01:00Z',outcome:'running'},()=>sample(60000)));
    assert.ok(parseBackupObservationState(JSON.parse(readFileSync(statePath,'utf8'))));
    assert.equal(readdirSync(join(statePath,'..')).filter(name=>name.includes('.tmp.')).length,0);
  } finally {fs.fsyncSync=fsync;syncBuiltinESMExports();}
}));
test('TT-B v1 migration archives exact history and keeps the established scheduled baseline unknown',()=>fixture(({dir,base,statePath,success})=>{
  const at=base.startedAt,legacy={schemaVersion:1,updatedAt:at,latestAttemptTrigger:'scheduled',latestAttemptStartedAt:at,
    latestAttemptCompletedAt:at,latestAttemptResult:'success',latestAttemptFailureClass:null,latestVerifiedAt:at,
    latestVerifiedTrigger:'scheduled',latestScheduledAttemptStartedAt:at,latestScheduledAttemptCompletedAt:at,
    latestScheduledAttemptResult:'success',latestScheduledAttemptFailureClass:null,latestScheduledVerifiedAt:at};
  const original=JSON.stringify(legacy,null,2)+'\n';writeFileSync(statePath,original,{mode:0o600});
  const manual={...base,trigger:'manual',startedAt:'2026-10-27T09:01:00Z'};
  publishObservation({...manual,outcome:'running'},()=>sample(60000));success(manual,()=>sample(61000));
  const raw=JSON.parse(readFileSync(statePath,'utf8'));
  assert.equal(raw.scheduledBaselineEstablished,true);assert.equal(raw.latestScheduledVerifiedAt,at);
  assert.equal(raw.latestScheduledVerifiedProof,null);assert.ok(raw.latestVerifiedProof);
  const archive=readdirSync(dir).find(name=>name.includes('.legacy-'));
  assert.ok(archive);assert.equal(readFileSync(join(dir,archive),'utf8'),original);
}));
test('TT-B CLI rejects caller clocks and invalid argument combinations',()=>fixture(({base,statePath})=>{
  const cli=fileURLToPath(new URL('../scripts/backup-observation.sh',import.meta.url));
  for(const extra of [['--now','123'],['--completed-at',base.startedAt]]) {
    const result=spawnSync('bash',[cli,'--state',statePath,'--trigger','manual','--started-at',base.startedAt,'--outcome','running',...extra],{encoding:'utf8'});
    assert.equal(result.status,64);
  }
  assert.equal(readdirSync(join(statePath,'..')).includes('observation-v1.json'),false);
}));
test('TT-B manual/running/failed attempts preserve scheduled proof and prior success',()=>fixture(({base,statePath,success})=>{
  publishObservation({...base,outcome:'running'},()=>sample());success();
  const original=JSON.parse(readFileSync(statePath,'utf8'));
  const manual={...base,trigger:'manual',startedAt:'2026-10-27T09:01:00Z'};
  publishObservation({...manual,outcome:'running'},()=>sample(60000));success(manual,()=>sample(61000));
  const manualState=JSON.parse(readFileSync(statePath,'utf8'));
  assert.deepEqual(manualState.latestScheduledVerifiedProof,original.latestScheduledVerifiedProof);
  publishObservation({...base,startedAt:'2026-10-27T09:02:00Z',outcome:'running'},()=>sample(120000));
  publishObservation({...base,startedAt:'2026-10-27T09:02:00Z',outcome:'failure',completedAt:'2026-10-27T09:02:01Z',failureClass:'DUMP_FAILED'});
  const failed=JSON.parse(readFileSync(statePath,'utf8'));
  assert.equal(failed.latestAttemptResult,'failure');assert.deepEqual(failed.latestVerifiedProof,manualState.latestVerifiedProof);
  assert.deepEqual(failed.latestScheduledVerifiedProof,original.latestScheduledVerifiedProof);
}));
test('TT-B missing synchronization retains integrity success with no new freshness proof',()=>fixture(({base,statePath,success})=>{
  const retry=retryRecorder();
  publishObservation({...base,outcome:'running'},unknown,retry.options);
  success(base,()=>sample(1000));
  assert.deepEqual(retry.sleeps,[...TRUSTED_TIME_RETRY_DELAYS_MS]);
  const raw=JSON.parse(readFileSync(statePath,'utf8'));
  assert.equal(raw.latestAttemptResult,'success');assert.equal(raw.latestVerifiedProof,null);
  assert.equal(raw.latestScheduledVerifiedProof,null);assert.equal(raw.scheduledBaselineEstablished,true);
}));
test('TT-B malformed prior state is never overwritten; temp residues are not canonical',()=>fixture(({dir,base,statePath})=>{
  writeFileSync(statePath,'{"schemaVersion":99}',{mode:0o600});
  assert.throws(()=>publishObservation({...base,outcome:'running'},()=>sample()));
  assert.equal(readFileSync(statePath,'utf8'),'{"schemaVersion":99}');
  rmSync(statePath);writeFileSync(join(dir,'.observation-v1.json.tmp.foreign'),'partial');
  publishObservation({...base,outcome:'running'},()=>sample());
  assert.ok(parseBackupObservationState(JSON.parse(readFileSync(statePath,'utf8'))));
  assert.equal(readFileSync(join(dir,'.observation-v1.json.tmp.foreign'),'utf8'),'partial');
}));

test('TT-B artifact/sidecar mismatch, symlink and unsafe permissions never publish a success',()=>fixture(({base,statePath,artifactPath,success})=>{
  publishObservation({...base,outcome:'running'},()=>sample());
  const original=readFileSync(statePath,'utf8'),sidecar=artifactPath+'.sha256',bytes=readFileSync(sidecar);
  writeFileSync(sidecar,'0'.repeat(64)+'  backup.dump\n');
  assert.throws(()=>success());assert.equal(readFileSync(statePath,'utf8'),original);
  writeFileSync(sidecar,bytes);fs.chmodSync(artifactPath,0o644);
  assert.throws(()=>success());assert.equal(readFileSync(statePath,'utf8'),original);
  fs.chmodSync(artifactPath,0o600);fs.renameSync(sidecar,sidecar+'.original');fs.symlinkSync(sidecar+'.original',sidecar);
  assert.throws(()=>success());assert.equal(readFileSync(statePath,'utf8'),original);
}));

test('TT-B contradictory v1 scheduled success cannot erase an established baseline during migration',()=>fixture(({base,statePath})=>{
  const at=base.startedAt,legacy={schemaVersion:1,updatedAt:at,latestAttemptTrigger:'scheduled',latestAttemptStartedAt:at,
    latestAttemptCompletedAt:at,latestAttemptResult:'success',latestAttemptFailureClass:null,latestVerifiedAt:at,
    latestVerifiedTrigger:'scheduled',latestScheduledAttemptStartedAt:at,latestScheduledAttemptCompletedAt:at,
    latestScheduledAttemptResult:'success',latestScheduledAttemptFailureClass:null,latestScheduledVerifiedAt:null};
  const bytes=JSON.stringify(legacy);writeFileSync(statePath,bytes,{mode:0o600});
  assert.equal(parseBackupObservationState(legacy),null);
  assert.throws(()=>publishObservation({...base,trigger:'manual',startedAt:'2026-10-27T09:01:00Z',outcome:'running'},()=>sample(60000)));
  assert.equal(readFileSync(statePath,'utf8'),bytes);
}));

test('OPS-TT-003: a legacy sampler cannot mint new backup event freshness',()=>fixture(({base,statePath,success})=>{
  const retry=retryRecorder();
  publishObservation({...base,outcome:'running'},()=>legacySample(),retry.options);
  success(base,()=>legacySample(1000));
  assert.equal(retry.warnings.length,1);
  const raw=JSON.parse(readFileSync(statePath,'utf8'));
  assert.equal(raw.latestAttemptTime,null);
  assert.equal(raw.latestVerifiedProof,null);
}));

test('OPS-TT-003: a new event preserves legacy nested scheduled proof bytes without promoting them',()=>fixture(({base,statePath,success})=>{
  publishObservation({...base,outcome:'running'},()=>sample());success();
  const old=JSON.parse(readFileSync(statePath,'utf8'));
  old.latestVerifiedProof.before=legacySample();old.latestVerifiedProof.after=legacySample(1000);
  old.latestScheduledVerifiedProof=old.latestVerifiedProof;
  old.latestAttemptTime=old.latestVerifiedProof.before;old.latestScheduledAttemptTime=old.latestVerifiedProof.before;
  writeFileSync(statePath,JSON.stringify(old),{mode:0o600});
  const bytes=JSON.stringify(old.latestScheduledVerifiedProof);
  assert.ok(parseBackupObservationState(JSON.parse(readFileSync(statePath,'utf8'))));
  const manual={...base,trigger:'manual',startedAt:'2026-10-27T09:01:00Z'};
  publishObservation({...manual,outcome:'running'},()=>sample(60000));success(manual,()=>sample(61000));
  const next=JSON.parse(readFileSync(statePath,'utf8'));
  assert.equal(next.schemaVersion,2);assert.equal(next.latestVerifiedProof.after.formatVersion,2);
  assert.equal(next.latestScheduledVerifiedProof.after.formatVersion,1);
  assert.equal(JSON.stringify(next.latestScheduledVerifiedProof),bytes);
}));

test('TT-B transient trusted time: retry delays are bounded and span one minimum chrony poll',()=>{
  assert.deepEqual([...TRUSTED_TIME_RETRY_DELAYS_MS],[5000,20000,45000]);
  assert.ok(Object.isFrozen(TRUSTED_TIME_RETRY_DELAYS_MS));
  assert.ok(TRUSTED_TIME_RETRY_DELAYS_MS.reduce((a,b)=>a+b,0)>=64000);
});
test('TT-B transient trusted time: a transient before-sample miss is retried and still mints the full postdeploy proof',()=>fixture(({base,statePath,artifactPath})=>{
  const postdeploy={...base,trigger:'postdeploy'},retry=retryRecorder(),read=sequence(unknown,unknown,()=>sample());
  publishObservation({...postdeploy,outcome:'running'},read,retry.options);
  assert.equal(read.calls(),3);assert.deepEqual(retry.sleeps,[5000,20000]);assert.deepEqual(retry.warnings,[]);
  publishObservation({...postdeploy,outcome:'success',artifactPath,sidecarPath:artifactPath+'.sha256'},()=>sample(1000),retry.options);
  const raw=JSON.parse(readFileSync(statePath,'utf8'));
  assert.ok(parseBackupObservationState(raw));
  assert.equal(raw.latestVerifiedProof.trigger,'postdeploy');assert.equal(raw.latestVerifiedProof.attemptId,raw.latestAttemptId);
  assert.deepEqual(raw.latestVerifiedProof.before,sample());assert.deepEqual(raw.latestVerifiedProof.after,sample(1000));
  assert.equal(raw.latestVerifiedAt,raw.latestAttemptCompletedAt);
  assert.equal(raw.latestScheduledVerifiedProof,null);
}));
test('TT-B transient trusted time: a transient after-sample miss is retried before the proof is decided',()=>fixture(({base,statePath,artifactPath})=>{
  const postdeploy={...base,trigger:'postdeploy'},retry=retryRecorder();
  publishObservation({...postdeploy,outcome:'running'},()=>sample(),retry.options);
  const read=sequence(unknown,()=>sample(30000));
  publishObservation({...postdeploy,outcome:'success',artifactPath,sidecarPath:artifactPath+'.sha256'},read,retry.options);
  assert.equal(read.calls(),2);assert.deepEqual(retry.sleeps,[5000]);
  const raw=JSON.parse(readFileSync(statePath,'utf8'));
  assert.deepEqual(raw.latestVerifiedProof.after,sample(30000));
  assert.equal(raw.latestVerifiedAt,'2026-10-27T09:00:30Z');
}));
test('TT-B transient trusted time: a persistent miss stops after the bounded attempts, names TRUSTED_TIME_UNKNOWN and records no proof',()=>fixture(({base,statePath,artifactPath})=>{
  const postdeploy={...base,trigger:'postdeploy'},retry=retryRecorder(),read=sequence(unknown);
  publishObservation({...postdeploy,outcome:'running'},read,retry.options);
  assert.equal(read.calls(),TRUSTED_TIME_RETRY_DELAYS_MS.length+1);
  assert.deepEqual(retry.warnings,['backup-observation: TRUSTED_TIME_UNKNOWN sample=before attempts=4; freshness proof not recorded\n']);
  // No before sample means no proof is possible: the after sample is taken once, never retried.
  const after=sequence(unknown);
  publishObservation({...postdeploy,outcome:'success',artifactPath,sidecarPath:artifactPath+'.sha256'},after,retry.options);
  assert.equal(after.calls(),1);assert.equal(retry.sleeps.length,3);
  assert.match(retry.warnings[1],/^backup-observation: TRUSTED_TIME_UNKNOWN sample=after attempts=1;/);
  const raw=JSON.parse(readFileSync(statePath,'utf8'));
  assert.equal(raw.latestAttemptResult,'success');assert.equal(raw.latestAttemptTime,null);assert.equal(raw.latestVerifiedProof,null);
  for(const line of retry.warnings)assert.equal(line.includes(statePath)||line.includes(artifactPath),false);
}));
test('TT-B transient trusted time: retries never accept evidence the unchanged contract rejects',()=>fixture(({base,statePath,artifactPath})=>{
  const postdeploy={...base,trigger:'postdeploy'},retry=retryRecorder();
  publishObservation({...postdeploy,outcome:'running'},sequence(()=>legacySample(),()=>legacySample(),()=>legacySample(),()=>sample()),retry.options);
  publishObservation({...postdeploy,outcome:'success',artifactPath,sidecarPath:artifactPath+'.sha256'},sequence(()=>legacySample(1000)),retry.options);
  const raw=JSON.parse(readFileSync(statePath,'utf8'));
  // The fourth (valid) before sample is used; every after attempt is legacy, so no proof is minted.
  assert.deepEqual(raw.latestAttemptTime,sample());assert.equal(raw.latestVerifiedProof,null);
  assert.deepEqual(retry.sleeps,[5000,20000,45000,5000,20000,45000]);
}));
