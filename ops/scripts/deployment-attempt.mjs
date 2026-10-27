/** Fixed host-attempt data contract. Never source or evaluate journal text. */
import { classifyMigrationState } from './migration-reconciliation.mjs';
import { constants, lstatSync, openSync, fstatSync, readFileSync, closeSync,
  mkdirSync, writeFileSync, fsyncSync, linkSync, unlinkSync, readdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { validateDatabaseIdentity } from './deployment-db-guard.mjs';
import { elapsedTime, sampleTrustedTime, validateTimeEvidence } from './trusted-time.mjs';

const ATTEMPT_ROOT = '/var/lib/servora-med/deploy';
const ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Mandatory acceptance interval and the transition-phase budget that must
 * still fit inside the grant before admission consumes it. See the approval
 * contract in docs/operations/r4-forward-recovery.md.
 */
export const OBSERVATION_SECONDS = 1800;
export const TRANSITION_BUDGET_SECONDS = 1800;
export const REQUIRED_ADMISSION_WINDOW_SECONDS = OBSERVATION_SECONDS + TRANSITION_BUDGET_SECONDS;

const PROFILE_KEYS = ['formatVersion', 'machineId', 'fqdn', 'databaseIdentity', 'envBaselineSha256', 'contracts'];
const CONTRACT_KEYS = ['helperSha256', 'nodeSha256', 'unitSha256', 'attemptModuleSha256',
  'dbGuardModuleSha256', 'reconciliationModuleSha256', 'controllerModuleSha256',
  'timeModuleSha256', 'timeConfigSha256'];

export function validateHostProfile(record) {
  if (!record || Object.keys(record).length !== PROFILE_KEYS.length
    || PROFILE_KEYS.some(key => !Object.hasOwn(record,key)) || record.formatVersion !== 2
    || typeof record.machineId !== 'string' || !/^[0-9a-f]{32}$/.test(record.machineId)
    || typeof record.fqdn !== 'string' || record.fqdn.length > 253
    || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(record.fqdn)
    || typeof record.envBaselineSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(record.envBaselineSha256)
    || !record.contracts || Object.keys(record.contracts).length !== CONTRACT_KEYS.length
    || CONTRACT_KEYS.some(key => typeof record.contracts[key] !== 'string' || !/^[0-9a-f]{64}$/.test(record.contracts[key]))) {
    throw new Error('RECOVERY_HOST_PROFILE_INVALID');
  }
  try { validateDatabaseIdentity(record.databaseIdentity); }
  catch { throw new Error('RECOVERY_HOST_PROFILE_INVALID'); }
  return record;
}

export function readRootProfile(approval) {
  const { record, sha256 } = readProtectedRecord(`${ATTEMPT_ROOT}/profile.json`);
  const profile = validateHostProfile(record);
  if (sha256 !== approval.profileSha256) throw new Error('RECOVERY_HOST_PROFILE_MISMATCH');
  return profile;
}

/** Administrator-only issuance API; intentionally absent from the deploy CLI. */
export function issueRootApproval(fields, ttlMs) {
  if (process.getuid?.() !== 0 || !fields || ['formatVersion','issuedAtUTC','expiresAtUTC','issuedTime']
    .some(key => Object.hasOwn(fields,key)) || !Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 86400000) {
    throw new Error('ATTEMPT_APPROVAL_TIME_INVALID');
  }
  const issuedTime = sampleTrustedTime();
  const record = {...fields,formatVersion:2,issuedAtUTC:issuedTime.wallAtUTC,
    expiresAtUTC:new Date(Date.parse(issuedTime.wallAtUTC)+ttlMs).toISOString(),issuedTime};
  validateApprovalStructure(record); readRootProfile(record);
  const directory = ATTEMPT_ROOT+'/approvals';
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0
    || (info.mode & 0o7777) !== 0o700) throw new Error('ATTEMPT_FILE_UNTRUSTED');
  const file = directory+'/'+record.attemptId+'.json';
  const fd = openSync(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try { writeFileSync(fd,JSON.stringify(record)+'\n'); fsyncSync(fd); } finally { closeSync(fd); }
  flushDirectory(directory);
  return readProtectedRecord(file);
}

export function readProtectedRecord(file, expectedLinks = 1) {
  if (process.getuid?.() !== 0 || !file.startsWith(ATTEMPT_ROOT + '/')) {
    throw new Error('ATTEMPT_FILE_UNTRUSTED');
  }
  const components = file.split('/').slice(1, -1);
  let parent = '';
  for (const component of components) {
    parent += '/' + component;
    const info = lstatSync(parent);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0) {
      throw new Error('ATTEMPT_FILE_UNTRUSTED');
    }
  }
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (![1,2].includes(expectedLinks) || !info.isFile() || info.uid !== 0 || info.gid !== 0 || info.nlink !== expectedLinks
      || (info.mode & 0o7777) !== 0o600 || info.size > 32768) {
      throw new Error('ATTEMPT_FILE_UNTRUSTED');
    }
    const text = readFileSync(fd, 'utf8');
    return { record: parseCanonicalRecord(text), sha256: createHash('sha256').update(text).digest('hex') };
  } finally { closeSync(fd); }
}

export function readLatestCheckpoint(attemptId) {
  if (typeof attemptId !== 'string' || !ATTEMPT_ID.test(attemptId)) throw new Error('ATTEMPT_ID_INVALID');
  reconcileCheckpointResidues(attemptId);
  const files = readdirSync(`${ATTEMPT_ROOT}/attempts/${attemptId}`).sort();
  if (files.length === 0 || files.length >= 1000
    || files.some((file, index) => file !== `${String(index).padStart(4, '0')}.json`)) {
    throw new Error('ATTEMPT_CHECKPOINT_CHAIN_INVALID');
  }
  return readRootCheckpoint(attemptId, files.length - 1);
}

function flushDirectory(directory) {
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Private temporary names of the exclusive checkpoint publication protocol.
 * A crash between the final link and the temp unlink leaves exactly this
 * artifact; it is provably ours (protected per-attempt directory, root owner,
 * 0600, regular file, single or paired link). Anything else is foreign.
 */
const CHECKPOINT_RESIDUE = /^\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;

function trustedCheckpointDirectory(attemptId) {
  if (process.getuid?.() !== 0 || typeof attemptId !== 'string' || !ATTEMPT_ID.test(attemptId)) {
    throw new Error('ATTEMPT_FILE_UNTRUSTED');
  }
  const directory = `${ATTEMPT_ROOT}/attempts/${attemptId}`;
  let parent = '';
  for (const component of directory.split('/').slice(1)) {
    parent += '/' + component;
    const info = lstatSync(parent);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0) {
      throw new Error('ATTEMPT_FILE_UNTRUSTED');
    }
  }
  return directory;
}

/** Complete an interrupted exclusive publication idempotently. The record is
 * already durably linked under its final name; only the private temp name of
 * the same inode (or an unlinked pre-link temp) may linger. Foreign artifacts
 * are still rejected and never repaired. Readers run this before listing so a
 * crash inside the link/unlink window cannot present the chain as corrupt.
 */
function reconcileCheckpointResidues(attemptId) {
  const directory = trustedCheckpointDirectory(attemptId);
  for (const name of readdirSync(directory)) {
    if (!CHECKPOINT_RESIDUE.test(name)) continue;
    const path = `${directory}/${name}`;
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0
      || (info.mode & 0o7777) !== 0o600 || info.size > 32768 || ![1, 2].includes(info.nlink)) {
      throw new Error('ATTEMPT_CHECKPOINT_CHAIN_INVALID');
    }
    unlinkSync(path);
    flushDirectory(directory);
  }
}

function ensureCheckpointDirectory(attemptId) {
  if (process.getuid?.() !== 0 || typeof attemptId !== 'string' || !ATTEMPT_ID.test(attemptId)) {
    throw new Error('ATTEMPT_FILE_UNTRUSTED');
  }
  const directory = `${ATTEMPT_ROOT}/attempts/${attemptId}`;
  let parent = '';
  for (const component of directory.split('/').slice(1)) {
    const previous = parent || '/';
    parent += '/' + component;
    try {
      const info = lstatSync(parent);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0) {
        throw new Error('ATTEMPT_FILE_UNTRUSTED');
      }
    } catch (error) {
      if (error.code !== 'ENOENT' || !parent.startsWith(ATTEMPT_ROOT + '/')) throw error;
      mkdirSync(parent, { mode: 0o700 });
      flushDirectory(previous);
    }
  }
  return directory;
}

/** Persistence primitive only, not phase admission. Callers must hold the
 * common host lock and validate the journal transition before appending it.
 * Exclusive link publication cannot replace an already reserved start intent.
 */
export function appendRootCheckpoint(attemptId, record) {
  const directory = ensureCheckpointDirectory(attemptId);
  // A previous append may have been killed between its exclusive link and the
  // temp-name unlink; finish that publication before the chain is re-read.
  reconcileCheckpointResidues(attemptId);
  if (record?.attemptId !== attemptId || !Number.isSafeInteger(record.sequence)
    || record.sequence < 0 || record.sequence >= 1000) throw new Error('ATTEMPT_CHECKPOINT_INVALID');
  const text = JSON.stringify(record) + '\n';
  parseCanonicalRecord(text);
  if (record.sequence === 0 ? record.previousHash !== null
    : record.previousHash !== readRootCheckpoint(attemptId, record.sequence - 1).sha256) {
    throw new Error('ATTEMPT_CHECKPOINT_CHAIN_INVALID');
  }
  const file = `${directory}/${String(record.sequence).padStart(4, '0')}.json`;
  const temporary = `${directory}/.${randomUUID()}.tmp`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, text, 'utf8');
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try {
    try { linkSync(temporary, file); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error('ATTEMPT_CHECKPOINT_EXISTS');
      throw error;
    }
  } finally { unlinkSync(temporary); }
  flushDirectory(directory);
  return readRootCheckpoint(attemptId, record.sequence);
}

export function readRootCheckpoint(attemptId, sequence) {
  if (typeof attemptId !== 'string' || !ATTEMPT_ID.test(attemptId)
    || !Number.isSafeInteger(sequence) || sequence < 0 || sequence >= 1000) {
    throw new Error('ATTEMPT_CHECKPOINT_INVALID');
  }
  let previousHash = null;
  let checkpoint;
  for (let index = 0; index <= sequence; index += 1) {
    checkpoint = readProtectedRecord(`${ATTEMPT_ROOT}/attempts/${attemptId}/${String(index).padStart(4, '0')}.json`);
    if (checkpoint.record.attemptId !== attemptId || checkpoint.record.sequence !== index
      || checkpoint.record.previousHash !== previousHash) throw new Error('ATTEMPT_CHECKPOINT_CHAIN_INVALID');
    previousHash = checkpoint.sha256;
  }
  return checkpoint;
}

export function readRootApproval(attemptId) {
  if (typeof attemptId !== 'string' || !ATTEMPT_ID.test(attemptId)) {
    throw new Error('ATTEMPT_ID_INVALID');
  }
  const { record, sha256 } = readProtectedRecord(`${ATTEMPT_ROOT}/approvals/${attemptId}.json`);
  validateApprovalStructure(record);
  if (record.attemptId !== attemptId) throw new Error('ATTEMPT_APPROVAL_IDENTITY_INVALID');
  const context = {approval:record,approvalSha256:sha256};
  // Consumption begins at the sealed initial record, before owner/checkpoint
  // publication. Existence alone is never authority: validate its exact bytes,
  // grant digest, original admission window and the only permitted inode pair.
  const first = `${ATTEMPT_ROOT}/attempts/${attemptId}/0000.json`;
  const marker = `${ATTEMPT_ROOT}/initializations/${attemptId}.json`;
  const stat = path => { try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  const firstInfo = stat(first), markerInfo = stat(marker);
  let admitted = false;
  if (firstInfo || markerInfo) {
    let links = 1;
    if (firstInfo && markerInfo) {
      if (firstInfo.dev !== markerInfo.dev || firstInfo.ino !== markerInfo.ino) throw new Error('RECOVERY_INITIALIZATION_CONFLICT');
      links = 2;
    }
    const initial = readProtectedRecord(markerInfo ? marker : first, links).record;
    if (JSON.stringify(initial) !== JSON.stringify(initialAttempt(context,initial.admissionTime))) {
      throw new Error('RECOVERY_INITIALIZATION_CONFLICT');
    }
    if (markerInfo) {
      const activeInfo = stat(`${ATTEMPT_ROOT}/active.json`);
      if (activeInfo) {
        const active = readProtectedRecord(`${ATTEMPT_ROOT}/active.json`).record;
        if (Object.keys(active).length !== 2 || active.attemptId !== attemptId || active.approvalSha256 !== sha256) {
          throw new Error('RECOVERY_OTHER_ATTEMPT_ACTIVE');
        }
      }
    }
    const confirmation = readRootAdmissionConfirmation(context,initial);
    if (!confirmation) {
      // A reservation without confirmation cannot become historical authority.
      // Only a same-boot, zero-progress marker may finish within the ORIGINAL window.
      if (!markerInfo || firstInfo || stat(`${ATTEMPT_ROOT}/active.json`)) throw new Error('RECOVERY_ADMISSION_CONFIRMATION_MISSING');
      initialAttempt(context,sampleTrustedTime());
      return {...context,admissionTime:initial.admissionTime,initializationPending:true};
    }
    admitted = true;
    context.admissionTime = initial.admissionTime;
  }
  if (!admitted && readRootAdmissionConfirmation(context,null)) throw new Error('RECOVERY_ADMISSION_CONFIRMATION_INVALID');
  const approval = admitted ? consumedApproval(record) : validateApproval(record);
  return { ...context, approval };
}

export function parseCanonicalRecord(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 32768) {
    throw new Error('ATTEMPT_RECORD_NOT_CANONICAL');
  }
  let record;
  try { record = JSON.parse(text); } catch { throw new Error('ATTEMPT_RECORD_NOT_CANONICAL'); }
  if (record === null || typeof record !== 'object' || Array.isArray(record)
    || JSON.stringify(record) + '\n' !== text) {
    throw new Error('ATTEMPT_RECORD_NOT_CANONICAL');
  }
  return record;
}

const APPROVAL_KEYS = Object.freeze([
  'formatVersion', 'attemptId', 'releaseSha', 'treeSha', 'artifactSha256',
  'ciManifestSha256', 'targetCatalog', 'oldReleaseSha', 'oldArtifactSha256',
  'oldCatalog', 'profileSha256', 'issuedAtUTC', 'expiresAtUTC', 'maxStarts',
  'maxAbortStarts', 'allowMigration', 'allowForwardRecovery',
  'allowPreMigrationAbort', 'allowPostdeployBackup',
  'issuedTime',
]);

export function validateApprovalStructure(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)
    || Object.keys(record).length !== APPROVAL_KEYS.length
    || APPROVAL_KEYS.some((key) => !Object.hasOwn(record, key))) {
    throw new Error('ATTEMPT_APPROVAL_KEYS_INVALID');
  }
  const issued = Date.parse(record.issuedAtUTC);
  const expires = Date.parse(record.expiresAtUTC);
  const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  if (!utc.test(record.issuedAtUTC) || !utc.test(record.expiresAtUTC)
    || !Number.isFinite(issued) || !Number.isFinite(expires)
    || new Date(issued).toISOString() !== record.issuedAtUTC
    || new Date(expires).toISOString() !== record.expiresAtUTC
    || expires <= issued || expires - issued > 24 * 60 * 60 * 1000) {
    throw new Error('ATTEMPT_APPROVAL_TIME_INVALID');
  }
  if (record.formatVersion !== 2
    || typeof record.attemptId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(record.attemptId)
    || ['releaseSha', 'oldReleaseSha', 'treeSha'].some((key) =>
      typeof record[key] !== 'string' || !/^[0-9a-f]{40}$/.test(record[key]))
    || ['artifactSha256', 'oldArtifactSha256', 'ciManifestSha256', 'profileSha256'].some((key) =>
      typeof record[key] !== 'string' || !/^[0-9a-f]{64}$/.test(record[key]))) {
    throw new Error('ATTEMPT_APPROVAL_IDENTITY_INVALID');
  }
  for (const catalog of [record.oldCatalog, record.targetCatalog]) {
    if (!Array.isArray(catalog) || catalog.length === 0 || catalog.length > 999
      || catalog.some((entry) => entry === null || typeof entry !== 'object'
        || Array.isArray(entry) || Object.keys(entry).length !== 2
        || !Object.hasOwn(entry, 'version') || !Object.hasOwn(entry, 'sha256')
        || typeof entry.version !== 'string'
        || typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256))
      || classifyMigrationState(catalog.map((entry) => entry.version),
        catalog.map((entry) => entry.version)).status !== 'EXACT') {
      throw new Error('ATTEMPT_APPROVAL_CATALOG_INVALID');
    }
  }
  const relation = classifyMigrationState(record.targetCatalog.map((entry) => entry.version),
    record.oldCatalog.map((entry) => entry.version));
  if (!['EXACT', 'PREFIX_WITH_PENDING'].includes(relation.status)
    || record.oldCatalog.some((entry, index) => entry.sha256 !== record.targetCatalog[index]?.sha256)) {
    throw new Error('ATTEMPT_APPROVAL_CATALOG_INVALID');
  }
  if (!Number.isInteger(record.maxStarts) || record.maxStarts < 1 || record.maxStarts > 2
    || !Number.isInteger(record.maxAbortStarts) || record.maxAbortStarts < 0 || record.maxAbortStarts > 1
    || ['allowMigration', 'allowForwardRecovery', 'allowPreMigrationAbort', 'allowPostdeployBackup']
      .some((key) => typeof record[key] !== 'boolean')) {
    throw new Error('ATTEMPT_APPROVAL_SCOPE_INVALID');
  }
  validateTimeEvidence(record.issuedTime);
  if (record.issuedTime.wallAtUTC !== record.issuedAtUTC) throw new Error('ATTEMPT_APPROVAL_TIME_INVALID');
  return record;
}

export function validateApproval(record, current = sampleTrustedTime()) {
  validateApprovalStructure(record);
  const age = elapsedTime(record.issuedTime,current);
  if (age.status !== 'KNOWN') throw new Error('TRUSTED_TIME_UNKNOWN');
  const now = Date.parse(current.wallAtUTC);
  const issued = Date.parse(record.issuedAtUTC);
  const expires = Date.parse(record.expiresAtUTC);
  if (issued > now || expires <= now || age.upperMs >= expires-issued) {
    throw new Error('ATTEMPT_APPROVAL_TIME_INVALID');
  }
  return record;
}

/** Consumed-authority contract: a grant is fully validated before admission
 * (including the mandatory remaining window). Admission itself is the one
 * durable consumption of that authority; afterwards the attempt may still be
 * driven to a terminal state although the wall-clock expiry has passed.
 * Structure, scopes, budgets and issuance-vs-reference ordering stay enforced.
 */
function consumedApproval(record) {
  validateApprovalStructure(record);
  return record;
}

/** Catalog admission only; the host still must prove the same DB identity,
 * migration lock, immutable OLD release and attempt before changing a barrier.
 */
export function assertPreMigrationAbortCompatibility(approval, appliedVersions, current = sampleTrustedTime()) {
  consumedApproval(approval);
  validateTimeEvidence(current);
  if (!approval.allowPreMigrationAbort || approval.maxAbortStarts === 0) {
    throw new Error('PRE_MIGRATION_ABORT_NOT_AUTHORIZED');
  }
  if (classifyMigrationState(approval.oldCatalog.map((entry) => entry.version), appliedVersions).status !== 'EXACT') {
    throw new Error('PRE_MIGRATION_ABORT_DB_NOT_OLD_EXACT');
  }
}

const JOURNAL_KEYS = Object.freeze([
  'formatVersion', 'attemptId', 'approvalSha256', 'profileSha256', 'sequence',
  'previousHash', 'phase', 'starts', 'abortStarts', 'migrationCommitted',
  'lastStart', 'predeployBackup', 'postdeployBackup', 'smokePassed',
  'observationPassed', 'invariantBaseline', 'schemaChecked', 'updatedAtUTC',
  'admissionTime', 'timeEvidence',
]);
const JOURNAL_PHASES = new Set(['ADMITTED','BACKED_UP','FENCED','MIGRATION_INTENT','DB_EXACT',
  'ENV_INTENT','ENV_ALIGNED','POINTER_INTENT','POINTER_ALIGNED','START_INTENT','START_FAILED',
  'HEALTH_PASSED','SMOKE_PASSED','POSTDEPLOY_BACKUP_INTENT','POSTDEPLOY_BACKUP_PASSED',
  'OBSERVATION_PASSED','ACCEPTED','ABORT_INTENT','ABORTED','COMPLETED','COMPLETED_ABORT']);
const INVARIANT_KEYS = Object.freeze(['organizations','admins','staff','customers','products','jobs','demoData']);

function validUTC(value, now) {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time <= now && new Date(time).toISOString() === value;
}

function validReceipt(value, now) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 2 && typeof value.sha256 === 'string'
    && /^[0-9a-f]{64}$/.test(value.sha256) && validUTC(value.completedAtUTC,now);
}

/** Aggregate, non-sensitive business-row counts captured before migration.
 * Persisted so an interruption after COMMIT cannot lose the comparison base.
 */
function validInvariantBaseline(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === INVARIANT_KEYS.length
    && INVARIANT_KEYS.every(key => Number.isSafeInteger(value[key]) && value[key] >= 0);
}

export function initialAttempt(context, current = sampleTrustedTime()) {
  const approval = validateApproval(context.approval, current);
  const now = Date.parse(current.wallAtUTC);
  const age = elapsedTime(approval.issuedTime,current);
  // Before the first durable mutation, the grant must still cover the full
  // mandatory acceptance interval plus the transition-phase budget. This is
  // the one point where the wall-clock window is proven; admission consumes it.
  if (Date.parse(approval.expiresAtUTC) - now < REQUIRED_ADMISSION_WINDOW_SECONDS * 1000
    || Date.parse(approval.expiresAtUTC)-Date.parse(approval.issuedAtUTC)-age.upperMs < REQUIRED_ADMISSION_WINDOW_SECONDS*1000) {
    throw new Error('ATTEMPT_APPROVAL_WINDOW_INSUFFICIENT');
  }
  if (typeof context.approvalSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(context.approvalSha256)) {
    throw new Error('ATTEMPT_JOURNAL_INVALID');
  }
  return { formatVersion: 2, attemptId: approval.attemptId,
    approvalSha256: context.approvalSha256, profileSha256: approval.profileSha256,
    sequence: 0, previousHash: null, phase: 'ADMITTED', starts: 0, abortStarts: 0,
    migrationCommitted: false, lastStart: 'none', predeployBackup: null,
    postdeployBackup: null, smokePassed: false, observationPassed: false,
    invariantBaseline: null, schemaChecked: false, updatedAtUTC: current.wallAtUTC,
    admissionTime: current, timeEvidence: current };
}

const CONFIRMATION_KEYS = ['formatVersion','attemptId','approvalSha256','initialSha256','postFsyncTime'];

export function validateAdmissionConfirmation(context, initial, proof) {
  if (!proof || Object.keys(proof).length !== CONFIRMATION_KEYS.length
    || CONFIRMATION_KEYS.some(key => !Object.hasOwn(proof,key)) || proof.formatVersion !== 2
    || proof.attemptId !== context.approval.attemptId || proof.approvalSha256 !== context.approvalSha256
    || proof.initialSha256 !== createHash('sha256').update(JSON.stringify(initial)+'\n').digest('hex')
    || JSON.stringify(initial) !== JSON.stringify(initialAttempt(context,initial?.admissionTime))) {
    throw new Error('RECOVERY_ADMISSION_CONFIRMATION_INVALID');
  }
  // A post-fsync sample still inside the original window proves the first
  // publication was timely. Persisted evidence is historical, not a new lease.
  initialAttempt(context,proof.postFsyncTime);
  if (elapsedTime(initial.admissionTime,proof.postFsyncTime).status !== 'KNOWN') {
    throw new Error('RECOVERY_ADMISSION_CONFIRMATION_INVALID');
  }
  return proof;
}

export function admissionConfirmation(context, initial, postFsyncTime = sampleTrustedTime()) {
  return validateAdmissionConfirmation(context,initial,{formatVersion:2,attemptId:context.approval.attemptId,
    approvalSha256:context.approvalSha256,initialSha256:createHash('sha256').update(JSON.stringify(initial)+'\n').digest('hex'),postFsyncTime});
}

const PROOF_ROOT = ATTEMPT_ROOT+'/admission-proofs';
const PROOF_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;

function proofFiles(attemptId) {
  if (process.getuid?.() !== 0 || !ATTEMPT_ID.test(attemptId)) throw new Error('ATTEMPT_FILE_UNTRUSTED');
  let info;
  try { info = lstatSync(PROOF_ROOT); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0
    || (info.mode & 0o7777) !== 0o700) throw new Error('ATTEMPT_FILE_UNTRUSTED');
  const final = PROOF_ROOT+'/'+attemptId+'.json', temporary = PROOF_ROOT+'/.admission-'+attemptId+'.tmp';
  let pair = false;
  for (const name of readdirSync(PROOF_ROOT)) {
    if (PROOF_NAME.test(name)) continue;
    if (PROOF_ROOT+'/'+name !== temporary) throw new Error('RECOVERY_ADMISSION_CONFIRMATION_FOREIGN');
    const temp = lstatSync(temporary);
    let published;
    try { published = lstatSync(final); } catch { throw new Error('RECOVERY_ADMISSION_CONFIRMATION_INCOMPLETE'); }
    if (temp.dev !== published.dev || temp.ino !== published.ino) throw new Error('RECOVERY_ADMISSION_CONFIRMATION_FOREIGN');
    pair = true;
  }
  return {final,temporary,links:pair?2:1};
}

/** Read-only: paired publication residue is recognized but never removed here. */
export function readRootAdmissionConfirmation(context, initial) {
  const paths = proofFiles(context.approval.attemptId);
  if (!paths) return null;
  let proof;
  try { proof = readProtectedRecord(paths.final,paths.links).record; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!initial) throw new Error('RECOVERY_ADMISSION_CONFIRMATION_INVALID');
  return validateAdmissionConfirmation(context,initial,proof);
}

/** Caller holds the host lock and has proved fresh OLD EXACT/zero-progress state. */
export function publishRootAdmissionConfirmation(context, initial) {
  const existing = readRootAdmissionConfirmation(context,initial);
  if (!existing) {
    if (!proofFiles(context.approval.attemptId)) {
      mkdirSync(PROOF_ROOT,{mode:0o700}); flushDirectory(ATTEMPT_ROOT);
    }
    // On a retry, re-flush the exact reserved marker before taking the post sample.
    const marker = ATTEMPT_ROOT+'/initializations/'+context.approval.attemptId+'.json';
    if (JSON.stringify(readProtectedRecord(marker).record) !== JSON.stringify(initial)) throw new Error('RECOVERY_INITIALIZATION_CONFLICT');
    const markerFd = openSync(marker,constants.O_RDONLY|constants.O_NOFOLLOW);
    try { fsyncSync(markerFd); } finally { closeSync(markerFd); }
    flushDirectory(ATTEMPT_ROOT+'/initializations');
    const proof = admissionConfirmation(context,initial);
    const paths = proofFiles(context.approval.attemptId);
    const fd = openSync(paths.temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try { writeFileSync(fd,JSON.stringify(proof)+'\n'); fsyncSync(fd); } finally { closeSync(fd); }
    linkSync(paths.temporary,paths.final);
    flushDirectory(PROOF_ROOT);
  }
  const paths = proofFiles(context.approval.attemptId);
  // Both fresh and interrupted publication are durable before owner/side effects.
  readRootAdmissionConfirmation(context,initial);
  flushDirectory(PROOF_ROOT);
  if (paths.links === 2) { unlinkSync(paths.temporary); flushDirectory(PROOF_ROOT); }
  return readRootAdmissionConfirmation(context,initial);
}

/** Only completed acceptance or a successful never-migrated abort may give
 * ownership back. A phase label alone is not proof of downstream gates.
 */
export function acceptedHandoffDirection(journal, context, now = sampleTrustedTime()) {
  advanceAttempt(journal,context,'VALIDATE',now);
  if (journal.phase === 'ACCEPTED' && context.approval.allowForwardRecovery
    && context.approval.allowPostdeployBackup && journal.migrationCommitted
    && journal.starts > 0 && journal.lastStart === 'pass' && journal.predeployBackup
    && journal.postdeployBackup && journal.invariantBaseline && journal.schemaChecked
    && journal.smokePassed && journal.observationPassed) return 'target';
  if (journal.phase === 'ABORTED' && context.approval.allowPreMigrationAbort
    && !journal.migrationCommitted && journal.starts === 0 && journal.abortStarts === 1
    && journal.lastStart === 'pass') return 'old';
  throw new Error('RECOVERY_HANDOFF_EVIDENCE_MISSING');
}

/** Reserve a start before invoking systemd. Persist the returned checkpoint
 * with file+directory fsync before executing any start operation.
 */
export function advanceAttempt(journal, context, event, current = sampleTrustedTime()) {
  const approval = validateApprovalStructure(context.approval);
  validateTimeEvidence(current);
  const now = Date.parse(current.wallAtUTC);
  if (journal === null || typeof journal !== 'object' || Array.isArray(journal)
    || Object.keys(journal).length !== JOURNAL_KEYS.length
    || JOURNAL_KEYS.some((key) => !Object.hasOwn(journal, key))
    || journal.formatVersion !== 2 || journal.attemptId !== approval.attemptId
    || typeof context.approvalSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(context.approvalSha256)
    || journal.approvalSha256 !== context.approvalSha256
    || journal.profileSha256 !== approval.profileSha256
    || !Number.isSafeInteger(journal.sequence) || journal.sequence < 0 || journal.sequence >= 1000
    || !(journal.previousHash === null || /^[0-9a-f]{64}$/.test(journal.previousHash))
    || !Number.isInteger(journal.starts) || journal.starts < 0 || journal.starts > approval.maxStarts
    || !Number.isInteger(journal.abortStarts) || journal.abortStarts < 0 || journal.abortStarts > approval.maxAbortStarts
    || !JOURNAL_PHASES.has(journal.phase)
    || (journal.predeployBackup !== null && !validReceipt(journal.predeployBackup,now))
    || (journal.postdeployBackup !== null && !validReceipt(journal.postdeployBackup,now))
    || (journal.invariantBaseline !== null && !validInvariantBaseline(journal.invariantBaseline))
    || typeof journal.migrationCommitted !== 'boolean' || typeof journal.smokePassed !== 'boolean'
    || typeof journal.schemaChecked !== 'boolean'
    || typeof journal.observationPassed !== 'boolean'
    || !['none', 'intent', 'pass', 'fail'].includes(journal.lastStart)
    || !validUTC(journal.updatedAtUTC,Infinity)) {
    throw new Error('ATTEMPT_JOURNAL_INVALID');
  }
  // The grant was consumed at admission: wall-clock expiry no longer blocks
  // the already-authorized transition, but a grant issued after the durable
  // journal timeline was never the one consumed here.
  // Historical admission is checked against the original issue anchor, never
  // reconstructed by passing an old wall timestamp as the current clock.
  initialAttempt(context,journal.admissionTime);
  validateTimeEvidence(journal.timeEvidence);
  if (journal.updatedAtUTC !== journal.timeEvidence.wallAtUTC
    || (context.admissionTime && JSON.stringify(context.admissionTime) !== JSON.stringify(journal.admissionTime))
    || (journal.timeEvidence.bootId === current.bootId
      && (journal.timeEvidence.timeNamespaceId !== current.timeNamespaceId
        || current.bootLowerMs < journal.timeEvidence.bootLowerMs
        || current.bootUpperMs < journal.timeEvidence.bootUpperMs))) {
    throw new Error('TRUSTED_TIME_UNKNOWN');
  }
  // No new lifetime is granted here. Historical consumption, phase and budgets
  // authorize this command. Fresh infrastructure evidence is mandatory, but a
  // corrected UTC label cannot retroactively change consumption. Continuous
  // elapsed/UTC consistency is independently required by observation.
  if (event === 'VALIDATE') return journal;
  const kind = typeof event === 'string' ? event : event?.kind;
  const next = { ...journal, sequence: journal.sequence + 1, updatedAtUTC: current.wallAtUTC, timeEvidence: current };
  if (kind === 'PREDEPLOY_BACKUP') {
    const receipt = event.receipt;
    if (journal.phase !== 'ADMITTED' || !validReceipt(receipt,now)) throw new Error('ATTEMPT_TRANSITION_INVALID');
    return { ...next, phase: 'BACKED_UP', predeployBackup: receipt };
  }
  if (kind === 'FENCED') {
    if (journal.phase !== 'BACKED_UP' || !journal.predeployBackup) throw new Error('ATTEMPT_TRANSITION_INVALID');
    return { ...next, phase: 'FENCED' };
  }
  if (kind === 'MIGRATION_INTENT') {
    const baseline = event?.baseline;
    if (journal.phase !== 'FENCED' || !approval.allowMigration
      || !approval.allowForwardRecovery || !approval.allowPostdeployBackup
      || !validInvariantBaseline(baseline)) throw new Error('ATTEMPT_TRANSITION_INVALID');
    return { ...next, phase: 'MIGRATION_INTENT',
      invariantBaseline: Object.fromEntries(INVARIANT_KEYS.map(key => [key, baseline[key]])) };
  }
  const transitions = {
    DB_EXACT: ['FENCED', 'MIGRATION_INTENT'],
    ENV_INTENT: ['DB_EXACT'], ENV_ALIGNED: ['ENV_INTENT'],
    POINTER_INTENT: ['ENV_ALIGNED'], POINTER_ALIGNED: ['POINTER_INTENT'],
    START_FAILED: ['START_INTENT'],
    HEALTH_PASSED: ['START_INTENT'], SMOKE_PASSED: ['HEALTH_PASSED'],
    POSTDEPLOY_BACKUP_INTENT: ['SMOKE_PASSED'],
    ABORTED: ['ABORT_INTENT'],
    COMPLETED_ABORT: ['ABORTED'],
  };
  if (Object.hasOwn(transitions, kind)) {
    if (!transitions[kind].includes(journal.phase)) throw new Error('ATTEMPT_TRANSITION_INVALID');
    if (kind === 'POSTDEPLOY_BACKUP_INTENT' && !approval.allowPostdeployBackup) throw new Error('ATTEMPT_TRANSITION_INVALID');
    if (kind === 'COMPLETED_ABORT') acceptedHandoffDirection(journal,context,current);
    if (kind === 'DB_EXACT' && (!journal.predeployBackup || !journal.invariantBaseline)) throw new Error('ATTEMPT_TRANSITION_INVALID');
    if (kind === 'SMOKE_PASSED' && !journal.schemaChecked) throw new Error('ATTEMPT_TRANSITION_INVALID');
    return { ...next, phase: kind,
      migrationCommitted: kind === 'DB_EXACT' ? true : journal.migrationCommitted,
      lastStart: kind === 'START_FAILED' ? 'fail' : ['HEALTH_PASSED', 'ABORTED'].includes(kind) ? 'pass' : journal.lastStart,
      smokePassed: kind === 'SMOKE_PASSED' ? true : journal.smokePassed };
  }
  if (kind === 'POSTDEPLOY_BACKUP_PASSED') {
    const receipt = event.receipt;
    if (journal.phase !== 'POSTDEPLOY_BACKUP_INTENT' || !approval.allowPostdeployBackup
      || !validReceipt(receipt,now)) throw new Error('ATTEMPT_TRANSITION_INVALID');
    return { ...next, phase: kind, postdeployBackup: receipt };
  }
  if (kind === 'OBSERVATION_PASSED') {
    if (journal.phase !== 'POSTDEPLOY_BACKUP_PASSED' || !journal.smokePassed || !journal.postdeployBackup
      || !Number.isSafeInteger(event.elapsedSeconds) || event.elapsedSeconds < OBSERVATION_SECONDS) throw new Error('ATTEMPT_TRANSITION_INVALID');
    return { ...next, phase: kind, observationPassed: true };
  }
  if (kind === 'ACCEPTED') {
    if (journal.phase !== 'OBSERVATION_PASSED' || !journal.observationPassed
      || !journal.smokePassed || !journal.postdeployBackup) throw new Error('ATTEMPT_TRANSITION_INVALID');
    return { ...next, phase: kind };
  }
  if (kind === 'COMPLETED') {
    if (journal.phase !== 'ACCEPTED') throw new Error('ATTEMPT_TRANSITION_INVALID');
    acceptedHandoffDirection(journal,context,current);
    return {...next,phase:kind};
  }
  if (kind === 'SCHEMA_CHECKED') {
    // Durable record of a passing schema gate. Only a healthy, activated
    // candidate may carry it; completion gates read it, never assume it.
    if (journal.phase !== 'HEALTH_PASSED') throw new Error('ATTEMPT_TRANSITION_INVALID');
    return { ...next, phase: 'HEALTH_PASSED', schemaChecked: true };
  }
  if (kind === 'ABORT_INTENT') {
    if (!['ADMITTED', 'BACKED_UP', 'FENCED', 'MIGRATION_INTENT'].includes(journal.phase) || journal.migrationCommitted
      || !approval.allowPreMigrationAbort || journal.abortStarts >= approval.maxAbortStarts) {
      throw new Error('ATTEMPT_TRANSITION_INVALID');
    }
    return { ...next, phase: 'ABORT_INTENT', abortStarts: journal.abortStarts + 1, lastStart: 'intent' };
  }
  if (kind === 'HEALTH_LOST') {
    if (journal.phase !== 'HEALTH_PASSED' || journal.smokePassed) throw new Error('ATTEMPT_TRANSITION_INVALID');
    if (journal.starts >= approval.maxStarts) throw new Error('ATTEMPT_START_BUDGET_EXHAUSTED');
    return {...next,phase:'START_FAILED',lastStart:'fail'};
  }
  if (kind !== 'START_INTENT') throw new Error('ATTEMPT_EVENT_INVALID');
  if (journal.lastStart === 'intent') throw new Error('ATTEMPT_START_AMBIGUOUS');
  if (!['POINTER_ALIGNED', 'START_FAILED'].includes(journal.phase)
    || !approval.allowForwardRecovery) throw new Error('ATTEMPT_START_NOT_AUTHORIZED');
  if (journal.starts >= approval.maxStarts) throw new Error('ATTEMPT_START_BUDGET_EXHAUSTED');
  return { ...next, phase: 'START_INTENT', starts: journal.starts + 1, lastStart: 'intent' };
}
