import assert from 'node:assert/strict';
import test from 'node:test';
import {createBootstrapFenceGuard, REQUIRED_MANAGEMENT_FILES} from '../scripts/bootstrap-fence.mjs';
import {fenceFixture, encode, hash, ROOT, ID} from './bootstrap-fence-fixture.mjs';

const fixture = () => fenceFixture(REQUIRED_MANAGEMENT_FILES);

test('a closed or absent fence denies every ordinary management operation without writing', () => {
  const f = fixture(), guard = createBootstrapFenceGuard(f.io);
  const before = JSON.stringify([...f.files]);
  for (const operation of ['deploy', 'postdeploy', 'forward-recovery', 'pre-migration-abort',
    'attempt-preflight', 'forward', 'emergency-handoff', 'preserve-authorization', 'adoption']) {
    assert.throws(() => guard(operation, ID), /BOOTSTRAP_FENCE_CLOSED/);
  }
  assert.equal(JSON.stringify([...f.files]), before);
  f.files.delete(ROOT + '/closed.json');
  assert.throws(() => guard('deploy', ID), /BOOTSTRAP_FENCE_UNREADABLE/);
});

test('process restart, a changed boot and elapsed time cannot release a persistent closed fence', () => {
  const f = fixture();
  for (let boot = 0; boot < 3; boot++) {
    const guard = createBootstrapFenceGuard({...f.io, bootId: () => String(boot), now: () => 9e15});
    assert.throws(() => guard('deploy', ID), /BOOTSTRAP_FENCE_CLOSED/);
  }
});

test('release needs a separate owner authorization, verified closure and unchanged profile', () => {
  const f = fixture(), guard = createBootstrapFenceGuard(f.io);
  f.releaseFence();
  assert.equal(guard('deploy', ID).state, 'RELEASED');
  f.files.delete(ROOT + '/release-authorization.json');
  assert.throws(() => guard('deploy', ID), /BOOTSTRAP_FENCE_UNREADABLE/);
  f.releaseFence();
  f.add('/var/lib/servora-med/deploy/profile.json', 'different profile\n');
  assert.throws(() => guard('deploy', ID), /BOOTSTRAP_FENCE_PROFILE_DRIFT/);
});

test('RELEASED never opens attempt-less deploy, postdeploy, rollback, restore or legacy deploy', () => {
  const f = fixture(), guard = createBootstrapFenceGuard(f.io);
  f.releaseFence();
  for (const operation of ['deploy', 'postdeploy', 'forward-recovery', 'pre-migration-abort', 'attempt-preflight']) {
    for (const id of ['', undefined, 'not-a-uuid']) {
      assert.throws(() => guard(operation, id), /BOOTSTRAP_FENCE_ATTEMPT_REQUIRED/);
    }
    assert.equal(guard(operation, ID).state, 'RELEASED');
  }
  for (const operation of ['legacy-deploy', 'rollback', 'legacy-restore']) {
    assert.throws(() => guard(operation, ID), /BOOTSTRAP_FENCE_LEGACY_MUTATION_DISABLED/);
  }
  assert.throws(() => guard('arbitrary-operation', ID), /BOOTSTRAP_FENCE_OPERATION_INVALID/);
});

test('unknown, torn, foreign or rehashed invalid records fail closed without repair', () => {
  for (const bytes of ['{', '{}\n', encode({...fixture().fence, kind: 'RELEASED'}),
    encode({...fixture().fence, unexpected: true})]) {
    const f = fixture();
    f.add(ROOT + '/closed.json', bytes);
    assert.throws(() => createBootstrapFenceGuard(f.io)('deploy', ID), /BOOTSTRAP_FENCE_RECORD_INVALID/);
    assert.deepEqual(f.files.get(ROOT + '/closed.json').bytes, Buffer.from(bytes));
  }
});

test('EACCES, ENOTDIR, EIO and ENOSPC while reading are failures, never absence or release', () => {
  for (const code of ['EACCES', 'ENOTDIR', 'EIO', 'ENOSPC']) {
    const f = fixture(); f.releaseFence(); f.faults.set(ROOT + '/released.json', code);
    assert.throws(() => createBootstrapFenceGuard(f.io)('deploy', ID), /BOOTSTRAP_FENCE_UNREADABLE/);
  }
});

test('partially installed, omitted, duplicate, reordered or changed tools cannot be released', () => {
  for (const change of ['missing', 'bytes', 'mode', 'omitted', 'duplicate', 'reordered']) {
    const f = fixture(); f.releaseFence();
    const first = REQUIRED_MANAGEMENT_FILES[0];
    if (change === 'missing') f.files.delete(first.path);
    if (change === 'bytes') f.add(first.path, 'partial replacement\n', first.mode);
    if (change === 'mode') f.files.get(first.path).mode = 0o666;
    if (['omitted', 'duplicate', 'reordered'].includes(change)) {
      if (change === 'omitted') f.manifest.files.pop();
      if (change === 'duplicate') f.manifest.files.push(f.manifest.files[0]);
      if (change === 'reordered') f.manifest.files.reverse();
      f.add(ROOT + '/manifest.json', encode(f.manifest));
    }
    assert.throws(() => createBootstrapFenceGuard(f.io)('deploy', ID), /BOOTSTRAP_FENCE_/);
  }
});

test('a valid hash is insufficient when release verification or owner scope is wrong', () => {
  for (const variant of ['verification', 'scope', 'machine', 'fence', 'digest']) {
    const f = fixture(); f.releaseFence();
    if (variant === 'verification') {
      f.verification.checks.canonicalTrustedTime = false;
      f.add(ROOT + '/verification.json', encode(f.verification));
    }
    if (variant === 'scope') {
      f.authorization.scope = 'DEPLOY_ANYTHING';
      f.add(ROOT + '/release-authorization.json', encode(f.authorization));
    }
    if (variant === 'machine') f.io.machineId = () => '2'.repeat(32);
    if (variant === 'fence') f.release.fenceSha256 = '0'.repeat(64);
    if (variant === 'digest') f.release.verificationSha256 = hash('other');
    f.add(ROOT + '/released.json', encode(f.release));
    assert.throws(() => createBootstrapFenceGuard(f.io)('deploy', ID), /BOOTSTRAP_FENCE_/);
  }
});

test('unknown publication residue remains closed and is never removed', () => {
  const f = fixture(); f.releaseFence();
  f.add(ROOT + '/.released.tmp', 'torn publication');
  assert.throws(() => createBootstrapFenceGuard(f.io)('deploy', ID), /BOOTSTRAP_FENCE_DIRECTORY_INVALID/);
  assert.equal(f.files.get(ROOT + '/.released.tmp').bytes.toString(), 'torn publication');
});

test('RELEASED cannot reclaim a different host.lock inode', () => {
  const f = fixture(); f.releaseFence();
  f.io.lockIdentity = () => ({device: '1', inode: '999'});
  assert.throws(() => createBootstrapFenceGuard(f.io)('deploy', ID), /BOOTSTRAP_FENCE_LOCK_UNTRUSTED/);
});
