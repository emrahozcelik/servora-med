import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {createBootstrapInstaller} from './bootstrap-transition.mjs';
import {REQUIRED_MANAGEMENT_FILES, createBootstrapFenceGuard} from '../scripts/bootstrap-fence.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = record => Buffer.from(JSON.stringify({record, sha256: hash(JSON.stringify(record) + '\n')}) + '\n');
const PRIVATE = '/var/lib/servora-med-bootstrap-transition';
const ROOT = '/var/lib/servora-med/deploy/bootstrap';
const ID = '11111111-1111-4111-8111-111111111111';

function fixture() {
  const files = new Map(), events = [], retained = [];
  const add = (path, bytes, mode = 0o600) => files.set(path, {bytes: Buffer.from(bytes), mode});
  const manifest = {formatVersion: 1, kind: 'BOOTSTRAP_MANAGEMENT_MANIFEST', files:
    REQUIRED_MANAGEMENT_FILES.map(tool => {
      const bytes = Buffer.from('new synthetic tool ' + tool.path + '\n');
      add(PRIVATE + '/prepared/' + hash(bytes), bytes);
      add(tool.path, 'old synthetic tool ' + tool.path + '\n', tool.mode);
      return {...tool, sha256: hash(bytes)};
    }).sort((a, b) => a.path < b.path ? -1 : 1)};
  const manifestBytes = encode(manifest); add(PRIVATE + '/manifest.json', manifestBytes);
  const state = {currentRelease: 'a'.repeat(40), profileSha256: 'b'.repeat(64),
    serviceIdentity: 'c'.repeat(64), historicalInventorySha256: 'd'.repeat(64)};
  const profile = Buffer.from('synthetic profile\n');
  add('/var/lib/servora-med/deploy/profile.json', profile);
  state.profileSha256 = hash(profile);
  const external = {formatVersion: 1, kind: 'BOOTSTRAP_EXTERNAL_QUARANTINE_AUTHORIZATION',
    scope: 'ALL_NON_ROOT_MANAGEMENT_CLOSED_AND_PRIVILEGED_MUTATIONS_DRAINED', fenceId: ID,
    machineId: '1'.repeat(32), bootId: '22222222-2222-4222-8222-222222222222',
    hostLock: {device: '1', inode: '2'}, sudoReceiptSha256: 'e'.repeat(64),
    managementReviewSha256: 'f'.repeat(64), rootAccessProofSha256: '0'.repeat(64), processDrainProofSha256: '9'.repeat(64)};
  const externalBytes = encode(external); add(PRIVATE + '/external-quarantine-authorization.json', externalBytes);
  const authorization = {formatVersion: 1, kind: 'BOOTSTRAP_INSTALL_AUTHORIZATION',
    scope: 'PUBLISH_CLOSED_AND_INSTALL_TOOLS', fenceId: ID, machineId: external.machineId,
    hostLock: external.hostLock, sourceSha: '8'.repeat(40), manifestSha256: hash(manifestBytes),
    externalAuthorizationSha256: hash(externalBytes), preservedState: state,
    previousTools: manifest.files.map(t => ({path: t.path, mode: t.mode, sha256: hash(files.get(t.path).bytes)}))};
  const authorizationBytes = encode(authorization); add(PRIVATE + '/install-authorization.json', authorizationBytes);
  const io = {
    assertRoot() {}, machineId: () => external.machineId, bootId: () => external.bootId,
    assertLock: () => external.hostLock, lockIdentity: () => external.hostLock,
    readTrusted(path, mode) {
      const f = files.get(path);
      if (!f) throw Object.assign(new Error('absent'), {code: 'ENOENT'});
      assert.equal(f.mode, mode); return f.bytes;
    },
    readOptionalTool: t => files.get(t.path)?.bytes ?? null,
    snapshot: () => state, assertExternalQuarantine() {},
    assertPreparedClosure() {},
    assertFreshInstall() {if (files.has(PRIVATE + '/install-operation.json') || [...files.keys()].some(p => p.startsWith(ROOT + '/'))) throw new Error('STATE_NOT_FRESH');},
    list: directory => [...files.keys()].filter(p => p.startsWith(directory + '/')).map(p => p.slice(directory.length + 1)),
    reserveInstall(originals) {events.push('reserve'); add(PRIVATE + '/install-operation.json', 'synthetic reservation'); retained.push(...originals);},
    publishClosed(manifest, closed) {events.push('closed'); add(ROOT + '/manifest.json', manifest); add(ROOT + '/closed.json', closed);},
    replaceTool(tool, bytes, previous) {
      assert.ok(files.has(ROOT + '/closed.json')); assert.equal(files.has(ROOT + '/released.json'), false);
      assert.deepEqual(files.get(tool.path)?.bytes ?? null, previous);
      events.push(tool.path); add(tool.path, bytes, tool.mode);
    },
    installReceipt(bytes) {events.push('receipt'); add(PRIVATE + '/install-receipt.json', bytes);},
  };
  const prepareRelease = () => {
    add(PRIVATE + '/release-external-authorization.json', externalBytes);
    io.assertFreshRelease = () => {
      if (files.has(PRIVATE + '/release-operation.json') || files.has(ROOT + '/released.json')) throw new Error('STATE_NOT_FRESH');
    };
    io.assertProfileContracts = () => {};
    io.assertCanonicalTrustedTime = () => ({syntheticTimeEvidence: 'unit port only, never host evidence'});
    io.reserveRelease = bytes => {events.push('reserve-release'); add(PRIVATE + '/release-operation.json', bytes);};
    io.publishReleaseEvidence = bytes => {events.push('release-evidence'); add(PRIVATE + '/release-evidence.json', bytes);};
    io.publishReleased = bytes => {events.push('released'); add(ROOT + '/released.json', bytes);};
    io.assertReleased = () => createBootstrapFenceGuard(io)('forward');
  };
  return {files, events, retained, io, authorization, authorizationBytes, manifest, manifestBytes, state, add, prepareRelease};
}

test('an installation proposal cannot authorize CLOSED publication or any tool write', () => {
  const bytes = encode({formatVersion: 1, kind: 'BOOTSTRAP_INSTALL_PROPOSAL'});
  const writes = [];
  const io = {assertRoot() {}, readTrusted(path) {
    assert.equal(path, PRIVATE + '/install-authorization.json');
    return bytes;
  }, write(...args) {writes.push(args);}};
  assert.throws(() => createBootstrapInstaller(io)({mode: 'apply', expectedAuthorization: hash(bytes)}), /AUTHORIZATION_INVALID/);
  assert.deepEqual(writes, []);
});

test('installation durably publishes CLOSED before the first tool replacement and never publishes RELEASED', () => {
  const f = fixture();
  const result = createBootstrapInstaller(f.io)({mode: 'apply', expectedAuthorization: hash(f.authorizationBytes)});
  assert.equal(result?.status, 'INSTALLED_CLOSED');
  assert.deepEqual(f.events, ['reserve', 'closed', ...f.manifest.files.map(t => t.path), 'receipt']);
  assert.equal(f.retained.length, f.manifest.files.length);
  for (const t of f.manifest.files) assert.equal(hash(f.files.get(t.path).bytes), t.sha256);
  assert.equal(f.files.has(ROOT + '/released.json'), false);
  assert.throws(() => createBootstrapFenceGuard(f.io)('forward'), /BOOTSTRAP_FENCE_CLOSED/);
  assert.deepEqual(f.io.snapshot(), f.state);
});

test('partial installation remains CLOSED across a new invocation without retry, repair or rollback', () => {
  const f = fixture(), replace = f.io.replaceTool;
  f.io.replaceTool = (...args) => {
    if (args[0].path === f.manifest.files[1].path) throw Object.assign(new Error('synthetic I/O failure'), {code: 'EIO'});
    replace(...args);
  };
  const options = {mode: 'apply', expectedAuthorization: hash(f.authorizationBytes)};
  assert.throws(() => createBootstrapInstaller(f.io)(options), /synthetic I\/O failure/);
  assert.deepEqual(f.events, ['reserve', 'closed', f.manifest.files[0].path]);
  const partial = new Map(f.files);
  assert.equal(f.files.has(PRIVATE + '/install-receipt.json'), false);
  assert.throws(() => createBootstrapFenceGuard(f.io)('forward'), /BOOTSTRAP_FENCE_CLOSED/);
  assert.throws(() => createBootstrapInstaller(f.io)(options), /STATE_NOT_FRESH/);
  assert.deepEqual(f.files, partial);
});

test('an ENOSPC failure before CLOSED and an interrupted reservation cannot write tools or authorize a second attempt', () => {
  for (const stage of ['reserveInstall', 'publishClosed']) {
    const f = fixture();
    f.io[stage] = () => {throw Object.assign(new Error('synthetic ENOSPC'), {code: 'ENOSPC'});};
    assert.throws(() => createBootstrapInstaller(f.io)({mode: 'apply', expectedAuthorization: hash(f.authorizationBytes)}), /ENOSPC/);
    assert.equal(f.events.some(e => e.startsWith('/usr/')), false);
    assert.equal(f.files.has(ROOT + '/released.json'), false);
    if (stage === 'publishClosed') {
      assert.throws(() => createBootstrapInstaller(f.io)({mode: 'apply', expectedAuthorization: hash(f.authorizationBytes)}), /STATE_NOT_FRESH/);
    }
  }
});

test('a dry-run verifies the entire prepared closure and owner bindings without a persistent write', () => {
  const f = fixture(), before = new Map(f.files);
  assert.equal(createBootstrapInstaller(f.io)({mode: 'dry-run', expectedAuthorization: hash(f.authorizationBytes)}).status, 'DRY_RUN_OK');
  assert.deepEqual(f.files, before); assert.deepEqual(f.events, []);
  f.add(PRIVATE + '/prepared/' + f.manifest.files.at(-1).sha256, 'changed');
  assert.throws(() => createBootstrapInstaller(f.io)({mode: 'apply', expectedAuthorization: hash(f.authorizationBytes)}), /PREPARED_TOOL_DRIFT/);
  assert.deepEqual(f.events, []);
});

test('reboot or live service/history drift cannot release CLOSED or continue installation', () => {
  for (const fault of ['boot', 'service', 'history']) {
    const f = fixture(), publish = f.io.publishClosed;
    f.io.publishClosed = (...args) => {
      publish(...args);
      if (fault === 'boot') f.io.bootId = () => '33333333-3333-4333-8333-333333333333';
      else f.state[fault === 'service' ? 'serviceIdentity' : 'historicalInventorySha256'] = '7'.repeat(64);
    };
    assert.throws(() => createBootstrapInstaller(f.io)({mode: 'apply', expectedAuthorization: hash(f.authorizationBytes)}), /BOOT_CHANGED|PRESERVED_STATE_DRIFT/);
    assert.deepEqual(f.events, ['reserve', 'closed']);
    assert.throws(() => createBootstrapFenceGuard(f.io)('forward'), /BOOTSTRAP_FENCE_CLOSED/);
  }
});

test('capture measures the prepared plan and old tools but returns only a proposal without writes', () => {
  const f = fixture(), before = new Map(f.files);
  const result = createBootstrapInstaller(f.io)({mode: 'capture', sourceSha: '8'.repeat(40), fenceId: ID});
  assert.equal(result.status, 'INSTALL_PROPOSAL');
  assert.equal(result.authority, 'READ_ONLY_NOT_AUTHORIZATION');
  assert.equal(result.record.kind, 'BOOTSTRAP_INSTALL_PROPOSAL');
  assert.equal(result.record.manifestSha256, hash(f.manifestBytes));
  assert.deepEqual(result.record.previousTools, f.authorization.previousTools);
  assert.deepEqual(f.files, before); assert.deepEqual(f.events, []);
});

test('release capture measures all checks but leaves CLOSED and never manufactures owner authorization', async () => {
  const {createBootstrapReleaser} = await import('./bootstrap-transition.mjs');
  const f = fixture();
  createBootstrapInstaller(f.io)({mode: 'apply', expectedAuthorization: hash(f.authorizationBytes)});
  f.prepareRelease();
  const before = new Map(f.files), events = [...f.events];
  const result = createBootstrapReleaser(f.io)({mode: 'capture'});
  assert.equal(result.status, 'RELEASE_PROPOSAL');
  assert.equal(result.authority, 'READ_ONLY_NOT_AUTHORIZATION');
  assert.equal(result.verification.record.kind, 'BOOTSTRAP_RELEASE_VERIFICATION');
  assert.equal(Object.keys(result.verification.record.checks).length, 8);
  assert.equal(Object.values(result.verification.record.checks).every(v => v === true), true);
  assert.deepEqual(f.files, before); assert.deepEqual(f.events, events);
  assert.throws(() => createBootstrapFenceGuard(f.io)('forward'), /BOOTSTRAP_FENCE_CLOSED/);
});

test('separate release authority publishes RELEASED last while attempts and disabled legacy paths remain guarded', async () => {
  const {createBootstrapReleaser} = await import('./bootstrap-transition.mjs');
  const f = fixture();
  createBootstrapInstaller(f.io)({mode: 'apply', expectedAuthorization: hash(f.authorizationBytes)});
  f.prepareRelease();
  const proposal = createBootstrapReleaser(f.io)({mode: 'capture'}), v = proposal.verification.record;
  f.add(ROOT + '/verification.json', encode(v));
  const authorization = encode({formatVersion: 1, kind: 'BOOTSTRAP_RELEASE_AUTHORIZATION',
    scope: 'ENABLE_APPROVAL_GATED_MANAGEMENT', fenceSha256: v.fenceSha256, manifestSha256: v.manifestSha256,
    profileSha256: v.profileSha256, verificationSha256: proposal.verificationSha256});
  f.add(ROOT + '/release-authorization.json', authorization);
  const result = createBootstrapReleaser(f.io)({mode: 'apply', expectedAuthorization: hash(authorization),
    expectedExternalAuthorization: proposal.evidence.externalAuthorizationSha256});
  assert.equal(result.status, 'RELEASED_APPROVAL_GATES_REMAIN');
  assert.deepEqual(f.events.slice(-3), ['reserve-release', 'release-evidence', 'released']);
  assert.equal(createBootstrapFenceGuard(f.io)('forward').state, 'RELEASED');
  assert.throws(() => createBootstrapFenceGuard(f.io)('deploy'), /ATTEMPT_REQUIRED/);
  for (const op of ['legacy-deploy', 'legacy-restore', 'rollback']) {
    assert.throws(() => createBootstrapFenceGuard(f.io)(op), /LEGACY_MUTATION_DISABLED/);
  }
});

test('an owner manifest cannot rewrite a content-addressed forward toolset during bootstrap', () => {
  const f = fixture(), path = '/usr/local/libexec/servora-med-forward-tools/' + 'f'.repeat(64) + '/forward-host.mjs';
  const bytes = Buffer.from('new synthetic immutable-toolset bytes\n');
  f.add(path, 'old synthetic immutable-toolset bytes\n', 0o644);
  f.add(PRIVATE + '/prepared/' + hash(bytes), bytes);
  f.manifest.files.push({path, mode: 0o644, sha256: hash(bytes)});
  f.manifest.files.sort((a, b) => a.path < b.path ? -1 : 1);
  const manifestBytes = encode(f.manifest); f.add(PRIVATE + '/manifest.json', manifestBytes);
  f.authorization.manifestSha256 = hash(manifestBytes);
  f.authorization.previousTools = f.manifest.files.map(t => ({path: t.path, mode: t.mode, sha256: hash(f.files.get(t.path).bytes)}));
  const auth = encode(f.authorization); f.add(PRIVATE + '/install-authorization.json', auth);
  const before = new Map(f.files);
  assert.throws(() => createBootstrapInstaller(f.io)({mode: 'apply', expectedAuthorization: hash(auth)}), /IMMUTABLE_TOOLSET_CHANGE/);
  assert.deepEqual(f.files, before); assert.deepEqual(f.events, []);
});

test('prefilled verification cannot bypass live profile or canonical time checks, and interrupted release refuses replay', async () => {
  const {createBootstrapReleaser} = await import('./bootstrap-transition.mjs');
  for (const fault of ['profile', 'time', 'after-reservation', 'evidence-publication']) {
    const f = fixture();
    createBootstrapInstaller(f.io)({mode: 'apply', expectedAuthorization: hash(f.authorizationBytes)});
    f.prepareRelease();
    const proposal = createBootstrapReleaser(f.io)({mode: 'capture'}), v = proposal.verification.record;
    f.add(ROOT + '/verification.json', encode(v));
    const auth = encode({formatVersion: 1, kind: 'BOOTSTRAP_RELEASE_AUTHORIZATION',
      scope: 'ENABLE_APPROVAL_GATED_MANAGEMENT', fenceSha256: v.fenceSha256,
      manifestSha256: v.manifestSha256, profileSha256: v.profileSha256,
      verificationSha256: proposal.verificationSha256});
    f.add(ROOT + '/release-authorization.json', auth);
    const options = {mode: 'apply', expectedAuthorization: hash(auth),
      expectedExternalAuthorization: proposal.evidence.externalAuthorizationSha256};
    const failure = () => {throw Object.assign(new Error('synthetic ' + fault + ' EIO'), {code: 'EIO'});};
    if (fault === 'profile') f.io.assertProfileContracts = failure;
    if (fault === 'time') f.io.assertCanonicalTrustedTime = failure;
    if (fault === 'after-reservation') {
      const reserve = f.io.reserveRelease;
      f.io.reserveRelease = bytes => {reserve(bytes); f.io.assertCanonicalTrustedTime = failure;};
    }
    if (fault === 'evidence-publication') f.io.publishReleaseEvidence = failure;
    assert.throws(() => createBootstrapReleaser(f.io)(options), /synthetic .* EIO/);
    assert.equal(f.files.has(ROOT + '/released.json'), false);
    assert.throws(() => createBootstrapFenceGuard(f.io)('forward'), /BOOTSTRAP_FENCE_CLOSED/);
    if (['after-reservation', 'evidence-publication'].includes(fault)) {
      const beforeRetry = new Map(f.files);
      assert.throws(() => createBootstrapReleaser(f.io)(options), /STATE_NOT_FRESH/);
      assert.deepEqual(f.files, beforeRetry);
    } else assert.equal(f.files.has(PRIVATE + '/release-operation.json'), false);
  }
});
