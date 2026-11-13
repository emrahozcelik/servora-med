// One-time root-only narrowing of the four observed servora-deploy sudo grants.
// It never opens the bootstrap fence or authorizes installation or deployment.
import {createHash} from 'node:crypto';

const ROOT = '/var/lib/servora-med-bootstrap-quarantine';
const SHA = /^[a-f0-9]{64}$/;
const canonical = value => JSON.stringify(value) + '\n';
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw new Error('BOOTSTRAP_SUDO_QUARANTINE_' + code); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export const POLICY_FILES = Object.freeze([
  '/etc/sudoers.d/servora-deploy',
  '/etc/sudoers.d/servora-deploy-caddy-activation',
  '/etc/sudoers.d/servora-med-predeploy-backup',
  '/etc/sudoers.d/servora-med-production-deploy',
]);
export const QUARANTINED_POLICY = '# Servora-Med bootstrap sudo quarantine.\n'
  + '# No delegated management command is granted by this file.\n';

// Deliberately not a sudoers parser: only simple positive grants for this
// account may be removed. Removing a deny, Defaults, alias or include can
// uncover authority in an otherwise unchanged policy.
function assertPositivePolicy(bytes) {
  const text = bytes.toString('utf8');
  if (!/^[\t\n\x20-\x7e]*$/.test(text)) fail('POLICY_UNSUPPORTED');
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || (line.startsWith('#') && !/^#[ \t]*include/i.test(line))) continue;
    const grant = /^servora-deploy[ \t]+ALL[ \t]*=[ \t]*\([ \t]*root[ \t]*\)[ \t]*NOPASSWD[ \t]*:[ \t]*(.+)$/.exec(line);
    if (!grant || !grant[1].split(',').every(command =>
      /^\/[A-Za-z0-9_./@*?+-]+(?:[ \t]+[A-Za-z0-9_./@*?=+-]+)*$/.test(command.trim()))) fail('POLICY_UNSUPPORTED');
  }
}

/** Tests provide synthetic ports. The root CLI provides only fixed paths and
 * real root-owned evidence; no CLI truth flags or filesystem overrides exist. */
export function createDelegationQuarantine(io) {
  return ({mode, expectedAuthorization}) => {
    io.assertRoot();
    if (!['dry-run', 'apply'].includes(mode) || !SHA.test(expectedAuthorization ?? '')) fail('ARGUMENTS_INVALID');
    const bytes = io.readTrusted(ROOT + '/authorization.json', 0o600);
    if (hash(bytes) !== expectedAuthorization) fail('AUTHORIZATION_MISMATCH');
    let a;
    try { a = JSON.parse(bytes.toString('utf8')); } catch { fail('AUTHORIZATION_INVALID'); }
    if (!exact(a, ['formatVersion', 'kind', 'scope', 'machineId', 'hostLock', 'sudoListingSha256',
      'otherPolicySha256', 'preservedState', 'policies']) || canonical(a) !== bytes.toString('utf8')
      || a.formatVersion !== 1 || a.kind !== 'BOOTSTRAP_SUDO_QUARANTINE_AUTHORIZATION'
      || a.scope !== 'CLOSE_SERVORA_DEPLOY_SUDO_ONLY' || !/^[a-f0-9]{32}$/.test(a.machineId)
      || !exact(a.hostLock, ['device', 'inode']) || !/^[0-9]+$/.test(a.hostLock.device)
      || !/^[1-9][0-9]*$/.test(a.hostLock.inode) || !SHA.test(a.sudoListingSha256)
      || !SHA.test(a.otherPolicySha256) || !exact(a.preservedState,
        ['currentRelease', 'profileSha256', 'serviceIdentity', 'historicalInventorySha256'])
      || !/^[a-f0-9]{40}$/.test(a.preservedState.currentRelease)
      || ['profileSha256', 'serviceIdentity', 'historicalInventorySha256'].some(key => !SHA.test(a.preservedState[key]))
      || !Array.isArray(a.policies) || a.policies.length !== POLICY_FILES.length
      || a.policies.some((entry, index) => !exact(entry, ['path', 'sha256'])
        || entry.path !== POLICY_FILES[index] || !SHA.test(entry.sha256))) fail('AUTHORIZATION_INVALID');
    io.assertFresh();
    const check = () => {
      if (io.machineId() !== a.machineId || canonical(io.assertLock()) !== canonical(a.hostLock)) fail('HOST_MISMATCH');
      if (io.otherPolicyHash() !== a.otherPolicySha256) fail('OTHER_POLICY_DRIFT');
      if (canonical(io.snapshot()) !== canonical(a.preservedState)) fail('PRESERVED_STATE_DRIFT');
    };
    check();
    if (io.sudoListingHash() !== a.sudoListingSha256) fail('SUDO_LISTING_DRIFT');
    const originals = a.policies.map(entry => {
      const original = io.readTrusted(entry.path, 0o440);
      if (hash(original) !== entry.sha256) fail('POLICY_DRIFT');
      assertPositivePolicy(original);
      return {...entry, bytes: original};
    });
    if (mode === 'dry-run') return {status: 'DRY_RUN_OK', authorizationSha256: expectedAuthorization,
      policyPaths: [...POLICY_FILES], proposedPolicySha256: hash(QUARANTINED_POLICY)};
    // Reservation and original bytes are durable before any permission change.
    // Any residue refuses the next invocation; nothing is automatically repaired.
    io.reserve(originals, expectedAuthorization);
    for (const original of originals) {
      check();
      io.replacePolicy(original.path, Buffer.from(QUARANTINED_POLICY), original.bytes);
      if (hash(io.readTrusted(original.path, 0o440)) !== hash(QUARANTINED_POLICY)) fail('PUBLISHED_POLICY_MISMATCH');
    }
    io.assertSudoClosed();
    check();
    const receipt = {formatVersion: 1, kind: 'BOOTSTRAP_SUDO_MANAGEMENT_QUARANTINED',
      authority: 'SUDO_ONLY_NOT_BOOTSTRAP_INSTALL_OR_RELEASE', authorizationSha256: expectedAuthorization,
      oldPolicies: a.policies, newPolicySha256: hash(QUARANTINED_POLICY), preservedState: a.preservedState};
    io.receipt(Buffer.from(canonical(receipt)));
    return {status: 'SUDO_MANAGEMENT_QUARANTINED', authority: receipt.authority,
      authorizationSha256: expectedAuthorization, receiptSha256: hash(canonical(receipt))};
  };
}
