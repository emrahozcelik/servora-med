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
