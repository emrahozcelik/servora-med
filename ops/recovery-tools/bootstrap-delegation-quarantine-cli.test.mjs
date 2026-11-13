import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {parseArguments} from './bootstrap-delegation-quarantine-host.mjs';

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
