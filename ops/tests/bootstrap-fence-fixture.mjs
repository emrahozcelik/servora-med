// Synthetic port only. Production always uses the fixed Linux paths and UID 0.
import {createHash} from 'node:crypto';

export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const encode = record => Buffer.from(JSON.stringify({record, sha256: hash(JSON.stringify(record) + '\n')}) + '\n');
export const ROOT = '/var/lib/servora-med/deploy/bootstrap';
export const LIB = '/usr/local/libexec/servora-med';
export const ID = '11111111-1111-4111-8111-111111111111';

export function fenceFixture(requiredFiles) {
  const files = new Map(), reads = [], faults = new Map();
  const add = (path, data, mode = 0o600) => files.set(path, {bytes: Buffer.from(data), mode});
  const tools = requiredFiles.map(({path, mode}) => {
    const bytes = Buffer.from('synthetic ' + path + '\n');
    add(path, bytes, mode);
    return {path, mode, sha256: hash(bytes)};
  });
  const manifest = {formatVersion: 1, kind: 'BOOTSTRAP_MANAGEMENT_MANIFEST', files: tools};
  const fence = {formatVersion: 1, kind: 'BOOTSTRAP_FENCE_CLOSED', fenceId: ID,
    machineId: '1'.repeat(32), manifestSha256: hash(encode(manifest)), hostLock: {device: '1', inode: '2'}};
  const profile = Buffer.from('synthetic profile\n');
  add('/var/lib/servora-med/deploy/profile.json', profile);
  const verification = {formatVersion: 1, kind: 'BOOTSTRAP_RELEASE_VERIFICATION',
    fenceSha256: hash(encode(fence)), manifestSha256: hash(encode(manifest)), profileSha256: hash(profile),
    checks: {toolClosure: true, mutationCoverage: true, delegatedAccess: true,
      noPendingOperation: true, historicalPreservation: true, canonicalTrustedTime: true,
      profileContracts: true, serviceUnchanged: true}};
  const authorization = {formatVersion: 1, kind: 'BOOTSTRAP_RELEASE_AUTHORIZATION',
    fenceSha256: hash(encode(fence)), manifestSha256: hash(encode(manifest)),
    profileSha256: hash(profile), verificationSha256: hash(encode(verification)),
    scope: 'ENABLE_APPROVAL_GATED_MANAGEMENT'};
  const release = {formatVersion: 1, kind: 'BOOTSTRAP_FENCE_RELEASED',
    fenceSha256: hash(encode(fence)), authorizationSha256: hash(encode(authorization)),
    verificationSha256: hash(encode(verification))};
  add(ROOT + '/manifest.json', encode(manifest));
  add(ROOT + '/closed.json', encode(fence));
  const releaseFence = () => {
    add(ROOT + '/verification.json', encode(verification));
    add(ROOT + '/release-authorization.json', encode(authorization));
    add(ROOT + '/released.json', encode(release));
  };
  const io = {
    assertRoot: () => {},
    machineId: () => '1'.repeat(32),
    lockIdentity: () => ({device: '1', inode: '2'}),
    list: directory => [...files.keys()].filter(path => path.startsWith(directory + '/')).map(path => path.slice(directory.length + 1)),
    readTrusted: (path, mode) => {
      reads.push(path);
      if (faults.has(path)) throw Object.assign(new Error('private details'), {code: faults.get(path)});
      const file = files.get(path);
      if (!file) throw Object.assign(new Error('private path'), {code: 'ENOENT'});
      if (file.mode !== mode) throw new Error('BOOTSTRAP_FENCE_FILE_UNTRUSTED');
      return file.bytes;
    },
  };
  return {io, files, reads, faults, add, manifest, fence, release, verification, authorization, releaseFence};
}
