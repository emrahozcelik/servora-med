/** Host-only backup writer. CLI accepts no caller time proof or clock override. */
import {constants,openSync,closeSync,fstatSync,readFileSync,readSync,writeFileSync,fsyncSync,
  renameSync,unlinkSync,lstatSync,realpathSync,existsSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {basename,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {sampleTrustedTime,elapsedTime} from './trusted-time.mjs';
import {BACKUP_TRIGGER_CLASSES,BACKUP_ATTEMPT_RESULTS,BACKUP_FAILURE_CLASSES,OBSERVATION_KEYS,
  parseBackupObservationState,parseObservationInstant,eventLabel} from './backup-observation.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=()=>{throw new Error('BACKUP_OBSERVATION_UNTRUSTED');};
const flushDirectory=path=>{const fd=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY);try{fsyncSync(fd);}finally{closeSync(fd);}};
function sample(readTime) {try{return readTime();}catch{return null;}}
function readState(path) {
  let fd;
  try {
    fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    const info=fstatSync(fd);
    if(!info.isFile()||info.nlink!==1||info.size>65536||(info.mode&0o777)!==0o600||info.uid!==process.getuid())fail();
    const bytes=readFileSync(fd),raw=JSON.parse(bytes);
    if(!parseBackupObservationState(raw))fail();
    return {raw,bytes};
  } catch(error) {if(error.code==='ENOENT')return null;throw error;}
  finally {if(fd!==undefined)closeSync(fd);}
}
function verifiedArtifact(artifactPath,sidecarPath) {
  if(typeof artifactPath!=='string'||!artifactPath.startsWith('/')||resolve(artifactPath)!==artifactPath
    ||sidecarPath!==artifactPath+'.sha256'||realpathSync(dirname(artifactPath))!==dirname(artifactPath))fail();
  const fds=[];
  try {
    for(const path of [artifactPath,sidecarPath]) {
      const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);fds.push(fd);
      const info=fstatSync(fd);
      if(!info.isFile()||info.nlink!==1||(info.mode&0o777)!==0o600||info.uid!==process.getuid())fail();
    }
    const before=fstatSync(fds[0]);
    if(fstatSync(fds[1]).size>1024)fail();
    const sidecar=readFileSync(fds[1]);
    const expected=sidecar.toString().match(/^([0-9a-f]{64})  ([^\s/]+)\n$/);
    if(!expected||expected[2]!==basename(artifactPath))fail();
    const digest=createHash('sha256'),buffer=Buffer.alloc(1024*1024);
    for(let count;(count=readSync(fds[0],buffer,0,buffer.length,null))>0;)digest.update(buffer.subarray(0,count));
    const artifactSha256=digest.digest('hex'),after=fstatSync(fds[0]);
    if(artifactSha256!==expected[1]||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)fail();
    for(const fd of fds)fsyncSync(fd);
    flushDirectory(dirname(artifactPath));
    return {artifactSha256,sidecarSha256:hash(sidecar)};
  } finally {for(const fd of fds)closeSync(fd);}
}

/** Internal test seam supplies samples; the executable always uses the fixed TT-A sampler. */
export function publishObservation(input,readTime=sampleTrustedTime) {
  const {statePath,trigger,startedAt,outcome,failureClass=null}=input;
  if(!BACKUP_TRIGGER_CLASSES.includes(trigger)||!BACKUP_ATTEMPT_RESULTS.includes(outcome)
    ||parseObservationInstant(startedAt)===null||typeof statePath!=='string'||!statePath.startsWith('/')
    ||resolve(statePath)!==statePath
    ||(outcome==='failure'?!BACKUP_FAILURE_CLASSES.includes(failureClass):failureClass!==null)
    ||(outcome==='running'&&input.completedAt!=null)
    ||(outcome==='failure'&&parseObservationInstant(input.completedAt)===null)) {
    throw Object.assign(new Error('BACKUP_OBSERVATION_ARGUMENT_INVALID'),{exitCode:64});
  }
  const directory=dirname(statePath),dirInfo=lstatSync(directory);
  if(!dirInfo.isDirectory()||dirInfo.isSymbolicLink()||realpathSync(directory)!==directory
    ||(dirInfo.mode&0o777)!==0o700||dirInfo.uid!==process.getuid())fail();
  const prior=readState(statePath),raw=prior?.raw;
  if(raw&&raw.latestAttemptTrigger===trigger&&raw.latestAttemptStartedAt===startedAt
    &&raw.latestAttemptResult===outcome&&outcome==='running')return;
  const state=Object.fromEntries(OBSERVATION_KEYS.map(key=>[key,null]));
  Object.assign(state,raw??{}, {schemaVersion:2,scheduledBaselineEstablished:raw?.schemaVersion===2
    ?raw.scheduledBaselineEstablished:raw?.latestScheduledVerifiedAt!=null});
  // An explicit v1 migration retains UTC/outcome history and no invented proof.
  if(raw?.schemaVersion!==2)for(const key of ['latestAttemptId','latestAttemptTime','latestScheduledAttemptId',
    'latestScheduledAttemptTime','latestVerifiedProof','latestScheduledVerifiedProof'])state[key]=null;
  const matching=raw?.latestAttemptTrigger===trigger&&raw?.latestAttemptStartedAt===startedAt;
  if(outcome==='success'&&matching&&raw.latestAttemptResult==='success') {
    const digest=verifiedArtifact(input.artifactPath,input.sidecarPath);
    if(!raw.latestVerifiedProof||raw.latestVerifiedProof.artifactSha256!==digest.artifactSha256
      ||raw.latestVerifiedProof.sidecarSha256!==digest.sidecarSha256)fail();
    return;
  }
  if(outcome==='success'&&(!matching||raw.latestAttemptResult!=='running'||!raw.latestAttemptId))fail();
  const time=outcome==='running'?sample(readTime):null;
  Object.assign(state,{latestAttemptTrigger:trigger,latestAttemptStartedAt:startedAt,latestAttemptResult:outcome,
    latestAttemptId:outcome==='running'?randomUUID():matching?raw.latestAttemptId:null,
    latestAttemptTime:outcome==='running'?time:matching?raw.latestAttemptTime:null,
    latestAttemptCompletedAt:outcome==='running'?null:input.completedAt??new Date().toISOString().slice(0,19)+'Z',
    latestAttemptFailureClass:failureClass});
  if(outcome==='success') {
    const digest=verifiedArtifact(input.artifactPath,input.sidecarPath);
    const after=sample(readTime),before=state.latestAttemptTime;
    const completedAt=after?eventLabel(after):new Date().toISOString().slice(0,19)+'Z';
    state.latestAttemptCompletedAt=completedAt;state.latestVerifiedAt=completedAt;state.latestVerifiedTrigger=trigger;
    state.latestVerifiedProof=before&&after&&elapsedTime(before,after).status==='KNOWN'
      ?{formatVersion:1,attemptId:state.latestAttemptId,trigger,startedAt,...digest,before,after}:null;
    if(trigger==='scheduled') {
      state.latestScheduledVerifiedAt=completedAt;state.latestScheduledVerifiedProof=state.latestVerifiedProof;
      state.scheduledBaselineEstablished=true;
    }
  }
  if(trigger==='scheduled')for(const suffix of ['StartedAt','CompletedAt','Result','FailureClass','Id','Time']) {
    state['latestScheduledAttempt'+suffix]=state['latestAttempt'+suffix];
  }
  state.updatedAt=new Date().toISOString().slice(0,19)+'Z';
  if(!parseBackupObservationState(state))fail();
  if(prior?.raw.schemaVersion===1) {
    const archive=statePath+'.legacy-'+hash(prior.bytes)+'.json';
    if(existsSync(archive)) {if(hash(readFileSync(archive))!==hash(prior.bytes))fail();}
    else {
      const fd=openSync(archive,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      try{writeFileSync(fd,prior.bytes);fsyncSync(fd);}finally{closeSync(fd);}
      flushDirectory(directory);
    }
  }
  const temporary=directory+'/.'+basename(statePath)+'.tmp.'+randomUUID();
  try {
    const fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try{writeFileSync(fd,JSON.stringify(state,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
    renameSync(temporary,statePath);flushDirectory(directory);
  } finally {if(existsSync(temporary))unlinkSync(temporary);}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const keys={'--state':'statePath','--trigger':'trigger','--started-at':'startedAt','--outcome':'outcome',
    '--completed-at':'completedAt','--failure-class':'failureClass','--artifact':'artifactPath','--sidecar':'sidecarPath'};
  const input={};
  try {
    for(let index=2;index<process.argv.length;index+=2) {
      const key=keys[process.argv[index]];
      if(!key||process.argv[index+1]===undefined||Object.hasOwn(input,key))throw Object.assign(new Error('BACKUP_OBSERVATION_ARGUMENT_INVALID'),{exitCode:64});
      input[key]=process.argv[index+1];
    }
    publishObservation(input);
  } catch(error) {process.stderr.write('backup-observation: publication failed\n');process.exitCode=error.exitCode??1;}
}
