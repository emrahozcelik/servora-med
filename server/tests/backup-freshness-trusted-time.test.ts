import {describe, expect, it} from 'vitest';
import {evaluateBackupProviderStatus, parseBackupObservationState} from '../src/modules/health/backup-freshness.js';
import {timeAt, legacyTimeAt, trustedDocument} from './backup-time-fixture.js';
import {createHostBackupObservationHealth} from '../src/modules/health/host-backup-observation.js';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';

const at='2026-10-27T09:00:00Z';
const legacy={schemaVersion:1,updatedAt:at,latestAttemptTrigger:'scheduled',latestAttemptStartedAt:at,
  latestAttemptCompletedAt:at,latestAttemptResult:'success',latestAttemptFailureClass:null,
  latestVerifiedAt:at,latestVerifiedTrigger:'scheduled',latestScheduledAttemptStartedAt:at,
  latestScheduledAttemptCompletedAt:at,latestScheduledAttemptResult:'success',latestScheduledAttemptFailureClass:null,
  latestScheduledVerifiedAt:at};

describe('TT-B backup event time',()=>{
  it('does not accept legacy UTC-only success as fresh',()=>{
    const state=parseBackupObservationState(legacy);
    expect(state).not.toBeNull();
    expect(evaluateBackupProviderStatus(state,Date.parse(at)+1000)).toBe('unavailable');
  });
  it('accepts a strict v2 event at exactly 26 hours',()=>{
    const state=parseBackupObservationState(trustedDocument(legacy));
    expect(state).not.toBeNull();
    expect(evaluateBackupProviderStatus(state,timeAt(Date.parse(at)+26*3600000))).toBe('healthy');
  });
  it.each([
    ['26h + 1ms',26*3600000+1,26*3600000+1,'stale'],
    ['27h plus 2h rollback',27*3600000,25*3600000,'stale'],
    ['young event plus rollback',3600000,1800000,'unavailable'],
    ['young event plus forward step',3600000,3*3600000,'unavailable'],
  ])('evaluates %s from the original event',(_name,elapsed,wall,status)=>{
    const start=Date.parse(at);
    const state=parseBackupObservationState(trustedDocument(legacy));
    expect(evaluateBackupProviderStatus(state,timeAt(start+elapsed,{wallAtUTC:new Date(start+wall).toISOString()}))).toBe(status);
  });
  it('does not bridge a reboot or an age interval straddling the threshold',()=>{
    const state=parseBackupObservationState(trustedDocument(legacy)),start=Date.parse(at);
    expect(evaluateBackupProviderStatus(state,timeAt(start+1000,{bootId:'22222222-2222-4222-8222-222222222222'}))).toBe('unavailable');
    const current=timeAt(start+26*3600000);
    expect(evaluateBackupProviderStatus(state,{...current,bootUpperMs:current.bootUpperMs+1})).toBe('unavailable');
  });
  it('rejects a coerced digest in strict verification evidence',()=>{
    const raw=trustedDocument(legacy);
    (raw.latestVerifiedProof as Record<string,unknown>).artifactSha256=['a'.repeat(64)];
    raw.latestScheduledVerifiedProof=raw.latestVerifiedProof;
    expect(parseBackupObservationState(raw)).toBeNull();
  });
  it('rejects conflicting attempt and verification time evidence',()=>{
    const raw=trustedDocument(legacy);
    raw.latestAttemptTime=timeAt(Date.parse(at)+1000);
    expect(parseBackupObservationState(raw)).toBeNull();
  });
  it('cannot make a delayed publication fresh by labeling its end as now',()=>{
    const raw=trustedDocument(legacy);
    const proof=raw.latestVerifiedProof as {before:ReturnType<typeof timeAt>};
    proof.before=timeAt(Date.parse(at)-27*3600000);
    raw.latestAttemptTime=proof.before;raw.latestScheduledAttemptTime=proof.before;
    expect(evaluateBackupProviderStatus(parseBackupObservationState(raw),timeAt(Date.parse(at)))).toBe('unavailable');
  });
  it('preserves the original event across separate reader processes',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'ttb-process-'));
    try {
      const observationPath=join(dir,'observation-v1.json');
      const bytes=JSON.stringify(trustedDocument(legacy));
      await writeFile(observationPath,bytes);
      const check=(elapsed:number)=>{
        const code=`import {createHostBackupObservationHealth} from './src/modules/health/host-backup-observation.ts';
          const health=createHostBackupObservationHealth({observationPath:${JSON.stringify(observationPath)},
          sampleTime:()=>(${JSON.stringify(timeAt(Date.parse(at)+elapsed))})});
          console.log((await health.check()).providerStatus);`;
        return execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',code],{encoding:'utf8',cwd:new URL('../',import.meta.url)}).trim();
      };
      expect(check(3600000)).toBe('healthy');
      expect(check(27*3600000)).toBe('stale');
      expect(check(27*3600000)).toBe('stale');
      const {readFile}=await import('node:fs/promises');
      expect(await readFile(observationPath,'utf8')).toBe(bytes);
    } finally {await rm(dir,{recursive:true,force:true});}
  });
  it('reads persisted event evidence with a fresh trusted sample',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'ttb-reader-'));
    try {
      const observationPath=join(dir,'observation-v1.json');
      await writeFile(observationPath,JSON.stringify(trustedDocument(legacy)));
      const health=createHostBackupObservationHealth({observationPath,sampleTime:()=>timeAt(Date.parse(at)+1000)});
      expect((await health.check()).providerStatus).toBe('healthy');
    } finally {await rm(dir,{recursive:true,force:true});}
  });
});


it('OPS-TT-003 keeps old time proofs as history and never promotes their quorum',()=>{
  const raw=trustedDocument(legacy);
  const proof=raw.latestVerifiedProof as {before:ReturnType<typeof legacyTimeAt>;after:ReturnType<typeof legacyTimeAt>};
  proof.before=legacyTimeAt(Date.parse(at));proof.after=legacyTimeAt(Date.parse(at));
  raw.latestScheduledVerifiedProof=proof;raw.latestAttemptTime=proof.before;raw.latestScheduledAttemptTime=proof.before;
  const bytes=JSON.stringify(raw),state=parseBackupObservationState(JSON.parse(bytes));
  expect(state).not.toBeNull();
  expect(evaluateBackupProviderStatus(state,legacyTimeAt(Date.parse(at)+1000))).toBe('unavailable');
  expect(evaluateBackupProviderStatus(state,timeAt(Date.parse(at)+1000))).toBe('unavailable');
  expect(JSON.stringify(raw)).toBe(bytes);
});
