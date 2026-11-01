// Synthetic adapter port. Never installed or used by the production CLI.
import {createHash} from 'node:crypto';
import {FORWARD_ACTIONS, FORWARD_FORBIDDEN, FORWARD_PARENT_DISPOSITION} from '../scripts/forward-transition.mjs';
export const hash = value => createHash('sha256').update(value).digest('hex');
export const HEAD = '060_crm_duplicate_review_decisions';
export function fixture() {
  const catalog = Array.from({length: 60}, (_, i) => ({
    version: i === 59 ? HEAD : String(i + 1).padStart(3, '0') + '_fixture', sha256: '1'.repeat(64),
  }));
  const authorization = {
    formatVersion: 1, kind: 'FORWARD_TRANSITION_AUTHORIZATION',
    authorizationId: '33333333-3333-4333-8333-333333333333',
    attemptId: '22222222-2222-4222-8222-222222222222',
    issuedAtUTC: '2026-11-01T16:00:00Z', expiresAtUTC: '2026-11-01T20:00:00Z',
    maxUses: 1, reason: 'FORWARD_HOST_FIXTURE', scope: 'FORWARD_ONLY_RELEASE_TRANSITION',
    parent: {attemptId: '11111111-1111-4111-8111-111111111111', approvalSha256: 'a'.repeat(64),
      profileSha256: 'b'.repeat(64), checkpointSequence: 17, checkpointSha256: 'c'.repeat(64),
      emergencyAuthorizationId: '44444444-4444-4444-8444-444444444444',
      emergencyJournalHeadSha256: 'd'.repeat(64), emergencyReceiptSha256: 'e'.repeat(64),
      disposition: FORWARD_PARENT_DISPOSITION},
    old: {releaseSha: 'f5f87d450061ca12ee80451c55eb56e99b80823c', artifactSha256: '1'.repeat(64), schemaHead: HEAD, catalog},
    target: {releaseSha: 'a'.repeat(40), treeSha: 'b'.repeat(40), artifactSha256: '2'.repeat(64), ciManifestSha256: '3'.repeat(64), schemaHead: HEAD, catalog},
    host: {machineId: '4'.repeat(32), database: {clusterId: '123', databaseName: 'servora_med_test_forward', databaseOid: '16384', role: 'servora', host: '127.0.0.1', port: 5432}},
    migration: {allowed: false, required: false, authorizedMigrations: []},
    budgets: {maxStarts: 2, maxObservationAttempts: 1}, actions: [...FORWARD_ACTIONS], forbidden: [...FORWARD_FORBIDDEN],
  };
  const log = [], effects = [];
  let release = authorization.old.releaseSha, active = true, policy = 'on-failure', owner = false;
  let clock = Date.parse('2026-11-01T17:00:00Z');
  const io = {
    now: () => new Date(clock).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    readLog: () => structuredClone(log),
    append: record => { log.push(structuredClone(record)); },
    check: async () => {},
    context: async () => ({nowUTC: io.now(), authorizationSha256: hash(JSON.stringify(authorization) + '\n'),
      supersession: {kind: 'PARENT_ATTEMPT_SUPERSESSION', disposition: FORWARD_PARENT_DISPOSITION,
        parentAttemptId: authorization.parent.attemptId, parentCheckpointSequence: 17,
        parentCheckpointSha256: authorization.parent.checkpointSha256,
        emergencyAuthorizationId: authorization.parent.emergencyAuthorizationId,
        emergencyJournalHeadSha256: authorization.parent.emergencyJournalHeadSha256,
        parentAttemptCompleted: false, grantsReleaseAuthority: false},
      emergency: {receiptSha256: authorization.parent.emergencyReceiptSha256, journalHeadSha256: authorization.parent.emergencyJournalHeadSha256},
      parentIdentity: {approvalSha256: authorization.parent.approvalSha256, profileSha256: authorization.parent.profileSha256},
      host: {machineId: authorization.host.machineId, database: authorization.host.database,
        schemaHead: HEAD, appActive: active, restartPolicy: policy, releaseSha: release,
        artifactSha256: release === authorization.old.releaseSha ? authorization.old.artifactSha256 : authorization.target.artifactSha256,
        activeOwnerIds: owner ? [authorization.attemptId] : []}, target: authorization.target, journal: {present: log.length > 0}}),
    identity: async () => active ? {pid: release === authorization.old.releaseSha ? 101 : 102, startTime: '123', bootId: 'boot-fixture', invocationId: 'a'.repeat(32)} : null,
    effect: async (operation, data) => {
      effects.push({operation, data: structuredClone(data), phase: log.at(-1).contract.phase, event: log.at(-1).event});
      if (operation === 'OWNER') owner = true;
      if (operation === 'FENCE') policy = 'no';
      if (operation === 'STOP') active = false;
      if (operation === 'POINTER') release = authorization.target.releaseSha;
      if (operation === 'START') active = true;
      if (operation === 'HANDOFF') policy = 'on-failure';
      if (operation === 'RETIRE') owner = false;
      return {operation, ...(operation === 'START' ? {identity: await io.identity()} : {})};
    },
    reconcile: async () => { throw new Error('FORWARD_HOST_OUTCOME_UNKNOWN'); },
    verifyTarget: async () => { if (!active || release !== authorization.target.releaseSha) throw new Error('FORWARD_HOST_TARGET_UNHEALTHY'); },
    verifyBackups: async () => {},
    verifyObservation: async proof => proof,
    observe: async () => { throw new Error('REAL_OBSERVATION_NOT_RUN'); },
    toolHash: '9'.repeat(64),
  };
  return {authorization, io, log, effects, tick: ms => { clock += ms; }};
}
