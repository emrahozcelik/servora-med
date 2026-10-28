import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { validateInstalledOldAdoption, issueInstalledOldAdoption } from '../scripts/deployment-controller.mjs';
import { approvalFixture, timeEvidenceAt } from './trusted-time-fixture.mjs';
import {adoptionHost} from './installed-old-adoption-fixture.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const jsonHash = value => hash(JSON.stringify(value)+'\n');
const oldSha = '71ae6df6dd0659ed6390a6785d4bab29ddf5b1fa';
const original = '6f9dbb6a211813fd0d6d5e92396b71045d506eb959cd98d883e257663af79672';
const directory = new URL('../../server/src/db/migrations/',import.meta.url);
const catalog = readdirSync(directory).filter(name=>/^\d{3}_.*\.sql$/.test(name)).sort().slice(0,55)
  .map(name=>({version:name.slice(0,-4),sha256:hash(readFileSync(new URL(name,directory)))}));

function fixture() {
  const approval={...approvalFixture(),oldReleaseSha:oldSha,oldArtifactSha256:original,
    oldCatalog:catalog,targetCatalog:catalog};
  const databaseIdentity={clusterId:'1',databaseName:'servora_med_test_adoption',databaseOid:'1',role:'servora_app',host:'127.0.0.1',port:5432};
  const profile={machineId:'1'.repeat(32),databaseIdentity};
  const baseline={formatVersion:1,kind:'RECOVERY_BASELINE_NOT_ORIGINAL_ARTIFACT',
    baselineId:'20261012T090000Z-issue369-71ae6df6',createdAtUTC:approval.issuedAtUTC,completedAtUTC:approval.issuedAtUTC,
    machineId:profile.machineId,sourceReleaseSha:oldSha,originalArtifactSha256:original,
    installedContentManifestSha256:'5'.repeat(64),databaseIdentity,catalog,restoreAcceptance:false,
    verifications:{dumpList:true,dumpCatalogExact:true,adoptedArchiveComparedToInstalled:true,configurationArchiveCompared:true,originalObservationAndMarkerUnchanged:true,appPidUnchanged:true},
    files:Object.fromEntries(['database.dump','installed-old-release.adopted.tar.gz','configuration.tar.gz','database-metadata.json','installed-old-content.sha256'].map(name=>[name,{name,sha256:'6'.repeat(64),bytes:10}]))};
  const context={approval,approvalSha256:'4'.repeat(64),profile};
  baseline.files['installed-old-content.sha256'].sha256=baseline.installedContentManifestSha256;
  const record={formatVersion:1,kind:'ADOPTED_INSTALLED_OLD_FIRST_CUTOVER',attemptId:approval.attemptId,
    approvalSha256:context.approvalSha256,profileSha256:approval.profileSha256,machineId:profile.machineId,
    oldReleaseSha:oldSha,originalArtifactSha256:original,oldCatalogSha256:jsonHash(catalog),
    oldContentManifestSha256:baseline.installedContentManifestSha256,targetReleaseSha:approval.releaseSha,
    targetTreeSha:approval.treeSha,targetArtifactSha256:approval.artifactSha256,
    baselineId:baseline.baselineId,baselineManifestSha256:jsonHash(baseline),
    adoptedArchiveSha256:baseline.files['installed-old-release.adopted.tar.gz'].sha256,
    databaseDumpSha256:baseline.files['database.dump'].sha256,attestedTime:timeEvidenceAt()};
  return {record,context,baseline,baselineSha256:jsonHash(baseline)};
}

test('first cutover accepts one root-sealed exact OLD/baseline binding without replacing original identity',()=>{
  const {record,context,baseline,baselineSha256}=fixture();
  assert.equal(validateInstalledOldAdoption(record,context,baseline,baselineSha256),record);
  assert.equal(context.approval.oldArtifactSha256,original);
  assert.notEqual(record.adoptedArchiveSha256,original);
});

test('rejects a recovery payload whose content-manifest digest contradicts its identity',()=>{
  const f=fixture();
  f.baseline.files['installed-old-content.sha256'].sha256='7'.repeat(64);
  f.record.baselineManifestSha256=f.baselineSha256=jsonHash(f.baseline);
  assert.throws(()=>validateInstalledOldAdoption(f.record,f.context,f.baseline,f.baselineSha256));
});

test('the deploy user cannot issue installed OLD authority',t=>{
  t.mock.method(process,'getuid',()=>1001);
  assert.throws(()=>issueInstalledOldAdoption('11111111-1111-4111-8111-111111111111',
    '20261012T090000Z-issue369-71ae6df6'),/RECOVERY_ADOPTION_ADMIN_REQUIRED/);
});

test('administrator independently verifies and exclusively seals a separate first-cutover record',async t=>{
  const f=fixture(),host=await adoptionHost(f);t.after(host.cleanup);
  const sealed=host.controller.issueInstalledOldAdoption(f.context.approval.attemptId,f.baseline.baselineId);
  assert.deepEqual(sealed.record,f.record);
  assert.equal(host.files.get(host.recordFile).mode,0o600);
  assert.equal(host.files.get(host.root+'/.servora-release-artifact.sha256').data.toString(),original+'\n');
  assert.ok(host.commands.some(([file,...args])=>file==='/usr/bin/tar'&&args.includes('--compare')));
  assert.ok(host.commands.some(([file,...args])=>file==='/usr/bin/pg_restore'&&args.includes('--list')));
});

// Resealing keeps a mutation internally consistent, so each negative below
// fails on the rule it targets rather than on a stale digest.
function reseal(f) {
  f.record.baselineManifestSha256=f.baselineSha256=jsonHash(f.baseline);
  f.record.oldContentManifestSha256=f.baseline.installedContentManifestSha256;
  f.record.adoptedArchiveSha256=f.baseline.files['installed-old-release.adopted.tar.gz'].sha256;
  f.record.databaseDumpSha256=f.baseline.files['database.dump'].sha256;
  return f;
}
const rejects=(f,pattern)=>{const g=reseal(f);
  assert.throws(()=>validateInstalledOldAdoption(g.record,g.context,g.baseline,g.baselineSha256),pattern);};

test('rejects an approval for any release other than the installed OLD',()=>{
  const f=fixture();f.context.approval.oldReleaseSha='0'.repeat(40);
  rejects(f,/RECOVERY_INSTALLED_OLD_ADOPTION_INVALID/);
});

test('rejects an approval that renames the missing original artifact digest',()=>{
  const f=fixture();f.context.approval.oldArtifactSha256='9'.repeat(64);
  rejects(f,/RECOVERY_INSTALLED_OLD_ADOPTION_INVALID/);
});

test('rejects an approved OLD catalog that is not the preserved one',()=>{
  const f=fixture();f.context.approval.oldCatalog=catalog.slice(0,54);
  rejects(f,/RECOVERY_INSTALLED_OLD_ADOPTION_INVALID/);
});

test('rejects a foreign machine identity',()=>{
  const f=fixture();f.context.profile={...f.context.profile,machineId:'2'.repeat(32)};
  rejects(f,/RECOVERY_INSTALLED_OLD_ADOPTION_INVALID/);
});

test('rejects an attestation sampled outside the original grant window',()=>{
  const f=fixture();f.record.attestedTime=timeEvidenceAt(Date.parse('2026-10-12T12:00:00.001Z'));
  rejects(f,/ATTEMPT_APPROVAL_TIME_INVALID/);
});

test('rejects a baseline that completed after the attestation',()=>{
  const f=fixture();f.baseline.completedAtUTC='2026-10-12T09:00:00.001Z';
  rejects(f,/RECOVERY_INSTALLED_OLD_ADOPTION_INVALID/);
});

test('rejects a baseline that claims restore acceptance',()=>{
  const f=fixture();f.baseline.restoreAcceptance=true;
  rejects(f,/RECOVERY_INSTALLED_OLD_ADOPTION_INVALID/);
});

test('rejects a baseline that omits a required static verification',()=>{
  const f=fixture();f.baseline.verifications={...f.baseline.verifications,appPidUnchanged:false};
  rejects(f,/RECOVERY_INSTALLED_OLD_ADOPTION_INVALID/);
});

test('rejects a baseline from a different database identity',()=>{
  const f=fixture();f.baseline.databaseIdentity={...f.baseline.databaseIdentity,databaseName:'other_db'};
  rejects(f,/RECOVERY_INSTALLED_OLD_ADOPTION_INVALID/);
});

test('rejects a record that carries extra or missing keys',()=>{
  const f=fixture();delete f.record.attestedTime;
  rejects(f,/RECOVERY_INSTALLED_OLD_ADOPTION_INVALID/);
});

test('rejects an adopted archive that reuses the original artifact digest',()=>{
  const f=fixture();f.baseline.files['installed-old-release.adopted.tar.gz'].sha256=original;
  rejects(f,/RECOVERY_INSTALLED_OLD_ADOPTION_INVALID/);
});

test('rejects a baseline identifier outside the single authorised cutover slot',()=>{
  const f=fixture();f.baseline.baselineId='20261012T090000Z-issue369-deadbeef';
  rejects(f,/RECOVERY_INSTALLED_OLD_ADOPTION_INVALID/);
});

test('rejects a target binding that differs from the grant',()=>{
  const f=fixture();f.record.targetReleaseSha='f'.repeat(40);
  rejects(f,/RECOVERY_INSTALLED_OLD_ADOPTION_INVALID/);
});

// Every host-level rejection must also leave no partially published record.
async function refuses(t,mutate,pattern) {
  const f=fixture(),host=await adoptionHost(f);t.after(host.cleanup);
  mutate(host,f);
  assert.throws(()=>host.controller.issueInstalledOldAdoption(f.context.approval.attemptId,f.baseline.baselineId),pattern);
  assert.equal(host.files.has(host.recordFile),false,'no partial adoption record');
  return host;
}

test('refuses adoption when a retained OLD archive is present',async t=>{
  await refuses(t,host=>host.add('/var/lib/servora-med/deploy/artifacts/'+oldSha+'.tar.gz','retained',0o600),
    /RECOVERY_INSTALLED_OLD_ADOPTION_INVALID/);
});

test('refuses adoption while another attempt owns the host',async t=>{
  await refuses(t,host=>host.add('/var/lib/servora-med/deploy/active.json',
    JSON.stringify({attemptId:'11111111-1111-4111-8111-111111111111',approvalSha256:'4'.repeat(64)})+'\n'),
    /RECOVERY_ADOPTION_STATE_NOT_EMPTY/);
});

test('refuses adoption when an admission record already exists',async t=>{
  // Whichever guard observes the record first must refuse publication; the
  // contract under test is that no adoption record is ever written.
  await refuses(t,host=>host.add('/var/lib/servora-med/deploy/attempts/'
    +'11111111-1111-4111-8111-111111111111/0000.json','{}\n'),
    /RECOVERY_(?:ADOPTION_STATE_NOT_EMPTY|INITIALIZATION_CONFLICT)/);
});

test('refuses an adopted archive whose member list differs from the installed release',async t=>{
  await refuses(t,host=>{host.names.push('./unexpected');host.types.push('-');},
    /RECOVERY_INSTALLED_OLD_ADOPTION_INVALID/);
});

test('refuses an adopted archive whose member types differ from the installed release',async t=>{
  // Flip the recorded type so the member can never match the installed release.
  await refuses(t,host=>{host.types[1]=host.types[1]==='d'?'-':'d';},
    /RECOVERY_INSTALLED_OLD_ADOPTION_INVALID/);
});

test('refuses adoption when the dump cannot be listed',async t=>{
  await refuses(t,host=>{host.failCommand='/usr/bin/pg_restore';},/command failed/);
});

test('refuses adoption when the installed content marker changed after the baseline',async t=>{
  await refuses(t,host=>host.add(host.root+'/.servora-release-content.sha256','tampered\n'),
    /RECOVERY_RELEASE_UNPROVEN/);
});

test('refuses adoption when the payload bytes no longer match the baseline manifest',async t=>{
  await refuses(t,(host,f)=>{const path='/var/lib/servora-med-recovery-baselines/'
    +f.baseline.baselineId+'/database.dump';host.files.get(path).data=Buffer.from('synthetic drift');},
    /RECOVERY_INSTALLED_OLD_ADOPTION_INVALID/);
});

test('a sealed adoption is permanent and cannot be reissued',async t=>{
  const f=fixture(),host=await adoptionHost(f);t.after(host.cleanup);
  host.controller.issueInstalledOldAdoption(f.context.approval.attemptId,f.baseline.baselineId);
  const before=Buffer.from(host.files.get(host.recordFile).data);
  assert.throws(()=>host.controller.issueInstalledOldAdoption(f.context.approval.attemptId,f.baseline.baselineId),
    /RECOVERY_ADOPTION_ALREADY_SEALED/);
  assert.deepEqual(host.files.get(host.recordFile).data,before);
});

test('a partially published adoption burns the slot instead of being repaired',async t=>{
  // A crash between exclusive create and fsync leaves an unusable record. The
  // operator cannot renew, overwrite or repair it; a new grant is required.
  const f=fixture(),host=await adoptionHost(f);t.after(host.cleanup);
  host.add(host.recordFile,'{"formatVersion":1,"kind":"ADOPTED_INST');
  assert.throws(()=>host.controller.issueInstalledOldAdoption(f.context.approval.attemptId,f.baseline.baselineId),
    /RECOVERY_ADOPTION_ALREADY_SEALED/);
  assert.equal(host.files.get(host.recordFile).data.toString(),'{"formatVersion":1,"kind":"ADOPTED_INST');
});

test('OLD verification accepts the installed release only through a sealed adoption',async t=>{
  const f=fixture(),host=await adoptionHost(f);t.after(host.cleanup);
  assert.throws(()=>host.controller.verifyAttemptRelease(f.context.approval.attemptId,'old'),
    /RECOVERY_RELEASE_UNPROVEN/,'absent retention and absent adoption is unproven');
  host.controller.issueInstalledOldAdoption(f.context.approval.attemptId,f.baseline.baselineId);
  assert.doesNotThrow(()=>host.controller.verifyAttemptRelease(f.context.approval.attemptId,'old'));
});

test('OLD verification never falls back to adoption when the retained archive is corrupt',async t=>{
  const f=fixture(),host=await adoptionHost(f);t.after(host.cleanup);
  host.controller.issueInstalledOldAdoption(f.context.approval.attemptId,f.baseline.baselineId);
  host.add('/var/lib/servora-med/deploy/artifacts/'+oldSha+'.tar.gz','not the approved bytes',0o600);
  assert.throws(()=>host.controller.verifyAttemptRelease(f.context.approval.attemptId,'old'),
    /RECOVERY_RELEASE_UNPROVEN/);
});
