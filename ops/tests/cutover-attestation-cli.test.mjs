import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

const wrapper=new URL('../recovery-tools/attest-installed-old-cutover-67d3318',import.meta.url);
test('the separately provisioned attestation CLI refuses a real non-root user before reading host state',
  {skip:process.getuid?.()===0?'requires an ordinary user':false},()=>{
    const result=spawnSync('/bin/bash',[fileURLToPath(wrapper),
      '11111111-1111-4111-8111-111111111111','20261110T090000Z-ops-r4-002-67d3318'],
    {encoding:'utf8',env:{PATH:'/usr/bin:/bin',NODE_OPTIONS:'untrusted'}});
    assert.equal(result.status,1);
    assert.equal(result.stderr.trim(),'RECOVERY_ADOPTION_ADMIN_REQUIRED');
    assert.equal(result.stdout,'');
  });

test('private wrapper pins the stable lock library and verifies the fenced/profile-pinned controller before issuance',()=>{
  const source=readFileSync(wrapper,'utf8');
  const libraryHash=createHash('sha256').update(readFileSync(
    new URL('../scripts/host-operation-lock.sh',import.meta.url))).digest('hex');
  assert.ok(source.includes('== '+libraryHash+' ]]'));
  assert.match(source,/unset NODE_OPTIONS NODE_PATH BASH_ENV ENV/);
  assert.ok(source.indexOf('servora_acquire_host_lock\n')<source.indexOf('bootstrap-fence adoption'));
  assert.ok(source.indexOf('bootstrap-fence adoption')<source.indexOf('issueInstalledOldCutoverAttestation67d3318(process.argv'));
  assert.match(source,/exec \/usr\/bin\/env -i/);
  assert.doesNotMatch(source,/--force|--root|--clock|SERVORA_STATE_ROOT/);
});
