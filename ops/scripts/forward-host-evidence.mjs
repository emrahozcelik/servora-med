// Forward-only host evidence validation.
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {chmodSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync,
  realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {elapsedTime, validateCurrentTimeEvidence} from './trusted-time.mjs';
import {FORWARD_OBSERVATION_SECONDS, FORWARD_OBSERVATION_MIN_SAMPLES} from './forward-transition.mjs';
export const digest = value => createHash('sha256').update(value).digest('hex');
export const seal = body => ({...body, hash: digest(JSON.stringify(body) + '\n')});
const fail = code => { throw new Error(code); };
// Canonical staging excludes these two sidecars at any depth.
const SIDECARS = ['.servora-release-artifact.sha256', '.servora-release-content.sha256'];

/** Reproduce `release_content_manifest()` from deploy-production-host.sh:
 * `f ./path <sha256>`, `l ./path <target>`, `d ./path`, LC_ALL=C sorted by
 * whole line. Only regular single-link files, directories and in-root symlinks
 * are accepted; anything else is untrusted. */
export function releaseContentManifest(root) {
  const base = realpathSync(root), entries = [];
  const walk = relative => {
    const path = join(root, relative), info = lstatSync(path);
    const name = relative === '.' ? '.' : './' + relative;
    if (info.isSymbolicLink()) {
      if (!realpathSync(path).startsWith(base + '/')) fail('FORWARD_HOST_ARCHIVE_UNTRUSTED');
      entries.push('l ' + name + ' ' + readlinkSync(path));
    } else if (info.isDirectory()) {
      if (relative !== '.') entries.push('d ' + name);
      for (const child of readdirSync(path)) {
        if (SIDECARS.includes(child)) continue;
        if (/[\r\n]/.test(child)) fail('FORWARD_HOST_ARCHIVE_UNTRUSTED');
        walk(relative === '.' ? child : relative + '/' + child);
      }
    } else if (info.isFile() && info.nlink === 1) entries.push('f ' + name + ' ' + digest(readFileSync(path)));
    else fail('FORWARD_HOST_ARCHIVE_UNTRUSTED');
  };
  walk('.');
  entries.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return entries.join('\n') + '\n';
}

/** Bind the retained, grant-hashed release archive to the installed release by
 * CONTENT, not by tar metadata. Canonical staging extracts with
 * `--no-same-owner --no-same-permissions` and then applies
 * `set_release_permissions`, so uid/gid/mode legitimately differ from the
 * archive. The archive is extracted into a private root-only directory and
 * compared against the release's own `release_content_manifest()` output.
 * Release code is never executed and the temporary tree is always removed. */
export function verifyReleaseArchive({archive, expectedManifest, tar = '/usr/bin/tar',
  run = (file, args) => execFileSync(file, args, {timeout: 120000, maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'], env: {PATH: '/usr/local/bin:/usr/bin:/bin', LC_ALL: 'C'}})}) {
  // Reject traversal names before any root extraction. GNU tar also refuses
  // `..` members, but the archive contract is checked here explicitly.
  const names = run(tar, ['--list', '--gzip', '--file', archive]).toString().split('\n').filter(Boolean);
  for (const name of names) {
    if (/[\r\n]/.test(name) || name.startsWith('/') || name.replace(/^\.\//, '').split('/').includes('..')) {
      fail('FORWARD_HOST_ARCHIVE_UNTRUSTED');
    }
  }
  const root = mkdtempSync(join(tmpdir(), 'servora-release-verify-'));
  try {
    chmodSync(root, 0o700);
    if (readdirSync(root).length) fail('FORWARD_HOST_ARCHIVE_UNTRUSTED');
    run(tar, ['--extract', '--gzip', '--file', archive, '--directory', root,
      '--no-same-owner', '--no-same-permissions', '--no-overwrite-dir']);
    if (releaseContentManifest(root) !== expectedManifest) fail('FORWARD_HOST_RELEASE_CONTENT_DRIFT');
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
  return true;
}

/** Match the existing forward dump bound, only for the sealed parent's two
 * receipts. The supplied protected reader retains every metadata check. */
export function verifyForwardParentBackups(backups, read) {
  for (const kind of ['pre', 'post']) {
    if (digest(read(kind, {limit: 1024 * 1024 * 1024})) !== backups[kind + 'Sha256']) fail('FORWARD_HOST_PARENT_BACKUP_DRIFT');
  }
}

/** Uses the repository's required-checks.txt, supplied by the sealed adapter.
 * This verifies retained evidence; it never starts CI. */
export function verifyForwardCI(m, target, read, required) {
  if (!m || m.schemaVersion !== 2 || m.sha !== target.releaseSha || m.tree !== target.treeSha
    || m.result !== 'PASS' || m.provenance !== 'local-operator-attested'
    || !m.builder?.os || !m.builder?.arch || !m.builder?.node
    || !Array.isArray(required) || required.length === 0 || new Set(required).size !== required.length
    || !Array.isArray(m.checks) || m.checks.length !== required.length
    || new Set(m.checks.map(c => c.id)).size !== required.length
    || m.checks.some(c => !required.includes(c.id) || c.result !== 'PASS'
      || !/^logs\/[A-Za-z0-9_.-]+\.log$/.test(c.log) || !/^[a-f0-9]{64}$/.test(c.sha256))
    || m.cleanup?.result !== 'PASS' || !['remove', 'keep-containers'].includes(m.cleanup.mode)) fail('FORWARD_HOST_CI_INVALID');
  for (const c of m.checks) if (digest(read(c.log)) !== c.sha256) fail('FORWARD_HOST_CI_INVALID');
  for (const [key, path] of [['log', 'logs/aux/cleanup.log'], ['status', 'logs/aux/cleanup.status']]) {
    if (m.cleanup[key]?.path !== path || digest(read(path)) !== m.cleanup[key].sha256
      || (key === 'status' && read(path).toString() !== 'PASS\n')) fail('FORWARD_HOST_CI_INVALID');
  }
  const detail = m.checks.find(c => c.id === 'linux-compat')?.detail;
  if (!detail || detail.nativeBinaries !== 0 || detail.osRestricted !== 0 || detail.cpuRestricted !== 0
    || detail.linuxAmd64?.result !== 'pass' || !detail.linuxAmd64.productionPackages) fail('FORWARD_HOST_CI_INVALID');
  return true;
}

/** CI check logs are genuine test output and legitimately exceed the default
 * 4 MiB protected-file bound. Only that exact entry class gets a larger,
 * explicit bound; manifest, cleanup evidence and every other protected file
 * keep the default. */
export const MAX_FORWARD_CI_LOG_BYTES = 32 * 1024 * 1024;
const CI_CHECK_LOG = /^logs\/[A-Za-z0-9_.-]+\.log$/;
export function forwardCIEntryOptions(name) {
  return CI_CHECK_LOG.test(name) ? {limit: MAX_FORWARD_CI_LOG_BYTES} : {};
}

/** Verifies the retained manifest and its exact top-level log set. The caller
 * supplies the protected reader so path, ownership and mode checks stay in
 * the host adapter. */
export function verifyForwardCIPackage({manifestBytes, target, required, read, actualLogs}) {
  if (digest(manifestBytes) !== target.ciManifestSha256) fail('FORWARD_HOST_CI_INVALID');
  const manifest = JSON.parse(manifestBytes);
  verifyForwardCI(manifest, target, read, required);
  if (!Array.isArray(actualLogs)
    || JSON.stringify(actualLogs) !== JSON.stringify(manifest.checks.map(c => c.log.slice(5)).sort())) {
    fail('FORWARD_HOST_CI_INVALID');
  }
  return manifest;
}

export function verifyObservationProof(proof, expected) {
  const {hash, ...body} = proof ?? {};
  if (hash !== seal(body).hash || body.kind !== 'FORWARD_HOST_OBSERVATION'
    || body.attemptId !== expected.attemptId || body.authorizationSha256 !== expected.authorizationSha256
    || body.anchor !== expected.anchor || body.backupReceiptSha256 !== expected.backupReceiptSha256
    || !Array.isArray(body.samples) || body.samples.length < FORWARD_OBSERVATION_MIN_SAMPLES || body.samples.length > 128
    || JSON.stringify(body.identity) !== JSON.stringify(expected.identity)) fail('FORWARD_HOST_OBSERVATION_INVALID');
  let previous = null;
  for (const [index, sample] of body.samples.entries()) {
    const {hash: sampleHash, ...sampleBody} = sample;
    validateCurrentTimeEvidence(sample.time);
    if (sampleHash !== seal(sampleBody).hash || sample.index !== index || sample.previousHash !== previous?.hash && !(index === 0 && sample.previousHash === null)
      || JSON.stringify(sample.identity) !== JSON.stringify(body.identity)
      || sample.time.bootId !== body.identity.bootId || sample.health !== true || sample.backupHealth !== true
      || sample.releaseSha !== expected.releaseSha || sample.schemaHead !== expected.schemaHead
      || !/^[0-9]{1,24}$/.test(sample.monotonicNs)) fail('FORWARD_HOST_OBSERVATION_INVALID');
    if (previous) {
      const gap = elapsedTime(previous.time, sample.time);
      const hr = Number(BigInt(sample.monotonicNs) - BigInt(previous.monotonicNs)) / 1e6;
      if (gap.status !== 'KNOWN' || hr < 0 || hr > 35_000 || hr + 1 < gap.lowerMs || hr - 1 > gap.upperMs) fail('FORWARD_HOST_OBSERVATION_INTERRUPTED');
    }
    previous = sample;
  }
  const first = body.samples[0], last = body.samples.at(-1);
  const interval = elapsedTime(first.time, last.time);
  const hr = Number(BigInt(last.monotonicNs) - BigInt(first.monotonicNs)) / 1e6;
  const recent = elapsedTime(last.time, expected.now);
  const startUTC = first.time.wallAtUTC.replace(/\.\d{3}Z$/, 'Z');
  const endUTC = last.time.wallAtUTC.replace(/\.\d{3}Z$/, 'Z');
  const seconds = (Date.parse(endUTC) - Date.parse(startUTC)) / 1000;
  if (interval.status !== 'KNOWN' || Math.min(hr, interval.lowerMs) < FORWARD_OBSERVATION_SECONDS * 1000 || seconds < FORWARD_OBSERVATION_SECONDS
    || hr + 1 < interval.lowerMs || hr - 1 > interval.upperMs
    || recent.status !== 'KNOWN' || recent.upperMs > 60_000) fail('FORWARD_HOST_OBSERVATION_TOO_SHORT_OR_STALE');
  return {startedAtUTC: startUTC, completedAtUTC: endUTC, seconds, samples: body.samples.length,
    pid: body.identity.pid, pidStartTime: body.identity.startTime, bootId: body.identity.bootId,
    endPid: expected.identity.pid, endStartTime: expected.identity.startTime, endBootId: expected.identity.bootId};
}
