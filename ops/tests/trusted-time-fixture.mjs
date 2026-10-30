import {SOURCE_POLICY,CHRONY_CONFIG_SHA256} from '../scripts/trusted-time.mjs';
export const legacyTimeEvidenceAt = (wallMs = Date.parse('2026-10-12T09:00:00.000Z'), overrides = {}) => ({
  formatVersion:1,source:'linux-boottime',bootId:'11111111-1111-4111-8111-111111111111',
  timeNamespaceId:'time:[4026531834]',bootLowerMs:wallMs,bootUpperMs:wallMs,
  wallAtUTC:new Date(wallMs).toISOString(),wallResolutionMs:1,
  synchronization:{service:'chrony',referenceAgeMs:1000,rootDistanceMs:1,correctionMs:0,sourceCount:2},...overrides,
});

export const timeEvidenceAt = (wallMs, overrides = {}) => {
  const legacy=legacyTimeEvidenceAt(wallMs);
  return {...legacy,formatVersion:2,synchronization:{...legacy.synchronization,
    sourcePolicy:SOURCE_POLICY,configSha256:CHRONY_CONFIG_SHA256,configuredSourceCount:3,
    authenticatedSourceCount:2,selectableSources:['1.ntp.ubuntu.com','time.cloudflare.com'],
    selectedSource:'time.cloudflare.com'},...overrides};
};

export const approvalFixture = () => ({
  formatVersion:2,attemptId:'11111111-1111-4111-8111-111111111111',
  releaseSha:'a'.repeat(40),treeSha:'b'.repeat(40),artifactSha256:'c'.repeat(64),ciManifestSha256:'d'.repeat(64),
  targetCatalog:[{version:'001_baseline',sha256:'e'.repeat(64)}],oldReleaseSha:'1'.repeat(40),
  oldArtifactSha256:'2'.repeat(64),oldCatalog:[{version:'001_baseline',sha256:'e'.repeat(64)}],profileSha256:'3'.repeat(64),
  issuedAtUTC:'2026-10-12T09:00:00.000Z',expiresAtUTC:'2026-10-12T12:00:00.000Z',
  maxStarts:2,maxAbortStarts:1,allowMigration:true,allowForwardRecovery:true,allowPreMigrationAbort:true,allowPostdeployBackup:true,
  issuedTime:timeEvidenceAt(),
});
