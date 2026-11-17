// Synthetic evidence only. No host path, database or real approval is used.
import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import * as controller from '../scripts/deployment-controller.mjs';
import {initialAttempt} from '../scripts/deployment-attempt.mjs';
import {adoptionFixture67d3318} from './installed-old-adoption-fixture.mjs';
import {timeEvidenceAt} from './trusted-time-fixture.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)+'\n').digest('hex');
const scopeKeys = ['maxStarts','maxAbortStarts','allowMigration','allowForwardRecovery',
  'allowPreMigrationAbort','allowPostdeployBackup'];

function fixture() {
  const f = adoptionFixture67d3318();
  const {attemptId,approvalSha256,...identity} = f.record;
  f.attestation = {...identity,kind:'INSTALLED_OLD_CUTOVER_ATTESTATION_OPS_R4_002',
    authority:'IDENTITY_AND_PLAN_ONLY_NOT_EXECUTION',
    databaseIdentitySha256:hash(f.context.profile.databaseIdentity),
    targetCatalogSha256:hash(f.context.approval.targetCatalog),
    targetCiManifestSha256:f.context.approval.ciManifestSha256,
    scopeCeiling:Object.fromEntries(scopeKeys.map(key=>[key,f.context.approval[key]]))};
  return f;
}

test('permanent identity/plan evidence permits a fresh same-plan grant after expiry/reboot without renewing the old grant', () => {
  const f = fixture(), sealedHash = hash(f.attestation);
  const now = timeEvidenceAt(Date.parse('2026-11-14T10:00:00.000Z'),
    {bootId:'22222222-2222-4222-8222-222222222222'});
  assert.throws(()=>initialAttempt(f.context,now), /TRUSTED_TIME_UNKNOWN|APPROVAL_TIME_INVALID/);
  const approval = {...f.context.approval,attemptId:'33333333-3333-4333-8333-333333333333',
    issuedAtUTC:now.wallAtUTC,expiresAtUTC:'2026-11-14T12:00:00.000Z',issuedTime:now};
  const context = {...f.context,approval,approvalSha256:hash(approval)};
  assert.equal(controller.validateInstalledOldCutoverAttestation(
    f.attestation,context,f.baseline,f.baselineSha256),f.attestation);
  assert.equal(initialAttempt(context,now).starts,0);
  assert.equal(hash(f.attestation),sealedHash,'new authority must not modify identity evidence');
});

test('identity, target, catalog, CI, baseline and recovery pins cannot drift and scope ceilings cannot widen', () => {
  const mutations=[
    f=>{f.attestation.kind='ADOPTED_INSTALLED_OLD_OPS_R4_002';},
    f=>{f.attestation.authority='EXECUTION';},
    f=>{f.attestation.attemptId=f.context.approval.attemptId;},
    f=>{f.attestation.databaseIdentitySha256='0'.repeat(64);},
    f=>{f.attestation.profileSha256='0'.repeat(64);},
    f=>{f.attestation.machineId='0'.repeat(32);},
    f=>{f.attestation.oldReleaseSha='0'.repeat(40);},
    f=>{f.attestation.originalArtifactSha256='0'.repeat(64);},
    f=>{f.attestation.oldCatalogSha256='0'.repeat(64);},
    f=>{f.attestation.targetReleaseSha='0'.repeat(40);},
    f=>{f.attestation.targetTreeSha='0'.repeat(40);},
    f=>{f.attestation.targetArtifactSha256='0'.repeat(64);},
    f=>{f.attestation.targetCatalogSha256='0'.repeat(64);},
    f=>{f.attestation.targetCiManifestSha256='0'.repeat(64);},
    f=>{f.attestation.baselineManifestSha256='0'.repeat(64);},
    f=>{f.attestation.adoptedArchiveSha256='0'.repeat(64);},
    f=>{f.attestation.oldContentManifestSha256='0'.repeat(64);},
    f=>{f.attestation.databaseDumpSha256='0'.repeat(64);},
    f=>{f.attestation.scopeCeiling.maxStarts=1;},
    f=>{f.attestation.scopeCeiling.maxAbortStarts=0;},
    ...scopeKeys.slice(2).map(key=>f=>{f.attestation.scopeCeiling[key]=false;}),
    f=>{f.attestation.scopeCeiling.maxStarts=3;},
    f=>{f.attestation.scopeCeiling.extra=true;},
    f=>{f.baseline.restoreAcceptance=true;},
    f=>{f.attestation.attestedTime.formatVersion=1;}
  ];
  for(const mutate of mutations){
    const f=fixture();mutate(f);
    assert.throws(()=>controller.validateInstalledOldCutoverAttestation(
      f.attestation,f.context,f.baseline,f.baselineSha256),/INVALID|TIME/);
  }
  const f=fixture();
  f.context.approval.maxStarts=1;f.context.approval.maxAbortStarts=0;
  for(const key of scopeKeys.slice(2))f.context.approval[key]=false;
  assert.doesNotThrow(()=>controller.validateInstalledOldCutoverAttestation(
    f.attestation,f.context,f.baseline,f.baselineSha256));
});
