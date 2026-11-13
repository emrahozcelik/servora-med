import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {parseArguments, validateClosedSudoListing} from './bootstrap-delegation-quarantine-host.mjs';

test('the root CLI accepts only capture, dry-run and explicitly hash-bound apply', () => {
  assert.deepEqual(parseArguments(['--capture']), {mode: 'capture'});
  for (const mode of ['dry-run', 'apply']) assert.deepEqual(
    parseArguments(['--' + mode, '--expected-authorization', 'a'.repeat(64)]),
    {mode, expectedAuthorization: 'a'.repeat(64)});
  for (const argv of [[], ['--apply'], ['--force'], ['--resume'], ['--release'],
    ['--capture', '--path', '/tmp'], ['--apply', '--expected-authorization', 'A'.repeat(64)],
    ['--apply', '--expected-authorization', 'a'.repeat(64), '--verified', 'true']]) {
    assert.throws(() => parseArguments(argv), /ARGUMENTS_INVALID/);
  }
});

test('the root wrapper pins its entire direct import closure', () => {
  const wrapper = readFileSync(new URL('bootstrap-delegation-quarantine', import.meta.url), 'utf8');
  for (const file of ['bootstrap-delegation-quarantine.mjs', 'bootstrap-delegation-quarantine-host.mjs',
    '../scripts/bootstrap-fence.mjs', '../scripts/historical-recovery-evidence.mjs']) {
    const bytes = readFileSync(new URL(file, import.meta.url));
    const sha = createHash('sha256').update(bytes).digest('hex');
    assert.ok(wrapper.includes(sha), 'missing exact import pin: ' + file);
  }
  assert.match(wrapper, /a5564b6e82256fed8260a86d8c3d582c009c6fac4f2ad4216a61e566bb5f500e/);
  assert.doesNotMatch(wrapper, /^source /m);
  assert.match(wrapper, /env -i/);
  assert.match(wrapper, /--no-addons/);
});

test('a successful root list query must still require an explicit target-user denial and no granted commands', () => {
  for (const status of [0, 1]) assert.doesNotThrow(() => validateClosedSudoListing({status,
    stdout: 'User servora-deploy is not allowed to run sudo on synthetic-host.\n', stderr: ''}));
  for (const result of [
    {status: 0, stdout: 'User servora-deploy may run the following commands on synthetic-host:\n    (root) /bin/sh\n', stderr: ''},
    {status: 1, stdout: '', stderr: 'sudo: policy plugin initialization failed\n'},
    {status: 2, stdout: 'User servora-deploy is not allowed to run sudo on synthetic-host.\n', stderr: ''},
    {status: 0, stdout: 'User servora-deploy may run the following commands on synthetic-host:\n    (root) /bin/sh\n',
      stderr: 'servora-deploy is not allowed to run sudo\n'},
  ]) assert.throws(() => validateClosedSudoListing(result), /DELEGATION_REMAINS_OPEN/);
});
