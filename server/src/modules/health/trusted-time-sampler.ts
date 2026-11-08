/** HTTP-only isolation; the fixed TT-A sampler and its security rules are unchanged. */
import {spawn,type ChildProcess} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {validateCurrentTimeEvidence,type CurrentTimeEvidence} from '../../../../ops/scripts/trusted-time.mjs';

export const HEALTH_TIME_SAMPLE_TIMEOUT_MS=3000;
const MAX_OUTPUT_BYTES=16*1024;
export type TrustedTimeSampler={sample():Promise<CurrentTimeEvidence|null>;close():Promise<void>};
const samplerUrl=new URL('../../../../ops/scripts/trusted-time.mjs',import.meta.url).href;
const program=`import {sampleTrustedTime} from ${JSON.stringify(samplerUrl)};process.stdout.write(JSON.stringify(sampleTrustedTime()));`;
function spawnFixedSampler():ChildProcess {
  return spawn(process.execPath,['--input-type=module','--eval',program],{
    detached:process.platform!=='win32',stdio:['ignore','pipe','ignore'],
    env:{PATH:'/usr/bin:/bin',LC_ALL:'C'},
  });
}

/** Test seams only; production always uses the fixed command and 3s deadline. */
export function createTrustedTimeSampler(
  spawnSample:()=>ChildProcess=spawnFixedSampler,
  timeoutMs=HEALTH_TIME_SAMPLE_TIMEOUT_MS,
):TrustedTimeSampler {
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>HEALTH_TIME_SAMPLE_TIMEOUT_MS)throw new Error('INVALID_SAMPLE_TIMEOUT');
  let closed=false;
  let active:{kill():void;done:Promise<void>}|null=null;
  return {
    async sample() {
      if(closed||active)return null; // No queued waiters and no previous healthy cache.
      let child:ChildProcess;
      try {child=spawnSample();}catch{return null;}
      const started=performance.now();
      let resolveDone!:()=>void;
      const done=new Promise<void>(resolve=>{resolveDone=resolve;});
      let resolveSample!:(time:CurrentTimeEvidence|null)=>void;
      const result=new Promise<CurrentTimeEvidence|null>(resolve=>{resolveSample=resolve;});
      let invalid=false,output=Buffer.alloc(0);
      const kill=()=>{
        invalid=true;resolveSample(null);
        // The child executes synchronous system commands. Kill its POSIX group,
        // including any current systemctl/chronyc child, rather than orphan it.
        if(child.pid&&process.platform!=='win32') {
          try {process.kill(-child.pid,'SIGKILL');return;}catch { /* Already exited: fall back to its handle. */ }
        }
        child.kill('SIGKILL');
      };
      const current={kill,done};active=current;
      const timer=setTimeout(kill,timeoutMs);timer.unref();
      child.stdout?.on('data',(chunk:Buffer)=>{
        if(invalid)return;
        if(output.length+chunk.length>MAX_OUTPUT_BYTES){kill();return;}
        output=Buffer.concat([output,chunk]);
      });
      child.once('error',()=>{invalid=true;resolveSample(null);});
      child.once('close',(code)=>{
        clearTimeout(timer);
        let time:CurrentTimeEvidence|null=null;
        if(!invalid&&code===0&&performance.now()-started<=timeoutMs) {
          try {time=validateCurrentTimeEvidence(JSON.parse(output.toString('utf8')));}catch { /* Untrusted output denies. */ }
        }
        resolveSample(time);
        if(active===current)active=null;
        resolveDone();
      });
      return result;
    },
    async close() {
      closed=true;
      const current=active;
      if(current){current.kill();await current.done;}
    },
  };
}
