/** Exact-main GitHub Actions CI receipt. Hashes bind immutable run/job identity;
 *  they do not replace root approval, the artifact seal, or host Trusted Time.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SHA_RE = /^[0-9a-f]{40}$/;
const REQUIRED_JOBS = ['Auth KDF benchmark smoke', 'server', 'web'];
const REPOSITORY = 'emrahozcelik/servora-med';

function invalid() { throw new Error('GITHUB_CI_PROOF_INVALID'); }
function positiveInteger(value) { return Number.isSafeInteger(value) && value > 0; }

export function githubCiProof(run, expectedSha, expectedRunId, { requirePackage = false } = {}) {
  if (!run || typeof run !== 'object' || Array.isArray(run)
    || !SHA_RE.test(expectedSha) || !positiveInteger(expectedRunId)
    || run.databaseId !== expectedRunId || run.workflowName !== 'CI'
    || run.headSha !== expectedSha || run.headBranch !== 'main'
    || run.event !== 'push' || run.status !== 'completed'
    || run.conclusion !== 'success' || !positiveInteger(run.attempt)
    || !Array.isArray(run.jobs)) invalid();

  const names = new Set();
  const ids = new Set();
  const jobs = run.jobs.map(job => {
    if (!job || typeof job !== 'object' || Array.isArray(job)
      || typeof job.name !== 'string' || !job.name
      || !positiveInteger(job.databaseId) || names.has(job.name) || ids.has(job.databaseId)
      || job.status !== 'completed' || job.conclusion !== 'success') invalid();
    names.add(job.name);
    ids.add(job.databaseId);
    return { id: job.databaseId, name: job.name, conclusion: 'success' };
  }).sort((left, right) => left.name.localeCompare(right.name, 'en'));

  const required = requirePackage ? [...REQUIRED_JOBS, 'release-package'] : REQUIRED_JOBS;
  if (required.some(name => !names.has(name))) invalid();
  const manifest = {
    formatVersion: 1,
    provider: 'github-actions',
    repository: REPOSITORY,
    workflow: 'ci.yml',
    runId: expectedRunId,
    runAttempt: run.attempt,
    releaseSha: expectedSha,
    event: 'push',
    branch: 'main',
    jobs,
  };
  const bytes = JSON.stringify(manifest) + '\n';
  return { manifest, sha256: createHash('sha256').update(bytes).digest('hex') };
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (!(args.length === 4 || args.length === 5)
      || args[0] !== '--sha' || args[2] !== '--run-id'
      || (args.length === 5 && args[4] !== '--require-package')
      || !/^[1-9][0-9]*$/.test(args[3])) invalid();
    const run = JSON.parse(readFileSync(0, 'utf8'));
    process.stdout.write(githubCiProof(run, args[1], Number(args[3]),
      { requirePackage: args.length === 5 }).sha256 + '\n');
  } catch {
    console.error('GITHUB_CI_PROOF_INVALID');
    process.exitCode = 1;
  }
}
