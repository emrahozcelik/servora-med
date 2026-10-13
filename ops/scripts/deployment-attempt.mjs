/** Fixed host-attempt data contract. Never source or evaluate journal text. */
import { classifyMigrationState } from './migration-reconciliation.mjs';
import { constants, lstatSync, openSync, fstatSync, readFileSync, closeSync,
  mkdirSync, writeFileSync, fsyncSync, linkSync, unlinkSync, readdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { validateDatabaseIdentity } from './deployment-db-guard.mjs';

const ATTEMPT_ROOT = '/var/lib/servora-med/deploy';
const ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const PROFILE_KEYS = ['formatVersion', 'machineId', 'fqdn', 'databaseIdentity', 'envBaselineSha256', 'contracts'];
const CONTRACT_KEYS = ['helperSha256', 'nodeSha256', 'unitSha256', 'attemptModuleSha256',
  'dbGuardModuleSha256', 'reconciliationModuleSha256', 'controllerModuleSha256'];

export function validateHostProfile(record) {
  if (!record || Object.keys(record).length !== PROFILE_KEYS.length
    || PROFILE_KEYS.some(key => !Object.hasOwn(record,key)) || record.formatVersion !== 1
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

export function readRootApproval(attemptId, now = Date.now()) {
  if (typeof attemptId !== 'string' || !ATTEMPT_ID.test(attemptId)) {
    throw new Error('ATTEMPT_ID_INVALID');
  }
  const { record, sha256 } = readProtectedRecord(`${ATTEMPT_ROOT}/approvals/${attemptId}.json`);
  const approval = validateApproval(record, now);
  if (approval.attemptId !== attemptId) throw new Error('ATTEMPT_APPROVAL_IDENTITY_INVALID');
  return { approval, approvalSha256: sha256 };
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
]);

export function validateApproval(record, now = Date.now()) {
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
    || !Number.isFinite(now) || issued > now || expires <= now
    || expires <= issued || expires - issued > 24 * 60 * 60 * 1000) {
    throw new Error('ATTEMPT_APPROVAL_TIME_INVALID');
  }
  if (record.formatVersion !== 1
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
  return record;
}

/** Catalog admission only; the host still must prove the same DB identity,
 * migration lock, immutable OLD release and attempt before changing a barrier.
 */
export function assertPreMigrationAbortCompatibility(approval, appliedVersions, now = Date.now()) {
  validateApproval(approval, now);
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

export function initialAttempt(context, now = Date.now()) {
  const approval = validateApproval(context.approval, now);
  if (typeof context.approvalSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(context.approvalSha256)) {
    throw new Error('ATTEMPT_JOURNAL_INVALID');
  }
  return { formatVersion: 1, attemptId: approval.attemptId,
    approvalSha256: context.approvalSha256, profileSha256: approval.profileSha256,
    sequence: 0, previousHash: null, phase: 'ADMITTED', starts: 0, abortStarts: 0,
    migrationCommitted: false, lastStart: 'none', predeployBackup: null,
    postdeployBackup: null, smokePassed: false, observationPassed: false,
    invariantBaseline: null, schemaChecked: false, updatedAtUTC: new Date(now).toISOString() };
}

/** Only completed acceptance or a successful never-migrated abort may give
 * ownership back. A phase label alone is not proof of downstream gates.
 */
export function acceptedHandoffDirection(journal, context, now = Date.now()) {
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
export function advanceAttempt(journal, context, event, now = Date.now()) {
  const approval = validateApproval(context.approval, now);
  if (journal === null || typeof journal !== 'object' || Array.isArray(journal)
    || Object.keys(journal).length !== JOURNAL_KEYS.length
    || JOURNAL_KEYS.some((key) => !Object.hasOwn(journal, key))
    || journal.formatVersion !== 1 || journal.attemptId !== approval.attemptId
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
    || !validUTC(journal.updatedAtUTC,now)) {
    throw new Error('ATTEMPT_JOURNAL_INVALID');
  }
  if (event === 'VALIDATE') return journal;
  const kind = typeof event === 'string' ? event : event?.kind;
  const next = { ...journal, sequence: journal.sequence + 1, updatedAtUTC: new Date(now).toISOString() };
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
    if (kind === 'COMPLETED_ABORT') acceptedHandoffDirection(journal,context,now);
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
      || !Number.isSafeInteger(event.elapsedSeconds) || event.elapsedSeconds < 1800) throw new Error('ATTEMPT_TRANSITION_INVALID');
    return { ...next, phase: kind, observationPassed: true };
  }
  if (kind === 'ACCEPTED') {
    if (journal.phase !== 'OBSERVATION_PASSED' || !journal.observationPassed
      || !journal.smokePassed || !journal.postdeployBackup) throw new Error('ATTEMPT_TRANSITION_INVALID');
    return { ...next, phase: kind };
  }
  if (kind === 'COMPLETED') {
    if (journal.phase !== 'ACCEPTED') throw new Error('ATTEMPT_TRANSITION_INVALID');
    acceptedHandoffDirection(journal,context,now);
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
