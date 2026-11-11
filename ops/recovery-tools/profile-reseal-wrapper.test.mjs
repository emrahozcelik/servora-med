// Disposable-container integration for the root-only wrapper.
//
// This test writes to the fixed production paths, so it is hard-gated to a
// throwaway Linux root container explicitly opted in with
// PROFILE_RESEAL_CONTAINER_TEST=1. It must never run on a real host.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';

const enabled=process.env.PROFILE_RESEAL_CONTAINER_TEST==='1'
  &&process.platform==='linux'&&process.getuid?.()===0;
const TOOL_DIR='/usr/local/libexec/servora-med-profile-reseal';
const LIBEXEC='/usr/local/libexec/servora-med';
const STATE='/var/lib/servora-med/deploy';
const REPO=new URL('.',import.meta.url);

test('root wrapper integration',{skip:!enabled},async t=>{
  assert.equal(fs.existsSync(TOOL_DIR),false,'refusing to overwrite an existing tool dir');
  assert.equal(fs.existsSync(STATE),false,'refusing to write over existing state');
  const createdNodeLink=!fs.existsSync('/usr/bin/node');
  if(createdNodeLink)fs.symlinkSync(process.execPath,'/usr/bin/node');
  fs.mkdirSync(TOOL_DIR,{recursive:true,mode:0o750});
  fs.chmodSync(TOOL_DIR,0o750);
  fs.mkdirSync(LIBEXEC,{recursive:true,mode:0o755});
  fs.mkdirSync(path.join(STATE,'initializations'),{recursive:true,mode:0o700});
  fs.chmodSync(STATE,0o750);
  fs.chmodSync(path.join(STATE,'initializations'),0o700);

  const copy=(source,destination,mode)=>{
    fs.copyFileSync(source,destination);
    fs.chmodSync(destination,mode);
  };
  const wrapper=path.join(TOOL_DIR,'profile-reseal');
  const module=path.join(TOOL_DIR,'profile-reseal.mjs');
  copy(new URL('./profile-reseal',REPO),wrapper,0o750);
  copy(new URL('./profile-reseal.mjs',REPO),module,0o644);
  for(const file of ['host-operation-lock.sh','deployment-attempt.mjs',
    'deployment-controller.mjs','deployment-db-guard.mjs',
    'migration-reconciliation.mjs','trusted-time.mjs',
    'historical-recovery-evidence.mjs']){
    copy(new URL('../scripts/'+file,REPO),path.join(LIBEXEC,file),0o644);
  }
  const lock=path.join(STATE,'host.lock');
  fs.writeFileSync(lock,Buffer.alloc(0),{mode:0o600});
  fs.chmodSync(lock,0o600);

  t.after(()=>{
    try{fs.rmSync(TOOL_DIR,{recursive:true,force:true});}catch{}
    try{fs.rmSync(LIBEXEC,{recursive:true,force:true});}catch{}
    try{fs.rmSync('/var/lib/servora-med',{recursive:true,force:true});}catch{}
    if(createdNodeLink){try{fs.unlinkSync('/usr/bin/node');}catch{}}
  });

  const run=(args={})=>spawnSync(wrapper,args,{encoding:'utf8',timeout:20000});
  const stdout=result=>`${result.stdout ?? ''}${result.stderr ?? ''}`;

  // The wrapper passes its trust, lock and pending checks, then the module
  // fails closed because no profile exists yet.
  const healthy=run(['--dry-run']);
  assert.equal(healthy.status,1,stdout(healthy));
  assert.match(healthy.stderr,/PROFILE_RESEAL_PROFILE_UNTRUSTED/);

  fs.unlinkSync(lock);
  const missing=run(['--dry-run']);
  assert.equal(missing.status,1);
  assert.match(missing.stderr,/PROFILE_RESEAL_HOST_LOCK_REQUIRED/);
  fs.writeFileSync(lock,Buffer.alloc(0),{mode:0o600});
  fs.chmodSync(lock,0o600);

  fs.writeFileSync(path.join(STATE,'active.json'),'{}\n');
  const pending=run(['--dry-run']);
  assert.equal(pending.status,1);
  assert.match(pending.stderr,/RECOVERY_ATTEMPT_PENDING/);
  fs.unlinkSync(path.join(STATE,'active.json'));

  const ready=path.join(STATE,'lock-ready');
  const holder=spawn('/bin/bash',['-c',
    'exec 9>>"$LOCK"; flock -n 9; : > "$READY"; sleep 10'],
  {env:{...process.env,LOCK:lock,READY:ready},stdio:'ignore'});
  t.after(()=>{try{holder.kill('SIGKILL');}catch{}});
  for(let attempt=0;attempt<100&&!fs.existsSync(ready);attempt+=1){
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.equal(fs.existsSync(ready),true,'lock holder did not start');
  const busy=run(['--dry-run']);
  assert.equal(busy.status,1);
  assert.match(busy.stderr,/HOST_DEPLOYMENT_LOCK_BUSY/);
  holder.kill('SIGKILL');
  fs.unlinkSync(ready);

  const original=fs.readFileSync(module);
  fs.appendFileSync(module,'# tampered\n');
  const tampered=run(['--dry-run']);
  assert.equal(tampered.status,1);
  assert.match(tampered.stderr,/PROFILE_RESEAL_TOOL_UNTRUSTED/);
  fs.writeFileSync(module,original,{mode:0o644});
  fs.chmodSync(module,0o644);

  fs.chmodSync(module,0o600);
  const modeDrift=run(['--dry-run']);
  assert.equal(modeDrift.status,1);
  assert.match(modeDrift.stderr,/PROFILE_RESEAL_TOOL_UNTRUSTED/);
});
