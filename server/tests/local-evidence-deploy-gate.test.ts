import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const runner = fileURLToPath(new URL('../../ops/deploy-production.sh', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const localCiDir = fileURLToPath(new URL('../../ops/local-ci/', import.meta.url));
const verifier = fileURLToPath(new URL('../../ops/local-ci/verify-evidence.sh', import.meta.url));

const REQUIRED_IDS = [
  'server-static-syntax', 'server-shellcheck', 'server-systemd-units',
  'server-backup-observation', 'server-operator-alerting', 'server-caddyfile',
  'server-sse-behavior', 'server-tunnel-caddyfile', 'server-tunnel-behavior',
  'server-cloudflared-ingress', 'server-env-examples', 'server-db-auth-contract',
  'server-build', 'server-dep-smoke', 'server-migrate-schema', 'server-tests',
  'server-audit', 'web-build', 'web-bundle', 'web-tests', 'web-playwright-install',
  'web-smoke-dist', 'web-smoke-responsive', 'web-geometry', 'web-audit',
  'benchmark-smoke', 'linux-compat',
];

const GOOD_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function sha256File(path: string) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function temporaryDirectory(prefix: string) {
  return mkdtempSync(join(tmpdir(), `servora-evidence-${prefix}-`));
}

/** Build a self-consistent evidence bundle; overrides mutate after hashing. */
function makeBundle(root: string, sha: string, tree: string, mutate?: (bundle: string) => void) {
  const bundle = join(root, sha);
  const logs = join(bundle, 'logs');
  mkdirSync(logs, { recursive: true });
  const checks = REQUIRED_IDS.map((id) => {
    const content = `log for ${id} at ${sha}\n`;
    writeFileSync(join(logs, `${id}.log`), content);
    return {
      id,
      command: `check ${id}`,
      exit: 0,
      result: 'PASS',
      log: `logs/${id}.log`,
      sha256: createHash('sha256').update(content).digest('hex'),
      tests: null,
      detail: id === 'linux-compat'
        ? { productionPackages: 10, nativeBinaries: 0, osRestricted: 0, cpuRestricted: 0, offenders: [], builderOs: 'linux', builderArch: 'arm64', nodeVersion: 'v22.0.0' }
        : null,
    };
  });
  const manifest = {
    schemaVersion: 1,
    repo: 'git@github.com:example/servora-med.git',
    sha,
    tree,
    clean: true,
    builder: { os: 'Linux x86_64', arch: 'arm64', node: 'v22.0.0', npm: '10.0.0', pgServer: '17', pgClient: '17' },
    startedAt: '2026-10-08T10:00:00Z',
    finishedAt: '2026-10-08T11:00:00Z',
    checks,
    result: 'PASS',
  };
  writeFileSync(join(bundle, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  if (mutate) mutate(bundle);
  return join(bundle, 'manifest.json');
}

function runVerifier(args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  return spawnSync('bash', [verifier, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function runSourced(script: string, body: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  return spawnSync('bash', ['-c', `source "$1"\n${body}`, 'sourced-test', script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

/** Fixture git repo containing the real deploy script + local-ci tooling. */
function createDeployFixture() {
  const root = temporaryDirectory('source');
  const bare = temporaryDirectory('origin');
  mkdirSync(join(root, 'ops'), { recursive: true });
  copyFileSync(runner, join(root, 'ops', 'deploy-production.sh'));
  cpSync(localCiDir, join(root, 'ops', 'local-ci'), { recursive: true });
  chmodSync(join(root, 'ops', 'deploy-production.sh'), 0o755);
  chmodSync(join(root, 'ops', 'local-ci', 'verify-evidence.sh'), 0o755);
  // Files required by --check (syntax + presence gates only, never executed).
  const checkDeps = [
    ['ops/scripts/deploy-production-host.sh', 'ops/scripts/deploy-production-host.sh'],
    ['ops/scripts/migration-state.mjs', 'ops/scripts/migration-state.mjs'],
    ['ops/scripts/migration-reconciliation.mjs', 'ops/scripts/migration-reconciliation.mjs'],
    ['web/scripts/production-browser-smoke.mjs', 'web/scripts/production-browser-smoke.mjs'],
    ['.github/workflows/deploy-production.yml', '.github/workflows/deploy-production.yml'],
    ['docs/operations/production-deployment.md', 'docs/operations/production-deployment.md'],
  ] as const;
  for (const [from, to] of checkDeps) {
    const src = join(repoRoot, from);
    const dest = join(root, to);
    mkdirSync(join(dest, '..'), { recursive: true });
    copyFileSync(src, dest);
  }
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'fixture@example.test']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Deployment Fixture']);
  execFileSync('git', ['-C', root, 'add', 'ops/deploy-production.sh', 'ops/local-ci',
    'ops/scripts', 'web/scripts', '.github/workflows', 'docs/operations']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'fixture']);
  execFileSync('git', ['init', '--bare', '-q', bare]);
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', bare]);
  execFileSync('git', ['-C', root, 'push', '-q', 'origin', 'main']);
  const sha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const tree = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
  const bin = join(root, '.fixture-bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return {
    root,
    sha,
    tree,
    script: join(root, 'ops', 'deploy-production.sh'),
    env: { PATH: `${bin}:${process.env.PATH ?? ''}`, GH_TOKEN: 'fixture-token' },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe('verify-evidence.sh fail-closed gates', () => {
  it('rejects unknown arguments and malformed SHA', () => {
    const root = temporaryDirectory('args');
    try {
      expect(runVerifier(['--bogus']).status).not.toBe(0);
      expect(runVerifier(['--evidence-root', root, '--sha', 'not-a-sha']).stderr)
        .toContain('INVALID_SHA');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts a self-consistent bundle', () => {
    const root = temporaryDirectory('good');
    try {
      makeBundle(root, GOOD_SHA, 't'.repeat(40));
      const result = runVerifier(['--evidence-root', root, '--sha', GOOD_SHA]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('EVIDENCE_VERIFY_PASS');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a tampered log and an unlisted log file', () => {
    const root = temporaryDirectory('tamper');
    try {
      makeBundle(root, GOOD_SHA, 't'.repeat(40), (bundle) => {
        writeFileSync(join(bundle, 'logs', 'server-tests.log'), 'forged content\n', { flag: 'a' });
      });
      expect(runVerifier(['--evidence-root', root, '--sha', GOOD_SHA]).stderr)
        .toContain('EVIDENCE_LOG_HASH_MISMATCH');

      const root2 = temporaryDirectory('unlisted');
      makeBundle(root2, GOOD_SHA, 't'.repeat(40));
      writeFileSync(join(root2, GOOD_SHA, 'logs', 'extra.log'), 'unlisted\n');
      expect(runVerifier(['--evidence-root', root2, '--sha', GOOD_SHA]).stderr)
        .toContain('EVIDENCE_UNLISTED_LOG');
      rmSync(root2, { recursive: true, force: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects stale SHA and changed tree', () => {
    const root = temporaryDirectory('stale');
    try {
      makeBundle(root, GOOD_SHA, 't'.repeat(40));
      expect(runVerifier(['--evidence-root', root, '--sha', OTHER_SHA]).stderr)
        .toContain('MANIFEST_MISSING');
      cpSync(join(root, GOOD_SHA), join(root, OTHER_SHA), { recursive: true });
      const tampered = JSON.parse(readFileSync(join(root, OTHER_SHA, 'manifest.json'), 'utf8'));
      tampered.sha = 'c'.repeat(40);
      writeFileSync(join(root, OTHER_SHA, 'manifest.json'), JSON.stringify(tampered));
      expect(runVerifier(['--evidence-root', root, '--sha', OTHER_SHA]).stderr)
        .toContain('EVIDENCE_SHA_MISMATCH');
      tampered.sha = OTHER_SHA;
      writeFileSync(join(root, OTHER_SHA, 'manifest.json'), JSON.stringify(tampered));
      expect(runVerifier(['--evidence-root', root, '--sha', OTHER_SHA, '--tree', 'd'.repeat(40)]).stderr)
        .toContain('EVIDENCE_TREE_MISMATCH');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a failed check unless explicitly excepted', () => {
    const root = temporaryDirectory('failed-check');
    try {
      makeBundle(root, GOOD_SHA, 't'.repeat(40), (bundle) => {
        const manifest = JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8'));
        const check = manifest.checks.find((c: { id: string }) => c.id === 'server-tests');
        check.result = 'FAIL';
        writeFileSync(join(bundle, 'manifest.json'), JSON.stringify(manifest));
      });
      expect(runVerifier(['--evidence-root', root, '--sha', GOOD_SHA]).stderr)
        .toContain('EVIDENCE_CHECK_FAILED_server-tests');
      const allowed = runVerifier(['--evidence-root', root, '--sha', GOOD_SHA,
        '--exceptions', 'server-tests:reviewed-locale-gap-2026-10-08']);
      expect(allowed.status).toBe(0);
      expect(runVerifier(['--evidence-root', root, '--sha', GOOD_SHA,
        '--exceptions', 'no-such-check:reason']).stderr)
        .toContain('EXCEPTION_UNKNOWN_CHECK');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects non-compatible linux detail and non-PASS result', () => {
    const root = temporaryDirectory('compat');
    try {
      makeBundle(root, GOOD_SHA, 't'.repeat(40), (bundle) => {
        const manifest = JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8'));
        manifest.checks.find((c: { id: string }) => c.id === 'linux-compat').detail.nativeBinaries = 2;
        writeFileSync(join(bundle, 'manifest.json'), JSON.stringify(manifest));
      });
      expect(runVerifier(['--evidence-root', root, '--sha', GOOD_SHA]).stderr)
        .toContain('EVIDENCE_LINUX_INCOMPATIBLE');

      const root2 = temporaryDirectory('result');
      makeBundle(root2, GOOD_SHA, 't'.repeat(40), (bundle) => {
        const manifest = JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8'));
        manifest.result = 'FAIL';
        writeFileSync(join(bundle, 'manifest.json'), JSON.stringify(manifest));
      });
      expect(runVerifier(['--evidence-root', root2, '--sha', GOOD_SHA]).stderr)
        .toContain('EVIDENCE_RESULT_NOT_PASS');
      rmSync(root2, { recursive: true, force: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('deploy-production.sh local evidence gate', () => {
  it('rejects an invalid --ci-mode and keeps github the default', () => {
    const fixture = createDeployFixture();
    try {
      const bad = spawnSync('bash', [fixture.script, '--sha', fixture.sha, '--ci-mode', 'bogus'],
        { encoding: 'utf8', env: { ...process.env, ...fixture.env } });
      expect(bad.status).not.toBe(0);
      expect(`${bad.stdout}${bad.stderr}`).toContain('INVALID_CI_MODE');

      const githubDefault = spawnSync(
        'bash', [fixture.script, '--sha', fixture.sha, '--check', '--ci-mode', 'github'],
        { encoding: 'utf8', env: { ...process.env, ...fixture.env } });
      expect(githubDefault.status).toBe(0);
    } finally {
      fixture.cleanup();
    }
  });

  it('verifies matching evidence and refuses stale or missing evidence', () => {
    const fixture = createDeployFixture();
    const evidenceRoot = temporaryDirectory('evidence');
    try {
      const manifest = makeBundle(evidenceRoot, fixture.sha, fixture.tree);
      const good = runSourced(
        fixture.script,
        'SHA="$2"; CI_MODE=local; EVIDENCE="$3"; EVIDENCE_ROOT=""; EVIDENCE_EXCEPTIONS=""; verify_local_evidence; echo "CI_STATUS=$CI_STATUS"',
        [fixture.sha, manifest, fixture.root],
        fixture.env,
      );
      expect(good.status).toBe(0);
      expect(good.stdout).toContain('CI_STATUS=PASS');

      const stale = runSourced(
        fixture.script,
        'SHA="$2"; CI_MODE=local; EVIDENCE="$3"; EVIDENCE_ROOT=""; EVIDENCE_EXCEPTIONS=""; verify_local_evidence',
        [OTHER_SHA, manifest, fixture.root],
        fixture.env,
      );
      expect(stale.status).not.toBe(0);
      // Unknown revision fails at commit resolution; a known-but-unverified
      // SHA would fail at LOCAL_EVIDENCE_MANIFEST_MISSING. Both fail closed.
      expect(`${stale.stdout}${stale.stderr}`).toMatch(
        /LOCAL_EVIDENCE_MANIFEST_MISSING|COMMIT_NOT_FOUND/);

      const missing = runSourced(
        fixture.script,
        'SHA="$2"; CI_MODE=local; EVIDENCE=""; EVIDENCE_ROOT="/nonexistent-evidence-root"; EVIDENCE_EXCEPTIONS=""; verify_local_evidence',
        [fixture.sha, fixture.root],
        fixture.env,
      );
      expect(missing.status).not.toBe(0);
      expect(`${missing.stdout}${missing.stderr}`).toContain('LOCAL_EVIDENCE_MANIFEST_MISSING');
    } finally {
      fixture.cleanup();
      rmSync(evidenceRoot, { recursive: true, force: true });
    }
  });

  it('fails closed on concurrent deployment and recovers stale locks', () => {
    const fixture = createDeployFixture();
    const lockBase = temporaryDirectory('lock');
    try {
      const lockDir = join(lockBase, 'servora-med-production-deploy.lock');
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, 'pid'), `${process.pid}\n`);
      const busy = runSourced(
        fixture.script,
        `DEPLOY_LOCK_DIR=${lockDir}; acquire_deploy_lock`,
        [], fixture.env,
      );
      expect(busy.status).not.toBe(0);
      expect(`${busy.stdout}${busy.stderr}`).toContain('CONCURRENT_DEPLOYMENT_ACTIVE');

      writeFileSync(join(lockDir, 'pid'), '2147483647\n');
      const stale = runSourced(
        fixture.script,
        `DEPLOY_LOCK_DIR=${lockDir}; acquire_deploy_lock; echo LOCK_ACQUIRED; release_deploy_lock`,
        [], fixture.env,
      );
      expect(stale.status).toBe(0);
      expect(stale.stdout).toContain('LOCK_ACQUIRED');
    } finally {
      fixture.cleanup();
      rmSync(lockBase, { recursive: true, force: true });
    }
  });

  it('reaches transfer failure without touching production', () => {
    const fixture = createDeployFixture();
    const evidenceRoot = temporaryDirectory('evidence-e2e');
    const artifactDir = temporaryDirectory('artifact');
    try {
      const manifest = makeBundle(evidenceRoot, fixture.sha, fixture.tree);
      const payload = join(artifactDir, 'payload');
      mkdirSync(join(payload, 'server', 'dist', 'db'), { recursive: true });
      mkdirSync(join(payload, 'web', 'dist'), { recursive: true });
      writeFileSync(join(payload, 'server', 'dist', 'index.js'), 'ok\n');
      writeFileSync(join(payload, 'server', 'package.json'), '{}\n');
      writeFileSync(join(payload, 'web', 'dist', 'index.html'), 'ok\n');
      const artifact = join(artifactDir, `servora-med-${fixture.sha}.tar.gz`);
      execFileSync('tar', ['-czf', artifact, '-C', payload, 'server', 'web']);
      const digest = sha256File(artifact);
      writeFileSync(`${artifact}.sha256`, `${digest}  servora-med-${fixture.sha}.tar.gz\n`);
      const result = spawnSync('bash', [
        fixture.script,
        '--sha', fixture.sha,
        '--ci-mode', 'local',
        '--evidence', manifest,
        '--artifact', artifact,
      ], {
        encoding: 'utf8',
        env: {
          ...process.env,
          ...fixture.env,
          SERVORA_PROD_HOST: '127.0.0.1',
          SERVORA_PROD_SSH_USER: 'servora-deploy',
          SERVORA_PROD_SSH_KEY: 'dummy-key',
          SERVORA_PROD_KNOWN_HOSTS: 'dummy-known-hosts',
          SERVORA_PROD_FQDN: 'deploy-test.example',
          TMPDIR: artifactDir,
        },
      });
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('ARTIFACT_TRANSFER_FAILED');
    } finally {
      fixture.cleanup();
      rmSync(evidenceRoot, { recursive: true, force: true });
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  it('keeps migrations unauthorized by default', () => {
    const defaults = runSourced(runner, 'echo "ALLOW_MIGRATIONS=$ALLOW_MIGRATIONS CI_MODE=$CI_MODE"');
    expect(defaults.status).toBe(0);
    expect(defaults.stdout).toContain('ALLOW_MIGRATIONS=false');
    expect(defaults.stdout).toContain('CI_MODE=github');
  });
});
