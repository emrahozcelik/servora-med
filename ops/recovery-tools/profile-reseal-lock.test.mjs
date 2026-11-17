// Real fd-9 lock ownership tests. These require Linux flock semantics and are
// skipped on platforms without /usr/bin/flock. The production wrapper still
// performs the same check in every environment.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {createFixture} from './profile-reseal-fixture.mjs';
import {assertHostLock} from './profile-reseal.mjs';

const linuxLock=process.platform==='linux'&&fs.existsSync('/usr/bin/flock');
const childSource=fixture=>`
import fs from 'node:fs';
import {assertHostLock} from ${JSON.stringify(new URL('./profile-reseal.mjs',import.meta.url).href)};
try {
  assertHostLock({lockFile:${JSON.stringify(fixture.lockFile)}},
    {uid:${fixture.uid},gid:${fixture.gid},fs});
  process.stdout.write('HOST_LOCK_OK\\n');
} catch (error) {
  process.stderr.write(error.message+'\\n');
  process.exitCode=1;
}
`;

function childFile(fixture){
  const file=path.join(fixture.root,'lock-child.mjs');
  fs.writeFileSync(file,childSource(fixture),{mode:0o600});
  return file;
}

test('a missing inherited lock fd fails closed',{skip:!linuxLock},async t=>{
  const fixture=createFixture();
  t.after(fixture.cleanup);
  const file=childFile(fixture);
  const result=spawnSync(process.execPath,['--no-addons',file],
    {encoding:'utf8',timeout:10000});
  assert.equal(result.status,1);
  assert.match(result.stderr,/PROFILE_RESEAL_HOST_LOCK_REQUIRED/);
});

test('a valid inherited fd-9 kernel lock is accepted',{skip:!linuxLock},async t=>{
  const fixture=createFixture();
  t.after(fixture.cleanup);
  const file=childFile(fixture);
  const script='exec 9>>"$LOCK"; flock -n 9; exec "$NODE" --no-addons "$CHILD"';
  const result=spawnSync('/bin/bash',['-c',script],{encoding:'utf8',timeout:10000,
    env:{...process.env,LOCK:fixture.lockFile,NODE:process.execPath,CHILD:file}});
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/HOST_LOCK_OK/);
});

test('a lock held by another process is rejected',{skip:!linuxLock},async t=>{
  const fixture=createFixture();
  t.after(fixture.cleanup);
  const file=childFile(fixture);
  const ready=path.join(fixture.root,'lock-ready');
  const holder=spawn('/bin/bash',['-c',
    'exec 9>>"$LOCK"; flock -n 9; : > "$READY"; sleep 15'],
  {env:{...process.env,LOCK:fixture.lockFile,READY:ready},stdio:'ignore'});
  t.after(()=>{try{holder.kill('SIGKILL');}catch{}});
  for(let attempt=0;attempt<100&&!fs.existsSync(ready);attempt+=1){
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.equal(fs.existsSync(ready),true,'holder did not acquire the lock');
  const script='exec 9>>"$LOCK"; exec "$NODE" --no-addons "$CHILD"';
  const result=spawnSync('/bin/bash',['-c',script],{encoding:'utf8',timeout:10000,
    env:{...process.env,LOCK:fixture.lockFile,NODE:process.execPath,CHILD:file}});
  assert.equal(result.status,1);
  assert.match(result.stderr,/PROFILE_RESEAL_HOST_LOCK_REQUIRED/);
});

test('an fd-9 lock on a different inode is rejected',{skip:!linuxLock},async t=>{
  const fixture=createFixture();
  t.after(fixture.cleanup);
  const file=childFile(fixture);
  const other=path.join(fixture.root,'other.lock');
  fs.writeFileSync(other,Buffer.alloc(0),{mode:0o600});
  const script='exec 9>>"$OTHER"; flock -n 9; exec "$NODE" --no-addons "$CHILD"';
  const result=spawnSync('/bin/bash',['-c',script],{encoding:'utf8',timeout:10000,
    env:{...process.env,OTHER:other,NODE:process.execPath,CHILD:file}});
  assert.equal(result.status,1);
  assert.match(result.stderr,/PROFILE_RESEAL_HOST_LOCK_REQUIRED/);
});

test('the lock file must be root:root 0600 with one link',{skip:!linuxLock},async t=>{
  const fixture=createFixture();
  t.after(fixture.cleanup);
  fs.chmodSync(fixture.lockFile,0o644);
  const file=childFile(fixture);
  const script='exec 9>>"$LOCK"; flock -n 9; exec "$NODE" --no-addons "$CHILD"';
  const result=spawnSync('/bin/bash',['-c',script],{encoding:'utf8',timeout:10000,
    env:{...process.env,LOCK:fixture.lockFile,NODE:process.execPath,CHILD:file}});
  assert.equal(result.status,1);
  assert.match(result.stderr,/PROFILE_RESEAL_HOST_LOCK_REQUIRED/);
});
