/** OPS-DEPLOY-002 one-time root host transition.
 *
 * Replaces exactly three reviewed management files (host helper, fence wrapper,
 * fence module) with the pinned OPS-DEPLOY-002 bytes, archives every record it
 * supersedes, and re-seals manifest -> closed -> verification -> authorization
 * -> released plus the profile helper contract. It never touches attempts,
 * approvals, backups, releases, the database or the service.
 *
 * Root deliberately changing host policy is outside the B1-01 fence threat
 * model; this tool makes that change bounded, pinned and auditable. Run only
 * through the hash-pinning `normal-deploy-transition` wrapper, which holds the
 * host lock and has already refused any pending attempt. */
import * as fs from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

export const LIB = '/usr/local/libexec/servora-med';
export const STATE = '/var/lib/servora-med/deploy';
export const BOOTSTRAP = STATE + '/bootstrap';
export const PROFILE = STATE + '/profile.json';
export const ARCHIVE = STATE + '/transitions/ops-deploy-002';
export const TEMP_PREFIX = '.ops-deploy-002-';
export const RECORDS = ['manifest.json', 'closed.json', 'verification.json', 'release-authorization.json', 'released.json'];

/** name -> mode, pre-transition (installed 2026-11-16) and OPS-DEPLOY-002 bytes. */
export const TOOLS = Object.freeze({
  'deploy-production-host': {mode: 0o755,
    old: '615fecec455ca105e461e4a7ec1822e84886e378a7e7a22ff98245b0c155a4ad',
    new: '7a728ab1174a6ad9b3bc1550c4602fa013720d0199ea56d50e3a89200150a483'},
  'bootstrap-fence': {mode: 0o755,
    old: 'd3e6195035aacd70c46504e5728fe12647272272dfe29c0aa16e352a23b9b761',
    new: 'ffa7f31281f70a8c770eb54e2e59bf5e81929e8db5b62e03bbad086c5d8781df'},
  'bootstrap-fence.mjs': {mode: 0o644,
    old: '068ea5157b89fd2dc3303acd1343b22a57c71b2bcd79ec3d3a42ee6c18174f31',
    new: '7142119e49d25b8b28050dab9251879353ad4da40b37292556272f860d682926'},
});

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(value) + '\n';
const fail = code => { throw new Error('OPS_DEPLOY_002_' + code); };
export const envelope = record => canonical({record, sha256: sha(canonical(record))});

/** Pure re-seal of the B1-01 chain. Inputs are the archived (pre-transition)
 * record bodies and profile; output is every file's exact new bytes. */
export function resealRecords({manifest, closed, verification, authorization, profile}, tools = TOOLS) {
  const paths = Object.fromEntries(Object.entries(tools).map(([name, tool]) => [`${LIB}/${name}`, tool]));
  const covered = new Set();
  const files = manifest.files.map(entry => {
    const tool = paths[entry.path];
    if (!tool) return entry;
    if (entry.mode !== tool.mode || ![tool.old, tool.new].includes(entry.sha256)) fail('MANIFEST_UNEXPECTED');
    covered.add(entry.path);
    return {...entry, sha256: tool.new};
  });
  if (covered.size !== Object.keys(tools).length) fail('MANIFEST_UNEXPECTED');
  const contracts = profile.contracts;
  const helper = tools['deploy-production-host'];
  if (![helper.old, helper.new].includes(contracts?.helperSha256)) fail('PROFILE_UNEXPECTED');
  const profileBytes = canonical({...profile, contracts: {...contracts, helperSha256: helper.new}});
  const manifestBytes = envelope({...manifest, files});
  const closedBytes = envelope({...closed, manifestSha256: sha(manifestBytes)});
  const common = {fenceSha256: sha(closedBytes), manifestSha256: sha(manifestBytes), profileSha256: sha(profileBytes)};
  const verificationBytes = envelope({...verification, ...common});
  const authorizationBytes = envelope({...authorization, ...common, verificationSha256: sha(verificationBytes)});
  const releasedBytes = envelope({formatVersion: 1, kind: 'BOOTSTRAP_FENCE_RELEASED', fenceSha256: common.fenceSha256,
    authorizationSha256: sha(authorizationBytes), verificationSha256: sha(verificationBytes)});
  return {profile: profileBytes, 'manifest.json': manifestBytes, 'closed.json': closedBytes,
    'verification.json': verificationBytes, 'release-authorization.json': authorizationBytes, 'released.json': releasedBytes};
}

function readRecord(path) {
  const parsed = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (!parsed || canonical(parsed) !== fs.readFileSync(path, 'utf8') || sha(canonical(parsed.record)) !== parsed.sha256) fail('RECORD_INVALID');
  return parsed.record;
}

function writeAtomic(directory, name, bytes, mode) {
  const temporary = `${directory}/${TEMP_PREFIX}${name}`;
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
  try { fs.writeFileSync(fd, bytes); fs.fchownSync(fd, 0, 0); fs.fchmodSync(fd, mode); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, `${directory}/${name}`);
  const dir = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}

const fence = (operation, attempt) => {
  try {
    execFileSync(`${LIB}/bootstrap-fence`, attempt ? [operation, attempt] : [operation], {stdio: ['ignore', 'pipe', 'pipe']});
    return 'ALLOWED';
  } catch (error) { return String(error.stderr ?? '').trim() || 'DENIED'; }
};

/** Read-only rehearsal on the real host: re-seal the live records in memory and
 * evaluate them with the staged OPS-DEPLOY-002 fence module. Writes nothing. */
async function checkTransition(staging, staged) {
  const live = name => readRecord(`${BOOTSTRAP}/${name}`);
  const next = resealRecords({manifest: live('manifest.json'), closed: live('closed.json'),
    verification: live('verification.json'), authorization: live('release-authorization.json'),
    profile: JSON.parse(fs.readFileSync(PROFILE, 'utf8'))});
  const overlay = new Map([[PROFILE, next.profile], ...RECORDS.map(name => [`${BOOTSTRAP}/${name}`, next[name]]),
    ...Object.entries(staged).map(([name, bytes]) => [`${LIB}/${name}`, bytes])]);
  const {createBootstrapFenceGuard, readBootstrapTrustedFile} = await import(`${staging}/bootstrap-fence.mjs`);
  const lock = fs.lstatSync(`${STATE}/host.lock`, {bigint: true});
  const guard = createBootstrapFenceGuard({
    assertRoot: () => {},
    readTrusted: (path, mode) => overlay.has(path) ? Buffer.from(overlay.get(path)) : readBootstrapTrustedFile(path, mode),
    list: directory => fs.readdirSync(directory),
    lockIdentity: () => ({device: String(lock.dev), inode: String(lock.ino)}),
    machineId: () => fs.readFileSync('/etc/machine-id', 'utf8').trim(),
  });
  const probe = (operation, attempt) => { try { guard(operation, attempt); return 'ALLOWED'; } catch (error) { return error.message; } };
  const probes = {deploy: probe('deploy'), postdeploy: probe('postdeploy'), rollback: probe('rollback'),
    forwardRecoveryWithoutAttempt: probe('forward-recovery'), legacyDeploy: probe('legacy-deploy')};
  if (probes.deploy !== 'ALLOWED' || probes.postdeploy !== 'ALLOWED' || probes.rollback !== 'ALLOWED'
    || !/ATTEMPT_REQUIRED/.test(probes.forwardRecoveryWithoutAttempt)
    || !/LEGACY_MUTATION_DISABLED/.test(probes.legacyDeploy)) fail('CHECK_FENCE_UNEXPECTED');
  return {formatVersion: 1, kind: 'OPS_DEPLOY_002_CHECK', writes: 0, probes,
    nextProfileSha256: sha(next.profile), nextReleasedSha256: sha(next['released.json'])};
}

export async function runTransition(staging, {check = false} = {}) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) fail('ROOT_LINUX_REQUIRED');
  if (!check) {
    for (const directory of [LIB, BOOTSTRAP, STATE]) {
      for (const name of fs.readdirSync(directory)) if (name.startsWith(TEMP_PREFIX)) fs.unlinkSync(`${directory}/${name}`);
    }
  }
  const installed = Object.fromEntries(Object.keys(TOOLS).map(name => [name, sha(fs.readFileSync(`${LIB}/${name}`))]));
  const state = Object.entries(TOOLS).every(([name, tool]) => installed[name] === tool.old) ? 'OLD'
    : Object.entries(TOOLS).every(([name, tool]) => installed[name] === tool.new) ? 'NEW' : fail('TOOL_STATE_UNKNOWN');
  const staged = Object.fromEntries(Object.entries(TOOLS).map(([name, tool]) => {
    const bytes = fs.readFileSync(`${staging}/${name}`);
    if (sha(bytes) !== tool.new) fail('STAGED_TOOL_MISMATCH');
    return [name, bytes];
  }));
  if (check) {
    if (state !== 'OLD') fail('CHECK_REQUIRES_PRE_TRANSITION_HOST');
    if (fence('forward') !== 'ALLOWED') fail('CURRENT_FENCE_NOT_RELEASED');
    if (fs.existsSync(ARCHIVE)) fail('ARCHIVE_ALREADY_EXISTS');
    return checkTransition(staging, staged);
  }
  if (state === 'OLD') {
    if (fence('forward') !== 'ALLOWED') fail('CURRENT_FENCE_NOT_RELEASED');
    if (fs.existsSync(ARCHIVE)) fail('ARCHIVE_ALREADY_EXISTS');
    fs.mkdirSync(STATE + '/transitions', {recursive: true, mode: 0o700});
    fs.mkdirSync(ARCHIVE, {mode: 0o700});
    const inventory = {};
    for (const name of RECORDS) {
      const bytes = fs.readFileSync(`${BOOTSTRAP}/${name}`);
      writeAtomic(ARCHIVE, name, bytes, 0o600); inventory[name] = sha(bytes);
    }
    const profileBytes = fs.readFileSync(PROFILE);
    writeAtomic(ARCHIVE, 'profile.json', profileBytes, 0o600); inventory['profile.json'] = sha(profileBytes);
    for (const name of Object.keys(TOOLS)) {
      const bytes = fs.readFileSync(`${LIB}/${name}`);
      writeAtomic(ARCHIVE, `tool-${name}`, bytes, 0o600); inventory[`tool-${name}`] = sha(bytes);
    }
    writeAtomic(ARCHIVE, 'archive.json', canonical({formatVersion: 1, kind: 'OPS_DEPLOY_002_ARCHIVE',
      archivedAtUTC: new Date().toISOString(), files: inventory}), 0o600);
  } else if (!fs.existsSync(`${ARCHIVE}/archive.json`)) fail('RESUME_ARCHIVE_MISSING');
  const archive = JSON.parse(fs.readFileSync(`${ARCHIVE}/archive.json`, 'utf8'));
  for (const [name, digest] of Object.entries(archive.files)) {
    if (sha(fs.readFileSync(`${ARCHIVE}/${name}`)) !== digest) fail('ARCHIVE_CORRUPT');
  }
  const next = resealRecords({
    manifest: readRecord(`${ARCHIVE}/manifest.json`), closed: readRecord(`${ARCHIVE}/closed.json`),
    verification: readRecord(`${ARCHIVE}/verification.json`), authorization: readRecord(`${ARCHIVE}/release-authorization.json`),
    profile: JSON.parse(fs.readFileSync(`${ARCHIVE}/profile.json`, 'utf8')),
  });
  for (const [name, bytes] of Object.entries(staged)) {
    if (installed[name] !== TOOLS[name].new) writeAtomic(LIB, name, bytes, TOOLS[name].mode);
  }
  writeAtomic(STATE, 'profile.json', next.profile, 0o600);
  for (const name of RECORDS) writeAtomic(BOOTSTRAP, name, next[name], 0o600);
  const probes = {
    deploy: fence('deploy'), postdeploy: fence('postdeploy'), rollback: fence('rollback'),
    forwardRecoveryWithoutAttempt: fence('forward-recovery'), legacyDeploy: fence('legacy-deploy'),
  };
  if (probes.deploy !== 'ALLOWED' || probes.postdeploy !== 'ALLOWED' || probes.rollback !== 'ALLOWED'
    || !/ATTEMPT_REQUIRED/.test(probes.forwardRecoveryWithoutAttempt)
    || !/LEGACY_MUTATION_DISABLED/.test(probes.legacyDeploy)) fail('POST_TRANSITION_FENCE_UNEXPECTED');
  const receipt = {formatVersion: 1, kind: 'OPS_DEPLOY_002_TRANSITION', completedAtUTC: new Date().toISOString(),
    resumed: state === 'NEW', tools: Object.fromEntries(Object.entries(TOOLS).map(([n, t]) => [n, {old: t.old, new: t.new}])),
    profileSha256: sha(next.profile), releasedSha256: sha(next['released.json']), probes};
  writeAtomic(ARCHIVE, 'transition.json', canonical(receipt), 0o600);
  return receipt;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = process.argv.slice(2);
    const check = args[0] === '--check';
    const [staging, ...extra] = check ? args.slice(1) : args;
    if (!staging || extra.length || !staging.startsWith('/')) fail('ARGUMENTS_INVALID');
    process.stdout.write(canonical(await runTransition(staging, {check})));
    console.log(check ? 'OPS_DEPLOY_002_CHECK=PASS' : 'OPS_DEPLOY_002_TRANSITION=PASS');
  } catch (error) {
    console.error(/^OPS_DEPLOY_002_[A-Z_]+$/.test(error.message) ? error.message : 'OPS_DEPLOY_002_FAILED ' + error.message);
    process.exitCode = 1;
  }
}
