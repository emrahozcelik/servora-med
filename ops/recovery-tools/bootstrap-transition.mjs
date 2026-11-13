// Separately provisioned root-only B1-02 transition; never a deployment grant.
import {createHash} from 'node:crypto';
import {BOOTSTRAP_RELEASE_CHECKS, validateBootstrapManagementManifest} from '../scripts/bootstrap-fence.mjs';

const PRIVATE = '/var/lib/servora-med-bootstrap-transition';
const ROOT = '/var/lib/servora-med/deploy/bootstrap';
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const canonical = value => JSON.stringify(value) + '\n';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const encodeBootstrapEnvelope = record => Buffer.from(canonical({record, sha256: hash(canonical(record))}));
const encode = encodeBootstrapEnvelope;
const fail = code => {throw new Error('BOOTSTRAP_TRANSITION_' + code);};
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export function decodeBootstrapEnvelope(bytes) {
  try {
    const e = JSON.parse(bytes.toString('utf8'));
    if (!exact(e, ['record', 'sha256']) || canonical(e) !== bytes.toString('utf8')
      || !SHA.test(e.sha256) || hash(canonical(e.record)) !== e.sha256) fail('RECORD_INVALID');
    return e.record;
  } catch {fail('RECORD_INVALID');}
}
const decode = decodeBootstrapEnvelope;

function externalAuthorization(io, a, name = 'external-quarantine-authorization.json') {
  const bytes = io.readTrusted(PRIVATE + '/' + name, 0o600);
  if (hash(bytes) !== a.externalAuthorizationSha256) fail('EXTERNAL_AUTHORIZATION_MISMATCH');
  const e = decode(bytes);
  if (!exact(e, ['formatVersion', 'kind', 'scope', 'fenceId', 'machineId', 'bootId', 'hostLock',
    'sudoReceiptSha256', 'managementReviewSha256', 'rootAccessProofSha256', 'processDrainProofSha256'])
    || e.formatVersion !== 1 || e.kind !== 'BOOTSTRAP_EXTERNAL_QUARANTINE_AUTHORIZATION'
    || e.scope !== 'ALL_NON_ROOT_MANAGEMENT_CLOSED_AND_PRIVILEGED_MUTATIONS_DRAINED'
    || e.fenceId !== a.fenceId || e.machineId !== a.machineId || !UUID.test(e.bootId)
    || e.bootId !== io.bootId() || canonical(e.hostLock) !== canonical(a.hostLock)
    || ['sudoReceiptSha256', 'managementReviewSha256', 'rootAccessProofSha256', 'processDrainProofSha256']
      .some(key => !SHA.test(e[key]))) fail('EXTERNAL_AUTHORIZATION_INVALID');
  return e;
}

export function createBootstrapInstaller(io) {
  return ({mode, expectedAuthorization, sourceSha, fenceId}) => {
    io.assertRoot();
    if (mode === 'capture') {
      if (!/^[a-f0-9]{40}$/.test(sourceSha ?? '') || !UUID.test(fenceId ?? '')) fail('ARGUMENTS_INVALID');
      io.assertFreshInstall();
      const manifestBytes = io.readTrusted(PRIVATE + '/manifest.json', 0o600);
      const tools = validateBootstrapManagementManifest(decode(manifestBytes));
      io.assertPreparedClosure(tools);
      const externalBytes = io.readTrusted(PRIVATE + '/external-quarantine-authorization.json', 0o600);
      const anchor = {fenceId, machineId: io.machineId(), hostLock: io.assertLock(),
        externalAuthorizationSha256: hash(externalBytes)};
      const external = externalAuthorization(io, anchor);
      io.assertExternalQuarantine(external, {phase: 'install', sourceSha, manifestSha256: hash(manifestBytes)});
      const previousTools = tools.map(tool => {
        if (hash(io.readTrusted(PRIVATE + '/prepared/' + tool.sha256, 0o600)) !== tool.sha256) fail('PREPARED_TOOL_DRIFT');
        const previous = io.readOptionalTool(tool);
        return {path: tool.path, mode: tool.mode, sha256: previous === null ? null : hash(previous)};
      });
      return {status: 'INSTALL_PROPOSAL', authority: 'READ_ONLY_NOT_AUTHORIZATION', record: {
        formatVersion: 1, kind: 'BOOTSTRAP_INSTALL_PROPOSAL', scope: 'PUBLISH_CLOSED_AND_INSTALL_TOOLS',
        ...anchor, sourceSha, manifestSha256: hash(manifestBytes), preservedState: io.snapshot(), previousTools,
      }};
    }
    if (!['dry-run', 'apply'].includes(mode) || !SHA.test(expectedAuthorization ?? '')) fail('ARGUMENTS_INVALID');
    const bytes = io.readTrusted(PRIVATE + '/install-authorization.json', 0o600);
    if (hash(bytes) !== expectedAuthorization) fail('AUTHORIZATION_MISMATCH');
    const a = decode(bytes);
    if (a.formatVersion !== 1 || a.kind !== 'BOOTSTRAP_INSTALL_AUTHORIZATION'
      || a.scope !== 'PUBLISH_CLOSED_AND_INSTALL_TOOLS') fail('AUTHORIZATION_INVALID');
    if (!exact(a, ['formatVersion', 'kind', 'scope', 'fenceId', 'machineId', 'hostLock', 'sourceSha',
      'manifestSha256', 'externalAuthorizationSha256', 'preservedState', 'previousTools'])
      || !UUID.test(a.fenceId) || !/^[a-f0-9]{32}$/.test(a.machineId) || !/^[a-f0-9]{40}$/.test(a.sourceSha)
      || !exact(a.hostLock, ['device', 'inode']) || !/^[0-9]+$/.test(a.hostLock.device)
      || !/^[1-9][0-9]*$/.test(a.hostLock.inode) || !SHA.test(a.manifestSha256)
      || !SHA.test(a.externalAuthorizationSha256) || !exact(a.preservedState,
        ['currentRelease', 'profileSha256', 'serviceIdentity', 'historicalInventorySha256'])
      || !/^[a-f0-9]{40}$/.test(a.preservedState.currentRelease)
      || ['profileSha256', 'serviceIdentity', 'historicalInventorySha256'].some(key => !SHA.test(a.preservedState[key]))) fail('AUTHORIZATION_INVALID');
    io.assertFreshInstall();
    const manifestBytes = io.readTrusted(PRIVATE + '/manifest.json', 0o600);
    if (hash(manifestBytes) !== a.manifestSha256) fail('MANIFEST_MISMATCH');
    const tools = validateBootstrapManagementManifest(decode(manifestBytes));
    io.assertPreparedClosure(tools);
    if (!Array.isArray(a.previousTools) || a.previousTools.length !== tools.length
      || a.previousTools.some((old, i) => !exact(old, ['path', 'mode', 'sha256'])
        || old.path !== tools[i].path || old.mode !== tools[i].mode
        || (old.sha256 !== null && !SHA.test(old.sha256)))) fail('AUTHORIZATION_INVALID');
    const external = externalAuthorization(io, a);
    const check = () => {
      if (io.machineId() !== a.machineId || canonical(io.assertLock()) !== canonical(a.hostLock)) fail('HOST_MISMATCH');
      if (io.bootId() !== external.bootId) fail('BOOT_CHANGED');
      io.assertExternalQuarantine(external, {phase: 'install', sourceSha: a.sourceSha, manifestSha256: a.manifestSha256});
      if (canonical(io.snapshot()) !== canonical(a.preservedState)) fail('PRESERVED_STATE_DRIFT');
    };
    check();
    const prepared = tools.map((tool, i) => {
      const replacement = io.readTrusted(PRIVATE + '/prepared/' + tool.sha256, 0o600);
      if (hash(replacement) !== tool.sha256) fail('PREPARED_TOOL_DRIFT');
      const previous = io.readOptionalTool(tool);
      if ((previous === null ? null : hash(previous)) !== a.previousTools[i].sha256) fail('OLD_TOOL_DRIFT');
      // Existing content-addressed sets belong to their owning factory and
      // remain immutable even when a root installation plan names them.
      if (/^\/usr\/local\/libexec\/servora-med-(?:forward|emergency)-tools\/[a-f0-9]{64}\//.test(tool.path)
        && (previous === null || !previous.equals(replacement))) fail('IMMUTABLE_TOOLSET_CHANGE');
      return {tool, replacement, previous};
    });
    const closedBytes = encode({formatVersion: 1, kind: 'BOOTSTRAP_FENCE_CLOSED', fenceId: a.fenceId,
      machineId: a.machineId, manifestSha256: a.manifestSha256, hostLock: a.hostLock});
    if (mode === 'dry-run') return {status: 'DRY_RUN_OK', manifestSha256: a.manifestSha256, fenceSha256: hash(closedBytes)};
    io.reserveInstall(prepared, expectedAuthorization);
    io.publishClosed(manifestBytes, closedBytes);
    const checkClosed = () => {
      if (canonical(io.list(ROOT).sort()) !== canonical(['closed.json', 'manifest.json'])
        || !io.readTrusted(ROOT + '/closed.json', 0o600).equals(closedBytes)
        || !io.readTrusted(ROOT + '/manifest.json', 0o600).equals(manifestBytes)) fail('CLOSED_STATE_DRIFT');
    };
    for (const entry of prepared) {
      check(); checkClosed();
      io.replaceTool(entry.tool, entry.replacement, entry.previous);
      if (hash(io.readTrusted(entry.tool.path, entry.tool.mode)) !== entry.tool.sha256) fail('INSTALLED_TOOL_DRIFT');
    }
    check(); checkClosed();
    const receipt = encode({formatVersion: 1, kind: 'BOOTSTRAP_INSTALLED_CLOSED',
      authority: 'NO_RELEASE_OR_DEPLOYMENT_AUTHORITY', installAuthorizationSha256: expectedAuthorization,
      externalAuthorizationSha256: a.externalAuthorizationSha256, sourceSha: a.sourceSha,
      fenceSha256: hash(closedBytes), manifestSha256: a.manifestSha256, preservedState: a.preservedState});
    io.installReceipt(receipt);
    return {status: 'INSTALLED_CLOSED', fenceSha256: hash(closedBytes), manifestSha256: a.manifestSha256,
      receiptSha256: hash(receipt)};
  };
}

function collectReleaseEvidence(io, expectedExternalAuthorization) {
  const closedBytes = io.readTrusted(ROOT + '/closed.json', 0o600), closed = decode(closedBytes);
  if (!exact(closed, ['formatVersion', 'kind', 'fenceId', 'machineId', 'manifestSha256', 'hostLock'])
    || closed.formatVersion !== 1 || closed.kind !== 'BOOTSTRAP_FENCE_CLOSED' || !UUID.test(closed.fenceId)
    || closed.machineId !== io.machineId() || canonical(closed.hostLock) !== canonical(io.assertLock())) fail('CLOSED_STATE_DRIFT');
  const manifestBytes = io.readTrusted(ROOT + '/manifest.json', 0o600);
  if (hash(manifestBytes) !== closed.manifestSha256) fail('MANIFEST_MISMATCH');
  const tools = validateBootstrapManagementManifest(decode(manifestBytes));
  io.assertPreparedClosure(tools);
  const receipt = decode(io.readTrusted(PRIVATE + '/install-receipt.json', 0o600));
  if (!exact(receipt, ['formatVersion', 'kind', 'authority', 'installAuthorizationSha256',
    'externalAuthorizationSha256', 'sourceSha', 'fenceSha256', 'manifestSha256', 'preservedState'])
    || receipt.formatVersion !== 1 || receipt.kind !== 'BOOTSTRAP_INSTALLED_CLOSED'
    || receipt.authority !== 'NO_RELEASE_OR_DEPLOYMENT_AUTHORITY' || receipt.fenceSha256 !== hash(closedBytes)
    || receipt.manifestSha256 !== hash(manifestBytes) || !/^[a-f0-9]{40}$/.test(receipt.sourceSha)) fail('INSTALL_RECEIPT_INVALID');
  const installedAuthorization = io.readTrusted(PRIVATE + '/install-authorization.json', 0o600);
  if (hash(installedAuthorization) !== receipt.installAuthorizationSha256) fail('INSTALL_RECEIPT_INVALID');
  const a = decode(installedAuthorization);
  if (a.kind !== 'BOOTSTRAP_INSTALL_AUTHORIZATION' || a.scope !== 'PUBLISH_CLOSED_AND_INSTALL_TOOLS'
    || a.fenceId !== closed.fenceId || a.sourceSha !== receipt.sourceSha
    || a.manifestSha256 !== receipt.manifestSha256 || canonical(a.preservedState) !== canonical(receipt.preservedState)) fail('INSTALL_RECEIPT_INVALID');
  const externalBytes = io.readTrusted(PRIVATE + '/release-external-authorization.json', 0o600);
  if (expectedExternalAuthorization !== undefined && hash(externalBytes) !== expectedExternalAuthorization) fail('EXTERNAL_AUTHORIZATION_MISMATCH');
  const external = externalAuthorization(io, {...closed, externalAuthorizationSha256: hash(externalBytes)}, 'release-external-authorization.json');
  io.assertExternalQuarantine(external, {phase: 'release', sourceSha: receipt.sourceSha, manifestSha256: hash(manifestBytes)});
  for (const tool of tools) if (hash(io.readTrusted(tool.path, tool.mode)) !== tool.sha256) fail('INSTALLED_TOOL_DRIFT');
  const state = io.snapshot();
  for (const key of ['currentRelease', 'serviceIdentity', 'historicalInventorySha256']) {
    if (state[key] !== receipt.preservedState[key]) fail('PRESERVED_STATE_DRIFT');
  }
  // These methods perform real fixed-path host checks in the production port.
  // They are not caller-provided verification booleans or CLI switches.
  io.assertProfileContracts();
  const canonicalTime = io.assertCanonicalTrustedTime();
  const verification = {formatVersion: 1, kind: 'BOOTSTRAP_RELEASE_VERIFICATION', fenceSha256: hash(closedBytes),
    manifestSha256: hash(manifestBytes), profileSha256: state.profileSha256,
    checks: Object.fromEntries(BOOTSTRAP_RELEASE_CHECKS.map(check => [check, true]))};
  return {verification, evidence: {sourceSha: receipt.sourceSha, state, canonicalTime,
    externalAuthorizationSha256: hash(externalBytes)}};
}

export function createBootstrapReleaser(io) {
  return ({mode, expectedAuthorization, expectedExternalAuthorization}) => {
    io.assertRoot();
    if (!['capture', 'apply'].includes(mode) || (mode === 'apply'
      && (!SHA.test(expectedAuthorization ?? '') || !SHA.test(expectedExternalAuthorization ?? '')))) fail('ARGUMENTS_INVALID');
    io.assertFreshRelease();
    if (mode === 'capture') {
      const result = collectReleaseEvidence(io), bytes = encode(result.verification);
      return {status: 'RELEASE_PROPOSAL', authority: 'READ_ONLY_NOT_AUTHORIZATION',
        verification: JSON.parse(bytes.toString('utf8')), verificationSha256: hash(bytes), evidence: result.evidence};
    }
    const authorizationBytes = io.readTrusted(ROOT + '/release-authorization.json', 0o600);
    if (hash(authorizationBytes) !== expectedAuthorization) fail('AUTHORIZATION_MISMATCH');
    const a = decode(authorizationBytes);
    if (!exact(a, ['formatVersion', 'kind', 'scope', 'fenceSha256', 'manifestSha256', 'profileSha256', 'verificationSha256'])
      || a.formatVersion !== 1 || a.kind !== 'BOOTSTRAP_RELEASE_AUTHORIZATION'
      || a.scope !== 'ENABLE_APPROVAL_GATED_MANAGEMENT'
      || ['fenceSha256', 'manifestSha256', 'profileSha256', 'verificationSha256'].some(key => !SHA.test(a[key]))) fail('RELEASE_AUTHORIZATION_INVALID');
    const verificationBytes = io.readTrusted(ROOT + '/verification.json', 0o600);
    if (hash(verificationBytes) !== a.verificationSha256) fail('VERIFICATION_MISMATCH');
    const result = collectReleaseEvidence(io, expectedExternalAuthorization);
    const check = evidence => {
      if (!encode(evidence.verification).equals(verificationBytes)
        || ['fenceSha256', 'manifestSha256', 'profileSha256'].some(key => a[key] !== evidence.verification[key])) fail('VERIFICATION_MISMATCH');
    };
    check(result);
    io.reserveRelease(encode({formatVersion: 1, kind: 'BOOTSTRAP_RELEASE_RESERVED',
      authorizationSha256: expectedAuthorization, externalAuthorizationSha256: expectedExternalAuthorization}));
    const final = collectReleaseEvidence(io, expectedExternalAuthorization);
    check(final);
    io.publishReleaseEvidence(encode({formatVersion: 1, kind: 'BOOTSTRAP_RELEASE_EVIDENCE',
      authorizationSha256: expectedAuthorization, verificationSha256: a.verificationSha256,
      beforeReservation: result.evidence, beforePublication: final.evidence}));
    // This final exclusive publication is the release commit point. No sudo
    // grant is restored and no approval/adoption/deployment is issued here.
    const releasedBytes = encode({formatVersion: 1, kind: 'BOOTSTRAP_FENCE_RELEASED',
      fenceSha256: a.fenceSha256, authorizationSha256: expectedAuthorization, verificationSha256: a.verificationSha256});
    io.publishReleased(releasedBytes);
    io.assertReleased();
    return {status: 'RELEASED_APPROVAL_GATES_REMAIN', releasedSha256: hash(releasedBytes),
      fenceSha256: a.fenceSha256, manifestSha256: a.manifestSha256};
  };
}
