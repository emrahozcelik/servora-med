import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {
  COLLECTOR_DRAIN_MS, COLLECTOR_INSTANCE_MAX_MS, assertCollectorDrainBound,
  collectorText, collectorExpectation, collectorSwitchPlan, isContinuity,
  preserveAttemptAuthorization, assertNoLineageFork, atomicReplaceFile,
} from '../scripts/forward-host-continuity.mjs';
import {CONTINUITY_KIND, CONTINUITY_SCOPE} from '../scripts/forward-transition.mjs';

const h = c => c.repeat(64);
const digest = value => createHash('sha256').update(value).digest('hex');
const LIVE = 'c8efe8a7999f879683a62454ff74b2b649c4dee3';
const VERSIONED = '/usr/local/libexec/servora-med-forward-tools/' + 'a'.repeat(64);
const legacyGrant = (overrides = {}) => ({kind: 'FORWARD_TRANSITION_AUTHORIZATION', ...overrides});
const continuityGrant = (overrides = {}) => ({
  kind: CONTINUITY_KIND, lineage: {predecessorCollectorPath: '/usr/local/libexec/servora-med-forward/trusted-time.mjs',
    predecessorCollectorModuleSha256: h('1')}, ...overrides,
});

test('CONT-H01: collector expectations keep v2 legacy, continuity predecessor and target distinct', () => {
  const target = h('2');
  const v2 = collectorExpectation(legacyGrant(), {complete: false, toolDir: VERSIONED, targetModule: target,
    installed: '/usr/local/libexec/servora-med'});
  assert.equal(v2.path, '/usr/local/libexec/servora-med/trusted-time.mjs');
  assert.equal(v2.dropin, false);
  const pre = collectorExpectation(continuityGrant(), {complete: false, toolDir: VERSIONED, targetModule: target,
    installed: '/usr/local/libexec/servora-med'});
  assert.equal(pre.path, '/usr/local/libexec/servora-med-forward/trusted-time.mjs');
  assert.equal(pre.dropin, true);
  assert.equal(pre.text, collectorText('/usr/local/libexec/servora-med-forward'));
  const post = collectorExpectation(continuityGrant(), {complete: true, toolDir: VERSIONED, targetModule: target,
    installed: '/usr/local/libexec/servora-med'});
  assert.equal(post.path, VERSIONED + '/trusted-time.mjs');
  assert.equal(post.moduleSha256, target);
  assert.equal(post.text, collectorText(VERSIONED));
});

test('CONT-H02: the collector switch is atomic in decision and never overwrites unknown content', () => {
  const oldText = collectorText('/usr/local/libexec/servora-med-forward');
  const newText = collectorText(VERSIONED);
  assert.deepEqual(collectorSwitchPlan({currentText: oldText, oldText, newText}), {write: true, reload: true});
  assert.deepEqual(collectorSwitchPlan({currentText: newText, oldText, newText}), {write: false, reload: false});
  assert.deepEqual(collectorSwitchPlan({currentText: null, oldText: null, newText}), {write: true, reload: true});
  assert.throws(() => collectorSwitchPlan({currentText: 'foreign', oldText, newText}), /COLLECTOR_UNIT_DRIFT/);
});

test('CONT-H03: the drain bound covers the sealed instance lifetime', () => {
  assert.equal(COLLECTOR_DRAIN_MS, 4500);
  assert.equal(COLLECTOR_INSTANCE_MAX_MS, 4000);
  assert.ok(COLLECTOR_DRAIN_MS > COLLECTOR_INSTANCE_MAX_MS);
  assert.equal(assertCollectorDrainBound(), 4500);
});

test('CONT-H04: predecessor authorization preservation is exact, exclusive and idempotent', t => {
  const root = mkdtempSync(join(tmpdir(), 'servora-cont-copy-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const source = join(root, 'source.json'), destination = join(root, 'attempt', 'authorization.json');
  const bytes = Buffer.from('{"kind":"FORWARD_CONTINUITY_TEST"}\n');
  writeFileSync(source, bytes);
  const read = path => readFileSync(path);
  const publish = (path, value, mode) => writeFileSync(path, value, {mode});
  mkdirSync(join(root, 'attempt'));
  assert.equal(preserveAttemptAuthorization({source, destination, expectedSha: digest(bytes), read, publish}), true);
  assert.deepEqual(readFileSync(destination), bytes);
  assert.equal(preserveAttemptAuthorization({source, destination, expectedSha: digest(bytes), read, publish}), false);
  writeFileSync(destination, 'foreign');
  assert.throws(() => preserveAttemptAuthorization({source, destination, expectedSha: digest(bytes), read, publish}),
    /LINEAGE_AUTHORIZATION_DRIFT/);
  assert.throws(() => preserveAttemptAuthorization({source, destination: join(root, 'x'), expectedSha: h('0'), read, publish}),
    /LINEAGE_AUTHORIZATION_DRIFT/);
});

test('CONT-H05: two continuity attempts cannot fork from the same predecessor', t => {
  const root = mkdtempSync(join(tmpdir(), 'servora-cont-fork-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const current = '11111111-1111-4111-8111-111111111111';
  const other = '22222222-2222-4222-8222-222222222222';
  const predecessor = '33333333-3333-4333-8333-333333333333';
  mkdirSync(join(root, current)); mkdirSync(join(root, other));
  const grant = (attempt, pred = predecessor) => JSON.stringify(continuityGrant({attemptId: attempt,
    lineage: {predecessorAttemptId: pred, predecessorCollectorPath: '/usr/local/libexec/servora-med-forward/trusted-time.mjs',
      predecessorCollectorModuleSha256: h('1')}}));
  const files = new Map([[join(root, other, 'authorization.json'), grant(other)]]);
  writeFileSync(join(root, other, 'authorization.json'), files.get(join(root, other, 'authorization.json')));
  const list = () => [current, other];
  const read = path => files.get(path);
  assert.throws(() => assertNoLineageFork({root, authorization: JSON.parse(grant(current)), list, read}),
    /FORWARD_HOST_LINEAGE_FORK/);
  files.set(join(root, other, 'authorization.json'), grant('44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555'));
  writeFileSync(join(root, other, 'authorization.json'), files.get(join(root, other, 'authorization.json')));
  assert.doesNotThrow(() => assertNoLineageFork({root, authorization: JSON.parse(grant(current)), list, read}));
  files.set(join(root, other, 'authorization.json'), JSON.stringify(legacyGrant({attemptId: other})));
  writeFileSync(join(root, other, 'authorization.json'), files.get(join(root, other, 'authorization.json')));
  assert.doesNotThrow(() => assertNoLineageFork({root, authorization: JSON.parse(grant(current)), list, read}));
  assert.equal(isContinuity({kind: CONTINUITY_KIND}), true);
  assert.equal(isContinuity({kind: 'FORWARD_TRANSITION_AUTHORIZATION'}), false);
});

test('CONT-H06: the one-time preservation CLI is fail-closed and documents exact inputs', () => {
  const script = new URL('../scripts/preserve-forward-authorization.mjs', import.meta.url).pathname;
  const help = spawnSync(process.execPath, [script, '--help'], {encoding: 'utf8'});
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--attempt-id/); assert.match(help.stdout, /--expected-sha256/);
  const missing = spawnSync(process.execPath, [script], {encoding: 'utf8'});
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /ARGUMENTS_INVALID/);
});

test('CONT-H07: the drop-in replacement is atomic and leaves the old text on failure', t => {
  const root = mkdtempSync(join(tmpdir(), 'servora-cont-atomic-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const path = join(root, 'dropin.conf');
  writeFileSync(path, 'old\n', {mode: 0o600});
  atomicReplaceFile({path, text: 'new\n', directory: root});
  assert.equal(readFileSync(path, 'utf8'), 'new\n');
  writeFileSync(path, 'old\n');
  assert.throws(() => atomicReplaceFile({path, text: 'new\n', directory: root,
    rename: () => { throw new Error('RENAME_FAILED'); }}), /RENAME_FAILED/);
  assert.equal(readFileSync(path, 'utf8'), 'old\n');
  assert.deepEqual(readdirSync(root).filter(name => name.startsWith('.collector-')), []);
});
