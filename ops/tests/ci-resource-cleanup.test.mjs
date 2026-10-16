// ci-resource-cleanup.test.mjs — ownership-scoped local-CI resource cleanup.
//
// Runs lib/resource-cleanup.sh against a fake `docker` executable and asserts
// that only run-owned resources are removed. No real Docker interaction.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const REPO = new URL('../..', import.meta.url).pathname;
const LIB = path.join(REPO, 'ops/local-ci/lib/resource-cleanup.sh');

// Build an isolated fixture: lock dir with claim, export dir, evidence logs,
// and a fake docker(1) that records invocations and serves canned answers.
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-cleanup-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const calls = path.join(dir, 'calls.log');
  const canned = path.join(dir, 'canned');
  fs.mkdirSync(canned);
  // Fake docker: log argv, then answer inspect queries from canned files.
  fs.writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env bash
echo "$*" >> ${JSON.stringify(calls)}
if [[ "$1" == "inspect" || "$2" == "inspect" ]]; then
  if [[ "$*" == *".Mounts"* ]]; then cat ${JSON.stringify(path.join(canned, 'mounts'))} 2>/dev/null || true; exit 0; fi
  if [[ "$*" == *".Labels"* ]]; then
    name="\${@: -1}"
    cat ${JSON.stringify(canned)}/"labels-\${name}" 2>/dev/null || { echo "No such volume" >&2; exit 1; }
    exit 0
  fi
fi
exit 0
`);
  fs.chmodSync(path.join(bin, 'docker'), 0o755);
  const lockDir = path.join(dir, 'lock');
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, 'pid'), 'pid=999 nonce=1-2\n');
  const exportDir = path.join(dir, 'export');
  fs.mkdirSync(exportDir);
  const bundle = path.join(dir, 'bundle');
  fs.mkdirSync(path.join(bundle, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(bundle, 'logs', 'server-tests.log'), 'evidence');
  return { dir, bin, calls, canned, lockDir, exportDir, bundle };
}

function runCleanup(fx, vars) {
  const claim = 'pid=999 nonce=1-2';
  fs.writeFileSync(path.join(fx.lockDir, 'pid'), claim + '\n');
  const env = {
    ...process.env,
    PATH: `${fx.bin}:/usr/bin:/bin`,
    DOCKER_BIN: 'docker',
    LOCAL_CI_LOCK_DIR: fx.lockDir,
    LOCAL_CI_LOCK_CLAIM: claim,
    KEEP: 'false',
    PG: 'servora-localci-pg-1-2',
    NET: 'servora-localci-1-2',
    PG_CREATED: 'false',
    NET_CREATED: 'false',
    PG_VOLUMES: '',
    EXPORT_CREATED: 'false',
    EXPORT_DIR: fx.exportDir,
    ...vars,
  };
  const r = spawnSync('bash', ['-c', `source ${JSON.stringify(LIB)} && ci_cleanup_run_resources`], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, `cleanup failed: ${r.stderr}`);
  const logged = fs.existsSync(fx.calls) ? fs.readFileSync(fx.calls, 'utf8') : '';
  return { logged, stderr: r.stderr };
}

const dockerCalls = (logged) => logged.split('\n').filter(Boolean);

test('successful cleanup removes the owned container, network and anonymous volumes', () => {
  const fx = fixture();
  fs.writeFileSync(path.join(fx.canned, 'mounts'), 'aaaabbbb\n');
  fs.writeFileSync(path.join(fx.canned, 'labels-aaaabbbb'), '{"com.docker.volume.anonymous":""}');
  const { logged } = runCleanup(fx, { PG_CREATED: 'true', NET_CREATED: 'true', PG_VOLUMES: 'aaaabbbb', EXPORT_CREATED: 'true' });
  const calls = dockerCalls(logged);
  assert.ok(calls.some((c) => c === 'rm -f servora-localci-pg-1-2'), `pg removed:\n${logged}`);
  assert.ok(calls.some((c) => c === 'volume rm aaaabbbb'), `anon volume removed:\n${logged}`);
  assert.ok(calls.some((c) => c === 'network rm servora-localci-1-2'), `network removed:\n${logged}`);
  assert.ok(!fs.existsSync(fx.exportDir), 'run-owned export dir removed');
  assert.ok(!fs.existsSync(fx.lockDir), 'lock released');
  assert.ok(fs.existsSync(path.join(fx.bundle, 'logs', 'server-tests.log')), 'evidence logs preserved');
});

test('failed runs still clean owned volumes but keep every evidence byte', () => {
  const fx = fixture();
  fs.writeFileSync(path.join(fx.canned, 'mounts'), 'vvv\n');
  fs.writeFileSync(path.join(fx.canned, 'labels-vvv'), 'null');
  const { logged } = runCleanup(fx, { PG_CREATED: 'true', NET_CREATED: 'false', PG_VOLUMES: 'vvv', EXPORT_CREATED: 'false' });
  const calls = dockerCalls(logged);
  assert.ok(calls.some((c) => c === 'rm -f servora-localci-pg-1-2'), `pg removed:\n${logged}`);
  assert.ok(calls.some((c) => c === 'volume rm vvv'), `anon volume removed:\n${logged}`);
  assert.ok(!calls.some((c) => c.startsWith('network rm')), `no network call:\n${logged}`);
  assert.ok(fs.existsSync(path.join(fx.bundle, 'logs', 'server-tests.log')), 'evidence logs preserved');
  assert.ok(!fs.existsSync(fx.lockDir), 'lock released');
});

test('labeled named/shared volumes are preserved while the owned container is removed', () => {
  const fx = fixture();
  fs.writeFileSync(path.join(fx.canned, 'labels-shared-data'), '{"com.example":"shared-db"}');
  const { logged, stderr } = runCleanup(fx, { PG_CREATED: 'true', PG_VOLUMES: 'shared-data' });
  const calls = dockerCalls(logged);
  assert.ok(calls.some((c) => c === 'rm -f servora-localci-pg-1-2'), `pg removed:\n${logged}`);
  assert.ok(!calls.some((c) => c.includes('shared-data') && c.startsWith('volume rm')), `shared volume kept:\n${logged}`);
  assert.match(stderr, /keeping non-anonymous volume shared-data/);
});

test('--keep-containers preserves containers, networks and their volumes', () => {
  const fx = fixture();
  fs.writeFileSync(path.join(fx.canned, 'labels-keepme'), '{"com.docker.volume.anonymous":""}');
  const claim = 'pid=999 nonce=1-2';
  fs.writeFileSync(path.join(fx.lockDir, 'pid'), claim + '\n');
  const env = {
    ...process.env, PATH: `${fx.bin}:/usr/bin:/bin`, DOCKER_BIN: 'docker',
    LOCAL_CI_LOCK_DIR: fx.lockDir, LOCAL_CI_LOCK_CLAIM: claim, KEEP: 'true',
    PG: 'servora-localci-pg-1-2', NET: 'servora-localci-1-2',
    PG_CREATED: 'true', NET_CREATED: 'true', PG_VOLUMES: 'keepme',
    EXPORT_CREATED: 'true', EXPORT_DIR: fx.exportDir,
  };
  const r = spawnSync('bash', ['-c', `source ${JSON.stringify(LIB)} && ci_cleanup_run_resources`], { env, encoding: 'utf8' });
  assert.equal(r.status, 0);
  const logged = fs.existsSync(fx.calls) ? fs.readFileSync(fx.calls, 'utf8') : '';
  assert.ok(!dockerCalls(logged).some((c) => /^(rm|volume rm|network rm)/.test(c)), `no removals:\n${logged}`);
  assert.ok(!fs.existsSync(fx.lockDir), 'lock released');
  assert.ok(!fs.existsSync(fx.exportDir), 'run-owned export still removed');
});

test('unknown lock ownership leaves every resource in place', () => {
  const fx = fixture();
  fs.writeFileSync(path.join(fx.lockDir, 'pid'), 'pid=1 nonce=concurrent-run\n');
  const claim = 'pid=999 nonce=1-2';
  const env = {
    ...process.env, PATH: `${fx.bin}:/usr/bin:/bin`, DOCKER_BIN: 'docker',
    LOCAL_CI_LOCK_DIR: fx.lockDir, LOCAL_CI_LOCK_CLAIM: claim, KEEP: 'false',
    PG: 'servora-localci-pg-1-2', NET: 'servora-localci-1-2',
    PG_CREATED: 'true', NET_CREATED: 'true', PG_VOLUMES: 'whatever',
    EXPORT_CREATED: 'true', EXPORT_DIR: fx.exportDir,
  };
  const r = spawnSync('bash', ['-c', `source ${JSON.stringify(LIB)} && ci_cleanup_run_resources`], { env, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /ownership unknown/);
  const logged = fs.existsSync(fx.calls) ? fs.readFileSync(fx.calls, 'utf8') : '';
  assert.equal(dockerCalls(logged).length, 0, `docker untouched:\n${logged}`);
  assert.ok(fs.existsSync(fx.lockDir), 'foreign lock not released');
  assert.ok(fs.existsSync(fx.exportDir), 'export kept without ownership');
});

test('partial creation only addresses resources this run actually created', () => {
  const fx = fixture();
  const { logged } = runCleanup(fx, { PG_CREATED: 'false', NET_CREATED: 'true', EXPORT_CREATED: 'false' });
  const calls = dockerCalls(logged);
  assert.ok(!calls.some((c) => c.startsWith('rm -f')), `no container call:\n${logged}`);
  assert.ok(!calls.some((c) => c.startsWith('volume rm')), `no volume call:\n${logged}`);
  assert.ok(calls.some((c) => c === 'network rm servora-localci-1-2'), `network removed:\n${logged}`);
  assert.ok(!fs.existsSync(fx.lockDir), 'lock released');
});

test('missing lock claim file fails closed without touching docker', () => {
  const fx = fixture();
  assert.ok(fs.existsSync(path.join(fx.lockDir, 'pid')), 'fixture writes the claim');
  fs.rmSync(path.join(fx.lockDir, 'pid'), { force: true });
  const claim = 'pid=999 nonce=1-2';
  const env = {
    ...process.env, PATH: `${fx.bin}:/usr/bin:/bin`, DOCKER_BIN: 'docker',
    LOCAL_CI_LOCK_DIR: fx.lockDir, LOCAL_CI_LOCK_CLAIM: claim, KEEP: 'false',
    PG: 'servora-localci-pg-1-2', NET: 'servora-localci-1-2',
    PG_CREATED: 'true', NET_CREATED: 'true', PG_VOLUMES: 'whatever',
    EXPORT_CREATED: 'true', EXPORT_DIR: fx.exportDir,
  };
  const r = spawnSync('bash', ['-c', `source ${JSON.stringify(LIB)} && ci_cleanup_run_resources`], { env, encoding: 'utf8' });
  assert.equal(r.status, 0);
  const logged = fs.existsSync(fx.calls) ? fs.readFileSync(fx.calls, 'utf8') : '';
  assert.equal(dockerCalls(logged).length, 0, `docker untouched:\n${logged}`);
  assert.ok(fs.existsSync(fx.exportDir), 'export kept without ownership');
});

test('ci_list_container_volumes reports mounts and stays empty on docker failure', () => {
  const fx = fixture();
  fs.writeFileSync(path.join(fx.canned, 'mounts'), 'vol-a vol-b\n');
  const env = { ...process.env, PATH: `${fx.bin}:/usr/bin:/bin`, DOCKER_BIN: 'docker' };
  const list = (container) => spawnSync('bash', ['-c', `source ${JSON.stringify(LIB)} && ci_list_container_volumes ${container}`], { env, encoding: 'utf8' });
  assert.equal(list('pg-ok').stdout.trim(), 'vol-a vol-b');
  fs.rmSync(path.join(fx.canned, 'mounts'));
  const failed = list('pg-gone');
  assert.equal(failed.status, 0);
  assert.equal(failed.stdout.trim(), '');
});

test('run.sh delegates cleanup to the tested lib and CI keeps all 27 gates wired', () => {
  const runSh = fs.readFileSync(path.join(REPO, 'ops/local-ci/run.sh'), 'utf8');
  assert.match(runSh, /lib\/resource-cleanup\.sh/);
  assert.match(runSh, /ci_cleanup_run_resources/);
  assert.match(runSh, /ci_list_container_volumes/);
  assert.ok(!/docker volume prune|system prune|--volumes/.test(runSh), 'no broad prune in run.sh');
  assert.ok(!/colima delete|limactl delete/.test(runSh), 'no VM deletion in run.sh');
  const chain = fs.readFileSync(path.join(REPO, 'ops/local-ci/chains/server-chain-user.sh'), 'utf8');
  assert.match(chain, /ci-resource-cleanup\.test\.mjs/);
  assert.match(chain, /lib\/resource-cleanup\.sh/);
  const checks = fs.readFileSync(path.join(REPO, 'ops/local-ci/required-checks.txt'), 'utf8')
    .split('\n').filter((l) => l && !l.startsWith('#'));
  assert.equal(checks.length, 27);
});
