import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * The deployment workflow installs Playwright browsers before the host stages.
 * Playwright 1.55.1 has no Ubuntu 26.04 dependency build, so `ubuntu-latest`
 * can fail the deploy before any release or activation work starts. Keep the
 * deployment job on the same supported image as the web CI job.
 */
test('deploy-production.yml stays on the Playwright-supported Ubuntu runner', () => {
  const workflow = readFileSync(resolve(repoRoot, '.github/workflows/deploy-production.yml'), 'utf8');
  const runner = /^\s{4}runs-on:\s*(\S+)\s*$/m.exec(workflow);
  assert.ok(runner, 'deploy job must declare a pinned runs-on value');
  assert.equal(runner[1], 'ubuntu-24.04');
  assert.doesNotMatch(workflow, /runs-on:\s*ubuntu-latest/);
});

test('attempt-bound migration uses exact hosted CI receipt and a prebuilt release package', () => {
  const workflow = readFileSync(resolve(repoRoot, '.github/workflows/deploy-production.yml'), 'utf8');
  const ci = readFileSync(resolve(repoRoot, '.github/workflows/ci.yml'), 'utf8');
  const deploy = readFileSync(resolve(repoRoot, 'ops/deploy-production.sh'), 'utf8');

  assert.match(workflow, /attempt_id:/);
  assert.match(workflow, /ci_run_id:/);
  assert.match(workflow, /MIGRATION_ATTEMPT_ID_REQUIRED/);
  assert.match(workflow, /MIGRATION_CI_RUN_ID_REQUIRED/);
  assert.match(workflow, /gh run download "\$CI_RUN_ID"/);
  assert.match(workflow, /--allow-migrations --attempt-id "\$ATTEMPT_ID"/);
  assert.match(workflow, /--ci-mode github --ci-run-id "\$CI_RUN_ID"/);
  assert.match(workflow, /--artifact "\$RUNNER_TEMP\/servora-release/);

  assert.match(ci, /release-package:/);
  assert.match(ci, /needs: \[benchmark-smoke, server, web\]/);
  assert.match(ci, /github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
  assert.match(ci, /--package-only --output-dir/);
  assert.match(ci, /actions\/upload-artifact@v4/);
  assert.match(deploy, /CI_MANIFEST_SHA=.*github-ci-evidence/);
  assert.match(deploy, /--require-package/);
  assert.match(deploy, /ATTEMPT_ARGUMENTS_INVALID/);
  assert.match(deploy, /ATTEMPT_REQUIRED_FOR_MIGRATIONS/);
});
