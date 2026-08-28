import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const runner = fileURLToPath(new URL('../../ops/deploy-production.sh', import.meta.url));
const hostHelper = fileURLToPath(new URL('../../ops/scripts/deploy-production-host.sh', import.meta.url));
const migrationState = fileURLToPath(new URL('../../ops/scripts/migration-state.mjs', import.meta.url));
const browserSmoke = fileURLToPath(new URL('../../web/scripts/production-browser-smoke.mjs', import.meta.url));
const workflow = fileURLToPath(new URL('../../.github/workflows/deploy-production.yml', import.meta.url));
const deploymentDoc = fileURLToPath(new URL('../../docs/operations/production-deployment.md', import.meta.url));

describe('controlled production deployment automation contract', () => {
  it('keeps shell and Node helpers syntactically valid', () => {
    execFileSync('bash', ['-n', runner], { stdio: 'pipe' });
    execFileSync('bash', ['-n', hostHelper], { stdio: 'pipe' });
    execFileSync(process.execPath, ['--check', migrationState], { stdio: 'pipe' });
    execFileSync(process.execPath, ['--check', browserSmoke], { stdio: 'pipe' });
  });

  it('enforces main-only source and exact-head CI gates in the runner', () => {
    const content = readFileSync(runner, 'utf8');
    expect(content).toMatch(/\^\[0-9a-f\]\{40\}\$/);
    expect(content).toContain('refs/heads/main');
    expect(content).toContain('ls-remote origin refs/heads/main');
    expect(content).toContain('--event push');
    expect(content).toContain('--commit "$SHA"');
    expect(content).toContain('EXACT_MAIN_CI_NOT_GREEN');
    expect(content).toContain('EXACT_MAIN_CI_SERVER_NOT_GREEN');
    expect(content).toContain('EXACT_MAIN_CI_WEB_NOT_GREEN');
    expect(content).not.toContain('StrictHostKeyChecking=no');
    expect(content).not.toContain('git pull');
  });

  it('rejects an invalid SHA in local contract mode before any network setup', () => {
    const result = spawnSync('bash', [runner, '--check', '--sha', 'not-a-sha'], {
      encoding: 'utf8',
      env: { ...process.env, SERVORA_PROD_HOST: '', SERVORA_PROD_SSH_KEY: '' },
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('INVALID_SHA');
  });

  it('keeps release packaging and privileged operations fail-closed', () => {
    const runnerContent = readFileSync(runner, 'utf8');
    const hostContent = readFileSync(hostHelper, 'utf8');
    for (const forbidden of ['host.md', '*/.env.*', '*/credentials/*', '*/passwords/*', '*/db-dumps/*', '*/._*']) {
      expect(runnerContent).toContain(forbidden);
      expect(hostContent).toContain(forbidden);
    }
    expect(hostContent).toContain('IMMUTABLE_RELEASE_COLLISION');
    expect(hostContent).toContain('ARTIFACT_CHECKSUM_MISMATCH');
    expect(hostContent).toContain('PENDING_MIGRATIONS_REQUIRE_EXPLICIT_AUTHORIZATION');
    expect(hostContent).toContain('MIGRATIONS_APPLIED');
    expect(hostContent).toContain('SERVICE_USER="servora-med"');
    expect(hostContent).toContain('sudo -u "$SERVICE_USER"');
    expect(hostContent).toContain('BUSINESS_DATA_INVARIANT_CHANGED');
    expect(hostContent).toContain('ARTIFACT_SHA_NAME_MISMATCH');
    expect(hostContent).toContain('HOST_HELPER_SOURCE_DRIFT');
    expect(hostContent).toContain('mv -Tf -- "$temporary" "$CURRENT_LINK"');
    expect(hostContent).not.toContain('git pull');
    expect(hostContent).not.toContain('pg_restore.*--clean');
    expect(hostContent).toContain('MIGRATIONS_APPLIED=1');
  });

  it('never exposes importers, seed, bootstrap, or database restore in deploy paths', () => {
    const runnerContent = readFileSync(runner, 'utf8');
    const hostContent = readFileSync(hostHelper, 'utf8');
    for (const content of [runnerContent, hostContent]) {
      expect(content).not.toMatch(/import-customers|import-personnel|bootstrap-admin|seed-dev/);
      expect(content).not.toMatch(/restore-rehearsal|restore-dr-acceptance|pg_restore\s+.*--clean/);
    }
  });

  it('reports only aggregate migration/data state from the protected database', () => {
    const content = readFileSync(migrationState, 'utf8');
    expect(content).toContain('schema_migrations ORDER BY version');
    expect(content).toContain('COUNT(*) FROM organizations');
    expect(content).toContain('COUNT(*) FROM demo_datasets');
    expect(content).toContain("'organizations', 'admins', 'staff', 'customers', 'products', 'jobs', 'demo_data'");
    expect(content).not.toMatch(/password_hash|SELECT\s+\*|DATABASE_URL.*console/);
  });

  it('keeps browser smoke anonymous and checks the historical blank-page failure', () => {
    const content = readFileSync(browserSmoke, 'utf8');
    expect(content).toContain("const routes = ['/', '/login'];");
    expect(content).toContain("locator('#root')");
    expect(content).toContain('TypeError:\\s*pt is not a function');
    expect(content).toContain('newContext()');
    expect(content).not.toMatch(/password|DATABASE_URL|SSH_KEY|set-cookie/i);
  });

  it('requires a manually started production environment workflow with minimum permissions', () => {
    const content = readFileSync(workflow, 'utf8');
    expect(content).toContain('workflow_dispatch:');
    expect(content).not.toMatch(/^\s+push:/m);
    expect(content).toContain('contents: read');
    expect(content).toContain('actions: read');
    expect(content).toContain('group: production-deploy');
    expect(content).toContain('cancel-in-progress: false');
    expect(content).toContain('name: production');
    expect(content).toContain('SERVORA_PROD_HOST');
    expect(content).toContain('SERVORA_PROD_SSH_KEY');
    expect(content).toContain('SERVORA_PROD_KNOWN_HOSTS');
    expect(content).not.toContain('StrictHostKeyChecking=no');
  });

  it('documents the environment approval and one-time host bootstrap boundary', () => {
    const content = readFileSync(deploymentDoc, 'utf8');
    expect(content).toContain('Production Deploy');
    expect(content).toContain('production');
    expect(content).toContain('SERVORA_PROD_SSH_KEY');
    expect(content).toContain('SERVORA_PROD_KNOWN_HOSTS');
    expect(content).toContain('required reviewers');
    expect(content).toContain('deploy-production-host');
    expect(content).toContain('No business-data import');
  });
});
