/** Trusted fixed-path host operations. No candidate code executes as root. */
import { createHash, randomUUID } from 'node:crypto';
import {assertBootstrapManagementAllowed} from './bootstrap-fence.mjs';
import { readRootApproval, readRootProfile, initialAttempt, appendRootCheckpoint,
  readProtectedRecord, readLatestCheckpoint, advanceAttempt, acceptedHandoffDirection,
  OBSERVATION_SECONDS, publishRootAdmissionConfirmation, validateApprovalStructure,
  validateApproval, validateInitialAttemptRecord } from './deployment-attempt.mjs';
import { elapsedTime, sampleTrustedTime, validateCurrentTimeEvidence } from './trusted-time.mjs';
import { readFileSync, constants, lstatSync, openSync, fstatSync, closeSync, realpathSync,
  writeFileSync, fsyncSync, fchmodSync, fchownSync, renameSync, unlinkSync,
  symlinkSync, mkdirSync, readdirSync, readlinkSync, readSync, writeSync, linkSync } from 'node:fs';
import { parseCanonicalRecord } from './deployment-attempt.mjs';
import { classifyMigrationState } from './migration-reconciliation.mjs';
import { validateDatabaseIdentity } from './deployment-db-guard.mjs';
import {
  HISTORICAL_STATE_ROOT,HISTORICAL_ATTEMPT_ID,HISTORICAL_LOG_NAMES,HISTORICAL_ARCHIVED_PATHS,
  HISTORICAL_SOURCE_DIRECTORIES,HISTORICAL_REMOVED_DIRECTORIES,historicalSourceMode,
  HISTORICAL_STAGING_DIR,HISTORICAL_STAGING_RECEIPT,
  captureHistoricalSourceInventory,readHistoricalStageReceipt,verifyHistoricalStageReadback
} from './historical-recovery-evidence.mjs';
import { pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

const digest = value => createHash('sha256').update(value).digest('hex');
const INSTALLED = '/usr/local/libexec/servora-med';
const ENV_FILE = '/etc/servora-med/servora-med.env';
const STATE_ROOT = HISTORICAL_STATE_ROOT;
const PERMIT_DIRECTORY = '/run/servora-med-recovery';
const PERMIT_FILE = `${PERMIT_DIRECTORY}/start.permit`;
const PG_RESTORE_BIN = '/usr/bin/pg_restore';

// Owner-authorized Issue #369 first cutover only. This does not redefine the
// original artifact, or add an operator-selected compatibility mode.
const ADOPTION_FILE = STATE_ROOT+'/installed-old-adoption.json';
const BASELINE_ROOT = '/var/lib/servora-med-recovery-baselines';
const ADOPTABLE_OLD = '71ae6df6dd0659ed6390a6785d4bab29ddf5b1fa';
const ORIGINAL_OLD_ARTIFACT = '6f9dbb6a211813fd0d6d5e92396b71045d506eb959cd98d883e257663af79672';
const ORIGINAL_OLD_CATALOG = 'd285479365412eaf25133adec8853be75cb97ac87a46980b814e5321333ee62d';

// OPS-R4-002 is a separate, one-time recovery contract for the missing
// 67d3318 artifact. It never changes the OPS-R4-001 constants, record or slot.
// Policy selection is by the approval's exact OLD release SHA, never by a
// caller-supplied path, mode, force flag or arbitrary selector.
const OPS_R4_001_POLICY = Object.freeze({
  policyId: 'OPS-R4-001',
  oldReleaseSha: ADOPTABLE_OLD,
  originalArtifactSha256: ORIGINAL_OLD_ARTIFACT,
  reconstructedArtifactSha256: null,
  contentManifestSha256: null,
  oldCatalogSha256: ORIGINAL_OLD_CATALOG,
  baselineIdPattern: /^[0-9]{8}T[0-9]{6}Z-issue369-71ae6df6$/,
  recordKind: 'ADOPTED_INSTALLED_OLD_FIRST_CUTOVER',
  adoptionFile: ADOPTION_FILE
});

export const OPS_R4_002_POLICY = Object.freeze({
  policyId: 'OPS-R4-002',
  oldReleaseSha: '67d33183d22e00f231ca21a5807cf49a6c4c2a68',
  originalArtifactSha256: 'a1db5a8d8faea144f6f18006f09cd9c0f457a6a79782fd5fcd9884f528593ebf',
  reconstructedArtifactSha256: 'ddf12049ed483062d00b4a1c0fdd4909d01010d9dc9459c3cb5a5c39c142a220',
  contentManifestSha256: '059dedcbaf2de186608e7f975f223a5ac659651d67ca56bbb6a26407a9628aef',
  oldCatalogSha256: '43f96550a71be82e55d855a677fdf2ecbecf4acf9a0dfba6d9f5ae988bc75c28',
  baselineIdPattern: /^[0-9]{8}T[0-9]{6}Z-ops-r4-002-67d3318$/,
  recordKind: 'ADOPTED_INSTALLED_OLD_OPS_R4_002',
  adoptionFile: STATE_ROOT+'/installed-old-adoption-67d3318.json'
});

// OPS-R4-003 is a separate historical disposition and archive-completion gate
// for the one consumed, nonterminal OPS-R4-001 attempt. It is not an approval,
// not a terminal state, and not a caller-selectable recovery mode. The exact
// historical attempt is fixed in source; there is no attempt/path selector.
const HISTORICAL_OLD_RELEASE = '71ae6df6dd0659ed6390a6785d4bab29ddf5b1fa';
const HISTORICAL_OLD_ARTIFACT = '6f9dbb6a211813fd0d6d5e92396b71045d506eb959cd98d883e257663af79672';
const HISTORICAL_TARGET_RELEASE = 'f5f87d450061ca12ee80451c55eb56e99b80823c';
const HISTORICAL_TARGET_TREE = 'ab6f387460259c29ff3a30ba25e9619b39b7f7c8';
const HISTORICAL_TARGET_ARTIFACT = 'd85c13c465a4ad5e3ea33ed2a8d8d6271707d3303c000ea731648f1f49153b33';
const HISTORICAL_OLD_BASELINE_ID = '20261028T055858Z-issue369-71ae6df6';
const HISTORICAL_OLD_BASELINE_DIR = BASELINE_ROOT+'/'+HISTORICAL_OLD_BASELINE_ID;
const HISTORICAL_DISPOSITION_ROOT = STATE_ROOT+'/historical-dispositions';
const HISTORICAL_DISPOSITION_FILE = HISTORICAL_DISPOSITION_ROOT+'/'+HISTORICAL_ATTEMPT_ID+'.json';
const HISTORICAL_ARCHIVE_ROOT = '/var/lib/servora-med-recovery-archive';
const HISTORICAL_ARCHIVE_DIR = HISTORICAL_ARCHIVE_ROOT+'/'+HISTORICAL_ATTEMPT_ID;
// The controller's one new import is pinned by hash instead of by a tenth
// profile contract key: every historical profile carries exactly nine keys and
// must stay readable for the retained OPS-R4-001 evidence and the emergency
// handoff. The profile already pins this controller's bytes, so pinning the
// shared evidence module here closes the dependency without a schema change or
// a second recovery protocol.
const HISTORICAL_EVIDENCE_TOOL = INSTALLED+'/historical-recovery-evidence.mjs';
const HISTORICAL_EVIDENCE_TOOL_SHA256 = 'c6c4eada519183056a05d8c982ef4eaba311289ed271456182a665b7362d254f';
const HISTORICAL_ARCHIVE_MANIFEST_FILE = HISTORICAL_ARCHIVE_DIR+'/ARCHIVE-MANIFEST.json';
const HISTORICAL_ARCHIVE_COMPLETE_FILE = HISTORICAL_ARCHIVE_DIR+'/ARCHIVE-COMPLETE.json';
const HISTORICAL_SOURCE_EMPTY_PROOF_FILE = HISTORICAL_ARCHIVE_DIR+'/SOURCE-EMPTY-PROOF.json';
const HISTORICAL_OLD_APPROVAL_FILE = STATE_ROOT+'/approvals/'+HISTORICAL_ATTEMPT_ID+'.json';
const HISTORICAL_OLD_BASELINE_MANIFEST_FILE = HISTORICAL_OLD_BASELINE_DIR+'/baseline-manifest.json';
const HISTORICAL_OLD_BASELINE_SUMS_FILE = HISTORICAL_OLD_BASELINE_DIR+'/SHA256SUMS';
const HISTORICAL_EMERGENCY_RECEIPT_FILE = STATE_ROOT+
  '/emergency/52f632ef-ca3e-49ab-a26e-0b562adc2c78/receipt.json';
const HISTORICAL_POSTDEPLOY_LOG_FILE = STATE_ROOT+'/logs/'+HISTORICAL_ATTEMPT_ID+
  '/postdeploy-operator-20261101T040551Z.log';
const HISTORICAL_POSTDEPLOY_RC_FILE = STATE_ROOT+'/logs/'+HISTORICAL_ATTEMPT_ID+
  '/postdeploy-operator-20261101T040551Z.rc';
const HISTORICAL_PRESERVED_EVIDENCE = Object.freeze([
  {path:ADOPTION_FILE,role:'old-adoption',liveSource:true},
  {path:HISTORICAL_OLD_APPROVAL_FILE,role:'old-approval',liveSource:true},
  {path:HISTORICAL_OLD_BASELINE_MANIFEST_FILE,role:'old-baseline-manifest',liveSource:true},
  {path:HISTORICAL_OLD_BASELINE_SUMS_FILE,role:'old-baseline-sha256sums',liveSource:true},
  {path:HISTORICAL_EMERGENCY_RECEIPT_FILE,role:'emergency-receipt',liveSource:true},
  {path:'preserved/profile.json',role:'old-profile-copy',liveSource:false},
  {path:'preserved/disposition.json',role:'disposition-copy',liveSource:true,
    sourcePath:HISTORICAL_DISPOSITION_FILE}
].map(Object.freeze));
const HISTORICAL_ARCHIVE_METADATA_PATHS = Object.freeze([
  'ARCHIVE-MANIFEST.json','ARCHIVE-COMPLETE.json','SOURCE-EMPTY-PROOF.json'
]);

export const OPS_R4_003_POLICY = Object.freeze({
  policyId: 'OPS-R4-003',
  attemptId: HISTORICAL_ATTEMPT_ID,
  oldReleaseSha: HISTORICAL_OLD_RELEASE,
  oldArtifactSha256: HISTORICAL_OLD_ARTIFACT,
  targetReleaseSha: HISTORICAL_TARGET_RELEASE,
  targetTreeSha: HISTORICAL_TARGET_TREE,
  targetArtifactSha256: HISTORICAL_TARGET_ARTIFACT,
  oldBaselineId: HISTORICAL_OLD_BASELINE_ID,
  lastSequence: 17,
  checkpointCount: 18,
  lastPhase: 'POSTDEPLOY_BACKUP_PASSED',
  observationPassed: false,
  smokePassed: true,
  starts: 2,
  maxStarts: 2,
  abortStarts: 0,
  maxAbortStarts: 1,
  classification: 'ABANDONED_SUPERSEDED',
  r4Acceptance: 'NOT_ACCEPTED',
  r4TerminalState: 'HEALTH_PASSED_FENCED',
  operationalStatus: 'EMERGENCY_RESTART_POLICY_RESTORED',
  dispositionFile: HISTORICAL_DISPOSITION_FILE,
  archiveDir: HISTORICAL_ARCHIVE_DIR,
  archiveManifestFile: HISTORICAL_ARCHIVE_MANIFEST_FILE,
  archiveCompleteFile: HISTORICAL_ARCHIVE_COMPLETE_FILE,
  sourceEmptyProofFile: HISTORICAL_SOURCE_EMPTY_PROOF_FILE,
  oldApprovalFile: HISTORICAL_OLD_APPROVAL_FILE,
  oldAdoptionFile: ADOPTION_FILE,
  oldBaselineManifestFile: HISTORICAL_OLD_BASELINE_MANIFEST_FILE,
  oldBaselineSha256SumsFile: HISTORICAL_OLD_BASELINE_SUMS_FILE,
  emergencyReceiptFile: HISTORICAL_EMERGENCY_RECEIPT_FILE,
  postdeployLogFile: HISTORICAL_POSTDEPLOY_LOG_FILE,
  postdeployRcFile: HISTORICAL_POSTDEPLOY_RC_FILE
});

export const OPS_R4_003_LAYOUT = Object.freeze({
  archivedPaths: HISTORICAL_ARCHIVED_PATHS,
  preservedEvidence: HISTORICAL_PRESERVED_EVIDENCE,
  metadataPaths: HISTORICAL_ARCHIVE_METADATA_PATHS
});

const RECOVERY_POLICIES = Object.freeze({
  [OPS_R4_001_POLICY.oldReleaseSha]: OPS_R4_001_POLICY,
  [OPS_R4_002_POLICY.oldReleaseSha]: OPS_R4_002_POLICY
});

function recoveryPolicyForRelease(sha) {
  const policy = Object.hasOwn(RECOVERY_POLICIES, sha) ? RECOVERY_POLICIES[sha] : null;
  if (!policy) throw new Error('RECOVERY_INSTALLED_OLD_ADOPTION_INVALID');
  return policy;
}

const jsonDigest = value => digest(JSON.stringify(value)+'\n');
const ADOPTION_KEYS = ['formatVersion','kind','attemptId','approvalSha256','profileSha256','machineId',
  'oldReleaseSha','originalArtifactSha256','oldCatalogSha256','oldContentManifestSha256',
  'targetReleaseSha','targetTreeSha','targetArtifactSha256','baselineId','baselineManifestSha256',
  'adoptedArchiveSha256','databaseDumpSha256','attestedTime'];

const HISTORICAL_DISPOSITION_KEYS = Object.freeze(['formatVersion','kind','dispositionId','attemptId',
  'classification','approvalSha256','profileSha256','machineId','oldReleaseSha','targetReleaseSha',
  'targetTreeSha','targetArtifactSha256','initialCheckpointSha256','lastCheckpointSha256',
  'admissionProofSha256','checkpointCount','lastSequence','lastPhase','observationPassed',
  'smokePassed','starts','maxStarts','abortStarts','maxAbortStarts','terminal','r4Acceptance',
  'emergencyReceiptSha256','postdeployLogSha256','postdeployRcSha256','oldAdoptionSha256',
  'oldBaselineManifestSha256','oldBaselineSha256SumsSha256','issuedAtUTC','issuedTime']);
const HISTORICAL_MANIFEST_KEYS = Object.freeze(['formatVersion','kind','attemptId','dispositionSha256',
  'approvalSha256','profileSha256','machineId','oldReleaseSha','targetReleaseSha','targetTreeSha',
  'targetArtifactSha256','archivedFiles','preservedEvidence','sourceDirectories','removedDirectories',
  'checkpoint','createdAtUTC']);
const HISTORICAL_ARCHIVE_ENTRY_KEYS = Object.freeze(['sourcePath','archivePath','type','mode',
  'sourceMode','sourceMtimeNs','uid','gid','nlink','size','sha256','symlinkTarget']);
const HISTORICAL_PRESERVED_KEYS = Object.freeze(['path','role','liveSource','sha256','size']);
const HISTORICAL_DIRECTORY_KEYS = Object.freeze(['beforeEntries','afterEntries','sourceMtimeNs']);
const HISTORICAL_REMOVED_DIRECTORY_KEYS = Object.freeze(['mode','uid','gid','sourceMtimeNs']);
const historicalMtimeNs = value => typeof value === 'string' && /^(?:0|[1-9][0-9]{0,19})$/.test(value);
const HISTORICAL_PROOF_KEYS = Object.freeze(['formatVersion','kind','attemptId','dispositionSha256',
  'manifestSha256','directories','pendingMarkers','verifiedAtUTC']);
const HISTORICAL_PROOF_DIRECTORY_KEYS = Object.freeze(['exists','type','symlink','uid','gid','mode',
  'entries']);
const HISTORICAL_PENDING_KEYS = Object.freeze(['active','activation','permit','recoveryDropIn']);
const HISTORICAL_COMPLETE_KEYS = Object.freeze(['formatVersion','kind','attemptId','dispositionSha256',
  'manifestSha256','sourceEmptyProofSha256','archiveId','complete','checkpointCount',
  'lastCheckpointSha256','lastPhase','observationPassed','terminal','starts','completedAtUTC']);
const HISTORICAL_CHECKPOINT_KEYS = Object.freeze(['count','lastSequence','lastSha256','lastPhase',
  'observationPassed','smokePassed','starts','abortStarts']);
const HISTORICAL_HEX = /^[0-9a-f]{64}$/;
const HISTORICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HISTORICAL_MACHINE = /^[0-9a-f]{32}$/;
const historicalUtc = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
const historicalExact = (value, keys) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const historicalDispositionFail = () => {
  throw new Error('RECOVERY_HISTORICAL_DISPOSITION_INVALID');
};
const historicalArchiveFail = () => {
  throw new Error('RECOVERY_HISTORICAL_ARCHIVE_INVALID');
};
const historicalPreservationFail = () => {
  throw new Error('RECOVERY_HISTORICAL_PRESERVATION_INVALID');
};

/** Pure disposition validation. Root-private readers must supply every hash. */
export function validateHistoricalRecoveryDisposition(record, context, fail = historicalDispositionFail) {
  const policy = OPS_R4_003_POLICY;
  if (!historicalExact(record, HISTORICAL_DISPOSITION_KEYS) || record.formatVersion !== 1
    || record.kind !== 'HISTORICAL_RECOVERY_DISPOSITION' || !HISTORICAL_UUID.test(record.dispositionId)
    || record.attemptId !== policy.attemptId || record.classification !== policy.classification
    || record.terminal !== false || record.r4Acceptance !== policy.r4Acceptance
    || record.lastPhase !== policy.lastPhase || record.observationPassed !== false
    || record.smokePassed !== true || record.starts !== policy.starts
    || record.maxStarts !== policy.maxStarts || record.abortStarts !== policy.abortStarts
    || record.maxAbortStarts !== policy.maxAbortStarts || record.checkpointCount !== policy.checkpointCount
    || record.lastSequence !== policy.lastSequence || record.oldReleaseSha !== policy.oldReleaseSha
    || record.targetReleaseSha !== policy.targetReleaseSha
    || record.targetTreeSha !== policy.targetTreeSha
    || record.targetArtifactSha256 !== policy.targetArtifactSha256
    || !HISTORICAL_MACHINE.test(record.machineId)
    || ['approvalSha256','profileSha256','initialCheckpointSha256','lastCheckpointSha256',
      'admissionProofSha256','emergencyReceiptSha256','postdeployLogSha256','postdeployRcSha256',
      'oldAdoptionSha256','oldBaselineManifestSha256','oldBaselineSha256SumsSha256']
      .some(key => !HISTORICAL_HEX.test(record[key]))) fail();
  if (!context || !context.approval || !context.profile || !context.initialCheckpoint
    || !context.lastCheckpoint || !context.admissionProof || !context.emergencyReceipt
    || !context.oldAdoption || !context.oldBaselineManifest || !context.currentTime) fail();
  const {approval,profile,initialCheckpoint,lastCheckpoint,admissionProof,emergencyReceipt} = context;
  try { validateApprovalStructure(approval); } catch { fail(); }
  if (approval.attemptId !== policy.attemptId || approval.releaseSha !== policy.targetReleaseSha
    || approval.treeSha !== policy.targetTreeSha || approval.artifactSha256 !== policy.targetArtifactSha256
    || approval.oldReleaseSha !== policy.oldReleaseSha
    || approval.oldArtifactSha256 !== policy.oldArtifactSha256
    || approval.maxStarts !== policy.maxStarts || approval.maxAbortStarts !== policy.maxAbortStarts
    || jsonDigest(approval.oldCatalog) !== context.oldAdoption.oldCatalogSha256
    || approval.profileSha256 !== context.profileSha256
    || record.approvalSha256 !== context.approvalSha256
    || record.profileSha256 !== context.profileSha256
    || record.machineId !== context.machineId || profile.machineId !== record.machineId) fail();
  if (!initialCheckpoint.record || !HISTORICAL_HEX.test(initialCheckpoint.sha256)
    || initialCheckpoint.record.attemptId !== policy.attemptId
    || initialCheckpoint.record.sequence !== 0
    || initialCheckpoint.sha256 !== record.initialCheckpointSha256) fail();
  if (!lastCheckpoint.record || !HISTORICAL_HEX.test(lastCheckpoint.sha256)
    || lastCheckpoint.record.attemptId !== policy.attemptId
    || lastCheckpoint.record.sequence !== policy.lastSequence
    || lastCheckpoint.record.phase !== policy.lastPhase
    || lastCheckpoint.record.observationPassed !== false
    || lastCheckpoint.record.smokePassed !== true
    || lastCheckpoint.record.starts !== policy.starts
    || lastCheckpoint.record.abortStarts !== policy.abortStarts
    || lastCheckpoint.record.approvalSha256 !== record.approvalSha256
    || lastCheckpoint.record.profileSha256 !== record.profileSha256
    || lastCheckpoint.sha256 !== record.lastCheckpointSha256) fail();
  if (admissionProof.formatVersion !== 2 || admissionProof.attemptId !== policy.attemptId
    || admissionProof.approvalSha256 !== record.approvalSha256
    || admissionProof.initialSha256 !== record.initialCheckpointSha256
    || context.admissionProofSha256 !== record.admissionProofSha256) fail();
  try { validateCurrentTimeEvidence(admissionProof.postFsyncTime); } catch { fail(); }
  if (emergencyReceipt.kind !== 'EMERGENCY_HANDOFF_RECEIPT'
    || !emergencyReceipt.parent || emergencyReceipt.parent.attemptId !== policy.attemptId
    || emergencyReceipt.parent.phase !== policy.lastPhase
    || emergencyReceipt.parentAttemptCompleted !== false
    || emergencyReceipt.r4Acceptance !== policy.r4Acceptance
    || emergencyReceipt.r4TerminalState !== policy.r4TerminalState
    || emergencyReceipt.operationalStatus !== policy.operationalStatus
    || emergencyReceipt.observationPassed !== false
    || !emergencyReceipt.host || emergencyReceipt.host.releaseSha !== policy.targetReleaseSha
    || context.emergencyReceiptSha256 !== record.emergencyReceiptSha256) fail();
  if (context.postdeployLogSha256 !== record.postdeployLogSha256
    || context.postdeployRcSha256 !== record.postdeployRcSha256) fail();
  if (context.oldAdoption.kind !== 'ADOPTED_INSTALLED_OLD_FIRST_CUTOVER'
    || context.oldAdoption.attemptId !== policy.attemptId
    || context.oldAdoption.machineId !== record.machineId
    || context.oldAdoption.approvalSha256 !== record.approvalSha256
    || context.oldAdoption.profileSha256 !== record.profileSha256
    || context.oldAdoption.oldReleaseSha !== policy.oldReleaseSha
    || context.oldAdoption.originalArtifactSha256 !== policy.oldArtifactSha256
    || context.oldAdoption.targetReleaseSha !== policy.targetReleaseSha
    || context.oldAdoption.targetTreeSha !== policy.targetTreeSha
    || context.oldAdoption.targetArtifactSha256 !== policy.targetArtifactSha256
    || context.oldAdoption.baselineId !== policy.oldBaselineId
    || context.oldAdoption.baselineManifestSha256 !== context.oldBaselineManifestSha256
    || context.oldAdoptionSha256 !== record.oldAdoptionSha256) fail();
  if (context.oldBaselineManifest.kind !== 'RECOVERY_BASELINE_NOT_ORIGINAL_ARTIFACT'
    || context.oldBaselineManifest.baselineId !== policy.oldBaselineId
    || context.oldBaselineManifest.machineId !== record.machineId
    || context.oldBaselineManifest.sourceReleaseSha !== policy.oldReleaseSha
    || context.oldBaselineManifest.originalArtifactSha256 !== policy.oldArtifactSha256
    || context.oldBaselineManifest.restoreAcceptance !== false
    || context.oldBaselineManifestSha256 !== record.oldBaselineManifestSha256
    || context.oldBaselineSha256SumsSha256 !== record.oldBaselineSha256SumsSha256) fail();
  if (record.issuedAtUTC !== record.issuedTime.wallAtUTC || !historicalUtc(record.issuedAtUTC)) fail();
  try { validateCurrentTimeEvidence(record.issuedTime); validateCurrentTimeEvidence(context.currentTime); }
  catch (error) { throw error; }
  if (Date.parse(record.issuedAtUTC) > Date.parse(context.currentTime.wallAtUTC)) fail();
  return record;
}

/** Pure builder used by the administrator API and deterministic tests. */
export function historicalRecoveryDispositionRecord(context) {
  const record = {
    formatVersion: 1,
    kind: 'HISTORICAL_RECOVERY_DISPOSITION',
    dispositionId: randomUUID(),
    attemptId: OPS_R4_003_POLICY.attemptId,
    classification: OPS_R4_003_POLICY.classification,
    approvalSha256: context.approvalSha256,
    profileSha256: context.profileSha256,
    machineId: context.machineId,
    oldReleaseSha: OPS_R4_003_POLICY.oldReleaseSha,
    targetReleaseSha: OPS_R4_003_POLICY.targetReleaseSha,
    targetTreeSha: OPS_R4_003_POLICY.targetTreeSha,
    targetArtifactSha256: OPS_R4_003_POLICY.targetArtifactSha256,
    initialCheckpointSha256: context.initialCheckpoint.sha256,
    lastCheckpointSha256: context.lastCheckpoint.sha256,
    admissionProofSha256: context.admissionProofSha256,
    checkpointCount: OPS_R4_003_POLICY.checkpointCount,
    lastSequence: OPS_R4_003_POLICY.lastSequence,
    lastPhase: OPS_R4_003_POLICY.lastPhase,
    observationPassed: false,
    smokePassed: true,
    starts: OPS_R4_003_POLICY.starts,
    maxStarts: OPS_R4_003_POLICY.maxStarts,
    abortStarts: OPS_R4_003_POLICY.abortStarts,
    maxAbortStarts: OPS_R4_003_POLICY.maxAbortStarts,
    terminal: false,
    r4Acceptance: OPS_R4_003_POLICY.r4Acceptance,
    emergencyReceiptSha256: context.emergencyReceiptSha256,
    postdeployLogSha256: context.postdeployLogSha256,
    postdeployRcSha256: context.postdeployRcSha256,
    oldAdoptionSha256: context.oldAdoptionSha256,
    oldBaselineManifestSha256: context.oldBaselineManifestSha256,
    oldBaselineSha256SumsSha256: context.oldBaselineSha256SumsSha256,
    issuedAtUTC: context.currentTime.wallAtUTC,
    issuedTime: context.currentTime
  };
  return validateHistoricalRecoveryDisposition(record, context);
}

/** Pure binding check; callers must obtain records through root-private readers. */
export function validateInstalledOldAdoption(record, context, baseline, baselineSha256) {
  const fail = () => { throw new Error('RECOVERY_INSTALLED_OLD_ADOPTION_INVALID'); };
  const {approval,approvalSha256,profile} = context;
  validateApprovalStructure(approval);
  let policy;
  try { policy = recoveryPolicyForRelease(approval.oldReleaseSha); }
  catch { fail(); }
  if (!record || Object.keys(record).length !== ADOPTION_KEYS.length
    || ADOPTION_KEYS.some(key=>!Object.hasOwn(record,key)) || record.formatVersion !== 1
    || record.kind !== policy.recordKind
    || approval.oldReleaseSha !== policy.oldReleaseSha
    || approval.oldArtifactSha256 !== policy.originalArtifactSha256
    || jsonDigest(approval.oldCatalog) !== policy.oldCatalogSha256
    || record.attemptId !== approval.attemptId || record.approvalSha256 !== approvalSha256
    || record.profileSha256 !== approval.profileSha256 || record.machineId !== profile.machineId
    || record.oldReleaseSha !== policy.oldReleaseSha
    || record.oldReleaseSha !== approval.oldReleaseSha
    || record.originalArtifactSha256 !== policy.originalArtifactSha256
    || record.originalArtifactSha256 !== approval.oldArtifactSha256
    || record.oldCatalogSha256 !== policy.oldCatalogSha256
    || record.oldCatalogSha256 !== jsonDigest(approval.oldCatalog)
    || record.targetReleaseSha !== approval.releaseSha || record.targetTreeSha !== approval.treeSha
    || record.targetArtifactSha256 !== approval.artifactSha256
    || !policy.baselineIdPattern.test(record.baselineId)
    || record.baselineManifestSha256 !== baselineSha256
    || ['approvalSha256','profileSha256','oldCatalogSha256','oldContentManifestSha256',
      'targetArtifactSha256','baselineManifestSha256','adoptedArchiveSha256','databaseDumpSha256']
      .some(key=>typeof record[key] !== 'string' || !/^[0-9a-f]{64}$/.test(record[key]))) fail();
  // Attestation proves a historical root action inside this grant's original
  // window. It never re-anchors current approval age or consumed-attempt scope.
  validateApproval(approval,record.attestedTime);
  if (!baseline || baseline.formatVersion !== 1 || baseline.kind !== 'RECOVERY_BASELINE_NOT_ORIGINAL_ARTIFACT'
    || baseline.baselineId !== record.baselineId || baseline.machineId !== profile.machineId
    || baseline.sourceReleaseSha !== policy.oldReleaseSha
    || baseline.sourceReleaseSha !== approval.oldReleaseSha
    || baseline.originalArtifactSha256 !== policy.originalArtifactSha256
    || baseline.originalArtifactSha256 !== approval.oldArtifactSha256
    || baseline.installedContentManifestSha256 !== record.oldContentManifestSha256
    || jsonDigest(baseline.catalog) !== policy.oldCatalogSha256
    || baseline.restoreAcceptance !== false
    || !Number.isFinite(Date.parse(baseline.completedAtUTC))
    || Date.parse(baseline.completedAtUTC) > Date.parse(record.attestedTime.wallAtUTC)
    || ['dumpList','dumpCatalogExact','adoptedArchiveComparedToInstalled','configurationArchiveCompared',
      'originalObservationAndMarkerUnchanged','appPidUnchanged'].some(key=>baseline.verifications?.[key] !== true)) fail();
  validateDatabaseIdentity(profile.databaseIdentity); validateDatabaseIdentity(baseline.databaseIdentity);
  if (Object.keys(profile.databaseIdentity).some(key=>profile.databaseIdentity[key] !== baseline.databaseIdentity[key])) fail();
  for (const name of ['database.dump','installed-old-release.adopted.tar.gz','configuration.tar.gz',
    'database-metadata.json','installed-old-content.sha256']) {
    const entry = baseline.files?.[name];
    if (!entry || entry.name !== name || !/^[0-9a-f]{64}$/.test(entry.sha256)
      || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0) fail();
  }
  if (record.adoptedArchiveSha256 !== baseline.files['installed-old-release.adopted.tar.gz'].sha256
    || record.adoptedArchiveSha256 === approval.oldArtifactSha256
    || record.oldContentManifestSha256 !== baseline.files['installed-old-content.sha256'].sha256
    || record.databaseDumpSha256 !== baseline.files['database.dump'].sha256) fail();
  // OPS-R4-002 pins the recovered archive and content manifest to the exact
  // published recovery identity. OPS-R4-001 leaves these two historical fields
  // unpinned, exactly as its already-consumed sealed record was validated.
  if (policy.contentManifestSha256 !== null
    && (record.oldContentManifestSha256 !== policy.contentManifestSha256
      || baseline.installedContentManifestSha256 !== policy.contentManifestSha256
      || baseline.files['installed-old-content.sha256'].sha256 !== policy.contentManifestSha256)) fail();
  if (policy.reconstructedArtifactSha256 !== null
    && (record.adoptedArchiveSha256 !== policy.reconstructedArtifactSha256
      || baseline.files['installed-old-release.adopted.tar.gz'].sha256 !== policy.reconstructedArtifactSha256)) fail();
  return record;
}

/** Separate administrator API, deliberately absent from the deploy CLI. */
export function issueInstalledOldAdoption(attemptId, baselineId) {
  return issueInstalledOldAdoptionForPolicy(attemptId, baselineId, OPS_R4_001_POLICY);
}

/** OPS-R4-002 separate one-time administrator API; no mode/path selector. */
export function issueInstalledOldAdoption67d3318(attemptId, baselineId) {
  return issueInstalledOldAdoptionForPolicy(attemptId, baselineId, OPS_R4_002_POLICY);
}

function issueInstalledOldAdoptionForPolicy(attemptId, baselineId, policy) {
  if (![OPS_R4_001_POLICY, OPS_R4_002_POLICY].includes(policy)) {
    throw new Error('RECOVERY_INSTALLED_OLD_ADOPTION_INVALID');
  }
  if (process.getuid?.() !== 0) throw new Error('RECOVERY_ADOPTION_ADMIN_REQUIRED');
  // The administrator CLI inherits the same open-file description as the
  // deployment helper. Verify the stable inode and take/confirm its kernel
  // lock before reading state; a direct, unlocked API call cannot race admit.
  try {
    trustedFile(STATE_ROOT+'/host.lock',0o600);
    const held = fstatSync(9), named = lstatSync(STATE_ROOT+'/host.lock');
    if (!held.isFile() || held.dev !== named.dev || held.ino !== named.ino) throw new Error();
    execFileSync('/usr/bin/flock',['--nonblock','9'],{timeout:2000,
      env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'},stdio:['ignore','pipe','pipe',...Array(6).fill('ignore'),9]});
    const after = lstatSync(STATE_ROOT+'/host.lock');
    if (held.dev !== after.dev || held.ino !== after.ino) throw new Error();
  } catch { throw new Error('RECOVERY_ADOPTION_HOST_LOCK_REQUIRED'); }
  if (typeof baselineId !== 'string' || !policy.baselineIdPattern.test(baselineId)) {
    throw new Error('RECOVERY_INSTALLED_OLD_ADOPTION_INVALID');
  }
  // One exclusive permanent host slot per policy. Partial publication burns
  // reuse too; there is no renewal, overwrite, journal repair or deploy-user
  // issuance. OPS-R4-002 has a different file and never touches OPS-R4-001.
  if (existsSync(policy.adoptionFile)) throw new Error('RECOVERY_ADOPTION_ALREADY_SEALED');
  // Reject pending state before loadAttempt: its normal deployment recovery
  // path can reconcile checkpoint residues in a pending systemd window.
  for (const path of [STATE_ROOT+'/active.json',STATE_ROOT+'/activation.block',PERMIT_FILE,
    '/etc/systemd/system/servora-med.service.d/90-servora-recovery.conf']) {
    // OPS-R4-002 requires positive absence. existsSync follows symlinks,
    // masking dangling links and access failures; OPS-R4-001 remains unchanged.
    if (policy === OPS_R4_002_POLICY) {
      try { lstatSync(path); }
      catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw new Error('RECOVERY_ADOPTION_STATE_UNTRUSTED');
      }
      throw new Error('RECOVERY_ADOPTION_STATE_NOT_EMPTY');
    }
    if (existsSync(path)) throw new Error('RECOVERY_ADOPTION_STATE_NOT_EMPTY');
  }
  if (policy === OPS_R4_002_POLICY) {
    // The 67d3318 policy owns its historical proof: either the sealed OPS-R4-003
    // archive over trusted empty sources, or the exact 26-file attempt preserved
    // in place with a verified OPS-R4-005 stage receipt. Empty directories alone
    // establish neither, so the generic check is not reused here.
    verifyHistoricalPreservationGate();
  } else {
    for (const path of [STATE_ROOT+'/attempts',STATE_ROOT+'/initializations',STATE_ROOT+'/admission-proofs',
      STATE_ROOT+'/backups',STATE_ROOT+'/logs']) {
      if (!existsSync(path)) continue;
      const info = lstatSync(path);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0
        || (info.mode & 0o7777) !== 0o700) throw new Error('RECOVERY_ADOPTION_STATE_UNTRUSTED');
      if (readdirSync(path).length) throw new Error('RECOVERY_ADOPTION_STATE_NOT_EMPTY');
    }
  }
  // OPS-R4-001 keeps its historical behavior unchanged.
  const context = loadAttempt(attemptId), {approval,profile} = context;
  const root = '/opt/servora-med/releases/'+policy.oldReleaseSha;
  const tuple = validateIdentityTuple(trustedFile(ENV_FILE,0o640,null).toString('utf8'),approval);
  if (realpathSync('/opt/servora-med/current') !== root || tuple.release !== policy.oldReleaseSha
    || tuple.schema !== approval.oldCatalog.at(-1).version
    || existsSync(`${STATE_ROOT}/artifacts/${policy.oldReleaseSha}.tar.gz`)
    || trustedFile(root+'/.servora-release-artifact.sha256',0o600).toString('utf8') !== policy.originalArtifactSha256+'\n') {
    throw new Error('RECOVERY_INSTALLED_OLD_ADOPTION_INVALID');
  }
  const baselineBytes = trustedFile(BASELINE_ROOT+'/'+baselineId+'/baseline-manifest.json',0o600);
  const baseline = parseCanonicalRecord(baselineBytes.toString('utf8'));
  const record = {formatVersion:1,kind:policy.recordKind,attemptId,
    approvalSha256:context.approvalSha256,profileSha256:approval.profileSha256,machineId:profile.machineId,
    oldReleaseSha:approval.oldReleaseSha,originalArtifactSha256:approval.oldArtifactSha256,
    oldCatalogSha256:jsonDigest(approval.oldCatalog),oldContentManifestSha256:baseline.installedContentManifestSha256,
    targetReleaseSha:approval.releaseSha,targetTreeSha:approval.treeSha,targetArtifactSha256:approval.artifactSha256,
    baselineId,baselineManifestSha256:digest(baselineBytes),
    adoptedArchiveSha256:baseline.files?.['installed-old-release.adopted.tar.gz']?.sha256,
    databaseDumpSha256:baseline.files?.['database.dump']?.sha256,attestedTime:sampleTrustedTime()};
  verifyAttemptCatalog(attemptId,'old');
  verifyInstalledOldBaseline(record,context,root,verifiedReleaseEntries(root),policy);
  // The directory is protected by loadAttempt's root-private grant/profile
  // readers. Mode is fixed by open, not by the caller's umask.
  const fd = openSync(policy.adoptionFile,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try { writeFileSync(fd,JSON.stringify(record)+'\n');fsyncSync(fd); } finally {closeSync(fd);}
  flushDirectory(STATE_ROOT);
  validateApproval(approval,sampleTrustedTime());
  const sealed = readProtectedRecord(policy.adoptionFile);
  if (sealed.sha256 !== jsonDigest(record)) throw new Error('RECOVERY_INSTALLED_OLD_ADOPTION_INVALID');
  return sealed;
}

function verifyInstalledOldBaseline(record,context,root,entries,policy) {
  // Validate the ID before using it as a path component, even for a sealed
  // administrator record. No arbitrary filesystem selector is accepted.
  if (!policy || policy.oldReleaseSha !== context?.approval?.oldReleaseSha
    || !policy.baselineIdPattern.test(record?.baselineId)) {
    throw new Error('RECOVERY_INSTALLED_OLD_ADOPTION_INVALID');
  }
  const directory = BASELINE_ROOT+'/'+record.baselineId;
  const bytes = trustedFile(directory+'/baseline-manifest.json',0o600);
  const baseline = parseCanonicalRecord(bytes.toString('utf8'));
  validateInstalledOldAdoption(record,context,baseline,digest(bytes));
  const payloads = Object.entries(baseline.files);
  if (payloads.length > 32) throw new Error('RECOVERY_INSTALLED_OLD_ADOPTION_INVALID');
  for (const [name,entry] of payloads) {
    if (!/^[a-z0-9][a-z0-9.-]{0,99}$/.test(name) || entry?.name !== name
      || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0) throw new Error('RECOVERY_INSTALLED_OLD_ADOPTION_INVALID');
    const payload = trustedFile(directory+'/'+name,0o600);
    if (payload.length !== entry.bytes || digest(payload) !== entry.sha256) throw new Error('RECOVERY_INSTALLED_OLD_ADOPTION_INVALID');
  }
  if (digest(trustedFile(root+'/.servora-release-content.sha256',0o600)) !== record.oldContentManifestSha256) {
    throw new Error('RECOVERY_INSTALLED_OLD_ADOPTION_INVALID');
  }
  const archive = directory+'/installed-old-release.adopted.tar.gz';
  const run = args => execFileSync('/usr/bin/tar',args,{encoding:'utf8',timeout:30000,maxBuffer:8388608,
    env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'},stdio:['ignore','pipe','pipe']});
  const names = run(['--list','--quoting-style=literal','--file',archive]).trimEnd().split('\n');
  const types = run(['--list','--verbose','--quoting-style=literal','--file',archive]).trimEnd().split('\n');
  const expected = new Map(entries.map(([path,line])=>[path,line[0]==='f'?'-':line[0]]));
  expected.set('.','d');expected.set('./.servora-release-artifact.sha256','-');expected.set('./.servora-release-content.sha256','-');
  if (names.length !== expected.size || types.length !== names.length) throw new Error('RECOVERY_INSTALLED_OLD_ADOPTION_INVALID');
  for (let index=0;index<names.length;index++) {
    const name = names[index].replace(/\/$/,'');
    if (!expected.has(name) || expected.get(name) !== types[index][0]) throw new Error('RECOVERY_INSTALLED_OLD_ADOPTION_INVALID');
    expected.delete(name);
  }
  // Compare bytes, file types, modes, owners and symlink targets; never extract
  // or execute the adopted archive. Missing/extra/duplicate members fail above.
  run(['--compare','--file',archive,'--directory',root]);
  execFileSync(PG_RESTORE_BIN,['--list',directory+'/database.dump'],{timeout:30000,maxBuffer:8388608,
    env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'},stdio:['ignore','pipe','pipe']});
  // Read only the migration ledger from the archive into memory. No database
  // connection, SQL execution, restore, or business-row export occurs here.
  const ledger = execFileSync(PG_RESTORE_BIN,['--data-only','--table=schema_migrations','--file=-',directory+'/database.dump'],
    {encoding:'utf8',timeout:30000,maxBuffer:1048576,env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'},stdio:['ignore','pipe','pipe']});
  const blocks = [...ledger.matchAll(/^COPY public\.schema_migrations \(version, applied_at\) FROM stdin;\n([\s\S]*?)^\\\.\n/gm)];
  const rows = blocks.length === 1 ? blocks[0][1].replace(/\n$/,'').split('\n') : [];
  const versions = rows.map(row=>row.match(/^([0-9]{3}_[a-z0-9_]+)\t[^\t\r\n]+$/)?.[1]).sort();
  if (JSON.stringify(versions) !== JSON.stringify(context.approval.oldCatalog.map(entry=>entry.version))) {
    throw new Error('RECOVERY_BASELINE_DUMP_CATALOG_MISMATCH');
  }
}

function existsSync(path) {
  // A dangling link is an existing, untrusted resource; never treat it as
  // permission to recreate a barrier, permit, approval or active owner.
  try { lstatSync(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function flushDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function attemptLogDirectory(attemptId) {
  currentAttempt(attemptId);
  for (const directory of [STATE_ROOT+'/logs',STATE_ROOT+'/logs/'+attemptId]) {
    if (!existsSync(directory)) { mkdirSync(directory,{mode:0o700}); flushDirectory(directory.slice(0,directory.lastIndexOf('/'))); }
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0
      || (info.mode & 0o7777) !== 0o700) throw new Error('RECOVERY_LOG_DIRECTORY_UNTRUSTED');
  }
  return STATE_ROOT+'/logs/'+attemptId;
}

const INITIALIZATIONS = STATE_ROOT+'/initializations';

function initializationRecord(context) {
  if (!existsSync(INITIALIZATIONS)) return null;
  const directory = lstatSync(INITIALIZATIONS);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== 0
    || directory.gid !== 0 || (directory.mode & 0o7777) !== 0o700) throw new Error('RECOVERY_INITIALIZATION_UNTRUSTED');
  const names = readdirSync(INITIALIZATIONS);
  const name = context.approval.attemptId+'.json';
  if (names.some(value => value !== name)) throw new Error('RECOVERY_OTHER_ATTEMPT_ACTIVE');
  if (!names.includes(name)) return null;
  const marker = INITIALIZATIONS+'/'+name;
  const checkpointDirectory = STATE_ROOT+'/attempts/'+context.approval.attemptId;
  const checkpointFile = checkpointDirectory+'/0000.json';
  let links = 1;
  if (existsSync(checkpointDirectory)) {
    const info = lstatSync(checkpointDirectory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0
      || (info.mode & 0o7777) !== 0o700
      || readdirSync(checkpointDirectory).some(value => value !== '0000.json')) throw new Error('RECOVERY_INITIALIZATION_CONFLICT');
    if (existsSync(checkpointFile)) {
      const first = lstatSync(checkpointFile), pending = lstatSync(marker);
      if (first.dev !== pending.dev || first.ino !== pending.ino) throw new Error('RECOVERY_INITIALIZATION_CONFLICT');
      links = 2; // Only this verified initial-marker/checkpoint inode pair.
    }
  }
  const record = readProtectedRecord(marker,links).record;
  advanceAttempt(record,context,'VALIDATE');
  validateInitialAttemptRecord(context,record);
  if (existsSync(STATE_ROOT+'/active.json')) {
    const active = readProtectedRecord(STATE_ROOT+'/active.json').record;
    if (Object.keys(active).length !== 2 || active.attemptId !== context.approval.attemptId
      || active.approvalSha256 !== context.approvalSha256) throw new Error('RECOVERY_OTHER_ATTEMPT_ACTIVE');
  }
  return {marker,record,checkpointDirectory,checkpointFile};
}

function finishInitialization(context) {
  const pending = initializationRecord(context);
  if (!pending) throw new Error('RECOVERY_INITIALIZATION_MISSING');
  // No backup, migration, budget, barrier, or later checkpoint can exist in
  // this initialization protocol. Never use it to repair a progressed chain.
  const id = context.approval.attemptId;
  publishRootAdmissionConfirmation(context,pending.record);
  if (existsSync(STATE_ROOT+'/backups/'+id+'-pre.dump') || existsSync(STATE_ROOT+'/backups/'+id+'-post.dump')
    || existsSync(STATE_ROOT+'/logs/'+id)) throw new Error('RECOVERY_INITIALIZATION_CONFLICT');
  if (!existsSync(STATE_ROOT+'/active.json')) {
    const fd = openSync(STATE_ROOT+'/active.json',constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try { writeFileSync(fd,JSON.stringify({attemptId:id,approvalSha256:context.approvalSha256})+'\n');fsyncSync(fd); }
    finally {closeSync(fd);}
    flushDirectory(STATE_ROOT);
  }
  if (!existsSync(pending.checkpointDirectory)) {
    mkdirSync(pending.checkpointDirectory,{mode:0o700});flushDirectory(STATE_ROOT+'/attempts');
  }
  if (!existsSync(pending.checkpointFile)) linkSync(pending.marker,pending.checkpointFile);
  flushDirectory(pending.checkpointDirectory);
  initializationRecord(context); // Exact pair and zero-progress proof again.
  unlinkSync(pending.marker);flushDirectory(INITIALIZATIONS);
  return readLatestCheckpoint(id);
}

/** Re-entry into the initial publication window requires fresh OLD identity
 * and full immutable proofs, under the normal host and PostgreSQL locks.
 */
async function reconcileInitialization(context) {
  if (!initializationRecord(context)) return false;
  if (existsSync(STATE_ROOT+'/activation.block') || existsSync(PERMIT_FILE)
    || existsSync('/etc/systemd/system/servora-med.service.d/90-servora-recovery.conf')) {
    throw new Error('RECOVERY_INITIALIZATION_CONFLICT');
  }
  verifyAttemptRelease(context.approval.attemptId,'old');verifyAttemptRelease(context.approval.attemptId,'target');
  const tuple = validateIdentityTuple(trustedFile(ENV_FILE,0o640,null).toString('utf8'),context.approval);
  if (tuple.release !== context.approval.oldReleaseSha || tuple.schema !== context.approval.oldCatalog.at(-1).version
    || realpathSync('/opt/servora-med/current') !== '/opt/servora-med/releases/'+context.approval.oldReleaseSha
    || systemctl('show','servora-med.service','-p','Restart','--value') !== 'on-failure') throw new Error('RECOVERY_INITIALIZATION_CONFLICT');
  await withGuard(context,'old',async check => {
    await check();finishInitialization(context);
  });
  return true;
}

/** Caller holds the common host lock; an active owner survives process exit.
 * A same-owner retry of an early, unmigrated attempt resumes instead of
 * stranding: no other attempt phase or owner is ever reclaimed here.
 */
export function admitAttempt(attemptId) {
  const context = loadAttempt(attemptId);
  // The public CLI reconciles pending initialization only after fresh DB and
  // payload proof. Direct persistence users must not auto-repair that window.
  if (initializationRecord(context)) throw new Error('RECOVERY_INITIALIZATION_REQUIRES_PROBE');
  if (existsSync(`${STATE_ROOT}/active.json`)) {
    const active = readProtectedRecord(`${STATE_ROOT}/active.json`).record;
    const checkpoint = readLatestCheckpoint(attemptId);
    if (Object.keys(active).length !== 2 || active.attemptId !== attemptId
      || active.approvalSha256 !== context.approvalSha256
      || !['ADMITTED','BACKED_UP'].includes(checkpoint.record.phase)) {
      throw new Error('RECOVERY_OTHER_ATTEMPT_ACTIVE');
    }
    assertRetainedBackups({ approval: context.approval, checkpoint });
    return { resumed: true, checkpoint };
  }
  if (existsSync(`${STATE_ROOT}/attempts/${attemptId}`)) throw new Error('ATTEMPT_ALREADY_ADMITTED');
  if (!existsSync(INITIALIZATIONS)) {mkdirSync(INITIALIZATIONS,{mode:0o700});flushDirectory(STATE_ROOT);}
  if (!existsSync(STATE_ROOT+'/attempts')) {mkdirSync(STATE_ROOT+'/attempts',{mode:0o700});flushDirectory(STATE_ROOT);}
  const marker = INITIALIZATIONS+'/'+attemptId+'.json';
  const fd = openSync(marker,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try {writeFileSync(fd,JSON.stringify(initialAttempt(context))+'\n');fsyncSync(fd);} finally {closeSync(fd);}
  flushDirectory(INITIALIZATIONS);
  return {resumed:false,checkpoint:finishInitialization(context)};
}

export function currentAttempt(attemptId) {
  const context = loadAttempt(attemptId);
  const checkpoint = readLatestCheckpoint(attemptId);
  // A completed retry is read-only. It cannot reclaim ownership or reset any
  // counter, and must not interfere with a newer active attempt.
  if (!existsSync(`${STATE_ROOT}/active.json`) && ['COMPLETED','COMPLETED_ABORT'].includes(checkpoint.record.phase)) {
    advanceAttempt(checkpoint.record,context,'VALIDATE');
    return {...context,checkpoint};
  }
  const active = readProtectedRecord(`${STATE_ROOT}/active.json`).record;
  if (Object.keys(active).length !== 2 || active.attemptId !== attemptId
    || active.approvalSha256 !== context.approvalSha256) throw new Error('RECOVERY_OTHER_ATTEMPT_ACTIVE');
  advanceAttempt(checkpoint.record, context, 'VALIDATE');
  return { ...context, checkpoint };
}

/** The service-UID guard holds the Migrator advisory lock across the whole
 * transition. While an operation runs under it, every acceptance checkpoint
 * proves the guard is still alive: a lost connection/lock must never receive
 * a journal event, and a non-zero guard exit is never a successful lifecycle.
 */
let activeGuard = null;

/** Long synchronous helper blocks (suppression, service stop, schema-check)
 * can defer the guard's exit callback past the next acceptance checkpoint.
 * Yield two event-loop turns so a lock loss that already happened is observed
 * by the checkpoint gate before any journal mutation is written.
 */
async function settleGuard() { if (activeGuard) await activeGuard.settle(); }

export function checkpointAttempt(attemptId, event) {
  if (activeGuard) activeGuard.assertAlive();
  const context = currentAttempt(attemptId);
  const next = advanceAttempt(context.checkpoint.record, context, event);
  next.previousHash = context.checkpoint.sha256;
  return appendRootCheckpoint(attemptId, next);
}

function writeAttemptBarrier(attemptId, approvalSha256) {
  const owner = { attemptId, approvalSha256 };
  const file = `${STATE_ROOT}/activation.block`;
  if (existsSync(file)) {
    try {
      const existing = readProtectedRecord(file).record;
      if (Object.keys(existing).length !== 2 || existing.attemptId !== attemptId
        || existing.approvalSha256 !== owner.approvalSha256) throw new Error('RECOVERY_BARRIER_UNTRUSTED');
    } catch { throw new Error('RECOVERY_BARRIER_UNTRUSTED'); }
    return;
  }
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd,JSON.stringify(owner)+'\n'); fsyncSync(fd); } finally { closeSync(fd); }
  flushDirectory(STATE_ROOT);
}

export function createAttemptBarrier(attemptId) {
  const context = currentAttempt(attemptId);
  if (!context.checkpoint.record.predeployBackup || context.checkpoint.record.phase === 'ADMITTED') throw new Error('ATTEMPT_TRANSITION_INVALID');
  writeAttemptBarrier(attemptId, context.approvalSha256);
}

function assertBarrier(context) {
  let record;
  try { record = readProtectedRecord(`${STATE_ROOT}/activation.block`).record; }
  catch { throw new Error('RECOVERY_BARRIER_UNTRUSTED'); }
  if (Object.keys(record).length !== 2 || record.attemptId !== context.approval.attemptId
    || record.approvalSha256 !== context.approvalSha256) throw new Error('RECOVERY_BARRIER_UNTRUSTED');
}

export function alignAttemptPointer(attemptId, direction) {
  const context = currentAttempt(attemptId);
  const {approval,checkpoint} = context;
  if (direction === 'target' ? checkpoint.record.phase !== 'POINTER_INTENT'
    : direction !== 'old' || checkpoint.record.phase !== 'ABORT_INTENT') throw new Error('ATTEMPT_TRANSITION_INVALID');
  assertBarrier(context);
  const current = '/opt/servora-med/current';
  const info = lstatSync(current);
  const resolved = realpathSync(current);
  const approved = [approval.oldReleaseSha,approval.releaseSha].map(sha => '/opt/servora-med/releases/'+sha);
  if (!info.isSymbolicLink() || info.uid !== 0 || !approved.includes(resolved)) throw new Error('RECOVERY_POINTER_UNTRUSTED');
  const target = direction === 'old' ? approved[0] : approved[1];
  for (const path of ['/opt','/opt/servora-med','/opt/servora-med/releases',target]) {
    const dir = lstatSync(path);
    if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== 0 || (dir.mode & 0o022)) throw new Error('RECOVERY_POINTER_UNTRUSTED');
  }
  if (resolved === target) return;
  const temporary = `/opt/servora-med/.r4-current-${randomUUID()}`;
  symlinkSync(target,temporary);
  try { renameSync(temporary,current); flushDirectory('/opt/servora-med'); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
  if (realpathSync(current) !== target) throw new Error('RECOVERY_POINTER_READBACK_FAILED');
}

export function grantStartPermit(attemptId) {
  const context = currentAttempt(attemptId);
  const record = context.checkpoint.record;
  if (!['START_INTENT','ABORT_INTENT'].includes(record.phase) || record.lastStart !== 'intent'
    || (record.phase === 'START_INTENT' ? record.starts < 1 : record.abortStarts < 1)) throw new Error('ATTEMPT_TRANSITION_INVALID');
  assertBarrier(context);
  if (!existsSync(PERMIT_DIRECTORY)) {
    mkdirSync(PERMIT_DIRECTORY,{mode:0o700}); flushDirectory('/run');
  }
  const dir = lstatSync(PERMIT_DIRECTORY);
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== 0 || dir.gid !== 0
    || (dir.mode & 0o7777) !== 0o700) throw new Error('RECOVERY_PERMIT_UNTRUSTED');
  const fd = openSync(PERMIT_FILE,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try {
    writeFileSync(fd,JSON.stringify({attemptId,approvalSha256:context.approvalSha256})+'\n'); fsyncSync(fd);
  } finally { closeSync(fd); }
  flushDirectory(PERMIT_DIRECTORY);
}

/** Revocation is safe after expiry: it cannot activate anything. */
export function revokeStartPermit(attemptId) {
  if (!existsSync(PERMIT_FILE)) return;
  const active = readProtectedRecord(`${STATE_ROOT}/active.json`).record;
  const permit = parseCanonicalRecord(trustedFile(PERMIT_FILE,0o600).toString('utf8'));
  if (Object.keys(active).length !== 2 || Object.keys(permit).length !== 2
    || active.attemptId !== attemptId || permit.attemptId !== attemptId
    || permit.approvalSha256 !== active.approvalSha256) throw new Error('RECOVERY_PERMIT_UNTRUSTED');
  unlinkSync(PERMIT_FILE); flushDirectory(PERMIT_DIRECTORY);
}

export function verifyAttemptCatalog(attemptId, direction) {
  const {approval} = loadAttempt(attemptId);
  if (!['old','target'].includes(direction)) throw new Error('RECOVERY_CONTROLLER_ARGUMENTS_INVALID');
  const sha = direction === 'old' ? approval.oldReleaseSha : approval.releaseSha;
  const expected = direction === 'old' ? approval.oldCatalog : approval.targetCatalog;
  const directory = `/opt/servora-med/releases/${sha}/server/dist/db/migrations`;
  // Same catalog contract as MigrationCatalog: only SQL files participate;
  // malformed SQL names, duplicate/gapped versions and branches fail closed.
  const files = readdirSync(directory).filter(file => file.endsWith('.sql')).sort();
  if (classifyMigrationState(expected.map(entry => entry.version),files.map(file => file.slice(0,-4))).status !== 'EXACT') {
    throw new Error('RECOVERY_CATALOG_MISMATCH');
  }
  const catalog = files.map(file => ({version:file.slice(0,-4),sha256:digest(trustedFile(directory+'/'+file,0o640,null))}));
  if (JSON.stringify(catalog) !== JSON.stringify(expected)) throw new Error('RECOVERY_CATALOG_MISMATCH');
}

/** Markers are created only by the reviewed staging path after archive byte
 * comparison. Every payload entry remains root-owned and non-writable by the
 * operator/service; retained archives are sealed by the root admission path.
 */
function verifiedReleaseEntries(root) {
  const entries = [];
    const walk = relative => {
      const path = root+'/'+relative;
      const info = lstatSync(path);
      if (info.uid !== 0 || (!info.isSymbolicLink() && (info.mode & 0o022))) throw new Error('RECOVERY_RELEASE_UNPROVEN');
      if (info.isSymbolicLink()) {
        if (!realpathSync(path).startsWith(root+'/')) throw new Error('RECOVERY_RELEASE_UNPROVEN');
        entries.push([relative,'l '+relative+' '+readlinkSync(path)]);
      } else if (info.isDirectory()) {
        if (relative !== '.') entries.push([relative,'d '+relative]);
        for (const name of readdirSync(path)) {
          if (relative === '.' && ['.servora-release-artifact.sha256','.servora-release-content.sha256'].includes(name)) continue;
          if (/[\r\n]/.test(name)) throw new Error('RECOVERY_RELEASE_UNPROVEN');
          walk(relative === '.' ? './'+name : relative+'/'+name);
        }
      } else if (info.isFile() && info.nlink === 1) entries.push([relative,'f '+relative+' '+digest(readFileSync(path))]);
      else throw new Error('RECOVERY_RELEASE_UNPROVEN');
    };
    walk('.');
    // The existing staging manifest sorts `find`'s TYPE + PATH, in C locale.
    entries.sort(([a,lineA],[b,lineB]) => Buffer.compare(Buffer.from(lineA[0]+' '+a),Buffer.from(lineB[0]+' '+b)));
    const manifest = entries.map(([,line]) => line).join('\n')+'\n';
    if (trustedFile(root+'/.servora-release-content.sha256',0o600).toString('utf8') !== manifest) {
      throw new Error('RECOVERY_RELEASE_UNPROVEN');
    }
  return entries;
}

function historicalReadBytes(path, mode, kind) {
  try { return trustedFile(path, mode); }
  catch (error) {
    const missing = error.code === 'ENOENT';
    if (kind === 'disposition') throw new Error(missing
      ? 'RECOVERY_HISTORICAL_DISPOSITION_MISSING' : 'RECOVERY_HISTORICAL_DISPOSITION_INVALID');
    if (kind === 'preservation') throw new Error(missing
      ? 'RECOVERY_HISTORICAL_PRESERVATION_REQUIRED' : 'RECOVERY_HISTORICAL_PRESERVATION_INVALID');
    throw new Error(missing ? 'RECOVERY_HISTORICAL_ARCHIVE_REQUIRED' : 'RECOVERY_HISTORICAL_ARCHIVE_INVALID');
  }
}

function historicalReadRecord(path, mode, kind) {
  const bytes = historicalReadBytes(path, mode, kind);
  let record;
  try { record = parseCanonicalRecord(bytes.toString('utf8')); }
  catch {
    if (kind === 'disposition') historicalDispositionFail();
    else if (kind === 'preservation') historicalPreservationFail();
    else historicalArchiveFail();
  }
  return {record, bytes, sha256: digest(bytes)};
}

function dispositionReadBytes(path, mode) {
  try { return trustedFile(path, mode); }
  catch (error) {
    throw new Error(error.code === 'ENOENT'
      ? 'RECOVERY_DISPOSITION_EVIDENCE_MISSING' : 'RECOVERY_DISPOSITION_EVIDENCE_INVALID');
  }
}

function dispositionReadRecord(path, mode) {
  const bytes = dispositionReadBytes(path, mode);
  try { return {record:parseCanonicalRecord(bytes.toString('utf8')), bytes, sha256:digest(bytes)}; }
  catch { throw new Error('RECOVERY_DISPOSITION_EVIDENCE_INVALID'); }
}

function historicalDirectory(path, fail) {
  let info;
  try { info = lstatSync(path); } catch { fail(); }
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0
    || (info.mode & 0o7777) !== 0o700) fail();
}

function historicalCheckpointNames() {
  return Array.from({length:OPS_R4_003_POLICY.checkpointCount},(_,index)=>
    String(index).padStart(4,'0')+'.json');
}

function historicalReadCheckpointChain(root, kind) {
  const read = kind === 'disposition' ? dispositionReadRecord : historicalReadRecord;
  const fail = kind === 'disposition' ? historicalDispositionFail
    : kind === 'preservation' ? historicalPreservationFail : historicalArchiveFail;
  const directory = root+'/attempts/'+OPS_R4_003_POLICY.attemptId;
  historicalDirectory(directory,fail);
  let names;
  try { names = readdirSync(directory).sort(); } catch { fail(); }
  if (JSON.stringify(names) !== JSON.stringify(historicalCheckpointNames())) fail();
  return names.map(name => read(directory+'/'+name,0o600,kind));
}

function validateHistoricalCheckpointChain(checkpoints, disposition, fail = historicalArchiveFail) {
  const policy = OPS_R4_003_POLICY;
  if (!Array.isArray(checkpoints) || checkpoints.length !== policy.checkpointCount) fail();
  let previousHash = null;
  for (let index = 0; index < checkpoints.length; index += 1) {
    const {record,sha256} = checkpoints[index];
    if (!record || record.formatVersion !== 2 || record.attemptId !== policy.attemptId
      || record.sequence !== index || record.previousHash !== previousHash
      || record.approvalSha256 !== disposition.approvalSha256
      || record.profileSha256 !== disposition.profileSha256) fail();
    previousHash = sha256;
  }
  const initial = checkpoints[0], last = checkpoints.at(-1);
  if (initial.sha256 !== disposition.initialCheckpointSha256
    || last.sha256 !== disposition.lastCheckpointSha256
    || last.record.phase !== policy.lastPhase
    || last.record.observationPassed !== false || last.record.smokePassed !== true
    || last.record.starts !== policy.starts || last.record.abortStarts !== policy.abortStarts) fail();
  return {initial,last};
}

function validateHistoricalAdmissionProof(proof, approvalSha256, initialSha256,
  fail = historicalArchiveFail) {
  if (!historicalExact(proof,['formatVersion','attemptId','approvalSha256','initialSha256','postFsyncTime'])
    || proof.formatVersion !== 2 || proof.attemptId !== OPS_R4_003_POLICY.attemptId
    || proof.approvalSha256 !== approvalSha256 || proof.initialSha256 !== initialSha256) fail();
  try { validateCurrentTimeEvidence(proof.postFsyncTime); } catch { fail(); }
  return proof;
}

function validateHistoricalEmergencyReceipt(receipt, fail = historicalArchiveFail) {
  const policy = OPS_R4_003_POLICY;
  if (!receipt || receipt.kind !== 'EMERGENCY_HANDOFF_RECEIPT' || !receipt.parent
    || receipt.parent.attemptId !== policy.attemptId || receipt.parent.phase !== policy.lastPhase
    || receipt.parentAttemptCompleted !== false || receipt.r4Acceptance !== policy.r4Acceptance
    || receipt.r4TerminalState !== policy.r4TerminalState
    || receipt.operationalStatus !== policy.operationalStatus
    || receipt.observationPassed !== false || !receipt.host
    || receipt.host.releaseSha !== policy.targetReleaseSha) fail();
  return receipt;
}

function validateHistoricalOldEvidence(oldAdoption, oldBaseline, approvalSha256, profileSha256,
  oldBaselineManifestSha256, fail = historicalArchiveFail) {
  const policy = OPS_R4_003_POLICY;
  if (!oldAdoption || oldAdoption.kind !== 'ADOPTED_INSTALLED_OLD_FIRST_CUTOVER'
    || oldAdoption.attemptId !== policy.attemptId
    || oldAdoption.approvalSha256 !== approvalSha256 || oldAdoption.profileSha256 !== profileSha256
    || oldAdoption.oldReleaseSha !== policy.oldReleaseSha
    || oldAdoption.originalArtifactSha256 !== policy.oldArtifactSha256
    || oldAdoption.targetReleaseSha !== policy.targetReleaseSha
    || oldAdoption.targetTreeSha !== policy.targetTreeSha
    || oldAdoption.targetArtifactSha256 !== policy.targetArtifactSha256
    || oldAdoption.baselineId !== policy.oldBaselineId
    || oldAdoption.baselineManifestSha256 !== oldBaselineManifestSha256) fail();
  if (!oldBaseline || oldBaseline.kind !== 'RECOVERY_BASELINE_NOT_ORIGINAL_ARTIFACT'
    || oldBaseline.baselineId !== policy.oldBaselineId
    || oldBaseline.sourceReleaseSha !== policy.oldReleaseSha
    || oldBaseline.originalArtifactSha256 !== policy.oldArtifactSha256
    || oldBaseline.restoreAcceptance !== false
    || oldAdoption.oldCatalogSha256 !== jsonDigest(oldBaseline.catalog)
    || oldAdoption.oldContentManifestSha256 !== oldBaseline.files?.['installed-old-content.sha256']?.sha256
    || oldAdoption.adoptedArchiveSha256 !== oldBaseline.files?.['installed-old-release.adopted.tar.gz']?.sha256
    || oldAdoption.databaseDumpSha256 !== oldBaseline.files?.['database.dump']?.sha256) fail();
}

/** Rehash every OPS-R4-001 baseline payload; the old baseline stays in place. */
function validateHistoricalOldBaselinePayloads(baseline, fail = historicalArchiveFail) {
  const files = baseline?.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) fail();
  for (const [name,entry] of Object.entries(files)) {
    if (!/^[a-z0-9][a-z0-9.-]{0,99}$/.test(name) || !entry || entry.name !== name
      || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0
      || !HISTORICAL_HEX.test(entry.sha256)) fail();
    let bytes;
    try { bytes = trustedFile(HISTORICAL_OLD_BASELINE_DIR+'/'+name,0o600); } catch { fail(); }
    if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256) fail();
  }
  return baseline;
}

function validateHistoricalPostdeploy(logBytes, rcBytes, fail = historicalArchiveFail) {
  const text = logBytes.toString('utf8');
  if (!text.includes('RECOVERY_BACKUP_HEALTH_FAILED')
    || !text.includes('PRODUCTION_DEPLOYMENT_FAILED')
    || !rcBytes.equals(Buffer.from('1\n'))) fail();
}

function assertHistoricalSourceState() {
  const fail = () => { throw new Error('RECOVERY_DISPOSITION_SOURCE_STATE_INVALID'); };
  const exact = (path,names) => {
    historicalDirectory(path,fail);
    let entries;
    try { entries = readdirSync(path).sort(); } catch { fail(); }
    if (JSON.stringify(entries) !== JSON.stringify([...names].sort())) fail();
  };
  exact(STATE_ROOT+'/attempts',[OPS_R4_003_POLICY.attemptId]);
  exact(STATE_ROOT+'/attempts/'+OPS_R4_003_POLICY.attemptId,historicalCheckpointNames());
  exact(STATE_ROOT+'/initializations',[]);
  exact(STATE_ROOT+'/admission-proofs',[OPS_R4_003_POLICY.attemptId+'.json']);
  exact(STATE_ROOT+'/backups',[OPS_R4_003_POLICY.attemptId+'-pre.dump',
    OPS_R4_003_POLICY.attemptId+'-post.dump']);
  exact(STATE_ROOT+'/logs',[OPS_R4_003_POLICY.attemptId]);
  exact(STATE_ROOT+'/logs/'+OPS_R4_003_POLICY.attemptId,HISTORICAL_LOG_NAMES);
}

function assertHistoricalSourceEmpty() {
  for (const name of HISTORICAL_SOURCE_DIRECTORIES) {
    const path = STATE_ROOT+'/'+name;
    historicalDirectory(path,historicalArchiveFail);
    let entries;
    try { entries = readdirSync(path); } catch { historicalArchiveFail(); }
    if (entries.length) historicalArchiveFail();
  }
  for (const path of [STATE_ROOT+'/active.json',STATE_ROOT+'/activation.block',PERMIT_FILE,
    '/etc/systemd/system/servora-med.service.d/90-servora-recovery.conf']) {
    if (existsSync(path)) historicalArchiveFail();
  }
}

function historicalPreservedKey(entry) {
  return [entry.path,entry.role,String(entry.liveSource),entry.sourcePath ?? ''].join('|');
}

function verifyHistoricalArchiveRecords({disposition,dispositionBytes,dispositionSha256,manifest,
  manifestSha256,proof,proofSha256,complete,completeSha256,checkpointSummary,archiveBytes,liveBytes,
  copyBytes,archiveMtimes,currentTime}) {
  const fail = historicalArchiveFail;
  const policy = OPS_R4_003_POLICY;
  if (!historicalExact(manifest,HISTORICAL_MANIFEST_KEYS) || manifest.formatVersion !== 1
    || manifest.kind !== 'HISTORICAL_RECOVERY_ARCHIVE_MANIFEST'
    || manifest.attemptId !== policy.attemptId || manifest.dispositionSha256 !== dispositionSha256
    || manifest.approvalSha256 !== disposition.approvalSha256
    || manifest.profileSha256 !== disposition.profileSha256
    || manifest.machineId !== disposition.machineId
    || manifest.oldReleaseSha !== policy.oldReleaseSha
    || manifest.targetReleaseSha !== policy.targetReleaseSha
    || manifest.targetTreeSha !== policy.targetTreeSha
    || manifest.targetArtifactSha256 !== policy.targetArtifactSha256
    || !historicalUtc(manifest.createdAtUTC)
    || Date.parse(manifest.createdAtUTC) < Date.parse(disposition.issuedAtUTC)) fail();

  if (!Array.isArray(manifest.archivedFiles)
    || manifest.archivedFiles.length !== HISTORICAL_ARCHIVED_PATHS.length) fail();
  const expectedPaths = new Set(HISTORICAL_ARCHIVED_PATHS);
  const seenPaths = new Set();
  for (const entry of manifest.archivedFiles) {
    if (!historicalExact(entry,HISTORICAL_ARCHIVE_ENTRY_KEYS)
      || !expectedPaths.has(entry.archivePath) || seenPaths.has(entry.archivePath)
      || entry.sourcePath !== STATE_ROOT+'/'+entry.archivePath
      || entry.type !== 'file' || entry.mode !== '0600'
      || entry.sourceMode !== historicalSourceMode(entry.archivePath)
      || !historicalMtimeNs(entry.sourceMtimeNs)
      || entry.sourceMtimeNs !== archiveMtimes.get(entry.archivePath)
      || entry.uid !== 0 || entry.gid !== 0 || entry.nlink !== 1
      || !Number.isSafeInteger(entry.size) || entry.size <= 0
      || !HISTORICAL_HEX.test(entry.sha256) || entry.symlinkTarget !== null) fail();
    const bytes = archiveBytes.get(entry.archivePath);
    if (!bytes || bytes.length !== entry.size || digest(bytes) !== entry.sha256) fail();
    seenPaths.add(entry.archivePath);
  }
  if (seenPaths.size !== expectedPaths.size) fail();

  if (!Array.isArray(manifest.preservedEvidence)
    || manifest.preservedEvidence.length !== HISTORICAL_PRESERVED_EVIDENCE.length) fail();
  const expectedPreserved = new Set(HISTORICAL_PRESERVED_EVIDENCE.map(historicalPreservedKey));
  const seenPreserved = new Set();
  for (const entry of manifest.preservedEvidence) {
    const keys = entry && Object.hasOwn(entry,'sourcePath')
      ? [...HISTORICAL_PRESERVED_KEYS,'sourcePath'] : HISTORICAL_PRESERVED_KEYS;
    if (!historicalExact(entry,keys) || !expectedPreserved.has(historicalPreservedKey(entry))
      || seenPreserved.has(historicalPreservedKey(entry))
      || typeof entry.liveSource !== 'boolean' || !HISTORICAL_HEX.test(entry.sha256)
      || !Number.isSafeInteger(entry.size) || entry.size <= 0) fail();
    const bytes = entry.path.startsWith('preserved/') ? copyBytes.get(entry.path) : liveBytes.get(entry.path);
    if (!bytes || bytes.length !== entry.size || digest(bytes) !== entry.sha256) fail();
    if (entry.role === 'old-profile-copy'
      && (entry.liveSource !== false || entry.sha256 !== disposition.profileSha256)) fail();
    if (entry.role === 'disposition-copy'
      && (entry.liveSource !== true || entry.sourcePath !== policy.dispositionFile
        || !bytes.equals(dispositionBytes))) fail();
    seenPreserved.add(historicalPreservedKey(entry));
  }
  if (seenPreserved.size !== expectedPreserved.size) fail();

  if (!manifest.sourceDirectories || typeof manifest.sourceDirectories !== 'object'
    || Array.isArray(manifest.sourceDirectories)
    || Object.keys(manifest.sourceDirectories).length !== HISTORICAL_SOURCE_DIRECTORIES.length) fail();
  for (const name of HISTORICAL_SOURCE_DIRECTORIES) {
    const entry = manifest.sourceDirectories[STATE_ROOT+'/'+name];
    if (!historicalExact(entry,HISTORICAL_DIRECTORY_KEYS) || !Number.isSafeInteger(entry.beforeEntries)
      || entry.beforeEntries < 0 || entry.afterEntries !== 0
      || !historicalMtimeNs(entry.sourceMtimeNs)) fail();
  }
  if (!manifest.removedDirectories || typeof manifest.removedDirectories !== 'object'
    || Array.isArray(manifest.removedDirectories)
    || Object.keys(manifest.removedDirectories).length !== HISTORICAL_REMOVED_DIRECTORIES.length) fail();
  for (const name of HISTORICAL_REMOVED_DIRECTORIES) {
    const entry = manifest.removedDirectories[STATE_ROOT+'/'+name];
    if (!historicalExact(entry,HISTORICAL_REMOVED_DIRECTORY_KEYS)
      || entry.mode !== '0700' || entry.uid !== 0 || entry.gid !== 0
      || !historicalMtimeNs(entry.sourceMtimeNs)) fail();
  }
  if (!historicalExact(manifest.checkpoint,HISTORICAL_CHECKPOINT_KEYS)
    || manifest.checkpoint.count !== policy.checkpointCount
    || manifest.checkpoint.lastSequence !== policy.lastSequence
    || manifest.checkpoint.lastSha256 !== disposition.lastCheckpointSha256
    || manifest.checkpoint.lastPhase !== policy.lastPhase
    || manifest.checkpoint.observationPassed !== false
    || manifest.checkpoint.smokePassed !== true
    || manifest.checkpoint.starts !== policy.starts
    || manifest.checkpoint.abortStarts !== policy.abortStarts) fail();

  if (!historicalExact(proof,HISTORICAL_PROOF_KEYS) || proof.formatVersion !== 1
    || proof.kind !== 'HISTORICAL_RECOVERY_SOURCE_EMPTY_PROOF'
    || proof.attemptId !== policy.attemptId || proof.dispositionSha256 !== dispositionSha256
    || proof.manifestSha256 !== manifestSha256 || !historicalUtc(proof.verifiedAtUTC)
    || Date.parse(proof.verifiedAtUTC) < Date.parse(manifest.createdAtUTC)
    || !historicalExact(proof.pendingMarkers,HISTORICAL_PENDING_KEYS)
    || HISTORICAL_PENDING_KEYS.some(key => proof.pendingMarkers[key] !== false)) fail();
  if (!proof.directories || typeof proof.directories !== 'object'
    || Object.keys(proof.directories).length !== HISTORICAL_SOURCE_DIRECTORIES.length) fail();
  for (const name of HISTORICAL_SOURCE_DIRECTORIES) {
    const entry = proof.directories[STATE_ROOT+'/'+name];
    if (!historicalExact(entry,HISTORICAL_PROOF_DIRECTORY_KEYS) || entry.exists !== true
      || entry.type !== 'directory' || entry.symlink !== false || entry.uid !== 0 || entry.gid !== 0
      || entry.mode !== '0700' || entry.entries !== 0) fail();
  }

  if (!historicalExact(complete,HISTORICAL_COMPLETE_KEYS) || complete.formatVersion !== 1
    || complete.kind !== 'HISTORICAL_RECOVERY_ARCHIVE_COMPLETE'
    || complete.attemptId !== policy.attemptId || complete.dispositionSha256 !== dispositionSha256
    || complete.manifestSha256 !== manifestSha256
    || complete.sourceEmptyProofSha256 !== proofSha256 || complete.archiveId !== policy.attemptId
    || complete.complete !== true || complete.checkpointCount !== policy.checkpointCount
    || complete.lastCheckpointSha256 !== disposition.lastCheckpointSha256
    || complete.lastPhase !== policy.lastPhase || complete.observationPassed !== false
    || complete.terminal !== false || complete.starts !== policy.starts
    || !historicalUtc(complete.completedAtUTC)
    || Date.parse(complete.completedAtUTC) < Date.parse(proof.verifiedAtUTC)
    || Date.parse(complete.completedAtUTC) > Date.parse(currentTime.wallAtUTC)) fail();
  if (!checkpointSummary || checkpointSummary.last.sha256 !== disposition.lastCheckpointSha256) fail();
  return {attemptId:policy.attemptId,complete:true,terminal:false,dispositionSha256,manifestSha256,
    sourceEmptyProofSha256:proofSha256,completeSha256};
}

function walkHistoricalArchive() {
  const expectedFiles = new Set([
    ...HISTORICAL_ARCHIVED_PATHS,
    ...HISTORICAL_PRESERVED_EVIDENCE.filter(entry=>entry.path.startsWith('preserved/')).map(entry=>entry.path),
    ...HISTORICAL_ARCHIVE_METADATA_PATHS
  ]);
  const expectedDirs = new Set(['.','attempts','attempts/'+OPS_R4_003_POLICY.attemptId,
    'admission-proofs','backups','logs','logs/'+OPS_R4_003_POLICY.attemptId,'preserved']);
  const files = new Set(), directories = new Set(), archiveMtimes = new Map();
  const visit = (path,relative) => {
    let info, names;
    try { info = lstatSync(path); names = readdirSync(path); } catch { historicalArchiveFail(); }
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0
      || (info.mode & 0o7777) !== 0o700) historicalArchiveFail();
    directories.add(relative || '.');
    for (const name of names) {
      const full = path+'/'+name, childRelative = relative ? relative+'/'+name : name;
      let child;
      try { child = lstatSync(full); } catch { historicalArchiveFail(); }
      if (child.isSymbolicLink()) historicalArchiveFail();
      if (child.isDirectory()) visit(full,childRelative);
      else if (child.isFile()) {
        if (child.uid !== 0 || child.gid !== 0 || child.nlink !== 1
          || (child.mode & 0o7777) !== 0o600) historicalArchiveFail();
        // Capture the copied file's actual nanosecond timestamp, not just a
        // purported source timestamp supplied by its manifest.
        const measured = lstatSync(full,{bigint:true}).mtimeNs;
        if (typeof measured !== 'bigint') historicalArchiveFail();
        archiveMtimes.set(childRelative,measured.toString());
        files.add(childRelative);
      } else historicalArchiveFail();
    }
  };
  visit(HISTORICAL_ARCHIVE_DIR,'');
  if (files.size !== expectedFiles.size || [...files].some(path=>!expectedFiles.has(path))
    || directories.size !== expectedDirs.size || [...directories].some(path=>!expectedDirs.has(path))) {
    historicalArchiveFail();
  }
  return archiveMtimes;
}

/**
 * OPS-R4-002 non-destructive acceptance branch.
 *
 * The exact 26-file historical attempt stays at its live paths. The OPS-R4-005
 * staged replica (created after the disposition and before the profile re-seal)
 * is the immutable record of the bytes: its receipt binds the full source
 * inventory digest, every staged hash/size/nanosecond mtime, the old profile
 * copy and the disposition copy. This function re-reads the live evidence and
 * proves it is byte-identical to that record.
 *
 * It never removes, renames or moves a source; never writes ARCHIVE-MANIFEST,
 * SOURCE-EMPTY-PROOF or ARCHIVE-COMPLETE; and never claims independent
 * retention or disaster-recovery coverage.
 */
export function verifyHistoricalInPlacePreservation() {
  const policy = OPS_R4_003_POLICY;
  const fail = historicalPreservationFail;
  if (!existsSync(HISTORICAL_STAGING_RECEIPT)) {
    throw new Error('RECOVERY_HISTORICAL_PRESERVATION_REQUIRED');
  }
  // Verify the exact installed bytes before calling any function from the
  // shared module; a stale or foreign module must not influence acceptance.
  verifyHistoricalEvidenceTool();
  const staged = readHistoricalStageReceipt({
    receiptPath: HISTORICAL_STAGING_RECEIPT, uid: 0, gid: 0
  });
  verifyHistoricalStageReadback({
    stageRoot: HISTORICAL_STAGING_DIR, receiptPath: HISTORICAL_STAGING_RECEIPT,
    uid: 0, gid: 0, receipt: staged.receipt
  });
  // The live disposition is the only authority for this attempt; the staged
  // copies must be the same bytes that were sealed before the profile re-seal.
  const disposition = historicalReadRecord(policy.dispositionFile, 0o600, 'disposition');
  if (staged.receipt.dispositionSha256 !== disposition.sha256) fail();
  const dispositionCopy = historicalReadBytes(HISTORICAL_STAGING_DIR+
    '/preserved/disposition.json', 0o600, 'preservation');
  if (!dispositionCopy.equals(disposition.bytes)) fail();
  const profileCopy = historicalReadBytes(HISTORICAL_STAGING_DIR+'/preserved/profile.json',
    0o600, 'preservation');
  const profileSha256 = digest(profileCopy);
  if (profileSha256 !== disposition.record.profileSha256
    || staged.receipt.profileSha256 !== profileSha256) fail();
  let oldProfile;
  try { oldProfile = parseCanonicalRecord(profileCopy.toString('utf8')); }
  catch { fail(); }

  const approval = historicalReadRecord(policy.oldApprovalFile, 0o600, 'preservation');
  // The live profile is the separately re-sealed record. Only its machine
  // identity is shared with the preserved pre-re-seal copy; the old profile
  // bytes are never substituted from the live path.
  const currentProfile = historicalReadRecord(STATE_ROOT+'/profile.json', 0o600, 'preservation');
  const checkpoints = historicalReadCheckpointChain(STATE_ROOT, 'preservation');
  validateHistoricalCheckpointChain(checkpoints, disposition.record, historicalPreservationFail);
  const admission = historicalReadRecord(STATE_ROOT+'/admission-proofs/'+
    policy.attemptId+'.json', 0o600, 'preservation');
  validateHistoricalAdmissionProof(admission.record, disposition.record.approvalSha256,
    checkpoints[0].sha256, historicalPreservationFail);
  const pre = historicalReadBytes(STATE_ROOT+'/backups/'+policy.attemptId+'-pre.dump',
    0o600, 'preservation');
  const post = historicalReadBytes(STATE_ROOT+'/backups/'+policy.attemptId+'-post.dump',
    0o600, 'preservation');
  const log = historicalReadBytes(policy.postdeployLogFile, 0o644, 'preservation');
  const rc = historicalReadBytes(policy.postdeployRcFile, 0o644, 'preservation');
  validateHistoricalPostdeploy(log, rc, historicalPreservationFail);
  const oldAdoption = historicalReadRecord(policy.oldAdoptionFile, 0o600, 'preservation');
  const oldBaseline = historicalReadRecord(policy.oldBaselineManifestFile, 0o600, 'preservation');
  validateHistoricalOldBaselinePayloads(oldBaseline.record, historicalPreservationFail);
  const oldSums = historicalReadBytes(policy.oldBaselineSha256SumsFile, 0o600, 'preservation');
  const emergencyReceipt = historicalReadRecord(policy.emergencyReceiptFile, 0o600, 'preservation');
  const currentTime = sampleTrustedTime();
  const context = {approval:approval.record,approvalSha256:approval.sha256,
    profile:oldProfile,profileSha256,machineId:currentProfile.record.machineId,
    initialCheckpoint:checkpoints[0],lastCheckpoint:checkpoints.at(-1),
    admissionProof:admission.record,admissionProofSha256:admission.sha256,
    emergencyReceipt:emergencyReceipt.record,emergencyReceiptSha256:emergencyReceipt.sha256,
    postdeployLogSha256:digest(log),postdeployRcSha256:digest(rc),
    oldAdoption:oldAdoption.record,oldAdoptionSha256:oldAdoption.sha256,
    oldBaselineManifest:oldBaseline.record,oldBaselineManifestSha256:oldBaseline.sha256,
    oldBaselineSha256SumsSha256:digest(oldSums),currentTime};
  validateHistoricalRecoveryDisposition(disposition.record, context, historicalPreservationFail);
  validateHistoricalEmergencyReceipt(emergencyReceipt.record, historicalPreservationFail);
  validateHistoricalOldEvidence(oldAdoption.record, oldBaseline.record,
    disposition.record.approvalSha256, profileSha256, oldBaseline.sha256,
    historicalPreservationFail);
  const preReceipt = checkpoints[1].record.predeployBackup;
  const postReceipt = checkpoints.at(-1).record.postdeployBackup;
  if (!preReceipt || preReceipt.sha256 !== digest(pre)
    || !postReceipt || postReceipt.sha256 !== digest(post)) fail();

  // Exact live allowlist: any missing, extra, modified, linked, foreign-owned
  // or re-timestamped entry changes the inventory digest and fails closed.
  let inventory;
  try { inventory = captureHistoricalSourceInventory(); }
  catch { fail(); }
  if (digest(Buffer.from(JSON.stringify(inventory)+'\n')) !== staged.receipt.sourceInventorySha256) {
    fail();
  }
  const live = new Map(inventory.files.map(entry => [entry.archivePath, entry]));
  if (live.size !== HISTORICAL_ARCHIVED_PATHS.length
    || staged.receipt.files.length !== HISTORICAL_ARCHIVED_PATHS.length+2) fail();
  for (const entry of staged.receipt.files) {
    if (entry.archivePath.startsWith('preserved/')) continue;
    const source = live.get(entry.archivePath);
    if (!source || source.sha256 !== entry.sha256 || source.size !== entry.size
      || source.mtimeNs !== entry.mtimeNs) fail();
  }
  return Object.freeze({attemptId:policy.attemptId,status:'IN_PLACE_PRESERVATION_VERIFIED',
    authority:'SOURCE_RETAINED_NOT_ARCHIVED_NOT_INDEPENDENTLY_RETAINED',
    archived:false,sourceRetained:true,terminal:false,
    r4Acceptance:disposition.record.r4Acceptance,filesVerified:HISTORICAL_ARCHIVED_PATHS.length,
    dispositionSha256:disposition.sha256,receiptSha256:staged.sha256});
}

/** Installed-byte pin for the shared evidence module. The administrator wrappers
 * check owner/mode/link; this check adds the exact version binding. A missing,
 * foreign or stale module must never change the acceptance gate. */
function verifyHistoricalEvidenceTool() {
  let bytes;
  try { bytes = trustedFile(HISTORICAL_EVIDENCE_TOOL,0o644); }
  catch { throw new Error('RECOVERY_HISTORICAL_EVIDENCE_UNTRUSTED'); }
  if (digest(bytes) !== HISTORICAL_EVIDENCE_TOOL_SHA256) {
    throw new Error('RECOVERY_HISTORICAL_EVIDENCE_UNTRUSTED');
  }
}

/** Fail-closed sealed-archive presence.
 *
 * Only a positively absent archive root and attempt directory mean "no archive
 * was started". A dangling symlink, a plain file, a symlinked directory, an
 * unreadable parent or a wrong-owner/mode archive root is never treated as
 * absent, so the in-place branch can never mask a started or hostile archive.
 */
function historicalArchivePresence() {
  const fail = historicalArchiveFail;
  let root;
  try { root = lstatSync(HISTORICAL_ARCHIVE_ROOT); }
  catch (error) {
    if (error.code === 'ENOENT') return 'absent';
    fail();
  }
  // A present archive root that is not a plain root-owned, non-writable-by-
  // others directory is a hostile or broken layout, never "absent".
  if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== 0 || root.gid !== 0
    || (root.mode & 0o022) !== 0) fail();
  try { lstatSync(HISTORICAL_ARCHIVE_DIR); return 'present'; }
  catch (error) {
    if (error.code === 'ENOENT') return 'absent';
    fail();
  }
}

/** OPS-R4-002 policy-owned historical prerequisite. A sealed OPS-R4-003 archive
 * is still accepted exactly as before; otherwise the exact attempt must remain
 * provably preserved in place. A started, partial or unreadable archive never
 * falls back to the in-place branch.
 */
export function verifyHistoricalPreservationGate() {
  if (historicalArchivePresence() === 'present') return verifyHistoricalArchiveGate();
  return verifyHistoricalInPlacePreservation();
}

/** Read-only OPS-R4-002 precondition. No caller-selected path or mode. */
export function verifyHistoricalArchiveGate() {
  const policy = OPS_R4_003_POLICY;
  const disposition = historicalReadRecord(policy.dispositionFile,0o600,'disposition');
  const approval = historicalReadRecord(policy.oldApprovalFile,0o600,'archive');
  const currentProfile = historicalReadRecord(STATE_ROOT+'/profile.json',0o600,'archive');
  const profileCopy = historicalReadRecord(policy.archiveDir+'/preserved/profile.json',0o600,'archive');
  // Read archived bytes independently; substitution of live disposition bytes
  // would incorrectly accept corruption of preserved/disposition.json.
  const dispositionCopy = historicalReadBytes(policy.archiveDir+'/preserved/disposition.json',0o600,'archive');
  const checkpoints = historicalReadCheckpointChain(policy.archiveDir,'archive');
  validateHistoricalCheckpointChain(checkpoints,disposition.record);
  const admission = historicalReadRecord(policy.archiveDir+'/admission-proofs/'+
    policy.attemptId+'.json',0o600,'archive');
  validateHistoricalAdmissionProof(admission.record,disposition.record.approvalSha256,
    checkpoints[0].sha256);
  const pre = historicalReadBytes(policy.archiveDir+'/backups/'+policy.attemptId+'-pre.dump',0o600,'archive');
  const post = historicalReadBytes(policy.archiveDir+'/backups/'+policy.attemptId+'-post.dump',0o600,'archive');
  const log = historicalReadBytes(policy.archiveDir+'/logs/'+policy.attemptId+
    '/postdeploy-operator-20261101T040551Z.log',0o600,'archive');
  const rc = historicalReadBytes(policy.archiveDir+'/logs/'+policy.attemptId+
    '/postdeploy-operator-20261101T040551Z.rc',0o600,'archive');
  validateHistoricalPostdeploy(log,rc);
  const oldAdoption = historicalReadRecord(policy.oldAdoptionFile,0o600,'archive');
  const oldBaseline = historicalReadRecord(policy.oldBaselineManifestFile,0o600,'archive');
  validateHistoricalOldBaselinePayloads(oldBaseline.record);
  const oldSums = historicalReadBytes(policy.oldBaselineSha256SumsFile,0o600,'archive');
  const receipt = historicalReadRecord(policy.emergencyReceiptFile,0o600,'archive');
  const currentTime = sampleTrustedTime();
  const context = {approval:approval.record,approvalSha256:approval.sha256,
    profile:profileCopy.record,profileSha256:profileCopy.sha256,
    machineId:currentProfile.record.machineId,initialCheckpoint:checkpoints[0],
    lastCheckpoint:checkpoints.at(-1),admissionProof:admission.record,
    admissionProofSha256:admission.sha256,emergencyReceipt:receipt.record,
    emergencyReceiptSha256:receipt.sha256,postdeployLogSha256:digest(log),
    postdeployRcSha256:digest(rc),oldAdoption:oldAdoption.record,
    oldAdoptionSha256:oldAdoption.sha256,oldBaselineManifest:oldBaseline.record,
    oldBaselineManifestSha256:oldBaseline.sha256,
    oldBaselineSha256SumsSha256:digest(oldSums),currentTime};
  validateHistoricalRecoveryDisposition(disposition.record,context);
  validateHistoricalEmergencyReceipt(receipt.record);
  validateHistoricalOldEvidence(oldAdoption.record,oldBaseline.record,
    disposition.record.approvalSha256,profileCopy.sha256,oldBaseline.sha256);
  const preReceipt = checkpoints[1].record.predeployBackup;
  const postReceipt = checkpoints.at(-1).record.postdeployBackup;
  if (!preReceipt || preReceipt.sha256 !== digest(pre)
    || !postReceipt || postReceipt.sha256 !== digest(post)) historicalArchiveFail();
  assertHistoricalSourceEmpty();
  const manifest = historicalReadRecord(policy.archiveManifestFile,0o600,'archive');
  const proof = historicalReadRecord(policy.sourceEmptyProofFile,0o600,'archive');
  const complete = historicalReadRecord(policy.archiveCompleteFile,0o600,'archive');
  const archiveBytes = new Map();
  for (let index = 0; index < checkpoints.length; index += 1) {
    archiveBytes.set('attempts/'+policy.attemptId+'/'+String(index).padStart(4,'0')+'.json',
      checkpoints[index].bytes);
  }
  archiveBytes.set('admission-proofs/'+policy.attemptId+'.json',admission.bytes);
  archiveBytes.set('backups/'+policy.attemptId+'-pre.dump',pre);
  archiveBytes.set('backups/'+policy.attemptId+'-post.dump',post);
  archiveBytes.set('logs/'+policy.attemptId+'/postdeploy-operator-20261101T040551Z.log',log);
  archiveBytes.set('logs/'+policy.attemptId+'/postdeploy-operator-20261101T040551Z.rc',rc);
  for (const name of HISTORICAL_LOG_NAMES.filter(name=>!name.startsWith('postdeploy-operator'))) {
    archiveBytes.set('logs/'+policy.attemptId+'/'+name,
      historicalReadBytes(policy.archiveDir+'/logs/'+policy.attemptId+'/'+name,0o600,'archive'));
  }
  const liveBytes = new Map([[policy.oldAdoptionFile,oldAdoption.bytes],
    [policy.oldApprovalFile,approval.bytes],[policy.oldBaselineManifestFile,oldBaseline.bytes],
    [policy.oldBaselineSha256SumsFile,oldSums],[policy.emergencyReceiptFile,receipt.bytes]]);
  const copyBytes = new Map([['preserved/profile.json',profileCopy.bytes],
    ['preserved/disposition.json',dispositionCopy]]);
  const archiveMtimes = walkHistoricalArchive();
  const result = verifyHistoricalArchiveRecords({disposition:disposition.record,
    dispositionBytes:disposition.bytes,dispositionSha256:disposition.sha256,manifest:manifest.record,
    manifestSha256:manifest.sha256,proof:proof.record,proofSha256:proof.sha256,
    complete:complete.record,completeSha256:complete.sha256,
    checkpointSummary:{last:checkpoints.at(-1)},archiveBytes,liveBytes,copyBytes,archiveMtimes,currentTime});
  return result;
}

/** Root-only one-time historical disposition. Deliberately absent from deploy. */
export function issueHistoricalRecoveryDisposition() {
  const policy = OPS_R4_003_POLICY;
  if (process.getuid?.() !== 0) throw new Error('RECOVERY_DISPOSITION_ADMIN_REQUIRED');
  try {
    trustedFile(STATE_ROOT+'/host.lock',0o600);
    const held = fstatSync(9), named = lstatSync(STATE_ROOT+'/host.lock');
    if (!held.isFile() || held.dev !== named.dev || held.ino !== named.ino) throw new Error();
    execFileSync('/usr/bin/flock',['--nonblock','9'],{timeout:2000,
      env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'},stdio:['ignore','pipe','pipe',...Array(6).fill('ignore'),9]});
    const after = lstatSync(STATE_ROOT+'/host.lock');
    if (held.dev !== after.dev || held.ino !== after.ino) throw new Error();
  } catch { throw new Error('RECOVERY_DISPOSITION_HOST_LOCK_REQUIRED'); }
  for (const path of [STATE_ROOT+'/active.json',STATE_ROOT+'/activation.block',PERMIT_FILE,
    '/etc/systemd/system/servora-med.service.d/90-servora-recovery.conf']) {
    if (existsSync(path)) throw new Error('RECOVERY_DISPOSITION_STATE_NOT_EMPTY');
  }
  if (existsSync(policy.dispositionFile)) throw new Error('RECOVERY_DISPOSITION_ALREADY_SEALED');
  if (existsSync(policy.archiveDir)) throw new Error('RECOVERY_DISPOSITION_ARCHIVE_ALREADY_PRESENT');
  assertHistoricalSourceState();
  const approval = dispositionReadRecord(policy.oldApprovalFile,0o600);
  try { validateApprovalStructure(approval.record); }
  catch { throw new Error('RECOVERY_DISPOSITION_EVIDENCE_INVALID'); }
  const profile = dispositionReadRecord(STATE_ROOT+'/profile.json',0o600);
  if (profile.sha256 !== approval.record.profileSha256
    || profile.record.machineId !== readFileSync('/etc/machine-id','utf8').trim()) {
    throw new Error('RECOVERY_DISPOSITION_EVIDENCE_INVALID');
  }
  const checkpoints = historicalReadCheckpointChain(STATE_ROOT,'disposition');
  const dispositionStub = {approvalSha256:approval.sha256,profileSha256:approval.record.profileSha256,
    initialCheckpointSha256:checkpoints[0].sha256,lastCheckpointSha256:checkpoints.at(-1).sha256};
  validateHistoricalCheckpointChain(checkpoints,dispositionStub,historicalDispositionFail);
  const admission = dispositionReadRecord(STATE_ROOT+'/admission-proofs/'+
    policy.attemptId+'.json',0o600);
  validateHistoricalAdmissionProof(admission.record,approval.sha256,checkpoints[0].sha256,
    historicalDispositionFail);
  const pre = dispositionReadBytes(STATE_ROOT+'/backups/'+policy.attemptId+'-pre.dump',0o600);
  const post = dispositionReadBytes(STATE_ROOT+'/backups/'+policy.attemptId+'-post.dump',0o600);
  const preReceipt = checkpoints[1].record.predeployBackup;
  const postReceipt = checkpoints.at(-1).record.postdeployBackup;
  if (!preReceipt || preReceipt.sha256 !== digest(pre)
    || !postReceipt || postReceipt.sha256 !== digest(post)) {
    throw new Error('RECOVERY_DISPOSITION_EVIDENCE_INVALID');
  }
  const historicalLogs = new Map();
  for (const name of HISTORICAL_LOG_NAMES) {
    const mode = name.startsWith('postdeploy-operator') ? 0o644 : 0o600;
    historicalLogs.set(name,dispositionReadBytes(STATE_ROOT+'/logs/'+policy.attemptId+'/'+name,mode));
  }
  const log = historicalLogs.get('postdeploy-operator-20261101T040551Z.log');
  const rc = historicalLogs.get('postdeploy-operator-20261101T040551Z.rc');
  validateHistoricalPostdeploy(log,rc,historicalDispositionFail);
  const oldAdoption = dispositionReadRecord(policy.oldAdoptionFile,0o600);
  const oldBaseline = dispositionReadRecord(policy.oldBaselineManifestFile,0o600);
  validateHistoricalOldBaselinePayloads(oldBaseline.record,historicalDispositionFail);
  const oldSums = dispositionReadBytes(policy.oldBaselineSha256SumsFile,0o600);
  const receipt = dispositionReadRecord(policy.emergencyReceiptFile,0o600);
  validateHistoricalEmergencyReceipt(receipt.record,historicalDispositionFail);
  validateHistoricalOldEvidence(oldAdoption.record,oldBaseline.record,approval.sha256,
    profile.sha256,oldBaseline.sha256,historicalDispositionFail);
  const currentTime = sampleTrustedTime();
  const context = {approval:approval.record,approvalSha256:approval.sha256,
    profile:profile.record,profileSha256:profile.sha256,machineId:profile.record.machineId,
    initialCheckpoint:checkpoints[0],lastCheckpoint:checkpoints.at(-1),admissionProof:admission.record,
    admissionProofSha256:admission.sha256,emergencyReceipt:receipt.record,
    emergencyReceiptSha256:receipt.sha256,postdeployLogSha256:digest(log),
    postdeployRcSha256:digest(rc),oldAdoption:oldAdoption.record,oldAdoptionSha256:oldAdoption.sha256,
    oldBaselineManifest:oldBaseline.record,oldBaselineManifestSha256:oldBaseline.sha256,
    oldBaselineSha256SumsSha256:digest(oldSums),currentTime};
  const record = historicalRecoveryDispositionRecord(context);
  if (!existsSync(HISTORICAL_DISPOSITION_ROOT)) {
    mkdirSync(HISTORICAL_DISPOSITION_ROOT,{mode:0o700});
    flushDirectory(STATE_ROOT);
  }
  historicalDirectory(HISTORICAL_DISPOSITION_ROOT,historicalDispositionFail);
  const fd = openSync(policy.dispositionFile,
    constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try {
    writeFileSync(fd,JSON.stringify(record)+'\n');
    fsyncSync(fd);
  } finally { closeSync(fd); }
  flushDirectory(HISTORICAL_DISPOSITION_ROOT);
  const sealed = trustedFile(policy.dispositionFile,0o600);
  if (digest(sealed) !== jsonDigest(record)) historicalDispositionFail();
  return {record,sha256:digest(sealed)};
}

export function verifyAttemptRelease(attemptId, direction) {
  const context = loadAttempt(attemptId);
  const {approval} = context;
  if (!['old','target'].includes(direction)) throw new Error('RECOVERY_CONTROLLER_ARGUMENTS_INVALID');
  const sha = direction === 'old' ? approval.oldReleaseSha : approval.releaseSha;
  const expected = direction === 'old' ? approval.oldArtifactSha256 : approval.artifactSha256;
  const root = '/opt/servora-med/releases/'+sha;
  try {
    if (trustedFile(root+'/.servora-release-artifact.sha256',0o600).toString('utf8') !== expected+'\n') {
      throw new Error('RECOVERY_RELEASE_UNPROVEN');
    }
    const entries = verifiedReleaseEntries(root);
    const retained = `${STATE_ROOT}/artifacts/${sha}.tar.gz`;
    if (existsSync(retained)) {
      // Corrupt, foreign or dangling retained archives never fall back.
      if (digest(trustedFile(retained,0o600)) !== expected) throw new Error('RECOVERY_RELEASE_UNPROVEN');
    } else {
      if (direction !== 'old') throw new Error('RECOVERY_RELEASE_UNPROVEN');
      const policy = recoveryPolicyForRelease(approval.oldReleaseSha);
      const record = readProtectedRecord(policy.adoptionFile).record;
      verifyInstalledOldBaseline(record,context,root,entries,policy);
    }
    if (direction === 'target' && digest(trustedFile(root+'/ops/scripts/deploy-production-host.sh',0o750,null))
      !== digest(trustedFile(INSTALLED+'/deploy-production-host',0o755))) throw new Error('RECOVERY_RELEASE_UNPROVEN');
    if (direction === 'target') {
      for (const name of ['deployment-attempt.mjs','deployment-controller.mjs','deployment-db-guard.mjs','migration-reconciliation.mjs','trusted-time.mjs']) {
        if (digest(trustedFile(root+'/ops/scripts/'+name,0o650,null)) !== digest(trustedFile(INSTALLED+'/'+name,0o644))) {
          throw new Error('RECOVERY_RELEASE_UNPROVEN');
        }
      }
      if (digest(trustedFile(root+'/ops/scripts/host-operation-lock.sh',0o650,null)) !== digest(trustedFile(INSTALLED+'/host-operation-lock.sh',0o644))) throw new Error('RECOVERY_RELEASE_UNPROVEN');
      if (digest(trustedFile(root+'/ops/systemd/servora-med.service',0o640,null))
        !== digest(trustedFile('/etc/systemd/system/servora-med.service',0o644))) throw new Error('RECOVERY_RELEASE_UNPROVEN');
    }
  } catch { throw new Error('RECOVERY_RELEASE_UNPROVEN'); }
  verifyAttemptCatalog(attemptId,direction);
}

export function alignAttemptEnvironment(attemptId, direction) {
  const { approval, profile, checkpoint } = currentAttempt(attemptId);
  if (direction === 'target' ? checkpoint.record.phase !== 'ENV_INTENT'
    : direction !== 'old' || checkpoint.record.phase !== 'ABORT_INTENT') throw new Error('ATTEMPT_TRANSITION_INVALID');
  const before = trustedFile(ENV_FILE, 0o640, null).toString('utf8');
  validateIdentityTuple(before, approval);
  if (environmentBaseline(before) !== profile.envBaselineSha256) throw new Error('RECOVERY_ENV_BASELINE_MISMATCH');
  const schema = (direction === 'old' ? approval.oldCatalog : approval.targetCatalog).at(-1).version;
  const release = direction === 'old' ? approval.oldReleaseSha : approval.releaseSha;
  const next = alignIdentityEnvironment(before, schema, release);
  if (before === next) return;
  const temporary = `/etc/servora-med/.r4-env-${randomUUID()}.tmp`;
  const gid = lstatSync(ENV_FILE).gid;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    fchownSync(fd, 0, gid); fchmodSync(fd, 0o640);
    writeFileSync(fd, next); fsyncSync(fd);
  } finally { closeSync(fd); }
  try {
    renameSync(temporary, ENV_FILE); flushDirectory('/etc/servora-med');
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  if (trustedFile(ENV_FILE, 0o640, gid).toString('utf8') !== next) throw new Error('RECOVERY_ENV_READBACK_FAILED');
}

function trustedFile(path, mode, gid = 0) {
  let parent = '';
  for (const component of path.split('/').slice(1, -1)) {
    parent += '/' + component;
    const info = lstatSync(parent);
    if (!info.isDirectory() || info.uid !== 0 || info.isSymbolicLink() || (info.mode & 0o022)) throw new Error('RECOVERY_HOST_FILE_UNTRUSTED');
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== 0 || (gid !== null && info.gid !== gid) || info.nlink !== 1
      || (info.mode & 0o7777) !== mode) throw new Error('RECOVERY_HOST_FILE_UNTRUSTED');
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

function verifyHostProfile(profile, context) {
  const files = {
    helperSha256: [`${INSTALLED}/deploy-production-host`, 0o755],
    nodeSha256: [realpathSync('/usr/bin/node'), 0o755],
    unitSha256: ['/etc/systemd/system/servora-med.service', 0o644],
    attemptModuleSha256: [`${INSTALLED}/deployment-attempt.mjs`, 0o644],
    dbGuardModuleSha256: [`${INSTALLED}/deployment-db-guard.mjs`, 0o644],
    reconciliationModuleSha256: [`${INSTALLED}/migration-reconciliation.mjs`, 0o644],
    controllerModuleSha256: [`${INSTALLED}/deployment-controller.mjs`, 0o644],
    timeModuleSha256: [`${INSTALLED}/trusted-time.mjs`, 0o644],
    timeConfigSha256: ['/etc/chrony/chrony.conf', 0o644],
  };
  for (const [key, [path, mode]] of Object.entries(files)) {
    if (digest(trustedFile(path, mode)) !== profile.contracts[key]) throw new Error('RECOVERY_HOST_CONTRACT_MISMATCH');
  }
  if (environmentBaseline(trustedFile(ENV_FILE, 0o640, null).toString('utf8')) !== profile.envBaselineSha256) {
    throw new Error('RECOVERY_ENV_BASELINE_MISMATCH');
  }
  const properties = Object.fromEntries(systemctl('show','servora-med.service',
    '-p','User','-p','Group','-p','WorkingDirectory','-p','FragmentPath','-p','DropInPaths',
    '-p','ExecStart','-p','EnvironmentFiles','-p','NeedDaemonReload','-p','Restart').split('\n')
    .map(line => [line.slice(0,line.indexOf('=')),line.slice(line.indexOf('=')+1)]));
  const policy = '/etc/systemd/system/servora-med.service.d/90-servora-recovery.conf';
  let pendingHandoffReload = false;
  if (properties.NeedDaemonReload === 'yes' && properties.DropInPaths === policy
    && properties.Restart === 'no' && !existsSync(policy)) {
    // Exact interruption after unlinking our owned policy but before reload.
    // No other drift is tolerated; the sealed acceptance and owned barrier
    // must still exist. Reload happens only after fresh DB/payload proof.
    const active = readProtectedRecord(STATE_ROOT+'/active.json').record;
    const checkpoint = readLatestCheckpoint(context.approval.attemptId);
    if (Object.keys(active).length !== 2 || active.attemptId !== context.approval.attemptId
      || active.approvalSha256 !== context.approvalSha256) throw new Error('RECOVERY_OTHER_ATTEMPT_ACTIVE');
    acceptedHandoffDirection(checkpoint.record,context);
    assertBarrier({...context,profile,checkpoint});pendingHandoffReload = true;
  }
  let pendingPolicyInstall = false;
  if (properties.NeedDaemonReload === 'yes' && properties.DropInPaths === ''
    && properties.Restart === 'on-failure' && existsSync(policy)) {
    // Exact interruption after our owned drop-in was renamed into place but
    // before daemon-reload (the install direction of the same publication
    // window). Only the verified, same-attempt pending policy may reload;
    // unknown systemd drift is still rejected. The reload itself happens in
    // the phase helper after fresh DB/payload proof, never from this check.
    if (!existsSync(STATE_ROOT+'/active.json')
      || trustedFile(policy,0o600).toString('utf8') !== '[Service]\nRestart=no\n') {
      throw new Error('RECOVERY_SERVICE_CONTRACT_MISMATCH');
    }
    const active = readProtectedRecord(STATE_ROOT+'/active.json').record;
    const checkpoint = readLatestCheckpoint(context.approval.attemptId);
    if (Object.keys(active).length !== 2 || active.attemptId !== context.approval.attemptId
      || active.approvalSha256 !== context.approvalSha256) throw new Error('RECOVERY_OTHER_ATTEMPT_ACTIVE');
    if (!['ADMITTED','BACKED_UP','FENCED','MIGRATION_INTENT','DB_EXACT','ENV_INTENT','ENV_ALIGNED',
      'POINTER_INTENT','POINTER_ALIGNED','START_INTENT','START_FAILED','HEALTH_PASSED','SMOKE_PASSED',
      'POSTDEPLOY_BACKUP_INTENT','POSTDEPLOY_BACKUP_PASSED','OBSERVATION_PASSED','ABORT_INTENT']
      .includes(checkpoint.record.phase)) throw new Error('RECOVERY_SERVICE_CONTRACT_MISMATCH');
    assertBarrier({...context,profile,checkpoint});pendingPolicyInstall = true;
  }
  if (properties.User !== 'servora-med' || properties.Group !== 'servora-med'
    || properties.WorkingDirectory !== '/opt/servora-med/current/server'
    || properties.FragmentPath !== '/etc/systemd/system/servora-med.service'
    || properties.EnvironmentFiles !== ENV_FILE+' (ignore_errors=no)'
    || (properties.NeedDaemonReload !== 'no' && !pendingHandoffReload && !pendingPolicyInstall)
    || !/^\{ path=\/usr\/bin\/node ; argv\[\]=\/usr\/bin\/node dist\/index\.js ; ignore_errors=no ; [^}]*\}$/.test(properties.ExecStart)
    || !['',policy].includes(properties.DropInPaths)
    || properties.Restart !== (properties.DropInPaths ? 'no' : 'on-failure')) {
    throw new Error('RECOVERY_SERVICE_CONTRACT_MISMATCH');
  }
  if (properties.DropInPaths && !pendingHandoffReload && trustedFile(policy,0o600).toString('utf8') !== '[Service]\nRestart=no\n') {
    throw new Error('RECOVERY_SERVICE_CONTRACT_MISMATCH');
  }
}

export function loadAttempt(attemptId) {
  let context;
  try { context = readRootApproval(attemptId); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('ATTEMPT_APPROVAL_MISSING');
    throw error;
  }
  const profile = readRootProfile(context.approval);
  if (readFileSync('/etc/machine-id', 'utf8').trim() !== profile.machineId) throw new Error('RECOVERY_HOST_MACHINE_MISMATCH');
  verifyHostProfile(profile,context);
  return { ...context, profile };
}

function identityLines(text) {
  if (typeof text !== 'string' || !text.endsWith('\n') || text.includes('\r')) throw new Error('ENV_IDENTITY_INVALID');
  const lines = text.split('\n');
  const schema = lines.filter(line => line.startsWith('HEALTH_SCHEMA_VERSION='));
  const release = lines.filter(line => line.startsWith('SERVORA_RELEASE_SHA='));
  if (schema.length !== 1 || release.length !== 1
    || !/^HEALTH_SCHEMA_VERSION=[0-9]{3}_[a-z0-9_]+$/.test(schema[0])
    || !/^SERVORA_RELEASE_SHA=[0-9a-f]{40}$/.test(release[0])
    || lines.some(line => /^(?:\s|export\s+)+(HEALTH_SCHEMA_VERSION|SERVORA_RELEASE_SHA)\s*=/.test(line))) {
    throw new Error('ENV_IDENTITY_INVALID');
  }
  return lines;
}

export function environmentBaseline(text) {
  return digest(identityLines(text).filter(line => !/^(HEALTH_SCHEMA_VERSION|SERVORA_RELEASE_SHA)=/.test(line)).join('\n'));
}

export function alignIdentityEnvironment(text, schema, release) {
  if (!/^[0-9]{3}_[a-z0-9_]+$/.test(schema) || !/^[0-9a-f]{40}$/.test(release)) throw new Error('ENV_IDENTITY_INVALID');
  return identityLines(text).map(line => line.startsWith('HEALTH_SCHEMA_VERSION=') ? `HEALTH_SCHEMA_VERSION=${schema}`
    : line.startsWith('SERVORA_RELEASE_SHA=') ? `SERVORA_RELEASE_SHA=${release}` : line).join('\n');
}

export function validateIdentityTuple(text, approval) {
  const lines = identityLines(text);
  const schema = lines.find(line => line.startsWith('HEALTH_SCHEMA_VERSION=')).slice('HEALTH_SCHEMA_VERSION='.length);
  const release = lines.find(line => line.startsWith('SERVORA_RELEASE_SHA=')).slice('SERVORA_RELEASE_SHA='.length);
  if (![approval.oldCatalog.at(-1).version, approval.targetCatalog.at(-1).version].includes(schema)
    || ![approval.oldReleaseSha, approval.releaseSha].includes(release)) throw new Error('ENV_IDENTITY_DRIFT');
  return { schema, release };
}

const COMMAND_ENV = {PATH:'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'};
function systemctl(...args) {
  return execFileSync('/usr/bin/systemctl',args,{env:COMMAND_ENV,encoding:'utf8',timeout:40000,stdio:['ignore','pipe','pipe']}).trim();
}

/** Private temporary names of the sealed-dump publication protocol. A crash
 * between the exclusive link and the temp unlink, or before the link, leaves
 * exactly these artifacts; they are provably ours in the protected directory.
 */
const SEALED_RESIDUE = /^\.backup-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function trustedBackupDirectory() {
  const directory = STATE_ROOT+'/backups';
  if (!existsSync(directory)) throw new Error('RECOVERY_BACKUP_SEALED_MISSING');
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0
    || (info.mode & 0o7777) !== 0o700) throw new Error('RECOVERY_BACKUP_UNTRUSTED');
  return directory;
}

function reconcileSealedResidues(directory) {
  for (const name of readdirSync(directory)) {
    if (!SEALED_RESIDUE.test(name)) continue;
    const path = `${directory}/${name}`;
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0
      || (info.mode & 0o7777) !== 0o600 || ![1, 2].includes(info.nlink)) {
      throw new Error('RECOVERY_BACKUP_UNTRUSTED');
    }
    unlinkSync(path);
    flushDirectory(directory);
  }
}

function hashSealedFile(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(1024*1024);
    for (let count; (count = readSync(fd,buffer,0,buffer.length,null)) > 0;) hash.update(buffer.subarray(0,count));
    return hash.digest('hex');
  } finally { closeSync(fd); }
}

/** Adopt an already-published sealed dump for the same attempt and kind.
 * An interrupted resume must not be forced to produce a second backup, and it
 * must not trust the retained bytes either: the sealed copy is revalidated as
 * a real PostgreSQL archive with a coherent identity and hash before the
 * receipt is journaled. Corrupt or foreign sealed bytes fail closed.
 */
function adoptSealedBackup(attemptId, kind, context) {
  const directory = trustedBackupDirectory();
  reconcileSealedResidues(directory);
  const file = `${directory}/${attemptId}-${kind}.dump`;
  if (!existsSync(file)) throw new Error('RECOVERY_BACKUP_SEALED_MISSING');
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0
    || info.nlink !== 1 || (info.mode & 0o7777) !== 0o600 || info.size <= 0
    || info.mtimeMs < Date.parse(context.checkpoint.record.updatedAtUTC)-1000) {
    throw new Error('RECOVERY_BACKUP_UNTRUSTED');
  }
  try {
    execFileSync(PG_RESTORE_BIN,['--list',file],{env:COMMAND_ENV,timeout:30000,stdio:['ignore','ignore','ignore']});
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('RECOVERY_BACKUP_VALIDATION_UNAVAILABLE');
    throw new Error('RECOVERY_BACKUP_ARCHIVE_INVALID');
  }
  const sha256 = hashSealedFile(file);
  return checkpointAttempt(attemptId,{kind:kind === 'pre' ? 'PREDEPLOY_BACKUP' : 'POSTDEPLOY_BACKUP_PASSED',
    receipt:{sha256,completedAtUTC:new Date(info.mtimeMs).toISOString()}});
}

/** Seal the bytes of a freshly verified fixed-path host backup. Never retain
 * only the service-writable pathname: root retains its own immutable copy.
 */
export function validateBackupObservationBinding(document,artifactSha256,sidecarSha256,trigger) {
  const proof=document?.latestVerifiedProof;
  try {validateCurrentTimeEvidence(proof?.before);validateCurrentTimeEvidence(proof?.after);}
  catch {throw new Error('RECOVERY_BACKUP_UNTRUSTED');}
  if(document?.schemaVersion!==2||document.latestAttemptResult!=='success'||document.latestAttemptTrigger!==trigger
    ||document.latestVerifiedTrigger!==trigger||!proof||Object.keys(proof).length!==8||proof.formatVersion!==1
    ||typeof proof.attemptId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(proof.attemptId)
    ||proof.attemptId!==document.latestAttemptId||proof.trigger!==trigger||proof.startedAt!==document.latestAttemptStartedAt
    ||JSON.stringify(proof.before)!==JSON.stringify(document.latestAttemptTime)
    ||proof.artifactSha256!==artifactSha256||proof.sidecarSha256!==sidecarSha256
    ||document.latestAttemptCompletedAt!==document.latestVerifiedAt
    ||typeof proof.after?.wallAtUTC!=='string'||proof.after.wallAtUTC.slice(0,19)+'Z'!==document.latestVerifiedAt
    ||elapsedTime(proof.before,proof.after).status!=='KNOWN')throw new Error('RECOVERY_BACKUP_UNTRUSTED');
}

function assertBackupObservationBinding(uid,gid,artifactSha256,sidecarSha256,trigger) {
  const directory='/var/lib/servora-med-backup',info=lstatSync(directory);
  if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==uid||info.gid!==gid||(info.mode&0o7777)!==0o700)throw new Error('RECOVERY_BACKUP_UNTRUSTED');
  const fd=openSync(directory+'/observation-v1.json',constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const stat=fstatSync(fd);
    if(!stat.isFile()||stat.nlink!==1||stat.uid!==uid||stat.gid!==gid||(stat.mode&0o7777)!==0o600||stat.size>65536)throw new Error('RECOVERY_BACKUP_UNTRUSTED');
    validateBackupObservationBinding(JSON.parse(readFileSync(fd,'utf8')),artifactSha256,sidecarSha256,trigger);
  } finally {closeSync(fd);}
}

export function sealBackupReceipt(attemptId, kind, file = null) {
  const context = currentAttempt(attemptId);
  if (!['pre','post'].includes(kind)
    || context.checkpoint.record.phase !== (kind === 'pre' ? 'ADMITTED' : 'POSTDEPLOY_BACKUP_INTENT')
    || (file !== null && !/^\/var\/backups\/servora-med\/servora-med-[0-9]{8}T[0-9]{6}Z\.dump$/.test(file))) {
    throw new Error('ATTEMPT_TRANSITION_INVALID');
  }
  // The root-private copy can be published while the checkpoint write is
  // interrupted. Convert that verified sealed dump into the receipt instead
  // of demanding a second backup, which would collide with the sealed name.
  if (file === null || existsSync(`${STATE_ROOT}/backups/${attemptId}-${kind}.dump`)) {
    return adoptSealedBackup(attemptId, kind, context);
  }
  const uid = Number(execFileSync('/usr/bin/id',['-u','servora-med'],{encoding:'utf8'}));
  const gid = Number(execFileSync('/usr/bin/id',['-g','servora-med'],{encoding:'utf8'}));
  const sourceDir = lstatSync('/var/backups/servora-med');
  if (!sourceDir.isDirectory() || sourceDir.isSymbolicLink() || sourceDir.uid !== uid || sourceDir.gid !== gid
    || (sourceDir.mode & 0o7777) !== 0o700) throw new Error('RECOVERY_BACKUP_UNTRUSTED');
  const source = openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  const checksum = openSync(file+'.sha256',constants.O_RDONLY|constants.O_NOFOLLOW);
  const directory = STATE_ROOT+'/backups';
  let temporary;
  try {
    for (const fd of [source,checksum]) {
      const info = fstatSync(fd);
      if (!info.isFile() || info.uid !== uid || info.gid !== gid || info.nlink !== 1
        || (info.mode & 0o7777) !== 0o600 || info.mtimeMs < Date.parse(context.checkpoint.record.updatedAtUTC)-1000) {
        throw new Error('RECOVERY_BACKUP_UNTRUSTED');
      }
    }
    const line = readFileSync(checksum,'utf8');
    const name = file.split('/').at(-1);
    const expected = line.match(/^([0-9a-f]{64})  ([^\s/]+)\n$/);
    if (!expected || expected[2] !== name) throw new Error('RECOVERY_BACKUP_UNTRUSTED');
    if (!existsSync(directory)) { mkdirSync(directory,{mode:0o700}); flushDirectory(STATE_ROOT); }
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0 || (info.mode & 0o7777) !== 0o700) throw new Error('RECOVERY_BACKUP_UNTRUSTED');
    reconcileSealedResidues(directory);
    temporary = directory+'/.backup-'+randomUUID();
    const output = openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    const hash = createHash('sha256');
    try {
      const buffer = Buffer.alloc(1024*1024);
      for (let count; (count = readSync(source,buffer,0,buffer.length,null)) > 0;) {
        hash.update(buffer.subarray(0,count));
        for (let offset = 0; offset < count;) offset += writeSync(output,buffer,offset,count-offset);
      }
      fsyncSync(output);
    } finally { closeSync(output); }
    const sha256 = hash.digest('hex');
    if (sha256 !== expected[1]) throw new Error('RECOVERY_BACKUP_UNTRUSTED');
    assertBackupObservationBinding(uid,gid,sha256,digest(line),kind==='pre'?'predeploy':'postdeploy');
    // The copied root-private bytes must themselves be a real PostgreSQL
    // archive: digest agreement with the equally service-writable sidecar is
    // not proof, and the source pathname may have been swapped between the
    // helper's verification and this sealed copy.
    try {
      execFileSync(PG_RESTORE_BIN,['--list',temporary],{env:COMMAND_ENV,timeout:30000,stdio:['ignore','ignore','ignore']});
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('RECOVERY_BACKUP_VALIDATION_UNAVAILABLE');
      throw new Error('RECOVERY_BACKUP_ARCHIVE_INVALID');
    }
    linkSync(temporary,`${directory}/${attemptId}-${kind}.dump`); unlinkSync(temporary); temporary = null; flushDirectory(directory);
    return checkpointAttempt(attemptId,{kind:kind === 'pre' ? 'PREDEPLOY_BACKUP' : 'POSTDEPLOY_BACKUP_PASSED',
      receipt:{sha256,completedAtUTC:new Date().toISOString()}});
  } finally { closeSync(source); closeSync(checksum); if (temporary && existsSync(temporary)) unlinkSync(temporary); }
}

function validateBackupDatabase(profile) {
  const text = trustedFile('/etc/servora-med/servora-med-backup.env',0o640,null).toString('utf8');
  const keys = {PGHOST:profile.databaseIdentity.host,PGPORT:String(profile.databaseIdentity.port),
    PGUSER:profile.databaseIdentity.role,PGDATABASE:profile.databaseIdentity.databaseName};
  for (const [key,value] of Object.entries(keys)) {
    const lines = text.split('\n').filter(line => line.startsWith(key+'='));
    if (lines.length !== 1 || lines[0] !== key+'='+value) throw new Error('RECOVERY_BACKUP_DATABASE_MISMATCH');
  }
}

/** Fixed service-UID probe holds the Migrator's advisory lock throughout the
 * host transition. No protected URL is printed or put on the command line.
 * The root parent retains host flock; no root lock fd reaches the service UID.
 */
async function withGuard(context, direction, operation) {
  const child = spawn('/usr/bin/sudo',['-u','servora-med','--','/usr/bin/env','-i',
    'PATH='+COMMAND_ENV.PATH,'/usr/bin/node','--env-file='+ENV_FILE,
    INSTALLED+'/deployment-db-guard.mjs','--hold'],{env:COMMAND_ENV,stdio:['pipe','pipe','pipe']});
  child.stdin.on('error', () => {});
  let probeError = '';
  child.stderr.on('data',chunk => { if (probeError.length < 1024) probeError += chunk.toString(); });
  let exit = null;
  const finished = new Promise(resolve => {
    child.once('error',() => { exit = exit ?? {code:-1,signal:null}; resolve(-1); });
    child.once('exit',(code,signal) => { exit = {code,signal}; resolve(code); });
  });
  const reader = createInterface({input:child.stdout,crlfDelay:Infinity});
  const lines = reader[Symbol.asyncIterator]();
  const expect = async value => {
    let timer;
    try {
      const line = await Promise.race([lines.next(),new Promise((_,reject) => {
        timer = setTimeout(() => reject(new Error('RECOVERY_DATABASE_PROBE_FAILED')),10000);
      })]);
      if (line.done || line.value !== value) {
        const code = probeError.trim();
        throw new Error(/^RECOVERY_DATABASE_[A-Z_]+$/.test(code) ? code : 'RECOVERY_DATABASE_PROBE_FAILED');
      }
    } finally { clearTimeout(timer); }
  };
  const counts = async () => {
    let timer;
    try {
      child.stdin.write('COUNTS\n');
      const line = await Promise.race([lines.next(),new Promise((_,reject) => {
        timer = setTimeout(() => reject(new Error('RECOVERY_DATABASE_PROBE_FAILED')),10000);
      })]);
      if (line.done || typeof line.value !== 'string' || !line.value.startsWith('COUNTS=')) {
        const code = probeError.trim();
        throw new Error(/^RECOVERY_DATABASE_[A-Z_]+$/.test(code) ? code : 'RECOVERY_DATABASE_PROBE_FAILED');
      }
      const parsed = JSON.parse(line.value.slice('COUNTS='.length));
      for (const key of ['organizations','admins','staff','customers','products','jobs','demo_data']) {
        if (!Number.isSafeInteger(parsed[key]) || parsed[key] < 0) throw new Error('RECOVERY_DATABASE_PROBE_FAILED');
      }
      return parsed;
    } finally { clearTimeout(timer); }
  };
  child.stdin.write(JSON.stringify({releaseDirectory:'/opt/servora-med/releases/'+(direction === 'old' ? context.approval.oldReleaseSha : context.approval.releaseSha),
    expectedIdentity:context.profile.databaseIdentity,
    expectedCatalog:(direction === 'old' ? context.approval.oldCatalog : context.approval.targetCatalog).map(entry => entry.version)})+'\n');
  const guard = { assertAlive() { if (exit) throw new Error('RECOVERY_DATABASE_PROBE_FAILED'); },
    async settle() { if (exit !== null) return; await delay(0); await delay(0); } };
  const previousGuard = activeGuard;
  activeGuard = guard;
  let result = null;
  let operationError = null;
  try {
    await expect('READY');
    const check = async () => { child.stdin.write('CHECK\n'); await expect('EXACT'); };
    const quiescence = async () => { child.stdin.write('QUIESCENCE\n'); await expect('QUIESCENT'); };
    result = await operation(check, counts, quiescence);
  } catch (error) { operationError = error; }
  let shutdownError = null;
  try {
    if (exit === null) {
      // A completed transition requires the guard to observe RELEASE and exit
      // zero: an exited guard means the advisory lock was lost before the
      // transition was durably accepted.
      child.stdin.end('RELEASE\n');
      const timer = setTimeout(() => child.kill('SIGTERM'),5000);
      try { await finished; } finally { clearTimeout(timer); }
    }
    if (!exit || exit.code !== 0) shutdownError = new Error('RECOVERY_DATABASE_PROBE_FAILED');
  } finally { activeGuard = previousGuard; reader.close(); }
  if (operationError) throw operationError;
  if (shutdownError) throw shutdownError;
  return result;
}

function assertStoppedWriters(context) {
  assertBarrier(context);
  if (existsSync(PERMIT_FILE) || systemctl('show','servora-med.service','-p','MainPID','--value') !== '0'
    || systemctl('show','servora-med.service','-p','ActiveState','--value') !== 'inactive'
    || systemctl('show','servora-med.service','-p','Restart','--value') !== 'no') {
    throw new Error('RECOVERY_DATABASE_WRITERS_NOT_QUIESCENT');
  }
  const worker = 'servora-med-backup-worker.service';
  if (systemctl('show',worker,'-p','LoadState','--value') !== 'not-found') {
    if (systemctl('show',worker,'-p','ActiveState','--value') !== 'inactive'
      || systemctl('show',worker,'-p','UnitFileState','--value') !== 'disabled') {
      throw new Error('RECOVERY_DATABASE_WRITERS_NOT_QUIESCENT');
    }
  }
  // A detached application/worker process can reopen DB connections. Reject
  // it instead of treating systemd's MainPID alone as proof of quiescence.
  try {
    execFileSync('/usr/bin/pgrep',['-u','servora-med'],{env:COMMAND_ENV,stdio:'ignore'});
    throw new Error('RECOVERY_DATABASE_WRITERS_NOT_QUIESCENT');
  } catch (error) {
    if (error.status !== 1) throw new Error('RECOVERY_DATABASE_WRITERS_NOT_QUIESCENT');
  }
}

/** The stopped, owned fence may precede its FENCED checkpoint. Only its
 * unchanged owner may finish that publication and continue OLD EXACT into
 * migration; this is never TARGET forward recovery or generic health bypass.
 */
export async function proveFencedResume(attemptId) {
  const context = currentAttempt(attemptId);
  const {approval,checkpoint} = context;
  const record = checkpoint.record;
  if (!['BACKED_UP','FENCED'].includes(record.phase) || record.migrationCommitted || record.invariantBaseline
    || record.starts !== 0 || record.abortStarts !== 0 || !record.predeployBackup
    || !approval.allowMigration || !approval.allowForwardRecovery || !approval.allowPostdeployBackup) {
    throw new Error('ATTEMPT_TRANSITION_INVALID');
  }
  verifyAttemptRelease(attemptId,'old');verifyAttemptRelease(attemptId,'target');
  assertRetainedBackups(context);validateBackupDatabase(context.profile);assertStoppedWriters(context);
  try {
    execFileSync(PG_RESTORE_BIN,['--list',`${STATE_ROOT}/backups/${attemptId}-pre.dump`],
      {env:COMMAND_ENV,timeout:30000,stdio:['ignore','ignore','ignore']});
  } catch { throw new Error('RECOVERY_BACKUP_ARCHIVE_INVALID'); }
  const tuple = validateIdentityTuple(trustedFile(ENV_FILE,0o640,null).toString('utf8'),approval);
  if (tuple.release !== approval.oldReleaseSha || tuple.schema !== approval.oldCatalog.at(-1).version
    || realpathSync('/opt/servora-med/current') !== '/opt/servora-med/releases/'+approval.oldReleaseSha) {
    throw new Error('ATTEMPT_DEPLOYMENT_IDENTITY_MISMATCH');
  }
  await withGuard(context,'old',async (check,counts,quiescence) => {
    await check();await quiescence();await counts();await quiescence();
    if (record.phase === 'BACKED_UP') {
      await settleGuard();checkpointAttempt(attemptId,'FENCED');
    }
  });
  return context;
}

export async function recordFreshMigrationIntent(attemptId, expectedCounts) {
  const context = currentAttempt(attemptId);
  if (context.checkpoint.record.phase !== 'FENCED') throw new Error('ATTEMPT_TRANSITION_INVALID');
  verifyAttemptRelease(attemptId,'old');verifyAttemptRelease(attemptId,'target');assertRetainedBackups(context);
  assertStoppedWriters(context);
  return withGuard(context,'old',async (check,counts,quiescence) => {
    await check();await quiescence();
    const fresh=await counts();await quiescence();
    const baseline={organizations:fresh.organizations,admins:fresh.admins,staff:fresh.staff,
      customers:fresh.customers,products:fresh.products,jobs:fresh.jobs,demoData:fresh.demo_data};
    if (Object.keys(baseline).some(key=>baseline[key]!==expectedCounts[key])) {
      throw new Error('RECOVERY_DATABASE_BASELINE_CHANGED');
    }
    return checkpointAttempt(attemptId,{kind:'MIGRATION_INTENT',baseline});
  });
}

function assertApprovedPointer(approval) {
  const file = '/opt/servora-med/current';
  const info = lstatSync(file);
  if (!info.isSymbolicLink() || info.uid !== 0 || ![approval.oldReleaseSha,approval.releaseSha]
    .map(sha => '/opt/servora-med/releases/'+sha).includes(realpathSync(file))) throw new Error('RECOVERY_POINTER_UNTRUSTED');
}

function assertProcessAndHealth(context, direction = 'target') {
  const sha = direction === 'old' ? context.approval.oldReleaseSha : context.approval.releaseSha;
  const root = '/opt/servora-med/releases/'+sha;
  const tuple = validateIdentityTuple(trustedFile(ENV_FILE,0o640,null).toString('utf8'),context.approval);
  const head = (direction === 'old' ? context.approval.oldCatalog : context.approval.targetCatalog).at(-1).version;
  if (tuple.release !== sha || tuple.schema !== head || realpathSync('/opt/servora-med/current') !== root) throw new Error('RECOVERY_RELEASE_IDENTITY_MISMATCH');
  if (systemctl('is-active','servora-med.service') !== 'active') throw new Error('RECOVERY_SERVICE_NOT_ACTIVE');
  const pid = systemctl('show','servora-med.service','-p','MainPID','--value');
  if (!/^[1-9][0-9]*$/.test(pid) || realpathSync('/proc/'+pid+'/cwd') !== root+'/server'
    || realpathSync('/proc/'+pid+'/exe') !== realpathSync('/usr/bin/node')) throw new Error('RECOVERY_PROCESS_IDENTITY_MISMATCH');
  for (const url of ['http://127.0.0.1:3000/api/health','https://'+context.profile.fqdn+'/api/health']) {
    const text = execFileSync('/usr/bin/curl',['--fail','--silent','--show-error','--max-time','5',url],
      {env:COMMAND_ENV,encoding:'utf8',timeout:6000,stdio:['ignore','pipe','pipe']});
    const health = JSON.parse(text);
    if (health.status !== 'ok' || health.releaseSha !== sha) throw new Error('RECOVERY_RELEASE_IDENTITY_MISMATCH');
  }
  if (systemctl('show','servora-med.service','-p','MainPID','--value') !== pid) throw new Error('RECOVERY_PROCESS_CHANGED');
  return pid;
}

/** Fresh schema-check gate. Runs the sealed target release's own
 * schema-check as the service UID with the protected env file; the root
 * controller never executes candidate code as root. Any failure fails closed.
 */
export function runTargetSchemaCheck(context, direction = 'target') {
  if (!['old','target'].includes(direction)) throw new Error('RECOVERY_SCHEMA_CHECK_FAILED');
  const release = '/opt/servora-med/releases/'+(direction === 'old' ? context.approval.oldReleaseSha : context.approval.releaseSha);
  try {
    execFileSync('/usr/bin/sudo',['-u','servora-med','--','/usr/bin/env','-i',
      'PATH='+COMMAND_ENV.PATH,'NODE_ENV=production','/usr/bin/node','--env-file='+ENV_FILE,
      release+'/server/dist/db/schema-check.js'],
      {env:COMMAND_ENV,timeout:120000,stdio:['ignore','ignore','ignore']});
  } catch { throw new Error('RECOVERY_SCHEMA_CHECK_FAILED'); }
}

/** DB056 recovery never migrates/restores. Ambiguous start intent is denied;
 * resumable env/pointer intents only replay their exact sealed destinations.
 */
export async function recoverAttempt(attemptId) {
  const context = currentAttempt(attemptId);
  if (!context.approval.allowForwardRecovery) throw new Error('ATTEMPT_START_NOT_AUTHORIZED');
  verifyAttemptRelease(attemptId,'target');
  assertRetainedBackups(context);
  assertApprovedPointer(context.approval);
  validateIdentityTuple(trustedFile(ENV_FILE,0o640,null).toString('utf8'),context.approval);
  if (context.checkpoint.record.phase === 'ACCEPTED') {
    await completeAcceptedHandoff(context);
    return 'FORWARD_RECOVERY=ALREADY_COMPLETED_OWNER_RETIRED';
  }
  if (context.checkpoint.record.phase === 'COMPLETED') {
    return withGuard(context,'target',async check => {
      await check(); assertProcessAndHealth(context); assertBackupHealth(context);
      return retireCompletedOwner(context) ? 'FORWARD_RECOVERY=ALREADY_COMPLETED_OWNER_RETIRED' : 'FORWARD_RECOVERY=ALREADY_COMPLETED_READ_ONLY';
    });
  }
  assertBarrier(context);
  let phase = context.checkpoint.record.phase;
  if (!['FENCED','MIGRATION_INTENT','DB_EXACT','ENV_INTENT','ENV_ALIGNED','POINTER_INTENT',
    'POINTER_ALIGNED','START_FAILED','HEALTH_PASSED','SMOKE_PASSED','POSTDEPLOY_BACKUP_INTENT',
    'POSTDEPLOY_BACKUP_PASSED','OBSERVATION_PASSED','ACCEPTED'].includes(phase)) throw new Error('ATTEMPT_TRANSITION_INVALID');
  return withGuard(context,'target',async (check,counts) => {
    if (['HEALTH_PASSED','SMOKE_PASSED','POSTDEPLOY_BACKUP_INTENT','POSTDEPLOY_BACKUP_PASSED','OBSERVATION_PASSED','ACCEPTED'].includes(phase)) {
      await check();
      try { assertProcessAndHealth(context); }
      catch (error) {
        if (phase !== 'HEALTH_PASSED') throw error;
        phase = checkpointAttempt(attemptId,'HEALTH_LOST').record.phase;
      }
      if (phase !== 'START_FAILED') {
        // Durable schema-check acceptance: a health checkpoint alone must not
        // satisfy the schema gate. If no durable result exists (interruption
        // between activation and the wrapper's recorded check), run the
        // sealed release's own check again before any smoke/postdeploy step.
        if (!readLatestCheckpoint(attemptId).record.schemaChecked) {
          await runTargetSchemaCheck(context);
          await settleGuard();
          checkpointAttempt(attemptId,'SCHEMA_CHECKED');
        }
        return 'FORWARD_RECOVERY=HEALTH_PASSED_PENDING_ACCEPTANCE';
      }
    }
    // Deny an exhausted start budget before stopping or changing the host.
    if (context.checkpoint.record.starts >= context.approval.maxStarts) throw new Error('ATTEMPT_START_BUDGET_EXHAUSTED');
    // Only admitted, exact-DB attempts may change policy or stop the service.
    await check();
    // A committed migration must re-prove the persisted pre-migration business
    // baseline before the durable DB_EXACT boundary or any activation. A
    // TARGET-exact ledger alone is not data-integrity proof.
    if (['FENCED','MIGRATION_INTENT'].includes(phase)) {
      const baseline = readLatestCheckpoint(attemptId).record.invariantBaseline;
      if (!baseline) throw new Error('RECOVERY_INVARIANT_BASELINE_MISSING');
      const fresh = await counts();
      const pairs = [['organizations','organizations'],['admins','admins'],['staff','staff'],
        ['customers','customers'],['products','products'],['jobs','jobs'],['demoData','demo_data']];
      for (const [journalKey,freshKey] of pairs) {
        if (baseline[journalKey] !== fresh[freshKey]) throw new Error('RECOVERY_BUSINESS_DATA_INVARIANT_CHANGED');
      }
    }
    execFileSync('/bin/bash',['--noprofile','--norc','-c',
      'source /usr/local/libexec/servora-med/deploy-production-host; r4_suppress_restarts'],
      {env:COMMAND_ENV,timeout:40000,stdio:['ignore','pipe','pipe']});
    systemctl('stop','servora-med.service');
    revokeStartPermit(attemptId);
    await settleGuard();
    const record = event => { phase = checkpointAttempt(attemptId,event).record.phase; };
    if (['FENCED','MIGRATION_INTENT'].includes(phase)) record('DB_EXACT');
    if (phase === 'DB_EXACT') record('ENV_INTENT');
    if (phase === 'ENV_INTENT') { await check(); alignAttemptEnvironment(attemptId,'target'); record('ENV_ALIGNED'); }
    if (phase === 'ENV_ALIGNED') record('POINTER_INTENT');
    if (phase === 'POINTER_INTENT') { await check(); alignAttemptPointer(attemptId,'target'); record('POINTER_ALIGNED'); }
    await check();
    if (!['POINTER_ALIGNED','START_FAILED'].includes(phase)) throw new Error('ATTEMPT_TRANSITION_INVALID');
    record('START_INTENT'); // fsync before the only explicit start
    let interrupted = false;
    const interrupt = () => { interrupted = true; };
    process.once('SIGTERM',interrupt); process.once('SIGINT',interrupt);
    try {
      grantStartPermit(attemptId);
      systemctl('reset-failed','servora-med.service');
      systemctl('start','servora-med.service');
      revokeStartPermit(attemptId);
      let healthy = false;
      for (let sample = 0; sample < 30; sample++) {
        if (interrupted) throw new Error('RECOVERY_INTERRUPTED');
        await check();
        if (systemctl('show','servora-med.service','-p','Restart','--value') !== 'no') throw new Error('RECOVERY_AUTOMATIC_RESTART_NOT_DISABLED');
        if (systemctl('show','servora-med.service','-p','ActiveState','--value') === 'failed') throw new Error('RECOVERY_SERVICE_START_FAILED');
        try { assertProcessAndHealth(context); healthy = true; break; } catch { await delay(1000); }
      }
      if (!healthy) throw new Error('RECOVERY_HEALTH_FAILED');
      await check(); assertProcessAndHealth(context); record('HEALTH_PASSED');
      return 'FORWARD_RECOVERY=HEALTH_PASSED_PENDING_ACCEPTANCE';
    } catch (error) {
      // No OLD rollback. Keep the boot barrier and disable automatic starts.
      try { systemctl('stop','servora-med.service'); } catch { /* stays fenced */ }
      if (!interrupted) record('START_FAILED');
      throw error;
    } finally {
      revokeStartPermit(attemptId);
      process.removeListener('SIGTERM',interrupt); process.removeListener('SIGINT',interrupt);
    }
  });
}

function handBackToSystemd(context) {
  // Accepted ownership hand-off only. Keep the barrier while reloading the
  // ordinary restart policy; an interruption cannot boot an unaccepted app.
  context = currentAttempt(context.approval.attemptId);
  acceptedHandoffDirection(context.checkpoint.record,context);
  if (existsSync(STATE_ROOT+'/activation.block')) assertBarrier(context);
  revokeStartPermit(context.approval.attemptId);
  const policy = '/etc/systemd/system/servora-med.service.d/90-servora-recovery.conf';
  if (existsSync(policy)) {
    if (trustedFile(policy,0o600).toString('utf8') !== '[Service]\nRestart=no\n') throw new Error('RECOVERY_POLICY_FILE_UNTRUSTED');
    unlinkSync(policy); flushDirectory('/etc/systemd/system/servora-med.service.d');
  }
  systemctl('daemon-reload');
  if (systemctl('show','servora-med.service','-p','Restart','--value') !== 'on-failure') throw new Error('RECOVERY_NORMAL_RESTART_POLICY_MISMATCH');
  if (existsSync(STATE_ROOT+'/activation.block')) { unlinkSync(STATE_ROOT+'/activation.block'); flushDirectory(STATE_ROOT); }
}

/** Re-entry after acceptance never reactivates, backs up or observes again.
 * A missing barrier is permitted only after all durable acceptance gates and
 * an already effective ordinary policy. Earlier missing barriers still fail.
 */
async function completeAcceptedHandoff(context) {
  const direction = acceptedHandoffDirection(context.checkpoint.record,context);
  const id = context.approval.attemptId;
  verifyAttemptRelease(id,'target');if (direction === 'old') verifyAttemptRelease(id,'old');
  assertRetainedBackups(context);assertApprovedPointer(context.approval);
  if (existsSync(PERMIT_FILE)) throw new Error('RECOVERY_COMPLETION_AMBIGUOUS');
  const fenced = existsSync(STATE_ROOT+'/activation.block');
  if (fenced) assertBarrier(context);
  else if (existsSync('/etc/systemd/system/servora-med.service.d/90-servora-recovery.conf')
    || systemctl('show','servora-med.service','-p','Restart','--value') !== 'on-failure') {
    throw new Error('RECOVERY_COMPLETION_AMBIGUOUS');
  }
  await withGuard(context,direction,async check => {
    await check();const pid=assertProcessAndHealth(context,direction);
    runTargetSchemaCheck(context,direction);
    if (direction === 'target') assertBackupHealth(context);
    if (fenced) handBackToSystemd(context);
    await check();
    if (assertProcessAndHealth(context,direction) !== pid) throw new Error('RECOVERY_PROCESS_CHANGED');
    checkpointAttempt(id,direction === 'target' ? 'COMPLETED' : 'COMPLETED_ABORT');
    retireCompletedOwner(currentAttempt(id));
  });
}

export function validateBackupHealthProjection(health) {
  if (!health || health.status !== 'ok' || health.provider !== 'host-observation'
    || health.providerStatus !== 'healthy' || typeof health.latestScheduledVerifiedAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(health.latestScheduledVerifiedAt)
    || !Number.isFinite(Date.parse(health.latestScheduledVerifiedAt))) throw new Error('RECOVERY_BACKUP_HEALTH_FAILED');
}

function assertBackupHealth(context) {
  let health;
  try {
    const text = execFileSync('/usr/bin/curl',['--fail','--silent','--show-error','--max-time','5',
      'http://127.0.0.1:3000/api/health/backup'],{env:COMMAND_ENV,encoding:'utf8',timeout:6000,stdio:['ignore','pipe','pipe']});
    health = JSON.parse(text);
  } catch { throw new Error('RECOVERY_BACKUP_HEALTH_FAILED'); }
  // Use the existing application projection/freshness SSOT; postdeploy success
  // must not substitute for its separate scheduled heartbeat.
  validateBackupHealthProjection(health);
  validateBackupDatabase(context.profile);
}

function assertRetainedBackups(context) {
  for (const [kind,receipt] of [['pre',context.checkpoint.record.predeployBackup],['post',context.checkpoint.record.postdeployBackup]]) {
    if (receipt && digest(trustedFile(`${STATE_ROOT}/backups/${context.approval.attemptId}-${kind}.dump`,0o600)) !== receipt.sha256) {
      throw new Error('RECOVERY_BACKUP_UNTRUSTED');
    }
  }
}

function retireCompletedOwner(context) {
  // Crash after terminal journal fsync but before claim retirement. Only
  // matching completed ownership may be retired; no activation is repeated.
  if (!existsSync(STATE_ROOT+'/active.json')) return false;
  currentAttempt(context.approval.attemptId);
  if (!['COMPLETED','COMPLETED_ABORT'].includes(context.checkpoint.record.phase)
    || existsSync(STATE_ROOT+'/activation.block') || existsSync(PERMIT_FILE)
    || existsSync('/etc/systemd/system/servora-med.service.d/90-servora-recovery.conf')) throw new Error('RECOVERY_COMPLETION_AMBIGUOUS');
  unlinkSync(STATE_ROOT+'/active.json'); flushDirectory(STATE_ROOT); return true;
}

/** Read-only confirmation of a terminal attempt. No mutation, no claim, no
 * service start, no backup. Unknown/malformed/revoked/conflicting terminal
 * records fail closed through the same validators.
 */
async function assertTerminalReadOnly(context, record) {
  const direction = record.phase === 'COMPLETED' ? 'target' : 'old';
  if (existsSync(STATE_ROOT+'/activation.block') || existsSync(PERMIT_FILE)
    || existsSync('/etc/systemd/system/servora-med.service.d/90-servora-recovery.conf')) {
    throw new Error('RECOVERY_COMPLETION_AMBIGUOUS');
  }
  verifyAttemptRelease(context.approval.attemptId,'target');
  if (record.phase === 'COMPLETED_ABORT') verifyAttemptRelease(context.approval.attemptId,'old');
  assertRetainedBackups(context);
  assertApprovedPointer(context.approval);
  await withGuard(context,direction,async check => {
    await check(); assertProcessAndHealth(context,direction);
    if (record.phase === 'COMPLETED') assertBackupHealth(context);
  });
}

/** Non-secret projection, validated before any operator artifact transfer. */
export async function preflightAttempt(attemptId) {
  let context = loadAttempt(attemptId);
  await reconcileInitialization(context);
  let mode = 'deploy';
  if (existsSync(STATE_ROOT+'/active.json')) {
    context = currentAttempt(attemptId);
    const record = context.checkpoint.record;
    if (['ACCEPTED','ABORTED'].includes(record.phase)) {
      mode = record.phase === 'ACCEPTED' ? 'forward-recovery' : 'pre-migration-abort';
      await completeAcceptedHandoff(context);
    } else if (['COMPLETED','COMPLETED_ABORT'].includes(record.phase)) {
      // Crash window: terminal journal fsynced before claim retirement.
      mode = record.phase === 'COMPLETED' ? 'forward-recovery' : 'pre-migration-abort';
      await assertTerminalReadOnly(context, record);
    } else if (record.phase === 'FENCED' || (record.phase === 'BACKED_UP'
      && systemctl('show','servora-med.service','-p','MainPID','--value') === '0')) {
      await proveFencedResume(attemptId);
    } else if (['ADMITTED','BACKED_UP'].includes(record.phase)) {
      // Same-owner retry of an early, unmigrated attempt: resume as a deploy.
      verifyAttemptRelease(attemptId,'target'); assertRetainedBackups(context);
      assertApprovedPointer(context.approval);
      if (existsSync(STATE_ROOT+'/activation.block')) assertBarrier(context);
      await withGuard(context,'old',async check => { await check(); });
    } else {
      mode = 'forward-recovery';
      verifyAttemptRelease(attemptId,'target'); assertRetainedBackups(context);
      assertApprovedPointer(context.approval); assertBarrier(context);
      await withGuard(context,'target',async check => { await check(); });
    }
  } else if (existsSync(STATE_ROOT+'/attempts/'+attemptId)) {
    const checkpoint = readLatestCheckpoint(attemptId);
    const record = checkpoint.record;
    if (!['COMPLETED','COMPLETED_ABORT'].includes(record.phase)) throw new Error('ATTEMPT_DEPLOYMENT_IDENTITY_MISMATCH');
    // Terminal read-only confirmation after successful claim retirement.
    mode = record.phase === 'COMPLETED' ? 'forward-recovery' : 'pre-migration-abort';
    await assertTerminalReadOnly({ ...context, checkpoint }, record);
  } else {
    if (!context.approval.allowMigration || !context.approval.allowForwardRecovery
      || !context.approval.allowPostdeployBackup
      || existsSync(STATE_ROOT+'/activation.block')) throw new Error('ATTEMPT_DEPLOYMENT_IDENTITY_MISMATCH');
    verifyAttemptRelease(attemptId,'old');
    await withGuard(context,'old',async check => {
      await check(); assertProcessAndHealth(context,'old'); assertBackupHealth(context);
    });
  }
  return {mode,releaseSha:context.approval.releaseSha,treeSha:context.approval.treeSha,
    artifactSha256:context.approval.artifactSha256,ciManifestSha256:context.approval.ciManifestSha256,
    fqdn:context.profile.fqdn,oldReleaseSha:context.approval.oldReleaseSha};
}

export async function preparePostdeploy(attemptId,sha,fqdn) {
  const context = currentAttempt(attemptId);
  if (sha !== context.approval.releaseSha || fqdn !== context.profile.fqdn || !context.approval.allowPostdeployBackup) throw new Error('ATTEMPT_DEPLOYMENT_IDENTITY_MISMATCH');
  verifyAttemptRelease(attemptId,'target'); assertRetainedBackups(context);
  return withGuard(context,'target',async check => {
    await check(); assertProcessAndHealth(context); assertBackupHealth(context);
    await settleGuard();
    let phase = context.checkpoint.record.phase;
    // Calling this fixed phase attests the operator wrapper's completed Mac
    // smoke. It is operator-trusted provenance, not independent authentication.
    if (phase === 'HEALTH_PASSED') phase = checkpointAttempt(attemptId,'SMOKE_PASSED').record.phase;
    if (phase === 'SMOKE_PASSED') { checkpointAttempt(attemptId,'POSTDEPLOY_BACKUP_INTENT'); return 'BACKUP_REQUIRED'; }
    if (['POSTDEPLOY_BACKUP_PASSED','OBSERVATION_PASSED','ACCEPTED','COMPLETED'].includes(phase)) return 'BACKUP_ALREADY_VERIFIED';
    throw new Error('POSTDEPLOY_BACKUP_AMBIGUOUS_OPERATOR_REVIEW_REQUIRED');
  });
}

export function validateAttemptDeploymentState(text, approval) {
  const oldRelease = '/opt/servora-med/releases/'+approval.oldReleaseSha;
  const migrationsApplied = approval.targetCatalog.length-approval.oldCatalog.length;
  if (typeof text !== 'string' || !['not_run','success'].some(postdeploy => text ===
    `sha=${approval.releaseSha}\nold_release=${oldRelease}\nnew_release=/opt/servora-med/releases/${approval.releaseSha}\nmigrations_applied=${migrationsApplied}\npostdeploy=${postdeploy}\n`)) {
    throw new Error('DEPLOYMENT_STATE_INVALID');
  }
  return {oldRelease,migrationsApplied};
}

/** State may be reconstructed only from committed exact-catalog journal and
 * sealed approval. Existing contradictory state is never silently repaired.
 */
export async function deploymentStateProjection(attemptId, sha, fqdn) {
  const context = currentAttempt(attemptId);
  if (sha !== context.approval.releaseSha || fqdn !== context.profile.fqdn) throw new Error('ATTEMPT_DEPLOYMENT_IDENTITY_MISMATCH');
  const record = context.checkpoint.record;
  if (!record.migrationCommitted || !record.predeployBackup || !record.invariantBaseline
    || !record.schemaChecked || !['HEALTH_PASSED','SMOKE_PASSED','POSTDEPLOY_BACKUP_INTENT',
      'POSTDEPLOY_BACKUP_PASSED','OBSERVATION_PASSED','ACCEPTED','COMPLETED'].includes(record.phase)) {
    throw new Error('DEPLOYMENT_STATE_INVALID');
  }
  verifyAttemptRelease(attemptId,'target');assertRetainedBackups(context);
  return withGuard(context,'target',async check => {
    await check();assertProcessAndHealth(context);
    const file = STATE_ROOT+'/'+context.approval.releaseSha+'.state';
    const missing = !existsSync(file);
    const projection = missing ? {
      oldRelease:'/opt/servora-med/releases/'+context.approval.oldReleaseSha,
      migrationsApplied:context.approval.targetCatalog.length-context.approval.oldCatalog.length,
    } : validateAttemptDeploymentState(trustedFile(file,0o600).toString('utf8'),context.approval);
    return {...projection,missing};
  });
}

/** No duration input exists. A fresh full interval is required after an
 * interrupted observation; completed backup/start operations are not repeated.
 */
export async function observeAttempt(attemptId) {
  const context = currentAttempt(attemptId);
  if (context.checkpoint.record.phase === 'ACCEPTED') {
    await completeAcceptedHandoff(context);return 'OBSERVATION=ALREADY_COMPLETED_OWNER_RETIRED';
  }
  verifyAttemptRelease(attemptId,'target'); assertRetainedBackups(context);
  if (!['POSTDEPLOY_BACKUP_PASSED','OBSERVATION_PASSED','ACCEPTED','COMPLETED'].includes(context.checkpoint.record.phase)) throw new Error('ATTEMPT_TRANSITION_INVALID');
  return withGuard(context,'target',async check => {
    if (context.checkpoint.record.phase === 'COMPLETED') {
      await check(); assertProcessAndHealth(context); assertBackupHealth(context);
      return retireCompletedOwner(context) ? 'OBSERVATION=ALREADY_COMPLETED_OWNER_RETIRED' : 'OBSERVATION=ALREADY_COMPLETED_READ_ONLY';
    }
    if (context.checkpoint.record.phase !== 'ACCEPTED') assertBarrier(context);
    let phase = context.checkpoint.record.phase;
    if (phase === 'POSTDEPLOY_BACKUP_PASSED') {
      const startEvidence = sampleTrustedTime();
      const startUTC = startEvidence.wallAtUTC;
      const start = process.hrtime.bigint();
      const boot = readFileSync('/proc/sys/kernel/random/boot_id','utf8');
      let samples = 0, pid, interrupted = false;
      const interrupt = () => { interrupted = true; };
      process.once('SIGTERM',interrupt); process.once('SIGINT',interrupt);
      const logDirectory = attemptLogDirectory(attemptId);
      const logFd = openSync(`${logDirectory}/observation-${randomUUID()}.log`,
        constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      flushDirectory(logDirectory);
      const emit = text => { writeFileSync(logFd,text+'\n'); fsyncSync(logFd); console.log(text); };
      emit('OBSERVATION_START_UTC='+startUTC);
      try {
        while (true) {
          if (interrupted) throw new Error('OBSERVATION_PARTIAL_INTERRUPTED');
          await check();
          const currentPid = assertProcessAndHealth(context); assertBackupHealth(context);
          if ((pid && pid !== currentPid) || readFileSync('/proc/sys/kernel/random/boot_id','utf8') !== boot
            || systemctl('show','servora-med.service','-p','Restart','--value') !== 'no') throw new Error('RECOVERY_OBSERVATION_UNSTABLE');
          pid = currentPid; samples++;
          const interval = elapsedTime(startEvidence,sampleTrustedTime());
          const hrMs = Number(process.hrtime.bigint()-start)/1000000;
          if (interval.status !== 'KNOWN' || hrMs+1 < interval.lowerMs || hrMs-1 > interval.upperMs) {
            throw new Error('RECOVERY_OBSERVATION_UNSTABLE');
          }
          const elapsedSeconds = Math.floor(Math.min(hrMs,interval.lowerMs)/1000);
          emit(`OBSERVATION_SAMPLE=${samples} UTC=${new Date().toISOString()} elapsed_seconds=${elapsedSeconds} health=PASS release=PASS backup=PASS pid=${pid}`);
          if (elapsedSeconds >= OBSERVATION_SECONDS) {
            phase = checkpointAttempt(attemptId,{kind:'OBSERVATION_PASSED',elapsedSeconds}).record.phase;
            emit('OBSERVATION_END_UTC='+new Date().toISOString()); break;
          }
          await delay(Math.min(30000,(OBSERVATION_SECONDS-elapsedSeconds)*1000));
        }
      } catch (error) {
        emit(`OBSERVATION_STOP_UTC=${new Date().toISOString()} samples=${samples} reason=${/^[A-Z_]+$/.test(error.message)?error.message:'CHECK_FAILED'}`);
        throw error;
      } finally { closeSync(logFd); process.removeListener('SIGTERM',interrupt); process.removeListener('SIGINT',interrupt); }
    }
    if (phase === 'OBSERVATION_PASSED') phase = checkpointAttempt(attemptId,'ACCEPTED').record.phase;
    await check(); assertProcessAndHealth(context); assertBackupHealth(context);
    if (phase !== 'ACCEPTED') throw new Error('ATTEMPT_TRANSITION_INVALID');
    handBackToSystemd(context);
    await settleGuard();
    checkpointAttempt(attemptId,'COMPLETED');
    unlinkSync(STATE_ROOT+'/active.json'); flushDirectory(STATE_ROOT);
    return 'OBSERVATION=PASS';
  });
}

export async function abortAttempt(attemptId) {
  await reconcileInitialization(loadAttempt(attemptId));
  const context = currentAttempt(attemptId);
  assertRetainedBackups(context);
  if (context.checkpoint.record.phase === 'ABORTED') {
    await completeAcceptedHandoff(context);return 'PRE_MIGRATION_ABORT=ALREADY_COMPLETED_OWNER_RETIRED';
  }
  if (context.checkpoint.record.phase === 'COMPLETED_ABORT') {
    verifyAttemptRelease(attemptId,'target'); verifyAttemptRelease(attemptId,'old');
    return withGuard(context,'old',async check => {
      await check(); assertProcessAndHealth(context,'old');
      return retireCompletedOwner(context) ? 'PRE_MIGRATION_ABORT=ALREADY_COMPLETED_OWNER_RETIRED' : 'PRE_MIGRATION_ABORT=ALREADY_COMPLETED_READ_ONLY';
    });
  }
  if (!context.approval.allowPreMigrationAbort || context.checkpoint.record.migrationCommitted
    || !['ADMITTED','BACKED_UP','FENCED','MIGRATION_INTENT','ABORTED'].includes(context.checkpoint.record.phase)) {
    throw new Error('PRE_MIGRATION_ABORT_NOT_AUTHORIZED');
  }
  verifyAttemptRelease(attemptId,'target'); // trusted pg runtime for the UID probe
  assertApprovedPointer(context.approval);
  // An early interruption (ADMITTED hello-window) may have no barrier yet;
  // only a same-owner barrier is ever created or reused below.
  if (context.checkpoint.record.phase !== 'ABORTED' && existsSync(STATE_ROOT+'/activation.block')) assertBarrier(context);
  return withGuard(context,'old',async check => {
    // DB OLD EXACT precedes every mutation and any barrier removal. Never
    // decide this from a retry's migrations_applied=0 or schema head alone.
    await check(); verifyAttemptRelease(attemptId,'old');
    if (context.checkpoint.record.phase !== 'ABORTED') {
      if (!existsSync(STATE_ROOT+'/activation.block')) writeAttemptBarrier(attemptId, context.approvalSha256);
      execFileSync('/bin/bash',['--noprofile','--norc','-c',
        'source /usr/local/libexec/servora-med/deploy-production-host; r4_suppress_restarts'],
        {env:COMMAND_ENV,timeout:40000,stdio:['ignore','pipe','pipe']});
      systemctl('stop','servora-med.service'); revokeStartPermit(attemptId);
      await settleGuard();
      checkpointAttempt(attemptId,'ABORT_INTENT');
      await check(); alignAttemptEnvironment(attemptId,'old');
      await check(); alignAttemptPointer(attemptId,'old');
      try {
        grantStartPermit(attemptId);
        systemctl('reset-failed','servora-med.service'); systemctl('start','servora-med.service');
        revokeStartPermit(attemptId);
        let healthy = false;
        for (let sample = 0; sample < 30; sample++) {
          await check();
          try { assertProcessAndHealth(context,'old'); healthy = true; break; } catch { await delay(1000); }
        }
        if (!healthy) throw new Error('PRE_MIGRATION_ABORT_HEALTH_FAILED');
        checkpointAttempt(attemptId,'ABORTED');
      } catch (error) {
        try { systemctl('stop','servora-med.service'); } catch { /* barrier stays */ }
        throw error; // Ambiguous/failed abort never restores normal restarts.
      } finally { revokeStartPermit(attemptId); }
    }
    await check(); assertProcessAndHealth(context,'old');
    handBackToSystemd(context);
    checkpointAttempt(attemptId,'COMPLETED_ABORT');
    unlinkSync(STATE_ROOT+'/active.json'); flushDirectory(STATE_ROOT);
    return 'PRE_MIGRATION_ABORT=COMPLETE_OLD_EXACT';
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, attemptId, ...extra] = process.argv.slice(2);
    assertBootstrapManagementAllowed('controller', attemptId);
    if (command === 'preflight' && extra.length === 0) {
      process.stdout.write(JSON.stringify(await preflightAttempt(attemptId))+'\n');
    } else if (command === 'inspect' && extra.length === 0) {
      process.stdout.write(JSON.stringify(loadAttempt(attemptId).approval)+'\n');
    } else if (command === 'match-deploy' && extra.length === 3) {
      await reconcileInitialization(loadAttempt(attemptId));
      const {approval,profile,approvalSha256: contextSha256} = loadAttempt(attemptId);
      const tuple = validateIdentityTuple(trustedFile(ENV_FILE,0o640,null).toString('utf8'),approval);
      // Every scope the normal deployment path unconditionally needs must be
      // granted before admission, backup, migration or any service mutation.
      if (!approval.allowMigration || !approval.allowForwardRecovery || !approval.allowPostdeployBackup) {
        throw new Error('ATTEMPT_DEPLOYMENT_SCOPES_INCOMPLETE');
      }
      if (extra[0] !== approval.releaseSha || extra[1] !== approval.artifactSha256
        || extra[2] !== profile.fqdn || realpathSync('/opt/servora-med/current') !== '/opt/servora-med/releases/'+approval.oldReleaseSha
        || tuple.release !== approval.oldReleaseSha || tuple.schema !== approval.oldCatalog.at(-1).version) throw new Error('ATTEMPT_DEPLOYMENT_IDENTITY_MISMATCH');
      validateBackupDatabase(profile);
      // A same-owner resume of an early, unmigrated attempt is admitted;
      // any other active owner, later phase or foreign barrier blocks a
      // fresh deployment binding. No claim is ever silently replaced.
      if (existsSync(STATE_ROOT+'/active.json')) {
        const active = readProtectedRecord(STATE_ROOT+'/active.json').record;
        const phase = readLatestCheckpoint(attemptId).record.phase;
        if (Object.keys(active).length !== 2 || active.attemptId !== attemptId
          || active.approvalSha256 !== contextSha256
          || !['ADMITTED','BACKED_UP','FENCED'].includes(phase)) throw new Error('RECOVERY_OTHER_ATTEMPT_ACTIVE');
        if (phase === 'FENCED' || (phase === 'BACKED_UP'
          && systemctl('show','servora-med.service','-p','MainPID','--value') === '0')) {
          await proveFencedResume(attemptId);
          process.stdout.write('ATTEMPT_FENCED_RESUME=YES\n');
        }
      }
      if (existsSync(STATE_ROOT+'/activation.block')) {
        let barrier;
        try { barrier = readProtectedRecord(STATE_ROOT+'/activation.block').record; }
        catch { throw new Error('RECOVERY_OTHER_ATTEMPT_ACTIVE'); }
        if (Object.keys(barrier).length !== 2 || barrier.attemptId !== attemptId
          || barrier.approvalSha256 !== contextSha256) throw new Error('RECOVERY_OTHER_ATTEMPT_ACTIVE');
      }
      process.stdout.write('ATTEMPT_DEPLOYMENT_BINDING_PASS\n');
    } else if (command === 'probe-old' && extra.length === 0) {
      const context = loadAttempt(attemptId);
      verifyAttemptRelease(attemptId,'target'); verifyAttemptRelease(attemptId,'old');
      await withGuard(context,'old',async check => { await check(); });
      process.stdout.write('ATTEMPT_OLD_DATABASE_EXACT_PASS\n');
    } else if (command === 'migration-log-path' && extra.length === 0) {
      process.stdout.write(attemptLogDirectory(attemptId)+'/migration.log\n');
    } else if (command === 'admit' && extra.length === 0) {
      const context = loadAttempt(attemptId);
      await reconcileInitialization(context);
      verifyAttemptRelease(attemptId,'old');verifyAttemptRelease(attemptId,'target');
      await withGuard(context,'old',async check=>{await check();});
      const resumePhase = existsSync(STATE_ROOT+'/active.json') ? readLatestCheckpoint(attemptId).record.phase : null;
      if (resumePhase === 'FENCED' || (resumePhase === 'BACKED_UP'
        && systemctl('show','servora-med.service','-p','MainPID','--value') === '0')) {
        await proveFencedResume(attemptId);
        process.stdout.write('ATTEMPT_RESUMED phase=FENCED\n');
        process.exitCode = 0;
      } else {
      const admitted = admitAttempt(attemptId);
      process.stdout.write(admitted.resumed
        ? 'ATTEMPT_RESUMED phase='+admitted.checkpoint.record.phase+'\n' : 'ATTEMPT_ADMITTED\n');
      }
    } else if (command === 'deployment-state' && extra.length === 2) {
      const state = await deploymentStateProjection(attemptId,...extra);
      process.stdout.write(`OLD_RELEASE=${state.oldRelease}\nMIGRATIONS_APPLIED=${state.migrationsApplied}\nSTATE_MISSING=${state.missing}\n`);
    } else if (command === 'migration-intent' && extra.length === 7) {
      const values = extra.map(value => Number(value));
      if (values.some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error('RECOVERY_CONTROLLER_ARGUMENTS_INVALID');
      await recordFreshMigrationIntent(attemptId,{organizations:values[0],admins:values[1],
        staff:values[2],customers:values[3],products:values[4],jobs:values[5],demoData:values[6]});
      process.stdout.write('ATTEMPT_EVENT_RECORDED\n');
    } else if (command === 'event' && extra.length === 1) {
      if (!['FENCED','SCHEMA_CHECKED','SMOKE_PASSED','POSTDEPLOY_BACKUP_INTENT'].includes(extra[0])) throw new Error('RECOVERY_CONTROLLER_ARGUMENTS_INVALID');
      checkpointAttempt(attemptId,extra[0]); process.stdout.write('ATTEMPT_EVENT_RECORDED\n');
    } else if (command === 'barrier' && extra.length === 0) {
      createAttemptBarrier(attemptId); process.stdout.write('ATTEMPT_BARRIER_CREATED\n');
    } else if (command === 'backup-receipt' && extra.length === 2) {
      sealBackupReceipt(attemptId,extra[0],extra[1]); process.stdout.write('ATTEMPT_BACKUP_SEALED\n');
    } else if (command === 'adopt-backup' && extra.length === 1) {
      sealBackupReceipt(attemptId,extra[0],null); process.stdout.write('ATTEMPT_BACKUP_ADOPTED\n');
    } else if (command === 'prepare-postdeploy' && extra.length === 2) {
      process.stdout.write(await preparePostdeploy(attemptId,...extra)+'\n');
    } else if (command === 'observe' && extra.length === 0) {
      process.stdout.write(await observeAttempt(attemptId)+'\n');
    } else if (command === 'recover' && extra.length === 0) {
      process.stdout.write(await recoverAttempt(attemptId)+'\n');
    } else if (command === 'abort' && extra.length === 0) {
      process.stdout.write(await abortAttempt(attemptId)+'\n');
    } else if (command === 'verify-release' && extra.length === 1 && ['old','target'].includes(extra[0])) {
      verifyAttemptRelease(attemptId,extra[0]);
      process.stdout.write('RECOVERY_RELEASE_PROOF_PASS\n');
    } else if (command === 'db-config' && extra.length === 1 && ['old','target'].includes(extra[0])) {
      const {approval,profile} = loadAttempt(attemptId);
      verifyAttemptCatalog(attemptId,'target');
      verifyAttemptCatalog(attemptId,extra[0]);
      process.stdout.write(JSON.stringify({releaseDirectory:'/opt/servora-med/releases/'+approval.releaseSha,
        expectedIdentity:profile.databaseIdentity,
        expectedCatalog:(extra[0] === 'old' ? approval.oldCatalog : approval.targetCatalog).map(entry => entry.version)})+'\n');
    } else throw new Error('RECOVERY_CONTROLLER_ARGUMENTS_INVALID');
  } catch (error) {
    // Print only our constant contract errors; no filesystem, connection or
    // protected environment values may reach the operator log.
    console.error(/^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'RECOVERY_CONTROLLER_FAILED');
    process.exitCode = 1;
  }
}
