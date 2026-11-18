import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

const hash=path=>createHash('sha256').update(readFileSync(new URL(path,import.meta.url))).digest('hex');
const runbook=readFileSync(new URL('../../docs/operations/ops-r4-002-67d3318-installed-old-recovery.md',import.meta.url),'utf8');

test('OPS-R4-002 runbook pins exact source hashes rather than stale pre-merge values',()=>{
  for(const path of [
    '../scripts/deployment-controller.mjs',
    '../scripts/trusted-time.mjs',
    '../scripts/issue-historical-recovery-disposition-6ce4cff0.sh',
    '../scripts/issue-installed-old-adoption-67d3318.sh',
    '../recovery-tools/attest-installed-old-cutover-67d3318'
  ])assert.ok(runbook.includes(hash(path)),path+' SHA-256 does not match runbook');
});

test('the projected host profile remains explicitly non-authoritative',()=>{
  assert.match(runbook,/audit.only|audit estimate|not a production authorization/i);
  assert.match(runbook,/918f8a98cc986257c47ed0956eab92bd85aeb384c32500c4c5c285b49e7fd4aa/);
});
