import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, writeFileSync, chownSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readRootApproval, appendRootCheckpoint, readRootCheckpoint, readLatestCheckpoint } from '../scripts/deployment-attempt.mjs';

assert.equal(process.getuid(), 0);
assert.equal(hostname(), 'lima-servora-r4-20261012');

test('rejects a deployment-user-owned approval at the fixed host path', () => {
  const folder = '/var/lib/servora-med/deploy/approvals';
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const id = '22222222-2222-4222-8222-222222222222';
  const file = `${folder}/${id}.json`;
  writeFileSync(file, '{}\n', { mode: 0o600 });
  const uid = Number(execFileSync('id', ['-u', 'servora-deploy'], { encoding: 'utf8' }).trim());
  chownSync(file, uid, 0);
  try { assert.throws(() => readRootApproval(id), /ATTEMPT_FILE_UNTRUSTED/); }
  finally { chownSync(file, 0, 0); }
});

test('resume reads the complete journal chain and refuses a missing intermediate checkpoint', () => {
  const id = randomUUID();
  const first = appendRootCheckpoint(id, { attemptId: id, sequence: 0, previousHash: null, phase: 'ADMITTED' });
  const second = appendRootCheckpoint(id, { attemptId: id, sequence: 1, previousHash: first.sha256, phase: 'BACKED_UP' });
  assert.deepEqual(readLatestCheckpoint(id), second);
  execFileSync('mv', [`/var/lib/servora-med/deploy/attempts/${id}/0000.json`, `/var/lib/servora-med/deploy/attempts/${id}/missing-first.json`]);
  assert.throws(() => readLatestCheckpoint(id), /ATTEMPT_CHECKPOINT_CHAIN_INVALID/);
});

test('durably appends a checkpoint and rejects replacement of an existing sequence', () => {
  const id = randomUUID();
  const record = { attemptId: id, sequence: 0, previousHash: null, phase: 'APPROVED' };
  const checkpoint = appendRootCheckpoint(id, record);
  assert.deepEqual(readRootCheckpoint(id, 0), checkpoint);
  const before = readFileSync(`/var/lib/servora-med/deploy/attempts/${id}/0000.json`);
  assert.throws(() => appendRootCheckpoint(id, { ...record, phase: 'ACCEPTED' }),
    /ATTEMPT_CHECKPOINT_EXISTS/);
  assert.deepEqual(readFileSync(`/var/lib/servora-med/deploy/attempts/${id}/0000.json`), before);
});
