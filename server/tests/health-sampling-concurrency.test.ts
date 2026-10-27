import {expect,it} from 'vitest';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildApp} from '../src/app.js';
import {loadConfig} from '../src/config.js';
import {createHostBackupObservationHealth} from '../src/modules/health/host-backup-observation.js';
import {createTrustedTimeSampler} from '../src/modules/health/trusted-time-sampler.js';
import {timeAt,trustedDocument} from './backup-time-fixture.js';

it('PR394-P1: a slow health child permits normal API progress and busy health requests never queue more children',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'pr394-http-')),marker=join(dir,'normal-served');
  const observationPath=join(dir,'observation-v1.json'),at='2026-10-27T09:00:00Z';
  const evidence=timeAt(Date.parse(at)+1000);
  await writeFile(observationPath,JSON.stringify(trustedDocument({updatedAt:at,latestAttemptTrigger:'scheduled',latestAttemptStartedAt:at,
    latestAttemptCompletedAt:at,latestAttemptResult:'success',latestAttemptFailureClass:null,latestVerifiedAt:at,
    latestVerifiedTrigger:'scheduled',latestScheduledAttemptStartedAt:at,latestScheduledAttemptCompletedAt:at,
    latestScheduledAttemptResult:'success',latestScheduledAttemptFailureClass:null,latestScheduledVerifiedAt:at})));
  let started!:()=>void,runs=0;
  const ready=new Promise<void>(resolve=>{started=resolve;});
  const sampler=createTrustedTimeSampler(()=>{
    runs++;
    const child=spawn(process.execPath,['-e',`const fs=require('node:fs');process.send('ready');const deadline=setTimeout(()=>process.exit(1),2500);const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(marker)})){clearInterval(timer);clearTimeout(deadline);process.stdout.write(${JSON.stringify(JSON.stringify(evidence))},()=>process.exit(0));}},5);`],
      {detached:process.platform!=='win32',stdio:['ignore','pipe','ignore','ipc']});
    child.once('message',()=>started());
    return child;
  });
  const health=createHostBackupObservationHealth({observationPath,sampleTime:()=>sampler.sample()});
  const app=await buildApp(loadConfig({DATABASE_URL:'postgresql://unused',NODE_ENV:'test',LOG_LEVEL:'silent'}),{backupHealthReadiness:health});
  app.get('/normal',async()=>{await writeFile(marker,'served');return {ok:true};});
  try {
    const pending=app.inject('/api/health');
    await ready;
    const busy=await Promise.all(Array.from({length:12},()=>app.inject('/api/health/backup')));
    expect(busy.every(response=>response.statusCode===503&&response.json().providerStatus==='unavailable')).toBe(true);
    expect(runs).toBe(1);
    expect((await app.inject('/normal')).statusCode).toBe(200);
    const response=await pending;
    expect(response.json().backup.providerStatus).toBe('healthy');
    expect(JSON.stringify(response.json())).not.toMatch(/bootId|timeNamespaceId|artifactSha256|rootDistanceMs/);
    expect(runs).toBe(1);
  } finally {await sampler.close();await app.close();await rm(dir,{recursive:true,force:true});}
});

it('PR394-P1: timeout denies, keeps one active child until reaped, and never queues requests',async()=>{
  let child:ReturnType<typeof spawn>|undefined,runs=0;
  const sampler=createTrustedTimeSampler(()=>{
    runs++;child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:process.platform!=='win32',stdio:['ignore','pipe','ignore']});return child;
  },150);
  try {
    const first=sampler.sample();
    expect(await sampler.sample()).toBeNull();
    expect(runs).toBe(1);
    expect(await first).toBeNull();
    await sampler.close();
    expect(child?.signalCode).toBe('SIGKILL');
    expect(await sampler.sample()).toBeNull();
    expect(runs).toBe(1);
  } finally {await sampler.close();}
});

it.skipIf(process.platform==='win32')('PR394-P1: shutdown kills the sampling process group including a descendant holding stdout',async()=>{
  let ready!:()=>void;
  const started=new Promise<void>(resolve=>{ready=resolve;});
  let child:ReturnType<typeof spawn>|undefined;
  const sampler=createTrustedTimeSampler(()=>{
    child=spawn(process.execPath,['-e',`const {spawn}=require('node:child_process');const grand=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','ignore','ipc']});grand.once('spawn',()=>process.send('ready'));setInterval(()=>{},1000);`],{detached:true,stdio:['ignore','pipe','ignore','ipc']});
    child.once('message',()=>ready());return child;
  });
  try {
    const pending=sampler.sample();await started;
    await sampler.close();
    expect(await pending).toBeNull();
    expect(child?.signalCode).toBe('SIGKILL');
    // close() awaits the pipe close: a surviving descendant would keep it open.
  } finally {await sampler.close();}
});

it('PR394-P1: public health routes share a per-IP budget and do not throttle normal API routes',async()=>{
  let checks=0,closed=false;
  const backup={check:async()=>{checks++;return {status:'unavailable' as const,latestVerifiedAt:null,latestScheduledVerifiedAt:null,
    latestRunStatus:null,latestScheduledRunStatus:null,workerHeartbeatAt:null,schedulerLastTickAt:null};},close:async()=>{closed=true;}};
  const app=await buildApp(loadConfig({DATABASE_URL:'postgresql://unused',NODE_ENV:'test',LOG_LEVEL:'silent'}),{backupHealthReadiness:backup});
  app.get('/normal',async()=>({ok:true}));
  try {
    for(let i=0;i<60;i++) {
      const response=await app.inject({url:i%2?'/api/health':'/api/health/backup',remoteAddress:'198.51.100.1',headers:{'x-forwarded-for':'203.0.113.'+i}});
      expect(response.statusCode).not.toBe(429);
    }
    expect((await app.inject({url:'/api/health',remoteAddress:'198.51.100.1'})).statusCode).toBe(429);
    expect((await app.inject({url:'/api/health/backup',remoteAddress:'198.51.100.1'})).statusCode).toBe(429);
    expect(checks).toBe(60);
    expect((await app.inject({url:'/normal',remoteAddress:'198.51.100.1'})).statusCode).toBe(200);
    expect((await app.inject({url:'/api/health',remoteAddress:'198.51.100.2'})).statusCode).toBe(200);
  } finally {await app.close();}
  expect(closed).toBe(true);
});

it('PR394-P1: healthy is not cached across the 26h boundary or a later sampling error',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'pr394-age-')),at='2026-10-27T09:00:00Z',observationPath=join(dir,'observation-v1.json');
  await writeFile(observationPath,JSON.stringify(trustedDocument({updatedAt:at,latestAttemptTrigger:'scheduled',latestAttemptStartedAt:at,
    latestAttemptCompletedAt:at,latestAttemptResult:'success',latestAttemptFailureClass:null,latestVerifiedAt:at,
    latestVerifiedTrigger:'scheduled',latestScheduledAttemptStartedAt:at,latestScheduledAttemptCompletedAt:at,
    latestScheduledAttemptResult:'success',latestScheduledAttemptFailureClass:null,latestScheduledVerifiedAt:at})));
  let elapsed=26*3600000,fail=false,samples=0;
  const health=createHostBackupObservationHealth({observationPath,sampleTime:async()=>{samples++;if(fail)throw new Error('TRUSTED_TIME_UNKNOWN');return timeAt(Date.parse(at)+elapsed);}});
  try {
    expect((await health.check()).providerStatus).toBe('healthy');
    elapsed++;expect((await health.check()).providerStatus).toBe('stale');
    fail=true;expect((await health.check()).providerStatus).toBe('unavailable');
    expect(samples).toBe(3);
    await health.close?.();expect((await health.check()).providerStatus).toBe('unavailable');
    expect(samples).toBe(3);
  } finally {await health.close?.();await rm(dir,{recursive:true,force:true});}
});

it('PR394-P1: failed, malformed and excessive child output never authorizes time',async()=>{
  for(const code of ['process.exit(1)',"process.stdout.write('not-json')","process.stdout.write('x'.repeat(100000))"]) {
    const sampler=createTrustedTimeSampler(()=>spawn(process.execPath,['-e',code],{detached:process.platform!=='win32',stdio:['ignore','pipe','ignore']}));
    try {expect(await sampler.sample()).toBeNull();}finally {await sampler.close();}
  }
  const sampler=createTrustedTimeSampler(()=>{throw new Error('spawn failure');});
  try {expect(await sampler.sample()).toBeNull();}finally {await sampler.close();}
});
