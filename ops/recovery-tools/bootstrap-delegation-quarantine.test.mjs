import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {createDelegationQuarantine, POLICY_FILES, QUARANTINED_POLICY} from './bootstrap-delegation-quarantine.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => Buffer.from(JSON.stringify(value) + '\n');
const ROOT = '/var/lib/servora-med-bootstrap-quarantine';

function fixture() {
  const files = new Map(POLICY_FILES.map(path => [path, Buffer.from('# synthetic sudo policy ' + path + '\n')]));
  const state = {currentRelease: 'a'.repeat(40), profileSha256: 'b'.repeat(64),
    serviceIdentity: 'c'.repeat(64), historicalInventorySha256: 'd'.repeat(64)};
  const authorization = {formatVersion: 1, kind: 'BOOTSTRAP_SUDO_QUARANTINE_AUTHORIZATION',
    scope: 'CLOSE_SERVORA_DEPLOY_SUDO_ONLY', machineId: '1'.repeat(32),
    hostLock: {device: '1', inode: '2'}, sudoListingSha256: 'e'.repeat(64),
    otherPolicySha256: 'f'.repeat(64), preservedState: state,
    policies: POLICY_FILES.map(path => ({path, sha256: hash(files.get(path))}))};
  const bytes = encode(authorization);
  files.set(ROOT + '/authorization.json', bytes);
  const events = [];
  let reserved = false;
  const io = {
    assertRoot() {}, assertLock: () => ({device: '1', inode: '2'}), machineId: () => '1'.repeat(32),
    readTrusted(path) { return files.get(path); },
    assertFresh() { if (reserved) throw new Error('BOOTSTRAP_SUDO_QUARANTINE_STATE_NOT_FRESH'); },
    otherPolicyHash: () => 'f'.repeat(64), snapshot: () => state,
    sudoListingHash: () => 'e'.repeat(64), assertSudoClosed() {},
    reserve(originals) { events.push('reserve'); reserved = true; assert.equal(originals.length, 4); },
    replacePolicy(path, bytes, original) {
      assert.deepEqual(files.get(path), original); events.push(path); files.set(path, bytes);
    },
    receipt(bytes) { events.push('receipt'); files.set(ROOT + '/receipt.json', bytes); },
  };
  return {files, authorization, authorizationSha256: hash(bytes), io, events, state};
}

test('unreadable evidence and a replaced stable lock stop before the first state write', () => {
  const f = fixture();
  f.io.readTrusted = () => { throw Object.assign(new Error('unreadable'), {code: 'EACCES'}); };
  assert.throws(() => createDelegationQuarantine(f.io)({mode: 'apply', expectedAuthorization: f.authorizationSha256}), /unreadable/);
  assert.deepEqual(f.events, []);
  const g = fixture();
  g.io.assertLock = () => ({device: '1', inode: '999'});
  assert.throws(() => createDelegationQuarantine(g.io)({mode: 'apply', expectedAuthorization: g.authorizationSha256}), /HOST_MISMATCH/);
  assert.deepEqual(g.events, []);
});

test('service or historical drift during narrowing stops without rollback or a success receipt', () => {
  const f = fixture(), publish = f.io.replacePolicy;
  f.io.replacePolicy = (...args) => { publish(...args); f.io.snapshot = () => ({...f.state, historicalInventorySha256: '0'.repeat(64)}); };
  assert.throws(() => createDelegationQuarantine(f.io)({mode: 'apply', expectedAuthorization: f.authorizationSha256}), /PRESERVED_STATE_DRIFT/);
  assert.deepEqual(f.events, ['reserve', POLICY_FILES[0]]);
  assert.equal(f.files.has(ROOT + '/receipt.json'), false);
});

test('a remaining sudo grant prevents any completion receipt', () => {
  const f = fixture();
  f.io.assertSudoClosed = () => { throw new Error('BOOTSTRAP_SUDO_QUARANTINE_DELEGATION_REMAINS_OPEN'); };
  assert.throws(() => createDelegationQuarantine(f.io)({mode: 'apply', expectedAuthorization: f.authorizationSha256}), /DELEGATION_REMAINS_OPEN/);
  assert.equal(f.files.has(ROOT + '/receipt.json'), false);
  assert.deepEqual(f.events, ['reserve', ...POLICY_FILES]);
});

test('an ENOSPC reservation failure cannot change a sudo policy', () => {
  const f = fixture(), before = new Map(f.files);
  f.io.reserve = () => { throw Object.assign(new Error('full disk'), {code: 'ENOSPC'}); };
  assert.throws(() => createDelegationQuarantine(f.io)({mode: 'apply', expectedAuthorization: f.authorizationSha256}), /full disk/);
  assert.deepEqual(f.files, before);
  assert.deepEqual(f.events, []);
});

test('policy drift is checked for the entire set before the first reservation or write', () => {
  const f = fixture();
  f.files.set(POLICY_FILES.at(-1), Buffer.from('unexpected current grant\n'));
  assert.throws(() => createDelegationQuarantine(f.io)({mode: 'apply', expectedAuthorization: f.authorizationSha256}), /POLICY_DRIFT/);
  assert.deepEqual(f.events, []);
});

test('a read-only capture cannot become an authorization by copying its bytes', () => {
  const f = fixture();
  f.authorization.kind = 'BOOTSTRAP_SUDO_QUARANTINE_PROPOSAL';
  const bytes = encode(f.authorization);
  f.files.set(ROOT + '/authorization.json', bytes);
  assert.throws(() => createDelegationQuarantine(f.io)({mode: 'apply', expectedAuthorization: hash(bytes)}),
    /AUTHORIZATION_INVALID/);
  assert.deepEqual(f.events, []);
});

test('dry-run validates the same authorization and leaves all policies and state unchanged', () => {
  const f = fixture(), before = new Map(f.files);
  const result = createDelegationQuarantine(f.io)({mode: 'dry-run', expectedAuthorization: f.authorizationSha256});
  assert.equal(result.status, 'DRY_RUN_OK');
  assert.deepEqual(f.files, before);
  assert.deepEqual(f.events, []);
});

test('the owner-authorized transition closes all four sudo policy files and grants no bootstrap installation', () => {
  const f = fixture();
  const result = createDelegationQuarantine(f.io)({mode: 'apply', expectedAuthorization: f.authorizationSha256});
  assert.equal(result.status, 'SUDO_MANAGEMENT_QUARANTINED');
  assert.equal(result.authority, 'SUDO_ONLY_NOT_BOOTSTRAP_INSTALL_OR_RELEASE');
  assert.deepEqual(f.events, ['reserve', ...POLICY_FILES, 'receipt']);
  for (const path of POLICY_FILES) assert.equal(f.files.get(path).toString(), QUARANTINED_POLICY);
});

test('a partial policy change never rolls back or retries the uncertain operation', () => {
  const f = fixture(), original = f.io.replacePolicy;
  f.io.replacePolicy = (path, bytes, previous) => {
    if (path === POLICY_FILES[1]) throw Object.assign(new Error('synthetic I/O failure'), {code: 'EIO'});
    original(path, bytes, previous);
  };
  const apply = () => createDelegationQuarantine(f.io)({mode: 'apply', expectedAuthorization: f.authorizationSha256});
  assert.throws(apply, /synthetic I\/O failure/);
  assert.equal(f.files.get(POLICY_FILES[0]).toString(), QUARANTINED_POLICY);
  assert.notEqual(f.files.get(POLICY_FILES[1]).toString(), QUARANTINED_POLICY);
  assert.equal(f.files.has(ROOT + '/receipt.json'), false);
  assert.deepEqual(f.events, ['reserve', POLICY_FILES[0]]);
  assert.throws(apply, /STATE_NOT_FRESH/);
  assert.deepEqual(f.events, ['reserve', POLICY_FILES[0]]);
});
