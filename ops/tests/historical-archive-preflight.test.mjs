import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {
  validateHistoricalSourceInventory,captureHistoricalSourceInventory
} from '../scripts/historical-archive-preflight.mjs';
import {
  historicalFixture,ARCHIVED_PATHS,ATTEMPT,STATE,LOG_FILES
} from './historical-recovery-fixture.mjs';

const hash=x=>createHash('sha256').update(x).digest('hex');
const NS='1762770600000000000';
const dirs=['attempts','initializations','admission-proofs','backups','logs',
  'attempts/'+ATTEMPT,'logs/'+ATTEMPT];
const children={
  attempts:[ATTEMPT],initializations:[],
  'admission-proofs':[ATTEMPT+'.json'],
  backups:[ATTEMPT+'-pre.dump',ATTEMPT+'-post.dump'],
  logs:[ATTEMPT],
  ['attempts/'+ATTEMPT]:ARCHIVED_PATHS.filter(p=>p.startsWith('attempts/')).map(p=>p.split('/').at(-1)),
  ['logs/'+ATTEMPT]:LOG_FILES
};
const markers=[
  STATE+'/active.json',STATE+'/activation.block',
  '/run/servora-med-recovery/start.permit',
  '/etc/systemd/system/servora-med.service.d/90-servora-recovery.conf'
];

function inventory(){
  const f=historicalFixture();
  return {formatVersion:1,kind:'HISTORICAL_RECOVERY_SOURCE_INVENTORY',attemptId:ATTEMPT,
    authority:'READ_ONLY_NOT_ARCHIVE_ACCEPTANCE',
    files:[...f.movedFiles].map(([rel,bytes])=>({
      sourcePath:STATE+'/'+rel,archivePath:rel,type:'file',uid:0,gid:0,nlink:1,
      mode:rel.startsWith('logs/'+ATTEMPT+'/postdeploy-operator-')?'0644':'0600',
      mtimeNs:NS,size:bytes.length,sha256:hash(bytes)
    })),
    directories:Object.fromEntries(dirs.map(name=>[STATE+'/'+name,
      {type:'directory',uid:0,gid:0,mode:'0700',mtimeNs:NS,children:children[name]}])),
    pendingMarkers:Object.fromEntries(markers.map(x=>[x,false]))
  };
}
const invalid=x=>assert.throws(()=>validateHistoricalSourceInventory(x),
  /RECOVERY_HISTORICAL_INVENTORY_INVALID/);

test('exact 26 historical files and seven directory states pass read-only inventory validation',()=>{
  const x=inventory();
  assert.equal(x.files.length,26);
  assert.equal(validateHistoricalSourceInventory(x),x);
  assert.equal(x.authority,'READ_ONLY_NOT_ARCHIVE_ACCEPTANCE');
});

test('unexpected files or metadata fail closed',()=>{
  const mutations=[
    x=>x.files.pop(),
    x=>x.files.push(x.files[0]),
    x=>x.files[0].sourcePath='/tmp/untrusted',
    x=>x.files[0].archivePath='attempts/untrusted/0000.json',
    x=>x.files[0].uid=1000,
    x=>x.files[0].gid=1000,
    x=>x.files[0].nlink=2,
    x=>x.files[0].mode='0644',
    x=>x.files[0].mtimeNs='12.5',
    x=>x.files[0].sha256='0',
    x=>x.files[0].size=0,
    x=>x.directories[STATE+'/logs'].children.push('unexpected'),
    x=>x.directories[STATE+'/attempts/'+ATTEMPT].mode='0755',
    x=>x.directories[STATE+'/logs/'+ATTEMPT].mtimeNs='-1',
    x=>{delete x.directories[STATE+'/initializations'];},
    x=>x.pendingMarkers[STATE+'/active.json']=true,
    x=>x.authority='ARCHIVE_COMPLETE'
  ];
  for(const mutate of mutations){
    const x=inventory();mutate(x);invalid(x);
  }
});

test('archive inventory cannot be gathered by an unprivileged caller',t=>{
  t.mock.method(process,'getuid',()=>1001);
  assert.throws(()=>captureHistoricalSourceInventory(),
    /RECOVERY_HISTORICAL_INVENTORY_ADMIN_REQUIRED/);
});

test('the original postdeploy operator log and rc modes remain 0644 in the source inventory',()=>{
  const x=inventory();
  const operator=x.files.filter(v=>v.archivePath.includes('/postdeploy-operator-'));
  assert.equal(operator.length,2);
  assert.ok(operator.every(v=>v.mode==='0644'));
});
