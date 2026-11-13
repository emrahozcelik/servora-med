import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {parseTransitionArguments} from './bootstrap-transition-host.mjs';

test('the root CLI separates install and release authority and rejects caller paths and truth switches', () => {
  const sha = 'a'.repeat(64), source = 'b'.repeat(40), id = '11111111-1111-4111-8111-111111111111';
  assert.deepEqual(parseTransitionArguments(['install', '--capture', '--source-sha', source, '--fence-id', id]),
    {command: 'install', mode: 'capture', sourceSha: source, fenceId: id});
  for (const mode of ['dry-run', 'apply']) assert.deepEqual(
    parseTransitionArguments(['install', '--' + mode, '--expected-authorization', sha]),
    {command: 'install', mode, expectedAuthorization: sha});
  assert.deepEqual(parseTransitionArguments(['release', '--capture']), {command: 'release', mode: 'capture'});
  assert.deepEqual(parseTransitionArguments(['release', '--apply', '--expected-authorization', sha, '--expected-external-authorization', sha]),
    {command: 'release', mode: 'apply', expectedAuthorization: sha, expectedExternalAuthorization: sha});
  for (const args of [[], ['install'], ['release', '--apply'], ['install', '--release'], ['release', '--dry-run'],
    ['install', '--force'], ['install', '--resume'], ['release', '--verified', 'true'],
    ['install', '--capture', '--path', '/tmp'], ['install', '--apply', '--expected-authorization', sha, '--root', '/tmp'],
    ['release', '--capture', '--time', 'forward'], ['release', '--capture', '--checks', 'true']]) {
    assert.throws(() => parseTransitionArguments(args), /ARGUMENTS_INVALID/);
  }
});

test('operator evidence must bind source, manifest, boot and independent root access rather than sudo-only closure', async () => {
  const {validateOperatorEvidence} = await import('./bootstrap-transition-host.mjs');
  const external = {machineId: '1'.repeat(32), bootId: '22222222-2222-4222-8222-222222222222'};
  const context = {sourceSha: 'a'.repeat(40), manifestSha256: 'b'.repeat(64)};
  const base = {formatVersion: 1, machineId: external.machineId, bootId: external.bootId};
  const review = {...base, kind: 'BOOTSTRAP_MANAGEMENT_ROUTE_REVIEW', ...context,
    scope: 'ALL_NON_ROOT_ROUTES_CLOSED', inventorySha256: 'c'.repeat(64)};
  const access = {...base, kind: 'BOOTSTRAP_INDEPENDENT_ROOT_ACCESS_PROOF', uid: 0, user: 'root',
    channel: 'SSH', independentOf: 'servora-deploy-sudo'};
  const drain = {...base, kind: 'BOOTSTRAP_PRIVILEGED_MUTATION_DRAIN_PROOF',
    scope: 'NO_INFLIGHT_OR_AUTONOMOUS_MANAGEMENT', inventorySha256: 'd'.repeat(64)};
  const valid = {external, context, review, access, drain};
  assert.doesNotThrow(() => validateOperatorEvidence(valid));
  for (const invalid of [
    {...valid, review: {...review, scope: 'SUDO_ONLY_NOT_BOOTSTRAP_INSTALL_OR_RELEASE'}},
    {...valid, review: {...review, manifestSha256: 'e'.repeat(64)}},
    {...valid, review: {...review, bootId: '33333333-3333-4333-8333-333333333333'}},
    {...valid, access: {...access, uid: 1000}}, {...valid, access: {...access, independentOf: 'same-sudo-session'}},
    {...valid, drain: {...drain, scope: 'NOT_REVIEWED'}},
    {...valid, review: {...review, verified: true}},
  ]) assert.throws(() => validateOperatorEvidence(invalid), /OPERATOR_EVIDENCE_INVALID/);
});

test('the separately provisioned wrapper pins all imports and mandatory source payloads', async () => {
  const {BOOTSTRAP_TRANSITION_SOURCE_FILES} = await import('./bootstrap-transition-host.mjs');
  const wrapper = readFileSync(new URL('bootstrap-transition', import.meta.url), 'utf8');
  const expected = new Set([...BOOTSTRAP_TRANSITION_SOURCE_FILES.map(t => t.source),
    'ops/recovery-tools/bootstrap-transition.mjs', 'ops/recovery-tools/bootstrap-transition-host.mjs',
    'ops/recovery-tools/bootstrap-delegation-quarantine.mjs', 'ops/recovery-tools/bootstrap-delegation-quarantine-host.mjs',
    'ops/recovery-tools/profile-reseal.mjs']);
  const pinned = [...wrapper.matchAll(/^pin "\$BASE\/([^"]+)" ([a-f0-9]{64})$/gm)];
  assert.deepEqual(new Set(pinned.map(m => m[1])), expected);
  for (const [, path, sha] of pinned) {
    const actual = createHash('sha256').update(readFileSync(new URL('../../' + path, import.meta.url))).digest('hex');
    assert.equal(sha, actual, path);
  }
  assert.match(wrapper, /env -i/); assert.match(wrapper, /--no-addons/);
  assert.doesNotMatch(wrapper, /^source /m);
});
