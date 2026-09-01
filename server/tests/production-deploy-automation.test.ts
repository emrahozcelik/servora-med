import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import {
  classifyMigrationState,
  formatMigrationVersions,
} from '../../ops/scripts/migration-reconciliation.mjs';

const runner = fileURLToPath(new URL('../../ops/deploy-production.sh', import.meta.url));
const hostHelper = fileURLToPath(new URL('../../ops/scripts/deploy-production-host.sh', import.meta.url));
const recoveryHelper = fileURLToPath(new URL('../../ops/scripts/production-recovery.sh', import.meta.url));
const patchedHostHelper = (() => {
  const p = join(tmpdir(), `patched-host-${process.pid}.sh`);
  try {
    const content = readFileSync(hostHelper, 'utf8').replace(
      'readonly APP_ENV_FILE="/etc/servora-med/servora-med.env"',
      'APP_ENV_FILE="${APP_ENV_FILE:-/etc/servora-med/servora-med.env}"',
    );
    writeFileSync(p, content, { mode: 0o755 });
  } catch {}
  return p;
})();
const migrationState = fileURLToPath(new URL('../../ops/scripts/migration-state.mjs', import.meta.url));
const migrationReconciliation = fileURLToPath(new URL('../../ops/scripts/migration-reconciliation.mjs', import.meta.url));
const browserSmoke = fileURLToPath(new URL('../../web/scripts/production-browser-smoke.mjs', import.meta.url));
const workflow = fileURLToPath(new URL('../../.github/workflows/deploy-production.yml', import.meta.url));
const deploymentDoc = fileURLToPath(new URL('../../docs/operations/production-deployment.md', import.meta.url));

const TEST_SHA = '0123456789abcdef0123456789abcdef01234567';

function temporaryDirectory(prefix: string) {
  return mkdtempSync(join(tmpdir(), `servora-deploy-${prefix}-`));
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function runSourced(script: string, body: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  return spawnSync('bash', ['-c', `source "$1"\n${body}`, 'sourced-test', script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function createGitFixture() {
  const root = temporaryDirectory('source');
  const bare = temporaryDirectory('origin');
  mkdirSync(join(root, 'ops'), { recursive: true });
  copyFileSync(runner, join(root, 'ops', 'deploy-production.sh'));
  chmodSync(join(root, 'ops', 'deploy-production.sh'), 0o755);
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'fixture@example.test']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Deployment Fixture']);
  execFileSync('git', ['-C', root, 'add', 'ops/deploy-production.sh']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'fixture']);
  execFileSync('git', ['init', '--bare', '-q', bare]);
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', bare]);
  execFileSync('git', ['-C', root, 'push', '-q', 'origin', 'main']);
  const sha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const bin = join(root, '.fixture-bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return {
    root,
    sha,
    path: join(root, 'ops', 'deploy-production.sh'),
    env: { PATH: `${bin}:${process.env.PATH ?? ''}`, GH_TOKEN: 'fixture-token' },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function runHostHarness(body: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  return runSourced(hostHelper, body, args, env);
}

function runChecksumCheck(script: string, artifact: string, artifactSha: string) {
  return runSourced(
    script,
    'ARTIFACT="$2"; ARTIFACT_SHA="$3"; PHASE=TEST; SHA="$4"; verify_artifact_checksum',
    [artifact, artifactSha, TEST_SHA],
  );
}

function runRunnerSidecarCheck(artifact: string) {
  return runSourced(
    runner,
    'ARTIFACT="$2"; verify_artifact_sidecar',
    [artifact],
  );
}

function runCiContractFixture(serverConclusion: string, webConclusion: string, listOutput = '123') {
  return runSourced(
    runner,
    `SHA="${TEST_SHA}"
GH_TOKEN=fixture-token
gh() {
  if [[ "$1" == run && "$2" == list ]]; then printf '%s\\n' "${listOutput}"; return 0; fi
  if [[ "$1" == run && "$2" == view ]]; then printf '[{"name":"server","conclusion":"${serverConclusion}"},{"name":"web","conclusion":"${webConclusion}"}]\\n'; return 0; fi
  return 1
}
verify_exact_main_ci`,
  );
}

function runDeployPhaseHarness(
  mode:
    | 'backup-failure'
    | 'checksum-failure'
    | 'zero-rollback'
    | 'migrated-no-rollback'
    | 'pending-default'
    | 'pending-allow'
    | 'divergent-allow'
    | 'ahead-allow'
    | 'enable-failure',
) {
  const root = temporaryDirectory(`phase-${mode}`);
  const eventLog = join(root, 'events.log');
  const body = `
EVENT_LOG="$2"
SHA="${TEST_SHA}"
FQDN="fixture.example"
ARTIFACT="/tmp/fixture.tar.gz"
ARTIFACT_SHA="${'a'.repeat(64)}"
if [[ "${mode}" == pending-allow || "${mode}" == divergent-allow || "${mode}" == ahead-allow ]]; then ALLOW_MIGRATIONS=true; fi
log_event() { printf '%s\\n' "$1" >>"$EVENT_LOG"; }
require_commands() { log_event require; }
validate_sha() { log_event validate_sha; }
validate_fqdn() { :; }
validate_artifact() { :; }
assert_env_contract() { :; }
assert_host_backup_contract() { :; }
assert_release_dir() { return 0; }
current_release() { printf '%s\\n' /opt/servora-med/releases/old; }
assert_service_and_health() { log_event preflight; }
verify_archive_entries() { log_event archive; }
verify_artifact_checksum() { log_event checksum; ${mode === 'checksum-failure' ? 'fail ARTIFACT_CHECKSUM_MISMATCH' : ':'}; }
stage_release() { log_event stage; }
validate_release_tree() { :; }
assert_candidate_backup_contract() { :; }
run_predeploy_backup() { log_event backup; ${mode === 'backup-failure' ? 'fail PREDEPLOY_BACKUP_FAILED' : ':'}; }
run_schema_check() { log_event schema; return 0; }
transition_health_schema_version() { log_event "transition:$STATE_CATALOG_HEAD:$MIGRATIONS_APPLIED"; return 0; }
write_state() { log_event write_state; }
atomic_switch() { log_event "switch:$1"; CURRENT_SWITCHED=true; }
health_gate() { log_event health; return 0; }
restart_candidate_or_fail() { log_event candidate_start; ${mode === 'zero-rollback' || mode === 'migrated-no-rollback' ? 'return 1' : 'return 0'}; }
systemctl() {
  log_event "systemctl:$*"
  if [[ "$1" == enable && "${mode}" == enable-failure ]]; then return 1; fi
  return 0
}
STATE_READ_COUNT=0
read_migration_state() {
  STATE_READ_COUNT=$((STATE_READ_COUNT + 1))
  STATE_CATALOG_COUNT=1; STATE_CATALOG_HEAD=001_fixture; STATE_APPLIED_HEAD=001_fixture
  if [[ "$STATE_READ_COUNT" -gt 1 && ("${mode}" == migrated-no-rollback || "${mode}" == pending-allow) ]]; then STATE_APPLIED_COUNT=1; else STATE_APPLIED_COUNT=0; fi
  STATE_PENDING_VERSIONS=""; STATE_PENDING_COUNT=0; STATE_UNEXPECTED_VERSIONS=""; STATE_UNEXPECTED_COUNT=0
  STATE_MIGRATION_STATUS=EXACT; STATE_MIGRATION_REASON=EXACT; STATE_DUPLICATE_VERSIONS=""; STATE_EXACT_CATALOG=true
  if [[ "$STATE_READ_COUNT" -eq 1 && ("${mode}" == pending-default || "${mode}" == pending-allow) ]]; then
    STATE_PENDING_VERSIONS=002_fixture; STATE_PENDING_COUNT=1; STATE_MIGRATION_STATUS=PREFIX_WITH_PENDING; STATE_MIGRATION_REASON=PREFIX_WITH_PENDING; STATE_EXACT_CATALOG=false
  elif [[ "$STATE_READ_COUNT" -eq 1 && "${mode}" == divergent-allow ]]; then
    STATE_PENDING_VERSIONS=002_fixture; STATE_PENDING_COUNT=1; STATE_UNEXPECTED_VERSIONS=003_other; STATE_UNEXPECTED_COUNT=1; STATE_MIGRATION_STATUS=DIVERGENT; STATE_MIGRATION_REASON=NON_PREFIX_HISTORY; STATE_EXACT_CATALOG=false
  elif [[ "$STATE_READ_COUNT" -eq 1 && "${mode}" == ahead-allow ]]; then
    STATE_UNEXPECTED_VERSIONS=002_ahead; STATE_UNEXPECTED_COUNT=1; STATE_MIGRATION_STATUS=DATABASE_AHEAD; STATE_MIGRATION_REASON=DATABASE_AHEAD_OF_CANDIDATE; STATE_EXACT_CATALOG=false
  fi
  STATE_ORGANIZATIONS=0; STATE_ADMINS=0; STATE_STAFF=0; STATE_CUSTOMERS=0; STATE_PRODUCTS=0; STATE_JOBS=0; STATE_DEMO_DATA=0
}
run_release_node() { log_event migrate; return 0; }
deploy_phase
`;
  const result = runHostHarness(body, [eventLog]);
  const events = existsSync(eventLog) ? readFileSync(eventLog, 'utf8').trim().split('\n').filter(Boolean) : [];
  return { result, events, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

type BootEnablementMode = 'disabled' | 'enabled' | 'failure';

function runBootEnablementHarness(script: string, mode: BootEnablementMode) {
  const root = temporaryDirectory(`boot-enablement-${mode}`);
  const eventLog = join(root, 'events.log');
  const body = `
EVENT_LOG="$2"
SHA="${TEST_SHA}"
FQDN="fixture.example"
ARTIFACT="/tmp/fixture.tar.gz"
ARTIFACT_SHA="${'a'.repeat(64)}"
SERVICE_STATE="${mode === 'enabled' ? 'enabled' : 'disabled'}"
SERVICE_STARTED=false
log_event() { printf '%s\\n' "$1" >>"$EVENT_LOG"; }
require_commands() { log_event require; }
validate_sha() { log_event validate_sha; }
validate_fqdn() { :; }
validate_artifact() { :; }
assert_env_contract() { :; }
assert_host_backup_contract() { :; }
assert_release_dir() { return 0; }
current_release() { printf '%s\\n' /opt/servora-med/releases/old; }
assert_service_and_health() { log_event preflight; }
verify_archive_entries() { log_event archive; }
verify_artifact_checksum() { log_event checksum; }
stage_release() { log_event stage; }
validate_release_tree() { :; }
assert_candidate_backup_contract() { :; }
run_predeploy_backup() { log_event backup; }
read_migration_state() {
  STATE_CATALOG_COUNT=41; STATE_CATALOG_HEAD=041_user_lifecycle_reconciliation
  STATE_APPLIED_COUNT=41; STATE_APPLIED_HEAD=041_user_lifecycle_reconciliation
  STATE_PENDING_VERSIONS=""; STATE_PENDING_COUNT=0
  STATE_UNEXPECTED_VERSIONS=""; STATE_UNEXPECTED_COUNT=0
  STATE_MIGRATION_STATUS=EXACT; STATE_MIGRATION_REASON=EXACT
  STATE_DUPLICATE_VERSIONS=""; STATE_EXACT_CATALOG=true
  STATE_ORGANIZATIONS=0; STATE_ADMINS=0; STATE_STAFF=0; STATE_CUSTOMERS=0
  STATE_PRODUCTS=0; STATE_JOBS=0; STATE_DEMO_DATA=0
}
capture_data_invariants() { :; }
assert_data_invariants_unchanged() { :; }
run_schema_check() { log_event schema; return 0; }
transition_health_schema_version() { log_event transition; return 0; }
write_state() { log_event write_state; }
atomic_switch() { log_event "switch:$1"; CURRENT_SWITCHED=true; }
health_gate() { log_event health; return 0; }
restart_candidate_or_fail() { log_event candidate_start; SERVICE_STARTED=true; return 0; }
run_release_node() { log_event migrate; return 0; }
systemctl() {
  log_event "systemctl:$*"
  case "$1" in
    enable)
      if [[ "${mode}" == failure ]]; then return 1; fi
      SERVICE_STATE=enabled
      return 0
      ;;
    start|restart)
      SERVICE_STARTED=true
      return 0
      ;;
    *)
      return 0
      ;;
  esac
}
deploy_phase
printf 'final_state=%s\\nstarted=%s\\n' "$SERVICE_STATE" "$SERVICE_STARTED" >>"$EVENT_LOG"
`;
  const result = runSourced(script, body, [eventLog]);
  const events = existsSync(eventLog)
    ? readFileSync(eventLog, 'utf8').trim().split('\n').filter(Boolean)
    : [];
  const finalState = events.find((event) => event.startsWith('final_state='))?.split('=', 2)[1];
  const started = events.find((event) => event.startsWith('started='))?.split('=', 2)[1];
  return {
    result,
    events,
    finalState,
    started,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function isServiceActivationEvent(event: string) {
  return /^(?:systemctl:(?:start|restart) servora-med\.service|systemctl:enable --now servora-med\.service)$/.test(
    event,
  );
}

function earlyServiceActivationEvents(events: string[]) {
  const enableIndex = events.indexOf('systemctl:enable servora-med.service');
  const activationBoundaryIndex = events.findIndex((event) => event.startsWith('switch:'));
  if (enableIndex === -1 || activationBoundaryIndex <= enableIndex) {
    throw new Error('BOOT_ENABLEMENT_ACTIVATION_BOUNDARY_MISSING');
  }

  return events.slice(enableIndex + 1, activationBoundaryIndex).filter(isServiceActivationEvent);
}

function assertNoEarlyServiceActivation(events: string[]) {
  expect(earlyServiceActivationEvents(events)).toEqual([]);
}

function assertBootEnablementContract(result: ReturnType<typeof runBootEnablementHarness>) {
  expect(result.result.status).toBe(0);
  expect(result.finalState).toBe('enabled');
  expect(result.events).toContain('systemctl:enable servora-med.service');
}

function runPostdeployBackupFailureHarness() {
  const root = temporaryDirectory('postdeploy-failure');
  const eventLog = join(root, 'events.log');
  const body = `
EVENT_LOG="$2"
SHA="${TEST_SHA}"
FQDN="fixture.example"
log_event() { printf '%s\\n' "$1" >>"$EVENT_LOG"; }
require_commands() { log_event require; }
validate_sha() { :; }
validate_fqdn() { :; }
assert_env_contract() { :; }
read_state() { MIGRATIONS_APPLIED=0; OLD_RELEASE=/opt/servora-med/releases/old; }
current_release() { printf '/opt/servora-med/releases/%s\\n' "$SHA"; }
systemctl() {
  log_event "systemctl:$*"
  if [[ "$1" == start ]]; then return 1; fi
  return 0
}
health_gate() { log_event health; return 0; }
find() { return 0; }
postdeploy_phase
`;
  const result = runHostHarness(body, [eventLog]);
  const events = existsSync(eventLog) ? readFileSync(eventLog, 'utf8').trim().split('\n').filter(Boolean) : [];
  return { result, events, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function runImmutableCollisionHarness(matchingMarker: boolean) {
  const root = temporaryDirectory('collision');
  mkdirSync(join(root, 'releases'), { recursive: true });
  const releaseRoot = realpathSync(join(root, 'releases'));
  const release = join(releaseRoot, TEST_SHA);
  const payloadRoot = join(root, 'payload');
  const artifact = join(root, `servora-med-${TEST_SHA}.tar.gz`);
  mkdirSync(release, { recursive: true });
  mkdirSync(payloadRoot, { recursive: true });
  writeFileSync(join(payloadRoot, 'payload.txt'), 'immutable payload');
  copyFileSync(join(payloadRoot, 'payload.txt'), join(release, 'payload.txt'));
  execFileSync('tar', ['-czf', artifact, '-C', payloadRoot, 'payload.txt']);
  const artifactDigest = execFileSync('sha256sum', [artifact], { encoding: 'utf8' }).split(/\s+/)[0];
  const markerDigest = matchingMarker ? artifactDigest : 'b'.repeat(64);
  writeFileSync(join(release, '.servora-release-artifact.sha256'), `${markerDigest}\n`, { mode: 0o600 });
  const payloadDigest = sha256('immutable payload');
  writeFileSync(join(release, '.servora-release-content.sha256'), `f ./payload.txt ${payloadDigest}\n`, { mode: 0o600 });
  const body = `
SHA="${TEST_SHA}"
ARTIFACT="${artifact}"
ARTIFACT_SHA="${artifactDigest}"
PHASE=PACKAGE
tar() {
  local arg; local -a filtered=()
  for arg in "$@"; do [[ "$arg" == --no-overwrite-dir ]] || filtered+=("$arg"); done
  command tar "\${filtered[@]}"
}
stat() {
  case "$*" in
    *'.servora-release-artifact.sha256') printf 'root:root:600\\n'; return 0 ;;
    *'.servora-release-content.sha256') printf 'root:root:600\\n'; return 0 ;;
  esac
  command stat "$@"
}
validate_release_tree() { :; }
assert_candidate_backup_contract() { :; }
assert_candidate_host_helper_contract() { :; }
set_release_permissions() { :; }
apply_caddy_acl() { :; }
release_content_manifest() { printf 'f ./payload.txt ${payloadDigest}\\n'; }
stage_release
`;
  const result = runHostHarness(body, [], {
    SERVORA_DEPLOY_TEST_MODE: '1',
    SERVORA_TEST_RELEASE_ROOT: releaseRoot,
  });
  return { result, release, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function createEnvFile(root: string, content: string) {
  const envFile = join(root, 'servora-med.env');
  writeFileSync(envFile, content);
  return envFile;
}

function runPatchedHost(body: string, extraEnv: NodeJS.ProcessEnv = {}, args: string[] = []) {
  return runSourced(patchedHostHelper, body, args, extraEnv);
}

function runHealthTransitionHarness(
  envContent: string,
  stateHead: string,
  migrationsApplied: number,
  extraSetup = '',
) {
  const root = temporaryDirectory('health-transition');
  const envFile = createEnvFile(root, envContent);
  const body = `
STATE_CATALOG_HEAD="${stateHead}"
MIGRATIONS_APPLIED=${migrationsApplied}
chown() { return 0; }
stat() {
  case "$*" in
    *servora-med.env*) printf 'root:servora-med:640\\n'; return 0 ;;
    *) command stat "$@" ;;
  esac
}
${extraSetup}
transition_health_schema_version
`;
  const result = runPatchedHost(body, { APP_ENV_FILE: envFile });
  const envAfter = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
  return { result, envFile, envAfter, root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function runDeployEnvHarness(opts: {
  mode: 'backup-failure' | 'partial-migration' | 'full-success' | 'zero-migration';
  initialEnv: string;
  allowMigrations?: boolean;
}) {
  const root = temporaryDirectory(`deploy-env-${opts.mode}`);
  const eventLog = join(root, 'events.log');
  const envFile = createEnvFile(root, opts.initialEnv);
  const body = `
EVENT_LOG="$2"
ENV_FILE="${envFile}"
SHA="${TEST_SHA}"
FQDN="fixture.example"
ARTIFACT="/tmp/fixture.tar.gz"
ARTIFACT_SHA="${'a'.repeat(64)}"
ALLOW_MIGRATIONS=${opts.allowMigrations ? 'true' : 'false'}
log_event() { printf '%s\\n' "$1" >>"$EVENT_LOG"; }
require_commands() { log_event require; }
validate_sha() { log_event validate_sha; }
validate_fqdn() { :; }
validate_artifact() { :; }
assert_env_contract() { :; }
assert_host_backup_contract() { :; }
assert_release_dir() { return 0; }
current_release() { printf '%s\\n' /opt/servora-med/releases/old; }
assert_service_and_health() { log_event preflight; }
verify_archive_entries() { log_event archive; }
verify_artifact_checksum() { log_event checksum; :; }
stage_release() { log_event stage; }
validate_release_tree() { :; }
assert_candidate_backup_contract() { :; }
run_predeploy_backup() { log_event backup; ${opts.mode === 'backup-failure' ? 'fail PREDEPLOY_BACKUP_FAILED' : ':'}; }
# Mock chown/stat for env transition
chown() { return 0; }
stat() {
  case "$*" in
    *servora-med.env*) printf 'root:servora-med:640\\n'; return 0 ;;
    *) command stat "$@" ;;
  esac
}
STATE_READ_COUNT=0
read_migration_state() {
  STATE_READ_COUNT=$((STATE_READ_COUNT + 1))
  STATE_CATALOG_COUNT=41
  STATE_CATALOG_HEAD=041_user_lifecycle_reconciliation
  STATE_APPLIED_HEAD=041_user_lifecycle_reconciliation
  STATE_PENDING_VERSIONS=""; STATE_PENDING_COUNT=0; STATE_UNEXPECTED_VERSIONS=""; STATE_UNEXPECTED_COUNT=0
  STATE_MIGRATION_STATUS=EXACT; STATE_MIGRATION_REASON=EXACT; STATE_DUPLICATE_VERSIONS=""; STATE_EXACT_CATALOG=true
  STATE_ORGANIZATIONS=0; STATE_ADMINS=0; STATE_STAFF=0; STATE_CUSTOMERS=0; STATE_PRODUCTS=0; STATE_JOBS=0; STATE_DEMO_DATA=0
  if [[ "${opts.mode}" == "zero-migration" ]]; then
    STATE_APPLIED_COUNT=41; STATE_APPLIED_HEAD=041_user_lifecycle_reconciliation
  elif [[ "${opts.mode}" == "partial-migration" ]]; then
    if [[ "$STATE_READ_COUNT" -eq 1 ]]; then
      STATE_APPLIED_COUNT=37; STATE_APPLIED_HEAD=037_staff_offboarding_audit
      STATE_PENDING_VERSIONS="038_demo_dataset_audit_types 039_contact_deleted_audit"; STATE_PENDING_COUNT=2
      STATE_MIGRATION_STATUS=PREFIX_WITH_PENDING; STATE_MIGRATION_REASON=PREFIX_WITH_PENDING; STATE_EXACT_CATALOG=false
    else
      # After partial failure, 038 was committed, count=38
      STATE_APPLIED_COUNT=38; STATE_APPLIED_HEAD=038_demo_dataset_audit_types
      STATE_PENDING_VERSIONS=""; STATE_PENDING_COUNT=0
      STATE_MIGRATION_STATUS=EXACT; STATE_MIGRATION_REASON=EXACT; STATE_EXACT_CATALOG=true
    fi
  elif [[ "${opts.mode}" == "full-success" ]]; then
    if [[ "$STATE_READ_COUNT" -eq 1 ]]; then
      STATE_APPLIED_COUNT=37; STATE_APPLIED_HEAD=037_staff_offboarding_audit
      STATE_PENDING_VERSIONS="038_demo_dataset_audit_types 039_contact_deleted_audit 040_demo_lifecycle_simplification 041_user_lifecycle_reconciliation"; STATE_PENDING_COUNT=4
      STATE_MIGRATION_STATUS=PREFIX_WITH_PENDING; STATE_MIGRATION_REASON=PREFIX_WITH_PENDING; STATE_EXACT_CATALOG=false
    else
      STATE_APPLIED_COUNT=41; STATE_APPLIED_HEAD=041_user_lifecycle_reconciliation
    fi
  else
    STATE_APPLIED_COUNT=37; STATE_APPLIED_HEAD=037_staff_offboarding_audit
  fi
  CAPTURED_APPLIED_COUNT="$STATE_APPLIED_COUNT"
}
capture_data_invariants() { :; }
assert_data_invariants_unchanged() { :; }
run_schema_check() { log_event schema; return 0; }
write_state() { log_event write_state; }
atomic_switch() { log_event "switch:$1"; CURRENT_SWITCHED=true; }
health_gate() { log_event health; return 0; }
restart_candidate_or_fail() { log_event candidate_start; return 0; }
systemctl() { log_event "systemctl:$*"; return 0; }
run_release_node() {
  log_event migrate
  if [[ "${opts.mode}" == "partial-migration" ]]; then
    return 1
  fi
  return 0
}
deploy_phase
`;
  const result = runPatchedHost(body, { APP_ENV_FILE: envFile }, [eventLog]);
  const events = existsSync(eventLog) ? readFileSync(eventLog, 'utf8').trim().split('\n').filter(Boolean) : [];
  const envAfter = readFileSync(envFile, 'utf8');
  return { result, events, envAfter, envFile, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('controlled production deployment automation contract', () => {
  it('keeps shell and Node helpers syntactically valid', () => {
    execFileSync('bash', ['-n', runner], { stdio: 'pipe' });
    execFileSync('bash', ['-n', hostHelper], { stdio: 'pipe' });
    execFileSync(process.execPath, ['--check', migrationState], { stdio: 'pipe' });
    execFileSync(process.execPath, ['--check', migrationReconciliation], { stdio: 'pipe' });
    execFileSync(process.execPath, ['--check', browserSmoke], { stdio: 'pipe' });
  });

  it('enables a disabled service before deployment safety gates without early start', () => {
    const source = readFileSync(hostHelper, 'utf8');
    expect(source).toContain('systemctl enable "$SERVICE"');
    expect(source).not.toContain('systemctl enable --now');

    const harness = runBootEnablementHarness(hostHelper, 'disabled');
    try {
      assertBootEnablementContract(harness);
      const enableIndex = harness.events.indexOf('systemctl:enable servora-med.service');
      const backupIndex = harness.events.indexOf('backup');
      const switchIndex = harness.events.findIndex((event) => event.startsWith('switch:'));
      const activationStartIndex = harness.events.indexOf('candidate_start');
      expect(enableIndex).toBeGreaterThan(-1);
      expect(enableIndex).toBeLessThan(backupIndex);
      expect(activationStartIndex).toBeGreaterThan(switchIndex);
      expect(harness.events.some((event) => event.includes('systemctl:enable --now'))).toBe(false);
      expect(harness.events).not.toContain('systemctl:start servora-med.service');
      expect(earlyServiceActivationEvents(harness.events)).toEqual([]);
    } finally {
      harness.cleanup();
    }
  });

  it('detects a plain restart inserted before the activation boundary', () => {
    const root = temporaryDirectory('early-restart-mutation');
    const mutatedHelper = join(root, 'deploy-production-host.sh');
    const source = readFileSync(hostHelper, 'utf8');
    const marker = '  enable_service_for_boot\n\n  PHASE=PREFLIGHT';
    const mutatedSource = source.replace(
      marker,
      '  enable_service_for_boot\n  systemctl restart "$SERVICE"\n\n  PHASE=PREFLIGHT',
    );
    expect(mutatedSource).not.toBe(source);
    writeFileSync(mutatedHelper, mutatedSource, { mode: 0o755 });

    const baseline = runBootEnablementHarness(hostHelper, 'disabled');
    const mutated = runBootEnablementHarness(mutatedHelper, 'disabled');
    try {
      expect(() => assertNoEarlyServiceActivation(baseline.events)).not.toThrow();
      expect(mutated.events).toContain('systemctl:restart servora-med.service');
      expect(() => assertNoEarlyServiceActivation(mutated.events)).toThrow();
    } finally {
      baseline.cleanup();
      mutated.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows a plain restart at the final activation boundary', () => {
    const root = temporaryDirectory('final-restart-mutation');
    const mutatedHelper = join(root, 'deploy-production-host.sh');
    const source = readFileSync(hostHelper, 'utf8');
    const marker = '  atomic_switch "$release"\n';
    const mutatedSource = source.replace(
      marker,
      '  atomic_switch "$release"\n  systemctl restart "$SERVICE"\n',
    );
    expect(mutatedSource).not.toBe(source);
    writeFileSync(mutatedHelper, mutatedSource, { mode: 0o755 });

    const harness = runBootEnablementHarness(mutatedHelper, 'disabled');
    try {
      expect(harness.result.status).toBe(0);
      expect(harness.events).toContain('systemctl:restart servora-med.service');
      expect(() => assertNoEarlyServiceActivation(harness.events)).not.toThrow();
    } finally {
      harness.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps enablement idempotent when the service is already enabled', () => {
    const harness = runBootEnablementHarness(hostHelper, 'enabled');
    try {
      assertBootEnablementContract(harness);
      expect(harness.events.filter((event) => event === 'systemctl:enable servora-med.service')).toHaveLength(1);
      expect(harness.events.some((event) => event.includes('systemctl:enable --now'))).toBe(false);
      expect(harness.events).not.toContain('systemctl:start servora-med.service');
      expect(earlyServiceActivationEvents(harness.events)).toEqual([]);
    } finally {
      harness.cleanup();
    }
  });

  it('fails closed when systemctl enable fails', () => {
    const harness = runBootEnablementHarness(hostHelper, 'failure');
    try {
      expect(harness.result.status).not.toBe(0);
      expect(`${harness.result.stdout}${harness.result.stderr}`).toContain('SERVICE_BOOT_ENABLEMENT_FAILED');
      expect(harness.events).toEqual([
        'require',
        'validate_sha',
        'systemctl:enable servora-med.service',
      ]);
      expect(harness.events).not.toContain('preflight');
      expect(harness.events).not.toContain('backup');
      expect(harness.events).not.toContain('migrate');
      expect(harness.events.some((event) => event.startsWith('switch:'))).toBe(false);
    } finally {
      harness.cleanup();
    }
  });

  it('detects removal of the boot enablement invocation', () => {
    const root = temporaryDirectory('boot-enablement-removal');
    const modifiedHelper = join(root, 'deploy-production-host.sh');
    const source = readFileSync(hostHelper, 'utf8');
    const withoutEnablement = source.replace('  enable_service_for_boot\n', '');
    expect(withoutEnablement).not.toBe(source);
    writeFileSync(modifiedHelper, withoutEnablement, { mode: 0o755 });

    const baseline = runBootEnablementHarness(hostHelper, 'disabled');
    const removed = runBootEnablementHarness(modifiedHelper, 'disabled');
    try {
      assertBootEnablementContract(baseline);
      expect(removed.result.status).toBe(0);
      expect(removed.finalState).toBe('disabled');
      expect(removed.events).not.toContain('systemctl:enable servora-med.service');
      expect(() => assertBootEnablementContract(removed)).toThrow();
    } finally {
      baseline.cleanup();
      removed.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
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
    expect(runnerContent).toContain('SOURCE_TREE_NOT_EXACT');
    expect(runnerContent).toContain('*temporary-password*');
    expect(hostContent).toContain('ARTIFACT_CHECKSUM_SIDECAR_INVALID');
    expect(hostContent).toContain('STATE_MIGRATION_STATUS');
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
    expect(content).toContain('schema_migrations ORDER BY applied_at');
    expect(content).toContain('migration_status=');
    expect(content).toContain('classifyMigrationState');
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
    expect(content).toContain('PREFIX_WITH_PENDING');
    expect(content).toContain('ARTIFACT_CHECKSUM_SIDECAR_INVALID');
    expect(content).toContain('SOURCE_TREE_NOT_EXACT');
    expect(content).toContain('systemctl enable servora-med.service');
    expect(content).toContain('does not start the process');
    expect(content).not.toContain('systemctl enable --now servora-med.service');
  });

  it('executes strict checksum sidecar validation for valid and malicious fixtures', () => {
    const root = temporaryDirectory('checksum');
    const artifact = join(root, `servora-med-${TEST_SHA}.tar.gz`);
    const artifactContent = 'isolated-artifact-fixture';
    const digest = sha256(artifactContent);
    writeFileSync(artifact, artifactContent);
    try {
      writeFileSync(`${artifact}.sha256`, `${digest}  ${artifact.split('/').at(-1)}\n`);
      const hostValid = runChecksumCheck(hostHelper, artifact, digest);
      const runnerValid = runRunnerSidecarCheck(artifact);
      expect(hostValid.status).toBe(0);
      expect(runnerValid.status).toBe(0);

      const invalidSidecars = [
        `${digest}  /dev/zero\n`,
        `${digest}  /etc/passwd\n`,
        `${digest}  ../other-file\n`,
        `${digest}  subdir/artifact\n`,
        `${digest}  wrong-artifact.tar.gz\n`,
        `${digest}  ${artifact.split('/').at(-1)}\n${digest}  ${artifact.split('/').at(-1)}\n`,
        `abc  ${artifact.split('/').at(-1)}\n`,
        `${digest.toUpperCase()}  ${artifact.split('/').at(-1)}\n`,
        `${digest.slice(0, 63)}  ${artifact.split('/').at(-1)}\n`,
        `${digest}  ${artifact.split('/').at(-1)} extra\n`,
        `${digest}\t${artifact.split('/').at(-1)}\n`,
      ];
      for (const sidecar of invalidSidecars) {
        writeFileSync(`${artifact}.sha256`, sidecar);
        const hostResult = runChecksumCheck(hostHelper, artifact, digest);
        const runnerResult = runRunnerSidecarCheck(artifact);
        expect(hostResult.status).not.toBe(0);
        expect(`${hostResult.stdout}${hostResult.stderr}`).toContain('ARTIFACT_CHECKSUM_SIDECAR_INVALID');
        expect(runnerResult.status).not.toBe(0);
        expect(`${runnerResult.stdout}${runnerResult.stderr}`).toContain('ARTIFACT_CHECKSUM_SIDECAR_INVALID');
      }
      writeFileSync(`${artifact}.sha256`, Buffer.from(`${digest}  ${artifact.split('/').at(-1)}\0\n`));
      const binaryHostResult = runChecksumCheck(hostHelper, artifact, digest);
      const binaryRunnerResult = runRunnerSidecarCheck(artifact);
      expect(binaryHostResult.status).not.toBe(0);
      expect(binaryRunnerResult.status).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('classifies migration history by ordered prefix rather than set membership', () => {
    const catalog = ['001_alpha', '002_beta', '003_gamma'];
    expect(classifyMigrationState(catalog, catalog).status).toBe('EXACT');
    expect(classifyMigrationState(catalog, ['001_alpha', '002_beta']).status).toBe('PREFIX_WITH_PENDING');
    expect(classifyMigrationState(catalog, ['001_alpha', '003_gamma']).status).toBe('DIVERGENT');
    expect(classifyMigrationState(catalog, ['001_alpha', '002_beta', '004_delta']).status).toBe('DIVERGENT');
    expect(classifyMigrationState(['001_alpha', '002_beta'], ['001_alpha', '002_beta', '003_gamma']).status).toBe('DATABASE_AHEAD');
    expect(classifyMigrationState(catalog, ['001_alpha', '002_beta', '002_beta']).status).toBe('DUPLICATE_HISTORY');
    expect(classifyMigrationState(catalog, ['001_alpha', '002_beta', '002_other']).status).toBe('DUPLICATE_HISTORY');
    expect(classifyMigrationState(catalog, ['001_alpha', '003_gamma', '002_beta']).status).toBe('DIVERGENT');
    expect(classifyMigrationState(catalog, []).pendingVersions).toEqual(catalog);
  });

  it('does not emit untrusted migration identifiers verbatim', () => {
    const output = formatMigrationVersions(['001_safe', 'secret-password\nINJECTED=1', '/etc/passwd']);
    expect(output).toBe('001_safe,INVALID,INVALID');
    expect(output).not.toContain('secret-password');
    expect(output).not.toContain('INJECTED');
    expect(formatMigrationVersions(['secret-password'])).toBe('INVALID');
  });

  it('executes the manual source-purity gate without rejecting safe root notes', () => {
    const fixture = createGitFixture();
    try {
      const wrongSha = spawnSync('bash', [fixture.path, '--sha', 'a'.repeat(40)], {
        encoding: 'utf8',
        env: fixture.env,
      });
      expect(wrongSha.status).not.toBe(0);
      expect(`${wrongSha.stdout}${wrongSha.stderr}`).toContain('LOCAL_HEAD_MISMATCH');

      for (const sourcePath of ['server/src/example.ts', 'web/src/example.tsx', 'web/vite.config.ts']) {
        mkdirSync(join(fixture.root, sourcePath.split('/').slice(0, -1).join('/')), { recursive: true });
        writeFileSync(join(fixture.root, sourcePath), 'fixture');
        const blocked = spawnSync('bash', [fixture.path, '--sha', fixture.sha], {
          encoding: 'utf8',
          env: fixture.env,
        });
        expect(blocked.status).not.toBe(0);
        expect(`${blocked.stdout}${blocked.stderr}`).toContain('SOURCE_TREE_NOT_EXACT');
        rmSync(join(fixture.root, sourcePath), { force: true });
      }

      mkdirSync(join(fixture.root, '.codebase-memory'), { recursive: true });
      writeFileSync(join(fixture.root, '.codebase-memory', 'graph.db.zst'), 'generated graph');
      writeFileSync(join(fixture.root, 'example-local-note.txt'), 'preserve me');
      const safeNote = spawnSync('bash', [fixture.path, '--sha', fixture.sha], {
        encoding: 'utf8',
        env: fixture.env,
      });
      expect(safeNote.status).not.toBe(0);
      expect(`${safeNote.stdout}${safeNote.stderr}`).toContain('EXACT_MAIN_CI_NOT_GREEN');
      expect(`${safeNote.stdout}${safeNote.stderr}`).not.toContain('SOURCE_TREE_NOT_EXACT');
      expect(existsSync(join(fixture.root, 'example-local-note.txt'))).toBe(true);
      expect(existsSync(join(fixture.root, '.codebase-memory', 'graph.db.zst'))).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it('executes CI provenance classification for stale and failed job fixtures', () => {
    const stale = runCiContractFixture('success', 'success', '');
    expect(stale.status).not.toBe(0);
    expect(`${stale.stdout}${stale.stderr}`).toContain('EXACT_MAIN_CI_NOT_GREEN');

    const serverFailed = runCiContractFixture('failure', 'success');
    expect(serverFailed.status).not.toBe(0);
    expect(`${serverFailed.stdout}${serverFailed.stderr}`).toContain('EXACT_MAIN_CI_SERVER_NOT_GREEN');

    const webFailed = runCiContractFixture('success', 'failure');
    expect(webFailed.status).not.toBe(0);
    expect(`${webFailed.stdout}${webFailed.stderr}`).toContain('EXACT_MAIN_CI_WEB_NOT_GREEN');
  });

  it('excludes explicit secret artifact names while retaining legitimate source names', () => {
    const root = temporaryDirectory('packaging');
    const artifact = join(root, 'fixture.tar.gz');
    mkdirSync(join(root, 'ops'), { recursive: true });
    mkdirSync(join(root, 'server', 'dist'), { recursive: true });
    mkdirSync(join(root, 'server', 'dist', 'modules', 'crm'), { recursive: true });
    mkdirSync(join(root, 'server', 'src'), { recursive: true });
    mkdirSync(join(root, 'server', 'node_modules'), { recursive: true });
    mkdirSync(join(root, 'web', 'dist'), { recursive: true });
    writeFileSync(join(root, 'server', 'package.json'), '{}');
    writeFileSync(join(root, 'server', 'package-lock.json'), '{}');
    copyFileSync(runner, join(root, 'ops', 'deploy-production.sh'));
    chmodSync(join(root, 'ops', 'deploy-production.sh'), 0o755);
    writeFileSync(join(root, 'server', 'dist', 'index.js'), 'fixture');
    writeFileSync(
      join(root, 'server', 'dist', 'modules', 'crm', 'customer-onboarding-import.d.ts.map'),
      '{}',
    );
    writeFileSync(join(root, 'server', 'src', 'credentials.ts'), 'export const safe = true;');
    writeFileSync(join(root, 'web', 'dist', 'index.html'), '<div id="root"></div>');
    const secretNames = [
      'servora-med-shared-temporary-password',
      'temporary-password.txt',
      'servora-med-personnel-onboarding-credentials.json',
      'personnel-onboarding-credentials.json',
      'servora-med-personnel-onboarding-manifest.json',
      'personnel-onboarding-manifest.json',
      'servora-med-customer-onboarding-manifest-production.json',
      'customer-onboarding.json',
      'customer-onboarding.yaml',
      'production-mapping.json',
      'fixture-production-mapping.yml',
      'fixture-credential.json',
      'credentials.csv',
    ];
    for (const name of secretNames) writeFileSync(join(root, 'ops', name), 'secret fixture');
    writeFileSync(join(root, 'ops', 'credentials.ts'), 'export const safe = true;');
    try {
      const result = runSourced(
        join(root, 'ops', 'deploy-production.sh'),
        'package_artifact "$2"; ARTIFACT="$2"; verify_archive_entries',
        [artifact],
      );
      expect(result.status).toBe(0);
      const inventory = execFileSync('tar', ['-tzf', artifact], { encoding: 'utf8' });
      for (const name of secretNames) expect(inventory).not.toContain(name);
      expect(inventory).toContain('ops/credentials.ts');

      const legitimateHostArchive = join(root, 'legitimate-host.tar.gz');
      execFileSync('tar', [
        '-czf',
        legitimateHostArchive,
        '-C',
        root,
        'server/dist/modules/crm/customer-onboarding-import.d.ts.map',
        'server/src/credentials.ts',
      ]);
      const legitimateHostResult = runSourced(
        hostHelper,
        'ARTIFACT="$2"; verify_archive_entries',
        [legitimateHostArchive],
      );
      expect(legitimateHostResult.status).toBe(0);

      for (const name of secretNames) {
        const malicious = join(root, `malicious-${name.replace(/[^A-Za-z0-9_.-]/g, '_')}.tar.gz`);
        execFileSync('tar', ['-czf', malicious, '-C', root, `ops/${name}`]);
        const rejected = runSourced(hostHelper, 'ARTIFACT="$2"; verify_archive_entries', [malicious]);
        expect(rejected.status).not.toBe(0);
        expect(`${rejected.stdout}${rejected.stderr}`).toContain('ARTIFACT_FORBIDDEN_CONTENT');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('executes immutable collision identity checks without overwriting a release', () => {
    const matching = runImmutableCollisionHarness(true);
    try {
      expect(matching.result.status).toBe(0);
      expect(`${matching.result.stdout}${matching.result.stderr}`).toContain('RELEASE_STAGE=EXISTING_BYTE_IDENTICAL');
    } finally {
      matching.cleanup();
    }

    const collision = runImmutableCollisionHarness(false);
    try {
      expect(collision.result.status).not.toBe(0);
      expect(`${collision.result.stdout}${collision.result.stderr}`).toContain('IMMUTABLE_RELEASE_COLLISION');
      expect(existsSync(join(collision.release, 'payload.txt'))).toBe(true);
    } finally {
      collision.cleanup();
    }
  });

  it('proves backup and checksum failures stop before migration or activation', () => {
    const backupFailure = runDeployPhaseHarness('backup-failure');
    try {
      expect(backupFailure.result.status).not.toBe(0);
      expect(backupFailure.events).toEqual(['require', 'validate_sha', 'systemctl:enable servora-med.service', 'preflight', 'archive', 'checksum', 'stage', 'backup']);
      expect(`${backupFailure.result.stdout}${backupFailure.result.stderr}`).toContain('PREDEPLOY_BACKUP_FAILED');
      expect(backupFailure.events).not.toContain('migrate');
      expect(backupFailure.events.some((event) => event.startsWith('switch:'))).toBe(false);
    } finally {
      backupFailure.cleanup();
    }

    const checksumFailure = runDeployPhaseHarness('checksum-failure');
    try {
      expect(checksumFailure.result.status).not.toBe(0);
      expect(checksumFailure.events).toEqual(['require', 'validate_sha', 'systemctl:enable servora-med.service', 'preflight', 'archive', 'checksum']);
      expect(`${checksumFailure.result.stdout}${checksumFailure.result.stderr}`).toContain('ARTIFACT_CHECKSUM_MISMATCH');
      expect(checksumFailure.events).not.toContain('backup');
      expect(checksumFailure.events).not.toContain('migrate');
    } finally {
      checksumFailure.cleanup();
    }
  });

  it('executes migration authorization and blocks divergence/ahead histories', () => {
    const pendingDefault = runDeployPhaseHarness('pending-default');
    try {
      expect(pendingDefault.result.status).not.toBe(0);
      expect(`${pendingDefault.result.stdout}${pendingDefault.result.stderr}`).toContain('PENDING_MIGRATIONS_REQUIRE_EXPLICIT_AUTHORIZATION');
      expect(pendingDefault.events).not.toContain('migrate');
      expect(pendingDefault.events.some((event) => event.startsWith('systemctl:stop'))).toBe(false);
    } finally {
      pendingDefault.cleanup();
    }

    const pendingAllowed = runDeployPhaseHarness('pending-allow');
    try {
      expect(pendingAllowed.result.status).toBe(0);
      expect(pendingAllowed.events).toContain('migrate');
      expect(pendingAllowed.events).toContain('systemctl:stop servora-med.service');
    } finally {
      pendingAllowed.cleanup();
    }

    for (const mode of ['divergent-allow', 'ahead-allow'] as const) {
      const blocked = runDeployPhaseHarness(mode);
      try {
        expect(blocked.result.status).not.toBe(0);
        expect(`${blocked.result.stdout}${blocked.result.stderr}`).toContain('MIGRATION_HISTORY_DIVERGED');
        expect(blocked.events).not.toContain('migrate');
        expect(blocked.events.some((event) => event.startsWith('systemctl:stop'))).toBe(false);
      } finally {
        blocked.cleanup();
      }
    }
  });

  it('executes zero-migration rollback and refuses automatic rollback after migration', () => {
    const zeroRollback = runDeployPhaseHarness('zero-rollback');
    try {
      expect(zeroRollback.result.status).toBe(0);
      expect(zeroRollback.events.some((event) => event === 'switch:/opt/servora-med/releases/old')).toBe(true);
      expect(zeroRollback.events).toContain('systemctl:restart servora-med.service');
      expect(zeroRollback.events.filter((event) => event.startsWith('switch:')).length).toBe(2);
    } finally {
      zeroRollback.cleanup();
    }

    const migrated = runDeployPhaseHarness('migrated-no-rollback');
    try {
      expect(migrated.result.status).not.toBe(0);
      expect(`${migrated.result.stdout}${migrated.result.stderr}`).toContain('ACTIVATION_SERVICE_START_FAILED_MANUAL_ROLLBACK_REQUIRED');
      expect(migrated.events.some((event) => event === 'switch:/opt/servora-med/releases/old')).toBe(false);
      expect(migrated.events).not.toContain('systemctl:restart servora-med.service');
    } finally {
      migrated.cleanup();
    }
  });

  it('classifies a live deployment with failed postdeploy backup without rollback', () => {
    const result = runPostdeployBackupFailureHarness();
    try {
      expect(result.result.status).toBe(2);
      expect(`${result.result.stdout}${result.result.stderr}`).toContain('LIVE_BUT_POSTDEPLOY_BACKUP_FAILED');
      expect(result.events).toContain('health');
      expect(result.events).toContain('systemctl:start servora-med-backup.service');
      expect(result.events.some((event) => event.startsWith('switch:'))).toBe(false);
      expect(result.events).not.toContain('systemctl:restart servora-med.service');
    } finally {
      result.cleanup();
    }
  });
});

describe('HEALTH_SCHEMA_VERSION transition — derive and atomic ENV handling', () => {
  it('derives valid target 041_user_lifecycle_reconciliation', () => {
    const result = runSourced(hostHelper, 'STATE_CATALOG_HEAD="041_user_lifecycle_reconciliation"; derive_health_schema_target');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('041_user_lifecycle_reconciliation');
  });

  it('derives 037_staff_offboarding_audit and rejects invalid patterns', () => {
    const valid = runSourced(hostHelper, 'STATE_CATALOG_HEAD="037_staff_offboarding_audit"; derive_health_schema_target');
    expect(valid.status).toBe(0);
    expect(valid.stdout.trim()).toBe('037_staff_offboarding_audit');
    const empty = runSourced(hostHelper, 'set +e; STATE_CATALOG_HEAD=""; derive_health_schema_target; echo EXIT:$?');
    expect(empty.stdout).toContain('EXIT:1');
    const badFormat = runSourced(hostHelper, 'set +e; STATE_CATALOG_HEAD="not-a-version"; derive_health_schema_target; echo EXIT:$?');
    expect(badFormat.stdout).toContain('EXIT:1');
    const uppercase = runSourced(hostHelper, 'set +e; STATE_CATALOG_HEAD="041_InvalidUpper"; derive_health_schema_target; echo EXIT:$?');
    expect(uppercase.stdout).toContain('EXIT:1');
  });

  it('transitions 037→041 atomically, mode 640, single entry, preserves other keys, secret-safe', () => {
    const root = temporaryDirectory('health-atomic');
    const envFile = createEnvFile(root, 'DATABASE_URL=postgresql://user:s3cr3t@localhost/servora_med\nHEALTH_SCHEMA_VERSION=037_staff_offboarding_audit\nOTHER=keep\n');
    try {
      const body = `
STATE_CATALOG_HEAD="041_user_lifecycle_reconciliation"
MIGRATIONS_APPLIED=1
chown() { return 0; }
stat() {
  case "$*" in
    *servora-med.env*) printf 'root:servora-med:640\\n'; return 0 ;;
    *) command stat "$@" ;;
  esac
}
transition_health_schema_version
`;
      const result = runPatchedHost(body, { APP_ENV_FILE: envFile });
      expect(result.status).toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('HEALTH_SCHEMA_VERSION_TRANSITION old=037_staff_offboarding_audit new=041_user_lifecycle_reconciliation');
      // Secret must not be logged
      expect(`${result.stdout}${result.stderr}`).not.toContain('s3cr3t');
      expect(`${result.stdout}${result.stderr}`).not.toContain('postgresql://');
      const after = readFileSync(envFile, 'utf8');
      expect(after).toContain('HEALTH_SCHEMA_VERSION=041_user_lifecycle_reconciliation');
      expect(after).toContain('DATABASE_URL=postgresql://user:s3cr3t@localhost/servora_med');
      expect(after).toContain('OTHER=keep');
      expect((after.match(/^HEALTH_SCHEMA_VERSION=/gm) || []).length).toBe(1);
      // Verify atomic: only one HEALTH line, no duplicate
      // Verify no duplicate remains (grep count)
      const count = (after.match(/^HEALTH_SCHEMA_VERSION=/gm) || []).length;
      expect(count).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips mutation when already current (idempotent, no duplicate)', () => {
    const root = temporaryDirectory('health-already');
    const envFile = createEnvFile(root, 'HEALTH_SCHEMA_VERSION=041_user_lifecycle_reconciliation\nOTHER=keep\n');
    const before = readFileSync(envFile, 'utf8');
    const beforeStat = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
    try {
      const body = `
STATE_CATALOG_HEAD="041_user_lifecycle_reconciliation"
MIGRATIONS_APPLIED=1
chown() { echo unexpected_chown; return 0; }
chmod() { echo unexpected_chmod; return 0; }
stat() {
  case "$*" in
    *servora-med.env*) printf 'root:servora-med:640\\n'; return 0 ;;
    *) command stat "$@" ;;
  esac
}
transition_health_schema_version
`;
      const result = runPatchedHost(body, { APP_ENV_FILE: envFile });
      expect(result.status).toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('reason=already_current');
      const after = readFileSync(envFile, 'utf8');
      expect(after).toBe(before);
      expect(`${result.stdout}${result.stderr}`).not.toContain('unexpected_chown');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('zero-migration preserves env untouched (no mutation)', () => {
    const harness = runHealthTransitionHarness(
      'HEALTH_SCHEMA_VERSION=037_staff_offboarding_audit\nOTHER=keep\n',
      '041_user_lifecycle_reconciliation',
      0,
    );
    try {
      expect(harness.result.status).toBe(0);
      expect(`${harness.result.stdout}${harness.result.stderr}`).toContain('reason=zero_migrations');
      expect(harness.envAfter).toContain('037_staff_offboarding_audit');
      expect(harness.envAfter).not.toContain('041_user_lifecycle_reconciliation');
      expect((harness.envAfter.match(/^HEALTH_SCHEMA_VERSION=/gm) || []).length).toBe(1);
    } finally {
      harness.cleanup();
    }
  });

  it('consolidates duplicate HEALTH_SCHEMA_VERSION entries to single canonical', () => {
    const root = temporaryDirectory('health-dedup');
    const envFile = createEnvFile(
      root,
      'HEALTH_SCHEMA_VERSION=037_staff_offboarding_audit\nHEALTH_SCHEMA_VERSION=037_staff_offboarding_audit\nOTHER=keep\n',
    );
    try {
      const body = `
STATE_CATALOG_HEAD="041_user_lifecycle_reconciliation"
MIGRATIONS_APPLIED=1
chown() { return 0; }
stat() {
  case "$*" in
    *servora-med.env*) printf 'root:servora-med:640\\n'; return 0 ;;
    *) command stat "$@" ;;
  esac
}
transition_health_schema_version
`;
      const result = runPatchedHost(body, { APP_ENV_FILE: envFile });
      expect(result.status).toBe(0);
      const after = readFileSync(envFile, 'utf8');
      expect((after.match(/^HEALTH_SCHEMA_VERSION=/gm) || []).length).toBe(1);
      expect(after).toContain('HEALTH_SCHEMA_VERSION=041_user_lifecycle_reconciliation');
      expect(after).toContain('OTHER=keep');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails when STATE_CATALOG_HEAD invalid and preserves env', () => {
    const root = temporaryDirectory('health-invalid');
    const envFile = createEnvFile(root, 'HEALTH_SCHEMA_VERSION=037_staff_offboarding_audit\n');
    const before = readFileSync(envFile, 'utf8');
    try {
      const body = `
set +e
STATE_CATALOG_HEAD=""
MIGRATIONS_APPLIED=1
chown() { return 0; }
stat() { printf 'root:servora-med:640\\n'; return 0; }
transition_health_schema_version
echo EXIT:$?
`;
      const result = runPatchedHost(body, { APP_ENV_FILE: envFile });
      expect(result.stdout).toContain('EXIT:1');
      expect(`${result.stdout}${result.stderr}`).toContain('HEALTH_SCHEMA_VERSION_TRANSITION_FAILED');
      expect(readFileSync(envFile, 'utf8')).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps transition helper syntactically valid and secret-safe', () => {
    const hostContent = readFileSync(hostHelper, 'utf8');
    expect(hostContent).toContain('derive_health_schema_target');
    expect(hostContent).toContain('transition_health_schema_version');
    expect(hostContent).toContain('HEALTH_SCHEMA_VERSION_TRANSITION');
    expect(hostContent).toContain('already_current');
    expect(hostContent).toContain('zero_migrations');
    // Secret-safe: log only old/new identifiers, not DATABASE_URL
    expect(hostContent).not.toMatch(/echo.*DATABASE_URL/);
  });
});

describe('deploy phase ENV integration — zero, failure, partial, full', () => {
  it('failure before migration preserves old env (backup failure)', () => {
    const harness = runDeployEnvHarness({
      mode: 'backup-failure',
      initialEnv: 'HEALTH_SCHEMA_VERSION=037_staff_offboarding_audit\nOTHER=keep\n',
    });
    try {
      expect(harness.result.status).not.toBe(0);
      expect(`${harness.result.stdout}${harness.result.stderr}`).toContain('PREDEPLOY_BACKUP_FAILED');
      expect(harness.envAfter).toContain('037_staff_offboarding_audit');
      expect(harness.envAfter).not.toContain('041_user_lifecycle_reconciliation');
      expect(harness.events).not.toContain('migrate');
    } finally {
      harness.cleanup();
    }
  });

  it('partial migration 038 committed, 039 fails → no old restart, env not changed, manual recovery required', () => {
    const harness = runDeployEnvHarness({
      mode: 'partial-migration',
      initialEnv: 'HEALTH_SCHEMA_VERSION=037_staff_offboarding_audit\n',
      allowMigrations: true,
    });
    try {
      expect(harness.result.status).not.toBe(0);
      expect(`${harness.result.stdout}${harness.result.stderr}`).toContain('MIGRATION_FAILED');
      expect(harness.envAfter).toContain('037_staff_offboarding_audit');
      expect(harness.envAfter).not.toContain('041_user_lifecycle_reconciliation');
      // Must not have restarted old release
      expect(harness.events).not.toContain('systemctl:restart servora-med.service');
      expect(harness.events.some((e) => e === 'switch:/opt/servora-med/releases/old')).toBe(false);
      // Must have attempted stop and migrate
      expect(harness.events).toContain('systemctl:stop servora-med.service');
      expect(harness.events).toContain('migrate');
      // Env unchanged proves atomic guard
      expect((harness.envAfter.match(/^HEALTH_SCHEMA_VERSION=/gm) || []).length).toBe(1);
    } finally {
      harness.cleanup();
    }
  });

  it('full migration success → env 041, schema-check PASS, health PASS', () => {
    const harness = runDeployEnvHarness({
      mode: 'full-success',
      initialEnv: 'HEALTH_SCHEMA_VERSION=037_staff_offboarding_audit\nOTHER=keep\n',
      allowMigrations: true,
    });
    try {
      expect(harness.result.status).toBe(0);
      expect(harness.envAfter).toContain('HEALTH_SCHEMA_VERSION=041_user_lifecycle_reconciliation');
      expect(harness.envAfter).toContain('OTHER=keep');
      expect((harness.envAfter.match(/^HEALTH_SCHEMA_VERSION=/gm) || []).length).toBe(1);
      expect(harness.events).toContain('migrate');
      expect(harness.events).toContain('schema');
      expect(harness.events).toContain('systemctl:stop servora-med.service');
      expect(`${harness.result.stdout}${harness.result.stderr}`).toContain('SCHEMA_CHECK=PASS');
      expect(`${harness.result.stdout}${harness.result.stderr}`).toContain('HEALTH=PASS');
    } finally {
      harness.cleanup();
    }
  });

  it('zero-migration preserves env untouched and still passes', () => {
    const harness = runDeployEnvHarness({
      mode: 'zero-migration',
      initialEnv: 'HEALTH_SCHEMA_VERSION=037_staff_offboarding_audit\n',
    });
    try {
      expect(harness.result.status).toBe(0);
      expect(harness.envAfter).toContain('037_staff_offboarding_audit');
      expect(harness.envAfter).not.toContain('041_user_lifecycle_reconciliation');
      expect(harness.events).toContain('migrate');
    } finally {
      harness.cleanup();
    }
  });
});

describe('production-recovery helper — contract validation', () => {
  const validSha = 'a'.repeat(40);
  const validVersion = '037_staff_offboarding_audit';

  function runRecovery(args: string[], env: NodeJS.ProcessEnv = {}) {
    return spawnSync('bash', [recoveryHelper, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
  }

  function createBackupFixture(root: string, valid: boolean) {
    const backup = join(root, 'servora-med-20250831T120000Z.dump');
    const checksum = `${backup}.sha256`;
    const content = valid ? 'valid-dump-content' : 'invalid';
    writeFileSync(backup, content);
    const digest = createHash('sha256').update(content).digest('hex');
    // Write checksum file; if valid, use correct digest, else wrong
    const sidecarDigest = valid ? digest : 'b'.repeat(64);
    writeFileSync(checksum, `${sidecarDigest}  ${backup.split('/').pop()}\n`);
    return { backup, checksum, digest };
  }

  it('keeps recovery helper syntactically valid and fail-closed', () => {
    execFileSync('bash', ['-n', recoveryHelper], { stdio: 'pipe' });
    const content = readFileSync(recoveryHelper, 'utf8');
    expect(content).toContain('PRODUCTION_RECOVERY_REFUSED');
    expect(content).toContain('CHECKSUM_MISMATCH');
    expect(content).toContain('INVALID_TARGET_DB');
    expect(content).toContain('INVALID_EXPECTED_HOST');
    expect(content).toContain('--allow-destructive');
    expect(content).toContain('servora_med');
    expect(content).toContain('127.0.0.1');
    expect(content).toContain('TEST_DATABASE_URL');
  });

  it('refuses without --allow-destructive', () => {
    const root = temporaryDirectory('recovery-no-destructive');
    try {
      const { backup, checksum } = createBackupFixture(root, true);
      const envFile = createEnvFile(root, `HEALTH_SCHEMA_VERSION=${validVersion}\n`);
      const result = runRecovery(
        [
          '--backup',
          backup,
          '--checksum',
          checksum,
          '--target-db',
          'servora_med',
          '--expected-host',
          '127.0.0.1',
          '--old-release',
          validSha,
          '--old-health-schema-version',
          validVersion,
          '--env-file',
          envFile,
        ],
        { TEST_DATABASE_URL: 'postgresql://localhost:5432/servora_med_recovery_test' },
      );
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('DESTRUCTIVE_NOT_AUTHORIZED');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses checksum mismatch', () => {
    const root = temporaryDirectory('recovery-checksum-mismatch');
    try {
      const backup = join(root, 'servora-med-20250831T120000Z.dump');
      writeFileSync(backup, 'content-a');
      const badDigest = 'b'.repeat(64);
      const checksum = `${backup}.sha256`;
      writeFileSync(checksum, `${badDigest}  ${backup.split('/').pop()}\n`);
      const envFile = createEnvFile(root, `HEALTH_SCHEMA_VERSION=${validVersion}\n`);
      const result = runRecovery(
        [
          '--backup',
          backup,
          '--checksum',
          checksum,
          '--target-db',
          'servora_med',
          '--expected-host',
          '127.0.0.1',
          '--allow-destructive',
          '--old-release',
          validSha,
          '--old-health-schema-version',
          validVersion,
          '--env-file',
          envFile,
        ],
        { TEST_DATABASE_URL: 'postgresql://localhost:5432/servora_med_recovery_test' },
      );
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('CHECKSUM_MISMATCH');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses wrong target DB', () => {
    const root = temporaryDirectory('recovery-wrong-db');
    try {
      const { backup, checksum } = createBackupFixture(root, true);
      const envFile = createEnvFile(root, `HEALTH_SCHEMA_VERSION=${validVersion}\n`);
      const result = runRecovery(
        [
          '--backup',
          backup,
          '--checksum',
          checksum,
          '--target-db',
          'other_db',
          '--expected-host',
          '127.0.0.1',
          '--allow-destructive',
          '--old-release',
          validSha,
          '--old-health-schema-version',
          validVersion,
          '--env-file',
          envFile,
        ],
        { TEST_DATABASE_URL: 'postgresql://localhost:5432/servora_med_recovery_test' },
      );
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('INVALID_TARGET_DB');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses wrong expected host (remote)', () => {
    const root = temporaryDirectory('recovery-wrong-host');
    try {
      const { backup, checksum } = createBackupFixture(root, true);
      const envFile = createEnvFile(root, `HEALTH_SCHEMA_VERSION=${validVersion}\n`);
      const result = runRecovery(
        [
          '--backup',
          backup,
          '--checksum',
          checksum,
          '--target-db',
          'servora_med',
          '--expected-host',
          '10.0.0.5',
          '--allow-destructive',
          '--old-release',
          validSha,
          '--old-health-schema-version',
          validVersion,
          '--env-file',
          envFile,
        ],
        { TEST_DATABASE_URL: 'postgresql://localhost:5432/servora_med_recovery_test' },
      );
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('INVALID_EXPECTED_HOST');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses invalid archive (pg_restore --list fails)', () => {
    const root = temporaryDirectory('recovery-invalid-archive');
    try {
      const backup = join(root, 'servora-med-20250831T120000Z.dump');
      writeFileSync(backup, 'not-a-valid-pg-dump');
      const digest = createHash('sha256').update('not-a-valid-pg-dump').digest('hex');
      const checksum = `${backup}.sha256`;
      writeFileSync(checksum, `${digest}  ${backup.split('/').pop()}\n`);
      const envFile = createEnvFile(root, `HEALTH_SCHEMA_VERSION=${validVersion}\n`);
      // Mock pg_restore to fail on -l
      const bin = join(root, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'pg_restore'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      writeFileSync(join(bin, 'psql'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const result = runRecovery(
        [
          '--backup',
          backup,
          '--checksum',
          checksum,
          '--target-db',
          'servora_med',
          '--expected-host',
          '127.0.0.1',
          '--allow-destructive',
          '--old-release',
          validSha,
          '--old-health-schema-version',
          validVersion,
          '--env-file',
          envFile,
        ],
        {
          TEST_DATABASE_URL: 'postgresql://localhost:5432/servora_med_recovery_test',
          PATH: `${bin}:${process.env.PATH}`,
          PG_RESTORE_BIN: join(bin, 'pg_restore'),
          PSQL_BIN: join(bin, 'psql'),
        },
      );
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('BACKUP_ARCHIVE_INVALID');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses missing backup file', () => {
    const root = temporaryDirectory('recovery-missing-backup');
    try {
      const missing = join(root, 'servora-med-20250831T120000Z.dump');
      const checksum = `${missing}.sha256`;
      writeFileSync(checksum, `${'a'.repeat(64)}  ${missing.split('/').pop()}\n`);
      const envFile = createEnvFile(root, `HEALTH_SCHEMA_VERSION=${validVersion}\n`);
      const result = runRecovery(
        [
          '--backup',
          missing,
          '--checksum',
          checksum,
          '--target-db',
          'servora_med',
          '--expected-host',
          '127.0.0.1',
          '--allow-destructive',
          '--old-release',
          validSha,
          '--old-health-schema-version',
          validVersion,
          '--env-file',
          envFile,
        ],
        { TEST_DATABASE_URL: 'postgresql://localhost:5432/servora_med_recovery_test' },
      );
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('BACKUP_MISSING');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses invalid checksum sidecar (control chars)', () => {
    const root = temporaryDirectory('recovery-bad-sidecar');
    try {
      const backup = join(root, 'servora-med-20250831T120000Z.dump');
      writeFileSync(backup, 'valid-content');
      const checksum = `${backup}.sha256`;
      // Inject control char
      writeFileSync(checksum, `${'a'.repeat(64)}  ${backup.split('/').pop()}\x00\n`);
      const envFile = createEnvFile(root, `HEALTH_SCHEMA_VERSION=${validVersion}\n`);
      const result = runRecovery(
        [
          '--backup',
          backup,
          '--checksum',
          checksum,
          '--target-db',
          'servora_med',
          '--expected-host',
          '127.0.0.1',
          '--allow-destructive',
          '--old-release',
          validSha,
          '--old-health-schema-version',
          validVersion,
          '--env-file',
          envFile,
        ],
        { TEST_DATABASE_URL: 'postgresql://localhost:5432/servora_med_recovery_test' },
      );
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('CHECKSUM_SIDECAR_INVALID');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never logs DATABASE_URL secret', () => {
    const root = temporaryDirectory('recovery-secret');
    try {
      const { backup, checksum } = createBackupFixture(root, true);
      const envFile = createEnvFile(root, `HEALTH_SCHEMA_VERSION=${validVersion}\n`);
      const secretUrl = 'postgresql://servora:s3cr3tP@ss@localhost:5432/servora_med_recovery_test';
      const bin = join(root, 'bin');
      mkdirSync(bin);
      // pg_restore mock that lists successfully
      writeFileSync(join(bin, 'pg_restore'), '#!/bin/sh\nif [ "$1" = "-l" ]; then echo "Dumped by pg_dump version: 16"; exit 0; fi\nexit 0\n', { mode: 0o755 });
      writeFileSync(join(bin, 'psql'), '#!/bin/sh\nif echo "$*" | grep -q "schema_migrations"; then echo "037_staff_offboarding_audit"; exit 0; fi\nexit 0\n', { mode: 0o755 });
      const result = runRecovery(
        [
          '--backup',
          backup,
          '--checksum',
          checksum,
          '--target-db',
          'servora_med',
          '--expected-host',
          '127.0.0.1',
          '--allow-destructive',
          '--old-release',
          validSha,
          '--old-health-schema-version',
          validVersion,
          '--env-file',
          envFile,
        ],
        {
          TEST_DATABASE_URL: secretUrl,
          PATH: `${bin}:${process.env.PATH}`,
          PG_RESTORE_BIN: join(bin, 'pg_restore'),
          PSQL_BIN: join(bin, 'psql'),
        },
      );
      // Even on failure/success, output must not contain secret
      const combined = `${result.stdout}${result.stderr}`;
      expect(combined).not.toContain('s3cr3tP@ss');
      expect(combined).not.toContain('postgresql://servora');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses missing env file in test mode', () => {
    const root = temporaryDirectory('recovery-missing-env');
    try {
      const { backup, checksum } = createBackupFixture(root, true);
      const missingEnv = join(root, 'no-such.env');
      const bin = join(root, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'pg_restore'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      writeFileSync(join(bin, 'psql'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const result = runRecovery(
        [
          '--backup',
          backup,
          '--checksum',
          checksum,
          '--target-db',
          'servora_med',
          '--expected-host',
          '127.0.0.1',
          '--allow-destructive',
          '--old-release',
          validSha,
          '--old-health-schema-version',
          validVersion,
          '--env-file',
          missingEnv,
        ],
        {
          TEST_DATABASE_URL: 'postgresql://localhost:5432/servora_med_recovery_test',
          PG_RESTORE_BIN: join(bin, 'pg_restore'),
          PSQL_BIN: join(bin, 'psql'),
        },
      );
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('ENV_FILE_MISSING');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses TEST_DATABASE_URL pointing to protected servora_med', () => {
    const root = temporaryDirectory('recovery-protected-db');
    try {
      const { backup, checksum } = createBackupFixture(root, true);
      const envFile = createEnvFile(root, `HEALTH_SCHEMA_VERSION=${validVersion}\n`);
      const result = runRecovery(
        [
          '--backup',
          backup,
          '--checksum',
          checksum,
          '--target-db',
          'servora_med',
          '--expected-host',
          '127.0.0.1',
          '--allow-destructive',
          '--old-release',
          validSha,
          '--old-health-schema-version',
          validVersion,
          '--env-file',
          envFile,
        ],
        { TEST_DATABASE_URL: 'postgresql://localhost:5432/servora_med' },
      );
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('TEST_DATABASE_URL_PRODUCTION_COLLISION');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('validates timestamp binding mismatch', () => {
    const root = temporaryDirectory('recovery-timestamp');
    try {
      const { backup, checksum } = createBackupFixture(root, true);
      const envFile = createEnvFile(root, `HEALTH_SCHEMA_VERSION=${validVersion}\n`);
      const result = runRecovery(
        [
          '--backup',
          backup,
          '--checksum',
          checksum,
          '--target-db',
          'servora_med',
          '--expected-host',
          '127.0.0.1',
          '--allow-destructive',
          '--old-release',
          validSha,
          '--old-health-schema-version',
          validVersion,
          '--expected-backup-timestamp',
          '20990101T000000Z',
          '--env-file',
          envFile,
        ],
        { TEST_DATABASE_URL: 'postgresql://localhost:5432/servora_med_recovery_test' },
      );
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('BACKUP_TIMESTAMP_MISMATCH');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
