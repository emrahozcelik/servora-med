import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,
  lstatSync,chmodSync,existsSync,rmSync,utimesSync,symlinkSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {
  stageHistoricalEvidence,stageHistoricalArchive
} from '../scripts/historical-archive-stage.mjs';
import {validateHistoricalSourceInventory} from '../scripts/historical-archive-preflight.mjs';
import {
  historicalFixture,ATTEMPT,STATE,ARCHIVED_PATHS
} from './historical-recovery-fixture.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const uid=process.getuid?.()??0;
const linux=process.platform==='linux'&&existsSync('/usr/bin/cp');
const dirs=['attempts','initializations','admission-proofs','backups','logs',
  'attempts/'+ATTEMPT,'logs/'+ATTEMPT];
const markerNames=[
  STATE+'/active.json',STATE+'/activation.block',
  '/run/servora-med-recovery/start.permit',
  '/etc/systemd/system/servora-med.service.d/90-servora-recovery.conf'
];
function makeFixture(t){
  const fixture=historicalFixture();
  const temp=mkdtempSync(join(tmpdir(),'servora-historical-stage-'));
  t.after(()=>rmSync(temp,{recursive:true,force:true}));
  const sourceRoot=join(temp,'source'),stagingParent=join(temp,'stage');
  mkdirSync(sourceRoot,{mode:0o700});
  mkdirSync(stagingParent,{mode:0o700});
  for(const dir of dirs)mkdirSync(join(sourceRoot,dir),{recursive:true,mode:0o700});
  mkdirSync(join(sourceRoot,'historical-dispositions'),{mode:0o700});
  for(const [rel,bytes] of fixture.movedFiles){
    const path=join(sourceRoot,rel);
    writeFileSync(path,bytes,{mode:0o600});
    chmodSync(path,rel.startsWith('logs/'+ATTEMPT+'/postdeploy-operator-')?0o644:0o600);
  }
  writeFileSync(join(sourceRoot,'profile.json'),fixture.oldProfileBytes,{mode:0o600});
  writeFileSync(join(sourceRoot,'historical-dispositions',ATTEMPT+'.json'),fixture.dispositionBytes,{mode:0o600});
  const snapshot=()=>{
    const files=ARCHIVED_PATHS.map(rel=>{
      const path=join(sourceRoot,rel),s=lstatSync(path,{bigint:true}),data=readFileSync(path);
      return {sourcePath:STATE+'/'+rel,archivePath:rel,type:'file',uid:0,gid:0,nlink:1,
        mode:rel.startsWith('logs/'+ATTEMPT+'/postdeploy-operator-')?'0644':'0600',
        mtimeNs:s.mtimeNs.toString(),size:data.length,sha256:sha(data)};
    });
    const directories=Object.fromEntries(dirs.map(dir=>{
      const path=join(sourceRoot,dir),s=lstatSync(path,{bigint:true});
      return [STATE+'/'+dir,{type:'directory',uid:0,gid:0,mode:'0700',
        mtimeNs:s.mtimeNs.toString(),children:readdirSync(path)}];
    }));
    return validateHistoricalSourceInventory({
      formatVersion:1,kind:'HISTORICAL_RECOVERY_SOURCE_INVENTORY',attemptId:ATTEMPT,
      authority:'READ_ONLY_NOT_ARCHIVE_ACCEPTANCE',files,directories,
      pendingMarkers:Object.fromEntries(markerNames.map(path=>[path,false]))
    });
  };
  return {fixture,sourceRoot,stagingParent,snapshot};
}

test('OPS-R4-005 staging copies exactly 28 files, preserves source and nanosecond mtimes',{
  skip:!linux
},t=>{
  const {sourceRoot,stagingParent,snapshot}=makeFixture(t);
  const inventory=snapshot();
  const original=inventory.files.map(f=>[f.sourcePath,f.sha256,f.mtimeNs,f.mode]);
  const result=stageHistoricalEvidence({sourceRoot,stagingParent,inventory,uid});
  assert.equal(result.status,'STAGED_ONLY_NO_SOURCE_REMOVAL');
  assert.equal(result.files,28);
  const stageRoot=join(stagingParent,ATTEMPT);
  assert.equal(readdirSync(stageRoot).sort().join(','),
    'admission-proofs,attempts,backups,logs,preserved');
  for(const file of inventory.files){
    const source=join(sourceRoot,file.archivePath);
    const staged=join(stageRoot,file.archivePath);
    assert.ok(existsSync(source));
    assert.equal(sha(readFileSync(source)),file.sha256);
    assert.equal(sha(readFileSync(staged)),file.sha256);
    assert.equal(lstatSync(staged,{bigint:true}).mtimeNs.toString(),file.mtimeNs);
    assert.equal(Number(lstatSync(staged).mode&0o7777),0o600);
  }
  const after=snapshot();
  assert.deepEqual(after.files.map(f=>[f.sourcePath,f.sha256,f.mtimeNs,f.mode]),original);
  assert.equal(sha(readFileSync(join(stageRoot,'preserved/profile.json'))),
    sha(readFileSync(join(sourceRoot,'profile.json'))));
  assert.equal(sha(readFileSync(join(stageRoot,'preserved/disposition.json'))),
    sha(readFileSync(join(sourceRoot,'historical-dispositions',ATTEMPT+'.json'))));
  const receipt=JSON.parse(readFileSync(join(stagingParent,ATTEMPT+'.stage-receipt.json'),'utf8'));
  assert.equal(receipt.authority,'NOT_ARCHIVED_NOT_RETAINED_NO_SOURCE_REMOVAL');
  assert.equal(receipt.files.length,28);
  assert.ok(receipt.files.every(f=>f.mode==='0600'));
});

test('second staging attempt refuses existing archive staging and never overwrites', {
  skip:!linux
},t=>{
  const {sourceRoot,stagingParent,snapshot}=makeFixture(t);
  const inventory=snapshot();
  stageHistoricalEvidence({sourceRoot,stagingParent,inventory,uid});
  const original=readFileSync(join(stagingParent,ATTEMPT+'.stage-receipt.json'));
  assert.throws(()=>stageHistoricalEvidence({sourceRoot,stagingParent,inventory,uid}),
    /RECOVERY_HISTORICAL_STAGE_ALREADY_PRESENT/);
  assert.deepEqual(readFileSync(join(stagingParent,ATTEMPT+'.stage-receipt.json')),original);
});

test('changed source mtime, bytes, or symlink refuses copy without deleting sources',{
  skip:!linux
},t=>{
  for(const kind of ['mtime','bytes','symlink']){
    const f=makeFixture(t),inventory=f.snapshot();
    const source=join(f.sourceRoot,ARCHIVED_PATHS[0]);
    if(kind==='mtime')utimesSync(source,new Date('2026-10-01'),new Date('2026-10-01'));
    if(kind==='bytes')writeFileSync(source,Buffer.from('different'));
    if(kind==='symlink'){
      // A fake source link must never be followed into the staging archive.
      const old=source+'.original';
      renameSync(source,old);symlinkSync(old,source);
    }
    assert.throws(()=>stageHistoricalEvidence({
      sourceRoot:f.sourceRoot,stagingParent:f.stagingParent,inventory,uid
    }),/RECOVERY_HISTORICAL_STAGE_INVALID/);
    assert.ok(existsSync(source));
  }
});

test('tampered disposition/profile binding fails before creating stage',t=>{
  const f=makeFixture(t),inventory=f.snapshot();
  writeFileSync(join(f.sourceRoot,'profile.json'),Buffer.from('{"mismatch":true}\n'));
  assert.throws(()=>stageHistoricalEvidence({
    sourceRoot:f.sourceRoot,stagingParent:f.stagingParent,inventory,uid
  }),/RECOVERY_HISTORICAL_STAGE_INVALID/);
  assert.equal(existsSync(join(f.stagingParent,ATTEMPT)),false);
});

test('root-only CLI rejects unprivileged execution before touching production',t=>{
  t.mock.method(process,'getuid',()=>1001);
  assert.throws(()=>stageHistoricalArchive(),
    /RECOVERY_HISTORICAL_STAGE_ADMIN_REQUIRED/);
});
