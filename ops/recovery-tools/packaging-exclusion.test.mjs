// Release packaging policy: the root-only bootstrap tool must be reviewed and
// transferred separately, never silently shipped in the production artifact.
//
// The second test executes the real package_artifact() shell function from
// ops/deploy-production.sh against a synthetic repository and inspects the
// actual tar members. This catches the GNU tar/bsdtar difference where a
// leading "./" exclude pattern does not match an "ops/..." member.
import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const script=readFileSync(new URL('../deploy-production.sh',import.meta.url),'utf8');

function shellFunction(name){
  const start=script.indexOf(`${name}() {`);
  assert.notEqual(start,-1,`missing ${name}`);
  const end=script.indexOf('\n}\n',start);
  assert.notEqual(end,-1,`unterminated ${name}`);
  return script.slice(start,end+3);
}

test('the release artifact excludes the root-only recovery tooling',()=>{
  assert.match(script,/--exclude='\.\/ops\/recovery-tools'/);
  assert.match(script,/--exclude='\.\/ops\/recovery-tools\/\*'/);
  assert.match(script,/--exclude='ops\/recovery-tools'/);
  assert.match(script,/--exclude='ops\/recovery-tools\/\*'/);
});

test('the real package_artifact tar contains no recovery-tool member',t=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'servora-package-exclusion-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const repo=path.join(root,'repo');
  const output=path.join(root,'artifact.tar.gz');
  const write=(relative,content)=>{
    const file=path.join(repo,relative);
    mkdirSync(path.dirname(file),{recursive:true});
    writeFileSync(file,content);
  };
  write('ops/recovery-tools/profile-reseal','tool\n');
  write('ops/recovery-tools/profile-reseal.mjs','tool module\n');
  write('ops/recovery-tools/bootstrap-delegation-quarantine','root-only quarantine\n');
  write('ops/recovery-tools/bootstrap-delegation-quarantine-host.mjs','root-only quarantine adapter\n');
  write('ops/scripts/deploy-production-host.sh','release helper\n');
  write('server/dist/index.js','release\n');
  write('server/package.json','{}\n');
  write('server/package-lock.json','{}\n');
  write('server/node_modules/.keep','\n');
  write('web/dist/index.html','release\n');

  const shell=`set -Eeuo pipefail\n${shellFunction('get_tar_portability_args')}\n`
    +`${shellFunction('package_artifact')}\nREPO_ROOT="$1"\npackage_artifact "$2"\n`;
  const packaged=spawnSync('bash',['-c',shell,'--',repo,output],{encoding:'utf8',timeout:120000});
  assert.equal(packaged.status,0,packaged.stderr);
  assert.ok(readFileSync(output).length>0,'artifact must not be empty');

  const listed=spawnSync('tar',['-tzf',output],{encoding:'utf8',timeout:120000});
  assert.equal(listed.status,0,listed.stderr);
  const members=listed.stdout.split('\n').filter(Boolean);
  assert.ok(members.includes('ops/scripts/deploy-production-host.sh'));
  assert.deepEqual(members.filter(member=>member.includes('ops/recovery-tools')),[]);
});
