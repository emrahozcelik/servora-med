import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import { validateInstalledOldAdoption, issueInstalledOldAdoption } from '../scripts/deployment-controller.mjs';
import {timeEvidenceAt} from './trusted-time-fixture.mjs';
import {adoptionHost,adoptionFixture as fixture} from './installed-old-adoption-fixture.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const jsonHash = value => hash(JSON.stringify(value)+'\n');
const oldSha = '71ae6df6dd0659ed6390a6785d4bab29ddf5b1fa';
const original = '6f9dbb6a211813fd0d6d5e92396b71045d506eb959cd98d883e257663af79672';
const directory = new URL('../../server/src/db/migrations/',import.meta.url);
const catalog = readdirSync(directory).filter(name=>/^\d{3}_.*\.sql$/.test(name)).sort().slice(0,55)
  .map(name=>({version:name.slice(0,-4),sha256:hash(readFileSync(new URL(name,directory)))}));


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
  // operator cannot renew, overwrite or repair it; a separate decision is required.
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

test('adoption independently refuses a dump ledger differing from OLD despite true manifest flags',async t=>{
  await refuses(t,host=>{host.dumpLedger='COPY public.schema_migrations (version, applied_at) FROM stdin;\n001_foreign\t2026-10-12\n\\.\n';},
    /RECOVERY_BASELINE_DUMP_CATALOG_MISMATCH/);
});

test('malformed, duplicate and missing dump ledger blocks never pass the static catalogue flag',async t=>{
  const f=fixture(),host=await adoptionHost(f);t.after(host.cleanup);
  const valid=host.dumpLedger;
  for(const invalid of ['',valid+valid,valid.replace('001_', '999_'),
    valid.replace('\\.\n',''),valid.replace('version, applied_at','applied_at, version'),
    valid.replace(/\n001_[^\n]+\n/,'\n')]) {
    host.dumpLedger=invalid;
    assert.throws(()=>host.controller.issueInstalledOldAdoption(f.context.approval.attemptId,f.baseline.baselineId),
      /RECOVERY_BASELINE_DUMP_CATALOG_MISMATCH/);
    assert.equal(host.files.has(host.recordFile),false);
  }
});

test('another UUID or a rewritten grant cannot replay a sealed OLD adoption',async t=>{
  const f=fixture(),host=await adoptionHost(f);t.after(host.cleanup);
  const id=f.context.approval.attemptId;
  host.controller.issueInstalledOldAdoption(id,f.baseline.baselineId);
  const sealed=Buffer.from(host.files.get(host.recordFile).data);
  const foreignId='22222222-2222-4222-8222-222222222222';
  host.add('/var/lib/servora-med/deploy/approvals/'+foreignId+'.json',
    JSON.stringify({...f.context.approval,attemptId:foreignId})+'\n');
  assert.throws(()=>host.controller.verifyAttemptRelease(foreignId,'old'),/RECOVERY_RELEASE_UNPROVEN/);
  host.add('/var/lib/servora-med/deploy/approvals/'+id+'.json',
    JSON.stringify({...f.context.approval,maxStarts:1})+'\n');
  assert.throws(()=>host.controller.verifyAttemptRelease(id,'old'),/RECOVERY_RELEASE_UNPROVEN/);
  assert.deepEqual(host.files.get(host.recordFile).data,sealed);
});

test('foreign ownership, permissions, links and torn root records cannot establish OLD proof',async t=>{
  const f=fixture(),host=await adoptionHost(f);t.after(host.cleanup);
  const id=f.context.approval.attemptId;
  host.controller.issueInstalledOldAdoption(id,f.baseline.baselineId);
  const valid=host.files.get(host.recordFile);
  for(const drift of [{uid:1001},{gid:1001},{mode:0o644},{nlink:2},{data:Buffer.from('{')},
    {data:Buffer.from(valid.data.toString().trimEnd())}]) {
    host.files.set(host.recordFile,{...valid,...drift});
    assert.throws(()=>host.controller.verifyAttemptRelease(id,'old'),/RECOVERY_RELEASE_UNPROVEN/);
  }
  host.files.set(host.recordFile,valid);
  assert.doesNotThrow(()=>host.controller.verifyAttemptRelease(id,'old'));
});

test('an interrupted exclusive write stays unusable across controller restart and burns reissuance',async t=>{
  const f=fixture(),host=await adoptionHost(f);t.after(host.cleanup);
  const id=f.context.approval.attemptId;
  host.interruptWrite=true;
  assert.throws(()=>host.controller.issueInstalledOldAdoption(id,f.baseline.baselineId),/simulated interruption/);
  const torn=Buffer.from(host.files.get(host.recordFile).data);
  host.interruptWrite=false;
  const restarted=await host.restart();
  assert.throws(()=>restarted.verifyAttemptRelease(id,'old'),/RECOVERY_RELEASE_UNPROVEN/);
  assert.throws(()=>restarted.issueInstalledOldAdoption(id,f.baseline.baselineId),/ALREADY_SEALED/);
  assert.deepEqual(host.files.get(host.recordFile).data,torn);
});

test('restart cannot renew an unconsumed grant; proven consumption retains only the same adoption',async t=>{
  const f=fixture(),host=await adoptionHost(f);t.after(host.cleanup);
  const id=f.context.approval.attemptId;
  host.controller.issueInstalledOldAdoption(id,f.baseline.baselineId);
  const sealed=Buffer.from(host.files.get(host.recordFile).data);
  host.now=timeEvidenceAt(Date.parse(f.context.approval.expiresAtUTC)+1,
    {bootId:'22222222-2222-4222-8222-222222222222',bootLowerMs:1000,bootUpperMs:1000});
  const restarted=await host.restart();
  assert.throws(()=>restarted.verifyAttemptRelease(id,'old'),/TIME_INVALID|TRUSTED_TIME_UNKNOWN/);
  const initial=host.attempt.initialAttempt(f.context,f.record.attestedTime);
  const proof=host.attempt.admissionConfirmation(f.context,initial,f.record.attestedTime);
  host.add('/var/lib/servora-med/deploy/attempts/'+id+'/0000.json',JSON.stringify(initial)+'\n');
  host.add('/var/lib/servora-med/deploy/admission-proofs/'+id+'.json',JSON.stringify(proof)+'\n');
  host.directories.set('/var/lib/servora-med/deploy/admission-proofs',0o700);
  const before=new Map([...host.files].map(([path,file])=>[path,Buffer.from(file.data)]));
  assert.doesNotThrow(()=>restarted.verifyAttemptRelease(id,'old'));
  for(const [path,bytes] of before)assert.deepEqual(host.files.get(path).data,bytes,'verification must remain read-only');
  assert.deepEqual(host.files.get(host.recordFile).data,sealed);
  assert.throws(()=>restarted.issueInstalledOldAdoption(id,f.baseline.baselineId),/ALREADY_SEALED/);
});

test('a subsequent release requires its normal retained artifact even while the adoption slot remains',async t=>{
  const f=fixture(),bytes='next normal OLD artifact';
  f.context.approval.oldReleaseSha='e'.repeat(40);
  f.context.approval.oldArtifactSha256=hash(bytes);
  const host=await adoptionHost(f);t.after(host.cleanup);
  host.add(host.recordFile,JSON.stringify(f.record)+'\n');
  const retained='/var/lib/servora-med/deploy/artifacts/'+f.context.approval.oldReleaseSha+'.tar.gz';
  host.add(retained,bytes);
  assert.doesNotThrow(()=>host.controller.verifyAttemptRelease(f.context.approval.attemptId,'old'));
  host.files.delete(retained);
  assert.throws(()=>host.controller.verifyAttemptRelease(f.context.approval.attemptId,'old'),/RECOVERY_RELEASE_UNPROVEN/);
});

test('an adopted OLD proof preserves pre-migration abort and post-migration forward-only budgets',async t=>{
  const f=fixture();
  f.context.approval.targetCatalog=readdirSync(directory).filter(name=>/^\d{3}_.*\.sql$/.test(name)).sort()
    .map(name=>({version:name.slice(0,-4),sha256:hash(readFileSync(new URL(name,directory)))}));
  const host=await adoptionHost(f);t.after(host.cleanup);
  const {initialAttempt,advanceAttempt,assertPreMigrationAbortCompatibility}=host.attempt;
  const now=f.record.attestedTime,context=f.context;
  host.controller.issueInstalledOldAdoption(context.approval.attemptId,f.baseline.baselineId);
  host.controller.verifyAttemptRelease(context.approval.attemptId,'old');
  const initial=initialAttempt(context,now);
  // A synthetic distinct receipt represents the mandatory fresh TARGET backup;
  // the adopted recovery-baseline dump does not become an R4 PRE receipt.
  const backed=advanceAttempt(initial,context,{kind:'PREDEPLOY_BACKUP',receipt:{sha256:'8'.repeat(64),completedAtUTC:now.wallAtUTC}},now);
  const fenced=advanceAttempt(backed,context,'FENCED',now);
  assert.doesNotThrow(()=>assertPreMigrationAbortCompatibility(context.approval,catalog.map(e=>e.version),now));
  const abortIntent=advanceAttempt(fenced,context,'ABORT_INTENT',now);
  assert.equal(abortIntent.abortStarts,1);
  const aborted=advanceAttempt(abortIntent,context,'ABORTED',now);
  const terminal=advanceAttempt(aborted,context,'COMPLETED_ABORT',now);
  assert.throws(()=>advanceAttempt(terminal,context,'ABORT_INTENT',now),/ATTEMPT_TRANSITION_INVALID/);
  const baseline={organizations:1,admins:1,staff:1,customers:1,products:1,jobs:1,demoData:0};
  const intent=advanceAttempt(fenced,context,{kind:'MIGRATION_INTENT',baseline},now);
  const exact=advanceAttempt(intent,context,'DB_EXACT',now);
  assert.equal(exact.migrationCommitted,true);
  assert.throws(()=>advanceAttempt(exact,context,'ABORT_INTENT',now),/ATTEMPT_TRANSITION_INVALID/);
  assert.throws(()=>assertPreMigrationAbortCompatibility(context.approval,context.approval.targetCatalog.map(e=>e.version),now),
    /PRE_MIGRATION_ABORT_DB_NOT_OLD_EXACT/);
  let target=exact;
  for(const event of ['ENV_INTENT','ENV_ALIGNED','POINTER_INTENT','POINTER_ALIGNED','START_INTENT'])
    target=advanceAttempt(target,context,event,now);
  assert.equal(target.starts,1);
  assert.throws(()=>advanceAttempt(target,context,'START_INTENT',now),/ATTEMPT_START_AMBIGUOUS/);
  target=advanceAttempt(target,context,'START_FAILED',now);
  target=advanceAttempt(target,context,'START_INTENT',now);
  assert.equal(target.starts,2);
  target=advanceAttempt(target,context,'START_FAILED',now);
  assert.throws(()=>advanceAttempt(target,context,'START_INTENT',now),/BUDGET_EXHAUSTED/);
});

test('administrator issuance cannot race admission through an unlocked direct API call',async t=>{
  await refuses(t,host=>host.fds.delete(9),/RECOVERY_ADOPTION_HOST_LOCK_REQUIRED/);
});

test('the administrator CLI refuses a real non-root process before reading privileged state',
  {skip:process.getuid?.()===0?'requires an ordinary user':false},()=>{
    const command=fileURLToPath(new URL('../scripts/issue-installed-old-adoption.sh',import.meta.url));
    const result=spawnSync('/bin/bash',[command,'11111111-1111-4111-8111-111111111111',
      '20261012T090000Z-issue369-71ae6df6'],{encoding:'utf8',env:{PATH:'/usr/bin:/bin',NODE_OPTIONS:'untrusted'}});
    assert.equal(result.status,1);
    assert.equal(result.stderr.trim(),'RECOVERY_ADOPTION_ADMIN_REQUIRED');
    assert.equal(result.stdout,'');
  });

test('a trailing newline cannot select a different baseline directory',()=>{
  const f=fixture();f.record.baselineId=f.baseline.baselineId+='\n';
  rejects(f,/RECOVERY_INSTALLED_OLD_ADOPTION_INVALID/);
});

test('issuance rejects pending recovery before loading any potentially reconciling attempt helper',async t=>{
  const host=await refuses(t,(host,f)=>{
    host.add('/var/lib/servora-med/deploy/active.json',JSON.stringify({attemptId:f.context.approval.attemptId,
      approvalSha256:f.context.approvalSha256})+'\n');
    host.add('/etc/systemd/system/servora-med.service.d/90-servora-recovery.conf','[Service]\nRestart=no\n');
    host.properties.NeedDaemonReload='yes';
  },/RECOVERY_ADOPTION_STATE_NOT_EMPTY/);
  assert.equal(host.commands.some(([file])=>file==='/usr/bin/systemctl'),false);
});

test('an empty but untrusted recovery directory is not an empty trusted namespace',async t=>{
  await refuses(t,host=>host.directories.set('/var/lib/servora-med/deploy/initializations',0o755),
    /RECOVERY_ADOPTION_STATE_UNTRUSTED/);
});

test('orphan R4 backup or log history blocks first-cutover issuance',async t=>{
  for(const relative of ['backups/orphan.dump','logs/orphan.log'])
    await refuses(t,host=>host.add('/var/lib/servora-med/deploy/'+relative,'unowned history'),
      /RECOVERY_ADOPTION_STATE_NOT_EMPTY/);
});
