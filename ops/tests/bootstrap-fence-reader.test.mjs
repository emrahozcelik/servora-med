import assert from 'node:assert/strict';
import test from 'node:test';
import {constants} from 'node:fs';
import {readBootstrapTrustedFile} from '../scripts/bootstrap-fence.mjs';

const file = '/var/lib/servora-med/deploy/bootstrap/closed.json';
function fixture() {
  const bytes = Buffer.from('synthetic bytes');
  const info = {uid: 0n, gid: 0n, mode: 0o100600n, nlink: 1n, size: BigInt(bytes.length),
    dev: 1n, ino: 2n, mtimeNs: 3n, ctimeNs: 4n,
    isFile: () => true, isSymbolicLink: () => false};
  const directory = {uid: 0n, gid: 0n, mode: 0o40700n,
    isDirectory: () => true, isSymbolicLink: () => false};
  const calls = [];
  const io = {
    lstatSync: path => path === file ? {...info} : {...directory},
    openSync: (path, flags) => { calls.push(['open', path, flags]); return 9; },
    fstatSync: () => ({...info}), readFileSync: () => bytes,
    closeSync: fd => calls.push(['close', fd]),
  };
  return {io, info, directory, bytes, calls};
}

test('trusted reader opens no-follow/nonblocking and closes a descriptor after a stable bounded read', () => {
  const f = fixture();
  assert.deepEqual(readBootstrapTrustedFile(file, 0o600, f.io), f.bytes);
  assert.ok(f.calls[0][2] & constants.O_NOFOLLOW);
  assert.ok(f.calls[0][2] & constants.O_NONBLOCK);
  assert.deepEqual(f.calls.at(-1), ['close', 9]);
});

test('owner, group, mode, type, links, size and parent trust fail before opening', () => {
  for (const change of [
    {uid: 1n}, {gid: 1n}, {mode: 0o100644n}, {nlink: 2n},
    {isFile: () => false}, {isSymbolicLink: () => true}, {size: 5n * 1024n * 1024n},
  ]) {
    const f = fixture(); Object.assign(f.info, change);
    assert.throws(() => readBootstrapTrustedFile(file, 0o600, f.io), /FILE_UNTRUSTED/);
    assert.deepEqual(f.calls, []);
  }
  for (const change of [{uid: 1n}, {mode: 0o40755n}, {isDirectory: () => false}, {isSymbolicLink: () => true}]) {
    const f = fixture(); Object.assign(f.directory, change);
    assert.throws(() => readBootstrapTrustedFile(file, 0o600, f.io), /PATH_UNTRUSTED/);
    assert.deepEqual(f.calls, []);
  }
});

test('EACCES, ENOTDIR and EIO at metadata/open/read are opaque failures; open descriptors close', () => {
  for (const method of ['lstatSync', 'openSync', 'readFileSync']) {
    for (const code of ['EACCES', 'ENOTDIR', 'EIO']) {
      const f = fixture();
      f.io[method] = () => { throw Object.assign(new Error('secret details'), {code}); };
      assert.throws(() => readBootstrapTrustedFile(file, 0o600, f.io), /^Error: BOOTSTRAP_FENCE_UNREADABLE$/);
      if (method === 'readFileSync') assert.deepEqual(f.calls.at(-1), ['close', 9]);
    }
  }
});

test('changed inode, bytes or metadata during a descriptor read never authorize a record', () => {
  for (const change of ['inode', 'metadata', 'length']) {
    const f = fixture(); let reads = 0;
    if (change === 'inode') f.io.fstatSync = () => ({...f.info, ino: 99n});
    if (change === 'metadata') f.io.fstatSync = () => ({...f.info, ctimeNs: ++reads > 1 ? 99n : 4n});
    if (change === 'length') f.io.readFileSync = () => Buffer.from('short');
    assert.throws(() => readBootstrapTrustedFile(file, 0o600, f.io), /FILE_(?:UNTRUSTED|CHANGED)/);
    assert.deepEqual(f.calls.at(-1), ['close', 9]);
  }
});
