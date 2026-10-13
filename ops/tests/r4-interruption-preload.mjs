// Deterministic syscall interruption harness. Never loaded by the host helper.
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {hostname} from 'node:os';
if (process.getuid() !== 0 || hostname() !== 'lima-servora-r4-20261012') throw Error('ISOLATED_HOST_REQUIRED');
const fsync = fs.fsyncSync;
let owner;
fs.fsyncSync = function(fd) {
  const result = fsync(fd);
  const path = fs.readlinkSync('/proc/self/fd/'+fd);
  if(fs.existsSync('/var/lib/servora-med/deploy/active.json'))owner=JSON.parse(fs.readFileSync('/var/lib/servora-med/deploy/active.json')).attemptId;
  if (process.env.SERVORA_R4_FAULT_POINT === 'claim-fsync'
    && path === '/var/lib/servora-med/deploy/active.json') {
    fs.writeSync(1,'FAULT_READY=claim-fsync\n');
    process.kill(process.pid,'SIGSTOP');
  }
  if (process.env.SERVORA_R4_FAULT_POINT === 'initialization-fsync'
    && path === '/var/lib/servora-med/deploy/initializations') {
    fs.writeSync(1,'FAULT_READY=initialization-fsync\n');process.kill(process.pid,'SIGSTOP');
  }
  if (process.env.SERVORA_R4_FAULT_POINT === 'handoff-fsync'
    && path === '/var/lib/servora-med/deploy' && !fs.existsSync(path+'/activation.block')
    && fs.existsSync(path+'/active.json')) {
    const id=JSON.parse(fs.readFileSync(path+'/active.json')).attemptId;
    const files=fs.readdirSync(path+'/attempts/'+id).sort();
    const phase=JSON.parse(fs.readFileSync(path+'/attempts/'+id+'/'+files.at(-1))).phase;
    if (['ACCEPTED','ABORTED'].includes(phase)) {
      fs.writeSync(1,'FAULT_READY=handoff-fsync\n');process.kill(process.pid,'SIGSTOP');
    }
  }
  if(process.env.SERVORA_R4_FAULT_POINT==='completed-fsync' && owner
    && path==='/var/lib/servora-med/deploy/attempts/'+owner) {
    const files=fs.readdirSync(path).sort();const phase=JSON.parse(fs.readFileSync(path+'/'+files.at(-1))).phase;
    if(['COMPLETED','COMPLETED_ABORT'].includes(phase)){fs.writeSync(1,'FAULT_READY=completed-fsync\n');process.kill(process.pid,'SIGSTOP');}
  }
  if(process.env.SERVORA_R4_FAULT_POINT==='owner-retirement-fsync' && owner
    && path==='/var/lib/servora-med/deploy' && !fs.existsSync(path+'/active.json')) {
    fs.writeSync(1,'FAULT_READY=owner-retirement-fsync\n');process.kill(process.pid,'SIGSTOP');
  }
  if(process.env.SERVORA_R4_FAULT_POINT==='seal-publish-fsync'
    && path==='/var/lib/servora-med/deploy/backups' && owner
    && fs.readdirSync(path).some(name=>name===owner+'-pre.dump'||name===owner+'-post.dump')) {
    fs.writeSync(1,'FAULT_READY=seal-publish-fsync\n');process.kill(process.pid,'SIGSTOP');
  }
  return result;
};
syncBuiltinESMExports();
