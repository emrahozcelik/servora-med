/**
 * DRAFT — emergency handoff state machine for the fenced R4 attempt.
 *
 * This module is pure: it performs no filesystem, database, systemd or network
 * operations. It proves the authorization binding, the append-only sidecar
 * journal and the interruption-safe next-action plan before any production
 * integration is written.
 *
 * It deliberately has no observation/completion authority: the parent attempt
 * remains incomplete and the sidecar records `observationPassed:false` and
 * `acceptanceWaived:true`. A true R4 COMPLETED requires the separate
 * forward-only transition contract.
 */
import {createHash} from 'node:crypto';

export const EMERGENCY_HANDOFF_ACTIONS = Object.freeze([
  'restore_restart_on_failure','remove_barrier','retire_owner',
]);
export const EMERGENCY_HANDOFF_FORBIDDEN = Object.freeze([
  'observation_passed','completed','migration','release_change',
]);
export const EMERGENCY_HANDOFF_PHASES = Object.freeze([
  'INTENT','POLICY_RESTORED','BARRIER_REMOVED','OWNER_RETIRED','COMPLETED',
]);

const AUTH_KEYS = ['formatVersion','kind','authorizationId','issuedAtUTC','expiresAtUTC',
  'maxUses','reason','parent','host','backups','actions','forbidden','toolSha256'];
const PARENT_KEYS = ['attemptId','approvalSha256','profileSha256','checkpointSequence',
  'checkpointSha256','phase','migrationCommitted'];
const HOST_KEYS = ['machineId','database','schemaHead','releaseSha','releaseArtifactSha256',
  'timeModuleSha256','timeConfigSha256','startBudget'];
const DATABASE_KEYS = ['clusterId','databaseName','databaseOid'];
const BUDGET_KEYS = ['used','max'];
const BACKUP_KEYS = ['preSha256','postSha256'];
const CONTEXT_KEYS = ['nowUTC','authorizationSha256','toolSha256','parent','host','backups','live'];
const LIVE_KEYS = ['activeAttemptId','activeApprovalSha256','barrierAttemptId',
  'barrierApprovalSha256','permitPresent','foreignOwner','appActive','appPid','coreHealth',
  'releaseSha','schemaHead','starts','maxStarts','dropInPresent','restartPolicy'];
const JOURNAL_KEYS = ['formatVersion','kind','authorizationId','authorizationSha256',
  'parentCheckpointSequence','parentCheckpointSha256','phase','observationPassed',
  'acceptanceWaived','handoffCompleted','steps','sequence','previousHash','createdAtUTC',
  'updatedAtUTC'];
const STEPS_KEYS = ['policyRestored','barrierRemoved','ownerRetired'];

const fail = code => { throw new Error(code); };
const digest = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value) + '\n';
const sealed = body => ({...body, hash: digest(canonical(body))});

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value,key));
}
function hex(value, length) {
  return typeof value === 'string' && new RegExp('^[0-9a-f]{'+length+'}$').test(value);
}
function instant(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}
function sealedRecord(record) {
  if (!exactKeys(record, [...JOURNAL_KEYS,'hash'])) fail('EMERGENCY_HANDOFF_JOURNAL_INVALID');
  const body = {...record}; delete body.hash;
  if (digest(canonical(body)) !== record.hash) fail('EMERGENCY_HANDOFF_JOURNAL_HASH_INVALID');
  return body;
}
function validateAuthorization(record, context) {
  if (!exactKeys(record, AUTH_KEYS) || record.formatVersion !== 1
    || record.kind !== 'EMERGENCY_HANDOFF_AUTHORIZATION'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(record.authorizationId)
    || !instant(record.issuedAtUTC) || !instant(record.expiresAtUTC)
    || Date.parse(record.issuedAtUTC) >= Date.parse(record.expiresAtUTC)
    || record.maxUses !== 1 || typeof record.reason !== 'string' || record.reason.length === 0
    || !exactKeys(record.parent, PARENT_KEYS) || !exactKeys(record.host, HOST_KEYS)
    || !exactKeys(record.host.database, DATABASE_KEYS) || !exactKeys(record.host.startBudget, BUDGET_KEYS)
    || !exactKeys(record.backups, BACKUP_KEYS)
    || !Array.isArray(record.actions) || !Array.isArray(record.forbidden)
    || JSON.stringify(record.actions) !== JSON.stringify(EMERGENCY_HANDOFF_ACTIONS)
    || JSON.stringify(record.forbidden) !== JSON.stringify(EMERGENCY_HANDOFF_FORBIDDEN)
    || !hex(record.parent.approvalSha256,64) || !hex(record.parent.profileSha256,64)
    || !hex(record.parent.checkpointSha256,64) || !Number.isSafeInteger(record.parent.checkpointSequence)
    || record.parent.checkpointSequence < 0 || record.parent.phase !== 'POSTDEPLOY_BACKUP_PASSED'
    || record.parent.migrationCommitted !== true
    || !hex(record.host.machineId,32) || !/^[1-9][0-9]*$/.test(record.host.database.clusterId)
    || typeof record.host.database.databaseName !== 'string' || !/^[a-z_][a-z0-9_]*$/.test(record.host.database.databaseName)
    || !Number.isSafeInteger(record.host.database.databaseOid) || record.host.database.databaseOid < 1
    || record.host.schemaHead !== '060_crm_duplicate_review_decisions'
    || !hex(record.host.releaseSha,40) || !hex(record.host.releaseArtifactSha256,64)
    || !hex(record.host.timeModuleSha256,64) || !hex(record.host.timeConfigSha256,64)
    || !Number.isSafeInteger(record.host.startBudget.used) || !Number.isSafeInteger(record.host.startBudget.max)
    || record.host.startBudget.max !== 2 || record.host.startBudget.used !== record.host.startBudget.max
    || !hex(record.backups.preSha256,64) || !hex(record.backups.postSha256,64)
    || !hex(record.toolSha256,64)) fail('EMERGENCY_HANDOFF_AUTHORIZATION_INVALID');
  if (!exactKeys(context, CONTEXT_KEYS) || !instant(context.nowUTC) || !hex(context.authorizationSha256,64)
    || !hex(context.toolSha256,64) || !exactKeys(context.parent, PARENT_KEYS)
    || !exactKeys(context.host, HOST_KEYS) || !exactKeys(context.host.database, DATABASE_KEYS)
    || !exactKeys(context.host.startBudget, BUDGET_KEYS) || !exactKeys(context.backups, BACKUP_KEYS)
    || !exactKeys(context.live, LIVE_KEYS)) fail('EMERGENCY_HANDOFF_CONTEXT_INVALID');
  if (Date.parse(context.nowUTC) < Date.parse(record.issuedAtUTC)
    || Date.parse(context.nowUTC) >= Date.parse(record.expiresAtUTC)) fail('EMERGENCY_HANDOFF_AUTHORIZATION_EXPIRED');
  if (JSON.stringify(record.parent) !== JSON.stringify(context.parent)
    || JSON.stringify(record.host) !== JSON.stringify(context.host)
    || JSON.stringify(record.backups) !== JSON.stringify(context.backups)
    || record.toolSha256 !== context.toolSha256) fail('EMERGENCY_HANDOFF_BINDING_MISMATCH');
  const live = context.live;
  if (live.activeAttemptId !== record.parent.attemptId
    || live.activeApprovalSha256 !== record.parent.approvalSha256
    || live.barrierAttemptId !== record.parent.attemptId
    || live.barrierApprovalSha256 !== record.parent.approvalSha256
    || live.permitPresent !== false || live.foreignOwner !== false
    || live.appActive !== true || !Number.isSafeInteger(live.appPid) || live.appPid < 1
    || live.coreHealth !== true || live.releaseSha !== record.host.releaseSha
    || live.schemaHead !== record.host.schemaHead
    || live.starts !== record.host.startBudget.used || live.maxStarts !== record.host.startBudget.max
    || live.dropInPresent !== true || live.restartPolicy !== 'no') fail('EMERGENCY_HANDOFF_LIVE_STATE_MISMATCH');
  return record;
}

/**
 * Validates the root authorization against the captured parent, host and live
 * state. No mutation, no observation authority.
 */
export function validateEmergencyHandoffAuthorization(record, context) {
  return validateAuthorization(record,context);
}

/** Creates the append-only INTENT record. The parent journal is untouched. */
export function initialEmergencyHandoff(record, context) {
  validateAuthorization(record,context);
  const body = {
    formatVersion:1, kind:'EMERGENCY_HANDOFF',
    authorizationId:record.authorizationId, authorizationSha256:context.authorizationSha256,
    parentCheckpointSequence:record.parent.checkpointSequence,
    parentCheckpointSha256:record.parent.checkpointSha256,
    phase:'INTENT', observationPassed:false, acceptanceWaived:true, handoffCompleted:false,
    steps:{policyRestored:false,barrierRemoved:false,ownerRetired:false},
    sequence:0, previousHash:null, createdAtUTC:context.nowUTC, updatedAtUTC:context.nowUTC,
  };
  return sealed(body);
}

const EVENTS = Object.freeze({
  POLICY_RESTORED:{from:'INTENT',phase:'POLICY_RESTORED',step:'policyRestored'},
  BARRIER_REMOVED:{from:'POLICY_RESTORED',phase:'BARRIER_REMOVED',step:'barrierRemoved'},
  OWNER_RETIRED:{from:'BARRIER_REMOVED',phase:'OWNER_RETIRED',step:'ownerRetired'},
  COMPLETED:{from:'OWNER_RETIRED',phase:'COMPLETED',step:null},
});

/**
 * Appends one handoff step. Only the four handoff events are accepted; there is
 * deliberately no OBSERVATION_PASSED/ACCEPTED/COMPLETED_ACCEPTANCE transition.
 */
export function advanceEmergencyHandoff(journal, event, nowUTC) {
  const body = sealedRecord(journal);
  if (!Object.hasOwn(EVENTS,event) || !instant(nowUTC)) fail('EMERGENCY_HANDOFF_EVENT_INVALID');
  const transition = EVENTS[event];
  if (body.phase !== transition.from || body.observationPassed !== false
    || body.acceptanceWaived !== true || !exactKeys(body.steps, STEPS_KEYS)
    || (event === 'COMPLETED' && !Object.values(body.steps).every(Boolean))
    || (event === 'OWNER_RETIRED' && (!body.steps.policyRestored || !body.steps.barrierRemoved))) {
    fail('EMERGENCY_HANDOFF_TRANSITION_INVALID');
  }
  const next = {...body, sequence:body.sequence+1, previousHash:journal.hash, updatedAtUTC:nowUTC,
    phase:transition.phase, steps:{...body.steps}, handoffCompleted:event === 'COMPLETED'};
  if (transition.step) next.steps[transition.step] = true;
  if (event === 'COMPLETED') next.observationPassed = false;
  return sealed(next);
}

/**
 * Maps the observed live state to exactly one next action. Already-performed
 * steps are only *recorded*; mutations are never repeated. Any inconsistent
 * combination returns STOP and the caller must make no change.
 */
export function nextEmergencyHandoffAction(journal, observed) {
  const body = sealedRecord(journal);
  if (!observed || typeof observed !== 'object' || Array.isArray(observed)
    || !['dropInPresent','barrierPresent','ownerPresent'].every(key => typeof observed[key] === 'boolean')
    || !['no','on-failure'].includes(observed.restartPolicy)) fail('EMERGENCY_HANDOFF_OBSERVATION_INVALID');
  const {dropInPresent,barrierPresent,ownerPresent,restartPolicy} = observed;
  const allGone = !dropInPresent && !barrierPresent && !ownerPresent && restartPolicy === 'on-failure';
  if (body.phase === 'COMPLETED') return allGone ? 'DONE' : 'STOP';
  if (!body.steps.policyRestored) {
    if (dropInPresent && restartPolicy === 'no' && barrierPresent && ownerPresent) return 'REMOVE_POLICY';
    if (!dropInPresent && restartPolicy === 'on-failure' && barrierPresent && ownerPresent) return 'RECORD_POLICY';
    return 'STOP';
  }
  if (!body.steps.barrierRemoved) {
    if (!dropInPresent && restartPolicy === 'on-failure' && barrierPresent && ownerPresent) return 'REMOVE_BARRIER';
    if (!dropInPresent && restartPolicy === 'on-failure' && !barrierPresent && ownerPresent) return 'RECORD_BARRIER';
    return 'STOP';
  }
  if (!body.steps.ownerRetired) {
    if (!dropInPresent && restartPolicy === 'on-failure' && !barrierPresent && ownerPresent) return 'RETIRE_OWNER';
    if (allGone) return 'RECORD_OWNER';
    return 'STOP';
  }
  return allGone ? 'SEAL_COMPLETED' : 'STOP';
}
