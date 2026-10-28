import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const loader = join(root, 'ops/local-ci/load-prod-env.sh');
const deploy = join(root, 'ops/deploy-production.sh');
const pinned = 'deploy.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestOnly';

function credentialFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'servora-credential-safety-'));
  const key = join(dir, 'key');
  const hosts = join(dir, 'known_hosts');
  const envFile = join(dir, 'prod.env');
  writeFileSync(key, '-----BEGIN OPENSSH PRIVATE KEY-----\nsynthetic-key\n-----END OPENSSH PRIVATE KEY-----\n', { mode: 0o600 });
  writeFileSync(hosts, `${pinned}\n`, { mode: 0o600 });
  const config = (hostEntry = `SERVORA_PROD_KNOWN_HOSTS_FILE=${hosts}`) => {
    writeFileSync(envFile, `SERVORA_PROD_HOST=deploy.example\nSERVORA_PROD_SSH_USER=servora-deploy\nSERVORA_PROD_SSH_KEY_FILE=${key}\nSERVORA_PROD_FQDN=deploy.example\n${hostEntry}\n`, { mode: 0o600 });
  };
  config();
  return { dir, key, hosts, envFile, config, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function load(file: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync('bash', [loader, '--check', '--file', file], { encoding: 'utf8', env: { ...process.env, ...env } });
}

function validateDeployHosts(file: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync('bash', ['-c', 'source "$1"; PROD_HOST=deploy.example; SSH_USER=servora-deploy; SSH_KEY=synthetic; KNOWN_HOSTS_PATH="$2"; validate_host_identity', 'hosts-test', deploy, file], { encoding: 'utf8', env: { ...process.env, ...env } });
}

// Synthetic Docker/toolchain boundary; the runner, Git gates and assembler
// execute unchanged. No production credentials or network are used.
function runnerFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'servora-runner-safety-'));
  const repo = join(dir, 'repo');
  const ci = join(repo, 'ops/local-ci');
  cpSync(join(root, 'ops/local-ci'), ci, { recursive: true });
  // Cache lifecycle has its own Docker-boundary regressions in ci-cache.test.mjs.
  writeFileSync(join(ci, 'lib/cache.sh'), 'ci_prepare_caches() { WEB_PLATFORM=linux/arm64; WEB_ARCH=arm64; WEB_IMAGE_KEY=fixture; WEB_IMAGE_ID=fixture; SERVER_NPM_CACHE=fixture-server; WEB_NPM_CACHE=fixture-web; }\n');
  mkdirSync(join(repo, 'server'));
  mkdirSync(join(dir, 'bin'));
  const binary = (name: string, content: string) => writeFileSync(join(dir, 'bin', name), `#!/bin/bash\n${content}\n`, { mode: 0o755 });
  binary('node', `case "$1" in --version) echo v22.0.0 ;; -p) echo 22 ;; *) exec '${process.execPath}' "$@" ;; esac`);
  binary('npm', 'if [[ "$1" == --version ]]; then [[ ! -e "$FIXTURE_DIR/early-fail" ]] || exit 23; echo 10.0.0; fi');
  binary('docker', `
printf '%s\\n' "$*" >>"$FIXTURE_DIR/docker-calls"
# Mirror the pinned-context and create/start CLI boundary, not Docker itself.
if [[ "$1" == --host ]]; then shift 2; fi
case "$1 $2" in
  'context show') echo colima-true; exit 0 ;;
  'context inspect') echo unix:///fixture/docker.sock; exit 0 ;;
  'info --format') echo fixture-daemon; exit 0 ;;
  'network create') echo ${'a'.repeat(64)}; exit 0 ;;
esac
if [[ "$1" == create ]]; then echo ${'b'.repeat(64)}; exit 0; fi
if [[ "$*" == *'psql --version'* ]]; then echo 'psql (PostgreSQL) 17'; exit 0; fi
logs=''
for arg in "$@"; do case "$arg" in *:/logs) logs="\${arg%:/logs}" ;; esac; done
if [[ "$*" == *server-chain.sh* || "$*" == *web-chain.sh* ]]; then
  if [[ -e "$FIXTURE_DIR/chain-fail" && "$*" == *server-chain.sh* ]]; then
    echo 'synthetic server build failure' >"$logs/server-build.log"
    echo 7 >"$logs/server-build.exit"
    exit 7
  fi
  for id in $(cat "$FIXTURE_DIR/repo/ops/local-ci/required-checks.txt"); do
    case "$id" in server-*|web-*) [[ "$*" != *web-chain.sh* || "$id" == web-* ]] || continue; [[ "$*" != *server-chain.sh* || "$id" == server-* ]] || continue; echo synthetic >"$logs/$id.log"; echo 0 >"$logs/$id.exit" ;; esac
  done
fi
exit 0`);
  // Empty dependency set plus actual positive linux/amd64-shaped detail.
  writeFileSync(join(ci, 'verify-linux-compat.sh'), '#!/bin/bash\necho \'{"productionPackages":1,"nativeBinaries":0,"osRestricted":0,"cpuRestricted":0}\'\n');
  writeFileSync(join(ci, 'chains/linux-amd64-compat.sh'), '#!/bin/bash\necho \'{"platform":"linux/amd64","productionPackages":1,"result":"pass"}\'\n');
  writeFileSync(join(ci, 'docker-gated.sh'), '#!/bin/bash\nexit 0\n');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture']);
  const sha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const evidence = join(dir, 'evidence');
  const invoke = (script = join(ci, 'run.sh')) => spawnSync('bash', [script, '--repo', repo, '--sha', sha, '--evidence-root', evidence], {
    encoding: 'utf8', env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, TMPDIR: dir, FIXTURE_DIR: dir, DOCKER_CONTEXT: 'colima-true', DOCKER_HOST: undefined, LOCAL_CI_DOCKER_ENDPOINT: undefined, LOCAL_CI_DOCKER_DAEMON_ID: undefined },
  });
  return { dir, repo, sha, evidence, invoke, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('production credential safety reconciliation', () => {
  it('enforces the documented dedicated deployment account in loader and deploy', () => {
    const f = credentialFixture();
    try {
      const config = readFileSync(f.envFile, 'utf8');
      writeFileSync(f.envFile, config.replace('SSH_USER=servora-deploy', 'SSH_USER=ubuntu'));
      expect(load(f.envFile).status).not.toBe(0);
      const result = spawnSync('bash', ['-c', 'source "$1"; PROD_HOST=deploy.example; SSH_USER=ubuntu; SSH_KEY=synthetic; KNOWN_HOSTS_PATH="$2"; validate_host_identity', 'restricted-user', deploy, f.hosts], { encoding: 'utf8' });
      expect(result.status).not.toBe(0);
    } finally { f.cleanup(); }
  });
  it('rejects an untrusted known_hosts owner, symlinks and malformed content', () => {
    const f = credentialFixture();
    try {
      const bin = join(f.dir, 'bin');
      mkdirSync(bin);
      // Stat boundary stub: portable deterministic ownership failure without
      // chown/root privileges or touching any real production file.
      const stat = execFileSync('sh', ['-c', 'command -v stat'], { encoding: 'utf8' }).trim();
      writeFileSync(join(bin, 'stat'), `#!/bin/bash\nif [[ "$2" == %u && "$3" == '${f.hosts}' ]]; then echo 2147483647; else exec '${stat}' "$@"; fi\n`, { mode: 0o755 });
      const env = { PATH: `${bin}:${process.env.PATH}` };
      expect(load(f.envFile, env).status).not.toBe(0);
      expect(validateDeployHosts(f.hosts, env).status).not.toBe(0);
      for (const content of ['', '# comments only\n', 'unparseable\n']) {
        writeFileSync(f.hosts, content);
        expect(load(f.envFile).status).not.toBe(0);
        expect(validateDeployHosts(f.hosts).status).not.toBe(0);
      }
      rmSync(f.hosts);
      execFileSync('ln', ['-s', f.key, f.hosts]);
      expect(load(f.envFile).status).not.toBe(0);
      expect(validateDeployHosts(f.hosts).status).not.toBe(0);
    } finally { f.cleanup(); }
  });
  it('rechecks known_hosts permissions immediately before each SSH command', () => {
    const f = credentialFixture();
    try {
      const bin = join(f.dir, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'ssh'), '#!/bin/bash\necho SSH_WAS_CALLED\n', { mode: 0o755 });
      const result = spawnSync('bash', ['-c', 'source "$1"; KNOWN_HOSTS_FILE="$2"; SSH_OPTS=(-o BatchMode=yes); validate_known_hosts_file "$2"; chmod 620 "$2"; ssh_run true', 'recheck', deploy, f.hosts], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain('SSH_WAS_CALLED');
    } finally { f.cleanup(); }
  });
  it('clears inherited credential alternatives before exporting the validated configuration', () => {
    const f = credentialFixture();
    try {
      f.config(`SERVORA_PROD_KNOWN_HOSTS=${pinned}`);
      const inherited = {
        SERVORA_PROD_SSH_KEY: 'inherited-private-key',
        SERVORA_PROD_KNOWN_HOSTS_FILE: '/unvalidated/stale-hosts',
      };
      const result = spawnSync('bash', ['-ec', 'eval "$(bash "$1" --file "$2")"; test -z "${SERVORA_PROD_SSH_KEY+x}"; test -z "${SERVORA_PROD_KNOWN_HOSTS_FILE+x}"; test "$SERVORA_PROD_SSH_KEY_FILE" = "$3"; test "$SERVORA_PROD_KNOWN_HOSTS" = "$4"', 'isolation', loader, f.envFile, f.key, pinned], { encoding: 'utf8', env: { ...process.env, ...inherited } });
      expect(result.status).toBe(0);
      f.config();
      const fileResult = spawnSync('bash', ['-ec', 'eval "$(bash "$1" --file "$2")"; test -z "${SERVORA_PROD_KNOWN_HOSTS+x}"; test "$SERVORA_PROD_KNOWN_HOSTS_FILE" = "$3"', 'file-isolation', loader, f.envFile, f.hosts], { encoding: 'utf8', env: { ...process.env, SERVORA_PROD_KNOWN_HOSTS: 'stale-pinned-key' } });
      expect(fileResult.status).toBe(0);
    } finally { f.cleanup(); }
  });
  it('rejects group/other-writable known_hosts in loader and deploy preflight', () => {
    const f = credentialFixture();
    try {
      expect(load(f.envFile).status).toBe(0);
      expect(validateDeployHosts(f.hosts).status).toBe(0);
      for (const mode of [0o620, 0o602]) {
        chmodSync(f.hosts, mode);
        expect(load(f.envFile).status).not.toBe(0);
        expect(validateDeployHosts(f.hosts).status).not.toBe(0);
      }
    } finally { f.cleanup(); }
  });
});

async function waitForFile(file: string) {
  const deadline = Date.now() + 5000;
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for test barrier ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('deterministic deployment lock interleaving', () => {
  it('serializes callers with different TMPDIR values using the same machine lock', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'servora-global-lock-'));
    const owned = join(dir, 'owned');
    const release = join(dir, 'release');
    // Prefix the actual configured absolute path with a fixture root so this
    // exercises the default selection without touching the machine lock.
    const body = `source "$1"; printf '%s\\n' "$DEPLOY_LOCK_DIR";
DEPLOY_LOCK_DIR="$2/\${DEPLOY_LOCK_DIR#/}"; mkdir -p "$(dirname "$DEPLOY_LOCK_DIR")";
acquire_deploy_lock; : >"$3"; while [[ ! -e "$4" ]]; do sleep 0.01; done; release_deploy_lock`;
    const a = spawn('bash', ['-c', body, 'machine-lock', deploy, dir, owned, release],
      { env: { ...process.env, TMPDIR: '/tmp/operator-a' } });
    const done = new Promise<number | null>((resolve) => a.on('close', resolve));
    try {
      await waitForFile(owned);
      const b = spawnSync('bash', ['-c', `source "$1";
DEPLOY_LOCK_DIR="$2/\${DEPLOY_LOCK_DIR#/}"; mkdir -p "$(dirname "$DEPLOY_LOCK_DIR")";
acquire_deploy_lock; release_deploy_lock`, 'machine-lock', deploy, dir],
        { encoding: 'utf8', env: { ...process.env, TMPDIR: '/tmp/operator-b' } });
      expect(b.status).not.toBe(0);
      expect(b.stderr).toContain('CONCURRENT_DEPLOYMENT_ACTIVE');
      writeFileSync(release, 'go');
      expect(await done).toBe(0);
    } finally { a.kill(); rmSync(dir, { recursive: true, force: true }); }
  }, 15000);
  it('cannot steal a new owner after reading an older stale claim', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'servora-delayed-lock-'));
    const lock = join(dir, 'lock');
    mkdirSync(lock);
    writeFileSync(join(lock, 'pid'), '2147483647\n');
    const paused = join(dir, 'paused');
    const resume = join(dir, 'resume');
    const owned = join(dir, 'owned');
    const release = join(dir, 'release');
    const b = spawn('bash', ['-c', `source "$1"; DEPLOY_LOCK_DIR="$2"
pause_path="$3"; resume_path="$4"
cat() { local captured; captured="$(command cat "$@")"; : >"$pause_path"; while [[ ! -e "$resume_path" ]]; do sleep 0.01; done; printf '%s\\n' "$captured"; }
acquire_deploy_lock; echo B_ACQUIRED`, 'delayed', deploy, lock, paused, resume]);
    let bOutput = '';
    b.stdout.on('data', (data) => { bOutput += data; });
    const bDone = new Promise<number | null>((resolve) => b.on('close', resolve));
    let a: ReturnType<typeof spawn> | undefined;
    try {
      await waitForFile(paused);
      // Test-controlled replacement reproduces the reviewed TOCTOU window:
      // B holds an old observation while A already owns the current path.
      rmSync(lock, { recursive: true });
      a = spawn('bash', ['-c', 'source "$1"; DEPLOY_LOCK_DIR="$2"; acquire_deploy_lock; : >"$3"; while [[ ! -e "$4" ]]; do sleep 0.01; done; release_deploy_lock', 'owner', deploy, lock, owned, release]);
      const aDone = new Promise<number | null>((resolve) => a?.on('close', resolve));
      await waitForFile(owned);
      const aClaim = readFileSync(join(lock, 'pid'), 'utf8');
      writeFileSync(resume, 'go');
      expect(await bDone).not.toBe(0);
      expect(bOutput).not.toContain('B_ACQUIRED');
      expect(readFileSync(join(lock, 'pid'), 'utf8')).toBe(aClaim);
      writeFileSync(release, 'go');
      expect(await aDone).toBe(0);
      expect(existsSync(lock)).toBe(false);
    } finally {
      b.kill(); a?.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);
});

describe('local CI runner reconciliation', () => {
  it('rejects CI tools from another checkout before creating evidence or resources', () => {
    const f = runnerFixture();
    try {
      const result = f.invoke(join(root, 'ops/local-ci/run.sh'));
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('CI_TOOL_ROOT_MISMATCH');
      expect(existsSync(f.evidence)).toBe(false);
      expect(existsSync(join(f.dir, 'docker-calls'))).toBe(false);
    } finally { f.cleanup(); }
  });
  it('preserves locks and resources when cleanup cannot verify ownership', () => {
    const dir = mkdtempSync(join(tmpdir(), 'servora-cleanup-owner-'));
    try {
      const lock = join(dir, 'lock');
      const exported = join(dir, 'export');
      mkdirSync(lock); mkdirSync(exported);
      writeFileSync(join(lock, 'pid'), 'another-owner');
      const result = spawnSync('bash', ['-c', 'source "$1"; LOCAL_CI_LOCK_DIR="$2"; LOCAL_CI_LOCK_CLAIM=this-owner; EXPORT_DIR="$3"; EXPORT_CREATED=true; PG_CREATED=true; PG=other-pg; KEEP=false; docker() { echo DELETED; }; cleanup', 'unknown-owner', join(root, 'ops/local-ci/run.sh'), lock, exported], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain('DELETED');
      expect(existsSync(exported)).toBe(true);
      expect(readFileSync(join(lock, 'pid'), 'utf8')).toBe('another-owner');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('pins the server toolchain container to the downloaded age binary architecture', () => {
    const script = readFileSync(join(root, 'ops/local-ci/run.sh'), 'utf8');
    expect(script).toMatch(/docker run --platform linux\/amd64[^\n]*servora-localci-server/);
  });
  it('never persists credentials from a token-bearing origin URL', () => {
    const f = runnerFixture();
    try {
      const token = 'SYNTHETIC_TOKEN_DO_NOT_PERSIST';
      execFileSync('git', ['-C', f.repo, 'remote', 'add', 'origin', `https://operator:${token}@github.com/emrahozcelik/servora-med.git`]);
      const result = f.invoke();
      expect(result.status, result.stderr).toBe(0);
      const bundle = join(f.evidence, f.sha);
      const manifestText = readFileSync(join(bundle, 'manifest.json'), 'utf8');
      expect(JSON.parse(manifestText).repo).toBe('github.com/emrahozcelik/servora-med');
      expect(`${manifestText}${readFileSync(join(bundle, 'report.md'), 'utf8')}${result.stdout}${result.stderr}`).not.toContain(token);
      for (const name of readdirSync(join(bundle, 'logs'))) {
        if (name.endsWith('.log')) expect(readFileSync(join(bundle, 'logs', name), 'utf8')).not.toContain(token);
      }
    } finally { f.cleanup(); }
  });
  it('releases an early-failure lock, allows the next run and removes only its export', () => {
    const f = runnerFixture();
    try {
      writeFileSync(join(f.dir, 'early-fail'), 'fail');
      const early = f.invoke();
      expect(early.status).not.toBe(0);
      expect(existsSync(join(f.dir, 'servora-med-local-ci.lock'))).toBe(false);
      rmSync(join(f.dir, 'early-fail'));
      const next = f.invoke();
      expect(next.status, next.stderr).toBe(0);
      expect(existsSync(join(f.dir, 'servora-med-local-ci.lock'))).toBe(false);
      expect(readdirSync(join(f.evidence, f.sha)).filter((name) => name.startsWith('tree-export'))).toEqual([]);
      expect(existsSync(join(f.evidence, f.sha, 'logs/server-build.log'))).toBe(true);
      const calls = readFileSync(join(f.dir, 'docker-calls'), 'utf8');
      expect(calls).not.toContain('rm -f servora-localci-pg\n');
    } finally { f.cleanup(); }
  });
  it('publishes failed-chain evidence with FAIL/ABSENT and a nonzero exit', () => {
    const f = runnerFixture();
    try {
      writeFileSync(join(f.dir, 'chain-fail'), 'fail');
      const result = f.invoke();
      expect(result.status).not.toBe(0);
      const bundle = join(f.evidence, f.sha);
      expect(existsSync(join(bundle, 'manifest.json'))).toBe(true);
      expect(existsSync(join(bundle, 'report.md'))).toBe(true);
      const manifest = JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8'));
      expect(manifest.result).toBe('FAIL');
      expect(manifest.checks.find((c: { id: string }) => c.id === 'server-build').result).toBe('FAIL');
      expect(manifest.checks.find((c: { id: string }) => c.id === 'server-tests').result).toBe('ABSENT');
      expect(readFileSync(join(bundle, 'logs/server-build.log'), 'utf8')).toContain('synthetic server build failure');
    } finally { f.cleanup(); }
  });
});
