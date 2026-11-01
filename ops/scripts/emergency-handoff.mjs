/**
 * Emergency restart-policy handoff for the fenced R4 attempt.
 *
 * This module is pure: it performs no filesystem, database, systemd or network
 * operations. It defines the root authorization, the append-only sidecar
 * journal and the future-owner supersession contract. The host adapter owns
 * every mutation.
 *
 * The handoff has no acceptance authority. It cannot produce
 * OBSERVATION_PASSED, ACCEPTED, COMPLETED or PRODUCTION_GO, cannot start the
 * app, cannot migrate, cannot change the release, and cannot reset the start
 * budget. A true R4 COMPLETED still requires the separate forward-only
 * transition that carries the collector fix and a fresh observation.
 */
import {createHash} from 'node:crypto';

export const EMERGENCY_OPERATIONAL_STATUS = 'EMERGENCY_RESTART_POLICY_RESTORED';
export const EMERGENCY_R4_TERMINAL_STATE = 'HEALTH_PASSED_FENCED';
export const EMERGENCY_HANDOFF_ACTIONS = Object.freeze([
  'restore_restart_on_failure','remove_barrier','retire_owner',
]);
export const EMERGENCY_HANDOFF_FORBIDDEN = Object.freeze([
  'observation_passed','completed','migration','release_change','start_app','reset_start_budget',
]);
export const EMERGENCY_HANDOFF_PHASES = Object.freeze([
  'INTENT','POLICY_INTENT','POLICY_RESTORED',
  'BARRIER_INTENT','BARRIER_REMOVED',
  'OWNER_INTENT','OWNER_RETIRED','HANDOFF_COMPLETE',
]);

const AUTHORIZATION_KEYS = ['formatVersion','kind','authorizationId','issuedAtUTC','expiresAtUTC',
  'maxUses','reason','scope','parent','host','backups','actions','forbidden','toolArtifactSha256'];
const PARENT_KEYS = ['attemptId','approvalSha256','profileSha256','checkpointSequence',
  'checkpointSha256','phase','migrationCommitted','schemaHead','starts','maxStarts','lastStart'];
const HOST_KEYS = ['machineId','database','releaseSha','releaseArtifactSha256',
  'timeModuleSha256','timeConfigSha256'];
const DATABASE_KEYS = ['clusterId','databaseName','databaseOid','role','host','port'];
const BACKUP_KEYS = ['preSha256','postSha256'];
const CONTEXT_KEYS = ['nowUTC','authorizationSha256','toolArtifactSha256','parent','host',
  'backups','live','journal'];
const LIVE_KEYS = ['activeAttemptId','activeApprovalSha256','barrierAttemptId',
  'barrierApprovalSha256','permitPresent','foreignOwner','appActive','appPid','coreHealth',
  'releaseSha','schemaHead','starts','maxStarts','dropInPresent','restartPolicy',
  'needDaemonReload'];
const JOURNAL_STATE_KEYS = ['present','authorizationId','authorizationSha256','terminal'];
const JOURNAL_KEYS = ['formatVersion','kind','authorizationId','authorizationSha256',
  'toolArtifactSha256','parentCheckpointSequence','parentCheckpointSha256','phase','steps',
  'observationPassed','r4Acceptance','r4TerminalState','handoffComplete','sequence',
  'previousHash','createdAtUTC','updatedAtUTC'];
const STEP_KEYS = ['barrierRemoved','policyRestored','ownerRetired'];
const OBSERVED_KEYS = ['dropInPresent','restartPolicy','needDaemonReload','barrierPresent',
  'ownerPresent','permitPresent','receiptPresent'];
const RECEIPT_KEYS = ['formatVersion','kind','operationalStatus','r4TerminalState',
  'r4Acceptance','observationPassed','parentAttemptCompleted','futureReleaseAuthority',
  'authorizationId','authorizationSha256','toolArtifactSha256','parent','handoff','host',
  'backups'];
const RECEIPT_PARENT_KEYS = ['attemptId','approvalSha256','profileSha256',
  'checkpointSequence','checkpointSha256','phase'];
const RECEIPT_HANDOFF_KEYS = ['journalHeadSha256','steps','completedAtUTC'];
const RECEIPT_HOST_KEYS = ['machineId','database','releaseSha','schemaHead','startBudget'];
const RECEIPT_BUDGET_KEYS = ['used','max'];
const EXPECTED_RECEIPT_KEYS = ['authorizationId','authorizationSha256','toolArtifactSha256','parent'];
const FORWARD_LIVE_KEYS = ['activeAttemptId','barrierPresent','permitPresent','dropInPresent',
  'restartPolicy'];
const PHASE_STEPS = Object.freeze({
  INTENT: [],
  POLICY_INTENT: [],
  POLICY_RESTORED: ['policyRestored'],
  BARRIER_INTENT: ['policyRestored'],
  BARRIER_REMOVED: ['policyRestored','barrierRemoved'],
  OWNER_INTENT: ['policyRestored','barrierRemoved'],
  OWNER_RETIRED: ['policyRestored','barrierRemoved','ownerRetired'],
  HANDOFF_COMPLETE: ['policyRestored','barrierRemoved','ownerRetired'],
});
const TRANSITIONS = Object.freeze({
  POLICY_INTENT: {from: 'INTENT', to: 'POLICY_INTENT', step: null},
  POLICY_RESTORED: {from: 'POLICY_INTENT', to: 'POLICY_RESTORED', step: 'policyRestored'},
  BARRIER_INTENT: {from: 'POLICY_RESTORED', to: 'BARRIER_INTENT', step: null},
  BARRIER_REMOVED: {from: 'BARRIER_INTENT', to: 'BARRIER_REMOVED', step: 'barrierRemoved'},
  OWNER_INTENT: {from: 'BARRIER_REMOVED', to: 'OWNER_INTENT', step: null},
  OWNER_RETIRED: {from: 'OWNER_INTENT', to: 'OWNER_RETIRED', step: 'ownerRetired'},
  HANDOFF_COMPLETE: {from: 'OWNER_RETIRED', to: 'HANDOFF_COMPLETE', step: null},
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
const safeCount = value => Number.isSafeInteger(value) && value >= 0;

function journalBody(record) {
  if (!exactKeys(record, [...JOURNAL_KEYS, 'hash'])) fail('EMERGENCY_HANDOFF_JOURNAL_INVALID');
  const body = {...record};
  delete body.hash;
  if (digest(canonical(body)) !== record.hash) fail('EMERGENCY_HANDOFF_JOURNAL_HASH_INVALID');
  return body;
}

function validateJournalSteps(body) {
  if (!exactKeys(body.steps, STEP_KEYS)
    || STEP_KEYS.some(key => typeof body.steps[key] !== 'boolean')) {
    fail('EMERGENCY_HANDOFF_JOURNAL_INVALID');
  }
  const expected = PHASE_STEPS[body.phase];
  if (!expected || STEP_KEYS.some(key => body.steps[key] !== expected.includes(key))) {
    fail('EMERGENCY_HANDOFF_JOURNAL_INVALID');
  }
}

function validateJournal(record) {
  const body = journalBody(record);
  if (body.formatVersion !== 1 || body.kind !== 'EMERGENCY_HANDOFF'
    || !uuid(body.authorizationId) || !hex(body.authorizationSha256, 64)
    || !hex(body.toolArtifactSha256, 64)
    || !Number.isSafeInteger(body.parentCheckpointSequence) || body.parentCheckpointSequence < 0
    || !hex(body.parentCheckpointSha256, 64)
    || !EMERGENCY_HANDOFF_PHASES.includes(body.phase)
    || body.observationPassed !== false || body.r4Acceptance !== 'NOT_ACCEPTED'
    || body.r4TerminalState !== EMERGENCY_R4_TERMINAL_STATE
    || typeof body.handoffComplete !== 'boolean'
    || body.handoffComplete !== (body.phase === 'HANDOFF_COMPLETE')
    || !Number.isSafeInteger(body.sequence) || body.sequence < 0 || body.sequence >= 1000
    || !(body.previousHash === null || hex(body.previousHash, 64))
    || !instant(body.createdAtUTC) || !instant(body.updatedAtUTC)
    || Date.parse(body.updatedAtUTC) < Date.parse(body.createdAtUTC)) {
    fail('EMERGENCY_HANDOFF_JOURNAL_INVALID');
  }
  validateJournalSteps(body);
  return body;
}

function validateAuthorization(record, context) {
  if (!exactKeys(record, AUTHORIZATION_KEYS) || record.formatVersion !== 2
    || record.kind !== 'EMERGENCY_HANDOFF_AUTHORIZATION'
    || !uuid(record.authorizationId)
    || !instant(record.issuedAtUTC) || !instant(record.expiresAtUTC)
    || Date.parse(record.issuedAtUTC) >= Date.parse(record.expiresAtUTC)
    || Date.parse(record.expiresAtUTC) - Date.parse(record.issuedAtUTC) > 60 * 60 * 1000
    || record.maxUses !== 1 || typeof record.reason !== 'string'
    || record.reason.length === 0 || record.reason.length > 200
    || record.scope !== 'EMERGENCY_RESTART_POLICY_HANDOFF'
    || !exactKeys(record.parent, PARENT_KEYS)
    || !exactKeys(record.host, HOST_KEYS)
    || !exactKeys(record.host.database, DATABASE_KEYS)
    || !exactKeys(record.backups, BACKUP_KEYS)
    || !Array.isArray(record.actions) || !Array.isArray(record.forbidden)
    || JSON.stringify(record.actions) !== JSON.stringify(EMERGENCY_HANDOFF_ACTIONS)
    || JSON.stringify(record.forbidden) !== JSON.stringify(EMERGENCY_HANDOFF_FORBIDDEN)
    || !hex(record.toolArtifactSha256, 64)) {
    fail('EMERGENCY_HANDOFF_AUTHORIZATION_INVALID');
  }
  const parent = record.parent;
  if (!uuid(parent.attemptId) || !hex(parent.approvalSha256, 64)
    || !hex(parent.profileSha256, 64) || !Number.isSafeInteger(parent.checkpointSequence)
    || parent.checkpointSequence < 0 || !hex(parent.checkpointSha256, 64)
    || parent.phase !== 'POSTDEPLOY_BACKUP_PASSED' || parent.migrationCommitted !== true
    || typeof parent.schemaHead !== 'string' || !/^[0-9]{3}_[a-z0-9_]+$/.test(parent.schemaHead)
    || !Number.isSafeInteger(parent.starts) || parent.starts < 1
    || !Number.isSafeInteger(parent.maxStarts) || parent.maxStarts < 1
    || parent.starts !== parent.maxStarts || parent.lastStart !== 'pass') {
    fail('EMERGENCY_HANDOFF_AUTHORIZATION_INVALID');
  }
  const host = record.host, database = host.database;
  if (!hex(host.machineId, 32) || !hex(host.releaseSha, 40)
    || !hex(host.releaseArtifactSha256, 64) || !hex(host.timeModuleSha256, 64)
    || !hex(host.timeConfigSha256, 64)
    || typeof database.clusterId !== 'string' || !/^[1-9][0-9]{0,30}$/.test(database.clusterId)
    || typeof database.databaseName !== 'string' || !/^[a-z_][a-z0-9_]{0,62}$/.test(database.databaseName)
    || typeof database.databaseOid !== 'string' || !/^[1-9][0-9]*$/.test(database.databaseOid)
    || typeof database.role !== 'string' || !/^[a-z_][a-z0-9_]{0,62}$/.test(database.role)
    || typeof database.host !== 'string' || !/^[a-z0-9.:-]{1,253}$/.test(database.host)
    || !Number.isSafeInteger(database.port) || database.port < 1 || database.port > 65535
    || !hex(record.backups.preSha256, 64) || !hex(record.backups.postSha256, 64)) {
    fail('EMERGENCY_HANDOFF_AUTHORIZATION_INVALID');
  }
  if (!exactKeys(context, CONTEXT_KEYS) || !instant(context.nowUTC)
    || !hex(context.authorizationSha256, 64) || !hex(context.toolArtifactSha256, 64)
    || !exactKeys(context.parent, PARENT_KEYS) || !exactKeys(context.host, HOST_KEYS)
    || !exactKeys(context.host.database, DATABASE_KEYS)
    || !exactKeys(context.backups, BACKUP_KEYS)
    || !exactKeys(context.live, LIVE_KEYS)
    || !exactKeys(context.journal, JOURNAL_STATE_KEYS)) {
    fail('EMERGENCY_HANDOFF_CONTEXT_INVALID');
  }
  if (Date.parse(context.nowUTC) < Date.parse(record.issuedAtUTC)
    || Date.parse(context.nowUTC) >= Date.parse(record.expiresAtUTC)) {
    fail('EMERGENCY_HANDOFF_AUTHORIZATION_EXPIRED');
  }
  if (JSON.stringify(record.parent) !== JSON.stringify(context.parent)
    || JSON.stringify(record.host) !== JSON.stringify(context.host)
    || JSON.stringify(record.backups) !== JSON.stringify(context.backups)
    || record.toolArtifactSha256 !== context.toolArtifactSha256) {
    fail('EMERGENCY_HANDOFF_BINDING_MISMATCH');
  }
  const live = context.live;
  if (live.activeAttemptId !== parent.attemptId
    || live.activeApprovalSha256 !== parent.approvalSha256
    || live.barrierAttemptId !== parent.attemptId
    || live.barrierApprovalSha256 !== parent.approvalSha256
    || live.permitPresent !== false || live.foreignOwner !== false
    || live.appActive !== true || !Number.isSafeInteger(live.appPid) || live.appPid < 1
    || live.coreHealth !== true || live.releaseSha !== host.releaseSha
    || live.schemaHead !== parent.schemaHead
    || live.starts !== parent.starts || live.maxStarts !== parent.maxStarts
    || live.dropInPresent !== true || live.restartPolicy !== 'no'
    || live.needDaemonReload !== false) {
    fail('EMERGENCY_HANDOFF_LIVE_STATE_MISMATCH');
  }
  const journal = context.journal;
  if (typeof journal.present !== 'boolean' || typeof journal.terminal !== 'boolean'
    || (journal.present && (!uuid(journal.authorizationId)
      || !hex(journal.authorizationSha256, 64)))
    || (!journal.present && (journal.authorizationId !== null
      || journal.authorizationSha256 !== null || journal.terminal !== false))) {
    fail('EMERGENCY_HANDOFF_CONTEXT_INVALID');
  }
  if (journal.present && (journal.authorizationId !== record.authorizationId
    || journal.authorizationSha256 !== context.authorizationSha256)) {
    fail('EMERGENCY_HANDOFF_OTHER_AUTHORIZATION');
  }
  return record;
}

/** Validates the root authorization against the captured parent, host, live
 * state and any existing journal. No mutation, no acceptance authority.
 */
export function validateEmergencyHandoffAuthorization(record, context) {
  return validateAuthorization(record, context);
}

/** Creates the append-only INTENT record. The parent journal is untouched. */
export function initialEmergencyHandoff(record, context) {
  validateAuthorization(record, context);
  if (context.journal.present) fail('EMERGENCY_HANDOFF_ALREADY_STARTED');
  return sealed({
    formatVersion: 1, kind: 'EMERGENCY_HANDOFF',
    authorizationId: record.authorizationId,
    authorizationSha256: context.authorizationSha256,
    toolArtifactSha256: record.toolArtifactSha256,
    parentCheckpointSequence: record.parent.checkpointSequence,
    parentCheckpointSha256: record.parent.checkpointSha256,
    phase: 'INTENT', steps: {barrierRemoved: false, policyRestored: false, ownerRetired: false},
    observationPassed: false, r4Acceptance: 'NOT_ACCEPTED',
    r4TerminalState: EMERGENCY_R4_TERMINAL_STATE, handoffComplete: false,
    sequence: 0, previousHash: null,
    createdAtUTC: context.nowUTC, updatedAtUTC: context.nowUTC,
  });
}

/**
 * Appends one handoff transition. Only the seven restart-policy events are
 * accepted. There is deliberately no OBSERVATION_PASSED, ACCEPTED, COMPLETED
 * or start event.
 */
export function advanceEmergencyHandoff(journal, event, nowUTC) {
  const body = validateJournal(journal);
  if (typeof event !== 'string' || !Object.hasOwn(TRANSITIONS, event) || !instant(nowUTC)) {
    fail('EMERGENCY_HANDOFF_EVENT_INVALID');
  }
  const transition = TRANSITIONS[event];
  if (body.phase !== transition.from
    || Date.parse(nowUTC) < Date.parse(body.createdAtUTC)) {
    fail('EMERGENCY_HANDOFF_TRANSITION_INVALID');
  }
  const steps = {...body.steps};
  if (transition.step) steps[transition.step] = true;
  const next = {...body, sequence: body.sequence + 1, previousHash: journal.hash,
    updatedAtUTC: nowUTC, phase: transition.to, steps,
    handoffComplete: transition.to === 'HANDOFF_COMPLETE'};
  return sealed(next);
}

/**
 * Maps the observed live state to exactly one next action. Already-performed
 * steps are only recorded; mutations are never repeated. Any inconsistent
 * combination returns STOP and the caller must make no change.
 *
 * Ordering is policy-first on purpose: systemd 255 automatic restart jobs do
 * not re-evaluate ConditionPathExists, so restoring Restart=on-failure makes a
 * crash restart effective immediately; the barrier only blocks manual/boot
 * starts and is removed next. The reverse order would leave a crash window
 * with Restart=no.
 */
export function nextEmergencyHandoffAction(journal, observed) {
  const body = validateJournal(journal);
  if (!exactKeys(observed, OBSERVED_KEYS)
    || ['dropInPresent','needDaemonReload','barrierPresent','ownerPresent','permitPresent',
      'receiptPresent'].some(key => typeof observed[key] !== 'boolean')
    || !['no','on-failure'].includes(observed.restartPolicy)) {
    fail('EMERGENCY_HANDOFF_OBSERVATION_INVALID');
  }
  const {dropInPresent, restartPolicy, needDaemonReload, barrierPresent, ownerPresent,
    permitPresent, receiptPresent} = observed;
  if (permitPresent) return 'STOP';
  const policyClean = !dropInPresent && restartPolicy === 'on-failure' && !needDaemonReload;
  const barrierGone = !barrierPresent;
  const ownerGone = !ownerPresent;
  const allClean = barrierGone && policyClean && ownerGone;
  switch (body.phase) {
    case 'INTENT':
    case 'POLICY_INTENT':
      if (!barrierPresent || !ownerPresent) return 'STOP';
      if (dropInPresent && restartPolicy === 'no' && !needDaemonReload) return 'REMOVE_POLICY';
      if (!dropInPresent && restartPolicy === 'no' && needDaemonReload) return 'RELOAD_POLICY';
      if (policyClean) return 'RECORD_POLICY';
      return 'STOP';
    case 'POLICY_RESTORED':
    case 'BARRIER_INTENT':
      if (!policyClean || !ownerPresent) return 'STOP';
      return barrierPresent ? 'REMOVE_BARRIER' : 'RECORD_BARRIER';
    case 'BARRIER_REMOVED':
    case 'OWNER_INTENT':
      if (!policyClean || barrierPresent) return 'STOP';
      return ownerPresent ? 'RETIRE_OWNER' : 'RECORD_OWNER';
    case 'OWNER_RETIRED':
      return allClean && !receiptPresent ? 'SEAL_COMPLETE' : 'STOP';
    case 'HANDOFF_COMPLETE':
      if (!allClean) return 'STOP';
      return receiptPresent ? 'DONE' : 'SEAL_RECEIPT';
    default:
      return 'STOP';
  }
}

/**
 * Validates an already published append-only journal chain. Every record must
 * be sealed, linked to its predecessor and follow the single allowed phase
 * order; steps may only advance.
 */
export function validateEmergencyHandoffChain(records) {
  if (!Array.isArray(records) || records.length === 0 || records.length > 64) {
    fail('EMERGENCY_HANDOFF_JOURNAL_INVALID');
  }
  const order = EMERGENCY_HANDOFF_PHASES;
  let previous = null;
  const first = validateJournal(records[0]);
  if (first.phase !== 'INTENT' || first.sequence !== 0 || first.previousHash !== null) {
    fail('EMERGENCY_HANDOFF_JOURNAL_INVALID');
  }
  for (const [index, record] of records.entries()) {
    const body = validateJournal(record);
    if (body.sequence !== index || (index === 0
      ? body.previousHash !== null
      : body.previousHash !== records[index - 1].hash)) {
      fail('EMERGENCY_HANDOFF_JOURNAL_CHAIN_INVALID');
    }
    if (body.authorizationId !== first.authorizationId
      || body.authorizationSha256 !== first.authorizationSha256
      || body.toolArtifactSha256 !== first.toolArtifactSha256
      || body.parentCheckpointSequence !== first.parentCheckpointSequence
      || body.parentCheckpointSha256 !== first.parentCheckpointSha256
      || body.createdAtUTC !== first.createdAtUTC) {
      fail('EMERGENCY_HANDOFF_JOURNAL_CHAIN_INVALID');
    }
    if (index > 0) {
      const from = order.indexOf(previous.phase), to = order.indexOf(body.phase);
      if (to !== from + 1) fail('EMERGENCY_HANDOFF_JOURNAL_CHAIN_INVALID');
      if (STEP_KEYS.some(key => previous.steps[key] === true && body.steps[key] !== true)) {
        fail('EMERGENCY_HANDOFF_JOURNAL_CHAIN_INVALID');
      }
      if (Date.parse(body.updatedAtUTC) < Date.parse(previous.updatedAtUTC)) {
        fail('EMERGENCY_HANDOFF_JOURNAL_CHAIN_INVALID');
      }
    }
    previous = body;
  }
  return records.at(-1);
}

/** Seals the terminal operational receipt. It never claims R4 acceptance. */
export function sealEmergencyHandoffReceipt(journal, record, context, nowUTC) {
  const body = validateJournal(journal);
  validateAuthorization(record, context);
  if (body.phase !== 'HANDOFF_COMPLETE' || body.handoffComplete !== true) {
    fail('EMERGENCY_HANDOFF_NOT_COMPLETE');
  }
  if (body.authorizationId !== record.authorizationId
    || body.authorizationSha256 !== context.authorizationSha256
    || body.toolArtifactSha256 !== record.toolArtifactSha256
    || body.parentCheckpointSequence !== record.parent.checkpointSequence
    || body.parentCheckpointSha256 !== record.parent.checkpointSha256) {
    fail('EMERGENCY_HANDOFF_RECEIPT_BINDING_MISMATCH');
  }
  if (!instant(nowUTC) || Date.parse(nowUTC) < Date.parse(body.updatedAtUTC)) {
    fail('EMERGENCY_HANDOFF_RECEIPT_INVALID');
  }
  return sealed({
    formatVersion: 1, kind: 'EMERGENCY_HANDOFF_RECEIPT',
    operationalStatus: EMERGENCY_OPERATIONAL_STATUS,
    r4TerminalState: EMERGENCY_R4_TERMINAL_STATE,
    r4Acceptance: 'NOT_ACCEPTED',
    observationPassed: false, parentAttemptCompleted: false,
    futureReleaseAuthority: false,
    authorizationId: record.authorizationId,
    authorizationSha256: context.authorizationSha256,
    toolArtifactSha256: record.toolArtifactSha256,
    parent: {
      attemptId: record.parent.attemptId,
      approvalSha256: record.parent.approvalSha256,
      profileSha256: record.parent.profileSha256,
      checkpointSequence: record.parent.checkpointSequence,
      checkpointSha256: record.parent.checkpointSha256,
      phase: record.parent.phase,
    },
    handoff: {
      journalHeadSha256: journal.hash,
      steps: {...body.steps},
      completedAtUTC: nowUTC,
    },
    host: {
      machineId: context.host.machineId,
      database: {...context.host.database},
      releaseSha: context.host.releaseSha,
      schemaHead: record.parent.schemaHead,
      startBudget: {used: record.parent.starts, max: record.parent.maxStarts},
    },
    backups: {...context.backups},
  });
}

function validateReceipt(receipt) {
  if (!exactKeys(receipt, [...RECEIPT_KEYS, 'hash'])) fail('EMERGENCY_HANDOFF_RECEIPT_INVALID');
  const body = {...receipt};
  delete body.hash;
  if (digest(canonical(body)) !== receipt.hash) fail('EMERGENCY_HANDOFF_RECEIPT_HASH_INVALID');
  if (body.formatVersion !== 1 || body.kind !== 'EMERGENCY_HANDOFF_RECEIPT'
    || body.operationalStatus !== EMERGENCY_OPERATIONAL_STATUS
    || body.r4TerminalState !== EMERGENCY_R4_TERMINAL_STATE
    || body.r4Acceptance !== 'NOT_ACCEPTED'
    || body.observationPassed !== false || body.parentAttemptCompleted !== false
    || body.futureReleaseAuthority !== false
    || !uuid(body.authorizationId) || !hex(body.authorizationSha256, 64)
    || !hex(body.toolArtifactSha256, 64)
    || !exactKeys(body.parent, RECEIPT_PARENT_KEYS)
    || !uuid(body.parent.attemptId) || !hex(body.parent.approvalSha256, 64)
    || !hex(body.parent.profileSha256, 64)
    || !Number.isSafeInteger(body.parent.checkpointSequence) || body.parent.checkpointSequence < 0
    || !hex(body.parent.checkpointSha256, 64)
    || body.parent.phase !== 'POSTDEPLOY_BACKUP_PASSED'
    || !exactKeys(body.handoff, RECEIPT_HANDOFF_KEYS)
    || !hex(body.handoff.journalHeadSha256, 64) || !exactKeys(body.handoff.steps, STEP_KEYS)
    || STEP_KEYS.some(key => body.handoff.steps[key] !== true)
    || !instant(body.handoff.completedAtUTC)
    || !exactKeys(body.host, RECEIPT_HOST_KEYS)
    || !hex(body.host.machineId, 32) || !exactKeys(body.host.database, DATABASE_KEYS)
    || !hex(body.host.releaseSha, 40) || typeof body.host.schemaHead !== 'string'
    || !exactKeys(body.host.startBudget, RECEIPT_BUDGET_KEYS)
    || !Number.isSafeInteger(body.host.startBudget.used)
    || !Number.isSafeInteger(body.host.startBudget.max)
    || body.host.startBudget.used !== body.host.startBudget.max
    || !exactKeys(body.backups, BACKUP_KEYS)
    || !hex(body.backups.preSha256, 64) || !hex(body.backups.postSha256, 64)) {
    fail('EMERGENCY_HANDOFF_RECEIPT_INVALID');
  }
  return body;
}

/**
 * Validates a terminal receipt and returns the only record a future
 * forward-only transition may consume. The parent is SUPERSEDED, never
 * COMPLETED, and the receipt grants no release authority by itself.
 */
export function verifyEmergencyHandoffReceipt(receipt, expected) {
  if (!isObject(receipt)) fail('EMERGENCY_HANDOFF_RECEIPT_INVALID');
  const body = validateReceipt(receipt);
  if (!exactKeys(expected, EXPECTED_RECEIPT_KEYS) || !uuid(expected.authorizationId)
    || !hex(expected.authorizationSha256, 64) || !hex(expected.toolArtifactSha256, 64)
    || !exactKeys(expected.parent, PARENT_KEYS)) {
    fail('EMERGENCY_HANDOFF_RECEIPT_INVALID');
  }
  if (body.authorizationId !== expected.authorizationId
    || body.authorizationSha256 !== expected.authorizationSha256
    || body.toolArtifactSha256 !== expected.toolArtifactSha256
    || RECEIPT_PARENT_KEYS.some(key => body.parent[key] !== expected.parent[key])) {
    fail('EMERGENCY_HANDOFF_RECEIPT_BINDING_MISMATCH');
  }
  return Object.freeze({
    kind: 'PARENT_ATTEMPT_SUPERSESSION',
    disposition: 'SUPERSEDED_BY_EMERGENCY_HANDOFF',
    parentAttemptId: body.parent.attemptId,
    parentCheckpointSequence: body.parent.checkpointSequence,
    parentCheckpointSha256: body.parent.checkpointSha256,
    emergencyAuthorizationId: body.authorizationId,
    emergencyJournalHeadSha256: body.handoff.journalHeadSha256,
    r4TerminalState: EMERGENCY_R4_TERMINAL_STATE,
    parentAttemptCompleted: false,
    grantsReleaseAuthority: false,
  });
}

/**
 * Gate a future 060 -> new-release forward-only transition. The parent owner
 * must be retired, no barrier/permit/recovery policy may remain, and the app
 * must be under normal systemd restart protection. A receipt alone never
 * authorizes a release.
 */
export function assertForwardTransitionEligible({receipt, expected, live}) {
  const supersession = verifyEmergencyHandoffReceipt(receipt, expected);
  if (!exactKeys(live, FORWARD_LIVE_KEYS)) fail('FORWARD_TRANSITION_LIVE_STATE_INVALID');
  if (live.activeAttemptId !== null) fail('FORWARD_TRANSITION_OWNERSHIP_CONFLICT');
  if (live.barrierPresent !== false || live.permitPresent !== false) {
    fail('FORWARD_TRANSITION_OWNERSHIP_CONFLICT');
  }
  if (live.dropInPresent !== false || live.restartPolicy !== 'on-failure') {
    fail('FORWARD_TRANSITION_POLICY_CONFLICT');
  }
  return supersession;
}

/** Derives the authorization parent/host binding from canonical parent state.
 * Pure helper used by the root issuer; it never reads I/O itself.
 */
export function emergencyAuthorizationBinding({attemptId, approvalSha256, profileSha256,
  checkpoint, approval, profile}) {
  if (!isObject(checkpoint) || !isObject(approval) || !isObject(profile)) {
    fail('EMERGENCY_HANDOFF_BINDING_INVALID');
  }
  const catalog = approval.targetCatalog;
  if (!Array.isArray(catalog) || catalog.length === 0) fail('EMERGENCY_HANDOFF_BINDING_INVALID');
  const schemaHead = catalog.at(-1).version;
  return {
    parent: {
      attemptId, approvalSha256, profileSha256,
      checkpointSequence: checkpoint.sequence, checkpointSha256: checkpoint.sha256,
      phase: checkpoint.phase, migrationCommitted: checkpoint.migrationCommitted,
      schemaHead, starts: checkpoint.starts, maxStarts: approval.maxStarts,
      lastStart: checkpoint.lastStart,
    },
    host: {
      machineId: profile.machineId,
      database: {...profile.databaseIdentity},
      releaseSha: approval.releaseSha,
      releaseArtifactSha256: approval.artifactSha256,
      timeModuleSha256: profile.contracts.timeModuleSha256,
      timeConfigSha256: profile.contracts.timeConfigSha256,
    },
  };
}
