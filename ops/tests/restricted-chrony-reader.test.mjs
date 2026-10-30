import test from 'node:test';
import assert from 'node:assert/strict';
import * as time from '../scripts/trusted-time.mjs';
import {timeEvidenceAt} from './trusted-time-fixture.mjs';
const identity={bootId:'11111111-1111-4111-8111-111111111111',service:'active',pid:42,startTicks:'12345',invocationId:'a'.repeat(32),configSha256:time.CHRONY_CONFIG_SHA256,configDev:1,configIno:44,moduleSha256:'b'.repeat(64)};
const context=()=>({nonce:'c'.repeat(64),before:{identity,bootMs:100000,namespace:'time:[4026531834]'},after:{identity:{...identity},bootMs:100200,namespace:'time:[4026531834]'}});
const reply=()=>({formatVersion:1,nonce:'c'.repeat(64),identity:{...identity},time:timeEvidenceAt(undefined,{bootLowerMs:100050,bootUpperMs:100150})});
test('fresh request-bound two-NTS response preserves current format2 evidence',()=>{
 const r=reply();assert.deepEqual(time.validateRestrictedReply(r,context()),r.time);
});

test('restricted reply denies nonce',()=>{const r=reply();r.nonce='d'.repeat(64);assert.throws(()=>time.validateRestrictedReply(r,context()),/TRUSTED_TIME_UNKNOWN/);});

test('restricted reply denies identity',()=>{const c=context();c.after.identity.invocationId='d'.repeat(32);assert.throws(()=>time.validateRestrictedReply(reply(),c),/TRUSTED_TIME_UNKNOWN/);});

test('restricted reply denies boot',()=>{const r=reply();r.time.bootId='22222222-2222-4222-8222-222222222222';assert.throws(()=>time.validateRestrictedReply(r,context()),/TRUSTED_TIME_UNKNOWN/);});

test('restricted reply denies stale',()=>{const c=context();c.after.bootMs+=3000;assert.throws(()=>time.validateRestrictedReply(reply(),c),/TRUSTED_TIME_UNKNOWN/);});

test('restricted reply denies outside-window',()=>{const r=reply();r.time.bootLowerMs-=1000;assert.throws(()=>time.validateRestrictedReply(r,context()),/TRUSTED_TIME_UNKNOWN/);});

test('transport cannot promote historical format1 to fresh authority',()=>{
 const r=reply();r.time.formatVersion=1;
 assert.throws(()=>time.validateRestrictedReply(r,context()),/TRUSTED_TIME_UNKNOWN/);
});
test('transport never alters nested proof or grant budgets',()=>{
 const r=reply(),original=JSON.stringify(r);time.validateRestrictedReply(r,context());
 assert.equal(JSON.stringify(r),original);assert.equal(r.time.formatVersion,2);
});
test('replayed response, daemon/config/module drift and changed namespace deny',()=>{
 for(const field of ['pid','startTicks','invocationId','configSha256','configIno','configCtimeMs','selectionSha256','moduleSha256','bootId']) {
  const c=context();c.after.identity[field]='changed';
  assert.throws(()=>time.validateRestrictedReply(reply(),c),/TRUSTED_TIME_UNKNOWN/);
 }
 const c=context();c.after.namespace='time:[12]';assert.throws(()=>time.validateRestrictedReply(reply(),c),/TRUSTED_TIME_UNKNOWN/);
});

test('malformed transport has one bounded UNKNOWN outcome',()=>{
 for(const r of [null,{}, {formatVersion:1,nonce:'c'.repeat(64),identity:{...identity},time:null}])
  assert.throws(()=>time.validateRestrictedReply(r,context()),/TRUSTED_TIME_UNKNOWN/);
});

test('root socket metadata accepts only the protected single-link endpoint',()=>{
 const valid={uid:0,gid:988,nlink:1,mode:0o140660,dev:1,ino:77,isSocket:()=>true};
 assert.deepEqual(time.validateReaderSocketMetadata(valid,988),{dev:1,ino:77});
});
test('foreign socket owner/mode/type/link/inode denies',()=>{
 const valid={uid:0,gid:988,nlink:1,mode:0o140660,dev:1,ino:77,isSocket:()=>true};
 for(const invalid of [{uid:999},{gid:0},{nlink:2},{mode:0o140666},{isSocket:()=>false},{ino:0}])
  assert.throws(()=>time.validateReaderSocketMetadata({...valid,...invalid},988),/TRUSTED_TIME_UNKNOWN/);
});

test('reviewed activation units are transitively pinned by the time module',async()=>{
 const {createHash}=await import('node:crypto');const {readFileSync}=await import('node:fs');
 for(const [name,pin] of [['servora-med-time-evidence@.service',time.READER_UNIT_SHA256],['servora-med-time-evidence.socket',time.READER_SOCKET_UNIT_SHA256]])
  assert.equal(createHash('sha256').update(readFileSync(new URL('../systemd/'+name,import.meta.url))).digest('hex'),pin);
});
