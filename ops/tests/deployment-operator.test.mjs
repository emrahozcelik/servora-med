import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const script = fileURLToPath(new URL('../deploy-production.sh',import.meta.url));
const projection = {mode:'deploy',releaseSha:'a'.repeat(40),treeSha:'b'.repeat(40),artifactSha256:'c'.repeat(64),ciManifestSha256:'d'.repeat(64),fqdn:'r4.synthetic.invalid',oldReleaseSha:'e'.repeat(40)};
function check(record,forward=false) {
 return spawnSync('/bin/bash',['-c','source "$1"; SHA="$3"; ARTIFACT_SHA="$4"; CI_MANIFEST_SHA="$5"; FQDN=r4.synthetic.invalid; FORWARD_RECOVERY="$6"; TREE="$7"; git() { echo "$TREE"; }; validate_attempt_projection "$2"','fixture',script,JSON.stringify(record),projection.releaseSha,projection.artifactSha256,projection.ciManifestSha256,String(forward),projection.treeSha],{encoding:'utf8'});
}
test('operator accepts only matching root-sealed source, artifact, CI and host projection',() => {
 assert.equal(check(projection).status,0);
 for(const key of ['releaseSha','treeSha','artifactSha256','ciManifestSha256','fqdn','mode']) {
  assert.notEqual(check({...projection,[key]:'unexpected'}).status,0,key);
 }
 assert.notEqual(check({...projection,command:'/bin/bash'}).status,0);
 assert.equal(check({...projection,mode:'forward-recovery'},true).status,0);
});

test('attempt output remains visible while failure and full logs are preserved',()=>{
 const result=spawnSync('/bin/bash',['-c',
  'source "$1"; ATTEMPT_ID=fixture; ssh_run() { printf "OBSERVATION_SAMPLE=1\\n"; return 7; }; output=$(mktemp); trap \'rm -f "$output"\' EXIT; if remote_phase "$output" fixture; then exit 99; fi; test "$(cat "$output")" = OBSERVATION_SAMPLE=1',
  'fixture',script],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
 assert.equal(result.stdout,'OBSERVATION_SAMPLE=1\n');
});
