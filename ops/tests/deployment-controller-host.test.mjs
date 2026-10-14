import assert from 'node:assert/strict';
import test from 'node:test';
import { hostname } from 'node:os';
import { loadAttempt, admitAttempt, checkpointAttempt, alignAttemptEnvironment, alignIdentityEnvironment,
  createAttemptBarrier, alignAttemptPointer, grantStartPermit, revokeStartPermit,
  verifyAttemptCatalog } from '../scripts/deployment-controller.mjs';
import { withSealedFixture } from './r4-root-fixture.mjs';
import { readLatestCheckpoint } from '../scripts/deployment-attempt.mjs';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, statSync, readlinkSync, symlinkSync, mkdirSync, linkSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

assert.equal(process.getuid(), 0);
assert.equal(hostname(), 'lima-servora-r4-20261012');

test('an unsealed attempt cannot acquire authority from a valid-looking UUID', () => {
  assert.throws(() => loadAttempt('99999999-9999-4999-8999-999999999999'), /ATTEMPT_APPROVAL_MISSING/);
});

test('recovery refuses unproven artifact content before touching env, pointer or service', () => withSealedFixture(grant => {
  const env = readFileSync('/etc/servora-med/servora-med.env');
  const pointer = readlinkSync('/opt/servora-med/current');
  const result = spawnSync('/usr/bin/node',['/usr/local/libexec/servora-med/deployment-controller.mjs','verify-release',grant.attemptId,'target'],{encoding:'utf8'});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/RECOVERY_RELEASE_UNPROVEN/);
  assert.deepEqual(readFileSync('/etc/servora-med/servora-med.env'),env);
  assert.equal(readlinkSync('/opt/servora-med/current'),pointer);
}));

test('effective systemd overrides cannot promote the approved app to root', () => withSealedFixture(grant => {
  const file = '/etc/systemd/system/servora-med.service.d/99-r4-untrusted-test.conf';
  assert.equal(existsSync(file),false);
  try {
    writeFileSync(file,'[Service]\nUser=root\n',{mode:0o644,flag:'wx'});
    assert.equal(spawnSync('/usr/bin/systemctl',['daemon-reload']).status,0);
    assert.throws(() => loadAttempt(grant.attemptId),/RECOVERY_SERVICE_CONTRACT_MISMATCH/);
  } finally { unlinkSync(file); spawnSync('/usr/bin/systemctl',['daemon-reload']); }
}));

test('durable admission claims one attempt and resumes only the same early owner', () => withSealedFixture(grant => {
  const root = '/var/lib/servora-med/deploy';
  const retained = root+'/backups/'+grant.attemptId+'-pre.dump';
  const first = admitAttempt(grant.attemptId);
  assert.equal(first.resumed, false);
  assert.equal(first.checkpoint.record.phase, 'ADMITTED');
  assert.equal(JSON.parse(readFileSync(root+'/active.json','utf8')).attemptId, grant.attemptId);
  const resume = admitAttempt(grant.attemptId);
  assert.equal(resume.resumed, true);
  assert.equal(resume.checkpoint.record.phase, 'ADMITTED');
  const payload = Buffer.from('synthetic retained dump');
  mkdirSync(root+'/backups',{recursive:true,mode:0o700});
  writeFileSync(retained,payload,{mode:0o600});
  try {
    checkpointAttempt(grant.attemptId,{kind:'PREDEPLOY_BACKUP',
      receipt:{sha256:createHash('sha256').update(payload).digest('hex'),completedAtUTC:new Date().toISOString()}});
    assert.equal(admitAttempt(grant.attemptId).resumed, true, 'a sealed BACKED_UP owner resumes');
    checkpointAttempt(grant.attemptId,'FENCED');
    assert.throws(() => admitAttempt(grant.attemptId), /RECOVERY_OTHER_ATTEMPT_ACTIVE/);
  } finally { unlinkSync(retained); }
}));

test('host checkpoints append the hash chain while preserving the committed migration boundary', () => withSealedFixture(grant => {
  admitAttempt(grant.attemptId);
  checkpointAttempt(grant.attemptId, { kind:'PREDEPLOY_BACKUP', receipt:{sha256:'6'.repeat(64),completedAtUTC:new Date().toISOString()} });
  checkpointAttempt(grant.attemptId, 'FENCED');
  checkpointAttempt(grant.attemptId, { kind:'MIGRATION_INTENT', baseline:{organizations:1,admins:1,staff:1,customers:1,products:1,jobs:1,demoData:0} });
  const committed = checkpointAttempt(grant.attemptId, 'DB_EXACT');
  assert.equal(committed.record.sequence,4);
  assert.equal(committed.record.migrationCommitted,true);
  assert.throws(() => checkpointAttempt(grant.attemptId,'ABORT_INTENT'), /ATTEMPT_TRANSITION_INVALID/);
}));

test('a torn checkpoint publication is reconciled idempotently while foreign artifacts fail closed', () => withSealedFixture(grant => {
  const directory = '/var/lib/servora-med/deploy/attempts/'+grant.attemptId;
  admitAttempt(grant.attemptId);
  const file = directory+'/0000.json';
  // SIGKILL between the exclusive link and the temp unlink: the record IS
  // published, only the private temp name of the same inode lingers.
  const paired = directory+'/.'+randomUUID()+'.tmp';
  linkSync(file,paired);
  assert.equal(statSync(file).nlink,2);
  assert.equal(readLatestCheckpoint(grant.attemptId).record.phase,'ADMITTED');
  assert.equal(existsSync(paired),false,'the interrupted publication is completed, not rejected');
  assert.equal(statSync(file).nlink,1);
  // SIGKILL before the link: the record was never published; its pre-link
  // temp is cleaned and the intact chain still reads.
  const orphaned = directory+'/.'+randomUUID()+'.tmp';
  writeFileSync(orphaned,Buffer.from('never linked'),{mode:0o600});
  assert.equal(readLatestCheckpoint(grant.attemptId).record.sequence,0);
  assert.equal(existsSync(orphaned),false);
  // A foreign artifact (wrong permissions) is rejected and never repaired.
  const foreign = directory+'/.'+randomUUID()+'.tmp';
  writeFileSync(foreign,Buffer.from('foreign'),{mode:0o644});
  try {
    assert.throws(() => readLatestCheckpoint(grant.attemptId),/ATTEMPT_CHECKPOINT_CHAIN_INVALID/);
    assert.equal(existsSync(foreign),true,'foreign artifacts are never auto-repaired');
  } finally { unlinkSync(foreign); }
  // Unknown names and gaps still fail closed.
  const unknown = directory+'/9999.json';
  writeFileSync(unknown,JSON.stringify({})+'\n',{mode:0o600});
  try { assert.throws(() => readLatestCheckpoint(grant.attemptId),/ATTEMPT_CHECKPOINT_CHAIN_INVALID/); }
  finally { unlinkSync(unknown); }
  assert.equal(readLatestCheckpoint(grant.attemptId).record.sequence,0);
}));

test('durable env alignment updates the coherent pair and keeps protected non-identity bytes', () => withSealedFixture(grant => {
  const envFile = '/etc/servora-med/servora-med.env';
  const original = readFileSync(envFile,'utf8');
  admitAttempt(grant.attemptId);
  checkpointAttempt(grant.attemptId,{kind:'PREDEPLOY_BACKUP',receipt:{sha256:'6'.repeat(64),completedAtUTC:new Date().toISOString()}});
  checkpointAttempt(grant.attemptId,'FENCED');
  checkpointAttempt(grant.attemptId,{kind:'MIGRATION_INTENT',baseline:{organizations:1,admins:1,staff:1,customers:1,products:1,jobs:1,demoData:0}});
  checkpointAttempt(grant.attemptId,'DB_EXACT');
  checkpointAttempt(grant.attemptId,'ENV_INTENT');
  try {
    writeFileSync(envFile,alignIdentityEnvironment(original,grant.oldCatalog.at(-1).version,grant.oldReleaseSha));
    alignAttemptEnvironment(grant.attemptId,'target');
    assert.equal(readFileSync(envFile,'utf8'),alignIdentityEnvironment(original,grant.targetCatalog.at(-1).version,grant.releaseSha));
    assert.equal(statSync(envFile).uid,0);
    assert.equal(statSync(envFile).mode & 0o777,0o640);
    assert.doesNotThrow(() => loadAttempt(grant.attemptId));
  } finally { writeFileSync(envFile,original); }
}));

test('fencing never overwrites an unknown preexisting root barrier', () => withSealedFixture(grant => {
  admitAttempt(grant.attemptId);
  checkpointAttempt(grant.attemptId,{kind:'PREDEPLOY_BACKUP',receipt:{sha256:'6'.repeat(64),completedAtUTC:new Date().toISOString()}});
  const file = '/var/lib/servora-med/deploy/activation.block';
  const before = readFileSync(file);
  assert.throws(() => createAttemptBarrier(grant.attemptId), /RECOVERY_BARRIER_UNTRUSTED/);
  assert.deepEqual(readFileSync(file),before);
}));

test('activation prepares only an approved pointer and a permit backed by a durable start slot', () => withSealedFixture(grant => {
  const barrier = '/var/lib/servora-med/deploy/activation.block';
  const priorBarrier = readFileSync(barrier);
  const current = '/opt/servora-med/current';
  const priorPointer = readlinkSync(current);
  const permit = '/run/servora-med-recovery/start.permit';
  assert.equal(existsSync(permit),false);
  admitAttempt(grant.attemptId);
  checkpointAttempt(grant.attemptId,{kind:'PREDEPLOY_BACKUP',receipt:{sha256:'6'.repeat(64),completedAtUTC:new Date().toISOString()}});
  try {
    unlinkSync(barrier);
    createAttemptBarrier(grant.attemptId);
    checkpointAttempt(grant.attemptId,'FENCED');
    checkpointAttempt(grant.attemptId,{kind:'MIGRATION_INTENT',baseline:{organizations:1,admins:1,staff:1,customers:1,products:1,jobs:1,demoData:0}});
    checkpointAttempt(grant.attemptId,'DB_EXACT');
    checkpointAttempt(grant.attemptId,'ENV_INTENT');
    checkpointAttempt(grant.attemptId,'ENV_ALIGNED');
    checkpointAttempt(grant.attemptId,'POINTER_INTENT');
    unlinkSync(current); symlinkSync('/etc',current);
    assert.throws(() => alignAttemptPointer(grant.attemptId,'target'), /RECOVERY_POINTER_UNTRUSTED/);
    assert.equal(readlinkSync(current),'/etc');
    unlinkSync(current); symlinkSync('/opt/servora-med/releases/'+grant.oldReleaseSha,current);
    alignAttemptPointer(grant.attemptId,'target');
    assert.equal(readlinkSync(current),'/opt/servora-med/releases/'+grant.releaseSha);
    checkpointAttempt(grant.attemptId,'POINTER_ALIGNED');
    assert.throws(() => grantStartPermit(grant.attemptId), /ATTEMPT_TRANSITION_INVALID/);
    checkpointAttempt(grant.attemptId,'START_INTENT');
    grantStartPermit(grant.attemptId);
    assert.equal(JSON.parse(readFileSync(permit,'utf8')).attemptId,grant.attemptId);
    assert.equal(existsSync(barrier),true);
    revokeStartPermit(grant.attemptId);
    assert.equal(existsSync(permit),false);
  } finally {
    revokeStartPermit(grant.attemptId);
    unlinkSync(current); symlinkSync(priorPointer,current);
    writeFileSync(barrier,priorBarrier,{mode:0o600});
  }
}));

test('a full approved catalog binds every SQL file, not only the schema head', () => withSealedFixture(grant => {
  assert.doesNotThrow(() => verifyAttemptCatalog(grant.attemptId,'target'));
  grant.targetCatalog.at(-1).sha256 = '0'.repeat(64);
  writeFileSync(`/var/lib/servora-med/deploy/approvals/${grant.attemptId}.json`,JSON.stringify(grant)+'\n');
  assert.throws(() => verifyAttemptCatalog(grant.attemptId,'target'), /RECOVERY_CATALOG_MISMATCH/);
}));

test('fixed controller CLI derives probe settings from sealed data and refuses arbitrary commands', () => withSealedFixture(grant => {
  const script = '/usr/local/libexec/servora-med/deployment-controller.mjs';
  const good = spawnSync('/usr/bin/node',[script,'db-config',grant.attemptId,'target'],{encoding:'utf8'});
  assert.equal(good.status,0,good.stderr);
  const config = JSON.parse(good.stdout);
  assert.equal(config.releaseDirectory,'/opt/servora-med/releases/'+grant.releaseSha);
  assert.deepEqual(config.expectedCatalog,grant.targetCatalog.map(entry => entry.version));
  const bad = spawnSync('/usr/bin/node',[script,'/bin/sh',grant.attemptId],{encoding:'utf8'});
  assert.notEqual(bad.status,0);
  assert.match(bad.stderr,/RECOVERY_CONTROLLER_ARGUMENTS_INVALID/);
  assert.equal(existsSync('/var/lib/servora-med/deploy/active.json'),false);
}));

test('a root-sealed grant for a different machine is refused before any journal is created', () => {
  const root = '/var/lib/servora-med/deploy';
  assert.equal(existsSync(root + '/active.json'), false, 'fixture requires no active attempt');
  const profileFile = root + '/profile.json';
  const original = existsSync(profileFile) ? readFileSync(profileFile) : null;
  const id = randomUUID();
  const hash = text => createHash('sha256').update(text).digest('hex');
  const profile = { formatVersion: 1, machineId: '0'.repeat(32), fqdn: 'r4.synthetic.invalid',
    databaseIdentity: { clusterId:'1', databaseName:'servora_med_test_r4_host', databaseOid:'1', role:'servora_r4_app', host:'127.0.0.1', port:5432 },
    envBaselineSha256:'0'.repeat(64), contracts:Object.fromEntries(['helperSha256','nodeSha256','unitSha256','attemptModuleSha256','dbGuardModuleSha256','reconciliationModuleSha256','controllerModuleSha256'].map(key => [key,'0'.repeat(64)])) };
  const profileText = JSON.stringify(profile) + '\n';
  const now = Date.now();
  const grant = { formatVersion:1, attemptId:id, releaseSha:'a'.repeat(40), treeSha:'b'.repeat(40), artifactSha256:'c'.repeat(64), ciManifestSha256:'d'.repeat(64),
    targetCatalog:[{version:'001_baseline',sha256:'e'.repeat(64)}], oldReleaseSha:'f'.repeat(40), oldArtifactSha256:'1'.repeat(64),
    oldCatalog:[{version:'001_baseline',sha256:'e'.repeat(64)}], profileSha256:hash(profileText),
    issuedAtUTC:new Date(now-1000).toISOString(), expiresAtUTC:new Date(now+60000).toISOString(), maxStarts:2,maxAbortStarts:1,
    allowMigration:true,allowForwardRecovery:true,allowPreMigrationAbort:true,allowPostdeployBackup:true };
  writeFileSync(profileFile,profileText,{mode:0o600});
  writeFileSync(`${root}/approvals/${id}.json`,JSON.stringify(grant)+'\n',{mode:0o600});
  try {
    assert.throws(() => loadAttempt(id), /RECOVERY_HOST_MACHINE_MISMATCH/);
    assert.equal(existsSync(`${root}/attempts/${id}`), false);
    profile.machineId = readFileSync('/etc/machine-id','utf8').trim();
    const matchingHostProfile = JSON.stringify(profile) + '\n';
    grant.profileSha256 = hash(matchingHostProfile);
    writeFileSync(profileFile, matchingHostProfile);
    writeFileSync(`${root}/approvals/${id}.json`, JSON.stringify(grant)+'\n');
    assert.throws(() => loadAttempt(id), /RECOVERY_HOST_CONTRACT_MISMATCH/);
  } finally {
    if (original) writeFileSync(profileFile,original); else unlinkSync(profileFile);
  }
});
