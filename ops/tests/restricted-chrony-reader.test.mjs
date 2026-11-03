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

test('collector sandbox grants one narrow Chrony client-socket path',async()=>{
 const {readFileSync}=await import('node:fs');
 const unit=readFileSync(new URL('../systemd/servora-med-time-evidence@.service',import.meta.url),'utf8');
 assert.match(unit,/^ProtectSystem=strict$/m);
 assert.match(unit,/^ReadWritePaths=-\/run\/chrony$/m);
 assert.match(unit,/^CapabilityBoundingSet=$/m);
 assert.match(unit,/^User=_chrony$/m);
});

const RELEASE_GID=988;
const releaseModulePath='/opt/servora-med/releases/'+'a'.repeat(40)+'/ops/scripts/trusted-time.mjs';
const releaseFile=(overrides={})=>({kind:'file',uid:0,gid:RELEASE_GID,mode:0o650,nlink:1,...overrides});
const releaseAncestors=(overrides={})=>[
 {kind:'directory',uid:0,gid:RELEASE_GID,mode:0o750},
 {kind:'directory',uid:0,gid:RELEASE_GID,mode:0o750},
 {kind:'directory',uid:0,gid:RELEASE_GID,mode:0o750},
 {kind:'directory',uid:0,gid:RELEASE_GID,mode:0o750},
 {kind:'directory',uid:0,gid:RELEASE_GID,mode:0o750},
 {kind:'directory',uid:0,gid:0,mode:0o755},
].map((entry,index)=>({...entry,...(overrides[index]||{})}));
const INSTALLED_MODULE='/usr/local/libexec/servora-med/trusted-time.mjs';
const installedFile=(overrides={})=>({kind:'file',uid:0,gid:0,mode:0o644,nlink:1,...overrides});
const installedAncestors=(overrides={})=>Array.from({length:4},(_,index)=>({kind:'directory',uid:0,gid:0,mode:0o755,...(overrides[index]||{})}));

test('release-path sampler accepts only the deployed immutable release contract',()=>{
 assert.equal(time.validateTimeModuleContract(releaseModulePath,releaseFile(),releaseAncestors(),RELEASE_GID),'release');
});

test('installed collector keeps the strict root-owned module contract',()=>{
 assert.equal(time.validateTimeModuleContract(INSTALLED_MODULE,installedFile(),installedAncestors(),RELEASE_GID),'installed');
});

test('forward collector accepts only its separately authorized fixed root-owned path',()=>{
 const path='/usr/local/libexec/servora-med-forward/trusted-time.mjs';
 assert.equal(time.validateTimeModuleContract(path,installedFile(),installedAncestors(),RELEASE_GID),'installed');
 for(const file of [installedFile({uid:1}),installedFile({gid:RELEASE_GID}),installedFile({mode:0o664}),installedFile({nlink:2})])
  assert.throws(()=>time.validateTimeModuleContract(path,file,installedAncestors(),RELEASE_GID),/TRUSTED_TIME_UNKNOWN/);
 for(const other of ['/usr/local/libexec/servora-med-forward-other/trusted-time.mjs','/tmp/servora-med-forward/trusted-time.mjs'])
  assert.throws(()=>time.validateTimeModuleContract(other,installedFile(),installedAncestors(),RELEASE_GID),/TRUSTED_TIME_UNKNOWN/);
});

test('versioned continuity tool accepts only the hash-named root-owned module path',()=>{
 const path='/usr/local/libexec/servora-med-forward-tools/'+'a'.repeat(64)+'/trusted-time.mjs';
 assert.equal(time.validateTimeModuleContract(path,installedFile(),installedAncestors(),RELEASE_GID),'installed');
 for(const file of [installedFile({uid:1}),installedFile({gid:RELEASE_GID}),installedFile({mode:0o664}),installedFile({nlink:2})])
  assert.throws(()=>time.validateTimeModuleContract(path,file,installedAncestors(),RELEASE_GID),/TRUSTED_TIME_UNKNOWN/);
 for(const other of [
  '/usr/local/libexec/servora-med-forward-tools/'+'a'.repeat(63)+'/trusted-time.mjs',
  '/usr/local/libexec/servora-med-forward-tools/'+'A'.repeat(64)+'/trusted-time.mjs',
  '/usr/local/libexec/servora-med-forward-tools/'+'a'.repeat(64)+'/other.mjs',
  '/usr/local/libexec/servora-med-forward-tools/'+'a'.repeat(64)+'/x/trusted-time.mjs',
  '/tmp/servora-med-forward-tools/'+'a'.repeat(64)+'/trusted-time.mjs',
 ]) assert.throws(()=>time.validateTimeModuleContract(other,installedFile(),installedAncestors(),RELEASE_GID),/TRUSTED_TIME_UNKNOWN/);
});

test('release-path sampler denies writable, foreign or non-release modules',()=>{
 for(const path of [
  '/opt/servora-med/releases/'+'a'.repeat(39)+'/ops/scripts/trusted-time.mjs',
  '/opt/servora-med/releases/'+'A'.repeat(40)+'/ops/scripts/trusted-time.mjs',
  '/opt/servora-med/releases/'+'a'.repeat(40)+'/ops/scripts/other.mjs',
  '/opt/servora-med/releases/'+'a'.repeat(40)+'/ops/trusted-time.mjs',
  '/opt/servora-med/current/ops/scripts/trusted-time.mjs',
  '/opt/servora-lab/ops/scripts/trusted-time.mjs',
  new URL('../scripts/trusted-time.mjs',import.meta.url).pathname,
 ]) assert.throws(()=>time.validateTimeModuleContract(path,releaseFile(),releaseAncestors(),RELEASE_GID),/TRUSTED_TIME_UNKNOWN/);
 for(const file of [releaseFile({uid:1}),releaseFile({gid:0}),releaseFile({gid:RELEASE_GID+1}),releaseFile({mode:0o644}),releaseFile({mode:0o655}),releaseFile({mode:0o660}),releaseFile({nlink:2}),releaseFile({kind:'other'})])
  assert.throws(()=>time.validateTimeModuleContract(releaseModulePath,file,releaseAncestors(),RELEASE_GID),/TRUSTED_TIME_UNKNOWN/);
 for(const gid of [0,-1,1.5,999999]) assert.throws(()=>time.validateTimeModuleContract(releaseModulePath,releaseFile(),releaseAncestors(),gid),/TRUSTED_TIME_UNKNOWN/);
});

test('release-path ancestors deny group/other write, foreign owners and links',()=>{
 for(const index of [0,1,2]) {
  for(const ancestor of [{mode:0o752},{mode:0o757},{mode:0o775},{gid:RELEASE_GID+1},{gid:0},{uid:1},{kind:'file'},{kind:'other'}])
   assert.throws(()=>time.validateTimeModuleContract(releaseModulePath,releaseFile(),releaseAncestors({[index]:ancestor}),RELEASE_GID),/TRUSTED_TIME_UNKNOWN/);
 }
 for(const index of [3,4,5]) {
  for(const ancestor of [{mode:0o757},{mode:0o775},{gid:RELEASE_GID+1},{uid:1},{kind:'file'},{kind:'other'}])
   assert.throws(()=>time.validateTimeModuleContract(releaseModulePath,releaseFile(),releaseAncestors({[index]:ancestor}),RELEASE_GID),/TRUSTED_TIME_UNKNOWN/);
 }
});

test('installed collector denies release-style and writable module metadata',()=>{
 for(const file of [installedFile({gid:RELEASE_GID}),installedFile({mode:0o650}),installedFile({mode:0o664}),installedFile({uid:1}),installedFile({nlink:2}),installedFile({kind:'other'})])
  assert.throws(()=>time.validateTimeModuleContract(INSTALLED_MODULE,file,installedAncestors(),RELEASE_GID),/TRUSTED_TIME_UNKNOWN/);
 for(const index of [0,1,2,3]) {
  for(const ancestor of [{gid:RELEASE_GID},{mode:0o757},{mode:0o775},{uid:1},{kind:'file'}])
   assert.throws(()=>time.validateTimeModuleContract(INSTALLED_MODULE,installedFile(),installedAncestors({[index]:ancestor}),RELEASE_GID),/TRUSTED_TIME_UNKNOWN/);
 }
});
