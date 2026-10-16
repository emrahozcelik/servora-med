// Exercise the actual run.sh entrypoint in a committed miniature repository.
// Docker is stateful and fake. Emit a valid archive before controlled exit 86,
// so both GNU and BSD tar succeed and pipefail preserves that intentional exit.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const FAKE = fileURLToPath(new URL('fixtures/local-ci-docker.mjs', import.meta.url));
const shellQuote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();

function fixture(t, settings = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-lifecycle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.cpSync(path.join(REPO, 'ops/local-ci'), path.join(repo, 'ops/local-ci'), { recursive: true });
  const git = (...args) => {
    const r = spawnSync(realGit, ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git('init', '-q');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Fixture');
  git('remote', 'add', 'origin', 'https://github.com/example/servora-ci-fixture.git');
  const sha = git('rev-parse', 'HEAD');
  const stateFile = path.join(root, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ volumes: { anonymous: false, 'named-db': true }, ...settings }));
  const writeBin = (name, body) => fs.writeFileSync(path.join(bin, name), '#!/bin/bash\n' + body + '\n', { mode: 0o755 });
  writeBin('docker', `exec ${shellQuote(process.execPath)} ${shellQuote(FAKE)} "$@"`);
  writeBin('git', `for arg in "$@"; do if [[ "$arg" == archive ]]; then ${shellQuote(realGit)} "$@"; exit 86; fi; done\nexec ${shellQuote(realGit)} "$@"`);
  writeBin('node', `if [[ "$1" == -p ]]; then echo 22; elif [[ "$1" == --version ]]; then echo v22.23.3; else exec ${shellQuote(process.execPath)} "$@"; fi`);
  writeBin('npm', 'echo 10.9.9');
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, TMPDIR: root, CI_FIXTURE_STATE: stateFile, DOCKER_CONTEXT: 'colima-true' };
  delete env.DOCKER_HOST;
  delete env.LOCAL_CI_DOCKER_ENDPOINT;
  delete env.LOCAL_CI_DOCKER_DAEMON_ID;
  const evidence = path.join(root, 'evidence');
  const bundle = path.join(evidence, sha);
  const runArgs = [path.join(repo, 'ops/local-ci/run.sh'), '--repo', repo, '--sha', sha, '--evidence-root', evidence];
  const run = (args = [], envPatch = {}) => spawnSync('/bin/bash', [...runArgs, ...args], { env: { ...env, ...envPatch }, encoding: 'utf8', timeout: 20_000 });
  return { root, repo, env, bundle, evidence, sha, run, runArgs, state: () => JSON.parse(fs.readFileSync(stateFile)), calls: () => fs.existsSync(stateFile + '.calls') ? fs.readFileSync(stateFile + '.calls', 'utf8').trim().split('\n').map(JSON.parse) : [] };
}

for (const labels of ['null', '{}']) {
  test(`F1: preserves an unlabeled named volume (${labels})`, (t) => {
    const fx = fixture(t, { namedLabels: labels });
    const result = fx.run();
    assert.equal(result.status, 86, result.stderr);
    assert.equal(fx.state().volumes['named-db'], true, 'named volume must survive cleanup');
    assert.equal(fx.state().volumes.anonymous, false, 'run-owned anonymous volume removed');
  });
}

test('F2: a failed mount inspection cannot orphan the anonymous volume', (t) => {
  const fx = fixture(t, { failure: 'inspect' });
  const result = fx.run();
  assert.equal(result.status, 86, result.stderr);
  assert.equal(fx.state().container, null);
  assert.equal(fx.state().volumes.anonymous, false);
});

test('F3: container start failure cleans its already-created container and volumes', (t) => {
  const fx = fixture(t, { failure: 'start' });
  const result = fx.run();
  assert.equal(result.status, 125, result.stderr);
  assert.equal(fx.state().container, null);
  assert.equal(fx.state().volumes.anonymous, false);
  assert.equal(fx.state().network, null);
});

test('F3: partial network creation recovers the matching run-owned network', (t) => {
  const fx = fixture(t, { failure: 'partial-network' });
  const result = fx.run();
  assert.equal(result.status, 125, result.stderr);
  assert.equal(fx.state().network, null);
});

test('partial container create recovers by run label and immutable ID', (t) => {
  const fx = fixture(t, { failure: 'partial-container' });
  const result = fx.run();
  assert.equal(result.status, 125, result.stderr);
  assert.equal(fx.state().container, null);
  assert.equal(fx.state().volumes.anonymous, false);
  assert.equal(fx.state().network, null);
});

test('foreign resource label fails closed after an ambiguous create', (t) => {
  const fx = fixture(t, { failure: 'partial-container', foreignLabel: true });
  const result = fx.run();
  assert.equal(result.status, 125, result.stderr);
  assert.ok(fx.state().container, 'foreign container is preserved');
  assert.equal(fx.state().volumes.anonymous, true);
  assert.match(result.stderr, /LOCAL_CI_OWNERSHIP_UNKNOWN.*label_mismatch/);
  assert.ok(!fx.calls().some((c) => c.args.includes('rm') && c.args.includes('-fv')));
});

test('unavailable ownership inspection preserves ambiguous resources and diagnostics', (t) => {
  const fx = fixture(t, { failure: 'partial-container' });
  fx.env.CI_FIXTURE_INSPECT_FAIL = 'true';
  const result = fx.run();
  assert.equal(result.status, 125, result.stderr);
  assert.ok(fx.state().container);
  assert.match(result.stderr, /LOCAL_CI_OWNERSHIP_UNKNOWN.*inspection_failed/);
});

test('a captured successful create ID cleans even when ownership inspect is unavailable', (t) => {
  const fx = fixture(t, { failure: 'ownership-inspect' });
  assert.equal(fx.run().status, 86);
  assert.equal(fx.state().volumes.anonymous, false);
});

test('--keep-containers retains container, network and all volumes on failure', (t) => {
  const fx = fixture(t);
  const result = fx.run(['--keep-containers']);
  assert.equal(result.status, 86, result.stderr);
  assert.ok(fx.state().container);
  assert.ok(fx.state().network);
  assert.equal(fx.state().volumes.anonymous, true);
  assert.ok(!fs.existsSync(path.join(fx.root, 'servora-med-local-ci.lock')));
  assert.equal(fs.readFileSync(path.join(fx.bundle, 'logs/aux/cleanup.status'), 'utf8'), 'PASS\n');
});

for (const holder of ['pid=2147483647 nonce=stale', `pid=${process.pid} nonce=live`]) {
  test(`existing lock fails closed: ${holder}`, (t) => {
    const fx = fixture(t);
    const lock = path.join(fx.root, 'servora-med-local-ci.lock');
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'pid'), holder + '\n');
    fs.mkdirSync(fx.bundle, { recursive: true });
    fs.writeFileSync(path.join(fx.bundle, 'sentinel'), 'original evidence');
    const result = fx.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /LOCAL_CI_ALREADY_RUNNING/);
    assert.equal(fs.readFileSync(path.join(lock, 'pid'), 'utf8'), holder + '\n');
    assert.equal(fs.readFileSync(path.join(fx.bundle, 'sentinel'), 'utf8'), 'original evidence');
    assert.equal(fx.state().container, undefined);
  });
}

test('context mismatch stops before resource creation or evidence relocation', (t) => {
  const fx = fixture(t);
  fs.mkdirSync(fx.bundle, { recursive: true });
  fs.writeFileSync(path.join(fx.bundle, 'sentinel'), 'original evidence');
  const result = fx.run([], { DOCKER_CONTEXT: 'foreign-project' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /DOCKER_CONTEXT_MISMATCH/);
  assert.equal(fx.state().network, undefined);
  assert.equal(fs.readFileSync(path.join(fx.bundle, 'sentinel'), 'utf8'), 'original evidence');
});

test('DOCKER_HOST override cannot silently bypass context selection', (t) => {
  const fx = fixture(t);
  const result = fx.run([], { DOCKER_HOST: 'unix:///foreign/docker.sock' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /DOCKER_CONTEXT_MISMATCH/);
  assert.equal(fx.state().network, undefined);
});

test('provisioning and cleanup use the endpoint resolved at preflight', (t) => {
  const fx = fixture(t);
  assert.equal(fx.run().status, 86);
  const daemonCalls = fx.calls().filter((c) => !c.args.includes('context'));
  assert.ok(daemonCalls.length > 5);
  for (const call of daemonCalls) {
    assert.equal(call.host, 'unix:///fixture/docker.sock');
    assert.equal(call.context, undefined);
    assert.deepEqual(call.args.slice(0, 2), ['--host', 'unix:///fixture/docker.sock']);
  }
});

test('retry preserves the complete previous bundle before provisioning', (t) => {
  const fx = fixture(t);
  fs.mkdirSync(path.join(fx.bundle, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(fx.bundle, 'logs/failed.log'), 'failure bytes\u0000\n');
  fs.writeFileSync(path.join(fx.bundle, 'manifest.json'), '{"result":"FAIL"}');
  assert.equal(fx.run().status, 86);
  const previous = path.join(fx.evidence, 'previous', fx.sha);
  const archived = path.join(previous, fs.readdirSync(previous)[0]);
  assert.equal(fs.readFileSync(path.join(archived, 'logs/failed.log'), 'utf8'), 'failure bytes\u0000\n');
  assert.equal(fs.readFileSync(path.join(archived, 'manifest.json'), 'utf8'), '{"result":"FAIL"}');
  assert.ok(!fs.existsSync(path.join(fx.bundle, 'logs/failed.log')));
});

test('cleanup failures are recorded without masking the original CI failure', (t) => {
  const fx = fixture(t, { failure: 'cleanup' });
  const result = fx.run();
  assert.equal(result.status, 86);
  assert.match(result.stderr, /LOCAL_CI_CLEANUP_FAILED.*exit=7.*fixture removal denied/);
  assert.match(fs.readFileSync(path.join(fx.bundle, 'logs/aux/cleanup.log'), 'utf8'), /exit=7/);
  assert.equal(fs.readFileSync(path.join(fx.bundle, 'logs/aux/cleanup.status'), 'utf8'), 'FAIL\n');
  assert.ok(fx.state().container);
});

for (const keep of [false, true]) {
  test(`daemon identity change fails closed before cleanup mutations (keep=${keep})`, (t) => {
    const fx = fixture(t, { failure: 'daemon-change' });
    const result = fx.run(keep ? ['--keep-containers'] : []);
    assert.equal(result.status, 86);
    assert.match(result.stderr, /DOCKER_DAEMON_MISMATCH/);
    assert.ok(fx.state().container);
    assert.ok(!fx.calls().some((c) => c.args.includes('rm')));
    assert.equal(fs.readFileSync(path.join(fx.bundle, 'logs/aux/cleanup.status'), 'utf8'), 'FAIL\n');
  });
}

test('partial network with a foreign run label is never removed', (t) => {
  const fx = fixture(t, { failure: 'partial-network', foreignLabel: true });
  const result = fx.run();
  assert.equal(result.status, 125);
  assert.ok(fx.state().network);
  assert.match(result.stderr, /LOCAL_CI_OWNERSHIP_UNKNOWN.*label_mismatch/);
  assert.ok(!fx.calls().some((c) => c.args.includes('rm')));
});

test('guest behavior gate rejects a different daemon before executing checks', (t) => {
  const fx = fixture(t);
  fs.mkdirSync(path.join(fx.repo, 'server'));
  fs.writeFileSync(path.join(fx.root, 'bin/colima'), '#!/bin/bash\nif [[ "$*" == *"docker info"* ]]; then echo foreign-guest-daemon; fi\n', { mode: 0o755 });
  const result = spawnSync('/bin/bash', [path.join(fx.repo, 'ops/local-ci/docker-gated.sh'), '--repo', fx.repo, '--logs', path.join(fx.root, 'gate-logs')], { env: fx.env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /DOCKER_DAEMON_MISMATCH/);
  assert.ok(!fx.calls().some((c) => c.args.includes('run')));
});

test('host behavior gate propagates the pinned endpoint to every child script', (t) => {
  const fx = fixture(t);
  fs.mkdirSync(path.join(fx.repo, 'server'));
  fs.mkdirSync(path.join(fx.repo, 'ops/ci'));
  fs.writeFileSync(path.join(fx.root, 'bin/colima'), '#!/bin/bash\nexit 1\n', { mode: 0o755 });
  for (const name of ['verify-caddyfile', 'verify-sse-streaming-behavior', 'verify-tunnel-caddyfile', 'verify-tunnel-caddy-behavior', 'verify-cloudflared-ingress']) {
    fs.writeFileSync(path.join(fx.repo, `ops/ci/${name}.sh`), '#!/bin/bash\ndocker info --format "{{.ID}}"\n');
  }
  const result = spawnSync('/bin/bash', [path.join(fx.repo, 'ops/local-ci/docker-gated.sh'), '--repo', fx.repo, '--logs', path.join(fx.root, 'gate-logs')], { env: fx.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const calls = fx.calls().filter((c) => !c.args.includes('context'));
  assert.ok(calls.length >= 6);
  for (const c of calls) {
    assert.equal(c.host, 'unix:///fixture/docker.sock');
    assert.equal(c.context, undefined);
  }
});

test('a shared anonymous volume remains attached to its other owner', (t) => {
  const fx = fixture(t, { sharedAnonymous: true });
  assert.equal(fx.run().status, 86);
  assert.equal(fx.state().container, null);
  assert.equal(fx.state().volumes.anonymous, true);
  assert.equal(fx.state().volumes['named-db'], true);
});

for (const missing of [false, true]) {
  test(`lost lock ownership protects resources and evidence (missing=${missing})`, (t) => {
    const fx = fixture(t);
    const change = missing ? 'rm -- "$TMPDIR/servora-med-local-ci.lock/pid"' : 'echo "pid=1 nonce=foreign" > "$TMPDIR/servora-med-local-ci.lock/pid"';
    fs.writeFileSync(path.join(fx.root, 'bin/git'), `#!/bin/bash\nfor arg in "$@"; do if [[ "$arg" == archive ]]; then ${change}; ${shellQuote(realGit)} "$@"; exit 86; fi; done\nexec ${shellQuote(realGit)} "$@"\n`);
    const result = fx.run();
    assert.equal(result.status, 86);
    assert.match(result.stderr, /ownership unknown/);
    assert.ok(fx.state().container);
    assert.ok(fx.state().network);
    assert.ok(fs.existsSync(path.join(fx.bundle, 'logs/aux/cleanup.log')));
    assert.ok(fs.readdirSync(fx.bundle).some((f) => f.startsWith('tree-export.')));
    assert.ok(fs.existsSync(path.join(fx.root, 'servora-med-local-ci.lock')));
    assert.ok(!fx.calls().some((c) => c.args.includes('rm')));
  });
}

test('cleanup failure preserves a successful CI exit status too', (t) => {
  const fx = fixture(t, { failure: 'cleanup' });
  const script = `source "$1"
ci_pin_docker_daemon
KEEP=false; RUN_ID=fixture; NET=fixture-net; PG=fixture-pg
NET_ID=""; PG_ID=""; EXPORT_CREATED=false
LOCAL_CI_LOCK_DIR="$TMPDIR/servora-med-local-ci.lock"
LOCAL_CI_LOCK_CLAIM='pid=1 nonce=fixture'
mkdir "$LOCAL_CI_LOCK_DIR"
echo "$LOCAL_CI_LOCK_CLAIM" >"$LOCAL_CI_LOCK_DIR/pid"
trap cleanup EXIT
ci_create_run_resources
exit 0`;
  const result = spawnSync('/bin/bash', ['-c', script, 'fixture', path.join(fx.repo, 'ops/local-ci/run.sh')], { env: fx.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /LOCAL_CI_CLEANUP_FAILED.*exit=7/);
});

test('an active entrypoint excludes a second process without moving its evidence', async (t) => {
  const fx = fixture(t);
  fs.writeFileSync(path.join(fx.root, 'bin/git'), `#!/bin/bash\nfor arg in "$@"; do if [[ "$arg" == archive ]]; then touch "$TMPDIR/archive-entered"; while [[ ! -f "$TMPDIR/archive-release" ]]; do sleep 0.02; done; ${shellQuote(realGit)} "$@"; exit 86; fi; done\nexec ${shellQuote(realGit)} "$@"\n`);
  const child = spawn('/bin/bash', fx.runArgs, { env: fx.env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const completed = new Promise((resolve) => child.once('exit', resolve));
  for (let i = 0; i < 500 && !fs.existsSync(path.join(fx.root, 'archive-entered')); i++) await delay(20);
  assert.ok(fs.existsSync(path.join(fx.root, 'archive-entered')), stderr);
  const loser = fx.run();
  assert.equal(loser.status, 1);
  assert.match(loser.stderr, /LOCAL_CI_ALREADY_RUNNING/);
  assert.ok(!fs.existsSync(path.join(fx.evidence, 'previous')));
  fs.writeFileSync(path.join(fx.root, 'archive-release'), 'release');
  assert.equal(await completed, 86, stderr);
  assert.equal(fx.state().container, null);
  assert.equal(fx.state().network, null);
});
