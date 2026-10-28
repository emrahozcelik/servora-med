// Wiring/policy integrity. Stateful behavior is covered by the actual
// entrypoint tests in ci-resource-lifecycle.test.mjs (no real Docker required).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import './ci-cache.test.mjs';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

function evidenceFixture(t, status = 'PASS') {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'servora-cleanup-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sha = 'a'.repeat(40), tree = 'b'.repeat(40);
  const bundle = path.join(root, sha);
  fs.mkdirSync(path.join(bundle, 'logs/aux'), { recursive: true });
  const required = read('ops/local-ci/required-checks.txt').split('\n').filter((l) => l && !l.startsWith('#'));
  for (const id of required) {
    fs.writeFileSync(path.join(bundle, `logs/${id}.log`), `synthetic ${id}\n`);
    fs.writeFileSync(path.join(bundle, `logs/${id}.exit`), '0\n');
  }
  const assembled = spawnSync(process.execPath, [path.join(REPO, 'ops/local-ci/assemble-manifest.mjs'),
    '--bundle', bundle, '--sha', sha, '--tree', tree, '--os', 'fixture', '--arch', 'fixture', '--node', process.version,
    '--compat-detail', JSON.stringify({ productionPackages: 1, nativeBinaries: 0, osRestricted: 0, cpuRestricted: 0, linuxAmd64: { result: 'pass', productionPackages: 1 } })], { encoding: 'utf8' });
  assert.equal(assembled.status, 0, assembled.stderr);
  fs.writeFileSync(path.join(bundle, 'logs/aux/cleanup.log'), 'synthetic cleanup\n');
  fs.writeFileSync(path.join(bundle, 'logs/aux/cleanup.status'), status + '\n');
  const manifestPath = path.join(bundle, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  const entry = (file) => ({ path: file, sha256: createHash('sha256').update(fs.readFileSync(path.join(bundle, file))).digest('hex') });
  manifest.cleanup = { result: status, mode: 'remove', log: entry('logs/aux/cleanup.log'), status: entry('logs/aux/cleanup.status') };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const verify = () => spawnSync('bash', [path.join(REPO, 'ops/local-ci/verify-evidence.sh'), '--evidence-root', root, '--sha', sha, '--tree', tree], { encoding: 'utf8' });
  return { root, bundle, sha, tree, manifestPath, manifest, verify };
}

function finishCleanup(fx, { code = 0, keep = false, failure = '' } = {}) {
  delete fx.manifest.cleanup;
  fs.writeFileSync(fx.manifestPath, JSON.stringify(fx.manifest));
  return spawnSync('bash', ['-c', `source "$1"
BUNDLE="$2"; CLEANUP_LOG="$BUNDLE/logs/aux/cleanup.log"
LOCAL_CI_LOCK_DIR="$3/lock"; LOCAL_CI_LOCK_CLAIM=fixture
mkdir "$LOCAL_CI_LOCK_DIR"; echo fixture >"$LOCAL_CI_LOCK_DIR/pid"
KEEP="$4"; PG_ID=fixture-pg; NET_ID=""; EXPORT_CREATED=false
ci_assert_docker_daemon() { :; }
ci_cleanup_command() { :; }
if [[ "$5" == resource ]]; then ci_cleanup_command() { return 7; }; fi
if [[ "$5" == finalize ]]; then node() { return 73; }; fi
if [[ "$5" == lock ]]; then rmdir() { return 1; }; fi
if [[ "$5" == status ]]; then ci_write_cleanup_status() { echo 'Permission denied (EACCES)' >&2; return 1; }; fi
if [[ "$5" == daemon ]]; then ci_assert_docker_daemon() { echo DOCKER_DAEMON_MISMATCH >&2; return 1; }; fi
trap cleanup EXIT
exit "$6"`, 'cleanup-fixture', path.join(REPO, 'ops/local-ci/run.sh'), fx.bundle, fx.root, String(keep), failure, String(code)], { encoding: 'utf8' });
}

test('CI PASS plus cleanup FAIL is rejected by the evidence acceptance gate', (t) => {
  const fx = evidenceFixture(t, 'FAIL');
  const result = fx.verify();
  assert.notEqual(result.status, 0, '27 PASS checks must not authorize failed cleanup');
  assert.match(result.stderr, /EVIDENCE_CLEANUP_NOT_PASS/);
});

test('cleanup status bytes are mandatory hash-bound evidence', (t) => {
  const fx = evidenceFixture(t);
  fs.writeFileSync(path.join(fx.bundle, 'logs/aux/cleanup.status'), 'FAIL\n');
  const result = fx.verify();
  assert.notEqual(result.status, 0, 'a manifest PASS cannot hide changed cleanup status');
  assert.match(result.stderr, /EVIDENCE_CLEANUP_INVALID/);
});

test('the real EXIT trap finalizes cleanup evidence without changing CI exit', (t) => {
  const fx = evidenceFixture(t);
  const result = finishCleanup(fx);
  assert.equal(result.status, 0, result.stderr);
  const finalized = JSON.parse(fs.readFileSync(fx.manifestPath));
  assert.equal(finalized.cleanup?.result, 'PASS', 'trap must seal the completed cleanup');
  assert.equal(finalized.cleanup.mode, 'remove');
  assert.equal(fx.verify().status, 0);
});

test('missing, invalid or tampered cleanup files and metadata fail closed', (t) => {
  const mutations = [
    (f) => fs.rmSync(path.join(f.bundle, 'logs/aux/cleanup.status')),
    (f) => fs.writeFileSync(path.join(f.bundle, 'logs/aux/cleanup.status'), 'UNKNOWN\n'),
    (f) => fs.writeFileSync(path.join(f.bundle, 'logs/aux/cleanup.status'), 'PASS\n\n'),
    (f) => fs.rmSync(path.join(f.bundle, 'logs/aux/cleanup.log')),
    (f) => fs.appendFileSync(path.join(f.bundle, 'logs/aux/cleanup.log'), 'changed'),
    (f) => { delete f.manifest.cleanup; fs.writeFileSync(f.manifestPath, JSON.stringify(f.manifest)); },
    (f) => { f.manifest.cleanup.status.path = '../foreign'; fs.writeFileSync(f.manifestPath, JSON.stringify(f.manifest)); },
  ];
  for (const mutate of mutations) {
    const fx = evidenceFixture(t);
    mutate(fx);
    const result = fx.verify();
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /EVIDENCE_CLEANUP|MANIFEST_FIELD_MISSING_cleanup/);
  }
});

test('CI FAIL plus cleanup PASS remains rejected with the original exit', (t) => {
  const fx = evidenceFixture(t);
  fx.manifest.result = 'FAIL';
  const result = finishCleanup(fx, { code: 86 });
  assert.equal(result.status, 86, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(fx.manifestPath)).cleanup.result, 'PASS');
  assert.match(fx.verify().stderr, /EVIDENCE_RESULT_NOT_PASS/);
});

test('intentional --keep-containers is recorded and accepted with PASS', (t) => {
  const fx = evidenceFixture(t);
  const result = finishCleanup(fx, { keep: true });
  assert.equal(result.status, 0, result.stderr);
  const m = JSON.parse(fs.readFileSync(fx.manifestPath));
  assert.equal(m.cleanup.mode, 'keep-containers');
  assert.equal(m.cleanup.result, 'PASS');
  assert.match(fs.readFileSync(path.join(fx.bundle, 'logs/aux/cleanup.log'), 'utf8'), /LOCAL_CI_CLEANUP_KEPT/);
  assert.equal(fx.verify().status, 0);
});

test('--keep-containers daemon mismatch refuses otherwise passing evidence', (t) => {
  const fx = evidenceFixture(t);
  const result = finishCleanup(fx, { keep: true, failure: 'daemon' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /DOCKER_DAEMON_MISMATCH/);
  const m = JSON.parse(fs.readFileSync(fx.manifestPath));
  assert.equal(m.cleanup.mode, 'keep-containers');
  assert.equal(m.cleanup.result, 'FAIL');
  assert.notEqual(fx.verify().status, 0);
});

test('resource, finalization and lock-release errors prevent acceptance without masking CI PASS', (t) => {
  for (const failure of ['resource', 'finalize', 'lock']) {
    const fx = evidenceFixture(t);
    const result = finishCleanup(fx, { failure });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(fx.bundle, 'logs/aux/cleanup.status'), 'utf8'), 'FAIL\n');
    assert.notEqual(fx.verify().status, 0, failure);
  }
});

test('legacy schema-1 evidence is retained byte-for-byte and refused without a downgrade', (t) => {
  const fx = evidenceFixture(t);
  fx.manifest.schemaVersion = 1;
  delete fx.manifest.cleanup;
  fs.writeFileSync(fx.manifestPath, JSON.stringify(fx.manifest));
  const before = fs.readFileSync(fx.manifestPath);
  const result = fx.verify();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SCHEMA_MISMATCH/);
  assert.deepEqual(fs.readFileSync(fx.manifestPath), before);
});

test('an unwritable status file cannot reuse a stale PASS', (t) => {
  const fx = evidenceFixture(t);
  // Stub the write boundary instead of permission bits: UID 0 bypasses chmod.
  const result = finishCleanup(fx, { failure: 'status' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /EACCES/);
  assert.match(result.stderr, /LOCAL_CI_CLEANUP_STATUS_WRITE_FAILED/);
  assert.equal(fs.readFileSync(path.join(fx.bundle, 'logs/aux/cleanup.status'), 'utf8'), 'PASS\n');
  assert.notEqual(fx.verify().status, 0);
});

test('deployment local evidence selection cannot bypass cleanup rejection', (t) => {
  const fx = evidenceFixture(t, 'FAIL');
  // CI source is a git archive, so construct the live-repository boundary
  // explicitly rather than relying on metadata in the checkout under test.
  const repo = path.join(fx.root, 'source');
  fs.mkdirSync(path.join(repo, 'ops'), { recursive: true });
  fs.cpSync(path.join(REPO, 'ops/local-ci'), path.join(repo, 'ops/local-ci'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'ops/deploy-production.sh'), path.join(repo, 'ops/deploy-production.sh'));
  const git = (...args) => {
    const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture');
  const head = git('rev-parse', 'HEAD');
  fx.manifest.sha = head;
  fx.manifest.tree = git('rev-parse', 'HEAD^{tree}');
  fs.writeFileSync(fx.manifestPath, JSON.stringify(fx.manifest));
  const bundle = path.join(fx.root, head);
  fs.renameSync(fx.bundle, bundle);
  for (const selected of ['', bundle, path.join(bundle, 'manifest.json')]) {
    const result = spawnSync('bash', ['-c', `source "$1"
SHA="$2"; CI_MODE=local; EVIDENCE_ROOT="$3"; EVIDENCE="$4"
verify_local_evidence
echo SHOULD_NOT_ACCEPT`, 'deploy-gate-fixture', path.join(repo, 'ops/deploy-production.sh'), head, fx.root, selected], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /LOCAL_EVIDENCE_NOT_VERIFIED/);
    assert.match(result.stdout + result.stderr, /EVIDENCE_CLEANUP_NOT_PASS/);
    assert.doesNotMatch(result.stdout, /SHOULD_NOT_ACCEPT/);
  }
});

test('local CI wires its lifecycle tests and every one of the 27 mandatory producers', () => {
  const run = read('ops/local-ci/run.sh');
  assert.match(run, /ci_create_run_resources/);
  assert.match(run, /ci_cleanup_run_resources/);
  const chain = read('ops/local-ci/chains/server-chain-user.sh');
  assert.match(chain, /ci-resource-lifecycle\.test\.mjs/);
  assert.match(chain, /lib\/resource-cleanup\.sh/);
  assert.match(chain, /local-ci\/docker-gated\.sh/);
  const required = read('ops/local-ci/required-checks.txt').split('\n').filter((l) => l && !l.startsWith('#'));
  assert.equal(required.length, 27);
  assert.equal(new Set(required).size, 27);
  const producers = ['ops/local-ci/chains/server-chain-user.sh', 'ops/local-ci/chains/web-chain.sh', 'ops/local-ci/docker-gated.sh']
    .flatMap((p) => [...read(p).matchAll(/^\s*(?:check|run_one)\s+([a-z0-9-]+)\s+--\s+\S/gm)].map((m) => m[1]));
  assert.match(run, /node \/repo\/ops\/benchmarks\/auth-kdf-benchmark\.mjs --mode=smoke/);
  assert.match(run, /chains\/linux-amd64-compat\.sh/);
  producers.push('benchmark-smoke', 'linux-compat');
  assert.deepEqual([...new Set(producers)].sort(), required.sort());
});

test('resource cleanup has no global prune or volume-label anonymity inference', () => {
  const source = read('ops/local-ci/lib/resource-cleanup.sh').split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');
  assert.doesNotMatch(source, /(?:volume|system) prune|colima delete|limactl delete/);
  assert.doesNotMatch(source, /volume (?:inspect|rm)|ci_is_removable_volume|ci_list_container_volumes/);
});
