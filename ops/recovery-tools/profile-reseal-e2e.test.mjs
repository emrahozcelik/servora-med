// Disposable-container end-to-end acceptance for the root-only profile re-seal.
//
// This test writes the fixed production paths inside a throwaway Linux
// container. It is hard-gated to Docker (/.dockerenv), Linux, uid 0 and the
// explicit PROFILE_RESEAL_CONTAINER_TEST=1 opt-in. It must never run on a real
// host.
//
// The historical evidence, approval, adoption, checkpoints, dumps and logs are
// synthetic. No production dump, approval, secret or profile is opened. The
// real wrapper, real module, real lock library, real controller, real evidence
// layer and a real PostgreSQL cluster are used. TT-A is the only substituted
// adapter: a non-privileged container cannot run systemd/chrony/NTS, so a
// schema-valid v2 evidence record is supplied at the installed module boundary
// while the real validator still consumes it.
import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createE2eHost} from './profile-reseal-e2e-fixture.mjs';

const PROFILE='/var/lib/servora-med/deploy/profile.json';
const TOOL='/usr/local/libexec/servora-med-profile-reseal/profile-reseal';
const enabled=process.env.PROFILE_RESEAL_CONTAINER_TEST==='1'
  &&process.platform==='linux'&&process.getuid?.()===0&&fs.existsSync('/.dockerenv');
const hash=value=>createHash('sha256').update(value).digest('hex');

const run=args=>spawnSync(TOOL,args,{encoding:'utf8',timeout:60000});

test('real wrapper performs a successful atomic re-seal end to end',{skip:!enabled},async t=>{
  const host=createE2eHost();
  t.after(host.cleanup);

  // The reviewed install bytes and the real production modules are the ones
  // actually exercised. TT-A is the documented synthetic adapter only.
  assert.equal(host.installedHashes.wrapper,
    'dc4be7b49edf294ac6ab3d82b7c588ef75746a5b34a0e3685e904b767050548e');
  assert.equal(host.installedHashes.module,
    'c069b9ebdb695987f99525ec481830a1fb5de0c068137053af64c13583f4ca2f');
  assert.equal(host.installedHashes.evidence,
    'c6c4eada519183056a05d8c982ef4eaba311289ed271456182a665b7362d254f');
  assert.equal(host.installedHashes.controller,
    '7f50d0cdea947cb4d22d95cac908a99eab66aecfcbd81f00051cb1aa2b947604');
  assert.equal(host.installedHashes.helper,
    '3455e5881baf770458bc044ca73c50660b75822ec0827a42c9eb7ea39575363c');
  assert.equal(host.installedHashes.ttAReal,
    'd28fb396527bf91a25ab73fd8dd4f5f3138e2279efc1c6414cdf0d44d93717ab');
  assert.notEqual(host.installedHashes.ttASynthetic,host.installedHashes.ttAReal);

  const dry=run(['--dry-run']);
  assert.equal(dry.status,0,`dry-run failed:\n${dry.stderr}`);
  const dryResult=JSON.parse(dry.stdout);
  console.log('E2E_DRY_RUN',JSON.stringify({status:dryResult.status,
    oldProfileSha256:dryResult.oldProfileSha256,
    candidateProfileSha256:dryResult.candidateProfileSha256,
    historicalStatus:dryResult.historicalStatus,ttAFormatVersion:dryResult.ttAFormatVersion,
    changedContracts:dryResult.changedContracts.map(item=>item.key)}));
  assert.equal(dryResult.status,'DRY_RUN_OK');
  assert.equal(dryResult.oldProfileSha256,host.oldProfileSha256);
  assert.equal(dryResult.candidateProfileSha256,host.expectedCandidate);
  assert.equal(dryResult.historicalStatus,'IN_PLACE_PRESERVATION_VERIFIED');
  assert.equal(dryResult.ttAFormatVersion,2);
  assert.deepEqual(dryResult.changedContracts.map(item=>item.key).sort(),
    Object.keys(host.liveContracts).sort());
  assert.equal(hash(fs.readFileSync(PROFILE)),host.oldProfileSha256);
  assert.deepEqual(host.snapshot(),host.before);

  const applied=run(['--apply','--expected-old',host.oldProfileSha256,
    '--expected-candidate',host.expectedCandidate]);
  assert.equal(applied.status,0,`apply failed:\n${applied.stderr}`);
  const applyResult=JSON.parse(applied.stdout);
  console.log('E2E_APPLY',JSON.stringify({status:applyResult.status,
    oldProfileSha256:applyResult.oldProfileSha256,
    newProfileSha256:applyResult.newProfileSha256,
    historicalStatus:applyResult.historicalStatus}));
  assert.equal(applyResult.status,'PROFILE_RESEALED');
  assert.equal(applyResult.newProfileSha256,host.expectedCandidate);

  const published=fs.readFileSync(PROFILE);
  assert.equal(hash(published),host.expectedCandidate);
  assert.equal(published.toString(),JSON.stringify(host.expectedProfile)+'\n');
  const info=fs.statSync(PROFILE,{bigint:true});
  assert.equal(info.uid,0n);
  assert.equal(info.gid,0n);
  assert.equal(info.mode&0o7777n,0o600n);
  assert.equal(info.nlink,1n);
  const profile=JSON.parse(published);
  assert.deepEqual(profile.contracts,host.liveContracts);
  assert.equal(profile.machineId,host.oldProfile.machineId);
  assert.equal(profile.databaseIdentity.clusterId,host.oldProfile.databaseIdentity.clusterId);
  assert.equal(profile.databaseIdentity.databaseOid,host.oldProfile.databaseIdentity.databaseOid);
  assert.equal(profile.envBaselineSha256,host.oldProfile.envBaselineSha256);

  // Every historical byte, staged copy, disposition, receipt, approval,
  // adoption, baseline and emergency record is untouched.
  assert.deepEqual(host.snapshot(),host.before);

  // No temp file, pending marker or new attempt/initialization exists.
  const state='/var/lib/servora-med/deploy';
  assert.deepEqual(fs.readdirSync(state).filter(name=>name.endsWith('.tmp')),[]);
  for(const marker of [state+'/active.json',state+'/activation.block',
    '/run/servora-med-recovery/start.permit',
    '/etc/systemd/system/servora-med.service.d/90-servora-recovery.conf']){
    assert.equal(fs.existsSync(marker),false,marker);
  }
  assert.deepEqual(fs.readdirSync(state+'/initializations'),[]);
  assert.deepEqual(fs.readdirSync(state+'/attempts'),[host.attemptId]);

  // The production wrapper and the module both refuse a non-root caller before
  // reading any state. Temporarily make the directory traversable so the
  // script-level EUID check is exercised, then restore the root-only mode.
  const toolDir='/usr/local/libexec/servora-med-profile-reseal';
  fs.chmodSync(toolDir,0o755);
  fs.chmodSync(TOOL,0o755);
  try{
    const nonRootWrapper=spawnSync(TOOL,['--dry-run'],{encoding:'utf8',timeout:10000,
      uid:65534,gid:65534});
    assert.equal(nonRootWrapper.status,1);
    assert.match(nonRootWrapper.stderr,/PROFILE_RESEAL_ADMIN_REQUIRED/);
    const nonRootModule=spawnSync('/usr/bin/node',
      ['--no-addons',toolDir+'/profile-reseal.mjs','--dry-run'],
      {encoding:'utf8',timeout:10000,uid:65534,gid:65534});
    assert.equal(nonRootModule.status,1);
    assert.match(nonRootModule.stderr,/PROFILE_RESEAL_ADMIN_REQUIRED/);
  }finally{
    fs.chmodSync(TOOL,0o750);
    fs.chmodSync(toolDir,0o750);
  }

  // A second apply is a one-shot failure. The new profile is not rewritten.
  const second=run(['--apply','--expected-old',host.oldProfileSha256,
    '--expected-candidate',host.expectedCandidate]);
  assert.equal(second.status,1);
  assert.match(second.stderr,/PROFILE_RESEAL_DISPOSITION_INVALID/);
  assert.equal(hash(fs.readFileSync(PROFILE)),host.expectedCandidate);
  assert.deepEqual(host.snapshot(),host.before);

  // The real historical gate still accepts the post-reseal state.
  const gate=await host.verifyHistoricalGate();
  assert.equal(gate.status,'IN_PLACE_PRESERVATION_VERIFIED');
  assert.equal(gate.filesVerified,26);
});
