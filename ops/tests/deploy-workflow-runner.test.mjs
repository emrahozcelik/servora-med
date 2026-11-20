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

test('one operator action: the only input is the optional migration checkbox', () => {
  assert.match(workflow, /allow_migrations:\n\s+description: [^\n]+\n\s+required: false\n\s+default: false\n\s+type: boolean/);
  for (const removed of ['deploy_sha:', 'attempt_id:', 'ci_run_id:', 'inputs.attempt_id', 'inputs.ci_run_id', 'inputs.deploy_sha']) {
    assert.doesNotMatch(workflow, new RegExp(removed.replace('.', '\\.')), removed);
  }
  assert.doesNotMatch(workflow, /--attempt-id/);
  // No step may be conditionally skipped: every deployment runs the same gates.
  assert.doesNotMatch(workflow, /^\s+if:\s*inputs\./m);
});

test('identity gate binds the deployment to the dispatched exact main SHA', () => {
  const validation = stepScript('Validate deployment identity');
  withTempDir((directory) => {
    const githubEnv = join(directory, 'github-env');
    writeFileSync(githubEnv, '');
    const accepted = runWorkflowStep(validation, { GITHUB_REF: 'refs/heads/main', GITHUB_SHA: DEPLOY_SHA, GITHUB_ENV: githubEnv });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(readFileSync(githubEnv, 'utf8'), `DEPLOY_SHA=${DEPLOY_SHA}\n`);
  });
  const rejected = [
    [{ GITHUB_REF: 'refs/heads/feature/example' }, 'NON_MAIN_WORKFLOW_REF'],
    [{ GITHUB_REF: '' }, 'NON_MAIN_WORKFLOW_REF'],
    [{ GITHUB_SHA: '' }, 'INVALID_DEPLOY_SHA'],
    [{ GITHUB_SHA: 'A'.repeat(40) }, 'INVALID_DEPLOY_SHA'],
    [{ GITHUB_SHA: 'a'.repeat(39) }, 'INVALID_DEPLOY_SHA'],
  ];
  for (const [override, reason] of rejected) {
    const result = runWorkflowStep(validation, { GITHUB_REF: 'refs/heads/main', GITHUB_SHA: DEPLOY_SHA, GITHUB_ENV: '/dev/null', ...override });
    assert.notEqual(result.status, 0, reason);
    assert.match(result.stderr, new RegExp(reason), reason);
  }
});

test('the exact green push CI run is resolved automatically and an absent run fails closed', () => {
  const script = stepScript('Resolve exact-main CI run for this SHA');
  assert.match(script, /--workflow ci\.yml --branch main --event push --commit "\$DEPLOY_SHA"/);
  assert.match(script, /\.conclusion == \\"success\\"/);
  withTempDir((directory) => {
    const bin = join(directory, 'bin');
    mkdirSync(bin);
    writeStub(bin, 'gh', '#!/bin/bash\nprintf \'%s\\n\' "$@" >"$GH_CAPTURE"\nprintf \'%s\' "${GH_RUN_ID:-}"\n');
    const githubEnv = join(directory, 'github-env');
    writeFileSync(githubEnv, '');
    const base = { PATH: `${bin}:/usr/bin:/bin`, GH_CAPTURE: join(directory, 'gh-args'), DEPLOY_SHA, GITHUB_ENV: githubEnv };
    const found = runWorkflowStep(script, { ...base, GH_RUN_ID: CI_RUN_ID });
    assert.equal(found.status, 0, found.stderr);
    assert.equal(readFileSync(githubEnv, 'utf8'), `CI_RUN_ID=${CI_RUN_ID}\n`);
    for (const value of ['', 'null', '0', '12a']) {
      const missing = runWorkflowStep(script, { ...base, GH_RUN_ID: value, GITHUB_ENV: '/dev/null' });
      assert.notEqual(missing.status, 0, `run id ${JSON.stringify(value)} must fail`);
      assert.match(missing.stderr, /EXACT_MAIN_CI_NOT_GREEN/);
    }
  });
});

test('every release downloads and verifies the exact-main artifact and its sidecar', () => {
  const script = stepScript('Download exact-main release artifact');
  const block = stepBlock('Download exact-main release artifact');
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

test('the runner gets the exact artifact and pinned CI run, never an attempt; migrations only when checked', () => {
  const step = 'Transfer, activate, smoke, back up and observe exact main SHA';
  const script = stepScript(step);
  const block = stepBlock(step);
  assert.match(block, /ALLOW_MIGRATIONS: \$\{\{ inputs\.allow_migrations \}\}/);

  withTempDir((directory) => {
    const bin = join(directory, 'bin');
    mkdirSync(bin);
    writeStub(bin, 'bash', BASH_CAPTURE_STUB);
    const runnerTemp = join(directory, 'runner');
    mkdirSync(runnerTemp);
    const expected = [
      'ops/deploy-production.sh',
      '--sha',
      DEPLOY_SHA,
      '--ci-mode',
      'github',
      '--ci-run-id',
      CI_RUN_ID,
      '--artifact',
      join(runnerTemp, 'servora-release', `servora-med-${DEPLOY_SHA}.tar.gz`),
    ];
    for (const [allow, extra] of [['false', []], ['', []], ['true', ['--allow-migrations']]]) {
      const capture = join(directory, `bash-args-${allow || 'empty'}`);
      const result = runWorkflowStep(script, {
        PATH: `${bin}:/usr/bin:/bin`, CAPTURE: capture, DEPLOY_SHA, CI_RUN_ID, RUNNER_TEMP: runnerTemp, ALLOW_MIGRATIONS: allow,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(readFileSync(capture, 'utf8').trim().split('\n'), [...expected, ...extra], `allow=${allow}`);
    }
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
  assert.match(workflow, /path: ~\/\.cache\/ms-playwright/);
  assert.match(workflow, /timeout-minutes: 60/);
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

test('a prebuilt release always requires the hosted CI receipt including release-package', () => {
  const ci = readFileSync(resolve(repoRoot, '.github/workflows/ci.yml'), 'utf8');
  const deploy = readFileSync(resolve(repoRoot, 'ops/deploy-production.sh'), 'utf8');

  assert.match(ci, /release-package:/);
  assert.match(ci, /needs: \[benchmark-smoke, server, web\]/);
  assert.match(ci, /github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
  assert.match(ci, /--package-only --output-dir/);
  assert.match(ci, /actions\/upload-artifact@v4/);
  assert.match(deploy, /CI_MANIFEST_SHA=.*github-ci-evidence/);
  assert.match(deploy, /--require-package/);
  assert.match(deploy, /if \[\[ -n "\$ATTEMPT_ID" \|\| -n "\$ARTIFACT_INPUT" \]\]; then proof_args=\(--require-package\)/);
  assert.match(deploy, /ATTEMPT_ARGUMENTS_INVALID/);
  assert.match(deploy, /NORMAL_ARGUMENTS_INVALID/);
  assert.doesNotMatch(deploy, /ATTEMPT_REQUIRED_FOR_MIGRATIONS/);
});

test('normal route argument rules: a pinned CI run needs its package; no attempt is required', () => {
  const runner = resolve(repoRoot, 'ops/deploy-production.sh');
  const run = (args) => spawnSync('/bin/bash', [runner, ...args], { cwd: repoRoot, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  const artifact = `/tmp/servora-med-${DEPLOY_SHA}.tar.gz`;
  for (const args of [
    ['--sha', DEPLOY_SHA, '--ci-run-id', CI_RUN_ID],
    ['--sha', DEPLOY_SHA, '--ci-run-id', '0', '--artifact', artifact],
    ['--sha', DEPLOY_SHA, '--ci-mode', 'local', '--ci-run-id', CI_RUN_ID, '--artifact', artifact],
  ]) {
    const result = run(args);
    assert.notEqual(result.status, 0, args.join(' '));
    assert.match(result.stderr, /reason=NORMAL_ARGUMENTS_INVALID/, args.join(' '));
  }
  const recovery = run(['--sha', DEPLOY_SHA, '--ci-run-id', CI_RUN_ID, '--artifact', artifact, '--forward-recovery']);
  assert.match(recovery.stderr, /reason=RECOVERY_ARGUMENTS_INVALID/, 'forward recovery still needs an attempt');
  const source = readFileSync(runner, 'utf8');
  assert.doesNotMatch(source, /ATTEMPT_REQUIRED_FOR_MIGRATIONS|CI_RUN_ID_REQUIRES_ATTEMPT/);
  assert.match(source, /REMOTE_MIGRATION_COUNT_INVALID/, 'an unknown migration count never enables rollback');
  assert.match(source, /observe_public_health \|\| fail LIVE_BUT_OBSERVATION_FAILED/);
});

/**
 * 2026-11-19: security.ubuntu.com and archive.ubuntu.com returned 503 for hours
 * and later crawled at ~143 kB/s while azure.archive.ubuntu.com stayed fast.
 * Every Playwright `--with-deps` install in the deploy path (web ->
 * release-package -> Production Deploy) must first make the Azure mirror the
 * preferred apt source with retries and fail within a bound.
 */
test('every Playwright --with-deps install first prefers the Azure apt mirror under a timeout', () => {
  const ci = readFileSync(resolve(repoRoot, '.github/workflows/ci.yml'), 'utf8');
  for (const [file, source, expected] of [['deploy-production.yml', workflow, 1], ['ci.yml', ci, 2]]) {
    const installs = [...source.matchAll(/npx playwright install --with-deps chromium webkit/g)];
    assert.equal(installs.length, expected, file);
    for (const install of installs) {
      const before = source.slice(0, install.index);
      const stepStart = Math.max(before.lastIndexOf('\n      - name:'), before.lastIndexOf('\n      - run:'));
      const step = before.slice(stepStart);
      assert.match(step, /\n {8}timeout-minutes: 15\n/, `${file}: install step must be time-bounded`);
      assert.match(step, /\n {10}sudo bash \.\.\/ops\/ci\/use-azure-apt-mirror\.sh\n/, `${file}: mirror guard must run first`);
      // 2026-11-20: a slow-but-alive Azure connection held both web jobs for the full 15 minutes.
      assert.match(step, /use-azure-apt-mirror\.sh\n(?: {10}npm ci\n)? {10}bash \.\.\/ops\/ci\/prefetch-playwright-apt-deps\.sh\n {10}$/,
        `${file}: bounded apt prefetch must run between the mirror guard and the install`);
    }
  }
  const releasePackage = ci.slice(ci.indexOf('\n  release-package:'));
  assert.match(releasePackage, /path: ~\/\.cache\/ms-playwright/);
});

const AZURE = 'http://azure.archive.ubuntu.com/ubuntu/';
const count = (text, needle) => text.split(needle).length - 1;

test('Azure apt mirror guard makes Azure the first source and keeps existing Ubuntu mirrors as fallbacks', () => {
  const script = resolve(repoRoot, 'ops/ci/use-azure-apt-mirror.sh');
  const run = (root) => spawnSync('/bin/bash', [script], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', APT_ROOT: root } });
  const runTwice = (root) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = run(root);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /APT_AZURE_MIRROR_READY/);
    }
  };

  // Actual ubuntu-24.04 runner layout (failed release-package job, 2026-11-19):
  // every stanza is `mirror+file:` and the list starts with the EC2 mirror.
  withTempDir((root) => {
    const apt = join(root, 'etc/apt');
    mkdirSync(join(apt, 'sources.list.d'), { recursive: true });
    const stanzas = [
      'Types: deb',
      'URIs: mirror+file:/etc/apt/apt-mirrors.txt',
      'Suites: noble noble-updates noble-backports noble-security',
      'Components: main universe restricted multiverse',
      'Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg',
      '',
    ].join('\n');
    writeFileSync(join(apt, 'sources.list.d/ubuntu.sources'), stanzas);
    const mirrors = [
      'http://us-east-2.ec2.archive.ubuntu.com/ubuntu/\tpriority:1',
      'https://archive.ubuntu.com/ubuntu/\tpriority:2',
      'https://security.ubuntu.com/ubuntu/\tpriority:3',
      '',
    ].join('\n');
    writeFileSync(join(apt, 'apt-mirrors.txt'), mirrors);
    runTwice(root);
    // apt tries the lowest priority number first: Azure 1, the runner's mirrors shift by one.
    assert.equal(readFileSync(join(apt, 'apt-mirrors.txt'), 'utf8'), [
      `${AZURE}\tpriority:1`,
      'http://us-east-2.ec2.archive.ubuntu.com/ubuntu/\tpriority:2',
      'https://archive.ubuntu.com/ubuntu/\tpriority:3',
      'https://security.ubuntu.com/ubuntu/\tpriority:4',
      '',
    ].join('\n'));
    assert.equal(readFileSync(join(apt, 'sources.list.d/ubuntu.sources'), 'utf8'), stanzas);
    const retries = readFileSync(join(apt, 'apt.conf.d/80-servora-ci-retries'), 'utf8');
    assert.match(retries, /Acquire::Retries "5";/);
    assert.match(retries, /Acquire::http::Timeout "30";/);

    rmSync(join(apt, 'apt-mirrors.txt'));
    const missingList = run(root);
    assert.notEqual(missingList.status, 0);
    assert.match(missingList.stderr, /APT_MIRROR_LIST_MISSING/);
  });

  // Direct URIs: deb822 lines get Azure prepended as the first URI, one-line
  // entries get an Azure duplicate before the original; originals stay as
  // fallbacks and third-party sources are untouched.
  withTempDir((root) => {
    const apt = join(root, 'etc/apt');
    mkdirSync(join(apt, 'sources.list.d'), { recursive: true });
    writeFileSync(join(apt, 'sources.list'), '# Ubuntu sources have moved to /etc/apt/sources.list.d/ubuntu.sources\n');
    writeFileSync(join(apt, 'sources.list.d/ubuntu.sources'), [
      'Types: deb',
      'URIs: http://archive.ubuntu.com/ubuntu/',
      'Suites: noble noble-updates noble-backports',
      'Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg',
      '',
      'Types: deb',
      'URIs: http://security.ubuntu.com/ubuntu/',
      'Suites: noble-security',
      'Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg',
      '',
    ].join('\n'));
    writeFileSync(join(apt, 'sources.list.d/legacy.list'), 'deb http://us.archive.ubuntu.com/ubuntu noble universe\n');
    const thirdParty = 'deb [arch=amd64] https://packages.microsoft.com/ubuntu/24.04/prod noble main\n';
    writeFileSync(join(apt, 'sources.list.d/microsoft-prod.list'), thirdParty);
    runTwice(root);

    const sources = readFileSync(join(apt, 'sources.list.d/ubuntu.sources'), 'utf8');
    assert.match(sources, new RegExp(`URIs: ${AZURE} http://archive\\.ubuntu\\.com/ubuntu/\\nSuites: noble noble-updates`));
    assert.match(sources, new RegExp(`URIs: ${AZURE} http://security\\.ubuntu\\.com/ubuntu/\\nSuites: noble-security`));
    assert.equal(count(sources, AZURE), 2);
    assert.equal(readFileSync(join(apt, 'sources.list.d/legacy.list'), 'utf8'),
      'deb http://azure.archive.ubuntu.com/ubuntu noble universe\ndeb http://us.archive.ubuntu.com/ubuntu noble universe\n');
    assert.equal(readFileSync(join(apt, 'sources.list.d/microsoft-prod.list'), 'utf8'), thirdParty);
    assert.equal(readFileSync(join(apt, 'sources.list'), 'utf8'), '# Ubuntu sources have moved to /etc/apt/sources.list.d/ubuntu.sources\n');
  });

  withTempDir((root) => {
    const missing = run(root);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /APT_CONFIG_DIR_MISSING/);
    mkdirSync(join(root, 'etc/apt/sources.list.d'), { recursive: true });
    writeFileSync(join(root, 'etc/apt/sources.list.d/other.list'), 'deb https://example.invalid/repo stable main\n');
    const noUbuntu = run(root);
    assert.notEqual(noUbuntu.status, 0);
    assert.match(noUbuntu.stderr, /APT_AZURE_MIRROR_NOT_CONFIGURED/);
  });
});

const hasTimeout = spawnSync('/bin/sh', ['-c', 'command -v timeout'], { env: { PATH: '/usr/bin:/bin' } }).status === 0;

/**
 * 2026-11-20: apt fetched 126 MB from the Azure mirror at ~60 kB/s for the
 * whole 15-minute step while a concurrent job got it in 5 s. The prefetch
 * bounds each download-only attempt, demotes Azure once, then fails closed.
 */
test('bounded Playwright apt prefetch retries a stalled download on the runner mirrors', { skip: !hasTimeout && 'GNU timeout is not installed' }, () => {
  const script = resolve(repoRoot, 'ops/ci/prefetch-playwright-apt-deps.sh');
  const guarded = [
    `${AZURE}\tpriority:1`,
    'http://us-east-2.ec2.archive.ubuntu.com/ubuntu/\tpriority:2',
    'https://archive.ubuntu.com/ubuntu/\tpriority:3',
    'https://security.ubuntu.com/ubuntu/\tpriority:4',
    '',
  ].join('\n');
  const demoted = [
    'http://us-east-2.ec2.archive.ubuntu.com/ubuntu/\tpriority:2',
    'https://archive.ubuntu.com/ubuntu/\tpriority:3',
    'https://security.ubuntu.com/ubuntu/\tpriority:4',
    `${AZURE}\tpriority:5`,
    '',
  ].join('\n');
  const run = (plan, check) => withTempDir((root) => {
    const apt = join(root, 'etc/apt');
    const stubs = join(root, 'stubs');
    mkdirSync(join(apt, 'sources.list.d'), { recursive: true });
    mkdirSync(join(apt, 'apt.conf.d'), { recursive: true });
    mkdirSync(stubs);
    writeFileSync(join(apt, 'sources.list.d/ubuntu.sources'), 'Types: deb\nURIs: mirror+file:/etc/apt/apt-mirrors.txt\nSuites: noble\n');
    writeFileSync(join(apt, 'apt-mirrors.txt'), guarded);
    writeFileSync(join(stubs, 'sudo'), '#!/bin/sh\nexec "$@"\n');
    // Records each call and the download-only config it saw; `hang` stalls past the bound.
    writeFileSync(join(stubs, 'npx'), [
      '#!/bin/sh',
      'n=$(( $(cat "$STUB_DIR/count" 2>/dev/null || echo 0) + 1 ))',
      'echo "$n" >"$STUB_DIR/count"',
      'echo "$*" >>"$STUB_DIR/calls"',
      'cat "$APT_ROOT/etc/apt/apt.conf.d/81-servora-ci-download-only" >>"$STUB_DIR/conf-seen"',
      'head -n 1 "$APT_ROOT/etc/apt/apt-mirrors.txt" >>"$STUB_DIR/first-mirror"',
      '[ "$(echo "$NPX_PLAN" | cut -d, -f"$n")" = hang ] && exec sleep 30',
      'exit 0',
      '',
    ].join('\n'));
    chmodSync(join(stubs, 'sudo'), 0o755);
    chmodSync(join(stubs, 'npx'), 0o755);
    const result = spawnSync('/bin/bash', [script], {
      encoding: 'utf8',
      env: { PATH: `${stubs}:/usr/bin:/bin`, APT_ROOT: root, PLAYWRIGHT_APT_ATTEMPT_SECONDS: '1', STUB_DIR: stubs, NPX_PLAN: plan },
    });
    const read = (name) => readFileSync(join(stubs, name), 'utf8');
    // The download-only config never outlives the prefetch.
    assert.equal(existsSync(join(apt, 'apt.conf.d/81-servora-ci-download-only')), false);
    check(result, { mirrors: readFileSync(join(apt, 'apt-mirrors.txt'), 'utf8'), read });
  });

  run('ok', (result, { mirrors, read }) => {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PLAYWRIGHT_APT_PREFETCH_READY attempt=1/);
    assert.equal(read('calls'), 'playwright install-deps chromium webkit\n');
    assert.equal(read('conf-seen'), 'APT::Get::Download-Only "true";\nDPkg::Lock::Timeout "120";\n');
    assert.equal(mirrors, guarded);
  });

  run('hang,ok', (result, { mirrors, read }) => {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /PLAYWRIGHT_APT_PREFETCH_ATTEMPT_FAILED attempt=1 status=124 limit=1s/);
    assert.match(result.stdout, /APT_AZURE_MIRROR_DEMOTED \/etc\/apt\/apt-mirrors\.txt/);
    assert.match(result.stdout, /PLAYWRIGHT_APT_PREFETCH_READY attempt=2/);
    assert.equal(read('calls'), 'playwright install-deps chromium webkit\n'.repeat(2));
    assert.equal(count(read('conf-seen'), 'APT::Get::Download-Only "true";'), 2);
    // The retry starts on the runner's own mirror; Azure stays as the last fallback.
    assert.equal(read('first-mirror'), `${AZURE}\tpriority:1\nhttp://us-east-2.ec2.archive.ubuntu.com/ubuntu/\tpriority:2\n`);
    assert.equal(mirrors, demoted);
  });

  run('hang,hang,ok', (result, { mirrors, read }) => {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /PLAYWRIGHT_APT_PREFETCH_ATTEMPT_FAILED attempt=2 status=124/);
    assert.match(result.stderr, /PLAYWRIGHT_APT_PREFETCH_FAILED/);
    assert.equal(read('count'), '2\n');
    assert.equal(mirrors, demoted);
  });
});
