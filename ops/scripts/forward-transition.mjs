/**
 * Forward-only release transition for the emergency-handoff-superseded R4
 * attempt (`060 -> hotfix release`).
 *
 * This module is pure: it performs no filesystem, database, systemd or network
 * operations. It defines the one-use root authorization, the append-only
 * attempt journal, the deterministic action order and the acceptance record.
 *
 * Hard boundaries:
 * - the R4 parent is only ever SUPERSEDED_BY_EMERGENCY_HANDOFF, never COMPLETED;
 * - the emergency receipt alone never grants release authority;
 * - no migration: the transition is 060 -> 060 and every catalog change is
 *   refused without a separate migration authorization;
 * - no observation bypass: acceptance needs a real uninterrupted 1800-second
 *   observation bound to one PID/start-time/boot;
 * - the host adapter owns every mutation and every live check.
 */
import {createHash} from 'node:crypto';
import {classifyMigrationState} from './migration-reconciliation.mjs';
import {verifyEmergencyHandoffReceipt} from './emergency-handoff.mjs';
import {elapsedTime, validateCurrentTimeEvidence} from './trusted-time.mjs';

export const FORWARD_TRANSITION_SCOPE = 'FORWARD_ONLY_RELEASE_TRANSITION';
export const FORWARD_PARENT_DISPOSITION = 'SUPERSEDED_BY_EMERGENCY_HANDOFF';
export const FORWARD_TERMINAL_STATUS = 'FORWARD_RELEASE_ACCEPTED';
export const FORWARD_OBSERVATION_SECONDS = 1800;
export const FORWARD_OBSERVATION_MIN_SAMPLES = 60;
export const FORWARD_MAX_OBSERVATION_ATTEMPTS = 1;
export const FORWARD_PHASES = Object.freeze([
  'INTENT', 'PREFLIGHT_PASSED', 'BACKUP_INTENT', 'PREDEPLOY_BACKUP_PASSED',
  'STOP_INTENT', 'OLD_STOPPED', 'ACTIVATE_INTENT', 'TARGET_ACTIVATED',
  'HEALTH_PASSED', 'SMOKE_PASSED', 'POSTDEPLOY_BACKUP_INTENT',
  'POSTDEPLOY_BACKUP_PASSED', 'OBSERVATION_INTENT', 'OBSERVATION_STARTED', 'OBSERVATION_PASSED', 'ACCEPTED',
]);
export const FORWARD_ACTIONS = Object.freeze([
  'verify_preflight', 'create_predeploy_backup', 'stop_old_release',
  'activate_target_release', 'verify_health', 'run_browser_smoke',
  'create_postdeploy_backup', 'start_observation', 'seal_acceptance',
]);
export const FORWARD_FORBIDDEN = Object.freeze([
  'complete_parent_attempt', 'migration', 'observation_bypass', 'rollback',
  'reset_start_budget', 'change_parent_records',
]);

export const CONTINUITY_KIND = 'RELEASE_CONTINUITY_AUTHORIZATION';
export const CONTINUITY_SCOPE = 'RELEASE_CONTINUITY_TRANSITION';
export const CONTINUITY_RECOVERY_OUTCOME = 'FORWARD_TARGET_POLICY_RESTORED_NOT_ACCEPTED';
export const LEGACY_TOOL_DIR = '/usr/local/libexec/servora-med-forward';
export const VERSIONED_TOOL_ROOT = '/usr/local/libexec/servora-med-forward-tools';
export const CONTINUITY_TOOL_DIR_RE = /^\/usr\/local\/libexec\/servora-med-forward-tools\/[0-9a-f]{64}$/;
export const CONTINUITY_COLLECTOR_PATH_RE = /^(?:\/usr\/local\/libexec\/servora-med-forward\/trusted-time\.mjs|\/usr\/local\/libexec\/servora-med-forward-tools\/[0-9a-f]{64}\/trusted-time\.mjs)$/;
const AUTHORIZATION_KEYS = Object.freeze([
  'formatVersion', 'kind', 'authorizationId', 'issuedAtUTC', 'expiresAtUTC', 'issuedTime',
  'maxUses', 'reason', 'scope', 'attemptId', 'parent', 'old', 'target', 'host',
  'migration', 'budgets', 'actions', 'forbidden',
]);
const PARENT_KEYS = Object.freeze([
  'attemptId', 'approvalSha256', 'profileSha256', 'checkpointSequence',
  'checkpointSha256', 'emergencyAuthorizationId', 'emergencyJournalHeadSha256',
  'emergencyReceiptSha256', 'disposition',
]);
const RELEASE_KEYS = Object.freeze(['releaseSha', 'artifactSha256', 'schemaHead', 'catalog']);
const TARGET_KEYS = Object.freeze([
  'releaseSha', 'treeSha', 'artifactSha256', 'ciManifestSha256', 'schemaHead', 'catalog',
]);
const HOST_KEYS = Object.freeze(['machineId', 'database']);
const DATABASE_KEYS = Object.freeze([
  'clusterId', 'databaseName', 'databaseOid', 'role', 'host', 'port',
]);
const MIGRATION_KEYS = Object.freeze(['allowed', 'required', 'authorizedMigrations']);
const BUDGET_KEYS = Object.freeze(['maxStarts', 'maxObservationAttempts']);
const CONTINUITY_AUTHORIZATION_KEYS = Object.freeze([...AUTHORIZATION_KEYS, 'lineage']);
const LINEAGE_COMMON_KEYS = Object.freeze([
  'type', 'predecessorAttemptId', 'predecessorAuthorizationSha256', 'predecessorToolHash',
  'predecessorJournalHeadSha256', 'predecessorTerminalPhase', 'predecessorReleaseSha',
  'predecessorArtifactSha256', 'predecessorCollectorModuleSha256', 'predecessorCollectorPath',
]);
const LINEAGE_RECOVERY_KEYS = Object.freeze([...LINEAGE_COMMON_KEYS,
  'recoveryAuthorizationSha256', 'recoveryJournalHeadSha256', 'recoveryReceiptSha256', 'recoveryOutcome']);
const LINEAGE_ACCEPTED_KEYS = Object.freeze([...LINEAGE_COMMON_KEYS, 'acceptanceContractSha256']);

const JOURNAL_KEYS = Object.freeze([
  'formatVersion', 'kind', 'attemptId', 'authorizationId', 'authorizationSha256',
  'parentAttemptId', 'parentDisposition', 'parentApprovalSha256', 'parentProfileSha256',
  'parentCheckpointSequence',
  'parentCheckpointSha256', 'emergencyAuthorizationId', 'emergencyJournalHeadSha256',
  'emergencyReceiptSha256', 'oldReleaseSha', 'targetReleaseSha', 'targetTreeSha',
  'targetArtifactSha256', 'ciManifestSha256', 'schemaHead', 'migrationPerformed',
  'phase', 'steps', 'observation', 'acceptance', 'parentAttemptCompleted',
  'sequence', 'previousHash', 'createdAtUTC', 'updatedAtUTC',
]);
const STEP_KEYS = Object.freeze([
  'preflightPassed', 'predeployBackupPassed', 'oldStopped', 'targetActivated',
  'healthPassed', 'smokePassed', 'postdeployBackupPassed', 'observationPassed',
]);
const OBSERVATION_KEYS = Object.freeze([
  'startedAtUTC', 'completedAtUTC', 'seconds', 'samples', 'pid', 'pidStartTime',
  'bootId', 'endPid', 'endStartTime', 'endBootId',
]);
const OBSERVED_KEYS = Object.freeze([
  'appActive', 'appReleaseSha', 'healthOk', 'healthReleaseSha', 'schemaHead',
  'predeployBackupValid', 'postdeployBackupValid', 'targetReleaseSha', 'observation',
]);
const ACCEPTANCE_EXPECTED_KEYS = Object.freeze([
  'authorizationId', 'authorizationSha256', 'target', 'parentAttemptId',
]);

const PHASE_STEPS = Object.freeze({
  INTENT: [],
  PREFLIGHT_PASSED: ['preflightPassed'],
  BACKUP_INTENT: ['preflightPassed'],
  PREDEPLOY_BACKUP_PASSED: ['preflightPassed', 'predeployBackupPassed'],
  STOP_INTENT: ['preflightPassed', 'predeployBackupPassed'],
  OLD_STOPPED: ['preflightPassed', 'predeployBackupPassed', 'oldStopped'],
  ACTIVATE_INTENT: ['preflightPassed', 'predeployBackupPassed', 'oldStopped'],
  TARGET_ACTIVATED: ['preflightPassed', 'predeployBackupPassed', 'oldStopped', 'targetActivated'],
  HEALTH_PASSED: [...['preflightPassed', 'predeployBackupPassed', 'oldStopped',
    'targetActivated'], 'healthPassed'],
  SMOKE_PASSED: ['preflightPassed', 'predeployBackupPassed', 'oldStopped',
    'targetActivated', 'healthPassed', 'smokePassed'],
  POSTDEPLOY_BACKUP_INTENT: ['preflightPassed', 'predeployBackupPassed', 'oldStopped',
    'targetActivated', 'healthPassed', 'smokePassed'],
  POSTDEPLOY_BACKUP_PASSED: ['preflightPassed', 'predeployBackupPassed', 'oldStopped',
    'targetActivated', 'healthPassed', 'smokePassed', 'postdeployBackupPassed'],
  OBSERVATION_INTENT: ['preflightPassed', 'predeployBackupPassed', 'oldStopped',
    'targetActivated', 'healthPassed', 'smokePassed', 'postdeployBackupPassed'],
  OBSERVATION_STARTED: ['preflightPassed', 'predeployBackupPassed', 'oldStopped',
    'targetActivated', 'healthPassed', 'smokePassed', 'postdeployBackupPassed'],
  OBSERVATION_PASSED: ['preflightPassed', 'predeployBackupPassed', 'oldStopped',
    'targetActivated', 'healthPassed', 'smokePassed', 'postdeployBackupPassed',
    'observationPassed'],
  ACCEPTED: [...STEP_KEYS],
});
const TRANSITIONS = Object.freeze({
  PREFLIGHT_PASSED: {from: 'INTENT', step: 'preflightPassed'},
  BACKUP_INTENT: {from: 'PREFLIGHT_PASSED', step: null},
  PREDEPLOY_BACKUP_PASSED: {from: 'BACKUP_INTENT', step: 'predeployBackupPassed'},
  STOP_INTENT: {from: 'PREDEPLOY_BACKUP_PASSED', step: null},
  OLD_STOPPED: {from: 'STOP_INTENT', step: 'oldStopped'},
  ACTIVATE_INTENT: {from: 'OLD_STOPPED', step: null},
  TARGET_ACTIVATED: {from: 'ACTIVATE_INTENT', step: 'targetActivated'},
  HEALTH_PASSED: {from: 'TARGET_ACTIVATED', step: 'healthPassed'},
  SMOKE_PASSED: {from: 'HEALTH_PASSED', step: 'smokePassed'},
  POSTDEPLOY_BACKUP_INTENT: {from: 'SMOKE_PASSED', step: null},
  POSTDEPLOY_BACKUP_PASSED: {from: 'POSTDEPLOY_BACKUP_INTENT', step: 'postdeployBackupPassed'},
  OBSERVATION_INTENT: {from: 'POSTDEPLOY_BACKUP_PASSED', step: null},
  OBSERVATION_STARTED: {from: 'OBSERVATION_INTENT', step: null},
  OBSERVATION_PASSED: {from: 'OBSERVATION_STARTED', step: 'observationPassed'},
});

const fail = code => { throw new Error(code); };
const digest = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value) + '\n';
const sealed = body => ({...body, hash: digest(canonical(body))});
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => isObject(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const hex = (value, length) => typeof value === 'string'
  && new RegExp('^[0-9a-f]{' + length + '}$').test(value);
const instant = value => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) && Number.isFinite(Date.parse(value));
const uuid = value => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const sameCatalog = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const sameDatabase = (left, right) => exactKeys(left, DATABASE_KEYS)
  && exactKeys(right, DATABASE_KEYS)
  && DATABASE_KEYS.every(key => left[key] === right[key]);
const validDatabase = value => exactKeys(value, DATABASE_KEYS)
  && typeof value.clusterId === 'string' && /^\d{1,32}$/.test(value.clusterId)
  && typeof value.databaseName === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value.databaseName)
  && typeof value.databaseOid === 'string' && /^\d{1,20}$/.test(value.databaseOid)
  && typeof value.role === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value.role)
  && typeof value.host === 'string' && value.host.length > 0
  && Number.isSafeInteger(value.port) && value.port > 0 && value.port <= 65535;

function validateCatalog(catalog) {
  if (!Array.isArray(catalog) || catalog.length === 0 || catalog.length > 999
    || catalog.some(entry => !exactKeys(entry, ['version', 'sha256'])
      || typeof entry.version !== 'string' || !hex(entry.sha256, 64))) {
    fail('FORWARD_TRANSITION_AUTHORIZATION_INVALID');
  }
  return catalog;
}

/**
 * Classifies a `start -> target` catalog relation for a migration-free
 * transition. Only an identical catalog is accepted by this contract.
 */
export function classifyForwardCatalog(startCatalog, targetCatalog) {
  const start = validateCatalog(startCatalog).map(entry => entry.version);
  const target = validateCatalog(targetCatalog).map(entry => entry.version);
  const relation = classifyMigrationState(target, start);
  if (relation.status === 'EXACT' && sameCatalog(startCatalog, targetCatalog)) {
    return 'MIGRATION_FREE';
  }
  if (relation.status === 'PREFIX_WITH_PENDING') return 'MIGRATION_REQUIRED';
  if (relation.status === 'DATABASE_AHEAD') return 'DOWNGRADE_REQUIRED';
  return 'INCOMPATIBLE';
}

function validateWindow(record) {
  if (!instant(record.issuedAtUTC) || !instant(record.expiresAtUTC)) {
    fail('FORWARD_TRANSITION_AUTHORIZATION_INVALID');
  }
  const issued = Date.parse(record.issuedAtUTC);
  const expires = Date.parse(record.expiresAtUTC);
  if (expires <= issued || expires - issued > 24 * 60 * 60 * 1000) {
    fail('FORWARD_TRANSITION_AUTHORIZATION_INVALID');
  }
  validateCurrentTimeEvidence(record.issuedTime);
  if (record.issuedTime.wallAtUTC.replace(/\.\d{3}Z$/, 'Z') !== record.issuedAtUTC) {
    fail('FORWARD_TRANSITION_TIME_INVALID');
  }
}

/** Fresh positive authority needs TT-A quorum, consistent UTC and conservative
 * same-boot/namespace elapsed bounds. Historical consumed replay uses the
 * recorded admission proof, never a new wall-clock window. */
export function validateForwardAuthorizationTime(record, current, clock = null) {
  validateWindow(record);
  validateCurrentTimeEvidence(current);
  const age = elapsedTime(record.issuedTime, current);
  if (age.status !== 'KNOWN') fail('TRUSTED_TIME_UNKNOWN');
  const issued = Date.parse(record.issuedTime.wallAtUTC), expires = Date.parse(record.expiresAtUTC);
  const now = Date.parse(current.wallAtUTC);
  if (now < issued || now >= expires || age.upperMs >= expires - issued) fail('FORWARD_TRANSITION_TIME_INVALID');
  // A live root reader also brackets the publication point. A previously
  // valid quorum sample cannot extend a deadline while I/O is delayed.
  if (clock !== null) {
    if (clock.bootId !== current.bootId || clock.timeNamespaceId !== current.timeNamespaceId
      || !Number.isSafeInteger(clock.uptimeMs) || clock.uptimeMs < current.bootUpperMs
      || !Number.isFinite(Date.parse(clock.wallAtUTC))) fail('TRUSTED_TIME_UNKNOWN');
    if (clock.uptimeMs - record.issuedTime.bootLowerMs >= expires - issued
      || Date.parse(clock.wallAtUTC) >= expires) fail('FORWARD_TRANSITION_TIME_INVALID');
    if (Date.parse(clock.wallAtUTC) < now) fail('TRUSTED_TIME_UNKNOWN');
  }
  return current;
}

/** Structural authorization validation; no live state required. */
export function validateForwardAuthorizationStructure(record) {
  const continuity = record?.kind === CONTINUITY_KIND;
  if (!exactKeys(record, continuity ? CONTINUITY_AUTHORIZATION_KEYS : AUTHORIZATION_KEYS)) {
    fail('FORWARD_TRANSITION_AUTHORIZATION_INVALID');
  }
  if (continuity ? record.formatVersion !== 1 : record.formatVersion !== 2) {
    fail('FORWARD_TRANSITION_AUTHORIZATION_INVALID');
  }
  if (!continuity && record.kind !== 'FORWARD_TRANSITION_AUTHORIZATION') {
    fail('FORWARD_TRANSITION_AUTHORIZATION_INVALID');
  }
  if (record.scope !== (continuity ? CONTINUITY_SCOPE : FORWARD_TRANSITION_SCOPE)) {
    fail('FORWARD_TRANSITION_SCOPE_INVALID');
  }
  if (!uuid(record.authorizationId) || !uuid(record.attemptId)
    || !Number.isSafeInteger(record.maxUses) || record.maxUses !== 1
    || typeof record.reason !== 'string' || record.reason.length === 0
    || record.reason.length > 200) {
    fail('FORWARD_TRANSITION_AUTHORIZATION_INVALID');
  }
  validateWindow(record);
  if (!exactKeys(record.parent, PARENT_KEYS) || !uuid(record.parent.attemptId)
    || !hex(record.parent.approvalSha256, 64) || !hex(record.parent.profileSha256, 64)
    || !Number.isSafeInteger(record.parent.checkpointSequence)
    || record.parent.checkpointSequence < 0
    || !hex(record.parent.checkpointSha256, 64)
    || !uuid(record.parent.emergencyAuthorizationId)
    || !hex(record.parent.emergencyJournalHeadSha256, 64)
    || !hex(record.parent.emergencyReceiptSha256, 64)
    || record.parent.disposition !== FORWARD_PARENT_DISPOSITION) {
    fail('FORWARD_TRANSITION_AUTHORIZATION_INVALID');
  }
  if (!exactKeys(record.old, RELEASE_KEYS) || !hex(record.old.releaseSha, 40)
    || !hex(record.old.artifactSha256, 64)
    || typeof record.old.schemaHead !== 'string'
    || !exactKeys(record.target, TARGET_KEYS) || !hex(record.target.releaseSha, 40)
    || !hex(record.target.treeSha, 40) || !hex(record.target.artifactSha256, 64)
    || !hex(record.target.ciManifestSha256, 64)
    || typeof record.target.schemaHead !== 'string') {
    fail('FORWARD_TRANSITION_AUTHORIZATION_INVALID');
  }
  validateCatalog(record.old.catalog);
  validateCatalog(record.target.catalog);
  if (classifyForwardCatalog(record.old.catalog, record.target.catalog) !== 'MIGRATION_FREE') {
    fail('FORWARD_TRANSITION_MIGRATION_REQUIRED');
  }
  if (record.old.schemaHead !== record.old.catalog.at(-1).version
    || record.target.schemaHead !== record.target.catalog.at(-1).version
    || record.old.schemaHead !== record.target.schemaHead) {
    fail('FORWARD_TRANSITION_SCHEMA_MISMATCH');
  }
  if (record.old.releaseSha === record.target.releaseSha) {
    fail('FORWARD_TRANSITION_AUTHORIZATION_INVALID');
  }
  if (!exactKeys(record.migration, MIGRATION_KEYS)
    || record.migration.allowed !== false || record.migration.required !== false
    || !Array.isArray(record.migration.authorizedMigrations)
    || record.migration.authorizedMigrations.length !== 0) {
    fail('FORWARD_TRANSITION_AUTHORIZATION_INVALID');
  }
  if (!exactKeys(record.budgets, BUDGET_KEYS)
    || !Number.isSafeInteger(record.budgets.maxStarts)
    || record.budgets.maxStarts < 1 || record.budgets.maxStarts > 2
    || record.budgets.maxObservationAttempts !== FORWARD_MAX_OBSERVATION_ATTEMPTS) {
    fail('FORWARD_TRANSITION_AUTHORIZATION_INVALID');
  }
  if (!exactKeys(record.host, HOST_KEYS) || !hex(record.host.machineId, 32)
    || !validDatabase(record.host.database)) {
    fail('FORWARD_TRANSITION_AUTHORIZATION_INVALID');
  }
  if (!Array.isArray(record.actions)
    || JSON.stringify(record.actions) !== JSON.stringify(FORWARD_ACTIONS)) {
    fail('FORWARD_TRANSITION_AUTHORIZATION_INVALID');
  }
  if (!Array.isArray(record.forbidden)
    || JSON.stringify(record.forbidden) !== JSON.stringify(FORWARD_FORBIDDEN)) {
    fail('FORWARD_TRANSITION_AUTHORIZATION_INVALID');
  }
  if (continuity) {
    validateContinuityLineageStructure(record.lineage);
    if (record.attemptId === record.lineage.predecessorAttemptId) {
      fail('FORWARD_TRANSITION_LINEAGE_INVALID');
    }
  }
  return record;
}

/** Structural lineage validation. The live predecessor journal, recovery
 * receipt and collector bytes are validated by the host adapter. */
export function validateContinuityLineageStructure(lineage) {
  if (!isObject(lineage) || !['RECOVERY', 'ACCEPTED'].includes(lineage.type)) {
    fail('FORWARD_TRANSITION_LINEAGE_INVALID');
  }
  const keys = lineage.type === 'RECOVERY' ? LINEAGE_RECOVERY_KEYS : LINEAGE_ACCEPTED_KEYS;
  if (!exactKeys(lineage, keys)
    || !uuid(lineage.predecessorAttemptId)
    || !hex(lineage.predecessorAuthorizationSha256, 64)
    || !hex(lineage.predecessorToolHash, 64)
    || !hex(lineage.predecessorJournalHeadSha256, 64)
    || !FORWARD_PHASES.includes(lineage.predecessorTerminalPhase)
    || !hex(lineage.predecessorReleaseSha, 40)
    || !hex(lineage.predecessorArtifactSha256, 64)
    || !hex(lineage.predecessorCollectorModuleSha256, 64)
    || !CONTINUITY_COLLECTOR_PATH_RE.test(lineage.predecessorCollectorPath)) {
    fail('FORWARD_TRANSITION_LINEAGE_INVALID');
  }
  if (lineage.type === 'ACCEPTED') {
    if (lineage.predecessorTerminalPhase !== 'ACCEPTED' || !hex(lineage.acceptanceContractSha256, 64)) {
      fail('FORWARD_TRANSITION_LINEAGE_INVALID');
    }
  } else if (lineage.predecessorTerminalPhase === 'ACCEPTED' || lineage.predecessorTerminalPhase === 'INTENT'
    || !hex(lineage.recoveryAuthorizationSha256, 64)
    || !hex(lineage.recoveryJournalHeadSha256, 64)
    || !hex(lineage.recoveryReceiptSha256, 64)
    || lineage.recoveryOutcome !== CONTINUITY_RECOVERY_OUTCOME) {
    fail('FORWARD_TRANSITION_LINEAGE_INVALID');
  }
  return lineage;
}

/** Cross-bind a continuity grant to the verified predecessor authorization and
 * the facts read from its terminal journal/recovery/acceptance evidence. */
export function validateContinuityLineageBindings(record, predecessor, facts) {
  validateForwardAuthorizationStructure(record);
  validateForwardAuthorizationStructure(predecessor);
  if (record.kind !== CONTINUITY_KIND) fail('FORWARD_TRANSITION_LINEAGE_INVALID');
  const line = record.lineage;
  if (predecessor.attemptId !== line.predecessorAttemptId
    || predecessor.authorizationId === record.authorizationId
    || record.attemptId === predecessor.attemptId
    || JSON.stringify(record.parent) !== JSON.stringify(predecessor.parent)
    || JSON.stringify(record.host) !== JSON.stringify(predecessor.host)
    || predecessor.target.releaseSha !== line.predecessorReleaseSha
    || predecessor.target.artifactSha256 !== line.predecessorArtifactSha256
    || predecessor.target.releaseSha !== record.old.releaseSha
    || predecessor.target.artifactSha256 !== record.old.artifactSha256
    || predecessor.target.schemaHead !== record.old.schemaHead
    || !sameCatalog(predecessor.target.catalog, record.old.catalog)) {
    fail('FORWARD_TRANSITION_LINEAGE_MISMATCH');
  }
  if (!isObject(facts) || facts.toolHash !== line.predecessorToolHash
    || facts.terminalPhase !== line.predecessorTerminalPhase
    || facts.journalHead !== line.predecessorJournalHeadSha256
    || facts.collectorModuleSha256 !== line.predecessorCollectorModuleSha256) {
    fail('FORWARD_TRANSITION_LINEAGE_MISMATCH');
  }
  if (line.type === 'RECOVERY') {
    if (!isObject(facts.recovery)
      || facts.recovery.authorizationSha256 !== line.recoveryAuthorizationSha256
      || facts.recovery.journalHead !== line.recoveryJournalHeadSha256
      || facts.recovery.receiptSha256 !== line.recoveryReceiptSha256
      || facts.recovery.outcome !== line.recoveryOutcome
      || facts.recovery.mode !== 'RESTORE_HEALTHY_TARGET'
      || facts.recovery.final !== true || facts.recovery.fallback !== false
      || facts.recovery.ownerRetired !== true) {
      fail('FORWARD_TRANSITION_LINEAGE_MISMATCH');
    }
  } else if (!isObject(facts.acceptance)
    || facts.acceptance.contractSha256 !== line.acceptanceContractSha256
    || facts.acceptance.handoff !== true || facts.acceptance.retire !== true) {
    fail('FORWARD_TRANSITION_LINEAGE_MISMATCH');
  }
  return true;
}

function validateSupersession(supersession, record, context) {
  if (!exactKeys(context.emergency, ['receiptSha256', 'journalHeadSha256'])
    || !exactKeys(context.parentIdentity, ['approvalSha256', 'profileSha256'])
    || !hex(context.parentIdentity.approvalSha256, 64)
    || !hex(context.parentIdentity.profileSha256, 64)) {
    fail('FORWARD_TRANSITION_AUTHORIZATION_INVALID');
  }
  if (!isObject(supersession)) fail('FORWARD_TRANSITION_RECEIPT_BINDING_MISMATCH');
  if (supersession.disposition !== FORWARD_PARENT_DISPOSITION
    || supersession.kind !== 'PARENT_ATTEMPT_SUPERSESSION') {
    fail('FORWARD_TRANSITION_PARENT_MISMATCH');
  }
  if (supersession.parentAttemptCompleted !== false
    || supersession.grantsReleaseAuthority !== false) {
    fail('FORWARD_TRANSITION_PARENT_COMPLETED');
  }
  if (supersession.parentAttemptId !== record.parent.attemptId
    || supersession.parentCheckpointSequence !== record.parent.checkpointSequence
    || supersession.parentCheckpointSha256 !== record.parent.checkpointSha256
    || supersession.emergencyAuthorizationId !== record.parent.emergencyAuthorizationId
    || supersession.emergencyJournalHeadSha256 !== record.parent.emergencyJournalHeadSha256) {
    fail('FORWARD_TRANSITION_PARENT_MISMATCH');
  }
  if (context.emergency.receiptSha256 !== record.parent.emergencyReceiptSha256
    || context.emergency.journalHeadSha256 !== record.parent.emergencyJournalHeadSha256) {
    fail('FORWARD_TRANSITION_RECEIPT_BINDING_MISMATCH');
  }
  if (context.parentIdentity.approvalSha256 !== record.parent.approvalSha256
    || context.parentIdentity.profileSha256 !== record.parent.profileSha256) {
    fail('FORWARD_TRANSITION_PARENT_MISMATCH');
  }
  return supersession;
}

/** Validates the one-use authorization against the sealed parent, host and
 * target identity. It never mutates state and never grants release authority.
 */
function validateAuthorizationBindings(record, context, {enforceWindow}) {
  if (!exactKeys(context, ['nowUTC', 'currentTime', 'authorizationSha256', 'supersession', 'emergency',
    'parentIdentity', 'host', 'target', 'journal'])
    || !exactKeys(context.journal, ['present'])
    || typeof context.journal.present !== 'boolean') {
    fail('FORWARD_TRANSITION_AUTHORIZATION_INVALID');
  }
  if (!instant(context.nowUTC) || !hex(context.authorizationSha256, 64)) {
    fail('FORWARD_TRANSITION_AUTHORIZATION_INVALID');
  }
  if (enforceWindow) {
    validateForwardAuthorizationTime(record, context.currentTime);
    const now = Date.parse(context.nowUTC);
    if (now < Date.parse(record.issuedAtUTC)) fail('FORWARD_TRANSITION_TIME_INVALID');
    if (now >= Date.parse(record.expiresAtUTC)) fail('FORWARD_TRANSITION_TIME_INVALID');
  }
  validateSupersession(context.supersession, record, context);

  const host = context.host;
  if (!isObject(host) || !hex(host.machineId, 32) || !sameDatabase(host.database, record.host.database)
    || host.machineId !== record.host.machineId) {
    fail('FORWARD_TRANSITION_OLD_STATE_MISMATCH');
  }
  if (host.schemaHead !== record.old.schemaHead
    || host.schemaHead !== record.target.schemaHead) {
    fail('FORWARD_TRANSITION_SCHEMA_MISMATCH');
  }
  if (host.appActive !== true) fail('FORWARD_TRANSITION_OLD_STATE_MISMATCH');
  if (host.restartPolicy !== 'on-failure') fail('FORWARD_TRANSITION_POLICY_CONFLICT');
  if (!Array.isArray(host.activeOwnerIds)) fail('FORWARD_TRANSITION_OWNER_CONFLICT');
  if (enforceWindow) {
    // Issuance: the OLD release is live and no deployment owner exists yet.
    if (host.releaseSha !== record.old.releaseSha
      || host.artifactSha256 !== record.old.artifactSha256) {
      fail('FORWARD_TRANSITION_OLD_STATE_MISMATCH');
    }
    if (host.activeOwnerIds.length !== 0) fail('FORWARD_TRANSITION_OWNER_CONFLICT');
  } else {
    // Consumed grant: a started journal owns the attempt and the TARGET is live.
    if (context.journal.present !== true) fail('FORWARD_TRANSITION_AUTHORIZATION_INVALID');
    if (host.releaseSha !== record.target.releaseSha
      || host.artifactSha256 !== record.target.artifactSha256) {
      fail('FORWARD_TRANSITION_OLD_STATE_MISMATCH');
    }
    if (host.activeOwnerIds.some(id => id !== record.attemptId)
      || host.activeOwnerIds.length > 1) {
      fail('FORWARD_TRANSITION_OWNER_CONFLICT');
    }
  }

  const target = context.target;
  if (!isObject(target)) fail('FORWARD_TRANSITION_ARTIFACT_MISMATCH');
  if (target.releaseSha !== record.target.releaseSha
    || target.treeSha !== record.target.treeSha
    || target.artifactSha256 !== record.target.artifactSha256
    || target.catalog === undefined || !sameCatalog(validateCatalog(target.catalog), record.target.catalog)) {
    fail('FORWARD_TRANSITION_ARTIFACT_MISMATCH');
  }
  if (target.ciManifestSha256 !== record.target.ciManifestSha256) {
    fail('FORWARD_TRANSITION_CI_MANIFEST_MISMATCH');
  }
  if (classifyForwardCatalog(record.old.catalog, record.target.catalog) !== 'MIGRATION_FREE') {
    fail('FORWARD_TRANSITION_MIGRATION_REQUIRED');
  }
  return record;
}

/** Issuance validation: the one-use window must still be open. */
export function validateForwardAuthorization(record, context) {
  validateForwardAuthorizationStructure(record);
  return validateAuthorizationBindings(record, context, {enforceWindow: true});
}

/**
 * Consumed-grant validation for a journal that already started. The one-use
 * grant was consumed at INTENT; resumption is bounded by the sealed journal,
 * not by the original wall-clock window. Structure, scopes and bindings stay
 * enforced.
 */
export function validateConsumedForwardAuthorization(record, context) {
  validateForwardAuthorizationStructure(record);
  return validateAuthorizationBindings(record, context, {enforceWindow: false});
}

function journalBody(record) {
  if (!exactKeys(record, [...JOURNAL_KEYS, 'hash'])) fail('FORWARD_TRANSITION_JOURNAL_INVALID');
  const body = {...record};
  delete body.hash;
  if (digest(canonical(body)) !== record.hash) fail('FORWARD_TRANSITION_JOURNAL_HASH_INVALID');
  return body;
}

function validateJournalObservation(observation, phase, updatedAtUTC) {
  if (phase !== 'OBSERVATION_PASSED' && phase !== 'ACCEPTED') {
    if (observation !== null) fail('FORWARD_TRANSITION_JOURNAL_INVALID');
    return;
  }
  if (!exactKeys(observation, OBSERVATION_KEYS)
    || classifyObservation(observation) !== 'COMPLETE'
    || Date.parse(observation.completedAtUTC) > Date.parse(updatedAtUTC)) {
    fail('FORWARD_TRANSITION_OBSERVATION_INVALID');
  }
}

function validateJournalSteps(body) {
  if (!exactKeys(body.steps, STEP_KEYS)
    || STEP_KEYS.some(key => typeof body.steps[key] !== 'boolean')) {
    fail('FORWARD_TRANSITION_JOURNAL_INVALID');
  }
  const expected = PHASE_STEPS[body.phase];
  if (!expected || STEP_KEYS.some(key => body.steps[key] !== expected.includes(key))) {
    fail('FORWARD_TRANSITION_JOURNAL_INVALID');
  }
}

function validateJournal(record) {
  const body = journalBody(record);
  if (body.formatVersion !== 1 || body.kind !== 'FORWARD_TRANSITION'
    || !uuid(body.attemptId) || !uuid(body.authorizationId)
    || !hex(body.authorizationSha256, 64) || !uuid(body.parentAttemptId)
    || body.parentDisposition !== FORWARD_PARENT_DISPOSITION
    || !hex(body.parentApprovalSha256, 64) || !hex(body.parentProfileSha256, 64)
    || !Number.isSafeInteger(body.parentCheckpointSequence)
    || body.parentCheckpointSequence < 0 || !hex(body.parentCheckpointSha256, 64)
    || !uuid(body.emergencyAuthorizationId) || !hex(body.emergencyJournalHeadSha256, 64)
    || !hex(body.emergencyReceiptSha256, 64) || !hex(body.oldReleaseSha, 40)
    || !hex(body.targetReleaseSha, 40) || !hex(body.targetTreeSha, 40)
    || !hex(body.targetArtifactSha256, 64) || !hex(body.ciManifestSha256, 64)
    || typeof body.schemaHead !== 'string'
    || body.migrationPerformed !== false || body.parentAttemptCompleted !== false
    || !FORWARD_PHASES.includes(body.phase)
    || (body.acceptance !== null && body.acceptance !== FORWARD_TERMINAL_STATUS)
    || (body.phase === 'ACCEPTED') !== (body.acceptance === FORWARD_TERMINAL_STATUS)
    || !Number.isSafeInteger(body.sequence) || body.sequence < 0 || body.sequence >= 1000
    || !(body.previousHash === null || hex(body.previousHash, 64))
    || !instant(body.createdAtUTC) || !instant(body.updatedAtUTC)
    || Date.parse(body.updatedAtUTC) < Date.parse(body.createdAtUTC)) {
    fail('FORWARD_TRANSITION_JOURNAL_INVALID');
  }
  validateJournalSteps(body);
  validateJournalObservation(body.observation, body.phase, body.updatedAtUTC);
  return body;
}

function journalFrom(record, context, nowUTC) {
  return sealed({
    formatVersion: 1, kind: 'FORWARD_TRANSITION',
    attemptId: record.attemptId,
    authorizationId: record.authorizationId,
    authorizationSha256: context.authorizationSha256,
    parentAttemptId: record.parent.attemptId,
    parentDisposition: FORWARD_PARENT_DISPOSITION,
    parentApprovalSha256: record.parent.approvalSha256,
    parentProfileSha256: record.parent.profileSha256,
    parentCheckpointSequence: record.parent.checkpointSequence,
    parentCheckpointSha256: record.parent.checkpointSha256,
    emergencyAuthorizationId: record.parent.emergencyAuthorizationId,
    emergencyJournalHeadSha256: record.parent.emergencyJournalHeadSha256,
    emergencyReceiptSha256: record.parent.emergencyReceiptSha256,
    oldReleaseSha: record.old.releaseSha,
    targetReleaseSha: record.target.releaseSha,
    targetTreeSha: record.target.treeSha,
    targetArtifactSha256: record.target.artifactSha256,
    ciManifestSha256: record.target.ciManifestSha256,
    schemaHead: record.target.schemaHead,
    migrationPerformed: false,
    phase: 'INTENT',
    steps: Object.fromEntries(STEP_KEYS.map(key => [key, false])),
    observation: null,
    acceptance: null,
    parentAttemptCompleted: false,
    sequence: 0, previousHash: null,
    createdAtUTC: nowUTC, updatedAtUTC: nowUTC,
  });
}

/** Creates the append-only INTENT record. The sealed parent is untouched. */
export function initialForwardTransition(record, context) {
  validateForwardAuthorization(record, context);
  if (!isObject(context.journal) || context.journal.present !== false) {
    fail('FORWARD_TRANSITION_ALREADY_STARTED');
  }
  return journalFrom(record, context, context.nowUTC);
}

/**
 * Appends one deterministic transition. ACCEPTED is deliberately absent: the
 * terminal record is only produced by `sealForwardAcceptance`, which requires a
 * real observation. There is no COMPLETED or PRODUCTION_GO event.
 */
export function advanceForwardTransition(journal, event, nowUTC) {
  const body = validateJournal(journal);
  if (typeof event !== 'string' || !instant(nowUTC)) {
    fail('FORWARD_TRANSITION_EVENT_INVALID');
  }
  if (event === 'ACCEPTED' || !Object.hasOwn(TRANSITIONS, event)) {
    fail('FORWARD_TRANSITION_TRANSITION_INVALID');
  }
  const transition = TRANSITIONS[event];
  if (body.phase !== transition.from || Date.parse(nowUTC) < Date.parse(body.updatedAtUTC)) {
    fail('FORWARD_TRANSITION_TRANSITION_INVALID');
  }
  const steps = {...body.steps};
  if (transition.step) steps[transition.step] = true;
  return sealed({
    ...body, phase: event, steps, sequence: body.sequence + 1,
    previousHash: journal.hash, updatedAtUTC: nowUTC,
  });
}

function classifyObservation(observation) {
  if (!isObject(observation) || !exactKeys(observation, OBSERVATION_KEYS)) return 'INVALID';
  if (!instant(observation.startedAtUTC)
    || !(observation.completedAtUTC === null || instant(observation.completedAtUTC))
    || !Number.isSafeInteger(observation.seconds) || observation.seconds < 0
    || !Number.isSafeInteger(observation.samples) || observation.samples < 0
    || !Number.isSafeInteger(observation.pid) || observation.pid < 1
    || typeof observation.pidStartTime !== 'string' || observation.pidStartTime.length === 0
    || typeof observation.bootId !== 'string' || observation.bootId.length === 0
    || !(observation.endPid === null || Number.isSafeInteger(observation.endPid))
    || !(observation.endStartTime === null || typeof observation.endStartTime === 'string')
    || !(observation.endBootId === null || typeof observation.endBootId === 'string')) {
    return 'INVALID';
  }
  const ends = [observation.endPid, observation.endStartTime, observation.endBootId];
  const anyEnd = ends.some(value => value !== null);
  const allEnd = ends.every(value => value !== null);
  if (anyEnd && !allEnd) return 'INTERRUPTED';
  if (anyEnd && (observation.endPid !== observation.pid
    || observation.endStartTime !== observation.pidStartTime
    || observation.endBootId !== observation.bootId)) {
    return 'INTERRUPTED';
  }
  if (observation.completedAtUTC === null) return 'RUNNING';
  if (!allEnd) return 'INVALID';
  const elapsed = (Date.parse(observation.completedAtUTC) - Date.parse(observation.startedAtUTC)) / 1000;
  if (observation.seconds !== elapsed
    || observation.seconds < FORWARD_OBSERVATION_SECONDS
    || observation.samples < FORWARD_OBSERVATION_MIN_SAMPLES) {
    return 'TOO_SHORT';
  }
  return 'COMPLETE';
}

/**
 * Maps the observed live state to exactly one next action. Already-performed
 * steps are only recorded, never repeated. Any inconsistent state returns STOP.
 */
export function nextForwardAction(journal, observed) {
  const body = validateJournal(journal);
  if (!exactKeys(observed, OBSERVED_KEYS)
    || ['appActive', 'healthOk', 'predeployBackupValid', 'postdeployBackupValid']
      .some(key => typeof observed[key] !== 'boolean')
    || !(observed.appReleaseSha === null || typeof observed.appReleaseSha === 'string')
    || !(observed.healthReleaseSha === null || typeof observed.healthReleaseSha === 'string')
    || typeof observed.schemaHead !== 'string'
    || typeof observed.targetReleaseSha !== 'string'
    || !(observed.observation === null || isObject(observed.observation))) {
    fail('FORWARD_TRANSITION_OBSERVATION_INVALID');
  }
  const healthy = observed.healthOk && observed.healthReleaseSha === body.targetReleaseSha
    && observed.appActive && observed.appReleaseSha === body.targetReleaseSha
    && observed.schemaHead === body.schemaHead;
  if (observed.targetReleaseSha !== body.targetReleaseSha
    || observed.schemaHead !== body.schemaHead) {
    return 'STOP';
  }
  switch (body.phase) {
    case 'INTENT':
      return observed.appActive && observed.appReleaseSha === body.oldReleaseSha
        && observed.healthOk && observed.healthReleaseSha === body.oldReleaseSha
        ? 'VERIFY_PREFLIGHT' : 'STOP';
    case 'PREFLIGHT_PASSED':
      return 'RECORD_BACKUP_INTENT';
    case 'BACKUP_INTENT':
      return observed.predeployBackupValid ? 'RECORD_PREDEPLOY_BACKUP' : 'CREATE_PREDEPLOY_BACKUP';
    case 'PREDEPLOY_BACKUP_PASSED':
      if (!observed.predeployBackupValid) return 'STOP';
      return observed.appActive ? 'STOP_OLD_RELEASE' : 'RECORD_OLD_STOPPED';
    case 'STOP_INTENT':
      return observed.appActive ? 'STOP_OLD_RELEASE' : 'RECORD_OLD_STOPPED';
    case 'OLD_STOPPED':
      return observed.appActive ? 'STOP' : 'ACTIVATE_TARGET_RELEASE';
    case 'ACTIVATE_INTENT':
      if (!observed.appActive) return 'ACTIVATE_TARGET_RELEASE';
      return observed.appReleaseSha === body.targetReleaseSha ? 'RECORD_TARGET_ACTIVATED' : 'STOP';
    case 'TARGET_ACTIVATED':
      if (!observed.appActive || observed.appReleaseSha !== body.targetReleaseSha) return 'STOP';
      return healthy ? 'RECORD_HEALTH' : 'VERIFY_HEALTH';
    case 'HEALTH_PASSED':
      return healthy ? 'RUN_BROWSER_SMOKE' : 'STOP';
    case 'SMOKE_PASSED':
      return healthy ? 'RECORD_POSTDEPLOY_BACKUP_INTENT' : 'STOP';
    case 'POSTDEPLOY_BACKUP_INTENT':
      if (!healthy) return 'STOP';
      return observed.postdeployBackupValid
        ? 'RECORD_POSTDEPLOY_BACKUP' : 'CREATE_POSTDEPLOY_BACKUP';
    case 'POSTDEPLOY_BACKUP_PASSED':
      return healthy && observed.postdeployBackupValid ? 'START_OBSERVATION' : 'STOP';
    case 'OBSERVATION_INTENT': {
      if (!healthy) return 'STOP';
      const state = observed.observation === null
        ? 'NOT_STARTED' : classifyObservation(observed.observation);
      if (state === 'NOT_STARTED') return 'START_OBSERVATION';
      return ['RUNNING', 'COMPLETE'].includes(state) ? 'RECORD_OBSERVATION_STARTED' : 'STOP';
    }
    case 'OBSERVATION_STARTED': {
      if (!healthy) return 'STOP';
      switch (classifyObservation(observed.observation)) {
        case 'COMPLETE': return 'RECORD_OBSERVATION_PASSED';
        case 'RUNNING': return 'CONTINUE_OBSERVATION';
        default: return 'STOP';
      }
    }
    case 'OBSERVATION_PASSED':
      return healthy && classifyObservation(body.observation) === 'COMPLETE'
        ? 'SEAL_ACCEPTANCE' : 'STOP';
    case 'ACCEPTED':
      return 'DONE';
    default:
      return 'STOP';
  }
}

/** Validates an append-only journal chain, including the terminal acceptance. */
export function validateForwardChain(records) {
  if (!Array.isArray(records) || records.length === 0 || records.length > 64) {
    fail('FORWARD_TRANSITION_JOURNAL_INVALID');
  }
  const first = validateJournal(records[0]);
  if (first.phase !== 'INTENT' || first.sequence !== 0 || first.previousHash !== null) {
    fail('FORWARD_TRANSITION_JOURNAL_CHAIN_INVALID');
  }
  let previous = null;
  for (const [index, record] of records.entries()) {
    const body = validateJournal(record);
    if (body.sequence !== index || (index === 0
      ? body.previousHash !== null
      : body.previousHash !== records[index - 1].hash)) {
      fail('FORWARD_TRANSITION_JOURNAL_CHAIN_INVALID');
    }
    if (body.attemptId !== first.attemptId
      || body.authorizationId !== first.authorizationId
      || body.authorizationSha256 !== first.authorizationSha256
      || body.parentAttemptId !== first.parentAttemptId
      || body.parentDisposition !== first.parentDisposition
      || body.parentApprovalSha256 !== first.parentApprovalSha256
      || body.parentProfileSha256 !== first.parentProfileSha256
      || body.parentCheckpointSequence !== first.parentCheckpointSequence
      || body.parentCheckpointSha256 !== first.parentCheckpointSha256
      || body.emergencyAuthorizationId !== first.emergencyAuthorizationId
      || body.emergencyJournalHeadSha256 !== first.emergencyJournalHeadSha256
      || body.emergencyReceiptSha256 !== first.emergencyReceiptSha256
      || body.oldReleaseSha !== first.oldReleaseSha
      || body.targetReleaseSha !== first.targetReleaseSha
      || body.targetTreeSha !== first.targetTreeSha
      || body.targetArtifactSha256 !== first.targetArtifactSha256
      || body.ciManifestSha256 !== first.ciManifestSha256
      || body.schemaHead !== first.schemaHead
      || body.createdAtUTC !== first.createdAtUTC) {
      fail('FORWARD_TRANSITION_JOURNAL_CHAIN_INVALID');
    }
    if (index > 0) {
      const from = FORWARD_PHASES.indexOf(previous.phase);
      const to = FORWARD_PHASES.indexOf(body.phase);
      if (to !== from + 1) fail('FORWARD_TRANSITION_JOURNAL_CHAIN_INVALID');
      if (STEP_KEYS.some(key => previous.steps[key] === true && body.steps[key] !== true)) {
        fail('FORWARD_TRANSITION_JOURNAL_CHAIN_INVALID');
      }
      if (Date.parse(body.updatedAtUTC) < Date.parse(previous.updatedAtUTC)) {
        fail('FORWARD_TRANSITION_JOURNAL_CHAIN_INVALID');
      }
    }
    if (body.phase === 'ACCEPTED' && index !== records.length - 1) {
      fail('FORWARD_TRANSITION_JOURNAL_CHAIN_INVALID');
    }
    previous = body;
  }
  return records.at(-1);
}

/**
 * Records a completed observation as a durable OBSERVATION_PASSED record. The
 * proof must be real: uninterrupted, at least 1800 seconds and 60 samples, and
 * bound to one PID/start-time/boot. A shorter, interrupted or inconsistent
 * observation is refused and never recorded.
 */
export function recordForwardObservation(journal, observation, nowUTC) {
  const body = validateJournal(journal);
  if (body.phase !== 'OBSERVATION_STARTED') fail('FORWARD_TRANSITION_NOT_COMPLETE');
  if (!instant(nowUTC) || Date.parse(nowUTC) < Date.parse(body.updatedAtUTC)) {
    fail('FORWARD_TRANSITION_ACCEPTANCE_INVALID');
  }
  if (classifyObservation(observation) !== 'COMPLETE') {
    fail('FORWARD_TRANSITION_OBSERVATION_INVALID');
  }
  const started = Date.parse(body.updatedAtUTC);
  const observedStart = Date.parse(observation.startedAtUTC);
  const observedEnd = Date.parse(observation.completedAtUTC);
  if (observedStart < started
    || observedEnd > Date.parse(nowUTC)
    || Date.parse(nowUTC) - started < FORWARD_OBSERVATION_SECONDS * 1000) {
    fail('FORWARD_TRANSITION_OBSERVATION_INVALID');
  }
  return sealed({
    ...body, phase: 'OBSERVATION_PASSED',
    steps: {...body.steps, observationPassed: true},
    observation: {...observation}, sequence: body.sequence + 1,
    previousHash: journal.hash, updatedAtUTC: nowUTC,
  });
}

/**
 * Seals the terminal acceptance from a durable OBSERVATION_PASSED record. Every
 * step must be true and the recorded observation is re-validated. The R4 parent
 * stays SUPERSEDED and is never marked COMPLETED.
 */
export function sealForwardAcceptance(journal, record, context, nowUTC) {
  const body = validateJournal(journal);
  if (body.phase !== 'OBSERVATION_PASSED' || body.steps.observationPassed !== true) {
    fail('FORWARD_TRANSITION_NOT_COMPLETE');
  }
  validateConsumedForwardAuthorization(record, context);
  if (!instant(nowUTC) || Date.parse(nowUTC) < Date.parse(body.updatedAtUTC)) {
    fail('FORWARD_TRANSITION_ACCEPTANCE_INVALID');
  }
  if (body.attemptId !== record.attemptId
    || body.authorizationId !== record.authorizationId
    || body.authorizationSha256 !== context.authorizationSha256
    || body.parentAttemptId !== record.parent.attemptId
    || body.parentDisposition !== record.parent.disposition
    || body.parentApprovalSha256 !== record.parent.approvalSha256
    || body.parentProfileSha256 !== record.parent.profileSha256
    || body.parentCheckpointSequence !== record.parent.checkpointSequence
    || body.parentCheckpointSha256 !== record.parent.checkpointSha256
    || body.emergencyAuthorizationId !== record.parent.emergencyAuthorizationId
    || body.emergencyJournalHeadSha256 !== record.parent.emergencyJournalHeadSha256
    || body.emergencyReceiptSha256 !== record.parent.emergencyReceiptSha256
    || body.oldReleaseSha !== record.old.releaseSha
    || body.targetReleaseSha !== record.target.releaseSha
    || body.targetTreeSha !== record.target.treeSha
    || body.targetArtifactSha256 !== record.target.artifactSha256
    || body.ciManifestSha256 !== record.target.ciManifestSha256
    || body.schemaHead !== record.target.schemaHead) {
    fail('FORWARD_TRANSITION_BINDING_MISMATCH');
  }
  if (classifyObservation(body.observation) !== 'COMPLETE') {
    fail('FORWARD_TRANSITION_OBSERVATION_INVALID');
  }
  if (STEP_KEYS.some(key => body.steps[key] !== true)) {
    fail('FORWARD_TRANSITION_NOT_COMPLETE');
  }
  return sealed({
    ...body, phase: 'ACCEPTED', acceptance: FORWARD_TERMINAL_STATUS,
    sequence: body.sequence + 1, previousHash: journal.hash, updatedAtUTC: nowUTC,
  });
}

/** Validates the terminal acceptance record and returns its exact release
 * identity. `grantsReleaseAuthority` is false by design: acceptance of this
 * release is evidence, not a standing deployment authority.
 */
export function verifyForwardAcceptance(record, expected) {
  if (!isObject(record)) fail('FORWARD_TRANSITION_ACCEPTANCE_INVALID');
  const body = validateJournal(record);
  if (body.phase !== 'ACCEPTED' || body.acceptance !== FORWARD_TERMINAL_STATUS) {
    fail('FORWARD_TRANSITION_ACCEPTANCE_INVALID');
  }
  if (!exactKeys(expected, ACCEPTANCE_EXPECTED_KEYS)
    || !uuid(expected.authorizationId) || !hex(expected.authorizationSha256, 64)
    || !uuid(expected.parentAttemptId) || !exactKeys(expected.target, TARGET_KEYS)) {
    fail('FORWARD_TRANSITION_ACCEPTANCE_INVALID');
  }
  validateCatalog(expected.target.catalog);
  if (body.authorizationId !== expected.authorizationId
    || body.authorizationSha256 !== expected.authorizationSha256
    || body.parentAttemptId !== expected.parentAttemptId
    || body.targetReleaseSha !== expected.target.releaseSha
    || body.targetTreeSha !== expected.target.treeSha
    || body.targetArtifactSha256 !== expected.target.artifactSha256
    || body.ciManifestSha256 !== expected.target.ciManifestSha256
    || body.schemaHead !== expected.target.schemaHead
    || body.schemaHead !== expected.target.catalog.at(-1).version
    || classifyObservation(body.observation) !== 'COMPLETE') {
    fail('FORWARD_TRANSITION_BINDING_MISMATCH');
  }
  return Object.freeze({
    kind: 'FORWARD_RELEASE_ACCEPTANCE',
    acceptance: FORWARD_TERMINAL_STATUS,
    parentAttemptId: body.parentAttemptId,
    parentDisposition: FORWARD_PARENT_DISPOSITION,
    parentAttemptCompleted: false,
    grantsReleaseAuthority: false,
    targetReleaseSha: body.targetReleaseSha,
    targetTreeSha: body.targetTreeSha,
    targetArtifactSha256: body.targetArtifactSha256,
    ciManifestSha256: body.ciManifestSha256,
    schemaHead: body.schemaHead,
    migrationPerformed: false,
    observation: {
      startedAtUTC: body.observation.startedAtUTC,
      completedAtUTC: body.observation.completedAtUTC,
      seconds: body.observation.seconds,
      samples: body.observation.samples,
      pid: body.observation.pid,
      pidStartTime: body.observation.pidStartTime,
      bootId: body.observation.bootId,
      continuity: 'PRESERVED',
    },
  });
}

/**
 * Verifies the sealed emergency receipt and returns the only parent record a
 * forward transition may consume. The parent is SUPERSEDED, never COMPLETED.
 */
export function assertEmergencySupersession(input = {}) {
  const {receipt, expected, receiptSha256} = input;
  if (!isObject(receipt) || !hex(receiptSha256, 64) || receipt.hash !== receiptSha256) {
    fail('FORWARD_TRANSITION_RECEIPT_BINDING_MISMATCH');
  }
  const supersession = verifyEmergencyHandoffReceipt(receipt, expected);
  if (supersession.disposition !== FORWARD_PARENT_DISPOSITION) {
    fail('FORWARD_TRANSITION_PARENT_MISMATCH');
  }
  if (supersession.parentAttemptCompleted !== false
    || supersession.grantsReleaseAuthority !== false) {
    fail('FORWARD_TRANSITION_PARENT_COMPLETED');
  }
  return supersession;
}

/** Derives the immutable authorization binding. No I/O. */
export function forwardAuthorizationBinding({parent, old, target, host}) {
  if (!isObject(parent) || !isObject(old) || !isObject(target) || !isObject(host)
    || !exactKeys(parent, PARENT_KEYS.filter(key => key !== 'disposition'))
    || !exactKeys(old, RELEASE_KEYS) || !exactKeys(target, TARGET_KEYS)
    || !exactKeys(host, HOST_KEYS)) {
    fail('FORWARD_TRANSITION_BINDING_INVALID');
  }
  validateCatalog(old.catalog);
  validateCatalog(target.catalog);
  if (!validDatabase(host.database)) fail('FORWARD_TRANSITION_BINDING_INVALID');
  if (old.schemaHead !== old.catalog.at(-1).version
    || target.schemaHead !== target.catalog.at(-1).version
    || old.schemaHead !== target.schemaHead) {
    fail('FORWARD_TRANSITION_SCHEMA_MISMATCH');
  }
  if (classifyForwardCatalog(old.catalog, target.catalog) !== 'MIGRATION_FREE') {
    fail('FORWARD_TRANSITION_MIGRATION_REQUIRED');
  }
  return {
    parent: {...parent, disposition: FORWARD_PARENT_DISPOSITION},
    old: {...old, catalog: old.catalog.map(entry => ({...entry}))},
    target: {...target, catalog: target.catalog.map(entry => ({...entry}))},
    host: {machineId: host.machineId, database: {...host.database}},
    migration: {allowed: false, required: false, authorizedMigrations: []},
  };
}
