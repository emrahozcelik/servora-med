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
import {publishObservation} from '../scripts/backup-observation-writer.mjs';
import {parseBackupObservationState} from '../scripts/backup-observation.mjs';
const legacySample=(ms=0)=>({formatVersion:1,source:'linux-boottime',bootId:'11111111-1111-4111-8111-111111111111',
  timeNamespaceId:'time:[4026531834]',bootLowerMs:100000+ms,bootUpperMs:100000+ms,
  wallAtUTC:new Date(Date.parse('2026-10-27T09:00:00Z')+ms).toISOString(),wallResolutionMs:1,
  synchronization:{service:'chrony',referenceAgeMs:1,rootDistanceMs:1,correctionMs:0,sourceCount:2}});
const sample=(ms=0)=>timeEvidenceAt(Date.parse('2026-10-27T09:00:00Z')+ms);
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
  publishObservation({...base,outcome:'running'},()=>{throw new Error('TRUSTED_TIME_UNKNOWN');});
  success(base,()=>sample(1000));
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
  publishObservation({...base,outcome:'running'},()=>legacySample());
  success(base,()=>legacySample(1000));
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
