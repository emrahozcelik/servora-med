import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createBootstrapFenceGuard, REQUIRED_MANAGEMENT_FILES} from '../scripts/bootstrap-fence.mjs';
import {fenceFixture, ROOT, LIB, ID} from '../tests/bootstrap-fence-fixture.mjs';
import {TOOLS, RECORDS, resealRecords, envelope} from './normal-deploy-transition.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const repo = path => readFileSync(new URL('../../' + path, import.meta.url));
const PROFILE = '/var/lib/servora-med/deploy/profile.json';
const SOURCES = {'deploy-production-host': 'ops/scripts/deploy-production-host.sh',
  'bootstrap-fence': 'ops/scripts/bootstrap-fence.sh', 'bootstrap-fence.mjs': 'ops/scripts/bootstrap-fence.mjs'};

test('pinned target bytes are exactly the reviewed repository sources', () => {
  for (const [name, source] of Object.entries(SOURCES)) {
    assert.equal(TOOLS[name].new, sha(repo(source)), `${name} pin must match ${source}`);
    assert.match(TOOLS[name].old, /^[0-9a-f]{64}$/);
    assert.notEqual(TOOLS[name].old, TOOLS[name].new);
  }
  const wrapper = repo('ops/recovery-tools/normal-deploy-transition').toString();
  assert.match(wrapper, new RegExp(`MODULE_SHA256=${sha(repo('ops/recovery-tools/normal-deploy-transition.mjs'))}`));
  assert.match(wrapper, /servora_acquire_host_lock\nservora_assert_no_pending_attempt/);
});

/** Synthetic RELEASED host whose three tools carry the fixture's "old" bytes. */
function releasedHost() {
  const f = fenceFixture(REQUIRED_MANAGEMENT_FILES);
  f.releaseFence();
  const tools = {}, staged = {};
  for (const name of Object.keys(TOOLS)) {
    const entry = f.manifest.files.find(file => file.path === `${LIB}/${name}`);
    staged[name] = Buffer.from(`OPS-DEPLOY-002 ${name}\n`);
    tools[name] = {mode: entry.mode, old: entry.sha256, new: sha(staged[name])};
  }
  const profile = {formatVersion: 2, machineId: '1'.repeat(32), fqdn: 'app.example.test',
    contracts: {helperSha256: tools['deploy-production-host'].old, nodeSha256: 'b'.repeat(64)}};
  // Re-seal once with identical old/new so the starting chain covers a JSON profile.
  const same = Object.fromEntries(Object.entries(tools).map(([n, t]) => [n, {...t, new: t.old}]));
  const start = resealRecords({manifest: f.manifest, closed: f.fence, verification: f.verification,
    authorization: f.authorization, profile}, same);
  f.add(PROFILE, start.profile);
  for (const name of RECORDS) f.add(`${ROOT}/${name}`, start[name]);
  const body = name => JSON.parse(f.files.get(`${ROOT}/${name}`).bytes.toString()).record;
  const archived = () => ({manifest: body('manifest.json'), closed: body('closed.json'), verification: body('verification.json'),
    authorization: body('release-authorization.json'), profile: JSON.parse(f.files.get(PROFILE).bytes.toString())});
  return {f, tools, staged, archived};
}

test('re-seal opens attempt-less normal deploy and keeps recovery and legacy gates closed', () => {
  const {f, tools, staged, archived} = releasedHost();
  const guard = createBootstrapFenceGuard(f.io);
  assert.equal(guard('forward').state, 'RELEASED');
  const inputs = archived();

  for (const [name, bytes] of Object.entries(staged)) f.add(`${LIB}/${name}`, bytes, tools[name].mode);
  assert.throws(() => guard('forward'), /BOOTSTRAP_FENCE_TOOL_DRIFT/, 'new tools alone must not pass');

  const next = resealRecords(inputs, tools);
  f.add(PROFILE, next.profile);
  for (const name of RECORDS) f.add(`${ROOT}/${name}`, next[name]);

  for (const operation of ['deploy', 'postdeploy', 'rollback']) {
    assert.equal(guard(operation).state, 'RELEASED', operation);
    assert.equal(guard(operation, ID).state, 'RELEASED', operation);
    assert.throws(() => guard(operation, 'not-a-uuid'), /BOOTSTRAP_FENCE_ATTEMPT_REQUIRED/, operation);
  }
  for (const operation of ['forward-recovery', 'pre-migration-abort', 'attempt-preflight', 'controller']) {
    assert.throws(() => guard(operation), /BOOTSTRAP_FENCE_ATTEMPT_REQUIRED/, operation);
  }
  for (const operation of ['legacy-deploy', 'legacy-restore']) {
    assert.throws(() => guard(operation, ID), /BOOTSTRAP_FENCE_LEGACY_MUTATION_DISABLED/, operation);
  }
  const profile = JSON.parse(next.profile.toString());
  assert.equal(profile.contracts.helperSha256, tools['deploy-production-host'].new);
  assert.equal(profile.contracts.nodeSha256, 'b'.repeat(64), 'other contracts unchanged');
  assert.deepEqual(resealRecords(inputs, tools), next, 're-seal is deterministic, so a resume is identical');
});

test('re-seal refuses unexpected manifests, profiles and tampered records', () => {
  const {tools, archived} = releasedHost();
  const inputs = archived();
  const foreign = {...inputs, manifest: {...inputs.manifest, files: inputs.manifest.files.map(file =>
    file.path === `${LIB}/bootstrap-fence.mjs` ? {...file, sha256: 'c'.repeat(64)} : file)}};
  assert.throws(() => resealRecords(foreign, tools), /OPS_DEPLOY_002_MANIFEST_UNEXPECTED/);
  const missing = {...inputs, manifest: {...inputs.manifest, files: inputs.manifest.files.filter(file =>
    file.path !== `${LIB}/deploy-production-host`)}};
  assert.throws(() => resealRecords(missing, tools), /OPS_DEPLOY_002_MANIFEST_UNEXPECTED/);
  const profile = {...inputs, profile: {...inputs.profile, contracts: {helperSha256: 'd'.repeat(64)}}};
  assert.throws(() => resealRecords(profile, tools), /OPS_DEPLOY_002_PROFILE_UNEXPECTED/);

  const {f} = releasedHost();
  const tampered = JSON.parse(f.files.get(`${ROOT}/released.json`).bytes.toString()).record;
  f.add(`${ROOT}/released.json`, envelope({...tampered, fenceSha256: 'e'.repeat(64)}));
  assert.throws(() => createBootstrapFenceGuard(f.io)('deploy'), /BOOTSTRAP_FENCE_RELEASE_INVALID/);
});
