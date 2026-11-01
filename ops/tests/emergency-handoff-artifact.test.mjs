import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync, readFileSync, unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  EMERGENCY_ARTIFACT_ENTRIES,
  artifactManifest,
  writeArtifactManifest,
  verifyInstalledArtifact,
} from '../scripts/emergency-handoff-artifact.mjs';

const uid = process.getuid();
const gid = process.getgid();
function validArtifact() {
  const root = mkdtempSync(join(tmpdir(), 'eh-artifact-'));
  mkdirSync(root, {recursive: true, mode: 0o755});
  for (const entry of EMERGENCY_ARTIFACT_ENTRIES) {
    writeFileSync(join(root, entry.path), `// ${entry.path}\nexport const x = 1;\n`, {mode: entry.mode});
    chmodSync(join(root, entry.path), entry.mode);
  }
  writeArtifactManifest(root, {uid, gid});
  return root;
}

test('ART-01: a root-shaped artifact verifies and has a deterministic content address', () => {
  const root = validArtifact();
  const first = verifyInstalledArtifact(root, {uid, gid});
  const second = verifyInstalledArtifact(root, {uid, gid});
  assert.match(first.artifactSha256, /^[0-9a-f]{64}$/);
  assert.equal(first.artifactSha256, second.artifactSha256);
  assert.equal(first.files.length, EMERGENCY_ARTIFACT_ENTRIES.length);
  assert.deepEqual(first.files.map(file => file.path), [...EMERGENCY_ARTIFACT_ENTRIES.map(file => file.path)].sort());
});

test('ART-02: any tool byte drift is rejected', () => {
  const root = validArtifact();
  writeFileSync(join(root, 'emergency-handoff.mjs'), '// changed\n');
  assert.throws(() => verifyInstalledArtifact(root, {uid, gid}), /EMERGENCY_ARTIFACT_DRIFT/);
});

test('ART-03: an unexpected file or directory is rejected', () => {
  const root = validArtifact();
  writeFileSync(join(root, 'extra.mjs'), '// extra\n', {mode: 0o644});
  assert.throws(() => verifyInstalledArtifact(root, {uid, gid}), /EMERGENCY_ARTIFACT_INVALID/);
  unlinkSync(join(root, 'extra.mjs'));
  mkdirSync(join(root, 'nested'), {mode: 0o755});
  assert.throws(() => verifyInstalledArtifact(root, {uid, gid}), /EMERGENCY_ARTIFACT_INVALID/);
});

test('ART-04: a mode change or symlinked entry is rejected', () => {
  let root = validArtifact();
  chmodSync(join(root, 'emergency-handoff-host.mjs'), 0o644);
  assert.throws(() => verifyInstalledArtifact(root, {uid, gid}), /EMERGENCY_ARTIFACT_INVALID/);
  root = validArtifact();
  unlinkSync(join(root, 'issue-emergency-handoff.mjs'));
  symlinkSync('/bin/sh', join(root, 'issue-emergency-handoff.mjs'));
  assert.throws(() => verifyInstalledArtifact(root, {uid, gid}), /EMERGENCY_ARTIFACT_INVALID/);
});

test('ART-05: manifest tampering or a missing tool file is rejected', () => {
  let root = validArtifact();
  const manifestPath = join(root, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.artifactSha256 = '0'.repeat(64);
  writeFileSync(manifestPath, JSON.stringify(manifest) + '\n', {mode: 0o644});
  assert.throws(() => verifyInstalledArtifact(root, {uid, gid}), /EMERGENCY_ARTIFACT_INVALID/);
  root = validArtifact();
  unlinkSync(join(root, 'emergency-handoff.mjs'));
  assert.throws(() => verifyInstalledArtifact(root, {uid, gid}), /EMERGENCY_ARTIFACT_INVALID/);
});

test('ART-06: the manifest records exact modes and never accepts a group-writable root', () => {
  const root = validArtifact();
  const manifest = artifactManifest(root, {uid, gid});
  const host = manifest.files.find(file => file.path === 'emergency-handoff-host.mjs');
  assert.equal(host.mode, 0o755);
  chmodSync(root, 0o775);
  assert.throws(() => verifyInstalledArtifact(root, {uid, gid}), /EMERGENCY_ARTIFACT_INVALID/);
});
