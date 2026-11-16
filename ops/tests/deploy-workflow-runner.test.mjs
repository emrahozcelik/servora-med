import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workflow = readFileSync(resolve(repoRoot, '.github/workflows/deploy-production.yml'), 'utf8');

const DEPLOY_SHA = 'a'.repeat(40);
const ATTEMPT_ID = '01234567-89ab-4cde-8f01-23456789abcd';
const CI_RUN_ID = '123456789';

/**
 * Minimal, dependency-free extraction of one `- name:` step block from the
 * workflow. Steps live at six-space indentation under the single `deploy` job.
 */
function stepBlock(name) {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  assert.notEqual(start, -1, `workflow step not found: ${name}`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^ {0,4}\S/.test(line) || /^ {6}- /.test(line)) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

/** Extract the literal `run: |` script of a named step and dedent it. */
function stepScript(name) {
  const lines = stepBlock(name).split('\n');
  const runIndex = lines.findIndex((line) => /^\s+run: \|\s*$/.test(line));
  assert.notEqual(runIndex, -1, `${name} must have a literal run block`);
  const indent = lines[runIndex].match(/^\s*/)[0].length;
  const body = [];
  for (let index = runIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() !== '' && line.match(/^\s*/)[0].length <= indent) break;
    body.push(line.slice(indent + 2));
  }
  return body.join('\n');
}

function withTempDir(callback) {
  const directory = mkdtempSync(join(tmpdir(), 'servora-deploy-workflow-'));
  try {
    return callback(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Execute the real workflow Bash with a controlled environment. */
function runWorkflowStep(script, environment) {
  return spawnSync('/bin/bash', ['-c', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', ...environment },
  });
}

function writeStub(directory, name, source) {
  const path = join(directory, name);
  writeFileSync(path, source);
  chmodSync(path, 0o755);
  return path;
}

const GH_STUB = `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$@" >"$GH_CAPTURE"
directory=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) directory="$2"; shift 2 ;;
    *) shift ;;
  esac
done
touch "$directory/servora-med-$DEPLOY_SHA.tar.gz"
if [[ "\${GH_STUB_SIDECAR:-1}" == "1" ]]; then
  touch "$directory/servora-med-$DEPLOY_SHA.tar.gz.sha256"
fi
`;

const BASH_CAPTURE_STUB = `#!/bin/bash
printf '%s\\n' "$@" >"$CAPTURE"
`;

/**
 * The deployment workflow installs Playwright browsers before the host stages.
 * Playwright 1.55.1 has no Ubuntu 26.04 dependency build, so `ubuntu-latest`
 * can fail the deploy before any release or activation work starts. Keep the
 * deployment job on the same supported image as the web CI job.
 */
test('deploy-production.yml stays on the Playwright-supported Ubuntu runner', () => {
  const runner = /^\s{4}runs-on:\s*(\S+)\s*$/m.exec(workflow);
  assert.ok(runner, 'deploy job must declare a pinned runs-on value');
  assert.equal(runner[1], 'ubuntu-24.04');
  assert.doesNotMatch(workflow, /runs-on:\s*ubuntu-latest/);
});

test('workflow advertises no migration-disable mode and requires the approved attempt for every deployment', () => {
  assert.doesNotMatch(workflow, /allow_migrations/i);
  assert.doesNotMatch(workflow, /ALLOW_MIGRATIONS/);

  assert.match(workflow, /deploy_sha:\n\s+description: Deploy this exact canonical main SHA\n\s+required: true\n\s+type: string/);
  assert.match(workflow, /attempt_id:\n\s+description: [^\n]*root-owned approval UUID[^\n]*\n\s+required: true\n\s+type: string/);
  assert.match(workflow, /ci_run_id:\n\s+description: [^\n]*exact-main push CI run[^\n]*\n\s+required: true\n\s+type: string/);

  // No step may be conditionally skipped: every workflow deployment performs
  // the same validation, artifact download, and guarded runner invocation.
  assert.doesNotMatch(workflow, /^\s+if:\s*inputs\./m);
});

test('identity gate accepts only an exact-main SHA, UUID v4 attempt and positive CI run id', () => {
  const validation = stepScript('Validate immutable deployment identity');
  const baseEnvironment = {
    DEPLOY_SHA,
    GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: DEPLOY_SHA,
    ATTEMPT_ID,
    CI_RUN_ID,
  };

  const accepted = runWorkflowStep(validation, baseEnvironment);
  assert.equal(accepted.status, 0, accepted.stderr);

  const rejected = [
    [{ DEPLOY_SHA: '', GITHUB_SHA: '' }, 'INVALID_DEPLOY_SHA'],
    [{ DEPLOY_SHA: 'A'.repeat(40), GITHUB_SHA: 'A'.repeat(40) }, 'INVALID_DEPLOY_SHA'],
    [{ DEPLOY_SHA: 'a'.repeat(39), GITHUB_SHA: 'a'.repeat(39) }, 'INVALID_DEPLOY_SHA'],
    [{ GITHUB_REF: 'refs/heads/feature/example' }, 'NON_MAIN_WORKFLOW_REF'],
    [{ GITHUB_REF: '' }, 'NON_MAIN_WORKFLOW_REF'],
    [{ GITHUB_SHA: 'b'.repeat(40) }, 'DEPLOY_SHA_EVENT_MISMATCH'],
    [{ ATTEMPT_ID: '' }, 'ATTEMPT_ID_REQUIRED'],
    [{ ATTEMPT_ID: 'not-a-uuid' }, 'ATTEMPT_ID_REQUIRED'],
    [{ ATTEMPT_ID: '01234567-89ab-3cde-8f01-23456789abcd' }, 'ATTEMPT_ID_REQUIRED'],
    [{ ATTEMPT_ID: '01234567-89ab-4cde-7f01-23456789abcd' }, 'ATTEMPT_ID_REQUIRED'],
    [{ ATTEMPT_ID: ATTEMPT_ID.toUpperCase() }, 'ATTEMPT_ID_REQUIRED'],
    [{ CI_RUN_ID: '' }, 'CI_RUN_ID_REQUIRED'],
    [{ CI_RUN_ID: '0' }, 'CI_RUN_ID_REQUIRED'],
    [{ CI_RUN_ID: '-1' }, 'CI_RUN_ID_REQUIRED'],
    [{ CI_RUN_ID: '12a' }, 'CI_RUN_ID_REQUIRED'],
  ];

  for (const [override, reason] of rejected) {
    const result = runWorkflowStep(validation, { ...baseEnvironment, ...override });
    assert.notEqual(result.status, 0, reason);
    assert.match(result.stderr, new RegExp(reason), reason);
  }
});

test('every release downloads and verifies the exact-main artifact and its sidecar', () => {
  const script = stepScript('Download exact-main release artifact for approved deployment');
  const block = stepBlock('Download exact-main release artifact for approved deployment');
  assert.doesNotMatch(block, /^\s+if:/m);

  withTempDir((directory) => {
    const bin = join(directory, 'bin');
    mkdirSync(bin);
    writeStub(bin, 'gh', GH_STUB);

    const capture = join(directory, 'gh-args');
    const runnerTemp = join(directory, 'runner');
    mkdirSync(runnerTemp);
    const success = runWorkflowStep(script, {
      PATH: `${bin}:/usr/bin:/bin`,
      GH_CAPTURE: capture,
      DEPLOY_SHA,
      CI_RUN_ID,
      RUNNER_TEMP: runnerTemp,
    });
    assert.equal(success.status, 0, success.stderr);
    assert.deepEqual(readFileSync(capture, 'utf8').trim().split('\n'), [
      'run',
      'download',
      CI_RUN_ID,
      '--name',
      `servora-med-release-${DEPLOY_SHA}`,
      '--dir',
      join(runnerTemp, 'servora-release'),
    ]);
    assert.ok(existsSync(join(runnerTemp, 'servora-release', `servora-med-${DEPLOY_SHA}.tar.gz`)));
    assert.ok(existsSync(join(runnerTemp, 'servora-release', `servora-med-${DEPLOY_SHA}.tar.gz.sha256`)));

    const sidecarRunnerTemp = join(directory, 'runner-missing-sidecar');
    mkdirSync(sidecarRunnerTemp);
    const missingSidecar = runWorkflowStep(script, {
      PATH: `${bin}:/usr/bin:/bin`,
      GH_CAPTURE: join(directory, 'gh-args-missing-sidecar'),
      GH_STUB_SIDECAR: '0',
      DEPLOY_SHA,
      CI_RUN_ID,
      RUNNER_TEMP: sidecarRunnerTemp,
    });
    assert.notEqual(missingSidecar.status, 0, 'a release without its SHA-256 sidecar must fail');
  });
});

test('the single workflow path always invokes the guarded attempt-bound runner with the exact artifact', () => {
  const step = 'Build, transfer, activate, smoke, and back up exact main SHA';
  const script = stepScript(step);
  const block = stepBlock(step);

  assert.match(block, /ATTEMPT_ID: \$\{\{ inputs\.attempt_id \}\}/);
  assert.match(block, /CI_RUN_ID: \$\{\{ inputs\.ci_run_id \}\}/);
  assert.doesNotMatch(script, /if \[\[|if !|else/);

  withTempDir((directory) => {
    const bin = join(directory, 'bin');
    mkdirSync(bin);
    writeStub(bin, 'bash', BASH_CAPTURE_STUB);

    const capture = join(directory, 'bash-args');
    const runnerTemp = join(directory, 'runner');
    mkdirSync(runnerTemp);
    const result = runWorkflowStep(script, {
      PATH: `${bin}:/usr/bin:/bin`,
      CAPTURE: capture,
      DEPLOY_SHA,
      ATTEMPT_ID,
      CI_RUN_ID,
      RUNNER_TEMP: runnerTemp,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(capture, 'utf8').trim().split('\n'), [
      'ops/deploy-production.sh',
      '--sha',
      DEPLOY_SHA,
      '--allow-migrations',
      '--attempt-id',
      ATTEMPT_ID,
      '--ci-mode',
      'github',
      '--ci-run-id',
      CI_RUN_ID,
      '--artifact',
      join(runnerTemp, 'servora-release', `servora-med-${DEPLOY_SHA}.tar.gz`),
    ]);
  });
});

test('workflow keeps the existing production protection bindings', () => {
  assert.match(workflow, /^on:\n {2}workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^ {2}(push|pull_request|schedule):/m);
  assert.match(workflow, /permissions:\n {2}contents: read\n {2}actions: read/);
  assert.match(workflow, /group: production-deploy/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /environment:\n {6}name: production/);
  assert.match(workflow, /node-version: 22/);
  assert.match(workflow, /npx playwright install --with-deps chromium webkit/);
  assert.match(workflow, /bash ops\/deploy-production\.sh/);
  assert.doesNotMatch(workflow, /StrictHostKeyChecking=no/);

  for (const name of [
    'SERVORA_PROD_HOST',
    'SERVORA_PROD_SSH_USER',
    'SERVORA_PROD_SSH_KEY',
    'SERVORA_PROD_KNOWN_HOSTS',
    'SERVORA_PROD_FQDN',
  ]) {
    assert.match(workflow, new RegExp(name));
  }
});

test('attempt-bound release still requires the hosted CI receipt and a prebuilt package', () => {
  const ci = readFileSync(resolve(repoRoot, '.github/workflows/ci.yml'), 'utf8');
  const deploy = readFileSync(resolve(repoRoot, 'ops/deploy-production.sh'), 'utf8');

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
