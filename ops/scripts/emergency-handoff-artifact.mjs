/**
 * Content-addressed tool artifact contract for the emergency handoff.
 *
 * The installed artifact is a root-owned directory with a fixed file list and
 * a sealed manifest. Its `artifactSha256` is recomputed from the actual bytes
 * and file modes, and the root authorization binds that value. A drifted,
 * extra, symlinked or group-writable artifact never executes.
 */
import {createHash} from 'node:crypto';
import {lstatSync, readdirSync, readFileSync, writeFileSync, openSync, closeSync, fsyncSync} from 'node:fs';
import {join} from 'node:path';

export const EMERGENCY_ARTIFACT_KIND = 'EMERGENCY_HANDOFF_TOOL_ARTIFACT';
export const EMERGENCY_ARTIFACT_ENTRIES = Object.freeze([
  Object.freeze({path: 'emergency-handoff-artifact.mjs', mode: 0o644}),
  Object.freeze({path: 'emergency-handoff.mjs', mode: 0o644}),
  Object.freeze({path: 'emergency-handoff-host.mjs', mode: 0o755}),
  Object.freeze({path: 'issue-emergency-handoff.mjs', mode: 0o755}),
]);
const MANIFEST = 'manifest.json';
const MANIFEST_MODE = 0o644;

const fail = code => { throw new Error(code); };
const digest = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value) + '\n';

function trustedDirectory(path, uid, gid) {
  let info;
  try { info = lstatSync(path); } catch { fail('EMERGENCY_ARTIFACT_INVALID'); }
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid
    || info.gid !== gid || (info.mode & 0o022) !== 0) {
    fail('EMERGENCY_ARTIFACT_INVALID');
  }
}

function trustedEntry(path, uid, gid, mode) {
  let info;
  try { info = lstatSync(path); } catch { fail('EMERGENCY_ARTIFACT_INVALID'); }
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== uid || info.gid !== gid
    || info.nlink !== 1 || (info.mode & 0o7777) !== mode || info.size > 1024 * 1024) {
    fail('EMERGENCY_ARTIFACT_INVALID');
  }
  return readFileSync(path);
}

/** Recomputes the manifest from bytes and modes; no manifest file is required. */
export function artifactManifest(root, {uid = 0, gid = uid} = {}) {
  trustedDirectory(root, uid, gid);
  const entries = readdirSync(root).filter(name => name !== MANIFEST).sort();
  const declared = [...EMERGENCY_ARTIFACT_ENTRIES].sort((left, right) => left.path < right.path ? -1 : 1);
  const expected = declared.map(entry => entry.path);
  if (entries.length !== expected.length || expected.some((name, index) => entries[index] !== name)) {
    fail('EMERGENCY_ARTIFACT_INVALID');
  }
  const files = declared.map(entry => {
    const bytes = trustedEntry(join(root, entry.path), uid, gid, entry.mode);
    return {path: entry.path, mode: entry.mode, sha256: digest(bytes)};
  });
  const body = {formatVersion: 1, kind: EMERGENCY_ARTIFACT_KIND, files};
  return {...body, artifactSha256: digest(canonical(body))};
}

/** Writes the sealed manifest into an already assembled artifact directory. */
export function writeArtifactManifest(root, {uid = 0, gid = uid} = {}) {
  const manifest = artifactManifest(root, {uid, gid});
  const file = join(root, MANIFEST);
  const fd = openSync(file, 'wx', MANIFEST_MODE);
  try {
    writeFileSync(fd, canonical(manifest));
    fsyncSync(fd);
  } finally { closeSync(fd); }
  return manifest;
}

/**
 * Verifies the installed artifact against its sealed manifest. Returns the
 * recomputed manifest only when every byte, mode and ownership check passes.
 */
export function verifyInstalledArtifact(root, {uid = 0, gid = uid} = {}) {
  trustedDirectory(root, uid, gid);
  const manifestPath = join(root, MANIFEST);
  const bytes = trustedEntry(manifestPath, uid, gid, MANIFEST_MODE);
  let sealed;
  try { sealed = JSON.parse(bytes.toString('utf8')); } catch { fail('EMERGENCY_ARTIFACT_INVALID'); }
  if (canonical(sealed) !== bytes.toString('utf8')
    || sealed?.formatVersion !== 1 || sealed?.kind !== EMERGENCY_ARTIFACT_KIND
    || !Array.isArray(sealed.files) || typeof sealed.artifactSha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(sealed.artifactSha256)) {
    fail('EMERGENCY_ARTIFACT_INVALID');
  }
  const {artifactSha256: _sealedHash, ...body} = sealed;
  if (digest(canonical(body)) !== sealed.artifactSha256) fail('EMERGENCY_ARTIFACT_INVALID');
  const actual = artifactManifest(root, {uid, gid});
  if (actual.artifactSha256 !== sealed.artifactSha256) fail('EMERGENCY_ARTIFACT_DRIFT');
  if (JSON.stringify(actual) !== JSON.stringify(sealed)) fail('EMERGENCY_ARTIFACT_DRIFT');
  return actual;
}
