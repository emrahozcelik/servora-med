/**
 * Root-only issuer for a single emergency restart-policy authorization.
 *
 * This tool is intentionally separate from the deployment approval API. It
 * never mutates deployment state: it reads the sealed parent, verifies the
 * exact installed host/release identity and writes one root-private,
 * one-use authorization bound to the current checkpoint.
 *
 * Running this tool is an explicit operator action. It is not part of the
 * normal deployment controller and grants no observation/acceptance authority.
 */
import {createHash} from 'node:crypto';
import {existsSync, readdirSync, writeFileSync, openSync, fsyncSync, closeSync, constants} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {
  AUTHORIZATION_FILE, ARTIFACT_ROOT, EMERGENCY_ROOT, ensureEmergencyRoot,
  assertRoot, withHostLock, verifyAttemptRelease, readLatestCheckpoint,
  captureLive, assertBackups,
} from './emergency-handoff-host.mjs';
import {verifyInstalledArtifact} from './emergency-handoff-artifact.mjs';
import {loadAttempt} from '/usr/local/libexec/servora-med/deployment-controller.mjs';
import {
  emergencyAuthorizationBinding,
  validateEmergencyHandoffAuthorization,
  EMERGENCY_HANDOFF_ACTIONS, EMERGENCY_HANDOFF_FORBIDDEN,
} from './emergency-handoff.mjs';


const digest = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value) + '\n';
const nowUTC = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const fail = code => { throw new Error(code); };

function argument(name) {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : null;
}

export async function issue() {
  assertRoot();
  ensureEmergencyRoot();
  const parentId = argument('--parent');
  const minutes = Number(argument('--expires-minutes') ?? '45');
  const reason = argument('--reason') ?? 'R4_OBSERVATION_TRUSTED_TIME_BLOCKED';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(parentId ?? '')
    || !Number.isInteger(minutes) || minutes < 1 || minutes > 60
    || typeof reason !== 'string' || reason.length === 0 || reason.length > 200) {
    fail('EMERGENCY_HANDOFF_ARGUMENTS_INVALID');
  }
  for (const name of readdirSync(EMERGENCY_ROOT)) {
    if (name !== 'authorization.json') fail('EMERGENCY_HANDOFF_JOURNAL_EXISTS');
  }
  if (existsSync(AUTHORIZATION_FILE)) fail('EMERGENCY_HANDOFF_AUTHORIZATION_EXISTS');
  const parent = loadAttempt(parentId);
  const checkpointFile = readLatestCheckpoint(parentId);
  const checkpoint = checkpointFile.record;
  if (checkpoint.phase !== 'POSTDEPLOY_BACKUP_PASSED' || checkpoint.migrationCommitted !== true
    || checkpoint.smokePassed !== true || !checkpoint.postdeployBackup
    || checkpoint.starts < 1 || checkpoint.starts !== parent.approval.maxStarts
    || checkpoint.lastStart !== 'pass') {
    fail('EMERGENCY_HANDOFF_PARENT_NOT_ELIGIBLE');
  }
  verifyAttemptRelease(parentId, 'target');
  assertBackups(parentId, checkpoint);
  const artifact = verifyInstalledArtifact(ARTIFACT_ROOT);
  const binding = emergencyAuthorizationBinding({
    attemptId: parentId, approvalSha256: parent.approvalSha256,
    profileSha256: parent.approval.profileSha256,
    checkpoint: {...checkpoint, sha256: checkpointFile.sha256},
    approval: parent.approval, profile: parent.profile,
  });
  const captured = await captureLive(parent.approval, parent.profile, checkpoint, null);
  const issuedAtUTC = nowUTC();
  const expiresAtUTC = new Date(Date.parse(issuedAtUTC) + minutes * 60 * 1000)
    .toISOString().replace(/\.\d{3}Z$/, 'Z');
  const authorization = {
    formatVersion: 2, kind: 'EMERGENCY_HANDOFF_AUTHORIZATION',
    authorizationId: randomUUID(),
    issuedAtUTC, expiresAtUTC, maxUses: 1, reason,
    scope: 'EMERGENCY_RESTART_POLICY_HANDOFF',
    parent: binding.parent, host: binding.host,
    backups: {
      preSha256: checkpoint.predeployBackup.sha256,
      postSha256: checkpoint.postdeployBackup.sha256,
    },
    actions: [...EMERGENCY_HANDOFF_ACTIONS],
    forbidden: [...EMERGENCY_HANDOFF_FORBIDDEN],
    toolArtifactSha256: artifact.artifactSha256,
  };
  const authorizationSha256 = digest(canonical(authorization));
  validateEmergencyHandoffAuthorization(authorization, {
    nowUTC: issuedAtUTC, authorizationSha256, toolArtifactSha256: artifact.artifactSha256,
    parent: binding.parent, host: binding.host,
    backups: authorization.backups, live: captured.live,
    journal: {present: false, authorizationId: null, authorizationSha256: null, terminal: false},
  });
  const fd = openSync(AUTHORIZATION_FILE, constants.O_WRONLY | constants.O_CREAT
    | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, canonical(authorization)); fsyncSync(fd); } finally { closeSync(fd); }
  const directory = EMERGENCY_ROOT;
  const dirFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  return {
    result: 'EMERGENCY_HANDOFF_AUTHORIZED',
    authorizationId: authorization.authorizationId,
    authorizationSha256,
    toolArtifactSha256: artifact.artifactSha256,
    parentAttemptId: parentId,
    checkpointSequence: checkpoint.sequence,
    checkpointSha256: checkpointFile.sha256,
    issuedAtUTC, expiresAtUTC,
    writeTo: AUTHORIZATION_FILE,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    assertRoot();
    withHostLock(process.argv.slice(2));
    issue().then(result => process.stdout.write(JSON.stringify(result) + '\n'))
      .catch(error => { process.stderr.write((error.message || 'EMERGENCY_HANDOFF_FAILED') + '\n'); process.exitCode = 1; });
  } catch (error) {
    process.stderr.write((error.message || 'EMERGENCY_HANDOFF_FAILED') + '\n');
    process.exitCode = 1;
  }
}

