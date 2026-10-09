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
  symlinkSync,
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

const REQUIRED_IDS: string[] = readFileSync(
  fileURLToPath(new URL('../../ops/local-ci/required-checks.txt', import.meta.url)),
  'utf8',
).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

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
        ? { productionPackages: 10, nativeBinaries: 0, osRestricted: 0, cpuRestricted: 0, offenders: [], builderOs: 'linux', builderArch: 'arm64', nodeVersion: 'v22.0.0', linuxAmd64: { platform: 'linux/amd64', emulated: true, productionPackages: 10, result: 'pass' } }
        : null,
    };
  });
  const manifest = {
    schemaVersion: 1,
    repo: 'git@github.com:example/servora-med.git',
    sha,
    tree,
    clean: true,
    provenance: 'local-operator-attested',
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
  for (const command of ['ssh', 'scp']) {
    writeFileSync(join(bin, command), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  }
  return {
    root,
    sha,
    tree,
    script: join(root, 'ops', 'deploy-production.sh'),
    env: { PATH: `${bin}:${process.env.PATH ?? ''}`, GH_TOKEN: 'fixture-token' },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// A verifier invocation starts many Node processes for the 27-check policy.
// amd64 emulation on ARM can take 13–26s; retain every assertion with a
// bounded CLI-test budget instead of the default 5s unit-test timeout.
describe('verify-evidence.sh fail-closed gates', { timeout: 60000 }, () => {
  it('rejects unknown or duplicate manifest check identities', () => {
    const root = temporaryDirectory('unknown-check');
    try {
      const file = makeBundle(root, GOOD_SHA, 't'.repeat(40));
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      manifest.checks.push({ ...manifest.checks[0], id: 'unknown-check' });
      writeFileSync(file, JSON.stringify(manifest));
      expect(runVerifier(['--evidence-root', root, '--sha', GOOD_SHA]).status).not.toBe(0);
      manifest.checks.at(-1).id = manifest.checks[0].id;
      writeFileSync(file, JSON.stringify(manifest));
      expect(runVerifier(['--evidence-root', root, '--sha', GOOD_SHA]).status).not.toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('derives required checks from the single source of truth with a producer for each', () => {
    // SSOT: required-checks.txt is the only list. The verifier (via
    // lib/evidence.sh), the assembler, and these fixtures all read it, so a
    // gate added in one place cannot silently diverge from the others.
    expect(REQUIRED_IDS.length).toBe(27);
    expect(new Set(REQUIRED_IDS).size).toBe(REQUIRED_IDS.length);
    const lib = readFileSync(join(localCiDir, 'lib', 'evidence.sh'), 'utf8');
    expect(lib).toContain('required-checks.txt');
    const assembler = readFileSync(join(localCiDir, 'assemble-manifest.mjs'), 'utf8');
    expect(assembler).toContain('required-checks.txt');
    // Only actual dispatch calls count; comments mentioning an ID cannot
    // satisfy the policy. Syntax-check every producer script as well.
    const scripts = ['chains/server-chain-user.sh', 'chains/web-chain.sh', 'docker-gated.sh'];
    const produced: string[] = [];
    for (const script of scripts) {
      const file = join(localCiDir, script);
      execFileSync('bash', ['-n', file]);
      const source = readFileSync(file, 'utf8');
      produced.push(...Array.from(source.matchAll(/^\s*(?:check|run_one)\s+([a-z0-9-]+)\s+--\s+\S/gm), (match) => match[1]));
    }
    const run = readFileSync(join(localCiDir, 'run.sh'), 'utf8');
    execFileSync('bash', ['-n', join(localCiDir, 'run.sh')]);
    expect(run).toContain('node /repo/ops/benchmarks/auth-kdf-benchmark.mjs --mode=smoke');
    expect(run).toContain('bash "$SCRIPT_DIR/verify-linux-compat.sh"');
    expect(run).toContain('bash "$SCRIPT_DIR/chains/linux-amd64-compat.sh"');
    produced.push('benchmark-smoke', 'linux-compat');
    expect([...new Set(produced)].sort()).toEqual([...REQUIRED_IDS].sort());
  });
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

  it('accepts a self-consistent bundle as integrity-only, never authenticated', () => {
    const root = temporaryDirectory('good');
    try {
      makeBundle(root, GOOD_SHA, 't'.repeat(40));
      const result = runVerifier(['--evidence-root', root, '--sha', GOOD_SHA]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('EVIDENCE_VERIFY_PASS');
      // The verifier must never describe the bundle as authenticated: the
      // only provenance claim is operator-attested (internal consistency).
      expect(`${result.stdout}${result.stderr}`).not.toMatch(/authenticated/i);
      const manifest = JSON.parse(readFileSync(join(root, GOOD_SHA, 'manifest.json'), 'utf8'));
      expect(manifest.provenance).toBe('local-operator-attested');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a forged provenance claim and a wholly fabricated bundle at the deploy gate', () => {
    const root = temporaryDirectory('forged');
    try {
      // A forger upgrades the provenance claim to sound independently
      // authenticated: refused, so forged evidence cannot be described as
      // anything stronger than operator-attested.
      makeBundle(root, GOOD_SHA, 't'.repeat(40), (bundle) => {
        const manifest = JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8'));
        manifest.provenance = 'independently-authenticated';
        writeFileSync(join(bundle, 'manifest.json'), JSON.stringify(manifest));
      });
      expect(runVerifier(['--evidence-root', root, '--sha', GOOD_SHA]).stderr)
        .toContain('EVIDENCE_PROVENANCE_UNRECOGNIZED');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    // A wholly fabricated but internally consistent bundle for a SHA that was
    // never built: integrity checks pass (documenting the trust-model limit),
    // but the deploy gate cannot resolve it against the live repository, so
    // it can never authorize a deployment.
    const fixture = createDeployFixture();
    const forgedRoot = temporaryDirectory('fabricated');
    try {
      const manifest = makeBundle(forgedRoot, OTHER_SHA, 'f'.repeat(40));
      const forged = runSourced(
        fixture.script,
        'SHA="$2"; CI_MODE=local; EVIDENCE="$3"; EVIDENCE_ROOT=""; verify_local_evidence',
        [OTHER_SHA, manifest, fixture.root],
        fixture.env,
      );
      expect(forged.status).not.toBe(0);
      expect(`${forged.stdout}${forged.stderr}`).toMatch(
        /LOCAL_EVIDENCE_MANIFEST_MISSING|COMMIT_NOT_FOUND/);
    } finally {
      fixture.cleanup();
      rmSync(forgedRoot, { recursive: true, force: true });
    }
  });

  it('rejects manifest log references escaping the logs directory', () => {
    const root = temporaryDirectory('logpath');
    try {
      makeBundle(root, GOOD_SHA, 't'.repeat(40), (bundle) => {
        const manifest = JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8'));
        manifest.checks[0].log = 'logs/../../evil.log';
        writeFileSync(join(bundle, 'manifest.json'), JSON.stringify(manifest));
      });
      expect(runVerifier(['--evidence-root', root, '--sha', GOOD_SHA]).stderr)
        .toContain('EVIDENCE_LOG_PATH_INVALID');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps machine-specific operator paths out of the local tooling', () => {
    // Regression guard for the review: guest usernames and home directories
    // differ per machine, so the tooling must probe instead of hardcode.
    const gated = readFileSync(join(localCiDir, 'docker-gated.sh'), 'utf8');
    expect(gated).not.toMatch(/\/home\/[a-z0-9._-]+\//i);
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

  it('rejects a failed check with no exception mechanism', () => {
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
      // Policy A: no production exceptions. A caller-supplied reason string
      // must never mark a failed check acceptable — the flag itself is refused.
      const refused = runVerifier(['--evidence-root', root, '--sha', GOOD_SHA,
        '--exceptions', 'server-tests:any-reason']);
      expect(refused.status).not.toBe(0);
      expect(`${refused.stdout}${refused.stderr}`).toContain('UNKNOWN_ARGUMENT');
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

      // Scan-only detail without the linux/amd64 install+import proof is not
      // a compatibility guarantee: refused as well.
      const root3 = temporaryDirectory('compat-amd64');
      try {
        makeBundle(root3, GOOD_SHA, 't'.repeat(40), (bundle) => {
          const manifest = JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8'));
          delete manifest.checks.find((c: { id: string }) => c.id === 'linux-compat').detail.linuxAmd64;
          writeFileSync(join(bundle, 'manifest.json'), JSON.stringify(manifest));
        });
        expect(runVerifier(['--evidence-root', root3, '--sha', GOOD_SHA]).stderr)
          .toContain('EVIDENCE_LINUX_INCOMPATIBLE');
      } finally {
        rmSync(root3, { recursive: true, force: true });
      }

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

describe('deploy-production.sh local evidence gate', { timeout: 60000 }, () => {
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
        'SHA="$2"; CI_MODE=local; EVIDENCE="$3"; EVIDENCE_ROOT=""; verify_local_evidence; echo "CI_STATUS=$CI_STATUS"',
        [fixture.sha, manifest, fixture.root],
        fixture.env,
      );
      expect(good.status).toBe(0);
      expect(good.stdout).toContain('CI_STATUS=PASS');

      const stale = runSourced(
        fixture.script,
        'SHA="$2"; CI_MODE=local; EVIDENCE="$3"; EVIDENCE_ROOT=""; verify_local_evidence',
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
        'SHA="$2"; CI_MODE=local; EVIDENCE=""; EVIDENCE_ROOT="/nonexistent-evidence-root"; verify_local_evidence',
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

  it('grants a racing fresh-lock acquisition to exactly one process', async () => {
    const fixture = createDeployFixture();
    const lockBase = temporaryDirectory('lock-race');
    try {
      const lockDir = join(lockBase, 'servora-med-production-deploy.lock');
      const gate = join(lockBase, 'start-gate');
      const { spawn } = await import('node:child_process');
      // All racers block on a start gate so the thundering herd attempts
      // within milliseconds of each other, inside the winner's hold.
      // The winner holds 3s (then releases); every loser must fail. No racer
      // may start after the hold ends, so a second ACQUIRED always means
      // simultaneous ownership (the bug), never a legitimate acquisition.
      rmSync(lockDir, { recursive: true, force: true });
      rmSync(gate, { force: true });
      const racers = Array.from({ length: 12 }, () => new Promise<string>((resolve) => {
        const hold = 'while [ ! -e "$3" ]; do sleep 0.02; done; acquire_deploy_lock >/dev/null 2>&1 && (echo ACQUIRED; sleep 3; release_deploy_lock) || echo FAILED';
        const child = spawn('bash', ['-c',
          `source "$1"\nDEPLOY_LOCK_DIR="$2"; ${hold}`,
          'lock-race', fixture.script, lockDir, gate,
        ], { env: { ...process.env, ...fixture.env } });
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        child.on('close', () => resolve(out));
      }));
      const pending = Promise.all(racers);
      await new Promise((r) => setTimeout(r, 1000));
      writeFileSync(gate, 'go\n');
      const results = await pending;
      expect(results.filter((o) => o.includes('ACQUIRED'))).toHaveLength(1);
    } finally {
      fixture.cleanup();
      rmSync(lockBase, { recursive: true, force: true });
    }
  }, 30000);

  it('never releases a lock owned by a different process', () => {
    const fixture = createDeployFixture();
    const lockBase = temporaryDirectory('lock-other');
    try {
      const lockDir = join(lockBase, 'servora-med-production-deploy.lock');
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, 'pid'), `${process.pid}\n`);
      const released = runSourced(
        fixture.script,
        `DEPLOY_LOCK_DIR=${lockDir}; release_deploy_lock; test -d ${lockDir} && echo LOCK_SURVIVES`,
        [], fixture.env,
      );
      expect(released.status).toBe(0);
      expect(released.stdout).toContain('LOCK_SURVIVES');
    } finally {
      fixture.cleanup();
      rmSync(lockBase, { recursive: true, force: true });
    }
  });
  it('fails closed on concurrent deployment and on stale locks', () => {
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

      // No automatic stale recovery: a dead holder blocks acquisition with a
      // supervised-recovery reason instead of being silently stolen.
      writeFileSync(join(lockDir, 'pid'), '2147483647\n');
      const stale = runSourced(
        fixture.script,
        `DEPLOY_LOCK_DIR=${lockDir}; acquire_deploy_lock`,
        [], fixture.env,
      );
      expect(stale.status).not.toBe(0);
      expect(`${stale.stdout}${stale.stderr}`).toContain('STALE_DEPLOY_LOCK');
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
          SERVORA_PROD_KNOWN_HOSTS: 'deploy-test.example ssh-ed25519 AAAATestOnly',
          SERVORA_PROD_FQDN: 'deploy-test.example',
          TMPDIR: artifactDir,
        },
      });
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('ARTIFACT_TRANSFER_FAILED');
      expect(spawnSync('test', ['-d', join(artifactDir, 'servora-med-production-deploy.lock')]).status).not.toBe(0);
    } finally {
      fixture.cleanup();
      rmSync(evidenceRoot, { recursive: true, force: true });
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  it('requires GitHub CLI tooling only in github CI mode', () => {
    // Base tools present, gh/jq absent: link every base command into an
    // isolated bin dir. Missing required base tooling fails this test.
    const baseTools = ['bash', 'git', 'node', 'npm', 'tar', 'ssh', 'scp', 'curl',
      'awk', 'sed', 'grep', 'rm', 'mktemp', 'basename', 'dirname', 'od', 'tr'];
    const missing = baseTools.filter((t) => {
      try {
        execFileSync('/bin/sh', ['-c', `command -v ${t}`], { stdio: 'pipe' });
        return false;
      } catch { return true; }
    });
    expect(missing).toEqual([]);
    const bin = temporaryDirectory('no-gh-bin');
    try {
      const tools = [...baseTools];
      for (const digest of ['sha256sum', 'shasum']) {
        try {
          execFileSync('/bin/sh', ['-c', `command -v ${digest}`], { stdio: 'pipe' });
          tools.push(digest);
          break;
        } catch { /* try next */ }
      }
      for (const t of tools) {
        const real = execFileSync('/bin/sh', ['-c', `command -v ${t}`], { encoding: 'utf8' }).trim().split('\n')[0];
        symlinkSync(real, join(bin, t));
      }
      const env = { ...process.env, PATH: bin };
      const local = runSourced(runner, 'CI_MODE=local; CHECK_ONLY=false; check_commands; echo COMMANDS_OK', [], env);
      expect(local.status).toBe(0);
      expect(local.stdout).toContain('COMMANDS_OK');
      const github = runSourced(runner, 'CI_MODE=github; CHECK_ONLY=false; check_commands', [], env);
      expect(github.status).not.toBe(0);
      expect(`${github.stdout}${github.stderr}`).toContain('REQUIRED_COMMAND_MISSING_gh');
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it('keeps migrations unauthorized by default', () => {
    const defaults = runSourced(runner, 'echo "ALLOW_MIGRATIONS=$ALLOW_MIGRATIONS CI_MODE=$CI_MODE"');
    expect(defaults.status).toBe(0);
    expect(defaults.stdout).toContain('ALLOW_MIGRATIONS=false');
    expect(defaults.stdout).toContain('CI_MODE=github');
  });
});
