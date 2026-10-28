// Real kernel/CLI boundary inside an explicitly disposable Linux container.
// Never run this test on a VPS, a general host or an existing R4 installation.
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,copyFileSync,chmodSync,
  lstatSync,existsSync,symlinkSync,unlinkSync,rmSync} from 'node:fs';
import {spawn,spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const enabled=process.env.SERVORA_R4_ISOLATED_CLI_TEST==='1';
test('real root CLI and kernel lock serialize issuance with deployment',
  {skip:enabled?false:'requires an explicitly owned disposable Linux container'},async t=>{
    assert.equal(process.platform,'linux');assert.equal(process.getuid(),0);
    assert.ok(existsSync('/.dockerenv'),'refuse a real host');
    const state='/var/lib/servora-med/deploy',installed='/usr/local/libexec/servora-med';
    assert.equal(existsSync(state),false,'never replace an existing recovery state');
    assert.equal(existsSync(installed),false,'never replace installed tools');
    const temporary=mkdtempSync(join(tmpdir(),'servora-adoption-cli-'));
    let stateCreated=false,toolsCreated=false,nodeLink=false,holder;
    t.after(async()=>{
      if(holder&&holder.exitCode===null){holder.stdin.end('release\n');await new Promise(resolve=>holder.once('exit',resolve));}
      if(stateCreated)rmSync(state,{recursive:true});
      if(toolsCreated)rmSync(installed,{recursive:true});
      if(nodeLink)unlinkSync('/usr/bin/node');
      rmSync(temporary,{recursive:true});
    });
    mkdirSync(state,{recursive:true,mode:0o700});stateCreated=true;
    mkdirSync(installed,{recursive:true,mode:0o755});toolsCreated=true;
    writeFileSync(state+'/host.lock','',{mode:0o600});
    const scripts=new URL('../scripts/',import.meta.url);
    for(const name of ['deployment-attempt.mjs','deployment-controller.mjs','deployment-db-guard.mjs',
      'migration-reconciliation.mjs','trusted-time.mjs','host-operation-lock.sh']){
      copyFileSync(fileURLToPath(new URL(name,scripts)),installed+'/'+name);chmodSync(installed+'/'+name,0o644);
    }
    const cli=installed+'/issue-installed-old-adoption';
    copyFileSync(fileURLToPath(new URL('issue-installed-old-adoption.sh',scripts)),cli);chmodSync(cli,0o750);
    if(!existsSync('/usr/bin/node')){symlinkSync(process.execPath,'/usr/bin/node');nodeLink=true;}
    const id='11111111-1111-4111-8111-111111111111',baseline='20261012T090000Z-issue369-71ae6df6';
    const run=(file,args,extra={})=>spawnSync(file,args,{encoding:'utf8',timeout:5000,
      env:{PATH:'/usr/bin:/bin',SERVORA_STATE_ROOT:temporary,NODE_OPTIONS:'untrusted',...extra}});
    const inode=lstatSync(state+'/host.lock').ino;
    const before=run('/bin/bash',[cli,id,baseline]);
    // Reaches the real controller under the actual kernel lock, then refuses
    // the intentionally absent grant. No live authority is issued in this test.
    assert.equal(before.status,1);assert.equal(before.stderr.trim(),'ATTEMPT_APPROVAL_MISSING');
    assert.equal(existsSync(state+'/installed-old-adoption.json'),false);
    const module=JSON.stringify(installed+'/deployment-controller.mjs');
    const direct=`import {issueInstalledOldAdoption as issue} from ${module};try{issue(${JSON.stringify(id)},${JSON.stringify(baseline)})}catch(e){console.error(e.message);process.exitCode=1}`;
    const unlocked=run(process.execPath,['--input-type=module','-e',direct],{NODE_OPTIONS:''});
    assert.equal(unlocked.status,1);assert.equal(unlocked.stderr.trim(),'RECOVERY_ADOPTION_HOST_LOCK_REQUIRED');
    holder=spawn('/usr/bin/flock',['--exclusive',state+'/host.lock','/bin/bash','-c','printf "ready\\n"; read -r release'],
      {stdio:['pipe','pipe','pipe']});
    await new Promise((resolve,reject)=>{
      holder.stdout.once('data',data=>data.toString().includes('ready')?resolve():reject(new Error('holder not ready')));
      holder.once('error',reject);holder.once('exit',()=>reject(new Error('holder exited before readiness')));
    });
    const busy=run('/bin/bash',[cli,id,baseline]);
    assert.equal(busy.status,1);assert.equal(busy.stderr.trim(),'HOST_DEPLOYMENT_LOCK_BUSY');
    assert.equal(lstatSync(state+'/host.lock').ino,inode,'never replace the lock inode');
    holder.stdin.end('release\n');await new Promise(resolve=>holder.once('exit',resolve));holder=null;
    const foreign=join(temporary,'foreign.lock');writeFileSync(foreign,'',{mode:0o600});
    const wrongFd=run('/bin/bash',['-c','exec 9>>"$1"; exec "$2" --input-type=module -e "$3"','fixture',foreign,process.execPath,direct],{NODE_OPTIONS:''});
    assert.equal(wrongFd.status,1);assert.equal(wrongFd.stderr.trim(),'RECOVERY_ADOPTION_HOST_LOCK_REQUIRED');
    const library=installed+'/host-operation-lock.sh',original=readFileSync(library);
    writeFileSync(library,Buffer.concat([original,Buffer.from('\n# drift\n')]));
    const drift=run('/bin/bash',[cli,id,baseline]);
    assert.equal(drift.status,1);assert.equal(drift.stderr.trim(),'RECOVERY_ADOPTION_TOOL_UNTRUSTED');
    assert.equal(existsSync(state+'/installed-old-adoption.json'),false);
    assert.deepEqual(readFileSync(state+'/host.lock'),Buffer.alloc(0));
  });
