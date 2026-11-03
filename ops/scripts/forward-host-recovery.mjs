// Separate failure authority. Never advances or accepts the deployment journal.
import {validateForwardAuthorizationStructure} from './forward-transition.mjs';
import {validateHostLog} from './forward-host-driver.mjs';
import {digest, seal} from './forward-host-evidence.mjs';
const fail = code => { throw new Error(code); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const recoveryDigest = value => digest(JSON.stringify(value) + '\n');
const MODES = Object.freeze({RESTORE_HEALTHY_TARGET: ['POLICY', 'SEAL', 'HANDOFF', 'RETIRE'],
  CLOSE_FENCED: ['FENCE', 'QUIESCE', 'SEAL'], RELEASE_UNCHANGED_OLD: ['SEAL', 'RETIRE']});
const OUTCOMES = {RESTORE_HEALTHY_TARGET: 'FORWARD_TARGET_POLICY_RESTORED_NOT_ACCEPTED',
  CLOSE_FENCED: 'FORWARD_FAILURE_FENCED_NOT_ACCEPTED', RELEASE_UNCHANGED_OLD: 'FORWARD_UNCHANGED_OLD_RELEASED_NOT_ACCEPTED'};
const RUNTIME_FAILURES = ['FORWARD_HOST_PROCESS_CHANGED', 'FORWARD_HOST_TARGET_UNHEALTHY',
  'FORWARD_HOST_RECOVERY_PROCESS_CHANGED', 'FORWARD_HOST_RECOVERY_RUNTIME_UNHEALTHY'];
const KEYS = ['formatVersion', 'kind', 'authorizationId', 'attemptId', 'scope', 'mode', 'onFailure', 'maxUses',
  'bootId', 'issuedUptimeMs', 'expiresUptimeMs',
  'issuedAtUTC', 'expiresAtUTC', 'reason', 'deploymentAuthorizationSha256',
  'deploymentJournalHeadSha256', 'toolHash', 'snapshotSha256'];
const instant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) && Number.isFinite(Date.parse(value));
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function validateRecoveryAuthorization(grant, a, deploymentLog, toolHash, snapshot, nowUTC, consumed = false, uptimeMs = null) {
  validateForwardAuthorizationStructure(a);
  if (!grant || !same(Object.keys(grant).sort(), [...KEYS].sort()) || grant.formatVersion !== 1
    || grant.kind !== 'FORWARD_FAILURE_RECOVERY_AUTHORIZATION' || !uuid(grant.authorizationId)
    || grant.authorizationId === a.authorizationId || grant.attemptId !== a.attemptId
    || grant.scope !== 'FORWARD_FAILURE_RECOVERY' || typeof grant.mode !== 'string' || !Object.hasOwn(MODES, grant.mode)
    || grant.onFailure !== 'CLOSE_FENCED' || grant.maxUses !== 1
    || typeof grant.bootId !== 'string' || !grant.bootId
    || !Number.isFinite(grant.issuedUptimeMs) || grant.issuedUptimeMs < 0
    || !Number.isFinite(grant.expiresUptimeMs) || grant.expiresUptimeMs <= grant.issuedUptimeMs
    || grant.expiresUptimeMs - grant.issuedUptimeMs > 3600_000
    || !instant(grant.issuedAtUTC) || !instant(grant.expiresAtUTC)
    || Date.parse(grant.expiresAtUTC) <= Date.parse(grant.issuedAtUTC)
    || Date.parse(grant.expiresAtUTC) - Date.parse(grant.issuedAtUTC) > 3600_000
    || typeof grant.reason !== 'string' || !/^[A-Z0-9_]{3,128}$/.test(grant.reason)
    || ![grant.deploymentAuthorizationSha256, grant.deploymentJournalHeadSha256, grant.toolHash, grant.snapshotSha256].every(hex)
    || grant.deploymentAuthorizationSha256 !== recoveryDigest(a) || grant.toolHash !== toolHash
    || grant.deploymentJournalHeadSha256 !== deploymentLog.at(-1)?.hash) fail('FORWARD_HOST_RECOVERY_AUTHORIZATION_INVALID');
  const state = validateHostLog(deploymentLog, a, grant.deploymentAuthorizationSha256, toolHash);
  const untouched = grant.mode === 'RELEASE_UNCHANGED_OLD';
  if (!state.contract || state.contract.acceptance !== null || state.contract.phase === 'ACCEPTED'
    || (untouched ? deploymentLog.some(r => r.contract.phase === 'STOP_INTENT') || state.starts !== 0
      : !deploymentLog.some(r => r.contract.phase === 'STOP_INTENT'))) fail('FORWARD_HOST_RECOVERY_PHASE_INVALID');
  if (!consumed) {
    if (!instant(nowUTC) || Date.parse(nowUTC) < Date.parse(grant.issuedAtUTC)
      || Date.parse(nowUTC) >= Date.parse(grant.expiresAtUTC) || grant.bootId !== snapshot.bootId
      || !Number.isFinite(uptimeMs) || uptimeMs < grant.issuedUptimeMs
      || uptimeMs >= grant.expiresUptimeMs) fail('FORWARD_HOST_RECOVERY_WINDOW_EXPIRED');
    if (grant.snapshotSha256 !== recoveryDigest(snapshot) || snapshot.owner !== true) fail('FORWARD_HOST_RECOVERY_SNAPSHOT_CHANGED');
    if (untouched && (!snapshot.identity || snapshot.releaseSha !== a.old.releaseSha || snapshot.pointerSha !== a.old.releaseSha
      || snapshot.environmentSha !== a.old.releaseSha || snapshot.health !== 'PASS' || snapshot.schema !== 'PASS'
      || snapshot.restart !== 'on-failure' || snapshot.gate !== false || snapshot.barrier !== false)) fail('FORWARD_HOST_RECOVERY_TARGET_UNSAFE');
    if (grant.mode === 'RESTORE_HEALTHY_TARGET') {
      const started = state.done.get('START')?.data.identity;
      if (!started || !same(snapshot.identity, started) || snapshot.bootId !== started.bootId
        || snapshot.releaseSha !== a.target.releaseSha || snapshot.pointerSha !== a.target.releaseSha
        || snapshot.environmentSha !== a.target.releaseSha || snapshot.health !== 'PASS' || snapshot.schema !== 'PASS'
        || snapshot.backupIntegrity !== 'VALID'
        || snapshot.gate !== true || snapshot.barrier !== true) fail('FORWARD_HOST_RECOVERY_TARGET_UNSAFE');
    }
  }
  return state;
}

export function recoveryReceipt(grant, intent, state, fallback = false) {
  return seal({kind: 'FORWARD_FAILURE_RECOVERY_RECEIPT', authorizationId: grant.authorizationId,
    recoveryAuthorizationSha256: recoveryDigest(grant), attemptId: grant.attemptId,
    deploymentAuthorizationSha256: grant.deploymentAuthorizationSha256,
    deploymentJournalHeadSha256: grant.deploymentJournalHeadSha256, toolHash: grant.toolHash,
    requestedMode: grant.mode, mode: fallback ? 'CLOSE_FENCED' : grant.mode,
    outcome: OUTCOMES[fallback ? 'CLOSE_FENCED' : grant.mode],
    deploymentPhase: state.contract.phase, usedStarts: state.starts,
    parentDisposition: state.contract.parentDisposition, parentAttemptCompleted: false,
    accepted: false, completed: false, productionGo: false, grantsReleaseAuthority: false,
    migrationPerformed: false, startAuthorized: false, observationRetryAuthorized: false,
    evidence: intent.data.snapshot, admittedAtUTC: intent.atUTC, recoveryIntentHash: intent.hash});
}

export function validateRecoveryLog(log, grant, a, deploymentLog, toolHash) {
  const state = validateRecoveryAuthorization(grant, a, deploymentLog, toolHash, null, null, true);
  if (!Array.isArray(log) || log.length > 32) fail('FORWARD_HOST_RECOVERY_JOURNAL_INVALID');
  const expected = ['INTENT', ...MODES[grant.mode].flatMap(op => [op + '_INTENT', op + '_DONE']), 'FINAL'];
  let fallback = false;
  for (const [index, record] of log.entries()) {
    const {hash, ...body} = record;
    if (body.event === 'FALLBACK_INTENT') {
      if (!index || fallback || grant.mode !== 'RESTORE_HEALTHY_TARGET' || expected[index] === 'FINAL'
        || body.data?.failedEvent !== expected[index] || !RUNTIME_FAILURES.includes(body.data?.code)) fail('FORWARD_HOST_RECOVERY_JOURNAL_INVALID');
      fallback = true;
      expected.splice(index, expected.length - index, 'FALLBACK_INTENT',
        ...MODES.CLOSE_FENCED.flatMap(op => [op + '_INTENT', op + '_DONE']), 'FINAL');
    }
    if (Object.keys(body).join(',') !== 'formatVersion,kind,sequence,previousHash,recoveryAuthorizationSha256,deploymentJournalHeadSha256,toolHash,event,data,atUTC'
      || body.formatVersion !== 1 || body.kind !== 'FORWARD_FAILURE_RECOVERY_EVENT'
      || body.sequence !== index || body.previousHash !== (index ? log[index - 1].hash : null)
      || body.recoveryAuthorizationSha256 !== recoveryDigest(grant)
      || body.deploymentJournalHeadSha256 !== grant.deploymentJournalHeadSha256 || body.toolHash !== toolHash
      || seal(body).hash !== hash || body.event !== expected[index] || !instant(body.atUTC)
      || (index && Date.parse(body.atUTC) < Date.parse(log[index - 1].atUTC))) fail('FORWARD_HOST_RECOVERY_JOURNAL_INVALID');
    if (index === 0) {
      if (!same(body.data.grant, grant)) fail('FORWARD_HOST_RECOVERY_JOURNAL_INVALID');
      validateRecoveryAuthorization(body.data.grant, a, deploymentLog, toolHash, body.data.snapshot, body.atUTC, false, body.data.uptimeMs);
    }
    if (body.event === 'SEAL_DONE' && !same(body.data.receipt, recoveryReceipt(grant, log[0], state, fallback))) fail('FORWARD_HOST_RECOVERY_RECEIPT_INVALID');
    if (body.event === 'FINAL' && !same(body.data, result(grant, fallback))) fail('FORWARD_HOST_RECOVERY_JOURNAL_INVALID');
  }
  return {state, next: expected[log.length] ?? null, final: log.at(-1)?.event === 'FINAL', fallback};
}
function result(grant, fallback = false) {
  return {outcome: OUTCOMES[fallback ? 'CLOSE_FENCED' : grant.mode],
  accepted: false, completed: false, productionGo: false, startAuthorized: false,
  ownerRetired: grant.mode !== 'CLOSE_FENCED' && !fallback};
}

export async function runFailureRecovery(io, a, grant, command) {
  if (!['recover', 'recovery-status'].includes(command)) fail('FORWARD_HOST_COMMAND_INVALID');
  await io.check();
  const context = await io.recoveryContext();
  let log = io.readRecoveryLog();
  const admission = !log.length;
  const state = validateRecoveryAuthorization(grant, a, context.deploymentLog, io.toolHash, context.snapshot, io.now(), !admission, context.uptimeMs);
  let validated = validateRecoveryLog(log, grant, a, context.deploymentLog, io.toolHash);
  if (command === 'recovery-status') return {readOnly: true, ...result(grant, validated.fallback),
    ownerRetired: validated.final && grant.mode !== 'CLOSE_FENCED' && !validated.fallback,
    recoveryPhase: log.at(-1)?.event ?? 'READY', snapshot: context.snapshot, uptimeMs: context.uptimeMs};
  const append = async (event, data) => {
    await io.check();
    const record = seal({formatVersion: 1, kind: 'FORWARD_FAILURE_RECOVERY_EVENT', sequence: log.length,
      previousHash: log.at(-1)?.hash ?? null, recoveryAuthorizationSha256: recoveryDigest(grant),
      deploymentJournalHeadSha256: grant.deploymentJournalHeadSha256, toolHash: io.toolHash,
      event, data, atUTC: io.now()});
    validateRecoveryLog([...log, record], grant, a, context.deploymentLog, io.toolHash);
    io.appendRecovery(record); log = io.readRecoveryLog();
    validated = validateRecoveryLog(log, grant, a, context.deploymentLog, io.toolHash);
  };
  if (admission) await append('INTENT', {grant, snapshot: context.snapshot, uptimeMs: context.uptimeMs});
  while (validated.next) {
    const next = validated.next;
    if (next === 'FINAL') { await append(next, result(grant, validated.fallback)); break; }
    const [op, status] = next.split('_');
    try {
      if (status === 'INTENT') {
        await append(next, null);
        const data = op === 'SEAL' ? {receipt: recoveryReceipt(grant, log[0], state, validated.fallback)} : {};
        const completed = await io.recoveryEffect(op, data, log);
        await append(op + '_DONE', completed);
      } else {
        const data = op === 'SEAL' ? {receipt: recoveryReceipt(grant, log[0], state, validated.fallback)} : {};
        const completed = await io.reconcileRecovery(op, data, log);
        await append(next, completed);
      }
    } catch (error) {
      if (grant.mode !== 'RESTORE_HEALTHY_TARGET' || validated.fallback || !RUNTIME_FAILURES.includes(error.message)) throw error;
      await append('FALLBACK_INTENT', {failedEvent: validated.next, code: error.message});
    }
  }
  return result(grant, validated.fallback);
}
