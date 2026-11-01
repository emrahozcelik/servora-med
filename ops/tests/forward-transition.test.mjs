import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  FORWARD_TRANSITION_SCOPE,
  FORWARD_PARENT_DISPOSITION,
  FORWARD_PHASES,
  FORWARD_ACTIONS,
  FORWARD_FORBIDDEN,
  FORWARD_OBSERVATION_SECONDS,
  validateForwardAuthorizationStructure,
  validateForwardAuthorization,
  validateConsumedForwardAuthorization,
  classifyForwardCatalog,
  initialForwardTransition,
  advanceForwardTransition,
  nextForwardAction,
  validateForwardChain,
  recordForwardObservation,
  sealForwardAcceptance,
  verifyForwardAcceptance,
  assertEmergencySupersession,
  forwardAuthorizationBinding,
} from '../scripts/forward-transition.mjs';

const h = c => c.repeat(64);
const NOW = '2026-11-01T17:00:00Z';
const NEW_ATTEMPT = '22222222-2222-4222-8222-222222222222';
const PARENT_ATTEMPT = '6ce4cff0-fa73-450e-b540-3f54ae429e7c';
const EMERGENCY_AUTH = '52f632ef-ca3e-49ab-a26e-0b562adc2c78';
const OLD_RELEASE = 'f5f87d450061ca12ee80451c55eb56e99b80823c';
const TARGET_RELEASE = 'a'.repeat(40);
const TARGET_TREE = 'b'.repeat(40);
const HEAD = '060_crm_duplicate_review_decisions';
const CATALOG = Object.freeze([
  ...Array.from({length: 59}, (_, index) => Object.freeze({
    version: String(index + 1).padStart(3, '0') + '_step_' + String(index + 1),
    sha256: h('1'),
  })),
  Object.freeze({version: HEAD, sha256: h('2')}),
]);
const RECEIPT_SHA = h('7');
const JOURNAL_HEAD = h('8');
const MACHINE_ID = 'ae00df7d546249218e3c5c2b5e21ecb6';
const DATABASE = Object.freeze({
  clusterId: '7678331783042422178', databaseName: 'servora_med',
  databaseOid: '16389', role: 'servora', host: '127.0.0.1', port: 5432,
});

function supersession(overrides = {}) {
  return {
    kind: 'PARENT_ATTEMPT_SUPERSESSION',
    disposition: FORWARD_PARENT_DISPOSITION,
    parentAttemptId: PARENT_ATTEMPT,
    parentCheckpointSequence: 17,
    parentCheckpointSha256: h('c'),
    emergencyAuthorizationId: EMERGENCY_AUTH,
    emergencyJournalHeadSha256: JOURNAL_HEAD,
    r4TerminalState: 'HEALTH_PASSED_FENCED',
    processContinuity: 'PRESERVED',
    parentAttemptCompleted: false,
    grantsReleaseAuthority: false,
    ...overrides,
  };
}

function authorization(overrides = {}) {
  return {
    formatVersion: 1,
    kind: 'FORWARD_TRANSITION_AUTHORIZATION',
    authorizationId: '33333333-3333-4333-8333-333333333333',
    issuedAtUTC: '2026-11-01T16:30:00Z',
    expiresAtUTC: '2026-11-01T17:30:00Z',
    maxUses: 1,
    reason: 'R4_OBSERVATION_TRUSTED_TIME_BLOCKED',
    scope: FORWARD_TRANSITION_SCOPE,
    attemptId: NEW_ATTEMPT,
    parent: {
      attemptId: PARENT_ATTEMPT,
      approvalSha256: h('a'),
      profileSha256: h('b'),
      checkpointSequence: 17,
      checkpointSha256: h('c'),
      emergencyAuthorizationId: EMERGENCY_AUTH,
      emergencyJournalHeadSha256: JOURNAL_HEAD,
      emergencyReceiptSha256: RECEIPT_SHA,
      disposition: FORWARD_PARENT_DISPOSITION,
    },
    old: {releaseSha: OLD_RELEASE, artifactSha256: h('d'), schemaHead: HEAD, catalog: [...CATALOG]},
    target: {
      releaseSha: TARGET_RELEASE, treeSha: TARGET_TREE,
      artifactSha256: h('e'), ciManifestSha256: h('f'),
      schemaHead: HEAD, catalog: [...CATALOG],
    },
    host: {machineId: MACHINE_ID, database: {...DATABASE}},
    migration: {allowed: false, required: false, authorizedMigrations: []},
    budgets: {maxStarts: 2, maxObservationAttempts: 1},
    actions: [...FORWARD_ACTIONS],
    forbidden: [...FORWARD_FORBIDDEN],
    ...overrides,
  };
}

function context(overrides = {}) {
  const a = authorization();
  return {
    nowUTC: NOW,
    authorizationSha256: h('9'),
    supersession: supersession(),
    emergency: {receiptSha256: RECEIPT_SHA, journalHeadSha256: JOURNAL_HEAD},
    parentIdentity: {approvalSha256: h('a'), profileSha256: h('b')},
    host: {
      machineId: MACHINE_ID,
      database: {...DATABASE},
      schemaHead: HEAD,
      releaseSha: OLD_RELEASE,
      artifactSha256: h('d'),
      restartPolicy: 'on-failure',
      appActive: true,
      activeOwnerIds: [],
    },
    target: {
      releaseSha: TARGET_RELEASE,
      treeSha: TARGET_TREE,
      artifactSha256: h('e'),
      ciManifestSha256: h('f'),
      catalog: [...CATALOG],
    },
    journal: {present: false},
    ...overrides,
  };
}

function targetContext(overrides = {}) {
  const base = context({
    journal: {present: true},
    host: {
      ...context().host,
      releaseSha: TARGET_RELEASE,
      artifactSha256: h('e'),
      activeOwnerIds: [NEW_ATTEMPT],
    },
  });
  return {...base, ...overrides};
}

function started() {
  return initialForwardTransition(authorization(), context());
}

function walk(journal, events) {
  let current = journal;
  let at = Date.parse(journal.updatedAtUTC);
  for (const event of events) {
    at += 1000;
    current = advanceForwardTransition(current, event, new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z'));
  }
  return current;
}

const TO_OBSERVATION_STARTED = [
  'PREFLIGHT_PASSED', 'BACKUP_INTENT', 'PREDEPLOY_BACKUP_PASSED', 'STOP_INTENT',
  'OLD_STOPPED', 'ACTIVATE_INTENT', 'TARGET_ACTIVATED', 'HEALTH_PASSED',
  'SMOKE_PASSED', 'POSTDEPLOY_BACKUP_INTENT', 'POSTDEPLOY_BACKUP_PASSED',
  'OBSERVATION_INTENT', 'OBSERVATION_STARTED',
];

function observation(overrides = {}) {
  return {
    startedAtUTC: '2026-11-01T17:30:00Z',
    completedAtUTC: '2026-11-01T18:00:00Z',
    seconds: FORWARD_OBSERVATION_SECONDS,
    samples: 60,
    pid: 451513,
    pidStartTime: '115266971',
    bootId: 'boot-a',
    endPid: 451513,
    endStartTime: '115266971',
    endBootId: 'boot-a',
    ...overrides,
  };
}

test('FWD-01: the authorization binds the sealed emergency supersession and rejects a foreign parent', () => {
  assert.equal(validateForwardAuthorizationStructure(authorization()).scope, FORWARD_TRANSITION_SCOPE);
  assert.throws(
    () => validateForwardAuthorization(authorization(), context({supersession: supersession({parentAttemptId: '44444444-4444-4444-8444-444444444444'})})),
    /FORWARD_TRANSITION_PARENT_MISMATCH/,
  );
  assert.throws(
    () => validateForwardAuthorization(authorization(), context({emergency: {receiptSha256: h('0'), journalHeadSha256: JOURNAL_HEAD}})),
    /FORWARD_TRANSITION_RECEIPT_BINDING_MISMATCH/,
  );
});

test('FWD-02: a COMPLETED parent or a receipt that grants release authority is rejected', () => {
  assert.throws(
    () => validateForwardAuthorization(authorization(), context({supersession: supersession({parentAttemptCompleted: true})})),
    /FORWARD_TRANSITION_PARENT_COMPLETED/,
  );
  assert.throws(
    () => validateForwardAuthorization(authorization(), context({supersession: supersession({grantsReleaseAuthority: true})})),
    /FORWARD_TRANSITION_PARENT_COMPLETED/,
  );
  assert.throws(
    () => validateForwardAuthorization(authorization(), context({supersession: supersession({disposition: 'COMPLETED'})})),
    /FORWARD_TRANSITION_PARENT_MISMATCH/,
  );
});

test('FWD-03: the schema head must be the exact 060 head on both sides', () => {
  assert.throws(
    () => validateForwardAuthorization(authorization({
      old: {...authorization().old, schemaHead: '061_next'},
      target: {...authorization().target, schemaHead: '061_next'},
    }), context()),
    /FORWARD_TRANSITION_SCHEMA_MISMATCH/,
  );
  assert.throws(
    () => validateForwardAuthorization(authorization(), context({host: {...context().host, schemaHead: '055_old'}})),
    /FORWARD_TRANSITION_SCHEMA_MISMATCH/,
  );
});

test('FWD-04: a target artifact, tree or release mismatch is rejected', () => {
  assert.throws(
    () => validateForwardAuthorization(authorization(), context({target: {...context().target, artifactSha256: h('0')}})),
    /FORWARD_TRANSITION_ARTIFACT_MISMATCH/,
  );
  assert.throws(
    () => validateForwardAuthorization(authorization(), context({target: {...context().target, treeSha: 'c'.repeat(40)}})),
    /FORWARD_TRANSITION_ARTIFACT_MISMATCH/,
  );
  assert.throws(
    () => validateForwardAuthorization(authorization(), context({host: {...context().host, releaseSha: TARGET_RELEASE}})),
    /FORWARD_TRANSITION_OLD_STATE_MISMATCH/,
  );
});

test('FWD-05: a wrong CI manifest binding is rejected', () => {
  assert.throws(
    () => validateForwardAuthorization(authorization(), context({target: {...context().target, ciManifestSha256: h('0')}})),
    /FORWARD_TRANSITION_CI_MANIFEST_MISMATCH/,
  );
  assert.throws(
    () => validateForwardAuthorizationStructure(authorization({target: {...authorization().target, ciManifestSha256: 'not-a-digest'}})),
    /FORWARD_TRANSITION_AUTHORIZATION_INVALID/,
  );
});

test('FWD-06: a foreign active owner blocks the transition', () => {
  assert.throws(
    () => validateForwardAuthorization(authorization(), context({host: {...context().host, activeOwnerIds: ['55555555-5555-4555-8555-555555555555']}})),
    /FORWARD_TRANSITION_OWNER_CONFLICT/,
  );
});

test('FWD-07: no valid authorization means no journal', () => {
  assert.throws(
    () => initialForwardTransition(authorization(), context({journal: {present: true}})),
    /FORWARD_TRANSITION_ALREADY_STARTED/,
  );
  assert.throws(
    () => initialForwardTransition(authorization({scope: 'EMERGENCY_RESTART_POLICY_HANDOFF'}), context()),
    /FORWARD_TRANSITION_SCOPE_INVALID/,
  );
  assert.throws(
    () => initialForwardTransition(authorization({actions: ['teleport']}), context()),
    /FORWARD_TRANSITION_AUTHORIZATION_INVALID/,
  );
});

test('FWD-08: migration is refused without separate migration authority', () => {
  assert.equal(classifyForwardCatalog(CATALOG, CATALOG), 'MIGRATION_FREE');
  const pending = [...CATALOG, {version: '061_new_table', sha256: h('3')}];
  assert.equal(classifyForwardCatalog(CATALOG, pending), 'MIGRATION_REQUIRED');
  assert.throws(
    () => validateForwardAuthorization(authorization({
      target: {...authorization().target, catalog: pending},
    }), context({target: {...context().target, catalog: pending}})),
    /FORWARD_TRANSITION_MIGRATION_REQUIRED/,
  );
  assert.throws(
    () => validateForwardAuthorization(authorization({
      migration: {allowed: true, required: true, authorizedMigrations: ['061_new_table']},
    }), context()),
    /FORWARD_TRANSITION_AUTHORIZATION_INVALID/,
  );
  assert.throws(
    () => validateForwardAuthorization(authorization(), context({host: {...context().host, schemaHead: '059_crm_duplicate_review_pending'}})),
    /FORWARD_TRANSITION_SCHEMA_MISMATCH/,
  );
});

test('FWD-09: old and target releases must differ and the old release must be live', () => {
  assert.throws(
    () => validateForwardAuthorization(authorization({target: {...authorization().target, releaseSha: OLD_RELEASE}}), context()),
    /FORWARD_TRANSITION_AUTHORIZATION_INVALID/,
  );
  assert.throws(
    () => validateForwardAuthorization(authorization(), context({host: {...context().host, appActive: false}})),
    /FORWARD_TRANSITION_OLD_STATE_MISMATCH/,
  );
  assert.throws(
    () => validateForwardAuthorization(authorization(), context({host: {...context().host, restartPolicy: 'no'}})),
    /FORWARD_TRANSITION_POLICY_CONFLICT/,
  );
});

test('FWD-10: expired or over-long authorization is rejected', () => {
  assert.throws(
    () => validateForwardAuthorization(authorization(), context({nowUTC: '2026-11-01T17:31:00Z'})),
    /FORWARD_TRANSITION_TIME_INVALID/,
  );
  assert.throws(
    () => validateForwardAuthorizationStructure(authorization({expiresAtUTC: '2026-11-02T17:30:01Z'})),
    /FORWARD_TRANSITION_AUTHORIZATION_INVALID/,
  );
});

test('FWD-11: the journal walks the deterministic phase order and blocks skipped phases', () => {
  const journal = started();
  assert.equal(journal.phase, 'INTENT');
  assert.equal(journal.parentAttemptCompleted, false);
  assert.equal(journal.migrationPerformed, false);
  assert.throws(() => advanceForwardTransition(journal, 'HEALTH_PASSED', NOW), /FORWARD_TRANSITION_TRANSITION_INVALID/);
  const afterBackup = walk(journal, ['PREFLIGHT_PASSED', 'BACKUP_INTENT', 'PREDEPLOY_BACKUP_PASSED']);
  assert.equal(afterBackup.phase, 'PREDEPLOY_BACKUP_PASSED');
  assert.throws(() => advanceForwardTransition(afterBackup, 'ACCEPTED', NOW), /FORWARD_TRANSITION_TRANSITION_INVALID/);
  assert.deepEqual(FORWARD_PHASES.slice(0, 4), ['INTENT', 'PREFLIGHT_PASSED', 'BACKUP_INTENT', 'PREDEPLOY_BACKUP_PASSED']);
});

test('FWD-12: crash after STOP_INTENT with the app already stopped is recorded, not repeated', () => {
  const journal = walk(started(), ['PREFLIGHT_PASSED', 'BACKUP_INTENT', 'PREDEPLOY_BACKUP_PASSED', 'STOP_INTENT']);
  assert.equal(nextForwardAction(journal, {
    appActive: false, appReleaseSha: OLD_RELEASE, healthOk: false, healthReleaseSha: null,
    schemaHead: HEAD, predeployBackupValid: true, postdeployBackupValid: false,
    targetReleaseSha: TARGET_RELEASE, observation: null,
  }), 'RECORD_OLD_STOPPED');
  const activated = walk(started(), TO_OBSERVATION_STARTED.slice(0, 6));
  assert.equal(nextForwardAction(activated, {
    appActive: true, appReleaseSha: TARGET_RELEASE, healthOk: true, healthReleaseSha: TARGET_RELEASE,
    schemaHead: HEAD, predeployBackupValid: true, postdeployBackupValid: false,
    targetReleaseSha: TARGET_RELEASE, observation: null,
  }), 'RECORD_TARGET_ACTIVATED');
});

test('FWD-13: failed activation never claims health and stops', () => {
  const journal = walk(started(), TO_OBSERVATION_STARTED.slice(0, 5));
  assert.equal(journal.phase, 'OLD_STOPPED');
  const observed = {
    appActive: false, appReleaseSha: null, healthOk: false, healthReleaseSha: null,
    schemaHead: HEAD, predeployBackupValid: true, postdeployBackupValid: false,
    targetReleaseSha: TARGET_RELEASE, observation: null,
  };
  assert.equal(nextForwardAction(journal, observed), 'ACTIVATE_TARGET_RELEASE');
  const activated = walk(journal, ['ACTIVATE_INTENT', 'TARGET_ACTIVATED']);
  assert.equal(nextForwardAction(activated, {...observed, appActive: true, appReleaseSha: OLD_RELEASE}), 'STOP');
  assert.equal(nextForwardAction(activated, {...observed, appActive: true, appReleaseSha: TARGET_RELEASE, healthOk: false}), 'VERIFY_HEALTH');
});

test('FWD-14: a failed predeploy or postdeploy backup blocks progress', () => {
  const journal = walk(started(), ['PREFLIGHT_PASSED', 'BACKUP_INTENT', 'PREDEPLOY_BACKUP_PASSED']);
  const base = {
    appActive: true, appReleaseSha: OLD_RELEASE, healthOk: true, healthReleaseSha: OLD_RELEASE,
    schemaHead: HEAD, predeployBackupValid: false, postdeployBackupValid: false,
    targetReleaseSha: TARGET_RELEASE, observation: null,
  };
  assert.equal(nextForwardAction(journal, base), 'STOP');
  const intent = walk(started(), ['PREFLIGHT_PASSED']);
  assert.equal(nextForwardAction(intent, base), 'RECORD_BACKUP_INTENT');
  assert.equal(nextForwardAction(walk(intent, ['BACKUP_INTENT']), base), 'CREATE_PREDEPLOY_BACKUP');
  const post = walk(started(), ['PREFLIGHT_PASSED', 'BACKUP_INTENT', 'PREDEPLOY_BACKUP_PASSED',
    'STOP_INTENT', 'OLD_STOPPED', 'ACTIVATE_INTENT', 'TARGET_ACTIVATED', 'HEALTH_PASSED',
    'SMOKE_PASSED', 'POSTDEPLOY_BACKUP_INTENT', 'POSTDEPLOY_BACKUP_PASSED']);
  assert.equal(nextForwardAction(post, {...base, appActive: true, appReleaseSha: TARGET_RELEASE,
    healthReleaseSha: TARGET_RELEASE, predeployBackupValid: true, postdeployBackupValid: false}), 'STOP');
  const smoke = walk(started(), ['PREFLIGHT_PASSED', 'BACKUP_INTENT', 'PREDEPLOY_BACKUP_PASSED',
    'STOP_INTENT', 'OLD_STOPPED', 'ACTIVATE_INTENT', 'TARGET_ACTIVATED', 'HEALTH_PASSED', 'SMOKE_PASSED']);
  assert.equal(nextForwardAction(smoke, {...base, appActive: true, appReleaseSha: TARGET_RELEASE,
    healthReleaseSha: TARGET_RELEASE, predeployBackupValid: true}), 'RECORD_POSTDEPLOY_BACKUP_INTENT');
});

test('FWD-15: acceptance requires a real 1800-second uninterrupted observation', () => {
  const journal = walk(started(), TO_OBSERVATION_STARTED);
  assert.equal(journal.phase, 'OBSERVATION_STARTED');
  const at = '2026-11-01T18:00:05Z';
  assert.throws(
    () => recordForwardObservation(journal, observation({seconds: 1799}), at),
    /FORWARD_TRANSITION_OBSERVATION_INVALID/,
  );
  assert.throws(
    () => recordForwardObservation(journal, observation({samples: 59}), at),
    /FORWARD_TRANSITION_OBSERVATION_INVALID/,
  );
  assert.throws(
    () => recordForwardObservation(journal, observation({bootId: 'boot-b'}), at),
    /FORWARD_TRANSITION_OBSERVATION_INVALID/,
  );
  assert.equal(recordForwardObservation(journal, observation(), at).phase, 'OBSERVATION_PASSED');
});

test('FWD-16: a PID or boot change during observation invalidates it', () => {
  const journal = walk(started(), [...TO_OBSERVATION_STARTED.slice(0, -1)]);
  assert.equal(journal.phase, 'OBSERVATION_INTENT');
  const base = {
    appActive: true, appReleaseSha: TARGET_RELEASE, healthOk: true, healthReleaseSha: TARGET_RELEASE,
    schemaHead: HEAD, predeployBackupValid: true, postdeployBackupValid: true,
    targetReleaseSha: TARGET_RELEASE,
  };
  const running = observation({
    completedAtUTC: null, seconds: 0, samples: 0,
    endPid: 451513, endStartTime: '115266971', endBootId: 'boot-a',
  });
  assert.equal(nextForwardAction(journal, {...base, observation: running}), 'RECORD_OBSERVATION_STARTED');
  assert.equal(nextForwardAction(journal, {...base, observation: observation({endPid: 999})}), 'STOP');
  const observing = walk(journal, ['OBSERVATION_STARTED']);
  assert.equal(nextForwardAction(observing, {...base, observation: observation({endPid: 999})}), 'STOP');
  assert.equal(nextForwardAction(observing, {...base, observation: observation({endBootId: 'boot-b'})}), 'STOP');
  assert.equal(nextForwardAction(observing, {...base, observation: observation({seconds: 1200, completedAtUTC: '2026-11-01T17:50:00Z'})}), 'STOP');
  assert.equal(nextForwardAction(observing, {...base, observation: observation()}), 'RECORD_OBSERVATION_PASSED');
});

test('FWD-17: forged acceptance, early acceptance and direct COMPLETED are rejected', () => {
  const auth = authorization();
  const early = walk(started(), ['PREFLIGHT_PASSED']);
  assert.throws(
    () => sealForwardAcceptance(early, auth, context({journal: {present: true}}), NOW),
    /FORWARD_TRANSITION_NOT_COMPLETE/,
  );
  const journal = walk(started(), TO_OBSERVATION_STARTED);
  assert.throws(
    () => recordForwardObservation(journal, {...observation(), seconds: 3600}, '2026-11-01T18:00:05Z'),
    /FORWARD_TRANSITION_OBSERVATION_INVALID/,
  );
  assert.throws(
    () => advanceForwardTransition(journal, 'ACCEPTED', '2026-11-01T18:00:05Z'),
    /FORWARD_TRANSITION_TRANSITION_INVALID/,
  );
});

test('FWD-18: the acceptance never marks the R4 parent COMPLETED', () => {
  const journal = recordForwardObservation(walk(started(), TO_OBSERVATION_STARTED),
    observation(), '2026-11-01T18:00:00Z');
  const auth = authorization();
  const ctx = targetContext({nowUTC: '2026-11-01T18:00:05Z'});
  const seal = sealForwardAcceptance(journal, auth, ctx, '2026-11-01T18:00:05Z');
  assert.equal(seal.parentAttemptCompleted, false);
  assert.equal(seal.parentDisposition, FORWARD_PARENT_DISPOSITION);
  assert.equal(seal.migrationPerformed, false);
  assert.equal(seal.acceptance, 'FORWARD_RELEASE_ACCEPTED');
  const verified = verifyForwardAcceptance(seal, {
    authorizationId: auth.authorizationId,
    authorizationSha256: ctx.authorizationSha256,
    target: auth.target,
    parentAttemptId: PARENT_ATTEMPT,
  });
  assert.equal(verified.parentAttemptCompleted, false);
  assert.equal(verified.grantsReleaseAuthority, false);
});

test('FWD-19: journal hash tamper, sequence gaps and foreign chains are rejected', () => {
  const journal = started();
  assert.throws(
    () => advanceForwardTransition({...journal, phase: 'ACCEPTED'}, 'PREFLIGHT_PASSED', NOW),
    /FORWARD_TRANSITION_JOURNAL_HASH_INVALID/,
  );
  const chain = replay(['PREFLIGHT_PASSED', 'BACKUP_INTENT']);
  assert.throws(
    () => validateForwardChain([chain[0], chain[2]]),
    /FORWARD_TRANSITION_JOURNAL_CHAIN_INVALID/,
  );
  assert.throws(
    () => validateForwardChain([chain[2], chain[1]]),
    /FORWARD_TRANSITION_JOURNAL_CHAIN_INVALID/,
  );
  assert.equal(validateForwardChain(chain).phase, 'BACKUP_INTENT');
});

test('FWD-20: happy path 060 -> 060 migration-free reaches FORWARD_RELEASE_ACCEPTED', () => {
  let journal = started();
  const observed = {
    appActive: true, appReleaseSha: OLD_RELEASE, healthOk: true, healthReleaseSha: OLD_RELEASE,
    schemaHead: HEAD, predeployBackupValid: false, postdeployBackupValid: false,
    targetReleaseSha: TARGET_RELEASE, observation: null,
  };
  assert.equal(nextForwardAction(journal, observed), 'VERIFY_PREFLIGHT');
  journal = walk(journal, TO_OBSERVATION_STARTED);
  assert.equal(journal.steps.preflightPassed, true);
  assert.equal(journal.steps.postdeployBackupPassed, true);
  assert.equal(journal.steps.observationPassed, false);
  const auth = authorization();
  const ctx = targetContext({nowUTC: '2026-11-01T18:00:05Z'});
  const passed = recordForwardObservation(journal, observation(), '2026-11-01T18:00:00Z');
  const seal = sealForwardAcceptance(passed, auth, ctx, '2026-11-01T18:00:05Z');
  assert.equal(seal.acceptance, 'FORWARD_RELEASE_ACCEPTED');
  assert.equal(seal.observation.seconds, FORWARD_OBSERVATION_SECONDS);
  assert.equal(seal.targetReleaseSha, TARGET_RELEASE);
  const full = [...replay(TO_OBSERVATION_STARTED), passed, seal];
  assert.equal(validateForwardChain(full).phase, 'ACCEPTED');
});

function replay(events) {
  const chain = [started()];
  let at = Date.parse(chain[0].updatedAtUTC);
  for (const event of events) {
    at += 1000;
    chain.push(advanceForwardTransition(chain.at(-1), event,
      new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z')));
  }
  return chain;
}

test('FWD-21: the binding helper derives old/target identities without I/O', () => {
  const binding = forwardAuthorizationBinding({
    parent: {
      attemptId: PARENT_ATTEMPT, approvalSha256: h('a'), profileSha256: h('b'),
      checkpointSequence: 17, checkpointSha256: h('c'),
      emergencyAuthorizationId: EMERGENCY_AUTH,
      emergencyJournalHeadSha256: JOURNAL_HEAD,
      emergencyReceiptSha256: RECEIPT_SHA,
    },
    old: {releaseSha: OLD_RELEASE, artifactSha256: h('d'), schemaHead: HEAD, catalog: CATALOG},
    target: {releaseSha: TARGET_RELEASE, treeSha: TARGET_TREE, artifactSha256: h('e'),
      ciManifestSha256: h('f'), schemaHead: HEAD, catalog: CATALOG},
    host: {machineId: MACHINE_ID, database: DATABASE},
  });
  assert.equal(binding.migration.allowed, false);
  assert.equal(binding.migration.required, false);
  assert.equal(binding.parent.disposition, FORWARD_PARENT_DISPOSITION);
  assert.equal(binding.target.releaseSha, TARGET_RELEASE);
});

test('FWD-22: acceptance is bound to the TARGET host state, not the OLD release', () => {
  const journal = recordForwardObservation(walk(started(), TO_OBSERVATION_STARTED),
    observation(), '2026-11-01T18:00:00Z');
  const auth = authorization();
  const targetHost = context({
    nowUTC: '2026-11-01T18:00:05Z',
    journal: {present: true},
    host: {
      ...context().host,
      releaseSha: TARGET_RELEASE,
      artifactSha256: auth.target.artifactSha256,
      activeOwnerIds: [NEW_ATTEMPT],
    },
  });
  assert.equal(sealForwardAcceptance(journal, auth, targetHost, '2026-11-01T18:00:05Z').phase, 'ACCEPTED');
  const oldHost = context({nowUTC: '2026-11-01T18:00:05Z', journal: {present: true}});
  assert.throws(
    () => sealForwardAcceptance(journal, auth, oldHost, '2026-11-01T18:00:05Z'),
    /FORWARD_TRANSITION_OLD_STATE_MISMATCH/,
  );
});

test('FWD-23: a hash-valid journal with a forged or interrupted observation is rejected', () => {
  const journal = walk(started(), TO_OBSERVATION_STARTED);
  const forged = recordForwardObservation(journal, observation(), '2026-11-01T18:00:00Z');
  const short = {...forged, observation: {...forged.observation, seconds: 60, completedAtUTC: '2026-11-01T17:31:00Z'}};
  const resealed = reseal(short);
  assert.throws(() => validateForwardChain([...replay(TO_OBSERVATION_STARTED), resealed]),
    /FORWARD_TRANSITION_JOURNAL_INVALID|FORWARD_TRANSITION_OBSERVATION_INVALID/);
  const interrupted = reseal({...forged, observation: {...forged.observation, endPid: 999}});
  assert.throws(() => verifyForwardAcceptance(interrupted, {
    authorizationId: authorization().authorizationId,
    authorizationSha256: context().authorizationSha256,
    target: authorization().target,
    parentAttemptId: PARENT_ATTEMPT,
  }), /FORWARD_TRANSITION_OBSERVATION_INVALID|FORWARD_TRANSITION_ACCEPTANCE_INVALID/);
});

test('FWD-24: schemaHead must be the catalog head and catalogs must be identical', () => {
  const drifted = {...authorization().old, schemaHead: 'wallet', catalog: CATALOG};
  const driftedTarget = {...authorization().target, schemaHead: 'wallet', catalog: CATALOG};
  assert.throws(
    () => validateForwardAuthorizationStructure(authorization({old: drifted, target: driftedTarget})),
    /FORWARD_TRANSITION_SCHEMA_MISMATCH/,
  );
  const pending = [...CATALOG, {version: '061_new_table', sha256: h('3')}];
  assert.throws(
    () => validateForwardAuthorizationStructure(authorization({target: {...authorization().target, catalog: pending}})),
    /FORWARD_TRANSITION_MIGRATION_REQUIRED/,
  );
});

test('FWD-25: the observation window must sit inside the journal timeline', () => {
  const journal = walk(started(), TO_OBSERVATION_STARTED);
  const at = '2026-11-01T18:00:05Z';
  const beforeStart = observation({startedAtUTC: '2026-11-01T16:00:00Z', completedAtUTC: '2026-11-01T16:30:00Z'});
  assert.throws(() => recordForwardObservation(journal, beforeStart, at), /FORWARD_TRANSITION_OBSERVATION_INVALID/);
  const future = observation({startedAtUTC: '2026-11-01T19:00:00Z', completedAtUTC: '2026-11-01T19:30:00Z'});
  assert.throws(() => recordForwardObservation(journal, future, at), /FORWARD_TRANSITION_OBSERVATION_INVALID/);
});

test('FWD-26: live target, schema and health drift stops the machine at every phase', () => {
  const base = {
    appActive: true, appReleaseSha: TARGET_RELEASE, healthOk: true, healthReleaseSha: TARGET_RELEASE,
    schemaHead: HEAD, predeployBackupValid: true, postdeployBackupValid: true,
    targetReleaseSha: TARGET_RELEASE, observation: null,
  };
  const smoke = walk(started(), TO_OBSERVATION_STARTED.slice(0, 9));
  assert.equal(smoke.phase, 'SMOKE_PASSED');
  assert.equal(nextForwardAction(smoke, {...base, healthOk: false}), 'STOP');
  assert.equal(nextForwardAction(smoke, {...base, schemaHead: '055_old'}), 'STOP');
  assert.equal(nextForwardAction(smoke, {...base, targetReleaseSha: OLD_RELEASE}), 'STOP');
  const post = walk(started(), TO_OBSERVATION_STARTED.slice(0, 11));
  assert.equal(post.phase, 'POSTDEPLOY_BACKUP_PASSED');
  assert.equal(nextForwardAction(post, {...base, healthOk: false}), 'STOP');
  assert.equal(nextForwardAction(post, {...base, observation: observation()}), 'START_OBSERVATION');
});

test('FWD-27: the emergency supersession helper rejects a forged or completed receipt', () => {
  const receipt = emergencyReceipt();
  assert.equal(assertEmergencySupersession({receipt, expected: receiptExpected(), receiptSha256: receipt.hash}).disposition,
    FORWARD_PARENT_DISPOSITION);
  assert.throws(() => assertEmergencySupersession({receipt, expected: receiptExpected(), receiptSha256: h('0')}),
    /FORWARD_TRANSITION_RECEIPT_BINDING_MISMATCH/);
  const completed = resealReceipt({...receipt, parentAttemptCompleted: true});
  assert.throws(() => assertEmergencySupersession({receipt: completed, expected: receiptExpected(), receiptSha256: completed.hash}),
    /EMERGENCY_HANDOFF_RECEIPT_INVALID/);
});

test('FWD-28: a fake observation cannot be recorded after an early start record', () => {
  const journal = walk(started(), TO_OBSERVATION_STARTED);
  const at = '2026-11-01T17:31:00Z';
  const fake = observation({completedAtUTC: '2026-11-01T17:31:00Z', seconds: 1800});
  assert.throws(() => recordForwardObservation(journal, fake, at), /FORWARD_TRANSITION_OBSERVATION_INVALID/);
});

function reseal(record) {
  const body = {...record};
  delete body.hash;
  return {...body, hash: createHash('sha256').update(JSON.stringify(body) + '\n').digest('hex')};
}

function resealReceipt(record) {
  return reseal(record);
}

function emergencyReceipt() {
  const body = {
    formatVersion: 1, kind: 'EMERGENCY_HANDOFF_RECEIPT',
    operationalStatus: 'EMERGENCY_RESTART_POLICY_RESTORED',
    r4TerminalState: 'HEALTH_PASSED_FENCED', r4Acceptance: 'NOT_ACCEPTED',
    observationPassed: false, parentAttemptCompleted: false, futureReleaseAuthority: false,
    authorizationId: EMERGENCY_AUTH, authorizationSha256: h('a'), toolArtifactSha256: h('b'),
    parent: {
      attemptId: PARENT_ATTEMPT, approvalSha256: h('a'), profileSha256: h('b'),
      checkpointSequence: 17, checkpointSha256: h('c'), phase: 'POSTDEPLOY_BACKUP_PASSED',
    },
    handoff: {
      journalHeadSha256: JOURNAL_HEAD,
      steps: {barrierRemoved: true, policyRestored: true, ownerRetired: true},
      completedAtUTC: '2026-11-01T15:04:59Z', processContinuity: 'PRESERVED',
      rebootObservationSha256: null,
    },
    host: {
      machineId: MACHINE_ID, database: {...DATABASE}, releaseSha: OLD_RELEASE,
      schemaHead: HEAD, startBudget: {used: 2, max: 2},
    },
    backups: {preSha256: h('1'), postSha256: h('2')},
  };
  return reseal(body);
}

function receiptExpected() {
  return {
    authorizationId: EMERGENCY_AUTH, authorizationSha256: h('a'), toolArtifactSha256: h('b'),
    parent: {
      attemptId: PARENT_ATTEMPT, approvalSha256: h('a'), profileSha256: h('b'),
      checkpointSequence: 17, checkpointSha256: h('c'), phase: 'POSTDEPLOY_BACKUP_PASSED',
      migrationCommitted: true, schemaHead: HEAD, starts: 2, maxStarts: 2, lastStart: 'pass',
    },
  };
}

test('FWD-29: a consumed grant requires the journal to exist and the observation to sit on the record', () => {
  const auth = authorization();
  assert.throws(
    () => validateConsumedForwardAuthorization(auth, targetContext({journal: {present: false}})),
    /FORWARD_TRANSITION_AUTHORIZATION_INVALID/,
  );
  const journal = recordForwardObservation(walk(started(), TO_OBSERVATION_STARTED),
    observation(), '2026-11-01T18:00:00Z');
  const late = reseal({...journal, observation: {
    ...journal.observation,
    completedAtUTC: '2026-11-01T18:00:06Z',
    seconds: 1806,
  }});
  assert.throws(
    () => validateForwardChain([...replay(TO_OBSERVATION_STARTED), late]),
    /FORWARD_TRANSITION_OBSERVATION_INVALID|FORWARD_TRANSITION_JOURNAL_INVALID/,
  );
});
