import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {
  chmodSync,linkSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,
  renameSync,rmSync,symlinkSync,unlinkSync,utimesSync,writeFileSync
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {
  verifyHistoricalStageReadback,validateHistoricalStageReceipt,verifyFixedHistoricalStage
} from '../scripts/historical-stage-readback.mjs';
import {historicalFixture,ATTEMPT,ARCHIVED_PATHS} from './historical-recovery-fixture.mjs';

const digest=b=>createHash('sha256').update(b).digest('hex');
const invalid=fn=>assert.throws(fn,/RECOVERY_HISTORICAL_STAGE_READBACK_INVALID/);

function fixture(t){
  const f=historicalFixture(),tmp=mkdtempSync(join(tmpdir(),'servora-stage-readback-'));
  t.after(()=>rmSync(tmp,{recursive:true,force:true}));
  const stageRoot=join(tmp,ATTEMPT),receiptPath=join(tmp,ATTEMPT+'.stage-receipt.json');
  const allFiles=[...ARCHIVED_PATHS,'preserved/profile.json','preserved/disposition.json'];
  const entries=[];
  for(const dir of ['attempts','attempts/'+ATTEMPT,'admission-proofs','backups',
    'logs','logs/'+ATTEMPT,'preserved'])mkdirSync(join(stageRoot,dir),{recursive:true,mode:0o700});
  for(const rel of allFiles){
    const bytes=f.movedFiles.get(rel)??f.copies.get(rel);
    assert.ok(bytes,rel);
    const path=join(stageRoot,rel);
    writeFileSync(path,bytes,{mode:0o600});chmodSync(path,0o600);
    const mtimeNs=lstatSync(path,{bigint:true}).mtimeNs.toString();
    entries.push({archivePath:rel,sha256:digest(bytes),size:bytes.length,
      mtimeNs,mode:'0600'});
  }
  const receipt={
    formatVersion:1,kind:'HISTORICAL_RECOVERY_STAGE_ONLY',
    authority:'NOT_ARCHIVED_NOT_RETAINED_NO_SOURCE_REMOVAL',
    attemptId:ATTEMPT,sourceInventorySha256:'a'.repeat(64),
    dispositionSha256:digest(f.copies.get('preserved/disposition.json')),
    profileSha256:digest(f.copies.get('preserved/profile.json')),files:entries
  };
  const write=()=>writeFileSync(receiptPath,JSON.stringify(receipt)+'\n',{mode:0o600});
  write();
  return {stageRoot,receiptPath,receipt,entries,write,
    uid:process.getuid?.()??0,gid:process.getgid?.()??0};
}
const verify=f=>verifyHistoricalStageReadback({
  stageRoot:f.stageRoot,receiptPath:f.receiptPath,uid:f.uid,gid:f.gid});

test('readback validates exactly 28 staged bytes with no retention/archival claim',t=>{
  const f=fixture(t);
  assert.equal(validateHistoricalStageReceipt(f.receipt),f.receipt);
  const result=verify(f);
  assert.equal(result.status,'STAGE_READBACK_VERIFIED_ONLY');
  assert.equal(result.authority,'NOT_ARCHIVED_NOT_INDEPENDENTLY_RETAINED');
  assert.equal(result.filesVerified,28);
  assert.match(result.receiptSha256,/^[0-9a-f]{64}$/);
});

test('readback rejects tampered file bytes, mtime, mode, hardlinks and symlinks',t=>{
  for(const kind of ['data','mtime','mode','hardlink','symlink']){
    const f=fixture(t),path=join(f.stageRoot,ARCHIVED_PATHS[0]);
    if(kind==='data')writeFileSync(path,'corrupted');
    if(kind==='mtime')utimesSync(path,new Date('2020-01-01'),new Date('2020-01-01'));
    if(kind==='mode')chmodSync(path,0o644);
    if(kind==='hardlink')linkSync(path,path+'.hardlink');
    if(kind==='symlink'){
      renameSync(path,path+'.original');symlinkSync(path+'.original',path);
    }
    invalid(()=>verify(f));
  }
});

test('readback rejects missing and extra tree entries',t=>{
  for(const kind of ['missing','extra']){
    const f=fixture(t),path=join(f.stageRoot,ARCHIVED_PATHS[0]);
    if(kind==='missing')unlinkSync(path);
    else writeFileSync(path+'.unexpected','unexpected',{mode:0o600});
    invalid(()=>verify(f));
  }
});

test('readback refuses tampered receipts, duplicate entries and fake retention authority',t=>{
  for(const mutate of [
    r=>r.files.pop(),
    r=>r.files.push(r.files[0]),
    r=>r.files[0].mtimeNs='123.44',
    r=>r.files[0].sha256='0'.repeat(64),
    r=>r.files[0].archivePath='../../untrusted',
    r=>r.profileSha256='0'.repeat(64),
    r=>r.dispositionSha256='0'.repeat(64),
    r=>r.authority='INDEPENDENTLY_RETAINED',
    r=>{r.newKey=true;}
  ]){
    const f=fixture(t);mutate(f.receipt);f.write();invalid(()=>verify(f));
  }
});

test('production fixed path readback is root-only',t=>{
  t.mock.method(process,'getuid',()=>1001);
  assert.throws(()=>verifyFixedHistoricalStage(),
    /RECOVERY_HISTORICAL_STAGE_READBACK_ADMIN_REQUIRED/);
});
