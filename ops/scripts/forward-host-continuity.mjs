// Host-side release-continuity lineage and collector handoff support.
// Pure decisions are exported separately from the root-only filesystem reads
// so deterministic tests do not need production paths.
import {constants, closeSync, existsSync, fsyncSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync} from 'node:fs';
import {basename, dirname, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {validateForwardAuthorizationStructure, validateContinuityLineageBindings,
  verifyForwardAcceptance, CONTINUITY_KIND, CONTINUITY_RECOVERY_OUTCOME,
  LEGACY_TOOL_DIR, VERSIONED_TOOL_ROOT} from './forward-transition.mjs';
import {validateHostLog} from './forward-host-driver.mjs';
import {validateRecoveryLog, recoveryDigest} from './forward-host-recovery.mjs';
import {protectedBytes, protectedJson, publishExclusive, openHostJournal} from './forward-host-storage.mjs';
import {digest} from './forward-host-evidence.mjs';

export const COLLECTOR_DRAIN_MS = 4500;
export const COLLECTOR_INSTANCE_MAX_MS = 3000 + 1000;
export const collectorText = toolDir =>
  '[Service]\nExecStart=\nExecStart=/usr/bin/node --no-addons ' + toolDir + '/trusted-time.mjs --collect-chrony\n';

export const isContinuity = authorization => authorization?.kind === CONTINUITY_KIND;

/** Pre-handoff the live collector is the predecessor module; post-handoff it is
 * the manifested target module. v2 keeps the sealed legacy collector. */
export function collectorExpectation(authorization, {complete, toolDir, targetModule, installed}) {
  if (complete) {
    return {path: toolDir + '/trusted-time.mjs', text: collectorText(toolDir), dropin: true, moduleSha256: targetModule};
  }
  if (isContinuity(authorization)) {
    const path = authorization.lineage.predecessorCollectorPath;
    return {path, text: collectorText(dirname(path)), dropin: true,
      moduleSha256: authorization.lineage.predecessorCollectorModuleSha256};
  }
  return {path: installed + '/trusted-time.mjs', text: null, dropin: false, moduleSha256: null};
}

/** Atomic switch decision. `null` means the drop-in is absent. */
export function collectorSwitchPlan({currentText, oldText, newText}) {
  if (currentText === newText) return {write: false, reload: false};
  if (currentText === oldText || (oldText === null && currentText === null)) return {write: true, reload: true};
  throw new Error('FORWARD_HOST_COLLECTOR_UNIT_DRIFT');
}

/** Atomic drop-in replacement: write a root-only temp file, fsync, rename over
 * the target and flush the directory. A rename failure removes the temp file
 * and leaves the predecessor text intact. */
export function atomicReplaceFile({path, text, directory = dirname(path),
  writeTemp = (temp, value) => {
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
  },
  rename = renameSync, flush = () => {}, uuid = randomUUID}) {
  const temp = join(directory, '.collector-' + uuid());
  writeTemp(temp, text);
  try { rename(temp, path); }
  catch (error) { try { unlinkSync(temp); } catch { /* already gone */ } throw error; }
  flush(directory);
}

export function assertCollectorDrainBound() {
  if (!(COLLECTOR_DRAIN_MS > COLLECTOR_INSTANCE_MAX_MS)) throw new Error('FORWARD_HOST_COLLECTOR_DRAIN_UNSAFE');
  return COLLECTOR_DRAIN_MS;
}

/** Preserve the exact authorization bytes under the attempt directory before a
 * successor grant replaces the single top-level file. No history rewrite. */
export function preserveAttemptAuthorization({source, destination, expectedSha, attemptId,
  read = path => protectedBytes(path), publish = publishExclusive,
  validate = validateForwardAuthorizationStructure}) {
  const bytes = read(source);
  if (digest(bytes) !== expectedSha) throw new Error('FORWARD_HOST_LINEAGE_AUTHORIZATION_DRIFT');
  let record;
  try { record = JSON.parse(bytes); } catch { throw new Error('FORWARD_HOST_LINEAGE_AUTHORIZATION_DRIFT'); }
  validate(record);
  if (record.attemptId !== attemptId) throw new Error('FORWARD_HOST_LINEAGE_AUTHORIZATION_DRIFT');
  if (existsSync(destination)) {
    if (digest(read(destination)) !== expectedSha) throw new Error('FORWARD_HOST_LINEAGE_AUTHORIZATION_DRIFT');
    return false;
  }
  publish(destination, bytes, 0o600);
  return true;
}

/** Two continuity attempts may not fork from the same predecessor. */
export function assertNoLineageFork({root, authorization,
  list = path => readdirSync(path), read = path => protectedBytes(path),
  exists = path => existsSync(path)}) {
  if (!isContinuity(authorization)) return;
  for (const name of list(root)) {
    if (name === authorization.attemptId) continue;
    const path = join(root, name, 'authorization.json');
    if (!exists(path)) continue;
    let other;
    try { other = JSON.parse(read(path)); } catch { throw new Error('FORWARD_HOST_LINEAGE_FORK'); }
    if (isContinuity(other)
      && other.lineage?.predecessorAttemptId === authorization.lineage.predecessorAttemptId) {
      throw new Error('FORWARD_HOST_LINEAGE_FORK');
    }
  }
}

/** Root-only lineage validation against the immutable predecessor attempt.
 * File readers and journal validators are injectable so every fail-closed
 * branch is exercised by deterministic tests without production paths. */
export function validateContinuityLineage(authorization, {
  root = '/var/lib/servora-med/deploy/forward',
  releasesRoot = '/opt/servora-med/releases',
  legacyTool = LEGACY_TOOL_DIR,
  toolRoot = VERSIONED_TOOL_ROOT,
  exists = existsSync,
  readAuthorization = path => protectedBytes(path),
  readManifest = path => protectedJson(path, {mode: 0o644}),
  openJournal = directory => openHostJournal(directory),
  validateDeploymentLog = validateHostLog,
  validateRecovery = validateRecoveryLog,
  readReceipt = path => protectedJson(path),
  readFile = path => readFileSync(path),
  digestValue = digest,
  verifyAcceptance = verifyForwardAcceptance,
} = {}) {
  if (!isContinuity(authorization)) throw new Error('FORWARD_HOST_LINEAGE_INVALID');
  const line = authorization.lineage, attempt = join(root, line.predecessorAttemptId);
  const authPath = join(attempt, 'authorization.json');
  if (!exists(authPath)) throw new Error('FORWARD_HOST_LINEAGE_AUTHORIZATION_MISSING');
  const authBytes = readAuthorization(authPath);
  if (digestValue(authBytes) !== line.predecessorAuthorizationSha256) {
    throw new Error('FORWARD_HOST_LINEAGE_AUTHORIZATION_DRIFT');
  }
  const predecessor = JSON.parse(authBytes);
  validateForwardAuthorizationStructure(predecessor);

  const toolDir = isContinuity(predecessor) ? join(toolRoot, line.predecessorToolHash) : legacyTool;
  if (isContinuity(predecessor)
    ? basename(toolDir) !== line.predecessorToolHash || !/^[0-9a-f]{64}$/.test(basename(toolDir))
    : toolDir !== legacyTool) throw new Error('FORWARD_HOST_LINEAGE_TOOL_DRIFT');
  const manifest = readManifest(join(toolDir, 'manifest.json'));
  if (manifest.hash !== line.predecessorToolHash) throw new Error('FORWARD_HOST_LINEAGE_TOOL_DRIFT');

  const journalDir = join(attempt, 'journal');
  if (!exists(journalDir)) throw new Error('FORWARD_HOST_LINEAGE_JOURNAL_MISSING');
  const journal = openJournal(journalDir);
  if (journal.pending() !== 0) throw new Error('FORWARD_HOST_LINEAGE_JOURNAL_PENDING');
  const log = journal.read();
  const state = validateDeploymentLog(log, predecessor, line.predecessorAuthorizationSha256, line.predecessorToolHash);
  const last = log.at(-1);
  const recoveryPending = line.type === 'RECOVERY'
    && (state.pending === null || state.pending?.event === 'OBSERVE_INTENT');
  const acceptedPending = line.type === 'ACCEPTED' && state.pending === null;
  if (!last || !(recoveryPending || acceptedPending) || last.hash !== line.predecessorJournalHeadSha256
    || state.contract?.phase !== line.predecessorTerminalPhase) {
    throw new Error('FORWARD_HOST_LINEAGE_JOURNAL_DRIFT');
  }
  for (const op of ['PRE_BACKUP', 'POST_BACKUP', 'COLLECTOR', 'START']) {
    if (!state.done.has(op)) throw new Error('FORWARD_HOST_LINEAGE_INCOMPLETE');
  }
  const collectorModule = state.done.get('COLLECTOR').data.moduleSha256;
  if (collectorModule !== line.predecessorCollectorModuleSha256) {
    throw new Error('FORWARD_HOST_LINEAGE_COLLECTOR_DRIFT');
  }
  const expectedCollectorPath = isContinuity(predecessor)
    ? join(toolRoot, line.predecessorToolHash, 'trusted-time.mjs')
    : join(legacyTool, 'trusted-time.mjs');
  if (line.predecessorCollectorPath !== expectedCollectorPath
    || digestValue(readFile(line.predecessorCollectorPath)) !== line.predecessorCollectorModuleSha256) {
    throw new Error('FORWARD_HOST_LINEAGE_COLLECTOR_DRIFT');
  }
  // Release files are root:servora-med 0650 and are content-verified by
  // verifyRelease(); bind the collector bytes to the same release module.
  if (digestValue(readFile(join(releasesRoot, line.predecessorReleaseSha, 'ops/scripts/trusted-time.mjs')))
    !== line.predecessorCollectorModuleSha256) {
    throw new Error('FORWARD_HOST_LINEAGE_COLLECTOR_DRIFT');
  }

  const facts = {toolHash: line.predecessorToolHash, terminalPhase: state.contract.phase,
    journalHead: last.hash, collectorModuleSha256: collectorModule};
  if (line.type === 'RECOVERY') {
    const recoveryPath = join(attempt, 'recovery');
    const grantPath = join(attempt, 'recovery-authorization.json');
    const receiptPath = join(recoveryPath, 'receipt.json');
    if (!exists(grantPath) || !exists(receiptPath)) throw new Error('FORWARD_HOST_LINEAGE_RECOVERY_MISSING');
    const grant = readReceipt(grantPath);
    if (recoveryDigest(grant) !== line.recoveryAuthorizationSha256) {
      throw new Error('FORWARD_HOST_LINEAGE_RECOVERY_DRIFT');
    }
    const recoveryJournal = openJournal(join(recoveryPath, 'journal'));
    if (recoveryJournal.pending() !== 0) throw new Error('FORWARD_HOST_LINEAGE_RECOVERY_PENDING');
    const recoveryLog = recoveryJournal.read();
    const validated = validateRecovery(recoveryLog, grant, predecessor, log, line.predecessorToolHash);
    const receipt = readReceipt(receiptPath);
    if (!validated.final || validated.fallback
      || digestValue(readAuthorization(receiptPath)) !== line.recoveryReceiptSha256
      || receipt.mode !== 'RESTORE_HEALTHY_TARGET'
      || receipt.outcome !== line.recoveryOutcome
      || receipt.outcome !== CONTINUITY_RECOVERY_OUTCOME
      || receipt.accepted !== false || receipt.completed !== false
      || receipt.deploymentPhase !== line.predecessorTerminalPhase
      || recoveryLog.at(-1)?.event !== 'FINAL'
      || recoveryLog.at(-1)?.hash !== line.recoveryJournalHeadSha256
      || recoveryLog.at(-1)?.data?.ownerRetired !== true) {
      throw new Error('FORWARD_HOST_LINEAGE_RECOVERY_DRIFT');
    }
    facts.recovery = {authorizationSha256: line.recoveryAuthorizationSha256,
      journalHead: line.recoveryJournalHeadSha256, receiptSha256: line.recoveryReceiptSha256,
      outcome: receipt.outcome, mode: receipt.mode, final: true, fallback: false, ownerRetired: true};
  } else {
    if (exists(join(attempt, 'recovery'))) throw new Error('FORWARD_HOST_LINEAGE_ACCEPTANCE_DRIFT');
    const accepted = log.find(record => record.event === 'PHASE' && record.contract.phase === 'ACCEPTED');
    if (!accepted || accepted.contract.hash !== line.acceptanceContractSha256
      || !state.done.has('HANDOFF') || !state.done.has('RETIRE')) {
      throw new Error('FORWARD_HOST_LINEAGE_ACCEPTANCE_DRIFT');
    }
    verifyAcceptance(accepted.contract, {authorizationId: predecessor.authorizationId,
      authorizationSha256: line.predecessorAuthorizationSha256,
      parentAttemptId: predecessor.parent.attemptId, target: predecessor.target});
    facts.acceptance = {contractSha256: line.acceptanceContractSha256, handoff: true, retire: true};
  }
  validateContinuityLineageBindings(authorization, predecessor, facts);
  return {predecessor, toolDir, collectorPath: line.predecessorCollectorPath,
    collectorModuleSha256: line.predecessorCollectorModuleSha256};
}
