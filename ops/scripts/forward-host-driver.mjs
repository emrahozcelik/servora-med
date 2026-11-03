// Forward-only host orchestration. All I/O is supplied by the root adapter.
import {createHash} from 'node:crypto';
import {
  validateForwardAuthorization, validateForwardAuthorizationStructure,
  initialForwardTransition, advanceForwardTransition, validateForwardChain,
  recordForwardObservation, sealForwardAcceptance,
  validateForwardAuthorizationTime,
} from './forward-transition.mjs';

const fail = code => { throw new Error(code); };
const hash = body => createHash('sha256').update(JSON.stringify(body) + '\n').digest('hex');
const OP_PHASE = {OWNER: 'INTENT', PRE_BACKUP: 'BACKUP_INTENT', FENCE: 'STOP_INTENT',
  STOP: 'STOP_INTENT', ENV: 'ACTIVATE_INTENT', POINTER: 'ACTIVATE_INTENT', COLLECTOR: 'ACTIVATE_INTENT', START: 'ACTIVATE_INTENT',
  SMOKE: 'HEALTH_PASSED', POST_BACKUP: 'POSTDEPLOY_BACKUP_INTENT',
  OBSERVE: 'OBSERVATION_STARTED', POLICY: 'OBSERVATION_PASSED', HANDOFF: 'ACCEPTED', RETIRE: 'ACCEPTED'};
const REQUIRED = {PREFLIGHT_PASSED: ['OWNER'], PREDEPLOY_BACKUP_PASSED: ['PRE_BACKUP'],
  OLD_STOPPED: ['FENCE', 'STOP'], TARGET_ACTIVATED: ['ENV', 'POINTER', 'COLLECTOR', 'START'],
  SMOKE_PASSED: ['SMOKE'], POSTDEPLOY_BACKUP_PASSED: ['POST_BACKUP'],
  OBSERVATION_PASSED: ['OBSERVE'], ACCEPTED: ['POLICY']};
const OP_REQUIRES = {STOP: ['FENCE'], POINTER: ['ENV'], COLLECTOR: ['ENV', 'POINTER'],
  START: ['ENV', 'POINTER', 'COLLECTOR'], RETIRE: ['HANDOFF']};

/** The host chain contains every intent, result and unchanged pure-contract
 * checkpoint. Start slots are derived from the immutable chain, never a file
 * counter that could be reset by a crash or reboot. */
export function validateHostLog(log, authorization, authorizationSha256, toolHash) {
  const contracts = [], done = new Map();
  let pending = null, starts = 0;
  if (!Array.isArray(log) || log.length > 512) fail('FORWARD_HOST_JOURNAL_INVALID');
  for (const [index, record] of log.entries()) {
    const {hash: sealed, ...body} = record;
    if (Object.keys(body).join(',') !== 'formatVersion,kind,sequence,previousHash,authorizationSha256,toolHash,event,data,contract,atUTC'
      || body.formatVersion !== 1 || body.kind !== 'FORWARD_HOST_EVENT'
      || body.sequence !== index || body.previousHash !== (index ? log[index - 1].hash : null)
      || body.authorizationSha256 !== authorizationSha256 || body.toolHash !== toolHash
      || hash(body) !== sealed || body.contract.attemptId !== authorization.attemptId
      || body.contract.authorizationSha256 !== authorizationSha256
      || !Number.isFinite(Date.parse(body.atUTC))
      || (index && Date.parse(body.atUTC) < Date.parse(log[index - 1].atUTC))) fail('FORWARD_HOST_JOURNAL_INVALID');
    if (body.event === 'PHASE') {
      if (pending || (index === 0 && body.contract.phase !== 'INTENT')) fail('FORWARD_HOST_PHASE_CONFLICT');
      if (index === 0) validateForwardAuthorizationTime(authorization, body.data?.admissionTime);
      if ((REQUIRED[body.contract.phase] ?? []).some(op => !done.has(op))) fail('FORWARD_HOST_PHASE_CONFLICT');
      contracts.push(body.contract);
      validateForwardChain(contracts);
    } else {
      if (!contracts.length || JSON.stringify(body.contract) !== JSON.stringify(contracts.at(-1))) fail('FORWARD_HOST_PHASE_CONFLICT');
      const match = /^(.*)_(INTENT|DONE)$/.exec(body.event);
      if (!match || OP_PHASE[match[1]] !== body.contract.phase) fail('FORWARD_HOST_PHASE_CONFLICT');
      const [, op, status] = match;
      if (status === 'INTENT') {
        if (pending || (done.has(op) && op !== 'START')) fail('FORWARD_HOST_PHASE_CONFLICT');
        if ((OP_REQUIRES[op] ?? []).some(required => !done.has(required))) fail('FORWARD_HOST_PHASE_CONFLICT');
        if (op === 'START') {
          if (++starts > authorization.budgets.maxStarts || body.data.slot !== starts) fail('FORWARD_HOST_START_BUDGET_EXHAUSTED');
          validateForwardAuthorizationTime(authorization, body.data.authorizationTime);
        }
        pending = record;
      } else {
        if (!pending || pending.event !== op + '_INTENT') fail('FORWARD_HOST_PHASE_CONFLICT');
        if (status === 'DONE') done.set(op, body);
        pending = null;
      }
    }
  }
  return {contract: contracts.at(-1) ?? null, done, pending, starts};
}

export async function runForwardHost(io, authorization, command) {
  if (!['preflight', 'status', 'apply', 'smoke', 'observe', 'finish'].includes(command)) fail('FORWARD_HOST_COMMAND_INVALID');
  validateForwardAuthorizationStructure(authorization);
  const context = await io.context();
  await io.check();
  let log = io.readLog();
  let state = validateHostLog(log, authorization, context.authorizationSha256, io.toolHash);
  if (!state.contract) {
    context.currentTime = await io.authorizationTime();
    validateForwardAuthorization(authorization, context);
  }
  if (['preflight', 'status'].includes(command)) return {readOnly: true, phase: state.contract?.phase ?? 'READY', starts: state.starts,
    ownerRetired: state.done.has('RETIRE'), pendingPublications: io.pendingPublications?.() ?? 0};
  if (io.recoveryStarted?.()) fail('FORWARD_HOST_RECOVERY_OWNS_ATTEMPT');
  if (command === 'apply' && state.contract && !['INTENT', 'PREFLIGHT_PASSED', 'BACKUP_INTENT', 'PREDEPLOY_BACKUP_PASSED', 'STOP_INTENT', 'OLD_STOPPED', 'ACTIVATE_INTENT', 'TARGET_ACTIVATED', 'HEALTH_PASSED'].includes(state.contract.phase)) fail('FORWARD_HOST_PHASE_CONFLICT');
  if (command === 'smoke' && !['HEALTH_PASSED', 'SMOKE_PASSED', 'POSTDEPLOY_BACKUP_INTENT', 'POSTDEPLOY_BACKUP_PASSED'].includes(state.contract?.phase)) fail('FORWARD_HOST_PHASE_CONFLICT');
  if (command === 'observe' && !['POSTDEPLOY_BACKUP_PASSED', 'OBSERVATION_INTENT', 'OBSERVATION_STARTED', 'OBSERVATION_PASSED', 'ACCEPTED'].includes(state.contract?.phase)) fail('FORWARD_HOST_PHASE_CONFLICT');
  if (command === 'finish' && !['OBSERVATION_PASSED', 'ACCEPTED'].includes(state.contract?.phase)) fail('FORWARD_HOST_PHASE_CONFLICT');
  const append = async (event, data, contract = state.contract) => {
    await io.check();
    if (log.length === 0) data = {...data,
      admissionTime: validateForwardAuthorizationTime(authorization, await io.authorizationTime())};
    if (event === 'START_INTENT') data = {...data,
      authorizationTime: validateForwardAuthorizationTime(authorization, await io.authorizationTime())};
    if (event === 'PHASE' && contract.phase === 'ACCEPTED') await io.verifyObservation(state.done.get('OBSERVE').data, log);
    const body = {formatVersion: 1, kind: 'FORWARD_HOST_EVENT', sequence: log.length,
      previousHash: log.at(-1)?.hash ?? null, authorizationSha256: context.authorizationSha256,
      toolHash: io.toolHash, event, data, contract, atUTC: io.now()};
    const record = {...body, hash: hash(body)};
    validateHostLog([...log, record], authorization, context.authorizationSha256, io.toolHash);
    io.append(record);
    log = io.readLog();
    state = validateHostLog(log, authorization, context.authorizationSha256, io.toolHash);
  };
  const phase = async name => append('PHASE', null, advanceForwardTransition(state.contract, name, io.now()));
  const operation = async (op, data = {}) => {
    if (state.done.has(op)) return state.done.get(op).data;
    if (state.pending) {
      if (state.pending.event !== op + '_INTENT') fail('FORWARD_HOST_PHASE_CONFLICT');
      const result = await io.reconcile(op, state.pending, log);
      await append(op + '_DONE', result);
      return result;
    }
    if (op === 'START') {
      validateForwardAuthorizationTime(authorization, await io.authorizationTime());
      if (Date.parse(io.now()) >= Date.parse(authorization.expiresAtUTC)) fail('FORWARD_HOST_START_WINDOW_EXPIRED');
    }
    await append(op + '_INTENT', data);
    const result = await io.effect(op, data, log);
    await append(op + '_DONE', result);
    return result;
  };
  if (!state.contract) await append('PHASE', {oldIdentity: await io.identity()}, initialForwardTransition(authorization, context));
  while (true) {
    switch (state.contract.phase) {
      case 'INTENT':
        await operation('OWNER');
        await phase('PREFLIGHT_PASSED'); break;
      case 'PREFLIGHT_PASSED': await phase('BACKUP_INTENT'); break;
      case 'BACKUP_INTENT':
        await operation('PRE_BACKUP'); await io.verifyBackups('pre');
        await phase('PREDEPLOY_BACKUP_PASSED'); break;
      case 'PREDEPLOY_BACKUP_PASSED':
        await io.verifyBackups('pre'); await phase('STOP_INTENT'); break;
      case 'STOP_INTENT':
        await io.verifyBackups('pre');
        await operation('FENCE'); await operation('STOP', {oldIdentity: log[0].data.oldIdentity});
        if (await io.identity()) fail('FORWARD_HOST_OLD_STILL_RUNNING');
        await phase('OLD_STOPPED'); break;
      case 'OLD_STOPPED':
        await io.verifyBackups('pre');
        if (await io.identity()) fail('FORWARD_HOST_UNEXPECTED_PROCESS');
        await phase('ACTIVATE_INTENT'); break;
      case 'ACTIVATE_INTENT': {
        await io.verifyBackups('pre'); await operation('ENV');
        await io.verifyBackups('pre'); await operation('POINTER');
        await operation('COLLECTOR');
        await io.verifyBackups('pre');
        if (!state.done.has('START') && !state.pending && state.starts >= authorization.budgets.maxStarts) fail('FORWARD_HOST_START_BUDGET_EXHAUSTED');
        const result = await operation('START', {slot: state.starts + 1});
        if (JSON.stringify(await io.identity()) !== JSON.stringify(result.identity)) fail('FORWARD_HOST_PROCESS_CHANGED');
        await phase('TARGET_ACTIVATED'); break;
      }
      case 'TARGET_ACTIVATED':
        await io.verifyTarget(); await phase('HEALTH_PASSED'); break;
      case 'HEALTH_PASSED':
        await io.verifyTarget();
        if (command === 'apply') return {readOnly: false, phase: state.contract.phase, starts: state.starts};
        await operation('SMOKE'); await io.verifyTarget(); await phase('SMOKE_PASSED'); break;
      case 'SMOKE_PASSED': await io.verifyTarget(); await phase('POSTDEPLOY_BACKUP_INTENT'); break;
      case 'POSTDEPLOY_BACKUP_INTENT':
        await io.verifyTarget(); await operation('POST_BACKUP'); await io.verifyBackups('post');
        await phase('POSTDEPLOY_BACKUP_PASSED'); break;
      case 'POSTDEPLOY_BACKUP_PASSED':
        await io.verifyTarget(); await io.verifyBackups('post');
        if (command !== 'observe') return {readOnly: false, phase: state.contract.phase, starts: state.starts};
        await phase('OBSERVATION_INTENT'); break;
      case 'OBSERVATION_INTENT':
        await io.verifyTarget(); await io.verifyBackups('post');
        await phase('OBSERVATION_STARTED'); break;
      case 'OBSERVATION_STARTED': {
        const proof = await operation('OBSERVE', {anchor: state.contract.hash, identity: await io.identity()});
        const summary = await io.verifyObservation(proof, log);
        await append('PHASE', null, recordForwardObservation(state.contract, summary, io.now())); break;
      }
      case 'OBSERVATION_PASSED': {
        await io.verifyTarget(); await io.verifyBackups('post');
        await io.verifyObservation(state.done.get('OBSERVE').data, log);
        await operation('POLICY');
        await io.verifyTarget();
        const current = await io.context();
        await append('PHASE', null, sealForwardAcceptance(state.contract, authorization, current, io.now())); break;
      }
      case 'ACCEPTED':
        // Acceptance is already durable. A crash/reboot may leave the closed
        // gate and app down; finish the accepted normal-policy handback first.
        await operation('HANDOFF');
        await io.verifyTarget(); await io.verifyBackups('post'); await operation('RETIRE');
        return {readOnly: false, phase: 'ACCEPTED', starts: state.starts, ownerRetired: true};
      default: fail('FORWARD_HOST_PHASE_CONFLICT');
    }
  }
}
