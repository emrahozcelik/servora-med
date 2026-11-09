import assert from 'node:assert/strict';
import test from 'node:test';
import { githubCiProof } from '../scripts/github-ci-evidence.mjs';

const sha = 'a'.repeat(40);
const runId = 123456;
const job = (name, databaseId) => ({ name, databaseId, status: 'completed', conclusion: 'success' });
const good = () => ({
  databaseId: runId, workflowName: 'CI', headSha: sha,
  headBranch: 'main', event: 'push', status: 'completed', conclusion: 'success',
  attempt: 1,
  jobs: [job('server', 101), job('web', 102), job('Auth KDF benchmark smoke', 103), job('release-package', 104)],
});

test('binds exact canonical main push, run attempt, required jobs and release package', () => {
  const first = githubCiProof(good(), sha, runId, { requirePackage: true });
  assert.match(first.sha256, /^[a-f0-9]{64}$/);
  assert.equal(first.manifest.releaseSha, sha);
  assert.equal(first.manifest.runAttempt, 1);
  assert.equal(first.manifest.workflow, 'ci.yml');
  assert.equal(githubCiProof({ ...good(), jobs: good().jobs.toReversed() }, sha, runId,
    { requirePackage: true }).sha256, first.sha256);
  assert.notEqual(githubCiProof({ ...good(), attempt: 2 }, sha, runId,
    { requirePackage: true }).sha256, first.sha256);
});

test('refuses mismatched SHA, run, branch, event and workflow identity', () => {
  for (const run of [
    { ...good(), headSha: 'b'.repeat(40) },
    { ...good(), databaseId: runId + 1 },
    { ...good(), headBranch: 'feature' },
    { ...good(), event: 'pull_request' },
    { ...good(), workflowName: 'Other' },
    { ...good(), status: 'in_progress' },
    { ...good(), conclusion: 'failure' },
    { ...good(), attempt: 0 },
  ]) assert.throws(() => githubCiProof(run, sha, runId, { requirePackage: true }), /GITHUB_CI_PROOF_INVALID/);
});

test('refuses incomplete, skipped, failed, duplicated or missing jobs', () => {
  const original = good();
  for (const jobs of [
    original.jobs.filter(j => j.name !== 'server'),
    original.jobs.filter(j => j.name !== 'release-package'),
    original.jobs.map(j => j.name === 'server' ? { ...j, conclusion: 'failure' } : j),
    original.jobs.map(j => j.name === 'server' ? { ...j, status: 'queued' } : j),
    [...original.jobs, { ...original.jobs[0] }],
    [...original.jobs, job('second', 101)],
  ]) assert.throws(() => githubCiProof({ ...original, jobs }, sha, runId, { requirePackage: true }),
    /GITHUB_CI_PROOF_INVALID/);
});

test('legacy green three-job CI is usable for non-migration checks only', () => {
  const three = { ...good(), jobs: good().jobs.filter(j => j.name !== 'release-package') };
  assert.match(githubCiProof(three, sha, runId).sha256, /^[a-f0-9]{64}$/);
  assert.throws(() => githubCiProof(three, sha, runId, { requirePackage: true }),
    /GITHUB_CI_PROOF_INVALID/);
});
