import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OPS_R4_002_POLICY, validateInstalledOldAdoption,
  issueInstalledOldAdoption67d3318 } from '../scripts/deployment-controller.mjs';
import { legacyTimeEvidenceAt } from './trusted-time-fixture.mjs';
import { adoptionHost, adoptionFixture67d3318 as fixture } from './installed-old-adoption-fixture.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const jsonHash = value => hash(JSON.stringify(value) + '\n');
const OLD = '67d33183d22e00f231ca21a5807cf49a6c4c2a68';
const ORIGINAL = 'a1db5a8d8faea144f6f18006f09cd9c0f457a6a79782fd5fcd9884f528593ebf';
const RECOVERED = 'ddf12049ed483062d00b4a1c0fdd4909d01010d9dc9459c3cb5a5c39c142a220';
const CONTENT = '059dedcbaf2de186608e7f975f223a5ac659651d67ca56bbb6a26407a9628aef';
const CATALOG = '43f96550a71be82e55d855a677fdf2ecbecf4acf9a0dfba6d9f5ae988bc75c28';
const BASELINE = '20261110T090000Z-ops-r4-002-67d3318';
const OLD_RECORD = '/var/lib/servora-med/deploy/installed-old-adoption.json';
const NEW_RECORD = '/var/lib/servora-med/deploy/installed-old-adoption-67d3318.json';

test('OPS-R4-002 policy pins the exact recovery identity and a separate adoption slot', () => {
  assert.equal(OPS_R4_002_POLICY.policyId, 'OPS-R4-002');
  assert.equal(OPS_R4_002_POLICY.oldReleaseSha, OLD);
  assert.equal(OPS_R4_002_POLICY.originalArtifactSha256, ORIGINAL);
  assert.equal(OPS_R4_002_POLICY.reconstructedArtifactSha256, RECOVERED);
  assert.equal(OPS_R4_002_POLICY.contentManifestSha256, CONTENT);
  assert.equal(OPS_R4_002_POLICY.oldCatalogSha256, CATALOG);
  assert.equal(OPS_R4_002_POLICY.adoptionFile, NEW_RECORD);
  assert.notEqual(OPS_R4_002_POLICY.adoptionFile, OLD_RECORD);
  assert.match(BASELINE, OPS_R4_002_POLICY.baselineIdPattern);
  assert.equal(OPS_R4_002_POLICY.recordKind, 'ADOPTED_INSTALLED_OLD_OPS_R4_002');
});

test('exact OLD and exact baseline pass without redefining original provenance', () => {
  const { record, context, baseline, baselineSha256 } = fixture();
  assert.equal(validateInstalledOldAdoption(record, context, baseline, baselineSha256), record);
  assert.equal(record.oldReleaseSha, OLD);
  assert.equal(record.originalArtifactSha256, ORIGINAL);
  assert.equal(record.adoptedArchiveSha256, RECOVERED);
  assert.notEqual(record.adoptedArchiveSha256, ORIGINAL);
  assert.equal(record.oldContentManifestSha256, CONTENT);
  assert.equal(record.oldCatalogSha256, CATALOG);
  assert.equal(record.baselineId, BASELINE);
});

test('rejects a different OLD release', () => {
  const f = fixture();
  f.context.approval.oldReleaseSha = '0'.repeat(40);
  assert.throws(() => validateInstalledOldAdoption(f.record, f.context, f.baseline, f.baselineSha256),
    /RECOVERY_INSTALLED_OLD_ADOPTION_INVALID/);
});

test('rejects a renamed original artifact digest', () => {
  const f = fixture();
  f.context.approval.oldArtifactSha256 = '9'.repeat(64);
  assert.throws(() => validateInstalledOldAdoption(f.record, f.context, f.baseline, f.baselineSha256),
    /RECOVERY_INSTALLED_OLD_ADOPTION_INVALID/);
});

test('rejects a recovery archive that claims to be the original artifact', () => {
  const f = fixture();
  f.record.adoptedArchiveSha256 = ORIGINAL;
  f.baseline.files['installed-old-release.adopted.tar.gz'].sha256 = ORIGINAL;
  f.record.baselineManifestSha256 = f.baselineSha256 = jsonHash(f.baseline);
  assert.throws(() => validateInstalledOldAdoption(f.record, f.context, f.baseline, f.baselineSha256),
    /RECOVERY_INSTALLED_OLD_ADOPTION_INVALID/);
});

test('rejects a changed recovery archive digest', () => {
  const f = fixture();
  f.record.adoptedArchiveSha256 = '7'.repeat(64);
  assert.throws(() => validateInstalledOldAdoption(f.record, f.context, f.baseline, f.baselineSha256),
    /RECOVERY_INSTALLED_OLD_ADOPTION_INVALID/);
});

test('rejects a changed content manifest', () => {
  const f = fixture();
  f.baseline.installedContentManifestSha256 = '8'.repeat(64);
  f.baseline.files['installed-old-content.sha256'].sha256 = '8'.repeat(64);
  f.record.oldContentManifestSha256 = '8'.repeat(64);
  f.record.baselineManifestSha256 = f.baselineSha256 = jsonHash(f.baseline);
  assert.throws(() => validateInstalledOldAdoption(f.record, f.context, f.baseline, f.baselineSha256),
    /RECOVERY_INSTALLED_OLD_ADOPTION_INVALID/);
});

test('rejects a different migration catalog', () => {
  const f = fixture();
  f.context.approval.oldCatalog = f.context.approval.oldCatalog.slice(0, 59);
  assert.throws(() => validateInstalledOldAdoption(f.record, f.context, f.baseline, f.baselineSha256),
    /RECOVERY_INSTALLED_OLD_ADOPTION_INVALID/);
});

test('rejects a missing or malformed baseline binding', () => {
  for (const mutate of [
    f => { f.baseline.baselineId = '20261110T090000Z-ops-r4-002-deadbeef'; },
    f => { f.baseline.completedAtUTC = '2999-01-01T00:00:00.000Z'; },
    f => { f.baseline.restoreAcceptance = true; },
    f => { delete f.baseline.files['database.dump']; },
    f => { f.baseline.verifications.dumpList = false; },
    f => { f.baseline.machineId = '2'.repeat(32); },
  ]) {
    const f = fixture();
    mutate(f);
    f.record.baselineManifestSha256 = f.baselineSha256 = jsonHash(f.baseline);
    assert.throws(() => validateInstalledOldAdoption(f.record, f.context, f.baseline, f.baselineSha256),
      /RECOVERY_INSTALLED_OLD_ADOPTION_INVALID/);
  }
});

test('UNKNOWN trusted-time evidence cannot authorize the new policy', () => {
  const f = fixture();
  f.record.attestedTime = legacyTimeEvidenceAt();
  assert.throws(() => validateInstalledOldAdoption(f.record, f.context, f.baseline, f.baselineSha256),
    /TIME|TRUSTED_TIME/);
});

test('a non-root caller cannot issue the new policy', t => {
  t.mock.method(process, 'getuid', () => 1001);
  assert.throws(() => issueInstalledOldAdoption67d3318(
    '11111111-1111-4111-8111-111111111111', BASELINE), /RECOVERY_ADOPTION_ADMIN_REQUIRED/);
});

test('pending recovery state blocks the new policy before any baseline read', async t => {
  const f = fixture(), host = await adoptionHost(f);
  t.after(host.cleanup);
  host.add('/var/lib/servora-med/deploy/active.json',
    JSON.stringify({ attemptId: f.context.approval.attemptId, approvalSha256: f.context.approvalSha256 }) + '\n');
  assert.throws(() => host.controller.issueInstalledOldAdoption67d3318(
    f.context.approval.attemptId, f.baseline.baselineId), /RECOVERY_ADOPTION_STATE_NOT_EMPTY/);
  assert.equal(host.files.has(NEW_RECORD), false);
});

test('duplicate issuance is refused and the OPS-R4-001 slot is untouched', async t => {
  const f = fixture(), host = await adoptionHost(f);
  t.after(host.cleanup);
  host.add(OLD_RECORD, 'legacy sealed record\n');
  host.add(NEW_RECORD, 'new sealed record\n');
  assert.throws(() => host.controller.issueInstalledOldAdoption67d3318(
    f.context.approval.attemptId, f.baseline.baselineId), /RECOVERY_ADOPTION_ALREADY_SEALED/);
  assert.equal(host.files.get(NEW_RECORD).data.toString(), 'new sealed record\n');
  assert.equal(host.files.get(OLD_RECORD).data.toString(), 'legacy sealed record\n');
});

test('the new policy does not fall back to the old adoption when its own slot is absent', async t => {
  const f = fixture(), host = await adoptionHost(f);
  t.after(host.cleanup);
  assert.throws(() => host.controller.verifyAttemptRelease(f.context.approval.attemptId, 'old'),
    /RECOVERY_RELEASE_UNPROVEN/);
  assert.equal(host.files.has(NEW_RECORD), false);
});

test('a corrupt retained 67d3318 archive never falls back to the new adoption', async t => {
  const f = fixture(), host = await adoptionHost(f);
  t.after(host.cleanup);
  host.add('/var/lib/servora-med/deploy/artifacts/' + OLD + '.tar.gz', 'not the approved bytes', 0o600);
  assert.throws(() => host.controller.verifyAttemptRelease(f.context.approval.attemptId, 'old'),
    /RECOVERY_RELEASE_UNPROVEN/);
});

test('a published recovery archive matches the policy constant when the real fixture is supplied', {
  skip: !process.env.SERVORA_OPS_R4_002_ARCHIVE || !process.env.SERVORA_OPS_R4_002_CONTENT_MANIFEST
    ? 'real recovery archive fixture not supplied; policy constants are still asserted above'
    : false
}, () => {
  assert.equal(hash(readFileSync(process.env.SERVORA_OPS_R4_002_ARCHIVE)), RECOVERED);
  assert.equal(hash(readFileSync(process.env.SERVORA_OPS_R4_002_CONTENT_MANIFEST)), CONTENT);
});

test('the old 71ae6df6 record is not rewritten by a failed new-policy attempt', async t => {
  const f = fixture(), host = await adoptionHost(f);
  t.after(host.cleanup);
  host.add(OLD_RECORD, 'preserve me\n');
  // The synthetic fixture intentionally cannot satisfy the exact 67d3318
  // content/archive constants, so issuance fails before publication.
  assert.throws(() => host.controller.issueInstalledOldAdoption67d3318(
    f.context.approval.attemptId, f.baseline.baselineId), /RECOVERY_INSTALLED_OLD_ADOPTION_INVALID/);
  assert.equal(host.files.get(OLD_RECORD).data.toString(), 'preserve me\n');
  assert.equal(host.files.has(NEW_RECORD), false);
});

test('the new administrator CLI refuses a real non-root process before privileged state', {
  skip: process.getuid?.() === 0 ? 'requires an ordinary user' : false
}, () => {
  const command = fileURLToPath(new URL('../scripts/issue-installed-old-adoption-67d3318.sh', import.meta.url));
  const result = spawnSync('/bin/bash', [command, '11111111-1111-4111-8111-111111111111', BASELINE],
    { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', NODE_OPTIONS: 'untrusted' } });
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), 'RECOVERY_ADOPTION_ADMIN_REQUIRED');
  assert.equal(result.stdout, '');
});
